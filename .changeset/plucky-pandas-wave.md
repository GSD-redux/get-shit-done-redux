---
type: Fixed
pr: 3978
---
**Reduced the complexity of the refactor-trigger evaluate handler.** `handleEvaluate` scored above the complexity-triggered-refactor feature's own default threshold; the read/analyze loop and the artifact/baseline/ledger write path are now separate named helpers, with no change to CLI behavior, output shape, or reason codes. (#3267)
