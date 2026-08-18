---
type: Fixed
pr: 3521
---
**Frontmatter round-trips no longer double backslashes on every state write** — `escapeDoubleQuoted` escaped `\`, `"`, and control characters on each serialize while the parser only stripped the outer quote delimiters, so every read-modify-write cycle doubled existing escapes (2ⁿ−1 backslashes after n cycles). `syncStateFrontmatter` carries `last_activity_desc` through that seam on every state command, growing STATE.md unboundedly — the reported 134 MB file OOMed `state.record-session` after 26 writes. Double-quoted scalars are now un-escaped on parse via the exact inverse of the escaper, making serialize→parse a fixed point; unrecognized escapes are kept literally so hand-authored files parse unchanged. (#3497)
