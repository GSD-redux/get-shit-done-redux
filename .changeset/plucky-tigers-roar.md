---
type: Security
pr: 3496
---
**`verify key-links` can no longer be hung by a plan's `key_links` pattern** — the pattern was compiled straight from plan frontmatter with a backtracking engine and tested against whole file contents, so a nested-quantifier pattern such as `(a+)+$` pinned a CPU core indefinitely and stalled any `verify-phase` run that reached it. Untrusted patterns now execute on the RE2 engine, whose match time is linear in the input length, and a pattern that cannot be compiled is refused outright rather than guessed at — a refused pattern can never report a match. (#3477)
