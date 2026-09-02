---
type: Fixed
pr: 4164
---
**Statusline no longer shows milestone complete at 0 of 0 phases** — the 0-of-0 counters a freshly-roadmapped milestone carries no longer read as every-phase-done (string truthiness made the equality vacuous); both the full and compact renderers now require a non-zero denominator. (#3945)
