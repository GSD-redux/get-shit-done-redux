---
type: Fixed
pr: 3098
---
**`phase_id_convention` set in `.planning/config.json` is no longer silently dropped** — the config loader's resolved-config constructor omitted the key despite it being in the valid-keys manifest, so the milestone-prefix validation check could only be activated via the ROADMAP frontmatter fallback. The key now survives resolution. (#2997)
