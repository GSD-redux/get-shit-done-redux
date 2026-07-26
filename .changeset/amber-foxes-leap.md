---
type: Fixed
pr: 2659
---
**`/gsd-profile-user` now writes the runtime-native instruction file on Codex and other AGENTS-native runtimes** — `generate-claude-profile` hardcoded `.claude/CLAUDE.md` for both project and global scope, ignoring the runtime-aware resolution that #3163 wired into the sibling `generate-claude-md` handler. The #3163 fix diverged when it didn't propagate here, so running `$gsd-profile-user --refresh` on a Codex install created/modified Claude configuration instead of producing a Codex `AGENTS.md` profile. The command now resolves its target through the shared runtime policy: project scope uses `getProjectInstructionFile(runtime)` and global scope derives `~/.<config-home>/<instruction-basename>`, so codex lands at `~/.codex/AGENTS.md`. Claude behaviour is preserved. A parity test guards against future re-divergence between the two handlers. (#2659)
