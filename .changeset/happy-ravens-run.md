---
type: Fixed
pr: 0
---
**Concurrent Claude Code sessions no longer share one active-workstream pointer** — Claude Code exports its session id as `CLAUDE_CODE_SESSION_ID`, but the session-identity probe only listened for `CLAUDE_SESSION_ID`, so session-scoped workstream isolation never engaged on Claude Code: every session in a working tree resolved through the single shared `.planning/active-workstream` pointer, and a `STATE.md` update belonging to one workstream could be written silently into another's directory. The probe now accepts `CLAUDE_CODE_SESSION_ID` (no other key's precedence changed); concurrent sessions each keep their own session-scoped pointer again. (#3557)
