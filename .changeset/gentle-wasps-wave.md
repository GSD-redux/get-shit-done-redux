---
type: Added
pr: 3296
---
**`effort sync` now repairs stale Codex `.toml` files without a reinstall** — on a `codex` install it strips a `model` pin that Codex rejects (a tier alias or a `claude-*` id) and an orphaned `model_reasoning_effort`, so agents fall back to the always-available session model. An explicit real-Codex pin is left alone. It is a **dry run by default** — pass `--apply` to write — and only the offending lines are removed: line endings, BOM, comments, key order, and any keys you added by hand are preserved byte-for-byte, so a repair is a two-line diff rather than a reformatted file. A file that cannot be parsed is refused and reported, never partially rewritten, and writes are atomic. Pairs with `validate agents`, which detects the same drift. The `claude` path is unchanged. (#3243)
