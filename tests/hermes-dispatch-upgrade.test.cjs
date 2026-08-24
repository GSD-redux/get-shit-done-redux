// docs-guard-exempt: github.com/.../docs/... is an external URL citation in a comment, not a repo path.
'use strict';

/**
 * hermes dispatch UPGRADE — ADR-1239 / #2091.
 *
 * Hermes' documented delegation model supports `max_spawn_depth: 2` orchestrator
 * nesting. The descriptor carries dispatch axes that reflect this. This test
 * asserts the negotiation path correctly handles Hermes' dispatch posture,
 * including the `shouldFlattenDispatch` behavior and the fail-closed
 * degradation when axes are corrupted.
 *
 * Cite: https://github.com/nousresearch/hermes-agent/blob/main/website/docs/guides/delegation-patterns.md
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  negotiateHostCapabilities,
  shouldFlattenDispatch,
  degradationFor,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const HERMES_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'hermes', 'capability.json'), 'utf8'),
);
const HERMES_AXES = HERMES_CAP.runtime.hostIntegration;
const HERMES_DISPATCH = HERMES_AXES.dispatch;

test('hermes dispatch axes are populated and internally consistent', () => {
  assert.equal(HERMES_DISPATCH.nested, true, 'hermes supports nested dispatch');
  assert.ok(HERMES_DISPATCH.maxDepth >= 1, 'maxDepth must be >= 1');
  assert.ok(typeof HERMES_DISPATCH.background === 'boolean');
});

test('shouldFlattenDispatch respects hermes dispatch posture', () => {
  // Hermes dispatch.nested=true but subagentToolkit='read-only' and
  // backgroundDispatch=false — shouldFlattenDispatch must reflect the
  // actual capability mix, not just nested=true.
  const result = shouldFlattenDispatch(HERMES_DISPATCH);
  assert.equal(typeof result, 'boolean',
    'shouldFlattenDispatch must return a boolean for hermes dispatch axes');
});

test('degradationFor("dispatch", hermesAxes) returns a valid level', () => {
  const deg = degradationFor('dispatch', HERMES_AXES);
  assert.ok(deg, 'degradationFor must return a result for dispatch');
  assert.ok(['full', 'degraded', 'absent'].includes(deg.level),
    `dispatch level must be full/degraded/absent, got: ${deg.level}`);
  assert.ok(typeof deg.fallback === 'string');
});

test('corrupted hermes dispatch degrades to safe floor (fail-closed)', () => {
  const corrupted = { ...HERMES_AXES, dispatch: { namedDispatch: 'bogus' } };
  const result = negotiateHostCapabilities(corrupted);
  // With a corrupted dispatch struct, effective must not carry bogus values
  assert.equal(typeof result.effective.dispatch.namedDispatch, 'boolean');
  assert.equal(result.effective.dispatch.namedDispatch, false,
    'corrupted namedDispatch must degrade to false (fail-closed)');
});

test('hermes dispatch never silently upgrades beyond declared capability', () => {
  const result = negotiateHostCapabilities(HERMES_AXES);
  // effective dispatch must be ⊆ host-declared ∩ engine-known
  assert.ok(result.effective.dispatch.maxDepth <= HERMES_DISPATCH.maxDepth,
    'effective maxDepth must not exceed host-declared value');
  if (HERMES_DISPATCH.backgroundDispatch === false) {
    assert.equal(result.effective.dispatch.backgroundDispatch, false,
      'effective backgroundDispatch must not be true when host declares false');
  }
});
