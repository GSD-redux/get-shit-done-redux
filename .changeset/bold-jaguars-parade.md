---
type: Fixed
pr: 4413
---
**`/gsd:update` no longer misreports a global install as LOCAL when the shell sits in $HOME** — running the update from a home-directory shell drove the installer's --local arm (settings.local.json + the #338 relocation) against a global install; the preferred-config-dir fast path now applies the same same-path dedup the rest of the detection cascade always has. (#4197)
