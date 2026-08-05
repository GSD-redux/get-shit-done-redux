---
type: Fixed
pr: 3077
---
**`execGit` now reports `timedOut` on every result, and its return type is no longer misdeclared** — three modules hand-copied the shape of `execGit`'s result because the canonical type was not exported, and two of those copies declared `exitCode` as nullable when it can never be null. The shape is now declared once and reused, so a consumer can no longer be written against a contract the function does not honor. (#3071)
