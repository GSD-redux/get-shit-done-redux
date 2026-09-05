'use strict';

/**
 * Failing-first tests for #3777 (opt-in concurrent per-plan planners in
 * chunked mode).
 *
 * Design:      .gsd/phase/feat-3777-chunked-parallel-planners/40-design.md
 * Test matrix: .gsd/phase/feat-3777-chunked-parallel-planners/50-test-matrix.md
 *
 * Two real, shipped bash blocks are extracted and EXECUTED (never re-typed), both from
 * chunked-planning-mode.md:
 *   1. the `CHUNKED_PARALLEL` resolution (config x dispatch-capacity), read once per
 *      chunked run, ahead of §8.5.1, so a non-chunked run never pays for it.
 *   2. the `BATCH_PLAN_IDS` dedup guard (§8.5.2 step 1).
 * Wave grouping itself is orchestrator (LLM) comprehension, not a bash block —
 * see the design doc's "Known limits" — so it has no extraction test here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTempDir,
  createTempProject,
  cleanup,
  readFileNormalized,
  runGsdTools,
} = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CHUNKED_MODE_MD_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'chunked-planning-mode.md',
);
const RUNTIME_LAUNCHER_SNIPPET_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh');

// ─── extraction (source-text-is-the-product) ──────────────────────────────

/** Finds the first ```bash/```sh fence in `content` whose text contains every string in `mustInclude`. */
function extractBashFenceContaining(content, mustInclude, label, filePath) {
  const lines = content.split(/\r?\n/);
  for (const fenced of scanFencedBlocks(lines)) {
    if (fenced.closeLineIdx === -1) continue;
    if (!['bash', 'sh'].includes((fenced.infoString || '').trim())) continue;
    const block = lines.slice(fenced.openLineIdx + 1, fenced.closeLineIdx).join('\n');
    if (mustInclude.every((s) => block.includes(s))) return block;
  }
  throw new Error(`extractBashFenceContaining: no fence matching ${label} found in ${filePath} (looked for ${JSON.stringify(mustInclude)})`);
}

/**
 * The canonical runtime-launcher preamble (source of truth for
 * scripts/sync-runtime-launcher.cjs) sits as the first line of the
 * CHUNKED_PARALLEL resolution fence in production (tests/runtime-launcher-parity.test.cjs
 * owns verifying its placement/uniqueness). Strip it here so this suite tests
 * only the resolution logic it's actually about, not the preamble's own
 * gsd_run-shim-resolution behavior (which would stomp this file's `gsd_run`
 * stub — see #3777 investigation).
 */
function stripRuntimeLauncherPreamble(block) {
  const preamble = readFileNormalized(RUNTIME_LAUNCHER_SNIPPET_PATH).replace(/\n+$/, '');
  if (!block.includes(preamble)) {
    throw new Error('stripRuntimeLauncherPreamble: canonical preamble not found in extracted block — extraction anchor or preamble content may have drifted');
  }
  return block.split(preamble).join('').replace(/^\s+/, '');
}

function extractChunkedParallelResolution() {
  const content = readFileNormalized(CHUNKED_MODE_MD_PATH);
  const block = extractBashFenceContaining(
    content,
    ['CHUNKED_PARALLEL_CFG', 'DISPATCH_CAPACITY', 'CHUNKED_PARALLEL='],
    '#3777 CHUNKED_PARALLEL resolution',
    CHUNKED_MODE_MD_PATH,
  );
  return stripRuntimeLauncherPreamble(block);
}

function extractBatchPlanIdsDedup() {
  const content = readFileNormalized(CHUNKED_MODE_MD_PATH);
  return extractBashFenceContaining(
    content,
    ['BATCH_PLAN_IDS=', 'WAVE_PLAN_IDS'],
    '#3777 BATCH_PLAN_IDS dedup guard',
    CHUNKED_MODE_MD_PATH,
  );
}

// ─── runners ────────────────────────────────────────────────────────────────

/**
 * Runs the real extracted CHUNKED_PARALLEL resolution block with a `gsd_run`
 * stub spliced in front of it. Returns the resolved `CHUNKED_PARALLEL` value
 * as a string ("true"/"false"), exactly as production code reads it.
 */
function runChunkedParallelResolution(t, opts) {
  const scriptDir = createTempDir('gsd-3777-script-');
  t.after(() => cleanup(scriptDir));

  const block = extractChunkedParallelResolution();

  const stub = [
    'gsd_run() {',
    '  if [ "$1" = "query" ] && [ "$2" = "config-get" ] && [ "$3" = "planning.chunked_parallel" ]; then',
    '    if [ "$STUB_CONFIG_GET_FAILS" = "1" ]; then',
    '      return 1',
    '    fi',
    '    printf %s "$STUB_CONFIG_VALUE"',
    '    return 0',
    '  fi',
    '  if [ "$1" = "query" ] && [ "$2" = "dispatch-capacity" ]; then',
    '    if [ "$STUB_CAPACITY_FAILS" = "1" ]; then',
    '      return 1',
    '    fi',
    '    printf %s "$STUB_CAPACITY_VALUE"',
    '    return 0',
    '  fi',
    '  return 0',
    '}',
  ].join('\n');

  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    stub,
    block,
    'printf "RESULT:%s" "$CHUNKED_PARALLEL"',
  ].join('\n');

  const scriptPath = path.join(scriptDir, 'resolve.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const env = {
    ...process.env,
    STUB_CONFIG_VALUE: opts.configValue === null || opts.configValue === undefined ? '' : opts.configValue,
    STUB_CONFIG_GET_FAILS: opts.configGetFails ? '1' : '0',
    STUB_CAPACITY_VALUE: opts.capacityValue === null || opts.capacityValue === undefined ? '' : String(opts.capacityValue),
    STUB_CAPACITY_FAILS: opts.capacityFails ? '1' : '0',
  };

  const result = runHook(scriptPath, [], {
    interpreter: 'bash',
    cwd: scriptDir,
    env,
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
  });

  const stdout = result.stdout || '';
  const match = /RESULT:(\S*)/.exec(stdout);
  return {
    outcome: result.outcome,
    exitCode: result.exitCode,
    stderr: result.stderr,
    chunkedParallel: match ? match[1] : null,
  };
}

/**
 * Runs the real extracted BATCH_PLAN_IDS dedup block with `WAVE_PLAN_IDS`
 * seeded from `waveIds` (already space-separated, matching how the
 * orchestrator populates it from outline rows).
 */
function runBatchDedup(t, waveIds) {
  const scriptDir = createTempDir('gsd-3777-dedup-script-');
  t.after(() => cleanup(scriptDir));

  const block = extractBatchPlanIdsDedup();

  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    `WAVE_PLAN_IDS='${waveIds}'`,
    block,
    'printf "RESULT:%s" "$BATCH_PLAN_IDS"',
  ].join('\n');

  const scriptPath = path.join(scriptDir, 'dedup.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const result = runHook(scriptPath, [], {
    interpreter: 'bash',
    cwd: scriptDir,
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
  });

  const stdout = result.stdout || '';
  const match = /RESULT:(.*)$/.exec(stdout);
  const batch = match ? match[1].trim() : '';
  return {
    outcome: result.outcome,
    exitCode: result.exitCode,
    stderr: result.stderr,
    batchIds: batch.length > 0 ? batch.split(/\s+/) : [],
  };
}

// ─── #1/#2 — default and explicit-disabled stay serial ────────────────────

describe('#3777 default and explicit-disabled CHUNKED_PARALLEL resolution stays serial', () => {
  test('defaultsToSerialWhenKeyUnset', (t) => {
    const result = runChunkedParallelResolution(t, { configValue: null, capacityValue: 20 });
    assert.equal(result.outcome, 'exited');
    assert.equal(result.chunkedParallel, 'false');
  });

  test('staysSerialWhenExplicitlyDisabled', (t) => {
    const result = runChunkedParallelResolution(t, { configValue: 'false', capacityValue: 20 });
    assert.equal(result.chunkedParallel, 'false');
  });
});

// ─── #3 — opt-in with sufficient capacity ──────────────────────────────────

describe('#3777 opt-in with sufficient dispatch capacity', () => {
  test('enablesParallelWhenConfigTrueAndCapacityAboveOne', (t) => {
    const result = runChunkedParallelResolution(t, { configValue: 'true', capacityValue: 20 });
    assert.equal(result.chunkedParallel, 'true');
  });
});

// ─── #4/#5/#6 — capacity boundary (limit-1, limit, limit+1) ────────────────

describe('#3777 dispatch-capacity boundary gates the opt-in', () => {
  test('staysSerialWhenCapacityIsOne', (t) => {
    const result = runChunkedParallelResolution(t, { configValue: 'true', capacityValue: 1 });
    assert.equal(result.chunkedParallel, 'false', 'capacity=1 (the fail-closed floor) must degrade to serial even when the config opts in');
  });

  test('enablesParallelAtCapacityTwo', (t) => {
    const result = runChunkedParallelResolution(t, { configValue: 'true', capacityValue: 2 });
    assert.equal(result.chunkedParallel, 'true', 'capacity=2 is already above the floor and must enable concurrent dispatch');
  });

  test('staysSerialWhenCapacityIsZero', (t) => {
    // Defensive: routeDispatchCapacity never legitimately emits 0, but the
    // resolution's own arithmetic comparison must not misbehave on it either.
    const result = runChunkedParallelResolution(t, { configValue: 'true', capacityValue: 0 });
    assert.equal(result.chunkedParallel, 'false');
  });
});

// ─── #7 — non-canonical truthy values stay serial ──────────────────────────

describe('#3777 non-canonical truthy config values stay serial', () => {
  test('nonCanonicalTruthyValuesStaySerial', async (t) => {
    const nearMisses = ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true '];
    for (const value of nearMisses) {
      await t.test(`chunked_parallel="${value}"`, (t2) => {
        const result = runChunkedParallelResolution(t2, { configValue: value, capacityValue: 20 });
        assert.equal(result.chunkedParallel, 'false', `value "${value}" must not opt into parallel dispatch`);
      });
    }
  });
});

// ─── #8/#9 — broken tooling fails safe to serial ───────────────────────────

describe('#3777 broken config/capacity tooling fails safe to serial', () => {
  test('configGetFailureFallsBackToSerial', (t) => {
    const result = runChunkedParallelResolution(t, { configValue: 'true', capacityValue: 20, configGetFails: true });
    assert.equal(result.chunkedParallel, 'false');
  });

  test('capacityQueryFailureFallsBackToSerial', (t) => {
    const result = runChunkedParallelResolution(t, { configValue: 'true', capacityValue: 20, capacityFails: true });
    assert.equal(result.chunkedParallel, 'false');
  });
});

// ─── #10/#11/#12 — BATCH_PLAN_IDS dedup guard ──────────────────────────────

describe('#3777 duplicate Plan ID in a Wave dispatches once', () => {
  test('duplicatePlanIdInBatchDispatchesOnce', (t) => {
    const result = runBatchDedup(t, '03-01 03-02 03-01');
    assert.equal(result.outcome, 'exited');
    assert.deepEqual(result.batchIds, ['03-01', '03-02'], 'no two plans in a parallel batch may declare the same output path');
  });
});

describe('#3777 batch dedup preserves outline row order', () => {
  test('preservesOutlineOrderInBatch', (t) => {
    const result = runBatchDedup(t, '03-03 03-01 03-02');
    assert.deepEqual(result.batchIds, ['03-03', '03-01', '03-02']);
  });
});

describe('#3777 an empty Wave produces an empty batch', () => {
  test('emptyWaveProducesEmptyBatch', (t) => {
    const result = runBatchDedup(t, '');
    assert.equal(result.outcome, 'exited');
    assert.deepEqual(result.batchIds, []);
  });
});

// ─── #13/#14/#15 — config-set registers planning.chunked_parallel ─────────

describe('#3777 planning.chunked_parallel config key', () => {
  test('configSetAcceptsAndPersistsChunkedParallel', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools('config-set planning.chunked_parallel true', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(config.planning?.chunked_parallel, true);
    assert.equal(typeof config.planning?.chunked_parallel, 'boolean');

    const getResult = runGsdTools('config-get planning.chunked_parallel --raw', tmpDir);
    assert.ok(getResult.success, `config-get failed: ${getResult.error}`);
    assert.equal((getResult.output || '').trim(), 'true');
  });

  test('configSetPersistsBooleanFalse', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const setResult = runGsdTools('config-set planning.chunked_parallel false', tmpDir);
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(config.planning?.chunked_parallel, false);
    assert.equal(typeof config.planning?.chunked_parallel, 'boolean');
  });

  test('rejectsUnregisteredNeighbouringKey', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Extra "l" — proves the whitelist is load-bearing and the two tests
    // above are not vacuous (they'd pass even for an unregistered key if
    // config-set accepted anything).
    const result = runGsdTools('config-set planning.chunked_parallell true', tmpDir);
    assert.equal(result.success, false, 'an unregistered near-miss key must be rejected');
  });
});
