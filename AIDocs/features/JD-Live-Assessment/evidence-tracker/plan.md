# Evidence Tracker — Plan

## Objective
Maintain a rolling map between transcript facts and JD requirements, enabling re-evaluation as new information arrives.

## Responsibilities
- Capture every transcript chunk with metadata and lightweight similarity to candidate requirements.
- Aggregate evidence per requirement with confidence scoring and contradiction detection.
- Provide snapshots for the reasoning engine and persist history for audit.

## Tasks
1. **Chunk Intake Queue**
   - Extend existing transcript IPC to emit `{ chunkId, sessionId, source, text, timestamp }`.
   - Batch chunks (2–3 s window) before deeper processing.
2. **Pre-Processing**
   - Run local similarity (cosine) against requirement embeddings to shortlist relevant requirements (<10 per chunk).
   - Extract key entities/skills using fast heuristic (regex for languages, frameworks) before calling LLM.
3. **State Model**
   - For each requirement maintain:
     - `confidence` (0–100), `status` (`unknown`, `pending`, `likely`, `confirmed`, `contradicted`).
     - `evidence`: array of `{ chunkId, text, summary, polarity }`.
     - `lastUpdated`, `needsFollowUp` flag.
4. **Contradiction Handling**
   - If new evidence conflicts with earlier judgement, mark `status = pending` and trigger reasoning engine to re-score.
5. **Persistence**
   - Append events to `JobData/<sessionId>/evidence.ndjson`.
   - Periodically snapshot state to `evidence.state.json` for fast resume if app restarts.
6. **APIs**
   - Expose methods: `recordChunk`, `getRequirementState`, `listFollowUps`, `getTimeline(requirementId)`.
   - Emit IPC `evidence-updated` for renderer + reasoning engine.

## Deliverables
- Main-process module owning evidence map (likely separate class, similar to `LogManager`).
- Lightweight similarity + heuristics before heavy LLM usage.
- Persistence helpers for NDJSON + snapshots.

## Risks
- Memory growth: mitigate with trimming chunk text (keep summaries) and archiving old events to disk.
- Ordering: ensure chunk IDs monotonically increase even with batching.
