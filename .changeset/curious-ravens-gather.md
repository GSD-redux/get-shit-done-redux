---
type: Fixed
pr: 0
---
**pi installs no longer trigger pi's deprecated-directory startup warning, respect `PI_CODING_AGENT_DIR`, and never lose custom files during an update** — the shared hook bundle now installs to `gsd-hooks/` instead of `hooks/` (which pi reserves for its own deprecated extension location and warns about on every startup), with an upgrade migration retiring the old directory; pi's own `PI_CODING_AGENT_DIR` override is now honored when resolving where GSD writes; and `/gsd-update`'s custom-file detection now recognizes the renamed bundle, so user files placed under it are backed up before a clean install instead of being silently wiped. (#3023)
