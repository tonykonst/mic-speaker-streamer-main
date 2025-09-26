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

## JD Fit Smoothing
- Each plan group is initialised with `verdict: unknown`, `confidence: 0`, `source: null`.
- `_mergeGroup` tags the source (`claude` or `heuristic`) and blends scores:
  - **Claude** overrides verdict/confidence and sets `source: claude`.
  - **Heuristic** can only seed empty groups or gently push existing heuristic estimates.
  - Confidence blending ensures increases move toward the new value (≤ 60 % retained) while decreases step down with damping.
- `overallFit` is a weighted mean (must‑have × 1.5, nice‑to‑have × 1). With smoothing, one strong signal keeps its weight while missing groups stay neutral instead of resetting everything to 0.

## Guidance Prompt Dedupe
- `session.guidanceHistory` stores the last question per requirement.
- When `_applyResult` sets `followUpQuestion`, we emit a `guidance` event only if the text changed; clearing questions removes the history entry.
- Renderer receives unique prompts (keeps max 20 entries) and simply prepends them to the queue.

## Persistence Artifacts
- **`JobData/v2/jd/<jdId>/evaluation_plan.json`** — Claude-generated rubric (groups, weights, probing questions).
- **`JobData/v2/sessions/<sessionId>/state.json`** — latest merged state: JD Fit, group verdicts, rationale, guidance question.
- **`JobData/v2/sessions/<sessionId>/events.ndjson`** — append-only log of evaluation batches (source = `claude` | `heuristic`).
- **`JobData/v2/sessions/<sessionId>/conflicts.ndjson`** — structured conflict cards emitted during `_applyResult`.

## Renderer Integration
- `onReasoningUpdate` normalises state (`normalizeReasoningState`) and refreshes JD Fit badge, group cards, report preview.
- `onGuidancePrompt` updates the queue; duplicates are avoided thanks to orchestrator history.
- Report/export uses the same state snapshot, so smoothing logic automatically propagates.

## Operational Notes
- **Claude timeouts** still trigger heuristics; monitor main-process console (`[eval-orchestrator] Claude evaluation failed ...`).
- If JD Fit feels sticky, check `events.ndjson` to confirm whether heuristics or Claude is driving recent updates.
