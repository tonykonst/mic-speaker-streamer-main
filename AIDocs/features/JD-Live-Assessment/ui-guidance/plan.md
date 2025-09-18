# UI Integration & Guidance — Plan

## Objective
Surface live scores, prompts, and the evolving report using existing UI elements to assist HR during the interview.

## Guidelines
- Prefer current status badges, transcript panes, and modal/toast patterns.
- Minimise new CSS; extend classes only when spacing/colour tweaks required.
- Keep updates non-intrusive but actionable.

## Tasks
1. **Status Bar Enhancements**
   - Extend `micStatus` / `speakerStatus` area with a JD badge (reuse `.status` classes). Display overall fit (`JD Fit: 72%`) derived from aggregated confidence.
   - Add icon indicator when guidance prompts are pending (reuse recording icon assets if possible).
2. **Transcript Annotations**
   - When a chunk contributes to a requirement, append an italicised line (`_Matches: Req-3 (Cloud Architecture)_`) below the transcript entry using existing text styles.
   - Provide tooltip (native `title` attribute) for confidence breakdown to avoid new tooltip library.
3. **Guidance Prompts Panel**
   - Reuse existing modal dialog (same as start/stop alerts) to present “Ask about X” prompts.
   - Maintain a small queue view using current list styles in the sidebar; allow HR to mark prompt as “Asked” or “Dismissed”.
4. **Living Report View**
   - Introduce collapsible panel adjacent to transcript panes (reuse `Logs` Markdown styling) summarising each requirement with status badge, key evidence bullets, and last update time.
   - Highlight revisions (e.g., `status` change) with existing `.connected`/`.disconnected` colours.
5. **Controls**
   - Add toggle checkbox (“JD Coach Enabled”) using same form styling as existing selects.
   - Provide “Export Report” button that triggers session-reporting writer (reuses existing button style).
6. **Accessibility & Performance**
   - Batch DOM updates to avoid reflow storms (use requestAnimationFrame throttle).
   - Ensure screen-reader text for status changes (aria-live on status bar).

## Events & Data Flow
- Listen for `jd-updated`, `evidence-updated`, `reasoning-update`, `guidance-prompt` messages.
- Maintain local store (plain JS object) to drive consistent rendering with minimal re-computation.

## QA Checklist
- Visual regression on main window sizes.
- Stress test with frequent prompts to ensure UI doesn’t flicker.
- Verify toggles persist between session start/stop.
