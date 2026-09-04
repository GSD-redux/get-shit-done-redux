# ADR-2313: Codex Adopts the Passive / Session-Only Model Posture

- **Status:** Accepted (Phase 0 — ADR only; locks the contract Phases 1–5 execute against. **No production code lands in this PR, and the posture is not real until Phase 1 merges.**)
- **Date:** 2026-08-09
- **Issue:** [#2313](https://github.com/open-gsd/gsd-core/issues/2313) — epic (`enhancement` + `approved-enhancement`). This Phase-0 sub-issue: [#3240](https://github.com/open-gsd/gsd-core/issues/3240)
- **Supersedes:** [#2517](https://github.com/open-gsd/gsd-core/issues/2517)'s Codex per-tier `model` embedding **on the default path only**. Explicit `model_overrides` pins are unaffected; other runtimes are untouched.
- **Builds on:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (**EoS**), which classifies Codex `modelMode: passive`. This ADR is the install-time half its `:137` boundary note names as "not yet written".
- **Relationship to prior work:** completes [#2310](https://github.com/open-gsd/gsd-core/issues/2310) / PR [#2312](https://github.com/open-gsd/gsd-core/pull/2312), which shipped the emission *guard*. Related model defaults: [#2122](https://github.com/open-gsd/gsd-core/issues/2122) (GPT-5.6 family), [#838](https://github.com/open-gsd/gsd-core/issues/838) (model ⇄ effort coupling), [#774](https://github.com/open-gsd/gsd-core/issues/774) (light-tier `service_tier`/`model_verbosity`).

## Context

ADR-1239 classifies every supported host along eight negotiated axes. For Codex it records
`modelMode: passive` — and it is unusually explicit about what that means. Cited by section rather
than line number, because ADR-1239 is append-only and its line numbers move:

> **Interface point 3, Model:** `passive`: instruction-injection only; **no tier routing**
> — *§ Per-interface-point capability + degradation ladder*

> Codex … `max_depth=1` · **passive (session-only)**
> — *§ Appendix — per-host capability matrix*

> `embeddingMode: declarative` · `commandSurface: slash-file` · **`modelMode: passive`** · …
> — *§ Codex binding (worked host-plugin)*

The installer does not behave that way. `bin/install.js` `generateCodexAgentToml` resolves a
per-agent `model` for the generated `~/.codex/agents/<agent>.toml` in two steps: an explicit
`model_overrides` pin (#2256), and failing that **the runtime-aware tier resolver** added by
#2517, which embeds a per-tier Codex model (`opus→gpt-5.6-sol`, `sonnet→gpt-5.6-terra`,
`haiku→gpt-5.6-luna`, from the #2122 defaults).

That second step treats Codex as a host that supports per-agent model routing. It does not.

### The failure this produces

On a **ChatGPT-account** Codex only the session model is exposed. A `.toml` pinning a model the
account does not carry fails the request outright:

```
400 invalid_request_error: "The 'sonnet' model is not supported when using Codex with a ChatGPT account."
```

That is [#2310](https://github.com/open-gsd/gsd-core/issues/2310) / #2311 (closed duplicate). The
blast is not confined to one agent: a typed agent spawn that 400s degrades the whole plan/execute
flow to the non-equivalent generic-agent workaround, so the user loses the routing GSD was trying
to give them *and* the agent specialization, in exchange for a pin that never worked.

PR #2312 fixed the *alias* half — never write an Anthropic-flavored value (`opus`/`sonnet`/
`haiku`/`fable`, or a `claude-*` id in any provider namespacing). It did not fix the general case:
a **real** Codex model id the account does not expose 400s exactly the same way, and the
runtime-resolver path still pins one by default.

### Two adjacent gaps the same posture closes

- **The install-check validates presence, not correctness.** `checkAgentsInstalled` confirms the
  manifest is complete and the declared agents exist on disk. An install carrying `model = "sonnet"`
  from before PR #2312 reports healthy until the spawn 400s.
- **There is no Codex `.toml` sync path.** `cmdEffortSync` (`src/commands.cts`) re-syncs `effort:`
  frontmatter for Claude `.md` agents and returns early for every other runtime. A stale Codex
  install is only fixable by a full reinstall.

## Decision

**Codex adopts the passive / session-only posture ADR-1239 already assigns it.** Concretely:

### D1 — Omit the per-agent `model` by default

`generateCodexAgentToml` emits **no** `model` line unless a model is explicitly pinned. The agent
inherits the Codex session model, which the account is guaranteed to expose. This cannot 400.

### D2 — Embed a `model` only for an explicit real-Codex pin

A `model_overrides` entry naming a real Codex model id (`gpt-5.6-sol`, …) is embedded verbatim.
This is the supported, and now the *only*, way to pin a Codex model.

### D3 — Never emit an Anthropic-flavored model

The #2310 guard stands: a bare tier alias (`opus`/`sonnet`/`haiku`/`fable`) or any `claude-*` id
in any provider namespacing is dropped with a deduped stderr warning. D1 makes the
runtime-resolver route to this gate unreachable by construction; **the gate is retained anyway**,
because the `model_overrides` route to it remains live.

### D4 — `model_reasoning_effort` stays coupled to a pinned model

No pin ⇒ no effort line (#838). A `.toml` with no `model` but a static `model_reasoning_effort`
is partial routing: the model follows the Codex UI while the effort follows GSD. The knobs move
together or not at all.

### D5 — Supersede #2517 on the default path

The runtime-resolver per-tier `model` embedding for Codex is removed. #2517's explicit-runtime
resolution is otherwise preserved, and every other runtime is untouched.

### D6 — Validate posture, not just presence

The install-check gains a Codex posture check: an installed `.toml` embedding an Anthropic-flavored
`model`, or carrying an orphaned `model_reasoning_effort`, is a reported violation.

### D7 — Repair stale installs without a reinstall

The effort/model sync gains a Codex `.toml` path that strips a stale Anthropic/tier `model` and an
orphaned effort, leaving legal pins intact.

### What the posture does **not** cover

`service_tier` and `model_verbosity` for light-tier agents (#774) are cost and verbosity knobs, not
routing. They are emitted independently of `model` and are unaffected by D1–D4.

## The reader/writer boundary

D6 and D7 both read a file D1–D4 write, and the file is user-editable — Codex reads it too. The
postures differ, deliberately, and conflating them is the trap:

**Writing is conservative.** Emit the minimal legal document. Never emit a value known to be
rejected.

**The health-check is liberal in parsing, strict in judging.** It tolerates comments, key ordering,
CRLF, and **extra keys GSD does not emit** — a user who hand-added `approval_policy` has not
violated the posture. The check is a predicate on the two fields the posture owns (`model`,
`model_reasoning_effort`), never a whitelist over the document. When it does find a violation it
names the agent and the offending value rather than reporting a bare count.

**The sync is liberal but visible, and never guesses.** It rewrites the user's file, so
"be liberal in what you accept" is precisely the instinct that produces silent data loss here:

- dry-run remains the default, and every strip is reported as a structured `{from, to}` change;
- a legal pin and its coupled effort survive untouched — reported `skipped`, not `synced`;
- **an unparseable document is skipped and reported, never partially rewritten.** A duplicate
  `[table]` or trailing garbage is a refusal, not a best-effort edit;
- the literal text `model = ` occurring **inside** the `'''`-quoted `developer_instructions` block
  is not a pin and must not be rewritten. The emitter writes agent prompts into that block and GSD's
  agent prompts discuss models constantly, so a line-oriented `/^model\s*=/m` strip corrupts the
  agent. This is the most likely way the sync ships a data-loss bug, and it is called out here so
  it is a design constraint rather than a review finding.

## Migration

**This is a breaking change, and the recourse is explicit.**

Codex agents installed with a `runtime` set in config and a non-`inherit` `model_profile` stop
receiving per-tier GPT-5.6 pins by default — they omit, and inherit the session model.

**Who this actually reaches, stated precisely, because "non-`inherit`" understates it.**
`readGsdRuntimeProfileResolver` (`bin/install.js`) returns `null` — no resolver, therefore no
embedded model even today — in exactly two cases: no `runtime` in project or home config, or
`model_profile === 'inherit'`. Everyone else gets a resolver, and **`model_profile` defaults to
`'balanced'`**. So the affected population is *every* Codex user who set a `runtime` and did not
explicitly opt into `inherit` — the default configuration, not an exotic one. Conversely, a user
already on `inherit` sees **no change at all**; their `.toml` has never carried a pin.

The users who lose something real are on an **API-key** Codex account whose account *does* expose
`gpt-5.6-sol`/`terra`/`luna`. For them the fix is one line per agent:

```json
{ "model_overrides": { "gsd-planner": "gpt-5.6-sol" } }
```

`model_overrides` with a real Codex model id is the retained pin mechanism (D2). It is unaffected
by this ADR and is the supported path forward.

**No deprecation window is offered.** The default flips in a single release rather than warning
first. That is a genuine departure from the usual "deprecate slowly and loudly" discipline, taken
because the current default hard-400s for the majority (ChatGPT) account type — the behavior being
removed is one most affected users could never successfully use. The cost is stated rather than
elided: an API-key user on a non-`inherit` profile will see their tier routing disappear in a minor
release and must consult this section to restore it. Phase 1's changeset leads with the migration
line for that reason.

## Consequences

**Positive.** Codex agents launch reliably, because the session model is always available. GSD's
Codex behavior matches ADR-1239's own classification of it instead of contradicting it. Stale
installs become detectable (D6) and repairable (D7) rather than requiring a reinstall. The
`.toml` GSD emits gets smaller and has fewer ways to be wrong.

**Negative.** Per-tier routing on Codex is gone by default, including for the API-key users who
could use it — recovered only by an explicit pin. GSD now owns a posture *validator* and a
*repairer* as permanent surface, both of which must track any future change to the emitted `.toml`
shape. Three surfaces (emitter, checker, syncer) now read one rule, which is a
generative-fix-divergence risk; it is mitigated by extracting the predicate into a single module in
Phase 1 with a parity assertion test, not by discipline.

**Expected breakage on landing.** Removing a line from an emitted artifact moves that artifact's
hash, so Phase 1 must expect the emitted-artifact gates to fire — correctly. The live gate is the
**differential attribution check** (`tests/emitted-attribution.test.cjs`,
[ADR-2719](2719-emitted-artifact-attribution.md)), which requires every moved hash to be
attributable to the diff, plus the committed `tests/fixtures/install-tree/*.json` family that
ADR-2719 §7 deliberately keeps and `npm run gen:install-tree` regenerates.

*Not* `golden-install-parity/codex.json`: that fixture family and
`tests/golden-install-parity.test.cjs` were **deleted** by ADR-2719 Phase 4 (#2724) and no longer
exist in the tree. ADR-1239's Codex-binding section still names the retired fixture; it is recorded
here so a Phase-1 implementer does not go looking for a gate that was removed a release ago.

`tests/codex-config.test.cjs` and `tests/model-resolver.test.cjs` (folds former
`issue-2517-runtime-aware-profiles`) assert the embedding today and flip to assert omission in the
same phase.

## Alternatives considered

1. **Keep #2517's per-tier embedding and force `runtime="codex"` resolution at install time.**
   Rejected: it still 400s on a ChatGPT-account Codex that lacks the pinned model — the resolution
   path was never the defect — and it entrenches the contradiction with ADR-1239's `passive`
   classification.
2. **Persist `runtime:"codex"` into the shared `~/.gsd/defaults.json`.** Rejected: that is exactly
   the cross-runtime poisoning open bug [#2297](https://github.com/open-gsd/gsd-core/issues/2297)
   flags. Recorded here as a standing constraint: no phase of this epic writes shared defaults.
3. **Hybrid — pin when the model is available, omit when it is not.** *Deferred, not rejected on
   merit.* It needs a model-availability signal Codex does not clearly expose. If Codex later
   exposes one, this is the design to revisit, and D1 becomes its fallback rung rather than its
   replacement.
4. **An allowlist of legal Codex model ids** instead of the Anthropic-flavored predicate. Rejected:
   an allowlist goes stale the moment OpenAI ships a model, which reintroduces "GSD pins a model
   the account cannot use" one layer up — the same defect with a different cause.
5. **Fold this into ADR-1239 as an amendment.** Rejected: ADR-1239:137 scopes itself to the
   *invocation-time* effort channel and names this as a separate ADR owning the *install-time*
   channel. Folding it in erases a boundary that ADR was deliberate about.

## Scope boundary

**In scope:** the static / install-time channel — what GSD writes into
`~/.codex/agents/<agent>.toml`, how it validates what is already written, and how it repairs it.

**Out of scope:**

- **Invocation-time orchestrator effort-override drift.** ADR-1239:137 draws this line from the
  other side; this ADR restates it. The two channels may share a descriptor once `EFFORT_RENDERING`
  folds in, but not here.
- **Re-architecting `agent_runtime` derivation.** Phase 5 corrects `init`'s *report* of the
  detected host (folded from [#2320](https://github.com/open-gsd/gsd-core/issues/2320)); the
  broader runtime-identity model and its intersection with #2297 is not redesigned here.
- **Every non-Codex runtime.** Claude, OpenCode, Kilo, Hermes and the rest keep their current model
  handling unchanged.

## Phases

Each phase is one sub-issue and one PR. `/adr-phase-coverage` reports every decision above owned by
exactly one phase, and every user-facing capability wired by an owning phase.

| Phase | Sub-issue | Owns | Deliverable |
|---|---|---|---|
| 0 | [#3240](https://github.com/open-gsd/gsd-core/issues/3240) | this ADR | ADR + index regen + the ADR-1239 cross-ref |
| 1 | [#3241](https://github.com/open-gsd/gsd-core/issues/3241) | D1–D5 | emission rework in `generateCodexAgentToml`; extract the posture predicate into one module with a parity test |
| 2 | [#3242](https://github.com/open-gsd/gsd-core/issues/3242) | D6 | posture health-check, as a **new exported function** — `checkAgentsInstalled` carries 33 dependents and cyclomatic 25 and does not get more branches |
| 3 | [#3243](https://github.com/open-gsd/gsd-core/issues/3243) | D7 | Codex `.toml` sync path |
| 4 | [#3244](https://github.com/open-gsd/gsd-core/issues/3244) | end-to-end proof | smoke test: researcher/planner/checker under **both** `model_profile: balanced` (the default, and the path that actually changes) **and** `inherit` — see the scoping correction below |
| 5 | [#3245](https://github.com/open-gsd/gsd-core/issues/3245) | #2320 fold | `init` reports the detected host; explicit `config.runtime` still overrides; no `defaults.json` write |

**Phase 5 exists because the coverage gate found it missing.** The #2320 fold was promised in a
maintainer comment on #2313 but claimed by none of the phases in the epic body, which lists 0–4 —
the promised-but-not-built shape that gate exists to catch. It is owned rather than dropped.

**Phase 4's scope is corrected here, and the correction is the point.** The epic body scopes the
smoke test to `model_profile: inherit`. That profile is precisely the one this ADR does **not**
change: `readGsdRuntimeProfileResolver` already returns `null` for `inherit`, so a Codex install
under `inherit` omits the model today, before Phase 1. A smoke test scoped only to `inherit` would
therefore pass identically before and after the change it exists to prove — green, and vacuous.

Phase 4 must cover `model_profile: balanced` (the default, and the path that actually loses its
pin) as the primary case, keeping `inherit` as the unchanged control. Asserting both is what makes
the test a regression test rather than a tautology, and it is the difference between proving the
posture and proving that `inherit` still behaves the way it always did.

## Known limits

What this ADR deliberately does **not** fix, gathered in one place so a later reader does not have
to assemble it from Consequences and Scope boundary:

- **API-key Codex users lose per-tier routing, with no automatic migration.** The recourse is an
  explicit `model_overrides` pin (see Migration). Accepted as the cost of the default flip; not
  mitigated further.
- **No deprecation window.** The default flips in a single minor release. A genuine departure from
  deprecate-slowly-and-loudly, taken because the behavior being removed hard-400s for the majority
  account type — but it is a departure, and no warning release is offered.
- **No model-availability detection.** GSD does not learn which models a Codex account exposes; it
  avoids the question by not pinning. Alternative 3 is the design to revisit if Codex ever exposes
  such a signal.
- **Invocation-time effort-override drift is untouched.** ADR-1239's boundary.
- **`agent_runtime` derivation is not re-architected.** Phase 5 corrects `init`'s *report* only.
- **Every non-Codex runtime is untouched**, including hosts that also lack real tier routing. This
  ADR does not generalize the posture; extending it to another host would be its own decision.
- **The posture is not real until Phase 1 merges.** `Accepted` locks the contract, not the tree —
  until #3241 lands, `generateCodexAgentToml` still embeds a per-tier model.

## Amendment (2026-08-09): a deprecation notice IS offered (#3241)

Recorded as a dated section rather than by editing the Migration section or the Known limits bullet
above, since ADRs here are append-only. Both now read as superseded on this one point; the rest of
each stands.

**What changed.** This ADR's Migration section states *"No deprecation window is offered. The default
flips in a single release rather than warning first,"* and Known limits repeats it. Phase 1 (#3241)
ships a deprecation notice instead, by maintainer direction taken after this ADR merged.

**Why the original position was wrong, precisely.** The argument for flipping silently was that the
behavior being removed *"is one most affected users could never successfully use"* — it 400s on a
ChatGPT-account Codex. That is true of the ChatGPT population and false of the API-key population,
which is exactly the group the Migration section already identifies as *losing something real*. The
ADR named a class of user harmed by the change and then declined to warn them, in the same document.
Hyrum's Law's own guidance — break a long-lived observable behavior when you must, but give a
migration path — was applied to the *recourse* (`model_overrides` stays) and not to the *notice*.

**The notice.** One line to stderr per install, emitted only for the population that actually loses a
pin: the runtime resolver would have supplied a model, and nothing ends up pinned. It names
`model_overrides` as the recovery mechanism and the session model as what the agent gets instead.

It deliberately names **no agent and no model**. The condition is per-install, not per-agent — every
agent hits it simultaneously — so per-agent detail would imply a per-agent decision that was not made,
and ~20 identical lines would train the reader to ignore them. It carries no interpolated
user-controlled value, which is why it needs none of the length-capping the adjacent
`_warnCodexModelOverrideDropped` applies.

It does **not** fire when the resolver is null (`inherit`, or no configured `runtime`), when the
resolver resolves to nothing, or when an explicit real-Codex pin survives. In each of those cases
nothing was lost, and a notice would be noise that costs the signal its meaning.

**Known limit this does not remove.** The notice fires at *install* time. A user who never
re-installs never sees it — Phase 2's health-check and Phase 3's sync are what reach them. The
Known-limits bullet above is therefore softened, not deleted: there is now a warning, but it is not
a full deprecation *release*, and no separate release ships before the flip.

## Amendment (2026-08-09): whitespace-only `model_overrides` was a live defect (#3241)

Surfaced while writing Phase 1's failing-first suite, and fixed there rather than filed.

`model_overrides[<agent>] = "   "` is **truthy**, survives the `typeof === 'string'` guard, is not
Anthropic-flavored, and was therefore embedded verbatim as `model = "   "`. That is the same class
the #2310 guard exists to stop — a value that is not a real Codex model id reaching the `.toml` and
400-ing the agent — reached by a different route.

Phase 1 trims before the truthiness test, so a whitespace-only override yields no pin. It is
deliberately **not** routed to `_warnCodexModelOverrideDropped`: that message says the value *"is not
a valid Codex model (Anthropic alias/id)"*, which misdescribes an empty config field. A blank value
is silently no-pin, matching how `""` already behaved.

This ADR's D2 ("embed a `model` only for an explicit real-Codex pin") always implied this. The
implementation simply did not enforce it, and no test covered the case.

## Amendment (2026-09-04): capability-gated invocation-time routing (#4270)

Codex now exposes `model` and `reasoning_effort` on some `spawn_agent` schemas. This is the
invocation-time capability signal that did not exist when this ADR adopted a session-only posture.
GSD therefore passes a workflow's resolved values on an individual spawn when — and only when —
the visible schema advertises each field. The fields are detected independently from each other
and from `agent_type`; absent fields, empty values, and `"inherit"` continue to degrade to session
or static agent configuration.

This amendment does not reverse D1–D4 for the static/install-time channel. Profile-resolved values
remain absent from generated TOML, explicit `model_overrides` pins remain the only static model
transport, and effort remains coupled to a static pin there. It supersedes only the broader claim
that Codex has no tier routing: capable schemas now route at invocation time, while older schemas
retain the passive fallback.
