---
type: Fixed
pr: 3537
---
**Installing GSD for Claude at both global and local scope no longer silently hides your project's specs.** Claude Code always resolves the personal skill over the project command, so a project with a local install previously ran the global workflow specs with no warning. The install now prints which scope wins and `/gsd-health` surfaces the same as diagnostic W028; at global scope, the winning skill's workflow reference now resolves your project's own specs first when present. (#2218)
