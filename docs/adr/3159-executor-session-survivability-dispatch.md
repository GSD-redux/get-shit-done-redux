# ADR-3159: Executor Session Survivability Dispatch [Accepted]

- **Status:** Accepted
- **Date:** 2026-08-29
- **Issue:** [#3159](https://github.com/open-gsd/gsd-core/issues/3159)
- **Relates to:** [#3158](https://github.com/open-gsd/gsd-core/issues/3158)

## Context

GSD's canonical `execute-phase` workflow dispatches `gsd-executor` subagents concurrently in the background by default (`run_in_background: true`). This model assumes the parent orchestrator session survives across the turn boundary to collect subagent results.

However, certain external wrapper hosts, containerized harnesses, or one-shot CLI integrations terminate the parent session when the active turn completes. On these hosts, background subagents are orphaned or aborted when the parent environment is torn down.

A critical distinction must be drawn between **agent-tool availability** and **parent-session survivability**:
- A runtime environment may fully support subagent creation primitives (e.g. `Agent()` tool calls or headless CLI spawning).
- Yet that same host environment may not support long-lived asynchronous background processes that outlive the calling turn.

Inferring this host lifecycle property from the runtime name (e.g., matching a specific host string) violates GSD's capability-based architecture and fails to account for varied host wrapper configurations.

## Decision

Introduce an explicit, default-preserving configuration key and literal dispatch branches for executor agents:

### 1. Public Configuration Key (D-01)

Add `workflow.session_outlives_turn` as a centrally registered boolean configuration key:
- **Default:** `true`. When absent or explicitly `true`, GSD preserves the standard asynchronous background dispatch across all supported executor backends.
- **Opt-out:** `false`. When explicitly set to `false`, GSD switches to a foreground, synchronous execution path.
- Non-boolean values passed via `gsd config-set` are rejected. The registered absent-key default resolves to `true`; malformed or unavailable workflow reads instead fail closed to foreground (`false`) so an unavailable configuration source cannot orphan an executor on a one-shot host.

### 2. Literal Foreground Dispatch with Awaiting (D-02)

When `workflow.session_outlives_turn` is `false`:
- **Harness Agent backend (`session-survivability-dispatch.md`):** Dispatches `gsd-executor` with an explicit, literal `run_in_background: false` instruction; the tool call returns synchronously before the next plan executor is dispatched. Subagents are retained; execution is not forced inline into the orchestrator prompt.
- **Orchestrator-worktree process backend (`executor-isolation-dispatch.md`):** Spawns the executor child process synchronously in the foreground and waits for completion before proceeding, while preserving worktree ownership, wave merging, and cleanup contracts.
- **No-isolation sequential backend:** Uses the same foreground/awaited executor mode when worktrees are disabled or a plan must use the main working tree.
- **Phase verifier dispatch (`verify_phase_goal`):** Threads `run_in_background: false` so that the final verification subagent of the phase is awaited in the foreground before the turn ends.
- Both true and false branches are expressed as distinct literal instructions in workflow fragments rather than relying on placeholder interpolation or omitted flags.

### 3. Scope Fence (D-03)

This configuration governs **`execute-phase` dispatches** (executors and phase verifier):
- Standalone workflows outside `execute-phase` (`map-codebase`, `docs-update`, `plan-phase`, `manager`, `debug`) are not governed by this flag.
- Git worktree isolation and ownership selection (`workflow.use_worktrees`) remain unchanged.
- Tool availability, capability descriptors, and runtime identity resolution remain unchanged.

## Excluded Alternatives

- **Runtime-Name Branching:** Branching on specific host names (e.g., `RUNTIME === 'codex'`) was rejected because host wrappers and one-shot configurations vary independently of the underlying engine.
- **Inline Execution:** Forcing inline execution instead of subagent invocation was rejected because it causes excessive context exhaustion and drops subagent role specialization.
- **Leaving Verifier Dispatch Untouched:** Omitting verifier dispatch from session survivability was rejected because default harness dispatch backgrounds `Agent()` calls, which would orphan the verifier at the end of the phase on one-shot hosts.

## Consequences & Verification Limits

- **Consequences:** Integrators on one-shot wrapper hosts can safely execute GSD phases sequentially by configuring `workflow.session_outlives_turn: false` without forfeiting subagent isolation or breaking defaults for long-running hosts. Setting `session_outlives_turn: false` runs multi-plan waves sequentially in the foreground and awaits the verifier in the foreground; wall-clock execution scales with total plan count rather than wave parallelization. Combining `session_outlives_turn: false` with `workflow.use_worktrees: true` uses an isolated worktree sequentially for each plan. Post-wave validation gates, merges, and cleanup continue to execute at the wave boundary.
- **Verification Limits:** Automated unit, workflow-product, and runtime-converter tests verify that configuration and canonical instructions emit the correct literal branches and parameter guidance for executor and verifier dispatches. They do **not** simulate live process termination of arbitrary external wrapper hosts, which remains a host integration concern.
