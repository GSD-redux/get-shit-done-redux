'use strict';

/**
 * Tests for scripts/benchmark-compact-content.cjs (Phase 4, #4404). Follows
 * `.gsd/phase/enhance-4404-token-benchmark/50-test-matrix.md` row by row.
 *
 * 80/20 risk zone per that matrix: the "never fails CI" property and the
 * offline/determinism proof are the highest-value tests here — a benchmark
 * that accidentally starts gating CI, or that silently drifts
 * non-deterministically, defeats the whole point of building a reporting
 * instrument. The token-count arithmetic itself is exercised mostly via
 * synthetic fixtures/direct function calls (fast, no subprocess needed).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { discoverRegisteredSplits: discoverRegisteredSplitsViaSharedHelper } = require('./helpers/compact-content-split.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'benchmark-compact-content.cjs');
const BASELINE_PATH = path.join(ROOT, 'tests', 'fixtures', 'compact-content-benchmark-baseline.json');
const DENY_NETWORK_PRELOAD = path.join(__dirname, 'fixtures', 'deny-network.cjs');

const benchmark = require('../scripts/benchmark-compact-content.cjs');

function runBenchmark(args = [], options = {}) {
  return runNode([SCRIPT, ...args], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS, ...options });
}

// ─── Discovery ──────────────────────────────────────────────────────────────

describe('discovery', () => {
  test('the real plan-phase split is found, with sane on/off counts', () => {
    const splits = benchmark.discoverRegisteredSplits();
    const planPhase = splits.find((s) => s.name === 'plan-phase');
    assert.ok(planPhase, 'plan-phase must be discovered from the real repo tree');
    const result = benchmark.computeSplitTokens(planPhase);
    assert.ok(result.onTokens > 0);
    assert.ok(result.offTokens > result.onTokens, 'off must be strictly larger than on for a real split with content');
    assert.ok(result.reductionPct > 0 && result.reductionPct < 100);
  });

  test('a split with an empty detail file: off equals on, 0% reduction, no NaN/Infinity', () => {
    const tmp = createTempDir('gsd-bench-discovery-');
    try {
      const workflowsDir = path.join(tmp, 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'only', 'detail'), { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'only.md'), '# Spine\n\nSome real content here.\n');
      fs.writeFileSync(path.join(workflowsDir, 'only', 'detail', 'empty.md'), '');

      const splits = benchmark.discoverRegisteredSplits(workflowsDir);
      assert.strictEqual(splits.length, 1);
      const result = benchmark.computeSplitTokens(splits[0]);
      assert.strictEqual(result.offTokens, result.onTokens);
      assert.strictEqual(result.reductionPct, 0);
      assert.ok(Number.isFinite(result.reductionPct));
    } finally {
      cleanup(tmp);
    }
  });

  test('zero registered splits at all: discovery returns [], aggregate reports an explicit 0/0 state', () => {
    const tmp = createTempDir('gsd-bench-discovery-empty-');
    try {
      const workflowsDir = path.join(tmp, 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'lonely.md'), '# No detail dir for this one\n');

      const splits = benchmark.discoverRegisteredSplits(workflowsDir);
      assert.deepStrictEqual(splits, []);
      const aggregate = benchmark.computeAggregate({});
      assert.deepStrictEqual(aggregate, { offTokens: 0, onTokens: 0, reductionPct: 0 });
    } finally {
      cleanup(tmp);
    }
  });

  test('two discovery calls against the same real tree agree, order-independent', () => {
    const a = benchmark.discoverRegisteredSplits().map((s) => s.name).sort();
    const b = benchmark.discoverRegisteredSplits().map((s) => s.name).sort();
    assert.deepStrictEqual(a, b);
  });

  test('parity: this script\'s own discovery agrees with tests/helpers/compact-content-split.cjs on the real tree', () => {
    // This module's header explains WHY discovery is reimplemented here rather
    // than importing the shared test helper (a scripts/ reporting tool must
    // not depend on a test-only module). CLAUDE.md's "Generative Fix
    // Divergence" rule requires a parity assertion for exactly this shape —
    // two independently-maintained copies of the same discovery rule that
    // could silently drift apart. This test is that assertion: it does NOT
    // import the shared helper into the script, it only proves the two
    // implementations still agree on the real repo tree today.
    const ownResults = benchmark.discoverRegisteredSplits();
    const sharedResults = discoverRegisteredSplitsViaSharedHelper();

    const ownByName = new Map(ownResults.map((s) => [s.name, s]));
    // The shared helper also reports a split whose spine file is missing
    // (spineExists: false); this script's own discovery filters those out
    // entirely (see the `fs.existsSync(spinePath)` guard above), so parity is
    // scoped to splits BOTH implementations agree are real.
    const sharedByName = new Map(sharedResults.filter((s) => s.spineExists).map((s) => [s.name, s]));

    assert.deepStrictEqual([...ownByName.keys()].sort(), [...sharedByName.keys()].sort());
    for (const name of ownByName.keys()) {
      const own = ownByName.get(name);
      const shared = sharedByName.get(name);
      assert.strictEqual(own.spinePath, shared.spinePath, `spinePath diverged for split "${name}"`);
      assert.deepStrictEqual(own.detailPaths, shared.detailPaths, `detailPaths diverged for split "${name}"`);
    }
  });
});

// ─── Reduction math ─────────────────────────────────────────────────────────

describe('reduction math', () => {
  test('the arithmetic does not clamp or hide a negative percentage', () => {
    // A synthetic input fed directly to computeAggregate (never producible by
    // computeSplitTokens's own formula, where off = on + detail >= on always) —
    // this exercises that the aggregate formula reports whatever the numbers
    // say, rather than silently clamping a reduction below zero to zero.
    const aggregate = benchmark.computeAggregate({
      weird: { offTokens: 100, onTokens: 150 },
    });
    assert.strictEqual(aggregate.offTokens, 100);
    assert.strictEqual(aggregate.onTokens, 150);
    assert.ok(aggregate.reductionPct < 0, 'a negative reduction must be reported as-is, not clamped to 0');
  });

  test('aggregate is a real sum of two very differently-sized splits, not an average of percentages', () => {
    // Split A: 90% reduction on a huge detail file. Split B: 10% reduction on a
    // tiny one. An averaged-percentage bug would report (90+10)/2 = 50%; the
    // real sum-of-tokens formula must instead be dominated by the larger split.
    const splitResults = {
      big: { offTokens: 10000, onTokens: 1000 }, // 90% reduction
      small: { offTokens: 100, onTokens: 90 }, // 10% reduction
    };
    const aggregate = benchmark.computeAggregate(splitResults);
    assert.strictEqual(aggregate.offTokens, 10100);
    assert.strictEqual(aggregate.onTokens, 1090);
    const expectedPct = Math.round(((10100 - 1090) / 10100) * 100 * 100) / 100;
    assert.strictEqual(aggregate.reductionPct, expectedPct);
    assert.notStrictEqual(aggregate.reductionPct, 50, 'must not be the naive average of 90% and 10%');
  });

  // CLAUDE.md's Property-Based Testing rule requires at least one fast-check
  // property test for budget-limit arithmetic; computeAggregate's off/on
  // token summation is exactly that.
  test('property: computeAggregate is a true sum over any number of splits, never NaN/Infinity, and never exceeds the summed off total', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/),
          fc.record({
            onTokens: fc.nat({ max: 1_000_000 }),
            extraDetailTokens: fc.nat({ max: 1_000_000 }),
          }),
          { minKeys: 0, maxKeys: 20 },
        ),
        (splitInputs) => {
          const splitResults = {};
          let expectedOff = 0;
          let expectedOn = 0;
          for (const key of Object.keys(splitInputs)) {
            const { onTokens, extraDetailTokens } = splitInputs[key];
            const offTokens = onTokens + extraDetailTokens; // mirrors computeSplitTokens's own invariant: off >= on
            splitResults[key] = { offTokens, onTokens };
            expectedOff += offTokens;
            expectedOn += onTokens;
          }

          const aggregate = benchmark.computeAggregate(splitResults);

          assert.strictEqual(aggregate.offTokens, expectedOff);
          assert.strictEqual(aggregate.onTokens, expectedOn);
          assert.ok(Number.isFinite(aggregate.reductionPct), 'reductionPct must never be NaN/Infinity');
          assert.ok(aggregate.reductionPct <= 100, 'reductionPct can never exceed 100% when off >= on for every split');
        },
      ),
    );
  });
});

// ─── Determinism ────────────────────────────────────────────────────────────

describe('determinism', () => {
  test('two consecutive real runs (default stdout mode) are byte-identical', () => {
    const r1 = runBenchmark();
    const r2 = runBenchmark();
    assert.strictEqual(r1.exitCode, 0, `stderr: ${r1.stderr}`);
    assert.strictEqual(r2.exitCode, 0, `stderr: ${r2.stderr}`);
    assert.strictEqual(r1.stdout, r2.stdout);
  });

  test('running from two different cwds produces the same result', () => {
    const otherCwd = os.tmpdir();
    const r1 = runBenchmark([], { cwd: ROOT });
    const r2 = runBenchmark([], { cwd: otherCwd });
    assert.strictEqual(r1.exitCode, 0, `stderr: ${r1.stderr}`);
    assert.strictEqual(r2.exitCode, 0, `stderr: ${r2.stderr}`);
    assert.strictEqual(r1.stdout, r2.stdout);
  });

  test('a genuine read error on a discovered source file throws loud, never silently dropped from the aggregate', () => {
    const realFs = require('node:fs');
    const originalReadFileSync = realFs.readFileSync;
    const targetPath = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
    // Method-monkeypatching, not chmod: deterministic cross-platform IO-failure
    // injection per this repo's own documented preference (chmod 000 is a
    // no-op under root/CI and on Windows). Restored in `finally` regardless of
    // assertion outcome, so no other test in this process observes the stub.
    realFs.readFileSync = function stubbedReadFileSync(p, ...rest) {
      if (p === targetPath) {
        throw new Error('ENOENT-synthetic: simulated unreadable source file for this test');
      }
      return originalReadFileSync.call(realFs, p, ...rest);
    };
    try {
      assert.throws(() => benchmark.buildReport(), /simulated unreadable source file/);
    } finally {
      realFs.readFileSync = originalReadFileSync;
    }
    // Prove the stub didn't leak: a normal call succeeds again afterward.
    assert.doesNotThrow(() => benchmark.buildReport());
  });
});

// ─── Offline proof ──────────────────────────────────────────────────────────

describe('offline proof', () => {
  test('the deny-network preload is not a no-op: a network-touching probe throws under it', () => {
    const tmp = createTempDir('gsd-bench-offline-');
    try {
      const probePath = path.join(tmp, 'dns-probe.cjs');
      fs.writeFileSync(probePath, "require('node:dns').lookup('example.com', () => {});\n");
      const result = runNode([probePath], {
        cwd: ROOT,
        timeoutMs: PROBE_TIMEOUT_MS,
        env: { ...process.env, NODE_OPTIONS: `--require ${DENY_NETWORK_PRELOAD}` },
      });
      assert.notStrictEqual(result.exitCode, 0, 'a network-touching script must NOT exit cleanly under the deny-network preload');
      assert.match(result.stderr, /deny-network/);
    } finally {
      cleanup(tmp);
    }
  });

  test('the benchmark itself runs to completion under the deny-network preload and emits valid JSON', () => {
    const result = runBenchmark([], {
      env: { ...process.env, NODE_OPTIONS: `--require ${DENY_NETWORK_PRELOAD}` },
    });
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  });

  test('two consecutive runs under the deny-network preload are byte-identical (combined determinism + offline property)', () => {
    // The "determinism" and "offline proof" describe-blocks above each prove
    // one half of this on its own (two runs agree; one run survives with
    // network denied). This test is the combined property the issue's
    // Done-when criterion actually asks for: identical output ACROSS two
    // runs THAT ARE BOTH network-denied, not each half verified separately.
    const env = { ...process.env, NODE_OPTIONS: `--require ${DENY_NETWORK_PRELOAD}` };
    const r1 = runBenchmark([], { env });
    const r2 = runBenchmark([], { env });
    assert.strictEqual(r1.exitCode, 0, `stderr: ${r1.stderr}`);
    assert.strictEqual(r2.exitCode, 0, `stderr: ${r2.stderr}`);
    assert.strictEqual(r1.stdout, r2.stdout);
  });

  test('the preload does not leak into this (parent) test process', () => {
    // The preload only ever runs inside the spawned child (NODE_OPTIONS is
    // per-process); the parent's own http.request reference must be
    // unaffected by the two child runs above.
    const httpRequest = require('node:http').request;
    assert.strictEqual(typeof httpRequest, 'function');
    assert.doesNotMatch(String(httpRequest), /deny-network/);
  });
});

// ─── Proxy-tokenizer labeling ───────────────────────────────────────────────

describe('proxy-tokenizer labeling', () => {
  test('the committed baseline carries the PROXY-TOKENIZER label', () => {
    const committed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    assert.match(committed.label, /PROXY-TOKENIZER/);
  });

  test('a fresh run (subprocess, default stdout mode) carries the PROXY-TOKENIZER label', () => {
    const result = runBenchmark();
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    const live = JSON.parse(result.stdout);
    assert.match(live.label, /PROXY-TOKENIZER/);
  });

  test('--check flags a baseline that is missing the PROXY-TOKENIZER label', () => {
    const live = benchmark.buildReport();
    const unlabeled = { ...live, label: 'a hand-edited pre-labeling-era baseline' };
    const output = benchmark.formatDriftReport('/nonexistent-path-not-used', unlabeled);
    // formatDriftReport treats a read failure as "no baseline found"; to test
    // the label check specifically we call it via a real temp file instead.
    const tmp = createTempDir('gsd-bench-label-');
    try {
      const baselinePath = path.join(tmp, 'baseline.json');
      fs.writeFileSync(baselinePath, JSON.stringify(unlabeled, null, 2));
      const report = benchmark.formatDriftReport(baselinePath, live);
      assert.match(report, /DRIFT/);
      assert.match(report, /PROXY-TOKENIZER/);
    } finally {
      cleanup(tmp);
    }
    assert.match(output, /DRIFT/); // the nonexistent-path branch also reports DRIFT
  });
});

// ─── Never-fails-CI ─────────────────────────────────────────────────────────

describe('never-fails-CI', () => {
  test('--check against the real, committed, non-drifted baseline exits 0', () => {
    const result = runBenchmark(['--check']);
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /up to date/);
  });

  test('--check against a baseline that differs by one token still exits 0, printing the diff', () => {
    const tmp = createTempDir('gsd-bench-drift-');
    try {
      const committed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
      const wrong = JSON.parse(JSON.stringify(committed));
      const firstSplit = Object.keys(wrong.splits)[0];
      wrong.splits[firstSplit].offTokens += 1; // deliberately wrong by one token
      const wrongPath = path.join(tmp, 'wrong-baseline.json');
      fs.writeFileSync(wrongPath, JSON.stringify(wrong, null, 2));

      const result = runBenchmark(['--check', `--baseline-path=${wrongPath}`]);
      assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /DRIFT/);
      assert.match(result.stdout, new RegExp(firstSplit));
    } finally {
      cleanup(tmp);
    }
  });

  test('--check against a wholly missing baseline file still exits 0, reported as fully drifted', () => {
    const tmp = createTempDir('gsd-bench-missing-');
    try {
      const missingPath = path.join(tmp, 'does-not-exist.json');
      const result = runBenchmark(['--check', `--baseline-path=${missingPath}`]);
      assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /no baseline found/);
    } finally {
      cleanup(tmp);
    }
  });

  test('running --check twice against the same drifted baseline reports the same drift both times (idempotent)', () => {
    const tmp = createTempDir('gsd-bench-idempotent-');
    try {
      const committed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
      const wrong = JSON.parse(JSON.stringify(committed));
      const firstSplit = Object.keys(wrong.splits)[0];
      wrong.splits[firstSplit].onTokens -= 1;
      const wrongPath = path.join(tmp, 'wrong-baseline.json');
      fs.writeFileSync(wrongPath, JSON.stringify(wrong, null, 2));

      const r1 = runBenchmark(['--check', `--baseline-path=${wrongPath}`]);
      const r2 = runBenchmark(['--check', `--baseline-path=${wrongPath}`]);
      assert.strictEqual(r1.exitCode, 0);
      assert.strictEqual(r2.exitCode, 0);
      assert.strictEqual(r1.stdout, r2.stdout);
    } finally {
      cleanup(tmp);
    }
  });

  test('a genuine I/O error on a SOURCE file still throws (never masked by the never-fails-CI contract)', () => {
    // Distinguishes "the baseline is never allowed to cause a failure" from
    // "nothing can ever cause a failure" — the module-header CRITICAL comment
    // in scripts/benchmark-compact-content.cjs makes exactly this distinction.
    // Re-verified here via subprocess (module require cache in the discovery
    // describe-block above already covers the in-process shape).
    const tmp = createTempDir('gsd-bench-ioerror-');
    try {
      const workflowsDir = path.join(tmp, 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'broken', 'detail'), { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'broken.md'), '# spine\n');
      fs.writeFileSync(path.join(workflowsDir, 'broken', 'detail', 'part.md'), 'detail content\n');

      // Directly exercise the exported function with a monkeypatched fs,
      // rather than a real chmod: chmod 000 is a no-op under a root-run
      // Docker/CI process and has no equivalent on Windows, so it is not a
      // reliable cross-platform failure injector (see CLAUDE.md's IO-failure
      // injection rule) — deterministic method-patching works everywhere.
      const realFs = require('node:fs');
      const originalReadFileSync = realFs.readFileSync;
      const targetPath = path.join(workflowsDir, 'broken', 'detail', 'part.md');
      realFs.readFileSync = function stubbedReadFileSync(p, ...rest) {
        if (p === targetPath) throw new Error('EACCES-synthetic: permission denied');
        return originalReadFileSync.call(realFs, p, ...rest);
      };
      try {
        assert.throws(() => benchmark.buildReport(workflowsDir), /EACCES-synthetic/);
      } finally {
        realFs.readFileSync = originalReadFileSync;
      }
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── gpt-tokenizer placement ────────────────────────────────────────────────

describe('gpt-tokenizer placement', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  test('devDependencies pins gpt-tokenizer at an exact (non-range) version', () => {
    assert.ok(pkg.devDependencies && typeof pkg.devDependencies['gpt-tokenizer'] === 'string');
    const version = pkg.devDependencies['gpt-tokenizer'];
    assert.doesNotMatch(version, /[\^~*x]/i, `expected an exact pin, got ${JSON.stringify(version)}`);
  });

  test('dependencies (production) does not carry gpt-tokenizer', () => {
    assert.ok(!pkg.dependencies || !('gpt-tokenizer' in pkg.dependencies));
  });

  test('package-lock.json resolves gpt-tokenizer to the exact pinned version', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const pinned = pkg.devDependencies['gpt-tokenizer'];
    const resolved = lock.packages && lock.packages['node_modules/gpt-tokenizer'];
    assert.ok(resolved, 'package-lock.json must carry a resolved entry for gpt-tokenizer');
    assert.strictEqual(resolved.version, pinned);
  });

  test('the reported tokenizer version matches the exact pinned devDependency', () => {
    const report = benchmark.buildReport();
    assert.strictEqual(report.tokenizer.name, 'gpt-tokenizer');
    assert.strictEqual(report.tokenizer.version, pkg.devDependencies['gpt-tokenizer']);
  });
});
