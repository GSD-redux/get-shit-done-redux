---
type: Fixed
pr: 4479
---
**Todos stay visible under a workstream** — todos are root-scoped shared state, but every code reader resolved them through the workstream-aware planning dir, so with a workstream active todos read as empty, `todo complete` refused existing files, and the milestone-close audit-open gate passed with pending todos on disk. (#4256)
