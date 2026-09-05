---
type: Fixed
pr: 4215
---
**Structural pre-pass no longer aborts for phases introduced in the repository's root commit** — Fallow uses the root commit itself when no parent exists instead of receiving an invalid parent revision. (#4183)
