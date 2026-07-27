---
type: Fixed
pr: 2678
---
**Editing `src/` no longer trips an undocumented changeset-lint failure** — CONTRIBUTING.md listed the Changeset Required triggers without `src/`, the path that compiles into every `gsd-core/bin/lib/*.cjs`, so contributors touching it hit a CI failure the docs said could not happen — and a local run of the lint reported success regardless, because it silently requires `GITHUB_BASE_REF` to see the branch at all. Both are now documented, and the config-loader test-helper that reset only one of its two warning-dedup sets now resets both. (#2674)
