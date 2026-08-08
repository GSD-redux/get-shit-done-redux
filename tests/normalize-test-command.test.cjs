'use strict';

/**
 * Regression tests for the test-command normalizer (#1857).
 *
 * A GSD test gate must not hang forever on a watch-mode runner. The normalizer
 * rewrites a resolved test command to a best-effort one-shot form; the gate's
 * wall-clock timeout is the ultimate guarantee (asserted separately as workflow
 * content). These tests cover the two normalization acceptance criteria:
 *   (a) an already-one-shot command is invoked UNCHANGED (never double-flagged),
 *   (b) a watch-mode command is normalized to a one-shot form.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const normalizer = require('../gsd-core/bin/lib/normalize-test-command.cjs');
const { normalizeTestCommand, isAlreadyOneShot } = normalizer;

function tmpProject(testScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1857-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: testScript } }),
  );
  return dir;
}

describe('normalizeTestCommand: direct vitest (watch by default) → one-shot (#1857)', () => {
  test('bare vitest gains "run"', () => {
    assert.strictEqual(normalizeTestCommand('vitest', '/tmp'), 'vitest run');
  });
  test('npx vitest with flags gains "run" and keeps flags', () => {
    assert.strictEqual(normalizeTestCommand('npx vitest --coverage', '/tmp'), 'npx vitest run --coverage');
  });
  test('vitest --watch is stripped and made one-shot', () => {
    assert.strictEqual(normalizeTestCommand('vitest --watch', '/tmp'), 'vitest run');
  });
});

describe('normalizeTestCommand: already one-shot is a no-op (#1857)', () => {
  for (const cmd of ['vitest run', 'vitest --run', 'npx vitest run -t foo', 'jest --watchAll=false']) {
    test(`"${cmd}" is recognised one-shot and returned unchanged`, () => {
      assert.strictEqual(normalizeTestCommand(cmd, '/tmp'), cmd);
      assert.ok(isAlreadyOneShot(cmd), `"${cmd}" should be recognised as one-shot`);
    });
  }
  // jest is one-shot by default (no --watch); --runInBand doesn't disable watch,
  // so it isn't a one-shot MARKER — but a jest command without a watch flag is
  // still returned unchanged via the jest branch.
  for (const cmd of ['jest', 'jest --runInBand']) {
    test(`"${cmd}" (jest, no watch flag) is returned unchanged`, () => {
      assert.strictEqual(normalizeTestCommand(cmd, '/tmp'), cmd);
    });
  }
});

describe('normalizeTestCommand: direct jest with watch flag → one-shot (#1857)', () => {
  test('jest --watch → --watchAll=false', () => {
    assert.strictEqual(normalizeTestCommand('jest --watch', '/tmp'), 'jest --watchAll=false');
  });
  test('jest --watchAll → --watchAll=false', () => {
    assert.strictEqual(normalizeTestCommand('jest --watchAll', '/tmp'), 'jest --watchAll=false');
  });
});

describe('normalizeTestCommand: package-manager script invocation inspects package.json (#1857)', () => {
  let vitestDir; let vitestRunDir; let jestDir;
  beforeEach(() => {
    vitestDir = tmpProject('vitest'); // watches by default
    vitestRunDir = tmpProject('vitest run'); // already one-shot
    jestDir = tmpProject('jest'); // one-shot by default
  });
  afterEach(() => {
    for (const d of [vitestDir, vitestRunDir, jestDir]) {
      cleanup(d);
    }
  });

  test('npm test whose script is watch-vitest → CI=true prefix', () => {
    assert.strictEqual(normalizeTestCommand('npm test', vitestDir), 'CI=true npm test');
  });
  test('pnpm test whose script is watch-vitest → CI=true prefix', () => {
    assert.strictEqual(normalizeTestCommand('pnpm test', vitestDir), 'CI=true pnpm test');
  });
  test('npm test whose script is already "vitest run" → unchanged', () => {
    assert.strictEqual(normalizeTestCommand('npm test', vitestRunDir), 'npm test');
  });
  test('npm test whose script is jest (one-shot) → unchanged', () => {
    assert.strictEqual(normalizeTestCommand('npm test', jestDir), 'npm test');
  });

  test('pnpm --dir <app> test inspects the target package.json (#1857 comment 5)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1857-root-'));
    try {
      fs.mkdirSync(path.join(root, 'app'));
      fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
      assert.strictEqual(normalizeTestCommand('pnpm --dir app test', root), 'CI=true pnpm --dir app test');
      // An explicit --run the user already passed is respected (no-op); the
      // gate timeout backstops a project that still watches despite --run.
      assert.strictEqual(normalizeTestCommand('pnpm --dir app test -- --run', root), 'pnpm --dir app test -- --run');
    } finally {
      cleanup(root);
    }
  });
});

describe('normalizeTestCommand: non-JS / unknown runners are untouched (#1857)', () => {
  for (const cmd of ['cargo test', 'go test ./...', 'make test', 'python -m pytest -q', 'true', '']) {
    test(`"${cmd}" is returned unchanged`, () => {
      assert.strictEqual(normalizeTestCommand(cmd, '/tmp'), cmd);
    });
  }
  test('npm test with no package.json is left unchanged (cannot classify)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1857-empty-'));
    try {
      assert.strictEqual(normalizeTestCommand('npm test', empty), 'npm test');
    } finally {
      cleanup(empty);
    }
  });
});

describe('normalizeTestCommand: security hardening (#1857 review)', () => {
  // "vitest"/"jest" as a token that isn't the invoked binary must NOT be mangled.
  for (const cmd of ['make test-vitest', 'node ./scripts/run-vitest.js', './bin/vitest-wrapper.sh', 'cat vitest.config.js', 'node jest-runner.js']) {
    test(`"${cmd}" is not mangled (word-token, not substring)`, () => {
      assert.strictEqual(normalizeTestCommand(cmd, '/tmp'), cmd);
    });
  }

  test('an oversized command is returned unchanged (no ReDoS)', () => {
    // The blow-up input from the review: a long "npm " run with no `test` token.
    const huge = 'npm '.repeat(200000); // ~800 KB
    const out = normalizeTestCommand(huge, '/tmp');
    // No elapsed-time bound: catastrophic backtracking on an 800 KB input
    // does not take 251ms, it does not finish at all. A real ReDoS
    // regression manifests as the suite being killed on this test, which is
    // a louder and more reliable signal than a threshold — the threshold
    // only ever distinguished "fast" from "slightly slow" (bench load), not
    // correctness.
    assert.strictEqual(out, huge, 'oversized input must be returned unchanged');
  });

  test('a package.json that is not a regular file is ignored (no FIFO hang)', () => {
    // resolvePackageDir would point here; a non-regular "package.json" must be skipped.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1857-notfile-'));
    try {
      fs.mkdirSync(path.join(dir, 'package.json')); // a DIRECTORY named package.json
      // Classified as "cannot determine runner" → command returned unchanged.
      assert.strictEqual(normalizeTestCommand('npm test', dir), 'npm test');
    } finally {
      cleanup(dir);
    }
  });
});
