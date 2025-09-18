# Reasoning & Guidance Engine — Plan

## Objective
Continuously evaluate requirement coverage, update judgements, and generate proactive guidance for HR using LLM calls only when necessary.

## Inputs
- Requirement definitions + embeddings (from JD intake).
- Evidence state snapshots + new chunk batches (from evidence tracker).
- Config thresholds for confidence and suggestion cadence.

## Tasks
1. **Scoring Orchestrator**
   - For each requirement with changed evidence, assemble mini-context (JD excerpt + latest supporting/contradicting snippets).
   - Call OpenAI Responses (JSON mode) with tool schema:
     ```json
     {
       "requirementId": "string",
       "confidence": "0-100",
       "verdict": "unknown|needs_more|satisfied|risk",
       "reasoning": "string",
       "followUpQuestion": "string|null"
     }
     ```
   - Maintain rate limiting (max 1 concurrent call per requirement).
2. **Incremental Updates**
   - Compare new verdict to previous; if improved (e.g., `risk` → `satisfied`), log change history and notify UI.
   - If verdict downgrades, reopen requirement and mark `needsFollowUp`.
3. **Guidance Generation**
   - When verdict == `needs_more`, use stored `followUpQuestion` or JD default to push suggestion.
   - Throttle repeated prompts (cooldown per requirement, e.g., 3 minutes).
4. **Confidence Decay & Timeouts**
   - If no relevant evidence for >N minutes, decay confidence gradually and re-trigger suggestion.
5. **API Compliance**
   - Ensure prompts are short: pass summaries instead of raw transcripts; rely on evidence tracker summarisation.
   - Keep tokens manageable (<4k) by truncating to last 3 evidences per polarity.
6. **Output Channels**
   - Emit `reasoning-update` event with full requirement state (confidence, verdict, explanation).
   - Push `guidance-prompt` event with question + context for renderer UI.

## Persistence
- Append revisions to `JobData/<sessionId>/reasoning.log.ndjson`.
- Update living report data structure (see session-reporting plan).

## Failure Handling
- On API failure, backoff and mark requirement as `pending`. Show banner if consecutive failures >3.

## Dependencies
- Requires JD intake + evidence tracker.

## Open Questions
- Explore streaming Responses to show partial reasoning? (optional).
- Consider local heuristics for low-risk requirements to avoid API calls entirely.
