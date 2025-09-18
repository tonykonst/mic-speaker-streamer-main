# Process Log — JD Intake & Requirement Extraction

## 2025-09-15T22:05:00Z — Kickoff
- Review plan.md tasks; confirm first milestone: JD ingestion UI hook, main-process JD manager scaffolding, storage layout under `JobData/`.
- Next: implement storage helpers + IPC in main process, then expose preload bridge and renderer placeholder UI.

## 2025-09-15T22:35:00Z — Main-process JD manager
- Added `JDManager` in `main.js` with storage under `JobData/`, pointer file, requirement extraction via OpenAI Responses + Embeddings (with heuristic fallback when no key).
- Exposed IPC handlers (`jd-set-text`, `jd-get-active`, `jd-clear`) and preload bridges for renderer access.

## 2025-09-15T22:45:00Z — Renderer controls & UI
- Introduced JD controls in `index.html` (file upload, paste, clear) reusing existing button/preview styles.
- Implemented renderer wiring: size limits, prompt-based paste flow, preview panel, and sync with main-process JD state.
- Added initial load to fetch stored JD on startup.
