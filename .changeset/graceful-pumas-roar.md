---
type: Added
pr: 0
---
**New ESLint rule `local/no-exact-case-env-access`** — flags an exact-case read of a Windows case-varying environment variable (`PATH`, `PATHEXT`, `ComSpec`, `USERPROFILE`, `TEMP`, `TMP`, `APPDATA`) off any object other than `process.env` itself, closing the gap ADR-1703's portability catalog left on production Windows semantics. (#3624)
