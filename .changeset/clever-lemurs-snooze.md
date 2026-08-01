---
type: Fixed
pr: 2975
---
**`windows append`/`waive`/`fixed` no longer destroy prose below the JSON ledger** — the writer reconstructed the file from the parsed JSON ledger only, silently dropping any human-authored prose sections below the closing fence. The writer now preserves trailing prose across all write operations. (#2893)
