---
type: Fixed
pr: 0
---
**UAT rows separated only by a lone carriage return were silently dropped from the audit-uat scan.** A `VERIFICATION.md` or `deferred-items.md` written with lone-CR line endings rendered normally to a human reader, but reported zero outstanding items to the audit, hiding real human-verification and deferred-work entries. Both file types now surface their rows exactly as their LF/CRLF equivalents do.

**Planning-inspect now surfaces UAT rows separated only by a lone carriage return.** The same lone-CR line-ending gap also hid rows from planning-inspect's own UAT reporting; a row that previously vanished from `uat.unresolved` now appears there too, matching its LF/CRLF equivalents.

**A UAT row whose `result:` line had trailing text containing a Unicode line or paragraph separator (U+2028/U+2029) is no longer dropped.** A column-0 `result:` line whose text after the token happened to contain one of these separators previously failed to parse at all, silently discarding an outstanding row; it now parses the same as its plain-line equivalent. (#3707)
