# ADR 456: Test-rigor architecture — deterministic scheduling, antagonistic tier, typed-surface mandate, and delete-bad-tests policy

- **Status:** Accepted
- **Date:** 2026-05-28

Four interrelated policies establish the test-rigor architecture for this codebase: (a) concurrency is tested deterministically via an injectable clock seam rather than real OS races, (b) fast-check property tests and Stryker mutation testing form a PR-gating antagonistic tier, (c) tests assert on typed `--json`/IR fields and exported registries, never on rendered text or source literals, and (d) pass-always, vacuous, source-grep, and racing tests are deleted and replaced with real coverage in the same change, never preserved behind permanent lint-rule debt or permanent quarantine. Real multi-process race tests are deleted once deterministic tests cover the logic.

## Context

### Observed test-quality failures

Several failure modes reached production or required significant rework:

- **Real-time race tests** — tests that rely on actual OS scheduler timing (e.g., two `Promise.race` branches whose winner depends on wall-clock latency) are non-deterministic on loaded CI runners. PR #432 / issue #407 documented a 40 % flake rate for a lock-race test that was fixed in PR #450 by replacing the real-race pattern with an injectable clock seam.
- **Source-grep tests** — tests that `readFileSync` a source file and assert on `.includes('someString')` create false confidence: the source string exists but the behavioral path it represents may be dead. `scripts/lint-no-source-grep.cjs` (now superseded by ESLint rule `local/no-source-grep`, per ADR 452) already bans this pattern, but violations still surface in PRs.
- **Vacuous / pass-always tests** — tests that assert `true` unconditionally, or that assert on a value that is computed from the same expression as the SUT input (circular), inflate test counts without exercising any behavioral path.
- **Elapsed-time assertions** — assertions such as `assert(Date.now() - start > 100)` fail spuriously on slow CI runners and pass spuriously on fast ones. They test the host, not the SUT.
- **Mutation survival** — PR #432 revealed that a mutation to the lock-release path survived the existing test suite for weeks: the test was asserting on a property that the mutant also produced correctly. Mutation testing would have caught this at PR time.

### Existing enforcement gaps

- No property-based testing framework is wired into the test suite or CI.
- No mutation testing runs in CI (Stryker was evaluated but not integrated).
- The `local/no-elapsed-assertion` ESLint rule exists (per ADR 452) but ships at `warn` initially; it needs a matching architectural policy so the rule has a canonical replacement pattern.
- The `// allow-test-rule` exemption mechanism was intended as a migration aid for the `no-source-grep` rule but has become a permanent home for tests that should be rewritten.

## Decision

### (a) Deterministic-over-racing

Concurrency logic must be tested via an **injectable clock seam** backed by `node:test` `mock.timers`, not by real OS scheduler races.

The clock seam pattern:

```javascript
// Production code — accepts an optional clock parameter
function acquireLock(resource, { clock = Date } = {}) {
  const deadline = clock.now() + LOCK_TTL_MS;
  // ... implementation using clock.now() for time checks
}

// Test code — controls time explicitly
test('lock expires after TTL', (t) => {
  t.mock.timers.enable(['Date']);
  t.mock.timers.setTime(0);
  acquireLock('res');
  t.mock.timers.tick(LOCK_TTL_MS + 1);
  assert.strictEqual(isLockExpired('res'), true);
});
```

Real multi-process race tests (where two OS processes genuinely compete for a resource) are **deleted** once the corresponding deterministic clock-seam test covers the same logical path. They are not quarantined or skipped — deleted. A deleted racing test must be replaced by a deterministic seam test in the same commit.

Wall-clock timing in production code paths that cannot accept an injectable clock (e.g., third-party integrations) must be wrapped behind an adapter interface so tests can substitute a controlled clock.

#### Reachability-based mechanism selection (amended 2026-08-10, #3314)

As originally written, this section names one mechanism — an injected `{clock = Date}` parameter driven by `t.mock.timers`. In practice this repo uses three, and the choice between them is determined by how a test reaches the system under test, not by preference:

| Test reaches the SUT via… | Mechanism | Why |
|---|---|---|
| **Direct in-process call** (`require(...)` then invoke) — regardless of whether the SUT accepts an injected clock or reads a global | `t.mock.timers.enable(['Date'])` | Patches the process-global `Date` class. Any code in the same process — whether it reads `Date.now()` directly or through `realClock.now()` — observes the mocked time. No production code change is required to make an in-process-tested function deterministic. |
| **Spawned CLI subprocess** (`execFileSync`/`spawnSync` into a new Node process) | `GSD_TEST_MODE=1` + `GSD_NOW_MS=<epoch-ms>` (subprocess time-pin adapter, issue #474), with `TZ` also pinned when local-time getters are involved | `t.mock.timers` in the parent test process cannot reach a child process's clock — mocking is process-local. `GSD_NOW_MS` is read inside `realClock.now()`'s `_pinnedNowMs()` check (`src/clock.cts`), so it reaches the subprocess's clock **only if the subprocess's code path reads time through `realClock`** (`now()`/`nowIso()`/`today()`/`localToday()`). A code path that calls raw `Date.now()`/`new Date()` bypasses the pin entirely and stays untestable no matter what the test does — this is the concrete, repo-specific form the preceding paragraph's "must be wrapped behind an adapter interface" requirement takes at the subprocess boundary. `realClock.now() === Date.now()` whenever `GSD_TEST_MODE` is unset, so routing a call site through the seam is behavior-preserving in production. |
| Module **accepts** an injected `{clock = Date}` parameter | `makeFakeClock()` (`tests/helpers/clock.cjs`) | The pattern this section already documented — unchanged, still correct for this population. |

This does not relax the typed-surface or delete-bad-tests policies elsewhere in this ADR; it only names the two mechanisms the original text omitted. Their absence from the documented policy is why several `src` modules read as "zero time-control adoption" despite some already routing through `realClock` correctly for part of their output — see #3314's audit for the concrete module-by-module classification (`commands.cts`, `init.cts`, and `io.cts` needed backfill; `roadmap.cts`, `workstream.cts`, `gsd2-import.cts`, `template.cts`, and `verify.cts` were already compliant incidental stamps; `review-lane-invocation.cts` does not touch the clock at all despite an earlier assumption that it did).

### (b) Antagonistic tier — property-based and mutation testing

Two tools form the antagonistic tier:

**fast-check** — property-based tests use `fast-check` (`fc`) to generate adversarial inputs. Property tests live in `*.test.cjs` files alongside unit tests; they do not require a separate suite tag. A property test must specify at least one invariant that must hold for all generated inputs, not just the set that a developer would think to write. Example invariant categories:

- Round-trip (serialize → parse → equal original)
- Monotonicity (larger input → larger or equal output)
- Boundary (output ∈ allowed-range for all inputs in domain)
- Idempotency (applying twice = applying once)

**Stryker mutation testing** — Stryker runs in incremental mode (`--since origin/next`) as a PR-gating signal. The default mutation score threshold is **80 %** (killed / total). Surviving mutants block merge unless the surviving mutant is in a path that is explicitly excluded in `stryker.config.mjs` with a documented reason. Stryker runs on the `ubuntu-latest` / Node 24 CI leg; it does not multiply across the OS/runtime matrix.

The three custom ESLint rules (`local/no-source-grep`, `local/no-magic-sleep-in-tests`, `local/no-elapsed-assertion`) ship at `warn` initially; a follow-up tracked at #453 flips them to `error` after the cleanup phases merge. This ADR establishes the architectural intent regardless of the current severity level.

### (c) Typed-surface mandate

Tests assert on typed `--json` fields, exported registries, and structured IR objects. They do not assert on:

- Rendered CLI text (stdout/stderr string content beyond exit-code and parse-able JSON)
- Source file literals (content of `.cjs`, `.ts`, or `.md` files read via `readFileSync`)
- Internal implementation details not exposed through a module's public API

When a CLI command must be tested, the pattern is:

```javascript
// GOOD — parse JSON, assert on typed fields
const { stdout } = await runGsdTools(['plan', '--json']);
const result = JSON.parse(stdout);
assert(Array.isArray(result.phases), `expected Array, got: ${stdout}`);
assert.strictEqual(result.phases[0].id, 'plan-1.1');

// BAD — assert on rendered text
assert(stdout.includes('Phase 1.1'), stdout);
```

When a module exports a registry (e.g., a command map, a label enum, a plugin list), tests import and assert on the registry directly, not on the output of a command that serializes it.

### (d) Delete-bad-tests policy

Tests that fall into any of the following categories are **deleted** (not commented out, not skipped, not annotated with `// allow-test-rule`) and replaced with real coverage in the same change:

| Category | Example |
|---|---|
| Pass-always | `assert(true)` or `assert.ok(someVar !== undefined)` where `someVar` is always defined |
| Vacuous-truth | Assertion computed from the same expression as the SUT input |
| Source-grep | `assert(src.includes('someIdentifier'))` where `src` is a `readFileSync` of a source file |
| Elapsed-time | `assert(Date.now() - start > N)` or equivalent |
| Real-race | Two OS processes competing for a resource with a pass/fail outcome determined by scheduler timing |
| Permanent `allow-test-rule` | `// allow-test-rule` exemptions that have been in place for more than one release cycle without a tracked cleanup issue |

"Replace with real coverage" means: in the same PR or commit, add a behavioral test that exercises the logical path the deleted test was intended to cover, using the typed-surface mandate (c) and, where concurrency is involved, the clock-seam pattern (a).

Tests must not be moved to a permanent quarantine directory or marked with a skip that has no associated tracking issue and deadline. If a test cannot be fixed now, file a tracking issue and delete the test rather than leaving a permanently-skipped test inflating the file count.

## Consequences

### For test authors

- Any new test asserting on rendered CLI text, source file content, or elapsed time will be caught by ESLint (`local/no-source-grep`, `local/no-elapsed-assertion`) — initially as a warning, later as an error after #453 merges.
- Concurrency tests must use `node:test` `mock.timers` seam from the point this ADR is accepted. Real-race tests written after this date are out of policy from the first commit.
- PRs touching modules with surviving Stryker mutants at or above the 80 % threshold must either add tests that kill the mutants or add the path to `stryker.config.mjs` with a documented reason.
- `// allow-test-rule` exemptions are a temporary migration aid. Any exemption added after this ADR is accepted must include a tracking issue number in the comment (`// allow-test-rule: see #NNN`) and will be reviewed at the issue's cleanup milestone.

### For CI

- Stryker runs incrementally (`--since origin/next`) on the `ubuntu-latest` / Node 24 leg. Cold runs (no prior cache) are expected to take 10–20 minutes; the job has a 30-minute timeout.
- `fast-check` failures are reported as standard `node:test` failures; no CI change is needed to surface them.
- The ESLint lint gate (`npm run lint`) runs alongside the test suite. A clean lint is a merge prerequisite once #453 promotes the three rules to `error`.

### For the delete-bad-tests sweep

A dedicated cleanup sweep (tracked separately from this ADR) will:

1. Enumerate all existing `// allow-test-rule` exemptions.
2. For each: either rewrite the test to comply with this ADR or file a tracking issue and delete.
3. Enumerate all existing tests that match the bad-test categories above.
4. Delete and replace each in isolated PRs, one test file per PR.

The sweep must complete before the three ESLint rules flip to `error` (i.e., before #453 merges).

## Rejected Alternatives

**(a) Annotate-and-migrate forever.** Leave existing bad tests in place with `// allow-test-rule` permanently and migrate on an unscheduled timeline. Rejected: the annotation mechanism is already used as permanent debt shelter. Unscheduled migration never happens. The delete policy with replacement creates a hard boundary.

**(b) Keep real-race tests with retry logic.** Wrap flaky race tests in a `retries: 3` loop. Rejected: retries add wall-clock latency without eliminating the non-determinism. A test that fails 1 in 10 runs will still fail on loaded runners and will not fail locally on idle machines, making the retry indistinguishable from masking.

**(c) Mutation testing as a nightly-only signal.** Run Stryker on the main branch nightly rather than on PRs. Rejected: nightly signals are not actionable at PR time. By the time a surviving mutant is reported nightly, the PR is merged and the fix requires a new PR, CI run, and review cycle. Incremental `--since origin/next` mode keeps the Stryker scope small enough for PR CI.

## References

- Tracking issue: [#456](https://github.com/open-gsd/get-shit-done-redux/issues/456)
- ESLint harness: `452-eslint-lint-harness.md`
- Warn-to-error follow-up: [#453](https://github.com/open-gsd/get-shit-done-redux/issues/453)
- Lock-race determinism fix: PR #450, issue #432 / #407
- `TESTING-STANDARDS.md` — full rule-to-enforcement table
- `docs/TESTING-SUITES.md` — suite naming and CI matrix
