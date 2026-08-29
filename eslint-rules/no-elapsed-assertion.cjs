'use strict';

/**
 * no-elapsed-assertion
 *
 * Flag assert*() calls whose argument reads a property/identifier whose
 * name is (or is a camelCase-suffixed/prefixed variant of) a timing word
 * — elapsed, duration, took, ms — or compares such an identifier.
 * Timing assertions are flaky and should not be in the test suite.
 *
 * Matches: elapsed, duration, took, ms, elapsedMs, tookMs, durationMs,
 * msElapsed, elapsedTime, startMs, endMs.
 * Does NOT match: params, items, forms, terms, dirnames (no capitalized
 * "Ms"/"Elapsed"/"Duration"/"Took" boundary present), nor configured-bound
 * identifiers like timeoutMs/cacheTtlMs/staleAfterMs (a deterministic
 * config value, not a measured wall-clock elapsed value).
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow timing assertions (elapsed, duration, took, ms) in assert calls',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      noElapsedAssertion:
        'Timing assertion detected: assert*() on a timing property (elapsed/duration/took/ms). Timing assertions are flaky — assert on observable behavior instead.',
    },
  },
  create(context) {
    // Bare timing word, optionally followed by a camelCase suffix:
    // elapsed, ms, elapsedMs, msElapsed, elapsedTime, tookMs, durationMs.
    const TIMING_PROPS = /^(?:elapsed|duration|took|ms)(?:[A-Z]\w*)?$/;
    // The specific start/end-of-interval delta pair, in millisecond form:
    // startMs, endMs. Deliberately NOT a blanket "*Ms" suffix — identifiers
    // like timeoutMs, cacheTtlMs, staleAfterMs name a configured bound
    // (deterministic, safe to assert equal), not a measured wall-clock
    // elapsed value, and must not be caught here.
    const TIMING_DELTA_SUFFIX = /^(?:start|end)Ms$/;

    function isTimingName(name) {
      return TIMING_PROPS.test(name) || TIMING_DELTA_SUFFIX.test(name);
    }

    function containsTimingRef(node) {
      if (!node) return false;

      // foo.elapsed, foo.duration, foo.took, foo.ms, foo.elapsedMs, foo.startMs
      if (
        node.type === 'MemberExpression' &&
        node.property.type === 'Identifier' &&
        isTimingName(node.property.name)
      ) {
        return true;
      }

      // Identifier directly: elapsed, duration, took, ms, elapsedMs, startMs
      if (node.type === 'Identifier' && isTimingName(node.name)) {
        return true;
      }

      // Binary expression: elapsed > 100, duration <= 500, etc.
      if (node.type === 'BinaryExpression') {
        return containsTimingRef(node.left) || containsTimingRef(node.right);
      }

      // Logical expression: elapsed && elapsed > 0
      if (node.type === 'LogicalExpression') {
        return containsTimingRef(node.left) || containsTimingRef(node.right);
      }

      // UnaryExpression: !elapsed
      if (node.type === 'UnaryExpression') {
        return containsTimingRef(node.argument);
      }

      return false;
    }

    function isAssertCall(node) {
      if (node.callee.type === 'Identifier') {
        return /^assert/.test(node.callee.name);
      }
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'assert'
      ) {
        return true;
      }
      // assert.strict.* or assert/strict
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'MemberExpression' &&
        node.callee.object.object.type === 'Identifier' &&
        node.callee.object.object.name === 'assert'
      ) {
        return true;
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isAssertCall(node)) return;

        // Check all arguments for timing refs
        for (const arg of node.arguments) {
          if (containsTimingRef(arg)) {
            context.report({ node, messageId: 'noElapsedAssertion' });
            return;
          }
        }
      },
    };
  },
};

module.exports = rule;
