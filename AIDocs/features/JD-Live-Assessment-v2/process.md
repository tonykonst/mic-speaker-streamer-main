# Process Log — JD Live Assessment v2

## 2025-09-16T01:40:00Z — Infrastructure scaffolding
- Added Claude client wrapper with timeout/retry-ready interface (`src/services/claudeClient.js`).
- Introduced centralized config (`config.js`) for toggling v2 and managing Claude credentials/models.
- Implemented `EvaluationPlanService` to call Claude for grouped requirements with structured fallback (`src/services/evaluationPlan.js`).
- Next: integrate plan generation into JD flow and start wiring streaming evaluation orchestrator.

## 2025-09-16T01:55:00Z — JD plan integration
- Hooked evaluation plan generation into JD IPC: on upload we call Claude (when enabled), persist `evaluation_plan.json`, and broadcast to renderer.
- Renderer now tracks the active evaluation plan, updates the JD preview with group summaries, and listens for `jd-evaluation-plan` events.
- Added preload bridge for plan events; clearing JD resets plan state.
- Next: stream evaluation batches to Claude and persist `state.json`/`events.ndjson` per the v2 design.

## 2025-09-16T02:20:00Z — Streaming evaluation orchestrator
- Implemented `ClaudeEvaluationOrchestrator` to batch transcript chunks, call Claude with plan/state context, and persist v2 session artifacts (`state.json`, `events.ndjson`, `conflicts.ndjson`).
- Main process now toggles between legacy reasoning and v2 orchestrator based on `JD_COACH_V2`, broadcasts updates/guidance/conflicts, and routes transcript chunks accordingly.
- Renderer listens for plan/conflict events and surfaces plan metadata in the JD preview (conflicts currently logged to console).
- Next: surface v2 scores/conflicts in the UI and enrich exports with Claude rationale.

## 2025-09-26T10:30:00Z — JD Fit regression investigation
- Issue: heuristic fallback batches were overwriting Claude-issued scores, dropping `overallFit` back to 0 even after strong positive signals (see `JobData/v2/sessions/*/events.ndjson`).
- Decision: treat Claude responses as authoritative, mark group state with a source flag, and limit heuristics to additive blending so JD Fit evolves instead of hard resetting.
- Plan: (1) add lightweight verdict-strength mapping + confidence blending, (2) let heuristics seed only unknown groups or nudge existing heuristic estimates, (3) update docs + UI flow once confident in the new smoothing behaviour.
