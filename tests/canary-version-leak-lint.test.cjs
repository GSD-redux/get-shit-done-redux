'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Canary-version-leak lint (DEFECT.CANARY-VERSION-LEAK, CONTEXT.md).
 *
 * scripts/lint-canary-version-leak.cjs fails a run whose package.json
 * .version carries a -canary.<N> suffix — that suffix belongs to a dev
 * branch only and must never land on main (2026-05-16 audit: origin/main at
 * "1.50.0-canary.0", commit 2d32ad82, #3206). Wired into
 * .github/workflows/version-gate.yml, gated to PRs targeting main.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const ROOT = path.join(__dirname, '..');
const LINT_SCRIPT = path.join(ROOT, 'scripts', 'lint-canary-version-leak.cjs');
const { isCanaryVersion, readPackageVersion } = require(LINT_SCRIPT);
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

describe('canary-version-leak lint: isCanaryVersion (pure)', () => {
  test('a plain release version is not canary', () => {
    assert.equal(isCanaryVersion('1.8.0'), false);
  });

  test('a -canary.<N> version IS flagged', () => {
    assert.equal(isCanaryVersion('1.8.0-canary.3'), true);
  });

  test('boundary: -canary.0 (N=0) is flagged', () => {
    assert.equal(isCanaryVersion('1.50.0-canary.0'), true);
  });

  test('a non-canary prerelease suffix (e.g. -rc.1) is not flagged', () => {
    assert.equal(isCanaryVersion('1.8.0-rc.1'), false);
  });

  test('non-string input is not flagged (fails closed to false, main() handles missing version separately)', () => {
    assert.equal(isCanaryVersion(undefined), false);
    assert.equal(isCanaryVersion(null), false);
  });

  test('property: appending -canary.<N> to any base string always flags it', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/-canary\.\d+/.test(s)),
        fc.nat(),
        (base, n) => {
          assert.equal(isCanaryVersion(`${base}-canary.${n}`), true);
        },
      ),
    );
  });

  test('property: a version with no "-canary." substring is never flagged', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes('-canary.')),
        (version) => {
          assert.equal(isCanaryVersion(version), false);
        },
      ),
    );
  });
});

describe('canary-version-leak lint: the live repo package.json is clean', () => {
  test('readPackageVersion + isCanaryVersion pass against the real package.json', () => {
    const version = readPackageVersion(ROOT);
    assert.equal(typeof version, 'string');
    assert.equal(isCanaryVersion(version), false, `package.json version '${version}' must not carry -canary.<N>`);
  });
});

describe('canary-version-leak lint: main() end-to-end wiring', () => {
  function writeFixtureRoot(version) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-canary-lint-e2e-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'fixture', version }), 'utf8');
    return tmpDir;
  }

  test('exit 0 on a clean version (real package.json, 1.8.0)', () => {
    const result = runNode([LINT_SCRIPT], { cwd: ROOT });
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });

  test('exit 1 on a fixture package.json carrying a -canary.<N> suffix (never touches the real package.json)', (t) => {
    const tmpDir = writeFixtureRoot('1.8.0-canary.3');
    t.after(() => cleanup(tmpDir));

    // The script resolves its target as `<script-dir>/../package.json`, so
    // run a throwaway copy of the script from inside the fixture root
    // rather than mutating the real repo's package.json.
    const scriptCopyDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptCopyDir, { recursive: true });
    const scriptCopy = path.join(scriptCopyDir, 'lint-canary-version-leak.cjs');
    fs.copyFileSync(LINT_SCRIPT, scriptCopy);

    const result = runNode([scriptCopy]);
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
    assert.match(result.stderr, /canary-version-leak/);
  });
});
