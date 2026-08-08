---
type: Fixed
pr: 2728
---
**`/gsd-quick` and the UAT-diagnosis step no longer abort with a FATAL on a non-Claude runtime that can actually isolate** — both dispatch sites resolved worktree isolation from a hardcoded `RUNTIME != "claude"` test, so every non-Claude host was refused regardless of what it could actually do. They now read the negotiated `dispatch.isolation` capability (#2584), and installs for runtimes that declare worktree support no longer stamp `workflow.use_worktrees` to `false`, which had pre-empted that negotiation. A runtime is judged by what it declares rather than by its name. A host that declares no isolation primitive at all still fails closed when worktrees are explicitly enabled — that FATAL is the fail-closed contract, not the bug — and a host whose isolation model the single-agent sites cannot express degrades to sequential, one agent at a time, on the main working tree.
