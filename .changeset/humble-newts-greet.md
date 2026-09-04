---
type: Fixed
pr: 4251
---
**Timed-out npm audit calls no longer report a misleading JSON parse error.** When npm's registry is slow or degraded, the npm-audit CI gate now reports a clear timeout error naming the real cause instead of `Unexpected end of JSON input`. (#4250)
