---
type: Security
pr: 3510
---
**Hook security hardening — shared injection patterns + fail-closed force-add guard** — the prompt-injection pattern list is now one shared module used by both the write-guard and the read-scanner hooks, so the two surfaces can no longer silently drift apart; and the opt-in workflow guard's force-add block on agent branches now fails closed on internal error instead of silently allowing. (#3504)
