---
type: Fixed
pr: 4494
---
**Pending-todo bullets in STATE.md now show a date, not a full timestamp** — `renderPendingTodosMarkdown` was echoing the todo's `created` frontmatter verbatim (a full ISO-8601 instant) into the rendered `[…]` bracket, instead of the date-only `[date]` format documented in `docs/reference/state-md.md` and `docs/COMMANDS.md`. (#4439)
