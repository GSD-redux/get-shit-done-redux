---
type: Fixed
pr: 0
---
**`roadmap validate` and `roadmap milestone-scope` now see bracket-convention phase entries (`### [GSD.04] 01:`)** — with `phase_id_convention: "bracket"` set, a genuinely truncated milestone window warned as nothing (V005 could never fire) while V004 falsely reported "no recognizable phase entries". Both now resolve the convention (config.json, ROADMAP frontmatter fallback) and route V004 through the shared entry predicate, so validate and the milestone-scope probe agree. Bracket milestone headings (`[GSD.02] Name`, no digit token) never count as entries. (#3641)
