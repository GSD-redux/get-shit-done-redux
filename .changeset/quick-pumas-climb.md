---
type: Fixed
pr: 0
---
ui-plan-gate no longer blocks planning on a UI-token match alone: the gate now requires static frontend evidence (a package.json UI-framework dependency or a component-framework file in the tree) before blocking, so a phase section naming a hyphenated repo like dashboard-financeiro no longer trips the gate in a repo with no frontend. The gate result also surfaces matchedToken/matchedLine so operators can see what triggered the flag.
