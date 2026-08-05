---
type: Fixed
pr: 3067
---
**Updating GSD on Codex no longer deletes user settings from config.toml** — the config merge preserved content before the GSD marker block but discarded everything after it, so any model preference, MCP server, or profile added after a fresh install was wiped on every update. The merge now preserves genuine user TOML after the block by routing it through the existing section stripper, which removes only GSD-owned sections while keeping user tables, and #2406's leaked-section de-dup still holds. Re-merging is idempotent.
