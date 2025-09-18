# Process Log — Speech Logging (Long Session)

## 2025-09-15T20:45:00Z — Planning
- Reviewed feature docs (`logs.md`, `dev-log.md`) and existing logging flow in `main.js`, `preload.js`, `renderer.js` to confirm current full-file rewrite approach and pain points.
- Implementation plan:
  1. main.js — replace `write-log-file` IPC with a `LogManager` that owns append-only streams per `(sessionId, type)`, handles secure path construction, backpressure via `write()` + `drain`, size-tracking, and rotation into `*_partNN.md`; expose `create-log`, `append-log`, `finalize-log`, `get-log-status`, and retain `ensure-log-directory` as a thin wrapper.
  2. preload.js — update `contextBridge` exports to surface the new IPC methods (`createLog`, `appendLog`, `finalizeLog`, `getLogStatus`) and retire the old `writeLogFile` helper.
  3. renderer.js — refactor `SpeechLogger` to initialize sessions through `createLog`, send incremental entries with `appendLog` (no in-memory file buffers), await acknowledgements via the existing `writeQueue`, and call `finalizeLog` with a session summary; adjust initialization/finalization paths and maintain UI feedback for errors.
  4. Follow-up — add lightweight status polling hooks (optional) and ensure `app` shutdown path finalizes open logs; verify logs rotate at the 10 MB threshold and Markdown output stays compatible with existing files.
- Next step: implement the refactor per plan, documenting significant milestones here.

## 2025-09-15T21:05:00Z — main.js LogManager
- Replaced the single-shot `write-log-file` IPC with a `LogManager` that opens append-only streams per `(sessionId, type)`, enforces secure path construction, and tracks size/part metadata.
- Implemented backpressure-aware `append-log`, rotation into `*_partNN.md` when a part exceeds 10 MB, and `finalize-log` with a final `fsync` before closing streams.
- Added `get-log-status` IPC for status polling and a shutdown hook to finalize in-flight logs if the app exits.
- Enabled `contextIsolation` on the BrowserWindow to align with the hardened preload bridge.

## 2025-09-15T21:10:00Z — preload bridge
- Replaced the legacy `writeLogFile` bridge with `createLog`, `appendLog`, `finalizeLog`, and `getLogStatus` IPC helpers while keeping `ensureLogDirectory` for directory bootstrapping.
- Confirmed the renderer will call into the new streaming API exclusively.

## 2025-09-15T21:25:00Z — renderer speech logger
- Reworked `SpeechLogger` to call the new streaming IPC: sessions now `createLog`, push incremental entries through `appendLog`, and `finalizeLog` with a shared summary (no in-memory Markdown buffers).
- Added per-log state tracking and queue keys so the existing `WriteQueue` sequences IPC calls even across log rotations; console-notify when a part rolls over.
- Updated the queue helper to use generic keys instead of file paths and removed the legacy buffer bookkeeping globals.
