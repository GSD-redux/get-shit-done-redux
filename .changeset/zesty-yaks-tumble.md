---
type: Added
pr: 0
---
**Context monitor advisory output now carries a typed `severity` field** — `gsd-context-monitor.js`'s context-budget advisory now includes `severity: 'warning'|'critical'` alongside its existing `additionalContext` prose, so callers can branch on severity without regex-matching the rendered warning text. (#3546)
