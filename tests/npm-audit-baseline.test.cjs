'use strict';

/**
 * Unit tests for scripts/npm-audit-baseline.cjs (#4196).
 *
 * Covers the pure diff/verdict functions directly, plus the git-object-level
 * extraction and env-driven ref resolution using real throwaway git fixture
 * repos (no network, no real npm registry round-trip -- runPackageLockAudit
 * is only exercised here for its filesystem-only skip conditions).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  AUDIT_DIFF_REASON,
  diffNewVulnerablePackages,
  evaluateAuditDiff,
  runPackageLockAudit,
  runInstalledTreeAudit,
  runNpmAuditWithRetry,
  extractBaselineTree,
  resolveBaselineRef,
  isTimeoutKill,
  buildTimeoutKillError,
  AUDIT_BACKOFF_BASE_MS,
  NULL_SHA,
} = require('../scripts/npm-audit-baseline.cjs');

const { createTempDir, cleanup } = require('./helpers.cjs');

const GIT_TIMEOUT_MS = 30_000;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
}

/**
 * Builds a throwaway git repo with one commit containing package.json +
 * package-lock.json (and optionally under a subdir), returning
 * { dir, commitSha }.
 */
function makeCommittedFixtureRepo(t, { subdir = '', pkgContent = '{"name":"fixture"}', lockContent = '{"lockfileVersion":3}' } = {}) {
  const dir = createTempDir('gsd-audit-baseline-fixture-');
  t.after(() => cleanup(dir));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  const targetDir = subdir ? path.join(dir, subdir) : dir;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'package.json'), pkgContent);
  fs.writeFileSync(path.join(targetDir, 'package-lock.json'), lockContent);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'fixture commit'], dir);
  const commitSha = git(['rev-parse', 'HEAD'], dir);
  return { dir, commitSha };
}

// ─── diffNewVulnerablePackages ────────────────────────────────────────────

describe('diffNewVulnerablePackages', () => {
  test('empty baseline + empty head -> []', () => {
    assert.deepStrictEqual(diffNewVulnerablePackages({}, {}), []);
  });

  test('baseline and head share the same packages -> [] (nothing new)', () => {
    const baseline = { a: {}, b: {} };
    const head = { a: {}, b: {} };
    assert.deepStrictEqual(diffNewVulnerablePackages(baseline, head), []);
  });

  test('head adds a package not in baseline -> only the addition', () => {
    const baseline = { a: {} };
    const head = { a: {}, b: {} };
    assert.deepStrictEqual(diffNewVulnerablePackages(baseline, head), ['b']);
  });

  test('empty baseline, head has one package -> that package', () => {
    assert.deepStrictEqual(diffNewVulnerablePackages({}, { a: {} }), ['a']);
  });

  test('packages removed from head (present in baseline only) are not "new"', () => {
    const baseline = { a: {}, b: {}, c: {} };
    const head = { a: {} };
    assert.deepStrictEqual(diffNewVulnerablePackages(baseline, head), []);
  });

  test('baseline and head both undefined -> [] (must not throw)', () => {
    assert.deepStrictEqual(diffNewVulnerablePackages(undefined, undefined), []);
  });
});

// ─── evaluateAuditDiff ─────────────────────────────────────────────────────

describe('evaluateAuditDiff', () => {
  test('no new packages -> ok:true with OK_NO_NEW_VULNERABILITIES and preExisting list', () => {
    const baselineVulnerabilities = { a: {} };
    const headVulnerabilities = { a: {} };
    const result = evaluateAuditDiff({ baselineVulnerabilities, headVulnerabilities });
    assert.deepStrictEqual(result, {
      ok: true,
      reason: AUDIT_DIFF_REASON.OK_NO_NEW_VULNERABILITIES,
      preExisting: ['a'],
    });
  });

  test('one new package -> ok:false with FAIL_NEW_VULNERABLE_PACKAGE and exact newlyIntroduced', () => {
    const baselineVulnerabilities = { a: {} };
    const headVulnerabilities = { a: {}, b: {} };
    const result = evaluateAuditDiff({ baselineVulnerabilities, headVulnerabilities });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, AUDIT_DIFF_REASON.FAIL_NEW_VULNERABLE_PACKAGE);
    assert.deepStrictEqual(result.newlyIntroduced, ['b']);
  });

  test('multiple new packages -> all listed', () => {
    const baselineVulnerabilities = {};
    const headVulnerabilities = { a: {}, b: {}, c: {} };
    const result = evaluateAuditDiff({ baselineVulnerabilities, headVulnerabilities });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.newlyIntroduced.sort(), ['a', 'b', 'c']);
  });
});

// ─── resolveBaselineRef ─────────────────────────────────────────────────────

describe('resolveBaselineRef', () => {
  const envKeys = ['AUDIT_BASELINE_REF', 'GITHUB_BASE_REF', 'GITHUB_EVENT_NAME'];
  let originalEnv;

  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test('AUDIT_BASELINE_REF set -> returned verbatim, highest priority even with others set', (t) => {
    const { dir } = makeCommittedFixtureRepo(t);
    process.env.AUDIT_BASELINE_REF = 'some/explicit-ref';
    process.env.GITHUB_BASE_REF = 'next';
    process.env.GITHUB_EVENT_NAME = 'push';
    assert.strictEqual(resolveBaselineRef(dir), 'some/explicit-ref');
  });

  test('AUDIT_BASELINE_REF unset, GITHUB_BASE_REF=next -> origin/next', (t) => {
    const { dir } = makeCommittedFixtureRepo(t);
    process.env.GITHUB_BASE_REF = 'next';
    assert.strictEqual(resolveBaselineRef(dir), 'origin/next');
  });

  test('neither set, push event, HEAD~1 resolves -> returns that parent sha', (t) => {
    const dir = createTempDir('gsd-audit-baseline-fixture-');
    t.after(() => cleanup(dir));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'first commit'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'second');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'second commit'], dir);

    // Compute expected parent sha independently, not via resolveBaselineRef.
    const expectedParentSha = git(['rev-parse', 'HEAD~1'], dir);

    process.env.GITHUB_EVENT_NAME = 'push';
    assert.strictEqual(resolveBaselineRef(dir), expectedParentSha);
  });

  test('NULL_SHA is the documented all-zeros 40-char sentinel', () => {
    assert.strictEqual(NULL_SHA, '0'.repeat(40));
    assert.strictEqual(NULL_SHA.length, 40);
  });

  test('push event but only one commit (HEAD~1 does not exist) falls through without choking', (t) => {
    const dir = createTempDir('gsd-audit-baseline-fixture-');
    t.after(() => cleanup(dir));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'only');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'only commit'], dir);

    process.env.GITHUB_EVENT_NAME = 'push';
    // No origin/next remote-tracking ref exists in this throwaway repo, so
    // this must fall all the way through to ''.
    assert.strictEqual(resolveBaselineRef(dir), '');
  });

  test('no origin/next, but a plain local branch named next exists -> returns "next"', (t) => {
    const dir = createTempDir('gsd-audit-baseline-fixture-');
    t.after(() => cleanup(dir));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'first commit'], dir);
    // rename the default branch to "next" so it's a plain LOCAL branch, not
    // a remote-tracking origin/next ref -- mirrors gsd-test's sandbox shape.
    git(['branch', '-M', 'next'], dir);

    process.env.GITHUB_EVENT_NAME = 'push';
    assert.strictEqual(resolveBaselineRef(dir), 'next');
  });

  test('nothing resolves at all (no env vars, not a git repo) -> returns ""', (t) => {
    const dir = createTempDir('gsd-audit-baseline-nongit-');
    t.after(() => cleanup(dir));
    assert.strictEqual(resolveBaselineRef(dir), '');
  });
});

// ─── extractBaselineTree ─────────────────────────────────────────────────────

describe('extractBaselineTree', () => {
  test('extracts package.json + package-lock.json at root from a real commit', (t) => {
    const pkgContent = JSON.stringify({ name: 'root-fixture' });
    const lockContent = JSON.stringify({ lockfileVersion: 3, name: 'root-fixture' });
    const { dir, commitSha } = makeCommittedFixtureRepo(t, { pkgContent, lockContent });

    const extracted = extractBaselineTree(commitSha, dir);
    assert.notStrictEqual(extracted, null);
    t.after(() => cleanup(extracted));

    assert.strictEqual(fs.readFileSync(path.join(extracted, 'package.json'), 'utf-8'), pkgContent);
    assert.strictEqual(fs.readFileSync(path.join(extracted, 'package-lock.json'), 'utf-8'), lockContent);
  });

  test('extracts package.json + package-lock.json from a subdir', (t) => {
    const pkgContent = JSON.stringify({ name: 'sdk-fixture' });
    const lockContent = JSON.stringify({ lockfileVersion: 3, name: 'sdk-fixture' });
    const { dir, commitSha } = makeCommittedFixtureRepo(t, { subdir: 'sdk', pkgContent, lockContent });

    const extracted = extractBaselineTree(commitSha, dir, 'sdk');
    assert.notStrictEqual(extracted, null);
    t.after(() => cleanup(extracted));

    assert.strictEqual(fs.readFileSync(path.join(extracted, 'package.json'), 'utf-8'), pkgContent);
    assert.strictEqual(fs.readFileSync(path.join(extracted, 'package-lock.json'), 'utf-8'), lockContent);
  });

  test('a ref that does not exist -> null', (t) => {
    const { dir } = makeCommittedFixtureRepo(t);
    const bogusSha = 'f'.repeat(40);
    assert.strictEqual(extractBaselineTree(bogusSha, dir), null);
  });

  test('ref exists but package-lock.json was never committed at that ref -> null', (t) => {
    const dir = createTempDir('gsd-audit-baseline-nolock-');
    t.after(() => cleanup(dir));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"nolock"}');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'no lockfile'], dir);
    const sha = git(['rev-parse', 'HEAD'], dir);

    assert.strictEqual(extractBaselineTree(sha, dir), null);
  });
});

// ─── runPackageLockAudit (filesystem-only skip conditions, no registry) ────

describe('runPackageLockAudit', () => {
  test('missing package.json -> null', () => {
    const dir = createTempDir('gsd-audit-baseline-empty-');
    try {
      assert.strictEqual(runPackageLockAudit(dir), null);
    } finally {
      cleanup(dir);
    }
  });

  test('package.json present but no package-lock.json -> null', () => {
    const dir = createTempDir('gsd-audit-baseline-nolock2-');
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"nolock2"}');
      assert.strictEqual(runPackageLockAudit(dir), null);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── runInstalledTreeAudit (filesystem-only skip conditions, no registry) ──

describe('runInstalledTreeAudit', () => {
  test('missing package.json -> null', () => {
    const dir = createTempDir('gsd-audit-installed-empty-');
    try {
      assert.strictEqual(runInstalledTreeAudit(dir), null);
    } finally {
      cleanup(dir);
    }
  });

  test('package.json present but no node_modules -> null', () => {
    const dir = createTempDir('gsd-audit-installed-nomodules-');
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"nomodules"}');
      assert.strictEqual(runInstalledTreeAudit(dir), null);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── isTimeoutKill ───────────────────────────────────────────────────────────

describe('isTimeoutKill', () => {
  test('killed: true -> true', () => {
    assert.strictEqual(isTimeoutKill({ killed: true }), true);
  });

  test('signal set (e.g. SIGTERM) -> true', () => {
    assert.strictEqual(isTimeoutKill({ signal: 'SIGTERM' }), true);
  });

  test('both killed and signal set -> true', () => {
    assert.strictEqual(isTimeoutKill({ killed: true, signal: 'SIGTERM' }), true);
  });

  test('neither killed nor signal set (normal non-zero exit) -> false', () => {
    assert.strictEqual(isTimeoutKill({ killed: false, signal: null, status: 1, stdout: '{}' }), false);
  });

  test('killed: false explicitly -> false', () => {
    assert.strictEqual(isTimeoutKill({ killed: false }), false);
  });

  test('null/undefined error -> false, does not throw', () => {
    assert.strictEqual(isTimeoutKill(null), false);
    assert.strictEqual(isTimeoutKill(undefined), false);
  });

  test('plain object with no killed/signal keys at all -> false', () => {
    assert.strictEqual(isTimeoutKill({}), false);
  });
});

// ─── buildTimeoutKillError ───────────────────────────────────────────────────

describe('buildTimeoutKillError', () => {
  test('default attempts (1) uses singular ms-based phrasing, not "N attempts"', () => {
    const err = buildTimeoutKillError('/some/dir', { stderr: 'some stderr text' });
    assert.match(err.message, /npm audit timed out after \d+ms/);
    assert.doesNotMatch(err.message, /attempts/);
    assert.match(err.message, /some stderr text/);
  });

  test('attempts > 1 uses plural "N attempts" phrasing with backoff mention', () => {
    const err = buildTimeoutKillError('/some/dir', { stderr: '' }, 3);
    assert.match(err.message, /npm audit timed out after 3 attempts/);
    assert.match(err.message, /exponential backoff/);
  });

  test('no error object at all still produces a message, no crash', () => {
    const err = buildTimeoutKillError('/some/dir', undefined);
    assert.match(err.message, /npm audit timed out after \d+ms/);
    assert.match(err.message, /no stderr was captured/);
  });
});

// ─── runPackageLockAudit -- timeout-kill classification (#4250) ─────────────

describe('runPackageLockAudit — timeout-kill retry classification (#4250, #4260)', () => {
  function makeFixtureDir(t) {
    const dir = createTempDir('gsd-audit-baseline-timeout-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    return dir;
  }

  function makeKilledError() {
    return Object.assign(new Error('command timed out'), {
      killed: true,
      signal: 'SIGTERM',
      stdout: '{"auditReportVersion":2,"vulnerabi', // deliberately truncated, non-empty
      stderr: 'npm http fetch GET 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk (attempt 1) 178234ms',
    });
  }

  test('a timeout-killed execFileSync call on every attempt throws a clear timeout error after exhausting retries, not a JSON parse error', (t) => {
    const dir = makeFixtureDir(t);
    const execFileSyncImpl = () => { throw makeKilledError(); };
    const sleepImpl = () => {};

    assert.throws(
      () => runPackageLockAudit(dir, { execFileSyncImpl, sleepImpl }),
      (err) => {
        assert.match(err.message, /npm audit timed out after \d+ attempts/);
        assert.match(err.message, /status\.npmjs\.org/);
        assert.doesNotMatch(err.message, /Unexpected end of JSON input/);
        assert.match(err.message, /Captured stderr before the last kill/);
        assert.match(err.message, /npm http fetch GET/);
        return true;
      },
    );
  });

  test('a timeout-killed call with no captured stderr still produces a clear message (no crash on missing stderr)', (t) => {
    const dir = makeFixtureDir(t);
    const killedError = Object.assign(new Error('command timed out'), {
      killed: true,
      signal: 'SIGTERM',
      // no stdout, no stderr at all
    });
    const execFileSyncImpl = () => { throw killedError; };
    const sleepImpl = () => {};

    assert.throws(
      () => runPackageLockAudit(dir, { execFileSyncImpl, sleepImpl }),
      (err) => {
        assert.match(err.message, /npm audit timed out after \d+ attempts/);
        assert.match(err.message, /no stderr was captured/);
        return true;
      },
    );
  });

  test('retry recovers: timeouts on the first attempts followed by a successful final attempt succeeds', (t) => {
    const dir = makeFixtureDir(t);
    const completeJson = JSON.stringify({ metadata: { vulnerabilities: { high: 0 } }, vulnerabilities: {} });
    let calls = 0;
    const execFileSyncImpl = () => {
      calls += 1;
      if (calls < 3) throw makeKilledError();
      return completeJson;
    };
    const sleepImpl = () => {};

    const result = runPackageLockAudit(dir, { execFileSyncImpl, sleepImpl });
    assert.deepStrictEqual(result.metadata.vulnerabilities, { high: 0 });
    assert.strictEqual(calls, 3);
  });

  test('a normal non-zero exit with complete stdout JSON still recovers correctly (no regression)', (t) => {
    const dir = makeFixtureDir(t);
    const completeJson = JSON.stringify({ metadata: { vulnerabilities: { high: 1 } }, vulnerabilities: { foo: {} } });
    const nonZeroExitError = Object.assign(new Error('npm audit found vulnerabilities'), {
      status: 1,
      stdout: completeJson,
    });
    const execFileSyncImpl = () => { throw nonZeroExitError; };

    const result = runPackageLockAudit(dir, { execFileSyncImpl });
    assert.deepStrictEqual(result.metadata.vulnerabilities, { high: 1 });
  });

  test('a real successful call (no throw) still works via the injected impl', (t) => {
    const dir = makeFixtureDir(t);
    const completeJson = JSON.stringify({ metadata: { vulnerabilities: {} }, vulnerabilities: {} });
    const execFileSyncImpl = () => completeJson;

    const result = runPackageLockAudit(dir, { execFileSyncImpl });
    assert.deepStrictEqual(result.metadata.vulnerabilities, {});
  });
});

// ─── runNpmAuditWithRetry — backoff timing (#4260) ──────────────────────────

describe('runNpmAuditWithRetry — backoff timing (#4260)', () => {
  test('a timeout-then-recover attempt sequence sleeps once with the base backoff value', (t) => {
    const dir = createTempDir('gsd-audit-baseline-backoff-');
    t.after(() => cleanup(dir));
    const completeJson = JSON.stringify({ metadata: { vulnerabilities: {} }, vulnerabilities: {} });
    let calls = 0;
    const execFileSyncImpl = () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('command timed out'), { killed: true, signal: 'SIGTERM' });
      }
      return completeJson;
    };
    const sleepCalls = [];
    const sleepImpl = (ms) => sleepCalls.push(ms);

    const parsed = runNpmAuditWithRetry(dir, ['audit', '--json'], { execFileSyncImpl, sleepImpl });

    assert.deepStrictEqual(parsed.metadata.vulnerabilities, {});
    assert.deepStrictEqual(sleepCalls, [AUDIT_BACKOFF_BASE_MS * 1]);
  });
});
