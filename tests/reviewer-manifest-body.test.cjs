'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * reviewer-manifest-body.test.cjs — behavioral tests for the reviewer lane body
 * (ADR-2782, chore #2795 Phase 2): `validateReviewerBody`, `collectReviewerWarnings`,
 * the `role:'reviewer'` dispatch branch of `validateCapability`, the reviewer-lane
 * uniqueness rules inside `validateCrossCapability`, and the harvest widening in
 * `buildRegistry` / `loadAndValidate`.
 *
 * Implements every row in `.gsd/phase/chore-2795-reviewer-manifest-body/50-test-matrix.md`
 * that carries a Test name (sections A–J). Test names are copied verbatim from the
 * matrix. See `.gsd/phase/chore-2795-reviewer-manifest-body/40-design.md` for the
 * behavior table the matrix derives from.
 *
 * Level choice: rows describing the SHAPE of the `reviewer` body in isolation
 * (A1–A3, A7–A11, and all of B–F) call `validateReviewerBody` directly — the
 * cheapest unit that proves the behavior, per the matrix's own "Units and level"
 * table. Rows describing ROLE-CONDITIONED admissibility of the body (A4–A6,
 * A12–A15) call `validateCapability(cap, folderId)`, since that dispatch only
 * exists there. Section G calls `validateCrossCapability(Map, Set)` — the real
 * caller shape, never a plain object. Section H splits across `buildRegistry`
 * (the harvest itself) and `validateCrossCapability` (the config-key ownership
 * loop it also widened) per where each behavior actually lives in the source.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');

const {
  validateReviewerBody,
  collectReviewerWarnings,
  validateCapability,
  validateCrossCapability,
  VALID_LANE_EFFORT_CHANNELS,
  VALID_MODEL_DISCOVERY,
  VALID_EMPTY_OUTPUT,
  VALID_EVIDENCE_CLASSES,
  VALID_LANE_HANDLERS,
  KNOWN_REVIEWER_FIELDS,
} = require('../gsd-core/bin/lib/capability-validator.cjs');

const { loadAndValidate, buildRegistry } = require('../scripts/gen-capability-registry.cjs');

// ─── Fixture builders ──────────────────────────────────────────────────────
// House convention (tests/gen-registry.test.cjs): builder functions return a
// VALID fixture, which each test then mutates. Every call returns a FRESH
// object — no module-level mutable shared state, no execution-order dependence.

/** A valid `spawn`-transport reviewer lane body. */
function validLane() {
  return {
    slug: 'my-lane',
    flags: ['--my-lane'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'my-lane' },
    invoke: {
      binary: 'my-lane',
      args: [],
      promptChannel: 'stdin',
      outputChannel: 'stdout',
      modelArg: null,
      effortChannel: 'none',
    },
    timeoutFloorMs: 5000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'My Lane',
    evidenceClass: 'source-grounded',
    requiresBinaries: ['my-lane'],
    promptBudgetKey: null,
    handler: null,
  };
}

/** A valid `openai-http`-transport reviewer lane body. */
function validHttpLane() {
  return {
    slug: 'lm-studio-http',
    flags: ['--lm-studio'],
    transport: 'openai-http',
    probe: {
      kind: 'http-reachable',
      hostConfigKey: 'lmStudio.baseUrl',
      path: '/v1/models',
      timeoutMs: 2000,
    },
    invoke: {
      hostConfigKey: 'lmStudio.baseUrl',
      path: '/v1/chat/completions',
      modelDiscovery: 'none',
      effortChannel: 'none',
    },
    timeoutFloorMs: 5000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'LM Studio',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    handler: null,
  };
}

/** A fresh, well-formed spawn lane, mutated in place by `mutator` before return. */
function laneOverride(mutator) {
  const lane = validLane();
  mutator(lane);
  return lane;
}

/** A fresh, well-formed http lane, mutated in place by `mutator` before return. */
function httpOverride(mutator) {
  const lane = validHttpLane();
  mutator(lane);
  return lane;
}

/**
 * A valid `role:'reviewer'` capability envelope (id/title/description/tier/
 * requires/version all satisfy `validateCapability`'s common envelope) carrying
 * a well-formed lane body. `overrides` is shallow-merged last, so passing
 * `{ reviewer: undefined }` represents "no reviewer key" (property present,
 * value undefined — behaviorally identical to an absent key for every check
 * in this file, and it is what `JSON.stringify` drops when a fixture is
 * written to disk in section I).
 */
function capWith(overrides) {
  return Object.assign(
    {
      id: 'test-cap',
      role: 'reviewer',
      title: 'Test Capability',
      description: 'A test capability for the reviewer manifest body test suite.',
      tier: 'standard',
      requires: [],
      version: '1.0.0',
      reviewer: validLane(),
    },
    overrides || {},
  );
}

// ─── A. Body presence / shape ──────────────────────────────────────────────

describe('A. Body presence / shape', () => {
  test('runtimeCapWithoutReviewerBodyIsValidAndNotALane', () => {
    const errs = validateReviewerBody({ id: 'x', role: 'runtime' });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('featureCapWithoutReviewerBodyIsValid', () => {
    const errs = validateReviewerBody({ id: 'x', role: 'feature' });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('runtimeCapMayCarryReviewerBody', () => {
    const errs = validateReviewerBody({ id: 'x', role: 'runtime', reviewer: validLane() });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('reviewerRoleWithLaneBodyIsValid', () => {
    const cap = capWith();
    const errs = validateCapability(cap, cap.id);
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('reviewerRoleWithoutLaneBodyIsRejected', () => {
    const cap = capWith({ reviewer: undefined });
    const errs = validateCapability(cap, cap.id);
    assert.ok(
      errs.some((e) => e.includes('role:reviewer capability must have a "reviewer" body')),
      `expected the lane-ness assertion error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('featureRoleRejectsReviewerBody', () => {
    const cap = capWith({ role: 'feature', reviewer: validLane() });
    const errs = validateCapability(cap, cap.id);
    assert.ok(
      errs.some((e) => e.includes('role:feature capability must not have a "reviewer" body')),
      `expected the feature-forbids-reviewer-body error, got: ${JSON.stringify(errs)}`,
    );
  });

  // A7/A1 are the highest-consequence pair: `typeof null === 'object'`, so an
  // explicit `null` must NOT be read as "absent" (A1), yet must still error (A7).
  test('reviewerNullIsRejectedNotTreatedAsAbsent', () => {
    const errs = validateReviewerBody({ id: 'x', reviewer: null });
    assert.ok(
      errs.some((e) => e.includes('reviewer must be an object (got: null)')),
      `expected a null-is-not-absent error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('reviewerBooleanIsRejected', () => {
    const errs = validateReviewerBody({ id: 'x', reviewer: true });
    assert.ok(
      errs.some((e) => e.includes('reviewer must be an object (got: boolean)')),
      `expected a must-be-an-object error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('reviewerZeroIsRejected', () => {
    // Falsy-but-present: 0 must not be misread as absent (only `undefined` is).
    const errs = validateReviewerBody({ id: 'x', reviewer: 0 });
    assert.ok(
      errs.some((e) => e.includes('reviewer must be an object (got: number)')),
      `expected a must-be-an-object error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('reviewerStringIsRejected', () => {
    const errs = validateReviewerBody({ id: 'x', reviewer: 'spawn' });
    assert.ok(
      errs.some((e) => e.includes('reviewer must be an object (got: string)')),
      `expected a must-be-an-object error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('reviewerArrayIsRejected', () => {
    const errs = validateReviewerBody({ id: 'x', reviewer: [] });
    assert.ok(
      errs.some((e) => e.includes('reviewer must be an object (got: array)')),
      `expected an array-is-not-a-body error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('emptyReviewerBodyReportsAllMissingFields', () => {
    const errs = validateReviewerBody({ id: 'x', reviewer: {} });
    const requiredFieldMarkers = [
      'reviewer.slug',
      'reviewer.flags',
      'reviewer.transport',
      'reviewer.probe',
      'reviewer.invoke',
      'reviewer.timeoutFloorMs',
      'reviewer.emptyOutput',
      'reviewer.reviewsSection',
      'reviewer.evidenceClass',
      'reviewer.requiresBinaries',
      'reviewer.promptBudgetKey',
      'reviewer.handler',
    ];
    for (const marker of requiredFieldMarkers) {
      assert.ok(
        errs.some((e) => e.includes(marker)),
        `expected an error mentioning ${marker}, got: ${JSON.stringify(errs)}`,
      );
    }
    assert.equal(
      errs.length,
      requiredFieldMarkers.length,
      `expected exactly one error per required field (not just the first), got: ${JSON.stringify(errs)}`,
    );
  });

  test('unknownFieldInsideReviewerBodyWarnsButValidates', () => {
    const lane = validLane();
    lane.futureField = 'from-a-newer-gsd';
    const cap = { id: 'cap-x', reviewer: lane };

    const errs = validateReviewerBody(cap);
    assert.deepEqual(errs, [], `unknown field must not be a validation error, got: ${JSON.stringify(errs)}`);

    const warnings = collectReviewerWarnings(cap);
    assert.ok(
      warnings.some(
        (w) => w.includes('cap-x') && w.includes('reviewer.futureField')
          && w.includes([...KNOWN_REVIEWER_FIELDS].join(', ')),
      ),
      `expected a warning naming reviewer.futureField and the known-fields list, got: ${JSON.stringify(warnings)}`,
    );
  });

  test('unknownRoleIsRejectedWithEnumeratedMembers', () => {
    const cap = capWith({ role: 'wat' });
    const errs = validateCapability(cap, cap.id);
    assert.ok(
      errs.some((e) => e.includes('role must be one of: feature, runtime, reviewer')),
      `expected the role error to enumerate all three members, got: ${JSON.stringify(errs)}`,
    );
  });

  test('reviewerRoleDoesNotRequireRuntimeCompat', () => {
    const cap = capWith();
    assert.equal(cap.runtimeCompat, undefined, 'fixture must not declare runtimeCompat');
    const errs = validateCapability(cap, cap.id);
    assert.deepEqual(errs, [], `expected no errors (runtimeCompat is a runtime-only concern), got: ${JSON.stringify(errs)}`);
  });

  test('reviewerRoleRejectsRuntimeBody', () => {
    const cap = capWith({ runtime: { configFormat: 'toml' } });
    const errs = validateCapability(cap, cap.id);
    assert.ok(
      errs.some((e) => e.includes('role:reviewer capability must not have a "runtime" body')),
      `expected a no-runtime-body error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('reviewerRoleRejectsFeatureOnlyFields', () => {
    const cap = capWith({ skills: ['s'], agents: ['a'], steps: [{ point: 'plan:pre' }] });
    const errs = validateCapability(cap, cap.id);
    for (const field of ['skills', 'agents', 'steps']) {
      assert.ok(
        errs.some((e) => e.includes(`role:reviewer capability must not have "${field}"`)),
        `expected a feature-only-field error for "${field}", got: ${JSON.stringify(errs)}`,
      );
    }
  });
});

// ─── B. transport discriminator (D2) ───────────────────────────────────────

describe('B. transport discriminator (D2)', () => {
  test('transportIsRequiredAndNeverInferred', () => {
    const lane = laneOverride((l) => { delete l.transport; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.transport must be one of: spawn, openai-http')),
      `expected a transport-required error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('spawnTransportAcceptsSpawnInvoke', () => {
    const errs = validateReviewerBody({ id: 'x', reviewer: validLane() });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('httpTransportAcceptsHttpInvoke', () => {
    const errs = validateReviewerBody({ id: 'x', reviewer: validHttpLane() });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('spawnTransportRejectsHttpOnlyInvokeFields', () => {
    const lane = laneOverride((l) => { l.invoke.hostConfigKey = 'x.y'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.hostConfigKey is not permitted for transport "spawn"')),
      `expected a forbidden-field error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('httpTransportRejectsSpawnOnlyInvokeFields', () => {
    const lane = httpOverride((l) => { l.invoke.binary = 'lm-studio'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.binary is not permitted for transport "openai-http"')),
      `expected a forbidden-field error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('invokeWithBothSubShapesIsRejected', () => {
    const lane = laneOverride((l) => { l.invoke.hostConfigKey = 'x.y'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke mixes spawn-only fields') && e.includes('openai-http-only fields')),
      `expected D2's exact both-subshapes error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('invokeWithNeitherSubShapeIsRejected', () => {
    const lane = laneOverride((l) => { l.invoke = {}; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.binary must be a non-empty string for transport "spawn"')),
      `expected the spawn sub-shape to be validated against an empty invoke, got: ${JSON.stringify(errs)}`,
    );
    assert.ok(
      !errs.some((e) => e.includes('mixes spawn-only fields')),
      `neither-subshape must not ALSO report the mixed-subshape error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('unknownTransportEnumeratesValidMembers', () => {
    const lane = laneOverride((l) => { l.transport = 'grpc'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.transport must be one of: spawn, openai-http') && e.includes('"grpc"')),
      `expected an unknown-transport error enumerating valid members, got: ${JSON.stringify(errs)}`,
    );
  });

  test('invokeIsRequired', () => {
    const lane = laneOverride((l) => { delete l.invoke; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke must be an object')),
      `expected an invoke-required error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('invokeNullIsRejected', () => {
    const lane = laneOverride((l) => { l.invoke = null; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke must be an object')),
      `expected an invoke-must-be-object error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('invokeArrayIsRejected', () => {
    const lane = laneOverride((l) => { l.invoke = []; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke must be an object')),
      `expected an invoke-must-be-object error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('reservedNameAsTransportIsRejected', () => {
    const lane = laneOverride((l) => { l.transport = '__proto__'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.transport "__proto__" is a reserved name')),
      `expected a reserved-name error, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── C. spawn invoke fields ─────────────────────────────────────────────────

describe('C. spawn invoke fields', () => {
  test('spawnBinaryIsRequired', () => {
    const lane = laneOverride((l) => { delete l.invoke.binary; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.binary must be a non-empty string for transport "spawn"')),
      `expected a binary-required error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('spawnEmptyBinaryIsRejected', () => {
    const lane = laneOverride((l) => { l.invoke.binary = ''; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.binary must be a non-empty string for transport "spawn"')),
      `expected an empty-binary error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('spawnArgsArrayIsRequired', () => {
    const lane = laneOverride((l) => { delete l.invoke.args; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.args must be an array')),
      `expected an args-required error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('spawnEmptyArgsArrayIsValid', () => {
    const lane = laneOverride((l) => { l.invoke.args = []; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (a lane may take no args), got: ${JSON.stringify(errs)}`);
  });

  test('spawnArgsRejectsNonStringElement', () => {
    const lane = laneOverride((l) => { l.invoke.args = ['-p', 7]; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.args entry 7 must be a string')),
      `expected a non-string-element error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('promptChannelStdinIsValid', () => {
    const lane = laneOverride((l) => { l.invoke.promptChannel = 'stdin'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('promptChannelNoneIsValidPerAmendment', () => {
    const lane = laneOverride((l) => { l.invoke.promptChannel = 'none'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (A1 amendment), got: ${JSON.stringify(errs)}`);
  });

  test('promptChannelArgvFileRefIsValid', () => {
    const lane = laneOverride((l) => { l.invoke.promptChannel = 'argv-file-ref'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  // Zero shipped lanes use promptChannel:'argv' — this row is its only coverage
  // until Phase 5b ships one (40-design.md C6 / Known Limits).
  test('promptChannelArgvIsValidDespiteNoShippedLane', () => {
    const lane = laneOverride((l) => { l.invoke.promptChannel = 'argv'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('outputChannelStdoutIsValid', () => {
    const lane = laneOverride((l) => { l.invoke.outputChannel = 'stdout'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('fileArgOutputWithOutputArgIsValid', () => {
    const lane = laneOverride((l) => {
      l.invoke.outputChannel = 'file-arg';
      l.invoke.outputArg = 'out.txt';
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (A2/A3 amendment), got: ${JSON.stringify(errs)}`);
  });

  test('fileArgOutputWithoutOutputArgIsRejected', () => {
    const lane = laneOverride((l) => { l.invoke.outputChannel = 'file-arg'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.outputArg is required') && e.includes('"file-arg"')),
      `expected a required-iff error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('stdoutOutputWithOutputArgIsRejected', () => {
    const lane = laneOverride((l) => {
      l.invoke.outputChannel = 'stdout';
      l.invoke.outputArg = 'out.txt';
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.outputArg is only permitted when outputChannel is "file-arg"')),
      `expected a forbidden-field error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('modelArgNullMeansNoOverride', () => {
    const lane = laneOverride((l) => { l.invoke.modelArg = null; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('modelArgEmptyStringIsRejected', () => {
    const lane = laneOverride((l) => { l.invoke.modelArg = ''; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.modelArg must be a non-empty string or null')),
      `expected an empty-string-is-not-none error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('effortChannelAcceptsAllThreeMembers', () => {
    for (const effortChannel of VALID_LANE_EFFORT_CHANNELS) {
      const lane = laneOverride((l) => { l.invoke.effortChannel = effortChannel; });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.deepEqual(errs, [], `effortChannel=${effortChannel} expected no errors, got: ${JSON.stringify(errs)}`);
    }
  });
});

// ─── D. openai-http invoke fields ──────────────────────────────────────────

describe('D. openai-http invoke fields', () => {
  test('httpHostConfigKeyIsRequired', () => {
    const lane = httpOverride((l) => { delete l.invoke.hostConfigKey; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.hostConfigKey must be a non-empty dotted config key')),
      `expected a hostConfigKey-required error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('httpEmptyHostConfigKeyIsRejected', () => {
    const lane = httpOverride((l) => { l.invoke.hostConfigKey = ''; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.hostConfigKey must be a non-empty dotted config key')),
      `expected an empty-hostConfigKey error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('httpPathIsRequiredAndNonEmpty', () => {
    for (const badPath of [undefined, '']) {
      const lane = httpOverride((l) => {
        if (badPath === undefined) delete l.invoke.path;
        else l.invoke.path = badPath;
      });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.ok(
        errs.some((e) => e.includes('reviewer.invoke.path must be a non-empty string for transport "openai-http"')),
        `path=${JSON.stringify(badPath)}: expected a path-required error, got: ${JSON.stringify(errs)}`,
      );
    }
  });

  test('modelDiscoveryAcceptsBothMembers', () => {
    for (const modelDiscovery of VALID_MODEL_DISCOVERY) {
      const lane = httpOverride((l) => { l.invoke.modelDiscovery = modelDiscovery; });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.deepEqual(errs, [], `modelDiscovery=${modelDiscovery} expected no errors, got: ${JSON.stringify(errs)}`);
    }
  });

  test('httpTransportRejectsNonNoneEffortChannel', () => {
    const lane = httpOverride((l) => { l.invoke.effortChannel = 'argv'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.invoke.effortChannel must be "none" for transport "openai-http"')),
      `expected an effortChannel-fixed-to-none error, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── E. probe (D7) — bounded-probe control ─────────────────────────────────

describe('E. probe (D7) — bounded-probe control', () => {
  test('probeIsRequiredObject', () => {
    const laneAbsent = laneOverride((l) => { delete l.probe; });
    const errsAbsent = validateReviewerBody({ id: 'x', reviewer: laneAbsent });
    assert.ok(
      errsAbsent.some((e) => e.includes('reviewer.probe must be an object with a "kind" from:')),
      `absent probe: expected a probe-required error, got: ${JSON.stringify(errsAbsent)}`,
    );

    const laneNonObject = laneOverride((l) => { l.probe = 'not-an-object'; });
    const errsNonObject = validateReviewerBody({ id: 'x', reviewer: laneNonObject });
    assert.ok(
      errsNonObject.some((e) => e.includes('reviewer.probe must be an object with a "kind" from:')),
      `non-object probe: expected a probe-required error, got: ${JSON.stringify(errsNonObject)}`,
    );
  });

  test('commandExistsProbeIsValid', () => {
    const lane = laneOverride((l) => { l.probe = { kind: 'command-exists', binary: 'my-lane' }; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  // Zero shipped lanes use probe.kind:'command-capability' — this row is its
  // only coverage until Phase 5b ships one.
  test('commandCapabilityProbeIsValidDespiteNoShippedLane', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'command-capability', binary: 'my-lane', needle: 'v1.2', timeoutMs: 3000 };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('httpReachableProbeIsValid', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'lmStudio.baseUrl', path: '/v1/models', timeoutMs: 2000 };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('commandCapabilityProbeRequiresTimeout', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'command-capability', binary: 'my-lane', needle: 'v1.2' };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs must be a positive integer of milliseconds for kind "command-capability"')),
      `expected a timeout-required error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('httpReachableProbeRequiresTimeout', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'lmStudio.baseUrl', path: '/v1/models' };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs must be a positive integer of milliseconds for kind "http-reachable"')),
      `expected a timeout-required error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('probeTimeoutZeroIsRejected', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'x.y', path: '/z', timeoutMs: 0 };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs must be a positive integer of milliseconds') && e.includes('(got: 0)')),
      `expected a boundary (limit-1) rejection, got: ${JSON.stringify(errs)}`,
    );
  });

  test('probeTimeoutOneIsAccepted', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'x.y', path: '/z', timeoutMs: 1 };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (boundary: limit), got: ${JSON.stringify(errs)}`);
  });

  test('probeNegativeTimeoutIsRejected', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'x.y', path: '/z', timeoutMs: -1 };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs must be a positive integer of milliseconds') && e.includes('(got: -1)')),
      `expected a negative-timeout rejection, got: ${JSON.stringify(errs)}`,
    );
  });

  test('probeFractionalTimeoutIsRejected', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'x.y', path: '/z', timeoutMs: 1.5 };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs must be a positive integer of milliseconds') && e.includes('(got: 1.5)')),
      `expected a fractional-timeout rejection (integer only), got: ${JSON.stringify(errs)}`,
    );
  });

  test('probeNumericStringTimeoutIsRejected', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'x.y', path: '/z', timeoutMs: '900' };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs must be a positive integer of milliseconds') && e.includes('(got: "900")')),
      `expected a numeric-string rejection, got: ${JSON.stringify(errs)}`,
    );
  });

  test('probeNaNTimeoutIsRejected', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'x.y', path: '/z', timeoutMs: NaN };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs must be a positive integer of milliseconds')),
      `expected a NaN rejection, got: ${JSON.stringify(errs)}`,
    );
  });

  test('probeInfiniteTimeoutIsRejected', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'http-reachable', hostConfigKey: 'x.y', path: '/z', timeoutMs: Infinity };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    // Note: JSON.stringify(Infinity) renders as "null" in the message's "(got: …)"
    // suffix — that's a property of JSON.stringify, not of this assertion; the
    // load-bearing check is that Infinity (literally unbounded, the exact defect
    // D7 exists to prevent) is rejected by the same branch as every other
    // non-positive-integer value.
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs must be a positive integer of milliseconds for kind "http-reachable"')),
      `expected an unbounded-timeout rejection, got: ${JSON.stringify(errs)}`,
    );
  });

  test('commandExistsProbeRejectsTimeout', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'command-exists', binary: 'my-lane', timeoutMs: 500 };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.timeoutMs is not permitted for kind "command-exists"')),
      `expected a forbidden-timeout error (no process is started), got: ${JSON.stringify(errs)}`,
    );
  });

  test('unknownProbeKindEnumeratesValidMembers', () => {
    const lane = laneOverride((l) => { l.probe = { kind: 'nope' }; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.kind must be one of: command-exists, command-capability, http-reachable')),
      `expected an unknown-kind error enumerating all three kinds, got: ${JSON.stringify(errs)}`,
    );
  });

  test('commandCapabilityProbeRequiresNeedle', () => {
    const lane = laneOverride((l) => {
      l.probe = { kind: 'command-capability', binary: 'my-lane', timeoutMs: 3000 };
    });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.probe.needle must be a non-empty string for kind "command-capability"')),
      `expected a needle-required error, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── F. Lane scalars ────────────────────────────────────────────────────────

describe('F. Lane scalars', () => {
  test('slugIsRequiredNonEmptyString', () => {
    for (const badSlug of [undefined, '', 42]) {
      const lane = laneOverride((l) => {
        if (badSlug === undefined) delete l.slug;
        else l.slug = badSlug;
      });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.ok(
        errs.some((e) => e.includes('reviewer.slug must be a non-empty string')),
        `slug=${JSON.stringify(badSlug)}: expected a slug-required error, got: ${JSON.stringify(errs)}`,
      );
    }
  });

  test('snakeCaseSlugIsAcceptedUnlikeCapabilityId', () => {
    const lane = laneOverride((l) => { l.slug = 'lm_studio'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (slug is not KEBAB_RE-checked), got: ${JSON.stringify(errs)}`);
  });

  test('slugRejectsUppercase', () => {
    const lane = laneOverride((l) => { l.slug = 'Lm-Studio'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.slug "Lm-Studio" must match')),
      `expected an uppercase-rejection error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('slugRejectsWhitespace', () => {
    const lane = laneOverride((l) => { l.slug = 'lm studio'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.slug "lm studio" must match')),
      `expected a whitespace-rejection error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('slugRejectsFlagSyntax', () => {
    const lane = laneOverride((l) => { l.slug = '--x'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.slug "--x" must match')),
      `expected a flag-syntax-rejection error (a slug is not a flag), got: ${JSON.stringify(errs)}`,
    );
  });

  test('flagsArrayIsRequired', () => {
    for (const badFlags of [undefined, 'not-an-array']) {
      const lane = laneOverride((l) => {
        if (badFlags === undefined) delete l.flags;
        else l.flags = badFlags;
      });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.ok(
        errs.some((e) => e.includes('reviewer.flags must be an array of CLI flags')),
        `flags=${JSON.stringify(badFlags)}: expected a flags-required error, got: ${JSON.stringify(errs)}`,
      );
    }
  });

  test('emptyFlagsArrayIsRejected', () => {
    const lane = laneOverride((l) => { l.flags = []; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.flags must declare at least one flag')),
      `expected an unnameable-lane rejection, got: ${JSON.stringify(errs)}`,
    );
  });

  test('duplicateFlagWithinOneLaneIsRejected', () => {
    const lane = laneOverride((l) => { l.flags = ['--x', '--x']; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.flags lists "--x" more than once')),
      `expected a self-duplicate-flag error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('flagWithoutDoubleDashIsRejected', () => {
    const lane = laneOverride((l) => { l.flags = ['x']; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.flags entry "x" must match')),
      `expected a missing-double-dash error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('multipleFlagsPerLaneAreValidPerAmendment', () => {
    const lane = laneOverride((l) => { l.flags = ['--antigravity', '--agy']; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (A4 amendment), got: ${JSON.stringify(errs)}`);
  });

  test('timeoutFloorIsRequired', () => {
    const lane = laneOverride((l) => { delete l.timeoutFloorMs; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.timeoutFloorMs must be a positive integer of milliseconds')),
      `expected a timeoutFloorMs-required error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('timeoutFloorZeroIsRejected', () => {
    const lane = laneOverride((l) => { l.timeoutFloorMs = 0; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.timeoutFloorMs must be a positive integer of milliseconds') && e.includes('(got: 0)')),
      `expected a boundary (limit-1) rejection, got: ${JSON.stringify(errs)}`,
    );
  });

  test('timeoutFloorOneIsAccepted', () => {
    const lane = laneOverride((l) => { l.timeoutFloorMs = 1; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (boundary: limit), got: ${JSON.stringify(errs)}`);
  });

  test('emptyOutputAcceptsBothMembers', () => {
    for (const emptyOutput of VALID_EMPTY_OUTPUT) {
      const lane = laneOverride((l) => { l.emptyOutput = emptyOutput; });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.deepEqual(errs, [], `emptyOutput=${emptyOutput} expected no errors, got: ${JSON.stringify(errs)}`);
    }
  });

  test('reviewsSectionIsRequiredNonEmpty', () => {
    for (const bad of [undefined, '']) {
      const lane = laneOverride((l) => {
        if (bad === undefined) delete l.reviewsSection;
        else l.reviewsSection = bad;
      });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.ok(
        errs.some((e) => e.includes('reviewer.reviewsSection must be a non-empty string')),
        `reviewsSection=${JSON.stringify(bad)}: expected a reviewsSection-required error, got: ${JSON.stringify(errs)}`,
      );
    }
  });

  test('evidenceClassAcceptsBothMembers', () => {
    for (const evidenceClass of VALID_EVIDENCE_CLASSES) {
      const lane = laneOverride((l) => { l.evidenceClass = evidenceClass; });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.deepEqual(errs, [], `evidenceClass=${evidenceClass} expected no errors, got: ${JSON.stringify(errs)}`);
    }
  });

  test('requiresBinariesArrayIsRequired', () => {
    for (const bad of [undefined, 'not-an-array']) {
      const lane = laneOverride((l) => {
        if (bad === undefined) delete l.requiresBinaries;
        else l.requiresBinaries = bad;
      });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.ok(
        errs.some((e) => e.includes('reviewer.requiresBinaries must be an array')),
        `requiresBinaries=${JSON.stringify(bad)}: expected a required-array error, got: ${JSON.stringify(errs)}`,
      );
    }
  });

  test('emptyRequiresBinariesIsValid', () => {
    const lane = laneOverride((l) => { l.requiresBinaries = []; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (no external tool required), got: ${JSON.stringify(errs)}`);
  });

  test('promptBudgetKeyNullIsValid', () => {
    const lane = laneOverride((l) => { l.promptBudgetKey = null; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('promptBudgetKeyEmptyStringIsRejected', () => {
    const lane = laneOverride((l) => { l.promptBudgetKey = ''; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.promptBudgetKey must be a dotted config key or null') && e.includes('(got: "")')),
      `expected an empty-string-is-not-none error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('handlerNullIsValidDefault', () => {
    const lane = laneOverride((l) => { l.handler = null; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.deepEqual(errs, [], `expected no errors (default), got: ${JSON.stringify(errs)}`);
  });

  test('handlerAcceptsEachFirstPartyMember', () => {
    for (const handler of VALID_LANE_HANDLERS) {
      const lane = laneOverride((l) => { l.handler = handler; });
      const errs = validateReviewerBody({ id: 'x', reviewer: lane });
      assert.deepEqual(errs, [], `handler=${handler} expected no errors, got: ${JSON.stringify(errs)}`);
    }
  });

  test('unknownHandlerIsRejectedAtBuildTime', () => {
    const lane = laneOverride((l) => { l.handler = 'acme'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.handler must be null or one of: antigravity, openai-compatible') && e.includes('"acme"')),
      `expected an unknown-handler error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('pathTraversalHandlerIsRejected', () => {
    const lane = laneOverride((l) => { l.handler = '../evil'; });
    const errs = validateReviewerBody({ id: 'x', reviewer: lane });
    assert.ok(
      errs.some((e) => e.includes('reviewer.handler must be null or one of: antigravity, openai-compatible') && e.includes('"../evil"')),
      `expected a path-shaped-handler rejection, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── G. Uniqueness (D8) — validateCrossCapability(Map, Set) ────────────────

describe('G. Uniqueness (D8) — validateCrossCapability(Map, Set)', () => {
  // Each lane defaults to a slug/flags/reviewsSection derived from its own id,
  // so distinct caps never accidentally collide — a test forces exactly ONE
  // axis to collide via `reviewerOverrides`, isolating what it claims to test.
  function laneCap(id, reviewerOverrides) {
    return {
      id,
      role: 'reviewer',
      reviewer: Object.assign(
        validLane(),
        { slug: `${id}-slug`, flags: [`--${id}`], reviewsSection: `Section for ${id}` },
        reviewerOverrides || {},
      ),
    };
  }

  test('duplicateSlugAcrossCapabilitiesIsRejected', () => {
    const capA = laneCap('cap-a');
    const capB = laneCap('cap-b', { slug: capA.reviewer.slug });
    const errs = validateCrossCapability(new Map([['cap-a', capA], ['cap-b', capB]]), new Set());
    assert.ok(
      errs.some((e) => e.includes(`reviewer slug "${capA.reviewer.slug}" is declared by "cap-a" and "cap-b"`)),
      `expected a slug-collision error naming both ids, got: ${JSON.stringify(errs)}`,
    );
  });

  // Regression guard for a real order-dependence defect in the first cut of the
  // lane-uniqueness check. That version reported a collision when the SECOND
  // claimant arrived, so with three lanes on one key it named whichever pair
  // happened to arrive first: forward order blamed {cap-0,cap-1}+{cap-0,cap-2},
  // reversed blamed {cap-1,cap-2}+{cap-0,cap-2}. Map order is readdir order at
  // build time and candidate order at load time, so a cross-platform CI lane
  // could disagree with a local run about the text of the same failure. The
  // pairwise case (G7) is order-independent either way, which is exactly why it
  // did not catch this. Claims are now accumulated and reported after the sweep:
  // ONE error per colliding key naming EVERY claimant, ids sorted.
  test('threeWayCollisionIsReportedOnceAndOrderIndependently', () => {
    const ids = ['cap-0', 'cap-1', 'cap-2'];
    const caps = ids.map((id) => laneCap(id, { slug: 'shared-slug' }));
    const laneErrs = (entries) => validateCrossCapability(new Map(entries), new Set())
      .filter((e) => e.startsWith('reviewer slug '));

    const forward = laneErrs(ids.map((id, i) => [id, caps[i]]));
    const reversed = laneErrs(ids.map((id, i) => [id, caps[i]]).reverse());

    assert.equal(
      forward.length, 1,
      `a 3-way collision is ONE error naming all three, got: ${JSON.stringify(forward)}`,
    );
    assert.deepEqual(
      forward, reversed,
      `error text must not depend on Map insertion order, got forward=${JSON.stringify(forward)} reversed=${JSON.stringify(reversed)}`,
    );
    for (const id of ids) {
      assert.ok(forward[0].includes(`"${id}"`), `every claimant must be named; ${id} missing from: ${forward[0]}`);
    }
  });

  test('overlappingFlagsAcrossCapabilitiesAreRejected', () => {
    const capA = laneCap('cap-a');
    const capB = laneCap('cap-b', { flags: [...capA.reviewer.flags] });
    const errs = validateCrossCapability(new Map([['cap-a', capA], ['cap-b', capB]]), new Set());
    assert.ok(
      errs.some((e) => e.includes(`reviewer flag "${capA.reviewer.flags[0]}" is declared by "cap-a" and "cap-b"`)),
      `expected a flag-collision error (flattened across arrays), got: ${JSON.stringify(errs)}`,
    );
  });

  test('duplicateReviewsSectionIsRejected', () => {
    const capA = laneCap('cap-a');
    const capB = laneCap('cap-b', { reviewsSection: capA.reviewer.reviewsSection });
    const errs = validateCrossCapability(new Map([['cap-a', capA], ['cap-b', capB]]), new Set());
    assert.ok(
      errs.some((e) => e.includes(`reviewer reviewsSection "${capA.reviewer.reviewsSection}" is declared by "cap-a" and "cap-b"`)),
      `expected a reviewsSection-collision error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('reviewsSectionUniquenessIsCaseSensitiveByDesign', () => {
    const capA = laneCap('cap-a');
    const capB = laneCap('cap-b', { reviewsSection: capA.reviewer.reviewsSection.toUpperCase() });
    const errs = validateCrossCapability(new Map([['cap-a', capA], ['cap-b', capB]]), new Set());
    assert.deepEqual(
      errs, [],
      `case-differing reviewsSection must NOT collide (Rejected #4, Known Limit), got: ${JSON.stringify(errs)}`,
    );
  });

  test('singleLaneHasNoUniquenessError', () => {
    const capA = laneCap('cap-a');
    const errs = validateCrossCapability(new Map([['cap-a', capA]]), new Set());
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('capabilitiesWithoutLanesContributeNoUniquenessErrors', () => {
    const capA = { id: 'cap-a', role: 'runtime' };
    const capB = { id: 'cap-b', role: 'runtime' };
    const errs = validateCrossCapability(new Map([['cap-a', capA], ['cap-b', capB]]), new Set());
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('nonLaneCapabilityIdMayMatchALaneSlug', () => {
    const capA = laneCap('cap-a', { slug: 'shared-name' });
    const capB = { id: 'shared-name', role: 'runtime' };
    const errs = validateCrossCapability(new Map([['cap-a', capA], ['shared-name', capB]]), new Set());
    assert.deepEqual(
      errs, [],
      `a capability id matching a lane slug string is not a collision (instances/ids are not lanes), got: ${JSON.stringify(errs)}`,
    );
  });

  test('uniquenessErrorsAreOrderIndependent', () => {
    const capA = laneCap('cap-a');
    const capB = laneCap('cap-b', { slug: capA.reviewer.slug });
    const forward = new Map([['cap-a', capA], ['cap-b', capB]]);
    const reversed = new Map([['cap-b', capB], ['cap-a', capA]]);
    const errsForward = validateCrossCapability(forward, new Set());
    const errsReversed = validateCrossCapability(reversed, new Set());
    assert.ok(errsForward.length > 0, `expected a real collision to exercise, got: ${JSON.stringify(errsForward)}`);
    assert.deepEqual(
      errsForward, errsReversed,
      `error set must not depend on Map insertion order: forward=${JSON.stringify(errsForward)} reversed=${JSON.stringify(errsReversed)}`,
    );
  });

  test('threeLanesWithOneCollisionReportOnce', () => {
    const capA = laneCap('cap-a');
    const capB = laneCap('cap-b', { slug: capA.reviewer.slug });
    const capC = laneCap('cap-c');
    const errs = validateCrossCapability(
      new Map([['cap-a', capA], ['cap-b', capB], ['cap-c', capC]]),
      new Set(),
    );
    const slugErrors = errs.filter((e) => e.startsWith('reviewer slug'));
    assert.equal(slugErrors.length, 1, `expected exactly one collision error, not two, got: ${JSON.stringify(errs)}`);
    assert.equal(errs.length, 1, `expected no unrelated errors from the non-colliding third lane, got: ${JSON.stringify(errs)}`);
  });
});

// ─── H. Harvest widening — buildRegistry(capMap) ───────────────────────────

describe('H. Harvest widening — buildRegistry(capMap)', () => {
  test('runtimeCapConfigIsHarvestedNotDropped', () => {
    const capMap = new Map([['my-runtime', {
      id: 'my-runtime',
      role: 'runtime',
      config: { 'myRuntime.enabled': { type: 'boolean', default: false, description: 'Enable my runtime feature.' } },
    }]]);
    const registry = buildRegistry(capMap);
    assert.equal(registry.configKeys['myRuntime.enabled'], 'my-runtime');
    assert.deepEqual(registry.configSchema['myRuntime.enabled'], {
      owner: 'my-runtime',
      type: 'boolean',
      default: false,
      description: 'Enable my runtime feature.',
    });
  });

  test('reviewerCapConfigIsHarvested', () => {
    const capMap = new Map([['my-reviewer', {
      id: 'my-reviewer',
      role: 'reviewer',
      config: { 'myReviewer.enabled': { type: 'boolean', default: true, description: 'Enable my reviewer lane.' } },
    }]]);
    const registry = buildRegistry(capMap);
    assert.equal(registry.configKeys['myReviewer.enabled'], 'my-reviewer');
    assert.deepEqual(registry.configSchema['myReviewer.enabled'], {
      owner: 'my-reviewer',
      type: 'boolean',
      default: true,
      description: 'Enable my reviewer lane.',
    });
  });

  test('runtimeCapWithoutConfigIsUnchanged', () => {
    const cap = { id: 'my-runtime', role: 'runtime' };
    const capMap = new Map([['my-runtime', cap]]);
    const registry = buildRegistry(capMap);
    assert.equal(registry.runtimes['my-runtime'], cap);
    // registry.configKeys is Object.create(null) (S2b prototype-pollution guard),
    // so comparing against a plain `{}` literal would fail on prototype alone —
    // compare via Object.keys() instead of asserting shape equality.
    assert.deepEqual(Object.keys(registry.configKeys), []);
  });

  test('reviewerCapIsNotStoredAsRuntime', () => {
    const cap = { id: 'my-reviewer', role: 'reviewer' };
    const capMap = new Map([['my-reviewer', cap]]);
    const registry = buildRegistry(capMap);
    assert.equal(registry.capabilities['my-reviewer'], cap);
    assert.equal(registry.runtimes['my-reviewer'], undefined);
  });

  // Lives in validateCrossCapability's config-key ownership loop, not
  // buildRegistry — that loop is the OTHER half of the harvest widening
  // (40-design.md: "the role filter was `role !== 'feature'`"), so this row
  // and H6 exercise validateCrossCapability directly rather than the harvest.
  test('nonFeatureConfigKeyCollidingWithCentralSchemaIsFlagged', () => {
    const capMap = new Map([['my-runtime', {
      id: 'my-runtime',
      role: 'runtime',
      config: { 'shared.key': { type: 'string', default: 'x', description: 'y' } },
    }]]);
    const errs = validateCrossCapability(capMap, new Set(['shared.key']));
    assert.ok(
      errs.some((e) => e.includes('shared.key') && e.includes('central config-schema')),
      `expected a central-schema collision error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('configKeyOwnedByTwoRolesIsRejected', () => {
    const capMap = new Map([
      ['cap-a', { id: 'cap-a', role: 'runtime', config: { 'dup.key': { type: 'string', default: 'x', description: 'y' } } }],
      ['cap-b', { id: 'cap-b', role: 'reviewer', config: { 'dup.key': { type: 'string', default: 'z', description: 'w' } } }],
    ]);
    const errs = validateCrossCapability(capMap, new Set());
    assert.ok(
      errs.some((e) => e.includes('dup.key') && e.includes('owned by both "cap-a" and "cap-b"')),
      `expected a two-role ownership-collision error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('shippedRegistryOutputIsUnchangedByHarvestWidening', () => {
    const { capMap, errors } = loadAndValidate(new Set());
    assert.deepEqual(errors, [], `expected the real shipped capability set to validate cleanly, got: ${JSON.stringify(errors)}`);

    const registry = buildRegistry(capMap);
    for (const [key, ownerId] of Object.entries(registry.configKeys)) {
      const owner = capMap.get(ownerId);
      assert.ok(owner, `configKeys owner "${ownerId}" for key "${key}" must exist in capMap`);
      assert.equal(
        owner.role,
        'feature',
        `harvest widening must not change the shipped set: config key "${key}" is owned by non-feature ` +
        `capability "${ownerId}" (role: ${owner.role}) — today only feature-role capabilities own config keys`,
      );
    }
  });
});

// ─── I. Integration — loadAndValidate(centralKeys, tmpCapDir) ──────────────

describe('I. Integration — loadAndValidate(centralKeys, tmpCapDir)', () => {
  function withCapDir(foldersToContent, fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-reviewer-body-'));
    try {
      for (const [folder, contentOrCap] of Object.entries(foldersToContent)) {
        const dir = path.join(tmp, folder);
        fs.mkdirSync(dir, { recursive: true });
        const content = typeof contentOrCap === 'string' ? contentOrCap : `${JSON.stringify(contentOrCap, null, 2)}\n`;
        fs.writeFileSync(path.join(dir, 'capability.json'), content, 'utf8');
      }
      return fn(tmp);
    } finally {
      cleanup(tmp);
    }
  }

  test('reviewerCapabilityLoadsFromDisk', () => {
    const cap = capWith({
      id: 'lm-studio',
      reviewer: Object.assign(validLane(), { slug: 'lm-studio', flags: ['--lm-studio'] }),
    });
    withCapDir({ 'lm-studio': cap }, (tmp) => {
      const { capMap, errors } = loadAndValidate(new Set(), tmp);
      assert.deepEqual(errors, [], `expected no errors, got: ${JSON.stringify(errors)}`);
      assert.ok(capMap.has('lm-studio'));
    });
  });

  test('malformedReviewerBodyReportsFolderId', () => {
    const cap = capWith({ id: 'lm-studio', reviewer: {} });
    withCapDir({ 'lm-studio': cap }, (tmp) => {
      const { errors } = loadAndValidate(new Set(), tmp);
      assert.ok(
        errors.some((e) => e.startsWith('lm-studio/capability.json:') && e.includes('reviewer.slug')),
        `expected the folder id to prefix the reported error, got: ${JSON.stringify(errors)}`,
      );
    });
  });

  test('emptyCapabilityFileIsReportedNotCrashed', () => {
    withCapDir({ 'lm-studio': '' }, (tmp) => {
      let errors;
      assert.doesNotThrow(() => { ({ errors } = loadAndValidate(new Set(), tmp)); });
      assert.ok(
        errors.some((e) => e.includes('lm-studio/capability.json') && e.includes('JSON parse error')),
        `expected a JSON-parse error naming the folder, got: ${JSON.stringify(errors)}`,
      );
    });
  });

  test('crlfCapabilityFileParsesIdentically', () => {
    const cap = capWith({
      id: 'lm-studio',
      reviewer: Object.assign(validLane(), { slug: 'lm-studio', flags: ['--lm-studio'] }),
    });
    const lfContent = `${JSON.stringify(cap, null, 2)}\n`;
    const crlfContent = lfContent.replace(/\n/g, '\r\n');
    withCapDir({ 'lm-studio': lfContent }, (tmpLf) => {
      withCapDir({ 'lm-studio': crlfContent }, (tmpCrlf) => {
        const lfResult = loadAndValidate(new Set(), tmpLf);
        const crlfResult = loadAndValidate(new Set(), tmpCrlf);
        assert.deepEqual(lfResult.errors, [], `LF variant should validate cleanly, got: ${JSON.stringify(lfResult.errors)}`);
        assert.deepEqual(crlfResult.errors, [], `CRLF variant should validate cleanly, got: ${JSON.stringify(crlfResult.errors)}`);
        assert.deepEqual(
          crlfResult.capMap.get('lm-studio'),
          lfResult.capMap.get('lm-studio'),
          'a CRLF-authored manifest must parse identically to its LF counterpart',
        );
      });
    });
  });

  test('unreadableCapabilityFileIsReportedNotCrashed', () => {
    const cap = capWith({
      id: 'lm-studio',
      reviewer: Object.assign(validLane(), { slug: 'lm-studio', flags: ['--lm-studio'] }),
    });
    withCapDir({ 'lm-studio': cap }, (tmp) => {
      const capPath = path.join(tmp, 'lm-studio', 'capability.json');
      // House rule: inject a deterministic IO failure by monkeypatching the fs
      // method (save the original, override it to throw, restore in `finally`).
      // NEVER `chmod 0o000` — root bypasses mode bits, so that trick silently
      // passes with zero coverage in root Docker/CI. The override is scoped to
      // the exact capability.json path under test and delegates every other
      // read (e.g. loadAndValidate's own wired-loop-point scan) to the real
      // implementation, so it fails only the read this test cares about.
      const originalReadFileSync = fs.readFileSync;
      let result;
      try {
        fs.readFileSync = (p, ...rest) => {
          if (p === capPath) {
            throw new Error('injected unreadable-file failure (simulated EACCES)');
          }
          return originalReadFileSync.call(fs, p, ...rest);
        };
        assert.doesNotThrow(() => { result = loadAndValidate(new Set(), tmp); });
      } finally {
        fs.readFileSync = originalReadFileSync;
      }
      assert.ok(
        result.errors.some((e) => e.includes('lm-studio') && e.includes('injected unreadable-file failure')),
        `expected the unreadable file to be reported, not crashed, got: ${JSON.stringify(result.errors)}`,
      );
    });
  });

  test('snakeCaseIdIsRejectedEvenWhenSlugIsSnakeCase', () => {
    // The Phase 5a trap: folder is kebab ("lm-studio") and reviewer.slug is
    // snake ("lm_studio", accepted per F2) — but `id` itself must ALSO be kebab.
    const badCap = capWith({
      id: 'lm_studio',
      reviewer: Object.assign(validLane(), { slug: 'lm_studio', flags: ['--lm-studio'] }),
    });
    withCapDir({ 'lm-studio': badCap }, (tmp) => {
      const { errors } = loadAndValidate(new Set(), tmp);
      assert.ok(
        errors.some((e) => e.includes('lm-studio/capability.json') && e.includes('kebab-case')),
        `expected a snake_case id to be rejected, got: ${JSON.stringify(errors)}`,
      );
    });

    const goodCap = capWith({
      id: 'lm-studio',
      reviewer: Object.assign(validLane(), { slug: 'lm_studio', flags: ['--lm-studio'] }),
    });
    withCapDir({ 'lm-studio': goodCap }, (tmp) => {
      const { capMap, errors } = loadAndValidate(new Set(), tmp);
      assert.deepEqual(
        errors, [],
        `a kebab id with a snake_case reviewer.slug must be accepted, got: ${JSON.stringify(errors)}`,
      );
      assert.ok(capMap.has('lm-studio'));
    });
  });
});

// ─── J. Property-based (fast-check) ────────────────────────────────────────

describe('J. Property-based (fast-check)', () => {
  test('validateReviewerBodyNeverThrowsOnArbitraryInput', () => {
    fc.assert(
      fc.property(fc.anything(), (reviewerValue) => {
        const cap = { id: 'prop-test', reviewer: reviewerValue };
        const result = validateReviewerBody(cap);
        assert.ok(Array.isArray(result), 'validateReviewerBody must always return an array');
        assert.ok(result.every((e) => typeof e === 'string'), 'every entry must be a string');
        return true;
      }),
      { numRuns: 500 },
    );
  });

  test('uniquenessIsInvariantUnderMapOrder', () => {
    // Groups of ARBITRARY size (1..4 capabilities sharing one slug), so N-way
    // collisions are exercised, not just pairwise ones. An earlier cut of the
    // uniqueness check reported a collision the moment a second claimant arrived,
    // which named a different pair depending on insertion order once three lanes
    // shared a key; claims are now accumulated and reported after the sweep, so
    // the guarantee holds for any N. Errors are compared UNSORTED and filtered to
    // the lane errors, so this asserts deterministic emission ORDER too — sorting
    // both sides first would hide exactly the defect this guards.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 0, maxLength: 8 }),
        (groupSizes, shuffleSeed) => {
          const entries = [];
          groupSizes.forEach((size, groupIdx) => {
            for (let member = 0; member < size; member += 1) {
              const id = `cap-${groupIdx}-${member}`;
              entries.push([id, {
                id,
                role: 'reviewer',
                // Every member of a group shares one slug; flags and sections stay
                // distinct so the slug is the only colliding dimension.
                reviewer: Object.assign(validLane(), {
                  slug: `group-slug-${groupIdx}`,
                  flags: [`--${id}`],
                  reviewsSection: `Section ${id}`,
                }),
              }]);
            }
          });

          const laneErrors = (ordered) => validateCrossCapability(new Map(ordered), new Set())
            .filter((e) => e.startsWith('reviewer '));

          // A deterministic permutation derived from the generated seed, so the
          // property covers arbitrary orderings rather than only forward/reverse.
          const shuffled = [...entries];
          shuffleSeed.forEach((n, i) => {
            const j = n % shuffled.length;
            const k = (i + n) % shuffled.length;
            [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
          });

          const forward = laneErrors(entries);
          const reversed = laneErrors([...entries].reverse());
          const permuted = laneErrors(shuffled);

          assert.deepEqual(reversed, forward, 'lane errors must not depend on Map insertion order (reversed)');
          assert.deepEqual(permuted, forward, 'lane errors must not depend on Map insertion order (permuted)');

          // One error per colliding group, naming every claimant.
          const expectedCollisions = groupSizes.filter((s) => s > 1).length;
          assert.equal(
            forward.length, expectedCollisions,
            `expected one error per colliding group, got: ${JSON.stringify(forward)}`,
          );
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  test('absentReviewerBodyNeverContributesErrors', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.anything()),
        (dict) => {
          delete dict.reviewer; // guarantee absence regardless of low-probability random key collision
          const capUndefinedKey = { ...dict, reviewer: undefined };
          const capDeletedKey = { ...dict };
          const errsUndefinedKey = validateReviewerBody(capUndefinedKey);
          const errsDeletedKey = validateReviewerBody(capDeletedKey);
          assert.deepEqual(errsUndefinedKey, errsDeletedKey, 'an explicit undefined must behave identically to an absent key');
          assert.deepEqual(errsUndefinedKey, [], 'D4.1 — absence must never be an error');
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
