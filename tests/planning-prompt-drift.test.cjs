/**
 * Tests for the prompt-layer plan/summary-COUNTING drift guard (epic #3180,
 * ADR-3180 Decision 4(e)) — `scripts/lint-planning-prompt-drift.cjs`.
 *
 * Covers:
 *   - `findPromptDrift` — the per-line detection shape (a `*...PLAN.md` /
 *     `*...SUMMARY.md` set glob AND a counting operator on the same line),
 *     and its documented near-miss exclusions.
 *   - `diffAgainstBaseline` — the three ratchet invariants (known / fresh /
 *     stale), keyed on TEXT not line number, exercised on synthetic input.
 *   - `loadBaseline` / `scanRepo` against the real, committed repo state —
 *     the guard's actual contract.
 *
 * Uses fs.mkdtempSync directly for the one synthetic-tree fixture, matching
 * the sibling drift-guard test suites' own drift-guard sections — cleaned
 * up in `t.after()`, never a fixed path.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const drift = require('../scripts/lint-planning-prompt-drift.cjs');
const { findPromptDrift, scanRepo, loadBaseline, diffAgainstBaseline } = drift;
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// ─── POSITIVE ───────────────────────────────────────────────────────────

describe('findPromptDrift — positive detection', () => {
  test('X=$(ls dir/*-PLAN.md 2>/dev/null | wc -l) is detected', () => {
    const line = 'X=$(ls dir/*-PLAN.md 2>/dev/null | wc -l)';
    const out = findPromptDrift(line, 'gsd-core/workflows/fake.md');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].found, '*-PLAN.md');
    assert.strictEqual(out[0].text, line);
  });

  test('the *-SUMMARY.md variant is detected', () => {
    const line = 'X=$(ls dir/*-SUMMARY.md 2>/dev/null | wc -l)';
    const out = findPromptDrift(line, 'gsd-core/workflows/fake.md');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].found, '*-SUMMARY.md');
  });

  test('a grep -c variant is detected', () => {
    const line = "Y=$(grep -cE '^' dir/*-PLAN.md)";
    const out = findPromptDrift(line, 'gsd-core/workflows/fake.md');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].found, '*-PLAN.md');
  });
});

// ─── NEGATIVE — each with a comment saying WHY it must not fire ──────────

describe('findPromptDrift — negative: documented near-misses', () => {
  test('grep -cE task-heading count inside ONE NAMED plan (no glob) is NOT detected', () => {
    // A real line in gsd-core/workflows/execute-plan.md: it counts <task>
    // elements INSIDE one already-named plan file — no `*` glob token
    // anywhere near PLAN.md — so it is not a plan-COUNT re-derivation. A
    // false positive here would redden lint:ci on an untouched file.
    const line = "grep -cE '^\\s*<task[[:space:]>]' .planning/phases/[current-phase-dir]/{phase}-{plan}-PLAN.md";
    const out = findPromptDrift(line, 'gsd-core/workflows/execute-plan.md');
    assert.deepStrictEqual(out, []);
  });

  test('a *-UAT.md count is NOT detected', () => {
    // UAT artifacts are a different derivation this guard does not own —
    // PLAN_SUMMARY_GLOB_RE requires the literal PLAN.md or SUMMARY.md
    // suffix, which "UAT.md" never satisfies.
    const line = 'X=$(ls dir/*-UAT.md 2>/dev/null | wc -l)';
    const out = findPromptDrift(line, 'gsd-core/workflows/fake.md');
    assert.deepStrictEqual(out, []);
  });

  test('a line that globs plan files but does not count them is NOT detected', () => {
    // Reading/iterating (cat, backup, cross-reference) over a *-PLAN.md
    // glob without a counting operator is not this derivation — every
    // non-counting *-PLAN.md/*-SUMMARY.md glob in plan-phase.md is exactly
    // this shape and is deliberately left alone.
    const line = 'cat dir/*-PLAN.md';
    const out = findPromptDrift(line, 'gsd-core/workflows/fake.md');
    assert.deepStrictEqual(out, []);
  });
});

// ─── RATCHET MECHANICS — diffAgainstBaseline on synthetic inputs ─────────

describe('diffAgainstBaseline — ratchet invariants (synthetic)', () => {
  test('a violation whose (file, text) pair is in the baseline is KNOWN: neither fresh nor stale', () => {
    const baseline = [{ file: 'a.md', text: 'X=$(ls *-PLAN.md 2>/dev/null | wc -l)' }];
    const violations = [
      { file: 'a.md', line: 10, found: '*-PLAN.md', text: 'X=$(ls *-PLAN.md 2>/dev/null | wc -l)' },
    ];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
  });

  test('a violation absent from the baseline is FRESH: fails', () => {
    const baseline = [];
    const violations = [
      { file: 'a.md', line: 1, found: '*-PLAN.md', text: 'Y=$(grep -c dir/*-PLAN.md)' },
    ];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].text, 'Y=$(grep -c dir/*-PLAN.md)');
    assert.deepStrictEqual(stale, []);
  });

  test('a baseline entry matching nothing this run is STALE: fails', () => {
    const baseline = [{ file: 'a.md', text: 'X=$(ls *-PLAN.md 2>/dev/null | wc -l)' }];
    const violations = [];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].text, 'X=$(ls *-PLAN.md 2>/dev/null | wc -l)');
  });

  test('keying is on TEXT not line number: the same trimmed text at a different line is still KNOWN', () => {
    // This is what stops the baseline rotting on an unrelated edit that
    // merely shifts line numbers (a new paragraph, a reworded step).
    const baseline = [{ file: 'a.md', text: 'X=$(ls *-PLAN.md 2>/dev/null | wc -l)' }];
    const violations = [
      { file: 'a.md', line: 999, found: '*-PLAN.md', text: 'X=$(ls *-PLAN.md 2>/dev/null | wc -l)' },
    ];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
  });
});

// ─── scanRepo — tree-walk mechanics on a synthetic tree ───────────────────

describe('scanRepo — synthetic tree', () => {
  test('a violation in a fresh temp tree is reported with its file, line, and text', (t) => {
    const root = createTempDir('gsd-planning-prompt-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'gsd-core', 'workflows', 'fake.md'),
      'X=$(ls dir/*-PLAN.md 2>/dev/null | wc -l)\n',
    );

    const violations = scanRepo(root);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].file, path.join('gsd-core', 'workflows', 'fake.md'));
    assert.strictEqual(violations[0].line, 1);
    assert.strictEqual(violations[0].found, '*-PLAN.md');
  });

  test('a clean temp tree with no re-derivations reports zero violations', (t) => {
    const root = createTempDir('gsd-planning-prompt-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, 'gsd-core', 'workflows', 'clean.md'), 'no globs or counts here\n');

    const violations = scanRepo(root);
    assert.deepStrictEqual(violations, []);
  });
});

// ─── BASELINE INTEGRITY — both directions, against the real repo ─────────

test('loadBaseline on the committed baseline returns exactly 7 entries', () => {
  const { entries, errors } = loadBaseline(REPO_ROOT);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(entries.length, 7);
});

test('scanRepo(repoRoot) matches the baseline exactly: zero fresh AND zero stale', () => {
  // The guard's actual contract: every re-derivation this run finds is
  // already acknowledged in the baseline, and every baseline entry still
  // fires — no fresh, no stale, in either direction.
  const violations = scanRepo(REPO_ROOT);
  const { entries: baseline, errors } = loadBaseline(REPO_ROOT);
  assert.deepStrictEqual(errors, []);
  const { fresh, stale } = diffAgainstBaseline(violations, baseline);
  assert.deepStrictEqual(fresh, []);
  assert.deepStrictEqual(stale, []);
});
