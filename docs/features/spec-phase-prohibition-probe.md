---
id: 146
title: Spec-Phase Prohibition Probe
group: v1.43.0 Features
---

**Command:** `/gsd-spec-phase`

**Purpose:** Surface the unwritten *must-NOT* constraints — the values/safety/ethics interpretations a feature could silently become that the author would never want but the spec does not forbid — before any code is written. The edge probe reaches data-shape edges; it structurally cannot reach prohibitions. This is the missing instrument, running as `Step 5.6` of spec-phase, after the edge probe.

**Behavior:** A two-stage, prose-orchestrated pass per requirement (no compiled recall engine — recall is inherently model-driven, ADR-550 D7b):

1. **Recall (adversarial probe):** *"What could this feature silently become that the author would NOT want, but the spec does not forbid?"* — model-robust open-vocabulary elicitation across values/safety/ethics.
2. **Precision (one-pass classifier):** drop routine-engineering items, keep genuine values/safety/ethics prohibitions — collapses the raw list to the load-bearing few.

Each surfaced prohibition is resolved to exactly one of three states:

| State | Meaning | Downstream effect |
|-------|---------|-------------------|
| `resolved` | Confirmed a real must-NOT | NEGATIVE acceptance criterion written into the SPEC `## Prohibitions (must-NOT)` section; lifted into `plan-phase` `must_haves.prohibitions` (its own sibling block, never `truths`) |
| `dismissed` | Not a genuine prohibition (requires a non-empty reason) | Recorded with its reason; empty dismissals are rejected |
| `unresolved` | Deferred | Soft-gates the spec; surfaced as a planner assumption |

Each resolved prohibition carries a `verification` tier — `test` (a negative test can enforce it) or `judgment` (only human/LLM judgment can). At verify time, judgment-tier prohibitions route to a never-silent / never-hard-halt soft gate (autonomous emits an `unverified-prohibition — human review recommended` flag); test-tier prohibitions are enforced via the deterministic `check prohibition-enforcement` gate — green when the wired negative test / lint rule passes, hard-gate (flagged, non-green) when missing or failing, in both interactive and autonomous modes (#1259, ADR-550 D5d). Under `--auto`, the probe **never auto-dismisses**. Canon-bound concerns (OWASP / GDPR / fairness) are referred to `/gsd-secure-phase` rather than minting SPEC prohibitions (ADR-550 D6).

The load-bearing wire is the `plan-phase` lift into `must_haves.prohibitions`, so the section is not merely documentation.

**Deterministic prohibition-check descriptor source (#1278).** A resolved `test`-tier prohibition MAY carry an optional **`check` descriptor** — the flat-scalar keys `check_kind` (`node-test` | `lint-rule`), `check_target`, and `check_rule` (lint-rule only) — authored at spec-phase. `projectProhibitions` projects these scalars deterministically and verify-phase reads them back to locate the check handed to `check prohibition-enforcement`, so a wired, passing test closes the gap with **zero manual descriptor authoring** (previously the verify-phase LLM had to invent `{kind, target, rule}` each run, #1259). The descriptor is **optional and backward-compatible** — a descriptor-less prohibition parses and disposes byte-identically to today — and **fail-closed**: a partial, invalid, or absent descriptor falls through to the producer's existing fail-closed locate, never a silent green. `failFirst` stays a verify-time caller attestation (machine-proven fail-first is tracked in #1279).

**Requirements:**
- REQ-PROHIB-01: The prohibition pass MUST run after the edge probe and emit a `## Prohibitions (must-NOT)` SPEC section.
- REQ-PROHIB-02: Stage 1 MUST ask the adversarial recall question; Stage 2 MUST drop routine-engineering items and keep values/safety/ethics prohibitions.
- REQ-PROHIB-03: A `dismissed` resolution MUST require a non-empty reason.
- REQ-PROHIB-04: `--auto` MUST never auto-dismiss.
- REQ-PROHIB-05: `plan-phase` MUST lift resolved prohibitions into `must_haves.prohibitions` (never `truths`).
- REQ-PROHIB-06: A well-formed but unwired `test`-tier prohibition MUST fail closed at verify time — never a silent pass.
- REQ-PROHIB-07: A `test`-tier prohibition with a **machine-proven-fail-first**, genuinely-passing (non-vacuous) wired mechanical check (a `node --test` negative test OR a lint/AST rule) MUST dispose green and be satisfiable; a missing, un-provable, or non-passing check MUST hard-gate (flagged, non-green) in both interactive and autonomous modes. Fail-first is **machine-proven, not caller-attested** (#1279, ADR-550 D5d): before a clean pass greens, the producer independently runs the wired check against a known violation (the descriptor's `violationFixture`) and confirms it goes RED — a lint rule via the violating fixture, a node test via the violating subject injected through the `GSD_PROHIB_SUBJECT` convention; absent a violation source it fails closed, never falling back to attestation. (Enforcement half shipped #1259; deterministic descriptor auto-locate in #1278.)

**Reference:** [Prohibition Probe](../gsd-core/references/prohibition-probe.md)
