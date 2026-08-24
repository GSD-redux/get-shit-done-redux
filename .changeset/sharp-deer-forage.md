---
type: Fixed
pr: 3731
---
**Orphaned GSD hooks in `~/.kimi` can now be reclaimed** — a `--kimi-code` install older than 1.10.0 wrote its hooks block, hook bundle and CommonJS marker into Kimi CLI's `~/.kimi` instead of Kimi Code's own root, and upgrading stranded those artifacts with no path to remove them. Adding `--reclaim-kimi-legacy` to a `--kimi-code` install now clears them; it stays opt-in because the stale block is byte-identical to a legitimate Kimi CLI one, so an automatic cleanup could not tell the two apart. (#3031)
