# ADR-3159: Dispatch safety is host capability **and** session survivability [Proposed]

- **Status:** Proposed (Phase 0 — ADR only. Phases 1–3 are outstanding, so per the [corpus lifecycle rule](README.md#1-every-adr-declares-one-status-from-the-canonical-vocabulary) this stays `Proposed`; **nothing in this document is true of the tree until Phase 1 merges**.)
- **Date:** 2026-08-22
- **Issue:** [#3159](https://github.com/open-gsd/gsd-core/issues/3159) — `approved-feature`. The maintainer's approval names this ADR as a condition: *"This changes the dispatch predicate from 'is the tool available' to 'is the tool available and will this session outlive the turn', which is an architectural statement about what GSD assumes of a host, not a config toggle."*
- **Builds on:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (**EoS**), which defines the negotiated host-capability axes this decision extends from the other side — the axes describe the *host binary*; this ADR adds the one property that describes the *deployment*.
- **Relationship to prior work:** completes the graduation begun by [#853](https://github.com/open-gsd/gsd-core/issues/853) / [#1708](https://github.com/open-gsd/gsd-core/issues/1708) (`shouldFlattenDispatch` + the `dispatch-should-flatten` query, which replaced a `RUNTIME === 'codex'` prose rule) and [#2584](https://github.com/open-gsd/gsd-core/issues/2584) (`dispatch-isolation`). Related: [#922](https://github.com/open-gsd/gsd-core/issues/922) (the same predicate failing in the opposite direction), [#2939](https://github.com/open-gsd/gsd-core/issues/2939) (the depth-budget correction to the same predicate).
- **Not superseded by, and does not supersede, anything.** Two adjacent items are deliberately *out* of this ADR and tracked separately: [#3178](https://github.com/open-gsd/gsd-core/issues/3178) (the shape-2 spike) and [#3177](https://github.com/open-gsd/gsd-core/issues/3177) (a stale doc line, since closed).

> **Source anchors.** Line numbers below are as of `next` at `2f86278b` and this file is append-only, so they will drift. Where a symbol or section name exists, it is cited instead.

## Context

### GSD already replaced runtime-name guessing with a typed predicate

Two prior decisions moved dispatch safety off prose and onto documentation-sourced capability data:

- `shouldFlattenDispatch` (`src/host-integration.cts`) answers *may this host background a nesting-capable orchestrator, or must it run inline?* Its own docblock records the lineage: it *"graduates the #853 prose rule (originally `RUNTIME === 'codex'`, then extended to cursor) to a typed, documentation-sourced decision."* It is exposed to workflows as `gsd_run query dispatch-should-flatten` (`routeDispatchShouldFlatten`, `gsd-core/bin/gsd-tools.cjs`).
- `dispatch-isolation` (#2584) does the same for executor isolation, *"so the scheduler branches on a declared capability instead of on a runtime id."*

Both are fail-closed by construction. `shouldFlattenDispatch` returns `true` (inline — the always-safe path) for a null, missing, `undocumented`, or insufficient descriptor; the isolation gate in `execute-phase/steps/executor-isolation-dispatch.md` refuses to dispatch at all rather than guess, on the stated principle that *"a guard that cannot verify must not answer 'safe'."*

This is good architecture and this ADR does not disturb it.

### The predicate's inputs are all properties of the host binary

`shouldFlattenDispatch` reads exactly five fields, all from `runtime.hostIntegration.dispatch` in the capability registry:

| Field | Answers |
|---|---|
| `background` | Can this host background a sub-agent at all? |
| `backgroundDispatch` | Can a *backgrounded* sub-agent itself spawn further sub-agents? (the #853 discriminator) |
| `nested`, `subagentToolkit` | Can it host a nesting orchestrator? |
| `maxDepth` | Is there depth budget left for the delegated leaf? |

Every one is sourced from vendor documentation with a cited quote — that is `docs/reference/host-integration-capability-matrix.md`'s entire evidentiary method. For `claude` the matrix cites Claude Code's own sub-agent docs for `dispatch.backgroundDispatch: false`.

**None of the five answers the question that actually determines whether backgrounding is safe: will the orchestrator's own process still exist when the backgrounded work finishes?**

### The failure

A host may drive GSD as a non-interactive one-shot launch (`claude -p "<prompt>"`), one process per stage. In that mode `Agent` *is* available, the descriptor *is* accurate, and the predicate correctly answers "may background" — and then the turn ends and the process exits. A backgrounded executor's completion notification is delivered to a session that no longer exists.

Reported against a real run (#3159): 7 plans across 6 waves; wave 2 was the only multi-plan wave, took the `run_in_background: true` branch, and was the only wave that failed. Its two executors completed **5 commits** and neither wrote its `SUMMARY.md`, having been killed before that step.

**Ownership, stated plainly:** the lost work is the *host's* fault. A wrapper chose a launch model that kills the session at turn end. GSD is not responsible for that, and this ADR does not make a one-shot host a supported posture. What GSD lacks — and what this ADR adds — is a way for such a host to *say so*, so GSD can take the path that is already known to be safe.

### The existing fallback cannot cover it, and says why itself

`<runtime_compatibility>`'s fallback rule instructs the orchestrator to treat a silent agent as successful *"based on spot-checks"* and *"always verify via filesystem and git state."* That is the right instinct and is unreachable here: it presumes an orchestrator alive to spot-check. Under one-shot launch it is not. The same assumption is load-bearing in the safe-resume gate.

### The finding that changes the scope: three notions of "should we background," one owner

The reported failure is at one site. It is not the only site, and a fix scoped to it would leave the same defect standing elsewhere. Auditing every `run_in_background` in shipped content on `next` at `2f86278b`:

Counts below are **`Agent()` parameter sites**, not prose mentions — the two differ by roughly a factor of two in these files, and the distinction is the difference between a real dispatch and a sentence describing one.

| Site | Backgrounds | Gated by |
|---|---|---|
| `manager.md` (2 resolutions → 2 dispatches), `autonomous.md` (2 → 2) | a whole plan/execute stage | **`dispatch-should-flatten`** — the typed predicate |
| `execute-phase.md:682` | wave executors (2+ plans) | **nothing** — the `run_in_background: true` mandate is unconditional prose |
| `docs-update.md` (9) | parallel doc writers, two waves | **nothing** — unconditional |
| `plan-phase.md` (3), `plan-phase/steps/chunked-planning-mode.md` (2) | planners and plan chunks | **nothing** — unconditional |
| `debug.md` (2) | — | pinned `false` deliberately (#2196), with a recorded reason |

Only the first row consults an owner. **Fourteen `Agent()` dispatch sites across three files, plus `execute-phase.md`'s prose mandate, each independently assert an answer to the same question.** The reported repro landed on `execute-phase.md:682`; `docs-update.md` and `plan-phase.md` background into the identical dying session and orphan their own work by the identical mechanism.

(`plan-phase/steps/stall-detection-helpers.md` mentions `run_in_background=true` three times but carries no dispatch of its own — it documents the pattern its caller uses. It is named here only so a reader auditing the same way does not count it twice.)

A config key wired into `execute-phase.md` alone would close the reported instance and leave the class open — and would do it by adding a *fourth* independent notion of "should we background," disagreeing with the typed one. [ADR-3180](3180-planning-semantic-model-single-owner.md) names that shape precisely: a derivation with more than one owner is fixed on one copy and missed on the siblings.

## Decision

### D1 — The dispatch-safety predicate is a conjunction

Backgrounding is safe only when **both** hold:

1. the **host** can background a nesting-capable orchestrator (today's five descriptor fields, unchanged), **and**
2. the **session** will outlive the turn in which the dispatch is made.

Either one false ⇒ inline. This is the architectural statement the maintainer's approval asked this ADR to make: availability and survivability are different properties, and only one of them was being consulted.

### D2 — Survivability is operator-declared, not descriptor-declared

It does **not** become a sixth `dispatch.*` axis.

The capability matrix's evidentiary model requires each axis to carry a vendor-documented citation. "Does this process survive past its turn" is not a property Claude Code's documentation asserts or denies — it is a property of how a *third-party wrapper invoked* Claude Code, and no vendor documents another party's invocation. Adding an uncitable axis to a matrix whose whole discipline is citation would corrode the discipline for one key.

The layering that results is clean and worth stating as the rule: **the descriptor says what the host *can* do; config says what this *deployment* is.**

### D3 — One owner: it enters at the existing predicate

The survivability input is consumed by `shouldFlattenDispatch` and surfaced through the existing `dispatch-should-flatten` query. It is **not** a new branch in workflow prose.

Consequence, and the reason for this choice: every current consumer (`manager.md`, `autonomous.md`) inherits the fix without being edited, and no second predicate exists to drift from the first.

### D4 — The unowned sites come under that owner

`execute-phase.md`'s wave dispatch, `docs-update.md`'s writer waves, and `plan-phase.md` (with its `chunked-planning-mode` step) stop asserting `run_in_background: true` unconditionally and consult the owner instead. `debug.md` is untouched — its `false` is deliberate and already reasoned.

**The `.git/config.lock` rationale is preserved, not traded away.** The existing instruction — dispatch one `Agent()` per message, never all in one message, because simultaneous `git worktree add` calls race on `.git/config.lock` — is orthogonal to the background flag and stays exactly as written. Serialized foreground dispatch is *strictly more* serialized than serialized background dispatch, so the race the rule exists to prevent cannot be reintroduced by this change.

### D5 — Fail closed, and report which input decided

Any unresolvable input yields inline, matching the predicate's existing posture.

`dispatch-should-flatten --json` gains a provenance field distinguishing **`host-capability`** (the descriptor said no), **`session-declared`** (the operator said no), and **`fail-closed`** (something could not be resolved) — so a `shouldFlatten: true` can be explained without reading source. This follows [ADR-1411](1411-resolution-provenance.md): resolution must report its provenance rather than fall open silently. A flag that silently produces the same boolean as a descriptor limitation is undiagnosable in exactly the situation — an unattended one-shot host — where nobody is watching.

### D6 — The key is `workflow.session_outlives_turn`, boolean, default `true`

An opt-out. Default preserves today's behavior byte-for-byte on every currently-supported runtime.

**It is named for the property, not the mechanism, and that is load-bearing.** A mechanism name (`workflow.background_dispatch`, the name the earlier abandoned attempt on PR [#3214](https://github.com/open-gsd/gsd-core/pull/3214) used) collides conceptually with the descriptor's own `dispatch.background` and `dispatch.backgroundDispatch`, which are vendor-sourced and mean different things. Three similarly-named knobs across two layers, one of which silently overrides the others, is the confusion this ADR exists to remove. The key states the fact the operator knows; GSD decides what to do about it.

### D7 — Registration ripple

The key is registered on every seam a config key must reach: the schema manifest's `validKeys`, `SCHEMA_DEFAULTS` (`src/config.cts`), and a `docs/CONFIGURATION.md` row matching the `workflow.use_worktrees` precedent.

**One hazard is called out so it is a design constraint rather than a review finding.** `resolveSchemaDefault` resolves an absent key in two tiers — the hardcoded `SCHEMA_DEFAULTS` first, then the capability-registry `configSchema` default that `capability-activation.cts`'s resolver honors. A key registered in one tier and not the other lets `config-get` and capability activation disagree on the effective default. That is the class [#2256](https://github.com/open-gsd/gsd-core/issues/2256) fixed for existing keys, and a new key can reintroduce it.

## Consequences

**Positive.** A host that knows its own launch model can state it, and gets the path already proven safe. The fix reaches every backgrounding site through one predicate instead of one site through a new branch. Three unowned assertions of a safety-relevant decision collapse onto the owner that already exists for it. The default is unchanged, so no currently-supported runtime is affected.

**Negative.** Declaring `false` costs wave parallelism — that is the trade, and it is real: a phase with multi-plan waves runs strictly slower. GSD acquires a config axis that can be set wrongly in a direction it cannot detect (see Known limits). Bringing the unowned sites under the predicate means four workflow files must read a query they do not read today, which is added surface in high-churn files.

**Expected breakage on landing.** Editing shipped `gsd-core/workflows/*.md` moves emitted-artifact hashes, so the differential attribution check (`tests/emitted-attribution.test.cjs`, [ADR-2719](2719-emitted-artifact-attribution.md)) will fire — correctly. Any ripple not attributable to the diff needs a per-PR fragment under `tests/emitted-drift-acks/`. Growth in those files is separately reported against the size-budget ratchet ([ADR-1610](1610-workflow-agent-size-budget-ratchet.md)), and **`execute-phase.md` has little room**: it is XL-tier against a 96 KiB hard cap and measures 92,356 bytes on `next` at `2f86278b` — under 6 KB of headroom for a file that is also the most-edited in the tree. Phase 2 should reach the predicate through the shortest possible addition there (a resolution plus a conditional), and may need to land the explanatory prose in a `steps/` fragment rather than inline.

**Verification standard.** Phase 3's regression must prove the predicate flips on the *session* input with the *host* input held constant, and vice versa — a test that only exercises the default path passes identically before and after the change it exists to prove.

## Alternatives considered

1. **A sixth `dispatch.*` descriptor axis (`sessionSurvivesTurn`).** Rejected — D2. No vendor citation can exist for it, and the matrix's method is citation. This is the philosophically tidier home and it structurally does not fit; recorded here so a later reader does not re-propose it without the reason.
2. **Name it for the mechanism (`workflow.background_dispatch`).** Rejected — D6. It is the name the earlier attempt used, and it collides with two existing descriptor fields that mean something else.
3. **Branch only in `execute-phase.md`.** Rejected — this is the smallest change that closes the reported repro, and it creates a fourth owner while leaving `docs-update.md` and the stall helper broken against the same host. The narrow fix is what the audit in Context argues against.
4. **A new `execution.*` namespace** (`execution.session_outlives_turn`, the maintainer's own illustrative spelling in the approval). **Deferred to review, not rejected on merit.** `workflow.*` is chosen because it is the established namespace holding every dispatch-shaping toggle (`use_worktrees`, `worktree_skip_hooks`, `agent_hint_routing`) and matches the `workflow.use_worktrees` sizing precedent the approval named; `execution.*` would exist for one key. If the maintainer prefers the new namespace the change is mechanical — the name is the reviewable half of D6, the property-not-mechanism principle is not.
5. **Auto-detect the one-shot posture.** Rejected — there is no reliable signal, and a wrong guess in the permissive direction reproduces the bug while claiming to have fixed it. A predicate that cannot verify must not answer "safe."
6. **Shape 2 — serialize worktree creation, then dispatch synchronously.** *Deferred, not rejected on merit,* and tracked as [#3178](https://github.com/open-gsd/gsd-core/issues/3178). If concurrent foreground `Agent()` dispatch genuinely parallelizes under Claude Code, this removes the *need* for the flag rather than complementing it — a strictly better outcome. It rests on an unestablished premise, touches the highest-churn dispatch path, and would change behavior for every install rather than only affected ones. It is not a substitute for closing this issue, and this ADR is written so that if #3178's premise holds, D1's second conjunct becomes vestigial rather than wrong.
7. **Shape 3 — orchestrator-owned `SUMMARY.md`.** Complementary hardening, not adopted here, per the maintainer's approval. It addresses recoverability after the orphaning; this ADR addresses not orphaning.
8. **`parallelization: false` (today's workaround).** Rejected as the answer. It serializes within a wave so the 2+ branch is never reached, but it is a different property being used as a proxy, it costs parallelism unconditionally, and it does not touch the sites that background regardless of wave width.

## Scope boundary

**In scope:** the dispatch-safety predicate, its second input, the config key that supplies it, provenance reporting on the query, and bringing the unconditional `run_in_background: true` sites under that predicate.

**Out of scope:**

- **Whether concurrent foreground `Agent()` dispatch parallelizes** — [#3178](https://github.com/open-gsd/gsd-core/issues/3178).
- **Making one-shot launch a supported posture.** This ADR makes the property *expressible*; it does not add a runtime, a certification, or a support claim. `docs/` says nothing about orchestrator session lifetime today and this ADR does not change that.
- **The `.git/config.lock` serialization rule.** Preserved verbatim (D4).
- **Recovery after an orphaned wave.** The safe-resume gate and shape 3 own that.
- **`debug.md`'s pinned foreground dispatch.** Already reasoned (#2196), untouched.
- **Every other capability axis and runtime.** No descriptor changes.

## Phases

Each phase is one sub-issue and one PR, per the corpus convention.

| Phase | Owns | Deliverable |
|---|---|---|
| 0 | this ADR | ADR + `node scripts/gen-adr-index.cjs --write` |
| 1 | D1, D2, D5, D6, D7 | the second conjunct in `shouldFlattenDispatch`; the key registered across manifest / `SCHEMA_DEFAULTS` / `docs/CONFIGURATION.md`; provenance on `dispatch-should-flatten --json`; a behavioral `config-set`/`config-get` test; changeset fragment (`Added`) |
| 2 | D3, D4 | `execute-phase.md`, `docs-update.md`, `plan-phase.md` and its `chunked-planning-mode` step consult the owner; emitted-drift-ack fragment if the attribution check requires one |
| 3 | verification | regression proving both conjuncts move the verdict independently, and that a declared non-surviving session takes the inline path at every site from Phase 2 |

Phase 1 ships a real but unreached capability — the key resolves and the predicate honors it, while the three unconditional sites still ignore it until Phase 2. That ordering is deliberate (the config surface is reviewable on its own), and it is the reason **this ADR must not be read as describing the tree until Phase 2 merges**.

## Known limits

Gathered here so a later reader does not have to assemble them from Consequences and Scope boundary:

- **The flag is a declaration, and GSD cannot check it.** A host that sets it wrongly — or never sets it — orphans work exactly as today. This ADR makes the property expressible, not detectable.
- **It does not make one-shot launch supported.** It makes it survivable when declared.
- **The cost is parallelism, unconditionally, for anyone who declares it.** There is no partial mode.
- **It does not address a session that dies for other reasons** — a quota kill, an interrupt, a crash. Those are the safe-resume gate's, and the failure shape is the same even though the cause is not.
- **If [#3178](https://github.com/open-gsd/gsd-core/issues/3178)'s premise holds, D1's second conjunct becomes redundant** for the wave-dispatch case. It would remain correct, and would remain load-bearing for the non-wave sites; it is not written to be thrown away, but it is written to be superseded gracefully.
- **Nothing here is true of the tree until Phases 1–2 merge.** `Proposed` locks nothing.
