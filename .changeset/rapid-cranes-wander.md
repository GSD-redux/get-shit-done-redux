---
type: Fixed
pr: 0
---
**Secret-scan no longer reports a false positive on the zh-CN verification-patterns translation** — the translated document carries the same illustrative placeholder examples as its English source, but the exclusion was never extended to the translation. The strict-mode scan now passes. (#3044)
