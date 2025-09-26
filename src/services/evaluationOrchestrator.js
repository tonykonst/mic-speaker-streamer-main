const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'evaluationSystemPrompt.txt'),
  'utf8'
);

const DEFAULT_BATCH_WINDOW_MS = 5000;
const DEFAULT_CONTEXT_WINDOW = 20;
class ClaudeEvaluationOrchestrator extends EventEmitter {
  constructor({ claudeClient, rootDir, model, logger = console, batchWindowMs = DEFAULT_BATCH_WINDOW_MS }) {
    super();
    this.claudeClient = claudeClient;
    this.rootDir = path.resolve(rootDir);
    this.model = model || 'claude-3-opus-20240229';
    this.logger = logger;
    this.batchWindowMs = batchWindowMs;
    this.sessions = new Map();
    this.contextWindow = DEFAULT_CONTEXT_WINDOW;
    this.activePlan = null;
  }

  get isEnabled() {
    return Boolean(this.claudeClient?.isConfigured);
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
  }

  setActivePlan(plan) {
    this.activePlan = plan || null;
    for (const session of this.sessions.values()) {
      session.evaluationPlan = this.activePlan;
      session.state.planVersion = this.activePlan?.generatedAt || null;
      session.state.groups = this._initialGroupState(this.activePlan);
      this._persistState(session).catch((error) => {
        this.logger.error('[eval-orchestrator] failed to persist plan update', error);
      });
    }
  }

  async enqueueChunk(chunk) {
    if (!this.isEnabled) {
      return;
    }
    if (!chunk?.sessionId || !chunk?.text) {
      return;
    }
    const session = await this._ensureSession(chunk.sessionId);
    session.queue.push(chunk);
    session.context.push({ timestamp: chunk.timestamp, source: chunk.source, text: chunk.text });
    if (session.context.length > this.contextWindow) {
      session.context.shift();
    }

    if (!session.timer) {
      session.timer = setTimeout(() => {
        session.timer = null;
        this._flushSession(session).catch((error) => {
          this.logger.error('[eval-orchestrator] flush failed', error);
        });
      }, this.batchWindowMs);
    }
  }

  async flushAll() {
    const tasks = [];
    for (const session of this.sessions.values()) {
      if (session.timer) {
        clearTimeout(session.timer);
        session.timer = null;
      }
      tasks.push(this._flushSession(session, { force: true }));
    }
    await Promise.allSettled(tasks);
  }

  async getState(sessionId) {
    const session = await this._ensureSession(sessionId);
    return session.state;
  }

  async _ensureSession(sessionId) {
    let session = this.sessions.get(sessionId);
    if (session) {
      return session;
    }

    await this.ensureRoot();
    const dir = path.join(this.rootDir, sessionId);
    await fs.promises.mkdir(dir, { recursive: true });

    session = {
      sessionId,
      dir,
      evaluationPlan: null,
      queue: [],
      context: [],
      timer: null,
      statePath: path.join(dir, 'state.json'),
      eventsPath: path.join(dir, 'events.ndjson'),
      conflictsPath: path.join(dir, 'conflicts.ndjson'),
      state: {
        sessionId,
        updatedAt: null,
        overallFit: 0,
        planVersion: null,
        groups: {},
      },
    };

    const existingState = await readJsonSafe(session.statePath);
    if (existingState) {
      session.state = existingState;
    }

    if (!session.evaluationPlan && this.activePlan) {
      session.evaluationPlan = this.activePlan;
      session.state.planVersion = this.activePlan.generatedAt || null;
      if (!existingState || !existingState.groups || !Object.keys(existingState.groups).length) {
        session.state.groups = this._initialGroupState(this.activePlan);
      }
    }

    this.sessions.set(sessionId, session);
    return session;
  }

  _initialGroupState(plan) {
    const groups = {};
    if (plan?.groups) {
      for (const group of plan.groups) {
        const fallbackRationale = group.successSummary || group.criteria?.[0] || group.title;
        groups[group.id] = {
          id: group.id,
          title: group.title,
          verdict: 'unknown',
          confidence: 0,
          rationale: fallbackRationale || null,
          followUpQuestion: null,
          notableQuotes: [],
          conflicts: [],
          lastUpdated: null,
          source: null,
        };
      }
    }
    return groups;
  }

  async _flushSession(session, { force = false } = {}) {
    if (!this.isEnabled) {
      session.queue = [];
      return;
    }
    if (!session.evaluationPlan) {
      session.queue = [];
      return;
    }
    if (!session.queue.length && !force) {
      return;
    }

    const batch = session.queue.splice(0, session.queue.length);
    if (!batch.length && !force) {
      return;
    }

    const prompt = this._buildPrompt(session, batch);
    try {
      const response = await this.claudeClient.sendMessages(prompt);
      const parsed = this._extractJson(response);
      if (!parsed) {
        this.logger.warn('[eval-orchestrator] Empty response', session.sessionId);
        return;
      }
      await this._applyClaudeState(session, parsed, batch);
    } catch (error) {
      this.logger.error('[eval-orchestrator] Claude evaluation failed', error);
    }
  }

  _buildPrompt(session, batch) {
    const payload = {
      sessionId: session.sessionId,
      plan: session.evaluationPlan,
      currentState: session.state,
      newChunks: batch,
      recentContext: session.context,
    };

    return {
      model: this.model,
      system: SYSTEM_PROMPT,
      maxTokens: 1000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'evaluation_state',
          schema: {
            type: 'object',
            properties: {
              overallFit: { type: 'number', minimum: 0, maximum: 100 },
              groups: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    verdict: { type: 'string' },
                    confidence: { type: 'number', minimum: 0, maximum: 100 },
                    rationale: { type: 'string' },
                    followUpQuestion: { type: ['string', 'null'] },
                    notableQuotes: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    conflicts: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          summary: { type: 'string' },
                          evidence: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                quote: { type: 'string' },
                                timestamp: { type: ['string', 'null'] },
                              },
                              required: ['quote'],
                            },
                          },
                          recommendedAction: { type: ['string', 'null'] },
                        },
                        required: ['summary'],
                      },
                    },
                  },
                  required: ['id', 'verdict', 'confidence', 'rationale'],
                },
              },
              guidance: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    groupId: { type: ['string', 'null'] },
                    question: { type: 'string' },
                    priority: { type: 'string' },
                    mustHave: { type: ['boolean', 'null'] },
                  },
                  required: ['question'],
                },
              },
              conflicts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    groupId: { type: ['string', 'null'] },
                    summary: { type: 'string' },
                    evidence: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    recommendedAction: { type: ['string', 'null'] },
                  },
                  required: ['groupId', 'summary'],
                },
              },
            },
            required: ['overallFit', 'groups'],
          },
        },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        },
      ],
    };
  }

  _extractJson(response) {
    if (!response?.content) return null;
    const jsonPart = response.content.find((chunk) => chunk.type === 'json');
    if (jsonPart?.json) {
      return jsonPart.json;
    }
    const textPart = response.content.find((chunk) => chunk.type === 'text');
    if (textPart?.text) {
      try {
        return JSON.parse(textPart.text);
      } catch (_err) {
        return null;
      }
    }
    return null;
  }

  async _applyClaudeState(session, result, batch) {
    const nowIso = new Date().toISOString();

    const eventRecord = {
      at: nowIso,
      source: 'claude',
      result,
      batch,
    };
    await appendJsonLine(session.eventsPath, eventRecord);

    const groupsArray = Array.isArray(result.groups)
      ? result.groups
      : result.groups && typeof result.groups === 'object'
        ? Object.values(result.groups)
        : [];

    const rawConfidences = groupsArray
      .map((group) => Number(group?.confidence ?? 0))
      .filter((value) => Number.isFinite(value));

    const usesFractionalScale = rawConfidences.some((value) => value > 0 && value < 1);
    const usesFivePointScale = !usesFractionalScale && rawConfidences.length > 0 && Math.max(...rawConfidences) <= 5;

    const normalizeConfidence = (value, verdict) => {
      let num = Number(value);
      if (!Number.isFinite(num)) {
        num = 0;
      }
      if (usesFractionalScale) {
        num *= 100;
      } else if (usesFivePointScale) {
        if (num <= 1 && (!verdict || verdict.toLowerCase() === 'unknown')) {
          num = 0;
        } else {
          num = Math.max(0, Math.min(5, num)) * 20;
        }
      }
      return this._normalizeFit(num);
    };

    let overallFitValue = Number(result.overallFit);
    if (!Number.isFinite(overallFitValue)) {
      overallFitValue = 0;
    }
    if (usesFractionalScale && overallFitValue > 0 && overallFitValue <= 1) {
      overallFitValue *= 100;
    } else if (usesFivePointScale && overallFitValue > 0 && overallFitValue <= 5) {
      overallFitValue *= 20;
    }
    const overallFit = this._normalizeFit(overallFitValue);

    const groupsMap = {};
    for (const group of groupsArray) {
      if (!group?.id) {
        continue;
      }
      groupsMap[group.id] = {
        id: group.id,
        title: group.title || this._lookupGroupTitle(session, group.id),
        verdict: group.verdict || 'unknown',
        confidence: normalizeConfidence(group.confidence ?? 0, group.verdict || ''),
        rationale: group.rationale || null,
        followUpQuestion: group.followUpQuestion || null,
        notableQuotes: Array.isArray(group.notableQuotes) ? group.notableQuotes.slice(0, 5) : [],
        conflicts: Array.isArray(group.conflicts) ? group.conflicts : [],
        lastUpdated: nowIso,
      };
    }

    session.state = {
      sessionId: session.sessionId,
      updatedAt: nowIso,
      overallFit,
      planVersion: session.evaluationPlan?.generatedAt || session.state.planVersion || null,
      groups: groupsMap,
    };

    await this._persistState(session);

    this.emit('update', {
      sessionId: session.sessionId,
      updatedAt: nowIso,
      overallFit,
      groups: Object.values(groupsMap),
    });

    const guidanceSource = Array.isArray(result.guidance)
      ? result.guidance
      : Object.values(groupsMap)
          .filter((group) => Boolean(group.followUpQuestion))
          .map((group) => ({
            groupId: group.id,
            question: group.followUpQuestion,
            priority: this._groupImportance(session, group.id) === 'must-have' ? 'high' : 'medium',
            mustHave: this._groupImportance(session, group.id) === 'must-have',
            groupTitle: group.title,
          }));

    const guidanceEntries = guidanceSource
      .filter((item) => Boolean(item?.question))
      .map((item) => ({
        sessionId: session.sessionId,
        requirementId: item.groupId || null,
        requirementTitle: item.groupTitle || (item.groupId ? this._lookupGroupTitle(session, item.groupId) : null),
        question: item.question,
        priority: item.priority || 'medium',
        mustHave: typeof item.mustHave === 'boolean'
          ? item.mustHave
          : (item.groupId ? this._groupImportance(session, item.groupId) === 'must-have' : false),
        createdAt: nowIso,
      }));

    this.emit('guidance-reset', {
      sessionId: session.sessionId,
      updatedAt: nowIso,
      entries: guidanceEntries,
    });

    if (Array.isArray(result.conflicts)) {
      for (const conflict of result.conflicts) {
        if (!conflict?.groupId) continue;
        const record = {
          at: nowIso,
          sessionId: session.sessionId,
          groupId: conflict.groupId,
          summary: conflict.summary,
          evidence: conflict.evidence || [],
          recommendedAction: conflict.recommendedAction || null,
        };
        await appendJsonLine(session.conflictsPath, record);
        this.emit('conflict', record);
      }
    }
  }

  _normalizeFit(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  _lookupGroupTitle(session, groupId) {
    const plan = session.evaluationPlan;
    if (!plan?.groups) return null;
    const match = plan.groups.find((group) => group.id === groupId);
    return match?.title || null;
  }

  _groupImportance(session, groupId) {
    const plan = session.evaluationPlan;
    if (!plan?.groups) return 'must-have';
    const match = plan.groups.find((group) => group.id === groupId);
    return match?.importance === 'nice-to-have' ? 'nice-to-have' : 'must-have';
  }

  async _persistState(session) {
    await writeJson(session.statePath, session.state);
  }
}

async function appendJsonLine(filePath, data) {
  try {
    await fs.promises.appendFile(filePath, `${JSON.stringify(data)}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to append JSON line:', error);
  }
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(filePath, `${json}\n`, 'utf8');
}

module.exports = {
  ClaudeEvaluationOrchestrator,
};
