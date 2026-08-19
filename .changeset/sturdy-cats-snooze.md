---
type: Fixed
pr: 3692
---
**Process-spawned executors now receive the executor role and contract instead of inferring them** — on runtimes that use GSD-managed worktrees (Codex, Kimi, Kimi Code, OpenCode), a parallel executor was launched with a five-line prompt carrying no role, no plan path and no execution context, and success criteria that demanded an unconditional SUMMARY.md commit — pushing it to force-stage gitignored planning artifacts. (#3637)
