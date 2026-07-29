# Claude orchestration capability (BETA)

> **Explanation** — *why this capability exists and how it fits the loop.* For the
> step-by-step, see the [capability reference](../reference/capability-matrix.md);
> for the design record, see [ADR-1143](../adr/1143-claude-orchestration-capability.md).

## The problem

GSD's `execute-phase` is wave-based: plans carry a wave number, waves run
sequentially, and plans *within* a wave run in parallel when their
`files_modified` sets don't overlap. On most runtimes GSD realizes that by
fanning out one backgrounded `gsd-executor` agent (in a worktree) per plan.

On **Claude Code** that fan-out degrades. Backgrounded agents on Claude Code have
no `Agent`/`Task` tool, so they cannot nest subagents ([#853]). The autonomous
loop therefore falls back to **inline sequential execution** — and with it
silently drops wave parallelism, the plan-checker, and the verifier — on the one
runtime most GSD users run.

Claude Code ships an orchestration primitive that sidesteps exactly this: the
**Workflow tool** (the engine behind `/effort ultracode`, Agent SDK ≥ v0.3.149).
A Workflow script *is* the orchestrator — it runs from the main loop and spawns
subagents itself via `agent()`, `parallel()` (barrier), `pipeline()`, and
`phase()`, with `isolation: 'worktree'`. Two related capabilities are **tool
inputs rather than script functions**: the token `budget` is a read-only object
a script reads but cannot set, and `resumeFromRunId` is a parameter passed when
invoking the tool.

## The capability

`claude-orchestration` is a **default-off, BETA, claude-only** capability that
adopts the Workflow tool as an optional, runtime-gated parallel-execution
backend, and folds the existing `gsd-ultraplan-phase` plan-offload under the same
gate. It is blocked-on-nothing now that the ADR-857 capability system is released.

- **`role: feature`**, `runtimeCompat.supported: ["claude"]`, `tier: full`.
- **`activationKey: claude_orchestration.enabled`** — default `false`. Nothing
  changes until you opt in.
- Registers at two **wired** loop points: `execute:wave:pre` (into the executor)
  and `plan:post` (into the planner). Both are `onError: skip` and gated by the
  `enabled` key. The dispatch-backend selector fires at `execute:wave:pre` — the
  seam that runs immediately BEFORE a wave's agents are dispatched — because a
  selector fired *after* a wave already dispatched inline (the original
  `execute:wave:post` placement, [#2285]) is structurally too late to change how
  dispatch happens.

## How it decides whether to activate

Detection is a pure, **fail-closed** function — `detectWorkflowBackend`. The
Workflow backend activates only when *every* gate passes; any miss degrades to
`inline` (today's behaviour):

1. `claude_orchestration.enabled` is true.
2. The runtime is Claude (the Workflow tool is Claude / Agent SDK-specific).
3. `claude_orchestration.execution_backend` is `auto` or `workflow` (not `inline`).
4. The host descriptor advertises `dispatch.nested` **and** `dispatch.background`
   (the nesting-capable Claude-Code shape — a proxy for Workflow-tool presence,
   meaningful only after gate 2).
5. The Agent SDK reports a valid semver version.
6. That version is `>= claude_orchestration.min_agent_sdk_version`
   (default `0.3.149`). A pre-release of the floor (e.g. `0.3.149-rc.1`) compares
   *below* the GA release per SemVer, so the preview backend stays off.

## What the executor runs when the backend is active

`emitWorkflowScript` maps the phase's wave/plan model onto Workflow primitives:

| GSD concept | Workflow primitive |
|---|---|
| Wave | `parallel()` stage barrier |
| Plan (`use_worktree` not `false`) | `agent(brief, { agentType: 'gsd-executor', isolation: 'worktree' })` |
| Plan (`use_worktree: false`) | `agent(brief, { agentType: 'gsd-executor' })` (no isolation) |
| `files_modified` overlap | forces the plans into separate sequential stages |
| Wave | a `phase("Wave <id>")` group, matching a `meta.phases` entry |
| Phase run id | `summary.resumeRunId` → pass as the Workflow tool's `resumeFromRunId` **input** |
| Phase token cap | recorded in `summary.budgetTokens`; `budget` is read-only in a script |

Because the emitted script composes the **same** `gsd-executor` agent the
inline path uses, with worktree isolation applied **per plan** from the
manifest's `use_worktree` field, it produces the same `SUMMARY.md` artifacts
and commits — the only difference is the execution vehicle. `use_worktree`
mirrors execute-phase.md step 2.5's per-plan submodule safety gate exactly: a
plan that touches a submodule path is never forced into worktree isolation,
whichever backend dispatches it ([#2772]).

## The fallback contract

On any runtime lacking the Workflow tool — or when the capability is disabled,
the SDK is too old, or detection fails for any reason — execute-phase proceeds
with the standard inline wave dispatch. This is a release gate, not a nicety: a
regression test asserts the inline fallback on every non-capable combination, so
the capability is default-off and low-risk by construction.

## BETA scope (v1)

The first slice ships **detection + emission + declarative ultraplan ownership**.
The emitter is exercised at the contract level (structure, overlap splitting,
resume, budget, anti-injection). End-to-end execution through the Workflow tool
is verifiable only inside Claude Code with the tool present. Full install-profile
migration of the `gsd-ultraplan-phase` skill into the capability's `skills[]`
array is a follow-up (it touches the cluster/profile machinery); for v1 the
manifest *declares* ultraplan ownership at `plan:post` and the existing skill's
own runtime gate continues to no-op on non-Claude runtimes.

[#853]: https://github.com/open-gsd/gsd-core/issues/853
[#1143]: https://github.com/open-gsd/gsd-core/issues/1143
[#2772]: https://github.com/open-gsd/gsd-core/issues/2772
[#2285]: https://github.com/open-gsd/gsd-core/issues/2285
