/**
 * Tests for the completion-RATIO single-owner drift guard (epic #3180,
 * ADR-3180) — `scripts/lint-completion-ratio-drift.cjs`.
 *
 * Covers:
 *   - `findCompletionRatioDrift` — the per-line detection shape (Math.round-
 *     family + `* 100` scale + an EARLIER division on the same line), and
 *     its documented near-miss exclusions.
 *   - Function-scoped owner exemption: only `clampPercent` /
 *     `clampPercentFromFraction` inside `src/phase-lifecycle.cts` are
 *     exempt — an unrelated top-level function in that SAME file is not.
 *   - `scanRepo` against the real repo tree: zero unsanctioned
 *     re-derivations (the guard's actual contract).
 *   - The canonical owner itself (`gsd-core/bin/lib/phase-lifecycle.cjs`'s
 *     `clampPercent`/`clampPercentFromFraction`) at its numeric boundaries.
 *
 * Uses fs.mkdtempSync directly (matching plan-count-single-owner.test.cjs /
 * milestone-window-single-owner.test.cjs's own drift-guard sections, which
 * build ad hoc fixture trees rather than routing through
 * tests/helpers.cjs's createTempDir/cleanup for this particular shape) —
 * cleaned up in `t.after()`, never a fixed path.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const drift = require('../scripts/lint-completion-ratio-drift.cjs');
const { clampPercent, clampPercentFromFraction } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');
const { scanPhasePlans } = require('../gsd-core/bin/lib/plan-scan.cjs');
const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const OWNER_RELPATH = path.join('src', 'phase-lifecycle.cts');

// ─── Fixture helpers (mirrors milestone-window-single-owner.test.cjs) ─────

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeState(cwd, fields) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), lines.join('\n'));
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ─── POSITIVE: the Math.round family, each with a genuine completed/total ─
// division whose result is scaled by 100 AFTER the divide.

describe('findCompletionRatioDrift — positive detection across the rounding family', () => {
  test('Math.round with a Math.min(100, ...) ceiling is detected', () => {
    const line = 'const p = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 1);
  });

  test('Math.floor variant is detected', () => {
    const line = 'const p = Math.floor((done / total) * 100);';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.strictEqual(out.length, 1);
  });

  test('Math.ceil variant is detected', () => {
    const line = 'const p = Math.ceil((done / total) * 100);';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.strictEqual(out.length, 1);
  });

  test('Math.trunc variant is detected', () => {
    const line = 'const p = Math.trunc((done / total) * 100);';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.strictEqual(out.length, 1);
  });

  test('a version with no Math.min(100, ...) ceiling is still detected', () => {
    const line = 'const p = total > 0 ? Math.round((done / total) * 100) : 0;';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.strictEqual(out.length, 1);
  });
});

// ─── NEGATIVE: each near-miss, with a comment saying WHY it must not fire ─

describe('findCompletionRatioDrift — negative: documented near-misses', () => {
  test('Math.round(n * 100) / 100 (2-decimal rounding) is NOT detected', () => {
    // Scales FIRST, divides SECOND — clause (c)'s ordering requirement
    // (divIdx < scaleIdx) is the guard's whole precision, and this idiom is
    // the exact shape it exists to let through: it rounds an
    // already-fractional value to 2 decimal places, unrelated to a
    // completed/total percentage derivation.
    const line = 'const rounded = Math.round(n * 100) / 100;';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.deepStrictEqual(out, []);
  });

  test('Math.floor(Math.random() * 100) is NOT detected', () => {
    // Carries the rounding call and the *100 scale but no division anywhere
    // on the line (DIVISION_RE finds nothing, divIdx === -1) — clause (c)
    // alone excludes it.
    const line = 'const p = Math.floor(Math.random() * 100);';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.deepStrictEqual(out, []);
  });

  test('Math.min(Math.round(ratio * 100), 100) is NOT detected', () => {
    // Scales an ALREADY-COMPUTED fraction (`ratio`) — there is no division
    // anywhere on this line either, so it is out of scope by domain (no
    // completed/total pair is being re-derived here), the same reason the
    // Math.random() case above is excluded.
    const line = 'const p = Math.min(Math.round(ratio * 100), 100);';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.deepStrictEqual(out, []);
  });

  test('a division and a * 100 scale on two DIFFERENT lines is NOT detected', () => {
    // Documented per-line limit: this guard's detection window is ONE
    // source line. The division happens on line 1; line 2 carries the
    // Math.round-family call and the *100 scale but no division of its
    // own, so DIVISION_RE finds nothing on line 2 and clause (c) excludes
    // it, even though the two lines together form the exact re-derivation
    // shape the guard exists to catch.
    const text = [
      'const frac = done / total;',
      'const p = Math.round(frac * 100);',
    ].join('\n');
    const out = drift.findCompletionRatioDrift(text, 'src/somewhere.cts');
    assert.deepStrictEqual(out, []);
  });
});

// ─── OWNER SCOPING: function-scoped, not file-scoped ──────────────────────

describe('findCompletionRatioDrift — owner exemption is function-scoped, not file-scoped', () => {
  test('the re-derivation line inside clampPercent in src/phase-lifecycle.cts is exempt', () => {
    const text = [
      'function clampPercent(completed, total) {',
      '  return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;',
      '}',
    ].join('\n');
    const out = drift.findCompletionRatioDrift(text, OWNER_RELPATH);
    assert.deepStrictEqual(out, []);
  });

  test('the re-derivation line inside clampPercentFromFraction in src/phase-lifecycle.cts is exempt', () => {
    const text = [
      'function clampPercentFromFraction(fraction) {',
      '  return Math.min(100, Math.round((fraction * total) / 100 * 100));',
      '}',
    ].join('\n');
    // Note: the real clampPercentFromFraction body carries no division at
    // all (Math.min(100, Math.round(fraction * 100))) and so never matches
    // regardless of exemption — this fixture synthesizes a line that WOULD
    // match the detection shape, specifically to prove the exemption itself
    // (not merely the absence of a division) is what suppresses it.
    const out = drift.findCompletionRatioDrift(text, OWNER_RELPATH);
    assert.deepStrictEqual(out, []);
  });

  test('the SAME line inside a differently-named top-level function in the SAME file IS reported', () => {
    // This is the point of function-scoped rather than file-scoped
    // exemption: src/phase-lifecycle.cts is scanned like every other file,
    // and only the two named canonical functions are exempt.
    const text = [
      'function someOtherFunction(completed, total) {',
      '  return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;',
      '}',
    ].join('\n');
    const out = drift.findCompletionRatioDrift(text, OWNER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 2);
  });

  test('exempt and non-exempt functions in ONE file: only the non-exempt line is reported', () => {
    const text = [
      'function clampPercent(completed, total) {',
      '  return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;',
      '}',
      '',
      'function someOtherFunction(completed, total) {',
      '  return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;',
      '}',
    ].join('\n');
    const out = drift.findCompletionRatioDrift(text, OWNER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 6);
  });

  test('the same line in a DIFFERENT, non-owner file is reported (no exemption applies)', () => {
    const line = 'const p = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;';
    const out = drift.findCompletionRatioDrift(line, path.join('src', 'unrelated.cts'));
    assert.strictEqual(out.length, 1);
  });
});

// ─── MAX_REGEX_LITERAL_LEN boundary on the reported fragment ──────────────
// Sibling precedent: tests/plan-count-single-owner.test.cjs's
// `readRegexLiteralAt` MAX_REGEX_LITERAL_LEN boundary test (limit-1 reads,
// limit reads, limit+1 returns/truncates). This guard has no regex-literal
// tokenizer of its own (see module header) — it truncates its REPORTED
// fragment with `.trim().slice(0, MAX_REGEX_LITERAL_LEN)`, so the boundary
// here is on `found.length`, not on a returned `null`.

describe('findCompletionRatioDrift — MAX_REGEX_LITERAL_LEN boundary on the reported fragment', () => {
  test('limit-1 reports the fragment in full, limit reports it in full, limit+1 truncates', () => {
    const MAX = drift.MAX_REGEX_LITERAL_LEN;
    assert.ok(Number.isInteger(MAX) && MAX > 10, `MAX_REGEX_LITERAL_LEN must be exported as an integer > 10, got ${MAX}`);

    // A genuine re-derivation shape (Math.round + earlier division + *100),
    // padded with trailing filler characters (never `/`, `*`, digits, or
    // whitespace-adjacent tokens that could themselves alter detection) so
    // the TOTAL trimmed-line length lands exactly on each boundary.
    const base = 'const p = Math.round((done / total) * 100);';
    const build = (totalLen) => {
      if (totalLen < base.length) throw new Error(`totalLen ${totalLen} shorter than base fixture ${base.length}`);
      return base + 'z'.repeat(totalLen - base.length);
    };

    const underBound = build(MAX - 1); // limit-1
    const atBound = build(MAX); // limit
    const overBound = build(MAX + 1); // limit+1

    const underOut = drift.findCompletionRatioDrift(underBound, 'src/somewhere.cts');
    assert.strictEqual(underOut.length, 1);
    assert.strictEqual(underOut[0].found.length, MAX - 1);
    assert.strictEqual(underOut[0].found, underBound);

    const atOut = drift.findCompletionRatioDrift(atBound, 'src/somewhere.cts');
    assert.strictEqual(atOut.length, 1);
    assert.strictEqual(atOut[0].found.length, MAX);
    assert.strictEqual(atOut[0].found, atBound);

    const overOut = drift.findCompletionRatioDrift(overBound, 'src/somewhere.cts');
    assert.strictEqual(overOut.length, 1);
    assert.strictEqual(overOut[0].found.length, MAX);
    // Truncated to exactly the limit-length fragment — the first MAX
    // characters of overBound are byte-identical to atBound (same base,
    // same padding character).
    assert.strictEqual(overOut[0].found, atBound);
  });
});

// ─── scanRepo — tree-walk mechanics on a synthetic tree ───────────────────

describe('scanRepo — synthetic tree', () => {
  test('a violation in a fresh temp tree is reported with its file and line', (t) => {
    const root = createTempDir('gsd-completion-ratio-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'fake.cts'),
      'const p = Math.round((done / total) * 100);\n',
    );

    const violations = drift.scanRepo(root);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].file, path.join('src', 'fake.cts'));
    assert.strictEqual(violations[0].line, 1);
  });

  test('a clean temp tree with no re-derivations reports zero violations', (t) => {
    const root = createTempDir('gsd-completion-ratio-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'clean.cts'), 'const x = 1;\n');

    const violations = drift.scanRepo(root);
    assert.deepStrictEqual(violations, []);
  });
});

// ─── WHOLE-REPO contract: the guard's actual promise ──────────────────────

test('scanRepo(repoRoot) against the real repo returns EMPTY — zero independent re-derivations', () => {
  // This is the guard's actual contract ("0 independent re-derivations") —
  // the test that fails the day copy number seven lands.
  const violations = drift.scanRepo(REPO_ROOT);
  assert.deepStrictEqual(violations, []);
});

// ─── Canonical owner: clampPercent / clampPercentFromFraction boundaries ──

describe('clampPercent — canonical owner boundaries', () => {
  test('total 0 yields 0 (nothing to complete is 0%, never 100%)', () => {
    assert.strictEqual(clampPercent(0, 0), 0);
  });

  test('total 1, completed 0 yields 0', () => {
    assert.strictEqual(clampPercent(0, 1), 0);
  });

  test('completed === total yields 100', () => {
    assert.strictEqual(clampPercent(5, 5), 100);
  });

  test('completed > total: ceiling holds at 100', () => {
    assert.strictEqual(clampPercent(7, 5), 100);
  });

  test('a negative total yields 0', () => {
    assert.strictEqual(clampPercent(3, -5), 0);
  });
});

describe('clampPercentFromFraction — canonical owner boundaries', () => {
  test('fraction 0 yields 0', () => {
    assert.strictEqual(clampPercentFromFraction(0), 0);
  });

  test('fraction 1 (completed === total, expressed as a fraction) yields 100', () => {
    assert.strictEqual(clampPercentFromFraction(1), 100);
  });

  test('a fraction greater than 1 (completed > total): ceiling holds at 100', () => {
    assert.strictEqual(clampPercentFromFraction(1.4), 100);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// CONSUMER identity (ADR-3180 Decision 4c): the completion-ratio derivation's
// canonical owner is `clampPercent`/`clampPercentFromFraction`
// (src/phase-lifecycle.cts). Decision 4(c) requires the identity test to
// compare each CONSUMER's own observable output against the canonical
// owner's result for the SAME input — a consumer can call the owner and
// then post-process the counts it feeds it locally, which satisfies both
// the structural lint (no re-implementation of the rounding arithmetic) AND
// an owner-level identity test (the owner itself is untouched) while
// silently restoring divergence. tests/milestone-window-single-owner.test.cjs
// (~lines 819-857) is the correct precedent in this repo: it drives real CLI
// verbs and asserts on THEIR output, not the owner's return value alone.
//
// The fixture below deliberately includes a `status: superseded` plan
// (03-baz/03-02-PLAN.md) — the canonical live-plan-counting owner
// (`scanPhasePlans`, #3183) excludes it, but a consumer that locally
// re-filtered or hand-counted files instead of calling the owner would
// include it, producing a DIFFERENT numerator/denominator and therefore a
// DIFFERENT percentage. That divergence is what gives this identity test
// power per Decision 4(c) — the "power proof" test below shows the two
// counting strategies land on different percentages (75% vs 60%) over the
// SAME fixture.
// ═════════════════════════════════════════════════════════════════════════

describe('CONSUMER identity (ADR-3180 Decision 4c): percent fields match the canonical owner', () => {
  function buildFixture(cwd) {
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, [
      '## v1.0 Current 🚧',
      '',
      '### Phase 1: Foo',
      '',
      '### Phase 2: Bar',
      '',
      '### Phase 3: Baz',
    ].join('\n'));

    // Phase 1 (01-foo): 2 live plans, 2 summaries, verified -> Complete.
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/01-foo/01-02-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');
    writeFile(cwd, '.planning/phases/01-foo/01-02-SUMMARY.md', '# Summary\n');
    writeFile(cwd, '.planning/phases/01-foo/VERIFICATION.md', '---\nstatus: passed\n---\n# Verification\n');

    // Phase 2 (02-bar): 1 live plan, 0 summaries -> Planned, not complete.
    writeFile(cwd, '.planning/phases/02-bar/02-01-PLAN.md', '# Plan\n');

    // Phase 3 (03-baz): 1 live plan + 1 SUPERSEDED plan (excluded by the
    // canonical owner scanPhasePlans, #2349), 1 summary, verified -> Complete.
    writeFile(cwd, '.planning/phases/03-baz/03-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/03-baz/03-01-SUMMARY.md', '# Summary\n');
    writeFile(cwd, '.planning/phases/03-baz/03-02-PLAN.md', '---\nstatus: superseded\n---\n# Plan\n');
    writeFile(cwd, '.planning/phases/03-baz/VERIFICATION.md', '---\nstatus: passed\n---\n# Verification\n');

    return ['01-foo', '02-bar', '03-baz'];
  }

  // Independently compute the canonical totals by calling the OWNER
  // (scanPhasePlans) directly per phase directory — never re-deriving the
  // superseded-exclusion filter locally in this test.
  function ownerTotals(cwd, dirs) {
    let totalPlans = 0;
    let totalSummaries = 0;
    for (const dir of dirs) {
      const scan = scanPhasePlans(path.join(cwd, '.planning', 'phases', dir));
      totalPlans += scan.planCount;
      totalSummaries += scan.summaryCount;
    }
    return { totalPlans, totalSummaries };
  }

  test('power proof: a naive raw-file count over this fixture computes a DIFFERENT percentage than the canonical owner', () => {
    // Not itself a guard assertion — documents why the fixture below has the
    // power Decision 4(c) requires. If this ever fails, the fixture has
    // stopped exercising the superseded-exclusion divergence and must be
    // redesigned.
    const canonical = clampPercent(3, 4); // scanPhasePlans-derived: 3 summaries / 4 live plans
    const naive = clampPercent(3, 5); // raw file count: 03-02-PLAN.md counted despite being superseded
    assert.strictEqual(canonical, 75);
    assert.strictEqual(naive, 60);
    assert.notStrictEqual(canonical, naive);
  });

  test('roadmap analyze: progress_percent matches clampPercent(owner totals)', (t) => {
    const cwd = createTempDir('gsd-completion-ratio-consumer-');
    t.after(() => cleanup(cwd));
    const dirs = buildFixture(cwd);

    const { totalPlans, totalSummaries } = ownerTotals(cwd, dirs);
    const expected = clampPercent(totalSummaries, totalPlans);
    assert.strictEqual(expected, 75, 'fixture sanity: must match the power-proof test above');

    const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
    assert.strictEqual(result.success, true, result.error);
    const analyzed = JSON.parse(result.output);
    assert.strictEqual(analyzed.progress_percent, expected);
  });

  test('query progress: the percent field matches clampPercent(owner totals)', (t) => {
    const cwd = createTempDir('gsd-completion-ratio-consumer-');
    t.after(() => cleanup(cwd));
    const dirs = buildFixture(cwd);

    const { totalPlans, totalSummaries } = ownerTotals(cwd, dirs);
    const expected = clampPercent(totalSummaries, totalPlans);
    assert.strictEqual(expected, 75, 'fixture sanity: must match the power-proof test above');

    const result = runGsdTools(['query', 'progress', '--cwd', cwd, '--raw'], cwd);
    assert.strictEqual(result.success, true, result.error);
    const rendered = JSON.parse(result.output);
    assert.strictEqual(rendered.percent, expected);
  });

  test('stats: plan_percent matches clampPercent(owner totals); percent (phase-level) matches clampPercent of its own reported completed/total', (t) => {
    const cwd = createTempDir('gsd-completion-ratio-consumer-');
    t.after(() => cleanup(cwd));
    const dirs = buildFixture(cwd);

    const { totalPlans, totalSummaries } = ownerTotals(cwd, dirs);
    const expectedPlanPercent = clampPercent(totalSummaries, totalPlans);
    assert.strictEqual(expectedPlanPercent, 75, 'fixture sanity: must match the power-proof test above');

    const result = runGsdTools(['stats', '--cwd', cwd, '--raw'], cwd);
    assert.strictEqual(result.success, true, result.error);
    const stats = JSON.parse(result.output);

    // plan_percent: the completion-ratio derivation this ADR section (§7.6)
    // owns — checked against the INDEPENDENTLY owner-derived totals, so a
    // consumer post-filtering scanPhasePlans's output locally would fail
    // this exact assertion (see the power-proof test above).
    assert.strictEqual(stats.plan_percent, expectedPlanPercent);

    // percent (phase-level completion): the completed/total PAIR itself is
    // phase enumeration + phase completion's derivation (§7.3/§7.4 — a
    // SEPARATE ADR-3180 phase, not owned by this guard; §7.6's own status
    // note says numerator/denominator SAME-SCOPE-SET enforcement is Phase 7,
    // not yet shipped). Re-deriving `determinePhaseStatus` locally in this
    // test to independently compute completedPhases/phasesTotal would
    // duplicate PRODUCTION status logic rather than exercise this
    // derivation's owner. What THIS guard (§7.6, completion-ratio
    // arithmetic) owns is that whatever completed/total pair `stats`
    // reports is turned into a percent through the canonical clampPercent
    // arithmetic, never a locally re-derived ternary/rounding — asserted
    // directly against the command's own reported pair.
    assert.strictEqual(stats.percent, clampPercent(stats.phases_completed, stats.phases_total));
    // Fixture sanity: phases_completed/phases_total must be the values this
    // fixture was designed to produce (2 of 3 phases Complete), so the
    // assertion above is not vacuously true against a degenerate 0/0 pair.
    assert.strictEqual(stats.phases_completed, 2);
    assert.strictEqual(stats.phases_total, 3);
    assert.strictEqual(stats.percent, 67);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// PROPERTY tests (CONTRIBUTING.md: parsers, budget limits, and bijective
// contracts require at least one fast-check property test). clampPercent /
// clampPercentFromFraction are clamp/budget-limit functions.
// ═════════════════════════════════════════════════════════════════════════

describe('clampPercent / clampPercentFromFraction — property tests (fast-check)', () => {
  // Bounded integer domains (matching this repo's fast-check convention —
  // see tests/derive-progress.property.test.cjs, tests/eval.property.test.cjs
  // — rather than unconstrained fc.float()/fc.double(), which would exercise
  // float-precision edge cases orthogonal to the property under test).

  test('property: non-negative completed + any finite total -> integer result in [0, 100]', () => {
    // Restricted to completed >= 0 -- every real caller in this codebase
    // passes a COUNT (never a negative numerator), and clampPercent does not
    // claim to clamp a negative numerator's result into [0, 100] (verified
    // against the implementation: clampPercent(-5, 10) returns -50, since
    // Math.min(100, x) has no LOWER bound). The property as stated is true
    // only within the domain the function is actually used in.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (completed, total) => {
          const result = clampPercent(completed, total);
          assert.ok(Number.isInteger(result), `result must be an integer, got ${result}`);
          assert.ok(result >= 0 && result <= 100, `result must be in [0, 100], got ${result} for clampPercent(${completed}, ${total})`);
        },
      ),
    );
  });

  test('property: a non-positive or non-finite total always yields exactly 0 (for a non-negative completed)', () => {
    // completed restricted to >= 0 for the same reason as the property
    // above (a real numerator is always a count) — AND to sidestep a signed
    // -0 vs +0 distinction: with total === Infinity the division short-
    // circuit is skipped (Infinity > 0), so completed/Infinity is computed
    // directly, and a NEGATIVE completed produces -0 (verified against the
    // implementation: clampPercent(-5, Infinity) returns -0, which
    // Object.is-based assert.strictEqual treats as distinct from +0 even
    // though both represent 0%).
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.oneof(
          fc.integer({ min: -1_000_000, max: 0 }),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
        ),
        (completed, total) => {
          assert.strictEqual(clampPercent(completed, total), 0);
        },
      ),
    );
  });

  test('property: clampPercent(c, t) === clampPercentFromFraction(c / t) for every t > 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (completed, total) => {
          assert.strictEqual(clampPercent(completed, total), clampPercentFromFraction(completed / total));
        },
      ),
    );
  });

  test('property: clampPercent is monotonic non-decreasing in completed for a fixed total > 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (total, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          assert.ok(
            clampPercent(lo, total) <= clampPercent(hi, total),
            `clampPercent(${lo}, ${total})=${clampPercent(lo, total)} must be <= clampPercent(${hi}, ${total})=${clampPercent(hi, total)}`,
          );
        },
      ),
    );
  });
});
