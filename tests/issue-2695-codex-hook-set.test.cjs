// Regression tests for #2695 — Codex native updates omit the update-hook worker
// and the managed-hooks registry.
//
// The Codex install branch in bin/install.js used to allowlist only two of the
// four hook files the shipped build emits (gsd-check-update.js +
// gsd-context-monitor.js), and gated the entire branch on !isMinimalMode so the
// `core` profile installed none of them. The parent SessionStart hook spawn()s
// the worker, which require()s the registry — so Codex was wired to a dependency
// chain the same installer never delivered.
//
// These tests drive the real installer (bin/install.js) behaviorally into an
// isolated temp config dir and assert the complete four-file set is delivered
// for both profiles, the registry is byte-for-byte, the version stamps resolve
// to the installed package version, and unrelated user files are preserved.

'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const {
  INSTALL_SCRIPT,
  BUILD_SCRIPT,
  HOOKS_DIST,
  installerEnv,
} = require('./helpers/install-shared.cjs');

const PKG_VERSION = require('../package.json').version;

// The four-file hook set the Codex surface must deliver together (#2695).
const CODEX_HOOK_FILES = [
  'gsd-check-update.js',
  'gsd-check-update-worker.js',
  'managed-hooks-registry.cjs',
  'gsd-context-monitor.js',
];

// Build hooks/dist before any install runs (the installer copies from there).
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

function hooksDirOf(configDir) {
  return path.join(configDir, 'hooks');
}

/** Run the Codex installer into an isolated temp config dir. */
function runCodexInstall({ profile, preseed }) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2695-${profile}-`));
  if (preseed) {
    const hooksDest = hooksDirOf(configDir);
    fs.mkdirSync(hooksDest, { recursive: true });
    for (const [name, body] of Object.entries(preseed)) {
      fs.writeFileSync(path.join(hooksDest, name), body);
    }
  }
  // Sandbox HOME/USERPROFILE to configDir: Codex's skills-kind `home: ".agents"`
  // override resolves via os.homedir(); sandboxing keeps the spawn self-contained
  // (mirrors tests/install-minimal-hooks.test.cjs Codex downgrade test).
  const result = spawnSync(
    process.execPath,
    [INSTALL_SCRIPT, '--codex', '--global', '--config-dir', configDir, `--profile=${profile}`],
    { encoding: 'utf8', env: installerEnv({ HOME: configDir, USERPROFILE: configDir }) },
  );
  return { configDir, result };
}

// Older-version stamp used to pre-seed an "upgrade" scenario.
const OLDER_VERSION = '1.7.0';

describe('#2695: fresh Codex installs deliver the complete four-file hook set', () => {
  for (const profile of ['core', 'full']) {
    test(`fresh --profile=${profile} installs all four hook files`, (t) => {
      const { configDir, result } = runCodexInstall({ profile });
      t.after(() => cleanup(configDir));

      const hooksDir = hooksDirOf(configDir);
      for (const file of CODEX_HOOK_FILES) {
        assert.ok(
          fs.existsSync(path.join(hooksDir, file)),
          `expected ${file} under <config>/hooks for --profile=${profile}\n` +
            `installer stdout: ${result.stdout}\ninstaller stderr: ${result.stderr}`,
        );
      }
    });
  }
});

describe('#2695: Codex upgrades refresh all four hook files to the current version', () => {
  // Pre-seed all four files stamped at OLDER_VERSION so an upgrade must overwrite them.
  function olderSeed() {
    const seed = {};
    for (const name of CODEX_HOOK_FILES) {
      // Registry carries no version token; seed it with a stale sentinel body.
      if (name.endsWith('.cjs')) {
        seed[name] = `// stale registry ${OLDER_VERSION}\nmodule.exports = {};\n`;
      } else {
        seed[name] = `// gsd-hook-version: ${OLDER_VERSION}\n// stale\n`;
      }
    }
    return seed;
  }

  for (const profile of ['core', 'full']) {
    test(`--profile=${profile} upgrade refreshes all four hook files`, (t) => {
      const { configDir, result } = runCodexInstall({ profile, preseed: olderSeed() });
      t.after(() => cleanup(configDir));

      const hooksDir = hooksDirOf(configDir);
      // All four must now carry the current version stamp where one exists, and
      // the registry must no longer be the stale sentinel.
      for (const name of CODEX_HOOK_FILES) {
        const dest = path.join(hooksDir, name);
        assert.ok(
          fs.existsSync(dest),
          `expected refreshed ${name} for --profile=${profile}\n` +
            `installer stdout: ${result.stdout}\ninstaller stderr: ${result.stderr}`,
        );
      }
      // The registry must be REFRESHED on upgrade, not merely present: assert it no
      // longer carries the stale sentinel and now matches the shipped dist byte-for-byte
      // (the raw-copy fallback must overwrite an existing dest, not skip it).
      const registryDest = path.join(hooksDir, 'managed-hooks-registry.cjs');
      const registryBytes = fs.readFileSync(registryDest, 'utf8');
      assert.ok(
        !registryBytes.includes(`stale registry ${OLDER_VERSION}`),
        `registry must be refreshed on upgrade for --profile=${profile} (still carries the stale sentinel)`,
      );
      assert.deepStrictEqual(
        fs.readFileSync(registryDest),
        fs.readFileSync(path.join(HOOKS_DIST, 'managed-hooks-registry.cjs')),
        `refreshed registry must match hooks/dist byte-for-byte for --profile=${profile}`,
      );
      // Version stamps resolved (acceptance #2/#3).
      const workerStamp = readHookVersionLine(path.join(hooksDir, 'gsd-check-update-worker.js'));
      assert.strictEqual(
        workerStamp, PKG_VERSION,
        `worker gsd-hook-version stamp must be the installed package version (${PKG_VERSION}), ` +
          `got "${workerStamp}" for --profile=${profile}`,
      );
      const parentStamp = readHookVersionLine(path.join(hooksDir, 'gsd-check-update.js'));
      assert.strictEqual(
        parentStamp, PKG_VERSION,
        `parent gsd-check-update stamp must be the installed package version (${PKG_VERSION}), ` +
          `got "${parentStamp}" for --profile=${profile}`,
      );
    });
  }
});

describe('#2695: managed-hooks-registry.cjs is copied byte-for-byte', () => {
  for (const profile of ['core', 'full']) {
    test(`--profile=${profile} registry matches hooks/dist byte-for-byte`, (t) => {
      const { configDir, result } = runCodexInstall({ profile });
      t.after(() => cleanup(configDir));

      const dest = path.join(hooksDirOf(configDir), 'managed-hooks-registry.cjs');
      assert.ok(fs.existsSync(dest), `registry missing for --profile=${profile}\nstdout: ${result.stdout}`);
      const distBytes = fs.readFileSync(path.join(HOOKS_DIST, 'managed-hooks-registry.cjs'));
      const destBytes = fs.readFileSync(dest);
      assert.deepStrictEqual(
        destBytes, distBytes,
        `managed-hooks-registry.cjs must be copied byte-for-byte (no version/path transform) for --profile=${profile}`,
      );
    });
  }
});

describe('#2695: worker hook-version stamp is a literal install-time value', () => {
  test('the stamp is the literal package version, never a placeholder or a runtime lookup', (t) => {
    const { configDir } = runCodexInstall({ profile: 'full' });
    t.after(() => cleanup(configDir));

    const workerPath = path.join(hooksDirOf(configDir), 'gsd-check-update-worker.js');
    const content = fs.readFileSync(workerPath, 'utf8');
    // The placeholder must have been replaced — a leftover {{GSD_VERSION}} is the bug shape.
    assert.ok(
      !content.includes('{{GSD_VERSION}}'),
      'worker still carries an unresolved {{GSD_VERSION}} placeholder — stamping did not run',
    );
    // And the resolved value must be the literal version, present on the version-comment line.
    const stamp = readHookVersionLine(workerPath);
    assert.strictEqual(stamp, PKG_VERSION, `worker stamp must equal package.json version, got "${stamp}"`);
  });
});

describe('#2695: unrelated user-owned hook files are preserved', () => {
  for (const profile of ['core', 'full']) {
    test(`--profile=${profile} leaves a pre-existing user hook untouched`, (t) => {
      const userOwned = 'my-custom-hook.js';
      const userBody = '// user-owned hook — do not touch\nconsole.log("mine");\n';
      const { configDir, result } = runCodexInstall({ profile, preseed: { [userOwned]: userBody } });
      t.after(() => cleanup(configDir));

      const dest = path.join(hooksDirOf(configDir), userOwned);
      assert.ok(fs.existsSync(dest), `user-owned ${userOwned} must be preserved for --profile=${profile}\nstdout: ${result.stdout}`);
      assert.strictEqual(
        fs.readFileSync(dest, 'utf8'), userBody,
        `user-owned ${userOwned} bytes must be unchanged for --profile=${profile}`,
      );
    });
  }
});

describe('#2695: re-running the installer is idempotent for the four-file set', () => {
  test('a second full install leaves all four files present and correctly stamped', (t) => {
    const first = runCodexInstall({ profile: 'full' });
    t.after(() => cleanup(first.configDir));
    // Second run into the SAME config dir.
    const result2 = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--codex', '--global', '--config-dir', first.configDir, '--profile=full'],
      { encoding: 'utf8', env: installerEnv({ HOME: first.configDir, USERPROFILE: first.configDir }) },
    );
    assert.ok(result2.stdout || result2.stderr);

    const hooksDir = hooksDirOf(first.configDir);
    for (const name of CODEX_HOOK_FILES) {
      assert.ok(fs.existsSync(path.join(hooksDir, name)), `${name} must survive a second install`);
    }
    assert.strictEqual(
      readHookVersionLine(path.join(hooksDir, 'gsd-check-update-worker.js')),
      PKG_VERSION,
      'worker stamp must remain correct after a second install',
    );
  });
});

describe('#2695: the core profile enables the hook feature and wires SessionStart (intended)', () => {
  // For the update-check/context-monitor hooks to actually fire, Codex needs both
  // the feature flag in config.toml AND the hooks.json routing — copying inert
  // files alone would leave `core` with scripts Codex never invokes. Entering the
  // codex-toml branch for `core` (the #2695 gate change) synthesizes `[features]
  // hooks = true` via ensureCodexHooksFeature, writes config.toml, and registers
  // the hooks. This is the intended behavior of the fix, not a side effect — these
  // assertions pin it so a future re-gating cannot silently regress it.
  test('--profile=core writes config.toml enabling the hooks feature', (t) => {
    const { configDir } = runCodexInstall({ profile: 'core' });
    t.after(() => cleanup(configDir));

    const configPath = path.join(configDir, 'config.toml');
    assert.ok(fs.existsSync(configPath), 'core must write config.toml so the hooks feature is enabled');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.ok(/^\s*hooks\s*=\s*true\s*$/m.test(config), 'config.toml must enable hooks = true for core');
  });

  test('--profile=core wires the SessionStart update-check hook in hooks.json', (t) => {
    const { configDir } = runCodexInstall({ profile: 'core' });
    t.after(() => cleanup(configDir));

    const hooksJsonPath = path.join(configDir, 'hooks.json');
    assert.ok(fs.existsSync(hooksJsonPath), 'core must write hooks.json');
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const sessionStartCmds = collectHookCommands(hooksJson, 'SessionStart');
    // The command points at the gsd-check-update hook script. Its extension is
    // platform-specific — Windows routes through a .cmd shim, POSIX through .js —
    // so assert on the basename prefix, not a hardcoded extension (Windows parity).
    const routedToUpdateHook = sessionStartCmds.some((c) => {
      const token = c.replace(/"/g, '').replace(/\\/g, '/');
      const segs = token.split('/');
      const last = segs[segs.length - 1];
      return last.startsWith('gsd-check-update.');
    });
    assert.ok(
      routedToUpdateHook,
      `core must route SessionStart to the gsd-check-update hook in hooks.json; got: ${JSON.stringify(sessionStartCmds)}`,
    );
  });
});

describe('#2695: the core profile still installs no agent files (negative space)', () => {
  test('--profile=core delivers hooks but no gsd-* agent files', (t) => {
    const { configDir } = runCodexInstall({ profile: 'core' });
    t.after(() => cleanup(configDir));

    // Hooks delivered (the fix)…
    for (const name of CODEX_HOOK_FILES) {
      assert.ok(fs.existsSync(path.join(hooksDirOf(configDir), name)), `${name} delivered for core`);
    }
    // …but the full agent surface is still absent (core stays minimal). Codex agents
    // are .toml ([agents.gsd-*] in config.toml + agents/gsd-*.toml), so check both
    // extensions — a .md-only filter would miss a Codex agent-surface regression.
    const agentsDir = path.join(configDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      const gsdAgents = fs.readdirSync(agentsDir).filter(
        (f) => f.startsWith('gsd-') && (f.endsWith('.md') || f.endsWith('.toml')),
      );
      assert.deepStrictEqual(gsdAgents, [], 'core must not install the full agent surface');
    }
    // And config.toml must carry no agent role sections.
    const configPath = path.join(configDir, 'config.toml');
    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, 'utf8');
      assert.ok(
        !/^\[agents\.gsd-/m.test(config),
        'core config.toml must not declare [agents.gsd-*] roles (full agent surface stays a full-profile concern)',
      );
    }
  });
});

/**
 * Read the `// gsd-hook-version: <value>` comment value from a hook file.
 * Returns the trimmed literal. Used so tests assert on the structured stamp,
 * not on raw `.includes()` prose (CONTRIBUTING raw-text-matching rule).
 */
function readHookVersionLine(hookPath) {
  const content = fs.readFileSync(hookPath, 'utf8');
  const m = content.match(/^\/\/ gsd-hook-version:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

/**
 * Collect every hook command string registered under a given Codex hooks.json
 * event key. Used so the SessionStart-wiring test asserts on the structured
 * hook entries (commands), not on raw text matching against the whole file.
 */
function collectHookCommands(hooksJson, eventName) {
  const entries = (hooksJson && hooksJson.hooks && Array.isArray(hooksJson.hooks[eventName]))
    ? hooksJson.hooks[eventName]
    : [];
  return entries.flatMap((entry) =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map((h) => (h && typeof h.command === 'string' ? h.command : null))
      .filter(Boolean),
  );
}
