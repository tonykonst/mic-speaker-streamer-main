# Process Log — Reasoning & Guidance Engine

## 2025-09-15T23:45:00Z — Kickoff
- Reviewed plan.md: orchestrate verdict updates, follow-up prompts, persistence, and renderer notifications.
- Implementation outline:
  1. Add `ReasoningEngine` (main process) subscribing to evidence updates, mapping confidence → verdict, managing follow-up prompts.
  2. Persist reasoning state under `JobData/sessions/<sessionId>/reasoning.*` with debounce flush.
  3. Broadcast results via IPC (`reasoning-update`, `guidance-prompt`) and expose a `get` endpoint.
  4. Add preload bindings and renderer console hooks for now.

## 2025-09-16T00:15:00Z — Reasoning engine core
- Added `ReasoningEngine` in `main.js` to evaluate evidence snapshots, compute verdict/confidence, and trigger follow-up prompts with cooldowns.
- Persists reasoning state per session (`JobData/sessions/<session>/reasoning.state.json`) and appends guidance prompts to `guidance.ndjson`.
- Broadcasts `reasoning-update` and `guidance-prompt` events; exposes `reasoning-get-state` IPC for sync queries.

## 2025-09-16T00:25:00Z — Renderer wiring & cleanup
- Exposed reasoning APIs in `preload.js` and hooked renderer listeners (currently console output) alongside existing evidence subscriptions.
- Reset chunk sequence on session start and ensured listeners detach on window unload.
- Updated shutdown flow to flush reasoning snapshots with log manager and evidence tracker.
