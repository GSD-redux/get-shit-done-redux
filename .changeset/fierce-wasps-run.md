---
type: Added
pr: 4290
---
Verification reports now record a deterministic content fingerprint of their covered inputs (phase PLAN/SUMMARY, mapped requirements, implementation files in the change set); `readVerificationStatus` recomputes it and reports `stale` on any mismatch, fail-closed on a missing/unreadable/confinement-escaping covered file. Legacy reports without fingerprint metadata keep the prior SUMMARY-mtime staleness check unchanged. (#4155)
