---
type: Added
pr: 0
---
**A generated exit-code reference at `docs/reference/exit-codes.md`.** Every registered exit code now has a page giving its number, name, meaning and owning band, alongside why `0` and `1` are unallocatable and why `3`-`13` are reserved by Node — so a `69` in a CI log has somewhere to be looked up. The page is generated from the same declaration the registry itself is built from and is `--check`-gated against drift. (#3913)
