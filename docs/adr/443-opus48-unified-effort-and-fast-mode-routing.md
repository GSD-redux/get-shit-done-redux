# ADR 443: Unified cross-provider effort controls and fast-mode-aware routing

- **Status:** Proposed (2026-05-28)
- **Date:** 2026-05-28
- **Tracking issue:** [#443](https://github.com/open-gsd/get-shit-done-redux/issues/443)

## Why this is still `Proposed` (audited 2026-07-17)

The audit confirmed the cross-provider resolver/renderer/CLI machinery genuinely shipped: `resolveEffortInternal`, `resolveEffortForTier`, `renderEffortForRuntime`, `RUNTIMES_WITH_FAST_MODE`, and `cmdResolveExecution` (`src/model-resolver.cts:534,654`; `src/commands.cts`) implement the cascade and clamping exactly as Decision items 1–3, 5, and 6 describe, and static install-time propagation is real and end-to-end tested — `tests/install-runtime-artifacts.test.cjs`'s `describe('#443 Claude install: effort: injected into frontmatter')` runs the actual `install()` function and reads the resulting agent `.md` files off disk, confirming `gsd-planner` gets `effort: xhigh`, `gsd-codebase-mapper` gets `effort: low`, and `gsd-executor` gets `effort: high`. That test predates the QA audit below (landed 2026-05-29 in the original `#443` PR, commit `5ca646f01`), so the "resolver-only, nothing reaches the runtime" framing of the original flavor-text problem this ADR set out to fix is fixed for the static path.

**The blocker.** Decision item 1's cascade names an "(1) orchestrator invocation override" as the *highest*-precedence layer, and Decision item 6 adds a dynamic escalation path ("effort steps up the ladder on a failed attempt"). Both exist only as CLI-callable resolver code — `resolveEffortInternal`'s invocation-override step (`src/model-resolver.cts:535`) and `resolveEffortForTier`'s attempt-based escalation (`src/model-resolver.cts:654`) — exercised solely by unit/CLI tests. Nothing in the shipped orchestration actually calls them: a search across every file in `gsd-core/workflows/*.md` and `agents/*.md` for `resolve-execution` or `CLAUDE_CODE_EFFORT_LEVEL` returns zero hits; the only workflow-level mentions of "effort" are documentation of the config keys in `settings-advanced.md`'s confirmation table. The only propagation channel actually wired into a real GSD flow is the static one (config → `install()` → frontmatter, baked once at install time) — the ADR's own decided design promises more than that, and the more-than-static-baking part has no consumer. Separately, the repo's own dated QA test-architecture audit (`docs/issueevidence/1192-adr-test-audit-2026-06-13.md`, produced under issue #1192, closed COMPLETED) rated ADR-443 "partial ... **end-to-end effort propagation untested**" and named it in its action plan ("Strengthen ... ADR-443 end-to-end effort propagation," line 220); that action item was never converted into a tracked follow-up issue, and no commit since 2026-06-13 addresses it. That audit's blanket "untested" framing overstates the gap — the static path is tested — but the underlying signal (a decided mechanism with no live caller) is real and independently confirmed here.

**Unblock condition.** Either (a) wire the orchestrator-invocation-override and attempt-based-escalation paths into an actual GSD workflow or agent dispatch (so `resolveEffortForTier`'s escalation and `resolveEffortInternal`'s invocation-override step have a real caller outside `src/commands.cts`'s CLI surface and tests), and add a test exercising that live path the way `tests/install-runtime-artifacts.test.cjs` exercises the static one; or (b) if the ADR's intended scope is in fact limited to static install-time propagation, amend Decision items 1 and 6 to say so explicitly and close out audit issue #1192's action-plan item 18 with a note pointing at the shipped install-wiring tests. Either is a maintainer call this file records but does not make.

## Amendment (2026-07-21): path (a) chosen; audit corrected (#2481)

**The maintainer call above has been made: path (a).** Raised by #2475 — reviewer CLIs invoked as subprocesses by the review workflow silently inherit whatever reasoning effort sits in the user's own global CLI config, because no shipped orchestration resolves effort at invocation time. That is this ADR's blocker surfacing as a user-visible defect, not a new problem.

**Two deferrals recorded above are closed by this change — resolved, not re-tracked:**

1. **Audit issue #1192's action-plan item 18** ("Strengthen … ADR-443 end-to-end effort propagation") — which the blocker text notes *"was never converted into a tracked follow-up issue"* — is **satisfied by this change**, which supplies the end-to-end propagation and the live-path tests it asked for. It is closed out, not converted into another follow-up.
2. **The choice between (a) and (b)** — which this file previously recorded without making — is resolved as **(a)**. Scope is *not* limited to static install-time propagation. Choosing the path is not the same as completing it; see the status table below for what remains.

**How path (a) is being satisfied.** The consumer is defined through the Host-Integration Interface rather than by hard-coding per-CLI effort syntax into a workflow: [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) gains an `effortSurface` axis declaring how each host accepts reasoning effort (`argv` | `none`), so a universal effort value resolved by this ADR's cascade is rendered per host through the negotiated descriptor. `EFFORT_RENDERING` (`src/model-catalog.cts`) — whose `channel` vocabulary is `frontmatter` | `api`, both install-time — collapses into that descriptor data rather than growing a parallel per-runtime table. Its callers today are exactly the two channels this ADR already ships: the static install-time renderer (`bin/install.js`, via `src/install-effort-resolver.cts`) and the manual `query resolve-execution` / effort-sync CLI surface (`src/commands.cts`). No workflow or agent dispatch calls it — which is the blocker restated in terms of the renderer rather than the resolver.

**What this change actually delivers — and what it does not.** Path (a) names *two* mechanisms needing a live caller. This change delivers neither of them; it delivers a third thing the blocker did not anticipate, and the audit of the other two turns out to have been stale.

| Path (a) mechanism | Status |
|---|---|
| Decision item 1 — `resolveEffortInternal`'s **invocation-override** step (`--effort`) | **Still no live caller.** No workflow, reference, or agent passes `--effort` to `resolve-execution`. This change does not add one. |
| Decision item 6 — `resolveEffortForTier`'s **attempt-based escalation** | **Already satisfied — by #2296, not by this change.** `gsd-core/references/execute-phase-quota-recovery.md` calls `resolve-execution gsd-executor --attempt "${QUOTA_ATTEMPT:-1}" --failure-class quota-exceeded`, and that reference is `@`-included into `gsd-core/workflows/execute-phase.md`, so it executes as part of the live workflow. |
| **New here:** the resolved effort **cascade** reaches a spawned host as an invocation argument | Delivered. `gsd-core/workflows/review.md` calls `resolve-execution … --host <id>` per reviewer and appends the rendered argument, gated by the host's negotiated `effortSurface`. |

**The blocker's grep was stale in two ways.** It searched only `gsd-core/workflows/*.md` and `agents/*.md`; `references/*.md` is `@`-included into workflows and is therefore just as live — that is where #2296's escalation caller sits. And the blocker text was written 2026-07-17, three days before #2296 landed (`455ad49ae`, 2026-07-20), so its "zero hits" finding was correct on the day and has since been overtaken.

**This ADR therefore remains `Proposed`.** Decision item 6's condition is met (by #2296); Decision item 1's is not. The corpus rule for ratifying a stale `Proposed` requires the decided mechanism to demonstrably exist in the tree, and the invocation-override step still has no caller outside the CLI surface and tests. Status flips when item 1 gains a live caller and a test exercises that path through a workflow rather than through `gsd-tools` directly.

**Boundary.** #2313 owns the static/install-time effort channel for Codex (`model_reasoning_effort` in generated `~/.codex/agents/<agent>.toml`, plus a sync path) and explicitly places orchestrator effort-override drift outside its scope. That is the static channel this ADR already ships; the work above is the invocation-time channel it does not.

## Context

### Effort control and fast mode in Claude Opus 4.8

Claude Opus 4.8 introduced two orthogonal execution controls relevant to GSD's agent orchestration:

1. **Effort control** — API request field `output_config.effort` (string enum). Anthropic levels: `low`, `medium`, `high`, `xhigh`, `max`; Opus 4.8 defaults to `high`. In Claude Code it is exposed as `/effort`, the `--effort` CLI flag, the `CLAUDE_CODE_EFFORT_LEVEL` env var, the `effortLevel` settings.json key (accepts `low`/`medium`/`high`/`xhigh`; `max` is session-only), and — critically for orchestration — a per-subagent `effort` frontmatter key (shipped per anthropics/claude-code issue #31536, CLOSED/COMPLETED).

2. **Fast mode** — API request field `speed` (`standard`|`fast`); `fast` enables high output-tokens-per-second inference. Pricing for Opus 4.8 fast mode is $10/$50 per MTok in/out vs $5/$25 standard. In Claude Code it is the interactive `/fast` toggle ONLY — there is no settings.json key, env var, or subagent-frontmatter mechanism to enable fast mode for a spawned subagent.

GSD already routes WHICH model runs a task (routingTier `heavy`/`standard`/`light`, model_profile `quality`/`balanced`/`budget`/`adaptive`/`inherit`, `model_overrides`, and dynamic_routing escalation). It had no way to control HOW HARD the model reasons or WHICH speed tier it uses.

### The "flavor text" problem: issue #2517

Issue #2517 added `resolveReasoningEffortInternal` and made `query resolve-model` emit a `reasoning_effort` field derived from the Codex runtime's per-tier catalog values (`model-catalog.json` `runtimeTierDefaults.codex.*.reasoning_effort`). However, a codebase audit found that NO orchestrator, workflow, or agent ever consumes that emitted field — it is never passed to an actual Codex invocation. The resolver computed a value and a test asserted the computed JSON, but the value reached no runtime. The feature was inert ("flavor text, no code"): asserting a resolver's return value is not the same as asserting the control reaches the model.

### Cross-provider effort enum mismatch

The two providers' effort enums are NOT identical:

- **Anthropic/Claude (Opus 4.8):** `low`, `medium`, `high`, `xhigh`, `max` (has `max`; no `minimal`)
- **OpenAI/Codex** (`model_reasoning_effort` / Responses API `reasoning.effort`; SDK `ReasoningEffort` ranks `none=0`, `minimal=1`, `low=2`, `medium=3`, `high=4`, `xhigh=5`): `minimal`, `low`, `medium`, `high`, `xhigh` (has `minimal`; no `max`)

Common core: `low`, `medium`, `high`, `xhigh`.

## Decision

1. **Introduce a single universal `effort` config knob** (and an orthogonal `fast_mode` knob) that compose with model selection rather than replace it. Resolution precedence mirrors the existing model cascade: (1) orchestrator invocation override, (2) `effort.agent_overrides[agent]`, (3) `effort.routing_tier_defaults[routingTier]`, (4) `effort.default`, (5) built-in default `high`. Same cascade for `fast_mode` with built-in default `false`. Invalid enum values at any level are ignored and fall through (mirrors the `VALID_TIERS` gate in `resolveModelInternal`) so a typo never silently breaks resolution.

2. **The universal effort value is provider-agnostic; a per-runtime renderer maps it to each runtime's wire parameter**, clamping the genuinely-unique tail levels:

   - **Claude / API:** param `output_config.effort` (Claude Code: subagent `effort` frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env). `minimal` clamps to `low` (Claude has no `minimal`); `low`/`medium`/`high`/`xhigh`/`max` pass through.
   - **Codex:** param `model_reasoning_effort` (Responses API `reasoning.effort`). `max` clamps to `xhigh` (Codex has no `max`); `minimal`/`low`/`medium`/`high`/`xhigh` pass through.

   | Universal level | Claude rendering | Codex rendering |
   | --- | --- | --- |
   | `minimal` | `low` (clamped) | `minimal` |
   | `low` | `low` | `low` |
   | `medium` | `medium` | `medium` |
   | `high` (default) | `high` | `high` |
   | `xhigh` | `xhigh` | `xhigh` |
   | `max` | `max` | `xhigh` (clamped) |

3. **Fold the inert `reasoning_effort` output into this unified model.** `query resolve-model` is preserved for back-compat; a NEW `query resolve-execution` is the superset that emits: `model`, `effort` (universal), the per-runtime rendered effort, the wire param name, the propagation channel, `fast_mode`, and `fast_mode_supported`. Each config key ships help text naming exactly which runtime field/invocation it drives.

4. **Make effort actually reach the runtime (close the flavor-text gap).** Claude is first-class: the resolved effort propagates to spawned subagents via the `effort` frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env. Tests assert end-to-end propagation, not just resolver return values.

5. **Fast mode honesty:** because Claude Code has no per-subagent fast-mode mechanism, `fast_mode` is resolved and surfaced (with a `fast_mode_supported` flag, `false` for the claude runtime's subagents) but is NEVER emitted as a fake frontmatter key — doing so would be a silent no-op. It propagates only where the runtime supports it (API `speed:"fast"`).

6. **Dynamic-routing integration is additive:** a new effort-escalation path (effort steps up the ladder on a failed attempt BEFORE model-tier escalation) is gated on the same `dynamic_routing.enabled` / `escalate_on_failure` switches and does NOT modify `resolveModelForTier` (so existing feat-3024 behavior is unchanged).

## Consequences

### Positive

- One coherent effort policy across all runtimes; Claude effort is first-class and actually wired.
- The dead `reasoning_effort` field becomes meaningful; finer-grained cost/quality control (a light-tier scanning agent can run `low` effort; a heavy planning agent `xhigh`) without changing model class.
- Effort-first escalation reduces unnecessary model upgrades.
- Cross-provider clamping is explicit and documented.

### Negative

- The universal enum is the union of two providers' ladders, so two levels (`max`, `minimal`) are runtime-specific and clamp when rendered to the other provider — users must understand the mapping (mitigated by help text and the table above).
- Fast mode remains asymmetric: it cannot be forced per-subagent on Claude Code, only at session level or on API-direct runtimes.
- Updating issue-2517's tests to assert real wiring is a deliberate behavior/contract change (the old "null on claude" assertion encoded the now-false premise that Claude has no effort control).

## Alternatives Considered

**(a) Global effort env override** (e.g. a single `CLAUDE_CODE_EFFORT_LEVEL` for the whole session) — rejected: caps cost but starves heavy agents that legitimately need deep reasoning; static global breaks the per-tier design.

**(b) Model selection alone (status quo)** — rejected: choosing Haiku for light tasks reduces cost, but within one model class there is no way to tune reasoning depth; a quality profile pays full reasoning cost even for scanning.

**(c) Static per-agent effort only** — rejected: loses context sensitivity; the same agent doing trivial vs complex work should not always get the same effort.

**(d) A separate `effort` field kept fully parallel to Codex's existing `reasoning_effort` (two independent lanes)** — rejected: produces two overlapping fields that can diverge and confuse; Codex's `reasoning_effort` is better modeled as one rendering of the single universal effort.

**(e) Overloading the existing `reasoning_effort` field to also carry Claude effort** — rejected: it would conflate a Codex-specific wire name with the universal concept and break the clean per-runtime rendering.

## References

- Tracking issue: #443
- Prior art (inert reasoning_effort): #2517; `tests/model-resolver.test.cjs` (folds former
  `issue-2517-runtime-aware-profiles`)
- dynamic_routing escalation: #3024; `tests/model-profiles.test.cjs` (folds former `feat-3024-dynamic-routing`, consolidation epic #1969)
- phase-type tiers: #3023
- Anthropic effort API: `output_config.effort` (`low`/`medium`/`high`/`xhigh`/`max`); fast mode: `speed` (`standard`/`fast`)
- Claude Code effort: `/effort`, `--effort`, `CLAUDE_CODE_EFFORT_LEVEL`, `effortLevel` setting, subagent `effort` frontmatter (anthropics/claude-code #31536, completed); fast mode: `/fast` (interactive only)
- OpenAI Codex effort: `model_reasoning_effort` config key; Responses API `reasoning.effort`; `ReasoningEffort` enum `none<minimal<low<medium<high<xhigh`
