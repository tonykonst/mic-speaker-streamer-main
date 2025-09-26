const { app, BrowserWindow, ipcMain } = require('electron');
const { initMain: initAudioLoopback } = require('electron-audio-loopback');
const path = require('node:path');
const fs = require('node:fs');
const { once, EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const dotenv = require('dotenv');

dotenv.config();

initAudioLoopback();

const appConfig = require('./config');
const { ClaudeClient } = require('./src/services/claudeClient');
const { EvaluationPlanService } = require('./src/services/evaluationPlan');
const { ClaudeEvaluationOrchestrator } = require('./src/services/evaluationOrchestrator');

const LOG_ROOT = path.resolve('./Logs');
const JOB_DATA_ROOT = path.resolve('./JobData');
const JOB_SESSION_ROOT = path.join(JOB_DATA_ROOT, 'sessions');
const V2_ROOT = path.join(JOB_DATA_ROOT, 'v2');
const JD_PLAN_ROOT = path.join(V2_ROOT, 'jd');
const EVALUATION_PLAN_FILE = 'evaluation_plan.json';
const JD_POINTER_FILE = 'active.json';
const JD_MARKDOWN_FILE = 'jd.md';
const JD_META_FILE = 'jd.meta.json';
const JD_REQUIREMENTS_FILE = 'requirements.json';
const JD_EMBEDDINGS_FILE = 'requirements.embeddings.json';
const JD_RESPONSE_MODEL = 'gpt-4o-mini';
const JD_EMBEDDING_MODEL = 'text-embedding-3-large';
const VALID_LOG_TYPES = new Set(['microphone', 'speaker']);

function sanitizeSegment(segment, label) {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty string`);
  }

  const safe = segment.replace(/[^A-Za-z0-9-_]/g, '-');
  if (!safe || safe.includes('..')) {
    throw new Error(`Invalid ${label}: contains prohibited characters`);
  }

  return safe;
}

class LogManager {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir);
    this.maxPartBytes = options.maxPartBytes ?? 10 * 1024 * 1024; // 10 MB per part
    this.highWaterMark = options.highWaterMark ?? 64 * 1024;
    this.items = new Map(); // key -> log state
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
  }

  async create(sessionId, type, header) {
    this._assertType(type);
    if (typeof header !== 'string') {
      throw new Error('Header must be a string');
    }

    const key = this._key(sessionId, type);
    if (this.items.has(key)) {
      throw new Error(`Log already exists for ${type}`);
    }

    await this.ensureRoot();

    const part = 1;
    const filePath = this._resolvePath(sessionId, type, part);
    const stream = await this._openStream(filePath);
    const headerBytes = await this._writeChunk(stream, header);

    const item = {
      key,
      sessionId: sanitizeSegment(sessionId, 'sessionId'),
      type,
      part,
      path: filePath,
      stream,
      size: headerBytes,
      header,
      createdAt: new Date(),
      totalBytes: headerBytes,
    };

    this.items.set(key, item);
    return { path: item.path, part: item.part, size: item.size };
  }

  async append(sessionId, type, chunk) {
    if (typeof chunk !== 'string') {
      throw new Error('Chunk must be a string');
    }

    const item = this._getItem(sessionId, type);
    const bytes = await this._writeChunk(item.stream, chunk);
    item.size += bytes;
    item.totalBytes += bytes;

    let rotated = false;
    if (item.size >= this.maxPartBytes) {
      await this._rotate(item);
      rotated = true;
    }

    return { path: item.path, part: item.part, size: item.size, rotated };
  }

  async finalize(sessionId, type, footer) {
    const item = this._getItem(sessionId, type);
    if (footer && typeof footer === 'string' && footer.length > 0) {
      const bytes = await this._writeChunk(item.stream, footer);
      item.size += bytes;
      item.totalBytes += bytes;
    }

    await this._fsync(item.stream);
    await this._endStream(item.stream);
    this.items.delete(this._key(sessionId, type));

    return { path: item.path, part: item.part, size: item.size };
  }

  async getStatus(sessionId, type) {
    const item = this._getItem(sessionId, type);
    return {
      path: item.path,
      part: item.part,
      size: item.size,
      createdAt: item.createdAt,
      totalBytes: item.totalBytes,
    };
  }

  hasActiveLogs() {
    return this.items.size > 0;
  }

  async shutdown(footerNote) {
    const results = [];
    const activeItems = [...this.items.values()];
    for (const item of activeItems) {
      try {
        const footer = footerNote ? `${footerNote}\n` : '';
        results.push(await this.finalize(item.sessionId, item.type, footer));
      } catch (error) {
        console.error(`Failed to finalize ${item.type} log on shutdown:`, error);
      }
    }
    return results;
  }

  async _rotate(item) {
    const nextPart = item.part + 1;
    const nextPath = this._resolvePath(item.sessionId, item.type, nextPart);

    await this._endStream(item.stream);

    const stream = await this._openStream(nextPath);
    const headerForPart = this._headerForPart(item.header, nextPart);
    const headerBytes = await this._writeChunk(stream, headerForPart);

    item.part = nextPart;
    item.path = nextPath;
    item.stream = stream;
    item.size = headerBytes;
    item.totalBytes += headerBytes;
  }

  async _openStream(filePath) {
    const stream = fs.createWriteStream(filePath, {
      flags: 'a',
      encoding: 'utf8',
      highWaterMark: this.highWaterMark,
    });

    stream.on('error', (error) => {
      console.error(`Log stream error for ${filePath}:`, error);
    });

    return stream;
  }

  async _writeChunk(stream, chunk) {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    if (bytes === 0) {
      return 0;
    }

    if (!stream.write(chunk)) {
      await once(stream, 'drain');
    }

    return bytes;
  }

  async _endStream(stream) {
    if (!stream || stream.destroyed || stream.closed) {
      return;
    }

    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve()));
    });

    if (!stream.closed) {
      await once(stream, 'close').catch(() => {});
    }
  }

  async _fsync(stream) {
    if (!stream || typeof stream.fd !== 'number') {
      return;
    }

    try {
      await fs.promises.fsync(stream.fd);
    } catch (error) {
      console.error('fsync failed:', error);
    }
  }

  _resolvePath(sessionId, type, part) {
    const safeSession = sanitizeSegment(sessionId, 'sessionId');
    const base = `${type}_${safeSession}`;
    const suffix = part > 1 ? `_part${String(part).padStart(2, '0')}` : '';
    const fileName = `${base}${suffix}.md`;
    const fullPath = path.join(this.rootDir, fileName);
    const resolved = path.resolve(fullPath);

    if (!resolved.startsWith(this.rootDir)) {
      throw new Error('Resolved path escapes log root directory');
    }

    return resolved;
  }

  _headerForPart(header, part) {
    if (part === 1) {
      return header;
    }

    const needsTrailingNewline = !header.endsWith('\n');
    const base = needsTrailingNewline ? `${header}\n` : header;
    return `${base}> Continued — part ${part}\n\n`;
  }

  _key(sessionId, type) {
    const safeSession = sanitizeSegment(sessionId, 'sessionId');
    return `${safeSession}:${type}`;
  }

  _getItem(sessionId, type) {
    const key = this._key(sessionId, type);
    const item = this.items.get(key);
    if (!item) {
      throw new Error(`Log not initialized for ${type}`);
    }
    return item;
  }

  _assertType(type) {
    if (!VALID_LOG_TYPES.has(type)) {
      throw new Error(`Unsupported log type: ${type}`);
    }
  }
}

const logManager = new LogManager(LOG_ROOT, {
  maxPartBytes: 10 * 1024 * 1024,
  highWaterMark: 64 * 1024,
});

const claudeClient = new ClaudeClient({
  apiKey: appConfig.claudeApiKey,
  apiVersion: appConfig.claudeApiVersion,
});

const evaluationPlanService = new EvaluationPlanService({
  claudeClient,
  logger: console,
  model: appConfig.claudeModel,
});

const useClaudeCoach = Boolean(appConfig.useClaudeCoach && evaluationPlanService.isEnabled);
let activeEvaluationPlan = null;

function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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

async function ensureV2Roots() {
  await fs.promises.mkdir(JD_PLAN_ROOT, { recursive: true });
}

async function saveEvaluationPlan(jdId, plan) {
  if (!plan || !jdId) {
    return null;
  }
  await ensureV2Roots();
  const dir = path.join(JD_PLAN_ROOT, sanitizeSegment(jdId, 'jdId'));
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, EVALUATION_PLAN_FILE);
  await writeJson(filePath, plan);
  return filePath;
}

async function loadEvaluationPlan(jdId) {
  if (!jdId) {
    return null;
  }
  const dir = path.join(JD_PLAN_ROOT, sanitizeSegment(jdId, 'jdId'));
  const filePath = path.join(dir, EVALUATION_PLAN_FILE);
  return await readJsonSafe(filePath);
}

async function upsertEvaluationPlan(jdData, { regenerate = false } = {}) {
  if (!jdData || !jdData.jdId) {
    return { plan: null, generated: false };
  }

  if (!regenerate) {
    const existing = await loadEvaluationPlan(jdData.jdId);
    if (existing) {
      return { plan: existing, generated: false };
    }
  }

  if (!useClaudeCoach) {
    return { plan: await loadEvaluationPlan(jdData.jdId), generated: false };
  }

  const generatedPlan = await evaluationPlanService.generatePlan({
    jdText: jdData.text,
    sessionId: jdData.jdId,
  });

  if (generatedPlan) {
    generatedPlan.jdId = jdData.jdId;
    if (!generatedPlan.generatedAt) {
      generatedPlan.generatedAt = new Date().toISOString();
    }
    await saveEvaluationPlan(jdData.jdId, generatedPlan);
    return { plan: generatedPlan, generated: true };
  }

  return { plan: null, generated: false };
}

class JDManager {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.pointerPath = path.join(this.rootDir, JD_POINTER_FILE);
    this.active = null;
    this.ready = this.bootstrap();
  }

  async bootstrap() {
    await this.ensureRoot();
    const pointer = await readJsonSafe(this.pointerPath);
    if (pointer?.activeId) {
      try {
        await this._loadActive(pointer.activeId);
      } catch (error) {
        console.error('Failed to load active JD from disk:', error);
        this.active = null;
      }
    }
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
  }

  async getActive() {
    await this.ready;
    if (!this.active) {
      return null;
    }
    return this._formatActive(this.active);
  }

  async setJD({ text, source }) {
    await this.ready;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('JD text must be a non-empty string');
    }

    const jdId = this._generateId(text);
    const dir = path.join(this.rootDir, jdId);
    await fs.promises.mkdir(dir, { recursive: true });

    const normalizedSource = {
      type: source?.type ?? 'manual',
      name: source?.name ?? null,
    };

    const checksum = hashText(text);
    const timestamps = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const meta = {
      jdId,
      checksum,
      ...timestamps,
      source: normalizedSource,
    };

    await fs.promises.writeFile(path.join(dir, JD_MARKDOWN_FILE), text, 'utf8');
    await writeJson(path.join(dir, JD_META_FILE), meta);

    const extraction = await this._extractRequirements({ text, jdId, dir, meta });

    const active = {
      ...meta,
      dir,
      snippet: this._snippet(text),
      text,
      requirements: extraction.requirements,
      embeddings: extraction.embeddings,
      revision: extraction.revision,
      extractionSource: extraction.source,
    };

    this.active = active;
    await writeJson(this.pointerPath, { activeId: jdId });

    await writeJson(path.join(dir, JD_REQUIREMENTS_FILE), {
      revision: active.revision,
      generatedAt: timestamps.updatedAt,
      source: active.extractionSource,
      requirements: active.requirements,
    });

    if (active.embeddings) {
      await writeJson(path.join(dir, JD_EMBEDDINGS_FILE), active.embeddings);
    }

    return this._formatActive(active);
  }

  async clear() {
    await this.ready;
    this.active = null;
    await writeJson(this.pointerPath, { activeId: null });
    return { success: true };
  }

  _formatActive(active) {
    return {
      jdId: active.jdId,
      snippet: active.snippet,
      text: active.text,
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
      source: active.source,
      revision: active.revision,
      requirements: active.requirements,
      embeddings: active.embeddings,
    };
  }

  _generateId(text) {
    const hash = hashText(text).slice(0, 8);
    return `jd-${Date.now()}-${hash}`;
  }

  _snippet(text) {
    return text.trim().split(/\s+/).slice(0, 80).join(' ');
  }

  async _loadActive(jdId) {
    const safeId = sanitizeSegment(jdId, 'jdId');
    const dir = path.join(this.rootDir, safeId);
    const [text, meta, requirements, embeddings] = await Promise.all([
      fs.promises.readFile(path.join(dir, JD_MARKDOWN_FILE), 'utf8'),
      readJsonSafe(path.join(dir, JD_META_FILE)),
      readJsonSafe(path.join(dir, JD_REQUIREMENTS_FILE)),
      readJsonSafe(path.join(dir, JD_EMBEDDINGS_FILE)),
    ]);

    if (!meta) {
      throw new Error('JD metadata missing');
    }

    this.active = {
      ...meta,
      dir,
      text,
      snippet: this._snippet(text),
      requirements: requirements?.requirements ?? [],
      revision: requirements?.revision ?? 0,
      embeddings: embeddings ?? null,
      extractionSource: requirements?.source ?? 'disk',
    };
  }

  async _extractRequirements({ text, jdId, dir, meta }) {
    const apiKey = process.env.OPENAI_KEY;
    if (!apiKey) {
      console.warn('OPENAI_KEY not configured; falling back to heuristic JD parsing');
      return this._fallbackExtraction(text);
    }

    try {
      const requirements = await this._callRequirementModel(text, apiKey);
      const embeddings = await this._computeEmbeddings(requirements, apiKey);
      return {
        requirements,
        embeddings,
        revision: Date.now(),
        source: {
          type: 'openai.responses',
          model: JD_RESPONSE_MODEL,
          embeddingModel: JD_EMBEDDING_MODEL,
        },
      };
    } catch (error) {
      console.error('JD requirement extraction failed, using heuristic fallback:', error);
      return this._fallbackExtraction(text);
    }
  }

  _fallbackExtraction(text) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const bullets = lines.filter((line) => /^[-*•]/.test(line));
    const requirements = (bullets.length > 0 ? bullets : lines.slice(0, 10)).map((line, index) => ({
      id: `fallback-${index + 1}`,
      title: line.replace(/^[-*•]\s*/, '').slice(0, 80),
      description: line.replace(/^[-*•]\s*/, ''),
      priority: 'medium',
      competencies: [],
      mustHave: true,
      niceToHave: false,
      probingQuestions: [],
    }));

    return {
      requirements,
      embeddings: null,
      revision: Date.now(),
      source: {
        type: 'fallback',
      },
    };
  }

  async _callRequirementModel(text, apiKey) {
    const schema = {
      name: 'jd_requirements',
      schema:
      {
        type: 'object',
        properties: {
          requirements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                priority: { type: 'string', enum: ['low', 'medium', 'high'] },
                competencies: {
                  type: 'array',
                  items: { type: 'string' },
                },
                mustHave: { type: 'boolean' },
                niceToHave: { type: 'boolean' },
                probingQuestions: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['id', 'title', 'description', 'priority', 'mustHave', 'niceToHave'],
            },
          },
        },
        required: ['requirements'],
        additionalProperties: false,
      },
    };

    const body = {
      model: JD_RESPONSE_MODEL,
      response_format: {
        type: 'json_schema',
        json_schema: schema,
      },
      input: [
        {
          role: 'system',
          content:
            'You extract structured hiring requirements from job descriptions. Return concise, unique requirement IDs and probing questions to validate each skill.',
        },
        {
          role: 'user',
          content: `Job Description:\n\n${text}`,
        },
      ],
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI responses error: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    const message = payload.output?.[0]?.content?.find((item) => item.type === 'output_json');
    const jsonData = message?.json;
    if (!jsonData?.requirements) {
      throw new Error('Unexpected responses payload format');
    }

    return jsonData.requirements.map((req, index) => ({
      id: req.id || `req-${index + 1}`,
      title: req.title?.trim() || req.description?.slice(0, 60) || `Requirement ${index + 1}`,
      description: req.description?.trim() || '',
      priority: req.priority || 'medium',
      competencies: Array.isArray(req.competencies) ? req.competencies : [],
      mustHave: Boolean(req.mustHave),
      niceToHave: Boolean(req.niceToHave),
      probingQuestions: Array.isArray(req.probingQuestions) ? req.probingQuestions : [],
    }));
  }

  async _computeEmbeddings(requirements, apiKey) {
    if (!requirements?.length) {
      return null;
    }

    const inputs = requirements.map((req) => {
      const competencies = req.competencies?.length ? `\nCompetencies: ${req.competencies.join(', ')}` : '';
      return `${req.title}\n${req.description}${competencies}`.trim();
    });

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: JD_EMBEDDING_MODEL,
        input: inputs,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI embeddings error: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload.data)) {
      throw new Error('Unexpected embeddings payload format');
    }

    const vectors = {};
    payload.data.forEach((item, index) => {
      const requirement = requirements[index];
      if (!requirement) {
        return;
      }
      vectors[requirement.id] = {
        embedding: item.embedding,
        index,
      };
    });

    return {
      model: JD_EMBEDDING_MODEL,
      vectors,
      generatedAt: new Date().toISOString(),
    };
  }
}

const jdManager = new JDManager(JOB_DATA_ROOT);

function tokenize(text) {
  if (typeof text !== 'string') {
    return [];
  }
  const matches = text
    .toLowerCase()
    .replace(/[^a-z0-9+#+\.\s-]/gi, ' ')
    .match(/[a-z0-9+#+\.]{2,}/gi);
  if (!matches) {
    return [];
  }
  return matches.map((token) => token.toLowerCase());
}

function cosineOverlapScore(chunkTokens, requirementTokens) {
  if (!chunkTokens.length || !requirementTokens.length) {
    return 0;
  }
  const chunkSet = new Set(chunkTokens);
  const requirementSet = new Set(requirementTokens);
  let overlap = 0;
  for (const token of requirementSet) {
    if (chunkSet.has(token)) {
      overlap += 1;
    }
  }
  return overlap / requirementSet.size;
}

class EvidenceTracker extends EventEmitter {
  constructor(rootDir) {
    super();
    this.rootDir = path.resolve(rootDir);
    this.sessions = new Map();
    this.requirements = [];
    this.requirementIndex = [];
    this.embeddings = null;
    this.flushIntervalMs = 5000;
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
  }

  async handleJDUpdate(jdData) {
    await this.ensureRoot();
    this.requirements = Array.isArray(jdData?.requirements) ? jdData.requirements : [];
    this.embeddings = jdData?.embeddings ?? null;
    this.requirementIndex = this.requirements.map((req) => ({
      id: req.id,
      title: req.title,
      tokens: tokenize(`${req.title || ''} ${req.description || ''} ${(req.competencies || []).join(' ')}`)
        .filter((token) => token.length > 2),
      priority: req.priority || 'medium',
    }));
    this.emit('jd-updated', {
      requirements: this.requirements,
      embeddings: this.embeddings,
    });
  }

  async clearJD() {
    this.requirements = [];
    this.requirementIndex = [];
    this.embeddings = null;
    this.emit('jd-updated', { requirements: [] });
  }

  async recordChunk(chunk) {
    if (!chunk || !chunk.sessionId || !chunk.text) {
      return { ignored: true };
    }

    await this.ensureRoot();
    const session = await this._ensureSession(chunk.sessionId);

    const matches = this._scoreChunk(chunk.text);
    const bestMatches = matches.slice(0, 5);

    const event = {
      chunkId: chunk.chunkId,
      sessionId: session.sessionId,
      source: chunk.source,
      timestamp: chunk.timestamp,
      text: chunk.text.slice(0, 5000),
      matchedRequirements: bestMatches.map((match) => ({
        requirementId: match.id,
        score: match.score,
        tokens: match.tokens,
      })),
      createdAt: new Date().toISOString(),
    };

    await this._appendEvent(session, event);
    const stateUpdated = this._updateState(session, bestMatches, event);
    if (stateUpdated) {
      await this._maybePersistState(session, false);
      this.emit('state-changed', {
        sessionId: session.sessionId,
        revision: session.state.revision,
        requirements: session.state.requirements,
      });
    }

    return { recorded: true, matches: bestMatches.length };
  }

  async flushAll() {
    const tasks = [];
    for (const session of this.sessions.values()) {
      tasks.push(this._maybePersistState(session, true));
      if (session.stream && !session.stream.closed) {
        session.stream.end();
      }
    }
    await Promise.allSettled(tasks);
  }

  async _ensureSession(sessionId) {
    const safeSession = sanitizeSegment(sessionId, 'sessionId');
    let session = this.sessions.get(safeSession);
    if (session) {
      return session;
    }

    const dir = path.join(JOB_SESSION_ROOT, safeSession);
    await fs.promises.mkdir(dir, { recursive: true });
    const eventsPath = path.join(dir, 'evidence.ndjson');
    const statePath = path.join(dir, 'evidence.state.json');
    const state = (await readJsonSafe(statePath)) || {
      sessionId: safeSession,
      revision: 0,
      requirements: {},
      lastChunkAt: null,
    };
    const stream = fs.createWriteStream(eventsPath, { flags: 'a', encoding: 'utf8' });

    session = {
      sessionId: safeSession,
      dir,
      eventsPath,
      statePath,
      state,
      stream,
      lastPersistAt: Date.now(),
    };

    this.sessions.set(safeSession, session);
    return session;
  }

  _scoreChunk(text) {
    if (!this.requirementIndex.length) {
      return [];
    }
    const tokens = tokenize(text);
    if (!tokens.length) {
      return [];
    }

    const matches = [];
    for (const req of this.requirementIndex) {
      if (!req.tokens.length) {
        continue;
      }
      const score = cosineOverlapScore(tokens, req.tokens);
      if (score > 0) {
        const matchedTokens = req.tokens.filter((token) => tokens.includes(token));
        matches.push({
          id: req.id,
          score,
          tokens: matchedTokens.slice(0, 5),
          priority: req.priority,
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  async _appendEvent(session, event) {
    return new Promise((resolve, reject) => {
      const payload = `${JSON.stringify(event)}\n`;
      if (!session.stream.write(payload)) {
        session.stream.once('drain', resolve);
      } else {
        resolve();
      }
    }).catch((error) => {
      console.error('Failed to append evidence event:', error);
    });
  }

  _updateState(session, matches, event) {
    if (!matches.length) {
      return false;
    }

    const state = session.state;
    state.revision += 1;
    state.lastChunkAt = event.timestamp;
    const requirementsState = state.requirements;

    let updated = false;
    for (const match of matches) {
      const requirementState = requirementsState[match.id] || {
        id: match.id,
        confidence: 0,
        status: 'unknown',
        evidence: [],
        lastUpdated: null,
        observations: 0,
        topScore: 0,
      };

      const entry = {
        chunkId: event.chunkId,
        timestamp: event.timestamp,
        source: event.source,
        score: Math.round(match.score * 1000) / 1000,
        text: event.text.slice(0, 240),
        tokens: match.tokens,
      };

      requirementState.evidence.unshift(entry);
      if (requirementState.evidence.length > 6) {
        requirementState.evidence.pop();
      }

      requirementState.observations += 1;
      requirementState.topScore = Math.max(requirementState.topScore, match.score);
      const weightedScore = (match.score * 100) * 0.6 + requirementState.confidence * 0.4;
      requirementState.confidence = Math.min(100, Math.round(weightedScore));
      requirementState.status = this._confidenceToStatus(requirementState.confidence);
      requirementState.lastUpdated = event.timestamp;

      requirementsState[match.id] = requirementState;
      updated = true;
    }

    return updated;
  }

  _confidenceToStatus(confidence) {
    if (confidence >= 70) {
      return 'confirmed';
    }
    if (confidence >= 30) {
      return 'likely';
    }
    if (confidence > 0) {
      return 'possible';
    }
    return 'unknown';
  }

  async _maybePersistState(session, force) {
    const now = Date.now();
    if (!force && now - session.lastPersistAt < this.flushIntervalMs) {
      return;
    }
    session.lastPersistAt = now;
    await writeJson(session.statePath, session.state);
  }
}

class ReasoningEngine extends EventEmitter {
  constructor(rootDir) {
    super();
    this.rootDir = path.resolve(rootDir);
    this.sessions = new Map();
    this.requirementsMeta = new Map();
    this.flushIntervalMs = 5000;
    this.promptCooldownMs = 3 * 60 * 1000; // 3 minutes
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
  }

  async handleJDUpdate(jdData) {
    await this.ensureRoot();
    this.requirementsMeta.clear();
    if (jdData && Array.isArray(jdData.requirements)) {
      for (const req of jdData.requirements) {
        this.requirementsMeta.set(req.id, {
          id: req.id,
          title: req.title,
          description: req.description,
          priority: req.priority || 'medium',
          mustHave: req.mustHave !== false,
          niceToHave: Boolean(req.niceToHave),
          probingQuestions: Array.isArray(req.probingQuestions) ? req.probingQuestions : [],
        });
      }
    }
    for (const session of this.sessions.values()) {
      session.promptTracker = {};
    }
  }

  async clearJD() {
    this.requirementsMeta.clear();
    for (const session of this.sessions.values()) {
      session.state.requirements = {};
      session.promptTracker = {};
      session.state.updatedAt = new Date().toISOString();
      session.state.revision += 1;
      await this._maybePersist(session, true);
      this.emit('state-cleared', { sessionId: session.sessionId });
    }
  }

  async handleEvidenceUpdate(payload) {
    if (!payload?.sessionId) {
      return;
    }
    await this.ensureRoot();
    const session = await this._ensureSession(payload.sessionId);
    const requirementsPayload = payload.requirements || {};
    let changed = false;
    const summary = [];
    const nowIso = new Date().toISOString();

    for (const [requirementId, evidence] of Object.entries(requirementsPayload)) {
      const evaluation = this._evaluateRequirement(requirementId, evidence);
      const prev = session.state.requirements[requirementId];
      const history = prev?.history ? [...prev.history] : [];
      if (prev && prev.verdict && prev.verdict !== evaluation.verdict) {
        history.unshift({
          at: nowIso,
          from: prev.verdict,
          to: evaluation.verdict,
        });
        if (history.length > 10) {
          history.pop();
        }
      }

      const requirementState = {
        id: requirementId,
        title: evaluation.meta.title,
        priority: evaluation.meta.priority,
        mustHave: evaluation.meta.mustHave,
        niceToHave: evaluation.meta.niceToHave,
        confidence: evaluation.confidence,
        verdict: evaluation.verdict,
        reasoning: evaluation.reasoning,
        followUpQuestion: evaluation.followUpQuestion,
        lastUpdated: nowIso,
        evidence: evidence.evidence || [],
        observations: evidence.observations || 0,
        topScore: evidence.topScore || 0,
        history,
      };

      session.state.requirements[requirementId] = requirementState;
      summary.push({
        id: requirementId,
        title: evaluation.meta.title,
        confidence: evaluation.confidence,
        verdict: evaluation.verdict,
        reasoning: evaluation.reasoning,
        followUpQuestion: evaluation.followUpQuestion,
        mustHave: evaluation.meta.mustHave,
        niceToHave: evaluation.meta.niceToHave,
        lastUpdated: nowIso,
      });

      changed = changed || !prev || prev.verdict !== evaluation.verdict || prev.confidence !== evaluation.confidence;

      if (evaluation.prompt) {
        const prompted = this._maybePrompt(session, requirementId, evaluation.prompt);
        if (prompted) {
          changed = true;
        }
      }
    }

    if (!summary.length) {
      return;
    }

    session.state.revision = payload.revision;
    session.state.updatedAt = nowIso;
    session.state.overallFit = this._computeOverallFit(session.state.requirements);

    await this._maybePersist(session, false);

    const updatePayload = {
      sessionId: session.sessionId,
      revision: session.state.revision,
      updatedAt: session.state.updatedAt,
      overallFit: session.state.overallFit,
      requirements: summary,
    };
    this.emit('update', updatePayload);
  }

  _evaluateRequirement(requirementId, evidence) {
    const meta = this.requirementsMeta.get(requirementId) || {
      id: requirementId,
      title: requirementId,
      priority: 'medium',
      mustHave: true,
      niceToHave: false,
      probingQuestions: [],
    };
    const confidence = Math.max(0, Math.min(100, evidence.confidence ?? 0));
    const status = evidence.status || 'unknown';
    let verdict = 'unknown';

    if (status === 'confirmed' || confidence >= 75) {
      verdict = 'satisfied';
    } else if (status === 'likely' || confidence >= 55) {
      verdict = 'likely';
    } else if (confidence > 0) {
      verdict = 'needs_more';
    }

    if (evidence.observations >= 3 && confidence < 25 && (evidence.topScore ?? 0) < 0.2) {
      verdict = 'risk';
    }

    const topEvidence = Array.isArray(evidence.evidence) ? evidence.evidence[0] : null;
    const reasoning = topEvidence
      ? `Recent evidence (${topEvidence.source ?? 'stream'} @ ${topEvidence.timestamp ?? 'unknown'}): "${topEvidence.text ?? ''}" (score ${topEvidence.score ?? 0}).`
      : 'No supporting evidence collected yet.';

    let followUpQuestion = null;
    if (verdict === 'needs_more') {
      followUpQuestion = meta.probingQuestions?.[0] || null;
    }

    const prompt = followUpQuestion && verdict === 'needs_more'
      ? {
          requirementId,
          requirementTitle: meta.title,
          question: followUpQuestion,
          priority: meta.priority,
          mustHave: meta.mustHave,
        }
      : null;

    return {
      meta,
      confidence,
      verdict,
      reasoning,
      followUpQuestion,
      prompt,
    };
  }

  _computeOverallFit(requirementsMap) {
    const entries = Object.values(requirementsMap || {});
    if (!entries.length) {
      return 0;
    }
    let weightedScore = 0;
    let totalWeight = 0;
    for (const req of entries) {
      const weight = req.mustHave ? 1.5 : 1;
      weightedScore += (req.confidence ?? 0) * weight;
      totalWeight += weight;
    }
    if (!totalWeight) {
      return 0;
    }
    return Math.round(weightedScore / totalWeight);
  }

  async _ensureSession(sessionId) {
    const safeSession = sanitizeSegment(sessionId, 'sessionId');
    let session = this.sessions.get(safeSession);
    if (session) {
      return session;
    }

    const dir = path.join(this.rootDir, safeSession);
    await fs.promises.mkdir(dir, { recursive: true });
    const statePath = path.join(dir, 'reasoning.state.json');
    const guidancePath = path.join(dir, 'guidance.ndjson');
    const state = (await readJsonSafe(statePath)) || {
      sessionId: safeSession,
      revision: 0,
      updatedAt: null,
      overallFit: 0,
      requirements: {},
    };

    session = {
      sessionId: safeSession,
      dir,
      statePath,
      guidancePath,
      state,
      lastPersistAt: Date.now(),
      promptTracker: {},
    };

    this.sessions.set(safeSession, session);
    return session;
  }

  async _maybePersist(session, force) {
    const now = Date.now();
    if (!force && now - session.lastPersistAt < this.flushIntervalMs) {
      return;
    }
    session.lastPersistAt = now;
    await writeJson(session.statePath, session.state);
  }

  _maybePrompt(session, requirementId, prompt) {
    if (!prompt) {
      return false;
    }
    const tracker = session.promptTracker[requirementId] || { lastPromptAt: 0, count: 0 };
    const now = Date.now();
    if (now - tracker.lastPromptAt < this.promptCooldownMs) {
      return false;
    }

    const entry = {
      sessionId: session.sessionId,
      requirementId,
      requirementTitle: prompt.requirementTitle,
      question: prompt.question,
      priority: prompt.priority,
      mustHave: prompt.mustHave,
      createdAt: new Date(now).toISOString(),
    };
    tracker.lastPromptAt = now;
    tracker.count += 1;
    session.promptTracker[requirementId] = tracker;

    this.emit('guidance', entry);
    void this._appendGuidance(session, entry);
    return true;
  }

  async _appendGuidance(session, entry) {
    try {
      await fs.promises.appendFile(session.guidancePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      console.error('Failed to append guidance entry:', error);
    }
  }

  async flushAll() {
    const tasks = [];
    for (const session of this.sessions.values()) {
      tasks.push(this._maybePersist(session, true));
    }
    await Promise.allSettled(tasks);
  }

  async getState(sessionId) {
    const session = await this._ensureSession(sessionId);
    return session.state;
  }
}

const reasoningEngine = new ReasoningEngine(JOB_SESSION_ROOT);
const evidenceTracker = new EvidenceTracker(JOB_SESSION_ROOT);
const evaluationOrchestrator = useClaudeCoach
  ? new ClaudeEvaluationOrchestrator({
      claudeClient,
      rootDir: path.join(V2_ROOT, 'sessions'),
      model: appConfig.claudeModel,
      logger: console,
    })
  : null;

async function bootstrapEvidenceTracker() {
  const active = await jdManager.getActive();
  if (active) {
    await evidenceTracker.handleJDUpdate(active);
    await reasoningEngine.handleJDUpdate(active);
    try {
      const { plan } = await upsertEvaluationPlan(active, { regenerate: false });
      if (plan) {
        activeEvaluationPlan = plan;
        if (useClaudeCoach) {
          evaluationOrchestrator?.setActivePlan(plan);
        }
        broadcast('jd-evaluation-plan', { jdId: active.jdId, plan });
      }
    } catch (error) {
      console.error('Bootstrap evaluation plan failed:', error);
    }
  }
}

void bootstrapEvidenceTracker();

function broadcast(channel, payload) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      console.error('Failed to broadcast message:', error);
    }
  }
}

function convertReasoningPayload(payload) {
  if (!payload) {
    return {
      sessionId: null,
      overallFit: 0,
      updatedAt: null,
      revision: 0,
      requirements: {},
      groups: [],
    };
  }
  const mapped = {
    sessionId: payload.sessionId,
    overallFit: payload.overallFit ?? 0,
    updatedAt: payload.updatedAt ?? null,
    revision: payload.revision ?? 0,
    requirements: {},
    groups: [],
  };
  if (Array.isArray(payload.groups)) {
    mapped.groups = payload.groups.map((group) => ({
      id: group.id || group.groupId,
      title: group.title || group.id,
      verdict: group.verdict || group.status || 'unknown',
      confidence: group.confidence ?? 0,
      rationale: group.rationale || '',
      followUpQuestion: group.followUpQuestion || null,
      notableQuotes: group.notableQuotes || [],
      conflicts: group.conflicts || [],
      lastUpdated: group.lastUpdated || mapped.updatedAt,
    }));
    mapped.groups.forEach((group) => {
      mapped.requirements[group.id] = {
        id: group.id,
        title: group.title,
        verdict: group.verdict,
        confidence: group.confidence,
        reasoning: group.rationale,
        followUpQuestion: group.followUpQuestion,
        evidence: (group.notableQuotes || []).map((quote) => ({ text: quote })),
      };
    });
  } else if (payload.groups && typeof payload.groups === 'object') {
    const arrayFromMap = Object.values(payload.groups).map((group) => ({
      id: group.id || group.groupId,
      title: group.title || group.id,
      verdict: group.verdict || group.status || 'unknown',
      confidence: group.confidence ?? 0,
      rationale: group.rationale || '',
      followUpQuestion: group.followUpQuestion || null,
      notableQuotes: group.notableQuotes || [],
      conflicts: group.conflicts || [],
      lastUpdated: group.lastUpdated || mapped.updatedAt,
    }));
    mapped.groups = arrayFromMap;
    arrayFromMap.forEach((group) => {
      mapped.requirements[group.id] = {
        id: group.id,
        title: group.title,
        verdict: group.verdict,
        confidence: group.confidence,
        reasoning: group.rationale,
        followUpQuestion: group.followUpQuestion,
        evidence: (group.notableQuotes || []).map((quote) => ({ text: quote })),
      };
    });
  }

  if (!mapped.groups.length && Array.isArray(payload.requirements)) {
    mapped.groups = payload.requirements.map((item) => ({
      id: item.id,
      title: item.title || item.id,
      verdict: item.verdict || item.status || 'unknown',
      confidence: item.confidence ?? 0,
      rationale: item.reasoning || '',
      followUpQuestion: item.followUpQuestion || null,
      notableQuotes: Array.isArray(item.evidence)
        ? item.evidence.map((evidence) => evidence.text).filter(Boolean)
        : [],
      conflicts: [],
      lastUpdated: item.lastUpdated || mapped.updatedAt,
    }));
  }

  if (!mapped.requirements || !Object.keys(mapped.requirements).length) {
    if (Array.isArray(payload.requirements)) {
      for (const item of payload.requirements) {
        mapped.requirements[item.id] = {
          ...item,
        };
      }
    }
  }
  return mapped;
}

evidenceTracker.on('state-changed', (payload) => {
  broadcast('evidence-updated', payload);
  if (!useClaudeCoach) {
    void reasoningEngine.handleEvidenceUpdate(payload);
  }
});

evidenceTracker.on('jd-updated', (payload) => {
  broadcast('jd-evidence-updated', payload);
});

if (useClaudeCoach && evaluationOrchestrator) {
  evaluationOrchestrator.on('update', (payload) => {
    broadcast('reasoning-update', payload);
    void reportManager.handleReasoningUpdate(payload);
  });

  evaluationOrchestrator.on('guidance-reset', (payload) => {
    broadcast('guidance-reset', payload);
  });

  evaluationOrchestrator.on('conflict', (payload) => {
    broadcast('evaluation-conflict', payload);
  });
} else {
  reasoningEngine.on('update', (payload) => {
    broadcast('reasoning-update', payload);
    void reportManager.handleReasoningUpdate(payload);
  });

  reasoningEngine.on('guidance', (payload) => {
    broadcast('guidance-prompt', payload);
  });
}

class ReportManager {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.sessions = new Map();
    this.template = this._defaultTemplate();
    this.debounceMs = 5000;
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
  }

  async handleReasoningUpdate(payload) {
    if (!payload?.sessionId) {
      return;
    }
    await this.ensureRoot();
    const session = await this._ensureSession(payload.sessionId);
    session.state = convertReasoningPayload(payload);
    session.state.updatedAt = payload.updatedAt;
    session.state.revision = payload.revision;
    await this._maybePersist(session, false);
  }

  async exportReport(sessionId) {
    await this.ensureRoot();
    const session = await this._ensureSession(sessionId);
    const reportJsonPath = path.join(session.dir, 'report.json');
    const reportMarkdownPath = path.join(session.dir, 'report.md');
    await this._maybePersist(session, true);
    const markdown = this._renderMarkdown(session.state);
    await writeJson(reportJsonPath, session.state);
    await fs.promises.writeFile(reportMarkdownPath, `${markdown}\n`, 'utf8');
    return { path: reportMarkdownPath };
  }

  async _ensureSession(sessionId) {
    const safeSession = sanitizeSegment(sessionId, 'sessionId');
    let session = this.sessions.get(safeSession);
    if (session) {
      return session;
    }
    const dir = path.join(this.rootDir, safeSession);
    await fs.promises.mkdir(dir, { recursive: true });
    const statePath = path.join(dir, 'report.json');
    const state = (await readJsonSafe(statePath)) || {
      sessionId: safeSession,
      overallFit: 0,
      updatedAt: null,
      revision: 0,
      requirements: {},
    };
    session = {
      sessionId: safeSession,
      dir,
      statePath,
      state,
      lastPersistAt: Date.now(),
    };
    this.sessions.set(safeSession, session);
    return session;
  }

  async _maybePersist(session, force) {
    const now = Date.now();
    if (!force && now - session.lastPersistAt < this.debounceMs) {
      return;
    }
    session.lastPersistAt = now;
    await writeJson(session.statePath, session.state);
  }

  _renderMarkdown(state) {
    const lines = [];
    lines.push(`# Session Report — ${state.sessionId}`);
    lines.push('');
    lines.push(`- Updated: ${state.updatedAt || 'N/A'}`);
    lines.push(`- Overall Fit: ${state.overallFit ?? 'N/A'}%`);
    lines.push(`- Revision: ${state.revision ?? 0}`);
    lines.push('');
    lines.push('## Requirements');
    lines.push('');
    const requirements = Object.values(state.requirements || {});
    if (!requirements.length) {
      lines.push('No requirements evaluated yet.');
    } else {
      for (const req of requirements) {
        lines.push(`### ${req.title || req.id}`);
        lines.push(`- Verdict: ${req.verdict || 'unknown'}`);
        lines.push(`- Confidence: ${req.confidence ?? 0}%`);
        lines.push(`- Status: ${req.status || req.verdict || 'unknown'}`);
        if (req.reasoning) {
          lines.push(`- Reasoning: ${req.reasoning}`);
        }
        if (req.followUpQuestion) {
          lines.push(`- Suggested question: ${req.followUpQuestion}`);
        }
        lines.push('');
        const evidence = req.evidence || [];
        if (evidence.length) {
          lines.push('> Evidence snippets:');
          evidence.slice(0, 5).forEach((entry) => {
            lines.push(`> - (${entry.source || 'stream'} @ ${entry.timestamp || 'unknown'}) score ${entry.score ?? 0}: ${entry.text}`);
          });
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  _defaultTemplate() {
    return `# Session Report — {{sessionId}}

- Updated: {{updatedAt}}
- Overall Fit: {{overallFit}}%
- Revision: {{revision}}

## Requirements

{{#requirements}}
### {{title}}
- Verdict: {{verdict}}
- Confidence: {{confidence}}%
- Status: {{status}}
- Reasoning: {{reasoning}}
- Suggested question: {{followUpQuestion}}

> Evidence snippets:
{{#evidence}}
> - ({{source}} @ {{timestamp}}) score {{score}}: {{text}}
{{/evidence}}

{{/requirements}}`;
  }

  async flushAll() {
    const tasks = [];
    for (const session of this.sessions.values()) {
      tasks.push(this._maybePersist(session, true));
    }
    await Promise.allSettled(tasks);
  }
}

const reportManager = new ReportManager(JOB_SESSION_ROOT);

function validateLogDirectory(dirPath) {
  const resolved = path.resolve(dirPath);
  if (!resolved.startsWith(LOG_ROOT)) {
    throw new Error('Invalid directory path: Only Logs directory allowed');
  }
  return resolved;
}

ipcMain.handle('ensure-log-directory', async (_event, dirPath) => {
  try {
    const target = validateLogDirectory(dirPath);
    await fs.promises.mkdir(target, { recursive: true });
    return { success: true };
  } catch (error) {
    console.error('Error creating log directory:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-log', async (_event, sessionId, type, header) => {
  try {
    const result = await logManager.create(sessionId, type, header);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error creating log stream:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('append-log', async (_event, sessionId, type, chunk) => {
  try {
    const result = await logManager.append(sessionId, type, chunk);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error appending to log:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('finalize-log', async (_event, sessionId, type, footer) => {
  try {
    const result = await logManager.finalize(sessionId, type, footer);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error finalizing log:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-log-status', async (_event, sessionId, type) => {
  try {
    const result = await logManager.getStatus(sessionId, type);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error fetching log status:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('jd-set-text', async (_event, text, options = {}) => {
  try {
    const jdData = await jdManager.setJD({ text, source: options.source });
    await evidenceTracker.handleJDUpdate(jdData);
    await reasoningEngine.handleJDUpdate(jdData);

    let evaluationPlan = null;
    try {
      const { plan } = await upsertEvaluationPlan(jdData, { regenerate: true });
      evaluationPlan = plan;
    } catch (planError) {
      console.error('Failed to generate evaluation plan:', planError);
    }

    const payload = { ...jdData, evaluationPlan };

    if (evaluationPlan) {
      broadcast('jd-evaluation-plan', { jdId: jdData.jdId, plan: evaluationPlan });
    }

    if (useClaudeCoach) {
      activeEvaluationPlan = evaluationPlan;
      evaluationOrchestrator?.setActivePlan(evaluationPlan);
    }

    return { success: true, data: payload };
  } catch (error) {
    console.error('Error setting JD text:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('jd-get-active', async () => {
  try {
    const jdData = await jdManager.getActive();
    if (jdData) {
      await evidenceTracker.handleJDUpdate(jdData);
      await reasoningEngine.handleJDUpdate(jdData);
      let evaluationPlan = null;
      try {
        const { plan } = await upsertEvaluationPlan(jdData, { regenerate: false });
        evaluationPlan = plan;
      } catch (planError) {
        console.error('Failed to load evaluation plan:', planError);
      }
      if (evaluationPlan) {
        broadcast('jd-evaluation-plan', { jdId: jdData.jdId, plan: evaluationPlan });
      }
      if (useClaudeCoach) {
        activeEvaluationPlan = evaluationPlan;
        evaluationOrchestrator?.setActivePlan(evaluationPlan);
      }
      return { success: true, data: { ...jdData, evaluationPlan } };
    }
    return { success: true, data: null };
  } catch (error) {
    console.error('Error reading active JD:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('jd-clear', async () => {
  try {
    const result = await jdManager.clear();
    await evidenceTracker.clearJD();
    await reasoningEngine.clearJD();
    broadcast('jd-evaluation-plan', { jdId: null, plan: null });
    if (useClaudeCoach) {
      activeEvaluationPlan = null;
      evaluationOrchestrator?.setActivePlan(null);
    }
    return { success: true, data: result };
  } catch (error) {
    console.error('Error clearing JD:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.on('transcript-chunk', (_event, chunk) => {
  void evidenceTracker.recordChunk(chunk);
  if (useClaudeCoach) {
    void evaluationOrchestrator.enqueueChunk(chunk);
  }
});

ipcMain.handle('reasoning-get-state', async (_event, sessionId) => {
  try {
    const result = useClaudeCoach && evaluationOrchestrator
      ? await evaluationOrchestrator.getState(sessionId)
      : await reasoningEngine.getState(sessionId);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error fetching reasoning state:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('export-report', async (_event, sessionId) => {
  try {
    const result = await reportManager.exportReport(sessionId);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error exporting report:', error);
    return { success: false, error: error.message };
  }
});

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 650,
    height: 600,
    title: 'Mic & Speaker Streamer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webSecurity: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (logManager.hasActiveLogs()) {
    void logManager.shutdown('Session aborted — application is closing');
  }
  void evidenceTracker.flushAll();
  void reasoningEngine.flushAll();
  if (useClaudeCoach && evaluationOrchestrator) {
    void evaluationOrchestrator.flushAll();
  }
  void reportManager.flushAll();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
