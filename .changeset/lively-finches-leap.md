---
type: Fixed
pr: 2638
---
**`query commit --files` now accepts absolute paths** — `cmdCommit` used `path.join(cwd, file)`, which concatenates instead of resetting on an absolute path, so absolute `--files` entries (e.g. the absolute `phase_dir` emitted by `init phase-op` since #2428) were joined to `cwd+absPath` (non-existent) and silently dropped as `nothing_to_commit` — and a mixed relative/absolute list committed the relative entries while reporting `committed:true`. Absolute paths are now normalized to repo-relative before staging/branch-detection, so they commit correctly and the phase-branch detection no longer matches digit-hyphen runs in the absolute prefix. (#2523)
