'use strict';

/**
 * quick-batch-command-router.test.cjs — Behavioral tests for the
 * `gsd-tools quick-batch` command router (#3676, Phase 4 of epic #3344 /
 * ADR-1239 "Quick-batch binding").
 *
 * Module: gsd-core/bin/lib/quick-batch-command-router.cjs
 *   (compiled from src/quick-batch-command-router.cts)
 *
 * Follows `tests/roadmap-command-router.test.cjs`'s pattern: unit-level
 * tests inject `_quickBatch`/`_quickBatchDispatch` mocks (same `_`-prefix
 * seam convention `graphify-command-router.cts` established) and assert on
 * recorded call shapes; a smaller set of end-to-end tests drive the REAL
 * compiled router through `gsd-tools quick-batch <verb>` via `runGsdTools`
 * to prove the `HOST_COMMAND_ROUTERS` wiring itself (test-matrix rows 46-47).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { routeQuickBatchCommand } = require('../gsd-core/bin/lib/quick-batch-command-router.cjs');
const { runGsdTools, cleanup } = require('./helpers.cjs');

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-batch-router-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

// ─── Unit-level: argument shaping against injected mocks ───────────────────

describe('quick-batch-command-router: argument shaping (mocked modules)', () => {
  test('create requires --file', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'create'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /--file/);
  });

  test('create parses --file/--base-revision/--options and forwards to parseTaskListFromFile + createBatch', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'create', '--file', 'tasks.md', '--base-revision', 'deadbeef', '--options', '{"note":"x"}'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {
        parseTaskListFromFile: (cwd, filePath) => {
          calls.push({ fn: 'parseTaskListFromFile', cwd, filePath });
          return { ok: true, value: [{ description: 'a' }, { description: 'b' }] };
        },
        createBatch: (cwd, items, options) => {
          calls.push({ fn: 'createBatch', cwd, items, options });
          return { ok: true, value: { batchId: 'x' } };
        },
      },
      _quickBatchDispatch: {},
    });
    assert.equal(calls[0].fn, 'parseTaskListFromFile');
    assert.equal(calls[0].filePath, 'tasks.md');
    assert.equal(calls[1].fn, 'createBatch');
    assert.deepEqual(calls[1].items, [{ description: 'a' }, { description: 'b' }]);
    assert.equal(calls[1].options.baseRevision, 'deadbeef');
    assert.deepEqual(calls[1].options.batchOptions, { note: 'x' });
  });

  test('update requires --batch and --updates', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'update', '--batch', 'b1'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /--updates/);
  });

  test('update parses --updates JSON and forwards to updateBatchItems', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'update', '--batch', 'b1', '--updates', '[{"quickId":"260101-abc","dependsOn":[]}]'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {
        updateBatchItems: (cwd, batchId, updates) => {
          calls.push({ cwd, batchId, updates });
          return { ok: true, value: { manifest: {} } };
        },
      },
      _quickBatchDispatch: {},
    });
    assert.equal(calls[0].batchId, 'b1');
    assert.deepEqual(calls[0].updates, [{ quickId: '260101-abc', dependsOn: [] }]);
  });

  test('update rejects malformed --updates JSON before calling updateBatchItems', () => {
    let message = null;
    let called = false;
    routeQuickBatchCommand({
      args: ['quick-batch', 'update', '--batch', 'b1', '--updates', 'not-json'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: { updateBatchItems: () => { called = true; return { ok: true, value: {} }; } },
      _quickBatchDispatch: {},
    });
    assert.match(message, /not valid JSON/);
    assert.equal(called, false);
  });

  test('resume requires --batch', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'resume'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /--batch/);
  });

  test('resume forwards --current-base-revision when present', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'resume', '--batch', 'b1', '--current-base-revision', 'cafebabe'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {
        resumeBatch: (cwd, batchId, options) => {
          calls.push({ cwd, batchId, options });
          return { ok: true, value: { eligible: [] } };
        },
      },
      _quickBatchDispatch: {},
    });
    assert.equal(calls[0].options.currentBaseRevision, 'cafebabe');
  });

  test('complete requires all of --batch/--quick-id/--description/--date/--commit', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'complete', '--batch', 'b1', '--quick-id', '260101-abc'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /Usage: gsd-tools quick-batch complete/);
  });

  test('effective-concurrency forwards jobs/task-count/capacity/isolation/mutating to the dispatch module', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'effective-concurrency', '--jobs', '4', '--task-count', '8', '--capacity', '3', '--isolation', 'none', '--mutating'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        computeEffectiveConcurrency: (input) => { calls.push(input); return 1; },
      },
    });
    assert.deepEqual(calls[0], { jobs: 4, taskCount: 8, capacity: 3, isolation: 'none', mutating: true });
  });

  test('effective-concurrency accepts --jobs auto', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'effective-concurrency', '--jobs', 'auto', '--task-count', '8', '--capacity', '3', '--isolation', 'harness-worktree'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        computeEffectiveConcurrency: (input) => { calls.push(input); return 3; },
      },
    });
    assert.equal(calls[0].jobs, 'auto');
    assert.equal(calls[0].mutating, false, '--mutating omitted defaults to false');
  });

  test('merge-eligible parses --wave-order/--ready JSON arrays', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'merge-eligible', '--wave-order', '["a","b"]', '--ready', '["a"]'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        computeMergeOrder: (waveOrder, readyIds) => { calls.push({ waveOrder, readyIds }); return ['a']; },
      },
    });
    assert.deepEqual(calls[0].waveOrder, ['a', 'b']);
    assert.deepEqual([...calls[0].readyIds], ['a']);
  });

  test('spawn-plan forwards eligible/capacity/in-flight/refused', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'spawn-plan', '--eligible', '["a","b","c"]', '--capacity', '2', '--in-flight', '0', '--refused', '["b"]'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        computeSpawnPlan: (input) => { calls.push(input); return { spawn: [], pending: [] }; },
      },
    });
    assert.deepEqual(calls[0], { eligibleIds: ['a', 'b', 'c'], capacity: 2, currentInFlight: 0, refused: ['b'] });
  });

  // #3677: crash-window duplicate-dispatch guard CLI verb.
  test('filter-executed forwards eligible/executed to filterAlreadyExecuted', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'filter-executed', '--eligible', '["a","b","c"]', '--executed', '["b"]'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        filterAlreadyExecuted: (eligibleIds, executedIds) => { calls.push({ eligibleIds, executedIds }); return { spawnEligible: [], alreadyExecuted: [] }; },
      },
    });
    assert.deepEqual(calls[0], { eligibleIds: ['a', 'b', 'c'], executedIds: ['b'] });
  });

  test('filter-executed rejects a missing --eligible', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'filter-executed', '--executed', '["b"]'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /--eligible/);
  });

  test('filter-executed rejects a missing --executed', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'filter-executed', '--eligible', '["a"]'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /--executed/);
  });

  test('verification-routing rejects an invalid --status', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'verification-routing', '--status', 'bogus'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /--status/);
  });

  test('verification-routing forwards a valid --status', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'verification-routing', '--status', 'gaps_found'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: { routeVerificationOutcome: (status) => { calls.push(status); return { action: 'fail' }; } },
    });
    assert.deepEqual(calls, ['gaps_found']);
  });

  test('merge-routing rejects an invalid --kind', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'merge-routing', '--kind', 'bogus'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /--kind/);
  });

  test('merge-routing forwards --kind and optional --detail', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'merge-routing', '--kind', 'merge_failed', '--detail', 'conflict'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: { routeMergeOutcome: (outcome) => { calls.push(outcome); return { action: 'fail' }; } },
    });
    assert.deepEqual(calls[0], { kind: 'merge_failed', detail: 'conflict' });
  });

  test('cleanup-entry requires --worktree-path/--branch/--expected-base/--plan-content', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'cleanup-entry', '--branch', 'b'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: {},
      _quickBatchDispatch: {},
    });
    assert.match(message, /Usage: gsd-tools quick-batch cleanup-entry/);
  });

  test('cleanup-entry forwards all fields, defaulting --agent-id to null when omitted', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'cleanup-entry', '--worktree-path', '/tmp/wt', '--branch', 'b', '--expected-base', 'main', '--plan-content', 'text', '--allowed-bases', '["main"]'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: { buildCleanupManifestEntry: (input) => { calls.push(input); return {}; } },
    });
    assert.deepEqual(calls[0], {
      agentId: null,
      worktreePath: '/tmp/wt',
      branch: 'b',
      expectedBase: 'main',
      allowedBases: ['main'],
      planContent: 'text',
    });
  });

  test('parse-args forwards everything after -- to parseQuickBatchArgs', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'parse-args', '--', '--jobs', '4', '--validate'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        parseQuickBatchArgs: (rawArgs) => { calls.push(rawArgs); return { ok: true, value: {} }; },
      },
    });
    assert.deepEqual(calls[0], ['--jobs', '4', '--validate']);
  });

  // #3676 security fix: `--text` accepts the ENTIRE raw $ARGUMENTS string as
  // ONE argv element (the caller quotes it, e.g. `--text "$ARGUMENTS"`), so
  // shell word-splitting/pathname-expansion on attacker-influenced task text
  // never happens before this parser sees it. The split into tokens happens
  // HERE, in Node, which never glob-expands.
  test('parse-args --text splits the whole string into tokens itself (no shell involvement)', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'parse-args', '--text', '--jobs 4 --validate'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        parseQuickBatchArgs: (rawArgs) => { calls.push(rawArgs); return { ok: true, value: {} }; },
      },
    });
    assert.deepEqual(calls[0], ['--jobs', '4', '--validate']);
  });

  test('parse-args --text with an embedded glob-shaped token passes it through literally, unexpanded', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'parse-args', '--text', '- fix files matching *.txt\n- second task'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        parseQuickBatchArgs: (rawArgs) => { calls.push(rawArgs); return { ok: true, value: {} }; },
      },
    });
    // The glob-shaped token survives as literal text tokens — never
    // expanded to matching filenames, because it never passed through a
    // shell glob context (the caller quoted it; this handler's own
    // whitespace split is not glob-aware).
    assert.ok(calls[0].includes('*.txt'));
  });

  test('parse-args --text with only whitespace produces an empty token array', () => {
    const calls = [];
    routeQuickBatchCommand({
      args: ['quick-batch', 'parse-args', '--text', '   '],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { throw new Error(`unexpected error: ${msg}`); },
      _quickBatch: {},
      _quickBatchDispatch: {
        parseQuickBatchArgs: (rawArgs) => { calls.push(rawArgs); return { ok: true, value: {} }; },
      },
    });
    assert.deepEqual(calls[0], []);
  });

  test('a domain Result failure (ok:false) is routed through error(), not treated as success', () => {
    let message = null;
    routeQuickBatchCommand({
      args: ['quick-batch', 'resume', '--batch', 'b1'],
      cwd: '/tmp/proj',
      raw: true,
      error: (msg) => { message = msg; },
      _quickBatch: { resumeBatch: () => ({ ok: false, reason: 'no BATCH.json found for batch b1' }) },
      _quickBatchDispatch: {},
    });
    assert.equal(message, 'no BATCH.json found for batch b1');
  });
});

// ─── End-to-end: real router wiring via HOST_COMMAND_ROUTERS (rows 46-47) ──

describe('quick-batch-command-router: end-to-end via gsd-tools (rows 46-47)', () => {
  test('row 47: unknown subcommand errors via the Hub\'s manifest check, same shape as graphify\'s', () => {
    const dir = mkTmpProject();
    try {
      const result = runGsdTools(['quick-batch', 'nonsense'], dir);
      assert.equal(result.success, false);
      assert.match(result.error, /Unknown quick-batch subcommand\. Available:/);
    } finally {
      cleanup(dir);
    }
  });

  test('row 46: create -> resume round-trips a real batch through the real router', () => {
    const dir = mkTmpProject();
    try {
      const tasksFile = path.join(dir, '.planning', 'tasks.md');
      fs.writeFileSync(tasksFile, '- first task\n- second task\n');

      const created = runGsdTools(['quick-batch', 'create', '--file', tasksFile, '--raw'], dir);
      assert.equal(created.success, true, `create failed: ${created.error}`);
      const createdJson = JSON.parse(created.output);
      assert.ok(createdJson.batchId);

      const resumed = runGsdTools(['quick-batch', 'resume', '--batch', createdJson.batchId, '--raw'], dir);
      assert.equal(resumed.success, true, `resume failed: ${resumed.error}`);
      const resumedJson = JSON.parse(resumed.output);
      assert.equal(resumedJson.eligible.length, 2, 'both items are eligible before any leaf runs');
    } finally {
      cleanup(dir);
    }
  });

  test('effective-concurrency verb is reachable end-to-end and returns a number', () => {
    const dir = mkTmpProject();
    try {
      const result = runGsdTools(['quick-batch', 'effective-concurrency', '--jobs', 'auto', '--task-count', '5', '--capacity', '3', '--isolation', 'harness-worktree', '--raw'], dir);
      assert.equal(result.success, true, `command failed: ${result.error}`);
      assert.deepEqual(JSON.parse(result.output), { concurrency: 3 });
    } finally {
      cleanup(dir);
    }
  });

  // Security/Spec review fix (#3676 review pass 3): row 9 previously asserted
  // rejection only at the pure parseQuickBatchArgs level, which has no I/O to
  // begin with — it never proves the WORKFLOW-LEVEL invariant "a rejected
  // --jobs value never reaches quick-batch create, so no partial BATCH.json
  // exists." Assert that end-to-end: reject via the real CLI parse-args verb,
  // then confirm .planning/quick-batches/ was never created at all.
  describe('row 9: a rejected --jobs value leaves no partial BATCH.json (hostile)', () => {
    for (const badJobs of ['0', '-1', 'abc']) {
      test(`--jobs ${badJobs} is rejected and .planning/quick-batches/ stays absent`, () => {
        const dir = mkTmpProject();
        try {
          const result = runGsdTools(['quick-batch', 'parse-args', '--raw', '--text', `--jobs ${badJobs}`], dir);
          assert.equal(result.success, false, `expected rejection for --jobs ${badJobs}`);
          assert.equal(
            fs.existsSync(path.join(dir, '.planning', 'quick-batches')),
            false,
            'parse-args must never create .planning/quick-batches/ — createBatch is never reached after a rejected --jobs value',
          );
        } finally {
          cleanup(dir);
        }
      });
    }
  });

  // Spec review fix: row 18 previously only exercised loadBatch against a
  // hand-corrupted BATCH.json — never a genuinely nonexistent batch
  // directory (the actual row-18 shape: "--resume <unknown-batch-id>").
  test('row 18: --resume <unknown-batch-id> fails closed with no batch directory ever created', () => {
    const dir = mkTmpProject();
    try {
      // No .planning/quick-batches/<id>/ directory exists at all for this id —
      // never created, never touched by any prior call in this test.
      const result = runGsdTools(['quick-batch', 'resume', '--batch', '999999-zzz', '--raw'], dir);
      assert.equal(result.success, false);
      assert.match(result.error, /no BATCH\.json found for batch 999999-zzz/);
      assert.equal(
        fs.existsSync(path.join(dir, '.planning', 'quick-batches', '999999-zzz')),
        false,
        'resume must never create a batch directory for an unknown id',
      );
    } finally {
      cleanup(dir);
    }
  });
});
