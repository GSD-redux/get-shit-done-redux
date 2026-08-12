'use strict';

// Tests for scripts/lint-allow-test-rule-refs.cjs — the dual guard that (a)
// ratchets exemption-marker comments on IDENTITY (uncited comments must
// carry a tracking-issue ref or be grandfathered) and (b) ratchets the total
// distinct exemption-file count against a tight ceiling via assertTightCeiling
// (scripts/lib/allowlist-ratchet.cjs). Uses the script's env overrides to
// point at sandbox fixture dirs/files; never touches the real tests/ dir or
// the real allowlist/ceiling JSON.
//
// Identifier note: the script computes `relpath = path.relative(ROOT, full)`
// where ROOT is the repo root (path.join(__dirname, '..') inside the script),
// NOT relative to the fixture tests dir. Since fixtures live in a temp dir
// outside the repo, the identifiers the script produces are relative paths
// like `../../../../tmp/xyz/tests-0/foo.test.cjs`, not `tests/foo.test.cjs`.
// This file mirrors that exact computation (relToRoot below) rather than
// hardcoding a `tests/...`-shaped string, so assertions match reality
// regardless of where the OS places the temp dir.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'lint-allow-test-rule-refs.cjs');

// Deliberately split so this file's OWN source never contains the contiguous
// exemption-marker substring the script under test scans for — the script
// does a raw-text scan (not AST/comment parsing), so an unsplit literal here
// would make THIS test file register as its own offender when the real
// lint:ci run scans tests/.
const MARKER = 'allow' + '-test-rule:';

let sandbox;
let fixtureCount = 0;

// Mirrors the script's own `path.relative(ROOT, full).split(path.sep).join('/')`
// computation (scripts/lint-allow-test-rule-refs.cjs's walkTestFiles) so
// expected identifiers are derived, never hardcoded as `tests/...`.
function relToRoot(fullPath) {
  return path.relative(ROOT, fullPath).split(path.sep).join('/');
}

/**
 * Writes `files` (name -> content) into a fresh sandbox tests dir, plus an
 * allowlist JSON and a ceiling JSON, then invokes the script via its three
 * env-var overrides.
 *
 * @param {object} opts
 * @param {Object<string,string>} opts.files - filename -> file content.
 * @param {string[]} [opts.allowlist] - allowlist array (default []).
 * @param {{maxFiles:number,grace:number}} [opts.ceiling] - default is
 *   deliberately generous so a case testing ONLY the citation check does not
 *   accidentally also trip the ceiling check.
 * @param {string[]} [opts.args] - extra CLI argv.
 */
function runLint({ files, allowlist = [], ceiling = { maxFiles: 1000, grace: 1000 }, args = [] }) {
  const testsDir = path.join(sandbox, `tests-${fixtureCount}`);
  fs.mkdirSync(testsDir, { recursive: true });
  const relpaths = {};
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(testsDir, name);
    fs.writeFileSync(full, content);
    relpaths[name] = relToRoot(full);
  }
  const allowlistPath = path.join(sandbox, `allowlist-${fixtureCount}.json`);
  fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));
  const ceilingPath = path.join(sandbox, `ceiling-${fixtureCount}.json`);
  fs.writeFileSync(ceilingPath, JSON.stringify(ceiling));
  fixtureCount += 1;

  const result = runNode([SCRIPT, ...args], {
    cwd: ROOT,
    timeoutMs: PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      GSD_LINT_ALLOW_TEST_RULE_TESTS_DIR: testsDir,
      GSD_LINT_ALLOW_TEST_RULE_ALLOWLIST: allowlistPath,
      GSD_LINT_ALLOW_TEST_RULE_CEILING: ceilingPath,
    },
  });
  return { ...toLegacyResult(result), relpaths, testsDir };
}

describe('lint-allow-test-rule-refs', () => {
  before(() => {
    sandbox = createTempDir('gsd-lint-allow-test-rule-');
  });

  after(() => {
    cleanup(sandbox);
  });

  test('passes when a known uncited exemption is grandfathered', () => {
    const files = { 'foo.test.cjs': `// ${MARKER} some-reason\n` };
    const testsDir = path.join(sandbox, `tests-${fixtureCount}`);
    fs.mkdirSync(testsDir, { recursive: true });
    const full = path.join(testsDir, 'foo.test.cjs');
    fs.writeFileSync(full, files['foo.test.cjs']);
    const relpath = relToRoot(full);
    const allowlistPath = path.join(sandbox, `allowlist-${fixtureCount}.json`);
    fs.writeFileSync(allowlistPath, JSON.stringify([`${relpath} :: some-reason`]));
    const ceilingPath = path.join(sandbox, `ceiling-${fixtureCount}.json`);
    fs.writeFileSync(ceilingPath, JSON.stringify({ maxFiles: 100, grace: 100 }));
    fixtureCount += 1;

    const r = toLegacyResult(
      runNode([SCRIPT], {
        cwd: ROOT,
        timeoutMs: PROBE_TIMEOUT_MS,
        env: {
          ...process.env,
          GSD_LINT_ALLOW_TEST_RULE_TESTS_DIR: testsDir,
          GSD_LINT_ALLOW_TEST_RULE_ALLOWLIST: allowlistPath,
          GSD_LINT_ALLOW_TEST_RULE_CEILING: ceilingPath,
        },
      })
    );
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('fails on a novel uncited exemption not in the allowlist', () => {
    const r = runLint({
      files: { 'foo.test.cjs': `// ${MARKER} mystery-reason\n` },
      allowlist: [],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /mystery-reason/);
  });

  test('fails on a stale allowlist entry (ratchet-down enforcement)', () => {
    const r = runLint({
      files: { 'foo.test.cjs': 'no marker here\n' },
      allowlist: ['tests/definitely-stale-file.test.cjs :: stale-reason'],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /stale-reason/);
    assert.match(r.stderr, /definitely-stale-file\.test\.cjs/);
  });

  test('passes when exemption-file count == ceiling exactly (boundary)', () => {
    const r = runLint({
      files: {
        'a.test.cjs': `// ${MARKER} see #123\n`,
        'b.test.cjs': `// ${MARKER} see #123\n`,
        'c.test.cjs': `// ${MARKER} see #123\n`,
      },
      allowlist: [],
      ceiling: { maxFiles: 3, grace: 0 },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('passes when exemption-file count == ceiling - 1 (limit-1 boundary)', () => {
    // 2 files, ceiling {maxFiles:3, grace:1} -> slack = 3-2 = 1, not > grace.
    // NOTE: grace:0 here (matching the sibling boundary tests) would fail on
    // the SEPARATE slack-ratchet check (slack 1 > grace 0), not the count
    // check this test targets, so grace is widened to 1 to isolate the axis
    // under test.
    const r = runLint({
      files: {
        'a.test.cjs': `// ${MARKER} see #123\n`,
        'b.test.cjs': `// ${MARKER} see #123\n`,
      },
      allowlist: [],
      ceiling: { maxFiles: 3, grace: 1 },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('fails when exemption-file count == ceiling + 1 (limit+1 boundary)', () => {
    const r = runLint({
      files: {
        'a.test.cjs': `// ${MARKER} see #123\n`,
        'b.test.cjs': `// ${MARKER} see #123\n`,
        'c.test.cjs': `// ${MARKER} see #123\n`,
        'd.test.cjs': `// ${MARKER} see #123\n`,
      },
      allowlist: [],
      ceiling: { maxFiles: 3, grace: 0 },
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /exceeds budget ceiling/);
  });

  test('passes when slack == grace exactly (boundary)', () => {
    // 2 files, ceiling {maxFiles:5, grace:3} -> slack = 5-2 = 3, not > grace.
    const r = runLint({
      files: {
        'a.test.cjs': `// ${MARKER} see #123\n`,
        'b.test.cjs': `// ${MARKER} see #123\n`,
      },
      allowlist: [],
      ceiling: { maxFiles: 5, grace: 3 },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('passes when slack == grace - 1 (limit-1 boundary)', () => {
    // 3 files, ceiling {maxFiles:5, grace:3} -> slack = 5-3 = 2, less than grace (2 < 3, not > grace).
    const r = runLint({
      files: {
        'a.test.cjs': `// ${MARKER} see #123\n`,
        'b.test.cjs': `// ${MARKER} see #123\n`,
        'c.test.cjs': `// ${MARKER} see #123\n`,
      },
      allowlist: [],
      ceiling: { maxFiles: 5, grace: 3 },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('fails when slack == grace + 1 (one past boundary)', () => {
    // 1 file, ceiling {maxFiles:5, grace:3} -> slack = 5-1 = 4 > grace.
    const r = runLint({
      files: {
        'a.test.cjs': `// ${MARKER} see #123\n`,
      },
      allowlist: [],
      ceiling: { maxFiles: 5, grace: 3 },
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Tighten the ceiling/);
  });

  test('a cited exemption passes the citation check with an empty allowlist', () => {
    const r = runLint({
      files: { 'cited.test.cjs': `// ${MARKER} see #456\n` },
      allowlist: [],
      ceiling: { maxFiles: 100, grace: 100 },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('the SAME cited exemption still counts toward the ceiling total', () => {
    const r = runLint({
      files: { 'cited.test.cjs': `// ${MARKER} see #456\n` },
      allowlist: [],
      ceiling: { maxFiles: 0, grace: 0 },
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /allow-test-rule-total-files/);
  });

  test('a duplicate uncited reason in one file dedupes to one identifier', () => {
    const files = {
      'dup.test.cjs': `// ${MARKER} dup-reason\n// ${MARKER} dup-reason\n`,
    };
    const testsDir = path.join(sandbox, `tests-${fixtureCount}`);
    fs.mkdirSync(testsDir, { recursive: true });
    const full = path.join(testsDir, 'dup.test.cjs');
    fs.writeFileSync(full, files['dup.test.cjs']);
    const relpath = relToRoot(full);
    const allowlistPath = path.join(sandbox, `allowlist-${fixtureCount}.json`);
    // A SINGLE allowlist entry suffices — if the dedupe regressed (two
    // identifiers produced), this single-entry allowlist would leave one
    // novel offender and fail.
    fs.writeFileSync(allowlistPath, JSON.stringify([`${relpath} :: dup-reason`]));
    const ceilingPath = path.join(sandbox, `ceiling-${fixtureCount}.json`);
    fs.writeFileSync(ceilingPath, JSON.stringify({ maxFiles: 100, grace: 100 }));
    fixtureCount += 1;

    const r = toLegacyResult(
      runNode([SCRIPT], {
        cwd: ROOT,
        timeoutMs: PROBE_TIMEOUT_MS,
        env: {
          ...process.env,
          GSD_LINT_ALLOW_TEST_RULE_TESTS_DIR: testsDir,
          GSD_LINT_ALLOW_TEST_RULE_ALLOWLIST: allowlistPath,
          GSD_LINT_ALLOW_TEST_RULE_CEILING: ceilingPath,
        },
      })
    );
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('repo baseline passes (real tests/ dir against real allowlist + ceiling)', () => {
    const r = runNode([SCRIPT], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  });

  test('unknown CLI arguments are rejected with exit code 2', () => {
    const r = runLint({ files: {}, allowlist: [], args: ['--bogus'] });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown argument/);
    assert.match(r.stderr, /--bogus/);
  });
});
