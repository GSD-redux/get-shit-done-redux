---
type: Fixed
pr: 3006
---
**Trae IDE is now detected as its own runtime** — `/gsd-new-project` and `/gsd-ingest-docs` no longer fall through to the Claude default when run inside Trae, and a `--trae` install no longer writes a malformed `.claude/.trae/rules/` or `.trae/.trae/rules/` instruction-file path; it now resolves to the concrete `.trae/rules/rules.md`. (#2658)
