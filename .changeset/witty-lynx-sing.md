---
type: Fixed
pr: 0
---
**A feature fragment declaring a malformed `order:` no longer sorts silently to the top of `docs/FEATURES.md`** — the generator validated that field by coercion, so an empty value read as `0` and hex, octal, binary and exponential values read as numbers, all placing the section ahead of every real feature with no violation and a clean `--check`. (#3840)
