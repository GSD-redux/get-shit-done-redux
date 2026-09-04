---
type: Fixed
pr: 4296
---
**Sequential phase execution now stays on the orchestrator's checkout** — non-isolated workers receive a literal root pin and halt before writes when their resolved root differs.
