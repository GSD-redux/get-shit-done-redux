---
type: Fixed
pr: 3522
---
**`state add-roadmap-evolution` and `state add-decision` no longer persist a literal `Phase ?` when `--phase` is omitted** — both commands built their entry from the raw CLI flag's `?` fallback instead of the phase already recorded in STATE.md, even with `current_phase: 3` present in frontmatter. Both now resolve the phase through a strict write-path ladder (frontmatter `current_phase` → body `Current Phase` → `Phase: X of Y` scoped strictly to `## Current Position`), leaving `?` only when genuinely unresolvable; an explicit `--phase` still wins. The resolver deliberately does not reuse the read-path `resolveStatePhase`, whose document-wide fallback could adopt a stale historical `| Phase | N |` table row. A guard test now sweeps `src/*.cts` for any new raw `phase || '?'` call site. (#3481)
