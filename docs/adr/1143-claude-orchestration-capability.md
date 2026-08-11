# ADR-1143: Claude orchestration capability — Workflow tool (ultracode) as a runtime-gated loop execution backend [Proposed]

- **Status:** Proposed
- **Date:** 2026-06-12
- **Issue:** [#1143](https://github.com/open-gsd/gsd-core/issues/1143)
- **Builds on:** [ADR-857](857-capability-system.md) — host/core vs plug-in split, loop extension points, `runtimeCompat`, federated config
- **Blocked by:** [#857](https://github.com/open-gsd/gsd-core/issues/857) being **released** (Proposed → Accepted + capability infrastructure shipped). Not actionable until then.
- **Relates to:** [#853](https://github.com/open-gsd/gsd-core/issues/853) (Claude Code backgrounded agents cannot nest subagents), existing BETA skill `gsd-ultraplan-phase`

## Why this is still `Proposed` (audited 2026-07-17)

Confirmed shipped, on-tree: the capability is real and registered, not vaporware. `capabilities/claude-orchestration/capability.json` exists with detection + emission (`detectWorkflowBackend` / `emitWorkflowScript`) in `src/claude-orchestration.cts` (compiled to `gsd-core/bin/lib/claude-orchestration.cjs`), federated config (`claude_orchestration.enabled` / `execution_backend` / `min_agent_sdk_version`), and 1,552 lines of tests across `tests/claude-orchestration.test.cjs` (which now includes the #2285 wiring-fix regression coverage, folded in per #3334) and `tests/claude-orchestration-command-router.test.cjs`. The previously-fatal wiring bug, #2285 ("claude-orchestration capability (#1143) registered as active but never wired into execute-phase orchestrator prompt"), is closed COMPLETED (2026-07-15) — one day before this audit — and the owning feature issue #1143 is also closed COMPLETED.

**The blocker.** The ADR sets its own bar for ratification in its own Amendment (above): "flipping to Accepted follows maintainer sign-off on the E2E behaviour once exercised on Claude Code with the Workflow tool present." No such exercise is recorded anywhere in issues, PRs, or tests. Every test in the two files above operates at the contract or CLI-subprocess layer — asserting the *shape* of an emitted script or the return value of `resolve-wave-dispatch` — none constructs or executes an actual Workflow-tool run (`grep -rn "Workflow(" tests/claude-orchestration*.test.cjs` returns no hits). Two further gaps sit inside the ADR's own Decision section: (1) Decision §1's claimed net effect — "wave parallelism, the plan-checker, and the verifier are restored" — is narrower than what shipped: `capability.json`'s own description says "the plan-checker and verifier remain inline until separately wired — this capability delivers the parallel-execution backend, not those gates"; (2) Decision §3's fold-in of the `gsd-ultraplan-phase` skill into the capability's `skills[]` has not happened — `capability.json` still shows `"skills": []`, and no follow-up issue for the migration the Amendment promises exists (searched via `gh issue list --search`, no result).

**Unblock condition.** Ratify once: (a) a real Claude Code session with the Workflow tool present and `claude_orchestration.enabled=true` drives an `execute-phase` wave through the Workflow backend, and the result is recorded (issue comment, PR, or a test that actually builds/executes a `Workflow` script rather than asserting emitted-script shape) — that is the maintainer sign-off the ADR itself asks for; and (b) the Decision section's "plan-checker and verifier restored" language is reconciled with the shipped scope (either corrected to match, or backed by a tracked issue for the deferred wiring `capability.json` already discloses). The `skills[]` migration (item 3) is lower priority since it is openly disclosed as deferred rather than silently dropped, but should carry a tracked issue number before ratification so it doesn't quietly vanish.

## Context

Claude Code ships two orchestration primitives GSD does not yet treat as first-class:

1. **`ultraplan`** (`/ultraplan <objective>`, `claude --teleport`) — hands a *planning* task to a Claude Code web session running in plan mode; the plan is drafted in the cloud, reviewed/commented in the browser, then approved back to the terminal (which archives the web session). GSD **already** wraps this as the BETA skill `gsd-ultraplan-phase` (`gsd-core/workflows/ultraplan-phase.md`), which constructs a plan prompt, triggers `/ultraplan`, and relies on the user manually running `/gsd:import --from <file>` to bring the plan back.

2. **`ultracode`** (`/effort ultracode`, or an `ultracode:` prompt prefix) — sets `xhigh` reasoning **plus automatic Workflow orchestration**. It is the trigger for the **Workflow tool** (Agent SDK ≥ v0.3.149): a deterministic JavaScript orchestrator that fans subagents out with `agent()`, `parallel()` (barrier), `pipeline()` (no barrier), and `phase()`, supporting `isolation: 'worktree'`, a shared token `budget`, custom `agentType`, and `resumeFromRunId`. It can be activated per-session via `/effort`, `--settings`, or an Agent SDK control request (`"ultracode": true`). **GSD does not use the Workflow tool at all.**

### Why this matters for the loop

GSD's `execute-phase` is wave-based: plans carry a `wave` number, waves run sequentially, and plans *within* a wave run in parallel when their `files_modified` sets do not overlap. Today GSD realizes that by dispatching, one `Agent` call per message, a backgrounded `gsd-executor` in a worktree.

On **Claude Code** this degrades. Backgrounded agents on Claude Code have no `Agent`/`Task` tool, so they cannot nest subagents (#853). The autonomous loop therefore falls back to **inline sequential execution** — and with it silently drops wave parallelism, the plan-checker, and the verifier — on the single runtime most GSD users run. The degradation is structural and outside GSD's control to fix at the agent layer.

The Workflow tool sidesteps #853 precisely because it is invoked **from the main loop**, not from a backgrounded agent: the script *is* the orchestrator and spawns the subagents itself. Its primitives map almost 1:1 onto GSD's existing wave model, and it adds three things GSD's hand-rolled fan-out lacks: determinism, a shared token budget, and resume.

Post ADR-857, GSD now has a home for exactly this kind of runtime-specific, preview-grade, toggleable feature: a **Capability** with `runtimeCompat`, a federated config slice, a `tier`, and loop-hook registration at the stable extension points. Before 857 there was nowhere clean to put runtime-gated loop behavior without forking core prose; after 857 it is a data manifest plus a registry regen.

## Decision

Introduce a **Claude orchestration Capability** — `capabilities/claude-orchestration/`, `role: feature`, `runtimeCompat: claude`, **default-off, BETA** — that adopts Claude Code's orchestration primitives as optional, runtime-gated GSD surfaces. It is **blocked on #857 being released** and ships only after the capability infrastructure is Accepted.

### 1. Workflow tool as an optional loop execution backend (primary, NEW)

When the active runtime exposes the Workflow tool, `execute-phase` may emit a generated **Workflow script** in place of manual one-agent-per-message dispatch. The translation preserves GSD's existing model:

| GSD execute-phase concept | Workflow primitive |
|---|---|
| Wave (barrier between waves) | `parallel()` barrier; or `pipeline()` when plans flow through stages without a cross-plan barrier |
| Plan executor | `agent(brief, { agentType: 'gsd-executor', isolation: 'worktree' })` |
| `files_modified` overlap forces sequential | overlap forces the plan into a later pipeline stage (same rule, declaratively) |
| Cost discipline | the Workflow `budget` pool |
| Resume / `gsd-undo` | `resumeFromRunId` keyed to the phase manifest |
| Orchestrator-only STATE.md / ROADMAP.md writes | unchanged — only the orchestrator (the script's return) writes shared files; executors stay in their worktrees |

Net effect on Claude Code: **wave parallelism, the plan-checker, and the verifier are restored** — the capability path is *not* a backgrounded agent, so #853 does not apply — and GSD gains determinism, a shared budget, and resume it does not have today.

### 2. Registration at ADR-857 loop extension points

The capability registers hooks at `execute:wave:pre`, `execute:wave:post`, and `execute:post`, resolved through `gsd_run loop render-hooks <point>`. Activation is gated by:

- **Runtime/tool detection** — the active runtime must actually expose the Workflow tool (Claude Code / Agent SDK ≥ the pinned minimum). Detection miss → no-op.
- **Federated config** — a `claude_orchestration.*` slice with `execution_backend: auto | workflow | inline` (default `auto`, which selects `workflow` only when the tool is present, else `inline`).

When neither gate passes, the loop runs exactly as it does today. This is the central safety property: **the inline/manual path remains the default and the only path on non-Claude runtimes and on Claude versions without the Workflow tool.**

### 3. Fold `ultraplan` under the same capability

The existing `gsd-ultraplan-phase` BETA skill and `commands/gsd/ultraplan-phase.md` become capability-owned at `plan:*`. Plan-offload (`ultraplan`) and execute-orchestration (`ultracode`/Workflow) then share one runtime gate, one federated config slice, and one BETA boundary — instead of `ultraplan` living as a stray BETA skill while a second preview surface is added elsewhere. This also lets a future iteration close `ultraplan`'s manual `/gsd:import --from` round-trip behind the same capability without touching core.

### 4. (Stretch) Other fan-out points opt into the same backend

`map-codebase` (parallel mappers), project/phase research (parallel researchers), and `plan-review-convergence` (parallel reviewers) are already manual `parallel`-shaped dispatches. Behind the same toggle and gate they can adopt the Workflow backend incrementally. Out of scope for the first cut; recorded so the capability is named for the general seam, not just execute-phase.

## Resolved design details

### Why a capability and not core

The Workflow tool is Claude Code / Agent SDK-specific and preview-grade. ADR-857 is explicit that the five-step loop plus shared-infrastructure skills are the privileged core and "every other feature is a Capability — a plug-in selectable at install and toggleable after restart." A runtime-specific, BETA execution backend is the textbook case for `role: feature` + `runtimeCompat: claude` + `tier`. Shipping it in core would re-introduce exactly the runtime-coupling 857 removed.

### Fallback is the contract, not an afterthought

The capability must be byte-for-byte transparent when absent: identical artifacts, commits, and STATE/ROADMAP writes whether a wave ran via the Workflow backend or the inline path. A parity regression test asserting this on a runtime without the Workflow tool is a release gate, not a nicety — it is what lets the capability be default-off and low-risk.

### Maintenance posture

The capability tracks two moving Claude-Code preview surfaces. Containment: one capability + BETA gate (mirroring today's `gsd-ultraplan-phase` BETA isolation), a pinned minimum Agent-SDK/Workflow-tool version in the runtime gate, and inline fallback on any detection miss. A preview-API change can degrade the capability to inline; it cannot break the core loop.

### Relationship to cross-AI delegation and plan-review-convergence

These existing multi-model features (`execute-phase` `cross_ai_delegation`, the convergence reviewer loop) are *model/runtime delegation*, not *intra-runtime fan-out orchestration*. They are orthogonal: cross-AI routes a plan to a different CLI; the Workflow backend parallelizes plans within the current Claude Code runtime. They compose rather than conflict.

## Consequences

- **Positive:** restores loop parallelism + plan-checker + verifier on Claude Code (undoing the #853 inline degradation); adds determinism, shared token budget, and resume to GSD execution; consolidates two Claude preview surfaces behind one gated capability; sets a reusable pattern for the other fan-out points.
- **Negative / cost:** another preview surface to track; a Workflow-script emitter and runtime/tool detection to maintain; BETA-grade until the upstream tool stabilizes.
- **Neutral:** no effect on non-Claude runtimes by construction; no behavior change until explicitly enabled.

> **Governance note:** This ADR is a *draft design* accompanying feature request #1143. Per CONTRIBUTING, it is PR'd only after the issue receives `approved-feature`, and the capability is implemented only after #857 is released.

## Amendment (2026-07-06): BETA v1 implementation landed

#857 is **released** (CLOSED); the capability infrastructure is live. The BETA v1
of this capability has shipped as `capabilities/claude-orchestration/` with the
scope agreed in the Decision, refined to the lowest-risk first slice:

- **Detection + emission** live as pure, fail-closed functions in
  `gsd-core/bin/lib/claude-orchestration.cjs` (source `src/claude-orchestration.cts`):
  `detectWorkflowBackend` (gate ladder: enabled → Claude runtime →
  execution_backend ≠ inline → host dispatch nested+background → valid Agent SDK
  → SDK ≥ `claude_orchestration.min_agent_sdk_version`, default `0.3.149`) and
  `emitWorkflowScript` (waves → `parallel()` stage barriers, plans →
  `agent({ agentType: 'gsd-executor', isolation: 'worktree' })`, `files_modified`
  overlap → separate sequential stages, `resumeFromRunId` wired to the phase run
  id, shared `budget(tokens)` pool). All interpolated values are validated as
  script-safe identifiers or JSON-quoted (review Finding 1).
- **Loop registration** is at the two **wired** points the loop host contract
  actually renders: `execute:wave:post into:executor` (Workflow-backend guidance)
  and `plan:post into:planner` (ultraplan ownership declaration). `execute:wave:pre`
  and `execute:pre` are declared in the contract but **not wired** today, so the
  capability registers at `wave:post` (the constraint `external-job` also documents).
- **Config** is federated (`claude_orchestration.enabled` default false /
  `activationKey`, `execution_backend` enum `auto|workflow|inline` default `auto`,
  `min_agent_sdk_version`); the keys live only in the registry, so uninstall
  removes them cleanly.
- **ultraplan ownership** is declared in the manifest (`plan:post` contribution);
  full install-profile migration of the `gsd-ultraplan-phase` skill into the
  capability's `skills[]` is deferred to a follow-up (it triggers the CLUSTERS /
  profile membership gate and is a heavier, install-machinery change).

Status remains **Proposed** — the BETA is default-off and the end-to-end Workflow
execution path (actual orchestration via the Workflow tool inside Claude Code) is
not verifiable outside that runtime. The capability is structurally complete and
tested at the contract level; flipping to Accepted follows maintainer sign-off on
the E2E behaviour once exercised on Claude Code with the Workflow tool present.
