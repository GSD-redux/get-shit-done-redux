---
type: Changed
pr: 2685
---
**Completing a phase now warns when its SUMMARY claims files that never landed** — `phase complete` runs the artifact check that `verify-summary` has always applied to the research SUMMARY against the completing phase's own `SUMMARY.md` files, and reports any referenced path that is not on disk through its existing `warnings[]` channel. Previously the check was wired to exactly two call sites, both pointed at `.planning/research/SUMMARY.md`, so the summaries that actually assert "I created these files" were never verified and an interrupted phase counted toward 100% silently. Advisory only: it never blocks completion. Paths are recovered heuristically from the SUMMARY body, so globs, URLs, bare hostnames, and paths resolving outside the project are skipped rather than reported; the `key-files:` frontmatter block and commit hashes are deliberately not read. (#2572)
