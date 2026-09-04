---
type: Fixed
pr: 4231
---
**`state` verbs keep the STATE.md body Progress bar in sync with frontmatter `progress.percent`** — 13 of 15 verbs rewrote the frontmatter percent while the body bar stayed stale (issue #4213: frontmatter 75, body bar still 50), so the two surfaces silently diverged on every record-session, add-decision and milestone switch. The bar is now rewritten through one shared helper on the write seam, keeping the bold `**Progress:**` status line the target even when a free-text line above it starts with `Progress:`, and an out-of-range persisted percent renders a clamped 0-100 bar instead of crashing the write. (#4213)
