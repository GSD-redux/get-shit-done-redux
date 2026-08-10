---
type: Fixed
pr: 0
---
**Known-defect warnings that lived only in docs are now enforced checks** — six failure modes that `CONTEXT.md` merely described are now caught automatically, including unbounded subprocesses that could hang a run indefinitely and an unscoped frontmatter read that could pick up a body line. Writing the checks surfaced nine live instances, all fixed. (#2896)
