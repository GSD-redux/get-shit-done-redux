---
type: Fixed
pr: 3096
---
**`/gsd-code-review` no longer picks a wrong diff base from unanchored commit-message grep** — the diff-base fallback searched all commit messages for the bare phase number as a substring, matching version strings, dates, and issue refs, then took the oldest match. The grep is now anchored to the phase-mention convention (`Phase N` with a word boundary), so the fail-closed branch is reachable when no commit genuinely references the phase. (#2989)
