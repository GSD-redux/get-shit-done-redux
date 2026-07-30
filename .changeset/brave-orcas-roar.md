---
type: Fixed
pr: 2889
---
**The markdown-parsing lint rule now catches the stricter cell-regex spelling it previously missed** — a hand-rolled table scan written as `[^|\n]` (excluding both the pipe and the newline, which is the more correct form) slipped past the guard entirely, so `STATE.md` field replacement kept parsing tables with a local regex and rewriting the whole document. The rule now flags any pipe-excluding character class, and the STATE.md field writer edits a bounded byte range instead. (#2880)
