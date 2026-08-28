---
type: Fixed
pr: 3940
---
**`audit-open acknowledge` no longer reports success on an entry it did not clear** — acknowledging a deferred item whose status is written as a nested list line now records a status the reader actually parses, so acknowledged entries drop out of audit counts instead of resurfacing forever. (#3740)
