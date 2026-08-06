// allow-test-rule: pending-migration-to-typed-ir [#3090]
// Phase 5 kimi-variant disambiguation is verified via install.js subprocess
// output capture (regex on printed notices), since disambiguateKimiVariant
// is inline in bin/install.js (not exported) and emits no structured/JSON
// output. Exporting the function and/or adding a --json notice mode is a
// production change out of scope here. Tracked under #3090.
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');

function makeDisposableHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-disambig-'));
  return {
    dir,
    cleanup() { cleanup(dir); },
  };
}

function runInstall(args, home) {
  // spawnSync captures stdout AND stderr separately regardless of exit code
  // (execFileSync drops stderr on success, which hid the console.error warnings).
  const r = spawnSync('node', [INSTALL_JS, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, GSD_TEST_MODE: '1' },
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exit: r.status };
}

describe('Kimi variant disambiguation (#2505 Phase 5 / #2513)', () => {
  let home;
  before(() => { home = makeDisposableHome(); });
  after(() => home.cleanup());

  test('--kimi prints the Kimi CLI (Python) description', () => {
    const r = runInstall(['--kimi', '--help'], home.dir);
    const combined = r.stdout + r.stderr;
    assert.match(combined, /Kimi CLI \(Python kimi-cli\).*named subagents.*~\/\.kimi\//);
  });

  test('--kimi-code prints the Kimi Code (Node CLI) description', () => {
    const r = runInstall(['--kimi-code', '--help'], home.dir);
    const combined = r.stdout + r.stderr;
    assert.match(combined, /Kimi Code \(Node CLI\).*coder\/explore\/plan.*~\/\.kimi-code\//);
  });

  test('--kimi warns when only ~/.kimi-code/config.toml exists', () => {
    const h = makeDisposableHome();
    try {
      fs.mkdirSync(path.join(h.dir, '.kimi-code'), { recursive: true });
      fs.writeFileSync(path.join(h.dir, '.kimi-code', 'config.toml'), '# kimi-code');
      const r = runInstall(['--kimi', '--help'], h.dir);
      const combined = r.stdout + r.stderr;
      assert.match(combined, /variant mismatch/i);
      assert.match(combined, /Detected ~\/\.kimi-code\/config\.toml/);
      assert.match(combined, /Re-run with --kimi-code/);
    } finally {
      h.cleanup();
    }
  });

  test('--kimi-code warns when only ~/.kimi/config.toml exists', () => {
    const h = makeDisposableHome();
    try {
      fs.mkdirSync(path.join(h.dir, '.kimi'), { recursive: true });
      fs.writeFileSync(path.join(h.dir, '.kimi', 'config.toml'), '# kimi-cli');
      const r = runInstall(['--kimi-code', '--help'], h.dir);
      const combined = r.stdout + r.stderr;
      assert.match(combined, /variant mismatch/i);
      assert.match(combined, /Detected ~\/\.kimi\/config\.toml/);
      assert.match(combined, /Re-run with --kimi/);
    } finally {
      h.cleanup();
    }
  });

  test('no warning when neither config exists (fresh install)', () => {
    const h = makeDisposableHome();
    try {
      const r = runInstall(['--kimi', '--help'], h.dir);
      const combined = r.stdout + r.stderr;
      assert.doesNotMatch(combined, /variant mismatch/i);
    } finally {
      h.cleanup();
    }
  });
});
