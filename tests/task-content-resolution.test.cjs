'use strict';

// Task Content Resolution Module tests (ADR-3646 Phase 1, #3970).
// Covers test matrix rows 5-16 (.gsd/phase/feat-3970-task-content-resolution-seam/50-test-matrix.md).
// Every subprocess call is a fake execFn — never a real spawn, never a real
// timeout wait (CLAUDE.md's clock-seam rule).

const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const m = require('../gsd-core/bin/lib/task-content-resolution.cjs');
const {
  TASK_CONTENT_RESULT,
  splitTrackerId,
  findResolver,
  buildInvocation,
  resolveTaskContent,
  ResolverAmbiguousError,
  ResolverFailedError,
  ResolverTimeoutError,
  ResolverMalformedOutputError,
} = m;

function beadsCapability(overrides = {}) {
  return {
    id: 'beads-capability',
    taskContentResolver: {
      trackerPrefix: 'beads',
      invoke: {
        binary: 'bd',
        args: ['show', '{{id}}', '--json'],
        timeoutMs: 10000,
      },
      ...overrides,
    },
  };
}

function timeoutError() {
  const e = new Error('spawnSync bd ETIMEDOUT');
  e.code = 'ETIMEDOUT';
  return e;
}

// ─── splitTrackerId — pure ─────────────────────────────────────────────────────

test('splitTrackerId returns null for null and empty input', () => {
  assert.strictEqual(splitTrackerId(null), null);
  assert.strictEqual(splitTrackerId(''), null);
});

test('splitTrackerId splits on the first colon', () => {
  assert.deepStrictEqual(splitTrackerId('beads:GSD-42'), { prefix: 'beads', id: 'GSD-42' });
});

test('splitTrackerId with no colon returns null (row 16 boundary partner)', () => {
  assert.strictEqual(splitTrackerId('noprefix'), null);
});

test('id containing colons splits on first colon only (row 16)', () => {
  assert.deepStrictEqual(
    splitTrackerId('beads:issue:GSD-1'),
    { prefix: 'beads', id: 'issue:GSD-1' },
  );
});

// ─── buildInvocation — pure ─────────────────────────────────────────────────────

test('buildInvocation replaces every {{id}} entry with the literal id', () => {
  const resolver = { invoke: { binary: 'bd', args: ['show', '{{id}}', '--json'], timeoutMs: 10000 } };
  assert.deepStrictEqual(buildInvocation(resolver, 'GSD-42'), {
    binary: 'bd',
    args: ['show', 'GSD-42', '--json'],
    timeoutMs: 10000,
  });
});

test('buildInvocation does not touch args that merely contain {{id}} as a substring', () => {
  const resolver = { invoke: { binary: 'bd', args: ['prefix-{{id}}-suffix'], timeoutMs: 1000 } };
  assert.deepStrictEqual(buildInvocation(resolver, 'X').args, ['prefix-{{id}}-suffix']);
});

// ─── findResolver — pure ─────────────────────────────────────────────────────

test('findResolver returns null when zero capabilities match the prefix', () => {
  assert.strictEqual(findResolver('beads', []), null);
  assert.strictEqual(findResolver('beads', [{ id: 'other', taskContentResolver: undefined }]), null);
});

test('findResolver returns the single well-formed match', () => {
  const cap = beadsCapability();
  const result = findResolver('beads', [cap]);
  assert.strictEqual(result.capabilityId, 'beads-capability');
  assert.strictEqual(result.trackerPrefix, 'beads');
});

test('findResolver returns "ambiguous" for two matching capabilities (row 7)', () => {
  const capA = beadsCapability();
  const capB = { ...beadsCapability(), id: 'other-capability' };
  assert.strictEqual(findResolver('beads', [capA, capB]), 'ambiguous');
});

test('findResolver ignores a declaration missing the {{id}} placeholder (row 15)', () => {
  const bad = {
    id: 'bad-capability',
    taskContentResolver: { trackerPrefix: 'beads', invoke: { binary: 'bd', args: ['show'], timeoutMs: 1000 } },
  };
  assert.strictEqual(findResolver('beads', [bad]), null);
});

test('findResolver ignores garbage taskContentResolver shapes without throwing', () => {
  const garbage = [
    { id: 'a', taskContentResolver: null },
    { id: 'b', taskContentResolver: 'not-an-object' },
    { id: 'c', taskContentResolver: [] },
    { id: 'd', taskContentResolver: { trackerPrefix: 'beads' } }, // no invoke
    { id: 'e', taskContentResolver: { trackerPrefix: 'beads', invoke: { binary: '', args: ['{{id}}'], timeoutMs: 1000 } } },
    { id: 'f', taskContentResolver: { trackerPrefix: 'beads', invoke: { binary: 'bd', args: ['{{id}}'], timeoutMs: 0 } } },
    { id: 'g', taskContentResolver: { trackerPrefix: 'beads', invoke: { binary: 'bd', args: ['{{id}}'], timeoutMs: -5 } } },
    { id: 'h', taskContentResolver: { trackerPrefix: 'beads', invoke: { binary: 'bd', args: ['{{id}}'], timeoutMs: 1.5 } } },
  ];
  assert.strictEqual(findResolver('beads', garbage), null);
});

// ─── resolveTaskContent — orchestration ─────────────────────────────────────────

test('row 5: no tracker-id resolves not-applicable', () => {
  const result = resolveTaskContent({ trackerId: null, capabilities: [beadsCapability()] });
  assert.deepStrictEqual(result, { kind: TASK_CONTENT_RESULT.NOT_APPLICABLE });
});

test('row 6: unmatched prefix resolves no-resolver', () => {
  const result = resolveTaskContent({ trackerId: 'unknownprefix:1', capabilities: [] });
  assert.deepStrictEqual(result, { kind: TASK_CONTENT_RESULT.NO_RESOLVER });
});

test('row 7: ambiguous prefix registration throws, never silently picks one', () => {
  const capA = beadsCapability();
  const capB = { ...beadsCapability(), id: 'other-capability' };
  assert.throws(
    () => resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [capA, capB], execFn: () => { throw new Error('must not be called'); } }),
    ResolverAmbiguousError,
  );
});

test('row 8: non-empty description resolves true with mapped content', () => {
  const execFn = () => ({
    status: 0,
    stdout: JSON.stringify({
      description: 'do X',
      verify: 'run tests',
      acceptance_criteria: ['a', 'b'],
      read_first: ['docs/x.md'],
      done: 'X is done',
    }),
    stderr: '',
  });
  const result = resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn });
  assert.deepStrictEqual(result, {
    kind: TASK_CONTENT_RESULT.RESOLVED,
    content: {
      action: 'do X',
      verify: 'run tests',
      acceptanceCriteria: ['a', 'b'],
      readFirst: ['docs/x.md'],
      done: 'X is done',
    },
  });
});

test('row 9: empty description string resolves empty', () => {
  const execFn = () => ({ status: 0, stdout: JSON.stringify({ description: '' }), stderr: '' });
  const result = resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn });
  assert.deepStrictEqual(result, { kind: TASK_CONTENT_RESULT.EMPTY });
});

test('row 9b: whitespace-only description resolves empty', () => {
  const execFn = () => ({ status: 0, stdout: JSON.stringify({ description: '   ' }), stderr: '' });
  const result = resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn });
  assert.deepStrictEqual(result, { kind: TASK_CONTENT_RESULT.EMPTY });
});

test('row 10: absent description resolves empty, same as empty string', () => {
  const execFn = () => ({ status: 0, stdout: JSON.stringify({}), stderr: '' });
  const result = resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn });
  assert.deepStrictEqual(result, { kind: TASK_CONTENT_RESULT.EMPTY });
});

test('row 11: non-zero resolver exit throws ResolverFailedError, never falls back silently', () => {
  const execFn = () => ({ status: 1, stdout: '', stderr: 'no such issue GSD-42' });
  assert.throws(
    () => resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn }),
    (err) => {
      assert.ok(err instanceof ResolverFailedError);
      assert.strictEqual(err.exitCode, 1);
      assert.match(err.stderrTail, /no such issue/);
      return true;
    },
  );
});

test('row 11b: a spawn error (e.g. ENOENT) also throws ResolverFailedError', () => {
  const enoent = new Error('spawnSync bd ENOENT');
  enoent.code = 'ENOENT';
  const execFn = () => ({ status: null, stdout: '', stderr: '', error: enoent });
  assert.throws(
    () => resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn }),
    ResolverFailedError,
  );
});

test('row 12: resolver exceeding timeoutMs throws ResolverTimeoutError (simulated, no real wait)', () => {
  const execFn = () => ({ status: null, stdout: '', stderr: '', error: timeoutError() });
  assert.throws(
    () => resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn }),
    (err) => {
      assert.ok(err instanceof ResolverTimeoutError);
      assert.strictEqual(err.timeoutMs, 10000);
      return true;
    },
  );
});

test('row 13: malformed JSON stdout throws, is not conflated with empty content', () => {
  const execFn = () => ({ status: 0, stdout: 'not json', stderr: '' });
  assert.throws(
    () => resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn }),
    ResolverMalformedOutputError,
  );
});

test('row 14: valid JSON non-object stdout (null/array/string/number/bool) throws', () => {
  const cases = [null, [], 'x', 0, true];
  for (const value of cases) {
    const execFn = () => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    assert.throws(
      () => resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn }),
      ResolverMalformedOutputError,
      `expected throw for JSON value ${JSON.stringify(value)}`,
    );
  }
});

test('row 15: invoke.args without {{id}} placeholder is rejected — resolves no-resolver, never spawns', () => {
  const badCapability = {
    id: 'bad-capability',
    taskContentResolver: { trackerPrefix: 'beads', invoke: { binary: 'bd', args: ['show'], timeoutMs: 1000 } },
  };
  const execFn = () => { throw new Error('must not spawn a rejected declaration'); };
  const result = resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [badCapability], execFn });
  assert.deepStrictEqual(result, { kind: TASK_CONTENT_RESULT.NO_RESOLVER });
});

test('row 16: id containing colons splits on first colon only, end to end', () => {
  let capturedArgs = null;
  const execFn = (binary, args) => {
    capturedArgs = args;
    return { status: 0, stdout: JSON.stringify({ description: 'do X' }), stderr: '' };
  };
  const result = resolveTaskContent({ trackerId: 'beads:issue:GSD-1', capabilities: [beadsCapability()], execFn });
  assert.deepStrictEqual(capturedArgs, ['show', 'issue:GSD-1', '--json']);
  assert.strictEqual(result.kind, TASK_CONTENT_RESULT.RESOLVED);
});

// ─── stderr-on-success is not an error (design.md negative space) ──────────────

test('stderr output on a successful (exit 0) run is not treated as a failure', () => {
  const execFn = () => ({ status: 0, stdout: JSON.stringify({ description: 'do X' }), stderr: 'informational log line' });
  const result = resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn });
  assert.strictEqual(result.kind, TASK_CONTENT_RESULT.RESOLVED);
});

// ─── fast-check property test (row 14, gauntlet enumeration) ───────────────────

test('property: any valid-JSON-but-not-an-object stdout always throws ResolverMalformedOutputError, never resolves silently', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(null),
        fc.array(fc.anything()),
        fc.string(),
        fc.double(),
        fc.boolean(),
      ),
      (value) => {
        const execFn = () => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
        try {
          resolveTaskContent({ trackerId: 'beads:GSD-42', capabilities: [beadsCapability()], execFn });
          return false;
        } catch (err) {
          return err instanceof ResolverMalformedOutputError;
        }
      },
    ),
    { numRuns: 100 },
  );
});
