---
type: Added
pr: 0
---
**`query audit-uat` now segments its summary by milestone.** The JSON output adds `summary.current_milestone: {files, items}` and `summary.archived: {files, items, by_milestone}`, so a consumer can read current-vs-archived UAT/verification debt directly instead of re-deriving the `archived_milestone` filter itself. Existing fields (`total_items`, `total_files`, `parse_gap_files`, `by_category`, `by_phase`) are unchanged. (#3783)

<!-- docs-exempt: internal JSON contract of the `query audit-uat` CLI verb, consumed by workflow .md files (progress.md, audit-fix.md) rather than end users; the pre-existing sibling fields (total_items, by_phase, by_category, parse_gap_files) this is additive to were never documented in docs/ either, and the maintainer's triage approval scoped this PR to the summary builder + tests only -->
