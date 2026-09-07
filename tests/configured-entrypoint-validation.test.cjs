'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const helpers = require('./helpers.cjs');

const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { install, installAllRuntimes, finishInstall } = require('../bin/install.js');

/**
 * Run `fn` with HOME/USERPROFILE pointed at a fresh temp dir and every
 * config-location env var scrubbed, so a real install() never touches the
 * developer's own config. Restores all of it, and cleans the dir, afterwards.
 */
function withSandboxedHome(t, prefix, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => helpers.cleanup(root));
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const restoreConfigLocationEnv = helpers.scrubConfigLocationEnv();
  try {
    return fn(root);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    restoreConfigLocationEnv();
  }
}

test('configured entrypoint validation exposes an aggregate typed boundary', () => {
  assert.equal(
    typeof hooksSurface.validateConfiguredEntrypoints,
    'function',
    'the Runtime Hooks Surface must export configured-entrypoint validation',
  );
});

test('finishInstall rejects an invalid configured entrypoint before Done output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-finish-'));
  t.after(() => helpers.cleanup(root));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  // #2665/#4249: finishInstall asserts configured entrypoints before any of its
  // own writes now, but still sandbox HOME (+ USERPROFILE for os.homedir() on
  // Windows) and config-location env defensively, so a future reordering that
  // reintroduces a pre-assertion write can never redirect it to a live config dir.
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const restoreConfigLocationEnv = helpers.scrubConfigLocationEnv();
  try {
    assert.throws(() => finishInstall(null, null, null, false, 'cline', false, root, {
      configuredEntrypoints: [{ runtime: 'cline', configPath: path.join(root, 'config'), scriptPath: path.join(root, 'missing.js') }],
    }), /Configured entrypoint validation failed/);
  } finally {
    console.log = originalLog;
    restoreConfigLocationEnv();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }
  assert.equal(logs.some(line => line.includes('Done!')), false);
});

test('a hook already registered under a stale command is still tracked for validation on re-install (#4154 Blocker)', (t) => {
  withSandboxedHome(t, 'configured-entrypoint-stale-', () => {
    const first = install(true, 'claude');
    assert.ok(first.settingsPath, 'a fresh global install must produce a settings path');
    finishInstall(first.settingsPath, first.settings, first.statuslineCommand, false, 'claude', true, first.configDir, {
      configuredEntrypoints: first.configuredEntrypoints,
    });

    // Simulate an entry registered by an older installer under a DIFFERENT
    // node install (e.g. an nvm switch, #4087/#4098/#4137): same real
    // scriptPath under <configDir>/hooks/ (that never changes across
    // installer versions) and still shaped as the modern runtime-resolving
    // chain (rewriteLegacyManagedNodeHookCommands deliberately never touches
    // an already-current-format entry — #3662), but baked with a node path
    // this install would never produce. `hasGsdUpdateHook` still finds it and
    // applySettingsJsonHooks takes its register-only-if-absent branch on the
    // next install (never rewriting it).
    const onDisk = JSON.parse(fs.readFileSync(first.settingsPath, 'utf8'));
    const staleEntry = (onDisk.hooks.SessionStart || []).find(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('gsd-check-update.js'))
    );
    assert.ok(staleEntry, 'a fresh install must register the check-update hook');
    const staleCommand = hooksSurface.buildHookCommand(first.configDir, 'gsd-check-update.js', {
      execPath: '/old/nvm/pinned/node',
      platform: process.platform,
      runtime: 'claude',
    });
    for (const h of staleEntry.hooks) {
      if (h.command && h.command.includes('gsd-check-update.js')) {
        h.command = staleCommand;
      }
    }
    fs.writeFileSync(first.settingsPath, JSON.stringify(onDisk, null, 2));

    const second = install(true, 'claude');
    const trackedNames = (second.configuredEntrypoints || []).map(entry => path.basename(entry.scriptPath));
    assert.ok(
      trackedNames.includes('gsd-check-update.js'),
      `a hook already registered under a stale command must still be tracked for validation, got: ${trackedNames.join(', ')}`,
    );
  });
});

test('configured entrypoint validation aggregates file and interpreter failures without execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-'));
  t.after(() => helpers.cleanup(root));
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);

  const unreadablePath = path.join(root, 'unreadable.js');
  const notExecutablePath = path.join(root, 'not-executable.js');

  const result = hooksSurface.validateConfiguredEntrypoints([
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: path.join(root, 'missing.js') },
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: directory },
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: __filename, interpreterCandidates: ['missing-node'] },
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: unreadablePath },
    // #4249: selfExecutable means this entry is invoked directly via its own
    // shebang (e.g. a Windows-Claude .sh hook) — must itself be +x.
    // platform pinned to non-win32: the X_OK check itself is a POSIX-only
    // concept (skipped entirely on win32, matching production) — this case
    // must exercise it deterministically regardless of which OS runs the test.
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath: notExecutablePath, selfExecutable: true, platform: 'linux' },
  ], {
    resolveExecutableBinary: () => null,
    statSync: (p) => {
      if (p === unreadablePath) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return fs.statSync(p === notExecutablePath ? __filename : p);
    },
    accessSync: (p, mode) => {
      if (p === notExecutablePath && mode === fs.constants.X_OK) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      // notExecutablePath is never written to disk (its statSync mock above
      // redirects to a real file instead) — its R_OK call must redirect too,
      // or this falls through to a real accessSync on a nonexistent path.
      return fs.accessSync(p === notExecutablePath ? __filename : p, mode);
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid.map(({ role, reason }) => [role, reason]), [
    ['script', 'missing'],
    ['script', 'wrong-file-type'],
    ['interpreter', 'unresolved-interpreter'],
    ['script', 'unreadable'],
    ['script', 'not-executable'],
  ]);
});

test('an interpreter-invoked script that exists but has no read permission is reported unreadable, not ok (#4249 agy review)', (t) => {
  // statSync only needs search (+x) permission on the parent directories, so
  // it succeeds on a chmod-000 file even though `node <script>` would fail
  // with EACCES at hook-fire time.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-unreadable-interp-'));
  t.after(() => helpers.cleanup(root));
  const scriptPath = path.join(root, 'hook.js');
  fs.writeFileSync(scriptPath, '// unreadable to the invoking user at hook-fire time\n');

  const result = hooksSurface.validateConfiguredEntrypoints([
    {
      runtime: 'claude',
      configPath: path.join(root, 'settings.json'),
      scriptPath,
      interpreterCandidates: ['/usr/bin/node'],
    },
  ], {
    resolveExecutableBinary: () => '/usr/bin/node',
    accessSync: (p, mode) => {
      if (p === scriptPath && mode === fs.constants.R_OK) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return fs.accessSync(p, mode);
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid.map(({ role, reason }) => [role, reason]), [
    ['script', 'unreadable'],
  ]);
});

test('an EPERM from statSync (Windows equivalent of EACCES on a parent directory) is also reported unreadable, not missing (#4249 agy review)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-eperm-'));
  t.after(() => helpers.cleanup(root));
  const scriptPath = path.join(root, 'hook.js');

  const result = hooksSurface.validateConfiguredEntrypoints([
    { runtime: 'claude', configPath: path.join(root, 'settings.json'), scriptPath },
  ], {
    statSync: () => {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid.map(({ role, reason }) => [role, reason]), [
    ['script', 'unreadable'],
  ]);
});

test('a selfExecutable + interpreterCandidates entry checks both the execute bit and the interpreter (#4249 CodeRabbit review — Cline\'s hybrid `env node` shebang)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-self-exec-'));
  t.after(() => helpers.cleanup(root));
  const okScript = path.join(root, 'ok.js');
  const notExecScript = path.join(root, 'not-exec.js');
  fs.writeFileSync(okScript, '#!/usr/bin/env node\n');
  fs.writeFileSync(notExecScript, '#!/usr/bin/env node\n');

  const makeEntry = (scriptPath) => ({
    runtime: 'cline',
    configPath: path.join(root, '.clinerules', 'hooks', 'PreToolUse'),
    scriptPath,
    interpreterCandidates: ['node'],
    selfExecutable: true,
    // X_OK is a POSIX-only concept (skipped entirely on win32, matching
    // production) — pinned here so the execute-bit case below is exercised
    // deterministically regardless of which OS runs the test.
    platform: 'linux',
  });

  // plain writeFileSync never sets the execute bit (and the repo bans chmod
  // in tests), so every case below stubs accessSync to simulate the exact
  // permission state under test rather than relying on the real filesystem.
  const alwaysOk = () => {};

  // node missing from PATH entirely: caught even though the script itself is fine.
  const missingInterpreter = hooksSurface.validateConfiguredEntrypoints([makeEntry(okScript)], {
    resolveExecutableBinary: () => null,
    accessSync: alwaysOk,
  });
  assert.equal(missingInterpreter.ok, false);
  assert.deepEqual(missingInterpreter.invalid.map(({ role, reason }) => [role, reason]), [
    ['interpreter', 'unresolved-interpreter'],
  ]);

  // node resolves fine, but the script itself lost its execute bit: caught too —
  // interpreterCandidates being present must not skip the X_OK check here.
  const notExecutable = hooksSurface.validateConfiguredEntrypoints([makeEntry(notExecScript)], {
    resolveExecutableBinary: () => '/usr/bin/node',
    accessSync: (p, mode) => {
      if (p === notExecScript && mode === fs.constants.X_OK) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
    },
  });
  assert.equal(notExecutable.ok, false);
  assert.deepEqual(notExecutable.invalid.map(({ role, reason }) => [role, reason]), [
    ['script', 'not-executable'],
  ]);

  // both hold: clean pass.
  const clean = hooksSurface.validateConfiguredEntrypoints([makeEntry(okScript)], {
    resolveExecutableBinary: () => '/usr/bin/node',
    accessSync: alwaysOk,
  });
  assert.equal(clean.ok, true);
});

test('a win32 selfExecutable entry (Codex .cmd shim) skips the execute-bit check (#4249 agy review)', (t) => {
  // POSIX mode bits don't mean executable on win32 — this must not depend on
  // Node's own accessSync(X_OK)-as-F_OK no-op (which only protects a real
  // Windows machine), or a test simulating win32 on a POSIX runner would see
  // a spurious 'not-executable' for a .cmd shim that was never chmod'd +x.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-win32-cmd-'));
  t.after(() => helpers.cleanup(root));
  const cmdPath = path.join(root, 'gsd-check-update.cmd');
  fs.writeFileSync(cmdPath, '@echo off\r\n');

  const result = hooksSurface.validateConfiguredEntrypoints([
    {
      runtime: 'codex',
      configPath: path.join(root, 'hooks.json'),
      scriptPath: cmdPath,
      platform: 'win32',
      selfExecutable: true,
    },
  ], {
    accessSync: (p, mode) => {
      if (mode === fs.constants.X_OK) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
});

test('runtime config writers expose the exact configured entrypoints they emit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-entrypoint-writers-'));
  t.after(() => helpers.cleanup(root));
  const sourceRoot = path.join(__dirname, '..');

  const codexRoot = path.join(root, 'codex');
  // On win32, ensureCodexHooksJsonSessionStart writes a .cmd shim under
  // <codexRoot>/hooks/; the real installer only calls this once that dir
  // (and gsd-check-update.js) already exist, so create it here too.
  fs.mkdirSync(path.join(codexRoot, 'hooks'), { recursive: true });
  const codex = hooksSurface.ensureCodexHooksJsonSessionStart(codexRoot, {
    absoluteRunner: JSON.stringify(process.execPath),
  });
  // win32 emits two entries (the .cmd shim plus the underlying script);
  // every other platform emits the script alone — assert the shape common
  // to both rather than a platform-fixed array.
  assert.ok(codex.configuredEntrypoints.length >= 1);
  assert.ok(codex.configuredEntrypoints.every(entry => entry.runtime === 'codex'
    && entry.configPath === path.join(codexRoot, 'hooks.json')
    && entry.platform === process.platform));
  assert.ok(codex.configuredEntrypoints.some(
    entry => path.basename(entry.scriptPath) === 'gsd-check-update.js'
      && Array.isArray(entry.interpreterCandidates)
      && entry.interpreterCandidates.length === 1,
  ));

  const cursorRoot = path.join(root, 'cursor');
  const cursor = hooksSurface.writeCursorHooksJson(cursorRoot, sourceRoot, {
    managedHookEvents: ['sessionStart'],
  });
  assert.deepEqual(
    cursor.configuredEntrypoints.map(entry => path.basename(entry.scriptPath)),
    ['gsd-cursor-session-start.js'],
  );
  assert.ok(cursor.configuredEntrypoints.every(entry => entry.configPath === cursor.hooksJsonPath));

  const windsurfRoot = path.join(root, 'windsurf');
  const windsurf = hooksSurface.writeWindsurfHooksJson(windsurfRoot, sourceRoot);
  assert.deepEqual(
    windsurf.configuredEntrypoints.map(entry => path.basename(entry.scriptPath)).sort(),
    ['gsd-windsurf-pre-command.js', 'gsd-windsurf-pre-write.js'],
  );

  const kimiRoot = path.join(root, 'kimi');
  fs.cpSync(path.join(sourceRoot, 'hooks'), path.join(kimiRoot, 'hooks'), { recursive: true });
  const kimiConfig = path.join(root, 'kimi-config.toml');
  const kimi = hooksSurface.writeKimiHooksToml(kimiConfig, kimiRoot, {
    hookOpts: { runtime: 'kimi' },
  });
  assert.equal(kimi.configuredEntrypoints.length, kimi.entryCount);
  assert.ok(kimi.configuredEntrypoints.every(entry => entry.configPath === kimiConfig));

  const clineRoot = path.join(root, 'cline');
  const cline = hooksSurface.writeClineArtifacts(clineRoot, false);
  assert.deepEqual(
    cline.configuredEntrypoints.map(entry => path.basename(entry.scriptPath)),
    ['PreToolUse'],
  );
  // #4249 (CodeRabbit): Cline's `#!/usr/bin/env node` hook is a hybrid —
  // self-executable (needs its own execute bit checked) AND PATH-dependent
  // on `node` (needs an interpreter candidate resolved), unlike GSD's other
  // JS hooks which bake an absolute node path specifically to avoid this.
  assert.equal(cline.configuredEntrypoints[0].selfExecutable, true);
  assert.deepEqual(cline.configuredEntrypoints[0].interpreterCandidates, ['node']);

  const portable = [];
  assert.ok(hooksSurface.buildHookCommand(root, 'gsd-context-monitor.js', {
    runtime: 'claude',
    portableHooks: true,
    configPath: path.join(root, 'settings.json'),
    configuredEntrypoints: portable,
  }));
  assert.deepEqual(
    portable.map(entry => path.basename(entry.scriptPath)),
    ['gsd-node-runner.sh', 'gsd-context-monitor.js'],
  );
});

test('a Codex rollback restores every manifest-tracked GSD file byte-for-byte (#4249 CodeRabbit)', (t) => {
  withSandboxedHome(t, 'configured-entrypoint-codex-rollback-', () => {
    const first = install(true, 'codex');
    const manifestPath = path.join(first.configDir, 'gsd-file-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // A managed file OUTSIDE the surfaces #3245's snapshot covers (config.toml,
    // hooks.json, skills/gsd-*, agents/gsd-*, gsd-core/VERSION) — the gap the
    // manifest-driven snapshot closes.
    const managedRel = 'gsd-core/CHANGELOG.md';
    assert.ok(manifest.files[managedRel], `the installer must track ${managedRel} in its manifest`);
    const managedPath = path.join(first.configDir, managedRel);

    // Stand in for "the bytes the previous install left on disk".
    const priorBytes = '# bytes only this test wrote\n';
    fs.writeFileSync(managedPath, priorBytes);
    const priorManifestBytes = fs.readFileSync(manifestPath);

    const second = install(true, 'codex');
    assert.notEqual(
      fs.readFileSync(managedPath, 'utf8'),
      priorBytes,
      'the second install must overwrite the managed file, or this test proves nothing',
    );

    // The exact closure installAllRuntimes invokes (bin/install.js
    // rollbackFinalizedInstallerMigrations) when assertConfiguredEntrypoints throws.
    assert.equal(typeof second.rollbackInstallerMigrations, 'function');
    second.rollbackInstallerMigrations();

    assert.equal(
      fs.readFileSync(managedPath, 'utf8'),
      priorBytes,
      'rollback must restore a manifest-tracked GSD file byte-for-byte, not leave the new payload behind',
    );
    assert.deepEqual(
      fs.readFileSync(manifestPath),
      priorManifestBytes,
      'rollback must also restore the manifest itself',
    );
  });
});

test('a minimal-profile Codex install snapshots its managed files too (#4249 CodeRabbit)', (t) => {
  withSandboxedHome(t, 'configured-entrypoint-codex-minimal-', () => {
    const first = install(true, 'codex');
    const managedPath = path.join(first.configDir, 'gsd-core', 'CHANGELOG.md');
    // Marker-driven core profile — the `gsd update` path into minimal mode
    // (resolveEffectiveProfile), reachable without a --minimal argv.
    fs.writeFileSync(path.join(first.configDir, '.gsd-profile'), 'core\n');

    const priorBytes = '# bytes only this test wrote\n';
    fs.writeFileSync(managedPath, priorBytes);

    const second = install(true, 'codex');
    assert.notEqual(
      fs.readFileSync(managedPath, 'utf8'),
      priorBytes,
      'a minimal Codex install must still overwrite gsd-core/, or this test proves nothing',
    );

    second.rollbackInstallerMigrations();
    assert.equal(
      fs.readFileSync(managedPath, 'utf8'),
      priorBytes,
      'a minimal Codex install must snapshot and restore its managed files, not just a full one',
    );
  });
});

test('a malformed prior manifest degrades the Codex rollback instead of deleting the payload (#4249 CodeRabbit)', (t) => {
  withSandboxedHome(t, 'configured-entrypoint-codex-badmanifest-', () => {
    const first = install(true, 'codex');
    const managedPath = path.join(first.configDir, 'gsd-core', 'CHANGELOG.md');
    // An unparseable manifest leaves the pre-install GSD-owned set UNKNOWN.
    // Treating that as "fresh install" would let the removal pass delete every
    // file the new manifest lists — i.e. the user's whole prior payload.
    fs.writeFileSync(path.join(first.configDir, 'gsd-file-manifest.json'), '{ not json');

    const second = install(true, 'codex');
    second.rollbackInstallerMigrations();

    assert.equal(
      fs.existsSync(managedPath),
      true,
      'an unreadable prior manifest must not let rollback delete the managed payload',
    );
  });
});

test('a minimal Codex rollback restores skills from the alternate skills home (#4249 CodeRabbit)', (t) => {
  withSandboxedHome(t, 'configured-entrypoint-codex-skills-', (root) => {
    const first = install(true, 'codex');
    // Codex resolves skills to $HOME/.agents/skills, NOT configDir (ADR-1239
    // skills-kind `home` override) — the surface #3245's own snapshot owns and
    // the manifest-driven pass deliberately leaves to it.
    const skillsRoot = path.join(root, '.agents', 'skills');
    const skillDir = fs.readdirSync(skillsRoot).find(name => name.startsWith('gsd-'));
    assert.ok(skillDir, `a Codex install must write gsd-* skills under ${skillsRoot}`);
    const skillFile = path.join(skillsRoot, skillDir, 'SKILL.md');

    const priorBytes = '# bytes only this test wrote\n';
    fs.writeFileSync(skillFile, priorBytes);

    // Marker-driven core profile — the `gsd update` path into minimal mode.
    fs.writeFileSync(path.join(first.configDir, '.gsd-profile'), 'core\n');
    const second = install(true, 'codex');
    second.rollbackInstallerMigrations();

    assert.equal(
      fs.existsSync(skillFile),
      true,
      'a minimal-mode rollback must not delete a skill dir it never snapshotted',
    );
    assert.equal(
      fs.readFileSync(skillFile, 'utf8'),
      priorBytes,
      'a minimal-mode rollback must restore alternate-home skills byte-for-byte',
    );
  });
});

test('a rollback with no prior manifest leaves the payload alone (#4249)', (t) => {
  withSandboxedHome(t, 'configured-entrypoint-codex-nomanifest-', () => {
    const first = install(true, 'codex');
    const managedPath = path.join(first.configDir, 'gsd-core', 'CHANGELOG.md');
    // A first install cannot tell "GSD created this file" from "GSD overwrote a
    // file the user already had there" — no prior manifest records the
    // difference. Removing it would be data loss, not rollback.
    fs.unlinkSync(path.join(first.configDir, 'gsd-file-manifest.json'));
    const userBytes = '# a file the user had at a tracked path\n';
    fs.writeFileSync(managedPath, userBytes);

    const second = install(true, 'codex');
    second.rollbackInstallerMigrations();

    assert.equal(
      fs.existsSync(managedPath),
      true,
      'with no prior manifest the removal pass must not run at all',
    );
  });
});

test('an aggregate entrypoint validation failure rolls the Codex install back (#4249)', (t) => {
  withSandboxedHome(t, 'configured-entrypoint-aggregate-', () => {
    const first = install(true, 'codex');
    const managedPath = path.join(first.configDir, 'gsd-core', 'CHANGELOG.md');
    const priorBytes = '# bytes only this test wrote\n';
    fs.writeFileSync(managedPath, priorBytes);

    // Cline's `#!/usr/bin/env node` hook records interpreterCandidates: ['node'],
    // resolved off PATH. Emptying PATH makes exactly that entry fail, which is
    // the only way to drive a REAL aggregate failure through installAllRuntimes:
    // every other entrypoint is a path the installer just wrote. Codex installs
    // first, so the reversed rollback loop reaches its restoreCodexSnapshot.
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      assert.throws(
        () => installAllRuntimes(['codex', 'cline'], true, false),
        /Configured entrypoint validation failed/,
        'an unresolvable interpreter must fail the aggregate gate',
      );
    } finally {
      process.env.PATH = savedPath;
    }

    assert.equal(
      fs.readFileSync(managedPath, 'utf8'),
      priorBytes,
      'the aggregate failure must reach restoreCodexSnapshot, not just throw',
    );
  });
});
