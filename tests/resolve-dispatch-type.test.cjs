process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDispatchType } = require('../gsd-core/bin/lib/host-integration.cjs');

describe('resolveDispatchType (pure function, #2508 Phase 4 Option A)', () => {
  describe('named-dispatch runtimes (namedDispatch: true)', () => {
    test('returns the requested gsd-* name unchanged', () => {
      assert.equal(resolveDispatchType('gsd-planner', { namedDispatch: true }), 'gsd-planner');
      assert.equal(resolveDispatchType('gsd-executor', { namedDispatch: true }), 'gsd-executor');
      assert.equal(resolveDispatchType('gsd-debugger', { namedDispatch: true }), 'gsd-debugger');
    });

    test('returns generic names unchanged', () => {
      assert.equal(resolveDispatchType('general-purpose', { namedDispatch: true }), 'general-purpose');
    });
  });

  describe('built-in-only runtimes (namedDispatch: false, e.g. kimi-code)', () => {
    test('maps -planner / -roadmapper / -selector / -spec suffixes to plan', () => {
      assert.equal(resolveDispatchType('gsd-planner', { namedDispatch: false }), 'plan');
      assert.equal(resolveDispatchType('gsd-roadmapper', { namedDispatch: false }), 'plan');
      assert.equal(resolveDispatchType('gsd-framework-selector', { namedDispatch: false }), 'plan');
    });

    test('maps read-only investigation suffixes to explore', () => {
      assert.equal(resolveDispatchType('gsd-researcher', { namedDispatch: false }), 'explore');
      assert.equal(resolveDispatchType('gsd-codebase-mapper', { namedDispatch: false }), 'explore');
      assert.equal(resolveDispatchType('gsd-plan-checker', { namedDispatch: false }), 'explore');
      assert.equal(resolveDispatchType('gsd-verifier', { namedDispatch: false }), 'explore');
      assert.equal(resolveDispatchType('gsd-security-auditor', { namedDispatch: false }), 'explore');
      assert.equal(resolveDispatchType('gsd-code-reviewer', { namedDispatch: false }), 'explore');
    });

    test('maps writer/fixer/executor/debugger suffixes to coder (default)', () => {
      assert.equal(resolveDispatchType('gsd-executor', { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType('gsd-code-fixer', { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType('gsd-doc-writer', { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType('gsd-debugger', { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType('gsd-debug-session-manager', { namedDispatch: false }), 'coder');
    });

    test('maps generic names to coder', () => {
      assert.equal(resolveDispatchType('general-purpose', { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType('general', { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType('sonnet', { namedDispatch: false }), 'coder');
    });
  });

  describe('fail-closed / edge cases', () => {
    test('null/undefined dispatch degrades to named-dispatch (returns requested as-is)', () => {
      // Per the comment in host-integration.cts: unknown dispatch shape ⇒
      // return the requested name unchanged (named-dispatch is the GSD default).
      assert.equal(resolveDispatchType('gsd-planner', null), 'gsd-planner');
      assert.equal(resolveDispatchType('gsd-planner', undefined), 'gsd-planner');
      assert.equal(resolveDispatchType('gsd-planner', {}), 'gsd-planner');
    });

    test('empty / non-string requested defaults to coder', () => {
      assert.equal(resolveDispatchType('', { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType(undefined, { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType(null, { namedDispatch: false }), 'coder');
      assert.equal(resolveDispatchType(42, { namedDispatch: false }), 'coder');
    });

    test('dispatch object without namedDispatch key degrades to named-dispatch', () => {
      // A dispatch with other axes but no namedDispatch is treated as
      // named-dispatch-capable (the safe default — preserves field behavior).
      assert.equal(
        resolveDispatchType('gsd-planner', { nested: true, maxDepth: 5 }),
        'gsd-planner',
      );
    });
  });
});
