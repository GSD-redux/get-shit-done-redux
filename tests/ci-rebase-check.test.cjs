'use strict';
/**
 * Tests for scripts/ci-rebase-check.cjs — Codex round 4 P1 regression.
 *
 * The root bug: run() used execFileSync with stdio:'inherit', which returns null
 * on success.  The caller checked `result !== null` to detect success, so the
 * condition was ALWAYS false (null !== null === false) and every successful fetch
 * fell through to the "failed after 3 attempts" exit-1 path.
 *
 * Fix: run() now returns true on success, false on failure, making the boolean
 * check unambiguous regardless of the stdio mode.
 *
 * These tests exercise the run() logic in isolation via subprocess execution,
 * verifying the sentinel behaviour rather than internal module state.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT   = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-rebase-check.cjs');
const NODE   = process.execPath;
const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// ---------------------------------------------------------------------------
// Helper: run a small inline Node snippet that requires the run() helper
// directly from the source (extracted via a thin wrapper).
//
// Because the script has top-level side-effects (git config calls), we cannot
// require() it.  Instead we test the run() sentinel by embedding the function
// body verbatim in a one-shot subprocess.
// ---------------------------------------------------------------------------

function evalRunHelper(stmts) {
  // Inline the exact fixed run() body so the test is tightly coupled to the
  // contract, not some mock.
  const code = `
    'use strict';
    const { execFileSync } = require('child_process');
    function run(cmd, args, opts) {
      try {
        execFileSync(cmd, args, { stdio: 'inherit', ...opts });
        return true;
      } catch (e) {
        return false;
      }
    }
    ${stmts}
  `;
  const r = spawnSync(NODE, ['-e', code], { encoding: 'utf8', timeout: 10_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// Test group 1 — run() sentinel correctness
// ---------------------------------------------------------------------------

describe('ci-rebase-check: run() helper — success sentinel (Codex round 4 P1)', () => {

  test('run() returns true when the command succeeds', () => {
    // Use `node -e ""` (no-op) as a guaranteed-success command that produces no output,
    // avoiding stdout contamination when stdio:'inherit' writes to the same stream.
    const { status, stdout, stderr } = evalRunHelper(`
      const result = run(process.execPath, ['-e', '']);
      process.stdout.write(String(result));
    `);
    assert.strictEqual(status, 0, `subprocess should exit 0; stderr: ${stderr}`);
    assert.strictEqual(stdout, 'true', `run() must return true on success; got: ${stdout}`);
  });

  test('run() returns false when the command fails', () => {
    // An invalid binary name causes execFileSync to throw ENOENT.
    const { status, stdout, stderr } = evalRunHelper(`
      const result = run('__nonexistent_binary_that_cannot_exist__', []);
      process.stdout.write(String(result));
    `);
    assert.strictEqual(status, 0, `subprocess should exit 0; stderr: ${stderr}`);
    assert.strictEqual(stdout, 'false', `run() must return false on failure; got: ${stdout}`);
  });

  test('run() returns true (not null) — counter-test for pre-fix null behaviour', () => {
    // Pre-fix: execFileSync with stdio:'inherit' returns null on success.
    // The old check was `result !== null`, which would be `null !== null === false`.
    // Post-fix: result must be strictly true, making `if (result)` correct.
    // Use `node -e ""` (no-op) so stdio:'inherit' does not pollute our stdout capture.
    const { status, stdout } = evalRunHelper(`
      const result = run(process.execPath, ['-e', '']);
      process.stdout.write(JSON.stringify({ isTrue: result === true, isNull: result === null }));
    `);
    assert.strictEqual(status, 0);
    const { isTrue, isNull } = JSON.parse(stdout);
    assert.strictEqual(isNull,  false, 'run() must NOT return null on success (pre-fix bug)');
    assert.strictEqual(isTrue,  true,  'run() must return exactly true on success');
  });

  test('run() returns false (not null) — failure path also returns boolean', () => {
    const { status, stdout } = evalRunHelper(`
      const result = run('__nonexistent__', []);
      process.stdout.write(JSON.stringify({ isFalse: result === false, isNull: result === null }));
    `);
    assert.strictEqual(status, 0);
    const { isFalse, isNull } = JSON.parse(stdout);
    assert.strictEqual(isNull,  false, 'run() must NOT return null on failure');
    assert.strictEqual(isFalse, true,  'run() must return exactly false on failure');
  });

});

// ---------------------------------------------------------------------------
// Test group 2 — fetch-retry loop uses the boolean correctly
//
// We cannot run the actual git fetch against GitHub in unit tests, but we can
// verify the fetch-loop logic by running the full script against a local git
// repo where GITHUB_TOKEN and GITHUB_REPOSITORY are absent (so remote set-url
// is skipped) and GITHUB_BASE_REF points to a branch that exists locally.
// ---------------------------------------------------------------------------

describe('ci-rebase-check: fetch-retry loop resolves when git fetch succeeds', () => {

  test('script exits 0 when fetch succeeds (local bare remote, clean merge)', () => {
    // Set up: create a temp dir with a local git repo that has a `main` branch.
    // The script will fetch `origin main` from this local "remote".
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-431-ci-rebase-'));
    const remoteDir = path.join(tmpDir, 'remote.git');
    const workDir   = path.join(tmpDir, 'work');

    try {
      // Build a bare remote with a `main` branch containing one commit. Each
      // setup step uses gitOrThrow (not the bare seam) so a failure here aborts
      // loudly at the point of failure instead of surfacing as a baffling
      // assertion mismatch against the script's exit code further down —
      // matching the throw-on-failure behavior the pre-migration `spawnSync`
      // calls this replaced never had either.
      fs.mkdirSync(remoteDir, { recursive: true });
      gitOrThrow(['init', '--bare', remoteDir], { timeoutMs: GIT_TIMEOUT_MS });

      // Create a working clone to push an initial commit.
      gitOrThrow(['clone', remoteDir, workDir], { timeoutMs: GIT_TIMEOUT_MS });
      fs.writeFileSync(path.join(workDir, 'seed.txt'), 'init\n');
      gitOrThrow(['-C', workDir, 'config', 'user.email', 'ci@test'], { timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['-C', workDir, 'config', 'user.name', 'CI Test'],  { timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['-C', workDir, 'checkout', '-b', 'main'],           { timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['-C', workDir, 'add', 'seed.txt'],                  { timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['-C', workDir, 'commit', '-m', 'init'],             { timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['-C', workDir, 'push', 'origin', 'main'],          { timeoutMs: GIT_TIMEOUT_MS });

      // Run the script from `workDir` with origin pointing at our bare remote.
      // GITHUB_BASE_REF=main so it fetches `origin main`.
      // No GITHUB_TOKEN so remote set-url is skipped.
      const r = spawnSync(NODE, [SCRIPT], {
        cwd:      workDir,
        encoding: 'utf8',
        timeout:  20_000,
        env: {
          ...process.env,
          GITHUB_BASE_REF:    'main',
          GITHUB_TOKEN:       '',
          GITHUB_REPOSITORY:  '',
        },
      });

      assert.strictEqual(
        r.status, 0,
        `Script should exit 0 when fetch+merge succeed.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`
      );
      // Must NOT emit the "failed after 3 attempts" error message.
      assert.ok(
        !(r.stderr || '').includes('failed after 3 attempts'),
        `Script must not emit "failed after 3 attempts" when fetch succeeded.\nstderr: ${r.stderr}`
      );
    } finally {
      cleanup(tmpDir);
    }
  });

});
