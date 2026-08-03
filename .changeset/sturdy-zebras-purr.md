---
type: Fixed
pr: 3032
---
**A `--kimi-code` install now configures hooks in Kimi Code, not Kimi CLI** — installing GSD for Kimi Code wrote its lifecycle hooks, hook bundle and CommonJS marker into Kimi CLI's `~/.kimi/config.toml`, so Kimi Code itself received no hooks at all and a machine with only Kimi Code got a config file no product reads. Each Kimi product now uses its own root and its own environment override (`KIMI_SHARE_DIR` for Kimi CLI, `KIMI_CODE_HOME` for Kimi Code), and uninstalling one no longer removes the other's hooks. (#2755)
