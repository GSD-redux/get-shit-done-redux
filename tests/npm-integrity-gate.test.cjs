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
 * workspace and the embedded SDK package and assert that the metadata
 * vulnerability counts are zero across info/low/moderate/high/critical.
 *
 * The test is intentionally strict — any advisory of any severity (other
 * than 'low' if the maintainer accepts it; that branch is left explicit
 * here) blocks CI. If a future advisory lands without an upstream patch,
 * either bump the patched transitive (preferred), or annotate the
 * acceptance below with a justification AND a link to the upstream tracker.
 *
 * Skips automatically when `node_modules/` is absent (a fresh checkout
 * before `npm install`) so the test does not falsely report on developer
 * machines mid-setup.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SDK = path.join(ROOT, 'sdk');
const AUDIT_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = AUDIT_TIMEOUT_MS + 30_000;

function auditProductionVulns(cwd) {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    return null; // signal "skip" to caller
  }
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    return null; // signal "skip" to caller
  }
  const isWindows = process.platform === 'win32';
  const npmCandidates = isWindows ? ['npm.cmd', 'npm'] : ['npm'];
  const args = ['audit', '--omit=dev', '--json'];
  let out;
  let lastErr = null;
  for (const npmCmd of npmCandidates) {
    try {
      out = execFileSync(
        npmCmd,
        args,
        {
          cwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: AUDIT_TIMEOUT_MS,
          shell: isWindows,
        }
      );
      lastErr = null;
      break;
    } catch (e) {
      // `npm audit` exits non-zero when advisories are present; the JSON is
      // still on stdout in that case. Recover and let the assertion classify.
      if (e && typeof e.stdout !== 'undefined' && e.stdout !== undefined && e.stdout !== null) {
        out = Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf-8') : String(e.stdout);
        lastErr = null;
        break;
      }
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  const parsed = JSON.parse(out);
  // `null` is reserved for the "node_modules missing → skip" signal above.
  // Any other unexpected JSON shape is a real failure of the audit harness
  // (npm changed its output format, audit aborted before metadata, etc.) —
  // throw so the test fails loudly instead of skipping silently.
  if (parsed && parsed.metadata && parsed.metadata.vulnerabilities) {
    return parsed.metadata.vulnerabilities;
  }
  throw new Error(`Unexpected npm audit JSON shape in ${cwd}: missing metadata.vulnerabilities`);
}

describe('#3588: npm audit --omit=dev reports zero advisories', () => {
  test('root workspace production tree has no advisories', { timeout: TEST_TIMEOUT_MS }, (t) => {
    const vulns = auditProductionVulns(ROOT);
    if (vulns === null) {
      t.skip('auditable npm package not present or node_modules/ missing');
      return;
    }
    assert.strictEqual(vulns.critical, 0, `expected 0 critical; got ${vulns.critical}`);
    assert.strictEqual(vulns.high, 0, `expected 0 high; got ${vulns.high}`);
    assert.strictEqual(vulns.moderate, 0, `expected 0 moderate; got ${vulns.moderate}`);
    // Low advisories are not explicitly forbidden by the #3588 acceptance
    // criterion but the issue listed only high/moderate as actual findings —
    // tighten if any future low advisory is introduced.
    assert.strictEqual(vulns.low, 0, `expected 0 low; got ${vulns.low}`);
  });

  test('sdk/ production tree has no advisories', { timeout: TEST_TIMEOUT_MS }, (t) => {
    const vulns = auditProductionVulns(SDK);
    if (vulns === null) {
      t.skip('sdk/ is not an auditable npm package or sdk/node_modules/ is missing');
      return;
    }
    assert.strictEqual(vulns.critical, 0, `expected 0 critical; got ${vulns.critical}`);
    assert.strictEqual(vulns.high, 0, `expected 0 high; got ${vulns.high}`);
    assert.strictEqual(vulns.moderate, 0, `expected 0 moderate; got ${vulns.moderate}`);
    assert.strictEqual(vulns.low, 0, `expected 0 low; got ${vulns.low}`);
  });
});
  });
}
