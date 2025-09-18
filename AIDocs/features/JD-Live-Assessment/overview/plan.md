# JD Live Assessment — End-to-End Plan

## Vision
HR loads a Job Description (JD) once, and the system continuously:
1. Extracts requirements/skills from the JD using an LLM.
2. Listens to live interview transcripts (microphone + system audio).
3. Tracks evidence across the entire conversation, merging new signals with prior judgements.
4. Surfaces real-time prompts when evidence is weak or contradictory.
5. Maintains a living report that is revised whenever fresh information changes the hiring verdict.

## Key Principles
- **Reuse existing infrastructure:** keep Markdown logging in `Logs/`, append-only pipeline, current status badges/buttons.
- **Incremental intelligence:** store structured evidence snapshots so the engine re-evaluates without re-reading full transcripts each time.
- **Official OpenAI stack only:** Realtime API for streaming audio, Embeddings for semantic search, Responses (JSON mode + function calling) for requirement extraction and reasoning.
- **Credential hygiene:** access OpenAI credentials exclusively via environment variables (process.env), document rotation procedures, and ensure keys are never logged or persisted to disk.
- **Explainability:** every score or prompt should reference supporting transcript snippets and JD requirement IDs.

## Core Subsystems
1. **JD Intake & Requirement Extraction** — load JD, derive canonical requirement objects, cache embeddings.
2. **Evidence Tracker** — maintain rolling state of candidate claims mapped to requirements, with contradictions and confidence decay.
3. **Reasoning & Guidance Engine** — orchestrate LLM calls to update judgement, detect gaps, and generate follow-up questions.
4. **UI Integration & Alerts** — present scores, prompts, and living report revisions using existing UI patterns.
5. **Session Reporting & Persistence** — write evolving report to disk, support post-interview review and replay.

Each subsystem has its own plan under `AIDocs/features/JD-Live-Assessment/<area>/plan.md`.

## Workflow Summary
1. **JD ingestion:** HR uploads/pastes JD → main process stores text → Responses API extracts structured requirement list + priorities → embeddings cached.
2. **Live transcription tap:** renderer emits every transcript chunk via IPC to the main process queue (already used for logging) → evidence tracker updates candidate timeline.
3. **Evidence updates:** for each chunk batch, the reasoning engine checks requirements lacking sufficient evidence, runs targeted LLM calls, updates confidence scores (0–100) and notes contradictions.
4. **Guidance output:** if confidence < threshold and no clarifying question sent recently, push prompt to HR (“Ask about X”). Use existing status area / modal.
5. **Living report:** maintain JSON state (requirements, verdict, supporting quotes). Renderer mirrors state in UI and at session end writes Markdown report alongside transcript.
6. **Revision loop:** when new evidence contradicts earlier “weak” judgement, engine reopens the requirement, updates score, logs change history, and refreshes UI/report.

## Data & Storage
- **Transcripts:** unchanged Markdown files + optional NDJSON for evidence events.
- **Requirements cache:** `JobData/<sessionId>/requirements.json` (structured list + embeddings).
- **Evidence store:** `JobData/<sessionId>/evidence.ndjson` capturing incremental updates for replay/debugging.
- **Report:** `JobData/<sessionId>/report.md` generated progressively.

## Risks & Mitigations
- **Latency:** combine chunk batching (2–3 s) with lightweight local similarity before expensive LLM calls.
- **Context drift:** cap evidence history window per requirement but keep summary notes from LLM to avoid prompt overrun.
- **UI overload:** throttle suggestions, reuse existing components, provide dismiss/acknowledge controls.

## Milestones
1. JD ingestion + requirement extraction (MVP structure + caching).
2. Transcript fan-out + evidence tracker skeleton (no LLM yet).
3. Reasoning engine with incremental updates + suggestion generation.
4. UI integration & live report writer.
5. QA, documentation, and launch review.
