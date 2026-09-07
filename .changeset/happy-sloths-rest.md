---
type: Fixed
pr: 4371
---
**A Kimi surface change no longer corrupts the installed agent tree** — `applySurface` now materializes the `kimi-agents` kind recursively (`gsd.yaml`, `gsd.md`, `subagents/gsd-*.{yaml,md}`) instead of writing `gsdgsd.md` and dropping the YAML and subagents, prunes only GSD-owned Kimi files, and stages with the same context a fresh install uses. (#4211)
