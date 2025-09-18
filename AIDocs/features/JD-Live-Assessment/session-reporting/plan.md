# Session Reporting & Persistence — Plan

## Objective
Maintain a continuously updated hiring report that reflects the latest reasoning decisions and can be exported post-interview.

## Components
1. **Living Report Data Model**
   - `report.json` structure:
     ```json
     {
       "sessionId": "string",
       "jdRevision": 3,
       "updatedAt": "ISO",
       "requirements": [
         {
           "id": "Req-1",
           "title": "Cloud Architecture",
           "status": "satisfied|needs_more|risk|unknown",
           "confidence": 82,
           "summary": "Short explanation",
           "evidence": [{ "chunkId": "c123", "quote": "...", "polarity": "positive" }],
           "followUps": ["Ask about multi-region"],
           "history": [{ "at": "ISO", "from": "risk", "to": "satisfied" }]
         }
       ],
       "overallFit": 78,
       "notes": "LLM summary paragraph"
     }
     ```
   - Keep evidence arrays trimmed (max 5 quotes) with pointer to NDJSON timeline for full detail.
2. **Update Pipeline**
   - Reasoning engine publishes changes → report manager merges, updates timestamps, persists to disk.
   - Debounce disk writes (e.g., every 10 seconds or on major status change).
3. **Markdown Export**
   - Renderer triggers `export-report` → main process renders Markdown using template (reuse existing Markdown styling for logs).
   - Write to `JobData/<sessionId>/report.md` and optionally append to `Logs/` for version control.
4. **Finalisation**
   - On session end, freeze report, append concluding summary (LLM-generated) and deliver success/failure verdict per requirement.
   - Optionally produce JSON for downstream ATS integration (future).
5. **History & Replay**
   - Provide small CLI/utility to replay evidence NDJSON and rebuild report for QA.

## Dependencies
- Consumes outputs from reasoning engine and evidence tracker.
- Leverages existing LogManager for writing files (extend to JobData path).

## Risks
- File contention: ensure writes are append/atomic using same patterns as new logging streams.
- Data growth: rotate NDJSON if exceeding size threshold (10 MB per session baseline).

## QA Tasks
- Simulate status churn (risk → satisfied) and confirm report reflects latest verdict and history.
- Validate Markdown export rendering inside existing log viewer.
