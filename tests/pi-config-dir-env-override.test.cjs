'use strict';

/**
 * pi PI_CODING_AGENT_DIR override (#3023).
 *
 * pi's real source (`earendil-works/pi`, `packages/coding-agent/src/config.ts`)
 * reads `PI_CODING_AGENT_DIR` to override its GLOBAL agent dir outright:
 *
 *   export function getAgentDir(): string {
 *       const envDir = process.env[ENV_AGENT_DIR];   // PI_CODING_AGENT_DIR
 *       if (envDir) return expandTildePath(envDir);
 *       return join(homedir(), CONFIG_DIR_NAME, "agent");
 *   }
 *
 * `capabilities/pi/capability.json`'s `runtime.configHome` previously declared
 * `env: []` (empty), so a user who had set `PI_CODING_AGENT_DIR` got GSD
 * installed to the DEFAULT `~/.pi/agent` — a path pi never reads. The fix adds
 * `PI_CODING_AGENT_DIR` to that array; `resolveConfigHomeFromDescriptor`'s
 * existing `dot-home-nested` env-override branch (already exercised by
 * antigravity/windsurf) requires no new code.
 *
 * Unit-level (`resolveConfigHomeFromDescriptor`) coverage lives in
 * tests/runtime-homes-descriptor-drive.test.cjs, describe block
 * "#3023: pi PI_CODING_AGENT_DIR". This file drives the real, spawned
 * installer end-to-end so the env var is proven to redirect the actual
 * install output, not just the pure resolver function.
 *
 * `capitalConfigDir`/`piConfig.configDir` (pi's OTHER override — a
 * project-`package.json` field that renames the `.pi` segment itself, for
 * both local and global scope) is NOT implemented here: GSD's descriptor
 * vocabulary has no existing mechanism for a runtime whose config-dir name is
 * sourced from a project's own `package.json` (reported to the orchestrator
 * separately; out of scope for this change).
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { INSTALL_SCRIPT, installerEnv, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');

// hooks/dist is gitignored and built (DEFECT.HOOKS-DIST-SCOPED-CI): a scoped CI
// lane does not run build:hooks first, so a real --pi --global install there
// would emit no gsd-hooks/ dir. Build idempotently before spawning, exactly as
// the golden/emitted-attribution harnesses do.
function ensureHooksBuilt() {
  spawnSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
}

/** Spawn the real installer for --pi --global against a fresh sandbox HOME,
 *  WITHOUT --config-dir, so the runtime's own configHome resolution (default
 *  or env-var override) is exactly what places the install. */
function runPiGlobalInstall(home, extraEnv = {}) {
  const result = spawnSync(process.execPath, [INSTALL_SCRIPT, '--pi', '--global'], {
    cwd: home,
    encoding: 'utf8',
    timeout: 120_000,
    env: installerEnv({ HOME: home, USERPROFILE: home, ...extraEnv }),
  });
  assert.strictEqual(result.status, 0,
    `installer exited with status ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

function sandboxHome(t, prefix = 'gsd-3023-pi-envdir-') {
  const dir = createTempDir(prefix);
  t.after(() => cleanup(dir));
  return dir;
}

describe('#3023: --pi --global honors PI_CODING_AGENT_DIR', () => {
  before(() => ensureHooksBuilt());

  test('PI_CODING_AGENT_DIR unset -> installs at the default ~/.pi/agent', (t) => {
    const home = sandboxHome(t);
    runPiGlobalInstall(home);

    const defaultDir = path.join(home, '.pi', 'agent');
    assert.ok(fs.existsSync(path.join(defaultDir, 'gsd-file-manifest.json')),
      'default install must land under ~/.pi/agent when the env var is unset');
  });

  test('PI_CODING_AGENT_DIR set -> installs at the overridden path, not ~/.pi/agent', (t) => {
    const home = sandboxHome(t);
    const altAgentDir = sandboxHome(t, 'gsd-3023-pi-envdir-alt-');
    runPiGlobalInstall(home, { PI_CODING_AGENT_DIR: altAgentDir });

    assert.ok(fs.existsSync(path.join(altAgentDir, 'gsd-file-manifest.json')),
      'install must land at the PI_CODING_AGENT_DIR override');
    assert.ok(!fs.existsSync(path.join(home, '.pi')),
      'the default ~/.pi tree must not be created when the env var redirects the install');
  });

  test('PI_CODING_AGENT_DIR with a tilde expands against the sandbox HOME', (t) => {
    const home = sandboxHome(t);
    runPiGlobalInstall(home, { PI_CODING_AGENT_DIR: '~/pi-alt-agent' });

    const expanded = path.join(home, 'pi-alt-agent');
    assert.ok(fs.existsSync(path.join(expanded, 'gsd-file-manifest.json')),
      'a tilde-prefixed PI_CODING_AGENT_DIR must expand against HOME, matching pi\'s own expandTildePath');
    assert.ok(!fs.existsSync(path.join(home, '.pi')),
      'the default ~/.pi tree must not be created when the env var redirects the install');
  });

  test('an empty-string PI_CODING_AGENT_DIR falls back to the default, never a bogus path', (t) => {
    const home = sandboxHome(t);
    runPiGlobalInstall(home, { PI_CODING_AGENT_DIR: '' });

    const defaultDir = path.join(home, '.pi', 'agent');
    assert.ok(fs.existsSync(path.join(defaultDir, 'gsd-file-manifest.json')),
      'an empty-string override must be treated as unset and fall back to ~/.pi/agent');
  });
});
