# ADR-3159: The dispatch predicate takes a dispatch **kind** and a session **survivability**, not a host descriptor alone [Proposed]

- **Status:** Proposed (Phase 0 — ADR only. Phases 1–3 are outstanding, so per the [corpus lifecycle rule](README.md#1-every-adr-declares-one-status-from-the-canonical-vocabulary) this stays `Proposed`; **nothing in this document is true of the tree until Phase 1 merges**.)
- **Date:** 2026-08-22
- **Issue:** [#3159](https://github.com/open-gsd/gsd-core/issues/3159) — `approved-feature`. The maintainer's approval names this ADR as a condition: *"This changes the dispatch predicate from 'is the tool available' to 'is the tool available and will this session outlive the turn', which is an architectural statement about what GSD assumes of a host, not a config toggle."* This ADR concludes that the approved statement is **half** of the correction; the other half is recorded in D1.
- **Builds on:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (**EoS**), which defines the negotiated host-capability axes. The axes describe the *host binary*; this ADR adds the two things they cannot describe — what is being dispatched, and whether the caller will live to collect it.
- **Relationship to prior work:** completes the graduation begun by [#853](https://github.com/open-gsd/gsd-core/issues/853) / [#1708](https://github.com/open-gsd/gsd-core/issues/1708) (`shouldFlattenDispatch` + the `dispatch-should-flatten` query, which replaced a `RUNTIME === 'codex'` prose rule) and [#2584](https://github.com/open-gsd/gsd-core/issues/2584) (`dispatch-isolation`). Related: [#922](https://github.com/open-gsd/gsd-core/issues/922) (the same predicate failing in the opposite direction), [#2939](https://github.com/open-gsd/gsd-core/issues/2939) (the depth-budget correction to the same predicate).
- **Out of scope, tracked separately:** [#3178](https://github.com/open-gsd/gsd-core/issues/3178) (the shape-2 spike) and [#3177](https://github.com/open-gsd/gsd-core/issues/3177) (a stale doc line, since closed).

> **Source anchors.** Line numbers below are as of `next` at `2f86278b` and this file is append-only, so they will drift. Where a symbol or section name exists, it is cited instead.

## Context

### GSD already replaced runtime-name guessing with a typed predicate

Two prior decisions moved dispatch safety off prose and onto documentation-sourced capability data:

- `shouldFlattenDispatch` (`src/host-integration.cts`) answers *may this host background a nesting-capable orchestrator, or must it run inline?* Its docblock records the lineage: it *"graduates the #853 prose rule (originally `RUNTIME === 'codex'`, then extended to cursor) to a typed, documentation-sourced decision."* It is exposed as `gsd_run query dispatch-should-flatten` (`routeDispatchShouldFlatten`, `gsd-core/bin/gsd-tools.cjs`).
- `dispatch-isolation` (#2584) does the same for executor isolation, *"so the scheduler branches on a declared capability instead of on a runtime id."*

Both fail closed by construction. That posture is correct and this ADR preserves it.

### The predicate answers one question; its callers ask two

`shouldFlattenDispatch` reads five fields, all from `runtime.hostIntegration.dispatch`:

| Field | Answers |
|---|---|
| `background` | Can this host background a sub-agent at all? |
| `backgroundDispatch` | Can a *backgrounded* sub-agent itself spawn further sub-agents? (the #853 discriminator) |
| `nested`, `subagentToolkit` | Can it host a nesting orchestrator? |
| `maxDepth` | Is there depth budget left for the delegated leaf? |

Four of those five are about **nesting**. That is correct for what the function was written for — `manager.md` and `autonomous.md` background an entire plan/execute *stage*, which must itself spawn a planner, a plan-checker, executors and a verifier.

It is wrong for what the rest of the codebase dispatches. **A wave executor spawns nothing.** Neither does a doc writer, a codebase mapper, or a planner — and this is not an inference, it is a property of the shipped agent definitions, which grant no `Agent`/`Task` tool at all:

```
agents/gsd-executor.md        tools: Read, Write, Edit, Bash, Grep, Glob, Skill, mcp__context7__*
agents/gsd-doc-writer.md      tools: Read, Bash, Grep, Glob, Write, Edit, Skill
agents/gsd-codebase-mapper.md tools: Read, Bash, Grep, Glob, Write, Skill
agents/gsd-planner.md         tools: Read, Write, Edit, Bash, Glob, Grep, Skill, WebFetch, mcp__context7__*
```

These are **leaf** dispatches. Asking them to satisfy `backgroundDispatch`/`nested`/`maxDepth > 1` asks them to prove a capability they will never exercise.

**This is measurable today, and it is why the unowned sites are unowned.** On `claude`, whose descriptor declares `background: true` but `backgroundDispatch: false` (`capabilities/claude/capability.json`; cited to Claude Code's own sub-agent docs at `docs/reference/host-integration-capability-matrix.md:87`):

```
$ gsd_run query dispatch-should-flatten --json
{ "runtime": "claude", "shouldFlatten": true, "dispatch": { …, "background": true, "backgroundDispatch": false, … } }
```

The only available predicate says **inline** on the primary runtime. Every site that backgrounds a leaf therefore could not consult it without losing its parallelism, and each hardcoded `run_in_background: true` instead. The unconditional sites are not an oversight; they are what happens when the only predicate on offer answers the wrong question.

### The failure this ADR was opened for

A host may drive GSD as a non-interactive one-shot launch (`claude -p "<prompt>"`), one process per stage. `Agent` is available, the descriptor is accurate, and the leaf dispatch is legitimate — then the turn ends and the process exits. A backgrounded executor's completion notification is delivered to a session that no longer exists.

Reported against a real run (#3159): 7 plans across 6 waves; wave 2 was the only multi-plan wave, took the `run_in_background: true` branch, and was the only wave that failed. Its two executors completed **5 commits** and neither wrote its `SUMMARY.md`.

**Ownership, stated plainly:** the lost work is the *host's* fault. A wrapper chose a launch model that kills the session at turn end. This ADR does not make one-shot launch a supported posture. It gives such a host a way to *say so*.

The existing fallback cannot cover it, and says why itself: `<runtime_compatibility>`'s rule instructs the orchestrator to treat a silent agent as successful *"based on spot-checks"* and to *"always verify via filesystem and git state."* That presumes an orchestrator alive to spot-check.

### The audit: 20 unowned dispatch sites across 6 files

Counted as **`Agent()` parameter sites**, not prose mentions — the two differ by roughly a factor of two in these files.

| Site | Backgrounds | Kind | Gated by |
|---|---|---|---|
| `manager.md` (2), `autonomous.md` (2) | a whole plan/execute stage | orchestrator | **`dispatch-should-flatten`** |
| `execute-phase.md:682` | wave executors | leaf | **nothing** — an unconditional prose mandate |
| `docs-update.md` (9) | doc writers, two waves | leaf | **nothing** |
| `docs-update/steps/dispatch-monorepo-packages.md` (1) | per-package doc writers | leaf | **nothing** |
| `plan-phase.md` (3), `plan-phase/steps/chunked-planning-mode.md` (2) | planners and plan chunks | leaf | **nothing** |
| `map-codebase.md` (4) | codebase mappers | leaf | **nothing** |
| `autonomous/steps/converge-dispatch-bg.md` (1) | convergence pass | leaf | **nothing** |
| `debug.md` (2) | — | — | pinned `false` deliberately (#2196) |
| `commands/gsd/graphify.md`, `skills/gsd-graphify/SKILL.md` | — | — | prose **prohibitions** ("Do NOT pass `run_in_background: true`"), not dispatches |

Four gated sites; **20 ungated ones across six files**, plus `execute-phase.md`'s prose mandate. [ADR-3180](3180-planning-semantic-model-single-owner.md) names this shape: a derivation with more than one owner is fixed on one copy and missed on the siblings.

(`plan-phase/steps/stall-detection-helpers.md` mentions `run_in_background=true` three times but carries no dispatch of its own — it documents the pattern its caller uses. Named here so a reader auditing the same way does not double-count it.)

## Decision

### D1 — The dispatch question has two axes, and neither was fully specified

Whether a dispatch may be backgrounded depends on:

1. **Kind** — is the dispatched agent a *leaf* (spawns nothing) or an *orchestrator* (must itself delegate)? A leaf requires only `background === true`. An orchestrator additionally requires `backgroundDispatch`, `nested`, `subagentToolkit: 'full'`, and depth budget above 1 — today's rule, unchanged.
2. **Survivability** — will the dispatching session outlive the turn to collect the result? Required by **both** kinds.

The approval framed this as adding a survivability conjunct. That is necessary and not sufficient: adding it to a predicate that already asks the wrong question of leaf callers would answer "inline" on Claude for every leaf site. **The predicate was under-parameterized in two dimensions; survivability is the second one.**

### D2 — Kind is declared by the call site, and is checkable against the agent definition

The dispatching workflow declares what it is dispatching. It is not inferred from the descriptor, which describes the host and cannot know what GSD is about to spawn.

The declaration is **falsifiable**, which is what keeps it from rotting: an agent dispatched as `leaf` must grant no `Agent`/`Task` tool in `agents/<name>.md`. Phase 3 asserts this over every dispatch site, so a future agent that gains the tool without its call sites being reclassified fails the suite rather than silently backgrounding a nesting agent into a depth budget that cannot hold it — the #2939 failure, re-entered from the other side.

### D3 — Survivability is operator-declared, not descriptor-declared

It does **not** become a sixth `dispatch.*` axis. The capability matrix requires each axis to carry a vendor-documented citation, and "does this process survive past its turn" is a property of how a *third-party wrapper invoked* the host — no vendor documents another party's invocation. Adding an uncitable axis to a matrix whose discipline is citation would corrode that discipline for one key.

The resulting layering: **the descriptor says what the host *can* do; the call site says what is being dispatched; config says what this *deployment* is.**

### D4 — One owner, parameterized — not forked, and not naively conjoined

`shouldFlattenDispatch` takes the dispatch kind and the survivability input alongside the descriptor. It is not split into `shouldFlattenOrchestrator`/`shouldFlattenExecutor`, and the second axis is not bolted onto the existing orchestrator-grade rule.

The existing signature accepts only `dispatch` and is exported through the public SDK (`src/host-integration-sdk.cts`), so Phase 1 owns the compatibility question explicitly: the added parameters are optional, and an omitted kind defaults to `orchestrator` — the stricter of the two — so any caller not yet updated keeps today's exact verdict.

Rejecting a fork is not aesthetic. Two predicates would answer the same question — *may this be backgrounded* — from two bodies of code, which is the ADR-3180 shape this ADR is otherwise arguing against.

### D5 — The ungated sites come under the owner, declaring their kind

The 20 sites in the audit consult the predicate and declare `leaf`. `manager.md` and `autonomous.md` continue to consult it and declare `orchestrator`. `debug.md` is untouched — its `false` is deliberate and already reasoned. The graphify prohibitions are untouched; they are not dispatches.

**The `.git/config.lock` rationale is preserved, not traded away.** The existing instruction — dispatch one `Agent()` per message, never all in one message, because simultaneous `git worktree add` calls race on `.git/config.lock` — is orthogonal to the background flag and stays exactly as written. Serialized foreground dispatch is *strictly more* serialized than serialized background dispatch, so the race cannot be reintroduced.

### D6 — Fail closed, and report which input decided

Any unresolvable input yields inline, matching the predicate's existing posture.

`dispatch-should-flatten --json` gains a provenance field distinguishing **`host-capability`**, **`session-declared`**, and **`fail-closed`**, following [ADR-1411](1411-resolution-provenance.md). A flag that silently produces the same boolean as a descriptor limitation is undiagnosable in exactly the situation — an unattended one-shot host — where nobody is watching.

**This is an observable output-contract change.** The documented shape is `{ runtime, shouldFlatten, dispatch }` and tests pin it (`tests/command-routing-hub.test.cjs`). Phase 1 adds a field rather than altering one, updates those tests, and states that consumers may not assume the object is closed. The `--raw` form still prints exactly `true` or `false` and is unchanged.

### D7 — The key is `workflow.session_outlives_turn`, boolean, default `true`

An opt-out, **named for the property, not the mechanism.** A mechanism name (`workflow.background_dispatch`, used by the earlier abandoned attempt on PR [#3214](https://github.com/open-gsd/gsd-core/pull/3214)) collides conceptually with the descriptor's own `dispatch.background` and `dispatch.backgroundDispatch`, which are vendor-sourced and mean different things. The key states the fact the operator knows; GSD decides what to do about it.

### D8 — The default is declared in the schema, and the value is validated

Registered in the schema manifest's `validKeys`, in `SCHEMA_DEFAULTS` (`src/config.cts`), and as a `docs/CONFIGURATION.md` row.

**`workflow.use_worktrees` is the sizing precedent, and explicitly not the registration precedent.** Measured against an empty `.planning/config.json` on `next` at `2f86278b`:

| Key | Registered in | `config-get` result |
|---|---|---|
| `git.create_tag` | `validKeys` + `SCHEMA_DEFAULTS` | `true`, exit 0 |
| `workflow.use_worktrees` | `validKeys` only | `Error: Key not found`, exit 1 |
| an unregistered key | nothing | `Error: Key not found`, exit 1 |

The last two rows are **output-identical**: `use_worktrees` is indistinguishable from a key nobody registered, its default existing only as a repeated `|| echo "true"` at each bash call site.

**A malformed value is the live hazard, and it fails open.** `config-set` performs no boolean validation for keys of this shape — `gsd_run query config-set workflow.use_worktrees garbage` succeeds and stores the string `"garbage"`. A `session_outlives_turn` set to `"fasle"` is *not* `false`, so a permissive consumer concludes the session survives and backgrounds — the precise orphaning D6 exists to prevent. Phase 1 therefore adds strict boolean validation at `config-set` **and** strict parsing at the consumer: anything that is not exactly boolean `false` (or the string `"false"`) is treated as unresolvable, which fails closed to inline rather than open to backgrounding.

**One further hazard, called out so it is a design constraint rather than a review finding.** `resolveSchemaDefault` resolves an absent key in two tiers — `SCHEMA_DEFAULTS` first, then the capability-registry `configSchema` default that `capability-activation.cts`'s resolver honors (`src/capability-activation.cts`). A key registered in one tier and not the other lets `config-get` and capability activation disagree on the effective default. That is the class [#2256](https://github.com/open-gsd/gsd-core/issues/2256) fixed for existing keys. Phase 1 registers both tiers and tests the resolution path the predicate actually uses, not only `config-get`.

## Consequences

**The default is preserved, and here is the evaluation rather than the assertion.** On `claude` (`background: true`, `backgroundDispatch: false`) with the key at its default `true`:

| Call site | Kind | Today | After |
|---|---|---|---|
| `manager.md`, `autonomous.md` | orchestrator | `shouldFlatten: true` → inline | `shouldFlatten: true` → inline |
| the 20 ungated sites | leaf | hardcoded background | `background: true` ∧ survivable → background |

Both rows are unchanged. The earlier draft of this ADR routed leaf sites through the orchestrator-grade rule and would have forced every one of them inline on the primary runtime; that is recorded as rejected Alternative 3.

**Positive.** A host that knows its own launch model can state it. Twenty independent assertions of a safety-relevant decision collapse onto one owner. The predicate stops asking leaf dispatches to prove they can nest, which removes the reason the ungated sites were ungated. The kind declaration is machine-checkable against the agent definitions.

**Negative.** Declaring `false` costs parallelism at every leaf site — that is the trade, and it is real. GSD acquires a config axis that can be set wrongly in a direction it cannot detect. Six workflow files must read a query they do not read today. The predicate takes three inputs where it took one, and a caller that omits the kind gets the strict answer, which is safe but can silently under-parallelize if a site is added without one.

**Expected breakage on landing.** Editing shipped `gsd-core/workflows/*.md` moves emitted-artifact hashes, so the differential attribution check (`tests/emitted-attribution.test.cjs`, [ADR-2719](2719-emitted-artifact-attribution.md)) will fire — correctly. Ripples not attributable to the diff need a per-PR fragment under `tests/emitted-drift-acks/`. Growth is separately reported against the size-budget ratchet ([ADR-1610](1610-workflow-agent-size-budget-ratchet.md)), and **`execute-phase.md` has little room**: XL-tier against a 96 KiB hard cap, measuring 92,356 bytes on `next` at `2f86278b` — under 6 KB of headroom in the most-edited file in the tree. Phase 2 should reach the predicate through the shortest possible addition there and may need to land explanatory prose in a `steps/` fragment.

**Verification standard.** Phase 3's regression must move the verdict on each axis with the others held constant — kind alone, survivability alone, descriptor alone. A test that exercises only the default path passes identically before and after the change it exists to prove.

## Alternatives considered

1. **A sixth `dispatch.*` descriptor axis (`sessionSurvivesTurn`).** Rejected — D3. No vendor citation can exist for it, and the matrix's method is citation.
2. **Name it for the mechanism (`workflow.background_dispatch`).** Rejected — D7. Collides with two existing descriptor fields that mean something else.
3. **Add survivability as a conjunct to the existing predicate, leaving it otherwise unchanged.** **Rejected on measured evidence, and this was the earlier draft of this ADR.** `dispatch-should-flatten` returns `shouldFlatten: true` for `claude` today, because Claude declares `backgroundDispatch: false`. Routing leaf sites through that rule would have disabled wave parallelism on the primary runtime by default — a silent, severe regression presented as a no-op opt-out. The error was conflating "may GSD background an orchestrator that must itself delegate" with "may this orchestrator background a leaf and stay alive."
4. **Fork into `shouldFlattenOrchestrator` / `shouldFlattenExecutor`.** Rejected — D4. It fixes the semantics and reintroduces the two-owner shape.
5. **Branch only in `execute-phase.md`.** Rejected — the smallest change that closes the reported repro, and it leaves nineteen sites broken against the same host while adding another owner.
6. **A new `execution.*` namespace** (`execution.session_outlives_turn`, the approval's illustrative spelling). **Deferred to review, not rejected on merit.** `workflow.*` holds every dispatch-shaping toggle (`use_worktrees`, `worktree_skip_hooks`, `agent_hint_routing`) and matches the sizing precedent the approval named; `execution.*` would exist for one key. Mechanical to change; the property-not-mechanism principle in D7 is not.
7. **Auto-detect the one-shot posture.** Rejected — no reliable signal, and a wrong guess in the permissive direction reproduces the bug while claiming to have fixed it.
8. **Shape 2 — serialize worktree creation, then dispatch synchronously.** *Deferred, not rejected on merit,* tracked as [#3178](https://github.com/open-gsd/gsd-core/issues/3178). If concurrent foreground `Agent()` dispatch genuinely parallelizes, it removes the *need* for the survivability axis rather than complementing it. It rests on an unestablished premise and would change behavior for every install. This ADR is written so that if #3178's premise holds, D1's second axis becomes vestigial rather than wrong — the kind axis stands regardless.
9. **Shape 3 — orchestrator-owned `SUMMARY.md`.** Complementary hardening, not adopted here, per the approval. It addresses recoverability after orphaning; this ADR addresses not orphaning.
10. **`parallelization: false` (today's workaround).** Rejected as the answer. A different property used as a proxy, costing parallelism unconditionally, and it does not touch the sites that background regardless of wave width.

## Scope boundary

**In scope:** the dispatch predicate's two missing parameters, the config key supplying one of them, provenance reporting, and bringing the ungated sites under the predicate.

**Out of scope:**

- **Whether concurrent foreground `Agent()` dispatch parallelizes** — [#3178](https://github.com/open-gsd/gsd-core/issues/3178).
- **Making one-shot launch a supported posture.** This ADR makes the property *expressible*. `docs/` asserts nothing about orchestrator session lifetime today and this ADR does not change that.
- **The `.git/config.lock` serialization rule.** Preserved verbatim (D5).
- **Recovery after an orphaned wave.** The safe-resume gate and shape 3 own that.
- **`debug.md`'s pinned foreground dispatch** (#2196) and the graphify prohibitions. Untouched.
- **Every capability descriptor and runtime.** No descriptor changes.

## Phases

Each phase is one sub-issue and one PR, per the corpus convention.

| Phase | Owns | Deliverable |
|---|---|---|
| 0 | this ADR | ADR + `node scripts/gen-adr-index.cjs --write` |
| 1 | D1–D4, D6–D8 | the kind + survivability parameters on `shouldFlattenDispatch` (optional, defaulting to `orchestrator`); the key registered across manifest / `SCHEMA_DEFAULTS` / registry `configSchema` / `docs/CONFIGURATION.md`; strict boolean validation at `config-set` and strict parsing at the consumer; provenance on `--json` with its pinned tests updated; changeset fragment (`Added`) |
| 2 | D5 | the six ungated files declare `leaf`; `manager.md` / `autonomous.md` declare `orchestrator`; emitted-drift-ack fragment if the attribution check requires one |
| 3 | verification | per-axis regressions; the D2 assertion that every site declared `leaf` dispatches an agent granting no `Agent`/`Task` tool; a declared non-surviving session takes the inline path at every site |

Phase 1 ships a real but unreached capability — the predicate honors both new inputs while the ungated sites still ignore it until Phase 2. That ordering is deliberate, and it is why **this ADR must not be read as describing the tree until Phase 2 merges**.

## Known limits

- **The flag is a declaration, and GSD cannot check it.** A host that sets it wrongly — or never sets it — orphans work exactly as today. This ADR makes the property expressible, not detectable.
- **It does not make one-shot launch supported.** It makes it survivable when declared.
- **The cost is parallelism, unconditionally, for anyone who declares it.** There is no partial mode.
- **The kind declaration can be forgotten.** A new dispatch site with no kind gets `orchestrator` and may under-parallelize. That is the safe direction, and Phase 3's assertion catches the inverse error, but neither catches a site that simply omits the query.
- **It does not address a session that dies for other reasons** — a quota kill, an interrupt, a crash. Those are the safe-resume gate's, though the failure shape is the same.
- **If [#3178](https://github.com/open-gsd/gsd-core/issues/3178)'s premise holds, the survivability axis becomes redundant** for the wave-dispatch case. The kind axis stands either way.
- **Nothing here is true of the tree until Phases 1–2 merge.** `Proposed` locks nothing.

## Provenance

The first draft of this ADR proposed Alternative 3 — survivability as a conjunct on the unmodified predicate — and asserted that the default was preserved. Two independent adversarial reviews (codex; antigravity/Gemini 3.1 Pro) each ran `dispatch-should-flatten` against the live registry, found `shouldFlatten: true` for `claude`, and identified the regression. The leaf/orchestrator decomposition in D1 and the machine-checkable kind declaration in D2 are the result. Recorded because the rejected design is the one a reader is most likely to re-propose, and because the evidence that killed it — one query invocation — is cheaper than the argument.
