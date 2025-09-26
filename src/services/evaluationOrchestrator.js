const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_BATCH_WINDOW_MS = 5000;
const DEFAULT_CONTEXT_WINDOW = 20;
const STOP_WORDS = new Set([
  'the','and','a','an','or','of','in','on','for','to','with','we','our','their','that','this','these','those','by','from','at','as','be','is','are','was','were','will','can','may','might','should','could','have','has','had','into','about','across','within','without','over','under','after','before','while','when','where','who','whom','which','what','why','how','i','me','my','you','your','they','them','it','its','us'
]);

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
    this.planMeta = new Map();
  }

  get isEnabled() {
    return Boolean(this.claudeClient?.isConfigured);
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
  }

  setActivePlan(plan) {
    this.activePlan = plan || null;
    this.planMeta = this._preparePlan(plan);
    for (const session of this.sessions.values()) {
      session.evaluationPlan = this.activePlan;
      session.state.planVersion = this.activePlan?.generatedAt || null;
      session.state.groups = this._initialGroupState(this.activePlan);
      session.planMeta = this.planMeta;
      session.guidanceHistory = new Map();
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
      planMeta: new Map(),
      queue: [],
      context: [],
      timer: null,
      statePath: path.join(dir, 'state.json'),
      eventsPath: path.join(dir, 'events.ndjson'),
      conflictsPath: path.join(dir, 'conflicts.ndjson'),
      guidanceHistory: new Map(),
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
      session.planMeta = this.planMeta;
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
      if (!parsed?.groups) {
        this.logger.warn('[eval-orchestrator] Empty response', session.sessionId);
        await this._applyHeuristicEvaluation(session, batch, { reason: 'empty-response' });
        return;
      }
      await this._applyResult(session, parsed, batch, { source: 'claude' });
    } catch (error) {
      this.logger.error('[eval-orchestrator] Claude evaluation failed', error);
      await this._applyHeuristicEvaluation(session, batch, { error });
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
      system:
        'You are a hiring copilot evaluating a candidate live based on grouped requirements. Return strict minified JSON with groups[]. Each group entry must include groupId, verdict, confidence (0-100), rationale, optional followUpQuestions[], notableQuotes[], conflicts[]. Return JSON only.',
      maxTokens: 800,
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

  async _applyResult(session, result, batch, { source = 'claude', skipEvent = false } = {}) {
    const groups = Array.isArray(result.groups) ? result.groups : [];
    if (!groups.length) return;

    const nowIso = new Date().toISOString();

    if (!skipEvent) {
      const eventRecord = {
        at: nowIso,
        source,
        groups,
        batch,
      };
      await appendJsonLine(session.eventsPath, eventRecord);
    }

    let totalConfidence = 0;
    let totalWeight = 0;

    for (const update of groups) {
      const existing = session.state.groups[update.groupId] || {
        id: update.groupId,
        title: update.groupId,
        verdict: 'unknown',
        confidence: 0,
        rationale: null,
        followUpQuestion: null,
        notableQuotes: [],
        conflicts: [],
        source: null,
      };

      const merged = this._mergeGroup(existing, update, { source });
      if (!merged) {
        continue;
      }

      merged.lastUpdated = nowIso;
      merged.source = merged.source || source;

      session.state.groups[update.groupId] = merged;

      const importance = this._groupImportance(session, update.groupId) === 'must-have' ? 1.5 : 1;
      totalConfidence += merged.confidence * importance;
      totalWeight += importance;

      if (merged.conflicts.length) {
        for (const conflict of merged.conflicts) {
          const record = {
            at: nowIso,
            sessionId: session.sessionId,
            groupId: update.groupId,
            summary: conflict.summary,
            evidence: conflict.evidence,
            recommendedAction: conflict.recommendedAction,
          };
          await appendJsonLine(session.conflictsPath, record);
          this.emit('conflict', record);
        }
      }

      if (merged.followUpQuestion) {
        const tracker = session.guidanceHistory || (session.guidanceHistory = new Map());
        const previous = tracker.get(update.groupId);
        if (!previous || previous.question !== merged.followUpQuestion) {
          tracker.set(update.groupId, { question: merged.followUpQuestion, issuedAt: nowIso });
          this.emit('guidance', {
            sessionId: session.sessionId,
            requirementId: update.groupId,
            requirementTitle: merged.title,
            question: merged.followUpQuestion,
            priority: this._groupImportance(session, update.groupId) === 'must-have' ? 'high' : 'medium',
            mustHave: this._groupImportance(session, update.groupId) === 'must-have',
            createdAt: nowIso,
          });
        }
      } else if (session.guidanceHistory) {
        session.guidanceHistory.delete(update.groupId);
      }
    }

    session.state.updatedAt = nowIso;
    session.state.overallFit = totalWeight ? Math.round(totalConfidence / totalWeight) : 0;

    await this._persistState(session);
    this.emit('update', {
      sessionId: session.sessionId,
      updatedAt: nowIso,
      overallFit: session.state.overallFit,
      groups: Object.values(session.state.groups),
    });
  }

  _mergeGroup(existing, update, { source }) {
    const merged = { ...existing };
    const prevSource = existing.source;
    if (source === 'heuristic' && prevSource && prevSource !== 'heuristic') {
      // Authoritative verdict already present; do not overwrite with heuristic guess.
      return null;
    }

    const incomingVerdict = (update.verdict || merged.verdict || 'unknown').toLowerCase();
    const incomingConfidence = this._clampConfidence(update.confidence ?? merged.confidence ?? 0);
    const prevStrength = this._verdictStrength(merged.verdict);
    const incomingStrength = this._verdictStrength(incomingVerdict);

    if (source === 'heuristic') {
      if (!merged.source) {
        // No prior signal — treat heuristic as the seed value.
        merged.verdict = incomingVerdict;
        merged.confidence = incomingConfidence;
        merged.source = 'heuristic';
      } else {
        const trend = incomingStrength > prevStrength
          ? 'increase'
          : incomingStrength < prevStrength
            ? 'decrease'
            : incomingConfidence > merged.confidence
              ? 'increase'
              : incomingConfidence < merged.confidence
                ? 'decrease'
                : 'neutral';

        if (trend === 'increase') {
          merged.verdict = incomingStrength >= prevStrength ? incomingVerdict : merged.verdict;
        } else if (trend === 'decrease') {
          merged.verdict = incomingVerdict;
        }

        if (trend !== 'neutral') {
          merged.confidence = this._blendConfidence(merged.confidence, incomingConfidence, trend);
        }
      }
      if (!merged.rationale && update.rationale) {
        merged.rationale = update.rationale;
      }
    } else {
      merged.verdict = incomingVerdict;
      merged.confidence = incomingConfidence;
      merged.rationale = update.rationale || merged.rationale;
      merged.source = 'claude';
    }

    const nextQuestion = Array.isArray(update.followUpQuestions) && update.followUpQuestions.length
      ? update.followUpQuestions[0]
      : null;
    if (nextQuestion) {
      merged.followUpQuestion = nextQuestion;
    }

    if (Array.isArray(update.notableQuotes) && update.notableQuotes.length) {
      const deduped = new Set([...(merged.notableQuotes || []), ...update.notableQuotes]);
      merged.notableQuotes = Array.from(deduped).slice(0, 5);
    }

    if (Array.isArray(update.conflicts)) {
      merged.conflicts = update.conflicts.map((conflict) => ({
        summary: conflict.summary,
        evidence: conflict.evidence || [],
        recommendedAction: conflict.recommendedAction || null,
      }));
    }

    return merged;
  }

  _clampConfidence(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return 0;
    if (num > 100) return 100;
    return Math.round(num);
  }

  _blendConfidence(previous, incoming, trend) {
    if (!Number.isFinite(previous)) {
      return incoming;
    }
    const applyRatio = trend === 'increase' ? 0.6 : 0.7;
    let result;
    if (trend === 'increase') {
      result = previous + (incoming - previous) * applyRatio;
      if (result < previous) {
        result = previous + Math.abs(incoming - previous) * 0.2;
      }
      result = Math.max(result, previous);
    } else {
      result = previous - (previous - incoming) * applyRatio;
      if (result > previous) {
        result = previous - Math.abs(incoming - previous) * 0.2;
      }
      result = Math.min(result, previous);
    }
    return this._clampConfidence(result);
  }

  _verdictStrength(verdict) {
    if (!verdict) return 0;
    const key = verdict.toString().toLowerCase();
    const table = {
      'strongly-aligned': 4,
      'strong_yes': 4,
      'strong-yes': 4,
      'strong': 3,
      'satisfied': 3,
      'yes': 3,
      'likely': 2,
      'promising': 2,
      'possible': 1,
      'unclear': -1,
      'needs_more': -1,
      'concern': -2,
      'no': -3,
      'strong_no': -4,
      'strongly-negative': -4,
      'unknown': 0,
    };
    return table[key] ?? 0;
  }

  _groupImportance(session, groupId) {
    const plan = session.evaluationPlan;
    if (!plan?.groups) return 'must-have';
    const group = plan.groups.find((item) => item.id === groupId);
    return group?.importance || 'must-have';
  }

  async _persistState(session) {
    await writeJson(session.statePath, session.state);
  }

  _preparePlan(plan) {
    const map = new Map();
    if (!plan?.groups) return map;
    plan.groups.forEach((group) => {
      const corpus = [group.title, ...(group.criteria || []), ...(group.successSignals || []), ...(group.riskSignals || [])]
        .filter(Boolean)
        .join(' ');
      const keywords = this._extractKeywords(corpus);
      map.set(group.id, {
        id: group.id,
        title: group.title,
        importance: group.importance === 'nice-to-have' ? 'nice-to-have' : 'must-have',
        keywords,
        probingQuestions: Array.isArray(group.probingQuestions) ? group.probingQuestions : [],
        fallbackRationale: group.successSummary || group.criteria?.[0] || group.title,
      });
    });
    return map;
  }

  _extractKeywords(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  }

  _tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  }

  _scoreToVerdict(score) {
    if (score >= 0.45) return 'satisfied';
    if (score >= 0.25) return 'likely';
    if (score > 0) return 'needs_more';
    return 'unknown';
  }

  async _applyHeuristicEvaluation(session, batch, { error, reason } = {}) {
    const metaMap = session.planMeta && session.planMeta.size ? session.planMeta : this._preparePlan(session.evaluationPlan);
    if (!metaMap || !metaMap.size) {
      this.logger.warn('[eval-orchestrator] No plan meta available for heuristic evaluation');
      return;
    }

    const groups = [];
    const timestamp = new Date().toISOString();

    metaMap.forEach((meta, groupId) => {
      const result = this._evaluateGroupHeuristic(meta, batch);
      const verdict = this._scoreToVerdict(result.score);
      const confidence = Math.round(Math.max(0, Math.min(1, result.score)) * 100);
      const rationale = result.bestChunk
        ? `Candidate mentioned: "${result.bestChunk.text}"`
        : meta.fallbackRationale || '';
      const followUp = confidence >= 60 ? [] : meta.probingQuestions.slice(0, 1);

      const existing = session.state.groups[groupId];
      const hasAuthoritativeSignal = existing && existing.source && existing.source !== 'heuristic';
      if (hasAuthoritativeSignal) {
        return;
      }

      groups.push({
        groupId,
        verdict,
        confidence,
        rationale,
        followUpQuestions: followUp,
        notableQuotes: result.bestChunk ? [result.bestChunk.text] : [],
        conflicts: [],
      });
    });

    const heuristicResult = { groups };
    await this._applyResult(session, heuristicResult, batch, { source: reason || 'heuristic', skipEvent: false });
  }

  _evaluateGroupHeuristic(meta, batch) {
    const keywords = meta.keywords || [];
    if (!keywords.length) {
      return { score: 0, bestChunk: null };
    }

    let bestScore = 0;
    let bestChunk = null;

    batch.forEach((chunk) => {
      const chunkTokens = this._tokenize(chunk.text);
      if (!chunkTokens.length) {
        return;
      }
      const hits = chunkTokens.filter((token) => keywords.includes(token));
      const uniqueHits = new Set(hits);
      const score = uniqueHits.size / keywords.length;

      if (score > bestScore) {
        bestScore = score;
        bestChunk = chunk;
      }
    });

    return { score: bestScore, bestChunk };
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
