---
type: Fixed
pr: 3608
---
**A capability's `ship:pre` gate now actually blocks the ship** — the ship preflight resolved every declared `ship:pre` gate but enforced only the built-in `security` and `broken-windows` capabilities, so any other capability's `blocking: true` gate was resolved, evaluable, and then silently dropped: a phase shipped past its own declared failing condition with nothing evaluated, nothing warned, and nothing logged. Preflight now dispatches every active gate generically — honoring each gate's own `blocking` and `onError` — matching the contract `execute:wave:post`, `execute:post` and `plan:post` already implement. (#3559)
