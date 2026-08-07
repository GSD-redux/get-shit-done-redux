'use strict';

// Tests for scripts/lint-regression-test-names.cjs — the identity ratchet
// that bans NEW top-level bug-NNNN test files (2026-06 CI audit). Uses the
// script's env overrides to point at sandbox fixture dirs; never touches the
// real tests/ directory or allowlist.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'lint-regression-test-names.cjs');

let sandbox;

let fixtureCount = 0;

function runLint({ files, allowlist, args = [] }) {
  const testsDir = path.join(sandbox, `tests-${fixtureCount++}`);
  fs.mkdirSync(testsDir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(testsDir, f), '');
  const allowlistPath = path.join(testsDir, 'allowlist.json');
  fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));
  const result = runNode([SCRIPT, ...args], {
    cwd: ROOT,
    timeoutMs: PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      GSD_LINT_REGRESSION_TESTS_DIR: testsDir,
      GSD_LINT_REGRESSION_ALLOWLIST: allowlistPath,
    },
  });
  // Composes toLegacyResult with the site-specific allowlistPath rather than
  // folding it into the shared helper — see git-fixture.cjs's toLegacyResult
  // JSDoc.
  return { ...toLegacyResult(result), allowlistPath };
}

describe('lint-regression-test-names', () => {
  before(() => {
    sandbox = createTempDir('gsd-lint-regression-');
  });

  after(() => {
    cleanup(sandbox);
  });

  test('passes when every bug-* file is grandfathered', () => {
    const r = runLint({
      files: ['bug-100-old.test.cjs', 'module.test.cjs'],
      allowlist: ['bug-100-old.test.cjs'],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('fails on a novel bug-* file with fold-into-module guidance', () => {
    const r = runLint({
      files: ['bug-100-old.test.cjs', 'bug-200-new.test.cjs'],
      allowlist: ['bug-100-old.test.cjs'],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /bug-200-new\.test\.cjs/);
    assert.match(r.stderr, /owning module/);
  });

  test('fails on a stale allowlist entry (ratchet-down enforcement)', () => {
    const r = runLint({
      files: ['bug-100-old.test.cjs'],
      allowlist: ['bug-100-old.test.cjs', 'bug-300-gone.test.cjs'],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /bug-300-gone\.test\.cjs/);
  });

  test('ignores non-bug test files and suite-marked non-bug names', () => {
    const r = runLint({
      files: ['module.test.cjs', 'feature.integration.test.cjs', 'debug-1-not-a-bug.test.cjs'],
      allowlist: [],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('catches a suite-marked bug-* file too (no marker escape hatch)', () => {
    const r = runLint({
      files: ['bug-400-sneaky.security.test.cjs'],
      allowlist: [],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /bug-400-sneaky\.security\.test\.cjs/);
  });

  test('repo baseline passes (real tests/ dir against real allowlist)', () => {
    const r = runNode([SCRIPT], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  });

  test('novel-offender failure names the --update drift-repair path', () => {
    const r = runLint({
      files: ['bug-500-inherited.test.cjs'],
      allowlist: [],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /--update/);
  });

  test('--update regenerates the allowlist from the tests dir (grandfather + prune)', () => {
    const r = runLint({
      files: ['bug-100-kept.test.cjs', 'bug-200-new.test.cjs'],
      allowlist: ['bug-100-kept.test.cjs', 'bug-300-gone.test.cjs'],
      args: ['--update'],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /grandfathered: bug-200-new\.test\.cjs/);
    assert.match(r.stdout, /pruned: bug-300-gone\.test\.cjs/);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(r.allowlistPath, 'utf8')),
      ['bug-100-kept.test.cjs', 'bug-200-new.test.cjs'],
    );
  });

  test('--update is a no-op when already in sync', () => {
    const r = runLint({
      files: ['bug-100-kept.test.cjs'],
      allowlist: ['bug-100-kept.test.cjs'],
      args: ['--update'],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /already in sync/);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(r.allowlistPath, 'utf8')),
      ['bug-100-kept.test.cjs'],
    );
  });

  test('unknown arguments are rejected', () => {
    const r = runLint({ files: [], allowlist: [], args: ['--frobnicate'] });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown argument/);
  });
});
