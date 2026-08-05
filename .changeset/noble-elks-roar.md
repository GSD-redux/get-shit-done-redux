---
type: Fixed
pr: 3076
---
**Planning artifacts whose frontmatter is preceded by a UTF-8 byte-order mark no longer lose all their frontmatter fields** — the frontmatter parser's fence check required the opening dashes at byte zero, so a BOM written by Windows PowerShell or several editors made every field silently disappear. A leading BOM is now stripped before the check, so the fields parse identically to the no-BOM case. The no-frontmatter and thematic-break cases stay silent and empty as before.
