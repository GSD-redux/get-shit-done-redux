---
type: Fixed
pr: 3713
---
**The spec-phase edge probe now classifies requirements in non-English projects** — a project running with `response_language` set had every requirement fall through the English-only shape cues into `unclassified`, silently disabling the whole edge taxonomy; Step 5.5 now feeds the probe an English translation of each requirement while the SPEC keeps its original language. (#2773)
