---
type: Fixed
pr: 4224
---
**`/gsd-ui-review` no longer claims screenshots it did not take, and no longer calls a live dev server absent** — the auditor's capture path now follows redirects and accepts any 2xx (a dev server whose `/` redirects was previously audited code-only), actually tries ports 3000, 5173 and 8080 as its own documentation promised, and derives the reported `Screenshots:` field from real exit statuses and files on disk, so it distinguishes full capture, partial capture (N/3) and failure-with-reason instead of printing success unconditionally. (#4176)
