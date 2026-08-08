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
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const OWNER_RELPATH = path.join('src', 'phase-lifecycle.cts');

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
