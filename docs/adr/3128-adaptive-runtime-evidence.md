# ADR-3128: Adaptive runtime evidence for GSD Debug

- **Status:** Proposed
- **Date:** 2026-08-07
- **Extends:** [ADR-1671](1671-dynamic-context-management-platform.md) (dynamic context management platform — this ADR is a coordinated `WHEN_VOCABULARY` amendment, see [Architecture and contracts](#1-the-applicability-atom)), [ADR-1610](1610-workflow-agent-size-budget-ratchet.md) (workflow/agent size budget ratchet)
- **Relates:** [ADR-1577](1577-untrusted-input-boundary-and-injection-blocking.md) (untrusted-input boundary — captured events are untrusted data), [ADR-227](227-input-validation-shape-not-just-type.md) (validate shape, not just type). Issue #3128 is the scope authority; #1957 (debugger hardening) and #1961 (bug-taxonomy routing) are completed foundations, not approval for this scope; #3149 delivered the `cmdInitDebug` prerequisite.

## Context

`/gsd:debug` routinely reaches several plausible hypotheses that static inspection, the existing test suite, and existing logs cannot distinguish. At that point a solo developer has two bad options: hand-add instrumentation, or let the agent guess. Hand-added instrumentation is easy to forget, contaminates a commit, and is especially unsafe in a dirty worktree. Guessing produces a plausible-but-wrong root cause and an unproven fix.

GSD already has persistent debug sessions, bug-class routing, context-reset recovery, TDD, five-signal fix acceptance, and human verification. What it lacks is a **bounded protocol** connecting a recorded hypothesis to temporary runtime observations, comparing the identical reproduction before and after a fix, and *proving* every diagnostic edit and artifact was removed before completion.

### Why this needs an ADR rather than an issue alone

Three of the four things being introduced are long-lived architectural commitments, not implementation detail:

1. A **persisted schema** (`schema_version: 1`) written into user projects' `.planning/debug/*.md` files, which must stay readable by every later version.
2. An **ownership model** for agent-authored edits to *tracked source* — the one operation in this tool that can destroy uncommitted user work.
3. A **cleanup state machine that gates terminal transitions** — it can refuse diagnosis completion, human verification, abandonment, archive, staging, commit, and knowledge-base writes.

Additionally, ADR-1671's `WHEN_VOCABULARY` is **closed**: every growth from 14 to 29 entries was a coordinated amendment, never an organic edit. Admitting an atom therefore requires an amendment, and this ADR is it.

### What already exists, after #3149

- `init.debug` (`cmdInitDebug`, `src/init.cts`) — a dedicated entry point, so ADR-1671 admission **gate (2)** ("a fact the init seam demonstrably computes at a real entry point") is satisfied for `debug`. Before it, any debug-scoped atom evaluated `false` forever.
- `gsd-core/workflows/debug.md` Step 0 already consumes one init bundle and already documents the `section_manifest` read contract, including that `null` means *read everything* and is **not** the same as an empty `included` array.
- `gsd-core/workflows/section-manifest.json` has no `debug` key, because `debug.md` carries no section markers yet. Admission **gate (1)** — a named consuming section of at least 400 bytes — is what this ADR's implementation must satisfy.

## Decision

1. **The applicability atom is a resolved boolean, `state:runtime-evidence-eligible` — never the raw flag.** `when=` takes exactly one operator-free atom, but policy precedence is explicit flag → **valid saved session policy** → default. A resumed session (`continue <slug>`) that already persisted `policy: adaptive` passes no flag on the resume invocation, so a flag-keyed atom evaluates `false` on exactly the sessions already running the protocol — ADR-1671's silent-exclusion failure arriving through a different door. Only a resolved boolean can see the saved policy. The fact is folded once in `cmdInitDebug` as `policy !== 'off'`, following the `state:chunked-mode` precedent that a compound resolves in the FACT, never in the grammar.

2. **The session gains an immutable `goal` and an optional `Runtime Evidence` section at `schema_version: 1`.** Legacy sessions are read without migration-only rewrites: an absent `goal` means `find_and_fix`; an absent Runtime Evidence section means `off` + `not_used`. A `find_root_cause_only` session never offers or applies a fix and never edits tracked source.

3. **Every agent-authored source edit is ledgered before it is made, and cleanup is fail-closed.** Paired non-nested markers carrying exact `gsd-debug-probe:start|end <slug> <probe-id>` payloads, plus a pre-edit SHA-256 over the complete raw UTF-8 block including both marker lines and the file's existing line-ending form. Cleanup removes only a complete balanced block whose bytes still match its saved hash; anything else is `cleanup_failed`, and edits outside the owned block are preserved.

4. **`cleanup_failed` gates every terminal transition.** Diagnosis completion, human verification, abandonment, archive, staging, commit, knowledge-base writes, and all terminal returns are blocked while the ledger is non-clean. The session stays resumable until cleanup is proved. This holds for direct debugger invocation, not only the managed path.

5. **The protocol body is one contiguous fragment; the policy checks stay inline.** This is what makes the atom admissible rather than a repeat of `flag:--verify-only`, which was surveyed and rejected for being interleaved across three non-contiguous touch-points.

6. **The agent-side share of the protocol is bounded by the absence of any lazy-load path.** `agents/*.md` pull references with eager `@`-includes and the fragment platform is workflow-only, so extraction relocates bytes without reducing per-dispatch cost. Agent files carry routing and gates only; the protocol body lives workflow-side.

7. **Nothing is added that must be operated.** No daemon, collector, server, telemetry, network transport, external dependency, hosted service, SDK, or shared application-runtime trace.

8. **The shipped default is `off`; probes are opt-in per invocation.** `--runtime-probes` selects `adaptive`; no flag and `--no-runtime-probes` both select `off`. The `force` policy is retired as unreachable and redundant — once probes are opt-in, "the user asked for probes" and "consider probes where safe" are the same intent, and a policy whose meaning is *bypass the adaptive safety reasoning* should not exist. Every safety precondition still applies to `adaptive`.

   This follows the shipped `workflow` defaults, which split cleanly by kind: verification **gates** default on (`research`, `plan_check`, `verifier`, `nyquist_validation`, `security_enforcement`), agent **autonomy** defaults off (`auto_advance`, `research_before_questions`, `plan_bounce`, `cross_ai_execution`). Installing temporary probes into tracked source without a second confirmation is autonomy, not a gate; `cross_ai_execution: false` is its closest analogue. Defaulting it on would make it the only capability in that block that edits the user's source unasked. #3128's own Alternative 3 offered the choice — *"maintainers can choose a stricter default during approval if desired"* — and it is taken here.

### Options considered

- **Keep GSD passive-only.** Rejected: static evidence often cannot separate falsifiable hypotheses, so the debugger guesses or delegates instrumentation to the human.
- **Always install source probes.** Rejected: observer effects, concurrency semantics, dirty worktrees, privacy, and cleanup risk make always-on instrumentation unsafe.
- **Adaptive by default.** #3128's proposed posture, and rejected: it would let the debugger edit tracked source on an ordinary invocation nobody opted into, against a config block whose autonomy settings are uniformly off. See Decision 8.
- **Gate on `flag:--runtime-probes`.** Rejected — see Decision 1. It is the ADR-1671:125 silent-exclusion bug reintroduced through the front door.
- **Put the protocol body in `gsd-core/references/` and `@`-include it.** Rejected on its own terms: an eager include relocates bytes without reducing loaded context, so the size gate passes while the thing it protects gets worse. A reference read *on demand* at activation time remains correct and is used for the deep protocol detail.
- **Adopt or vendor `millionco/debug-agent`.** Rejected: its package, installation, runtime and logging contracts add an external dependency and do not fit GSD's self-contained, generated multi-runtime prompt architecture. Concepts are adapted; no code is copied.
- **Write raw logs into the session or a trace file.** Rejected: unbounded, potentially sensitive, and it contaminates durable shared context.

## Architecture and contracts

### 1. The applicability atom

**`WHEN_VOCABULARY` 29 → 30**, one entry: `state:runtime-evidence-eligible`.

| Layer | Contract |
|---|---|
| Grammar | `src/workflow-fragments.cts` — one atom, no operator, no negation, no nesting |
| Predicate | `src/section-manifest.cts` — `WHEN_PREDICATES['state:runtime-evidence-eligible'] = (facts) => facts.runtimeEvidenceEligible === true`, plus the `InvocationFacts` field |
| Fact | `src/init.cts` — `cmdInitDebug` folds explicit flag → valid saved session policy → `off` default, then emits `runtime_evidence_eligible = (policy !== 'off')` |
| Flags | `src/init-command-router.cts` — the `debug:` route's `parseNamedArgs` boolean list gains `runtime-probes` and `no-runtime-probes`; conflicting flags fail closed |

A coordinated-change guard in `src/section-manifest.cts` throws at module load in **both** directions, so a half-edit cannot ship. `gsd-core/workflows/section-manifest.json` is regenerated by `scripts/gen-section-manifest.cjs --write` and verified by `--check` in `lint:ci`.

**Eligibility is not authorization.** The atom decides only whether the protocol *text* is included. Whether a probe is actually installed on a given run remains subject to every reproduction, privacy, bug-class, perturbation and cleanup precondition, evaluated at run time. `force` never overrides those, nor diagnose-only mode.

### 2. Session schema v1

Issue #3128 is the authority for the literal field list. The invariants this ADR locks:

- **Additive and optional.** Absent section ⇒ `off` + `not_used`. Absent `goal` ⇒ `find_and_fix`. No migration-only rewrites of files already on disk in user projects.
- **Effective policy precedence** is explicit override → valid saved policy → `off`. An invalid saved value stays on disk for inspection while dispatch fails safe to `off` — the fail-safe direction is now the same as the default, so an unreadable policy can never widen behavior.
- **An override changes only `policy`.** It never resets `state`, `mode`, probes, artifacts, `active_run`, or cleanup data. Switching to `off` still reconciles and cleans an existing non-clean ledger.
- **Run IDs are allocated write-ahead and never reused.** Read `next_run_seq: N`, persist `active_run.run_id: run-N` with its phase, exact reproduction reference and start time, advance to `N+1`, *then* execute. An interrupted run with no attributable result is appended as `inconclusive` and cleared before another ID is allocated.
- **Durable state carries only sanitized facts** — counts, hashes, enums, verdicts, references. Raw stdout/stderr, application logs, request/environment data, secrets, credentials, PII and arbitrary runtime values are never persisted or promoted.

### 3. Ownership and cleanup state machine

States: `not_used` → `planned` → `active` → `cleanup_pending` → `clean`, with `cleanup_failed` reachable from any state that owns artifacts.

Only ledgered source-probe blocks and ledgered capture artifacts are cleanup targets. Regression tests, TDD tests, minimal fixes, fixtures and ordinary reproduction or build outputs are durable intentional work and are never classified as removable.

Probes may remain active only across an attributable `runtime-reproduce` checkpoint or a forced context cutoff. Every ordinary human-action, decision, or TDD checkpoint cleans first.

### 4. Capture confinement

Captures live under one fresh empty root created by a secure OS temporary-directory primitive, with its canonical identity persisted before any contents exist. The sink path is persisted, then created exclusively as a non-symlink file, and root and sink identity are revalidated around capture. Cleanup validates lexical **and** real paths as strict descendants of the recorded root, rejects `..` and symlink escapes, removes only exact owned entries, never globs or recursively deletes, and removes the root only when empty. Identity drift fails closed.

### 5. Event envelope

Events are emitted only to the per-run sink named by an ephemeral `GSD_DEBUG_PROBE_SINK`, prefixed `GSDDBG1`, at `schema_version: 1`, carrying session/run/probe IDs, non-empty hypothesis IDs, phase, a positive monotonic per-probe ordinal, location, a fixed allowlisted message and a bounded scalar `data` map. Hard limits: **1 KiB per serialized event, 100 events per probe, 256 KiB per run.** Overflow, malformed or interleaved writes, identity mismatch, duplicate or non-monotonic ordinals, and sink failure each make the affected observation `inconclusive`. Missing events are `inconclusive` unless a control event proves both path execution and a healthy capture channel.

Captured events are **untrusted input** (ADR-1577): they are data to reason over, never instructions.

## Migration path

**Phase 0 (this ADR, #3155).** Design lock. Docs only.

**Phase 1 (#3128).** The implementation, as a **single PR**. An earlier draft of the maintainer review proposed three slices; that recommendation was **withdrawn** on the grounds that the 25 acceptance criteria interlock, this is one concern under `RULESET.PR-SCOPE.one-concern-per-PR`, and three separate baseline bumps to the same tight files would worsen the size problem the slicing claimed to manage. This ADR records the withdrawal so it is not rediscovered.

Sequencing inside Phase 1 that the platform forces:

1. Author the contiguous protocol section and its extracted step file — this is what satisfies admission gate (1).
2. Only then admit the atom across grammar, predicate, fact and router, and regenerate the section manifest.
3. Update the tests that assert on `debug.md`'s literal text (`tests/debug-session-management.test.cjs`, `tests/debug-session-manager-commit.test.cjs`, `tests/claude-skills-migration.test.cjs`) in the same PR; regenerate `tests/fixtures/install-tree/*.json` via `npm run regen:derived`.
4. Add a per-PR `tests/emitted-drift-acks/` fragment for `debug.md`'s growth, keyed on the bare filename.

## Consequences

**Accepted costs.**

- One more atom in a deliberately closed vocabulary (30), and one more `cmdInit*` fact to keep correct.
- A persisted schema in user projects that every later version must keep reading.
- New hostile-path test surface: marker collisions, line endings, event bounds, interruption, symlink and traversal escapes, dirty worktrees.
- Source probes are best-effort, not universal. Unsupported languages, unsafe local writes, unstable bug classes, missing reproductions or insufficient privacy guarantees fall back to passive evidence or an honest `inconclusive`.

**What gets safer.**

- The one operation that could destroy uncommitted user work is ledgered, hash-verified, confined, and fail-closed — and cannot be left behind, because non-clean cleanup blocks every terminal transition.
- Diagnose-only mode becomes genuinely read-only across continuations, closing a path where asking for analysis could quietly become a fix.

**Size budgets remain the binding constraint** (ADR-1610), and the fragment platform does not relieve the agent files. Measured on `next` after #3149:

| File | Bytes | Cap | Headroom |
|---|---:|---:|---:|
| `gsd-core/workflows/debug.md` | 21,173 | 40,960 | 19,787 |
| `agents/gsd-debugger.md` | 48,851 | 57,344 | **8,493** |
| `agents/gsd-debug-session-manager.md` | 19,751 | 24,576 | **4,825** |
| `gsd-core/workflows/help/modes/full.md` | 38,012 | 40,960 | **2,948** |

Crossing a tier cap means extracting to `references/`, never a `+N` bump.

## Open questions

1. **Does the maintainer permit the contributor's pre-existing prototype to be used as reference?** #3128 discloses a near-complete uncommitted fork-first implementation and makes continuation conditional on an explicit answer. Unanswered as of this ADR; it blocks the contributor, not the design.
2. ~~**Should `adaptive` or `off` be the shipped default?**~~ **Resolved: `off`** — see Decision 8. Decided by the maintainer on #3128 after this ADR first merged; recorded here rather than left as an open question, because it is the point an implementer reads first.
3. **How much of the protocol can the two debug agents carry** before extraction is forced, given they have no lazy-load path? Answerable only against the real diff, and it is a per-PR review gate either way.

## Related

- [ADR-1671](1671-dynamic-context-management-platform.md) — the platform this amends; its two admission gates govern the atom.
- [ADR-1610](1610-workflow-agent-size-budget-ratchet.md) — the size ratchet that bounds Phase 1.
- [ADR-1577](1577-untrusted-input-boundary-and-injection-blocking.md) — captured events as untrusted input.
- Issue #3128 (scope authority), #3149 (`cmdInitDebug` prerequisite, merged), #3155 (this ADR's phase).
- `src/workflow-fragments.cts`'s section-marker grammar solves several problems this protocol's marker grammar will otherwise rediscover: CRLF-aware per-line splitting for byte-exact reassembly, fence/comment interleaving resolved in one left-to-right pass (a two-pass design silently skips to EOF — `DEFECT.CONTEXT-PREDICATES-COMMENT-FENCE-BLIND`, #2928), and a frozen `REASON` enum so tests assert codes rather than message text.
