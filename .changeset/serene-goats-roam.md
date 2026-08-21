---
type: Added
pr: 3745
---
**UI-SPEC component inventories now record how they were produced** — a spec that lists the components a design system offers must name the command that enumerated them, the count it returned, the resolved package version and the date. `gsd-ui-checker` gains a seventh dimension that reports an inventory with no such line as a defect and downgrades it from a closed allowlist to a non-exhaustive list of known-good components, so an executor is never blocked from a component the spec merely failed to mention. (#2845)
