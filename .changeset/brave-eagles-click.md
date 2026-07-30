---
type: Fixed
pr: 2839
---
**`/gsd-code-review` no longer silently drops CRLF-saved artifacts** — the Tier-2 file-scope extractor (and every REVIEW/REVIEW-FIX frontmatter reader in the code-review and code-review-fix workflows) used a literal `\n` to find the YAML block, so any SUMMARY.md/REVIEW.md saved with CRLF line endings (default on Windows) contributed zero files with no warning. The boundary now normalizes CRLF first, so a mixed CRLF/LF phase reviews the union of its files instead of an incomplete set. (#2694)
