# GSD Configuration Reference

Complete schema reference for `.planning/config.json`. For setup walkthroughs and task-oriented guides see the [docs index](README.md).

> Full configuration schema, workflow toggles, model profiles, and git branching options. For feature context, see [Feature Reference](FEATURES.md).

---

## Configuration File

GSD stores project settings in `.planning/config.json`. Created during `/gsd-new-project`, updated via `/gsd-settings`.

### Full Schema

```json
{
  "mode": "interactive",
  "granularity": "standard",
  "model_profile": "balanced",
  "model_overrides": {},
  "models": {},
  "dynamic_routing": null,
  "planning": {
    "commit_docs": true,
    "search_gitignored": false,
    "sub_repos": []
  },
  "context": null,
  "workflow": {
    "research": true,
    "plan_check": true,
    "verifier": true,
    "auto_advance": false,
    "nyquist_validation": true,
    "ui_phase": true,
    "ui_safety_gate": true,
    "ui_review": true,
    "node_repair": true,
    "node_repair_budget": 2,
    "research_before_questions": false,
    "discuss_mode": "discuss",
    "max_discuss_passes": 3,
    "skip_discuss": false,
    "human_verify_mode": "end-of-phase",
    "tdd_mode": false,
    "text_mode": false,
    "use_worktrees": true,
    "code_review": true,
    "code_review_depth": "standard",
    "plan_bounce": false,
    "plan_bounce_script": null,
    "plan_bounce_passes": 2,
    "plan_chunked": false,
    "code_review_command": null,
    "cross_ai_execution": false,
    "cross_ai_command": null,
    "cross_ai_timeout": 300,
    "test_gate_timeout": 600,
    "security_enforcement": true,
    "security_asvs_level": 1,
    "security_block_on": "high",
    "post_planning_gaps": true,
    "build_command": null,
    "test_command": null
  },
  "code_quality": {
    "fallow": {
      "enabled": false,
      "scope": "phase",
      "profile": "standard",
      "mcp": false
    }
  },
  "ship": {
    "pr_body_sections": []
  },
  "hooks": {
    "context_warnings": true,
    "workflow_guard": false
  },
  "statusline": {
    "context_position": "end"
  },
  "review": {
    "default_reviewers": null,
    "reviewer_instances": {},
    "models": {}
  },
  "parallelization": {
    "enabled": true,
    "plan_level": true,
    "task_level": false,
    "skip_checkpoints": true,
    "max_concurrent_agents": 3,
    "min_plans_for_parallel": 2
  },
  "git": {
    "branching_strategy": "none",
    "create_tag": true,
    "phase_branch_template": "gsd/phase-{phase}-{slug}",
    "milestone_branch_template": "gsd/{milestone}-{slug}",
    "quick_branch_template": null
  },
  "gates": {
    "confirm_project": true,
    "confirm_phases": true,
    "confirm_roadmap": true,
    "confirm_breakdown": true,
    "confirm_plan": true,
    "execute_next_plan": true,
    "issues_review": true,
    "confirm_transition": true
  },
  "safety": {
    "always_confirm_destructive": true,
    "always_confirm_external_services": true
  },
  "security": {
    "injection_blocking": false
  },
  "project_code": null,
  "agent_skills": {},
  "agent_skills_security": {
    "trusted_global_roots": []
  },
  "response_language": null,
  "features": {
    "thinking_partner": false,
    "global_learnings": false
  },
  "learnings": {
    "max_inject": 10
  },
  "intel": {
    "enabled": false
  },
  "claude_md_path": "./.claude/CLAUDE.md"
}
```

---

## When your config file cannot be read

GSD distinguishes a config file that is **absent** from one that is **present but unusable**. The
two used to be indistinguishable: a single trailing comma in `.planning/config.json` silently
replaced your entire configuration with built-in defaults, and nothing said so (#1880).

| Situation | What GSD does | Diagnostic |
|---|---|---|
| No `.planning/config.json` | Uses built-in defaults. This is normal. | none |
| File present, valid, has settings | Uses your settings. | none |
| File present, valid, but empty (`{}`) | Uses built-in defaults. | none |
| **File present but not valid JSON** | Uses built-in defaults — **your settings are not applied** | `warning: <path> is not valid JSON — its settings were NOT applied` |
| **File present but unreadable** (e.g. permissions) | Uses built-in defaults — **your settings are not applied** | `warning: <path> could not be read (EACCES) — its settings were NOT applied` |

The warning is printed once per file per run, so a repeated command will not spam it.

The same applies to the global `~/.gsd/defaults.json`. If the project config is also unusable, the
project one is reported, since that is the file you are most likely able to fix.

**If you see this warning:** your config was not applied. Validate the file, for example with
`node -e "JSON.parse(require('fs').readFileSync('.planning/config.json','utf8'))"`, then re-run.

## Core Settings

| Setting | Type | Options | Default | Description |
|---------|------|---------|---------|-------------|
| `mode` | enum | `interactive`, `yolo` | `interactive` | `yolo` auto-approves decisions; `interactive` confirms at each step |
| `granularity` | enum | `coarse`, `standard`, `fine` | `standard` | Controls phase count: `coarse` (2-4), `standard` (4-6), `fine` (6-10) |
| `model_profile` | enum | `quality`, `balanced`, `budget`, `adaptive`, `inherit` | `balanced` | Model tier for each agent (see [Model Profiles](#model-profiles)). `adaptive` was added per [#1713](https://github.com/open-gsd/gsd-core/issues/1713) / [#1806](https://github.com/open-gsd/gsd-core/issues/1806) and resolves the same way as the other tiers under runtime-aware profiles. |
| `runtime` | string | `claude`, `codex`, or any string | (none) | Active runtime for [runtime-aware profile resolution](#runtime-aware-profiles-2517). When set, profile tiers (opus/sonnet/haiku) resolve to runtime-native model IDs. The resolved ID is embedded into each agent's static frontmatter at install time on `codex` and `opencode` (whose `task` / `spawn_agent` interfaces do not accept an inline `model` parameter, so editing `model_overrides` requires re-running `gsd install <runtime>` to take effect — see [Per-Agent Overrides](#per-agent-overrides)); other runtimes consume the resolver at spawn time. When unset (default), behavior is unchanged from prior versions. Added in v1.39 |
| `model_profile_overrides.<runtime>.<tier>` | string \| object | per-runtime tier override | (none) | Override the runtime-aware tier mapping for a specific `(runtime, tier)`. Tier is one of `opus`, `sonnet`, `haiku`. Value is either a model ID string (e.g. `"gpt-5-pro"`) or `{ model, reasoning_effort }`. See [Runtime-Aware Profiles](#runtime-aware-profiles-2517). Added in v1.39 |
| `model_policy.provider` | string | `openai`, `anthropic`, `anthropic-fable`, `google`, `qwen`, `generic` | (none) | Declares the model provider. Known providers (`openai`, `anthropic`, `anthropic-fable`, `google`, `qwen`) unlock catalog-backed presets. `generic` treats all model IDs as opaque strings — no prefix inference, no reasoning-effort defaults. `model_policy.runtime_tiers` resolves before legacy `model_profile_overrides`. See [Model Policy Presets](#model-policy-presets-model_policy--added-in-v142). Added in v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.budget` | enum | `high`, `medium`, `low` | (none) | Selects a budget tier when using a known provider. GSD materializes the matching catalog preset into explicit tier mappings at resolve time. Ignored when `provider` is `generic` or `custom`. Added in v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.high` | string | model ID | (none) | High-cost tier model ID for `generic`/`custom` provider. Used when `provider: "generic"` or `"custom"`. Added in v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.medium` | string | model ID | (none) | Medium-cost tier model ID for `generic`/`custom` provider. Added in v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.low` | string | model ID | (none) | Low-cost tier model ID for `generic`/`custom` provider. Added in v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.runtime_tiers.<runtime>.<tier>` | object | `{ model, reasoning_effort? }` | (none) | Explicit per-runtime, per-tier model entry. `tier` is one of `opus`, `sonnet`, `haiku` (matching the existing profile tier names). `reasoning_effort` is forwarded only to runtimes that support it; unsupported runtimes never receive the field. Takes precedence over `model_profile_overrides`. Added in v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `models.<phase_type>` | enum | `opus`, `sonnet`, `haiku`, `inherit` | (none) | Per-phase-type model tier. Six accepted slots: `planning`, `discuss`, `research`, `execution`, `verification`, `completion`. Lets you tune at the phase level ("Opus for planning, Sonnet for the rest") without learning agent names. Resolves between `model_overrides` (higher) and `model_profile` (lower); see [Per-Phase-Type Models](#per-phase-type-models-models--added-in-v140). Added in v1.40 ([#3023](https://github.com/open-gsd/gsd-core/pull/3030)) |
| `granularities.<phase_type>` | enum | `coarse`, `standard`, `fine` | (none) | Per-phase-type granularity override. Six accepted slots: `planning`, `discuss`, `research`, `execution`, `verification`, `completion`. Lets you tune phase count at the phase level without changing the global `granularity`. Precedence: `granularities[phaseType]` (highest, enum-guarded) → `granularity` (global) → `planning.granularity` → `'standard'` (hard default). Added in v1.43 ([#68](https://github.com/open-gsd/gsd-core/issues/68)) |
| `dynamic_routing.enabled` | boolean | `true`, `false` | `false` | Master switch for [dynamic routing with failure-tier escalation](#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140). When `true`, agents resolve to `tier_models[default_tier]` and escalate one tier up on orchestrator-detected soft failure. Added in v1.40 ([#3024](https://github.com/open-gsd/gsd-core/pull/3031)) |
| `dynamic_routing.tier_models.<tier>` | enum | `opus`, `sonnet`, `haiku` | (none) | Tier alias for `light`, `standard`, or `heavy`. Used when `dynamic_routing.enabled: true`. Added in v1.40 |
| `dynamic_routing.escalate_on_failure` | boolean | `true`, `false` | `true` | When `false`, escalation is disabled even if `enabled: true` — every attempt uses the default tier. Added in v1.40 |
| `dynamic_routing.max_escalations` | integer | `0`, `1`, `2`, … | `1` | Hard cap on retries per agent invocation. Beyond the cap the resolver returns the cap-tier model. Also caps `provider_escalation`. Added in v1.40 |
| `dynamic_routing.provider_escalation` | string[] | ordered model IDs | (none) | Opt-in fallback providers tried when a run dies on a quota / rate limit — see [provider escalation](#provider-escalation-on-quota-exceeded--added-in-v143). Added in v1.43 ([#2296](https://github.com/open-gsd/gsd-core/issues/2296)) |
| `project_code` | string | any short string | (none) | Prefix for phase directory names (e.g., `"ABC"` produces `ABC-01-setup/`). Added in v1.31 |
| `phase_id_convention` | enum | `"milestone-prefixed"`, `null` | `null` | Phase ID naming convention. `null` = legacy numeric IDs (`Phase 1`, `Phase 2`). `"milestone-prefixed"` = globally unique IDs that encode the enclosing milestone (`Phase 1-01`, `Phase 1-02`). Run `gsd-tools roadmap upgrade --convention milestone-prefixed` to migrate an existing ROADMAP.md. |
| `response_language` | string | language code | (none) | Language for agent responses (e.g., `"pt"`, `"ko"`, `"ja"`). Propagates to all spawned agents for cross-phase language consistency. Added in v1.32 |
| `context_window` | number | any integer | `200000` | Context window size in tokens. Set `1000000` for 1M-context models (e.g., `claude-fable-5`). Values `>= 500000` enable adaptive context enrichment (full-body reads of prior SUMMARY.md, deeper anti-pattern reads). Configured via `/gsd-config --advanced`. |
| `context_profile` | string | `dev`, `research`, `review` | (none) | Execution context preset that applies a pre-configured bundle of mode, model, and workflow settings for the current type of work. Added in v1.34 |
| `claude_md_path` | string | any file path | `./.claude/CLAUDE.md` | Custom output path for the generated CLAUDE.md file. Useful for monorepos or projects that need CLAUDE.md in a non-root location. Defaults to `./.claude/CLAUDE.md` — a valid project-scoped memory location that keeps GSD-generated content from polluting a hand-crafted repo-root `CLAUDE.md` ([#1098](https://github.com/open-gsd/gsd-core/issues/1098)). An existing file without GSD markers is never overwritten unless `--force` is passed. Default changed from `./CLAUDE.md` in v1.5. Added in v1.36 |
| `claude_md_assembly.mode` | enum | `embed`, `link` | `embed` | Controls how managed sections are written into CLAUDE.md. `embed` (default) inlines content between GSD markers. `link` writes `@.planning/<source-path>` instead — Claude Code expands the reference at runtime, reducing CLAUDE.md size by ~65% on typical projects. `link` only applies to sections that have a real source file; `workflow` and fallback sections always embed. Per-block overrides: `claude_md_assembly.blocks.<section>` (e.g. `claude_md_assembly.blocks.architecture: link`). Added in v1.38 |
| `context` | string | any text | (none) | Custom context string injected into every agent prompt for the project. Use to provide persistent project-specific guidance (e.g., coding conventions, team practices) that every agent should be aware of |
| `phase_naming` | string | any string | (none) | Custom prefix for phase directory names. When set, overrides the auto-generated phase slug (e.g., `"feature"` produces `feature-01-setup/` instead of the roadmap-derived slug) |
| `brave_search` | boolean | `true`/`false` | auto-detected | Override auto-detection of Brave Search API availability. When unset, GSD checks for `BRAVE_API_KEY` env var or `~/.gsd/brave_api_key` file |
| `firecrawl` | boolean | `true`/`false` | auto-detected | Override auto-detection of Firecrawl API availability. When unset, GSD checks for `FIRECRAWL_API_KEY` env var or `~/.gsd/firecrawl_api_key` file |
| `exa_search` | boolean | `true`/`false` | auto-detected | Override auto-detection of Exa Search API availability. When unset, GSD checks for `EXA_API_KEY` env var or `~/.gsd/exa_api_key` file |
| `tavily_search` | boolean | `true`/`false` | auto-detected | Override auto-detection of Tavily Search API availability. When unset, GSD checks for `TAVILY_API_KEY` env var or `~/.gsd/tavily_api_key` file |
| `ref_search` | boolean | `true`/`false` | auto-detected | Override auto-detection of Ref search API availability. When unset, GSD checks for `REF_API_KEY` env var or `~/.gsd/ref_api_key` file |
| `perplexity` | boolean | `true`/`false` | auto-detected | Override auto-detection of Perplexity API availability. When unset, GSD checks for `PERPLEXITY_API_KEY` env var or `~/.gsd/perplexity_api_key` file |
| `jina` | boolean | `true`/`false` | `true` | Override auto-detection of Jina API availability. Jina is a terminal fallback in the docs waterfall and defaults to available (`true`); GSD checks for `JINA_API_KEY` env var or `~/.gsd/jina_api_key` file when an explicit override is needed |
| `search_gitignored` | boolean | `true`/`false` | `false` | Legacy top-level alias for `planning.search_gitignored`. Prefer the namespaced form; this alias is accepted for backward compatibility |

> **Note:** `granularity` was renamed from `depth` in v1.22.3. Existing configs are auto-migrated.

---

## Integration Settings

Configured interactively via [`/gsd-config --integrations`](COMMANDS.md#gsd-config). These are *connectivity* settings — API keys and cross-tool routing — and are intentionally kept separate from `/gsd-settings` (workflow toggles).

### Search API keys

API key fields accept a string value (the key itself). They can also be set to the sentinels `true`/`false`/`null` to override auto-detection from env vars / `~/.gsd/*_api_key` files (legacy behavior, see rows above).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `brave_search` | string \| boolean \| null | `null` | Brave Search API key used for web research. Displayed as `****<last-4>` in all UI / `config-set` output; never echoed plaintext |
| `firecrawl` | string \| boolean \| null | `null` | Firecrawl API key for deep-crawl scraping. Masked in display |
| `exa_search` | string \| boolean \| null | `null` | Exa Search API key for semantic search. Masked in display |
| `tavily_search` | string \| boolean \| null | `null` | Tavily Search API key used in the web-discovery waterfall. Masked in display |
| `ref_search` | string \| boolean \| null | `null` | Ref search API key used in the docs-discovery waterfall. Masked in display |
| `perplexity` | string \| boolean \| null | `null` | Perplexity API key used in the web-discovery waterfall. Masked in display |
| `jina` | string \| boolean \| null | `null` | Jina API key (docs / scrape fallback). Masked in display |

**Masking convention (`gsd-core/bin/lib/secrets.cjs`):** keys 8+ characters render as `****<last-4>`; shorter keys render as `****`; `null`/empty renders as `(unset)`. Plaintext is written as-is to `.planning/config.json` — that file is the security boundary — but the CLI, confirmation tables, logs, and `AskUserQuestion` descriptions never display the plaintext. This applies to the `config-set` command output itself: `config-set brave_search <key>` returns a JSON payload with the value masked.

### Code-review CLI routing

`review.models.<cli>` maps a reviewer flavor to a bare model id. The code-review workflow injects this value into the CLI's `--model` (or `-m`) flag when invoking the reviewer.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `review.models.claude` | string | (session model) | Model id for Claude-flavored review. Defaults to the session model when unset |
| `review.models.codex` | string | `null` | Model id for Codex review (injected into --model), e.g. `"gpt-5"` |
| `review.models.gemini` | string | `null` | Model id for Gemini review (injected into -m), e.g. `"gemini-2.5-pro"` |
| `review.models.opencode` | string | `null` | Model id for OpenCode review (injected into --model), e.g. `"claude-sonnet-4"` |

The `<cli>` slug is validated against `[a-zA-Z0-9_-]+`. Empty or path-containing slugs are rejected by `config-set`.

### Reviewer defaults for `/gsd-review`

Use `review.default_reviewers` to scope the no-flag `/gsd-review` run to a subset of detected reviewers.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `review.default_reviewers` | string[] \| null | `null` (all detected reviewers) | Optional default subset for no-flag `/gsd-review`, e.g. `["gemini","codex"]`. Entries may be built-in reviewer slugs or configured `review.reviewer_instances` names. Precedence is: explicit reviewer flags > `--all` > `review.default_reviewers` > all detected. Unknown slugs are ignored with a warning when no instances are configured; with `review.reviewer_instances` present, unknown entries are hard errors to catch typoed instance names. Known-but-undetected slugs are ignored with an info note; empty arrays are rejected by `config-set`. |

Example:

```json
{
  "review": {
    "default_reviewers": ["gemini", "codex"]
  }
}
```

### Reviewer instances for `/gsd-review` (#1517)

Use `review.reviewer_instances` to run one model-capable adapter as several independent
reviewer identities — e.g. two OpenCode-backed reviews with different models in a single
`/gsd-review` pass. Each entry maps an instance name to `{ cli, model?, agent? }`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `review.reviewer_instances.<name>.cli` | string | (required) | A known reviewer adapter the instance reuses (e.g. `opencode`). Must be a built-in slug; never an arbitrary shell command. |
| `review.reviewer_instances.<name>.model` | string | (adapter default) | Opaque `provider/model` id passed through verbatim to the adapter's `--model`. GSD does not parse it. |
| `review.reviewer_instances.<name>.agent` | string | (none) | Opaque agent name; honoured only by adapters with a native agent concept (OpenCode `--agent` in v1). |

Instance names must match `^[a-z0-9][a-z0-9-]*$` and must not equal a built-in reviewer slug.
Instances participate ONLY through `review.default_reviewers` (there are no per-instance CLI
flags). Instance references are expanded before built-in slugs; an instance is available iff
its `cli` is detected. An entry that is neither a defined instance nor a built-in slug is a
hard error (a typo'd instance name must be loud). When two or more selected instances share
the same `cli`, `REVIEWS.md` prints a one-line shared-adapter caveat so review consensus is
not silently overstated. See [ADR-1517](adr/1517-reviewer-instances-config-surface.md).

Example:

```json
{
  "review": {
    "reviewer_instances": {
      "opencode-deepseek": { "cli": "opencode", "model": "deepseek/deepseek-v4-pro", "agent": "review" },
      "opencode-mimo": { "cli": "opencode", "model": "xiaomi/mimo-v2.5-pro" }
    },
    "default_reviewers": ["opencode-deepseek", "opencode-mimo", "codex"]
  }
}
```

Set each field via `config-set`:

```bash
gsd config-set review.reviewer_instances.opencode-deepseek.cli opencode
gsd config-set review.reviewer_instances.opencode-deepseek.model deepseek/deepseek-v4-pro
gsd config-set review.reviewer_instances.opencode-deepseek.agent review
gsd config-set review.default_reviewers '["opencode-deepseek","opencode-mimo","codex"]'
```

### Agent-skill injection (dynamic)

`agent_skills.<agent-type>` extends the `agent_skills` map documented below. Slug is validated against `[a-zA-Z0-9_-]+` — no path separators, no whitespace, no shell metacharacters. Configured interactively via `/gsd-config --integrations`.

---

## Workflow Toggles

All workflow toggles follow the **absent = enabled** pattern. If a key is missing from config, it defaults to `true`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workflow.research` | boolean | `true` | Domain investigation before planning each phase |
| `workflow.plan_check` | boolean | `true` | Plan verification loop (up to 3 iterations) |
| `workflow.verifier` | boolean | `true` | Post-execution verification against phase goals |
| `workflow.auto_advance` | boolean | `false` | Auto-chain discuss → plan → execute without stopping |
| `workflow.nyquist_validation` | boolean | `true` | Test coverage mapping during plan-phase research |
| `workflow.ui_phase` | boolean | `true` | Generate UI design contracts for frontend phases |
| `workflow.ui_safety_gate` | boolean | `true` | Prompt to run /gsd-ui-phase for frontend phases during plan-phase |
| `workflow.assumption_delta` | boolean | `true` | Advisory architecture checkpoint during planning. When a phase makes something **plural, optional, or chosen** that used to be **singular, required, or derived** (e.g. a second auth method, a required field becoming optional, a constant becoming a parameter), the planner is prompted to re-ask whether the primary key / identity model still names the right thing (promote the new general representation vs. add it alongside). Non-blocking; fires only on a detected signal. Bare "or" is intentionally excluded (prose false-positives). Inspect a phase with `gsd query assumption-delta scan <phase>`. Added in #1561 |
| `workflow.ui_review` | boolean | `true` | Run visual quality audit (`/gsd-ui-review`) after phase execution in autonomous mode. When `false`, the UI audit step is skipped. |
| `workflow.node_repair` | boolean | `true` | Autonomous task repair on verification failure |
| `workflow.node_repair_budget` | number | `2` | Max repair attempts per failed task |
| `workflow.smart_zone_tokens` | number | `100000` | Smart-zone token budget for phase-effort estimation (#2630, [ADR-2629](adr/2629-phase-effort-estimation-calibration.md)). A phase whose estimate exceeds this is flagged with a split recommendation — **advisory only, never a block**. This is a *policy default, not a benchmark constant*: LLM output quality degrades before the advertised context window is full, but the effective ceiling is model-, task-, and distractor-dependent, so no universal number exists. Lower it for models that degrade early; the estimate-vs-actual calibration loop corrects the figure per project over time. Must be a positive integer. |
| `workflow.research_before_questions` | boolean | `false` | Run research before discussion questions instead of after |
| `workflow.discuss_mode` | string | `'discuss'` | Controls how `/gsd-discuss-phase` gathers context. `'discuss'` (default) asks questions one-by-one. `'assumptions'` reads the codebase first, generates structured assumptions with confidence levels, and only asks you to correct what's wrong. Added in v1.28 |
| `workflow.max_discuss_passes` | number | `3` | Maximum number of question rounds in discuss-phase before the workflow stops asking. Useful in headless/auto mode to prevent infinite discussion loops. |
| `workflow.skip_discuss` | boolean | `false` | When `true`, `/gsd-autonomous` bypasses the discuss-phase entirely, writing minimal CONTEXT.md from the ROADMAP phase goal. Useful for projects where developer preferences are fully captured in PROJECT.md/REQUIREMENTS.md. Added in v1.28 |
| `workflow.text_mode` | boolean | `false` | Replaces AskUserQuestion TUI menus with plain-text numbered lists. Required for Claude Code remote sessions (`/rc` mode) where TUI menus don't render. Can also be set per-session with `--text` flag on discuss-phase. Added in v1.28 |
| `workflow.use_worktrees` | boolean | `true` | When `false`, disables git worktree isolation for parallel execution. Users who prefer sequential execution or whose environment does not support worktrees can disable this. Added in v1.31. **Branch-divergence note:** when your branch has diverged from `origin/HEAD`, GSD auto-degrades to sequential and prints a warning. See [`worktree.baseRef`](#worktree-settings) to restore parallel execution on a diverged branch. **Non-Claude note:** git worktree isolation uses Claude Code's `isolation="worktree"` agent primitive, which no other runtime honors. On any non-Claude install (Codex, Cursor, Antigravity, Qwen, etc.) a runtime-neutral `.planning/config.json` resolves the runtime to that install's own id and defaults this key to `false`; forcing `use_worktrees: true` on a non-Claude install fails closed before any executor dispatch (#1515, #1521). |
| `workflow.worktree_skip_hooks` | boolean | `false` | When `true`, executor agents in worktree mode pass `--no-verify` (skipping pre-commit hooks) and post-wave hook validation runs against the merged result instead. Opt-in escape hatch for projects whose hooks cannot run in agent worktrees. Default `false` runs hooks on every commit (#2924). |
| `workflow.code_review` | boolean | `true` | Enable `/gsd-code-review` and `/gsd-code-review --fix` commands. When `false`, the commands exit with a configuration gate message. Added in v1.34 |
| `workflow.code_review_depth` | string | `standard` | Default review depth for `/gsd-code-review`: `quick` (pattern-matching only), `standard` (per-file analysis), or `deep` (cross-file with import graphs). Can be overridden per-run with `--depth=`. Added in v1.34 |
| `workflow.plan_bounce` | boolean | `false` | Run external validation script against generated plans. When enabled, the plan-phase orchestrator pipes each PLAN.md through the script specified by `plan_bounce_script` and blocks on non-zero exit. Added in v1.36 |
| `workflow.plan_bounce_script` | string | (none) | Path to the external script invoked for plan bounce validation. Receives the PLAN.md path as its first argument. Required when `plan_bounce` is `true`. Added in v1.36 |
| `workflow.plan_bounce_passes` | number | `2` | Number of sequential bounce passes to run. Each pass feeds the previous pass's output back into the validator. Higher values increase rigor at the cost of latency. Added in v1.36 |
| `workflow.post_planning_gaps` | boolean | `true` | Unified post-planning gap report (#2493). After all plans are generated and committed, scans REQUIREMENTS.md and CONTEXT.md `<decisions>` against every PLAN.md in the phase directory, then prints one `Source \| Item \| Status` table. Word-boundary matching (REQ-1 vs REQ-10) and natural sort (REQ-02 before REQ-10). Non-blocking — informational report only. Set to `false` to skip Step 13e of plan-phase. |
| `workflow.plan_review_convergence` | boolean | `false` | Enable the `/gsd-plan-review-convergence` command. Disabled by default — the command exits with an enable instruction when this key is `false`. The command automates the manual plan→review→replan loop: it spawns configured reviewers (Codex, Gemini, Claude, OpenCode, Ollama, LM Studio, llama.cpp), counts unresolved HIGH concerns and actionable MEDIUM/LOW findings via the CYCLE_SUMMARY contract, replans with `--reviews` feedback, and repeats until converged or max cycles reached. Enable with `gsd config-set workflow.plan_review_convergence true`. Added in v1.39 |
| `workflow.plan_chunked` | boolean | `false` | Enable chunked planning mode. When `true` (or when `--chunked` flag is passed to `/gsd-plan-phase`), the orchestrator splits the single long-lived planner Task into a short outline Task followed by N short per-plan Tasks (~3-5 min each). Each plan is committed individually for crash resilience. If a Task hangs and the terminal is force-killed, rerunning with `--chunked` resumes from the last completed plan. Particularly useful on Windows where long-lived Tasks may hang on stdio. Added in v1.38 |
| `workflow.code_review_command` | string | (none) | Shell command for external code review integration in `/gsd-ship`. Receives changed file paths via stdin. Non-zero exit blocks the ship workflow. Added in v1.36 |
| `workflow.tdd_mode` | boolean | `false` | Enable TDD pipeline as a first-class execution mode. When `true`, the planner aggressively applies `type: tdd` to eligible tasks (business logic, APIs, validations, algorithms) and the executor enforces RED/GREEN/REFACTOR gate sequence. An end-of-phase collaborative review checkpoint verifies gate compliance. Added in v1.36 |
| `workflow.mvp_mode` | boolean | `false` | Persist the MVP-mode flag in config so every phase defaults to MVP framing without requiring `--mvp` on the CLI. Resolved via the precedence chain: `--mvp` CLI flag → ROADMAP.md `**Mode:** mvp` field → this config value → `false`. When `true`, the planner, executor, verifier, and discovery surfaces treat the phase as an MVP vertical slice (UI → API → DB) of one user-visible capability instead of a horizontal layer. |
| `workflow.human_verify_mode` | string | `'end-of-phase'` | Controls human verification checkpoints. `'end-of-phase'` (default since #3309) suppresses `checkpoint:human-verify` tasks and embeds checks into `<verify><human-check>` blocks for end-of-phase review. `'mid-flight'` restores blocking checkpoint tasks. `checkpoint:decision` and `checkpoint:human-action` are unaffected. See [Checkpoints Reference](../gsd-core/references/checkpoints.md#checkpoint_types). |
| `workflow.context_guard_mode` | string | `'warn'` | Context exhaustion guard for `execute-phase`. Before each wave, the orchestrator self-assesses context pressure using the degradation signals defined in `context-budget.md`. `'warn'` (default) emits a warning and recommends `/gsd:pause-work` when POOR tier (70%+) is detected. `'auto'` automatically invokes `/gsd:pause-work` before the next wave. `'off'` disables the guard. Set via: `gsd config-set workflow.context_guard_mode auto`. Added in #1452. |
| `workflow.cross_ai_execution` | boolean | `false` | Delegate phase execution to an external AI CLI instead of spawning local executor agents. Useful for leveraging a different model's strengths for specific phases. Added in v1.36 |
| `workflow.cross_ai_command` | string | (none) | Shell command template for cross-AI execution. Receives the phase prompt via stdin. Must produce SUMMARY.md-compatible output. Required when `cross_ai_execution` is `true`. Added in v1.36 |
| `workflow.cross_ai_timeout` | number | `300` | Timeout in seconds for cross-AI execution commands. Prevents runaway external processes. Added in v1.36 |
| `workflow.test_gate_timeout` | number | `600` | Wall-clock timeout (seconds) for a verification test gate; a watch-mode runner (vitest/jest) that never exits is aborted after this budget instead of hanging the orchestrator (#1857) |
| `workflow.ai_integration_phase` | boolean | `true` | Enable the `/gsd-ai-integration-phase` command. When `false`, the command exits with a configuration gate message |
| `workflow.api_coverage_gate` | boolean | `true` | Require an explicit API-coverage decision before a phase that integrates an external API/SDK/service can seal. At `plan:pre` the planner is prompted to produce a `COVERAGE.md` matrix (full coverage by default, every opt-out reasoned); at `verify:pre` a blocking gate fails the seal unless the matrix is complete. Independent of `ai_integration_phase` (#1562) |
| `workflow.auto_prune_state` | boolean | `false` | When `true`, automatically prune stale entries from STATE.md at phase boundaries instead of prompting |
| `workflow.pattern_mapper` | boolean | `true` | Run the `gsd-pattern-mapper` agent between research and planning to map new files to existing codebase analogs |
| `workflow.subagent_timeout` | number | `300000` | Timeout in milliseconds for parallel subagent tasks (e.g. codebase mapping). Increase for large codebases or slower models. Default: 300000 (5 minutes) |
| `executor.stall_detect_interval_minutes` | number | `5` | Minutes between executor stall checks while an executor agent is active. The execute-phase orchestrator uses this cadence to inspect recent commits and avoid waiting forever on a silent agent. |
| `executor.stall_threshold_minutes` | number | `10` | Minutes without executor completion or expected-branch commit activity before execute-phase offers recovery choices for a possible stalled executor. |
| `workflow.inline_plan_threshold` | number | `3` | Maximum number of tasks in a phase before the planner generates a separate PLAN.md file instead of inlining tasks in the prompt |
| `workflow.drift_threshold` | number | `3` | Minimum number of new structural elements (new directories, barrel exports, migrations, route modules) before the codebase-drift gate takes action. The gate runs at two points: `plan:pre` (before `/gsd-plan-phase` plans — **non-blocking, warn-only**, so plans are authored against a fresh STRUCTURE.md) and `execute:wave:post` (after `/gsd-execute-phase` — honors `workflow.drift_action`). See [#2003](https://github.com/open-gsd/gsd-core/issues/2003). Added in v1.39 |
| `workflow.drift_action` | string | `warn` | What to do when `workflow.drift_threshold` is exceeded **at `execute:wave:post`** (after `/gsd-execute-phase`). `warn` prints a message suggesting `/gsd-map-codebase --paths …`; `auto-remap` spawns `gsd-codebase-mapper` scoped to the affected paths. The `plan:pre` pre-check is always warn-only regardless of this setting — it never auto-spawns the mapper at plan entry. Added in v1.39 |
| `workflow.plan_drift_precheck` | boolean | `true` | Enable the non-blocking codebase-drift pre-check at `plan:pre`, before `/gsd:plan-phase` spawns the planner. Surfaces a stale STRUCTURE.md (drift over `workflow.drift_threshold`) as a warn-only advisory pointing to `/gsd:map-codebase`; never blocks planning, never spawns the mapper. Separate from the `execute:wave:post` gates so autonomous/CI runs can silence the plan-time advisory while keeping execute-time drift detection on. Added in v1.6.0. See [#1592](https://github.com/open-gsd/gsd-core/issues/1592). |
| `workflow.build_command` | string | (none) | Shell command to build the project in the post-merge build gate (Step A of step 5.6 in execute-phase). When unset, the gate auto-detects: Xcode (`.xcodeproj` present) → `xcodebuild build`, `Makefile` with `build:` target → `make build`, Justfile → `just build`, `Cargo.toml` → `cargo build`, `go.mod` → `go build ./...`, Python → `python -m py_compile`, `package.json` with `build` script → `npm run build`. Runs with a 5-minute timeout; failure increments `WAVE_FAILURE_COUNT`. Added in v1.39 |
| `workflow.test_command` | string | (none) | Shell command to run the project's test suite in the post-merge test gate (Step B of step 5.6 in execute-phase) and the regression gate. When unset, the gate auto-detects: Xcode (`.xcodeproj` present) → `xcodebuild test`, `Makefile` with `test:` target → `make test`, Justfile → `just test`, `package.json` → `npm test`, `Cargo.toml` → `cargo test`, `go.mod` → `go test ./...`, Python → `python -m pytest`. Runs with a 5-minute timeout; failure increments `WAVE_FAILURE_COUNT`. Added in v1.39 |

## Worktree Settings

> **File:** `.claude/settings.local.json` — not `.planning/config.json`. Unlike all other keys in this reference, `worktree.*` settings live in the Claude Code runtime settings file. Fresh installs and upgrades auto-set `worktree.baseRef: "head"` there (no-clobber) when `workflow.use_worktrees` is enabled. The key can also be set via `gsd-tools worktree set-baseref`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `worktree.baseRef` | string | (unset) | Controls which ref the worktree-based parallel executor uses as the base when creating new phase/wave worktrees. When unset, the executor bases new worktrees on the repository default branch (`origin/HEAD`); if the current branch has diverged, execute-phase auto-degrades to sequential execution rather than halting (as of v1.4.0). Set to `"head"` to base new worktrees on the local `HEAD` instead — the appropriate choice when working on a branch that has diverged from the default branch, as it prevents the exit-42 base-mismatch halt and allows wave-based parallel execution to proceed normally. See [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md). |

## Code Quality Settings

The `code_quality.*` namespace gates optional structural-analysis tooling that augments `/gsd-code-review`. Settings are additive: each tool is independently opt-in and off by default.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `code_quality.fallow.enabled` | boolean | `false` | Enables fallow structural pre-pass for `/gsd-code-review`. When `false`, no fallow binary probe or JSON artifact is produced. |
| `code_quality.fallow.scope` | string | `phase` | Scope for fallow analysis: `phase` (current review file scope) or `repo` (entire repository). |
| `code_quality.fallow.profile` | string | `standard` | Strictness preset for the fallow pre-pass (`minimal`, `standard`, `strict`). Fallow has no native profile concept, so this maps to its `--max-crap` complexity threshold: `minimal`→50, `standard`→30, `strict`→15 (lower = stricter). |
| `code_quality.fallow.mcp` | boolean | `false` | **Reserved — not yet implemented.** When `true`, enables MCP-backed structural findings mode for runtimes that support MCP server routing. Setting this to `true` is currently a no-op and emits a runtime warning. |

## Ship Settings

`ship.pr_body_sections` adds additional PR body sections for project-specific PRD/PR body content in `/gsd-ship` without editing `gsd-core/workflows/ship.md`.

For a user guide with onboarding examples and troubleshooting, see [Custom PR Body Sections](ship-pr-body-sections.md).

This list is append-only: configured entries are added after the core `Summary`, `Changes`, `Requirements Addressed`, `Verification`, and `Key Decisions` sections. They cannot replace, remove, or reorder required sections.

Recommended lean/agile PRD uses include user stories, acceptance criteria, Definition of Done or release criteria, risks and dependencies, success metrics, and stakeholder review notes. Keep these sections short and evidence-oriented so the PR body remains a living release artifact rather than a static requirements dump.

Each entry supports:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `heading` | string | required | Markdown section heading rendered as `## {heading}`. Must be a single line. |
| `enabled` | boolean | `true` | When `false`, onboarding can keep a candidate section in config without rendering it in generated PR bodies. |
| `source` | string | (none) | Optional fallback chain of planning artifact headings, such as `PLAN.md ## Risks \|\| VERIFICATION.md ## Manual Checks`. Allowed artifacts are `ROADMAP.md`, `PLAN.md`, `SUMMARY.md`, `VERIFICATION.md`, `STATE.md`, `REQUIREMENTS.md`, and `CONTEXT.md`. |
| `template` | string | (none) | Literal Markdown with closed tokens: `{phase_number}`, `{phase_name}`, `{phase_dir}`, `{base_branch}`, `{padded_phase}`. |
| `fallback` | string | (none) | Literal Markdown used when `source` yields no content and no `template` is provided. |

At least one of `source`, `template`, or `fallback` is required for each section. The default is `[]`, so existing projects keep their current `/gsd-ship` output until onboarding adds enabled entries.

Example:

```json
{
  "ship": {
    "pr_body_sections": [
      {
        "heading": "User Stories & Acceptance Criteria",
        "enabled": true,
        "source": "REQUIREMENTS.md ## User Stories || REQUIREMENTS.md ## Acceptance Criteria",
        "fallback": "- Acceptance criteria are covered by the linked requirements and verification evidence."
      },
      {
        "heading": "Risks & Rollback",
        "enabled": true,
        "source": "PLAN.md ## Risks || PLAN.md ## Rollback",
        "fallback": "- Rollback: revert this PR."
      },
      {
        "heading": "Stakeholder Sign-off",
        "enabled": false,
        "template": "- Product owner: pending for {phase_name}"
      }
    ]
  }
}
```

### Common Setting Combinations

The following combinations of `mode`, `granularity`, `model_profile`, and workflow toggles are commonly used together. See [Configure model profiles](how-to/configure-model-profiles.md) for setup guidance.

| Scenario | mode | granularity | profile | research | plan_check | verifier |
|----------|------|-------------|---------|----------|------------|----------|
| Prototyping | `yolo` | `coarse` | `budget` | `false` | `false` | `false` |
| Normal development | `interactive` | `standard` | `balanced` | `true` | `true` | `true` |
| Production release | `interactive` | `fine` | `quality` | `true` | `true` | `true` |

---

## Planning Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `planning.commit_docs` | boolean | `true` | Whether `.planning/` files are committed to git |
| `planning.search_gitignored` | boolean | `false` | Add `--no-ignore` to broad searches to include `.planning/` |
| `planning.sub_repos` | array of strings | `[]` | Paths of nested sub-repos relative to the project root. When set, GSD-aware tooling scopes phase-lookup, path-resolution, and commit operations per sub-repo instead of treating the outer repo as a monorepo |

### Project-Root Resolution in Multi-Repo Workspaces

When `sub_repos` is set and `gsd-tools.cjs` or `gsd-tools query` is invoked from inside a listed child repo, both CLIs walk up to the parent workspace that owns `.planning/` before dispatching handlers. Resolution order (checked at each ancestor up to 10 levels, never above `$HOME`):

1. If the starting directory already has its own `.planning/`, it is the project root (no walk-up).
2. Parent has `.planning/config.json` listing the starting directory's top-level segment in `sub_repos` (or the legacy `planning.sub_repos` shape).
3. Parent has `.planning/config.json` with legacy `multiRepo: true` and the starting directory is inside a git repo.
4. Parent has `.planning/` and an ancestor up to the candidate parent contains `.git` (heuristic fallback).

If none match, the starting directory is returned unchanged. Explicit `--project-dir /path/to/workspace` is idempotent under this resolution.

### Auto-Detection

If `.planning/` is in `.gitignore`, `commit_docs` is automatically `false` regardless of config.json. This prevents git errors.

---

## Hook Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `hooks.context_warnings` | boolean | `true` | Show context window usage warnings via context monitor hook |
| `hooks.workflow_guard` | boolean | `false` | Warn when file edits happen outside GSD workflow context (advises using `/gsd-quick` or `/gsd-fast`) |
| `statusline.show_last_command` | boolean | `false` | Append `last: /<cmd>` suffix to the statusline showing the most recently invoked slash command. Opt-in; reads the active session transcript to extract the latest `<command-name>` tag (closes #2538) |
| `statusline.context_position` | string | `"end"` | Position of the context-window meter. `"end"` (default) renders at line tail; `"front"` renders immediately after the model name so the meter stays visible in narrow terminals. Closes #2937 |
| `statusline.show_context_tokens` | boolean | `false` | Append the absolute token count (e.g. `(156k)`) after the context meter's percentage. Sums input, cache-creation, cache-read, and output tokens from the hook payload — a broader basis than the meter's percentage (which excludes output tokens), so the two figures can diverge slightly. Opt-in; the meter is unchanged when the flag is absent |
| `statusline.state_format` | string | `"full"` | Format of the GSD-state segment. `"full"` (default) is the existing rendering with milestone name and progress bar. `"compact"` renders `<version> · P<phase>/<total> · <status>` (e.g. `v1.12 · P7/12 · executing`) — drops the milestone name and bar, and collapses narrative statuses to the canonical keyword set from `normalizeStateStatus()` (`paused` — the canonical stuck state — renders uppercase as `PAUSED`) |
| `statusline.show_git` | boolean | `false` | Append a git segment after the directory: current branch plus compact work-state markers (`+staged` `~unstaged` `?untracked` `↑ahead` `↓behind`, or `✓` when clean and in sync). One `git status --porcelain=v2` call per render; the segment is absent outside a git repo or when git is unavailable |

The prompt injection guard hook (`gsd-prompt-guard.js`) is always active and cannot be disabled — it's a security feature, not a workflow toggle.

### Private Planning Setup

When `planning.commit_docs` is `false` and `.planning/` is listed in `.gitignore`, GSD treats planning artefacts as local-only. `planning.search_gitignored: true` ensures broad searches still include the `.planning/` directory in this configuration. See [Configure private planning](how-to/configure-model-profiles.md) for setup steps.

---

## Agent Skills Injection

Inject custom skill files into GSD subagent prompts. Skills are read by agents at spawn time, giving them project-specific instructions beyond what CLAUDE.md provides.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agent_skills` | object | `{}` | Map of agent types to arrays of skill entries |
| `agent_skills_security.trusted_global_roots` | array of strings | `[]` | Opt-in allowlist of additional trusted directories for `global:` skills. See [Trusted global skill roots](#trusted-global-skill-roots-agent_skills_securitytrusted_global_roots) |

### Configuration

Add an `agent_skills` section to `.planning/config.json` mapping agent types to arrays of skill entries:

```json
{
  "agent_skills": {
    "gsd-executor": [
      "skills/testing-standards",
      "global:shared-conventions",
      "global:coderabbit:code-review"
    ],
    "gsd-planner": ["skills/architecture-rules"],
    "gsd-verifier": ["skills/acceptance-criteria"]
  }
}
```

### Skill Entry Forms

Each element in the array is one of three forms:

| Form | Example | Resolution |
|------|---------|------------|
| Project-relative path | `"skills/my-skill"` | Resolves to `<project>/skills/my-skill/SKILL.md`, injected as an `@`-include |
| Global personal skill | `"global:<name>"` | Resolves to `~/.claude/skills/<name>/SKILL.md`, injected as an `@`-include |
| Plugin-provided skill (Claude only) | `"global:<plugin>:<skill>"` | A Claude Code plugin skill, loaded by name via the Skill tool at agent spawn time |

**Project-relative paths** must point to a directory containing a `SKILL.md` file. Paths are validated for safety (no traversal outside the project root).

**Global personal skills** (`global:<name>`) resolve against the runtime's global skills directory (e.g. `~/.claude/skills/`). Symlink-escape protection applies unless the target is listed in `agent_skills_security.trusted_global_roots`.

**Plugin-provided skills** (`global:<plugin>:<skill>`) follow the namespaced form `seg(:seg)*`, where each segment is one or more alphanumeric characters, underscores, or hyphens joined by single colons (e.g. `global:coderabbit:code-review`). This form is **Claude-only**: on the Claude runtime GSD emits a Skill-tool load directive in the agent's `<agent_skills>` block so the agent loads the skill by name via the Skill tool, and Claude Code resolves the `plugin:skill` namespace. On all other runtimes the entry is skipped with a warning — the plugin/Skill-tool model is specific to Claude Code and has no equivalent elsewhere.

> **Why load by name rather than path?** Claude Code's plugin cache is versioned and ephemeral, so there is no stable filesystem path to `@`-include. Loading by namespaced name via the Skill tool lets Claude Code's own resolver locate the current version of the plugin skill at runtime.

The plugin must already be installed in the user's Claude Code environment (`/plugin install …`). GSD only references the skill by its namespaced name and does not read or validate the plugin cache itself.

### Supported Agent Types

Any GSD agent type can receive skills. The agent types that consume `agent_skills` are the GSD sub-agents the workflows dispatch. There are 22 consumer agents in total, including:

- `gsd-executor` — executes implementation plans
- `gsd-planner` — creates phase plans
- `gsd-plan-checker` — verifies plan quality
- `gsd-verifier` — post-execution verification
- `gsd-phase-researcher` — phase research
- `gsd-project-researcher` — new-project research
- `gsd-debugger` — diagnostic agents
- `gsd-codebase-mapper` — codebase analysis
- `gsd-code-reviewer` — code review
- `gsd-ui-researcher` — UI design contract creation
- `gsd-ui-checker` — UI spec verification
- `gsd-ui-auditor` — UI audit
- `gsd-roadmapper` — roadmap creation
- `gsd-research-synthesizer` — research synthesis
- and others (see `tests/agent-skills.test.cjs` `CONSUMER_AGENTS` list for the full 22)

The `Skill` tool is granted to consumer agents deliberately and is instruction-bounded — agents use it only to load the skills listed in the `<agent_skills>` block.

### How It Works

Skills reach a consumer agent through **two cooperating seams** (dual injection — see [ADR 1866](adr/1866-agent-skills-dual-injection-contract.md)):

1. **Orchestrator-side (primary on Claude Code).** At spawn time, workflows call `gsd-tools query agent-skills <type>` (or legacy `node gsd-tools.cjs agent-skills <type>`) in their bash init and interpolate the resulting `<agent_skills>` block into the `Task()`/`Agent()` prompt. This is established across ~25 workflows.

2. **Agent-side self-load (durable fallback).** Each of the 22 consumer agents also self-loads in its own mandatory init step — it runs `gsd_run query agent-skills <its-type>` and `Read`s every listed `SKILL.md` per [`gsd-core/references/agent-skills-bootstrap.md`](../gsd-core/references/agent-skills-bootstrap.md). This is the path that works on every runtime, including **Cursor**, where `Skill()`-delegated workflow bash init does not reliably execute and `/gsd-autonomous` delegates via flat `Skill()` calls.

**Dedup guard.** If an agent's prompt already contains an `<agent_skills>` block (orchestrator already injected one), the agent skips self-load — so on runtimes where both seams run (Claude Code), the prompt never carries two copies. `query agent-skills` is read-only and idempotent: it exits 0 with an empty block when nothing is configured for the type, so self-load is zero-overhead for unconfigured agents.

For project-relative and global personal skills, entries appear as `@`-includes:

```xml
<agent_skills>
Read these user-configured skills:
- @skills/testing-standards/SKILL.md
- @/Users/you/.claude/skills/shared-conventions/SKILL.md
</agent_skills>
```

For a mixed config (path-resolvable and plugin-provided skills together), entries appear interleaved in config order in a single section:

```xml
<agent_skills>
Read these user-configured skills:
- @skills/testing-standards/SKILL.md
- Load the `coderabbit:code-review` skill via the Skill tool before proceeding (plugin-provided).
</agent_skills>
```

If no skills are configured, the block is omitted (zero overhead).

### CLI

Set skills via the CLI:

```bash
gsd-tools query config-set agent_skills.gsd-executor '["skills/my-skill"]'
```

See [How to attach a plugin-provided skill to a GSD agent](how-to/attach-a-plugin-skill-to-a-gsd-agent.md) for a step-by-step walkthrough of the `global:plugin:skill` form.

---

## Trusted Global Skill Roots (`agent_skills_security.trusted_global_roots`)

Widen the symlink-safety boundary for `global:` skills by declaring additional trusted root directories.

### Purpose

By default, a `global:<name>` skill whose `SKILL.md` real path (after resolving symlinks) escapes the runtime's global skills directory (e.g. `~/.claude/skills/`) is rejected as a symlink-escape. `agent_skills_security.trusted_global_roots` lets you declare additional trusted root directories so symlinked skills whose real target lives under one of them are accepted.

Common use case: a single source-of-truth skills directory elsewhere on disk (e.g. `~/shared/skills`) symlinked into `~/.claude/skills/` so `git pull` or `rsync` keeps a team's skills up to date without maintaining copies.

### Configuration

```json
{
  "agent_skills_security": {
    "trusted_global_roots": [
      "~/shared/skills",
      "/opt/shared-skills"
    ]
  }
}
```

### How It Works

- **Default `[]`** — behavior is byte-identical to omitting the option entirely: only skills whose real `SKILL.md` path resolves inside the default global skills directory are accepted.
- **Absolute or tilde-prefixed paths only.** Each entry must be an absolute path (`/opt/shared-skills`) or a `~`/`~/`-prefixed path (tilde expands to your home directory). Project-relative paths are rejected, so an untrusted repo's `.planning/config.json` cannot point trust at a directory inside itself.
- **`realpathSync` at load time.** Each declared root is resolved with `realpathSync` on every run, so trust follows the real target and cannot silently drift if a root itself later becomes a symlink. Non-existent or unreadable roots are dropped without error.
- **Dangerously broad roots are refused.** The filesystem root (`/`), drive or UNC roots, and your home directory itself cannot be declared as trusted roots — these would make the allowlist meaningless.
- **Acceptance rule.** A skill is accepted if and only if its real `SKILL.md` path lies inside the default global skills directory OR inside one of the resolved trusted roots. Skills resolving outside all of these are still rejected.
- **Audit note.** When a skill is accepted via a trusted root rather than the default global skills directory, a `[agent-skills] NOTE:` line is written to stderr so the widened boundary remains visible.

> **Security note:** `trusted_global_roots` is read from the project-local `.planning/config.json`. Only add roots you control and trust. Declaring a broad shared directory widens which symlinked global skills will load for every agent in this project.

### CLI

```bash
gsd config-set agent_skills_security.trusted_global_roots '["~/shared/skills"]'
```

Setting the parent object (`agent_skills_security`) directly is not supported; use the dot-notation leaf form shown above.

---

## Capability Trust (`capabilities.*`)

Policy for installing and updating third-party capabilities (ADR-1244). These keys govern the trust gate; they have no effect if you only ever use the native first-party capabilities shipped with GSD. They are **policy inputs** read by the `gsd capability` command flow, which passes the resulting decision into the capability lifecycle — `strict_known_registries` gates whether a source may be installed at all; `auto_update` is consulted by the `update`/`outdated` flow (which always re-prompts when a new version's executable surface set changes). The full rationale — including why there is no sandbox — is in [The capability trust model](explanation/capability-trust-model.md).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `capabilities.strict_known_registries` | array \| null | `null` | Allowlist gating **which sources** third-party capabilities may be installed from. `null` (default) is permissive: external installs (git / npm / tarball) are allowed and each still passes the consent + integrity gate. `[]` (explicit empty array) is lockdown: **all external installs are blocked** — only local-filesystem installs are permitted (managed/enterprise mode). A non-empty list is a **host-based allowlist**: only sources whose host matches an entry (exact host or a subdomain of it — `github.com` matches `api.github.com` but never `evilgithub.com`) are permitted; add the literal token `npm` to permit the npm source kind. Local installs are never "external" and are always allowed. |
| `capabilities.auto_update` | boolean | `false` | Whether installed third-party capabilities may auto-update. **Off by default.** Even when enabled, GSD re-prompts for explicit consent whenever a new version's executable surface set (hooks / command modules / MCP servers) differs from the installed one — the consent you gave was for a specific surface, not a blank cheque. |

```bash
# Lock the machine down to local-only capability installs:
gsd config-set capabilities.strict_known_registries '[]'

# Allow only your org's GitHub + npm:
gsd config-set capabilities.strict_known_registries '["github.com", "npm"]'
```

> **Security note:** `strict_known_registries` matching is **host-based, not substring** — a lookalike host like `evilgithub.com` is rejected even when `github.com` is allowed. `integrity` (sha512) pins only the top-level fetched artifact, not an npm package's transitive dependency tree; see the trust-model explanation for that boundary.

---

## Feature Flags

Toggle optional capabilities via the `features.*` config namespace. Feature flags default to `false` (disabled) — enabling a flag opts into new behavior without affecting existing workflows.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `features.thinking_partner` | boolean | `false` | Enable thinking partner analysis at workflow decision points |
| `features.global_learnings` | boolean | `false` | Enable cross-project learnings pipeline (auto-copy at phase completion, planner injection) |
| `learnings.max_inject` | number | `10` | Maximum number of cross-project learnings injected into each planner prompt. Lower values reduce prompt size; higher values provide broader historical context |
| `intel.enabled` | boolean | `false` | Enable queryable codebase intelligence system. When `true`, `/gsd-map-codebase --query` commands build and query a JSON index in `.planning/intel/`. Added in v1.34 |

<a id="plan-review-settings"></a>
### Plan Review Settings

The `plan_review.*` namespace controls the plan drift guard, which verifies that symbols cited in generated plans (decorators, classes, functions, CLI flags) actually exist in your source code at review time. This catches hallucinated names before execution begins.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `plan_review.source_grounding` | boolean | `true` | Enable the plan drift guard. When `true` (the default), plan review resolves every symbol reference cited in a PLAN.md against the live source tree. Plans that cite a non-existent function, class, decorator, or CLI flag produce a `needs-acknowledgement` notice before the plan is approved. Disable with `false` to skip symbol verification entirely. Toggle during setup (`/gsd:new-project`) or at any time via `/gsd:settings`. |
| `plan_review.source_grounding_authority` | enum | `grep` | Selects the resolver adapter used to verify symbol existence. Allowed values: `grep` (default — ripgrep/grep search of source files, works in any project without additional tooling), `intel` (query the `.planning/intel/api-map.json` index built by `/gsd:map-codebase`; requires `intel.enabled: true`), `treesitter` (reserved for future tree-sitter adapter), `lsp` (reserved for future LSP adapter), `scip` (reserved for future SCIP/LSIF adapter). Use `intel` when you have run `/gsd:map-codebase` and want the faster, pre-indexed lookup. All other values beyond `grep` and `intel` are reserved and have no effect in the current release. |

<a id="mempalace-settings"></a>
### MemPalace Settings

MemPalace is an opt-in, default-resilient memory capability. Every hook is `onError: skip` — a missing or unreachable MemPalace installation never halts or fails the loop. Enable with `mempalace.enabled: true` after installing MemPalace (`pip install mempalace`).

`mempalace.enabled` is the **master gate**: all five loop hooks (discuss, plan, execute-wave, verify, ship) and both curator contributions are gated on this key. When it is `false` (the default), nothing fires and the GSD loop is byte-for-byte unchanged. The remaining keys only refine behavior when `mempalace.enabled` is `true`; they are honored at runtime by the skills, curator, and fragments — they do not add independent hook gating.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mempalace.enabled` | boolean | `false` | Master gate for the MemPalace memory capability. When `false` (the default) every recall/capture hook is inactive and the loop is unchanged. All other `mempalace.*` keys are inert while this is `false`. |
| `mempalace.memory_mode` | enum: `augment`, `kg_backend`, `replace` | `augment` | How authoritative MemPalace is during recall/capture. `augment` (default — an additive recall layer alongside GSD's native graphs/learnings; native memory stays authoritative; lowest coupling). `kg_backend` (knowledge-graph queries resolve against MemPalace's temporal graph as the primary source, with `.planning/graphs/` as fallback; non-KG drawer recall stays additive). `replace` (recall resolves through the palace as the source of truth, native artifacts as fallback). Every mode is `onError:skip` and default-resilient: an unreachable palace degrades to native memory and GSD keeps writing `.planning/graphs/`, so no memory is lost. Cross-mode migration of existing `.planning/graphs/` into the palace is a separate, not-yet-implemented concern. |
| `mempalace.wing` | string | `""` | Palace wing name for this project. Empty (the default) derives the wing from `project_code` or the project directory name. |
| `mempalace.recall_on_discuss` | boolean | `true` | When `mempalace.enabled` is `true`: inject a wake-up + semantic-search recall fragment into the orchestrator at `discuss:pre`. Surfaces prior decisions, patterns, and surprises before the discussion starts. |
| `mempalace.recall_on_plan` | boolean | `true` | When `mempalace.enabled` is `true`: run the `mempalace-recall` skill at `plan:pre` to produce `MEMORY-RECALL.md` from prior decisions, patterns, and surprises relevant to the plan. |
| `mempalace.capture_artifacts` | boolean | `true` | When `mempalace.enabled` is `true`: file phase artifacts (`CONTEXT.md`, `PLAN.md`, `SUMMARY.md`) verbatim into MemPalace at their respective phase boundaries (`discuss:post`, `plan:post`, `verify:post`). Also captures confirmed bug→fix pairs at `execute:wave:post`. |
| `mempalace.mirror_kg` | boolean | `true` | When `mempalace.enabled` is `true`: mirror decisions and learnings into MemPalace's temporal knowledge graph (`mempalace_kg_add` with `valid_from` = phase date) alongside drawer capture. |
| `mempalace.cross_project_tunnels` | boolean | `false` | When `mempalace.enabled` is `true`: at `ship:post`, propose and create tunnels between this wing's rooms and semantically related wings in other projects (`mempalace_find_tunnels`, `mempalace_create_tunnel`). |
| `mempalace.diary_journal` | boolean | `true` | When `mempalace.enabled` is `true`: at `ship:post`, write a per-agent diary entry (`mempalace_diary_write`) summarising the session. |
| `mempalace.auto_capture_hooks` | boolean | `false` | **Reserved — not yet implemented.** Intended to install MemPalace's native Claude Code hooks (`session-start`, `stop`, `precompact`) for passive mid-session capture between loop points. The capability's `hooks` array is currently empty; no native hooks are installed by setting this key. This key is forward-declared for the future "Connected Capability" phase. |

#### Memory modes in detail

| Mode | KG-query source | Recall source | Coupling |
|------|-----------------|---------------|---------|
| `augment` (default) | GSD native + palace (additive) | GSD native + palace search | lowest |
| `kg_backend` | palace temporal KG primary, `.planning/graphs/` fallback | GSD native + palace search | medium |
| `replace` | palace primary, native fallback | palace as source of truth, native fallback | highest |

Mode is read at hook-render time; switching modes is a config change, not a reinstall. In every mode the palace is `onError:skip` and default-resilient — an unreachable palace degrades to native memory, and GSD keeps writing `.planning/graphs/` so no memory is lost. Switching an established project to `kg_backend`/`replace` changes how new recall/capture resolve but does not backfill existing `.planning/graphs/` into the palace (a separate, not-yet-implemented concern).

#### Example

```bash
# Enable MemPalace (augment is the default mode)
gsd-tools query config-set mempalace.enabled true

# Optional: route knowledge-graph recall through the palace's temporal KG (native as fallback)
# gsd-tools query config-set mempalace.memory_mode kg_backend

# Enable cross-project tunnel proposals at ship:post
gsd-tools query config-set mempalace.cross_project_tunnels true
```

<a id="graphify-settings"></a>
### Graphify Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `graphify.enabled` | boolean | `false` | Enable the project knowledge graph. When `true`, `/gsd-graphify` builds and queries a graph in `.planning/graphs/`. Added in v1.36 |
| `graphify.build_timeout` | number (seconds) | `300` | Maximum seconds allowed for a `/gsd-graphify build` run before it aborts. Added in v1.36 |
| `graphify.auto_update` | boolean | `false` | **Opt-in (issue #3347).** When `true` (and `graphify.enabled` is also `true`), the bundled PostToolUse hook `hooks/gsd-graphify-update.sh` auto-rebuilds the project knowledge graph in a detached background process after `git commit/merge/pull/rebase --continue/cherry-pick` on the default branch (`git.base_branch` override, else `main`/`master`/`trunk`). Hook returns instantly; the rebuild updates `.planning/graphs/{graph.json,graph.html,GRAPH_REPORT.md}` and writes `.planning/graphs/.last-build-status.json` (`{ts, status: "running"\|"ok"\|"failed", exit_code, duration_ms, head_at_build}`). PID-locked, CI-aware (`$CI` env suppresses), bails silently if `graphify` is not on `PATH`. Default `false` so existing behaviour is unchanged after upgrade. |
| `graphify.graph_path` | string (path) | _unset_ | **Umbrella/multi-repo support (issue #1825).** Overrides where `/gsd-graphify query\|status\|diff` read the knowledge graph from. Set to a path (relative to the project root, or absolute) pointing at a shared umbrella-level `graph.json` so a single curated cross-repo graph serves every sub-project without N drifting mirror copies. The diff snapshot (`.last-build-snapshot.json`) travels with the configured graph (same directory); the auto-update status sidecar stays project-local. Build stays project-scoped (`.planning/graphs/`) — build the umbrella graph in the umbrella project, then point sub-projects at it. When unset, behaviour is byte-identical to the historical `.planning/graphs/graph.json`. A clear, actionable error is returned when the configured file is missing. |

#### Multi-developer setup

When multiple developers rebuild the graph in the same repository, `graphify hook install` (run once per clone) installs a git merge driver that union-merges concurrent `graph.json` writes, eliminating conflict markers. It also registers the post-commit rebuild hook, writes `.gitattributes`, and adds `graphify merge-driver` to `.git/config`. Solo projects may skip this step. Introduced upstream in graphify v0.7.0 alongside the `built_at_commit` freshness signal surfaced by `/gsd-graphify status`.

#### Commit-based staleness

`/gsd-graphify status` reports two orthogonal staleness signals:

- **`stale`** (mtime-based, 24-hour window) — when the graph file was last
  written. Useful when graphify isn't run automatically.
- **`commit_stale`** (commit-based, requires graphify v0.7+) — whether the
  graph was built against the current `git HEAD`. Trustworthy when present.
  Tri-state: `true` / `false` / `null`. `null` means the signal is
  unavailable (pre-v0.7 graph, no git, or unreachable commit) — fall back
  to the mtime flag.

A CI-built graph rebuilt minutes ago against an old checkout will read as
fresh on mtime but `commit_stale: true`. Surface both when answering
architecture questions.

### Usage

```bash
# Enable a feature
gsd-tools query config-set features.global_learnings true

# Disable a feature
gsd-tools query config-set features.thinking_partner false
```

The `features.*` namespace is a dynamic key pattern — new feature flags can be added without modifying `VALID_CONFIG_KEYS`. Any key matching `features.<name>` is accepted by the config system.

---

## Capability Overlay (installed third-party capabilities)

GSD supports an **installed overlay** of third-party capability manifests that are composed with the frozen first-party registry at runtime via `loadRegistry({ includeInstalled: true })` (ADR-1244; see [`docs/reference/capability-manifest.md`](reference/capability-manifest.md) and [`docs/how-to/import-a-capability-from-a-url.md`](how-to/import-a-capability-from-a-url.md)).

### Install roots

Capability manifests (`capability.json`) are discovered from two scoped roots:

| Scope | Path |
|-------|------|
| Global | `$GSD_HOME/.gsd/capabilities/<id>/capability.json` |
| Project | `<projectRoot>/.gsd/capabilities/<id>/capability.json` |

`GSD_HOME` defaults to your home directory (`~`) when unset. Both roots are scanned on every `loadRegistry` call; neither requires config changes to activate.

### Composition and first-party-wins invariant

Installed overlay capabilities are merged via the same `buildRegistry` pipeline as first-party capabilities, so all derived views (`bySkill`, `byAgent`, `byLoopPoint`, `configKeys`) cover first-party and overlay entries identically. **First-party always wins**: an overlay entry is rejected at load time if its `id`, any owned skill or agent stem, or any federated config key collides with a first-party entry, or if its `id` uses a reserved prefix (`gsd-`, `gsd-core-`, `anthropic-`). Rejected entries emit a warning and are skipped; they never crash the load loop.

### Load-time `engines.gsd` compatibility gate

Each overlay manifest may declare an `engines.gsd` semver range. At load time GSD evaluates this range against the running GSD version. An overlay that does not satisfy the range is **skipped with a warning** — it is never loaded and never crashes the loop. Manifests without an `engines.gsd` field are accepted unconditionally.

### Gate-kind fail-open policy (#2009)

If a skipped or load-failed overlay capability (for example, one whose `engines.gsd` range is incompatible) declared a `gate`-kind loop hook, the loop resolver does **not** inject a gate at that hook point (fail OPEN): the loop proceeds. Instead it emits a loud warning — to stderr and in the `loop render-hooks` envelope's `warnings` array — naming the load-failure reason and the exact remediation, `gsd capability remove <id>`, so the operator is loudly told how to clear it. Skipped capabilities whose hooks are `step` or `contribution` kind skip open too, as before — the loop proceeds without them.

### Overlay config federation

Config keys declared in an overlay capability's `.config` slice federate into the `loadConfig` return value via the same Federated Config channel as first-party capability keys. They appear as valid keys in `config-schema.cjs` (`isValidConfigKey`) and in the runtime config schema, so overlay capabilities can declare project-local config toggles without editing the central config schema.

> **See also:** [`docs/reference/capability-manifest.md`](reference/capability-manifest.md) for the full `capability.json` schema, [`docs/how-to/import-a-capability-from-a-url.md`](how-to/import-a-capability-from-a-url.md) for installation steps, and [ADR-1244](adr/1244-capability-ecosystem.md) for the design record.

---

## Parallelization Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `parallelization` | boolean | `true` | Shorthand for `parallelization.enabled`. Setting `parallelization false` disables parallel execution without changing other sub-keys |
| `parallelization.enabled` | boolean | `true` | Run independent plans simultaneously |
| `parallelization.plan_level` | boolean | `true` | Parallelize at plan level |
| `parallelization.task_level` | boolean | `false` | Parallelize tasks within a plan |
| `parallelization.skip_checkpoints` | boolean | `true` | Skip checkpoints during parallel execution |
| `parallelization.max_concurrent_agents` | number | `3` | Maximum simultaneous agents |
| `parallelization.min_plans_for_parallel` | number | `2` | Minimum plans to trigger parallel execution |

> **Pre-commit hooks and parallel execution**: When parallelization is enabled, executor agents commit with `--no-verify` to avoid build lock contention (e.g., cargo lock fights in Rust projects). The orchestrator validates hooks once after each wave completes. STATE.md writes are protected by file-level locking to prevent concurrent write corruption. If you need hooks to run per-commit, set `parallelization.enabled: false`.

---

## STATE.md Frontmatter (Phase Lifecycle)

`STATE.md` carries YAML frontmatter that the status-line hook reads on every render. v1.40 adds four optional phase-lifecycle fields read by `parseStateMd()` and rendered by `formatGsdState()`:

| Field | Type | Purpose |
|-------|------|---------|
| `active_phase` | string (e.g. `"4.5"`) | Phase number when an orchestrator command is in flight |
| `next_action` | string | Recommended next command when idle (`discuss-phase` / `plan-phase` / `execute-phase` / `verify-phase`) |
| `next_phases` | YAML flow array | Phases the `next_action` applies to (e.g. `["4.5"]`) |
| `progress` | block | Nested `total_phases` / `completed_phases` / `percent` for the milestone progress bar |

All four fields are **optional and additive** — STATE.md files without them keep rendering exactly as in v1.38.x. See [STATE.md schema](reference/state-md.md) for the full field reference, parser constraints, and rendering scenes.

---

## Git Branching

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `git.branching_strategy` | enum | `none` | `none`, `phase`, or `milestone` |
| `git.base_branch` | string | `main` | The integration branch that phase/milestone branches are created from and merged back into. Override when your repo uses `master` or a release branch |
| `git.create_tag` | boolean | `true` | Create a git tag (`v[X.Y]`) on milestone completion. Set to `false` for projects with their own release flow |
| `git.phase_branch_template` | string | `gsd/phase-{phase}-{slug}` | Branch name template for phase strategy |
| `git.milestone_branch_template` | string | `gsd/{milestone}-{slug}` | Branch name template for milestone strategy |
| `git.quick_branch_template` | string or null | `null` | Optional branch name template for `/gsd-quick` tasks |

### Strategy Comparison

| Strategy | Creates Branch | Scope | Merge Point | Best For |
|----------|---------------|-------|-------------|----------|
| `none` | Never | N/A | N/A | Solo development, simple projects |
| `phase` | At `execute-phase` start | One phase | User merges after phase | Code review per phase, granular rollback |
| `milestone` | At first `execute-phase` | All phases in milestone | At `complete-milestone` | Release branches, PR per version |

### Template Variables

| Variable | Available In | Example |
|----------|-------------|---------|
| `{phase}` | `phase_branch_template` | `03` (zero-padded) |
| `{slug}` | Both templates | `user-authentication` (lowercase, hyphenated) |
| `{milestone}` | `milestone_branch_template` | `v1.0` |
| `{num}` / `{quick}` | `quick_branch_template` | `260317-abc` (quick task ID) |

Example quick-task branching:

```json
"git": {
  "quick_branch_template": "gsd/quick-{num}-{slug}"
}
```

### Merge Options at Milestone Completion

| Option | Git Command | Result |
|--------|-------------|--------|
| Squash merge (recommended) | `git merge --squash` | Single clean commit per branch |
| Merge with history | `git merge --no-ff` | Preserves all individual commits |
| Delete without merging | `git branch -D` | Discard branch work |
| Keep branches | (none) | Manual handling later |

---

## Gate Settings

Control confirmation prompts during workflows.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gates.confirm_project` | boolean | `true` | Confirm project details before finalizing |
| `gates.confirm_phases` | boolean | `true` | Confirm phase breakdown |
| `gates.confirm_roadmap` | boolean | `true` | Confirm roadmap before proceeding |
| `gates.confirm_breakdown` | boolean | `true` | Confirm task breakdown |
| `gates.confirm_plan` | boolean | `true` | Confirm each plan before execution |
| `gates.execute_next_plan` | boolean | `true` | Confirm before executing next plan |
| `gates.issues_review` | boolean | `true` | Review issues before creating fix plans |
| `gates.confirm_transition` | boolean | `true` | Confirm phase transition |

---

## Safety Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `safety.always_confirm_destructive` | boolean | `true` | Confirm destructive operations (deletes, overwrites) |
| `safety.always_confirm_external_services` | boolean | `true` | Confirm external service interactions |

---

## Security Settings

Settings for the security enforcement feature (v1.31). All follow the **absent = enabled** pattern. These keys live under `workflow.*` in `.planning/config.json` — matching the shipped template and the runtime reads in `workflows/plan-phase.md`, `workflows/execute-phase.md`, `workflows/secure-phase.md`, and `workflows/verify-work.md`.

These keys live under `workflow.*` — that is where the workflows and installer write and read them. Setting them at the top level of `config.json` is silently ignored.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workflow.security_enforcement` | boolean | `true` | Enable threat-model-anchored security verification via `/gsd-secure-phase`. When `false`, security checks are skipped entirely |
| `workflow.security_asvs_level` | number (1-3) | `1` | OWASP ASVS verification level. Level 1 = opportunistic, Level 2 = standard, Level 3 = comprehensive |
| `workflow.security_block_on` | string | `"high"` | Minimum threat severity that blocks phase advancement. The auditor counts only open threats at or above this severity toward the blocking gate; `none` disables severity blocking. Options: `"critical"`, `"high"`, `"medium"`, `"low"`, `"none"` |

### Injection blocking (top-level `security.*`)

Distinct from the `workflow.security_*` keys above: the read-injection scanner reads a **top-level** `security` object (not `workflow.security`). Set it with `gsd config-set security.injection_blocking true` — it persists as a nested key (`security.injection_blocking`), never a flat dotted key.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `security.injection_blocking` | boolean | `false` | Opt-in circuit-breaker for the read-injection scanner hook (`gsd-read-injection-scanner.js`, PostToolUse on `Read`/`WebFetch`/`WebSearch`). Default (`false`) is **advisory**: HIGH-confidence injection detections are logged but not blocked. When `true`, a HIGH detection emits `decision: "block"` to halt the agent's next step. Because the hook runs *after* the fetch, blocking does **not** retroactively redact content already in the transcript — it is a circuit-breaker, not a redactor. See the [security model](explanation/security-model.md) and [ADR-1577](adr/1577-untrusted-input-boundary-and-injection-blocking.md). |

---

## Decision Coverage Gates (`workflow.context_coverage_gate`)

When `discuss-phase` writes implementation decisions into CONTEXT.md
`<decisions>`, two gates ensure those decisions survive the trip into
plans and shipped code (issue #2492).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workflow.context_coverage_gate` | boolean | `true` | Toggle for both decision-coverage gates. When `false`, both the plan-phase translation gate and the verify-phase validation gate skip silently. |

### What the gates do

**Plan-phase translation gate (BLOCKING).** Runs immediately after the
existing requirements coverage gate, before plans are committed. For each
trackable decision in `<decisions>`, it checks that the decision id
(`D-NN`) or its text appears in at least one plan's `must_haves`,
`truths`, or `objective` (front-matter), a `## must_haves`/`truths`/`tasks`/`objective`
heading, or an `<objective>`/`<tasks>`/`<task>`/`<action>`/`<read_first>`/`<behavior>`/`<verify>`/`<acceptance_criteria>`/`<done>`
tag body. A miss surfaces the missing decision by id and refuses
to mark the phase planned.

**Verify-phase validation gate (NON-BLOCKING).** Runs alongside the other
verify steps. Searches every shipped artifact (PLAN.md, SUMMARY.md, files
modified, recent commit subjects) for each trackable decision. Misses are
written to VERIFICATION.md as a warning section but do **not** flip the
overall verification status. The asymmetry is deliberate — by verify time
the work is done, and a fuzzy substring miss should not fail an otherwise
green phase.

### How to write decisions the gates accept

The discuss-phase template already produces `D-NN`-numbered decisions.
The gate is happiest when:

1. Every plan that implements a decision **cites the id** somewhere —
   `must_haves.truths: ["D-12: bit offsets exposed"]` or a `D-12:` mention
   in the plan body. Strict id match is the cheapest, deterministic path.
2. Soft phrase matching is a fallback for paraphrases — if a 6+-word slice
   of the decision text appears verbatim in a plan/summary, it counts.

### Opt-outs

A decision is **not** subject to the gates when any of the following
apply:

- It lives under the `### Claude's Discretion` heading inside `<decisions>`.
- It is tagged `[informational]`, `[folded]`, or `[deferred]` in its
  bullet (e.g., `- **D-08 [informational]:** Naming style for internal
  helpers`).

Use these escape hatches when a decision genuinely doesn't need plan
coverage — implementation discretion, future ideas captured for the
record, or items already deferred to a later phase.

---

## Review Settings

Configure per-CLI model selection for `/gsd-review`. When set, overrides the CLI's default model for that reviewer.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `review.models.gemini` | string | (CLI default) | Model used when `--gemini` reviewer is invoked |
| `review.models.claude` | string | (CLI default) | Model used when `--claude` reviewer is invoked |
| `review.models.codex` | string | (CLI default) | Model used when `--codex` reviewer is invoked |
| `review.models.opencode` | string | (CLI default) | Model used when `--opencode` reviewer is invoked |
| `review.models.qwen` | string | (CLI default) | Model used when `--qwen` reviewer is invoked |
| `review.models.cursor` | string | (CLI default) | Model used when `--cursor` reviewer is invoked |
| `review.models.ollama` | string | (server default) | Model name passed to Ollama when `--ollama` reviewer is invoked. If unset, the first available model reported by the server is used (e.g. `llama3`). Set to a specific tag: `gsd config-set review.models.ollama codellama` |
| `review.models.lm_studio` | string | (server default) | Model name passed to LM Studio when `--lm-studio` reviewer is invoked. If unset, the first available model reported by the server is used. |
| `review.models.llama_cpp` | string | (server default) | Model name passed to llama.cpp when `--llama-cpp` reviewer is invoked. If unset, the first model reported by `/v1/models` is used. |
| `review.default_reviewers` | string[] \| null | (all detected reviewers) | Default reviewer subset for no-flag `/gsd-review`. Example: `["gemini","codex"]`. May include configured `review.reviewer_instances` names. Explicit flags and `--all` override this setting. |
| `review.max_prompt_tokens` | number\|null | null | Default maximum estimated tokens for the assembled review prompt. When set, the prompt is deterministically trimmed before being sent to each reviewer. Per-reviewer overrides via `review.max_prompt_tokens_per_reviewer` take precedence. null = no trim (current behavior). |
| `review.max_prompt_tokens_per_reviewer` | object | {} | Per-reviewer token budget overrides. Keys are reviewer slugs (ollama, llama_cpp, lm_studio, gemini, claude, codex, opencode, qwen, cursor). Values override `review.max_prompt_tokens` for that reviewer. Recommended for local model servers. |
| `review.ollama_host` | string | `http://localhost:11434` | Base URL of the Ollama server. Override when running Ollama on a non-default port or remote host: `gsd config-set review.ollama_host http://192.168.1.10:11434` |
| `review.lm_studio_host` | string | `http://localhost:1234` | Base URL of the LM Studio local server. Override when using a non-default port. |
| `review.llama_cpp_host` | string | `http://localhost:8080` | Base URL of the llama.cpp server (`llama-server`). Override when using a non-default port. |

### Prompt budgets for small-context reviewers

Local model servers (Ollama, llama.cpp, LM Studio) typically accept far fewer tokens than cloud APIs. Setting `review.max_prompt_tokens_per_reviewer` (or the global `review.max_prompt_tokens` fallback) triggers deterministic prompt trimming before the prompt is sent to that reviewer: CONTEXT is dropped first, then RESEARCH, then REQUIREMENTS; PROJECT.md is head-shrunk to the first 40 lines; PLANs are tail-truncated proportionally — instructions and roadmap are always preserved. When a reviewer is trimmed, a disclosure note is injected at the top of the prompt and trim metadata (budget, omitted sections, truncation percentage) is recorded in the REVIEWS.md frontmatter under `trimmed_reviewers`. If even the minimum review set (instructions + roadmap + plan stubs) exceeds the budget, the reviewer is skipped with a warning rather than sending a truncated prompt that would produce misleading feedback.

### Example

```json
{
  "review": {
    "models": {
      "gemini": "gemini-2.5-pro",
      "qwen": "qwen-max"
    }
  }
}
```

Falls back to each CLI's configured default when a key is absent. Added in v1.35.0 (#1849).

---

## Manager Passthrough Flags

Configure per-step flags that `/gsd-manager` appends to each dispatched command. This allows customizing how the manager runs discuss, plan, and execute steps without manual flag entry.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `manager.flags.discuss` | string | (none) | Flags appended to discuss-phase commands (e.g., `"--auto"`) |
| `manager.flags.plan` | string | (none) | Flags appended to plan-phase commands (e.g., `"--skip-research"`) |
| `manager.flags.execute` | string | (none) | Flags appended to execute-phase commands (e.g., `"--cross-ai"`) |

**Example:**

```json
{
  "manager": {
    "flags": {
      "discuss": "--auto",
      "plan": "--skip-research",
      "execute": "--cross-ai"
    }
  }
}
```

Invalid flag tokens are sanitized and logged as warnings. Only recognized GSD flags are passed through.

---

## Model Profiles

### Profile Definitions

| Agent | `quality` | `balanced` | `budget` | `adaptive` | `inherit` |
|-------|-----------|------------|----------|------------|-----------|
| gsd-planner | Opus | Opus | Sonnet | Opus | Inherit |
| gsd-roadmapper | Opus | Sonnet | Sonnet | Opus | Inherit |
| gsd-executor | Opus | Sonnet | Sonnet | Sonnet | Inherit |
| gsd-phase-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-project-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-research-synthesizer | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-debugger | Opus | Sonnet | Sonnet | Opus | Inherit |
| gsd-codebase-mapper | Sonnet | Haiku | Haiku | Haiku | Inherit |
| gsd-verifier | Sonnet | Sonnet | Haiku | Sonnet | Inherit |
| gsd-plan-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-integration-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-nyquist-auditor | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-pattern-mapper | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-ui-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-ui-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-ui-auditor | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-doc-writer | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-doc-verifier | Sonnet | Sonnet | Haiku | Haiku | Inherit |

> **All 33 shipped agents have explicit per-profile tier assignments** in the catalog (`sdk/shared/model-catalog.json`). The table above shows a representative subset of the most-used agents. For agents not listed here, `model_overrides` accepts any shipped agent name. The authoritative profile data is derived from `sdk/shared/model-catalog.json` via `gsd-core/bin/lib/model-catalog.cjs` and `sdk/src/model-catalog.ts`.

### Per-Agent Overrides

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

Valid override values: `opus`, `sonnet`, `haiku`, `inherit`, or any fully-qualified model ID (e.g., `"openai/o3"`, `"google/gemini-2.5-pro"`).

`model_overrides` can be set in either `.planning/config.json` (per-project)
or `~/.gsd/defaults.json` (global). Per-project entries win on conflict and
non-conflicting global entries are preserved, so you can tune a single
agent's model in one repo without re-setting global defaults. This applies
uniformly across Claude Code, Codex, OpenCode, Kilo, and the other
supported runtimes. On Codex and OpenCode, the resolved model is embedded
into each agent's static config at install time — `spawn_agent` and
OpenCode's `task` interface do not accept an inline `model` parameter, so
running `gsd install <runtime>` after editing `model_overrides` is required
for the change to take effect. See issue #2256.

### Per-Phase-Type Models (`models`) — added in v1.41

> Express tuning at the **phase** level (planning, research, execution, verification) without learning the agent taxonomy. Added in [#3023](https://github.com/open-gsd/gsd-core/pull/3030).

`model_overrides` is per-**agent** (precise but verbose; you have to know that `gsd-codebase-mapper` is research and `gsd-doc-writer` is execution). The `models` block lets you say "Opus for planning and execution, Sonnet for the rest" in two lines:

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

#### Phase-type → agent mapping

| Phase type | Agents |
|---|---|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `discuss` | `gsd-assumptions-analyzer` |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier`, `gsd-code-reviewer` |
| `completion` | (reserved — no subagent today) |

`discuss` and `completion` are accepted by the schema for forward compatibility; setting them today is a no-op until a subagent maps to them.

#### Resolution precedence (highest → lowest)

```text
1. model_overrides[<agent>]              ← per-agent; full IDs; targeted exception
2. dynamic_routing.tier_models[<tier>]   ← when enabled (see §Dynamic Routing)
3. models[<phase_type>]                  ← coarse phase-level tier (this section)
4. model_profile (per-agent col)         ← global tier strategy
5. Runtime default                       ← when nothing else applies
```

The five layers compose top-down: `model_profile` is the base tier, `models[<phase_type>]` overrides at the phase level, `dynamic_routing` (when enabled) escalates per-attempt on soft failure, `model_overrides[<agent>]` carves per-agent exceptions at the top, and the runtime default applies when nothing else does. In the example above, all five research agents resolve to `sonnet` *except* `gsd-codebase-mapper`, which the per-agent override pins to `haiku`. `dynamic_routing` is disabled by default — when off (`enabled: false` or block omitted), this section's behavior is unchanged from today.

#### Accepted values

`models.<phase_type>` accepts only tier aliases:

| Value | Effect |
|---|---|
| `"opus"` / `"sonnet"` / `"haiku"` | Standard tier — runtime resolution maps to the active runtime's model for that tier |
| `"inherit"` | Agents in this phase follow the session model (same semantics as `model_profile: "inherit"`) |

If you need a fully-qualified model ID (`"openai/gpt-5"`, `"google/gemini-2.5-pro"`), use `model_overrides` per agent instead. `models.*` is intentionally tier-only so the runtime-aware mapping stays correct on Codex / OpenCode / Antigravity CLI installs.

#### When to use which

| You want | Use |
|---|---|
| One global tier strategy ("balanced everywhere") | `model_profile` |
| Coarse phase-level tuning ("Opus for planning") | `models.<phase_type>` |
| Per-agent precision ("force haiku on the codebase mapper") | `model_overrides[<agent>]` |
| Full model ID for a specific agent | `model_overrides[<agent>]: "openai/gpt-5"` |

Mix freely — the precedence rule above resolves any overlap deterministically.

#### Validation

`config-set` rejects unknown phase-types:

```bash
$ gsd config-set models.deployment opus
Error: 'models.deployment' is not a valid config key

# Valid:
$ gsd config-set models.research sonnet
```

Direct edits to `.planning/config.json` are looser — the resolver simply ignores values it doesn't recognize and falls through to the profile tier — so a typo doesn't silently break tier resolution.

### Dynamic Routing with Failure-Tier Escalation (`dynamic_routing`) — added in v1.41

> Start cheap, escalate only when the agent fails the gate. Added in [#3024](https://github.com/open-gsd/gsd-core/pull/3031).

`dynamic_routing` lets you pay for the cheap tier by default and only escalate to the more expensive tier when the orchestrator detects a soft failure (verification inconclusive, plan-check FLAG, etc.).

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

#### Agent default tiers

Each agent in `MODEL_PROFILES` declares one of three default tiers. The resolver picks `tier_models[default_tier]` for the first attempt.

| Tier | Agents | Use case |
|---|---|---|
| `light` | gsd-codebase-mapper, gsd-doc-classifier, gsd-doc-verifier, gsd-integration-checker, gsd-intel-updater, gsd-nyquist-auditor, gsd-pattern-mapper, gsd-plan-checker, gsd-research-synthesizer, gsd-ui-auditor, gsd-ui-checker | Cheap/fast — pure mappers, scanners, low-stakes audits |
| `standard` | gsd-advisor-researcher, gsd-ai-researcher, gsd-code-fixer, gsd-code-reviewer, gsd-doc-synthesizer, gsd-doc-writer, gsd-domain-researcher, gsd-eval-auditor, gsd-executor, gsd-phase-researcher, gsd-project-researcher, gsd-ui-researcher, gsd-verifier | Default workhorse — research, writing, primary verification |
| `heavy` | gsd-assumptions-analyzer, gsd-debug-session-manager, gsd-debugger, gsd-eval-planner, gsd-framework-selector, gsd-planner, gsd-roadmapper, gsd-security-auditor, gsd-user-profiler | Deep reasoning — already at top, can't escalate further |

#### Escalation flow

```text
1. Orchestrator spawns agent → resolver returns tier_models[default_tier]
2. Soft failure?
   ├─ no → ✓ done (cheap path)
   └─ yes → orchestrator re-spawns at attempt+1
            → resolver returns tier_models[next_tier_up]
            → cap at max_escalations
3. Hard failure (exception/crash) → bypass escalation, surface immediately
```

If `dynamic_routing.escalate_on_failure: false`, soft failures do **not** advance the tier — every respawn keeps using `tier_models[default_tier]` regardless of the attempt counter. The kill-switch overrides the soft-failure branch above.

`light → standard → heavy → heavy` (heavy stays at heavy; can't go further).

#### Resolution precedence (highest → lowest)

1. **`model_overrides[<agent>]`** — full IDs accepted; targeted exception
2. **`dynamic_routing.tier_models[<tier>]`** (when `enabled: true`)
3. **`models[<phase_type>]`** — coarse phase-level (#3023)
4. **`model_profile`** — per-agent column from active profile
5. **Runtime default**

The `dynamic_routing` block is **disabled by default** — `enabled: false` (or omitting the block) preserves today's static resolution exactly.

#### Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `dynamic_routing.enabled` | boolean | `false` | Master switch. When `true`, the dynamic-routing resolver is used for tier selection. |
| `dynamic_routing.tier_models.light` | enum | (none) | Tier alias for the light tier. Typically `haiku`. |
| `dynamic_routing.tier_models.standard` | enum | (none) | Tier alias for standard. Typically `sonnet`. |
| `dynamic_routing.tier_models.heavy` | enum | (none) | Tier alias for heavy. Typically `opus`. |
| `dynamic_routing.escalate_on_failure` | boolean | `true` | When false, escalation is disabled (every attempt uses the default tier). |
| `dynamic_routing.max_escalations` | integer | `1` | Hard cap on retries per agent invocation. Prevents runaway loops. Also caps the provider ladder below. |
| `dynamic_routing.provider_escalation` | string[] | (none) | Ordered fallback model IDs tried when a run dies on a provider **quota / rate limit**. Added in v1.43 ([#2296](https://github.com/open-gsd/gsd-core/issues/2296)) |

#### Provider escalation on quota-exceeded — added in v1.43

The tier ladder above escalates *within one provider*. That does not help when the
provider itself is what ran out: a heavier tier on the same throttled account is still
throttled. `provider_escalation` is a separate, opt-in ladder for exactly that case.

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

When an executor dies and `gsd-tools agent classify-failure` classifies the error body as
`quota-exceeded`, `execute-phase` re-resolves the model from this list instead of waiting
for a quota reset, logs the switch (`sonnet → gpt-5`), and honors any `Retry-After` the
provider sent. The ladder is capped at `min(max_escalations, provider_escalation.length)`;
once spent, GSD reports every model it tried and falls back to the manual recovery prompt
rather than silently retrying the last one.

- **Opt-in.** With no `provider_escalation` configured, quota failures keep today's manual
  wait-for-reset prompt exactly as before.
- **Quota only.** Other failure classes (`classify-handoff-bug`, `unknown-failure`) never
  consult this ladder — they keep the tier ladder.
- **`escalate_on_failure: false`** disables this ladder too.
- Entries are opaque model IDs passed to the runtime. Blank and non-string entries are
  dropped; the surviving order is preserved.

#### When to use which

| You want | Use |
|---|---|
| One tier strategy across all agents | `model_profile` |
| Coarse phase-level tuning | `models.<phase_type>` |
| Per-agent precision (full IDs) | `model_overrides` |
| **Cheap-by-default, escalate only on failure** | **`dynamic_routing`** |

`dynamic_routing` is structurally a *cost lever*: you pay Opus rates only for the hard cases that warrant Opus. Compose with `model_overrides` for per-agent exceptions (override always wins).

---

### Effort Control (`effort`) — added in v1.42

> Unified cross-provider effort knob. Added in [#443](https://github.com/open-gsd/gsd-core/issues/443).

Control the reasoning effort of agent invocations with a single config. The universal ladder is:

```
minimal < low < medium < high < xhigh < max
```

Effort is rendered per-runtime: `output_config.effort` for Claude (Claude Code subagent `effort` frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env), `model_reasoning_effort` for Codex (Responses API `reasoning.effort`).

**Cross-provider clamping:** `max` is Anthropic-only — it clamps to `xhigh` on Codex. `minimal` is Codex-only — it clamps to `low` on Claude.

The model-catalog's `reasoning_effort` per-tier hint is a legacy field kept for reference; effort is now config-driven.

**Precedence (highest → lowest):**
1. Invocation override (e.g. `--effort` flag on `resolve-execution`)
2. `effort.agent_overrides[<agent-id>]`
3. `effort.routing_tier_defaults[<light|standard|heavy>]`
4. `effort.default`
5. `"high"` (Anthropic Opus 4.8 universal default)

```json
{
  "effort": {
    "default": "high",
    "routing_tier_defaults": {
      "light":    "low",
      "standard": "high",
      "heavy":    "xhigh"
    },
    "agent_overrides": {
      "gsd-planner": "max"
    }
  }
}
```

#### Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `effort.default` | enum | `"high"` | Global fallback effort level. Applies when no tier or agent override matches. |
| `effort.routing_tier_defaults.light` | enum | `"low"` | Effort for light-tier agents (fast mappers/scanners). |
| `effort.routing_tier_defaults.standard` | enum | `"high"` | Effort for standard-tier agents (workhorse agents). |
| `effort.routing_tier_defaults.heavy` | enum | `"xhigh"` | Effort for heavy-tier agents (deep reasoning). |
| `effort.agent_overrides.<agent-id>` | enum | (none) | Per-agent effort override. Beats tier defaults. |

Valid effort values: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

#### Where effort actually reaches — added in v1.8.0

Effort resolved from the cascade above reaches a runtime through one of two channels.

**Install-time.** The value is baked into the artifacts the installer generates — the
`effort:` frontmatter key on a Claude subagent, `model_reasoning_effort` in a generated
Codex `.toml`. This is fixed at install and changes only on reinstall or sync.

**Invocation-time.** When GSD spawns another CLI as a subprocess — the cross-AI reviewers
in `/gsd:review` — the effort is appended to that CLI's own command line. Whether a host
can receive effort this way is a declared capability (`effortSurface`, ADR-1239), not an
assumption:

| Reviewer CLI | Receives effort as |
|---|---|
| `claude` | `--effort <level>` |
| `opencode` | `--variant <level>` |
| `codex` | `-c model_reasoning_effort=<level>` |

A host whose documentation states no reasoning setting is left **untouched** — no flag is
guessed, and GSD never writes into your own CLI's config file to set one. Levels a given
CLI does not accept are clamped to its nearest supported value (`minimal` → `low` for
Claude, `max` → `xhigh` for Codex), so a cross-provider value never produces an invalid
argument.

Before this, a review run inherited whatever effort happened to be configured in your
personal CLI config, which is why the same project could produce very different review
times on two machines. Setting `effort.default` (or an agent/tier override) now controls
review runs too.

---

### Fast Mode (`fast_mode`) — added in v1.42

> Per-agent fast_mode propagation knob. Added in [#443](https://github.com/open-gsd/gsd-core/issues/443).

Control whether fast_mode is propagated to agent invocations. Only accepts real booleans — string `"true"` is rejected.

**Note:** `fast_mode` is only propagatable via API runtimes (`api` speed:"fast"). Claude Code has no per-subagent fast-mode mechanism — `/fast` is session-level only, so emitting a `fast_mode` frontmatter key on a Claude subagent is a silent no-op. `fast_mode_supported` in `resolve-execution` output tells you if the configured runtime supports it.

**Precedence (highest → lowest):**
1. Invocation override (e.g. `--fast-mode` flag on `resolve-execution`)
2. `fast_mode.agent_overrides[<agent-id>]` (boolean)
3. `fast_mode.routing_tier_defaults[<light|standard|heavy>]` (boolean)
4. `fast_mode.enabled` (boolean)
5. `false`

```json
{
  "fast_mode": {
    "enabled": false,
    "routing_tier_defaults": {
      "light":    true,
      "standard": false,
      "heavy":    false
    },
    "agent_overrides": {}
  }
}
```

#### Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `fast_mode.enabled` | boolean | `false` | Global fast_mode flag. Only honored when no tier/agent override matches. |
| `fast_mode.routing_tier_defaults.light` | boolean | `true` | Fast mode for light-tier agents. |
| `fast_mode.routing_tier_defaults.standard` | boolean | `false` | Fast mode for standard-tier agents. |
| `fast_mode.routing_tier_defaults.heavy` | boolean | `false` | Fast mode for heavy-tier agents. |
| `fast_mode.agent_overrides.<agent-id>` | boolean | (none) | Per-agent fast_mode override. |

---

### Execution Query (`resolve-execution`)

Use `node gsd-tools.cjs resolve-execution <agent-type> [--effort <level>] [--fast-mode <true|false>] [--attempt <n>]` to get the full resolved execution context for an agent:

```json
{
  "model":             "opus",
  "profile":           "balanced",
  "effort":            "xhigh",
  "effort_rendered":   "xhigh",
  "effort_param":      "output_config.effort",
  "effort_propagation": "frontmatter",
  "fast_mode":         false,
  "fast_mode_supported": false
}
```

`effort_param` tells you which runtime parameter to set. `fast_mode_supported` tells you whether the configured runtime supports per-agent fast_mode propagation.

---

### Non-Claude Runtimes (Codex, OpenCode, Antigravity CLI, Kilo)

> **Codex CLI minimum supported version: `0.130.0`** (issue [#3562](https://github.com/open-gsd/gsd-core/issues/3562)).
>
> [Codex CLI 0.130.0](https://github.com/openai/codex/releases/tag/rust-v0.130.0) (released 2026-05-08) removed extra-skills-roots discovery via [openai/codex#21485](https://github.com/openai/codex/pull/21485). From this version forward, Codex CLI only scans `~/.codex/skills/<name>/SKILL.md`, `<project>/.codex/skills/`, and registered plugin roots for invocable skills. GSD installs the `$gsd-*` surface as `~/.codex/skills/gsd-<name>/SKILL.md` so commands resolve after a Codex restart. Earlier Codex CLI versions can show a duplicate listing (the legacy extra-roots scan plus the user-root copies) — restart Codex and either upgrade to ≥ 0.130.0 or accept the duplicates until you do.

When GSD is installed for a non-Claude runtime, the installer automatically sets `resolve_model_ids: "omit"` in `~/.gsd/defaults.json`. This causes GSD to return an empty model parameter for all agents, so each agent uses whatever model the runtime is configured with. No additional setup is needed for the default case.

If you want different agents to use different models, use `model_overrides` with fully-qualified model IDs that your runtime recognizes:

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

The intent is the same as the Claude profile tiers -- use a stronger model for planning and debugging (where reasoning quality matters most), and a cheaper model for execution and mapping (where the plan already contains the reasoning).

**When to use which approach:**

| Scenario | Setting | Effect |
|----------|---------|--------|
| Non-Claude runtime, single model | `resolve_model_ids: "omit"` (installer default) | All agents use the runtime's default model |
| Non-Claude runtime, tiered models | `resolve_model_ids: "omit"` + `model_overrides` | Named agents use specific models, others use runtime default |
| Claude Code with OpenRouter/local provider | `model_profile: "inherit"` | All agents follow the session model |
| Claude Code with OpenRouter, tiered | `model_profile: "inherit"` + `model_overrides` | Named agents use specific models, others inherit |

**`resolve_model_ids` values:**

| Value | Behavior | Use When |
|-------|----------|----------|
| `false` (default) | Returns Claude aliases (`opus`, `sonnet`, `haiku`) | Claude Code with native Anthropic API |
| `true` | Maps aliases to full Claude model IDs (`claude-opus-4-8`) | Claude Code with API that requires full IDs |
| `"omit"` | Returns empty string (runtime picks its default) | Non-Claude runtimes (Codex, OpenCode, Antigravity CLI, Kilo) |

### Runtime-Aware Profiles (#2517)

When `runtime` is set, profile tiers (`opus`/`sonnet`/`haiku`) resolve to runtime-native model IDs instead of Claude aliases. This lets a single shared `.planning/config.json` work cleanly across Claude and Codex.

`resolve-model` JSON output includes `reasoning_effort` when the runtime tier resolved for the agent (after phase-type overrides) defines a `reasoning_effort`. Runtime adapters may pass that value to child-agent launch calls that support it; runtimes without explicit support omit it.

**Built-in tier maps:**

| Runtime | `opus` | `sonnet` | `haiku` | reasoning_effort |
|---------|--------|----------|---------|------------------|
| `claude` | `claude-opus-4-8` | `claude-sonnet-5` | `claude-haiku-4-5` | (not used) |
| `codex` | `gpt-5.6-sol` | `gpt-5.6-terra` | `gpt-5.6-luna` | `xhigh` / `medium` / `medium` |
| `qwen` | `qwen3-max-2026-01-23` | `qwen3-coder-plus` | `qwen3-coder-next` | (not used) |
| `opencode` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4-5` | (not used) |
| `copilot` | `claude-opus-4-8` | `claude-sonnet-5` | `claude-haiku-4-5` | (not used) |
| `hermes` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4-5` | (not used) |
| `kilo` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4-5` | (not used) |
| `pi` | `claude-opus-4-8` | `claude-sonnet-5` | `claude-haiku-4-5` | (not used) |
| Group B (`cline`, `cursor`, `windsurf` (alias: `devin-desktop`), `augment`, `trae`, `codebuddy`, `antigravity`) | (no built-in default — your runtime handles model selection) | | | |

> **How these model IDs are sourced.** The catalog (`bin/shared/model-catalog.json`) pins each runtime's tier defaults to that provider's current frontier IDs, and may intentionally carry forward-dated IDs ahead of a provider's public docs. To verify an ID is live before changing it, check the provider's own source/API — e.g. Codex: `codex debug models` or the OpenAI Codex models page; Qwen: Alibaba Model Studio model list. Only change an ID that the provider actually rejects — absence from documentation alone is not proof of invalidity.

**Codex example** — one config, tiered models, no large `model_overrides` block:

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

This resolves `gsd-planner` → `gpt-5.6-sol` (xhigh), `gsd-executor` → `gpt-5.6-terra` (medium), `gsd-codebase-mapper` → `gpt-5.6-luna` (medium). The Codex installer embeds `model = "..."` and `model_reasoning_effort = "..."` in each generated agent TOML.

**Claude example** — explicit opt-in resolves to full Claude IDs (no `resolve_model_ids: true` needed):

```json
{
  "runtime": "claude",
  "model_profile": "quality"
}
```

**Per-runtime overrides** — replace one or more tier defaults:

```json
{
  "runtime": "codex",
  "model_profile": "quality",
  "model_profile_overrides": {
    "codex": {
      "opus": "gpt-5-pro",
      "haiku": { "model": "gpt-5-nano", "reasoning_effort": "low" }
    }
  }
}
```

**Precedence (highest to lowest):**

1. `model_overrides[<agent>]` — explicit per-agent ID always wins.
2. **Runtime-aware tier resolution** (this section) — when `runtime` is set and profile is not `inherit`.
3. `resolve_model_ids: "omit"` — returns empty string when no `runtime` is set.
4. Claude-native default — `model_profile` tier as alias (current default).
5. `inherit` — propagates literal `inherit` for `Task(model="inherit")` semantics.

**Backwards compatibility.** Setups without `runtime` set see zero behavior change — every existing config continues to work identically. Codex installs that auto-set `resolve_model_ids: "omit"` continue to omit the model field unless the user opts in by setting `runtime: "codex"`.

**Unknown runtimes.** If `runtime` is set to a value with no built-in tier map and no `model_profile_overrides[<runtime>]`, GSD falls back to the Claude-alias safe default rather than emit a model ID the runtime cannot accept. To support a new runtime, populate `model_profile_overrides.<runtime>.{opus,sonnet,haiku}` with valid IDs.

### Profile Philosophy

| Profile | Philosophy | When to Use |
|---------|-----------|-------------|
| `quality` | Opus for all decision-making, Sonnet for verification | Quota available, critical architecture work |
| `balanced` | Opus for planning only, Sonnet for everything else | Normal development (default) |
| `budget` | Sonnet for code-writing, Haiku for research/verification | High-volume work, less critical phases |
| `inherit` | All agents use current session model | Dynamic model switching, **non-Anthropic providers** (OpenRouter, local models) |

---

## Model Policy Presets (`model_policy`) — Added in v1.42

> **[#49](https://github.com/open-gsd/gsd-core/issues/49)** — provider-neutral model policy config surface. Resolves before legacy `model_profile_overrides`.

`model_policy` provides a simpler, provider-neutral way to configure model tiers across runtimes. It is the preferred surface for non-Anthropic runtimes where `model_profile_overrides` would require manually knowing the right model IDs. Configure it via `/gsd:settings` → Section 8 (Model Policy).

### Known provider preset

Choose a provider and budget level via the settings workflow; GSD writes the canonical model IDs for that provider/budget combination:

```json
{
  "runtime": "codex",
  "model_policy": {
    "provider": "openai",
    "budget": "medium",
    "high":   "gpt-5.6-sol",
    "medium": "gpt-5.6-terra",
    "low":    "gpt-5.6-luna"
  }
}
```

Known providers: `openai`, `anthropic`, `anthropic-fable`, `google`, `qwen`. Budget levels: `high`, `medium`, `low`. Use `anthropic` to keep the Opus 4.8-backed Claude preset, or `anthropic-fable` to opt into Claude Fable 5 for high-budget top-tier routing. On the default `claude` runtime, policy-resolved model IDs are mapped to Claude Code agent aliases (for example `claude-fable-5` → `fable`); an ID with no corresponding Claude alias emits a warning and falls back to the configured tier.

For advanced per-runtime control, `runtime_tiers` accepts explicit entries using the internal profile tier names (`opus`, `sonnet`, `haiku`):

```json
{
  "runtime": "codex",
  "model_policy": {
    "provider": "openai",
    "runtime_tiers": {
      "codex": {
        "opus":   { "model": "gpt-5.6-sol",        "reasoning_effort": "high" },
        "sonnet": { "model": "gpt-5.6-terra",     "reasoning_effort": "medium" },
        "haiku":  { "model": "gpt-5.6-luna",      "reasoning_effort": "low" }
      }
    }
  }
}
```

### Generic provider (escape hatch)

Use `provider: "generic"` (or `"custom"`) for OpenRouter, LiteLLM, local gateways, or any runtime where you supply exact model IDs. GSD treats model IDs as opaque strings — no prefix inference, no provider-specific defaults:

```json
{
  "runtime": "opencode",
  "model_policy": {
    "provider": "generic",
    "high":   "openrouter/anthropic/claude-opus-4-5",
    "medium": "openrouter/anthropic/claude-sonnet-4-5",
    "low":    "openrouter/anthropic/claude-haiku-4-5"
  }
}
```

### Reasoning effort gating

`reasoning_effort` within a `runtime_tiers` entry is forwarded only to runtimes that declare support for it (currently: `codex`). Any runtime not on the allowlist receives the tier entry without the `reasoning_effort` field — it is silently stripped, never leaked.

### Precedence

`model_policy` resolution sits above `model_profile_overrides` in the resolver:

1. `model_overrides[<agent>]` — per-agent explicit ID (highest)
2. `model_policy.runtime_tiers[<runtime>][<tier>]` — explicit runtime/tier entry
3. `model_policy` flat `high`/`medium`/`low` keys — for `generic`/`custom` provider
4. `model_profile_overrides[<runtime>][<tier>]` — legacy per-runtime override
5. Built-in runtime catalog default
6. `model_profile` tier alias

**Backwards compatibility.** Configs without `model_policy` are unaffected. Existing `model_profile_overrides` blocks continue to work exactly as before.

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CONFIG_DIR` | Override default config directory (`~/.claude/`) |
| `GEMINI_API_KEY` | Detected by context monitor to switch hook event name |
| `GSD_AUDIT` | Set to `1` to enable the dispatch audit file (`.planning/.gsd-trace.jsonl`) |
| `GSD_AUDIT_ARGS` | Set to `1` to include command args in audit/error events (omitted by default) |
| `GSD_PROJECT` | Override project root for multi-project workspace support (v1.32) |
| `GSD_SKIP_SCHEMA_CHECK` | Skip schema drift detection during execute-phase (v1.31) |
| `GSD_ALLOW_SYMLINKED_DEST` | Set to `1` (or `true`) to permit install/update when `CLAUDE_CONFIG_DIR` (or any artifact-kind child like `skills/`, `hooks/`) is an **intentional, user-owned symlink** pointing outside the install root. v1.7.x write-confinement (ADR-1239 Phase B) refuses such layouts by default to prevent untrusted `destSubpath` traversal. Opt in only if you manage configHome via symlinked external dirs, multi-account config layouts (`~/.claude-personal`, `~/.claude-team`), or dotfiles-managed configHome (nix-darwin, etc.). Two refusals remain load-bearing even with opt-in: path-traversal in `destSubpath` (`../../etc`-style), and a symlink whose resolved target equals the install root itself (would let the prune pass wipe it). |
| `WSL_DISTRO_NAME` | Detected by installer for WSL path handling |

---

## Global Defaults

Save settings as global defaults for future projects:

**Location:** `~/.gsd/defaults.json`

When `/gsd-new-project` creates a new `config.json`, it reads global defaults and merges them as the starting configuration. Per-project settings always override globals.

---

## Observability

The Command Routing Hub emits a structured `DispatchEvent` after every dispatch — including capability commands (`graphify`, `intel`, `audit-uat`, `audit-open`) since #1646. Default behaviour is **silent on success** and **one structured JSON line to stderr on error**.

### Stderr error format

When a dispatch fails, one JSON line is emitted to stderr:

```json
{ "kind": "HandlerFailure", "traceId": "...", "command": "plan", "timestamp": "...", "message": "..." }
```

The `kind` field matches one of the Hub's error variants: `UnknownCommand`, `InvalidArgs`, `HandlerRefusal`, or `HandlerFailure`. Args are omitted by default (privacy); see `GSD_AUDIT_ARGS` below.

### Audit trail (opt-in)

Enable the append-only audit file to record every dispatch (success and error):

**Via environment variable:**
```bash
GSD_AUDIT=1 gsd plan
```

**Via config (`config.audit.enabled`):**
```json
{
  "audit": {
    "enabled": true
  }
}
```

**Audit file location:** `.planning/.gsd-trace.jsonl` (gitignored)

Each line is a full `DispatchEvent` JSON object containing both `traceId` (a unique UUID v4 per dispatch) and `parentTraceId` (present when a caller passes `req.parentTraceId` into `Hub.dispatch`). A future init-composer (Phase 2) will wire `parentTraceId` automatically so that all child dispatches of a single top-level invocation share a common parent; until then, leaf dispatches emit `parentTraceId: undefined`. You can correlate child events to a parent by filtering the audit file on `parentTraceId === <rootTraceId>`. The file is append-only and never truncated; rotate or remove it manually when desired. `parentTraceId` must be a canonical UUID v4 (RFC 4122, format `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`); values that do not match this format are silently dropped from the emitted event and will not appear in audit output.

### Args redaction

By default, command args are **omitted** from all emitted events (both stderr errors and the audit file). To include args verbatim:

```bash
GSD_AUDIT_ARGS=1 GSD_AUDIT=1 gsd plan --tdd
```

`GSD_AUDIT_ARGS` applies to both the stderr error line and the audit file simultaneously.

---

## Related

- [Commands](COMMANDS.md)
- [Configure model profiles](how-to/configure-model-profiles.md)
- [STATE.md schema](reference/state-md.md)
- [Docs index](README.md)
