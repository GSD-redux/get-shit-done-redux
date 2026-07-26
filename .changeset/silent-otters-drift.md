---
type: Fixed
pr: 2660
---
**`STATE.md` frontmatter is no longer silently overwritten by stale field lines in archive sections** — `buildStateFrontmatter` extracted Last Activity, Paused At, and the other current-state fields from the entire `STATE.md` body via `stateExtractField`, which matches the first `Field:` line anywhere. A historical line in an archive section further down the file silently overwrote the correct frontmatter value on every sync, and because the poisoning line stayed in the body it regressed again on the next write — so each repair looked successful and then silently reverted, with the offending line hundreds of lines away from the frontmatter. Field extraction is now scoped: current-state fields read from the body preamble before the first `##` heading, and session fields read from `## Session`. This generalizes the #2444 fix, which scoped `Stopped At` to `## Session` but did not propagate to the sibling fields. (#2660)
