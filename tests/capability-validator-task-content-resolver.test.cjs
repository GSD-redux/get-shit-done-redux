// docs-guard-exempt: no docs/ file reads in this test.
'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * capability-validator-task-content-resolver.test.cjs — behavioral tests for
 * the OPTIONAL `taskContentResolver` body on `role: "feature"` capability
 * manifests (ADR-3646, #3970).
 *
 * Implements test-matrix rows 20–24 of
 * `.gsd/phase/feat-3970-task-content-resolution-seam/50-test-matrix.md`.
 * See `docs/adr/3646-per-task-content-resolution-seam.md` Decision 3 for the
 * shape this validates.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCapability,
  validateTaskContentResolver,
  validateCrossCapability,
} = require('../gsd-core/bin/lib/capability-validator.cjs');

// ─── Fixture builders ──────────────────────────────────────────────────────
// House convention (tests/capability-manifest-version.test.cjs): builder
// functions return a VALID fixture, which each test then mutates. Every call
// returns a FRESH object — no shared mutable state, no execution-order
// dependence.

function validResolver() {
  return {
    trackerPrefix: 'beads',
    invoke: {
      binary: 'bd',
      args: ['show', '{{id}}', '--json'],
      timeoutMs: 10000,
    },
  };
}

function featureCap(overrides) {
  return {
    id: 'demo',
    role: 'feature',
    version: '1.2.3',
    title: 'Demo',
    description: 'A demo capability.',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.6.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
    ...overrides,
  };
}

function runtimeCap(overrides) {
  return {
    id: 'demo-rt',
    role: 'runtime',
    version: '1.2.3',
    title: 'Demo RT',
    description: 'A demo runtime.',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.6.0' },
    runtime: {
      configHome: { kind: 'dot-home', name: '.demo', env: [] },
      localConfigDir: '.demo',
      configFormat: 'settings-json',
      artifactLayout: { global: [], local: [] },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'settings-json',
      sandboxTier: 'none',
      supportTier: 2,
      installSurface: 'settings-json',
      writesSharedSettings: false,
      permissionWriter: null,
      extendedHookEvents: [],
      hostIntegration: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: false },
        modelMode: 'passive',
        hookBus: 'host',
        stateIO: 'filesystem',
        effortSurface: 'none',
        isolation: 'process',
      },
    },
    ...overrides,
  };
}

function reviewerCap(overrides) {
  return {
    id: 'demo-reviewer',
    role: 'reviewer',
    version: '1.2.3',
    title: 'Demo Reviewer',
    description: 'A demo reviewer lane.',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.6.0' },
    reviewer: {
      slug: 'demo-reviewer',
      flags: ['--demo-reviewer'],
      transport: 'spawn',
      probe: { kind: 'command-exists', binary: 'demo-reviewer' },
      invoke: {
        binary: 'demo-reviewer',
        args: [],
        promptChannel: 'stdin',
        outputChannel: 'stdout',
        modelArg: null,
        effortChannel: 'none',
      },
      timeoutFloorMs: 5000,
      emptyOutput: 'stub-with-stderr',
      reviewsSection: 'Demo Reviewer',
      evidenceClass: 'source-grounded',
      requiresBinaries: [],
      promptBudgetKey: null,
      handler: null,
    },
    ...overrides,
  };
}

// ─── Row 20: valid taskContentResolver on a feature manifest ───────────────

describe('row 20 — valid taskContentResolver body', () => {
  test('valid taskContentResolver body passes', () => {
    const cap = featureCap({ taskContentResolver: validResolver() });
    const errs = validateCapability(cap, cap.id);
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });

  test('omitting taskContentResolver entirely on an otherwise-valid feature manifest yields zero errors', () => {
    const cap = featureCap();
    const errs = validateCapability(cap, cap.id);
    assert.deepEqual(errs, [], `expected no errors, got: ${JSON.stringify(errs)}`);
  });
});

// ─── Row 21: feature-only field ────────────────────────────────────────────

describe('row 21 — taskContentResolver on non-feature role is rejected', () => {
  test('role:runtime declaring taskContentResolver is rejected', () => {
    const cap = runtimeCap({ taskContentResolver: validResolver() });
    const errs = validateCapability(cap, cap.id);
    assert.ok(
      errs.some((e) => e.includes('taskContentResolver') && e.includes('feature-only')),
      `expected a feature-only rejection, got: ${JSON.stringify(errs)}`,
    );
  });

  test('role:reviewer declaring taskContentResolver is rejected', () => {
    const cap = reviewerCap({ taskContentResolver: validResolver() });
    const errs = validateCapability(cap, cap.id);
    assert.ok(
      errs.some((e) => e.includes('taskContentResolver') && e.includes('feature-only')),
      `expected a feature-only rejection, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── Row 22: malformed trackerPrefix grammar ───────────────────────────────

describe('row 22 — malformed trackerPrefix is rejected', () => {
  test('capital-cased trackerPrefix violates KEBAB_RE', () => {
    const cap = featureCap({
      taskContentResolver: { ...validResolver(), trackerPrefix: 'Beads' },
    });
    const errs = validateTaskContentResolver(cap);
    assert.ok(
      errs.some((e) => e.includes('trackerPrefix') && e.includes('kebab-case')),
      `expected a grammar error naming trackerPrefix, got: ${JSON.stringify(errs)}`,
    );
  });

  test('empty-string trackerPrefix is rejected', () => {
    const cap = featureCap({
      taskContentResolver: { ...validResolver(), trackerPrefix: '' },
    });
    const errs = validateTaskContentResolver(cap);
    assert.ok(
      errs.some((e) => e.includes('trackerPrefix')),
      `expected a trackerPrefix error, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── Row 23: invoke.timeoutMs boundary ─────────────────────────────────────

describe('row 23 — invoke.timeoutMs must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, undefined]) {
    test(`timeoutMs ${JSON.stringify(bad)} is rejected`, () => {
      const resolver = validResolver();
      resolver.invoke = { ...resolver.invoke, timeoutMs: bad };
      const cap = featureCap({ taskContentResolver: resolver });
      const errs = validateTaskContentResolver(cap);
      assert.ok(
        errs.some((e) => e.includes('timeoutMs')),
        `expected a timeoutMs error for ${JSON.stringify(bad)}, got: ${JSON.stringify(errs)}`,
      );
    });
  }

  test('a legitimate positive integer timeoutMs (10000) is accepted', () => {
    const cap = featureCap({ taskContentResolver: validResolver() });
    const errs = validateTaskContentResolver(cap);
    assert.ok(
      !errs.some((e) => e.includes('timeoutMs')),
      `expected no timeoutMs error, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── invoke.timeoutMs upper ceiling (security review finding, #3970) ───────
// A manifest declaring an unbounded-in-practice timeoutMs (e.g.
// Number.MAX_SAFE_INTEGER) would let resolve-content hang near-indefinitely
// on a stuck/malicious resolver, defeating the "bounded subprocess" design
// intent. Boundary-inclusive per CLAUDE.md's limit-1/limit/limit+1 rule.

describe('invoke.timeoutMs upper ceiling (120000ms)', () => {
  test('timeoutMs 120000 (exactly at the ceiling) is accepted', () => {
    const resolver = validResolver();
    resolver.invoke = { ...resolver.invoke, timeoutMs: 120000 };
    const cap = featureCap({ taskContentResolver: resolver });
    const errs = validateTaskContentResolver(cap);
    assert.ok(
      !errs.some((e) => e.includes('timeoutMs')),
      `expected no timeoutMs error at the boundary, got: ${JSON.stringify(errs)}`,
    );
  });

  test('timeoutMs 120001 (one past the ceiling) is rejected', () => {
    const resolver = validResolver();
    resolver.invoke = { ...resolver.invoke, timeoutMs: 120001 };
    const cap = featureCap({ taskContentResolver: resolver });
    const errs = validateTaskContentResolver(cap);
    assert.ok(
      errs.some((e) => e.includes('timeoutMs') && e.includes('120000')),
      `expected a ceiling timeoutMs error, got: ${JSON.stringify(errs)}`,
    );
  });

  test('an unbounded-in-practice timeoutMs (Number.MAX_SAFE_INTEGER) is rejected', () => {
    const resolver = validResolver();
    resolver.invoke = { ...resolver.invoke, timeoutMs: Number.MAX_SAFE_INTEGER };
    const cap = featureCap({ taskContentResolver: resolver });
    const errs = validateTaskContentResolver(cap);
    assert.ok(
      errs.some((e) => e.includes('timeoutMs')),
      `expected a timeoutMs error, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── invoke.args must carry the {{id}} placeholder ─────────────────────────

describe('invoke.args without {{id}} placeholder', () => {
  test('args missing the {{id}} placeholder is rejected', () => {
    const resolver = validResolver();
    resolver.invoke = { ...resolver.invoke, args: ['show', 'GSD-42', '--json'] };
    const cap = featureCap({ taskContentResolver: resolver });
    const errs = validateTaskContentResolver(cap);
    assert.ok(
      errs.some((e) => e.includes('{{id}}')),
      `expected a placeholder error, got: ${JSON.stringify(errs)}`,
    );
  });
});

// ─── Row 24: cross-capability trackerPrefix uniqueness ─────────────────────

describe('row 24 — duplicate trackerPrefix across capabilities fails cross-capability validation', () => {
  test('two manifests declaring the same trackerPrefix collide', () => {
    const capA = featureCap({ id: 'resolver-a', taskContentResolver: validResolver() });
    const capB = featureCap({ id: 'resolver-b', taskContentResolver: validResolver() });
    const capMap = new Map([
      [capA.id, capA],
      [capB.id, capB],
    ]);
    const errs = validateCrossCapability(capMap, new Set());
    assert.ok(
      errs.some((e) => e.includes('trackerPrefix') && e.includes('resolver-a') && e.includes('resolver-b')),
      `expected a collision error naming both ids, got: ${JSON.stringify(errs)}`,
    );
  });

  test('two manifests declaring different trackerPrefix values do not collide', () => {
    const capA = featureCap({ id: 'resolver-a', taskContentResolver: validResolver() });
    const capB = featureCap({
      id: 'resolver-b',
      taskContentResolver: { ...validResolver(), trackerPrefix: 'linear' },
    });
    const capMap = new Map([
      [capA.id, capA],
      [capB.id, capB],
    ]);
    const errs = validateCrossCapability(capMap, new Set());
    assert.ok(
      !errs.some((e) => e.includes('trackerPrefix')),
      `expected no trackerPrefix collision, got: ${JSON.stringify(errs)}`,
    );
  });
});
