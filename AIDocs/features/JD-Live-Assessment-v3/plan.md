# JD Live Assessment v3 — Autonomous Claude Evaluator

## Goal
Hand over the complete reasoning loop to Claude so it:
- Weighs evidence against the JD rubric.
- Requests clarifications only where confidence is low or contradiction detected.
- Maintains and updates candidate scores (JD Fit + per-group verdicts) without host-side math.
- Digs below surface-level statements to confirm depth of skill.

## Proposed Flow
1. **Bootstrap Prompt**
   - Send Claude the JD (rubric, group weights, probing depth requirements) and an explicit instruction set:
     - Keep a running JSON state object `{ groups[], overallFit, openQuestions[] }`.
     - After each transcript batch, update state by re-evaluating evidence and adjusting scores.
     - Only flag `openQuestions` when confidence < threshold or conflicting evidence appears.
     - Always challenge shallow claims with deeper probes (e.g., require implementation details, failure scenarios).
2. **Streaming Updates**
   - For each chunk batch: provide `currentState`, `newTranscript`, `recentContext` and instruct Claude to return the full updated state.
   - Claude performs the comparison and supplies:
     ```json
     {
       "overallFit": 0-100,
       "groups": [
         {
           "id": "technical-skills",
           "verdict": "excellent",
           "confidence": 92,
           "rationale": "...",
           "needsDeeperProbe": false,
           "suggestedQuestion": null
         } ...
       ],
       "openQuestions": [ { "groupId": "communication", "question": "..." } ],
       "evidenceLog": [ ... optional key quotes ... ]
     }
     ```
   - Host simply persists the returned JSON; no local averaging or blending.
3. **Clarification Loop**
   - If `openQuestions` is non-empty, surface the highest priority prompt in the UI.
   - Once an answer arrives, next batch includes the question + response so Claude can resolve the uncertainty.
4. **Depth Enforcement**
   - Rubric prompt will demand that Claude cross-check each claim:
     - Example instruction: “For technical skills, do not mark above `likely` unless the candidate provides concrete implementation details (architectures, failure handling, metrics). Ask for them if missing.”
   - Include scoring policy tables directly in the system prompt so everything lives inside Claude’s reasoning.
5. **Session Finalization**
   - Request a final summary by passing `"finalize": true` with the latest state so Claude returns a closing report (verdict, risks, hire/no hire) based on its own scores.

## Implementation Plan
1. **Prompt Drafting**
   - Define canonical system + developer messages describing the rubric, depth requirements, scoring scale, JSON schema.
   - Prototype with Haiku/Sonnet to validate state updates.
2. **Client Update**
   - Simplify orchestrator: merely forwards batches + current state; removes local scoring, guidance history, heuristic fallback.
   - Handle cases where Claude fails (retry/backoff) or returns invalid schema → log and hold previous state.
3. **Renderer Adjustments**
   - Display `openQuestions` exactly as returned; JD Fit badge binds directly to Claude’s `overallFit`.
4. **Validation**
   - Golden-path transcripts to confirm Claude drills deeper.
   - Adversarial tests (vague answers) to ensure follow-up questions fire.

## Open Questions
- How often should we persist incremental state versus trusting Claude’s memory? (Probably always store the returned JSON.)
- Do we need a safety net if Claude inflates scores incorrectly? (Maybe a lightweight heuristic validator.)
- Pricing impact: evaluate Sonnet vs Haiku for long sessions.
