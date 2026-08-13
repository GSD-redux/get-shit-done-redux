---
type: Changed
pr: 3405
---
**`validate health --repair` no longer resets config.json or regenerates STATE.md automatically** — these two repairs are destructive (they lose custom settings or session history), so they're now reported with their fix described but never auto-applied; run the suggested command yourself to apply them.
