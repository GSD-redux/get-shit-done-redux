---
type: Fixed
pr: 2731
---
**Debug sessions now commit their session docs** — with `commit_docs: true`, finishing a `/gsd:debug` session left the session doc (and sometimes the fix's own code changes) sitting untracked in the working tree. The session manager, which owns the end of a debug session, never had a commit step — only the single-spawn debugger path did. Terminal sessions now commit the doc and any uncommitted in-session fix code, still respecting `commit_docs`; sessions that pause mid-investigation deliberately do not. (#2568)
