---
type: Fixed
pr: 0
---
**A terminal session now follows the workstream your repo says is active** — with `.planning/active-workstream` naming a workstream, any invocation that had never run `workstream use` silently resolved the flat `.planning/` tree instead: it misreported milestone, phase and progress on reads, and wrote to the superseded flat `STATE.md`. Because the stale tree is well-formed, nothing warned, and the documented workaround was to prepend `GSD_WORKSTREAM=` or `--ws` to every command. A session that has never set its own pointer now inherits the repo marker. Session isolation is unchanged — a session that owns a pointer is never repointed — and the two workstream-mode fail-safe guards now say whether a marker exists but failed to resolve, instead of claiming none is set. Note that clearing a session's pointer returns it to inheriting the marker rather than forcing flat mode. (#3579)
