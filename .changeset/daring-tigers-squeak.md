---
type: Fixed
pr: 0
---
**`fish_add_path` no longer skips a directory whose name starts with a dash** — fish parses a leading-dash token as an option, so the suggested command silently added nothing; it now passes the end-of-options separator. Also fixes a `config.toml` written unparseable when a value carried a newline or NUL, an installer PATH hint that printed a header with nothing under it, and a reviewer lane that crashed instead of degrading when its conversation cache file held the literal `null`. (#3118)
