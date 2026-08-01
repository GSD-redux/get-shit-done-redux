---
type: Added
pr: 2972
---
**Workflow markdown can now fragmentize into per-runtime-composed sections.** Authors can mark sections of a workflow file with in-file `<!-- gsd:section id= when= -->` markers; per-runtime emission strips the markers and composes the marked sections back byte-identical-or-smaller, piloted on `execute-phase.md`. (#2930)
