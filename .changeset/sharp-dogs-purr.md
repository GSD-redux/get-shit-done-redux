---
type: Added
pr: 2635
---
**Parallel execute-phase waves now run on Codex, OpenCode, Kimi and Kimi Code** — previously only Claude Code could execute a wave's independent plans concurrently, because worktree isolation relied on its harness-native `isolation="worktree"` primitive and every other runtime failed closed to sequential. Executor isolation is now a negotiated capability: runtimes whose harness isolates executors (Claude Code, Cursor) use their own flag, and runtimes exposing a headless exec with a working directory (Codex, OpenCode, Kimi, Kimi Code) get worktrees that GSD creates, validates and merges itself. Runtimes with no isolation primitive still run sequentially, and an unknown declaration always degrades to sequential rather than to an unisolated parallel run. (#2627)
