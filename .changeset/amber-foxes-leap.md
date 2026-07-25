---
type: Fixed
pr: 0
---
**`/gsd-profile-user` now writes the runtime-native instruction file on Codex (and other AGENTS-native runtimes)** — `generate-claude-profile` hardcoded `.claude/CLAUDE.md` for both project and global scope, ignoring the runtime-aware resolution that #3163 wired into the sibling `generate-claude-md` handler. The #3163 fix diverged when it didn't propagate here, so running `$gsd-profile-user --refresh` on a Codex install created/modified Claude configuration instead of producing a Codex `AGENTS.md` profile. Project scope now resolves through `getProjectInstructionFile(runtime)` (`AGENTS.md` for codex/opencode/kilo/kimi/unknown, `GEMINI.md` for antigravity, `.github/copilot-instructions.md` for copilot); global scope derives `~/.<config-home>/<instruction-basename>` so codex lands at `~/.codex/AGENTS.md`. Claude is preserved byte-for-behaviour. A parity test guards against future re-divergence between the two handlers. (#0)
