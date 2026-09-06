---
type: Fixed
pr: 4061
---
**Imperative-override injection patterns now tolerate filler words** — a planted phrasing with `all of your` between the verb and `instructions` previously matched nothing; the five narrow verb patterns are replaced by one superset pattern (`ignore|disregard|forget|discard|override`, with `override` and `discard` both covered) so a sentence counts once toward the severity threshold instead of twice. The prompt-guard advisory now renders the same bounded pattern label as the read scanner instead of echoing the raw regex source. (#4016)
