# Process Log — Evidence Tracker

## 2025-09-15T22:55:00Z — Kickoff
- Reviewed plan.md goals: tap transcript flow, batch chunks, compute lightweight similarity, persist evidence events.
- Implementation sequence:
  1. Define main-process EvidenceTracker class (state map, NDJSON persistence, cosine helper).
  2. Extend renderer to emit transcript chunks via IPC.
  3. Wire throttled queue between renderer and tracker; expose status IPC for future UI.

## 2025-09-15T23:20:00Z — Evidence tracker skeleton
- Implemented `EvidenceTracker` in `main.js` with per-session persistence (`JobData/sessions/<sessionId>`), requirement indexing, token overlap scoring, and NDJSON/state snapshots.
- Wired JD lifecycle events to update the tracker and broadcast state to renderer channels (`evidence-updated`, `jd-evidence-updated`).
- Added transcript chunk IPC listener and graceful shutdown flushing.

## 2025-09-15T23:30:00Z — Renderer integration
- Exposed transcript chunk emitter and evidence listeners via preload bridge.
- Updated `SpeechLogger` to emit chunks after each append and added startup listeners/logging hooks in the renderer.
- Ensured JD preview stays in sync and listeners clean up on window unload.
