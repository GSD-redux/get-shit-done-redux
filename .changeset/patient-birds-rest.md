---
type: Fixed
pr: 3068
---
**The composer's load-bearing-fragment guarantee is now enforced, not just documented** — ADR-1671 promised a deterministic gate proving no load-bearing content is dropped or shrunk when context is trimmed to fit a budget; only synthetic unit tests existed. The gate now runs against real declared strategies and fails if it would ever assert over nothing. (#3065)
