---
type: Added
pr: 2005
---
**Qoder (Alibaba) is now a supported install runtime** — `npx @opengsd/gsd-core --qoder` installs GSD skills and agents to `~/.qoder/` (or `QODER_CONFIG_DIR`), wires settings-json hooks (Claude-compatible event surface incl. SubagentStart/SubagentStop/Stop/PreCompact/FileChanged), and emits Qoder-native artifact conversions (AGENTS.md frontmatter, path rewrites, zero `.claude` leakage). Installs 71 skills across the full profile; available as interactive menu option 15 and via `--all`. (#860)
