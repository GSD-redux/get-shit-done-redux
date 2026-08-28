---
type: Fixed
pr: 3971
---
**`GSD_PROJECT`-scoped projects keep their signals and probes in their own tree** — `init manager`'s waiting signal, `map-codebase`'s dir/maps probes, `skill-manifest --write`, and `init.new-project`'s codebase-map readiness now all resolve through the project-aware planning dir instead of the repo root. (#3964)
