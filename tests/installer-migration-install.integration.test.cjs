/**
 * Phase 4 installer migration integration tests.
 *
 * These exercise the public install() entry point so the migration runner is
 * pinned at the install/update seam, not just as a standalone library.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const installModule = require('../bin/install.js');
const pkg = require('../package.json');
const { install } = installModule;
const { createTempDir, cleanup } = require('./helpers.cjs');

const installScript = path.join(__dirname, '..', 'bin', 'install.js');
const SUPPORTED_RUNTIMES = installModule.allRuntimes;
const RUNTIME_INSTALL_CONTRACTS = {
  claude: { surface: 'flat-skills', settings: true, packageJson: true },
  antigravity: { surface: 'flat-skills', settings: true, packageJson: true },
  augment: { surface: 'flat-skills', settings: true, packageJson: true },
  cline: { surface: 'clinerules', settings: false, packageJson: false },
  codebuddy: { surface: 'flat-skills', settings: true, packageJson: true },
  codex: { surface: 'flat-skills', settings: false, packageJson: false, codexConfig: true },
  copilot: { surface: 'flat-skills', settings: false, packageJson: false, copilotInstructions: true },
  cursor: { surface: 'flat-skills', settings: false, packageJson: false },
  gemini: { surface: 'commands-gsd', settings: true, packageJson: true },
  hermes: { surface: 'hermes-skills', settings: true, packageJson: true },
  kimi: { surface: 'kimi-skills-agents', settings: false, packageJson: false },
  // #2454: Kimi Code (Node CLI) has NO custom named subagents (per official
  // docs), so its install surface is skills-only (flat-skills), NOT
  // kimi-skills-agents. The kimi-agents YAML layout is Python kimi-cli only.
  'kimi-code': { surface: 'flat-skills', settings: false, packageJson: false },
  // #2305: Kilo's native plugin spawns the staged guard hooks, so it receives
  // the shared hooks bundle + the CommonJS package.json marker, like OpenCode.
  // (#1821 excluded Kilo on the false premise that it had no plugin surface.)
  kilo: { surface: 'flat-command', settings: false, packageJson: true },
  // #2329: OpenCode discovers commands from the PLURAL `commands/` dir — the
  // singular `command/` (still correct for Kilo) made all /gsd-* commands
  // invisible to OpenCode. commandDirName overrides the flat-command default.
  opencode: { surface: 'flat-command', settings: true, packageJson: true, commandDirName: 'commands' },
  // #2102 Stage 1/2: pi is a PLUGIN-ONLY install (hostBehaviors.pluginOnlyInstall)
  // for commands/agents/skills — NO commands/, agents/, or skills/ dir. pi's
  // /gsd command is registered programmatically by the native extension
  // (extensions/gsd.cjs) and dispatches via a bounded subprocess to
  // gsd-tools.cjs; it has no host-read markdown surface. Stage 2 (adversarial-
  // review fix): pi's native extension DOES spawn the shared hooks/*.js bundle
  // as bounded subprocesses (session_start/before_agent_start/session_before_
  // compact bridges) and its /gsd tokenizer requires hooks/lib/git-cmd.js, so
  // `hostBehaviors.skipSharedHooksInstall` was removed — pi now receives
  // hooks/ + hooks/lib/ + the {"type":"commonjs"} package.json marker, exactly
  // like OpenCode and (since #2305) Kilo — architecturally identical:
  // hooksSurface:'none' + a native plugin that spawns the staged hooks — NOT
  // like ZCode (no plugin surface, where the same hooks are dead weight).
  pi: { surface: 'plugin-only', settings: false, packageJson: true },
  qoder: { surface: 'flat-skills', settings: true, packageJson: true },
  qwen: { surface: 'flat-skills', settings: true, packageJson: true },
  trae: { surface: 'flat-skills', settings: false, packageJson: false },
  windsurf: { surface: 'global-artifacts-noop', settings: false, packageJson: false },
  // #1821: ZCode (hooksSurface:none, no plugin surface) no longer receives the
  // dead hook scripts or the CommonJS package.json marker.
  zcode: { surface: 'flat-skills', settings: false, packageJson: false },
};

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeManifest(root, files) {
  fs.writeFileSync(
    path.join(root, 'gsd-file-manifest.json'),
    JSON.stringify({
      version: '1.49.0',
      timestamp: '2026-05-10T00:00:00.000Z',
      mode: 'full',
      files,
    }, null, 2),
    'utf8'
  );
}

function withEnv(key, value, fn) {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  }
}

// #2088: Codex CLI skills install to `$HOME/.agents/skills` (resolved via
// os.homedir()), not `$CODEX_HOME/skills`. In-process codex installs must
// sandbox HOME (and USERPROFILE, for Windows os.homedir() resolution) to the
// test's codexHome dir, or skills get materialized into the real developer
// home directory. withEnv saves/restores a single key, so nesting is safe.
function withCodexEnv(codexHome, fn) {
  return withEnv('CODEX_HOME', codexHome, () =>
    withEnv('HOME', codexHome, () =>
      withEnv('USERPROFILE', codexHome, fn)
    )
  );
}

function captureConsole(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    return { value: fn(), output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function withWriteFailure(matchPath, fn) {
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(matchPath)) {
      throw new Error(`injected write failure for ${path.basename(matchPath)}`);
    }
    return originalWriteFileSync.call(fs, filePath, ...args);
  };
  try {
    return fn();
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
}

function withSdkDistPresent(fn) {
  const sdkCliPath = path.join(__dirname, '..', 'sdk', 'dist', 'cli.js');
  const originalExistsSync = fs.existsSync;
  const originalStatSync = fs.statSync;
  const originalChmodSync = fs.chmodSync;
  fs.existsSync = (filePath) => {
    if (path.resolve(String(filePath)) === path.resolve(sdkCliPath)) return true;
    return originalExistsSync.call(fs, filePath);
  };
  fs.statSync = (filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(sdkCliPath)) {
      return { mode: 0o755 };
    }
    return originalStatSync.call(fs, filePath, ...args);
  };
  fs.chmodSync = (filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(sdkCliPath)) return;
    return originalChmodSync.call(fs, filePath, ...args);
  };
  try {
    return fn();
  } finally {
    fs.existsSync = originalExistsSync;
    fs.statSync = originalStatSync;
    fs.chmodSync = originalChmodSync;
  }
}

function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the required leading byte of ANSI SGR color sequences; matching it is the purpose of stripping ANSI codes from captured CLI/console output
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function runInstallerCli(runtime, targetDir, options = {}) {
  const { minimal = true } = options;
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  env.HOME = path.join(path.dirname(targetDir), 'home');
  env.USERPROFILE = env.HOME;

  return spawnSync(
    process.execPath,
    [
      installScript,
      `--${runtime}`,
      '--global',
      '--config-dir',
      targetDir,
      ...(minimal ? ['--minimal'] : []),
      '--no-sdk',
    ],
    {
      encoding: 'utf8',
      env,
    }
  );
}

function listDirNames(root, relPath) {
  const dir = path.join(root, relPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name);
}

function assertHasGsdDirectory(root, relPath) {
  assert.ok(
    listDirNames(root, relPath).some((name) => name.startsWith('gsd-')),
    `${relPath} should contain generated GSD entries`
  );
}

function assertFreshInstallContract(runtime, targetDir) {
  const contract = RUNTIME_INSTALL_CONTRACTS[runtime];
  assert.ok(contract, `missing runtime install contract for ${runtime}`);

  if (contract.workflowPayload !== false) {
    assert.equal(
      fs.readFileSync(path.join(targetDir, 'gsd-core', 'VERSION'), 'utf8'),
      pkg.version,
      `${runtime} should install the package VERSION`
    );
    assert.ok(
      fs.existsSync(path.join(targetDir, 'gsd-core', 'bin', 'gsd-tools.cjs')),
      `${runtime} should install the GSD tool payload`
    );
    assert.ok(
      fs.existsSync(path.join(targetDir, 'gsd-file-manifest.json')),
      `${runtime} should write the install manifest`
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'gsd-file-manifest.json'), 'utf8'));
    assert.equal(manifest.version, pkg.version, `${runtime} manifest should record the package version`);
    assert.equal(manifest.mode, 'full', `${runtime} manifest should record a full install`);
    assert.ok(
      manifest.files['gsd-core/VERSION'],
      `${runtime} manifest should track the installed VERSION file`
    );
  } else {
    assert.equal(
      fs.existsSync(path.join(targetDir, 'gsd-core')),
      false,
      `${runtime} should not install the GSD workflow payload`
    );
  }

  if (contract.surface === 'flat-skills') {
    if (runtime === 'codex') {
      // #2088: Codex CLI skills install to the canonical `$HOME/.agents/skills`
      // root (resolved via os.homedir()), NOT `<config-dir>/skills`. Here
      // runInstallerCli sandboxes HOME to <dirname(targetDir)>/home, so assert
      // the skill dir under that sandboxed home instead of under targetDir.
      const codexSandboxHome = path.join(path.dirname(targetDir), 'home');
      assertHasGsdDirectory(path.join(codexSandboxHome, '.agents'), 'skills');
    } else {
      // Pre-#3562: codex was special-cased to expect zero gsd-* skill dirs
      // (assumption: Codex auto-discovers from workflows). That assumption
      // does not hold for Codex CLI 0.130.0 — fresh installs now materialize
      // the same flat-skills surface as the other runtimes.
      assertHasGsdDirectory(targetDir, 'skills');
    }
  } else if (contract.surface === 'hermes-skills') {
    // Hermes layout uses prefix: '' — skill dirs have bare stem names (no gsd- prefix).
    // Assert that the category dir contains at least one skill dir with SKILL.md.
    const hermesGsdDir = path.join(targetDir, 'skills', 'gsd');
    const hermesSkillCount = fs.existsSync(hermesGsdDir)
      ? fs.readdirSync(hermesGsdDir, { withFileTypes: true })
          .filter(e => e.isDirectory() && fs.existsSync(path.join(hermesGsdDir, e.name, 'SKILL.md')))
          .length
      : 0;
    assert.ok(hermesSkillCount > 0, `skills/gsd should contain generated GSD entries (got ${hermesSkillCount})`);
    assert.ok(
      fs.existsSync(path.join(targetDir, 'skills', 'gsd', 'DESCRIPTION.md')),
      'Hermes should install the nested GSD category description'
    );
  } else if (contract.surface === 'flat-command') {
    // #2329: dir name is per-runtime (opencode='commands', kilo stays 'command').
    const commandDirName = contract.commandDirName || 'command';
    assert.ok(
      listDirNames(targetDir, commandDirName).some((name) => name.startsWith('gsd-') && name.endsWith('.md')),
      `${runtime} should install flattened command markdown files in ${commandDirName}/`
    );
  } else if (contract.surface === 'plugin-only') {
    // #2102 Stage 1/2: pi — PLUGIN-ONLY install for commands/agents/skills
    // (hostBehaviors.pluginOnlyInstall). pi's /gsd command is registered
    // programmatically by the native extension and dispatches via a bounded
    // subprocess to gsd-tools.cjs — pi has no host-read markdown surface, so
    // NO commands/, agents/, or skills/ dir is written. The extension DOES
    // spawn the shared hooks/*.js bundle as bounded subprocesses (Stage 2
    // adversarial-review fix — hooksSurface:'none' no longer implies
    // skipSharedHooksInstall for pi, mirroring OpenCode), so hooks/ + the
    // git-cmd.js tokenizer helper ARE part of the artifact surface now.
    // #2470: the dest filename comes from pi's descriptor, and must satisfy
    // pi's isExtensionFile() auto-discovery filter (.ts/.js only) — otherwise
    // the file installs but pi never loads it and /gsd never registers.
    const piNativePlugin = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'pi', 'capability.json'), 'utf8')
    ).runtime.hostBehaviors.nativePlugin;
    assert.ok(
      piNativePlugin.file.endsWith('.ts') || piNativePlugin.file.endsWith('.js'),
      `${runtime}'s extension "${piNativePlugin.file}" must end in .ts or .js for pi to discover it (#2470)`
    );
    assert.ok(
      fs.existsSync(path.join(targetDir, piNativePlugin.dir, piNativePlugin.file)),
      `${runtime} should install the native extension file at ${piNativePlugin.dir}/${piNativePlugin.file}`
    );
    assert.ok(
      fs.existsSync(path.join(targetDir, 'hooks', 'gsd-ensure-canonical-path.js')),
      `${runtime} should install the shared hooks/ bundle (spawned by the native extension's event bridges)`
    );
    assert.ok(
      fs.existsSync(path.join(targetDir, 'hooks', 'lib', 'git-cmd.js')),
      `${runtime} should install hooks/lib/git-cmd.js (the /gsd command tokenizer)`
    );
    assert.equal(
      fs.existsSync(path.join(targetDir, 'commands')),
      false,
      `${runtime} should NOT install a commands/ dir (plugin-only, no host-read markdown surface)`
    );
    assert.equal(
      fs.existsSync(path.join(targetDir, 'agents')),
      false,
      `${runtime} should NOT install an agents/ dir (plugin-only, no named-dispatch toolkit)`
    );
    assert.equal(
      fs.existsSync(path.join(targetDir, 'skills')),
      false,
      `${runtime} should NOT install a skills/ dir (plugin-only)`
    );
  } else if (contract.surface === 'commands-gsd') {
    assert.ok(
      listDirNames(targetDir, path.join('commands', 'gsd')).length > 0,
      `${runtime} should install commands/gsd entries`
    );
  } else if (contract.surface === 'kimi-skills-agents') {
    assertHasGsdDirectory(targetDir, 'skills');
    assert.ok(
      fs.existsSync(path.join(targetDir, 'agents', 'gsd.yaml')),
      'Kimi should install the root agent YAML'
    );
    assert.ok(
      fs.existsSync(path.join(targetDir, 'agents', 'gsd.md')),
      'Kimi should install the root agent prompt'
    );
    assert.ok(
      fs.existsSync(path.join(targetDir, 'agents', 'subagents', 'gsd-executor.yaml')),
      'Kimi should install GSD subagent YAML'
    );
  } else if (contract.surface === 'clinerules') {
    // #787: Cline now uses the .clinerules/ directory form (rules at gsd.md).
    assert.match(
      fs.readFileSync(path.join(targetDir, '.clinerules', 'gsd.md'), 'utf8'),
      /GSD workflows live in `gsd-core\/workflows\/`/,
      'Cline should install .clinerules/gsd.md guidance'
    );
  } else if (contract.surface === 'global-artifacts-noop') {
    assert.equal(
      fs.existsSync(path.join(targetDir, 'skills')),
      false,
      `${runtime} should not install unsupported global skills artifacts`
    );
    assert.equal(
      fs.existsSync(path.join(targetDir, 'workflows')),
      false,
      `${runtime} should not install unsupported global workflow artifacts`
    );
  }

  if (contract.surface !== 'kimi-skills-agents' && contract.surface !== 'global-artifacts-noop' && contract.surface !== 'plugin-only') {
    assert.ok(
      listDirNames(targetDir, 'agents').some((name) => name.startsWith('gsd-')),
      `${runtime} full install should install agents`
    );
  }

  assert.equal(
    fs.existsSync(path.join(targetDir, 'settings.json')),
    contract.settings,
    `${runtime} settings.json presence should match the runtime contract`
  );
  assert.equal(
    fs.existsSync(path.join(targetDir, 'package.json')),
    contract.packageJson,
    `${runtime} package.json presence should match the runtime contract`
  );

  if (contract.codexConfig) {
    assert.match(
      fs.readFileSync(path.join(targetDir, 'config.toml'), 'utf8'),
      /GSD Agent Configuration/,
      'Codex should install config.toml with the GSD marker'
    );
  }

  if (contract.copilotInstructions) {
    assert.match(
      fs.readFileSync(path.join(targetDir, 'copilot-instructions.md'), 'utf8'),
      /GSD Configuration/,
      'Copilot should install managed copilot instructions'
    );
  }
}

describe('installer migration install integration', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    tmpRoot = createTempDir('gsd-install-migrations-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('reports applied migration actions before package materialization', () => {
    writeFile(codexHome, 'hooks/statusline.js', 'legacy managed hook\n');
    writeManifest(codexHome, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    const { output } = captureConsole(() =>
      withCodexEnv(codexHome, () => install(true, 'codex'))
    );

    const plainOutput = stripAnsi(output);
    assert.match(plainOutput, /Installer migrations/);
    assert.match(plainOutput, /removed\s+hooks\/statusline\.js/);
    assert.ok(
      plainOutput.indexOf('Installer migrations') < plainOutput.indexOf('Installed workflow assets'),
      'migration report should appear before package materialization'
    );
    assert.equal(fs.existsSync(path.join(codexHome, 'hooks/statusline.js')), false);
  });

  test('blocks install before materialization when baseline needs explicit user choice', () => {
    writeFile(codexHome, 'hooks/gsd-retired-hook.txt', 'old gsd hook\n');

    assert.throws(
      () => captureConsole(() =>
        withCodexEnv(codexHome, () => install(true, 'codex'))
      ),
      /installer migration blocked/
    );

    assert.equal(fs.readFileSync(path.join(codexHome, 'hooks/gsd-retired-hook.txt'), 'utf8'), 'old gsd hook\n');
    assert.equal(fs.existsSync(path.join(codexHome, 'skills')), false);
    // #2088: with HOME sandboxed to codexHome via withCodexEnv, Codex's
    // canonical skill root ($HOME/.agents/skills) resolves under codexHome
    // too — assert nothing was materialized there when the install is blocked.
    assert.equal(fs.existsSync(path.join(codexHome, '.agents', 'skills')), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'gsd-core', 'VERSION')), false);
  });

  test('rolls back applied migrations when package materialization fails for non-Codex installs', () => {
    const claudeHome = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    writeFile(claudeHome, 'hooks/statusline.js', 'legacy managed hook\n');
    writeManifest(claudeHome, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    assert.throws(
      () => captureConsole(() =>
        withEnv('CLAUDE_CONFIG_DIR', claudeHome, () =>
          withWriteFailure(path.join(claudeHome, 'gsd-core', 'VERSION'), () => install(true, 'claude'))
        )
      ),
      /injected write failure for VERSION/
    );

    assert.equal(
      fs.readFileSync(path.join(claudeHome, 'hooks/statusline.js'), 'utf8'),
      'legacy managed hook\n'
    );
    assert.equal(fs.existsSync(path.join(claudeHome, 'gsd-install-state.json')), false);
  });

  test('rolls back applied migrations when multi-runtime finalization fails', () => {
    const claudeHome = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    writeFile(claudeHome, 'hooks/statusline.js', 'legacy managed hook\n');
    writeManifest(claudeHome, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    assert.throws(
      () => captureConsole(() =>
        withEnv('CLAUDE_CONFIG_DIR', claudeHome, () =>
          withSdkDistPresent(() =>
            withWriteFailure(path.join(claudeHome, 'settings.json'), () =>
              installModule.installAllRuntimes(['claude'], true, false)
            )
          )
        )
      ),
      /injected write failure for settings\.json/
    );

    assert.equal(
      fs.readFileSync(path.join(claudeHome, 'hooks/statusline.js'), 'utf8'),
      'legacy managed hook\n'
    );
    assert.equal(fs.existsSync(path.join(claudeHome, 'gsd-install-state.json')), false);
  });

  test('rolls back completed runtime migrations when a later runtime install fails', () => {
    const claudeHome = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    writeFile(claudeHome, 'hooks/statusline.js', 'legacy managed hook\n');
    writeManifest(claudeHome, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    writeFile(codexHome, 'hooks/statusline.js', 'legacy managed hook\n');
    writeManifest(codexHome, {
      'hooks/statusline.js': sha256('legacy managed hook\n'),
    });

    assert.throws(
      () => captureConsole(() =>
        withEnv('CLAUDE_CONFIG_DIR', claudeHome, () =>
          withCodexEnv(codexHome, () =>
            withWriteFailure(path.join(codexHome, 'gsd-core', 'VERSION'), () =>
              installModule.installAllRuntimes(['claude', 'codex'], true, false)
            )
          )
        )
      ),
      /injected write failure for VERSION/
    );

    assert.equal(
      fs.readFileSync(path.join(claudeHome, 'hooks/statusline.js'), 'utf8'),
      'legacy managed hook\n'
    );
    assert.equal(fs.existsSync(path.join(claudeHome, 'gsd-install-state.json')), false);
    assert.equal(
      fs.readFileSync(path.join(codexHome, 'hooks/statusline.js'), 'utf8'),
      'legacy managed hook\n'
    );
    assert.equal(fs.existsSync(path.join(codexHome, 'gsd-install-state.json')), false);
  });

  for (const runtime of SUPPORTED_RUNTIMES) {
    test(`runs a full end-to-end install for ${runtime}`, () => {
      const targetDir = path.join(tmpRoot, `.${runtime}-full-install`);
      fs.mkdirSync(targetDir, { recursive: true });
      writeFile(targetDir, 'hooks/statusline.js', 'legacy managed hook\n');
      writeManifest(targetDir, {
        'hooks/statusline.js': sha256('legacy managed hook\n'),
      });

      const result = runInstallerCli(runtime, targetDir, { minimal: false });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
      assert.match(output, /Installing for /);
      assert.match(output, /Installer migrations/);
      assert.match(output, /removed\s+hooks\/statusline\.js/);
      if (runtime === 'kimi') {
        assert.match(output, /Generated Kimi root agent/);
      } else {
        assert.match(output, /Installed workflow assets/);
      }
      assert.match(output, /Done!/);
      assert.equal(fs.existsSync(path.join(targetDir, 'hooks/statusline.js')), false);

      const installState = JSON.parse(fs.readFileSync(path.join(targetDir, 'gsd-install-state.json'), 'utf8'));
      assert.ok(
        installState.appliedMigrations.some((entry) => entry.id === '2026-05-11-legacy-orphan-files'),
        `${runtime} should track the applied cleanup migration in install state`
      );
      assertFreshInstallContract(runtime, targetDir);
    });

    test(`runs managed cleanup migrations for ${runtime}`, () => {
      const targetDir = path.join(tmpRoot, `.${runtime}-managed-cleanup`);
      fs.mkdirSync(targetDir, { recursive: true });
      writeFile(targetDir, 'hooks/statusline.js', 'legacy managed hook\n');
      writeManifest(targetDir, {
        'hooks/statusline.js': sha256('legacy managed hook\n'),
      });

      const result = runInstallerCli(runtime, targetDir);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
      assert.match(output, /Installer migrations/);
      assert.match(output, /removed\s+hooks\/statusline\.js/);
      assert.equal(fs.existsSync(path.join(targetDir, 'hooks/statusline.js')), false);
      const installState = JSON.parse(fs.readFileSync(path.join(targetDir, 'gsd-install-state.json'), 'utf8'));
      assert.ok(
        installState.appliedMigrations.some((entry) => entry.id === '2026-05-11-legacy-orphan-files'),
        'successful install should write install state for the applied cleanup migration'
      );
    });

    test(`blocks ambiguous GSD-looking user-choice artifacts for ${runtime}`, () => {
      const targetDir = path.join(tmpRoot, `.${runtime}-blocked`);
      fs.mkdirSync(targetDir, { recursive: true });
      writeFile(targetDir, 'gsd-core/gsd-retired-tool.cjs', 'old ambiguous artifact\n');

      const result = runInstallerCli(runtime, targetDir);

      assert.notEqual(result.status, 0, 'install should fail before materialization');
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
      assert.match(output, /Installer migrations/);
      assert.match(output, /blocked\s+gsd-core\/gsd-retired-tool\.cjs/);
      assert.match(output, /installer migration blocked/);
      assert.equal(
        fs.readFileSync(path.join(targetDir, 'gsd-core/gsd-retired-tool.cjs'), 'utf8'),
        'old ambiguous artifact\n'
      );
      assert.equal(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')), false);
    });
  }
});
