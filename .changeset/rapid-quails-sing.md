---
type: Fixed
pr: 3736
---
**Worktree executors no longer fork from the wrong base on long-lived branches** — `worktree.baseRef:"head"` no longer silences the pre-dispatch base check on harness-managed runtimes: the check now compares HEAD against the actual fork base and auto-degrades to sequential execution before dispatch when they diverge, instead of letting every isolated executor die at the exit-42 guard. The suppress now applies only where GSD itself creates worktrees (where the setting is honored by construction). (#3659)
