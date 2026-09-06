# How to configure model profiles

Choose the right model tier strategy for your project, then tune individual agents or entire phase types without writing a large override block. This guide starts with the simplest lever and works up to dynamic routing.

---

## The four profiles (plus `adaptive` and `inherit`)

Set `model_profile` in `.planning/config.json` or via `/gsd-config --profile <name>`:

| Profile | Planner | Executor | Researchers | Verifier | Use when |
|---------|---------|----------|-------------|----------|----------|
| `quality` | Opus | Opus | Opus | Sonnet | Production-quality work where cost is secondary |
| `balanced` | Opus | Sonnet | Sonnet | Sonnet | Normal development — the default |
| `budget` | Sonnet | Sonnet | Haiku | Haiku | Rapid prototyping, cost-sensitive contexts |
| `adaptive` | Opus | Sonnet | Sonnet | Sonnet | Resolves the same way as the other tiers under runtime-aware profiles; use when switching between runtimes frequently |
| `inherit` | (session model) | (session model) | (session model) | (session model) | Non-Anthropic providers (OpenRouter, local models) — all agents follow your current session model |

The table above shows a representative subset. All 33 shipped agents have explicit per-profile tier assignments in `gsd-core/bin/shared/model-catalog.json`. For the full table see [Model Profiles](../CONFIGURATION.md#model-profiles) in the configuration reference.

**Quick switch via command:**

```bash
/gsd-config --profile balanced   # Normal development
/gsd-config --profile budget     # Prototyping or high-cost phases
/gsd-config --profile quality    # Production release
/gsd-config --profile inherit    # OpenRouter, local models
```

**Or edit `.planning/config.json` directly:**

```json
{
  "model_profile": "balanced"
}
```

---

## Per-agent overrides (`model_overrides`)

If a single agent needs a different tier without changing the whole profile, use `model_overrides`:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-codebase-mapper": "haiku"
  }
}
```

Valid values: `opus`, `sonnet`, `haiku`, `inherit`, or any fully-qualified model ID (e.g. `"openai/o3"`, `"google/gemini-2.5-pro"`).

`model_overrides` can be set per-project in `.planning/config.json` or globally in `~/.gsd/defaults.json`. Per-project entries win on conflict; non-conflicting global entries are preserved.

**Important for Codex and OpenCode:** Those runtimes embed the model into each agent's static config at install time rather than choosing it per spawn, so after editing `model_overrides` you must re-run the installer for the change to take effect:

```bash
npx @opengsd/gsd-core@latest --codex --global   # or --opencode, --kilo, etc.
```

GSD will also warn you if you forget: workflow entry commands (`gsd init plan-phase`, `gsd init execute-phase`, etc.) detect when `.planning/config.json` or `~/.gsd/defaults.json` is newer than your installed agent files and print a one-line stderr reminder naming the changed file and the re-install command. The check is read-only and runs only on `codex` and `opencode`; Claude Code resolves models at spawn time and is unaffected. (#1688)

---

## Per-phase-type models (`models`)

If you want to say "Opus for planning, Sonnet for everything else" without learning all 33 agent names, use the `models` block. It maps six phase types to tier aliases:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning":      "opus",
    "discuss":       "opus",
    "research":      "sonnet",
    "execution":     "opus",
    "verification":  "sonnet",
    "completion":    "sonnet"
  }
}
```

Phase types and their agents:

| Phase type | Agents covered |
|---|---|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier`, `gsd-code-reviewer` |
| `discuss` | `gsd-assumptions-analyzer` |
| `completion` | Reserved — no subagent today; accepted by schema for forward compatibility |

The `models` block accepts tier aliases only (`opus`, `sonnet`, `haiku`, `inherit`). For a fully-qualified model ID, use `model_overrides` per agent instead.

**Combining `models` with a per-agent exception:**

```json
{
  "model_profile": "balanced",
  "models": {
    "research": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

All five research agents resolve to `sonnet` *except* `gsd-codebase-mapper`, which is pinned to `haiku`.

---

## Dynamic routing — start cheap, escalate on failure

If you want to pay for cheaper tiers by default and only escalate when an agent fails a quality gate, enable `dynamic_routing`:

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "light":    "haiku",
      "standard": "sonnet",
      "heavy":    "opus"
    },
    "escalate_on_failure": true,
    "max_escalations": 1
  }
}
```

Each agent has a default tier (`light`, `standard`, or `heavy`). On the first attempt, GSD picks `tier_models[default_tier]`. If the orchestrator detects a soft failure (verification inconclusive, plan-check flagged, etc.), it re-spawns the agent one tier up. `max_escalations` caps the total retries.

Agents that already sit at `heavy` cannot escalate further.

**Turning off escalation while keeping dynamic resolution:**

```json
{
  "dynamic_routing": {
    "enabled": true,
    "escalate_on_failure": false
  }
}
```

Every attempt uses `tier_models[default_tier]` regardless of outcome — useful when you want explicit tier-to-model mapping without the escalation behaviour.

`dynamic_routing` is **disabled by default**. Omitting the block or setting `enabled: false` preserves static resolution.

### Keep going when a provider throttles you

The tier ladder above escalates within one provider. When the provider itself is the thing
that ran out of quota, a heavier tier on the same account is still throttled. Add
`provider_escalation` — an ordered list of fallback model IDs — to keep the phase moving
instead of stopping for a manual restart:

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": { "light": "haiku", "standard": "sonnet", "heavy": "opus" },
    "provider_escalation": ["gpt-5", "nvidia/llama-3.3"],
    "max_escalations": 2
  }
}
```

When an executor dies on a rate limit, GSD classifies the error body, switches to the next
model in the list, logs the swap (`sonnet → gpt-5`), and waits out any `Retry-After` the
provider sent. The walk is capped at `min(max_escalations, provider_escalation.length)`.
Once the list is spent, GSD names every model it tried and hands you the normal recovery
prompt — it never silently retries the exhausted one.

This is most useful on providers without a guaranteed SLA (Nvidia NIM, OpenRouter, and
other third-party OpenCode models), where a throttle mid-phase is routine. It only fires on
quota / rate-limit failures; other failures keep the tier ladder. Leaving
`provider_escalation` unset preserves the manual wait-for-reset behaviour exactly.

---

## Using GSD on non-Anthropic runtimes

If you installed GSD for Codex, OpenCode, Antigravity CLI, or Kilo, the installer already set `resolve_model_ids: "omit"` in your config. This prevents unresolved Anthropic model IDs from leaking into those runtimes. When `runtime` is set, runtime-native profile resolution still supplies any model and effort that the runtime adapter can transport. No manual setup is needed for the basic case.

### Codex routes tiers at spawn time when supported

GSD deliberately writes no profile-resolved `model` line into
`~/.codex/agents/<agent>.toml` ([ADR-2313](../adr/2313-codex-passive-model-posture.md)).
Instead, each Codex skill inspects the visible `spawn_agent` schema. When that schema advertises
`model` and `reasoning_effort`, the skill passes the model and effort resolved from
`model_profile` — including `adaptive` — on that individual spawn. When either field is absent,
the skill omits that field and the child inherits the session or static agent configuration.

This keeps compatibility with older Codex schemas while allowing newer installations to route
`gsd-planner`, `gsd-executor`, and other roles to their configured tiers. The fields are detected
independently; support for typed `agent_type` dispatch does not imply support for either routing
field.

**To pin a model on Codex, name a real Codex model id per agent:**

```json
{
  "runtime": "codex",
  "model_overrides": {
    "gsd-planner":  "gpt-5.6-sol",
    "gsd-executor": "gpt-5.6-terra"
  }
}
```

Then re-run the installer to materialize the override in the agent TOML as a fallback for spawn
schemas that do not advertise inline `model` (see above).

Two rules apply to what you can put there:

- **It must be a real Codex model id.** A GSD tier alias (`opus`, `sonnet`, `haiku`, `fable`) or a
  `claude-*` id is dropped with a warning rather than written, because Codex rejects them.
- **Your account must actually expose it.** GSD cannot check this — if you pin `gpt-5.6-sol` on an
  account that does not have it, you get the same 400. When in doubt, omit the pin and let the
  session model apply.

`model_reasoning_effort` follows the model: with no pin, GSD writes no effort line either, so the
Codex UI drives both rather than one following GSD and the other following your session.

> **Upgrading from v1.10 or earlier?** Codex installs used to embed a per-tier model
> (`opus→gpt-5.6-sol`, `sonnet→gpt-5.6-terra`, `haiku→gpt-5.6-luna`). If you were on an API-key
> account where those resolved successfully, add the `model_overrides` block above to keep them.
> The installer prints a one-time notice when it drops a pin. If you were on a ChatGPT account, this
> is the change that stops the 400s — nothing to do.

### Allocating for execution-heavy workflows on Codex

Execution and verification account for most of the model calls in a long GSD run — planning happens
once per phase, execution happens per plan, and verification runs over everything produced. On
2026-07-30 OpenAI cut GPT-5.6 Luna API pricing by 80% and Terra by 20%, and reduced how many credits
both consume against Codex paid-plan quotas while leaving subscription prices and quota budgets
unchanged. Sol was unchanged. That makes the cheaper models materially cheaper for exactly the
high-volume half of a workflow.

GSD does not add a routing surface for this — the levers below already express it, and
[#2935](https://github.com/open-gsd/gsd-core/issues/2935) was closed as already-implemented on
precisely that basis. Keep Sol where the reasoning is worth the spend, and put the volume on Terra
or Luna:

```json
{
  "runtime": "codex",
  "model_overrides": {
    "gsd-planner":   "gpt-5.6-sol",
    "gsd-debugger":  "gpt-5.6-sol",
    "gsd-executor":  "gpt-5.6-terra",
    "gsd-verifier":  "gpt-5.6-luna"
  }
}
```

Prefer `models` when you want the split by *phase type* rather than by agent — it maps the six phase
types at once and every agent carries a `phaseType`, so it survives the roster changing under you:

```json
{
  "models": { "planning": "opus", "execution": "sonnet", "verification": "haiku" }
}
```

Two things worth knowing before you tune this:

- **Effort is a separate lever from model, and it is now per-model.** Dropping to Luna does not force
  you to drop effort — Luna advertises everything up to `max`. See
  [Configuration reference — effort](../CONFIGURATION.md#model-profiles) for the per-model table and
  which levels clamp.
- **These are cost/limit tradeoffs, not quality claims.** The 2026-07-30 change was a pricing and
  credit-accounting change; it did not alter model quality. Sol remains the strongest model for
  planning and hard debugging, which is why it stays there above.

**If you want per-agent model IDs on any non-Claude runtime:**

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner":   "o3",
    "gsd-executor":  "o4-mini",
    "gsd-debugger":  "o3"
  }
}
```

For the full runtime-aware profiles reference and the `model_policy` surface (provider-neutral presets added in v1.42), see [Configuration reference — Model Profiles](../CONFIGURATION.md#model-profiles).

---

## Resolution precedence (highest to lowest)

When multiple layers apply, the resolver picks the highest-priority entry:

```text
1. model_overrides[<agent>]           — per-agent; full IDs; targeted exception
2. dynamic_routing.tier_models[<tier>] — when enabled; escalates on soft failure
3. models[<phase_type>]               — coarse phase-level tier
4. model_profile (per-agent column)   — global tier strategy
5. Runtime default                    — when nothing else applies
```

---

## Choosing the right lever

| You want | Use |
|---|---|
| One tier strategy for all agents | `model_profile` |
| Coarse phase-level tuning ("Opus for planning") | `models.<phase_type>` |
| Per-agent precision ("force Haiku on the codebase mapper") | `model_overrides[<agent>]` |
| A fully-qualified model ID for a specific agent | `model_overrides[<agent>]: "openai/gpt-5"` |
| Start cheap, escalate only on failure | `dynamic_routing` |
| All agents follow the session model (non-Anthropic provider) | `model_profile: "inherit"` |

---

## Related

- [Configuration reference](../CONFIGURATION.md)
- [Multi-agent orchestration](../explanation/multi-agent-orchestration.md)
- [Commands reference](../COMMANDS.md)
- [Docs index](../README.md)
