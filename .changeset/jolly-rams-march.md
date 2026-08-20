---
type: Added
pr: 3708
---
**New `planning inspect` query emits a schema-v1 snapshot of the whole planning state** — downstream harness UIs and dashboards can now read milestone identity, active position, per-phase verification/roadmap-acceptance/UAT evidence, requirement traceability, plan and task rows, and progress fractions from one read-only JSON document instead of parsing GSD's Markdown a second time. Unknown or conflicting evidence is reported as `unknown` with a coded diagnostic rather than inferred. (#2790)
