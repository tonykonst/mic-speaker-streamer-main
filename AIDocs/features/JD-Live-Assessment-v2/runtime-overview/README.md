# JD Live Assessment v2 — Runtime Overview

## High-Level Flow
- **Transcript capture** (`renderer.js`)
  - Completed microphone / system-audio segments are streamed to `main.js` via `emitTranscriptChunk`.
- **Main event routing** (`main.js`)
  - Persists the chunk to legacy evidence trackers.
  - Passes the chunk to `ClaudeEvaluationOrchestrator.enqueueChunk` when `JD_COACH_V2` is enabled.
- **Batching & prompt build** (`src/services/evaluationOrchestrator.js`)
  - Maintains per-session queues and recent context (默认 5 s window).
  - Flush builds a payload with the active evaluation plan, current state, new chunks, and sliding context, then calls Claude `messages.create`.
- **Result handling**
  - Successful Claude responses go through `_mergeGroup` → `_applyResult`, updating `state.json`, emitting `update`, guidance prompts, and conflict events.
  - Failures fall back to `_applyHeuristicEvaluation`, which now only seeds or nudges groups that lack authoritative data.

## JD Fit Ownership
- Claude now returns the complete state (`overallFit`, group verdicts, guidance, conflicts). System prompt lives in `src/prompts/evaluationSystemPrompt.txt` so we can iterate on instructions without touching code.
- The orchestrator simply persists the response and forwards updates; no local averaging or heuristics remain.
- `overallFit` comes straight from Claude, so tuning happens in the prompt rather than code.

## Guidance Prompts
- Claude is responsible for nominating follow-ups (`guidance` array) or inline `followUpQuestion` values.
- The orchestrator emits a `guidance-reset` event each time, replacing the entire queue in the renderer so resolved questions disappear automatically.
- UI still keeps a rolling window of the latest 20 prompts for operator focus.

## Persistence Artifacts
- **`JobData/v2/jd/<jdId>/evaluation_plan.json`** — Claude-generated rubric (groups, weights, probing questions).
- **`JobData/v2/sessions/<sessionId>/state.json`** — latest merged state: JD Fit, group verdicts, rationale, guidance question.
- **`JobData/v2/sessions/<sessionId>/events.ndjson`** — append-only log of evaluation batches (source = `claude` | `heuristic`).
- **`JobData/v2/sessions/<sessionId>/conflicts.ndjson`** — structured conflict cards emitted during `_applyResult`.

## Renderer Integration
- `onReasoningUpdate` normalises state (`normalizeReasoningState`) and refreshes JD Fit badge, group cards, report preview based on Claude’s state.
- `onGuidancePrompt` simply enqueues whatever Claude returned (priority/defaults handled by prompt design).
- Report/export uses the persisted state verbatim, keeping parity with Claude’s judgments.

## Operational Notes
- **Claude failures** now result in “stale” state (no update written). Monitor `[eval-orchestrator] Claude evaluation failed ...` and consider retries/backoff if needed.
- Roadmap: feed prompt improvements through `JD-Live-Assessment-v3/plan.md` to tighten consistency and depth.
