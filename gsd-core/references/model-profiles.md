# Model Profiles

Model profiles control which Claude model each GSD agent uses. This allows balancing quality vs token spend, or inheriting the currently selected session model.

## Profile Definitions

| Agent | `quality` | `balanced` | `budget` | `adaptive` | `inherit` |
|-------|-----------|------------|----------|------------|-----------|
| gsd-planner | opus | opus | sonnet | opus | inherit |
| gsd-roadmapper | opus | sonnet | sonnet | sonnet | inherit |
| gsd-executor | opus | sonnet | sonnet | sonnet | inherit |
| gsd-phase-researcher | opus | sonnet | haiku | sonnet | inherit |
| gsd-project-researcher | opus | sonnet | haiku | sonnet | inherit |
| gsd-research-synthesizer | sonnet | sonnet | haiku | haiku | inherit |
| gsd-debugger | opus | sonnet | sonnet | opus | inherit |
| gsd-codebase-mapper | sonnet | haiku | haiku | haiku | inherit |
| gsd-verifier | sonnet | sonnet | haiku | sonnet | inherit |
| gsd-plan-checker | sonnet | sonnet | haiku | haiku | inherit |
| gsd-integration-checker | sonnet | sonnet | haiku | haiku | inherit |
| gsd-nyquist-auditor | sonnet | sonnet | haiku | haiku | inherit |

## Per-Phase-Type Model Map (#3023)

`.planning/config.json` accepts a coarse per-**phase-type** map under the `models` key. Use this when you want tuning at the phase level ("Opus for planning and execution, Sonnet for the rest") without learning the agent taxonomy.

```json
{
  "model_profile": "balanced",
  "models": {
    "planning": "opus",
    "discuss": "opus",
    "research": "sonnet",
    "execution": "opus",
    "verification": "sonnet",
    "completion": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

### Phase-type → agent mapping

| Phase type | Agents |
|---|---|
| `planning` | gsd-planner, gsd-roadmapper, gsd-pattern-mapper |
| `discuss` | `gsd-assumptions-analyzer` |
| `research` | gsd-phase-researcher, gsd-project-researcher, gsd-research-synthesizer, gsd-codebase-mapper, gsd-ui-researcher |
| `execution` | gsd-executor, gsd-debugger, gsd-doc-writer |
| `verification` | gsd-verifier, gsd-plan-checker, gsd-integration-checker, gsd-nyquist-auditor, gsd-ui-checker, gsd-ui-auditor, gsd-doc-verifier, gsd-code-reviewer |
| `completion` | (reserved — no subagent today) |

### Resolution precedence (highest to lowest)

1. **Per-agent `model_overrides[agent]`** — full IDs accepted; targeted exceptions
2. **Phase-type `models[phase_type]`** — tier alias only (`opus` / `sonnet` / `haiku` / `inherit`)
3. **Profile table** — the per-agent column from the active `model_profile`
4. **Runtime default** — when nothing else applies

### Why two layers above the profile?

- **Profile** is a global tier strategy (everyone runs balanced).
- **`models`** is coarse phase-level tuning without learning agent names.
- **`model_overrides`** is per-agent precision (e.g. force `haiku` on `gsd-codebase-mapper` for a fan-out).

The three layers compose: `models` defaults a phase, `model_overrides` carves an exception out of it.

## Profile Philosophy

**quality** - Maximum reasoning power
- Opus for all decision-making agents
- Sonnet for read-only verification
- Use when: quota available, critical architecture work

**balanced** (default) - Smart allocation
- Opus only for planning (where architecture decisions happen)
- Sonnet for execution and research (follows explicit instructions)
- Sonnet for verification (needs reasoning, not just pattern matching)
- Use when: normal development, good balance of quality and cost

**budget** - Minimal Opus usage
- Sonnet for anything that writes code
- Haiku for research and verification
- Use when: conserving quota, high-volume work, less critical phases

**adaptive** — Role-based cost optimization
- Opus for planning and debugging (where reasoning quality has highest impact)
- Sonnet for execution, research, and verification (follows explicit instructions)
- Haiku for mapping, checking, and auditing (high volume, structured output)
- Use when: optimizing cost without sacrificing plan quality, solo development on paid API tiers

**inherit** - Follow the current session model
- All agents resolve to `inherit`
- Best when you switch models interactively (for example OpenCode or Kilo `/model`)
- **Required when using non-Anthropic providers** (OpenRouter, local models, etc.) — otherwise GSD may call Anthropic models directly, incurring unexpected costs
- Use when: you want GSD to follow your currently selected runtime model

## Using Non-Claude Runtimes (Codex, OpenCode, Gemini CLI, Kilo)

When installed for a non-Claude runtime, the GSD installer sets `resolve_model_ids: "omit"` in `~/.gsd/defaults.json`. This returns an empty model parameter for all agents, so each agent uses the runtime's default model. No manual setup is needed.

To assign different models to different agents, add `model_overrides` with model IDs your runtime recognizes:

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3",
    "gsd-codebase-mapper": "o4-mini"
  }
}
```

The same tiering logic applies: stronger models for planning and debugging, cheaper models for execution and mapping.

## Using Claude Code with Non-Anthropic Providers (OpenRouter, Local)

If you're using Claude Code with OpenRouter, a local model, or any non-Anthropic provider, set the `inherit` profile to prevent GSD from calling Anthropic models for subagents:

```bash
# Via settings command
/gsd:settings
# → Select "Inherit" for model profile

# Or manually in .planning/config.json
{
  "model_profile": "inherit"
}
```

Without `inherit`, GSD's default `balanced` profile spawns specific Anthropic models (`opus`, `sonnet`, `haiku`) for each agent type, which can result in additional API costs through your non-Anthropic provider.

## Advisor Tool (Claude Code)

Claude Code (v2.1.98+) can pair the session's executor model with a stronger **advisor** model that it consults mid-generation for strategy and course-correction (Anthropic's [advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)). This is a host-runtime feature, not a GSD setting — GSD selects each agent's *executor* model through the profile/tier system above; Claude Code supplies the advisor.

Set it once at the session level with `/advisor <model>` (or the `advisorModel` setting / `--advisor` flag). **Subagents inherit the session advisor automatically**, so every GSD subagent an orchestrator spawns gets the same advisor with no per-agent configuration. It composes cleanly with GSD's tiering: the profile keeps executors cheap where the work is mechanical, and the advisor adds a stronger reviewer inline on the turns that benefit.

### Candidate pairings

Per Anthropic's advisor-tool docs the advisor must be at least as capable as the executor. Candidate pairings by profile — evaluate on your own workload; the quality/cost characterizations below are Anthropic-reported, not GSD guarantees:

| Profile | Typical executors | Candidate advisor | Rationale (per Anthropic docs) |
|---|---|---|---|
| `budget` | Haiku / Sonnet | Fable 5 or Opus | A step up in intelligence over Haiku alone, at lower cost than switching the executor to a larger model |
| `balanced` | Sonnet | Fable 5 or Opus | A quality lift at similar or lower total cost than Sonnet-solo on complex tasks |
| `quality` / `adaptive` | Opus (planning), Sonnet | Fable 5 or Opus | Marginal on turns already at top capability; most valuable on the Sonnet-executor agents |

Fable 5 is a valid advisor for Haiku 4.5, Sonnet 4.6/5, and Opus 4.8 executors, so it pairs with any tier a profile assigns.

### When it's worth enabling

- **Worth it:** long, multi-step agent loops where the plan matters but most turns are mechanical — e.g. `execute-phase` and `debug`. Anthropic's docs note advisor prompt-caching pays off at roughly three or more advisor calls, which these long loops make.
- **Skip it:** short, one-shot agents (mappers, quick audits, single-file checks) — there is little to plan, and the advisor adds cost without a commensurate quality gain.

### Constraint: session-level only (today)

The advisor is a single session-wide setting inherited by all subagents; there is **no per-agent advisor selection**, so GSD cannot vary the advisor by role the way it varies the executor model (e.g. "no advisor on the Haiku mapper, a Fable 5 advisor on the Sonnet executor"). Per-agent advisor control is tracked upstream at [anthropics/claude-code#73072](https://github.com/anthropics/claude-code/issues/73072); until it lands, pick one session advisor that fits the most valuable agents in your run.

## Dynamic Routing with Failure-Tier Escalation (#3024)

When `dynamic_routing.enabled = true` in `.planning/config.json`, the resolver picks a model from a tier-mapped table based on the agent's *default tier* (light / standard / heavy) and escalates to the next tier up on orchestrator-detected soft failure.

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

**Agent default tiers** (each agent in `MODEL_PROFILES` declares one):

| Tier | Agents | Use case |
|---|---|---|
| `light` | gsd-codebase-mapper, gsd-pattern-mapper, gsd-research-synthesizer, gsd-plan-checker, gsd-integration-checker, gsd-nyquist-auditor, gsd-ui-checker, gsd-ui-auditor, gsd-doc-verifier | Cheap/fast — pure mappers, scanners, low-stakes audits |
| `standard` | gsd-executor, gsd-phase-researcher, gsd-project-researcher, gsd-verifier, gsd-doc-writer, gsd-ui-researcher | Default workhorse — research, writing, primary verification |
| `heavy` | gsd-planner, gsd-roadmapper, gsd-debugger | Deep reasoning — already at top, can't escalate further |

**Escalation flow** (orchestrator-driven):

1. Orchestrator spawns agent with `attempt: 0` → resolver returns `tier_models[default_tier]`
2. If orchestrator marks the result a soft failure, it re-spawns with `attempt: 1` → resolver returns `tier_models[next_tier_up]`
3. `max_escalations` caps total retries (default 1). Beyond the cap the resolver returns the cap-tier model so the orchestrator can log without burning further budget.
4. Hard failures (exceptions) bypass escalation and surface immediately.

**Precedence with other tier sources** (highest → lowest):

1. `model_overrides[<agent>]` — full ID, always wins
2. `dynamic_routing.tier_models[escalated_tier]` — when `enabled: true`
3. `models[<phase_type>]` — coarse phase-level (#3023)
4. `model_profile` — global tier strategy

When `dynamic_routing.enabled = false` (default), behavior is identical to today.

## Resolution Logic

Orchestrators resolve model before spawning. The full precedence ladder
is (highest → lowest):

```text
1. Read .planning/config.json
2. Check model_overrides[<agent>] (full IDs accepted; targeted exceptions)
3. If dynamic_routing.enabled, return tier_models[escalated_tier]
   (see §Dynamic Routing — escalation steps tier up per attempt counter)
4. If no dynamic_routing match, check models[phase_type] for a phase-type tier
   (see §Per-Phase-Type Model Map for the agent → phase-type mapping)
5. If no phase-type slot, look up agent in profile table
6. Pass model parameter to Task call
```

`model` and `effort` resolve through different mechanisms at different
times — they do not share the ladder above. `model` resolves at runtime,
per spawn, from `.planning/config.json`; a config change takes effect on
the next spawn. `effort` (claude runtime) has its own cascade
(`agent_overrides` → `routing_tier_defaults` → `default`; see
`docs/CONFIGURATION.md` § "Where effort actually reaches") and is baked at
install time into the `effort:` frontmatter key of
`~/.claude/agents/gsd-*.md` — Claude Code's Agent tool has no per-spawn
effort parameter, so per-agent frontmatter is the only channel. An effort
config change has no effect until `gsd_run effort sync --apply`
re-syncs the agent files. Codex agents instead pin
`model_reasoning_effort` in `~/.codex/agents/*.toml` at install time.

## Per-Agent Overrides

Override specific agents without changing the entire profile:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-planner": "haiku"
  }
}
```

Overrides take precedence over the profile. Valid values: `opus`, `sonnet`, `haiku`, `inherit`, or any fully-qualified model ID (e.g., `"o3"`, `"openai/o3"`, `"google/gemini-2.5-pro"`).

## Switching Profiles

Runtime: `/gsd-set-profile <profile>`

Per-project default: Set in `.planning/config.json`:
```json
{
  "model_profile": "balanced"
}
```

## Design Rationale

**Why Opus for gsd-planner?**
Planning involves architecture decisions, goal decomposition, and task design. This is where model quality has the highest impact.

**Why Sonnet for gsd-executor?**
Executors follow explicit PLAN.md instructions. The plan already contains the reasoning; execution is implementation.

**Why Sonnet (not Haiku) for verifiers in balanced?**
Verification requires goal-backward reasoning - checking if code *delivers* what the phase promised, not just pattern matching. Sonnet handles this well; Haiku may miss subtle gaps.

**Why Haiku for gsd-codebase-mapper?**
Read-only exploration and pattern extraction. No reasoning required, just structured output from file contents.

**Why `inherit` instead of passing `opus` directly?**
Claude Code's `"opus"` alias maps to a specific model version. Organizations may block older opus versions while allowing newer ones. GSD returns `"inherit"` for opus-tier agents, causing them to use whatever opus version the user has configured in their session. This avoids version conflicts and silent fallbacks to Sonnet.

**Why `inherit` profile?**
Some runtimes (including OpenCode) let users switch models at runtime (`/model`). The `inherit` profile keeps all GSD subagents aligned to that live selection.
