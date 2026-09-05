'use strict';

/**
 * tdd-walk.qa.test.cjs — self-tests for `tests/qa/tdd-walk.cjs` (#4298, Phase 5
 * of epic #4272).
 *
 * Matrix rows referenced below are from
 * `.gsd/phase/chore-4298-tdd-walk-qa-harness/50-test-matrix.md`. Every test
 * here runs the REAL shipped bash resolution against a REAL temp project —
 * no reimplementation of the predicate, no text-shape assertions on the
 * workflow markdown standing in for execution.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TddWalk, DISPATCH_STEP_PATH, TDD_EMBED_TERNARY } = require('./qa/tdd-walk.cjs');
const { readFileNormalized } = require('./helpers.cjs');

const TDD_TYPE_PLAN = `---
type: tdd
---
<task type="auto"><name>a</name></task>
`;

const PLAIN_PLAN = `<task type="auto"><name>a</name></task>\n`;

describe('tdd-walk harness', () => {
  test('row 1 — CLI predicate resolution: type: tdd resolves applicable/plan_frontmatter', (t) => {
    const walk = TddWalk.create();
    t.after(() => walk.cleanup());
    walk.writePlan(TDD_TYPE_PLAN);
    const result = walk.resolveViaCli();
    assert.equal(result.success, true, result.error);
    assert.equal(result.applicable, true);
    assert.equal(result.source, 'plan_frontmatter');
  });

  test('row 1 — CLI predicate resolution: nothing set resolves not-applicable/none', (t) => {
    const walk = TddWalk.create();
    t.after(() => walk.cleanup());
    walk.writePlan(PLAIN_PLAN);
    const result = walk.resolveViaCli();
    assert.equal(result.success, true, result.error);
    assert.equal(result.applicable, false);
    assert.equal(result.source, 'none');
  });

  test('row 2 — harness-backend script execution: type: tdd resolves TDD_APPLICABLE=true', (t) => {
    const walk = TddWalk.create();
    t.after(() => walk.cleanup());
    walk.writePlan(TDD_TYPE_PLAN);
    const result = walk.resolveViaBackend('harness');
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.value, 'true');
  });

  test('row 2 — harness-backend script execution: plain plan resolves TDD_APPLICABLE=false', (t) => {
    const walk = TddWalk.create();
    t.after(() => walk.cleanup());
    walk.writePlan(PLAIN_PLAN);
    const result = walk.resolveViaBackend('harness');
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.value, 'false');
  });

  test('row 3 — worktree-backend script execution: type: tdd resolves TDD_APPLICABLE=true', (t) => {
    const walk = TddWalk.create();
    t.after(() => walk.cleanup());
    walk.writePlan(TDD_TYPE_PLAN);
    const result = walk.resolveViaBackend('worktree');
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.value, 'true');
  });

  test('row 3 — worktree-backend script execution: plain plan resolves TDD_APPLICABLE=false', (t) => {
    const walk = TddWalk.create();
    t.after(() => walk.cleanup());
    walk.writePlan(PLAIN_PLAN);
    const result = walk.resolveViaBackend('worktree');
    assert.equal(result.success, true, result.stderr);
    assert.equal(result.value, 'false');
  });

  test('row 4 — cross-backend agreement: same fixture plan, identical resolved value (#4264/#4265)', (t) => {
    const tddWalk = TddWalk.create();
    t.after(() => tddWalk.cleanup());
    tddWalk.writePlan(TDD_TYPE_PLAN);
    const harnessResult = tddWalk.resolveViaBackend('harness');
    const worktreeResult = tddWalk.resolveViaBackend('worktree');
    assert.equal(harnessResult.success, true, harnessResult.stderr);
    assert.equal(worktreeResult.success, true, worktreeResult.stderr);
    assert.equal(harnessResult.value, worktreeResult.value);
    assert.equal(harnessResult.value, 'true');

    const plainWalk = TddWalk.create();
    t.after(() => plainWalk.cleanup());
    plainWalk.writePlan(PLAIN_PLAN);
    const harnessPlain = plainWalk.resolveViaBackend('harness');
    const worktreePlain = plainWalk.resolveViaBackend('worktree');
    assert.equal(harnessPlain.success, true, harnessPlain.stderr);
    assert.equal(worktreePlain.success, true, worktreePlain.stderr);
    assert.equal(harnessPlain.value, worktreePlain.value);
    assert.equal(harnessPlain.value, 'false');
  });

  test('row 5 — fail-closed: missing plan file exits non-zero with the TDD-resolution FATAL on stderr (worktree backend)', (t) => {
    const walk = TddWalk.create();
    t.after(() => walk.cleanup());
    // Deliberately no writePlan() call — {phase_dir}/{plan_file} points at a
    // plan that does not exist on disk.
    const result = walk.resolveViaBackend('worktree');
    assert.equal(result.success, false);
    // #4298 Standards+Spec review: a bare `.includes('FATAL')` would also
    // pass if the file's OTHER fail-closed guard (the unrelated ISOLATION
    // resolution, which shares the same first fenced block and can emit its
    // own differently-worded FATAL) fired instead of the TDD-applicability
    // one — silently proving the wrong guard. Assert the exact TDD-resolution
    // FATAL text (from executor-isolation-dispatch.md's own echo line) so a
    // future edit that changes which guard fires here is caught.
    assert.ok(
      result.stderr.includes("could not resolve TDD-applicability for plan"),
      `expected stderr to contain the TDD-applicability FATAL message, got: ${result.stderr}`,
    );
  });

  test('row 6 — #3800: the tdd.md embed ternary exists and its condition tracks the real predicate value', (t) => {
    const dispatchContent = readFileNormalized(DISPATCH_STEP_PATH);
    assert.ok(
      dispatchContent.includes(TDD_EMBED_TERNARY),
      'executor-isolation-dispatch.md no longer contains the documented TDD_APPLICABLE embed ternary',
    );

    const tddWalk = TddWalk.create();
    t.after(() => tddWalk.cleanup());
    tddWalk.writePlan(TDD_TYPE_PLAN);
    const tddResult = tddWalk.resolveViaBackend('harness');
    assert.equal(tddResult.success, true, tddResult.stderr);
    // The embed ternary fires (includes tdd.md) exactly when TDD_APPLICABLE
    // resolved to the literal string "true".
    assert.equal(tddResult.value, 'true');

    const plainWalk = TddWalk.create();
    t.after(() => plainWalk.cleanup());
    plainWalk.writePlan(PLAIN_PLAN);
    const plainResult = plainWalk.resolveViaBackend('harness');
    assert.equal(plainResult.success, true, plainResult.stderr);
    assert.equal(plainResult.value, 'false');
  });
});

// Non-regression (see 50-test-matrix.md "Non-regression"): this file shares
// no file with tests/tdd-single-statement.test.cjs, tests/tdd-backend-wiring.test.cjs,
// or tests/phase-tdd-applicable.test.cjs — it only reuses tests/helpers.cjs
// and tests/qa/tdd-walk.cjs (new, own to this phase), so those suites' own
// runs are the actual non-regression proof; nothing further to assert here.
