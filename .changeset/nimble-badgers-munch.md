---
type: Fixed
pr: 3134
---
**`npm test` no longer writes into the developer's live config directory** — `TEST_ENV_BASE` scrubbed 14 session-identity vars but omitted `CLAUDE_CONFIG_DIR`, `GSD_RUNTIME`, and `CODEX_HOME` (config-location vars that decide WHERE a child writes). The config-home resolver consults these before `HOME`, so an ambient value won unconditionally over a sandboxed `HOME`. All three are now blanked. (#2665)
