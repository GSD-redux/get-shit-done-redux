# ADR-2619: Observability and shareable diagnostics — wire the dispatch seam, add the outbound trust boundary

- **Status:** Accepted
- **Date:** 2026-07-29
- **Issue:** [#2619](https://github.com/open-gsd/gsd-core/issues/2619) (`enhancement` + `approved-enhancement`)
- **Completes:** [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) §6 — the observability seam, decided 2026-05-23 and shipped un-wired; wired on the live dispatch path 2026-07-28 by [#2620](https://github.com/open-gsd/gsd-core/issues/2620) / PR [#2621](https://github.com/open-gsd/gsd-core/pull/2621) (see D1)
- **Supersedes:** nothing. This ADR **narrows one bullet** of [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) §6 — the *unconditional* stderr-on-error rule (`0174:105`) — and **discloses** that narrowing rather than retconning it (D1b). ADR-0174 keeps its `Accepted` status and stays load-bearing, and no lifecycle back-link is claimed: a disclosed partial supersede of a single rule is not an ADR-level supersession. Per `CONTRIBUTING.md:174` and `docs/contributor-standards.md:146`, a change that intentionally revisits an ADR decision must call it out explicitly — this field is that call-out.
- **Mirrors:** [ADR-1577](1577-untrusted-input-boundary-and-injection-blocking.md) — the *inbound* untrusted-input boundary. This ADR adds the *outbound* one.
- **Constrained by:** [ADR-857](857-capability-system.md) (observability is core substrate, never a Feature Capability), [ADR-0001](0001-dispatch-policy-module.md) / [ADR-0012](0012-command-routing-hub.md) (the dispatch seam the events ride)

GSD's observability contract is described as live by an ADR, by `CONTEXT.md`, and by `docs/CONFIGURATION.md`, and was implemented by none of them until 2026-07-28. This ADR completes that rollout as increments and adds the **outbound** trust boundary that ADR-1577's inbound one has no counterpart for: one event artifact serving three consumers — **agents** (self-recovery), **team** (shareable diagnostics), **local audit** (forensics) — with egress user-initiated, field names aligned to an existing standard rather than a bespoke ontology, and no telemetry of any kind.

> **Section-numbering note.** Both rules this ADR touches live in ADR-0174 **§6** (*"Observability seam"*, `0174:102-108`); the injected-logger claim is restated at `0174:66` in §4. Issue #2619 and its approval comment refer to the stderr-on-error bullet as *"§5"* — but §5 is ADR-0174's sync-dispatch `Result<T>` decision (`0174:68-101`) and is untouched here. The line citations govern.

## Context

Three facts, verified against `next` @ `b12d4df0`.

**1. The seam was ADR-decided, shipped un-wired for two months, and is now wired for the opt-in case only.** ADR-0174 §6 states *"DispatchLogger **is injected**; the Hub emits `DispatchEvent` records on **every dispatch path**"* (`0174:66`) and *"the default implementation writes per the rules above"* (`0174:108`). Until PR #2621 merged, the Hub defaulted to `createNoOpLogger` and injected `createDefaultLogger` nowhere: both live `createHub()` callers passed no logger. #2620 wired both sites behind the existing opt-in signal — `src/cjs-command-router-adapter.cts:151`, `src/phase-command-router.cts:258` — and the Hub keeps its no-op fallback for callers that inject nothing (`src/command-routing-hub.cts:273-275`). Three conformance defects survive that fix:

- **`GSD_AUDIT_ARGS=1` is still inert.** `_notifyLogger` calls `makeDispatchEvent` without `includeArgs` (`src/command-routing-hub.cts:299`), which defaults `false` (`src/observability/event.cts:64`) and drops `args` before `redactEvent` (`src/observability/redaction.cts:42-52`) is ever reached. `docs/CONFIGURATION.md:1730` nonetheless states it *"applies to both the stderr error line and the audit file"*.
- **`config.audit.enabled` is unreachable.** `src/config-schema.cts` declares zero `audit` keys, and both injection sites call `isAuditEnabled()` and `createDefaultLogger({ cwd })` with no `config` argument — so only the `GSD_AUDIT` env var can turn observability on (`src/observability/logger.cts:52-56`). `docs/CONFIGURATION.md:1667` documents the pair as working.
- **stderr-on-error is opt-in, not unconditional** — the narrowing this ADR discloses. See D1b.

**2. Silent failure is worst for the agents.** GSD is agent-operated. A refusing dispatch — e.g. `state complete-phase` blocked on incomplete verification — is *swallowed*: an agent cannot recover from an error it cannot see. The stderr-on-error signal ADR-0174 already decided is precisely the machine-readable self-correction input agents need. **This is the highest-value outcome in this ADR and D1 does not deliver it.**

**3. No outbound trust boundary, therefore a diagnostic data desert.** ADR-1577 built the *inbound* boundary (untrusted fetched text) and notably **refused to claim a redaction it could not verify** (`1577:30`). Nothing governs what is safe to **emit or share**. `redactEvent` is args-only and binary (`src/observability/redaction.cts:42-52`); the actual PII vector is the unredacted `result` payload — `HandlerFailure.message` carries raw `err.message`, which embeds absolute home paths, and `ok.data` carries project, phase, and artifact names. So when a user hits a failure the team works from prose, not data, and a user who *wants* to hand over a diagnostic has no safe way to produce one.

Two further verified facts shape the design. The host runtime **already persists a full transcript** (Claude Code writes per-project session JSONL; Codex and Gemini use their own locations) and GSD **already ingests it** — `src/profile-pipeline.cts` and the `gsd-cursor-*` hooks are how `gsd-user-profiler` works — so capture largely exists already, at maximal PII and in per-runtime formats. And forensics/audit **reconstruct** from git, `STATE.md`, and phase directories, never from a log; there is no first-class workflow-step or agent-spawn event stream in-tree.

## Decision

Adopt an observability system built as increments, never as one engine. **Determinize the plumbing; keep egress user-initiated; align to the emerging standard instead of inventing an ontology.**

**D1 — Wire the seam behind the existing opt-in gate. *(Binding; shipped 2026-07-28.)*** Inject `createDefaultLogger` at both live `createHub()` sites, gated on the existing opt-in signal. When observability is off, inject nothing: the Hub keeps its no-op fallback and default output stays **byte-for-byte identical**. This makes `GSD_AUDIT` real for the first time and restores the opt-in `.planning/.gsd-trace.jsonl` file audit (`0174:106`). The three residual defects in Context #1 — `includeArgs` plumbing, first-class `audit`/`observability` config keys, and the `docs/CONFIGURATION.md` overstatement — are follow-ups, not part of this increment. Nothing is emitted off-box at any point.

**D1b — Unconditional stderr-on-error is the target state, gated on an envelope version. *(Binding as direction; its own increment.)*** ADR-0174 decided that *every* `Result` with `ok: false` emits a structured JSON line to stderr, **ungated** (`0174:105`). D1 does not deliver that, and this ADR says so rather than retconning the decision: `--json-errors` output is parsed by callers as exactly one JSON line, so a second line is a **real breaking change**. Measured, not estimated: injecting `createDefaultLogger` unconditionally at `src/cjs-command-router-adapter.cts:151` (the one-line change that removes the `isAuditEnabled()` gate) and running `npm run test:coverage:unit` fails **29 leaf assertions** across `tests/command-routing-hub.test.cjs`, `tests/intel-command-cutover.test.cjs`, `tests/repo-invariants.test.cjs`, `tests/config.test.cjs` and the graphify/init/roadmap/state/validate cutover suites — almost entirely `--json-errors` / `GSD_JSON_ERRORS` envelope assertions of the form "emits `{ok:false, reason}`", which is the envelope shape a second stderr line breaks. (35 distinct failing names in the raw output: 29 leaves, 4 parent `describe` wrappers, and 2 entries of one unrelated pre-existing flake.) The file audit is unaffected by that trial — it is separately gated inside the logger at `src/observability/logger.cts:134` — so the measurement isolates the stderr rule alone. Shipping it inside a bug fix would smuggle a contract break past review, which is how ADR-0174 §6 came to be half-implemented in the first place. Therefore unconditional stderr-on-error **remains decided policy** and ships as a separate increment carrying an **explicit envelope version plus a migration note**. **Condition of acceptance:** that increment is filed as its own issue when this ADR lands — an undated "target state" is aspiration, not a decision.

**D2 — *(Directional)* Event grain aligned to the OpenTelemetry GenAI conventions.** Extend `DispatchEvent` toward a workflow-step/outcome grain (step, `result.kind`, timestamp, model tier, durations, trace and parent-trace ids), shaped after the OpenTelemetry GenAI **agent / tool / LLM span** conventions rather than a bespoke schema. **Align field names only — take no OpenTelemetry dependency, SDK, exporter, or collector.** A deterministic verb→step **tagger** plus a pure **fold** (`gsd-tools audit sequence`) projects events to DONE / MISSING / OUT-OF-ORDER / UNVERIFIED. The tagger MUST stay a **flat declarative table** with no conditionals, precedence, or branching; if step semantics ever need branching, that metadata belongs in the workflow markdown, not in a rules engine growing inside `audit.cts`. Content stays out of indexed fields.

**D3 — *(Directional)* The outbound trust boundary — the ADR-1577 mirror.** Add `references/outbound-share-boundary.md` and a share-redactor built on an **allowlist of fields**: emit only step, `result.kind`, timestamp, trace id, tier, durations. Be precise about what that buys, because **an allowlist over *keys* is not an allowlist over *values***. Any retained field that can carry a free-form user string — notably anything derived from `result.data` — still needs pattern scrubbing (home paths → `~`, username, email, token shapes), and **pattern scrubbing fails open on the case nobody anticipated**, which is the exact weakness this ADR rejects a denylist for. Two consequences follow. First, prefer field shapes that make the allowlist real at the value level: enums, numerics, and hashes over free text. Second, **the load-bearing control is the user-facing preview/diff shown before anything is written for sharing** — the user, not the redactor, is the last check. Never claim "fully redacted"; claim only "these allowlisted fields are included, with these scrubs applied" (ADR-1577's don't-overclaim norm, `1577:30`). Exposed as a **user-initiated** `forensics --export` / `bundle --redacted`.

**D4 — *(Directional)* Two capture sources, cleanly split.** The GSD dispatch/step log from D1 and D2 is the low-PII, GSD-owned **default trail**. The host transcript is an **opt-in, redacted, per-runtime-abstracted** rich *derive* source for deep shares — never the default, never raw. Do not rebuild capture the host already performs.

**D5 — *(Directional)* Serve the agent consumer explicitly.** Provide a **compact folded digest** (last-N dispatches plus failures, git-anchored) that `resume-work` and session-start can feed an agent as deterministic "what already ran" memory. Agent-facing consumption leans only on deterministic, git-anchored facts, never self-graded claims — the trace is not tamper-evident against the agent that writes it.

**D6 — Non-goals. *(Binding.)*** No phone-home, telemetry vendor, or network egress of any kind; egress is user-initiated only. No blocking "you skipped a gate, phase refused" control — **report, don't gate**. No dashboards. No grand reconciliation engine. Observability stays **core substrate** per ADR-857 and never becomes a `capabilities/` plug-in.

### What the approval ratifies

Recorded verbatim from the `approved-enhancement` triage on #2619, so it is not inferred later:

- **D1b as direction** — the return to the *unconditional* stderr-on-error is approved as target state, *"including its cost: a deliberate breaking change to the `--json-errors` envelope (one JSON line → two), shipping as its own increment with an explicit envelope version and migration note. The partial supersede … is approved as **disclosed** … do not retcon"* the decided rule.
- **D2's field-name alignment** to the OpenTelemetry GenAI conventions is approved as **names only**. *"No OTel dependency, SDK, exporter, or collector enters the tree."*
- **D6 non-goals are binding** — *"no phone-home, no telemetry vendor, no network egress, no blocking gate, no dashboards; observability stays core substrate per ADR-857 and never becomes a `capabilities/` plug-in."*
- **D2–D5 remain Directional** — *"binding on direction only, with concrete schemas deferred to the increment that has real traces to design against."*

### Status of each decision

| | Scope | Binding? |
|---|---|---|
| **D1** | Wire the seam behind the existing opt-in gate | Binding — shipped 2026-07-28 (#2620 / PR #2621) |
| **D1b** | Unconditional stderr-on-error, versioned envelope | Binding as direction; its own increment; filed on acceptance |
| **D2–D5** | Grain, outbound boundary, capture split, agent digest | **Directional** — binding on *direction* (OTel field names not bespoke; allowlist not denylist; opt-in derive not default; report not gate). Concrete schemas are deliberately deferred to the increment that has real traces to design against |
| **D6** | Non-goals | Binding |

### Increment gating

**An approved ADR does not approve its children.** Each of D1b, D2, D3, D4, and D5 lands as its own issue requiring its own approval label before any code is written, per the issue-first rule in `CONTRIBUTING.md`. One issue, one increment, one PR.

### Contract stability

- **`--json-errors` and the default dispatch output are a STABLE contract.** They are already depended on as exactly one JSON line. Changing that requires a version and a migration note — that is the whole of D1b.
- **The `DispatchEvent` NDJSON, the folded digest, and the export bundle are VERSIONED and UNSTABLE from day one.** Each carries a schema-version field from its first commit and ships with defensive tests pinning unknown-key behavior (cf. #2202's unknown-key loss). Declaring this *before* anyone depends on them is the cheapest guard available.

## Alternatives considered

- **Phone-home or vendor telemetry** — rejected: violates the standing privacy-first, no-egress stance. Egress stays user-initiated.
- **Ship unconditional stderr-on-error inside the wiring fix** — rejected: bundles a breaking contract change into a bug fix. Split into D1 and D1b instead.
- **Ratify the opt-in gate permanently and formally drop the unconditional form** — rejected: retires the highest-value outcome (agent-visible failure) to avoid a one-time versioning cost, leaving agents blind indefinitely.
- **Denylist / pattern-scrub redaction as the primary control** — rejected: fails open on the unanticipated secret. Allowlisted fields plus a user-visible preview fail closed; pattern scrubbing is a secondary layer, never the claim.
- **Build capture from scratch** — rejected: the host already persists a full transcript and GSD already ingests it. Instrument only the clean GSD-owned events and derive the rest.
- **One grand observability engine** — rejected: ship D1, collect real traces, then design D2 and D3 against data.
- **A blocking conformance gate** — rejected: report and let a human decide; skips are often correct (`quick` and `fast` paths).
- **Leave the seam dormant and just fix the docs** — rejected: it would document away a real regression and keep agents blind to silent failures. The ADR-decided behavior should ship, not be retconned out.

## Consequences

Scoped per decision, so this ADR does not repeat the overclaim it charges `docs/CONFIGURATION.md` with in Context #1.

**From D1 (shipped).** `GSD_AUDIT` stops being a lie, and the opt-in file audit produces real traces for the first time — which is the data D2 through D5 need in order to be designed rather than guessed. ADR-0174 §6 conformance is restored for the injected-logger rule. Default runtime behavior is unchanged, so the blast radius is zero for anyone who does not opt in — and correspondingly **agents gain nothing by default**: a user who has not set `GSD_AUDIT` sees exactly what they saw before.

**From D1b (target).** Agents recover from *visible* failures instead of silent ones — the highest-impact outcome here. Cost: a genuine breaking change to a stable contract, paid deliberately with a version and a migration path rather than accidentally.

**From D2–D5 (directional).** The team gets an opt-in, redacted data path where today there is none; capture reuses the host transcript rather than reinventing it; the event vocabulary aligns to a vendor-neutral standard instead of a private ontology.

**Costs and risks.** Every emitted schema becomes a depended-on contract the moment it ships — addressed by the stability declaration above. The share-redactor and the per-runtime transcript adapters are ongoing maintenance. A conformance signal must never become a target: dispatch-presence proves "step invoked", never "step done well", so the fold reports and never gates. The trace is **not** an integrity control against a deceptive agent — that agent controls the ledger, the git identity, dates, trailers, and artifacts alike; real integrity would need signed commits with a key outside the agent's environment plus a protected remote, which is out of scope. This work targets **accidental** failures and honest-run auditability, which is where the great majority of real failures live.

## Applied software laws

- **Gall's Law** — increments, and D2 through D5 are explicitly Directional because the simple version has not been operated yet. Reuse the working host transcript rather than rebuilding capture.
- **Hyrum's Law** — `--json-errors` declared stable; every new emitted schema versioned and pinned with defensive tests from its first commit; D1b pays the contract change deliberately.
- **Kerckhoffs's Principle** — allowlisted fields, public-safe design, no unverifiable "fully redacted" claim, and the honest admission that an allowlist over keys is not an allowlist over values, which is why the preview is load-bearing.
- **Greenspun's Tenth Rule** — the verb→step tagger stays a flat declarative table; branching step semantics belong in workflow markdown, not a rules engine growing inside `audit.cts`.
- **Goodhart's Law** — report, never gate; no conformance-percentage target; dispatch-presence is not step quality.
- **Postel's Law** — the fold and the export degrade gracefully on missing sources; an absent trace never implies a skipped step; claims stay conservative.
- **The Shirky Principle** — applied narrowly, via its *identity* mechanism only: "privacy-first" is load-bearing for GSD's identity, which creates real structural resistance to any diagnostic emission, including emissions that would serve users. Naming that resistance is why the outbound boundary has to be designed deliberately rather than left to drift.
- **Choose Boring Technology** — NDJSON, git trailers, and a scrub function. No analytics platform, and explicitly no OpenTelemetry dependency despite aligning to its field vocabulary.

## Out of scope

Integrity against a deceptive agent (signed commits with an out-of-environment key plus a protected remote). Any network egress, exporter, or collector. Real-time dashboards. Rewriting the forensics reconstruction path to read a log instead of git, `STATE.md`, and phase directories. The `docs/CONFIGURATION.md` overstatement and the two residual wiring defects from Context #1, each of which is its own follow-up issue.

## References

- [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) — §6 observability seam (`0174:102-108`), the injected-logger claim (`0174:66`), the opt-in file audit (`0174:106`).
- [ADR-1577](1577-untrusted-input-boundary-and-injection-blocking.md) — the inbound boundary and its refusal to claim an unverifiable redaction (`1577:30`).
- [ADR-857](857-capability-system.md) — core substrate versus Feature Capability.
- [ADR-0001](0001-dispatch-policy-module.md) / [ADR-0012](0012-command-routing-hub.md) — the dispatch seam.
- `CONTEXT.md` §"Dispatch Observability Module" — the third surface describing this contract as live.
- `docs/CONFIGURATION.md:1667-1668,1730` — `GSD_AUDIT` / `GSD_AUDIT_ARGS` documented as working.
- Issues: [#2619](https://github.com/open-gsd/gsd-core/issues/2619) (this ADR), [#2620](https://github.com/open-gsd/gsd-core/issues/2620) / PR [#2621](https://github.com/open-gsd/gsd-core/pull/2621) (D1), [#2202](https://github.com/open-gsd/gsd-core/issues/2202) (unknown-key loss).
