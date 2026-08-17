---
type: Fixed
pr: 0
---
**`init.progress` no longer infers the next phase from stray out-of-order artifacts** — a phase directory created out of order (e.g. a phase-9 UAT evidence file while roadmap phase 8 was still pending and unscaffolded) dragged the reported frontier forward, making `init.progress` skip Phase 8 and disagree with `roadmap.analyze`; the frontier is now derived from roadmap order, with artifacts as corroborating evidence only. (#3581)
