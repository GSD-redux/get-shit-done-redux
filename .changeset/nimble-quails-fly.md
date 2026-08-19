---
type: Fixed
pr: 3680
---
**`check-glossary-refs` no longer reports a false clean** — backtick-pairing parity let stale file references in CONTEXT.md hide behind RULESET predicate lines, so renamed files stayed invisible to the drift gate. Visibility is now structural (per-line pairing + predicate-value harvesting), the renamed test reference is corrected, and retired-file mentions are exempted by name. (#3604)
