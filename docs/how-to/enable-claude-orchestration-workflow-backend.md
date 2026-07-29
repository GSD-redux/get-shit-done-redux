# How to enable and use the Claude orchestration backend (BETA)

Run GSD's execute-phase waves through Claude Code's Workflow tool (`/effort ultracode`, Agent SDK ≥ v0.3.149) instead of the default one-agent-per-message dispatch, and fold the `gsd-ultraplan-phase` plan-offload under the same gate. On Claude Code this restores the wave parallelism that backgrounded-agent nesting (#853) otherwise forces inline.

> **BETA.** This capability tracks a Claude Code preview surface. It is default-off, fail-closed, and Claude-only. Every detection miss degrades silently to today's inline behaviour — enabling it can never break the loop. See the [explanation doc](../explanation/claude-orchestration-capability.md) for the why, and [ADR-1143](../adr/1143-claude-orchestration-capability.md) for the design.

**What you need:**
- GSD installed with the `full` profile (the capability is `tier: full`).
- **Claude Code** with the Workflow tool available (Agent SDK ≥ `0.3.149`). On any other runtime the capability is an explicit no-op — you can flip the switch safely, nothing happens.
- A GSD project with at least one planned phase (you need a wave/plan manifest to emit a script for).

---

## Step 1 — Enable the capability

The capability ships disabled. Turn on the master switch inside your GSD project:

```bash
gsd-tools query config-set claude_orchestration.enabled true
```

That single key gates everything — both the Workflow-backend hook at `execute:wave:post` and the ultraplan ownership declaration at `plan:post`. All other `claude_orchestration.*` keys are optional refinements.

Verify it took:

```bash
gsd-tools query config-get claude_orchestration.enabled
# → true
```

---

## Step 2 — Check whether your runtime qualifies

Detection is fail-closed: the Workflow backend activates only when **every** gate opens. Before relying on it, confirm your runtime reports as capable:

```bash
gsd-tools claude-orchestration detect-backend \
  --runtime claude \
  --agent-sdk-version 1.2.0
```

You will get one of two results:

| `backend` | `available` | Meaning |
|-----------|-------------|---------|
| `workflow` | `true` | Every gate passed — the emitter will produce a Workflow script the orchestrator can run. |
| `inline` | `false` | A gate failed. The `reason` field tells you which: `capability_disabled`, `runtime_not_claude`, `backend_inline`, `workflow_tool_unavailable`, `agent_sdk_version_unknown`, or `agent_sdk_version_below_floor`. |

> **The CLI is a simulation harness, not a probe.** `detect-backend` assumes a capable host descriptor unless you pass `--no-nested-dispatch`. It exists so you (and the orchestrator) can ask "given these facts, would the backend activate?" The real detection the loop uses is the pure `detectWorkflowBackend` function, called with the live host descriptor.

### If detection returns `inline`

Work through the `reason`:

- **`runtime_not_claude`** — you are on Codex / Cursor / opencode / etc. The Workflow tool is Claude-specific; there is nothing to enable here. Your loop is unchanged.
- **`agent_sdk_version_below_floor`** — upgrade Claude Code / the Agent SDK to at least `claude_orchestration.min_agent_sdk_version` (default `0.3.149`). A pre-release of the floor (e.g. `0.3.149-rc.1`) compares *below* the GA release and will not activate.
- **`workflow_tool_unavailable`** — your host descriptor does not advertise nested + background dispatch. This is unusual on Claude Code; if you see it, the Workflow tool is not present in this session.
- **`agent_sdk_version_unknown`** — the version could not be determined. Supply it explicitly via `--agent-sdk-version`.

### Pin a higher floor (optional)

If you want to gate the BETA behind a newer Agent SDK than the default:

```bash
gsd-tools query config-set claude_orchestration.min_agent_sdk_version 1.0.0
```

---

## Step 3 — Choose the execution backend

`claude_orchestration.execution_backend` controls how aggressively the backend is used once detection passes:

| Value | Behaviour |
|-------|-----------|
| `auto` (default) | Use the Workflow backend **if** detection passes; otherwise inline. The safe, recommended value. |
| `workflow` | Force the Workflow backend when the tool is present (still fails closed to inline if the tool is absent or the SDK is too old — the floor applies in both modes). |
| `inline` | Force today's manual one-agent-per-message dispatch, even on a capable Claude Code runtime. Use this to A/B compare or to temporarily retire the BETA. |

Switch with:

```bash
gsd-tools query config-set claude_orchestration.execution_backend workflow
```

---

## Step 4 — Emit a Workflow script for a phase

With the capability enabled and detection passing, generate the Workflow script for a phase's wave/plan manifest. The manifest is the wave/plan model execute-phase already builds:

```json
{
  "waves": [
    {
      "id": "w1",
      "plans": [
        { "id": "p1", "brief": "Implement the foo module", "files_modified": ["src/foo.cts"] },
        { "id": "p2", "brief": "Wire the bar seam", "files_modified": ["src/bar.cts"] }
      ]
    }
  ]
}
```

Emit the script:

```bash
gsd-tools claude-orchestration emit-workflow \
  --waves .planning/phases/01-foo/waves.json \
  --run-id phase-01-foo \
  --phase-dir .planning/phases/01-foo \
  --budget 500000
```

The output is a generated Workflow script that maps GSD's model 1:1 onto Workflow primitives:

- an `export const meta = { name, description, phases }` block as the **first statement** (the Workflow tool rejects any script without it),
- **waves → a `phase("Wave <id>")` group and a sequential `await parallel([...])` barrier** (split into separate stages within a wave when `files_modified` overlap),
- **plans → `() => agent(brief, { agentType: "gsd-executor", isolation: "worktree" })`** — the **same** executor agent and worktree isolation the inline path uses, each wrapped in a thunk because `parallel()` takes an **array of functions**,
- the phase run id in **`summary.resumeRunId`**, and the intended token pool in **`summary.budgetTokens`**.

`resumeFromRunId` and `budget` are **not** emitted as calls (#2590). `resumeFromRunId` is a Workflow **tool input**, and `budget` is a read-only object (`{ total, spent(), remaining() }`) fed by the caller's token directive — calling either from a script throws and the whole script is rejected.

Because the script composes the same `gsd-executor` agent + worktree isolation + `SUMMARY.md` artifact as the inline path, the artifacts and commits it produces are identical — only the execution vehicle differs.

### Run the emitted script

Feed the emitted script to Claude Code's Workflow tool (`/effort ultracode`, or an Agent SDK `Workflow` invocation), **passing `summary.resumeRunId` as the tool's `resumeFromRunId` input**. The orchestrator runs it; each `agent()` call spawns a `gsd-executor` in its own worktree, and waves barrier between each other. Omitting that input silently regresses phase-resume to a no-op — an interrupted phase re-runs completed plans.

---

## Step 5 — Ultraplan plan-offload

Enabling the capability also folds `gsd-ultraplan-phase` under the same runtime gate. When the capability is on, the planner may offer the `/gsd-ultraplan-phase` path (offload plan-phase to Claude Code's ultraplan cloud) as an alternative to local `/gsd-plan-phase`. This is advisory — the stable local planner remains the default.

If the capability is off, or the runtime is not Claude Code, ultraplan offload is not surfaced and `/gsd-plan-phase` runs as normal.

---

## Disabling

To turn the capability off and return to byte-identical inline behaviour:

```bash
gsd-tools query config-set claude_orchestration.enabled false
```

Or force inline dispatch while leaving the capability otherwise on:

```bash
gsd-tools query config-set claude_orchestration.execution_backend inline
```

Either step is sufficient — no uninstall or resurface needed. The federated config keys live only in the capability registry, so they vanish cleanly if the capability is ever removed.

---

## What is and is not wired in BETA v1

**Working today:**
- Detection (`detectWorkflowBackend` / `gsd-tools claude-orchestration detect-backend`) — fail-closed, tested across every gate.
- Emission (`emitWorkflowScript` / `gsd-tools claude-orchestration emit-workflow`) — waves→barriers, overlap→stages, resume, budget, anti-injection.
- The contribution fragments at `execute:wave:post` and `plan:post` (gated, `onError: skip`).
- Inline fallback on every non-capable combination (regression-tested).

**Not yet wired (follow-ups):**
- `execute-phase.md` does not yet auto-branch to emit-and-run the Workflow script. Today you emit the script explicitly (Step 4) and run it via the Workflow tool. Automatic dispatch inside the loop is the next milestone.
- The plan-checker and verifier still run inline — this capability delivers the parallel-execution backend, not those gates.
- Full install-profile migration of the `gsd-ultraplan-phase` skill into the capability's `skills[]` (it is currently declared in the manifest; the skill's own runtime gate continues to no-op on non-Claude runtimes).

If a preview-API change breaks detection, the capability degrades to inline; it cannot destabilise the core loop.
