---
type: Added
pr: 4393
---

**Phase-scoped capability hooks now receive the phase they were invoked for, instead of guessing it** — `loop render-hooks <point>` gained an optional `--phase <token>` and returns a typed `context: {phase, phaseDir}`, which the 17 phase-scoped call sites across plan, execute, verify, secure, validate and autonomous now pass. Before this, a hook fired at `plan:pre` while planning Phase 2 had nothing but `STATE.current_phase` (still Phase 1, because Phase 1 is what is executing) or artifact mtimes to infer from, so phase-scoped extensions acted on the wrong phase whenever one phase was planned or verified while another ran. Omitting `--phase` leaves the previous envelope byte-identical, and a token that does not resolve to exactly one phase directory degrades to a warning rather than failing the render. (#4030)
