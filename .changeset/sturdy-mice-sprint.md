---
type: Fixed
pr: 3012
---
**Statusline now shows GSD state in workstream mode** — the GSD-state segment used to silently disappear in workstream-mode projects with no root STATE.md, even with an active workstream selected; it now resolves the active workstream (env var or stored pointer) and shows its milestone/phase/progress, or an explicit "no active workstream" message when nothing resolves. (#2850)
