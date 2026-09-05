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
  "agent_tools": {},
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
    "code_review_point": "execute:post",
    "code_review_depth": "standard",
    "code_review_depth_overrides": [],
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
    "models": {},
    "parallel_lanes": false
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

## Agent tool grants

`agent_tools` is an opt-in, install-time addition to the tools already declared by shipped
agents. Put defaults shared by your projects in `~/.gsd/defaults.json` and project-specific
choices in the nearest `.planning/config.json`:

```json
{
  "agent_tools": {
    "*": ["mcp__docs__search"],
    "gsd-executor": ["WebFetch"]
  }
}
```

Selectors are agent names; `"*"` applies to every agent. For an agent, GSD appends wildcard
grants before its named grants, after the agent's existing tools, in first-seen order. Re-running
the same install is idempotent: it does not add another copy of an existing grant.

Project configuration replaces only selectors it names. For example, this project setting keeps
the global wildcard but replaces the global `gsd-executor` list:

```json
{
  "agent_tools": {
    "gsd-executor": ["WebSearch"]
  }
}
```

Each selector value must be an array. A usable entry is a single tool token which, after trimming,
is non-empty and contains no whitespace, comma, `#`, quote, U+0000–U+001F, U+007F–U+009F,
U+2028, or U+2029, and does not end with `:`.
Invalid entries are ignored. An explicitly present but invalid project selector resolves to no
grant for that selector; it does not restore the global value. A present but invalid project
`agent_tools` container suppresses all global grants. Inline grants remain plain comma-separated
tool names as required by Claude; block-sequence entries are YAML-quoted. Agents without a
`tools:` key inherit the runtime's default tool surface, so GSD leaves those agents unchanged.

A `--global` install still discovers the nearest `.planning/config.json` from the current working
directory, so `gsd install <runtime> --global` run from inside a project applies that project's
`agent_tools` selectors to the global install too — not just to that project's own local install.

Run `gsd install <runtime>` again after changing `agent_tools`; installed artifacts do not read
configuration at agent-spawn time. The shared staging path gives Claude, Codex, and Qwen their
existing host representations. Kimi maps supported canonical tools and continues to omit MCP
grants with its existing diagnostic. ZCode continues to omit `mcp__*` entries because its
dispatcher treats them as required MCP servers, and OpenCode keeps its converter-owned tools
omission. These are converter-specific output rules, not a claim that every runtime authorizes a
tool identically. Codex custom agents inherit the parent session's MCP servers natively;
`agent_tools` does not encode an allowlist into their TOML or widen `sandbox_mode`, which remains
derived from the shipped agent declaration.

## Core Settings

| Setting | Type | Options | Default | Description |
|---------|------|---------|---------|-------------|
| `mode` | enum | `interactive`, `yolo` | `interactive` | `yolo` auto-approves decisions; `interactive` confirms at each step |
| `granularity` | enum | `coarse`, `standard`, `fine` | `standard` | Controls phase count: `coarse` (2-4), `standard` (4-6), `fine` (6-10) |
| `agent_tools.<selector>` | string[] | tool names meeting the [agent tool grant validation rules](#agent-tool-grants) | (none) | Additive install-time grants for `"*"` or a named agent. A project selector replaces the corresponding global selector; wildcard grants precede named grants. Re-run `gsd install <runtime>` after changing it. |
| `model_profile` | enum | `quality`, `balanced`, `budget`, `adaptive`, `inherit` | `balanced` | Model tier for each agent (see [Model Profiles](#model-profiles)). `adaptive` was added per [#1713](https://github.com/open-gsd/gsd-core/issues/1713) / [#1806](https://github.com/open-gsd/gsd-core/issues/1806) and resolves the same way as the other tiers under runtime-aware profiles. |
| `runtime` | string | `claude`, `codex`, or any string | (none) | Active runtime for [runtime-aware profile resolution](#runtime-aware-profiles-2517). When set, profile tiers (opus/sonnet/haiku) resolve to runtime-native model IDs. The resolved ID is embedded into each agent's static frontmatter at install time on `opencode` (whose `spawn_agent` interface does not accept an inline `model` parameter, so editing `model_overrides` requires re-running `gsd install <runtime>` to take effect — see [Per-Agent Overrides](#per-agent-overrides)); other runtimes consume the resolver at spawn time. **Codex keeps profile-resolved models out of static TOML and transports them conditionally at spawn time.** A Codex skill passes the resolved `model` and `reasoning_effort` only when the visible `spawn_agent` schema advertises each field; otherwise it omits that field and inherits the session/static agent configuration. Explicit real-Codex IDs in `model_overrides` (for example `"gpt-5.6-sol"`) are still written into `.toml` as a fallback. When unset (default), model resolution is unchanged from prior versions — but the runtime GSD *reports* (`agent_runtime`) then falls through to [host detection](how-to/control-the-reported-host-runtime.md), which can resolve `codex` from Codex's own session environment. Detection affects reporting and the agent-installation check only; it never feeds tier resolution, which still reads this key alone. Added in v1.39; Codex static posture changed in v1.11; reporting-only host detection added in v1.11 |
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
| `phase_id_convention` | enum | `"milestone-prefixed"`, `"bracket"`, `null` | `null` | Phase ID naming convention. `null` = legacy numeric IDs (`Phase 1`, `Phase 2`). `"milestone-prefixed"` = globally unique IDs that encode the enclosing milestone (`Phase 1-01`, `Phase 1-02`). Run `gsd-tools roadmap upgrade --convention milestone-prefixed` to migrate an existing ROADMAP.md. `"bracket"` = IDs that carry the milestone in a bracket ahead of the phase number — heading `### [GSD.02] 05: Name`, directory `GSD.02-05-name` — per [ADR-612](adr/612-bracket-phase-id-convention.md). **`"bracket"` currently affects the READ path only:** `roadmap analyze` / `roadmap get-phase`, the W005/W006/W007 phase checks, `validate health` (including an advisory W021 — a bracket phase's milestone disagreeing with its enclosing section, or a phase heading still spelled in legacy form that has not yet been migrated to bracket form), and both `total_phases` derivations recognise the bracket spelling once it is set. There is no bracket migrator and no bracket emit yet, so set it only on a project whose ROADMAP.md already uses that spelling; a project on any other value compiles the same patterns it did before and is unaffected. **What opting in costs:** on a bracket repo a heading whose bracket is followed directly by a digit is read as a phase heading, so shapes that are legal prose headings on any other convention — `### [RFC.2119] 5:`, `### [v1.0] 2024:`, `### [ADR.612] 3:` — are claimed as phases and will move `phase_count`, `total_phases` and W006. A bracket repo cedes that heading shape; that is the trade the opt-in buys, and it is why the widened read is selected at construction time from this value rather than applied everywhere ([#2761](https://github.com/open-gsd/gsd-core/issues/2761)). |
| `response_language` | string | language code | (none) | Language for agent responses (e.g., `"pt"`, `"ko"`, `"ja"`). Propagates to all spawned agents for cross-phase language consistency. Added in v1.32. UAT checkpoint frames (`/gsd-verify-work`) render a localized banner/instruction for English, Spanish, French, German, Portuguese, Japanese, Chinese, Korean, Italian, Dutch, Polish, Russian, Ukrainian, Turkish, Hindi, Arabic, Vietnamese, and Indonesian (endonyms and ISO codes also accepted); any other value falls back to the English frame. One deliberate exception: the `spec-phase` edge-completeness probe is fed an English translation of each requirement's text, because its shape cues are English-only — the SPEC itself stays in this language. See [Spec-Phase Edge-Completeness Probe](FEATURES.md#144-spec-phase-edge-completeness-probe). Every workflow is required to carry a directive honouring this setting, including for inter-tool narration; authors add or fix one per [response-language coverage](contributing/response-language-coverage.md), and `npm run lint:response-language` enforces it. |
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

`review.models.<cli>` maps a reviewer flavor to a bare model id, which is injected into the CLI's own model flag (`--model`, `-m`, …) when the reviewer is invoked.

The key suffix is **not** always the lane slug. Each lane declares the config key it reads, and one shipped lane already differs: the Antigravity lane's slug is `antigravity` but its key is `review.models.agy`, after the CLI's own name. Consult the table below rather than deriving the key from the flag.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `review.models.claude` | string | (session model) | Model id for Claude-flavored review. Defaults to the session model when unset |
| `review.models.codex` | string | `null` | Model id for Codex review (injected into --model), e.g. `"gpt-5"` |
| `review.models.gemini` | string | `null` | Model id for Gemini review (injected into -m), e.g. `"gemini-2.5-pro"` |
| `review.models.opencode` | string | `null` | Model id for OpenCode review (injected into --model), e.g. `"claude-sonnet-4"` |
| `review.models.cursor` | string | `null` | Model id for Cursor review (injected into --model), e.g. `"cursor-grok-4.5-high"` |
| `review.models.kimi-code` | string | `null` | Model id for Kimi Code review (injected into -m) |

### Resolved model recording (#2295)

Every `/gsd-review` run records the resolved model per reviewer in the `REVIEWS.md` frontmatter as `models:` and `model_sources:`, whether or not the lane was pinned via the keys above.

| `model_sources` value | Meaning |
|---|---|
| `pinned` | `review.models.<slug>` (or an ADR-1517 reviewer-instance `--model`) that really reached the invocation |
| `served` | An OpenAI-compatible server echoed the model it actually ran. Most authoritative |
| `requested` | openai-http: discovered from `/v1/models`, or the lane's declared `fallbackModel`; the server did not echo one |
| `banner` | The CLI's own startup banner named it. File-output lanes only (`codex` today) |
| `transcript` | The lane handler's own on-disk session log named it (`agy`'s `transcript_full.jsonl`) |
| `unknown` | Nothing recoverable |

A `models:` value reads `unknown` if and only if its `model_sources:` entry is `unknown`.

When GSD applies a reasoning effort to a lane, the recorded value carries it as a
`(reasoning=<level>)` suffix (for example `gpt-5.6-sol (reasoning=high)`) — the level is GSD's
own resolved effort, not the CLI's default.

**Ownership.** These keys are owned by their reviewer-lane capabilities rather than the central
config schema — `review.models.ollama` belongs to the `ollama` capability, `review.ollama_host`
to the same, and so on. Key names and existing `.planning/config.json` files are unchanged; only
which schema validates them moved.

One consequence follows: `<cli>` must now name a **declared reviewer lane**. Previously any slug
matching `[a-zA-Z0-9_-]+` was accepted, so a typo or a key left over from a removed reviewer
validated silently and was never read. Such a key is now rejected by `config-set`. The declared
lanes are `gemini`, `claude`, `codex`, `opencode`, `cursor`, `agy` (the Antigravity lane — its key suffix is
the CLI's own name, not the lane slug), `ollama`, `lm_studio` and `llama_cpp`.

The same applies to `review.max_prompt_tokens_per_reviewer.<slug>`. `review.max_prompt_tokens`
(the global default), `review.default_reviewers` and `review.reviewer_instances` describe policy
across lanes rather than one lane's behavior, so they remain central and are unaffected.

### Reviewer lane timeouts (`review.timeouts.*`, #3274)

Nine of the twelve declared reviewer lanes accept an outer wall-clock timeout override, federated
per-lane exactly like `review.max_prompt_tokens_per_reviewer.<slug>` above — the key is owned by
that lane's own capability manifest, not a central schema. Keys are seconds: `review.timeouts.gemini`,
`review.timeouts.claude`, `review.timeouts.codex`, `review.timeouts.opencode`,
`review.timeouts.antigravity`, `review.timeouts.kimi-code`, `review.timeouts.ollama`,
`review.timeouts.lm_studio`, `review.timeouts.llama_cpp`. Unset (or `0`/negative/non-numeric)
falls back to that lane's built-in floor. For the `antigravity` lane specifically, this value also
derives its native `agy --print-timeout` flag (roughly 60 seconds under the configured outer
value), so raising `review.timeouts.antigravity` raises both bounds together — this is how to fix
a reviewer lane being killed mid-run on a large plan set: `gsd config-set review.timeouts.antigravity 900`.
Two lanes — `qwen` and `coderabbit` — take neither a model flag nor a host and do not federate a
timeout key either, matching the same narrow key-ownership invariant their `review.models.*`/host
keys already follow (each owns only its own prompt-budget key). `cursor` gained a model flag
(`review.models.cursor`, #3653) but still owns no federated timeout key of its own.

### Reviewer lane reasoning effort (`review.effort.*`, #4255)

The three lanes that can carry a reasoning level on their command line — `codex`, `claude`,
`opencode` — federate a `review.effort.<slug>` key, owned by that lane's capability manifest like
its model and timeout keys. Accepted values are the usual effort levels (`minimal`, `low`,
`medium`, `high`, `xhigh`, `max`) plus `inherit`.

**Resolution order for a lane's effort, highest first:**

| # | Source | Result |
|---|---|---|
| 1 | `review.effort.<slug>` | the level you set, rendered in the host's own effort syntax and clamped to what that host supports |
| 2 | the lane's declared review default | `high` on all three lanes today |
| 3 | nothing declared | **no effort argument is emitted** — the reviewer CLI's own configuration decides |

Row 1 is the level you asked for, not always the level that runs: each host clamps to its own
supported set. Verified against the shipped catalog, `minimal` reaches Codex and Claude as `low`
while OpenCode takes it as-is; every other level passes through on all three. `REVIEWS.md` records
the level that actually ran, not the one requested.

`inherit` selects row 3 explicitly: use it when you want your own `~/.codex/config.toml` (or the
equivalent for another CLI) to be the authority, because the argument GSD renders is a
command-line config override and beats that file for the invocation. A value that is not a
recognized level falls back to row 2 rather than being forwarded, since an argument the CLI
rejects kills the lane outright.

Before #4255 there was no review-specific source at all: every lane's level came from the
`gsd-plan-checker` agent's installed frontmatter — `low` under every shipped model profile — so a
prompt-fed, source-grounded review ran at the level chosen for a fast structural verifier, and a
large plan set could come back as an empty lane. Effort is now a property of the review.

The lanes with no effort channel (`gemini`, `cursor`, `antigravity`, `qwen`, `coderabbit`,
`kimi-code`, `ollama`, `lm_studio`, `llama_cpp`) federate no key and emit no argument, matching the
same narrow key-ownership invariant their model and timeout keys already follow.

### Reviewer defaults for `/gsd-review`

Use `review.default_reviewers` to scope the no-flag `/gsd-review` run to a subset of detected reviewers.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `review.default_reviewers` | string[] \| null | `null` (all detected reviewers) | Optional default subset for no-flag `/gsd-review`, e.g. `["gemini","codex"]`. Entries may be built-in reviewer slugs or configured `review.reviewer_instances` names. Precedence is: explicit reviewer flags > `--all` > `review.default_reviewers` > all detected. Unknown slugs are ignored with a warning when no instances are configured; with `review.reviewer_instances` present, unknown entries are hard errors to catch typoed instance names. Known-but-undetected slugs are ignored with an info note; empty arrays are rejected by `config-set`. This leniency is specific to the configured default: a reviewer named by an explicit CLI flag that cannot run is an error, not an info note. |

Example:

```json
{
  "review": {
    "default_reviewers": ["gemini", "codex"]
  }
}
```

### Parallel reviewer lanes for `/gsd-review` (#3034)

By default `/gsd-review` invokes reviewer lanes one at a time. That is deliberate: concurrent
invocation can trip provider rate limits, and a lane dropped to a rate limit is a review that
silently lost an opinion. A pass with several reviewers therefore costs roughly the sum of their
runtimes.

The lanes within one review pass have no data dependency on one another — they all inspect the
same immutable plan snapshot. If your providers can accept concurrent requests (independent
accounts, generous quota, or local model servers), you can opt in:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `review.parallel_lanes` | boolean | `false` | When `true`, dispatch independent selected reviewer lanes concurrently within a single `/gsd-review` pass. All lanes are joined before `REVIEWS.md` and consensus are rendered. |

```bash
gsd config-set review.parallel_lanes true
/gsd-plan-review-convergence 3 --all
```

```json
{
  "review": {
    "parallel_lanes": true
  }
}
```

**What this does not change.** Convergence cycles stay sequential — `review → replan → re-review`
has a real data dependency, so enabling this speeds up each pass, not the number of passes.
Per-lane timeouts, prompt budgets, diagnostic stubs, explicit-lane failure, trust/egress checks and
result-file layout are all unchanged.

**Before you enable it.** Every selected lane dispatches at once — there is no concurrency bound.
Selecting eleven lanes issues eleven concurrent requests. Two reviewer instances backed by the same
adapter (see below) also dispatch concurrently against that one provider, which is the most likely
way to hit a limit. If a lane does get rate-limited it fails the way any other failing lane does:
a diagnostic stub with captured stderr, never a silently dropped review.

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
| `workflow.assumption_delta` | boolean | `true` | Advisory architecture checkpoint during planning. When a phase makes something **plural, optional, or chosen** that used to be **singular, required, or derived** (e.g. a second auth method, a required field becoming optional, a constant becoming a parameter), the planner is prompted to re-ask whether the primary key / identity model still names the right thing (promote the new general representation vs. add it alongside). Non-blocking; fires only on a detected signal. Bare "or" is intentionally excluded (prose false-positives). Inspect a phase with `gsd_run query assumption-delta scan <phase>`. Added in #1561. A phase section that cannot be resolved returns `{"skipped":true,"reason":"phase_unresolved"}` rather than a fabricated `detected:false` (#3909) |
| `workflow.ui_review` | boolean | `true` | Run visual quality audit (`/gsd-ui-review`) after phase execution in autonomous mode. When `false`, the UI audit step is skipped. |
| `workflow.live_dom_uat` | boolean | `false` | **Default-off.** Enable live-DOM verification (#2856). When `true`, a `gsd-dom-verifier` step runs after each execution wave and writes `{phase}-DOM-VERIFY.md`, and the orchestrator's automated UI verification will additionally consider `mcp__chrome-devtools__*` / `mcp__claude-in-chrome__*` when present. Browser reach is confined to `gsd-dom-verifier` — `gsd-executor`'s tool surface is unchanged in every configuration. Presence of a browser MCP server is **not** sufficient on its own: a server configured for unrelated work is never driven unless this key is on. The pre-existing `mcp__playwright__*` path is unaffected by this key. Note `chrome-devtools-mcp` holds an exclusive browser-profile lock, so concurrent waves need `--isolated` on **your** MCP server registration — GSD cannot pass it. See [Enable live-DOM verification](how-to/enable-live-dom-verification.md). |
| `workflow.node_repair` | boolean | `true` | Autonomous task repair on verification failure |
| `workflow.node_repair_budget` | number | `2` | Max repair attempts per failed task |
| `workflow.smart_zone_tokens` | number | `100000` | Smart-zone token budget for phase-effort estimation (#2630, [ADR-2629](adr/2629-phase-effort-estimation-calibration.md)). A phase whose estimate exceeds this is flagged with a split recommendation — **advisory only, never a block**. This is a *policy default, not a benchmark constant*: LLM output quality degrades before the advertised context window is full, but the effective ceiling is model-, task-, and distractor-dependent, so no universal number exists. Lower it for models that degrade early; the estimate-vs-actual calibration loop corrects the figure per project over time. Must be a positive integer. |
| `workflow.research_before_questions` | boolean | `false` | Run research before discussion questions instead of after |
| `workflow.discuss_mode` | string | `'discuss'` | Controls how `/gsd-discuss-phase` gathers context. `'discuss'` (default) asks questions one-by-one. `'assumptions'` reads the codebase first, generates structured assumptions with confidence levels, and only asks you to correct what's wrong. Added in v1.28 |
| `workflow.max_discuss_passes` | number | `3` | Maximum number of question rounds in discuss-phase before the workflow stops asking. Useful in headless/auto mode to prevent infinite discussion loops. |
| `workflow.skip_discuss` | boolean | `false` | When `true`, `/gsd-autonomous` bypasses the discuss-phase entirely, writing minimal CONTEXT.md from the ROADMAP phase goal. Useful for projects where developer preferences are fully captured in PROJECT.md/REQUIREMENTS.md. Added in v1.28 |
| `workflow.text_mode` | boolean | `false` | Replaces AskUserQuestion TUI menus with plain-text numbered lists. Required for Claude Code remote sessions (`/rc` mode) where TUI menus don't render. Can also be set per-session with `--text` flag on discuss-phase. Added in v1.28 |
| `workflow.use_worktrees` | boolean | `true` | When `false`, disables git worktree isolation for parallel execution. Users who prefer sequential execution or whose environment does not support worktrees can disable this. Added in v1.31. **Branch-divergence note:** when your branch has diverged from `origin/HEAD`, GSD auto-degrades to sequential and prints a warning. See [`worktree.baseRef`](#worktree-settings) to restore parallel execution on a diverged branch. **Per-runtime note:** whether this key can be honored depends on the runtime's declared `dispatch.isolation` capability, not on its name (#2584). Runtimes whose own harness isolates each executor (**Claude Code**, **Cursor**) run parallel worktrees natively; runtimes exposing a headless exec with an explicit working directory (**Codex**, **OpenCode**, **Kimi**, **Kimi Code**) get worktrees GSD itself creates and merges — where a dispatch site can only drive the harness model, those hosts degrade to sequential with a warning rather than aborting. Every other runtime declares no isolation primitive, and forcing `use_worktrees: true` there still fails closed before any executor dispatch. `/gsd-health` reports such a value as warning `W025` (#2486). **Default on a non-Claude install:** if a worktree-capable non-Claude host is not isolating as described above, check whether the install stamped this key's default to `false` and set an explicit `use_worktrees: true`. See [Executor isolation per runtime](#executor-isolation-per-runtime). |
| `workflow.agent_hint_routing` | boolean | `true` | Per-plan specialist executor routing (#1689). When `true`, a plan whose `agent_hint:` frontmatter names a subagent that resolves on the active runtime is dispatched to that specialist instead of `gsd-executor`. Default `true` — a no-op for plans without `agent_hint:`, so existing dispatch is unchanged. Set `false` to disable. See [PLAN.md `agent_hint`](reference/plan-md.md#per-plan-executor-routing). |
| `workflow.worktree_skip_hooks` | boolean | `false` | When `true`, executor agents in worktree mode pass `--no-verify` (skipping pre-commit hooks) and post-wave hook validation runs against the merged result instead. Opt-in escape hatch for projects whose hooks cannot run in agent worktrees. Default `false` runs hooks on every commit (#2924). |
| `workflow.code_review` | boolean | `true` | Enable `/gsd-code-review` and `/gsd-code-review --fix` commands. When `false`, the commands exit with a configuration gate message. Added in v1.34 |
| `workflow.code_review_point` | string | `execute:post` | Loop point at which the code-review capability's step registers: `execute:post` reviews once, after every wave in a phase has landed (default — unchanged behavior); `execute:wave:post` reviews once per completed wave instead, scoped to what changed since the phase's prior review (the whole phase's diff on the first wave, each subsequent wave's own diff thereafter). Manual `/gsd-code-review <phase>` invocation is unaffected by this key — it is gated by `workflow.code_review` alone and runs regardless of which point is configured. `/gsd-autonomous` and `/gsd-quick` have no wave granularity of their own, so setting this to `execute:wave:post` means code review does not run automatically inside those two flows (consistent with how every other `execute:wave:post`-only capability already behaves for them). Added in #3661 |
| `workflow.code_review_depth` | string | `standard` | Default review depth for `/gsd-code-review`: `quick` (pattern-matching only), `standard` (per-file analysis), or `deep` (cross-file with import graphs). Can be overridden per-run with `--depth=`. Added in v1.34 |
| `workflow.code_review_depth_overrides` | array | `[]` | Ordered list of `{ paths: string[], depth }` rules that escalate `/gsd-code-review` depth for specific directories, e.g. `[{ "paths": ["src/auth"], "depth": "deep" }]`. Each rule's `paths` are matched against the review's changed-file set by whole-segment directory-path prefix (`src/auth` matches `src/auth/token.ts`, never `src/authfoo/x.ts` or `docs/src/auth/x.ts`); matching is case-sensitive, following git. Glob syntax (`*`, `?`) is a configuration error, not sugar for a prefix. One matched file escalates the entire review — depth is not applied per file. Resolution order: `--depth=` flag → strongest matching rule → `workflow.code_review_depth` → `standard`; a matching rule wins even when its tier is weaker than the global default. A malformed rule (bad `depth`, glob syntax, absolute path, `..` segment, empty path, non-array `overrides`, non-object rule, malformed `paths`) is a configuration error and the review halts rather than falling back silently. The resolved depth and the matching rule are printed in the review output. Added in #2554 |
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
| `workflow.context_guard_mode` | string | `'warn'` | Context exhaustion guard for `execute-phase`. Before each wave, the orchestrator self-assesses context pressure using the degradation signals defined in `context-budget.md`. `'warn'` (default) emits a warning and recommends `/gsd-pause-work` when POOR tier (70%+) is detected. `'auto'` automatically invokes `/gsd-pause-work` before the next wave. `'off'` disables the guard. Set via: `gsd config-set workflow.context_guard_mode auto`. Added in #1452. |
| `workflow.cross_ai_execution` | boolean | `false` | Delegate phase execution to an external AI CLI instead of spawning local executor agents. Useful for leveraging a different model's strengths for specific phases. Added in v1.36 |
| `workflow.cross_ai_command` | string | (none) | Shell command template for cross-AI execution. Receives the phase prompt via stdin. Must produce SUMMARY.md-compatible output. Required when `cross_ai_execution` is `true`. Added in v1.36 |
| `workflow.cross_ai_timeout` | number | `300` | Timeout in seconds for cross-AI execution commands. Prevents runaway external processes. Added in v1.36 |
| `workflow.test_gate_timeout` | number | `600` | Wall-clock timeout (seconds) for a verification test gate; a watch-mode runner (vitest/jest) that never exits is aborted after this budget instead of hanging the orchestrator (#1857) |
| `workflow.ai_integration_phase` | boolean | `true` | Enable the `/gsd-ai-integration-phase` command. When `false`, the command exits with a configuration gate message |
| `workflow.api_coverage_gate` | boolean | `true` | Require an explicit API-coverage decision before a phase that integrates an external API/SDK/service can seal. At `plan:pre` the planner is prompted to produce a `COVERAGE.md` matrix (full coverage by default, every opt-out reasoned); at `verify:pre` a blocking gate fails the seal unless the matrix is complete. Independent of `ai_integration_phase` (#1562). A phase whose scope cannot be established at all (no plan body and no roadmap section) is held rather than passed, reporting `scope_unavailable` — see [Resolve a skipped capability probe](how-to/resolve-a-skipped-capability-probe.md) (#3909) |
| `workflow.auto_prune_state` | boolean | `false` | When `true`, automatically prune stale entries from STATE.md at phase boundaries instead of prompting |
| `workflow.pattern_mapper` | boolean | `true` | Run the `gsd-pattern-mapper` agent between research and planning to map new files to existing codebase analogs |
| `workflow.subagent_timeout` | number | `300000` | Timeout in milliseconds for parallel subagent tasks (e.g. codebase mapping). Increase for large codebases or slower models. Default: 300000 (5 minutes) |
| `executor.stall_detect_interval_minutes` | number | `5` | Minutes between executor stall checks while an executor agent is active. The execute-phase orchestrator uses this cadence to inspect recent commits and avoid waiting forever on a silent agent. |
| `executor.stall_threshold_minutes` | number | `10` | Minutes without executor completion or expected-branch commit activity before execute-phase offers recovery choices for a possible stalled executor. |
| `planner.stall_detect_interval_minutes` | number | `5` | Minutes between planner/plan-checker stall checks while a planner or plan-checker agent is active. The plan-phase orchestrator uses this cadence to inspect on-disk `*-PLAN.md` activity and avoid waiting forever on a silent agent (#2650). |
| `planner.stall_threshold_minutes` | number | `10` | Minutes without a completion marker or fresh on-disk plan activity before plan-phase automatically surfaces the accept-plans/retry/stop recovery choice for a possible stalled planner or plan-checker (#2650). |
| `workflow.inline_plan_threshold` | number | `3` | Maximum number of tasks in a phase before the planner generates a separate PLAN.md file instead of inlining tasks in the prompt |
| `workflow.drift_threshold` | number | `3` | Minimum number of new structural elements (new directories, barrel exports, migrations, route modules) before the codebase-drift gate takes action. The gate runs at two points: `plan:pre` (before `/gsd-plan-phase` plans — **non-blocking, warn-only**, so plans are authored against a fresh STRUCTURE.md) and `execute:wave:post` (after `/gsd-execute-phase` — honors `workflow.drift_action`). See [#2003](https://github.com/open-gsd/gsd-core/issues/2003). Added in v1.39 |
| `workflow.drift_action` | string | `warn` | What to do when `workflow.drift_threshold` is exceeded **at `execute:wave:post`** (after `/gsd-execute-phase`). `warn` prints a message suggesting `/gsd-map-codebase --paths …`; `auto-remap` spawns `gsd-codebase-mapper` scoped to the affected paths. The `plan:pre` pre-check is always warn-only regardless of this setting — it never auto-spawns the mapper at plan entry. Added in v1.39 |
| `workflow.plan_drift_precheck` | boolean | `true` | Enable the non-blocking codebase-drift pre-check at `plan:pre`, before `/gsd-plan-phase` spawns the planner. Surfaces a stale STRUCTURE.md (drift over `workflow.drift_threshold`) as a warn-only advisory pointing to `/gsd-map-codebase`; never blocks planning, never spawns the mapper. Separate from the `execute:wave:post` gates so autonomous/CI runs can silence the plan-time advisory while keeping execute-time drift detection on. Added in v1.6.0. See [#1592](https://github.com/open-gsd/gsd-core/issues/1592). |
| `workflow.context_drift_precheck` | boolean | `true` | Enable the non-blocking context-drift pre-check at `plan:pre`, before `/gsd-plan-phase` reuses an existing RESEARCH.md/PATTERNS.md/VALIDATION.md/SPEC.md. Compares each artifact's effective last-changed time (git commit time, falling back to mtime for uncommitted edits) against CONTEXT.md's own; an artifact that predates CONTEXT.md's newest decision was derived from a premise that has since changed. Warn-only by default (see `workflow.context_drift_action`); never blocks planning on its own. See [#3348](https://github.com/open-gsd/gsd-core/issues/3348). |
| `workflow.context_drift_action` | string | `warn` | What to do when the context-drift gate finds a stale upstream artifact. `warn` prints an advisory naming the stale artifacts and how to regenerate them; `block` halts `/gsd-plan-phase` until the artifacts are regenerated or the check is disabled. See [#3348](https://github.com/open-gsd/gsd-core/issues/3348). |
| `workflow.build_command` | string | (none) | Shell command to build the project in the post-merge build gate (Step A of step 5.6 in execute-phase). When unset, the gate auto-detects: Xcode (`.xcodeproj` present) → `xcodebuild build`, `Makefile` with `build:` target → `make build`, Justfile → `just build`, `Cargo.toml` → `cargo build`, `go.mod` → `go build ./...`, Python → `python -m py_compile`, `package.json` with `build` script → `npm run build`. Runs with a 5-minute timeout; failure increments `WAVE_FAILURE_COUNT`. Added in v1.39 |
| `workflow.test_command` | string | (none) | Shell command to run the project's test suite in the post-merge test gate (Step B of step 5.6 in execute-phase) and the regression gate. When unset, the gate auto-detects: Xcode (`.xcodeproj` present) → `xcodebuild test`, `Makefile` with `test:` target → `make test`, Justfile → `just test`, `package.json` → `npm test`, `Cargo.toml` → `cargo test`, `go.mod` → `go test ./...`, Python → `python -m pytest`. Runs with a 5-minute timeout; failure increments `WAVE_FAILURE_COUNT`. Added in v1.39 |

## Worktree Settings

> **File:** `.claude/settings.local.json` — not `.planning/config.json`. Unlike all other keys in this reference, `worktree.*` settings live in the Claude Code runtime settings file. Fresh installs and upgrades auto-set `worktree.baseRef: "head"` there (no-clobber) when `workflow.use_worktrees` is enabled. The key can also be set via `gsd-tools worktree set-baseref`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `worktree.baseRef` | string | (unset) | Controls which ref the worktree-based parallel executor uses as the base when creating new phase/wave worktrees. When unset, the executor bases new worktrees on the repository default branch (`origin/HEAD`); if the current branch has diverged, execute-phase auto-degrades to sequential execution rather than halting (as of v1.4.0). Set to `"head"` to base new worktrees on the local `HEAD` instead. **Where it applies (#48/#3659):** honored on runtimes where GSD itself creates the worktrees (Codex, OpenCode, Kimi, Kimi Code) — there it restores wave-based parallel execution on diverged branches. On harness-isolated runtimes (Claude Code, Cursor) the harness does **not** read this setting (verified 5/5 in #48; upstream claude-code#44965): the base check compares against the real fork base regardless and auto-degrades to sequential execution before dispatch when `HEAD` has diverged, so the exit-42 halt is a last-resort backstop rather than the only guard. See [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md). |

### Executor isolation per runtime

When `/gsd-execute-phase` runs a wave containing several independent plans, it can execute them concurrently — but only if the runtime can keep each executor isolated. Two executors sharing one checkout race on files, git state, hooks, and `.planning/`. Which runtimes can do this is a **declared capability** (`dispatch.isolation`), not a hardcoded list, so the scheduler behaves the same way for every host that declares the same value.

| Isolation | Runtimes | What happens |
|---|---|---|
| `harness-worktree` | `claude`, `cursor` | The runtime's own harness creates and binds a git worktree per executor. GSD passes the host's isolation flag and runs no git itself. |
| `orchestrator-worktree` | `codex`, `opencode`, `kimi`, `kimi-code` | The runtime has no harness-native isolation, but exposes a headless exec that accepts a working directory. **GSD** creates the worktree, spawns each executor into it, then validates and merges the result. All git operations are performed by GSD, never by the sandboxed executor. |
| `none` | every other runtime | No isolation primitive — plans in a wave run sequentially. Setting `workflow.use_worktrees: true` here fails closed before any executor is dispatched. |

You do not configure this directly: set `workflow.use_worktrees` and GSD negotiates the rest. `use_worktrees: false` forces sequential execution on **every** runtime, including the ones that support isolation. An unknown or undeclared isolation value always degrades to sequential — GSD never guesses its way into an unisolated parallel run.

To see what your current runtime negotiated:

```bash
gsd-tools query inspect-dispatch-isolation --json
```

(`inspect-dispatch-isolation` is the read-only form. The `dispatch-isolation` query is the executor-dispatch resolver: it records its decision to the isolation sentinel as a deliberate side effect, so it is not an inspection command.)

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
| `planning.pr_strict` | boolean | `false` | Filter mode for [`/gsd-pr-branch`](COMMANDS.md#gsd-pr-branch). `false` — the generated PR branch keeps structural planning state (`STATE.md`, `ROADMAP.md`, `MILESTONES.md`, `PROJECT.md`, `REQUIREMENTS.md`, `milestones/**`) and drops the transient subdirectories. `true` — every `.planning/` path is dropped, structural files included, and a commit is carried over only when it touches at least one file outside `.planning/`. Applies to the root repository's PR branch only; `planning.sub_repos` companion branches are unaffected |
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

#### Caveat: `.gitignore` does not affect files git already tracks

Adding `.planning/` to `.gitignore` stops git from picking up **new** files there. It has no effect
on files already committed — git keeps tracking those, so `git add -A` keeps staging them even
though `commit_docs` now resolves to `false`. Because GSD's default is `commit_docs: true`, most
existing projects have already committed `.planning/`, which makes this the common case rather than
the edge case.

`/gsd-health` reports this contradiction as **`W029`**:

```
W029  .planning/ is gitignored but N file(s) are still tracked by git
      Fix: git rm -r --cached .planning/ && git commit -m "chore: stop tracking planning docs"
```

The warning is advisory. GSD never untracks files for you — `--repair` deliberately will not act on
`W029`, because removing files from the index is destructive and the timing is yours to choose.

Once you run the `git rm -r --cached` above, `.planning/` is untracked, the ignore rule takes full
effect, and the warning clears.

Note: a file deliberately force-added under an otherwise-ignored `.planning/` (`git add -f
.planning/keep.md`) triggers this same warning — there is no reliable way to distinguish an
intentional force-add from the accidental case above, so `W029` is expected in that situation too.

### Per-Phase Override (`phase_commit_docs`)

`commit_docs` is a single project-wide switch by default, but a tech lead may want to commit one
phase's artifacts (e.g. an architecture or ADR phase) while keeping execution phases local. Set a
dynamic key of the form `phase_commit_docs.<phase-id>` to override `commit_docs` for that phase only:

```bash
gsd-tools config-set phase_commit_docs.03 true
gsd-tools config-set phase_commit_docs.07 false
```

```json
{
  "commit_docs": false,
  "phase_commit_docs": {
    "03": true,
    "07": false
  }
}
```

The `<phase-id>` segment accepts the same phase-number shapes GSD uses elsewhere (`3`, `03`,
`12A`, `3.2` — a project-code prefix like `PROJ-03` is normalized to the bare phase number before
lookup), so `phase_commit_docs.3` and `phase_commit_docs.03` refer to the same entry.

**Resolution order** (highest wins) when `gsd-tools commit` / `query commit` resolves the phase from
the committed `--files` paths:

1. `phase_commit_docs.<phase-id>` for the phase being committed
2. explicit `commit_docs` / `planning.commit_docs` in config.json
3. `.gitignore` auto-detect (see [Auto-Detection](#auto-detection) above)
4. the manifest default (`true`)

A per-phase value must be a real boolean — `"true"` (string), `1`, or `null` are never coerced and
fall through to the next tier. A value set for a different phase than the one being committed never
applies (no cross-phase leak). A commit that names no phase-scoped file (e.g. a project-wide
`ROADMAP.md`-only commit) has no phase to look up, so tier 1 is inapplicable and resolution starts
at tier 2 — unchanged from pre-#3587 behavior.

When tier 1 suppresses a commit, the skip envelope's `reason` is
`skipped_commit_docs_phase_false` — distinct from the project-wide `skipped_commit_docs_false` —
so a caller is never told "commit_docs is false" when the project setting is actually `true`.

A commit spanning multiple phases resolves the override against the first phase in the `--files`
list, so scope `--files` to one phase when using the override.

See [Keep planning docs out of a shared repo](how-to/keep-planning-docs-private.md#per-phase-override)
for a worked example.

---

## Hook Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `hooks.context_warnings` | boolean | `true` | Show context window usage warnings via context monitor hook |
| `hooks.workflow_guard` | boolean | `false` | Warn when file edits happen outside GSD workflow context (advises using `/gsd-quick` or `/gsd-fast`). When enabled, the hook's one hard block — `git add -f` on `agent-*`/`worktree-agent-*` branches — also fails closed on internal error (see `docs/explanation/security-model.md`, #3504) |
| `statusline.show_last_command` | boolean | `false` | Append `last: /<cmd>` suffix to the statusline showing the most recently invoked slash command. Opt-in; reads the active session transcript to extract the latest `<command-name>` tag (closes #2538) |
| `statusline.context_position` | string | `"end"` | Position of the context-window meter. `"end"` (default) renders at line tail; `"front"` renders immediately after the model name so the meter stays visible in narrow terminals. Closes #2937 |
| `statusline.show_context_tokens` | boolean | `false` | Append the absolute token count (e.g. `(156k)`) after the context meter's percentage. Sums input, cache-creation, cache-read, and output tokens from the hook payload — a broader basis than the meter's percentage (which excludes output tokens), so the two figures can diverge slightly. Opt-in; the meter is unchanged when the flag is absent |
| `statusline.state_format` | string | `"full"` | Format of the GSD-state segment. `"full"` (default) is the existing rendering with milestone name and progress bar. `"compact"` renders `<version> · P<phase>/<total> · <status>` (e.g. `v1.12 · P7/12 · executing`) — drops the milestone name and bar, and collapses narrative statuses to the canonical keyword set from `normalizeStateStatus()` (`paused` — the canonical stuck state — renders uppercase as `PAUSED`) |
| `statusline.show_git` | boolean | `false` | Append a git segment after the directory: current branch plus compact work-state markers (`+staged` `~unstaged` `?untracked` `↑ahead` `↓behind`, or `✓` when clean and in sync). One `git status --porcelain=v2` call per render; the segment is absent outside a git repo or when git is unavailable |
| `statusline.show_state_freshness` | boolean | `false` | Append `state ~N commits back` to the GSD-state segment when STATE.md carries a `state_head` stamp and the codebase has moved at least 20 commits past it (the same advisory threshold `/gsd-health`'s W024 uses). Exactly one `git rev-list` call per render, and only when enabled and a stamp is present; the marker is absent below the threshold, outside a git repo, when the project root does not own its `.git`, and in `planning.sub_repos` workspaces |

The prompt injection guard hook (`gsd-prompt-guard.js`) is always active and cannot be disabled — it's a security feature, not a workflow toggle.

### Private Planning Setup

When `planning.commit_docs` is `false` and `.planning/` is listed in `.gitignore`, GSD treats planning artifacts as local-only. `planning.search_gitignored: true` ensures broad searches still include the `.planning/` directory in this configuration. See [Keep planning docs out of a shared repo](how-to/keep-planning-docs-private.md) for the full setup, including untracking files git is already tracking.

#### Two ways to keep planning private, and what each costs

"Private planning" is really two different questions — *is it in git at all?* and *does it reach the remote?* — and GSD answers them with two different keys.

`planning.commit_docs: false` answers the first by keeping `.planning/` out of git entirely. That has a cost most projects discover late: **parallel executor worktrees stop working.** A worktree is checked out from a *commit*, so a `.planning/` directory that is untracked or ignored simply does not exist inside it, and the executor has no `PLAN.md` to read. Local-only planning and parallel execution are mutually exclusive under this setting. Untracked planning also has no git history, so `/gsd-undo` and revert paths have nothing to restore.

`planning.pr_strict: true` answers the second instead, and leaves the first alone. Planning artifacts are committed normally on your working branch — so worktrees find them, and history exists — while `/gsd-pr-branch` guarantees that none of them reach the branch you publish. The guarantee is enforced by the command rather than by remembering never to push the working branch.

Pick by which question you are actually asking:

| You want | Setting | What you give up |
|---|---|---|
| Planning never enters git | `planning.commit_docs: false` | Parallel executor worktrees; planning git history |
| Planning is versioned locally but never published | `planning.commit_docs: true` + `planning.pr_strict: true` | Nothing — but the working branch itself must not be pushed; publish the generated `-pr` branch |

The two are independent keys and can be set together, but `pr_strict` is inert when `commit_docs` is `false`: with nothing committed, there is nothing for the PR-branch filter to remove.

See [Publish PRs without planning artifacts](how-to/publish-prs-without-planning-artifacts.md) for the setup.

### `commit_docs` Pre-Commit Guard (opt-in)

`planning.commit_docs: false` only stops GSD's own `gsd-tools commit`/`gsd-tools state`
write path from committing `.planning/`. It does **not** stop a plain `git add -A` +
`git commit` run by hand, or by a script outside GSD's own tooling, from staging and
committing `.planning/` anyway.

`gsd-tools commit-docs-guard enable` closes that gap by writing a `.git/hooks/pre-commit`
hook into the **current repository** that refuses any commit staging `.planning/` files
while `commit_docs` resolves to `false`. Resolution goes through the same
[per-phase precedence chain](#per-phase-override-phase_commit_docs) `gsd-tools commit`/`query commit`
use — a `phase_commit_docs.<phase-id>` override for the staged phase is honored here too, so the
hook cannot contradict them. It is entirely opt-in — no install path wires it
automatically:

```bash
gsd-tools commit-docs-guard enable   # write the hook (refuses to clobber an existing pre-commit hook)
gsd-tools commit-docs-guard disable  # remove it (refuses to remove a hook GSD didn't write)
```

The hook is identified by a stable `# gsd-core:commit-docs-guard` marker line, so `enable`/
`disable` detect it by presence of that marker rather than by byte-for-byte content — editing
the file afterward does not make it unrecognizable. `enable` refuses (rather than silently
writing an inert file) when `core.hooksPath` is already configured, since a hook written to
`.git/hooks/pre-commit` would never run in that case; wire the guard into the configured hooks
path by hand instead. See [Keep planning docs out of a shared repo](how-to/keep-planning-docs-private.md#pre-commit-guard-hook-optional) for the full walkthrough, including the linked-worktree case.

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
| `plan_review.source_grounding` | boolean | `true` | Enable the plan drift guard. When `true` (the default), plan review resolves every symbol reference cited in a PLAN.md against the live source tree. Plans that cite a non-existent function, class, decorator, or CLI flag produce a `needs-acknowledgement` notice before the plan is approved. The same key also gates the cross-artifact fact-drift pass, which reports when ROADMAP.md, PLAN.md, STATE.md and CONTEXT.md state the same fact in contradictory ways (advisory only — it never blocks convergence). Disable with `false` to skip both passes entirely. Toggle during setup (`/gsd-new-project`) or at any time via `/gsd-settings`. |
| `plan_review.source_grounding_authority` | enum | `grep` | Selects the resolver adapter used to verify symbol existence. Allowed values: `grep` (default — ripgrep/grep search of source files, works in any project without additional tooling), `intel` (query the `.planning/intel/api-map.json` index built by `/gsd-map-codebase`; requires `intel.enabled: true`), `treesitter` (reserved for future tree-sitter adapter), `lsp` (reserved for future LSP adapter), `scip` (reserved for future SCIP/LSIF adapter). Use `intel` when you have run `/gsd-map-codebase` and want the faster, pre-indexed lookup. All other values beyond `grep` and `intel` are reserved and have no effect in the current release. |

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

<a id="refactor-trigger-settings"></a>
### Refactor-Trigger Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `refactor.trigger_enabled` | boolean | `false` | Enable the complexity-triggered refactor hook. When `true`, an `execute:post` step evaluates the complexity of the files the phase touched and writes a scoped refactor proposal if a function crosses `refactor.complexity_threshold` or jumps past `refactor.complexity_jump_delta`. Opt-in; when `false` the hook never runs. Added in v1.10.0 (#1953) |
| `refactor.complexity_threshold` | number | `15` | Absolute per-function complexity above which a refactor proposal is surfaced. Semantics match ESLint's `complexity: {max: N}` — the trigger is strictly greater, so a score of exactly `N` does not trigger. Default `15` follows SonarSource's default; ESLint's own default is `20` and radon's rank C begins at `11`. Raise it if proposals feel like noise. Added in v1.10.0 |
| `refactor.complexity_jump_delta` | number | `5` | Complexity growth above which a refactor proposal is surfaced even when the absolute threshold is not reached. Measured against the function's anchor — the score recorded the last time the function was consciously dispositioned (`refactor accept`/`refactor decline`) — so it accumulates across phases and catches slow creep the absolute threshold would miss. Strictly greater, as with the threshold. Added in v1.10.0 |
| `refactor.trigger_strict` | boolean | `false` | Record an untriaged refactor proposal as an open `deviation` entry in the broken-windows ledger, so it becomes a tracked task that must be resolved before ship. Off by default and deliberately so: a blocking complexity number is a metric an executor can satisfy by splitting one coherent function into two incoherent ones, so the entry clears on the proposal being dispositioned (`gsd-tools refactor accept\|decline`), never on the score improving. Ship blocking is the broken-windows capability's existing `ship:pre` gate — enable it separately with `workflow.windows_enforce`. With broken-windows absent, strict mode still records the proposal locally and says so; it cannot block on its own. Enabling `refactor.trigger_strict` without also enabling `workflow.windows_enforce` (or with broken-windows not installed) surfaces a typed `refactor_strict_not_enforcing` warning on every triggering `refactor evaluate`, naming the exact remediation. Advisory mode (the default) surfaces the same proposal and tracks nothing. Added in v1.10.0 |

See [ADR-1953](adr/1953-complexity-triggered-refactor.md) for the design rationale, including why the anchor moves only on disposition and never on the score improving.

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
| `git.protected_branches` | array of non-empty strings | (none) | Optional additional shared branches that should trigger protected-branch warnings alongside the resolved base branch |
| `git.create_tag` | boolean | `true` | Create a git tag (`v[X.Y]`) on milestone completion. Set to `false` for projects with their own release flow |
| `git.phase_branch_template` | string | `gsd/phase-{phase}-{slug}` | Branch name template for phase strategy |
| `git.milestone_branch_template` | string | `gsd/{milestone}-{slug}` | Branch name template for milestone strategy |
| `git.quick_branch_template` | string or null | `null` | Optional branch name template for `/gsd-quick` tasks |

### Protected Branch Warnings

`git.protected_branches` is optional and has no persisted default. When the field is absent,
GSD protects only the resolved base branch, preserving existing project behavior. Every configured
item must be a non-empty string. The configured list extends the resolved base branch; it never
replaces that branch or changes base-branch detection.

A match produces an advisory warning at execute-phase and ship and does not change
`git.branching_strategy: "none"`: GSD still continues on the current branch and ship still offers
to create a feature branch.

Matching is by exact branch name — there is no glob or prefix support, so a git-flow
layout must name each `release/*` or `hotfix/*` branch it wants protected. An entry that
is not a non-empty string is ignored with a warning naming it, and the remaining names
still apply.

```json
{
  "git": {
    "branching_strategy": "none",
    "protected_branches": ["develop", "staging"]
  }
}
```

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
| `review.models.cursor` | string | (CLI default) | Model used when the `--cursor` reviewer is invoked (injected into `--model`) |
| `review.models.agy` | string | (CLI default) | Model used when the `--antigravity` / `--agy` reviewer is invoked. The key suffix is the CLI's own name (`agy`), not the lane slug — the lane declares which key it reads, so the two need not match |
| `review.models.kimi-code` | string | (CLI default) | Model used when the `--kimi-code` reviewer is invoked (injected into `-m`) |
| `review.models.ollama` | string | (server default) | Model name passed to Ollama when `--ollama` reviewer is invoked. If unset, the first available model reported by the server is used (e.g. `llama3`). Set to a specific tag: `gsd config-set review.models.ollama codellama` |
| `review.models.lm_studio` | string | (server default) | Model name passed to LM Studio when `--lm-studio` reviewer is invoked. If unset, the first available model reported by the server is used. |
| `review.models.llama_cpp` | string | (server default) | Model name passed to llama.cpp when `--llama-cpp` reviewer is invoked. If unset, the first model reported by `/v1/models` is used. |
| `review.default_reviewers` | string[] \| null | (all detected reviewers) | Default reviewer subset for no-flag `/gsd-review`. Example: `["gemini","codex"]`. May include configured `review.reviewer_instances` names. Explicit flags and `--all` override this setting. |
| `review.max_prompt_tokens` | number\|null | null | Default maximum estimated tokens for the assembled review prompt. When set, the prompt is deterministically trimmed before being sent to each reviewer. Per-reviewer overrides via `review.max_prompt_tokens_per_reviewer` take precedence. null = no trim (current behavior). |
| `review.max_prompt_tokens_per_reviewer` | object | {} | Per-reviewer token budget overrides. Keys are reviewer slugs. Every declared reviewer lane accepts one (`gemini`, `claude`, `codex`, `coderabbit`, `opencode`, `qwen`, `cursor`, `antigravity`, `kimi-code`, `ollama`, `lm_studio`, `llama_cpp`). A lane's value of `-1` (the default) is unset and inherits `review.max_prompt_tokens`; `0` disables trimming for that lane specifically; any other number is that lane's own budget. |
| `review.parallel_lanes` | boolean | `false` | Dispatch independent reviewer lanes concurrently within a single `/gsd-review` pass. Default `false` keeps the sequential dispatch that protects against provider rate limits. Opt in only when your providers can accept concurrent requests. Convergence cycles stay sequential either way. |
| `review.ollama_host` | string | `http://localhost:11434` | Base URL of the Ollama server. Override when running Ollama on a non-default port or remote host: `gsd config-set review.ollama_host http://192.168.1.10:11434` |
| `review.lm_studio_host` | string | `http://localhost:1234` | Base URL of the LM Studio local server. Override when using a non-default port. |
| `review.llama_cpp_host` | string | `http://localhost:8080` | Base URL of the llama.cpp server (`llama-server`). Override when using a non-default port. |

### Prompt budgets for reviewer lanes

Every declared reviewer lane can be capped, most usefully the local model servers (Ollama, llama.cpp, LM Studio), which typically accept far fewer tokens than cloud APIs — but any CLI lane can be given a budget too. Setting `review.max_prompt_tokens_per_reviewer` (or the global `review.max_prompt_tokens` fallback, which every lane whose own key is unset inherits) triggers deterministic prompt trimming before the prompt is sent to that reviewer: CONTEXT is dropped first, then RESEARCH, then REQUIREMENTS; PROJECT.md is head-shrunk to the first 40 lines; PLANs are tail-truncated proportionally — instructions and roadmap are always preserved. When a reviewer is trimmed, a disclosure note is injected at the top of the prompt and trim metadata (budget, omitted sections, truncation percentage) is recorded in the REVIEWS.md frontmatter under `trimmed_reviewers`. If even the minimum review set (instructions + roadmap + plan stubs) exceeds the budget, the reviewer is skipped with a warning rather than sending a truncated prompt that would produce misleading feedback.

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

> **All 33 shipped agents have explicit per-profile tier assignments** in the catalog (`gsd-core/bin/shared/model-catalog.json`). The table above shows a representative subset of the most-used agents. For agents not listed here, `model_overrides` accepts any shipped agent name. The authoritative profile data is derived from `gsd-core/bin/shared/model-catalog.json` via `src/model-catalog.cts`.

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

Effort is rendered per-runtime: `output_config.effort` for Claude (Claude Code subagent `effort` frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env), `model_reasoning_effort` for Codex (Responses API `reasoning.effort`), and `variant` for OpenCode (agent frontmatter).

**OpenCode `variant` is opt-in ([#3706](https://github.com/open-gsd/gsd-core/issues/3706)).** OpenCode resolves a `variant` name against the variants available for the agent's model — the built-in sets are provider-specific (Anthropic ships `high` and `max`; OpenAI the full ladder) and you can define your own in `opencode.jsonc`. GSD writes the key only when an `effort` block is actually configured; with no `effort` config the generated agent carries no `variant` line and OpenCode applies its own default.

Note that the gate is on effort being configured **at all**, not on the individual agent being named. Once any `effort` block exists, the usual cascade resolves a level for *every* agent — an `agent_overrides` entry for one agent still leaves the others resolving through `routing_tier_defaults` and the tier ladder — so every generated OpenCode agent gets a `variant` line, not only the one you named. Two levels are never written: `inherit` (which means "follow the host default", so the key is omitted) and any level outside OpenCode's supported set. Runtimes with no declared effort surface — Kilo among them — never receive the key at all.

`effort sync` maintains the key too, so changing `effort` config does not require a reinstall: it writes the newly resolved `variant` into each installed OpenCode agent, and removes the key when the agent resolves to `inherit` or to a level OpenCode does not accept — the same states under which install writes nothing.

**Cross-provider clamping:** `minimal` is Anthropic-unsupported — it clamps to `low` on Claude.

**Codex effort is resolved per model, not per runtime (#3007).** Codex advertises a
`supported_reasoning_levels` set on each model and validates against it, so the same universal level
can pass cleanly on one model and clamp on another. GSD therefore renders against the model's own
advertised set:

| Model | Advertised levels |
|---|---|
| `gpt-5.6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh`, `max` |
| any other / unknown id | `low`, `medium`, `high`, `xhigh`, `max` (family baseline) |

Today every shipped Codex model advertises the same usable range, so the same effort resolves
identically across `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` — `ultra` is sol's only
differentiator, and GSD rejects it for every model regardless (see below), so no observable output
currently differs by model. The table is per-model, not per-runtime, because Codex declares
capability per model and the sets are free to diverge — the previous single per-runtime assumption
is exactly what went stale and produced this change.

Three consequences:

- **`max` reaches Codex.** It is no longer clamped to `xhigh`. Earlier GSD releases described `max`
  as Anthropic-only; that was accurate when written and Codex has since added it. If you set `max`
  for a Codex agent, your generated `model_reasoning_effort` now says `max` where it previously said
  `xhigh`.
- **`minimal` no longer reaches Codex.** No Codex model advertises it, so it clamps up to `low` —
  the floor every model does advertise. GSD previously emitted `minimal` verbatim, which Codex
  rejects.
- **`ultra` is refused outright**, and is not part of GSD's ladder. See below.

**Every clamp is now visible.** `resolve-execution` reports the level you asked for alongside the
level actually rendered, so a downgrade is legible instead of silent. These are flat keys in the
same result object as `effort_rendered` — there is no nested `effort` object:

```json
{
  "effort_rendered":    "low",
  "effort_requested":   "minimal",
  "effort_clamped":     true,
  "effort_clamp_reason": "requested 'minimal' is not in gpt-5.6-luna's advertised reasoning levels; clamped up to its floor, 'low'."
}
```

**Why `ultra` is rejected rather than clamped.** Codex's own catalog describes `ultra` as *"Maximum
reasoning with automatic task delegation"* — it is a mode switch, not a louder `max`. At `ultra`
Codex enters proactive multi-agent mode and spawns sub-agents on its own initiative, which would run
underneath GSD's orchestration rather than inside it ([#2167](https://github.com/open-gsd/gsd-core/issues/2167)).
GSD refuses it for every model, including `gpt-5.6-sol`, which does advertise it. This is
deliberately stricter than Codex requires: Codex only applies proactive mode to V2 sessions and
never to spawned sub-agents, but GSD writes effort into generated agent files at install time and
cannot know the session source of a future invocation. Clamping `ultra` down to `max` was rejected
as an option — it would silently discard what you actually asked for.

The model-catalog's `reasoning_effort` per-tier hint is a legacy field kept for reference; effort is now config-driven.

**Precedence (highest → lowest):**
1. Invocation override (e.g. `--effort` flag on `resolve-execution`)
2. `effort.agent_overrides[<agent-id>]`
3. `effort.routing_tier_defaults[<light|standard|heavy>]`, **merged per-tier over the
   built-in tier defaults** (`light: low`, `standard: high`, `heavy: xhigh`) — a partial
   block fills its gaps from the built-ins instead of discarding them, and an invalid
   value falls back to that tier's built-in ([#3531](https://github.com/open-gsd/gsd-core/issues/3531))
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

Valid effort values: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `inherit` ([#3533](https://github.com/open-gsd/gsd-core/issues/3533)).

`inherit` means "follow the session/host default" — it is a declarable choice, not a level:
at install time the agent's `effort:` frontmatter key (claude), `model_reasoning_effort`
pin (Codex `.toml`), or `variant:` frontmatter key (OpenCode) is **omitted** for an agent
resolving to `inherit`; `effort sync` treats
an absent key as the correct in-sync state and strips a present one; no runtime ever receives
the literal. An explicit `inherit` also never escalates on failed attempts — your choice
outranks the automatic ladder.

Where you set `inherit` matters: every GSD agent has a routing tier, and the merged tier
ladder (#3531) answers for tiered agents before `effort.default` is consulted — so a bare
`effort.default: "inherit"` only affects agents **without** a catalog tier. To make tiered
agents follow the session, set `effort.routing_tier_defaults` (per tier, or all three) or the
agent's `agent_overrides` entry to `"inherit"`. `query resolve-execution` shows both views.

`query resolve-execution --json` reports two effort views ([#3534](https://github.com/open-gsd/gsd-core/issues/3534)):
`effort` is the **resolved** config-cascade value; `effort_effective` is what the installed
agent will actually run at — read from the installed agent's `effort:` frontmatter for the
claude runtime (`effort_effective_source: "frontmatter"`), reported as `"inherit"` when the
key is absent (`"frontmatter-absent"` — the agent follows the session effort), and equal to
the resolved value with source `"resolved"` when there is no install-time channel or no
agent file to read. `--pick effort` still returns the resolved value.

#### Where effort actually reaches — added in v1.8.0

Effort resolved from the cascade above reaches a runtime through one of two channels.

**Install-time.** The value is baked into the artifacts the installer generates — the
`effort:` frontmatter key on a Claude subagent, `model_reasoning_effort` in a generated
Codex `.toml`. This is fixed at install and changes only on reinstall or sync.

**Invocation-time.** When GSD spawns another CLI as a subprocess — the cross-AI reviewers
in `/gsd-review` — the effort is appended to that CLI's own command line. Whether a host
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
  "model":               "opus",
  "profile":             "balanced",
  "effort":              "xhigh",
  "effort_rendered":     "xhigh",
  "effort_param":        "output_config.effort",
  "effort_propagation":  "frontmatter",
  "effort_requested":    "xhigh",
  "effort_clamped":      false,
  "effort_clamp_reason": null,
  "fast_mode":           false,
  "fast_mode_supported": false
}
```

`effort_param` tells you which runtime parameter to set. `effort_requested` is the level you asked
for (before any clamp); `effort_rendered` is what actually shipped. `effort_clamped` is `true` only
when the two differ, and `effort_clamp_reason` explains why (`null` when unclamped). `fast_mode_supported` tells you whether the configured runtime supports per-agent fast_mode propagation.

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

### The `tier` Field

`node gsd-tools.cjs query resolve-model <agent> --pick tier` returns the tier GSD resolved for that agent, independent of `resolve_model_ids`: `opus` | `sonnet` | `haiku` | `fable` | `inherit` | `unknown`. It is also emitted as a `tier` key in the command's full JSON output.

`tier` is computed above the `resolve_model_ids: "omit"` gate, so it stays meaningful exactly where `model` does not — every non-Claude install (blank under `"omit"`) and any install where the runtime's tier map substitutes a name (e.g. `gpt-5.6-luna` for the haiku tier on Codex).

`tier` accounts for every step that can change which tier runs, including a `model_policy` preset — a preset resolves after the profile tier and can dispatch a different one, so `model_policy: {provider: anthropic, budget: low}` under a `balanced` profile reports `haiku`, not `sonnet`.

**Honesty semantics:** a `model_overrides` pin naming a known alias or a mappable full Claude id reports that alias; a pin to an unmappable raw model id reports `unknown`; a policy-resolved model that maps to no alias — including every non-Claude runtime, where the policy model is passed through verbatim — reports `unknown` rather than falling back to the profile tier; `model_profile: inherit` reports `inherit`; an agent with no catalog entry reports `unknown`. `tier` never guesses, so treat `unknown` and `inherit` as *cannot tell*, never as *adequate*.

**One limit:** a `model_profile_overrides.<runtime>.<tier>` entry that repoints a tier at another tier's model makes `tier` report the tier that was asked for, not the tier of the model that answers.

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

This resolves `gsd-planner` → `gpt-5.6-sol` (xhigh), `gsd-executor` → `gpt-5.6-terra` (medium), `gsd-codebase-mapper` → `gpt-5.6-luna` (medium). Codex skills pass each resolved `model` and `reasoning_effort` to `spawn_agent` when its visible schema advertises the corresponding field; otherwise they omit the field and inherit the session/static agent configuration.

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

`model_policy` provides a simpler, provider-neutral way to configure model tiers across runtimes. It is the preferred surface for non-Anthropic runtimes where `model_profile_overrides` would require manually knowing the right model IDs. Configure it via `/gsd-settings` → Section 8 (Model Policy).

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
| `GSD_EXIT_CONTRACT` | Select the exit-code projection: `v1` (default) or `v2`. See [Exit-code contract](#exit-code-contract-gsd_exit_contract) below. |
| `GSD_ALLOW_SYMLINKED_DEST` | Set to `1` (or `true`) to permit install/update when `CLAUDE_CONFIG_DIR` (or any artifact-kind child like `skills/`, `hooks/`) is an **intentional, user-owned symlink** pointing outside the install root. v1.7.x write-confinement (ADR-1239 Phase B) refuses such layouts by default to prevent untrusted `destSubpath` traversal. Opt in only if you manage configHome via symlinked external dirs, multi-account config layouts (`~/.claude-personal`, `~/.claude-team`), or dotfiles-managed configHome (nix-darwin, etc.). Two refusals remain load-bearing even with opt-in: path-traversal in `destSubpath` (`../../etc`-style), and a symlink whose resolved target equals the install root itself (would let the prune pass wipe it). |
| `WSL_DISTRO_NAME` | Detected by installer for WSL path handling |

### Exit-code contract (`GSD_EXIT_CONTRACT`)

Which integers GSD's commands exit with is **versioned**, so the meanings can be
sharpened without breaking callers that already depend on today's numbers.

| Version | Behavior |
|---|---|
| `v1` | **Default.** Today's exit codes, unchanged. |
| `v2` | Codes come from the exit-code registry. |

Select `v2` either way — the flag wins when both are given:

```bash
GSD_EXIT_CONTRACT=v2 gsd-tools <command>
gsd-tools <command> --exit-contract=v2
```

An unrecognized value is **rejected**, not silently treated as `v1`. That is
deliberate: a selector that quietly ignores what you asked for is the failure
mode this contract exists to remove.

**What actually differs today.** Only one outcome: a command that ran to
completion and is reporting a condition **through its result payload** rather
than as a process failure. Under `v1` that exits `0` — a long-standing
contract across ~60 call sites, documented in
[`json-errors.md`](json-errors.md), where a caller detects the condition by
inspecting the payload rather than the exit code. Under `v2` it exits a
registered non-zero code instead. Pass or fail, and every other registered
outcome, are identical under both.

Every registered code is non-zero, so a caller written `if ! cmd; then` behaves
the same for success under either version and trips for everything else.
Switching to `v2` can turn a false green red; it cannot turn a red green.

`v2` is opt-in now and becomes the default at the next major version. Rationale
and the full band allocation are in
[ADR-3889](adr/3889-process-exit-contract.md).

---

## Global Defaults

Save settings as global defaults for future projects:

**Location:** `~/.gsd/defaults.json`

When `/gsd-new-project` creates a new `config.json`, it reads global defaults and merges them as the starting configuration. Per-project settings always override globals.

### What a global file can and cannot set at runtime

Two different rules apply, and the difference is deliberate ([#3532](https://github.com/open-gsd/gsd-core/issues/3532)):

- **In a directory with no `.planning/` at all**, `~/.gsd/defaults.json` is the active
  configuration — model resolution reads it directly.
- **In a real project (`.planning/config.json` present, even if empty)**, the global file is
  **not read for model resolution** — every model-side key it sets (`model_profile`,
  `model_overrides`, `models`, `dynamic_routing`, `runtime`, and the rest of the resolution
  set) is inert there. GSD prints a one-time stderr warning naming the shadowed keys when it
  detects this, instead of failing silently. To apply a global model setting to a project,
  put it in that project's `.planning/config.json`.
- **`effort` is the exception**: the install-time effort channel always merges
  `~/.gsd/defaults.json` with the project config (that is how `effort sync` works), so a
  global `effort` block keeps working in projects and does not trigger the warning.
- **The whole `git.*` namespace is project-scoped and never resolves from the global file**,
  in either directory shape — not `git.base_branch`, not `git.protected_branches`, not
  `git.branching_strategy` or the branch templates. Branch policy is a property of the
  repository, not of the machine, so it is read only from that project's
  `.planning/config.json`. A `git` block in `~/.gsd/defaults.json` still seeds new projects
  (`/gsd-new-project` copies globals into the new `config.json`), but it never takes effect
  at runtime on its own. It is outside the shadowed-key warning above, which covers the
  model-resolution set only.

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
