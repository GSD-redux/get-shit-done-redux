# ADR 550: spec-phase probe pattern and prohibition contract [Accepted]

- **Status:** Accepted
- **Date:** 2026-06-03

> **Provenance.** Drafted during triage of #644 (prohibition probe), hardened in a `/grill-with-docs` session, and extended with a `probe-core` seam designed in an `/improve-codebase-architecture` grill (Decision 7). Endorsed by the maintainer and by the #644 author (who also authored the edge-probe, #550 / PR #584). This ADR lands **on PR #584** alongside the `probe-core` extraction that implements Decision 7; #644 (the prohibition probe itself) remains blocked until #584 merges and then implements the prohibition adapter. "What exists today" is verified against `next` + the PR-#584 head as of 2026-06-03.
>
> **Lineage.** The judgment-tier contract (Decision 4) was reached independently from two directions: from the domain model (truths are unenforced positive-observables, so a values prohibition cannot be a silent pass) and from the author's "verifier-abstention" (N17) calibration experiment (on irreducible values rules the verifier is confidently wrong — ~0.93 confidence, ECE 0.81 — so confidence-gating cannot help; the only honest move is abstain-and-flag). That parked experiment folds into this ADR as the verify-time half of judgment-tier rather than needing a separate feature.

## Context

`spec-phase` produces `SPEC.md` from an interview. Two features add *probes* — soft-gate steps that surface spec gaps before code is written: **#550 / PR #584 (edge-probe)** for data-shape edges, and **#644 (prohibition probe)** for values/safety "must-NOT" constraints. Both use identical three-layer packaging and a recall→precision protocol, and both want confirmed findings to reach `SPEC.md` and the plan contract.

Grounding the design against the codebase surfaced the decisive facts:

- **`truths` are positive, observable assertions.** `gsd-planner` derives them as *"observable truths (3-7, user perspective)"*; `verify-phase` checks each by *"determine if the codebase enables it"* — a presence/wiring check. A prohibition is the inverse and cannot be confirmed that way.
- **`truths` are not mechanically verified.** `verify.cjs` iterates `artifacts` and `key_links` but has no `truths` handler. A prohibition parked in `truths` would inherit that non-enforcement — a negative wearing a positive's clothing.
- **`must_haves` has no schema/type** — a convention parsed by `parseMustHavesBlock` (blocks `truths`/`artifacts`/`key_links`), read in ≥6 places.
- **The SPEC→plan lift is LLM reasoning** in `gsd-planner`'s `derive_must_haves`, not mechanical extraction.
- **Prohibitions already exist in GSD only as narrative prose** (`<scope_reduction_prohibition>`, `"MUST NOT loop"`), never as structured, verifiable data.
- **The edge-probe's load-bearing logic is a deep module on the live path.** `src/edge-probe.cts` (~297 lines) is compiled to `bin/lib/edge-probe.cjs` and invoked by `spec-phase` Step 5.5 at runtime. ~120 of its lines are a *generic resolution model* (status lifecycle, validation, merge/rollup, CLI); only the `Shape`/`SHAPE_CUES`/`TAXONOMY`/`classifyShape`/`proposeEdges` cluster is edge-specific. The prohibition probe is the **second adapter** of that model — making the seam real (one adapter is hypothetical; two is real).
- **No prior ADR** governs probes, soft gates, or `must_haves` evolution.

The values/safety class #644 targets (*"must not become a guilt mechanic"*) is frequently **not reducible to a deterministic test** — which is why it needs an explicit verification contract rather than truth-style limbo.

## Decision

1. **Probe packaging (three layers).** Every spec-phase probe ships as: (a) a portable, dependency-free reference core under `references/<probe>.md` (taxonomy + protocol + output schema); (b) a `spec-phase.md` step run as a **soft gate** (write-anyway-with-flags), with explicit `--auto` and text-mode (non-Claude, no `AskUserQuestion`) handling, mirroring the ambiguity gate; (c) tests + docs.

2. **Two-stage protocol.** **Recall** (adversarial over-generation) → **precision** (classifier dropping routine engineering items), surfacing a short confirmable list. Dismissals require a non-empty reason.

3. **Prohibition home & representation.** Confirmed prohibitions live primarily as **`SPEC.md` acceptance criteria** (negative criteria). They MAY be projected into an optional **`must_haves.prohibitions:` sibling block** (alongside `truths`/`artifacts`/`key_links`) when they must survive into the plan contract. **`truths` is left untouched** — no `polarity` field is added. Each prohibition item carries `statement`, the orthogonal `status` + `verification` of Decision 7, and (when dismissed) a non-empty `reason`.

4. **Tiered verification.** Each prohibition declares `verification: test | judgment`.
   - **`test`-tier** (reducible to a deterministic assertion) → a **negative test** following `regression-must-fail-first` + negative-proof discipline. **Hard gate in both interactive and autonomous modes.**
   - **`judgment`-tier** (irreducible values/safety rule) → **mode-dependent soft-gate-with-flags**: *interactive* verify requires explicit human resolution of each item; *autonomous* verify records an LLM-judge verdict **marked non-authoritative** and emits a prominent *"unverified prohibition — human review recommended"* flag in SUMMARY/verdict. **Never a silent pass; never a hard halt of AFK runs.** Autonomous completion reads *"complete with N flagged prohibitions."*
   - *Optional future input:* cross-tier (or cross-model) disagreement MAY feed the judgment-tier flag as a cheap blind-spot signal. This is a breadcrumb, **not a dependency** — the flag stands without it.

5. **The CI-testable surface is the contract, not the classifier.** The recall/precision/tier-assignment stages are LLM behavior and are **not** claimed as deterministic CI coverage (validated by offline batteries; in CI only by source-grep-under-`// allow-test-rule:`-exemption over reference/workflow prose, which *is* the product). CI deterministically tests the **contract**: (a) parse + validate an item (`statement` present; `status ∈ {resolved, dismissed, unresolved}`; `verification` in the probe's allowed set; dismissed items carry a non-empty `reason`); (b) round-trip / projection between `SPEC.md` and `must_haves.prohibitions:`; (c) a `DEFECT.GENERATIVE-FIX` **parity assertion** across template ↔ parser ↔ planner; (d) `test`-tier items are provably wired into verify-phase and cannot be silently skipped. A test that asserts the LLM's *judgment* is vacuous and is rejected per `RULESET.TESTS.delete-bad-tests`. *(Scope: on #584 only **(a)** ships — it is the edge adapter's parse+validate contract test (`tests/probe-core.test.cjs`). **(b)–(d)** require the `must_haves.prohibitions:` block, projection, and verify-phase tiering and are **#644 scope**, as the Consequences section records.)*

6. **Ownership seam with security tooling.** The probe owns **bespoke product/values** prohibitions only. When precision classifies an item as **canon security/compliance** (OWASP/GDPR/fairness/prototype-pollution/path-traversal), it does **not** mint a SPEC prohibition; it emits a one-line breadcrumb (*"possible canon-security concern X — owned by `/gsd:secure-phase` / eslint"*) and stops. Canon checks are **referred, not duplicated** — keeping the surfaced list short (#644's ~2–3-item goal).

7. **`probe-core` is the seam; probes are adapters.** The shared resolution model is extracted into `src/probe-core.cts`; `edge-probe.cts` refactors onto it as the first adapter and the prohibition probe is born on it as the second. Sub-decisions, each chosen against both probes:
   - **7a — Orthogonal model.** The item carries two orthogonal dimensions: `status: resolved | dismissed | unresolved` (resolution lifecycle, shared) and `verification: <probe-defined> | null` (edge: `explicit | backstop`; prohibition: `test | judgment`). This replaces edge-probe's shipped `status: covered | dismissed | backstop | unresolved`, which smuggled a verification fact (`backstop`) into a lifecycle enum. Migration is mechanical (`covered → {resolved, explicit}`, `backstop → {resolved, backstop}`, others straight across); `coverage.resolved` is preserved **count-for-count** — it remains the *closed* set (`resolved` + `dismissed` status = `applicable − unresolved`), so every fixture's count is unchanged, while `coverage.byVerification` carries the per-tier `resolved`-status breakdown; the 6 edge fixtures are re-generated on #584. Done now (one adapter) rather than against a fixture-locked enum later.
   - **7b — Core ingests already-proposed items.** The seam is `analyzeCoverage(items, resolutions?, validators)`, **not** `(requirements, proposeFn, …)`. The probes have different deterministic surfaces — edge = deterministic propose (`proposeEdges`) + LLM resolve; prohibition = **LLM propose** (adversarial recall) + deterministic validate/merge/rollup — so core MUST NOT assume propose is deterministic. `proposeEdges` stays in the edge adapter; candidate-parsing stays in the prohibition adapter.
   - **7c — Hybrid typing.** Generic type params on the exported interfaces for adapter-authoring DX, but the load-bearing enforcement is **injected runtime validators** (`{ categories, verification, requiredFieldsByVerification }`), because the probe runs as a CLI over JSON where TS types are erased. The contract test (Decision 5) pins the validators, not the types.
   - **7d — Rollup carries a verification tally.** `CoverageReport.coverage` gains `byVerification: { <tier>: count }`, computed generically in core over items that have a verification set. Verify-phase reads `byVerification.judgment` as Decision 4's denominator without re-scanning. (Unresolved items carry no tier and are counted by `status`.)
   - **7e — One bin per probe.** Each probe ships its own compiled bin (`edge-probe.cjs`, `prohibition-probe.cjs`) calling a shared `runProbeCli(...)`. A single dispatcher CLI is **deferred** as an independent follow-on: unlike the enum, it is pure invocation plumbing with no migration debt, so it does not justify enlarging the #584 blast radius.

   Indicative `probe-core` surface:
   ```ts
   export type Status = 'resolved' | 'dismissed' | 'unresolved';
   export interface Item<TCat extends string = string, TVer extends string = string> {
     requirement_id: string; category: TCat; status: Status;
     verification: TVer | null; resolution: string | null; reason: string | null;
   }
   export interface CoverageReport {
     items: Item[];
     coverage: { applicable: number; resolved: number; unresolved: number; byVerification: Record<string, number> };
   }
   export interface ProbeValidators {
     categories: ReadonlySet<string>; verification: ReadonlySet<string>;
     requiredFieldsByVerification?: Record<string, ReadonlyArray<keyof Item>>;
   }
   export function analyzeCoverage(items: Item[], resolutions: Resolution[] | undefined, v: ProbeValidators): CoverageReport;
   export function validateResolution(r: Resolution, items: Item[], v: ProbeValidators): void;
   export function validateItems(items: Item[], v: ProbeValidators): void;
   export function runProbeCli(opts: { ingest: (argv: string[]) => { items: Item[]; resolutions?: Resolution[] }; validators: ProbeValidators }): never;
   ```

## Consequences

- **Positive:** `truths` keeps its positive-observable semantics; prohibitions get a first-class home with a real verification lifecycle; CI is honest (tests the contract, never fakes the model's judgment as green); no fake-green and no gutted autonomy; the secure-phase boundary is explicit and de-duplicated; the resolution model lives in one place, so the third probe is nearly free and `verification`/`status` cannot drift across the ≥6 `must_haves` read sites.
- **Costs / required work (on #584):** extract `probe-core.cts` and refactor `edge-probe.cts` onto it; re-cut the status enum into `status × verification` and re-generate the 6 edge fixtures. **On the #644 PR:** add the prohibition reference + the `must_haves.prohibitions:` block and its `parseMustHavesBlock` extension; the `DEFECT.GENERATIVE-FIX` parity assertion across template ↔ parser ↔ planner (**owned by the #644 author**); extend the SUMMARY/verdict schema with the `unverified-prohibition` flag; teach verify-phase the test-tier wiring and judgment-tier mode-dependent handling. A deterministic `projectProhibitions()` in `probe-core` is recommended so the parity assertion tests a function's round-trip rather than a prompt; every existing `must_haves` read site must tolerate the new block (absence = no prohibitions).
- **Docs debt:** `spec-phase` is undocumented in `FEATURES.md`/`COMMANDS.md` despite shipping in v1.38; the docs-required gate bites both probes. PR #584 establishes the spec-phase docs section.
- **Glossary:** `probe family`, `probe-core`, `verification tier`, and `bespoke vs canon prohibition` are added to `CONTEXT.md` when #584 merges (not while the contract is pre-merge); this ADR is their interim home.
- **Sequencing:** PR #584 lands ADR 550 + `probe-core` + the `edge-probe.cts` refactor + enum re-cut + fixture re-gen + the spec-phase docs section. #644 then adds the prohibition adapter (reference + `prohibitions:` block/parser/parity + tiered verification). #644 stays blocked until #584 merges.

## Cross-reference: ADR-857 capability boundary (2026-06-12)

The capability system (ADR-857) classifies **predicate-generation as core verification substrate, not an off-by-default Feature Capability** — settled before ADR-857's phase-6 (Migrate) freezes the core/plug-in line. This pins where the probe family sits relative to the loop:

- The **verifier↔predicate contract** — the verifier always expects must-NOT-have / edge predicates and grades **exogenously** against them — is **core and non-toggleable**. *Verifier reach = spec reach:* the predicates **are** the reach of the spec the verifier verifies, so the contract cannot live in an off-by-default plug-in without making core reliability a function of an optional capability (ADR-857 decision #6 blast-radius rule). ADR-857's `produces`/`consumes` artifact flow (its decision #6) is the **internal rail** carrying predicates into the core verifier; in this ADR's terms that rail is the `SPEC.md` ↔ `must_haves` representation/projection (Decision 3, round-tripped per Decision 5).
- **"Exogenous grading"** is the verify-time half of this ADR's **judgment-tier** (Decision 4): the autonomous verifier records an LLM-judge verdict **marked non-authoritative** and flags *"unverified prohibition — human review recommended"* — grading against the spec's explicit predicates, never a self-graded restatement (the prose-drift / self-graded-review failure modes reproduced on #664). The judgment-tier soft-gate **is** the contract's "never a silent pass" guarantee at the core boundary.
- **The probe *adapters* are the core-default *generator*** — `edge-probe`'s `classifyShape`/`proposeEdges` and the prohibition probe's adversarial LLM-propose, the surfaces that *propose* predicates — default-on and non-removable, but **independently versionable**. The classifier's measured recall gap (the prose→shape under-fire on terse prose) is the reason they stay their own modules under this ADR rather than being folded into the slow core rail. **`probe-core` is not the generator:** per Decision 7b it ingests already-proposed items, and its deterministic validators are the **contract**'s CI-testable surface (Decision 5) — so `probe-core` sits on the contract side, the adapters on the generator side. ADR-857 phase 6 wires these modules onto the core predicate rail; it does **not** relabel them as a `capabilities/edge-probe/` plug-in.
- Decision 5's rule — *the CI-testable surface is the contract, not the classifier* — extends to ADR-857's core rail: the deterministic conformance test is the contract shape the verifier consumes, never the LLM's judgment.

## Addendum (2026-06-12; updated 2026-06-15): test-tier disposition — fail-closed safety half (#644) + enforcement half LANDED (#1259)

Decision 4 describes the `test`-tier as a "**Hard gate in both interactive and autonomous modes.**" The #644 implementation revises that to a **fail-closed-now / deferred-enforcement** resolution (the "B-with-guard" maintainer decision of 2026-06-12), so the architecture-of-record matches the shipped code:

- A well-formed but **unwired** `test`-tier prohibition resolves via `dispositionForProhibition()` to `{ status: 'unverified', flagged: true }` — **provably never green** without explicit evidence (REQ-PROHIB-06). This is the load-bearing safety half and it holds today.
- The **negative-test enforcement mechanism** — locating the wired mechanical check, running it for a genuine **non-vacuous** pass, and building the `enforcementEvidence` that flips a passing test-tier item green — **landed in #1259** as the deterministic `check prohibition-enforcement` sub-command (authored as `src/prohibition-enforcement.cts`, compiled by `build:lib` to the gitignored `gsd-core/bin/lib/prohibition-enforcement.cjs`). It accepts BOTH wired-check kinds — a `node --test` negative test (requiring a real reported test, not the empty file `node --test` would count as one passing "test") OR a lint/AST rule run through the project flat config as `eslint --format json` filtered by `ruleId` (so plugin rules like `local/*` load — bare `--rule` cannot) — and is anchored on the in-tree `local/no-source-grep` rule (dogfooding the existing must-NOT proof, ADR-550 D4; the #644 corpus had zero authored test-tier prohibitions, so no contrived consumer was minted). A passing wired check disposes green; a missing, non-attested, or genuinely-non-passing check hard-gates (flagged, non-green) in both interactive and autonomous modes.
- **Honest scope — `failFirst` is caller-ATTESTED, not machine-proven (tracked follow-up).** What #1259 lands is the *execution + non-vacuous-pass* half: the producer requires the caller to attest `failFirst: true` and requires the check to genuinely run and pass. It does **not** yet independently prove the check *fails-on-violation* (the literal `regression-must-fail-first` property), because cheap proof of that at verify time needs running the check against a known **violation fixture** — deferred as a follow-up (#1279; the descriptor auto-locate half is #1278). Until then the red-first property rests on caller attestation, surfaced transparently in the evidence record. This closes the permanent-`gaps_found` dead-end with a genuinely-executed gate without overclaiming machine-proven fail-first.

Net effect on D4: the *guarantee* ("a `test`-tier prohibition is never a silent pass") was preserved through the fail-closed-now half and is now joined by the genuine-execution half — a test-tier prohibition with a passing, non-vacuous wired check can reach `green`/`passed`, and a missing/failing one hard-gates. The previously-unreachable green branch in `dispositionForProhibition()` is reachable from the live pipeline, and the fail-closed default backs every miss/fail. The one remaining gap to D4's literal intent — *machine-proven* fail-first — is documented above as a tracked follow-up. The decision also lives in `src/probe-core.cts` comments, `src/prohibition-enforcement.cts`, `verify-phase` (workflow, retired in #1892), and the #644 / #1259 changesets.

This enforcement seam is the concrete instance of **ADR-857 open-question §147** — the deferred "deterministic CI conformance test for the verifier↔predicate contract." Per D6 it lands on the **core verify rail** (non-toggleable substrate), never in `capabilities/`: the verifier consuming a contract-shaped, deterministic predicate is core, not an opt-in capability.

## Addendum (2026-06-15, #1279) — machine-proven fail-first REALIZED (D5d follow-up CLOSED)

The 2026-06-12 addendum above closed with one honest gap to D4's literal intent: `failFirst` was **caller-ATTESTED**, not machine-proven (the note at *"Honest scope"* and the *Net effect on D4* paragraph deferred the literal `regression-must-fail-first` property to #1279). **#1279 closes that follow-up.** The literal `regression-must-fail-first` property is now **machine-proven at verify time**: before a clean pass can dispose a `test`-tier prohibition green, the producer independently RUNS the wired check against a KNOWN VIOLATION and confirms it goes RED. Any other outcome (passes-on-violation, can't-prove, throws, times out, no violation source) **hard-gates in both modes** — attestation is gone from the green AND (`passed = proof.provenFailFirst === true && run.passed === true`). The previously-deferred half of D4's intent is therefore REALIZED; the D5d follow-up is **CLOSED**. The mechanism landed in `src/prohibition-enforcement.cts` (the `defaultProveFailFirst` real prover; the node-test red proof requires a NON-VACUOUS red via `isNonVacuousNodeTestRed` — a failing test named distinctly from the file, so a load crash on the bad subject is not mistaken for the negative assertion firing red) and is compiled by `build:lib` to the gitignored `gsd-core/bin/lib/prohibition-enforcement.cjs`.

This addendum ratifies three contract points:

- **(a) `CheckDescriptor.violationFixture?` — the violation-sourcing shape.** An author-supplied path to a KNOWN-BAD subject the prover runs the check against. For `lint-rule`: a file whose content violates `rule` (the prover lints it and requires the rule id to appear in the JSON report — the rule must have teeth). For `node-test`: a subject the negative test exercises, expected to drive it RED. A generic producer cannot synthesize a violation for an arbitrary check, so the fixture is required to prove fail-first; **absent → the prover fails closed (never attestation).** This is the uniform field for BOTH kinds (the inline producer-written snippet was rejected as it bakes rule-specific source into a generic producer).

- **(b) `GSD_PROHIB_SUBJECT` — the node-test subject-injection convention.** For the `node-test` kind the producer spawns the negative test with `GSD_PROHIB_SUBJECT=<violationFixture>` in the child env; the test reads that env var to locate the subject-under-test and is expected to go RED against the violating subject. The synthetic temp fixtures in `tests/prohibition-enforcement.test.cjs` demonstrate a test that honors the convention (defaulting to a clean in-dir subject when the env var is absent, so the plain run passes non-vacuously while the prover's run goes red).

- **(c) The `failFirst` DEMOTION (FF-08).** `CheckDescriptor.failFirst` is **kept** (so the #1259 route-JSON shape and the `CheckDescriptor` type stay backward-compatible for any caller mid-migration) but **DEMOTED to a non-authoritative hint** — the machine prover supersedes it and **no path greens on attestation alone**. Removal was rejected as it breaks the route-JSON shape mid-migration; demote-and-ignore is safer and still satisfies "no path greens on attestation."

> **PR-review flag — PROPOSED, renamable conventions (zero live consumers).** Both **`GSD_PROHIB_SUBJECT`** and **`CheckDescriptor.violationFixture`** are net-new surface introduced by this PR with **ZERO live in-tree consumers** — there is no in-tree `node --test` prohibition yet (the #1259 dogfood anchor and the #1279 lint-rule dogfood are both the LINT-rule `local/no-source-grep`; node-test fail-first is exercised only by SYNTHETIC temp fixtures in tests). They are therefore forward-looking scaffolding, and a later rename (or replacing the env var with an argv) is a **mechanical, zero-migration find/replace**. They are surfaced here explicitly so the maintainer can **rename or replace them at PR review** — the natural ratification point, exactly as #1278's ADR addendum was reviewed at PR time — without any migration cost. The `failFirst` DEMOTION is likewise open to the reviewer weighing outright removal; the rationale for keeping it as a hint is recorded above.

Net effect on D4: the *guarantee* ("a `test`-tier prohibition is never a silent pass") was preserved at every step — fail-closed-now (#644), genuine-execution (#1259), and now **machine-proven fail-first (#1279)**. A `test`-tier prohibition reaches `green`/`passed` ONLY when the wired check both genuinely, non-vacuously passes AND is independently proven to fail on a violation; every miss/fail/un-provable hard-gates. The decision also lives in `src/prohibition-enforcement.cts` comments, `gsd-core/references/prohibition-probe.md`, `gsd-core/workflows/verify-phase (retired in #1892)`, and the #1279 changeset.

**Review corrections (#1314 maintainer review) — two soundness items:**
- **node-test fixture-existence guard (was fail-OPEN) — FIXED.** The node-test prover originally guarded only `if (!fixture)`. A missing/typo'd/stale `violationFixture` path made `GSD_PROHIB_SUBJECT` point at a non-existent file; an honest negative test then threw ENOENT *inside its callback* — a failing test named distinctly from the file — which `isNonVacuousNodeTestRed` accepted as proof, **forging a green from a setup crash** (asymmetric with the lint-rule path, which fail-CLOSES on `< 1` file result). Fixed by requiring `fs.existsSync(path.resolve(cwd, fixture))` before spawning (symmetric fail-closed; resolved against the producer's `cwd` to match the child's resolution). **Residual (#1346) — now MITIGATED by an optional control; see the 2026-06-21 addendum below:** existence is necessary but not sufficient — a deceptive test that reds merely *because* `GSD_PROHIB_SUBJECT` is set (not because the subject's CONTENT violates) was still accepted; a generic always-on proof is impossible, so #1346 adds an **opt-in clean-subject control** that proves content-dependence when the author supplies one (and the residual remains, documented, only for checks with no control fixture).
- **`violationFixture` projection source (#1278 ↔ #1279 now COMPOSE) — DELIVERED.** Initially `descriptorFromProjection` reconstructed only `{ kind, target, rule? }` and the projection carried no fixture, so a prohibition wired purely through the deterministic path always hard-gated. This PR threads a **fourth flat scalar `check_violation_fixture`** through `projectProhibitions` + `descriptorFromProjection` (rides both kinds; mirrors `CheckDescriptor.violationFixture`). A prohibition authored with all four scalars now **machine-proves fail-first and greens end-to-end through the projection alone** (zero hand-authoring) — the round-trip is pinned by a fast-check property + CHK-03(D) + an end-to-end COMPOSE capstone. Fail-closed is preserved: a descriptor with no `check_violation_fixture` (or a blank one) projects absent and hard-gates. The remaining work under #1346 is now just the node-test causation residual above.

## Addendum (2026-06-21, #1346) — node-test causation control: prove the RED is CONTENT-caused

The #1314 review left one tracked residual (above): the node-test prover confirms the violation fixture exists and that the negative test goes a non-vacuous RED, but could not prove the RED was caused by the subject's **content** rather than by `GSD_PROHIB_SUBJECT` merely being *set*. A deceptive content-independent test (`assert.ok(!process.env.GSD_PROHIB_SUBJECT)`) was still accepted. A general always-on proof is impossible for an arbitrary author-supplied test, so #1346 closes the gap with an **opt-in control** rather than a forced one.

This addendum ratifies one contract point:

- **(d) `CheckDescriptor.cleanFixture?` / `check_clean_fixture` — the causation control (the 5th flat scalar).** An OPTIONAL author-supplied path to a KNOWN-CLEAN control subject. When present, the node-test prover runs the SAME negative test a second time with `GSD_PROHIB_SUBJECT=<cleanFixture>` and requires it to stay a **non-vacuous GREEN**. Fail-first is then proven ONLY when the check is **RED on the violation AND GREEN on the clean subject** — i.e. the red is content-dependent. A deceptive test that reds whenever the env var is set reds on the clean subject too → the control fails → not proven (fail-closed). The scalar rides both kinds through `projectProhibitions` + `descriptorFromProjection` exactly as `check_violation_fixture` does (round-trip pinned by the fast-check property + an end-to-end COMPOSE capstone exercising both the honest and deceptive subjects).

**Why opt-in, not required:** making the control mandatory would regress the #1314 zero-authoring compose path — every existing node-test prohibition (which carries no clean fixture) would suddenly hard-gate. So **absent `cleanFixture` → no control runs and behavior is byte-identical to post-#1314**; the residual remains a documented permanent constraint *only* for checks whose author did not supply a clean control. An author opts into the stronger machine guarantee by supplying one. The lint-rule kind needs no analog: its "subject" *is* the linted file (no `GSD_PROHIB_SUBJECT` indirection), so the "reds because the env var is set" gap does not exist there. Net effect on D4 is unchanged — every miss/fail/un-provable still hard-gates; this only *tightens* what counts as proven. The mechanism lives in `src/prohibition-enforcement.cts` (`defaultProveFailFirst` node-test branch + the `runNodeTestWithSubject` helper) and `src/probe-core.cts` (`projectProhibitions`), compiled by `build:lib`.

> **SUPERSEDED 2026-07-03 (#1906) — the node-test causation control is now MANDATORY, not opt-in.** The "why opt-in" rationale above rested on avoiding a regression of "every existing node-test prohibition." That premise no longer holds: there is **no in-tree `node-test` consumer** (ADR-1606 Consequences, "Open conventions"), so requiring the control hard-gates *zero* existing checks — while leaving the Goodhart hole open by default let a deceptive content-independent test pass the proof. Per the owner ruling on #1906, a `node-test` descriptor that omits `cleanFixture` is now **un-provable (fail-closed)**, never proven on the violation alone; when a clean fixture is present, fail-first is proven exactly as before (RED on violation AND non-vacuous GREEN on clean). The `lint-rule` kind is unchanged. Disclosed as breaking (Hyrum) with the ~zero blast radius noted. The decision-of-record lives in **ADR-1606's 2026-07-03 (#1906) addendum**; this note supersedes the "Why opt-in, not required" paragraph immediately above.

## Addendum (2026-06-15): optional `check` descriptor on the prohibition item — D3 shape extension (#1278)

This ratifies the **deterministic SOURCE** for the test-tier `CheckDescriptor` that #1259 (PR #1273) left caller/verifier-supplied. #1259 shipped the PRODUCER (`check prohibition-enforcement`) that *runs* a wired check given a `{kind, target, rule?}` descriptor, but the descriptor itself was invented by the verify-phase LLM each run (the "locate" half). #1278 makes that locate half **deterministic**: an optional `check` descriptor is authored at spec-phase on the resolved `test`-tier prohibition, projected by `projectProhibitions`, and read back by verify-phase — so a wired, passing test closes the gap with **zero manual authoring**. This extends the **Decision 3 prohibition-item shape** (it adds optional keys to that item), so it is ratified here rather than rewriting D3 in place.

1. **The D3 item shape gains OPTIONAL flat-scalar keys.** Alongside `statement`, `status`+`verification`, and the dismissed-only `reason`, a resolved `test`-tier prohibition MAY carry `check_kind` (`node-test` | `lint-rule`), `check_target`, and `check_rule` (lint-rule only). All three are **optional**; a descriptor-less prohibition parses and disposes byte-identically to today (backward compatibility, CHK-07).

2. **Flat scalars — NOT a nested `check:{}` object (load-bearing).** The representation is three flat scalar keys, never a nested object. The shared `parseMustHavesBlock` (`src/frontmatter.cts:252`) is a **flat parser**: continuation lines under a list item are handled only as nested ARRAYS or scalar `key: value` pairs, and the `reconstructFrontmatter` serializer is deliberately lossy for nested object-lists. A nested `check:{}` would flatten its keys into the parent item and mangle the round-trip. We follow the #644 precedent — **no parser rewrite, no `parseMustHavesBlock` change** — so the `truths`/`artifacts`/`key_links` shared-parser readers stay regression-free (the untouched frontmatter suite is the proof).

3. **Deterministic projection + read-back.** `projectProhibitions` (`src/probe-core.cts`) emits the scalar keys ONLY for a well-formed descriptor (valid `check_kind` + non-empty `check_target`; `check_rule` only on the lint-rule path). `descriptorFromProjection` (`src/prohibition-enforcement.cts`) reads them back into a `{ kind: check_kind, target: check_target, rule?: check_rule }` `CheckDescriptor` to build the producer request. The `CheckDescriptor` type itself is unchanged; `failFirst` is **NOT** sourced from the projection — it stays a verify-time caller attestation. verify-phase locates from the projection, so a wired passing test needs no hand-authored descriptor.

4. **Fail-closed on partial / invalid / absent descriptor.** A `lint-rule` descriptor missing `rule`, an unknown `kind`, or an absent descriptor on a test-tier prohibition MUST fall through to the producer's existing fail-closed locate ("no well-formed check descriptor is locatable → fail-closed") — never a silent green. The producer's locate semantics from #1259 are unchanged.

5. **Out of scope (unchanged boundaries).** Machine-proven fail-first (a violation-fixture / RuleTester-invalid proof replacing the `failFirst` caller attestation) stays tracked as **#1279**. The `dispositionForProhibition` green/fail-closed **policy** is untouched. No new check kinds are added.

Net effect on D3: the prohibition-item shape is extended with three optional, backward-compatible flat-scalar keys that give the test-tier locate a deterministic spec-phase source; the contract's CI-testable surface (D5) gains the projection round-trip parity (CHK-03), the fail-closed guard (CHK-06), and the byte-stable backward-compat fixture (CHK-07). The decision also lives in `src/probe-core.cts` / `src/prohibition-enforcement.cts` comments, the `verify-phase` (workflow, retired in #1892) / `spec-phase.md` prose, and the #1278 changeset.

## Addendum (2026-06-25, #1154) — honest verifier: the truth-axis disposition mirror of D4

This records the **truth-axis half of Decision 4** that the original ADR deliberately scoped out. D3 left `truths` untouched (no `polarity` field — that is a prohibition concern), and the Lineage note parked the N17 abstention experiment as the verify-time half of the **prohibition** judgment-tier only. D7a, however, already gives the **edge** axis an orthogonal `verification` tier (`explicit | backstop`), and `plan-phase` already lifts a `backstop` edge into `must_haves.truths`. Until now that tier was flattened to a prose parenthetical at the projection, so the verifier had nothing structured to branch on and graded a `backstop` truth `passed` like any inferable one — confidently false-passing a non-inferable check ~100% of the time (the exact "verifier reach = spec reach" failure ADR-857 names). This addendum closes that gap by giving the `backstop` **truth** tier the same abstain-and-flag disposition D4 gave the prohibition `judgment` tier — **opposite polarity (must-HAVE under-specified vs must-NOT irreducible), same never-silent-pass machinery.** It cross-references **ADR-857** (the verifier↔predicate contract this rides is core, non-toggleable substrate, graded exogenously — `:65`); this completes the already-endorsed edge branch of that rail and adds no parallel mechanism.

1. **The D3 truth-item shape gains an OPTIONAL flat-scalar `verification` marker.** A `must_haves.truths` item is normally a plain string (an inferable truth — today's shape, unchanged). A **non-inferable** truth MAY instead be an object item carrying `statement` + a flat scalar `verification: backstop`. The marker is additive and default-absent: a string truth, or an object with no marker, behaves byte-identically to today (Hyrum's Law backward-compat). This extends the **Decision 3 truth shape** the same way #1278 extended the prohibition shape — it does **not** add a `polarity` field (D3's "truths untouched" holds); `verification` is D7a's pre-existing orthogonal axis, now carried through to the truth projection.

2. **Flat scalars — NOT a nested object (load-bearing, #1278 precedent).** The marker is a flat `verification:` continuation key on the truth item, never a nested object — the shared flat `parseMustHavesBlock` round-trips it with **no parser change** (the round-trip parity test is the proof; the untouched frontmatter suite confirms `truths`/`artifacts`/`key_links`/`prohibitions` readers stay regression-free).

3. **Deterministic disposition + projection.** `projectTruths` (`src/probe-core.cts`) emits the flat-scalar marker ONLY for a `backstop` truth and collapses every inferable truth to a bare string (conservative serializer). `dispositionForUnverifiableTruth(truth, { evidence })` is the pure, fail-closed verdict: a `backstop` truth with no **explicit evidence** (a passing wired held-out/property-based test, or a directly-observed behavior) → `{ status: 'unverified', flagged: true, reason: 'insufficient_spec' }`, **never green**; with evidence → green; any non-`backstop` truth → green (the over-abstention guard). No LLM judgment is tested (D5) — the helper owns routing once evidence-existence is known; the LLM verifier's only job is to decide whether explicit evidence exists.

4. **`insufficient_spec` feeds the EXISTING `human_needed` outcome — no new verifier status (maintainer Decision 1).** Abstention reuses the locked 3-value `VERIFIER_STATUSES` (`['passed','gaps_found','human_needed']`, `src/verification.cts`) with **zero change** and no new downstream routing in `ship`/`execute-phase`. The abstain cause rides as a **distinguishable report reason** (`human_needed` + `reason: insufficient_spec`) so it is never conflated with an ordinary manual-UAT `human_needed` — asserted in a test (review condition-1 caveat). *Interactive:* the item routes to the end-of-phase human checkpoint. *Autonomous (AFK):* a prominent `unverified — held-out test recommended` flag; completion reads "complete with N unverified non-inferable checks" — never a silent pass, never a hard halt (the D4 guarantee, now on the truth axis).

5. **Two measured properties define the design (maintainer Decision 2; caveats to record).** *Exogenous, not endogenous:* abstention is triggered by the external `backstop` tag, never a self-judged "abstain if unsure" — endogenous abstention was measured near-useless on true blind spots (100% → 67% vs exogenous 100% → 17%; N17). *Routing, not diagnosis:* the verdict does not name the omitted rule (the held-out test carries it). **Evidence honesty:** N17 is n=27, 1 rep — **direction-finding, not powered**; the effect is large and monotone but real-world precision depends on the edge-probe's *true* `backstop` recall/precision (the experiment modeled a perfect tagger), which is why the over-abstention guard and the capable-tier requirement are load-bearing acceptance criteria. **Model-tier coupling:** abstention is reliable on the default `gsd-verifier` tier (`sonnet`+); the budget tier (`haiku`) heeds the tag only inconsistently and degrades toward current behavior — captured as a documented cost (and a test) so a tier regression is caught, not discovered in production.

Net effect: the truth-axis `backstop` tier gains the verify-time disposition D4 gave the prohibition judgment tier; the contract's CI-testable surface (D5) gains the truth-axis projection round-trip parity and the abstain-on-unconfirmed-backstop regression. The decision also lives in `src/probe-core.cts` comments, `gsd-core/references/honest-verifier.md`, the `plan-phase.md` / `verify-phase` (workflow, retired in #1892) / `agents/gsd-verifier.md` prose, and the #1154 changeset.

## Addendum (2026-06-22) — Alternatives considered (recall / representation / packaging side)

This consolidates the spec-phase-side rejected and deferred alternatives for the probe family,
so a re-proposal meets a recorded reason rather than a fresh debate. (The enforcement-mechanism
alternatives — the flat-vs-nested descriptor, the inline violation snippet, `failFirst`
attestation, and mandatory causation control — are recorded in **ADR-1606**, the
prohibition-enforcement verify-time seam.)

- **A standalone LLM requirement *classifier* as a feature — REJECTED (#652, closed
  2026-06-04).** The enhancement "requirement classification in the spec phase should use an
  LLM-assisted classifier" was closed without approval: the edge-probe's shape taxonomy plus
  the prohibition probe's adversarial recall **already capture most of the value** a general
  classifier would, without adding a separate model-dependent surface to maintain. *Re-open
  only if* a classifier demonstrably beats both probes on a held-out battery.

- **A deterministic `prohibition-probe.cjs` recall engine — REJECTED.** Unlike the closed edge
  taxonomy, the prohibition recall stage is inherently LLM prose reasoning; only the
  schema/projection layer is real code (Decision 7b). A deterministic recall adapter is the
  scope-creep flagged in `gsd-core/references/prohibition-probe.md`; recall is validated
  offline (N18), not asserted in CI. *Re-open only if* recall can be made deterministic without
  collapsing the adversarial open-question that gives it model-robust reach.

- **A `polarity` field on `truths` — REJECTED (already decided — see Decision 3).** `truths`
  are positive observables with no `verify.cjs` handler; a prohibition parked there inherits
  non-enforcement. Recorded in Decision 3 ("`truths` is left untouched — no `polarity` field is
  added"); listed here only so the alternatives set is readable in one place.

- **A single dispatcher CLI for all probes — DEFERRED (already decided — see Decision 7e).**
  Each probe ships its own bin calling a shared `runProbeCli(...)`; a unified dispatcher is
  deferred as pure invocation plumbing with no migration debt. Recorded in Decision 7e; listed
  here only for completeness.

*Net:* the two NEW entries (#652 classifier, deterministic recall engine) are the only ones
this addendum adds to 550's decision record; the other two are cross-references to existing
decisions, collected so the probe family's full "alternatives considered" set is readable in
one place.

## Amendment (2026-09-01, #3717): `text_en` field — durable fix for the #2773 language stopgap

**What changed.** `Requirement` (the Edge Probe Module's locked input shape) gains an optional
`text_en: string` field. `classifyShape`'s own signature is unchanged (still `(text: string) =>
Shape[]`, a directly-tested export); the `text_en ?? text` selection happens once, at
`proposeEdges`' single call site. `validateRequirement` fail-closes on a present-but-empty or
whitespace-only `text_en` (an unvalidated `''` would otherwise win `??` silently, since nullish
coalescing does not treat `''` as nullish).

**Why this is a locked-surface change, not a silent one.** `text` previously carried a dual,
undocumented meaning under the #2773 stopgap: the requirement's own text for English projects,
but silently the *translation* for `response_language` projects (spec-phase Step 5.5 wrote the
English rendering into `text`, never the SPEC's own words). `text_en` removes that overload —
`text` always means the requirement's own text, in whatever language the SPEC uses; `text_en`,
when present, is the engine-only English rendering the classifier prefers.

**Not a re-open of the #652 rejection (see the Addendum above, `docs/adr/550-spec-phase-probe-contract.md:172-177`).** That addendum rejects a *standalone, model-dependent* LLM
classifier surface. `text_en` is a plain optional string field read by the existing
deterministic regex classifier — no new model-dependent surface, no change to the taxonomy or
`SHAPE_CUES`'s cue-matching mechanism. The maintainer's approval on #3717 confirmed this reading
explicitly and scoped the change to Form 1 only (the `text_en` field); per-language `SHAPE_CUES`
tables (a form that WAS considered — a `lang` hint + a cue-table-per-language) were evaluated and
declined as an unwarranted maintenance burden for a solo-maintainer project. `en` remains the
only `SHAPE_CUES` vocabulary.

**Acceptance bar carried into `tests/edge-probe.test.cjs` / `tests/edge-probe-spec-phase-contract.test.cjs`:** a `SHAPE_CUES`/`VALID_SHAPES` parity assertion (`RULESET.GENERATIVE-FIX`), a fixture
pair proving a non-English requirement with `text_en` classifies identically to its English
equivalent, boundary coverage for `text_en`'s absence/presence/empty-string cases, and a
workflow-prose contract test asserting `spec-phase.md` Step 5.5 actually documents populating
`text_en` for `response_language` projects — the machine check the #2773 doc-only stopgap
explicitly lacked.

**Explicitly out of scope (unchanged from #2773).** The ADR-857 §98 / Decision 7b recall gap — a
requirement carrying no shape cue in *any* language, including English, still classifies to
zero shapes — is untouched. The authored `shapes` override remains the remedy there.
