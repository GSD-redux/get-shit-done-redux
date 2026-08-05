---
type: Fixed
pr: 3081
---
**`milestone complete` no longer silently disarms its unstarted-phase guard when STATE.md's `milestone:` field drifts** — the guard now runs whenever the ROADMAP can be scoped for the requested version (independent of STATE), and a STATE mismatch emits a WARNING naming both values instead of skipping the scan. (#2946)
