---
type: Fixed
pr: 0
---
**UAT rows separated only by a lone carriage return were silently dropped from the audit-uat scan.** A `VERIFICATION.md` or `deferred-items.md` written with lone-CR line endings rendered normally to a human reader, but reported zero outstanding items to the audit, hiding real human-verification and deferred-work entries. Both file types now surface their rows exactly as their LF/CRLF equivalents do. (#3707)
