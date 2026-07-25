---
type: Fixed
pr: 2626
---
**Stale `todos/done` references in workflows and docs now read `todos/completed`** — the todos/done → todos/completed rename (commit 447d17a9) under-swept 14 descriptive lines across check-todos.md, the /gsd-help tree, ARCHITECTURE.md, and USER-GUIDE.md (en + 4 locales). Those stale references steered agents and users to archive closed todos into `done/` — a directory nothing in gsd-core reads — so closed todos became invisible to ID sequencing and to anything that inventories closed work. All 14 sites now read `completed/`, matching the canonical code path (cmdTodoComplete). A CI guard now blocks future under-sweeps. (#2491)
