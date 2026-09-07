// docs-guard-exempt: docs/TESTING-SUITES.md is cited only in a header comment; never read.
// allow-test-rule: pending-migration-to-typed-ir [#3090]
// run-tests.cjs is a CLI test harness with no --json/structured output mode;
// these tests regex/substring-match its human-readable stderr (usage errors,
// the `run-tests: suite="X" files=N: name1 name2 ...` selection line) instead
// of a frozen typed IR. Adding a structured output mode is a production
// change out of scope here. See docs/TESTING-SUITES.md and issue #3597.
// Tracked under #3090.
//
// Tests for scripts/run-tests.cjs --suite filtering (issue #3597).
//
// Drives the harness through its subprocess seam — the same seam CI uses —
// rather than importing internals. Each test seeds a temporary directory
// with mock `.test.cjs` files (each one a trivial node:test no-op) and
// runs the harness against it via GSD_TEST_DIR.

'use strict';

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');

const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup, CONFIG_LOCATION_ENV_KEYS } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const HARNESS = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');

// The harness under test enforces its OWN per-chunk timeout internally
// (RUN_TESTS_CHUNK_TIMEOUT_MS, default 600000ms; this file's slowest explicit
// override below is 30000ms). This outer bound must stay comfortably above
// whatever the harness itself is configured to wait for a hung chunk, plus
// `node --test` child-process startup overhead — otherwise this seam would
// kill the harness before its own timeout diagnostic fires.
const HARNESS_TIMEOUT_MS = 120000;

// Minimal valid node:test file. Each fixture file passes when executed.
const PASS_BODY = `'use strict';
const { test } = require('node:test');
test('noop', () => {});
`;

function seed(dir, names) {
  for (const name of names) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, PASS_BODY, 'utf8');
  }
}

function runHarness(testDir, args = [], extraEnv = {}) {
  // Clear node:test parent-context env so the harness's child `node --test`
  // doesn't refuse to run with "recursive run() skipping running files".
  const env = { ...process.env, GSD_TEST_DIR: testDir, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  // #4070: strip RUN_TESTS_SHARD_RESERVE inherited from the OUTER job's own
  // environment. test.yml sets it on the "Run unit tests" step for the real
  // production shard 1 of the full-scope lane — and since these tests spawn
  // run-tests.cjs as a CHILD of that same step, they inherit it via
  // `...process.env` above like any other ambient var. Left unstripped, a
  // reserve of 77 weight units utterly dwarfs these synthetic 9-file
  // fixtures' combined weight (~0.3, since none of them are in the real
  // timings table), so shard index 1 gets EVERY file routed away from it —
  // a real, reproducible corruption of every test in this describe block,
  // not a flake (confirmed live: CI run 33288554040, shard 2/3, 7 of these
  // tests failed with exactly this signature). Deleted before `extraEnv` is
  // applied above would be too late (spread order), so it is deleted here,
  // AFTER composition, then only reinstated if a specific test opted in via
  // extraEnv — preserving this file's one legitimate use (the #4070 E2E
  // bounds-check test below, which sets it deliberately).
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'RUN_TESTS_SHARD_RESERVE')) {
    delete env.RUN_TESTS_SHARD_RESERVE;
  }
  const r = runNode([HARNESS, ...args], {
    cwd: path.join(__dirname, '..'),
    env,
    timeoutMs: HARNESS_TIMEOUT_MS,
  });
  // toLegacyResult() alone drops `signal` (several assertions below embed it
  // in their failure message) — compose it back on top, per git-fixture.cjs's
  // documented "extra field" composition pattern.
  return { ...toLegacyResult(r), signal: r.signal };
}

describe('run-tests.cjs harness (issue #3597)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3597-harness-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  describe('argument parsing', () => {
    test('unknown suite name exits non-zero with valid-suites hint', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'bogus']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /unknown suite/i);
      assert.match(r.stderr, /unit/);
      assert.match(r.stderr, /security/);
    });

    test('missing --suite value exits non-zero', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /requires a value/i);
    });

    test('duplicate --suite flag is rejected', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'unit', '--suite', 'security']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /duplicate/i);
    });

    test('unknown positional argument is rejected', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['unit']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /unknown argument/i);
    });

    test('--suite=value syntax is accepted', () => {
      seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
      const r = runHarness(tmpDir, ['--suite=security']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    });

    test('missing --files value exits non-zero', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--files']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /--files requires a value/i);
    });

    test('duplicate --files flag is rejected', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'a.test.cjs', '--files', 'a.test.cjs']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /duplicate --files/i);
    });

    test('--files and --files-from cannot be combined', () => {
      seed(tmpDir, ['a.test.cjs']);
      const listPath = path.join(tmpDir, 'selected-tests.txt');
      fs.writeFileSync(listPath, 'a.test.cjs\n', 'utf8');
      const r = runHarness(tmpDir, ['--files', 'a.test.cjs', '--files-from', listPath]);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /cannot be combined/i);
    });
  });

  describe('suite filtering', () => {
    test('no flag runs ALL test files (backcompat)', () => {
      seed(tmpDir, [
        'a.test.cjs',
        'b.security.test.cjs',
        'c.integration.test.cjs',
      ]);
      const r = runHarness(tmpDir);
      assert.strictEqual(r.status, 0);
      // node:test TAP output mentions each file path.
      assert.ok(r.stderr.includes('a.test.cjs'), 'expected a.test.cjs in output');
      assert.ok(
        r.stderr.includes('b.security.test.cjs'),
        'expected b.security.test.cjs in output',
      );
      assert.ok(
        r.stderr.includes('c.integration.test.cjs'),
        'expected c.integration.test.cjs in output',
      );
    });

    test('--suite all is equivalent to no flag', () => {
      seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'all']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('a.test.cjs'));
      assert.ok(r.stderr.includes('b.security.test.cjs'));
    });

    test('--suite unit excludes marked suites', () => {
      seed(tmpDir, [
        'a.test.cjs',
        'b.security.test.cjs',
        'c.integration.test.cjs',
        'd.install.test.cjs',
        'e.slow.test.cjs',
      ]);
      const r = runHarness(tmpDir, ['--suite', 'unit']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('a.test.cjs'));
      assert.ok(!r.stderr.includes('b.security.test.cjs'));
      assert.ok(!r.stderr.includes('c.integration.test.cjs'));
      assert.ok(!r.stderr.includes('d.install.test.cjs'));
      assert.ok(!r.stderr.includes('e.slow.test.cjs'));
    });

    test('--suite security selects only *.security.test.cjs', () => {
      seed(tmpDir, [
        'a.test.cjs',
        'b.security.test.cjs',
        'c.integration.test.cjs',
      ]);
      const r = runHarness(tmpDir, ['--suite', 'security']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('b.security.test.cjs'));
      assert.ok(!r.stderr.includes('a.test.cjs'));
      assert.ok(!r.stderr.includes('c.integration.test.cjs'));
    });

    test('--suite integration selects only *.integration.test.cjs', () => {
      seed(tmpDir, ['a.test.cjs', 'b.integration.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'integration']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('b.integration.test.cjs'));
      assert.ok(!r.stderr.includes('a.test.cjs'));
    });

    test('--suite install selects only *.install.test.cjs', () => {
      seed(tmpDir, ['a.test.cjs', 'b.install.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'install']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('b.install.test.cjs'));
    });

    test('--suite slow selects only *.slow.test.cjs', () => {
      seed(tmpDir, ['a.test.cjs', 'b.slow.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'slow']);
      assert.strictEqual(r.status, 0);
      assert.ok(r.stderr.includes('b.slow.test.cjs'));
    });
  });

  describe('empty-suite behavior', () => {
    test('--suite security with zero matching files exits non-zero with an error', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'security']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /0 test files selected/i);
    });

    test('GSD_ALLOW_EMPTY_SUITE=1 downgrades empty suite to a warning and exits 0', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--suite', 'security'], { GSD_ALLOW_EMPTY_SUITE: '1' });
      assert.strictEqual(r.status, 0);
      assert.match(r.stderr, /WARNING.*0 test files selected/i);
    });

    test('completely empty test dir still exits non-zero (preserves prior behavior)', () => {
      const r = runHarness(tmpDir);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /no test files/i);
    });
  });

  describe('explicit file selection', () => {
    test('--files runs only the named tests', () => {
      seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs', 'c.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'a.test.cjs tests/c.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('a.test.cjs'));
      assert.ok(r.stderr.includes('c.test.cjs'));
      assert.ok(!r.stderr.includes('b.security.test.cjs'));
    });

    test('--files-from runs tests listed in a file', () => {
      seed(tmpDir, ['a.test.cjs', 'b.security.test.cjs', 'c.test.cjs']);
      const listPath = path.join(tmpDir, 'selected-tests.txt');
      fs.writeFileSync(listPath, 'a.test.cjs\nb.security.test.cjs\n', 'utf8');
      const r = runHarness(tmpDir, ['--files-from', listPath]);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('a.test.cjs'));
      assert.ok(r.stderr.includes('b.security.test.cjs'));
      assert.ok(!r.stderr.includes('c.test.cjs'));
    });

    test('missing explicit test file exits non-zero', () => {
      seed(tmpDir, ['a.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'a.test.cjs missing.test.cjs']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /requested test file\(s\) not found: missing\.test\.cjs/i);
    });
  });

  describe('subdir file matching (findings #1 and #9)', () => {
    test('bare basename resolves to its single subdir file', () => {
      seed(tmpDir, ['sub/001-foo.test.cjs', 'b.test.cjs']);
      const r = runHarness(tmpDir, ['--files', '001-foo.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('001-foo.test.cjs'));
      assert.ok(!r.stderr.includes('b.test.cjs'));
    });

    test('full subdir relpath matches exactly', () => {
      seed(tmpDir, ['sub/001-foo.test.cjs', 'b.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'sub/001-foo.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('001-foo.test.cjs'));
      assert.ok(!r.stderr.includes('b.test.cjs'));
    });

    test('backslash-separated subdir path resolves on all platforms', () => {
      seed(tmpDir, ['sub/001-foo.test.cjs', 'b.test.cjs']);
      // Simulate a Windows caller passing backslash path
      const r = runHarness(tmpDir, ['--files', 'sub\\001-foo.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('001-foo.test.cjs'));
    });

    test('tests/ prefix is stripped before subdir matching', () => {
      seed(tmpDir, ['sub/001-foo.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'tests/sub/001-foo.test.cjs']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('001-foo.test.cjs'));
    });

    test('ambiguous bare basename exits non-zero with clear error', () => {
      seed(tmpDir, ['sub1/dup.test.cjs', 'sub2/dup.test.cjs']);
      const r = runHarness(tmpDir, ['--files', 'dup.test.cjs']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /ambiguous basename/i);
      assert.match(r.stderr, /dup\.test\.cjs/);
      assert.match(r.stderr, /subdir path/i);
    });
  });

  describe('failure propagation', () => {
    test('non-zero from node:test propagates through harness', () => {
      const FAIL = `'use strict';
const { test } = require('node:test');
test('boom', () => { throw new Error('intentional'); });
`;
      fs.writeFileSync(path.join(tmpDir, 'a.test.cjs'), FAIL, 'utf8');
      const r = runHarness(tmpDir);
      assert.notStrictEqual(
        r.status,
        0,
        `expected non-zero exit; got status=${r.status} signal=${r.signal}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
      );
    });
  });

  describe('env hermeticity', () => {
    // Regression guard for the two `delete process.env.GSD_PROJECT/GSD_WORKSTREAM`
    // lines added in scripts/run-tests.cjs main() right after ensureBuiltArtifacts().
    // If those deletions are removed, the fixture's assertions fail inside the child
    // node:test process → non-zero harness exit → this test fails → CI catches it.
    test('harness strips GSD_PROJECT and GSD_WORKSTREAM before running child tests', () => {
      // Write a fixture that asserts both vars are absent in the child process env.
      const FIXTURE = `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('ambient GSD workstream vars are stripped by the runner', () => {
  assert.strictEqual(process.env.GSD_PROJECT, undefined);
  assert.strictEqual(process.env.GSD_WORKSTREAM, undefined);
});
`;
      fs.writeFileSync(path.join(tmpDir, 'env-hermeticity.test.cjs'), FIXTURE, 'utf8');
      // Pass both vars in the ambient env given to the harness process.
      // The harness must delete them before spawning the child node:test process.
      const r = runHarness(tmpDir, [], {
        GSD_PROJECT: 'ambient-proj',
        GSD_WORKSTREAM: 'ambient-ws',
      });
      assert.strictEqual(r.status, 0, r.stderr);
    });
  });

  describe('Windows argv-overflow chunking (issue #3597)', () => {
    // Windows CreateProcess caps lpCommandLine at 32,767 chars. With ~550
    // tests the unchunked spawn fails instantly on Windows with no test
    // output. Linux/macOS allow ~2 MB so the same path works there. The
    // harness chunks selected files so each spawn stays under the ceiling,
    // and chunking is observable via the `run-tests: chunk N/M …` stderr
    // line. Long filenames force chunking even with a modest file count so
    // the test stays fast on every platform.
    test('chunks when total argv would exceed configured ceiling', () => {
      // Use a deliberately low MAX_CMDLINE_CHARS so the test is independent
      // of tmp-path length (varies by OS). With a 2000-char ceiling and 30
      // tests at ≥100 char paths, chunking must engage and at least one
      // `chunk N/M …` marker must appear in stderr.
      const longPrefix = 'a-deliberately-long-test-filename-to-force-chunking-behavior-cross-platform-';
      const names = Array.from({ length: 30 }, (_, i) => `${longPrefix}${String(i).padStart(4, '0')}.test.cjs`);
      seed(tmpDir, names);
      const r = runHarness(tmpDir, [], { RUN_TESTS_MAX_CMDLINE_CHARS: '2000' });
      assert.strictEqual(
        r.status,
        0,
        `expected zero exit; got status=${r.status} signal=${r.signal}\nSTDERR (tail):\n${r.stderr.split('\n').slice(-20).join('\n')}`,
      );
      assert.match(
        r.stderr,
        /run-tests: chunk \d+\/\d+ — \d+ files/,
        `expected chunking marker in stderr; STDERR (tail):\n${r.stderr.split('\n').slice(-20).join('\n')}`,
      );
    });

    test('chunks by file count even when argv length is below the ceiling', () => {
      const names = Array.from({ length: 7 }, (_, i) => `tiny-${String(i).padStart(2, '0')}.test.cjs`);
      seed(tmpDir, names);
      const r = runHarness(tmpDir, [], {
        RUN_TESTS_MAX_CMDLINE_CHARS: '100000',
        RUN_TESTS_MAX_FILES_PER_CHUNK: '3',
      });
      assert.strictEqual(
        r.status,
        0,
        `expected zero exit; got status=${r.status} signal=${r.signal}\nSTDERR:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /run-tests: chunk 1\/3 — 3 files/,
        `expected file-count chunking marker in stderr; STDERR:\n${r.stderr}`,
      );
      // #2456 changed the packer from sequential first-fit to LPT, so 7 equal-cost
      // files across 3 chunks now balance {3,2,2} instead of filling greedily to
      // {3,3,1}. The chunk COUNT is unchanged; only the tail is no longer starved.
      assert.match(
        r.stderr,
        /run-tests: chunk 3\/3 — 2 files/,
        `expected final file-count chunking marker in stderr; STDERR:\n${r.stderr}`,
      );
    });

    // #2088: expensive files must never all land in one chunk — otherwise the
    // unsharded targeted lane packs the whole install surface into a single chunk
    // that blows the 600s per-chunk backstop on the slow Windows runner. #2088
    // approximated "expensive" from the filename prefix; #2456 replaced that with
    // measured durations. This test carries the #2088 GUARANTEE forward onto the
    // new mechanism: the cost signal is now the timings table, injected via
    // RUN_TESTS_TIMINGS_FILE so the assertion does not depend on the real suite's
    // (regenerable, drifting) cost profile.
    function writeTimings(dir, timings) {
      const p = path.join(dir, 'timings.json');
      fs.writeFileSync(p, JSON.stringify({ schema_version: 1, unit: 'ms', timings }), 'utf8');
      return p;
    }

    test('expensive files SPREAD across chunks instead of clustering (#2088, #2456)', () => {
      // Discriminating by construction: the three EXPENSIVE files carry names the
      // old prefix heuristic scored 1, and the three TRIVIAL ones carry the
      // `install-` prefix it scored 12 — i.e. exactly inverted from their real
      // cost. Under the old packer this packs {2,2,1,1} (4 chunks, with two
      // expensive files sharing chunk 1); under measured weights it packs
      // {2,2,2}, one expensive file per chunk. The assertion below therefore
      // cannot pass on the old algorithm, nor with the timings file removed.
      const heavy = ['heavy-0.test.cjs', 'heavy-1.test.cjs', 'heavy-2.test.cjs'];
      const trivial = ['install-cheap-0.test.cjs', 'install-cheap-1.test.cjs', 'install-cheap-2.test.cjs'];
      seed(tmpDir, [...heavy, ...trivial]);
      const timingsFile = writeTimings(tmpDir, {
        ...Object.fromEntries(heavy.map((f) => [f, 30000])),
        ...Object.fromEntries(trivial.map((f) => [f, 10])),
      });
      const rh = runHarness(tmpDir, [], {
        RUN_TESTS_MAX_CMDLINE_CHARS: '100000',
        RUN_TESTS_MAX_FILES_PER_CHUNK: '2',
        RUN_TESTS_TIMINGS_FILE: timingsFile,
      });
      assert.strictEqual(rh.status, 0, `heavy: expected zero exit; STDERR:\n${rh.stderr}`);
      for (const n of [1, 2, 3]) {
        assert.match(
          rh.stderr,
          new RegExp(`run-tests: chunk ${n}/3 — 2 files`),
          `expensive files must spread one-per-chunk across exactly 3 chunks; STDERR:\n${rh.stderr}`,
        );
      }
    });

    test('trivial files the old heuristic over-weighted now stay in ONE chunk (#2088, #2456)', () => {
      // The other direction of the miscalibration. These four files carry the
      // `install-` prefix the old heuristic scored 12, so it split them into
      // FOUR single-file chunks against a 6-weight budget. Measured, they cost
      // 10ms each and belong together. The absence of a split marker cannot be
      // produced by the old algorithm.
      const trivial = Array.from({ length: 4 }, (_, i) => `install-triv-${i}.test.cjs`);
      seed(tmpDir, trivial);
      const timingsFile = writeTimings(tmpDir, Object.fromEntries(trivial.map((f) => [f, 10])));
      const rl = runHarness(tmpDir, [], {
        RUN_TESTS_MAX_CMDLINE_CHARS: '100000',
        RUN_TESTS_MAX_FILES_PER_CHUNK: '6',
        RUN_TESTS_TIMINGS_FILE: timingsFile,
      });
      assert.strictEqual(rl.status, 0, `light: expected zero exit; STDERR:\n${rl.stderr}`);
      // A single chunk emits NO `chunk N/M` split marker (it only prints when
      // chunks.length > 1), so its absence proves the four stayed together.
      assert.doesNotMatch(rl.stderr, /run-tests: chunk \d+\/\d+ — /, `4 trivial install-prefixed files must stay in one chunk; STDERR:\n${rl.stderr}`);
    });
  });

  describe('shard partitioning CLI (#1212)', () => {
    // The windows full-test lane is sharded across N parallel runners via a
    // GitHub Actions matrix shard dimension; each shard runs
    // `run-tests.cjs --suite unit --shard i/n`. Selection is a deterministic
    // round-robin over the SORTED file list so duration variance spreads
    // across shards. The CLI surface is validated here; the pure partition
    // contract (completeness/disjointness/balance/determinism) is validated
    // against the exported selectShard() in the separate describe block below.

    // 9 files, sorted: shard-00..shard-08. With n=3, round-robin gives
    // shard 1 -> {00,03,06}, shard 2 -> {01,04,07}, shard 3 -> {02,05,08}.
    const SHARD_NAMES = Array.from(
      { length: 9 },
      (_, i) => `shard-${String(i).padStart(2, '0')}.test.cjs`,
    );

    test('--shard 1/3 runs a balanced round-robin slice of the sorted files', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1/3']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      // The harness echoes the selected basenames on its `files=N:` line.
      assert.match(r.stderr, /files=3:/);
      assert.match(r.stderr, /shard-00\.test\.cjs/);
      assert.match(r.stderr, /shard-03\.test\.cjs/);
      assert.match(r.stderr, /shard-06\.test\.cjs/);
      // Files belonging to other shards must NOT appear in this shard's run.
      assert.doesNotMatch(r.stderr, /shard-01\.test\.cjs/);
      assert.doesNotMatch(r.stderr, /shard-02\.test\.cjs/);
    });

    // #2472 E2E: every other --shard test here uses synthetic filenames that
    // are absent from the real tests/test-timings.json, so they all collapse to
    // one uniform median weight — under which LPT is mathematically identical
    // to k % n. That means none of them can tell whether main() actually
    // threads fileWeightOf() into selectShard: a typo on that single line would
    // pass the entire existing suite. This test injects a table via
    // RUN_TESTS_TIMINGS_FILE with DIFFERING costs, so the weighted partition is
    // provably distinguishable from round-robin.
    test('--shard routes by measured cost end-to-end, not by index', (t) => {
      seed(tmpDir, SHARD_NAMES);
      // Heavy files sit at indices 0/3/6 — exactly the slice round-robin hands
      // to shard 1. Cost-weighting must NOT put all three on one shard.
      const timings = {
        schema_version: 1, unit: 'ms', timings: Object.fromEntries(
          SHARD_NAMES.map((n, i) => [n, i % 3 === 0 ? 30000 : 100]),
        ),
      };
      const tablePath = path.join(tmpDir, 'injected-timings.json');
      fs.writeFileSync(tablePath, JSON.stringify(timings));
      t.after(() => { try { fs.unlinkSync(tablePath); } catch { /* best effort */ } });

      const r = runHarness(tmpDir, ['--shard', '1/3'], { RUN_TESTS_TIMINGS_FILE: tablePath });
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      // Round-robin would give shard 1 exactly {00,03,06} — all three heavies.
      const heavies = ['shard-00', 'shard-03', 'shard-06']
        .filter(n => new RegExp(`${n}\\.test\\.cjs`).test(r.stderr)).length;
      assert.ok(
        heavies < 3,
        `cost-weighted shard 1 must not receive all three heavy files (that is the `
        + `round-robin split, proving the weigher was not threaded); stderr: ${r.stderr}`,
      );
      // And the diagnostic must show the table was actually consumed.
      assert.match(r.stderr, /table=loaded/, 'shard diagnostics must report the injected table as loaded');
      assert.match(r.stderr, /sig=[0-9a-f]+/, 'shard diagnostics must emit an input fingerprint');
    });

    // #4070 E2E: main()'s own bounds check on RUN_TESTS_SHARD_RESERVE — an
    // index that does not exist for the shard total in play — is invisible to
    // every pure in-memory selectShard/parseShardReserve test, because that
    // check lives in main() itself (scripts/run-tests.cjs, the
    // `reserve.index <= parsed.shard.total` guard and its console.error
    // fallback), which only runs through the CLI subprocess seam. Proves both
    // halves: the warning fires, AND the selection is provably unaffected
    // (byte-identical to a control run with no RUN_TESTS_SHARD_RESERVE at
    // all, both against the SAME injected timings table so the comparison
    // isn't muddied by table drift).
    test('RUN_TESTS_SHARD_RESERVE with an out-of-range index warns and is ignored (#4070)', () => {
      seed(tmpDir, SHARD_NAMES);
      const timings = {
        schema_version: 1, unit: 'ms', timings: Object.fromEntries(
          SHARD_NAMES.map((n, i) => [n, i % 3 === 0 ? 30000 : 100]),
        ),
      };
      const tablePath = path.join(tmpDir, 'injected-timings-oob.json');
      fs.writeFileSync(tablePath, JSON.stringify(timings));
      try {
        // --shard 1/3 → valid indices are 1..3. "5:999" is out of range.
        const withBadReserve = runHarness(
          tmpDir, ['--shard', '1/3'],
          { RUN_TESTS_TIMINGS_FILE: tablePath, RUN_TESTS_SHARD_RESERVE: '5:999' },
        );
        assert.strictEqual(withBadReserve.status, 0, `stderr: ${withBadReserve.stderr}`);
        assert.match(
          withBadReserve.stderr,
          /RUN_TESTS_SHARD_RESERVE="5:999" is not a valid .* for --shard total 3 — ignoring/,
          `expected the out-of-range-index fallback warning; got stderr: ${withBadReserve.stderr}`,
        );

        const control = runHarness(
          tmpDir, ['--shard', '1/3'],
          { RUN_TESTS_TIMINGS_FILE: tablePath },
        );
        assert.strictEqual(control.status, 0, `stderr: ${control.stderr}`);
        assert.doesNotMatch(control.stderr, /RUN_TESTS_SHARD_RESERVE/, 'control run must not warn — it sets no reserve at all');

        const filesLine = (s) => (s.match(/files=\d+: (.*)$/m) || [])[1] || '';
        assert.strictEqual(
          filesLine(withBadReserve.stderr), filesLine(control.stderr),
          'an out-of-range reserve index must select EXACTLY the same files as no reserve at all — '
          + 'the fallback warning alone is not proof the reserve was actually ignored',
        );
      } finally {
        try { fs.unlinkSync(tablePath); } catch { /* best effort */ }
      }
    });

    test('shard diagnostics report an identical input fingerprint across shards', () => {
      seed(tmpDir, SHARD_NAMES);
      // The cross-runner divergence guard: every shard of one run computes the
      // partition independently, so all of them must agree on the INPUT. A
      // differing sig between shard jobs is the only observable signal that
      // they disagreed — which is how the union could silently drop a file.
      const sigOf = (out) => (out.match(/sig=([0-9a-f]+)/) || [])[1];
      const sigs = [1, 2, 3].map((i) => sigOf(runHarness(tmpDir, ['--shard', `${i}/3`]).stderr));
      assert.ok(sigs.every(Boolean), `every shard must emit a sig; got ${JSON.stringify(sigs)}`);
      assert.strictEqual(new Set(sigs).size, 1, `all shards must fingerprint the same input; got ${sigs}`);
    });

    test('--shard 2/3 selects the second round-robin slice', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '2/3']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /files=3:/);
      assert.match(r.stderr, /shard-01\.test\.cjs/);
      assert.match(r.stderr, /shard-04\.test\.cjs/);
      assert.match(r.stderr, /shard-07\.test\.cjs/);
      assert.doesNotMatch(r.stderr, /shard-00\.test\.cjs/);
    });

    test('--shard composes with --suite (shards the post-filter selection)', () => {
      // 6 unit files + 2 security files. `--suite unit --shard 1/2` must shard
      // only the unit selection, never pulling in the security files.
      seed(tmpDir, [
        'u0.test.cjs',
        'u1.test.cjs',
        'u2.test.cjs',
        'u3.test.cjs',
        's0.security.test.cjs',
        's1.security.test.cjs',
      ]);
      const r = runHarness(tmpDir, ['--suite', 'unit', '--shard', '1/2']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /\.security\.test\.cjs/);
    });

    test('--shard 1/1 is a pure no-op (runs every file)', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1/1']);
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /files=9:/);
    });

    test('an empty shard (n > file count) exits 0 without crashing', () => {
      // n=5 with only 2 files: shards 3,4,5 are legitimately empty. An empty
      // shard must NOT take the "discovery is broken" hard-error path.
      seed(tmpDir, ['only-a.test.cjs', 'only-b.test.cjs']);
      const r = runHarness(tmpDir, ['--shard', '5/5']);
      assert.strictEqual(
        r.status,
        0,
        `empty shard must exit 0; got status=${r.status} signal=${r.signal}\nSTDERR:\n${r.stderr}`,
      );
    });

    test('an empty suite BEFORE sharding still hits the discovery hard error', () => {
      // Regression (Codex #1212 review): a genuinely empty selection
      // (e.g. --suite security with zero security files) must NOT be masked
      // by the empty-shard escape hatch. Only a shard that emptied a NON-empty
      // list is a legitimate no-op; a pre-empty selection is a broken filter.
      seed(tmpDir, ['a.test.cjs', 'b.test.cjs']); // unit files only, no security
      const r = runHarness(tmpDir, ['--suite', 'security', '--shard', '1/3']);
      assert.notStrictEqual(
        r.status,
        0,
        `empty-before-shard must fail; got status=${r.status}\nSTDERR:\n${r.stderr}`,
      );
      assert.match(r.stderr, /0 test files selected|discovery/i);
    });

    test('--shard over --files is order-independent (sorted before partition)', () => {
      // Regression (Codex #1212 review): the partition keys off array index,
      // so the same file set passed in different --files order must produce
      // the same per-shard assignment. The runner sorts the selection before
      // sharding to guarantee this.
      seed(tmpDir, ['x0.test.cjs', 'x1.test.cjs', 'x2.test.cjs', 'x3.test.cjs']);
      const forward = runHarness(tmpDir, [
        '--files', 'x0.test.cjs x1.test.cjs x2.test.cjs x3.test.cjs',
        '--shard', '1/2',
      ]);
      const reversed = runHarness(tmpDir, [
        '--files', 'x3.test.cjs x2.test.cjs x1.test.cjs x0.test.cjs',
        '--shard', '1/2',
      ]);
      assert.strictEqual(forward.status, 0, `stderr: ${forward.stderr}`);
      assert.strictEqual(reversed.status, 0, `stderr: ${reversed.stderr}`);
      // Both runs select the SAME files (sorted shard 1/2 of x0..x3 = x0,x2).
      const filesLine = (s) => (s.match(/files=\d+: (.*)$/m) || [])[1] || '';
      const a = filesLine(forward.stderr).split(' ').sort().join(' ');
      const b = filesLine(reversed.stderr).split(' ').sort().join(' ');
      assert.strictEqual(a, b, `order-dependent shard assignment:\nforward=${a}\nreversed=${b}`);
      assert.match(a, /x0\.test\.cjs/);
      assert.match(a, /x2\.test\.cjs/);
    });

    test('--shard rejects i outside 1..n', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '0/3']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('--shard rejects i greater than n', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '4/3']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('--shard rejects n < 1', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1/0']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('--shard rejects malformed (no slash) value', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '2']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('--shard rejects non-integer parts', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1.5/3']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /shard/i);
    });

    test('duplicate --shard flag is rejected', () => {
      seed(tmpDir, SHARD_NAMES);
      const r = runHarness(tmpDir, ['--shard', '1/3', '--shard', '2/3']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /duplicate/i);
    });

    test('--shard chunking engages within a shard (argv-overflow preserved)', () => {
      // Each shard must still chunk its own slice so a large shard cannot
      // overflow the Windows 32,767-char command-line ceiling (#3597).
      const longPrefix = 'a-deliberately-long-test-filename-to-force-chunking-within-a-shard-';
      const names = Array.from(
        { length: 30 },
        (_, i) => `${longPrefix}${String(i).padStart(4, '0')}.test.cjs`,
      );
      seed(tmpDir, names);
      // n=2 -> each shard gets 15 files; a 1500-char ceiling forces chunking.
      const r = runHarness(tmpDir, ['--shard', '1/2'], { RUN_TESTS_MAX_CMDLINE_CHARS: '1500' });
      assert.strictEqual(r.status, 0, `stderr (tail):\n${r.stderr.split('\n').slice(-20).join('\n')}`);
      assert.match(r.stderr, /run-tests: chunk \d+\/\d+ — \d+ files/);
    });
  });

  describe('per-chunk timeout + force-exit (windows hang guard, #1051)', () => {
    // A unit test that leaks an open handle (un-terminated Worker, un-killed
    // child_process, ref'd timer) causes node --test to hang ~150s after its
    // last test prints. Two such stalls push the windows full lane past its
    // 20m CI cap and the job is CANCELLED — a false-negative gate. The harness
    // now adds --test-force-exit (exits once all tests finish) and a per-chunk
    // timeout (kills a hung child loudly instead of silently burning the budget).

    // Leaky fixture: the test passes immediately, then a ref'd setInterval keeps
    // the event loop alive so `node --test` hangs unless --test-force-exit is on.
    const LEAKY_BODY = `const { test } = require('node:test');
test('passes but leaks a ref-d timer', () => {});
setInterval(() => {}, 1 << 30);
`;

    test('a hung chunk hits the per-chunk timeout and fails with a clear message', () => {
      // Regression proof: pre-fix (no timeout guard) this hung until the OS/CI
      // killed it; now it fails fast with a diagnostic message.
      fs.writeFileSync(path.join(tmpDir, 'leaky.test.cjs'), LEAKY_BODY, 'utf8');
      const r = runHarness(tmpDir, [], {
        RUN_TESTS_NO_FORCE_EXIT: '1',
        RUN_TESTS_CHUNK_TIMEOUT_MS: '2000',
      });
      assert.notStrictEqual(
        r.status,
        0,
        `expected non-zero exit from timed-out chunk; got status=${r.status}\nSTDERR:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /exceeded the per-chunk timeout/,
        `expected timeout diagnostic in stderr; STDERR:\n${r.stderr}`,
      );
    });

    test('a timed-out chunk aborts the remaining chunks instead of burning the job budget', () => {
      // Guards against a real CI failure mode (observed live on CI run
      // 29749380190, windows-latest full-lane shard 2/3): the per-chunk
      // timeout is HALF the 20m CI job cap (600000ms default vs a 1,200,000ms
      // job), so if the loop pressed on to the next chunk after a timeout
      // instead of aborting, a healthy full pass (~11m42s on that lane) could
      // never finish and the CI runner cancels the whole job. That
      // cancellation surfaces as an opaque "The operation was canceled."
      // and buries the actual timeout diagnostic thousands of lines back in
      // the log (in the real incident, ~38,000 lines from the end — and
      // `gh run view --log-failed` returned nothing). Proving chunk 2 never
      // runs pins the fix: abort the remaining chunks as soon as one times
      // out, so the loud diagnostic above survives as the visible failure.
      //
      // Force exactly one file per chunk so chunk 1 = the hanging file and
      // chunk 2 = a marker-writing file; sorted order (a- before b-, and
      // walkTestFiles(...).sort() sorts selection) fixes which chunk runs
      // first, deterministically — the margin between a 2s timeout and a
      // file that never terminates is unbounded, so there is no race.
      fs.writeFileSync(path.join(tmpDir, 'a-leaky.test.cjs'), LEAKY_BODY, 'utf8');
      const markerPath = path.join(tmpDir, 'chunk-2-ran.marker');
      const secondBody = `'use strict';
const fs = require('fs');
const { test } = require('node:test');
fs.writeFileSync(${JSON.stringify(markerPath)}, 'ran');
test('noop', () => {});
`;
      fs.writeFileSync(path.join(tmpDir, 'b-marker.test.cjs'), secondBody, 'utf8');

      const r = runHarness(tmpDir, [], {
        RUN_TESTS_NO_FORCE_EXIT: '1',
        RUN_TESTS_CHUNK_TIMEOUT_MS: '2000',
        RUN_TESTS_MAX_FILES_PER_CHUNK: '1',
      });

      assert.notStrictEqual(
        r.status,
        0,
        `expected non-zero exit from an aborted run; got status=${r.status}\nSTDERR:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /exceeded the per-chunk timeout/,
        `expected timeout diagnostic in stderr; STDERR:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /aborting — skipping the remaining 1 chunk/,
        `expected the new abort message in stderr; STDERR:\n${r.stderr}`,
      );
      assert.strictEqual(
        fs.existsSync(markerPath),
        false,
        `chunk 2's marker file must NOT exist — proves the second chunk's test file never executed; STDERR:\n${r.stderr}`,
      );
      assert.doesNotMatch(
        r.stderr,
        /chunk 2\/2/,
        `chunk 2's progress line must never print — proves the loop broke before starting chunk 2; STDERR:\n${r.stderr}`,
      );
    });

    test('force-exit lets a chunk with a leaked handle exit cleanly', () => {
      const nodeMajor = Number(process.versions.node.split('.')[0]);
      // --test-force-exit was added in Node 22; skip on older engines.
      if (nodeMajor < 22) {
        return; // skip — harness test options object not available here; just return
      }
      fs.writeFileSync(path.join(tmpDir, 'leaky.test.cjs'), LEAKY_BODY, 'utf8');
      // #4031: force-exit is ON by default only on win32 now, so opt in
      // explicitly — this test proves the flag still does its job wherever it
      // is enabled, not that it is enabled here.
      // 30s timeout: if force-exit works the child exits promptly after the test
      // passes; if force-exit failed, the 30s timeout would fire and status ≠ 0.
      const r = runHarness(tmpDir, [], {
        RUN_TESTS_FORCE_EXIT: '1',
        RUN_TESTS_NO_FORCE_EXIT: '', // blank, not absent: an ambient opt-out would win
        RUN_TESTS_CHUNK_TIMEOUT_MS: '30000',
      });
      assert.strictEqual(
        r.status,
        0,
        `expected zero exit with force-exit enabled; got status=${r.status} signal=${r.signal}\nSTDERR:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /run-tests: --test-force-exit on \(RUN_TESTS_FORCE_EXIT set\)/,
        `expected the force-exit decision line; STDERR:\n${r.stderr}`,
      );
    });
  });

  describe('--test-force-exit is scoped to win32 so reported counts stay exact (#4031)', () => {
    // Node's --test-force-exit can drop a file's TAIL of already-executed,
    // already-passing results under process isolation (nodejs/node#64833):
    // the reporter prints a smaller `# tests` total and the run exits 0. At
    // this harness's default concurrency the loss reproduced on every run on
    // Linux (worst observed 1644/2000). The fix keeps the flag only where the
    // hang it guards against lives (win32) and exposes an explicit opt-in.
    //
    // The fixture mirrors the issue's minimal reproduction: FILE_COUNT files
    // of TESTS_PER_FILE synchronous top-level tests each, the LAST of which
    // writes a sentinel to disk — so "did the tail actually execute?" is
    // answerable independently of the report the bug corrupts.
    const FILE_COUNT = 10;
    const TESTS_PER_FILE = 200;
    // Same leaky fixture as the #1051 block above (a ref'd timer keeps the
    // child's event loop alive after its only test passes).
    const LEAKY_BODY = `const { test } = require('node:test');
test('passes but leaks a ref-d timer', () => {});
setInterval(() => {}, 1 << 30);
`;
    // Passed to every default-path run below: blank both knobs so the outer
    // environment cannot select a branch on the harness's behalf.
    const FORCE_EXIT_DEFAULTS = { RUN_TESTS_FORCE_EXIT: '', RUN_TESTS_NO_FORCE_EXIT: '' };
    const NON_WIN32_ONLY = process.platform === 'win32'
      ? 'win32 keeps --test-force-exit on by design (#1051 hang guard); the count exposure there is bounded by the upstream Node fix (nodejs/node#64833)'
      : false;

    function seedTailSentinelFiles(dir, sentinelDir) {
      const names = [];
      for (let f = 0; f < FILE_COUNT; f++) {
        const tag = `f${String(f).padStart(2, '0')}`;
        const lines = ["'use strict';", "const { test } = require('node:test');", "const fs = require('fs');"];
        for (let i = 1; i < TESTS_PER_FILE; i++) {
          lines.push(`test('${tag}_t${i}', () => {});`);
        }
        const sentinel = path.join(sentinelDir, tag);
        lines.push(
          `test('${tag}_zz_sentinel', () => { fs.writeFileSync(${JSON.stringify(sentinel)}, 'ran'); });`,
        );
        const name = `${tag}.test.cjs`;
        fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`, 'utf8');
        names.push(tag);
      }
      return names;
    }

    // Sum every TAP `# <field> N` summary line the harness's chunks printed —
    // one per chunk, so summing is correct whether the fixture packs into one
    // chunk or several.
    function tapTotal(stdout, field) {
      const re = new RegExp(`^# ${field} (\\d+)$`, 'gm');
      let sum = 0;
      let seen = 0;
      for (const m of stdout.matchAll(re)) {
        sum += Number(m[1]);
        seen += 1;
      }
      return { sum, seen };
    }

    test('the default run reports every executed test — no tail truncation at the default concurrency', { skip: NON_WIN32_ONLY }, () => {
      const sentinelDir = path.join(tmpDir, 'sentinels');
      fs.mkdirSync(sentinelDir);
      const tags = seedTailSentinelFiles(tmpDir, sentinelDir);
      const expected = FILE_COUNT * TESTS_PER_FILE;

      // Defaults only — the harness's own concurrency. Both knobs are passed as
      // EMPTY strings (which the resolver treats as unset) rather than omitted,
      // so an ambient RUN_TESTS_FORCE_EXIT / RUN_TESTS_NO_FORCE_EXIT in the
      // outer CI environment cannot leak in through runHarness's process.env
      // spread and turn this into a test of that environment.
      const r = runHarness(tmpDir, [], FORCE_EXIT_DEFAULTS);

      assert.strictEqual(r.status, 0, `expected a clean pass; STDERR:\n${r.stderr}`);
      // Every file ran to its last test — execution is proven on disk, not
      // inferred from the report under test.
      assert.deepStrictEqual(
        fs.readdirSync(sentinelDir).sort(),
        tags,
        'every fixture file must have executed its final (sentinel) test',
      );
      // ...and the report accounted for all of them. Pre-fix this read a
      // smaller number at exit 0 on every run at this concurrency — this is
      // the assertion that goes red against the old runner, so it stays
      // ahead of the decision-line check below.
      const tests = tapTotal(r.stdout, 'tests');
      const pass = tapTotal(r.stdout, 'pass');
      assert.ok(tests.seen >= 1, `expected at least one TAP "# tests N" summary line; STDOUT (tail):\n${r.stdout.split('\n').slice(-15).join('\n')}`);
      assert.strictEqual(
        tests.sum,
        expected,
        `reported total must equal the registered count (${expected}) — a smaller number at exit 0 is the #4031 truncation`,
      );
      assert.strictEqual(pass.sum, expected, `reported pass count must equal ${expected}`);
      assert.match(
        r.stderr,
        /run-tests: --test-force-exit off \(/,
        `expected the non-win32 default to run WITHOUT --test-force-exit; STDERR:\n${r.stderr}`,
      );
    });

    test('the non-win32 default does not force-exit: a leaked handle is a loud per-chunk timeout, not a silent hang', { skip: NON_WIN32_ONLY }, () => {
      // The other half of the trade: without the flag a leaked handle would
      // hang the child, and the per-chunk timeout is what turns that into a
      // diagnosed failure. Pin that the default path lands there, not in a
      // clean exit that would mean the flag is still on.
      fs.writeFileSync(path.join(tmpDir, 'leaky.test.cjs'), LEAKY_BODY, 'utf8');
      const r = runHarness(tmpDir, [], { ...FORCE_EXIT_DEFAULTS, RUN_TESTS_CHUNK_TIMEOUT_MS: '2000' });
      assert.notStrictEqual(r.status, 0, `expected the leaked handle to hit the timeout; got status=${r.status}\nSTDERR:\n${r.stderr}`);
      assert.match(r.stderr, /run-tests: --test-force-exit off \(/, `STDERR:\n${r.stderr}`);
      assert.match(r.stderr, /exceeded the per-chunk timeout/, `STDERR:\n${r.stderr}`);
      // The fixture's only test must have REPORTED before the kill — that is
      // what makes this a post-test hang (the #1051 shape) and not a slow
      // start that happened to cross a 2s budget. The child streams its TAP
      // result to the parent on completion; the ref'd timer only stops the
      // exit, so the line is on stdout by the time the timeout fires.
      assert.match(
        r.stdout,
        /^ok 1 - passes but leaks a ref-d timer$/m,
        `the leaky fixture's test must have run and reported before the timeout; STDOUT:\n${r.stdout}`,
      );
    });

    test('resolveForceExit truth table: opt-out wins, then opt-in, then win32-only default', () => {
      const { resolveForceExit } = require('../scripts/run-tests.cjs');
      const on = (r) => r.forceExit === true;
      const off = (r) => r.forceExit === false;
      const cases = [
        // [platform, nodeMajor, env, expectOn, why]
        ['win32', 24, {}, on, 'win32 default keeps the #1051 hang guard'],
        ['linux', 24, {}, off, 'linux default is off (#4031)'],
        ['darwin', 24, {}, off, 'darwin default is off (#4031)'],
        ['linux', 24, { RUN_TESTS_FORCE_EXIT: '1' }, on, 'explicit opt-in enables it anywhere'],
        ['win32', 24, { RUN_TESTS_NO_FORCE_EXIT: '1' }, off, 'existing opt-out still disables it on win32'],
        ['win32', 24, { RUN_TESTS_NO_FORCE_EXIT: '1', RUN_TESTS_FORCE_EXIT: '1' }, off, 'opt-out beats opt-in'],
        ['win32', 20, {}, off, 'flag does not exist before Node 22'],
        ['linux', 20, { RUN_TESTS_FORCE_EXIT: '1' }, off, 'opt-in cannot enable a flag the engine lacks'],
        // #4031 round 1: boundary coverage for the `nodeMajor < 22` gate, per CONTEXT.md
        // RULESET.TESTS.boundary-coverage (limit-1 / limit / limit+1). Pinned to win32 with an
        // EMPTY env deliberately: that is the combination where the version gate is the only
        // thing that can produce `off`. A non-win32 row with an empty env is off under the
        // correct predicate and under `< 21`, `<= 22` and `< 23` alike, so it discriminates
        // nothing. (Setting RUN_TESTS_FORCE_EXIT would make a non-win32 row discriminate, since
        // the opt-in arm sits below the version gate — but that pins the boundary against the
        // opt-in path rather than against the default the flag actually ships with.)
        ['win32', 21, {}, off, 'limit-1: the flag does not exist on Node 21'],
        ['win32', 22, {}, on, 'limit: Node 22 is the first version carrying the flag, so the win32 default applies'],
        ['win32', 23, {}, on, 'limit+1: the win32 default still applies above the floor'],
        ['linux', 24, { RUN_TESTS_FORCE_EXIT: '' }, off, 'an empty opt-in reads as unset (any non-empty value sets it)'],
        ['win32', 24, { RUN_TESTS_NO_FORCE_EXIT: '' }, on, 'an empty opt-out reads as unset'],
      ];
      for (const [platform, nodeMajor, env, expect, why] of cases) {
        const r = resolveForceExit({ platform, nodeMajor, env });
        assert.ok(expect(r), `${why}: ${platform}/node${nodeMajor}/${JSON.stringify(env)} → ${JSON.stringify(r)}`);
        assert.strictEqual(typeof r.forceExitReason, 'string');
        assert.ok(r.forceExitReason.length > 0, 'every decision names its reason for the stderr line');
      }
    });
  });

  describe('chunk-timeout instrumentation (#3889)', () => {
    // Consolidation (CI cost, #4015): this describe block used to spawn the
    // harness once PER assertion group (3 success-path runs + 2 timeout-path
    // runs = 5 subprocess boots). Each boot is expensive — run-tests.cjs
    // starts, globs the suite, then spawns `node --test` children — so on a
    // CI shard already within ~39s of its 15-minute cap, paying for 5 boots
    // to check facts that all hold against the SAME run is wasted spend.
    // Below, exactly ONE successful run and ONE timed-out run are captured
    // once (via `before`) and every assertion group below reads from those
    // captured results instead of spawning its own. This is the whole
    // savings — no assertion is weakened or removed.
    // The fixture served to the timeout-path run below (#4105). Parks on a
    // SETTLING timer — the #4104 idiom — so the hang is a property of the
    // FIXTURE on every Node line, not of the runtime: the retired
    // `new Promise(() => {})` shape held NO libuv handle, so whether the
    // spawned child hung was decided by the Node line's test-runner shutdown
    // behavior (measured: v24/v26 happen to hold the loop open; v22.22.0
    // exits on its own in ~60ms with `# cancelled 1`, so the chunk never
    // reached the timeout path and T1/T4 below asserted nothing). The park
    // must outlast the chunk bound below with wide margin (asserted
    // structurally in the #4105 regression test), stays ~0% CPU while parked,
    // and the settle guarantees the fixture SELF-TERMINATES if a kill orphans
    // it — unlike `setInterval`-forever (never exits) or `while (true) {}`
    // (100% CPU forever), the two shapes #4104's pairing note rules out.
    const HANG_PARK_MS = 10_000;
    const HANGS_BODY = `'use strict';
const { test } = require('node:test');
test('hangs forever', () => new Promise((resolve) => { setTimeout(resolve, ${HANG_PARK_MS}); }));
`;

    // The per-chunk timeout the timeout-path run below arms. Hoisted (#4105)
    // so the #4105 fixture guard below asserts against the SAME bound the
    // harness run uses, not a re-typed literal that can drift from it.
    const CHUNK_TIMEOUT_MS_FOR_HANG_RUN = 2000;

    let successDir;
    let successRun;
    let eventsDirBefore;
    let eventsDirAfter;
    let timeoutDir;
    let timeoutRun;

    before(() => {
      // Single SUCCESS-path run, reused by T2/T3/T5 below.
      successDir = createTempDir('gsd-3889-success-');
      seed(successDir, ['a.test.cjs']);
      eventsDirBefore = fs.readdirSync(require('os').tmpdir())
        .filter((n) => n.startsWith('gsd-run-tests-events-'));
      successRun = runHarness(successDir, []);
      eventsDirAfter = fs.readdirSync(require('os').tmpdir())
        .filter((n) => n.startsWith('gsd-run-tests-events-'));

      // Single TIMEOUT-path run, reused by T1/T4 below. 2000ms is kept —
      // it is already the smallest value this suite used anywhere for the
      // per-chunk timeout, and going lower risks flaking on a loaded CI
      // box that has to boot node --test, register the hang, and observe
      // the kill inside the window.
      timeoutDir = createTempDir('gsd-3889-timeout-');
      fs.writeFileSync(path.join(timeoutDir, 'hangs.test.cjs'), HANGS_BODY, 'utf8');
      timeoutRun = runHarness(timeoutDir, [], {
        RUN_TESTS_NO_FORCE_EXIT: '1',
        RUN_TESTS_CHUNK_TIMEOUT_MS: String(CHUNK_TIMEOUT_MS_FOR_HANG_RUN),
      });
    });

    after(() => {
      cleanup(successDir);
      cleanup(timeoutDir);
    });

    // T2: per-chunk elapsed timing appears on the normal SUCCESS path, not
    // only when something goes wrong — this is what makes "which chunk is
    // drifting toward the cap" readable across ordinary green runs.
    test('a successful chunk prints its elapsed time', () => {
      assert.strictEqual(successRun.status, 0, `expected a clean pass; STDERR:\n${successRun.stderr}`);
      assert.match(
        successRun.stderr,
        /run-tests: chunk 1\/1 completed in \d+ms/,
        `expected a per-chunk completion timing line; STDERR:\n${successRun.stderr}`,
      );
    });

    // T3: the ndjson companion reporter's destination file is a temp
    // artifact of the instrumentation, not a product output — it must not
    // survive a successful run. Assert against the OS temp root's own
    // "gsd-run-tests-events-*" prefix (scripts/run-tests.cjs's mkdtemp
    // prefix) rather than any run-tests-owned directory, since that IS the
    // leak surface being guarded.
    test('the ndjson reporter temp dir is cleaned up after a successful run', () => {
      assert.strictEqual(successRun.status, 0, `expected a clean pass; STDERR:\n${successRun.stderr}`);
      assert.deepStrictEqual(
        eventsDirAfter,
        eventsDirBefore,
        `expected no leaked gsd-run-tests-events-* temp dir after a successful run; ` +
          `before=${JSON.stringify(eventsDirBefore)} after=${JSON.stringify(eventsDirAfter)}`,
      );
    });

    // T5 (regression): the human reporter's --test-reporter-destination
    // pairing must be a regular file, not os.devNull. devNull is a character
    // device; Node opens the reporter destination as an fs.WriteStream and
    // fsyncs it on close, and fsync on a character device fails with EINVAL
    // — surfaced as "Emitted 'error' event on WriteStream instance" /
    // "EINVAL: invalid argument, fsync", which crashed EVERY chunk on the
    // real remote run this regresses (43/43 failures), not only the timeout
    // path. The argv construction lives entirely inside main() with no
    // exported seam to unit-test directly (see NOTES), so this asserts the
    // closest real, externally-observable consequence: a normal successful
    // run must not surface that error text, and must still complete and
    // exit 0 — both of which a reintroduced devNull destination would break
    // on any platform where fsync(devNull) actually returns EINVAL (this
    // suite's own bench platform, historically).
    test('a successful run never surfaces the devNull fsync/EINVAL reporter crash', () => {
      assert.strictEqual(successRun.status, 0, `expected a clean pass; STDERR:\n${successRun.stderr}`);
      assert.doesNotMatch(
        successRun.stderr,
        /EINVAL|invalid argument, fsync|WriteStream instance/i,
        `expected no reporter-destination fsync crash; STDERR:\n${successRun.stderr}`,
      );
    });

    // T1: on a chunk timeout, the diagnostic must NAME the file that was
    // still executing — not merely list every file the chunk contained (the
    // pre-instrumentation behavior). A test that hangs INSIDE its own body
    // (parks on a settling timer that outlasts the chunk bound, so it never
    // resolves inside the window) keeps its test:start event unmatched by any
    // test:pass/test:fail in the ndjson companion reporter's output, which
    // is exactly the signal the diagnostic reads back on timeout.
    test('a chunk timeout names the file that was in flight when killed', () => {
      assert.notStrictEqual(
        timeoutRun.status,
        0,
        `expected non-zero exit from a timed-out chunk; got status=${timeoutRun.status}\nSTDERR:\n${timeoutRun.stderr}`,
      );
      assert.match(
        timeoutRun.stderr,
        /In flight when killed.*hangs\.test\.cjs/s,
        `expected the diagnostic to NAME the in-flight file, not just list the chunk; STDERR:\n${timeoutRun.stderr}`,
      );
    });

    // Regression (#3889 recurrence): the reporter module itself, called
    // directly with no subprocess, must return nully — this is the exact
    // contract violation (`return []`) that crashed every chunk on the real
    // remote run this file regresses ("Expected nully to be returned from
    // the 'body' function but got an instance of Array", thrown by
    // node:stream's `compose` when its async-function body returns an
    // iterable instead of undefined/null). Also pins the NDJSON side effect:
    // only the two handled event types are appended, verbatim, one per line.
    test('the reporter returns nully and appends only the handled event types as NDJSON', async () => {
      const reporter = require('../scripts/lib/ndjson-reporter.cjs');
      const eventsFile = path.join(tmpDir, 'ndjson-reporter-events.ndjson');
      const savedEventsFile = process.env.GSD_RUN_TESTS_EVENTS_FILE;
      process.env.GSD_RUN_TESTS_EVENTS_FILE = eventsFile;
      try {
        async function* fakeEvents() {
          yield { type: 'test:start', data: { file: 'a.test.cjs', name: 't', nesting: 0, testNumber: 1 } };
          yield { type: 'test:diagnostic', data: { message: 'ignored' } };
          yield { type: 'test:pass', data: { file: 'a.test.cjs', name: 't', nesting: 0, testNumber: 1 } };
        }
        const result = await reporter(fakeEvents());
        assert.strictEqual(
          result ?? null,
          null,
          `expected the reporter to return nully (undefined/null) per stream.compose's ` +
            `async-function body contract; got ${JSON.stringify(result)}`,
        );
        const rawContent = fs.readFileSync(eventsFile, 'utf8');
        const lines = splitLines(rawContent.trim()).filter((l) => l.length > 0);
        assert.strictEqual(lines.length, 3, `expected exactly 3 NDJSON lines (init marker + 2 handled events); got:\n${lines.join('\n')}`);
        const [init, start, pass] = lines.map((l) => JSON.parse(l));
        assert.strictEqual(init.type, 'reporter:init');
        assert.strictEqual(start.type, 'test:start');
        assert.strictEqual(start.file, 'a.test.cjs');
        assert.strictEqual(pass.type, 'test:pass');
        assert.strictEqual(pass.file, 'a.test.cjs');
      } finally {
        if (savedEventsFile === undefined) {
          delete process.env.GSD_RUN_TESTS_EVENTS_FILE;
        } else {
          process.env.GSD_RUN_TESTS_EVENTS_FILE = savedEventsFile;
        }
        cleanup(eventsFile);
      }
    });

    // Regression (#3889 root cause): a hang inside a test body NEVER produces
    // a `test:start`/`test:pass`/`test:fail` for that subtest (node:test only
    // surfaces those to the parent once the child reports completion), so
    // those three event types alone can never see a hang. `test:enqueue` and
    // `test:dequeue` are emitted by the RUNNER as it queues/begins a file,
    // independent of completion — this pins that the reporter now records
    // both, verbatim, for exactly the "enqueue then dequeue, then nothing"
    // shape a real hang produces.
    test('the reporter records test:enqueue and test:dequeue for the hang shape (enqueue, dequeue, nothing else)', async () => {
      const reporter = require('../scripts/lib/ndjson-reporter.cjs');
      const eventsFile = path.join(tmpDir, 'ndjson-reporter-hang-shape.ndjson');
      const savedEventsFile = process.env.GSD_RUN_TESTS_EVENTS_FILE;
      process.env.GSD_RUN_TESTS_EVENTS_FILE = eventsFile;
      try {
        async function* hangShapeEvents() {
          yield { type: 'test:enqueue', data: { file: 'hangs.test.cjs', name: 'hangs.test.cjs', nesting: 0 } };
          yield { type: 'test:dequeue', data: { file: 'hangs.test.cjs', name: 'hangs.test.cjs', nesting: 0 } };
          // Never yields test:start/test:pass/test:fail — this IS the hang.
        }
        const result = await reporter(hangShapeEvents());
        assert.strictEqual(result ?? null, null);
        const rawContent = fs.readFileSync(eventsFile, 'utf8');
        const lines = splitLines(rawContent.trim()).filter((l) => l.length > 0);
        assert.strictEqual(
          lines.length,
          3,
          `expected exactly 3 NDJSON lines (init marker + enqueue + dequeue); got:\n${lines.join('\n')}`,
        );
        const [init, enqueue, dequeue] = lines.map((l) => JSON.parse(l));
        assert.strictEqual(init.type, 'reporter:init');
        assert.strictEqual(enqueue.type, 'test:enqueue');
        assert.strictEqual(enqueue.file, 'hangs.test.cjs');
        assert.strictEqual(dequeue.type, 'test:dequeue');
        assert.strictEqual(dequeue.file, 'hangs.test.cjs');
      } finally {
        if (savedEventsFile === undefined) {
          delete process.env.GSD_RUN_TESTS_EVENTS_FILE;
        } else {
          process.env.GSD_RUN_TESTS_EVENTS_FILE = savedEventsFile;
        }
        cleanup(eventsFile);
      }
    });

    // #3889: the init marker is the reporter's FIRST action, written before
    // the `for await` loop even begins — so it must land even when the
    // source event stream yields ZERO events (e.g. the child is killed
    // before node:test emits anything). This pins the marker's whole
    // purpose: its presence alone proves the reporter module loaded and was
    // invoked, independent of whether any test ever started.
    test('the reporter writes only the init marker when the source yields zero events', async () => {
      const reporter = require('../scripts/lib/ndjson-reporter.cjs');
      const eventsFile = path.join(tmpDir, 'ndjson-reporter-init-only.ndjson');
      const savedEventsFile = process.env.GSD_RUN_TESTS_EVENTS_FILE;
      process.env.GSD_RUN_TESTS_EVENTS_FILE = eventsFile;
      try {
        async function* emptyEvents() {}
        const result = await reporter(emptyEvents());
        assert.strictEqual(
          result ?? null,
          null,
          `expected the reporter to return nully even with zero source events; got ${JSON.stringify(result)}`,
        );
        const rawContent = fs.readFileSync(eventsFile, 'utf8');
        const lines = splitLines(rawContent.trim()).filter((l) => l.length > 0);
        assert.strictEqual(
          lines.length,
          1,
          `expected exactly 1 NDJSON line (the init marker only); got:\n${lines.join('\n')}`,
        );
        const [init] = lines.map((l) => JSON.parse(l));
        assert.strictEqual(init.type, 'reporter:init');
        assert.strictEqual(typeof init.ts, 'number');
      } finally {
        if (savedEventsFile === undefined) {
          delete process.env.GSD_RUN_TESTS_EVENTS_FILE;
        } else {
          process.env.GSD_RUN_TESTS_EVENTS_FILE = savedEventsFile;
        }
        cleanup(eventsFile);
      }
    });

    // T4: the pre-existing timeout / abort / force-exit behavior (#1051)
    // still holds with the reporter instrumentation wired in — the new
    // --test-reporter flags must not change detection, the abort-on-timeout
    // control flow, or the exit code.
    test('existing timeout diagnostic and abort behavior are unchanged', () => {
      assert.notStrictEqual(timeoutRun.status, 0, `expected non-zero exit; STDERR:\n${timeoutRun.stderr}`);
      assert.match(
        timeoutRun.stderr,
        /exceeded the per-chunk timeout/,
        `expected the original timeout diagnostic wording to survive; STDERR:\n${timeoutRun.stderr}`,
      );
      assert.match(
        timeoutRun.stderr,
        /run-tests: chunk 1\/1 was killed after \d+ms/,
        `expected the new killed/elapsed line; STDERR:\n${timeoutRun.stderr}`,
      );
    });

    // Regression (#4105): T1/T4 above are only meaningful if the fixture
    // above GENUINELY hangs, and the hang must be a property of the FIXTURE,
    // not of the runtime's test-runner shutdown behavior. A never-settling
    // `new Promise(() => {})` holds NO libuv handle, so whether the spawned
    // child hangs is decided by the Node line: on v24/v26 the runner happens
    // to hold the loop open, but on v22 the child exits on its own in ~60ms
    // (`# cancelled 1`, rc=1) — the chunk then never reaches the timeout path
    // and T1/T4 assert nothing about the timeout diagnostic (measured:
    // v22.22.0 `node --test` exits after 61ms). RED at this test's introducing
    // sha against the then-current body: on Node 24 it fails the
    // self-termination arm (an unheld never-settling promise also never
    // self-terminates on lines where the runner DOES hold it open), and on
    // off-24 lines it fails the still-hanging arm. Deterministic guard, the
    // #4104 self-exit regression's event-driven shape: spawn the EXACT served
    // body directly — no harness, no runner, no polling — and observe that its
    // natural 'exit' event (a) arrives no earlier than past the chunk bound
    // the harness run above arms (it hangs by itself, without any runtime
    // holding it up), and (b) carries a natural exit — exit code 0, no
    // signal. The `{ timeout: 2 * HANG_PARK_MS }` backstop (the
    // health-validation #663 pattern) fails an immortal body — one that never
    // delivers 'exit' — instead of hanging the suite; a `{ timeout }` option
    // is the no-elapsed-assertion-compliant bound. Liveness of a SUBPROCESS
    // cannot be driven through the clock seam (mock.timers cannot reach
    // inside a separately spawned node), so the guard asserts observable
    // exit/signal/liveness behavior only — never a measured duration value
    // (RULESET.TESTS.no-timing-assertion).
    test('the #3889 hang fixture genuinely hangs by itself and self-terminates (#4105)', { timeout: 2 * HANG_PARK_MS }, (t, done) => {
      // (a) Structural margin, single-sourced with the served body: the park
      // must outlast the chunk bound by >= 4x, so a loaded box's scheduling
      // jitter can never let the timer settle before the harness kill fires.
      assert.ok(
        HANG_PARK_MS >= 4 * CHUNK_TIMEOUT_MS_FOR_HANG_RUN,
        `fixture park (${HANG_PARK_MS}ms) must exceed the chunk bound (${CHUNK_TIMEOUT_MS_FOR_HANG_RUN}ms) with margin`,
      );
      const dir = createTempDir('gsd-3889-hang-fixture-');
      t.after(() => cleanup(dir));
      const tf = path.join(dir, 'hangs.test.cjs');
      fs.writeFileSync(tf, HANGS_BODY, 'utf8');
      const child = spawn(process.execPath, [tf], { stdio: 'ignore' });
      // The runner timeout above fails an immortal body; this hook guarantees
      // the child is reaped on every exit path, including that one.
      t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
      const spawnedAt = Date.now();
      // Past the chunk bound the harness kills at: the fixture's natural exit
      // must arrive no earlier than this — that is the vacuity guard. +400ms
      // covers child spawn startup so the checkpoint measures the fixture,
      // not boot time.
      const stillHangingAt = spawnedAt + CHUNK_TIMEOUT_MS_FOR_HANG_RUN + 400;
      // Fast-fail on a spawn error (execPath unspawnable): 'exit' never fires
      // for a failed spawn, so without this the runner timeout would expire
      // with a generic timeout message instead of the real cause (same
      // hardening as #4104).
      child.on('error', (err) => {
        assert.fail(`could not spawn the fixture directly: ${err.message}`);
      });
      // `exitCode !== null` alone misses a SIGNALED exit (exitCode stays null
      // when a signal ends the child); the assertions name signalCode as the
      // failure when that happens.
      child.on('exit', () => {
        assert.ok(
          Date.now() >= stillHangingAt,
          `fixture must still be hanging past the ${CHUNK_TIMEOUT_MS_FOR_HANG_RUN}ms chunk bound — ` +
            `it exited after only ${Date.now() - spawnedAt}ms ` +
            '(#4105 regression: the hang is the runtime\'s, not the fixture\'s)',
        );
        assert.strictEqual(child.signalCode, null,
          'fixture must SELF-terminate (natural exit) — a signal means we had to kill it (#4105/#4104 regression)');
        assert.strictEqual(child.exitCode, 0, 'the parked fixture settles and its test passes cleanly');
        done();
      });
    });
  });
});

// Pure partition contract for the shard selector (#1212). Imported directly
// (no subprocess) because these are deterministic in-memory assertions about
// the round-robin partition — the cheapest, most precise way to pin
// completeness / disjointness / balance / determinism, including a fast-check
// property test (RULESET.TESTS.property-based-testing: partition is a
// bijective transformation contract).
const { parseShardArg, selectShard } = require('../scripts/run-tests.cjs');

describe('selectShard round-robin partition (#1212)', () => {
  // A deterministic sorted file list; selectShard MUST NOT re-sort — the caller
  // sorts once and the partition keys off array index so ordering is identical
  // across Windows/macOS/Linux.
  const files = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(3, '0')}.test.cjs`);

  test('n=1 returns the full list unchanged (pure no-op)', () => {
    assert.deepStrictEqual(selectShard(files, { index: 1, total: 1 }), files);
  });

  test('completeness: the union of all shards equals the full list', () => {
    const n = 4;
    const union = [];
    for (let i = 1; i <= n; i++) union.push(...selectShard(files, { index: i, total: n }));
    assert.deepStrictEqual([...union].sort(), [...files].sort());
  });

  test('disjointness: no file appears in two shards', () => {
    const n = 4;
    const seen = new Set();
    for (let i = 1; i <= n; i++) {
      for (const f of selectShard(files, { index: i, total: n })) {
        assert.ok(!seen.has(f), `file ${f} appeared in more than one shard`);
        seen.add(f);
      }
    }
    assert.strictEqual(seen.size, files.length);
  });

  test('balance: shard sizes differ by at most 1', () => {
    const n = 4;
    const sizes = [];
    for (let i = 1; i <= n; i++) sizes.push(selectShard(files, { index: i, total: n }).length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes=${sizes}`);
  });

  test('determinism: same input yields the same partition', () => {
    const a = selectShard(files, { index: 2, total: 3 });
    const b = selectShard(files, { index: 2, total: 3 });
    assert.deepStrictEqual(a, b);
  });

  test('round-robin: shard i gets indices i-1, i-1+n, i-1+2n, …', () => {
    const n = 3;
    assert.deepStrictEqual(
      selectShard(files, { index: 1, total: n }),
      files.filter((_, k) => k % n === 0),
    );
    assert.deepStrictEqual(
      selectShard(files, { index: 2, total: n }),
      files.filter((_, k) => k % n === 1),
    );
    assert.deepStrictEqual(
      selectShard(files, { index: 3, total: n }),
      files.filter((_, k) => k % n === 2),
    );
  });

  test('preserves relative order within a shard', () => {
    const slice = selectShard(files, { index: 1, total: 3 });
    const sorted = [...slice].sort();
    assert.deepStrictEqual(slice, sorted);
  });

  test('empty shard when total > file count returns []', () => {
    const two = ['a.test.cjs', 'b.test.cjs'];
    assert.deepStrictEqual(selectShard(two, { index: 5, total: 5 }), []);
    assert.deepStrictEqual(selectShard(two, { index: 3, total: 5 }), []);
    // shards 1 and 2 still get the two files
    assert.deepStrictEqual(selectShard(two, { index: 1, total: 5 }), ['a.test.cjs']);
    assert.deepStrictEqual(selectShard(two, { index: 2, total: 5 }), ['b.test.cjs']);
  });

  test('boundary: total exactly equals file count → one file per shard', () => {
    const three = ['a.test.cjs', 'b.test.cjs', 'c.test.cjs'];
    for (let i = 1; i <= 3; i++) {
      assert.strictEqual(selectShard(three, { index: i, total: 3 }).length, 1);
    }
  });

  test('boundary: total = count-1 and count+1', () => {
    const four = ['a.test.cjs', 'b.test.cjs', 'c.test.cjs', 'd.test.cjs'];
    // count-1 = 3 shards over 4 files → sizes {2,1,1}
    const sizes3 = [1, 2, 3].map(i => selectShard(four, { index: i, total: 3 }).length).sort();
    assert.deepStrictEqual(sizes3, [1, 1, 2]);
    // count+1 = 5 shards over 4 files → one shard empty
    const sizes5 = [1, 2, 3, 4, 5].map(i => selectShard(four, { index: i, total: 5 }).length).sort();
    assert.deepStrictEqual(sizes5, [0, 1, 1, 1, 1]);
  });

  test('property: partition is complete, disjoint, and balanced for any n,N', () => {
    const fc = require('fast-check');
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 12 }),
        (rawFiles, n) => {
          // Caller contract: deduped + sorted list. Mirror it so the property
          // exercises the same shape the runner feeds selectShard.
          const list = [...new Set(rawFiles)].sort();
          const shards = [];
          for (let i = 1; i <= n; i++) shards.push(selectShard(list, { index: i, total: n }));
          // completeness + disjointness
          const flat = shards.flat();
          assert.deepStrictEqual([...flat].sort(), [...list].sort());
          assert.strictEqual(new Set(flat).size, list.length);
          // balance — shard sizes differ by at most 1 (sizes is never empty
          // because n >= 1, so there is always at least one shard).
          const sizes = shards.map(s => s.length);
          assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes=${sizes}`);
        },
      ),
      // Seed pinned so a failure is reproducible (repo convention for property
      // tests); previously unseeded, flagged by the #2472 isolated review.
      { numRuns: 200, seed: 12120 },
    );
  });
});

// ─── #2472: weight-aware shard partition ────────────────────────────────────
//
// Equal file COUNTS is not equal file COST. Round-robin by array index balances
// the former and ignores the latter, which on the real suite produced Windows
// shard weights of 12.4m / 19.2m / 15.2m against a 20-minute job cap — a 1.23x
// max/ideal ratio and a 5%-of-cap margin on the heaviest shard. Adding any test
// file re-indexed the partition and tipped it over (#2472).
//
// Passing a weigher switches the partition to LPT (longest-processing-time
// first), the same algorithm packChunks already uses one level down (#2456 /
// #2463), so both layers share one cost model. Omitting the weigher keeps the
// legacy round-robin exactly — every test above still exercises that path.

describe('selectShard weight-aware partition (#2472)', () => {
  const fc = require('fast-check');

  const shardWeights = (files, total, weightOf) => {
    const out = [];
    for (let i = 1; i <= total; i++) {
      out.push(selectShard(files, { index: i, total }, weightOf).reduce((a, f) => a + weightOf(f), 0));
    }
    return out;
  };

  // The regression: a right-skewed cost distribution (the real suite's shape —
  // a few dominant files among many cheap ones) laid out so that filename order
  // clusters the heavy files onto one shard.
  const skewed = {
    'a01.test.cjs': 30000, 'a02.test.cjs': 100, 'a03.test.cjs': 100,
    'a04.test.cjs': 28000, 'a05.test.cjs': 100, 'a06.test.cjs': 100,
    'a07.test.cjs': 26000, 'a08.test.cjs': 100, 'a09.test.cjs': 100,
    'a10.test.cjs': 24000, 'a11.test.cjs': 100, 'a12.test.cjs': 100,
  };
  const skewedFiles = Object.keys(skewed).sort();
  const skewedWeight = (f) => skewed[f];

  test('REGRESSION: round-robin clusters heavy files; LPT does not', () => {
    const ideal = Object.values(skewed).reduce((a, b) => a + b, 0) / 3;

    // Legacy partition (no weigher) scored with the same cost function, so the
    // two strategies are compared on identical inputs.
    const rr = [1, 2, 3].map((i) =>
      selectShard(skewedFiles, { index: i, total: 3 }).reduce((a, f) => a + skewedWeight(f), 0));
    const lpt = shardWeights(skewedFiles, 3, skewedWeight);

    // Every heavy file sits at an index ≡ 0 (mod 3), so round-robin hands them
    // all to shard 1 — the exact clustering that produced the 19-minute shard.
    assert.ok(
      Math.max(...rr) / ideal > 1.5,
      `round-robin should be badly imbalanced on skewed costs; got ${rr} (ideal ${ideal})`,
    );
    // Graham's list-scheduling bound: makespan <= average + heaviest item. This
    // is the bound that is actually provable. The 4/3 figure quoted for LPT is
    // relative to the OPTIMAL makespan, not to the average — and the two differ
    // whenever item sizes force a pairing, as they do here: four items above
    // 24000 into three bins means some bin holds two of them, so 50000 is
    // optimal even though the average is 36267.
    const heaviest = Math.max(...Object.values(skewed));
    assert.ok(
      Math.max(...lpt) <= ideal + heaviest,
      `LPT must hold the average+max bound; got ${lpt} (bound ${ideal + heaviest})`,
    );
    assert.ok(
      Math.max(...lpt) < Math.max(...rr),
      `LPT must beat round-robin on skewed costs; lpt=${lpt} rr=${rr}`,
    );
  });

  test('back-compat: omitting the weigher reproduces round-robin exactly', () => {
    for (let i = 1; i <= 3; i++) {
      assert.deepStrictEqual(
        selectShard(skewedFiles, { index: i, total: 3 }),
        skewedFiles.filter((_, k) => k % 3 === i - 1),
        'the unweighted path must stay byte-identical to the legacy partition',
      );
    }
  });

  test('a uniform weigher degenerates to equal counts', () => {
    const sizes = [1, 2, 3].map(
      (i) => selectShard(skewedFiles, { index: i, total: 3 }, () => 1).length,
    );
    assert.ok(
      Math.max(...sizes) - Math.min(...sizes) <= 1,
      `equal weights must give equal counts; got ${sizes}`,
    );
  });

  test('n=1 is still a pure no-op with a weigher', () => {
    assert.deepStrictEqual(selectShard(skewedFiles, { index: 1, total: 1 }, skewedWeight), skewedFiles);
  });

  test('preserves the caller sort order within a weighted shard', () => {
    const slice = selectShard(skewedFiles, { index: 1, total: 3 }, skewedWeight);
    assert.deepStrictEqual(slice, [...slice].sort(), 'downstream chunking assumes caller order');
  });

  test('determinism: the weighted partition is stable across calls', () => {
    const a = selectShard(skewedFiles, { index: 2, total: 3 }, skewedWeight);
    const b = selectShard(skewedFiles, { index: 2, total: 3 }, skewedWeight);
    assert.deepStrictEqual(a, b);
  });

  test('ties break deterministically, not by object iteration order', () => {
    const flat = () => 5;
    const a = selectShard(skewedFiles, { index: 1, total: 3 }, flat);
    const b = selectShard([...skewedFiles], { index: 1, total: 3 }, flat);
    assert.deepStrictEqual(a, b, 'equal weights must still partition identically');
  });

  // A partition is a covering contract: every file lands in exactly one shard.
  // Getting this wrong silently DROPS tests from CI — the worst possible failure
  // mode for a test harness — so it is property-tested rather than sampled.
  test('property: the weighted partition is exhaustive and disjoint', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 60000 }), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 1, max: 8 }),
        (weights, total) => {
          const files = weights.map((_, i) => `p${String(i).padStart(3, '0')}.test.cjs`);
          const w = (f) => weights[Number(f.slice(1, 4))];
          const seen = [];
          for (let i = 1; i <= total; i++) seen.push(...selectShard(files, { index: i, total }, w));
          assert.strictEqual(new Set(seen).size, seen.length, 'a file appeared in two shards');
          assert.deepStrictEqual([...seen].sort(), [...files].sort(), 'a file was dropped or invented');
        },
      ),
      { numRuns: 200, seed: 24720 },
    );
  });

  // Graham's bound for any greedy-into-lightest schedule, and the reason the
  // shard cap stops being reachable: the heaviest shard cannot exceed the
  // average by more than one file's cost, however the names happen to sort.
  test('property: no shard exceeds average + heaviest file', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 60000 }), { minLength: 3, maxLength: 60 }),
        fc.integer({ min: 2, max: 6 }),
        (weights, total) => {
          const files = weights.map((_, i) => `p${String(i).padStart(3, '0')}.test.cjs`);
          const w = (f) => weights[Number(f.slice(1, 4))];
          const sums = shardWeights(files, total, w);
          const bound = weights.reduce((a, b) => a + b, 0) / total + Math.max(...weights);
          assert.ok(
            Math.max(...sums) <= bound + 1e-9,
            `bound violated: max=${Math.max(...sums)} bound=${bound}`,
          );
        },
      ),
      { numRuns: 200, seed: 24721 },
    );
  });

  // Deliberately NOT asserted: "weighted is never worse than round-robin".
  // fast-check falsifies it — weights [19316,10190,1,9128,29353,20227] over 2
  // shards give round-robin 48670 and LPT 48671. Round-robin can win by luck on
  // a specific input; LPT's guarantee is the worst-case bound above, not
  // universal dominance. The value for #2472 is that the bound holds for EVERY
  // distribution, so no arrangement of filenames can produce the 1.23x cluster
  // that round-robin allowed — which the skewed regression above pins directly.

  // Zero-weight regression (isolated review, HIGH). Adding a zero-weight file
  // leaves its bin's weight unchanged, so a weight-only tiebreak kept bin 0
  // tied-minimum forever and every such file landed there: all-zero weights put
  // the entire suite on shard 1 and left the other runners idle. Reachable via
  // safeWeight's clamp of a NaN/negative/Infinity entry, or any genuine 0ms
  // measurement. The file-count tiebreak is what makes ties rotate.
  test('REGRESSION: zero weights still split evenly across shards', () => {
    const files = Array.from({ length: 9 }, (_, i) => `z${i}.test.cjs`);
    const sizes = [1, 2, 3].map((i) => selectShard(files, { index: i, total: 3 }, () => 0).length);
    assert.deepStrictEqual(sizes, [3, 3, 3], `all-zero weights must not collapse onto one shard; got ${sizes}`);
  });

  test('REGRESSION: clamped NaN/negative/Infinity weights do not collapse', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `${x}.test.cjs`);
    const hostile = { 'a.test.cjs': NaN, 'b.test.cjs': -5, 'c.test.cjs': Infinity };
    const sizes = [1, 2, 3].map(
      (i) => selectShard(files, { index: i, total: 3 }, (f) => (f in hostile ? hostile[f] : 1)).length,
    );
    assert.ok(
      Math.max(...sizes) - Math.min(...sizes) <= 1,
      `weights that clamp to 0 must still spread; got ${sizes}`,
    );
  });

  test('property: zero weights spread evenly for any list size and shard count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 2, max: 6 }),
        (n, total) => {
          const files = Array.from({ length: n }, (_, i) => `p${String(i).padStart(3, '0')}.test.cjs`);
          const sizes = Array.from({ length: total }, (_, i) =>
            selectShard(files, { index: i + 1, total }, () => 0).length);
          assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes=${sizes}`);
        },
      ),
      { numRuns: 200, seed: 24723 },
    );
  });
});

// ─── #4070: reserved-weight shard partition ─────────────────────────────────
//
// `test.yml`'s `scope: full` lane tacks four unsharded aux suites
// (integration/security/install/slow) onto shard 1 only, outside this
// packer's model entirely — it balances the UNIT-TEST slice as if all three
// shards carried equal fixed cost, when shard 1 actually carries a fixed
// aux-suite overhead the other two do not. `initialWeights` lets a caller
// give one (or more) bins a virtual head start before LPT places any real
// file, so the algorithm converges on equalizing FINAL total cost (reserve +
// assigned files) instead of raw assigned-file weight alone — the same
// "greedy into the lightest bin" placement rule, just with non-zero starting
// points.
describe('selectShard reserved-weight partition (#4070)', () => {
  const fc = require('fast-check');

  const uniform = Array.from({ length: 30 }, (_, i) => `u${String(i).padStart(3, '0')}.test.cjs`);
  const uniformWeight = () => 10;

  const finalTotals = (files, total, weightOf, initialWeights) => {
    const out = [];
    for (let i = 1; i <= total; i++) {
      const assigned = selectShard(files, { index: i, total }, weightOf, initialWeights)
        .reduce((a, f) => a + weightOf(f), 0);
      out.push(assigned + ((initialWeights && initialWeights[i - 1]) || 0));
    }
    return out;
  };

  // The regression: without reserve support, bin 0 gets an EQUAL share of
  // files despite already carrying a head start, so its true final total
  // (assigned + reserve) sits well above the other bins' — exactly the shard
  // 1 overload this issue reports. With reserve support, LPT starts bin 0
  // "already heavier" and hands it fewer files so all three converge.
  test('REGRESSION: an initial reserve on one bin rebalances the rest (#4070)', () => {
    const reserve = 80; // 8 average-cost files' worth, on a 30-file/300-weight suite
    const totals = finalTotals(uniform, 3, uniformWeight, [reserve, 0, 0]);
    const spread = Math.max(...totals) - Math.min(...totals);
    assert.ok(
      spread <= uniformWeight(),
      `a reserved bin must converge toward the others' final totals (within one file's `
      + `weight), not just add the reserve on top of an equal share; got totals=${totals} `
      + `(spread=${spread})`,
    );
    // The reserved bin must have been handed FEWER files than an unreserved bin —
    // otherwise "rebalancing" did nothing and the reserve is purely additive.
    const reservedBinFiles = selectShard(uniform, { index: 1, total: 3 }, uniformWeight, [reserve, 0, 0]).length;
    const unreservedBinFiles = selectShard(uniform, { index: 2, total: 3 }, uniformWeight, [reserve, 0, 0]).length;
    assert.ok(
      reservedBinFiles < unreservedBinFiles,
      `the reserved bin (${reservedBinFiles} files) must receive fewer files than an `
      + `unreserved bin (${unreservedBinFiles}) — otherwise the reserve had no effect on `
      + 'placement',
    );
  });

  test('back-compat: omitting initialWeights reproduces the unreserved partition exactly', () => {
    for (let i = 1; i <= 3; i++) {
      assert.deepStrictEqual(
        selectShard(uniform, { index: i, total: 3 }, uniformWeight),
        selectShard(uniform, { index: i, total: 3 }, uniformWeight, undefined),
      );
    }
  });

  test('a zero reserve is a no-op', () => {
    for (let i = 1; i <= 3; i++) {
      assert.deepStrictEqual(
        selectShard(uniform, { index: i, total: 3 }, uniformWeight),
        selectShard(uniform, { index: i, total: 3 }, uniformWeight, [0, 0, 0]),
      );
    }
  });

  test('a reserve applies to any bin index, not only the first', () => {
    const reserve = 80;
    const totals = finalTotals(uniform, 3, uniformWeight, [0, reserve, 0]);
    const spread = Math.max(...totals) - Math.min(...totals);
    assert.ok(spread <= uniformWeight(), `expected convergence around index 2; got ${totals}`);
    const reservedBinFiles = selectShard(uniform, { index: 2, total: 3 }, uniformWeight, [0, reserve, 0]).length;
    const otherBinFiles = selectShard(uniform, { index: 1, total: 3 }, uniformWeight, [0, reserve, 0]).length;
    assert.ok(reservedBinFiles < otherBinFiles, `reserved bin 2 should get fewer files; got ${reservedBinFiles} vs ${otherBinFiles}`);
  });

  test('REGRESSION: a reserve larger than the whole suite still terminates and assigns every file', () => {
    const reserve = 1e9;
    const shards = [];
    for (let i = 1; i <= 3; i++) shards.push(selectShard(uniform, { index: i, total: 3 }, uniformWeight, [reserve, 0, 0]));
    const flat = shards.flat();
    assert.deepStrictEqual([...flat].sort(), [...uniform].sort(), 'every file must still be placed exactly once');
    // The massively-reserved bin should get the fewest (possibly zero) files.
    assert.ok(shards[0].length <= shards[1].length && shards[0].length <= shards[2].length);
  });

  test('REGRESSION: a hostile reserve value clamps to zero instead of poisoning placement', () => {
    for (const hostile of [NaN, -5, Infinity]) {
      const shards = [];
      for (let i = 1; i <= 3; i++) shards.push(selectShard(uniform, { index: i, total: 3 }, uniformWeight, [hostile, 0, 0]));
      const sizes = shards.map((s) => s.length);
      assert.ok(
        Math.max(...sizes) - Math.min(...sizes) <= 1,
        `a hostile reserve (${hostile}) must clamp to 0, not collapse/starve a bin; sizes=${sizes}`,
      );
    }
  });

  // Generalizes the existing "no shard exceeds average + heaviest file" bound
  // (#2472) to include a single reserved bin — but the Graham-style proof
  // (the max-load bin was the argmin, hence <= average, at the moment its
  // LAST item was placed) only applies to a bin that actually received at
  // least one item. A reserve large enough that its bin never receives any
  // real item stays at EXACTLY its initial reserve forever — no amount of
  // routing real items elsewhere can dilute a fixed head start below itself
  // — so the true bound is the LARGER of the classic Graham term and the
  // single biggest reserve. (Counterexample that falsified the original,
  // reserve-blind-to-domination version of this bound: weights=[1,1,1],
  // total=2, reserve=6 on bin 0 — bin 0 receives zero items and stays at 6,
  // while (sum+reserve)/total+max = 4.5+1 = 5.5 < 6.)
  test('property: no shard exceeds max(reserve, average(+reserve) + heaviest file)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 60000 }), { minLength: 3, maxLength: 60 }),
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 200000 }),
        fc.integer({ min: 0, max: 5 }),
        (weights, total, reserve, reserveIdxRaw) => {
          const files = weights.map((_, i) => `p${String(i).padStart(3, '0')}.test.cjs`);
          const w = (f) => weights[Number(f.slice(1, 4))];
          const reserveIdx = reserveIdxRaw % total;
          const initialWeights = Array.from({ length: total }, (_, i) => (i === reserveIdx ? reserve : 0));
          const sums = finalTotals(files, total, w, initialWeights);
          const grahamBound = (weights.reduce((a, b) => a + b, 0) + reserve) / total + Math.max(...weights);
          const bound = Math.max(reserve, grahamBound);
          assert.ok(
            Math.max(...sums) <= bound + 1e-9,
            `bound violated: max=${Math.max(...sums)} bound=${bound} sums=${sums}`,
          );
        },
      ),
      { numRuns: 200, seed: 24724 },
    );
  });
});

describe('parseShardArg (#1212)', () => {
  test('parses i/n into { index, total }', () => {
    assert.deepStrictEqual(parseShardArg('2/3'), { index: 2, total: 3 });
    assert.deepStrictEqual(parseShardArg('1/1'), { index: 1, total: 1 });
  });

  const bad = ['', '2', '0/3', '4/3', '1/0', '-1/3', '1.5/3', 'a/b', '1/3/2', ' 1/3', '1 / 3'];
  for (const v of bad) {
    test(`rejects malformed/out-of-range value ${JSON.stringify(v)}`, () => {
      const r = parseShardArg(v);
      assert.ok(r && r.error, `expected an error result for ${JSON.stringify(v)}, got ${JSON.stringify(r)}`);
    });
  }
});

// #4070: RUN_TESTS_SHARD_RESERVE env-var grammar — "<index>:<weight>", the
// operator knob test.yml uses to tell the full-scope lane's unit-test shard
// selection that shard 1 already carries a fixed aux-suite cost. Fail-open
// on anything malformed (mirrors positiveNumberEnv's precedent elsewhere in
// this file): a typo must degrade to "no reserve", never poison placement or
// throw and take the whole CI job down with it.
describe('parseShardReserve (#4070)', () => {
  const { parseShardReserve } = require('../scripts/run-tests.cjs');

  test('parses "<index>:<weight>" into { index, weight }', () => {
    assert.deepEqual(parseShardReserve('1:77'), { index: 1, weight: 77 });
    assert.deepEqual(parseShardReserve('2:0'), { index: 2, weight: 0 });
    assert.deepEqual(parseShardReserve('3:12.5'), { index: 3, weight: 12.5 });
  });

  for (const v of [undefined, null, '', '  ', 'x', '1', '1:', ':77', '0:77', '-1:77', '1:-5', '1.5:77', '1:abc', 'a:b', '1:2:3']) {
    test(`rejects malformed value ${JSON.stringify(v)}`, () => {
      assert.equal(parseShardReserve(v), null, `expected null for ${JSON.stringify(v)}`);
    });
  }

  test('whitespace around a valid value is tolerated', () => {
    assert.deepEqual(parseShardReserve(' 1:77 '), { index: 1, weight: 77 });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-969-test-infra-flake-hardening.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-969-test-infra-flake-hardening (consolidation epic #1969 B6 #1975)", () => {
'use strict';
/**
 * Regression tests for bug #969 — test-infra flake hardening.
 *
 * Two root causes addressed:
 *
 *  A. SIGNATURE A: "X is not a function"
 *     ensureBuiltArtifacts() previously short-circuited on a single sentinel
 *     (semver-compare.cjs). If any other migrated .cjs was stale or absent,
 *     it would be silently loaded in that broken state. This test proves the
 *     unconditional-build fix: deleting a non-sentinel artifact and invoking
 *     ensureBuiltArtifacts() regenerates it even when the sentinel is present.
 *
 *  B. SIGNATURE B: misleading assertion failures from killed subprocesses
 *     runGsdTools() previously had no timeout, so an OOM/SIGKILL'd subprocess
 *     returned { success: false } and looked like a product error. This test
 *     proves the kill-discrimination fix: a killed/timed-out invocation now
 *     throws a labeled resource-starvation error, while a clean non-zero exit
 *     still returns { success: false, exitCode: N }.
 *
 *  C. SIGNATURE C: "Failed to install hooks: directory is empty" in scoped CI
 *     hooks/dist is gitignored and NOT built by `prepare` (build:lib only), so
 *     the scoped test lane starts with it absent. The first install test's
 *     before() hook triggers build-hooks.js, which creates DIST_DIR empty then
 *     fills it file-by-file — a window where a concurrently-spawned install
 *     reader sees zero hooks and hard-fails. ensureBuiltHooks() builds hooks/dist
 *     ONCE upfront (same chokepoint as ensureBuiltArtifacts) so the empty window
 *     never exists during concurrent test execution. These tests prove it
 *     rebuilds when dist is absent/empty/incomplete and no-ops when complete.
 *
 * RULESET.TESTS.regression-must-fail-first: each test section documents what
 * the old behavior would have been (fail-before) and asserts the new behavior
 * (pass-after), using only behavioral invocations — no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { ensureBuiltArtifacts, ensureBuiltHooks } = require('../scripts/run-tests.cjs');
const { cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Part A — ensureBuiltArtifacts: unconditional rebuild
// ---------------------------------------------------------------------------

describe('bug #969 A — ensureBuiltArtifacts rebuilds stale artifacts', () => {
  /**
   * Helper: create a self-contained temp TypeScript project with two source files
   * (sentinelmod.cts and targetmod.cts) and a tsconfig that emits to <tmp>/out.
   * Returns { tmp, overrides, sentinelOut, targetOut, tsBuildInfoPath }.
   *
   * HERMETIC: all destructive tests use this helper. They NEVER touch the real
   * gsd-core/bin/lib/*.cjs or the real tsbuildinfo. (Regression from #996 fixed here.)
   */
  function makeTempProject() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug969-'));
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    const tsBuildInfoPath = path.join(outDir, '.tsbuildinfo');
    const tsconfigPath = path.join(tmp, 'tsconfig.build.json');

    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'sentinelmod.cts'), 'export const sentinelValue = 1;\n');
    fs.writeFileSync(path.join(srcDir, 'targetmod.cts'), 'export const targetValue = 2;\n');

    fs.writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: {
        rootDir: 'src',
        outDir: 'out',
        module: 'commonjs',
        target: 'es2022',
        esModuleInterop: true,
        noEmitOnError: true,
        incremental: true,
        tsBuildInfoFile: 'out/.tsbuildinfo',
      },
      include: ['src/**/*.cts'],
    }, null, 2));

    const overrides = { root: tmp, srcDir, outDir, tsBuildInfoPath, tsconfigPath };
    const sentinelOut = path.join(outDir, 'sentinelmod.cjs');
    const targetOut = path.join(outDir, 'targetmod.cjs');
    return { tmp, overrides, sentinelOut, targetOut, tsBuildInfoPath };
  }

  /**
   * FAIL-BEFORE (origin/next behavior):
   *   The old code contained `if (existsSync(sentinel)) return;`. When the
   *   sentinel (semver-compare.cjs) was present, the function returned early
   *   without touching any other .cjs. This test confirms the new code always
   *   invokes tsc — it would have returned immediately on origin/next.
   *
   *   Specifically: on origin/next, after deleting a non-sentinel artifact +
   *   its tsbuildinfo and calling ensureBuiltArtifacts() with sentinel present,
   *   the artifact would remain absent. On the fix, tsc runs unconditionally
   *   and recreates it.
   *
   * PASS-AFTER (fix):
   *   The sentinel guard is removed. ensureBuiltArtifacts() always invokes tsc.
   *   With no tsbuildinfo present (clean state), tsc performs a full emit and
   *   recreates all .cjs outputs including the deleted non-sentinel artifact.
   *
   * HERMETIC: this test operates on a self-contained temp project. It NEVER
   * touches gsd-core/bin/lib/core.cjs or the real tsbuildinfo. (Fixed from #996.)
   */
  test('rebuilds a non-sentinel artifact (with no tsbuildinfo) even when sentinel exists', () => {
    const { tmp, overrides, sentinelOut, targetOut, tsBuildInfoPath } = makeTempProject();
    try {
      // Initial build — both outputs must appear.
      ensureBuiltArtifacts(overrides);
      assert.ok(fs.existsSync(sentinelOut), 'initial build: sentinelmod.cjs must exist');
      assert.ok(fs.existsSync(targetOut), 'initial build: targetmod.cjs must exist');

      // Simulate: fresh CI checkout — target artifact missing, no tsbuildinfo.
      fs.unlinkSync(targetOut);
      if (fs.existsSync(tsBuildInfoPath)) fs.unlinkSync(tsBuildInfoPath);

      assert.ok(!fs.existsSync(targetOut), 'pre-condition: targetmod.cjs must be absent');
      assert.ok(fs.existsSync(sentinelOut), 'pre-condition: sentinelmod.cjs must still be present');

      // Under the OLD code this returned immediately (sentinel present → return).
      // Under the NEW code this calls tsc unconditionally → full emit → recreated.
      ensureBuiltArtifacts(overrides);

      assert.ok(
        fs.existsSync(targetOut),
        'ensureBuiltArtifacts must recreate targetmod.cjs even when sentinelmod.cjs ' +
        'exists (sentinel-short-circuit was removed in fix #969)'
      );
    } finally {
      cleanup(tmp);
    }
  });

  /**
   * PASS-AFTER: the unconditional build emits the expected output (sentinelmod.cjs).
   * Uses the temp project helper so this test is fully hermetic — it never touches
   * the real gsd-core/bin/lib tree.
   */
  test('sentinel (semver-compare.cjs) still exists after unconditional build', () => {
    const { tmp, overrides, sentinelOut } = makeTempProject();
    try {
      ensureBuiltArtifacts(overrides);
      assert.ok(fs.existsSync(sentinelOut), 'sentinel output (sentinelmod.cjs) must exist after ensureBuiltArtifacts');
    } finally {
      cleanup(tmp);
    }
  });

  /**
   * PERSISTENT-MIRROR CASE — the residual hole found by adversarial review.
   *
   * FAIL-BEFORE (incremental: true — the old behavior on this branch):
   *   With "incremental": true in tsconfig.build.json, tsc reads the .tsbuildinfo
   *   on disk. If sources are unchanged since the last build, tsc skips re-emitting
   *   any outputs — including outputs that were deleted or overwritten by an rsync
   *   from a different branch. This is the persistent-docker-mirror scenario:
   *     1. A prior branch rsync'd a stale core.cjs into bin/lib/
   *     2. A stale tsbuildinfo is present (from that same branch)
   *     3. ensureBuiltArtifacts() calls tsc (incremental)
   *     4. tsc sees "sources unchanged vs tsbuildinfo" → no-ops → stale .cjs served
   *   With "incremental": true this test would FAIL because targetmod.cjs remains absent.
   *
   * PASS-AFTER (step-3 unlink+clean-reemit logic):
   *   When a missing/zero-bytes output is detected after the incremental pass,
   *   ensureBuiltArtifacts() unlinks the tsbuildinfo and runs tsc a second time
   *   (clean re-emit). The stale/missing output is always regenerated.
   *
   * HERMETIC: this test operates on a self-contained temp project. It NEVER
   * touches gsd-core/bin/lib/core.cjs or the real tsbuildinfo. (Fixed from #996.)
   */
  test('PERSISTENT-MIRROR: rebuilds stale output even when tsbuildinfo is present (non-incremental is authoritative)', () => {
    const { tmp, overrides, targetOut, tsBuildInfoPath } = makeTempProject();
    const STALE_TSBUILDINFO = JSON.stringify({
      program: { fileNames: [], options: { incremental: true } },
      version: '5.0.0',
      _gsd_test_marker: 'stale-persistent-mirror',
    });

    try {
      // Initial build to populate outputs.
      ensureBuiltArtifacts(overrides);
      assert.ok(fs.existsSync(targetOut), 'initial build: targetmod.cjs must exist');

      // Inject a stale tsbuildinfo (mirrors: old branch rsync'd state onto workspace).
      fs.writeFileSync(tsBuildInfoPath, STALE_TSBUILDINFO);
      // Delete the output .cjs (mirrors: stale/missing output on the persistent mirror).
      fs.unlinkSync(targetOut);

      assert.ok(!fs.existsSync(targetOut), 'pre-condition: targetmod.cjs must be absent');
      assert.ok(fs.existsSync(tsBuildInfoPath), 'pre-condition: tsbuildinfo must be present');

      // FAIL-BEFORE (incremental: true, no step-3): tsc would read the stale
      // tsbuildinfo, see "sources unchanged", and skip re-emitting targetmod.cjs
      // → it would remain absent.
      //
      // PASS-AFTER (step-3 unlink+clean-reemit): missing output detected after
      // incremental pass → tsbuildinfo unlinked → tsc runs again → targetmod.cjs
      // is regenerated unconditionally.
      ensureBuiltArtifacts(overrides);

      assert.ok(
        fs.existsSync(targetOut),
        'ensureBuiltArtifacts must regenerate targetmod.cjs even when a stale ' +
        'tsbuildinfo is present on disk (persistent-mirror scenario — ' +
        'incremental:true alone would have no-op\'d here)'
      );

      // Verify the regenerated file is valid JS.
      const regenerated = fs.readFileSync(targetOut, 'utf-8');
      assert.ok(regenerated.length > 0, 'regenerated targetmod.cjs must be non-empty');
      assert.ok(
        regenerated.includes('exports.') || regenerated.includes('"use strict"'),
        'regenerated targetmod.cjs must look like a valid CommonJS module'
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Part B — runGsdTools: timeout + kill-signal discrimination
// ---------------------------------------------------------------------------

describe('bug #969 B — runGsdTools kill-signal discrimination', () => {
  const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  /**
   * Shared helper that mirrors the production runGsdTools implementation
   * (from tests/helpers.cjs) but accepts an explicit timeout so we can
   * trigger the kill path in tests without waiting 60 seconds.
   *
   * IMPORTANT: this helper is intentionally self-contained so that the test
   * proves the CONTRACT of the implementation, not just calls the real
   * runGsdTools (which would need a real 60s+ hang to trigger in tests).
   * We test the identical logic paths using a tiny timeout.
   */
  function runGsdToolsWithTimeout(args, cwd, env, timeoutMs) {
    // The session-identity subset stays a local literal on purpose: this helper
    // mirrors the production one to prove its CONTRACT, so it must not simply
    // re-import what it is testing. The config-LOCATION keys are the exception —
    // they are a safety scrub rather than part of the contract under test, and a
    // hand-copied list of them is the #2665 drift this change exists to end. So
    // spread the canonical derived set (tests/helpers.cjs) and keep the rest local.
    const TEST_ENV_BASE = {
      GSD_SESSION_KEY: '',
      CODEX_THREAD_ID: '',
      CLAUDE_SESSION_ID: '',
      ...Object.fromEntries(CONFIG_LOCATION_ENV_KEYS.map((k) => [k, ''])),
    };
    try {
      let result;
      const childEnv = { ...process.env, ...TEST_ENV_BASE, ...(env || {}) };
      const argv = Array.isArray(args)
        ? args
        : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
            .map(t => t.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1'));
      result = execFileSync(process.execPath, [TOOLS_PATH, ...argv], {
        cwd: cwd || process.cwd(),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
        timeout: timeoutMs,
      });
      return { success: true, output: result.trim(), exitCode: 0 };
    } catch (err) {
      // Production kill-discrimination logic (verbatim from helpers.cjs fix).
      if (err.killed || err.signal != null || err.code === 'ETIMEDOUT') {
        throw new Error(
          `[runGsdTools: resource-starvation / subprocess-kill] ` +
          `gsd-tools was killed before completion ` +
          `(signal=${err.signal}, code=${err.code}, killed=${err.killed}). ` +
          `This indicates host OOM or scheduler contention, not a product bug. ` +
          `stdout=${err.stdout?.toString().trim() || ''} ` +
          `stderr=${err.stderr?.toString().trim() || ''}`
        );
      }
      const stderrRaw = err.stderr?.toString().trim() || '';
      const error = stderrRaw || `${err.message} [stderr: (empty) exit:${err.status ?? 1}]`;
      return {
        success: false,
        output: err.stdout?.toString().trim() || '',
        error,
        exitCode: err.status ?? 1,
      };
    }
  }

  /**
   * FAIL-BEFORE (origin/next behavior):
   *   Without a timeout, an OOM-killed subprocess threw with err.killed=true
   *   but the catch block fell through to `return { success: false, ... }`.
   *   The test consumer saw a normal {success:false} result and tried to parse
   *   gsd-tools output from it, causing a confusing downstream assertion fail.
   *
   * PASS-AFTER (fix):
   *   The kill-discrimination guard rethrows immediately with a labeled error
   *   message containing "resource-starvation / subprocess-kill". The test
   *   asserts on that throw rather than getting a silent {success:false}.
   *
   * Mechanism: we use a tiny timeout (1ms) to guarantee a timeout-kill on a
   * real gsd-tools invocation (even `--help` takes >1ms to start node).
   */
  test('throws a resource-starvation error when subprocess is killed/times out', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 1ms timeout guarantees ETIMEDOUT / killed before gsd-tools can respond.
      assert.throws(
        () => runGsdToolsWithTimeout(['--help'], tmpDir, {}, 1),
        (err) => {
          assert.ok(
            err.message.includes('resource-starvation / subprocess-kill'),
            `Expected labeled resource-starvation error, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  /**
   * Verify that a normal fast command still returns { success: true } and does
   * NOT throw — i.e., the timeout addition does not break the happy path.
   */
  test('returns { success: true } for a normal fast command with generous timeout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 30s timeout; gsd-tools --help completes in well under 1s.
      const result = runGsdToolsWithTimeout(['--help'], tmpDir, {}, 30000);
      assert.ok(result.success === true, `Expected success:true, got ${JSON.stringify(result)}`);
      assert.ok(typeof result.output === 'string', 'output must be a string');
    } finally {
      cleanup(tmpDir);
    }
  });

  /**
   * Verify that a clean non-zero exit (a real gsd-tools application error, not
   * a kill) still returns { success: false } WITHOUT throwing. This preserves
   * existing test behavior that asserts on error shape.
   *
   * We trigger a clean non-zero by invoking a command that is known to fail
   * cleanly (no project directory set up).
   */
  test('returns { success: false } for a clean non-zero exit (no throw)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-'));
    try {
      // 'phase list' on a directory with no .planning/ produces a clean error exit.
      const result = runGsdToolsWithTimeout(['phase', 'list'], tmpDir, {}, 30000);
      assert.ok(result.success === false, `Expected success:false for clean error, got ${JSON.stringify(result)}`);
      assert.ok(result.exitCode !== 0, 'exitCode must be non-zero');
      // Must NOT have thrown — the clean-error path returns normally.
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Part C — ensureBuiltHooks: build hooks/dist once, closing the scoped-CI
// first-build empty-dir race.
// ---------------------------------------------------------------------------

describe('bug #969 C — ensureBuiltHooks populates hooks/dist before concurrent tests', () => {
  /**
   * Helper: a hermetic temp dist dir + a runBuild spy. The spy records how many
   * times a build was requested and, when invoked, writes the given hook files
   * (simulating build-hooks.js populating DIST_DIR) so idempotency is testable.
   *
   * HERMETIC: never touches the real hooks/dist. Uses dependency-injected
   * overrides (distDir, hookNames, runBuild) — no fs monkeypatching, so the test
   * is deterministic and root/OS-independent.
   */
  function makeHooksFixture(hookNames) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-969-hooks-'));
    const distDir = path.join(tmp, 'hooks', 'dist');
    let buildCalls = 0;
    const runBuild = () => {
      buildCalls += 1;
      fs.mkdirSync(distDir, { recursive: true });
      for (const h of hookNames) {
        fs.writeFileSync(path.join(distDir, h), `// ${h}\nmodule.exports = {};\n`);
      }
    };
    const overrides = () => ({ distDir, hookNames, runBuild });
    return { tmp, distDir, hookNames, overrides, calls: () => buildCalls };
  }

  const HOOKS = ['a-hook.js', 'b-hook.js', 'c-hook.sh'];

  /**
   * FAIL-BEFORE (origin/next): ensureBuiltHooks did not exist, so the export was
   * undefined and there was no upfront hooks build — the first concurrent
   * install test raced build-hooks.js's empty-then-fill window. The import at the
   * top of this file (ensureBuiltHooks) is itself the fail-first anchor: on
   * origin/next it is undefined and every test below throws "not a function".
   *
   * PASS-AFTER: ensureBuiltHooks() builds when hooks/dist is entirely absent.
   */
  test('builds when hooks/dist is absent (fresh checkout / scoped CI)', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      assert.equal(typeof ensureBuiltHooks, 'function',
        'ensureBuiltHooks must be exported (absent on origin/next — the fail-first anchor)');
      assert.ok(!fs.existsSync(fx.distDir), 'pre-condition: hooks/dist must be absent');
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 1, 'a build must be triggered when dist is absent');
      for (const h of HOOKS) {
        assert.ok(fs.existsSync(path.join(fx.distDir, h)), `${h} must exist after build`);
      }
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * BOUNDARY: dist exists but is empty (0 of N hooks) — the exact transient state
   * build-hooks.js exposes between mkdir(DIST_DIR) and the first file rename.
   */
  test('builds when hooks/dist exists but is empty (0 of N)', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      fs.mkdirSync(fx.distDir, { recursive: true }); // empty dir — the race window
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 1, 'an empty dist must trigger a build');
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * BOUNDARY: dist has all-but-one hook (N-1 of N) — a partially-filled dir mid
   * first-build. Must still be treated as incomplete and rebuilt.
   */
  test('builds when hooks/dist is partial (N-1 of N)', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      fs.mkdirSync(fx.distDir, { recursive: true });
      for (const h of HOOKS.slice(0, HOOKS.length - 1)) {
        fs.writeFileSync(path.join(fx.distDir, h), 'x');
      }
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 1, 'a partial dist (missing one hook) must trigger a build');
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * BOUNDARY: a zero-byte hook (N of N present, but one is 0 bytes) — a truncated
   * mid-write file. statSync().size === 0 must count as incomplete → rebuild.
   */
  test('builds when a hook file is present but zero-byte', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      fs.mkdirSync(fx.distDir, { recursive: true });
      HOOKS.forEach((h, i) => {
        fs.writeFileSync(path.join(fx.distDir, h), i === 0 ? '' : 'ok'); // first is 0 bytes
      });
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 1, 'a zero-byte hook must be treated as incomplete → rebuild');
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * BOUNDARY + idempotency: dist is complete (all N present, non-empty). No build
   * must fire — this keeps nested run-tests spawns and repeat invocations cheap
   * and avoids a redundant concurrent build against an already-populated dist.
   */
  test('no-op when hooks/dist is complete (N of N non-empty)', () => {
    const fx = makeHooksFixture(HOOKS);
    try {
      fs.mkdirSync(fx.distDir, { recursive: true });
      for (const h of HOOKS) fs.writeFileSync(path.join(fx.distDir, h), 'ok');
      ensureBuiltHooks(fx.overrides());
      assert.equal(fx.calls(), 0, 'a complete dist must NOT trigger a build (idempotent no-op)');
    } finally {
      cleanup(fx.tmp);
    }
  });

  /**
   * Integration guard: the REAL default hook set (from build-hooks.js) is what
   * ensureBuiltHooks checks when no override is given. Prove the real export is a
   * non-empty list so the completeness predicate can never vacuously pass.
   */
  test('default hook set (build-hooks.js HOOKS_TO_COPY) is a non-empty list', () => {
    const { HOOKS_TO_COPY } = require('../scripts/build-hooks.js');
    assert.ok(Array.isArray(HOOKS_TO_COPY) && HOOKS_TO_COPY.length > 0,
      'HOOKS_TO_COPY must be a non-empty array or the completeness check is vacuous');
  });
});
  });
}

// ---------------------------------------------------------------------------
// #2456 — chunk weights must reflect MEASURED cost, not a filename guess.
//
// These tests drive the packer's pure IR (`packChunks` / `makeFileWeigher` /
// `loadTestTimings`) rather than the `run-tests: chunk N/M` stderr line, so they
// assert on typed values (chunk composition, weights) instead of rendered text.
// ---------------------------------------------------------------------------

const {
  packChunks,
  makeFileWeigher,
  loadTestTimings,
  positiveNumberEnv,
  DEFAULT_TIMINGS_PATH,
} = require('../scripts/run-tests.cjs');

describe('chunk packing weights measured cost (#2456)', () => {
  // A cost profile modelled on the real measurements in the issue. It is the
  // MISCALIBRATION that matters: the pre-#2456 heuristic scored basenames
  // matching /^(?:install|codex-)/ at 12 and everything else at 1, which is
  // wrong in BOTH directions here —
  //   * run-tests-harness / release-tarball-smoke.install are the two most
  //     expensive files yet scored 1 (the regex is anchored to the START of the
  //     basename, so a mid-name "install" never matches), and
  //   * installer-migration-authoring / codex-declarative-reference scored 12
  //     while costing almost nothing.
  const MEASURED_MS = {
    'run-tests-harness.test.cjs': 150180,
    'release-tarball-smoke.install.test.cjs': 144420,
    'phase.test.cjs': 136770,
    'install-minimal-hooks.test.cjs': 136330,
    'config.test.cjs': 114420,
    'state.test.cjs': 94290,
    'commands.test.cjs': 70580,
    'init.test.cjs': 64100,
    'installer-migration-authoring.test.cjs': 90,
    'installer-migration-report.test.cjs': 120,
    'install-update-marker.test.cjs': 95,
    'codex-declarative-reference.test.cjs': 110,
  };
  const FILES = Object.keys(MEASURED_MS);
  const FIXED_OVERHEAD = 120;
  const ROOMY_CHARS = 100000;

  function tableFrom(timings) {
    const tmp = createTempDir('gsd-2456-timings-');
    const p = path.join(tmp, 'timings.json');
    fs.writeFileSync(p, JSON.stringify({ schema_version: 1, unit: 'ms', timings }), 'utf8');
    return { path: p, dir: tmp };
  }

  function packMeasured(files, maxWeight, extra = {}) {
    const t = tableFrom(MEASURED_MS);
    try {
      return packChunks(files, {
        weightOf: makeFileWeigher(loadTestTimings(t.path)),
        maxWeight,
        maxChars: ROOMY_CHARS,
        fixedOverhead: FIXED_OVERHEAD,
        ...extra,
      });
    } finally {
      cleanup(t.dir);
    }
  }

  const costOf = (chunk) => chunk.reduce((sum, f) => sum + MEASURED_MS[f], 0);

  /**
   * THE REGRESSION (#2456). Under the pre-fix packer the two most expensive
   * files both scored weight 1 and, being adjacent in selection order, packed
   * into the SAME chunk — that chunk ran ~3.9x the lightest and sat near the
   * 600s per-chunk timeout. Weighting by measured cost and packing with LPT must
   * separate them.
   */
  test('the two most expensive files never land in the same chunk', () => {
    const chunks = packMeasured(FILES, 4);
    const chunkOf = (f) => chunks.findIndex((c) => c.includes(f));
    const a = chunkOf('run-tests-harness.test.cjs');
    const b = chunkOf('release-tarball-smoke.install.test.cjs');
    assert.ok(a !== -1 && b !== -1, 'both heavy files must be packed');
    assert.notStrictEqual(
      a,
      b,
      `the two most expensive files must be split across chunks; got both in chunk ${a + 1}. ` +
        `Chunk costs (s): ${chunks.map((c) => (costOf(c) / 1000).toFixed(1)).join(', ')}`,
    );
  });

  test('chunk costs are balanced — slowest chunk stays well under 2x the fastest', () => {
    const chunks = packMeasured(FILES, 4);
    const costs = chunks.map(costOf);
    const ratio = Math.max(...costs) / Math.min(...costs);
    assert.ok(
      ratio < 2,
      `LPT must balance measured cost; imbalance was ${ratio.toFixed(2)}x ` +
        `(costs in s: ${costs.map((c) => (c / 1000).toFixed(1)).join(', ')})`,
    );
  });

  test('weights follow measured duration, correcting the old prefix heuristic both ways', () => {
    const t = tableFrom(MEASURED_MS);
    try {
      const weigh = makeFileWeigher(loadTestTimings(t.path));
      // Old heuristic: 1. Actual: the most expensive file in the suite.
      assert.ok(
        weigh('run-tests-harness.test.cjs') > 1,
        'the heaviest file must weigh above the table average',
      );
      // Old heuristic: 12 (install prefix). Actual: ~0.1s.
      assert.ok(
        weigh('installer-migration-authoring.test.cjs') < 1,
        'a trivially cheap install-prefixed file must weigh below the table average',
      );
      // The old regex is anchored to the START of the basename, so a mid-name
      // "install" scored 1. Measured, it is the second most expensive file.
      assert.ok(
        weigh('release-tarball-smoke.install.test.cjs')
          > weigh('installer-migration-authoring.test.cjs') * 100,
        'mid-name "install" must be ranked by cost, not by prefix position',
      );
    } finally {
      cleanup(t.dir);
    }
  });

  test('an average-cost file weighs exactly 1, preserving the MAX_FILES_PER_CHUNK scale', () => {
    // Three files at 10s, 20s, 30s → mean 20s. The 20s file is the average.
    const t = tableFrom({ 'a.test.cjs': 10000, 'b.test.cjs': 20000, 'c.test.cjs': 30000 });
    try {
      const weigh = makeFileWeigher(loadTestTimings(t.path));
      assert.strictEqual(weigh('b.test.cjs'), 1, 'the mean-cost file must weigh 1');
      assert.strictEqual(weigh('a.test.cjs'), 0.5);
      assert.strictEqual(weigh('c.test.cjs'), 1.5);
    } finally {
      cleanup(t.dir);
    }
  });

  describe('timings are advisory, never gated', () => {
    test('a file missing from the table falls back to the median weight', () => {
      // 10s, 20s, 60s → mean 30s, median 20s → median weight = 20/30.
      const t = tableFrom({ 'a.test.cjs': 10000, 'b.test.cjs': 20000, 'c.test.cjs': 60000 });
      try {
        const weigh = makeFileWeigher(loadTestTimings(t.path));
        assert.strictEqual(weigh('brand-new-test.test.cjs'), 20000 / 30000);
      } finally {
        cleanup(t.dir);
      }
    });

    test('an unknown file packs without error rather than failing the run', () => {
      const chunks = packMeasured([...FILES, 'never-measured.test.cjs'], 4);
      assert.ok(
        chunks.flat().includes('never-measured.test.cjs'),
        'a file absent from the timings table must still be packed',
      );
    });

    test('a missing timings file degrades to uniform weight, not an error', () => {
      // No temp dir needed — the point is a path that does NOT exist. Creating
      // one here would leak it (createTempDir has no registry).
      const missing = path.join(__dirname, 'no-such-dir-2456', 'does-not-exist.json');
      assert.strictEqual(loadTestTimings(missing), null, 'a missing table must load as null');
      const weigh = makeFileWeigher(null);
      assert.strictEqual(weigh('anything.test.cjs'), 1, 'a null table must weigh every file 1');
    });

    test('a corrupt timings file degrades to uniform weight, not an error', () => {
      const tmp = createTempDir('gsd-2456-corrupt-');
      try {
        const p = path.join(tmp, 'timings.json');
        fs.writeFileSync(p, '{ this is not json', 'utf8');
        assert.strictEqual(loadTestTimings(p), null, 'unparseable JSON must load as null');
      } finally {
        cleanup(tmp);
      }
    });

    test('a structurally valid but empty table degrades to uniform weight', () => {
      const t = tableFrom({});
      try {
        assert.strictEqual(loadTestTimings(t.path), null, 'an empty table must load as null');
      } finally {
        cleanup(t.dir);
      }
    });

    test('chunk count never drops below what count-based packing would produce', () => {
      const files = Array.from({ length: 30 }, (_, i) => `unmeasured-${i}.test.cjs`);
      assert.ok(
        packMeasured(files, 6).length >= Math.ceil(files.length / 6),
        'the count floor must hold for a fully-unknown file set',
      );
    });

    test('a right-skewed table cannot collapse unknown files into fat chunks', () => {
      // The safety floor in its worst case. In a realistically right-skewed suite
      // (many trivial files, a few very expensive ones) the median weight is far
      // below 1, so weighting ALONE would pack 30 unknown files into a single
      // chunk — exactly the failure mode this fix exists to prevent. The count
      // floor pins the result at what the pre-#2456 packer produced.
      const skewed = {
        ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t-${i}.test.cjs`, 100])),
        'one-huge.test.cjs': 100000,
      };
      const t = tableFrom(skewed);
      try {
        const table = loadTestTimings(t.path);
        assert.ok(table.medianWeight < 0.05, 'fixture must actually be right-skewed');
        const files = Array.from({ length: 30 }, (_, i) => `unmeasured-${i}.test.cjs`);
        const chunks = packChunks(files, {
          weightOf: makeFileWeigher(table),
          maxWeight: 6,
          maxChars: ROOMY_CHARS,
          fixedOverhead: FIXED_OVERHEAD,
        });
        assert.strictEqual(
          chunks.length,
          Math.ceil(files.length / 6),
          'a right-skewed table must still chunk exactly as count-based packing did',
        );
      } finally {
        cleanup(t.dir);
      }
    });
  });

  describe('boundary coverage', () => {
    // 12 files, each weighing exactly 1 (uniform) → total weight 12.
    const uniform = Array.from({ length: 12 }, (_, i) => `u-${String(i).padStart(2, '0')}.test.cjs`);
    const packUniform = (maxWeight) =>
      packChunks(uniform, {
        weightOf: () => 1,
        maxWeight,
        maxChars: ROOMY_CHARS,
        fixedOverhead: FIXED_OVERHEAD,
      });

    test('weight budget at limit-1 forces a second chunk', () => {
      assert.strictEqual(packUniform(11).length, 2, 'total weight 12 over budget 11 → 2 chunks');
    });

    test('weight budget exactly at the limit stays in one chunk', () => {
      assert.strictEqual(packUniform(12).length, 1, 'total weight 12 at budget 12 → 1 chunk');
    });

    test('weight budget at limit+1 stays in one chunk', () => {
      assert.strictEqual(packUniform(13).length, 1, 'total weight 12 under budget 13 → 1 chunk');
    });

    // argv ceiling: two files of identical length in one chunk occupies
    // fixedOverhead + 2*(len+1) chars.
    const two = ['argv-boundary-aaa.test.cjs', 'argv-boundary-bbb.test.cjs'];
    const exactChars = FIXED_OVERHEAD + two.reduce((sum, f) => sum + f.length + 1, 0);
    const packChars = (maxChars) =>
      packChunks(two, {
        weightOf: () => 1,
        maxWeight: 1000, // never the binding constraint here
        maxChars,
        fixedOverhead: FIXED_OVERHEAD,
      });

    test('argv ceiling at limit-1 splits the chunk', () => {
      assert.strictEqual(packChars(exactChars - 1).length, 2, 'one char short → must split');
    });

    test('argv ceiling exactly at the limit keeps one chunk', () => {
      assert.strictEqual(packChars(exactChars).length, 1, 'exactly at the ceiling → fits');
    });

    test('argv ceiling at limit+1 keeps one chunk', () => {
      assert.strictEqual(packChars(exactChars + 1).length, 1, 'one char spare → fits');
    });

    test('a single file wider than the argv ceiling is packed alone, not dropped or looped', () => {
      const chunks = packChunks(['x'.repeat(500) + '.test.cjs', 'small.test.cjs'], {
        weightOf: () => 1,
        maxWeight: 1000,
        maxChars: FIXED_OVERHEAD + 50, // narrower than the long file alone
        fixedOverhead: FIXED_OVERHEAD,
      });
      assert.strictEqual(chunks.flat().length, 2, 'both files must survive packing');
      assert.strictEqual(chunks.length, 2, 'the over-long file must occupy its own chunk');
    });

    test('an empty selection packs to no chunks', () => {
      assert.deepStrictEqual(
        packChunks([], {
          weightOf: () => 1,
          maxWeight: 60,
          maxChars: ROOMY_CHARS,
          fixedOverhead: FIXED_OVERHEAD,
        }),
        [],
      );
    });
  });

  describe('packing invariants', () => {
    test('every selected file is packed exactly once', () => {
      const chunks = packMeasured(FILES, 3);
      const flat = chunks.flat();
      assert.strictEqual(flat.length, FILES.length, 'no file may be dropped or duplicated');
      assert.deepStrictEqual([...flat].sort(), [...FILES].sort(), 'the packed set must equal the selection');
    });

    test('no chunk is empty', () => {
      const chunks = packMeasured(FILES, 3);
      for (const [i, c] of chunks.entries()) {
        assert.ok(c.length > 0, `chunk ${i + 1} must not be empty`);
      }
    });

    test('packing is deterministic — identical input yields byte-identical chunks', () => {
      assert.deepStrictEqual(packMeasured(FILES, 4), packMeasured(FILES, 4));
    });

    test('files keep their original selection order within a chunk', () => {
      const chunks = packMeasured(FILES, 3);
      for (const chunk of chunks) {
        const positions = chunk.map((f) => FILES.indexOf(f));
        assert.deepStrictEqual(
          positions,
          [...positions].sort((a, b) => a - b),
          'within a chunk, files must stay in selection order',
        );
      }
    });
  });

  describe('degenerate knobs degrade safely rather than hanging or crashing', () => {
    // These knobs come from the environment via Number(), so a typo yields NaN
    // and an explicit 0 yields 0. Both reach the chunk-count arithmetic. Before
    // hardening, NaN spun packChunks' retry loop forever (a hung CI job with no
    // output) and 0 threw `RangeError: Invalid array length` from Array.from.
    // Every case below must return a valid packing instead.
    const files = ['a.test.cjs', 'b.test.cjs', 'c.test.cjs'];
    const packWith = (opts) =>
      packChunks(files, {
        weightOf: () => 1,
        maxWeight: 60,
        maxChars: ROOMY_CHARS,
        fixedOverhead: FIXED_OVERHEAD,
        ...opts,
      });
    const conserves = (chunks) =>
      JSON.stringify(chunks.flat().sort()) === JSON.stringify([...files].sort());

    for (const [label, opts] of [
      ['a NaN weight budget', { maxWeight: NaN }],
      ['a zero weight budget', { maxWeight: 0 }],
      ['a negative weight budget', { maxWeight: -5 }],
      ['a NaN argv ceiling', { maxChars: NaN }],
      ['a zero argv ceiling', { maxChars: 0 }],
      ['a NaN fixed overhead', { fixedOverhead: NaN }],
      ['a weight function returning NaN', { weightOf: () => NaN }],
      ['a weight function returning Infinity', { weightOf: () => Infinity }],
      ['a weight function returning a negative', { weightOf: () => -1 }],
    ]) {
      test(`${label} still packs every file exactly once`, () => {
        const chunks = packWith(opts);
        assert.ok(conserves(chunks), `${label} must still pack all files; got ${JSON.stringify(chunks)}`);
      });
    }

    test('a legitimate but tiny weight budget does not explode the chunk count', () => {
      // positiveNumberEnv accepts any positive finite number, so 1e-9 is a valid
      // budget. Without an upper clamp the packer asks for files.length / 1e-9
      // bins and throws `RangeError: Invalid array length`. More chunks than
      // files is never useful, so the count clamps at one file per chunk.
      const many = Array.from({ length: 200 }, (_, i) => `m-${i}.test.cjs`);
      const chunks = packChunks(many, {
        weightOf: () => 1,
        maxWeight: 1e-9,
        maxChars: ROOMY_CHARS,
        fixedOverhead: FIXED_OVERHEAD,
      });
      assert.strictEqual(chunks.length, many.length, 'must clamp to one file per chunk');
      assert.strictEqual(chunks.flat().length, many.length, 'no file may be dropped');
    });

    test('a timings table from a future schema is ignored rather than mis-read', () => {
      // A v2 table could change the unit or key format; consuming it under v1
      // semantics would silently mis-weight every file. Falling back to null
      // (uniform weight) is the same graceful degradation as a missing table.
      const tmp = createTempDir('gsd-2456-schema-');
      try {
        const p2 = path.join(tmp, 'timings.json');
        fs.writeFileSync(p2, JSON.stringify({ schema_version: 2, timings: { 'a.test.cjs': 100 } }), 'utf8');
        assert.strictEqual(loadTestTimings(p2), null, 'an unknown schema_version must load as null');
        fs.writeFileSync(p2, JSON.stringify({ schema_version: 1, timings: { 'a.test.cjs': 100 } }), 'utf8');
        assert.ok(loadTestTimings(p2) !== null, 'the supported schema_version must load');
      } finally {
        cleanup(tmp);
      }
    });

    test('positiveNumberEnv falls back for every non-positive-finite input', () => {
      for (const bad of [undefined, null, '', '   ', 'abc', '0', '-1', 'NaN', 'Infinity', '1e999']) {
        assert.strictEqual(
          positiveNumberEnv(bad, 60),
          60,
          `${JSON.stringify(bad)} must fall back to the default`,
        );
      }
    });

    test('positiveNumberEnv accepts a legitimate override', () => {
      assert.strictEqual(positiveNumberEnv('3', 60), 3);
      assert.strictEqual(positiveNumberEnv('0.5', 60), 0.5);
    });

    test('a key that resolves on Object.prototype still weighs a number, not a function', () => {
      // The table is JSON-parsed, so a bare index would walk the prototype
      // chain. Real selections are `*.test.cjs` basenames, which can never equal
      // an Object.prototype member — so these BARE names are the only inputs
      // that actually reach that path, and makeFileWeigher is exported, so it
      // does not control its caller's strings. The contract is that any key not
      // present in the table weighs the median, whatever it resolves to.
      const t = tableFrom({ 'a.test.cjs': 10000, 'b.test.cjs': 20000, 'c.test.cjs': 60000 });
      try {
        const weigh = makeFileWeigher(loadTestTimings(t.path));
        for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
          const w = weigh(name);
          assert.strictEqual(typeof w, 'number', `${name} must weigh a number, not a function`);
          assert.strictEqual(w, 20000 / 30000, `${name} must fall back to the median weight`);
        }
      } finally {
        cleanup(t.dir);
      }
    });

    test('a __proto__ key in the table does not pollute Object.prototype', () => {
      const t = tableFrom(JSON.parse('{"__proto__":{"polluted":true},"a.test.cjs":1000}'));
      try {
        makeFileWeigher(loadTestTimings(t.path))('a.test.cjs');
        assert.strictEqual({}.polluted, undefined, 'Object.prototype must not be polluted');
      } finally {
        cleanup(t.dir);
      }
    });
  });

  describe('the checked-in timings table', () => {
    test('loads, is non-empty, and yields usable weights', () => {
      const table = loadTestTimings(DEFAULT_TIMINGS_PATH);
      assert.ok(table !== null, `${DEFAULT_TIMINGS_PATH} must parse into a usable timing table`);
      assert.ok(Object.keys(table.timings).length > 0, 'the table must not be empty');
      assert.ok(table.mean > 0, 'the table mean must be positive');
      assert.ok(table.medianWeight > 0, 'the median fallback weight must be positive');
    });

    // Schema guard on a static checked-in data file — NOT a timing assertion.
    // Reported as a list so a corrupt regeneration names every bad entry at once
    // rather than failing on the first.
    test('every recorded cost is a finite non-negative number', () => {
      const table = loadTestTimings(DEFAULT_TIMINGS_PATH);
      const invalid = Object.entries(table.timings)
        .filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        .map(([file, value]) => `${file}=${value}`);
      assert.deepStrictEqual(invalid, [], 'every timing-table entry must be a finite non-negative number');
    });
  });
});

// ─── analyzeChunkEvents (#3889 durability fix) ──────────────────────────────
//
// scripts/lib/ndjson-reporter.cjs now writes durably (fs.appendFileSync to a
// GSD_RUN_TESTS_EVENTS_FILE path) instead of yielding strings for Node to
// pipe through a buffered --test-reporter-destination WriteStream that a
// SIGKILL can wipe out before it flushes. These tests exercise the READER
// side (analyzeChunkEvents) directly against a hand-written events file, so
// they pin the reader's contract independently of whether the writer side
// managed to flush anything in a given subprocess run.
const { analyzeChunkEvents } = require('../scripts/run-tests.cjs');

describe('analyzeChunkEvents (#3889)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3889-events-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('a missing events file is reported as an explicit read error, not silently as "no events"', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.ndjson');
    const result = analyzeChunkEvents(missingPath);
    assert.strictEqual(result.readError, true, 'a missing file must set readError=true');
    assert.strictEqual(result.sawAnyEvent, false);
    assert.deepStrictEqual(result.files, []);
  });

  test('an existing-but-empty events file is distinguished from a missing one (readError=false)', () => {
    const emptyPath = path.join(tmpDir, 'empty.ndjson');
    fs.writeFileSync(emptyPath, '', 'utf8');
    const result = analyzeChunkEvents(emptyPath);
    assert.strictEqual(result.readError, false, 'an existing empty file must NOT be reported as a read error');
    assert.strictEqual(result.sawAnyEvent, false);
    assert.deepStrictEqual(result.files, []);
  });

  test('a truncated final line does not crash the reader and earlier complete lines are still reported', () => {
    const truncatedPath = path.join(tmpDir, 'truncated.ndjson');
    const complete = [
      JSON.stringify({ type: 'test:start', file: 'a.test.cjs', name: 'first', nesting: 0, testNumber: 1, ts: 1000 }),
      JSON.stringify({ type: 'test:pass', file: 'a.test.cjs', name: 'first', nesting: 0, testNumber: 1, ts: 1010 }),
      JSON.stringify({ type: 'test:start', file: 'b.test.cjs', name: 'hangs', nesting: 0, testNumber: 1, ts: 1020 }),
    ].join('\n');
    // Simulate a SIGKILL mid-appendFileSync: the trailing line is cut off
    // partway through a JSON object, exactly as an unbuffered but non-atomic
    // write can be interrupted.
    const truncatedTrailer = '\n{"type":"test:start","file":"c.test.cjs","name":"cut off mid-writ';
    fs.writeFileSync(truncatedPath, complete + truncatedTrailer, 'utf8');

    const result = analyzeChunkEvents(truncatedPath);
    assert.strictEqual(result.readError, false, 'a readable-but-truncated file must not be a read error');
    // The complete test:start (b.test.cjs) with no matching pass/fail is
    // still identified as in-flight despite the unparsable trailing line.
    assert.deepStrictEqual(result.files, ['b.test.cjs']);
    // a.test.cjs completed (start+pass), so it must NOT show as in-flight.
    assert.ok(!result.files.includes('a.test.cjs'));
    // c.test.cjs never parsed (truncated line), so it cannot appear either.
    assert.ok(!result.files.includes('c.test.cjs'));
    assert.strictEqual(result.sawAnyEvent, true, 'the complete lines before the truncation must still count as events');
  });

  // Regression (#3889 root cause): test:start/test:pass/test:fail are the
  // exact three event types a genuine hang guarantees are never emitted —
  // node:test only surfaces a subtest event to the parent once the child
  // reports it, which happens on completion. test:dequeue is the RUNNER's
  // own "began this file" signal and fires independent of completion; these
  // four cases pin analyzeChunkEvents' dequeue-based in-flight rule directly
  // against the synthetic event shapes a real hang, and a real finish, produce.
  test('a dequeued file with no terminal event is reported as in flight', () => {
    const eventsPath = path.join(tmpDir, 'dequeue-only.ndjson');
    const lines = [
      JSON.stringify({ type: 'reporter:init', ts: 900 }),
      JSON.stringify({ type: 'test:enqueue', file: 'a.test.cjs', ts: 1000 }),
      JSON.stringify({ type: 'test:dequeue', file: 'a.test.cjs', ts: 1010 }),
    ].join('\n');
    fs.writeFileSync(eventsPath, lines, 'utf8');

    const result = analyzeChunkEvents(eventsPath);
    assert.deepStrictEqual(result.files, ['a.test.cjs']);
    assert.strictEqual(result.anyDequeued, true);
    assert.strictEqual(result.sawInitMarker, true);
  });

  test('a dequeued file that also terminates reports nothing in flight (all files finished)', () => {
    const eventsPath = path.join(tmpDir, 'dequeue-then-pass.ndjson');
    const lines = [
      JSON.stringify({ type: 'reporter:init', ts: 900 }),
      JSON.stringify({ type: 'test:enqueue', file: 'a.test.cjs', ts: 1000 }),
      JSON.stringify({ type: 'test:dequeue', file: 'a.test.cjs', ts: 1010 }),
      JSON.stringify({ type: 'test:pass', file: 'a.test.cjs', ts: 1020 }),
    ].join('\n');
    fs.writeFileSync(eventsPath, lines, 'utf8');

    const result = analyzeChunkEvents(eventsPath);
    assert.deepStrictEqual(result.files, [], 'a terminated file must not show as in flight');
    assert.strictEqual(result.anyDequeued, true, 'the file WAS dequeued — "all files finished" is a distinct state from "nothing ran"');
  });

  test('one terminated file followed by a second dequeued-but-unterminated file reports only the second', () => {
    const eventsPath = path.join(tmpDir, 'two-files.ndjson');
    const lines = [
      JSON.stringify({ type: 'reporter:init', ts: 900 }),
      JSON.stringify({ type: 'test:dequeue', file: 'a.test.cjs', ts: 1000 }),
      JSON.stringify({ type: 'test:pass', file: 'a.test.cjs', ts: 1010 }),
      JSON.stringify({ type: 'test:dequeue', file: 'b.test.cjs', ts: 1020 }),
    ].join('\n');
    fs.writeFileSync(eventsPath, lines, 'utf8');

    const result = analyzeChunkEvents(eventsPath);
    assert.deepStrictEqual(result.files, ['b.test.cjs']);
    assert.ok(!result.files.includes('a.test.cjs'));
  });

  test('an init marker with no dequeue at all is distinguished (anyDequeued=false) from "all finished"', () => {
    const eventsPath = path.join(tmpDir, 'init-only.ndjson');
    fs.writeFileSync(eventsPath, JSON.stringify({ type: 'reporter:init', ts: 900 }), 'utf8');

    const result = analyzeChunkEvents(eventsPath);
    assert.deepStrictEqual(result.files, []);
    assert.strictEqual(result.anyDequeued, false);
    assert.strictEqual(result.sawInitMarker, true);
    assert.strictEqual(result.sawAnyEvent, false);
  });
});
