'use strict';

/**
 * Regression test for #114 — npm dependency integrity gate.
 *
 * Verifies that scripts/check-npm-integrity.cjs correctly detects:
 *   1. Clean install  — exits 0, no stderr findings
 *   2. Version drift  — exits 1, stderr names the offending package + both versions
 *                       (reproduces the ws 8.20.1 declared vs 8.20.0 installed incident)
 *   3. Extraneous     — exits 1 without --ignore-extraneous; exits 0 with it
 *   4. Missing        — exits 1 regardless of flags
 *
 * Each fixture lives under tests/fixtures/npm-integrity/<name>/.
 * The test spawns the script as a subprocess — no require/import of internals.
 *
 * Sources:
 *   - npm CLI docs: https://docs.npmjs.com/cli/v10/commands/npm-ls
 *   - NIST SSDF PW.4.1: https://csrc.nist.gov/publications/detail/sp/800-218/final
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-npm-integrity.cjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'npm-integrity');

/**
 * Run the integrity gate script against a fixture directory.
 *
 * @param {string} fixtureName  - subdirectory under tests/fixtures/npm-integrity/
 * @param {string[]} [extraArgs] - additional CLI args passed to the script
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runGate(fixtureName, extraArgs = []) {
  const fixtureDir = path.join(FIXTURES, fixtureName);
  const r = runNode([SCRIPT, ...extraArgs], { cwd: fixtureDir, timeoutMs: 30_000 });
  return {
    status: r.exitCode ?? 1,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

// ─── Scenario 1: Clean ───────────────────────────────────────────────────────

describe('#114: npm integrity gate — clean fixture', () => {
  test('exits 0 when install matches lockfile', () => {
    const { status } = runGate('clean');
    assert.strictEqual(status, 0, 'expected exit 0 for clean install');
  });

  test('emits no integrity findings to stderr on clean install', () => {
    const { stderr } = runGate('clean');
    // No "FAIL:" lines expected
    assert.ok(
      !stderr.includes('FAIL:'),
      `expected no FAIL: lines in stderr; got:\n${stderr}`
    );
  });
});

// ─── Scenario 2: Drift (declared vs installed mismatch) ─────────────────────
// Reproduces: ws 8.20.1 declared in lockfile, 8.20.0 installed in node_modules
// Fixture uses: stable-dep@8.20.1 (declared) vs stable-dep@8.20.0 (installed)

describe('#114: npm integrity gate — drift fixture (declared vs installed mismatch)', () => {
  test('exits 1 on version drift', () => {
    const { status } = runGate('drift');
    assert.strictEqual(status, 1, 'expected exit 1 for version drift');
  });

  test('stderr names the offending package', () => {
    const { stderr } = runGate('drift');
    assert.ok(
      stderr.includes('stable-dep'),
      `expected stderr to name "stable-dep"; got:\n${stderr}`
    );
  });

  test('stderr includes both the declared and installed versions', () => {
    const { stderr } = runGate('drift');
    assert.ok(
      stderr.includes('8.20.0'),
      `expected stderr to include installed version "8.20.0"; got:\n${stderr}`
    );
    assert.ok(
      stderr.includes('8.20.1'),
      `expected stderr to include declared version "8.20.1"; got:\n${stderr}`
    );
  });
});

// ─── Scenario 3: Extraneous ──────────────────────────────────────────────────

describe('#114: npm integrity gate — extraneous fixture', () => {
  test('exits 1 when extraneous package present (default behavior)', () => {
    const { status } = runGate('extraneous');
    assert.strictEqual(status, 1, 'expected exit 1 for extraneous package without --ignore-extraneous');
  });

  test('stderr names the extraneous package', () => {
    const { stderr } = runGate('extraneous');
    assert.ok(
      stderr.includes('ghost-pkg'),
      `expected stderr to name "ghost-pkg"; got:\n${stderr}`
    );
  });

  test('exits 0 with --ignore-extraneous flag', () => {
    const { status } = runGate('extraneous', ['--ignore-extraneous']);
    assert.strictEqual(status, 0, 'expected exit 0 for extraneous package with --ignore-extraneous');
  });
});

// ─── Scenario 4: Missing ─────────────────────────────────────────────────────

describe('#114: npm integrity gate — missing fixture', () => {
  test('exits 1 when required package is missing from node_modules', () => {
    const { status } = runGate('missing');
    assert.strictEqual(status, 1, 'expected exit 1 for missing package');
  });

  test('stderr names the missing package', () => {
    const { stderr } = runGate('missing');
    assert.ok(
      stderr.includes('absent-dep'),
      `expected stderr to name "absent-dep"; got:\n${stderr}`
    );
  });

  test('exits 1 even with --ignore-extraneous (missing is not extraneous)', () => {
    const { status } = runGate('missing', ['--ignore-extraneous']);
    assert.strictEqual(status, 1, 'expected exit 1 for missing package even with --ignore-extraneous');
  });
});

// ─── Smoke test: --help ───────────────────────────────────────────────────────

describe('#114: npm integrity gate — --help output', () => {
  test('exits 0 with --help flag', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    assert.strictEqual(result.status, 0, '--help should exit 0');
  });

  test('--help output mentions --ignore-extraneous', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    // The .cjs script writes --help to stdout.
    const helpText = (result.stdout ?? '') + (result.stderr ?? '');
    assert.ok(
      helpText.includes('--ignore-extraneous'),
      `expected --help output to document --ignore-extraneous; got:\n${helpText}`
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3588-npm-audit-clean.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3588-npm-audit-clean (consolidation epic #1969 B6 #1975)", () => {
'use strict';

/**
 * Regression test for #3588 — production dependency tree must not carry
 * high or moderate npm-audit advisories.
 *
 * Strategy: run `npm audit --omit=dev --json` against both the root
 * workspace and the embedded SDK package, then diff the resulting
 * vulnerable-package set against a baseline tree (see #4196 and
 * scripts/npm-audit-baseline.cjs) so the gate only fails on advisories
 * this PR/push actually introduces — not on pre-existing advisories in
 * an untouched transitive dependency. When no baseline can be resolved,
 * falls back to the original zero-tolerance check across
 * info/low/moderate/high/critical.
 *
 * If a future advisory lands without an upstream patch on a package this
 * PR touches, either bump the patched transitive (preferred), or annotate
 * the acceptance below with a justification AND a link to the upstream
 * tracker.
 *
 * Skips automatically when `node_modules/` is absent (a fresh checkout
 * before `npm install`) so the test does not falsely report on developer
 * machines mid-setup.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  evaluateAuditDiff,
  runPackageLockAudit,
  runInstalledTreeAudit,
  extractBaselineTree,
  resolveBaselineRef,
  AUDIT_ATTEMPT_TIMEOUT_MS,
  AUDIT_MAX_ATTEMPTS,
  AUDIT_BACKOFF_BASE_MS,
} = require('../scripts/npm-audit-baseline.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const SDK = path.join(ROOT, 'sdk');

// Worst case for ONE retry-audit call: every attempt times out, with
// exponential backoff between each (AUDIT_MAX_ATTEMPTS - 1 gaps) -- computed
// with the SAME formula scripts/npm-audit-baseline.cjs uses internally, so
// this can't independently drift from the real backoff schedule.
let totalBackoffMs = 0;
for (let attempt = 1; attempt < AUDIT_MAX_ATTEMPTS; attempt += 1) {
  totalBackoffMs += AUDIT_BACKOFF_BASE_MS * (2 ** (attempt - 1));
}
const SINGLE_AUDIT_WORST_CASE_MS = (AUDIT_ATTEMPT_TIMEOUT_MS * AUDIT_MAX_ATTEMPTS) + totalBackoffMs;
// checkTreeAgainstBaseline makes up to TWO sequential retry-audit calls
// (auditProductionVulns for HEAD, runPackageLockAudit for the baseline) --
// budget for both exhausting retries simultaneously, or node:test's own
// timeout fires first and masks buildTimeoutKillError's clear message.
const TEST_TIMEOUT_MS = (SINGLE_AUDIT_WORST_CASE_MS * 2) + 30_000;

function auditProductionVulns(cwd, opts = {}) {
  return runInstalledTreeAudit(cwd, opts);
}

describe('#3588: npm audit --omit=dev introduces no NEW advisories vs baseline (#4196)', () => {
  // #4196: a pre-existing advisory in an untouched transitive dependency
  // must not block this PR/push -- only an advisory THIS change actually
  // introduces should fail the gate. When no baseline can be resolved
  // (e.g. a bare local run with no git history), fall back to the
  // original #3588 zero-tolerance behavior rather than silently skipping.
  function checkTreeAgainstBaseline(t, cwd, subdir, skipMessage) {
    const audit = auditProductionVulns(cwd);
    if (audit === null) {
      t.skip(skipMessage);
      return;
    }
    const baselineRef = resolveBaselineRef(ROOT);
    const baselineDir = baselineRef ? extractBaselineTree(baselineRef, ROOT, subdir) : null;
    if (baselineDir === null) {
      const vulns = audit.metadata.vulnerabilities;
      assert.strictEqual(vulns.critical, 0, `no baseline available; falling back to zero-tolerance -- expected 0 critical; got ${vulns.critical}`);
      assert.strictEqual(vulns.high, 0, `no baseline available; falling back to zero-tolerance -- expected 0 high; got ${vulns.high}`);
      assert.strictEqual(vulns.moderate, 0, `no baseline available; falling back to zero-tolerance -- expected 0 moderate; got ${vulns.moderate}`);
      assert.strictEqual(vulns.low, 0, `no baseline available; falling back to zero-tolerance -- expected 0 low; got ${vulns.low}`);
      return;
    }
    t.after(() => cleanup(baselineDir));
    const baselineAudit = runPackageLockAudit(baselineDir);
    const baselineVulns = (baselineAudit && baselineAudit.vulnerabilities) || {};
    const result = evaluateAuditDiff({
      baselineVulnerabilities: baselineVulns,
      headVulnerabilities: audit.vulnerabilities || {},
    });
    assert.strictEqual(
      result.ok,
      true,
      result.ok
        ? ''
        : `new advisory introduced vs baseline (${baselineRef}): ${result.newlyIntroduced.join(', ')}. Pre-existing advisories are tracked separately (see #4196) and do not block this change.`,
    );
  }

  test('root workspace production tree introduces no new advisories', { timeout: TEST_TIMEOUT_MS }, (t) => {
    checkTreeAgainstBaseline(t, ROOT, '', 'auditable npm package not present or node_modules/ missing');
  });

  test('sdk/ production tree introduces no new advisories', { timeout: TEST_TIMEOUT_MS }, (t) => {
    checkTreeAgainstBaseline(t, SDK, 'sdk', 'sdk/ is not an auditable npm package or sdk/node_modules/ is missing');
  });
});

describe('auditProductionVulns — timeout-kill retry classification (#4250, #4260)', () => {
  function makeFixtureDir(t) {
    const dir = createTempDir('gsd-audit-baseline-timeout-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}');
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
      () => auditProductionVulns(dir, { execFileSyncImpl, sleepImpl }),
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

    const result = auditProductionVulns(dir, { execFileSyncImpl, sleepImpl });
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

    const result = auditProductionVulns(dir, { execFileSyncImpl });
    assert.deepStrictEqual(result.metadata.vulnerabilities, { high: 1 });
  });
});
  });
}
