---
id: 4030
title: Typed Phase Context for Lifecycle Hooks
group: v1.7.0 Features
---

**Purpose:** a capability hook fired at a phase-scoped loop point knew the
point and the project directory, but not which phase the invocation was
*for*. The envelope from `gsd_run loop render-hooks <point>` carried
`{point, activeHooks, rendered, warnings?}` and nothing else, so a
phase-scoped extension had to infer the phase from `STATE.current_phase`
or from artifact order and mtimes. Those disagree with the invocation
whenever one phase is planned or verified while another is still
executing — `STATE.current_phase` is project lifecycle status, not a claim
about what this call is scoped to.

**`loop render-hooks` accepts `--phase <token>` and returns a typed
`context`.** The envelope gains an additive, optional member:

```json
{ "point": "plan:pre", "activeHooks": [], "rendered": "...",
  "context": { "phase": "05", "phaseDir": ".planning/phases/05-widgets" } }
```

`context` is **authoritative for task-local phase identity** — a capability
must prefer it over `STATE.current_phase` or artifact inference when both
are available. All 17 phase-scoped call sites now pass the phase they are
operating on, across `plan-phase.md`, `execute-phase.md`, `verify-work.md`,
`secure-phase.md`, `validate-phase.md`, `autonomous.md` and
`code-review-fix.md`, and `gsd-core/references/loop-hook-dispatch.md` tells
every `step` / `gate` dispatch how to project it onto the unit it invokes.

**The resolver derives the directory; the caller never supplies one.**
`--phase` takes only the bare token every workflow already holds (`"05"`,
including decimal phases like `"07.5"`). `phaseDir` is whatever on-disk
directory `guardedFindPhase` matched, so an incoherent phase/directory pair
is unrepresentable rather than merely rejected, and path traversal,
absolute-path substitution and symlink escape have no input to travel
through. Resolution goes through the same `project_code` foreign-prefix
guard `init.*` applies, so a token like `OTHER-05` does not resolve to this
project's Phase 5.

**Known limits:**
- Omitting `--phase` reproduces the previous envelope exactly — no
  `context` key appears and no fallback phase is invented.
- A token that matches no phase directory, matches more than one, or
  carries a foreign project-code prefix omits `context` and appends to the
  existing `warnings` array. `--phase` degrades; it never fails a render.
- `discuss:*` and `ship:*` are not phase-scoped points and are unchanged;
  `audit-milestone.md` and `quick.md` hold no phase to pass.
