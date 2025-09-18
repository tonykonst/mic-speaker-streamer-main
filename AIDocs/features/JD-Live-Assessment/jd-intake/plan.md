# JD Intake & Requirement Extraction — Plan

## Objective
Enable HR to supply a JD, then convert it into structured, reusable requirement objects with minimal UI changes.

## Scope
- File/text ingestion using existing buttons/dialog styles.
- Main-process storage, validation, and change broadcasting.
- LLM pipeline to extract requirements, priorities, and example probes.
- Embedding cache for fast similarity checks.

## Tasks
1. **Ingestion UI & IPC**
   - Reuse current control bar: add “Load JD” button styled like `recordBtn`.
   - IPC handlers: `jd-load-file`, `jd-set-text`, `jd-get-active`, `jd-clear`.
   - Path validation restricts to `JobData/` directory (mirror `Logs`).
2. **Persistence Layer**
   - Store raw JD as Markdown in `JobData/<sessionId>/jd.md`.
   - Maintain `jd.meta.json` with timestamp, source (file/paste), checksum.
3. **Requirement Extraction**
   - Invoke OpenAI Responses (JSON mode) with schema: `{ id, description, priority, competencies[], mustHave, niceToHave, probingQuestions[] }`.
   - Retry/backoff logic; display failure banner if extraction fails.
4. **Embedding Cache**
   - For each requirement + competency, compute embedding via `text-embedding-3-large`.
   - Persist under `requirements.embeddings.json` for reuse across sessions.
5. **Change Notifications**
   - Broadcast `jd-updated` IPC with requirement list + metadata to renderer + evidence tracker.
   - Version requirements with monotonically increasing `rev` for downstream diffing.

## Deliverables
- JD ingestion UI hook (renderer updates preview panel).
- Main-process JD manager (mirrors LogManager patterns).
- Requirement JSON + embeddings persisted and ready for the evidence tracker.

## Open Questions
- Support multiple JDs in one session? (initial: single JD, but design data model to allow `jdId`).
- Limit on length (recommend 10k chars; warn otherwise).

## API Key Management
- Use environment variables (`process.env.OPENAI_KEY`) sourced outside the repo; never persist keys to disk.
- Document rotation steps for ops (update env, restart app) and validate key presence at app start with clear error messaging.
- Prevent accidental logging of key values (scrub IPC payloads, avoid toast messages with secrets).

## Dependencies
- Relies on existing environment variables for OpenAI keys (already wired through preload).
