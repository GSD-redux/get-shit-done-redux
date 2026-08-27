'use strict';

/**
 * tests/mutation-test-derivation-drift.test.cjs
 *
 * Regression net for scripts/lint-mutation-test-derivation-drift.cjs (#3881
 * follow-up, mutation-matrix piece 2). Drives the guard's pure `findDrift`
 * against a synthetic COVERED map so this test never depends on the real
 * tests/ tree (hermetic, and immune to future test-file churn).
 *
 * Also proves, against the REAL repo (scripts/mutation-matrix.cjs's exported
 * COVERED + derivation helpers), that the guard currently reports zero drift
 * — the same invariant `npm run lint:ci` enforces, exercised in-process here
 * so a regression is caught by the normal test suite too, not only by lint:ci.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { findDrift } = require('../scripts/lint-mutation-test-derivation-drift.cjs');

describe('lint-mutation-test-derivation-drift: findDrift (synthetic)', () => {
  test('a module-named file that requires the module and is in `tests` is NOT drift', () => {
    const covered = {
      widget: { tests: ['tests/widget.unit.test.cjs'] },
    };
    const findRequiringTestFiles = (mod) => (mod === 'widget' ? ['widget.unit.test.cjs'] : []);
    const matchesModuleNamingRule = (mod, file) => file.startsWith(`${mod}.`) || file.startsWith(`${mod}-`);

    const drift = findDrift(covered, findRequiringTestFiles, matchesModuleNamingRule);
    assert.deepEqual(drift, []);
  });

  test('a module-named file that requires the module and is in `excludeTests` is NOT drift (deliberate exclusion)', () => {
    const covered = {
      widget: { tests: ['tests/widget.unit.test.cjs'], excludeTests: ['widget.integration.test.cjs'] },
    };
    const findRequiringTestFiles = (mod) => (mod === 'widget' ? ['widget.unit.test.cjs', 'widget.integration.test.cjs'] : []);
    const matchesModuleNamingRule = (mod, file) => file.startsWith(`${mod}.`) || file.startsWith(`${mod}-`);

    const drift = findDrift(covered, findRequiringTestFiles, matchesModuleNamingRule);
    assert.deepEqual(drift, []);
  });

  test('PLANTED OMISSION: a module-named file that requires the module but is in neither `tests` nor `excludeTests` IS reported', () => {
    // Reproduces the exact #3888 shape: a new frontmatter-named test file added on a
    // branch, requiring frontmatter.cjs, that nobody registered anywhere.
    const covered = {
      widget: { tests: ['tests/widget.unit.test.cjs'] },
    };
    const findRequiringTestFiles = (mod) =>
      (mod === 'widget' ? ['widget.unit.test.cjs', 'widget.new-consequence.test.cjs'] : []);
    const matchesModuleNamingRule = (mod, file) => file.startsWith(`${mod}.`) || file.startsWith(`${mod}-`);

    const drift = findDrift(covered, findRequiringTestFiles, matchesModuleNamingRule);
    assert.deepEqual(drift, [{ module: 'widget', file: 'widget.new-consequence.test.cjs' }]);
  });

  test('a requiring file that does NOT match the naming rule is never drift (cross-cutting files need extraTests, not auto-detection)', () => {
    const covered = {
      widget: { tests: ['tests/widget.unit.test.cjs'] },
    };
    const findRequiringTestFiles = (mod) => (mod === 'widget' ? ['widget.unit.test.cjs', 'unrelated-integration.test.cjs'] : []);
    const matchesModuleNamingRule = (mod, file) => file.startsWith(`${mod}.`) || file.startsWith(`${mod}-`);

    const drift = findDrift(covered, findRequiringTestFiles, matchesModuleNamingRule);
    assert.deepEqual(drift, []);
  });

  test('a module with no requiring files at all reports no drift', () => {
    const covered = { widget: { tests: [] } };
    const findRequiringTestFiles = () => [];
    const matchesModuleNamingRule = () => false;
    assert.deepEqual(findDrift(covered, findRequiringTestFiles, matchesModuleNamingRule), []);
  });
});

describe('lint-mutation-test-derivation-drift: real repo has zero drift', () => {
  test('scripts/mutation-matrix.cjs COVERED has no undisposed module-named requiring test file', () => {
    const {
      COVERED,
      findRequiringTestFiles,
      matchesModuleNamingRule,
    } = require('../scripts/mutation-matrix.cjs');

    const drift = findDrift(COVERED, findRequiringTestFiles, matchesModuleNamingRule);
    assert.deepEqual(
      drift,
      [],
      `found undisposed test file(s): ${JSON.stringify(drift)} — see scripts/lint-mutation-test-derivation-drift.cjs`
    );
  });
});
