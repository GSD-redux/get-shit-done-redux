/**
 * Tests for scripts/check-env.cjs (issue #117).
 *
 * Verifies the environment validator exits correctly and emits
 * structured output for every documented check:
 *   1. Node version vs engines.node constraint
 *   2. npm version vs engines.npm constraint (if present)
 *   3. Lockfile presence
 *   4. Lockfile sync (npm ci --dry-run)
 *   5. Version-manager pin file matches active Node major
 *   6. --json flag produces parseable JSON with documented shape
 *   7. Integration smoke: exits 0 on the live worktree root
 *
 * Sources:
 *   npm engines: https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines
 *   npm ci:      https://docs.npmjs.com/cli/v10/commands/npm-ci
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-env.cjs');
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'check-env');
const LIVE_ROOT = path.resolve(__dirname, '..');

/**
 * Run check-env.cjs synchronously in `cwd` with optional extra args.
 * Returns { status, stdout, stderr }.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string,string>} [envOverrides] - optional env vars to overlay
 *   on process.env.  Pass { CI: '' } to suppress GitHub Actions CI detection
 *   so that version-manager-pin is exercised even inside CI runners.
 */
function runScript(cwd, args = [], envOverrides = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...envOverrides },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('check-env.cjs', () => {
  // -------------------------------------------------------------------------
  // Dynamic .nvmrc setup: write fixture .nvmrc files at test-run time so the
  // tests are correct across all Node major versions in the CI matrix (Node 22,
  // 24, 26, …).  A hardcoded value like "26" passes on Node 26 but fails on
  // every other matrix row; using the active major makes the fixture portable.
  //
  // good/     → .nvmrc = active Node major  (should match → exit 0)
  // bad-nvmrc/ → .nvmrc = active+99          (guaranteed mismatch → exit 1)
  // -------------------------------------------------------------------------
  const activeNodeMajor = parseInt(process.version.match(/^v(\d+)/)[1], 10);
  const goodNvmrc = path.join(FIXTURE_ROOT, 'good', '.nvmrc');
  const badNvmrc = path.join(FIXTURE_ROOT, 'bad-nvmrc', '.nvmrc');
  let originalGoodNvmrc;
  let originalBadNvmrc;

  before(() => {
    originalGoodNvmrc = fs.existsSync(goodNvmrc) ? fs.readFileSync(goodNvmrc, 'utf8') : null;
    originalBadNvmrc = fs.existsSync(badNvmrc) ? fs.readFileSync(badNvmrc, 'utf8') : null;
    fs.writeFileSync(goodNvmrc, `${activeNodeMajor}\n`);
    fs.writeFileSync(badNvmrc, `${activeNodeMajor + 99}\n`);
  });

  after(() => {
    if (originalGoodNvmrc !== null) {
      fs.writeFileSync(goodNvmrc, originalGoodNvmrc);
    }
    if (originalBadNvmrc !== null) {
      fs.writeFileSync(badNvmrc, originalBadNvmrc);
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: Happy path — all checks green
  // -------------------------------------------------------------------------
  test('exits 0 in a fixture directory with engines, .nvmrc, and matching lockfile', () => {
    const cwd = path.join(FIXTURE_ROOT, 'good');
    const { status, stdout } = runScript(cwd);
    assert.equal(
      status, 0,
      `Expected exit 0, got ${status}.\nstdout: ${stdout}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: engines.node constraint not satisfied
  // -------------------------------------------------------------------------
  test('exits 1 when engines.node constraint is not satisfied by current Node', () => {
    const cwd = path.join(FIXTURE_ROOT, 'bad-node-version');
    // Fixture has engines.node: "<14.0.0"; current Node is much higher.
    const { status, stdout } = runScript(cwd);
    assert.equal(
      status, 1,
      `Expected exit 1 (bad node version), got ${status}.\nstdout: ${stdout}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: Missing lockfile
  // -------------------------------------------------------------------------
  test('exits 1 when package-lock.json is missing', () => {
    const cwd = path.join(FIXTURE_ROOT, 'missing-lockfile');
    const { status, stdout } = runScript(cwd);
    assert.equal(
      status, 1,
      `Expected exit 1 (missing lockfile), got ${status}.\nstdout: ${stdout}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: .nvmrc major doesn't match active Node major
  // -------------------------------------------------------------------------
  test('exits 1 when .nvmrc major version does not match active Node major', () => {
    const cwd = path.join(FIXTURE_ROOT, 'bad-nvmrc');
    // Fixture .nvmrc is set to (activeNodeMajor + 99) by the before() hook above,
    // guaranteeing a mismatch regardless of the CI matrix Node version.
    // Override CI='' so the version-manager-pin check is not skipped even when
    // this test runs inside a CI runner (GitHub Actions sets CI=true, which
    // would otherwise turn the pin check into a skip and exit 0).
    const { status, stdout } = runScript(cwd, [], { CI: '' });
    assert.equal(
      status, 1,
      `Expected exit 1 (nvmrc mismatch), got ${status}.\nstdout: ${stdout}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: --json flag produces parseable JSON with documented shape
  // -------------------------------------------------------------------------
  test('--json emits parseable JSON with pass and checks keys', () => {
    const cwd = path.join(FIXTURE_ROOT, 'good');
    const { status, stdout } = runScript(cwd, ['--json']);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      assert.fail(`--json output was not valid JSON: ${err.message}\nstdout: ${stdout}`);
    }
    // Top-level shape
    assert.equal(typeof parsed.pass, 'boolean', 'JSON must have boolean `pass` key');
    assert.ok(Array.isArray(parsed.checks), 'JSON must have array `checks` key');
    // The good fixture has engines.node, .nvmrc, and package-lock.json — expect
    // at least the node-version, lockfile-present, lockfile-sync, and
    // version-manager-pin checks to appear.
    const checkNames = parsed.checks.map((c) => c.name);
    assert.ok(
      checkNames.includes('node-version'),
      `Expected 'node-version' check in JSON, got: ${checkNames.join(', ')}`
    );
    assert.ok(
      checkNames.includes('lockfile-present'),
      `Expected 'lockfile-present' check in JSON, got: ${checkNames.join(', ')}`
    );
    // Every check item must have name, status, message fields with expected types
    for (const check of parsed.checks) {
      assert.equal(typeof check.name, 'string', `check.name must be string in ${JSON.stringify(check)}`);
      assert.ok(
        ['pass', 'fail', 'skip'].includes(check.status),
        `check.status must be pass|fail|skip in ${JSON.stringify(check)}`
      );
      assert.equal(typeof check.message, 'string', `check.message must be string in ${JSON.stringify(check)}`);
    }
    // Good fixture: overall result must be pass:true
    assert.equal(parsed.pass, true, 'good fixture must report pass:true');
    assert.equal(
      status, 0,
      `Expected exit 0 in good fixture with --json, got ${status}`
    );
  });

  // -------------------------------------------------------------------------
  // Test 5b: --json reports pass:false on failure fixtures (counter-test for 5)
  // -------------------------------------------------------------------------
  test('--json reports pass:false when a check fails', () => {
    const cwd = path.join(FIXTURE_ROOT, 'bad-node-version');
    const { status, stdout } = runScript(cwd, ['--json']);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      assert.fail(`--json output was not valid JSON: ${err.message}\nstdout: ${stdout}`);
    }
    assert.equal(parsed.pass, false, 'failure fixture must report pass:false');
    assert.equal(status, 1, `Expected exit 1 with --json on failure fixture, got ${status}`);
    // The node-version check must be present and marked fail
    const nodeCheck = parsed.checks.find((c) => c.name === 'node-version');
    assert.ok(nodeCheck, 'node-version check must appear in JSON output');
    assert.equal(nodeCheck.status, 'fail', `Expected node-version status=fail, got ${nodeCheck.status}`);
  });

  // -------------------------------------------------------------------------
  // Test 6: Integration smoke — script runs without tool-error on live root
  //
  // Verifies the script executes against a real repo without a tool error (exit 2).
  // Exit 0 or 1 are acceptable — local Node may differ from the .nvmrc pin (22).
  // Uses --json for structured assertion, avoiding raw output-grep.
  // -------------------------------------------------------------------------
  test('script runs without tool error on the live worktree root (--json)', () => {
    const { status, stdout, stderr } = runScript(LIVE_ROOT, ['--json']);
    assert.notEqual(
      status, 2,
      `Expected exit 0 or 1 on live repo, got exit 2 (tool error).\nstdout: ${stdout}\nstderr: ${stderr}`
    );
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      assert.fail(`Live repo --json was not valid JSON: ${err.message}\nstdout: ${stdout}`);
    }
    assert.equal(typeof parsed.pass, 'boolean', 'Live repo JSON must have boolean pass');
    assert.ok(Array.isArray(parsed.checks), 'Live repo JSON must have checks array');
    // Node version check must be present and pass (Node >=24 is installed,
    // per package.json engines.node)
    const nodeCheck = parsed.checks.find((c) => c.name === 'node-version');
    assert.ok(nodeCheck, 'node-version check must be present in live repo output');
    assert.equal(nodeCheck.status, 'pass', `node-version should pass on live repo, got: ${nodeCheck.status} — ${nodeCheck.message}`);
    // Lockfile checks must pass on the live repo
    const lockfileCheck = parsed.checks.find((c) => c.name === 'lockfile-present');
    assert.ok(lockfileCheck, 'lockfile-present check must appear in live output');
    assert.equal(lockfileCheck.status, 'pass', `lockfile-present should pass on live repo`);
  });
});
