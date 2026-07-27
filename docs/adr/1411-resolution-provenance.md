# Resolution must report provenance, not fall open silently

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

A verb resolves config (or a skill set, or a planning path) from the invoking **cwd / `GSD_WORKSTREAM` / stored workstream pointer**. When that ambient context is "off" — a descendant subdirectory with no `.planning/`, or a workstream with no scoped config — resolution **silently falls open to bare defaults**, the verb **succeeds with empty output and no signal**, and a downstream subagent plans or verifies without its configured context. The gap is invisible: output is still produced.

We have shipped the **same fix-shape ≈11 times** between April and June 2026 — *anchor to the project root* / *fall back to the root config instead of defaults* / *bolt a diagnostic onto one verb*. The recurrence is concentrated, not scattered:

- **`loadConfig` is a 9-patch `try/catch` ladder** (#315, #443, #910, #1683, #2517, #2714, #3023, #3024, #3523). Each "config fell to defaults" bug adds a branch, and **the returned object is the same shape whether it found real config or bare defaults** — so every caller that cares re-detects degradation by sniffing the contents.
- The **agent-skills verb received this exact fix twice in two weeks**: #1374/#1376 (the `warnings[]` field) and then #1366 (PR #1408).
- The diagnostic half is **hand-rolled eight ways across seven files**; the I/O Module's `output()` has no notion of a "degraded" result.
- The walk-up to the project root exists **three-to-four times**; PR #1408 adds a *weaker fourth* (`resolvePlanningCwd`) because the canonical `findProjectRoot` (Project-Root Resolution Module) skips the plain single-repo-descendant case.

### The #1366 trigger

`gsd-tools query agent-skills <agent>` resolved a configured agent's `<agent_skills>` block to **empty** with no diagnostic under two invocation-context drifts: (1) invoked from a descendant subdirectory with no `.planning/`, config fell through to bare defaults → `agent_skills` was `{}`; (2) `GSD_WORKSTREAM` pointed at a workstream with no scoped config → the same fall-through. In both cases the verb exited 0 and emitted an empty block, so a planner/checker subagent planned or verified without its configured skill/rule context, invisibly.

### The generalizing precedent

**ADR-227** established that *input* validation at a trust boundary must check semantic shape, not just type, and surface coercion rather than propagate a contractually-invalid value. This ADR is the analog for the *resolution* side of the same trust boundary: looking a value up from ambient context (cwd, env, a stored pointer) is itself a trust boundary, and **silently substituting defaults when the lookup misses is the resolution-side equivalent of propagating a garbage value** — the caller cannot tell a real answer from a degraded one. CONTEXT.md's *Planning Path Projection Module* already states the rule for the SDK path-projection seam — "invalid workspace context is a validation error at this seam rather than a silent fallback" — but the CJS `loadConfig` never adopted it.

## Decision

Context resolution at a trust boundary — reading config, anchoring to a project root, resolving a workstream — **MUST report its provenance**. A resolver may fall back, but the fallback **must be a visible value, not a silent substitution**. Three sub-rules:

1. **Deterministic anchoring.** Resolve the project root through **one** walk-up module. Resolution MUST NOT depend on an arbitrary descendant cwd. The single owner is the Project-Root Resolution Module; ad-hoc walk-ups (e.g. `resolvePlanningCwd`) are retired into it.
2. **Provenance, not a bare value.** A resolver returns *what* it resolved **and** *where it came from*. Callers branch on the provenance field, never on the resolved contents, to detect degradation.
3. **Visible degradation.** A *configured* input that resolves empty MUST emit a diagnostic. "Not configured" and "configured-but-resolved-empty" MUST be distinguishable in the output contract.

Concretely, the principle binds three seams:

- **Config Loader Module** — `loadConfig` exposes a `ConfigResolution { config, source: 'workstream' | 'root' | 'global-defaults' | 'builtin-defaults', degraded: boolean }`. Introduced additively (`loadConfigResolved`) so the ~16 existing `loadConfig` call sites, SDK parity, and the generated `.cjs` are unaffected until they opt in.
- **Project-Root Resolution Module** — absorbs the nearest-`.planning/` ancestor as a first-class heuristic; `resolvePlanningCwd` and any sibling walk-up are deleted.
- **I/O Module** — a shared `Resolution<T> { value, configured, reason, warnings }` envelope; `output()` carries degradation so the eight hand-rolled `warnings[]` shapes converge on one.

A *configured* input that resolves empty **without** a reason is a CI-guarded regression (grandfather burn-down, mirroring the `no-adhoc-markdown-parsing` rule).

## Consequences

### Bug classes avoided

- **Silent context drop** — a planner/checker subagent planning or verifying without its configured skills (the #1366 / #1374 class).
- **N callers re-sniffing** — every consumer re-deriving "did this fall open?" from config contents instead of reading one field.
- **Walk-up drift** — a fourth or fifth project-root resolver diverging from the canonical one.

### Cost

- `loadConfig`'s result type grows — mitigated by the additive `loadConfigResolved`; callers migrate incrementally.
- One envelope to learn; ~18 verbs migrate onto it across phases P3–P4.

### Tradeoff

As in ADR-227, resolution may still fall back to preserve continuity — a missing workstream config should not abort the verb. The difference is that the fallback is now a **visible value plus an opt-in warning**, never a silent success. Fields where a miss is genuinely fatal may throw; that is a per-call decision, not the general rule.

## Alternatives considered

### Per-verb patching (status quo)

Rejected. The same fix-shape regenerated ≈11 times because each patch fixed one call site without changing the policy that the resolver fails open and hides which branch fired.

### Throw on a resolution miss

Rejected, for ADR-227's reason: throwing breaks pipeline continuity. A missing workstream config must not abort `query agent-skills`. Visible provenance preserves continuity *and* visibility.

### Deterministic anchoring only (no provenance)

Rejected. Fixing cwd/workstream drift removes the most common trigger but leaves callers re-sniffing contents and the diagnostic hand-rolled per verb — the bug class would keep regenerating at the next new consumer.

## Related

- **Epic:** #1411 (Resolution Provenance) · **This ADR (P0):** #1412
- **Supersedes** the tactical fix in PR #1408 (closed) — its `resolvePlanningCwd` and local `AgentSkillsReason`/`AgentSkillsDiagnostics` are redelivered through the seams above in P1–P3.
- **Builds on:** ADR-227 (input validation shape), ADR-0004 (Planning Workspace Module), ADR-0006 (Planning Path Projection Module).
- **Prior recurrences of this class:** #1374/#1376, #1683, #991, #2714, #2638, #3523, #2652, #2791, #2555, #2623, #3196.

## Amendment — 2026-06-18: P3 narrowed (the shared envelope is not a real seam)

The original P3 plan was a single `Resolution<T> { value, configured, reason, warnings }` envelope adopted by `agent-skills`, `capability-state`, and `capability-writer`. An adversarial fit-analysis showed this fails the deletion test: `configured`/`reason` are meaningless for the capability read/mutation verbs, and `capability-writer`'s `errors[]` (operation-not-applied) is load-bearing and cannot fold into `warnings[]` (advisory). The only genuinely shared seam across the three is `warnings: string[]`.

P3 is therefore narrowed to an honest convention rather than a forced generic:

- `Resolution<T> { value, configured, reason, warnings }` (`src/resolution.cts`) is the canonical shape for **config-interpreting read verbs**. `agent-skills` is the first adopter — the `value` field is added additively to its `--json` IR with the flat fields retained for back-compat; `source`/`degraded` remain config-provenance extras.
- Capability verbs keep their existing shapes, named explicitly: read = `{ runtimeConfigDir, capabilities, warnings? }`; mutation = `{ capabilities, warnings, errors }`.
- The shared contract is documented, not forced: read verbs expose `warnings[]`; mutation verbs expose `warnings[]` + `errors[]`; `configured`/`reason` appear only on config-interpreting read verbs.

Recurrence prevention does not depend on a shared envelope — it is delivered by P4's CI guard (a configured input resolving empty must carry a `reason`). (#1416)

## Amendment — 2026-07-26: corrupt is not absent

This ADR reasons exclusively about a **resolution miss** — ambient context is "off", the lookup finds nothing, resolution falls open to defaults. It is silent on the adjacent case: input that is *present but not usable*. That silence is why five engine read paths (#1879) could fold an unusable input into the very value that means "genuinely absent" without contradicting an Accepted ADR.

The failure detection differs per site and is not one mechanism — naming them precisely, because the fix differs with them:

| Site | How "not usable" is detected |
|---|---|
| `config-loader.cts` (#1880) | `SyntaxError` from `JSON.parse`, or an errno (`EACCES`) re-thrown by `platformReadSync` |
| `roadmap-parser.cts` (#1881) | errno only — the parse is regex over text and cannot throw |
| `frontmatter.cts` (#1882) | **neither** — no I/O and no throw site; an opening `---` with no closing fence is a *structural* check the function must make for itself |
| `planning-workspace.cts` / `verify.cts` (#1883) | errno from `readdirSync` (`EACCES`/`EIO`) |
| `planning-workspace.cts` (#1884) | an errno that was swallowed, then misclassified as a different condition |

### What the two governing ADRs actually permit

Read together rather than selectively, ADR-1411 and ADR-227 converge, and they do **not** license throwing as a cluster-wide answer:

- **ADR-227's Decision** requires malformed input to be *"silently coerced to the contract's safe default … It MUST NOT be propagated. Throw only if the surrounding codebase treats throws as a normal-flow signal (it usually does not …)"*, and its rejection of throwing carves out only fields where a value is *"genuinely fatal (not just malformed) … a per-field decision, not the general rule."* Malformed is explicitly on the coerce side of that line.
- **This ADR's own Decision** says: *"A resolver may fall back, but the fallback **must be a visible value, not a silent substitution**."*

The gap in the five sites is therefore **not** that they fall back. It is that they fall back **invisibly**. Continuity is correct and stays; the silence is the defect.

### The pattern — keep the fallback, make it visible

Both mechanisms below preserve every current return value. Neither changes a return type, so no caller that treats "absent" and "unusable" identically breaks.

- **In-band, where the result already carries provenance.** A read whose result is a provenance envelope names the cause in that envelope. `loadConfigResolved`'s `ConfigResolution { config, source, degraded }` is the first adopter (#1880): genuine absence keeps `degraded:false`; an unusable config sets `degraded:true` and adds a `reason`. `Resolution<T>` (`src/resolution.cts`) has **no** value for this case today — its documented vocabulary is `resolved` / `not_configured` / `configured_empty` / `configured_unresolved`, all of which describe a miss. #1880 introduces the unusable-input values and is responsible for documenting them alongside the existing four.
- **Out-of-band, where the return is a bare value that cannot carry provenance.** A read that returns a bare sentinel or a plausible default keeps returning exactly that, and emits a **deduplicated `stderr` diagnostic** naming the file and the errno. This covers `getRoadmapPhaseInternal` (#1881), `findContextMdIn` / `listMilestoneArchiveDirs` (#1883), `getMilestoneInfo` (#1881) — whose fallback is a populated `{ version: 'v1.0', name: 'milestone' }` rather than an empty sentinel, and a plausible-looking default is *more* in need of a diagnostic than an empty one, not less — and `extractFrontmatter` (#1882), which returns `{}`. The repo's existing seam is `config-loader.cts`'s `_warnedUnknownConfigKeys` guard around `process.stderr.write`.

  **This is unconditional, and that is a deliberate divergence from ADR-227.** ADR-227's Tradeoff proposes mitigating silent coercion with *"an opt-in debug log (`process.env.GSD_DEBUG`)"*; that env var has never been implemented, and an opt-in nobody sets is indistinguishable from the silence #1879 is about. This ADR's own Decision is the stronger rule and the one that governs here — degradation must be **visible**, not discoverable-on-request. The `_warnedUnknownConfigKeys` precedent is likewise unconditional. Appliers follow this ADR, not ADR-227's tradeoff, on that point.

  **Dedup key.** Key the guard on the *resolved absolute path plus the errno*, not on the message text or the bare errno. Keying too coarsely suppresses a genuine second failure in a different file; keying on prose couples the guard to wording.

**Throwing is not the cluster's answer.** It remains available only under ADR-227's genuinely-fatal carve-out, decided per call and justified in that PR — never inferred from the return shape. `withPlanningLock` (#1884) is the one site that qualifies, and it already throws; its defect is that it throws the *wrong* error after swallowing the real one.

**Detection, not propagation, where there is no exception.** #1882 takes the out-of-band mechanism above like its siblings — the difference is only in how the condition is *found*. `extractFrontmatter` takes a `string`, does no I/O, and has no throw site, so there is nothing to catch: an opening `---` with no closing fence is a structural check the function must make for itself, and having made it, it distinguishes malformed-truncated from well-formed-and-empty and emits the same deduplicated diagnostic. The check has to be written; the signal shape is not a new one.

**Wiring clause.** A `reason` that exists only inside an envelope no caller reads is not a delivered signal — it is an unreachable field. An in-band adopter MUST also expose the cause on the surface its callers actually use. `loadConfig`, the thin wrapper over `loadConfigResolved`, returns `.config` alone to roughly thirty call sites; adding `reason` to the envelope without a diagnostic on that path leaves every one of them exactly as blind as before.

**Caller audit is mandatory per applier.** Implemented as specified, neither mechanism can break a caller — no return type changes. The audit exists to prove the applier *did* implement it as specified, which is a different claim. The concrete hazard: `src/state.cts` carries a comment recording that a defensive `try/catch` around `getMilestoneInfo` was **deliberately removed** under the #2245 audit because that function "never throws". An applier who reaches for a throw here — the intuitive fix, and the one this amendment rules out — silently breaks that invariant. Each applying PR records its caller audit for that reason.

**CI ratchet.** `scripts/lint-resolution-provenance.cjs`'s `REGISTRY` currently holds one verb (`agent-skills`). The config-loader seam is not registered, so nothing today would catch a regression of #1880's contract. #1880 registers it.

**Test methodology.** Assert the typed surface, not the diagnostic prose — `CONTRIBUTING.md`'s *Prohibited: Raw Text Matching on Test Outputs* applies to `stderr` as much as to `stdout`, and `tests/roadmap-parser.test.cjs` already states the local convention for this call surface. Where the mechanism's only observable is a diagnostic, the applier exposes the typed surface (a frozen reason enum, or the dedup set) and asserts on that.

First appliers: #1880 (in-band), #1881 / #1882 / #1883 (out-of-band), #1884 (genuinely-fatal carve-out, already throwing) — epic #1879, Phase 0 = #2674.
