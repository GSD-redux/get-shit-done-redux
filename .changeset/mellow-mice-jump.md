---
type: Added
pr: 0
---
**Prompt-injection guard advisory output now carries a typed `findings` array** — `gsd-prompt-guard.js`'s `.planning/` write-scan advisory now emits `findings: [{ruleId, match}]` records (mirroring the pattern `gsd-read-injection-scanner.js` already ships) alongside its existing `additionalContext` prose, rendered through a single mapper so the two can never drift. (#3546)
