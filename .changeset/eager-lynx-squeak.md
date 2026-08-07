---
type: Fixed
pr: 3137
---
**`gsd-tools windows` no longer crashes on CRLF ledgers** — on repos with `core.autocrlf=true` (Windows default), the frontmatter parser threw on the last key of a CRLF `WINDOWS.md`, making the broken-windows status/waive/fixed subcommands unusable. (#3116)
