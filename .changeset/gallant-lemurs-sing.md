---
type: Security
pr: 3175
---
**Prompt-injection scan no longer misses single-quoted `eval()`/`exec()` payloads on macOS, and no longer flags ordinary prose** — the patterns used a GNU-grep-only `\\x27` escape that BSD/macOS grep read as four literal characters, so single-quoted code-execution payloads went undetected there while passing on CI; separately, several patterns lacked a left word boundary and matched inside ordinary words (`fact as a`, `retrieval(`, `Jordan mode`). (#3023)
