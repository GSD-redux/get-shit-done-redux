'use strict';

/**
 * TDD tests for scripts/lint-legacy-dir-name.cjs.
 *
 * Uses spawnSync to invoke the guard script against a temporary git repo
 * so we can inject fixtures without touching the real repo.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const GUARD_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'lint-legacy-dir-name.cjs');

// The guard itself does trivial work here (git ls-files against a 1-2 file
// fixture repo, then a per-line regex scan), but it shells out to `git` as a
// real subprocess and this call previously had NO timeout at all (unbounded
// spawnSync). The seam requires an explicit bound, so pick one generous
// enough to absorb a slow/contended CI runner's process-spawn and git-init
// overhead without masking a genuine hang: 30s, matching the timeout this
// suite already uses for the sibling check-npm-integrity.cjs script
// invocation in tests/npm-integrity-gate.test.cjs (also a small-fixture,
// single-subprocess CLI script).
//
// NOT sourced from `tests/helpers/timeouts.cjs`'s `BUILD_TIMEOUT_MS` even
// though the literal happens to coincide (both 30000): that shared constant
// is scoped to hooks bundling via `scripts/build-hooks.js` — a heavier,
// different class of work than this lint/guard script's single small-fixture
// git-and-regex pass. Aliasing onto BUILD_TIMEOUT_MS would tie this value's
// meaning to hook-bundling duration, which is not what bounds this call
// (#3147 pre-PR review finding).
const GUARD_TIMEOUT_MS = 30_000;

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-legacy-test-'));
  gitOrThrow(['init', '--initial-branch=main'], { cwd: dir });
  gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: dir });
  gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function writeFile(dir, relPath, content) {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function gitAdd(dir, relPath) {
  gitOrThrow(['add', relPath], { cwd: dir });
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup in lint test; no helpers import available
  fs.rmSync(dir, { recursive: true, force: true });
}

function runGuard(cwd) {
  // Invoke the guard script with the REPO_ROOT overridden via cwd.
  // The guard uses path.resolve(__dirname, '..') as REPO_ROOT, but we need
  // it to operate on our fixture repo. We achieve this by temporarily
  // injecting a wrapper that adjusts the module resolution.
  //
  // Simpler: run as a child process with the --cwd trick is not available for
  // scripts. Instead we pass the fixture dir path as an env var that the guard
  // can use to override REPO_ROOT when present.
  const r = runNode([GUARD_SCRIPT], {
    cwd,
    env: { ...process.env, GSD_LINT_LEGACY_REPO_ROOT: cwd },
    timeoutMs: GUARD_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// The guard script needs to respect GSD_LINT_LEGACY_REPO_ROOT for testing.
// We check how the script is designed and decide if we need a wrapper approach.
// Read the script to see if it already uses the env var, or patch inline.
// ---------------------------------------------------------------------------

// Since the guard script uses path.resolve(__dirname, '..') as REPO_ROOT,
// we cannot override it without modifying the script. Instead, run the guard
// against the real repo (which should be clean) for Case 1, and test
// individual detection logic by creating fixture files in the actual repo
// in a tracked-but-not-committed state... but git ls-files only shows
// tracked (committed/staged) files.
//
// The cleanest approach: create a wrapper that sets REPO_ROOT via env var
// and a thin shim. Let's use a different strategy: write the fixture to a
// temp dir, initialize a git repo there, and run the guard with an
// explicit --repo-root flag override.
//
// Since the script does not support --repo-root, we create a tiny shim that
// requires the real script after patching __dirname. This is a common test
// pattern for such scripts.
//
// Simplest testable approach: run the script in the REAL repo dir (which is
// clean) for Case 1, and for Cases 2-4 write temporary files to the real
// tracked repo's working tree, git-add them, run, then delete + git-reset.
// BUT that is too invasive.
//
// The correct approach: the guard needs to support an override. Since we own
// the guard, add GSD_LINT_LEGACY_REPO_ROOT env var support to it. We test
// against that.

// *** Re-reading the guard script: it uses path.resolve(__dirname, '..')
// for REPO_ROOT. We will modify the guard to support the env var override
// for testability, which is standard for lint script testing in this repo.

// Let's check: does the guard script support the env var?
// Since we wrote it without env var support, and this test expects it,
// we need to add the env var support to the guard first.
// (This test file will be the spec that drives us to add it.)

describe('lint-legacy-dir-name — clean repo', () => {
  test('exits 0 on a clean temporary repo with no forbidden token', () => {
    const dir = createTempRepo();
    try {
      writeFile(dir, 'README.md', '# My Project\n\nThis is gsd-core.\n');
      writeFile(dir, 'src/index.js', 'module.exports = {};\n');
      gitAdd(dir, 'README.md');
      gitAdd(dir, 'src/index.js');

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('0 violations'), `stdout: ${result.stdout}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-legacy-dir-name — bare forbidden token detected', () => {
  test('exits 1 when a tracked file contains the bare forbidden token', () => {
    const dir = createTempRepo();
    try {
      // Construct the forbidden string without putting it in a literal that the
      // guard would catch in this test file itself:
      const bare = 'get-shit' + '-done'; // the bare directory token
      writeFile(dir, 'src/config.js', `const dir = '${bare}';\n`);
      gitAdd(dir, 'src/config.js');

      const result = runGuard(dir);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
      assert.ok(result.stderr.includes('1 violation'), `stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes('src/config.js'), `stderr should name the file: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-legacy-dir-name — slug variant allowed', () => {
  test('exits 0 when token is a hyphenated slug variant (not bare)', () => {
    const dir = createTempRepo();
    try {
      // Slug variants like get-shit-done-redux, get-shit-done-cli should be allowed.
      // Construct without creating a bare literal:
      const slugVariant = 'get-shit' + '-done-redux';
      writeFile(dir, 'src/legacy.js', `const old = '${slugVariant}';\n`);
      gitAdd(dir, 'src/legacy.js');

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0 for slug variant, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

describe('lint-legacy-dir-name — gsd-allow-legacy-name marker', () => {
  test('exits 0 when forbidden token is on a line with the allow marker', () => {
    const dir = createTempRepo();
    try {
      const bare = 'get-shit' + '-done';
      // Line contains the token BUT also the allow marker.
      writeFile(dir, 'src/migration.js', `const legacyRoot = '${bare}'; // gsd-allow-legacy-name\n`);
      gitAdd(dir, 'src/migration.js');

      const result = runGuard(dir);
      assert.equal(result.status, 0, `expected exit 0 with allow marker, got ${result.status}; stderr: ${result.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});
