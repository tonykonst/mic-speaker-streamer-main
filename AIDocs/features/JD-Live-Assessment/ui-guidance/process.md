# Process Log — UI Integration & Guidance

## 2025-09-16T00:35:00Z — Kickoff
- Goal: surface reasoning/evidence outputs in the existing UI with minimal new styling.
- Plan:
  1. Add JD fit badge in status row and transcript annotations with current stats.
  2. Implement guidance queue panel (reuse existing styles) to show follow-up prompts.
  3. Render living report summary panel fed by reasoning state.
  4. Ensure teardown/reset on session end.

## 2025-09-16T00:55:00Z — UI scaffolding
- Extended `index.html` with JD fit badge, guidance queue, and live report panes while reusing existing styling.
- Renderer now tracks reasoning/guidance state, updates status badge colours, renders prompt queue and report summaries, and resets them on JD/session changes.
- Hooked reasoning/guidance IPC events into rendering pipeline; still logging raw payloads for debugging.

## 2025-09-16T02:35:00Z — Planning v2 UI work
- Goals: surface Claude-generated group verdicts/conflicts, update guidance cues, and align export preview with new state format.
- Planned tasks:
  1. Group cards: badge, rationale, tokens/quotes, conflict markers.
  2. Guidance/conflict panels: show top questions + highlight contradictions.
  3. Report/export update to include v2 data.

## 2025-09-16T03:05:00Z — v2 UI integration
- Added evaluation groups + conflicts panes in the main window, reusing existing `results` styling (`index.html`).
- Renderer now normalizes Claude reasoning output, renders group cards, handles conflict history, and shows guidance/plan summaries.
- Guidance/plan/events reset cleanly on JD changes; conflict events streamed to the UI for quick follow-up.
- Next: extend export/report to include v2 rationale/conflicts.

## 2025-09-26T10:35:00Z — JD Fit smoothing UX
- Observed JD Fit badge oscillating to 0 whenever heuristics ran; confusing for interviewers tracking progress.
- Updated renderer expectations to rely on the orchestrator's new source-aware blending (no additional UI code required yet, but badge will now reflect smoothed scores).
- Follow-up: keep an eye on guidance cues; if heuristic-only sessions feel sluggish, consider lightweight UI hint that scores are provisional.

## 2025-09-26T10:45:00Z — Guidance dedupe
- Reworked guidance handling after moving scoring to Claude: prompts now come directly from the model.
- The orchestrator forwards whatever Claude returns; duplicates are mitigated with prompt instructions instead of local history.
