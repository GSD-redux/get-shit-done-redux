'use strict';

/**
 * Characterization tests for the reviewer selection module.
 * Locks the normalizeConfiguredDefaultReviewers and resolveReviewerSelection
 * export shapes and key policy decisions.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWN_REVIEWER_SLUGS,
  normalizeConfiguredDefaultReviewers,
  resolveReviewerSelection,
} = require('../gsd-core/bin/lib/review-reviewer-selection.cjs');

describe('KNOWN_REVIEWER_SLUGS', () => {
  test('known slug appears in selected with no warning; unknown slug produces a warning and is dropped', () => {
    const knownSlug = KNOWN_REVIEWER_SLUGS[0];
    const unknownSlug = '__not_a_real_reviewer__';

    const knownResult = resolveReviewerSelection({
      detected: [knownSlug],
      explicitFlags: [],
      allFlag: false,
      configuredDefaultReviewers: [knownSlug],
    });
    assert.ok(
      knownResult.selected.includes(knownSlug),
      `expected known slug "${knownSlug}" to appear in selected`,
    );
    assert.ok(
      knownResult.warnings.length === 0,
      `expected no warnings for known slug "${knownSlug}", got: ${JSON.stringify(knownResult.warnings)}`,
    );

    const unknownResult = resolveReviewerSelection({
      detected: [unknownSlug],
      explicitFlags: [],
      allFlag: false,
      configuredDefaultReviewers: [unknownSlug],
    });
    assert.ok(
      !unknownResult.selected.includes(unknownSlug),
      `expected unknown slug "${unknownSlug}" to be dropped from selected`,
    );
    assert.ok(
      unknownResult.warnings.some((w) => w.includes(unknownSlug)),
      `expected a warning mentioning "${unknownSlug}", got: ${JSON.stringify(unknownResult.warnings)}`,
    );
  });
});

describe('normalizeConfiguredDefaultReviewers', () => {
  test('returns absent=true for undefined', () => {
    const r = normalizeConfiguredDefaultReviewers(undefined);
    assert.ok(r.absent);
    assert.deepStrictEqual(r.values, []);
    assert.deepStrictEqual(r.errors, []);
  });

  test('returns absent=true for null', () => {
    const r = normalizeConfiguredDefaultReviewers(null);
    assert.ok(r.absent);
  });

  test('returns error for non-array', () => {
    const r = normalizeConfiguredDefaultReviewers('gemini');
    assert.ok(!r.absent);
    assert.ok(r.errors.length > 0);
  });

  test('returns error for empty array', () => {
    const r = normalizeConfiguredDefaultReviewers([]);
    assert.ok(!r.absent);
    assert.ok(r.errors.length > 0);
  });

  test('normalizes slugs to lowercase', () => {
    const r = normalizeConfiguredDefaultReviewers(['Gemini', 'CLAUDE']);
    assert.ok(!r.absent);
    assert.ok(r.values.includes('gemini'));
    assert.ok(r.values.includes('claude'));
  });

  test('deduplicates slugs case-insensitively', () => {
    const r = normalizeConfiguredDefaultReviewers(['gemini', 'GEMINI']);
    assert.ok(!r.absent);
    assert.strictEqual(r.values.filter((s) => s === 'gemini').length, 1);
  });

  test('records error for invalid slug format', () => {
    const r = normalizeConfiguredDefaultReviewers(['gem@ini']);
    assert.ok(r.errors.some((e) => e.includes('invalid reviewer slug')));
  });
});

describe('resolveReviewerSelection', () => {
  test('explicit_flags source — returns intersection of flags and detected', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini', 'claude'],
      explicitFlags: ['gemini'],
      allFlag: false,
    });
    assert.equal(r.source, 'explicit_flags');
    assert.deepStrictEqual(r.selected, ['gemini']);
  });

  test('all_flag source — returns all detected', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini', 'claude'],
      explicitFlags: [],
      allFlag: true,
    });
    assert.equal(r.source, 'all_flag');
    assert.ok(r.selected.includes('gemini'));
    assert.ok(r.selected.includes('claude'));
  });

  test('no_config_all_detected source — returns all detected when no config', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: [],
      allFlag: false,
    });
    assert.equal(r.source, 'no_config_all_detected');
    assert.deepStrictEqual(r.selected, ['gemini']);
  });

  test('selected is sorted alphabetically', () => {
    const r = resolveReviewerSelection({
      detected: ['claude', 'gemini'],
      explicitFlags: [],
      allFlag: true,
    });
    assert.deepStrictEqual(r.selected, [...r.selected].sort());
  });

  test('empty detected with no flags/config falls back to no_config_all_detected with empty selected, warnings, and errors', () => {
    const r = resolveReviewerSelection({ detected: [] });
    assert.equal(r.source, 'no_config_all_detected');
    assert.deepStrictEqual(r.selected, []);
    assert.deepStrictEqual(r.warnings, []);
    assert.deepStrictEqual(r.errors, []);
  });
});

/**
 * ADR-2782 D4 (#2794) — absent-safe governs DISCOVERY, never explicit selection.
 *
 * "Not finding a lane nobody asked for is normal; failing to run a lane somebody
 * asked for is an error."
 *
 * Before this change every explicit miss was an `info`. A TOTAL miss still
 * errored, but only as a side effect of the selected set coming out empty — so
 * the PARTIAL miss (`--gemini --qwen` on a host without qwen) had no signal at
 * all: the review ran with a thinner reviewer set and present_results reported
 * success. The workflow's own guidance names why that is wrong — "a cross-AI
 * review that silently drops a lane is blind in one eye".
 */
describe('resolveReviewerSelection — explicit flags are an assertion (ADR-2782 D4)', () => {
  const errorsMentioning = (r, slug) => r.errors.filter((e) => e.includes(slug));

  test('an explicit flag for a detected reviewer selects it with no message', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: ['gemini'],
    });
    assert.deepStrictEqual(r.selected, ['gemini']);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.infos, []);
  });

  test('a partial explicit miss errors instead of degrading silently', () => {
    // THE regression row. Pre-fix this produced errors: [] and an info note,
    // and the run proceeded one-eyed.
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: ['gemini', 'qwen'],
    });
    assert.deepStrictEqual(r.selected, ['gemini'], 'the detected lane is still selected');
    assert.strictEqual(
      errorsMentioning(r, 'qwen').length,
      1,
      `expected exactly one error naming qwen, got: ${JSON.stringify(r.errors)}`,
    );
    assert.deepStrictEqual(r.infos, [], 'the miss must not be downgraded to an info');
  });

  test('a sole explicit flag that is undetected errors per-slug and in aggregate', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: ['qwen'],
    });
    assert.deepStrictEqual(r.selected, []);
    assert.strictEqual(errorsMentioning(r, 'qwen').length, 1);
    // The pre-existing aggregate message is preserved, not replaced — the
    // per-slug errors must not suppress it.
    assert.ok(
      r.errors.some((e) => e.includes('no selected reviewers are available')),
      `expected the aggregate error to survive, got: ${JSON.stringify(r.errors)}`,
    );
  });

  test('every missing explicit flag produces its own error, in a stable order', () => {
    const forward = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: ['gemini', 'qwen', 'codex'],
    });
    const reversed = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: ['gemini', 'codex', 'qwen'],
    });
    assert.strictEqual(errorsMentioning(forward, 'qwen').length, 1);
    assert.strictEqual(errorsMentioning(forward, 'codex').length, 1);
    // Order must not depend on the order flags appeared on the command line.
    assert.deepStrictEqual(forward.errors, reversed.errors);
  });

  test('a duplicate explicit flag produces exactly one error', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: ['qwen', 'qwen'],
    });
    assert.strictEqual(errorsMentioning(r, 'qwen').length, 1);
  });

  test('explicit flag matching is case-insensitive', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: ['QWEN'],
    });
    assert.strictEqual(errorsMentioning(r, 'qwen').length, 1);
  });

  test('an explicit flag with nothing detected at all errors', () => {
    const r = resolveReviewerSelection({
      detected: [],
      explicitFlags: ['gemini'],
    });
    assert.deepStrictEqual(r.selected, []);
    assert.strictEqual(errorsMentioning(r, 'gemini').length, 1);
  });

  test('pre-existing config errors do not suppress per-slug explicit errors', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: ['qwen'],
      configuredDefaultReviewers: 'not-an-array',
    });
    assert.strictEqual(errorsMentioning(r, 'qwen').length, 1);
    assert.ok(r.errors.some((e) => e.includes('must be a JSON array')));
    // Guarded on the PRE-branch error count, so the aggregate fires exactly when
    // it did before this change — i.e. not here, because a config error already
    // existed.
    assert.ok(!r.errors.some((e) => e.includes('no selected reviewers are available')));
  });

  test('non-string explicit flags are coerced, never thrown on', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: [null, 0, { a: 1 }],
    });
    assert.strictEqual(r.source, 'explicit_flags');
    assert.strictEqual(r.errors.length, 3 + 1, 'three unknown flags plus the aggregate');
  });
});

/**
 * The other half of D4, and the reason the carve-out is scoped to explicit
 * flags only: discovery paths stay lenient. `--all` is a quantifier over what
 * exists; `review.default_reviewers` is a preference evaluated across many
 * hosts. Neither is an assertion about a specific lane, so neither errors.
 */
describe('resolveReviewerSelection — discovery paths stay lenient (ADR-2782 D4)', () => {
  test('--all does not error on undetected lanes', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      allFlag: true,
    });
    assert.equal(r.source, 'all_flag');
    assert.deepStrictEqual(r.selected, ['gemini']);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.infos, []);
  });

  test('a configured default that is undetected stays an info, not an error', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      configuredDefaultReviewers: ['gemini', 'codex'],
    });
    assert.equal(r.source, 'config_default');
    assert.deepStrictEqual(r.selected, ['gemini']);
    assert.deepStrictEqual(r.errors, [], 'a preference miss must not become an error');
    assert.ok(
      r.infos.some((i) => i.includes('codex')),
      `expected an info naming codex, got: ${JSON.stringify(r.infos)}`,
    );
  });

  test('an unknown configured slug stays a warning', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      configuredDefaultReviewers: ['gemini', '__nope__'],
    });
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => w.includes('__nope__')));
  });
});
