---
type: Fixed
pr: 3390
---
**Interactive runs no longer stop for a checkpoint after every tracer task** — under the `end-of-phase` default a tracer whose `<verify>` is automated-only is re-run and expansion continues with no `checkpoint:human-verify`; `mid-flight`, tracers carrying `<human-check>`, and any task with `gate="blocking-human"` still stop for a human, and a failing tracer still halts. (#3299)
