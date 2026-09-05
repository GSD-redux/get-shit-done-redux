---
type: Fixed
pr: 4283
---
**Partial `.planning` directories now route to initialization recovery** — a bootstrap interrupted after `.planning/PROJECT.md` no longer mis-routes `/gsd:progress` to between-milestones or "no project", nor `resume` to STATE.md reconstruction; both now resume `/gsd:new-project` until the missing REQUIREMENTS.md/ROADMAP.md/STATE.md exist. (#4040)
