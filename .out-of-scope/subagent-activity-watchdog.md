# Generalized subagent activity watchdog

**Source:** [#2699](https://github.com/open-gsd/gsd-core/issues/2699)
**Decision:** wontfix — No-go as filed; redirected to [#2650](https://github.com/open-gsd/gsd-core/issues/2650)
**Date:** 2026-07-27

## Proposal summary

Reporter proposed a general, runtime-agnostic watchdog that would continuously classify
every spawned role agent (planner, executor, reviewer, researcher) into one of five
states — `ACTIVE`, `STALLED`, `COMPLETED_WITHOUT_MARKER`, `LOST_WITHOUT_ARTIFACT`,
`FAILED` — and surface recovery checkpoints instead of an indefinite spinner.

The proposed mechanism: a `SubagentWatchState` object per spawned agent, updated from
tool-call start/end events, artifact creation and mtime changes, commits, and an optional
30–60 second heartbeat emitted by the agent or its wrapper; plus per-unit
`expectedArtifacts` declarations, a `watchdog.*` config block, and bounded chunk resume
that preserves already-committed chunks. Explicitly not `ps aux`, explicitly no auto-kill.

## Why GSD does not own this

- **A narrower version already ships, and this proposal skips past it.**
  `gsd-core/workflows/execute-phase.md` already implements artifact-aware stall detection
  for the executor: a SUMMARY-existence plus `git log --since` spot-check (`:742-744`), a
  periodic surveillance loop (`:755-762`) gated on `executor.stall_detect_interval_minutes`
  and `executor.stall_threshold_minutes` (read at `:100-101`; both registered in
  `SCHEMA_DEFAULTS` at `src/config.cts:89-90`, defaults 5 and 10), and a *continue waiting /
  kill and retry / kill and switch to inline* recovery triad (`:759-762`) that never
  auto-kills. The proposal's core insight is already the shipped design; what it adds is
  generalization.
  *(Line numbers are as of the commit that added this entry and will drift; the symbol and
  config-key names are the durable anchors.)*

- **The gap it is actually motivated by has a scoped fix already diagnosed.** #2650
  carries a confirmed diagnosis and Agent Brief for the real gap — plan-phase's planner
  and plan-checker have no equivalent mechanism — sized as mirroring the two executor
  config keys into `planner.*` and reusing the existing checkpoint. That brief explicitly
  scopes out generalizing beyond plan-phase and any `SubagentWatchState`-style
  rearchitecture. Accepting #2699 would mean building the larger system on top of a
  foundation that has not landed.

- **The event-driven model assumes an orchestrator GSD does not have.** The proposal
  assumes a resident process with an event loop that can subscribe to hook callbacks and
  maintain an in-memory `lastActivityAt`. GSD's orchestrator is an LLM interpreting
  workflow markdown one turn at a time. Host-fired hooks run out-of-band and do not
  return control to the orchestrating prompt mid-spawn. The only mechanism that yields a
  turn in which a check can run is a backgrounded dispatch that returns control between
  polls. This is a categorical mismatch, not a per-runtime coverage gap — it does not
  resolve by picking a different host.

- **The heartbeat has no place to live.** Agents emitting JSON every 30–60 seconds
  requires wrapper-level control over agent execution that no GSD-supported runtime
  exposes. Absent a wrapper, the spawned agent would have to interleave heartbeat
  emission with its actual work, competing for the same turn.

- **The specification is incomplete by the project's own bar.** The issue was not filed
  through `feature_request.yml` and omits its required fields — type of addition, user
  stories, maintenance burden, alternatives considered, breaking changes. `CONTRIBUTING.md`
  states that incomplete specs are closed rather than revised by maintainers.

Note that the proposal's *premise* about runtime portability was sound and is not a
ground for rejection: `hookBus: host` and `stateIO: filesystem` are documented for the
large majority of supported runtimes in the host-integration capability matrix. The
blocker is the dispatch model, not signal availability.

## What this does NOT cover

This entry denies a **generalized, event-driven, heartbeat-augmented watchdog layer**.
Its keyword surface — watchdog, stall, timeout, heartbeat, hung agent, orphan, recovery —
overlaps request types this decision deliberately does not deny. Do not apply this entry to:

- **Extending the existing spot-check pattern to another spawn site.** Mirroring the
  executor's config keys and checkpoint into plan-phase, code-review, or any other
  workflow is the sanctioned incremental path. That is #2650's shape, and it is welcome.
- **Fixing the shipped executor mechanism.** If the executor's stall detection does not
  fire when it should — and there is open evidence it may not, on a single
  non-backgrounded spawn — that is a defect report, not this proposal.
- **Making a specific hang observable.** A report that one command hangs with no
  diagnostic is a bug about that command.
- **Config or documentation for the existing `executor.stall_*` keys.**
- **A display-only progress or elapsed-time indicator.** Showing "waiting on planner,
  last activity 4m ago" while a spawn is outstanding — with no state machine, no
  classification, and no recovery action — is a UX improvement, not this proposal. It is
  denied by nothing here.
- **Orphaned OS processes, containers, or bench resources.** Leaked test-runner containers
  and similar host-level cleanup share the words *orphan* and *recovery* with this entry
  but are a different domain entirely — nothing about GSD subagent dispatch. This entry
  says nothing about them.

## Re-open criteria

This may be revisited if:

- **#2650's fix has shipped**, and the resubmission **names at least one specific residual
  failure observed after it shipped** — a concrete case the shipped mechanism did not
  catch — rather than arguing for the full five-state model in the abstract.
- The **dispatch-turn dependency is resolved first**: a demonstrated mechanism by which
  the orchestrator reliably receives an execution turn during a single, non-backgrounded
  spawn. Until that exists, any watchdog generalization inherits the same unreliability
  the executor mechanism is already suspected of.
- The proposal is refiled through `feature_request.yml` with its required fields
  completed.

A generalization is accepted here once the narrow pattern it generalizes is **in use at two
or more spawn sites** and a **named, reproduced failure** shows why per-site application is
no longer sufficient — not before.

## Related

- `gsd-core/workflows/execute-phase.md` — the shipped executor stall-detection pattern
- `src/config.cts` — `SCHEMA_DEFAULTS`, where `executor.stall_*` keys are registered
- `docs/reference/host-integration-capability-matrix.md` — per-runtime `hookBus` / `stateIO` surfaces
- [#2650](https://github.com/open-gsd/gsd-core/issues/2650) — the confirmed defect this was redirected to
