'use strict';

/**
 * Parity test: `capability-validator.cjs`'s install-time `KEBAB_RE` grammar
 * check on `taskContentResolver.trackerPrefix` (`validateTaskContentResolver`)
 * MUST agree with `task-content-resolution.cts`'s resolve-time re-validation
 * inside `parseResolverDeclaration` (exercised here via `findResolver`) on
 * every `trackerPrefix` value.
 *
 * This is the "Generative Fix Divergence" guard CLAUDE.md requires whenever
 * two surfaces share a rule with no single source of truth: the grammar is
 * duplicated as a literal regex in both files (see `task-content-
 * resolution.cts`'s `TRACKER_PREFIX_RE` docstring for why it is not a shared
 * import), so this test is what actually keeps them from drifting apart. If a
 * future change to either regex loosens or tightens it without mirroring the
 * change in the other file, this test fails.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateTaskContentResolver } = require('../gsd-core/bin/lib/capability-validator.cjs');
const { findResolver } = require('../gsd-core/bin/lib/task-content-resolution.cjs');

function validInvoke() {
  return { binary: 'bd', args: ['show', '{{id}}', '--json'], timeoutMs: 10000 };
}

function featureCapWithResolver(trackerPrefix) {
  return {
    id: 'demo',
    role: 'feature',
    taskContentResolver: { trackerPrefix, invoke: validInvoke() },
  };
}

/** True when the validator accepts this trackerPrefix (no trackerPrefix-naming error). */
function validatorAccepts(trackerPrefix) {
  const cap = featureCapWithResolver(trackerPrefix);
  const errs = validateTaskContentResolver(cap);
  return !errs.some((e) => e.includes('trackerPrefix'));
}

/** True when the resolve-time seam accepts this trackerPrefix (finds a match, not `null`). */
function resolverAccepts(trackerPrefix) {
  const capabilities = [featureCapWithResolver(trackerPrefix)];
  const result = findResolver(trackerPrefix, capabilities);
  return result !== null && result !== 'ambiguous';
}

const TABLE = [
  { trackerPrefix: 'beads', valid: true },
  { trackerPrefix: 'my-tracker', valid: true },
  { trackerPrefix: 'Beads', valid: false },
  { trackerPrefix: 'has_underscore', valid: false },
  { trackerPrefix: 'UPPER', valid: false },
  { trackerPrefix: '', valid: false },
  { trackerPrefix: '1leading-digit', valid: false },
];

describe('trackerPrefix grammar parity — capability-validator.cjs vs task-content-resolution.cts', () => {
  for (const { trackerPrefix, valid } of TABLE) {
    test(`'${trackerPrefix}' — validator and resolver agree (expected valid: ${valid})`, () => {
      const validatorResult = validatorAccepts(trackerPrefix);
      const resolverResult = resolverAccepts(trackerPrefix);
      assert.strictEqual(
        validatorResult,
        valid,
        `validator disagreed with expected table value for '${trackerPrefix}'`,
      );
      assert.strictEqual(
        resolverResult,
        valid,
        `resolver disagreed with expected table value for '${trackerPrefix}'`,
      );
      assert.strictEqual(
        validatorResult,
        resolverResult,
        `PARITY BREAK: validator and resolver disagree for trackerPrefix '${trackerPrefix}' ` +
          `(validator: ${validatorResult}, resolver: ${resolverResult})`,
      );
    });
  }
});
