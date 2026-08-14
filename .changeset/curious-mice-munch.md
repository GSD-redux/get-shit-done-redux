---
type: Fixed
pr: 3480
---
A genuinely milestone-sectioned ROADMAP whose STATE.md asserts a milestone token matching no heading no longer has progress.total_phases clobbered to the on-disk phase-directory count (e.g. 25 -> 4) on every state-mutating command. The stored total is preserved (or the key omitted when nothing is stored), a stderr warning names the unbounded milestone token, and progress.percent stays withheld as before.
