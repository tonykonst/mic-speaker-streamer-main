# Dev Log — Speech Logging (Long Session)

- Feature: Long-session, stream-append Markdown logging to `./Logs`
- Plan doc: `logs.md`
- Scope: Move logging to main process with append streams, backpressure, rotation, safer IPC.
- Folder name note: Using placeholder `Speech-Logging-Long-Session` (rename if you want the exact chat title).

## Conventions
- Time: ISO (UTC) and local in parentheses if added.
- Entry format: date, action, files, notes.

## Timeline

- 2025-09-15T20:00:00Z — Repo review
  - Files: `main.js`, `preload.js`, `renderer.js`, `Logs/*`, `FEATURE_SPEECH_LOGGING.md`, `QA_SPEECH_LOGGING_REPORT.md`
  - Notes: Confirmed current Markdown logging works; identified memory growth (in-memory buffers), ordering risks, and init timing.

- 2025-09-15T20:05:00Z — Draft plan created
  - Files: `logs.md`
  - Notes: Wrote architecture plan: main-process `LogManager`, IPC `create/append/finalize`, rotation, backpressure, fsync policy, security.

- 2025-09-15T20:12:00Z — Cross-check best practices
  - Sources: Node.js streams/fs docs, Electron Security Guidelines, rotation/atomic write libs
  - Notes: Added backpressure (`write()` + `drain`), refined fsync strategy, CSP/contextIsolation, rotation libs (optional).

- 2025-09-15T20:15:00Z — Plan refined
  - Files: `logs.md`
  - Notes: Added pseudocode for `appendSafe`, production log path guidance (`app.getPath('userData')`), safe path building, TOC atomic updates.

## Next Steps
- Implement `LogManager` in `main.js` (append, rotate, finalize, fsync).
- Update `preload.js` with `createLog/appendLog/finalizeLog/getLogStatus`.
- Refactor `renderer.js` to use append-only IPC; remove full-content buffers and write queue.
- Add minimal UI indicator for logging status and errors.

## Open Questions
- Rotation thresholds (size/time)? Default 10MB per part suggested.
- Keep optional `.ndjson` alongside Markdown for recovery/analytics?
- Timestamp format: ISO-only vs ISO+local?

