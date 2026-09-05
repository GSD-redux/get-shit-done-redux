---
type: Fixed
pr: 4288
---
**`verify plan-structure` now flags quantitative acceptance criteria that are traps at HEAD** — plans whose criteria used an exact `grep -c` count, a bulk "all N tests were observed failing" claim, an unquoted $VAR in command position, `wc` output compared by string equality, or a relative `HEAD~N` git anchor passed verification while the criterion was unsatisfiable or vacuous before any work began. (#4024)
