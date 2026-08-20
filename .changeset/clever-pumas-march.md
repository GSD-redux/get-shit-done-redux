---
type: Fixed
pr: 3694
---
**Codex worktree-parallel executors now launch with the full executor contract** — the orchestrator-worktree process spawn handed its child a short objective-only prompt, so executors reconstructed their role by repository search and force-staged gitignored SUMMARY.md files (`git add -f`) to satisfy an unconditional commit criterion. The spawn prompt now carries the embedded executor workflow, required reading with the explicit plan path, the gsd-executor persona, and skip-aware success criteria, and halts before spawn when the contract embeds cannot be resolved. (#3637)
