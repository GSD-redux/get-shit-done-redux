---
type: Fixed
pr: 3462
---
Executor dispatch prompts no longer list companion files as raw @-include lines that Claude Code never expands inside an Agent() prompt string. The orchestrator now build-time embeds execute-plan.md and its companion references (summary template, checkpoints, tdd, worktree-path-safety, executor-examples) into the dispatched gsd-executor prompt, so execute-plan-only steps (segment_execution, previous_phase_check, verification_failure_gate, update_codebase_map) actually reach executors instead of silently never running.
