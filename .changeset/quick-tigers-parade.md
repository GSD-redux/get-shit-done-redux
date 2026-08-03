---
type: Fixed
pr: 3011
---
**Nine compiled `.cjs` runtime artifacts under `gsd-core/bin/lib/` are no longer tracked in git** — they are ADR-457 build outputs of `src/*.cts` sources and were missing from `.gitignore`, letting the committed bytes silently drift from source (as happened to `api-coverage.cjs` in #2653). They now build fresh from source like their ~160 already-gitignored siblings. (#2657)
