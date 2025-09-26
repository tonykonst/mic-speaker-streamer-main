# JD Live Assessment — v2 (Claude-Powered Reasoning)

## Vision
Leverage Claude for end-to-end semantic analysis during interviews. The system should:
1. Ask Claude to ingest the JD, extract thematic groups (e.g., "Core Stack", "Delivery Practices", "Collaboration"), and define evaluation rubrics per group.
2. Stream sanitized transcript chunks to Claude in near real time, requesting incremental assessments against each rubric.
3. Continuously update a living scorecard and send HR actionable guidance (questions, probing angles) as evidence changes.
4. Persist structured evidence, LLM rationales, and final summaries for audit and export.

## High-Level Flow
1. **JD Upload → Claude Structuring**
   - HR uploads/pastes JD.
   - Backend calls Claude (`/messages` with JSON schema) asking for grouped requirements, success criteria, and initial probing questions.
   - Result stored as `evaluation_plan.json` (group → criteria → probes, importance).

2. **Interview Start**
   - Transcription (existing Realtime/Markdown pipeline) produces sanitized chunks.
   - Every N seconds (e.g., 5) the orchestrator batches chunks + metadata and calls Claude to update scores.

3. **Claude Reasoning Loop**
   - Prompt includes:
     - Evaluation plan (groups + descriptors).
     - Recent transcript snippets.
     - Current state summary (last verdict/confidence per group).
   - Claude returns JSON: `{ groupId, verdict, confidence, rationale, suggestedQuestions[], notableQuotes[], conflicts[] }`.

4. **State Update & UI Refresh**
   - Backend merges results into `state.json`, appends to `events.ndjson`.
   - Renderer updates JD fit badge, group-level cards, and guidance queue using existing components (minimal new CSS).

5. **Export & Review**
   - On-demand export: human-readable report + raw JSON state.
   - Optional "post mortem" call to Claude for final summary per group + hiring recommendation.

## Components

### 1. JD Ingestion Service (v2)
- **Input:** JD text.
- **Claude Call:** Prompt to return grouped competencies.
- **Output:**
  ```json
  {
    "groups": [
      {
        "id": "core-stack",
        "title": "Core Stack Expertise",
        "importance": "must-have",
        "criteria": ["Node.js/Electron", "Realtime data pipelines"],
        "probingQuestions": [...],
        "successSignals": [...],
        "riskSignals": [...],
        "conflictSignals": ["Statements that contradict earlier claims about streaming or LLM integrations"]
      }
    ]
  }
  ```
- **Storage:** `JobData/v2/<sessionId>/evaluation_plan.json`
- **Fallback:** If Claude fails, store minimal heuristic grouping and notify HR.

### 2. Transcript Orchestrator
- Reuse existing transcript emitter.
- Batch chunks (configurable window, e.g., 5s).
- Maintain sliding context of last M minutes (e.g., 5) for Claude prompt.
- Preprocess chunk text (speaker label, timestamp, sanitized content).

### 3. Claude Evaluation Runner
- **Prompt Template (messages API):**
  - System: “You are a hiring copilot…”
  - User: JSON containing evaluation plan, recent transcript summary, current state snapshot, new chunk batch.
- **Response Schema:** enforce JSON with groups → {confidence, verdict (unknown/needs_more/strong), rationale, followUpQuestions[], evidenceQuotes[], conflicts[]} where each conflict entry contains `{ summary, evidence: [{ timestamp, quote }], recommendedAction }`.
- **Rate Control:** max 1 call per 5s; handle retries/backoff; fall back to last known state.
- **Caching:** keep hashed JD id; reuse plan across sessions if same JD.

### 4. State Store
- `state.json`: current verdict per group.
- `events.ndjson`: snapshot per evaluation call (LLM output + prompt trace ID + conflicts array).
- `guidance.ndjson`: recommended follow-ups (for audit).
- `conflicts.ndjson`: optional flattened conflict log for analytics/escalation workflows.
- Optionally keep vector store (future) if we add embeddings for retrieval.

### 5. UI Enhancements (reuse styles)
- Group cards with verdict badge + rationale snippet.
- Guidance queue showing Claude’s top follow-up question per group.
- JD fit badge derived from weighted average of group confidences.
- Report preview now draws from new `state.json` and includes LLM rationale/evidence.

### 6. Export Pipeline
- Markdown report with groups ordered by importance. Include:
  - Verdict, confidence, rationale, top evidence, suggested next steps.
- JSON export (full state + event history).
- Optional final wrap-up prompt to Claude for human-readable summary.

## Storage & Logging
- Continue writing Markdown transcripts for human audit.
- Add `JobData/v2/<sessionId>/` with: `evaluation_plan.json`, `state.json`, `events.ndjson`, `guidance.ndjson`, `report.md`.
- Log all Claude prompts/responses (with redaction) for traceability.
- Consider expiring raw responses after X days if policy requires.

## Security & Reliability Considerations
- Securely store Claude API key (env var, masked logs).
- Streaming prompts must scrub PII per compliance (optionally client-side). 
- Implement circuit breaker: if Claude errors > N times, fall back to local heuristic and show warning.
- Token budget management: truncate transcript context, summarise older evidence.

## Implementation Plan (Sprint Outline)
1. **Infra & SDK**
   - Add Claude client wrapper (fetch-based) with retry/backoff.
   - Config flags for enabling v2 pipeline.
2. **JD Structuring**
   - New JD manager method `generateEvaluationPlan()`.
   - Store plan + emit renderer event.
3. **Evaluation Runner**
   - Transcript batching; Claude call orchestrator; state merge logic.
   - NDJSON/JSON persistence.
4. **UI v2**
   - Group cards, guidance queue (upgrade), improved report preview.
   - Add toggle in UI: “Claude coach enabled”.
5. **Export**
   - Markdown/JSON export using new state.
   - Optional final wrap-up prompt.
6. **QA & Safety**
   - Dry-run with canned transcripts.
   - Load tests to validate token/RPS usage.
   - Failover tests (Claude unavailable).

## Open Questions
- How to handle multi-speaker interviews (per-candidate vs panel)?
- Should we stream partial responses (Claude streaming API) to reduce latency?
- Need for hybrid scoring (combine v1 heuristics + v2 LLM) for trust calibration?
- Policy approval for storing Claude responses (duration, encryption).

## Next Steps
- Confirm sprint scope & priorities with stakeholders (JD plan, live evaluation, UI, export).
- Draft prompts/schema for Claude review before implementation.
- Prepare synthetic transcripts + JD for load/accuracy benchmarking.
