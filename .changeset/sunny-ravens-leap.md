---
type: Fixed
pr: 0
---
**TDD Audit no longer reads a git trailer token git cannot parse** — the trailer token is renamed gate_status → gate-status, so the per-commit gate trail becomes machine-readable the moment a producer starts writing it; previously every commit read as missing and the section self-suppressed silently. (#3962)
