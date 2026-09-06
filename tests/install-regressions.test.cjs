'use strict';
/**
 * Installer Module — date-stamped regression tests.
 *
 * Consolidates install-hermes-regressions.test.cjs into a single
 * regressions file for the installer module cluster.
 *
 * Defects covered:
 *   #3664         — --config-dir foreign-agent destination warning (warn-and-proceed)
 *   #3664 Defect #1 — stale skills/gsd/gsd-<stem>/ dirs on Hermes upgrade
 *   #3664 Defect #2 — --hermes --profile=core falls through to wrong path
 *   #2973 M1–M3    — dev-preferences migration at profile=core for hermes/qwen/claude
 *   #2973 U1–U3    — uninstall preserves dev-preferences via skill migration
 *
 * Closes #3758
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const { createTempDir, cleanup, mockPartialWriteThenThrow } = require('./helpers.cjs');
const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

// Load install exports via GSD_TEST_MODE to skip CLI main()
const savedTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';
let installExports;
try {
  installExports = require('../bin/install.js');
} finally {
  if (savedTestMode === undefined) delete process.env.GSD_TEST_MODE;
  else process.env.GSD_TEST_MODE = savedTestMode;
}

const { install, mergeClaudePermissions, GSD_CLAUDE_ALLOW_PERMISSIONS, GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS, GSD_CLAUDE_LEGACY_DENY_PERMISSIONS, copyWithPathReplacement } = installExports || {};

const {
  installRuntimeArtifacts,
  uninstallRuntimeArtifacts,
} = require('../gsd-core/bin/lib/install-engine.cjs');

const {
  rewriteLegacyManagedNodeHookCommands,
  resolveNodeRunner,
  reconcileManagedShellHookCommands,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const HOOKS_SRC = path.join(__dirname, '..', 'hooks');
const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

/**
 * Stub managed GSD hook files into targetDir/hooks/ so that
 * fs.existsSync guards in the installer pass during tests where
 * hooks/dist/ is not built.
 */
function stubHooksIntoDir(targetDir, hookNames) {
  const hooksDest = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  for (const hookFile of hookNames) {
    const src = path.join(HOOKS_SRC, hookFile);
    const dest = path.join(hooksDest, hookFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
    }
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
}

describe('#2429 regression: Codex local skills stay project-scoped', () => {
  test('--codex --local --profile=core installs under .codex without writing to HOME', (t) => {
    const root = createTempDir('gsd 2429 ');
    const projectDir = path.join(root, 'project with spaces');
    const homeDir = path.join(root, 'home with spaces');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    t.after(() => cleanup(root));

    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    delete env.GSD_TEST_MODE;
    delete env.CODEX_HOME;

    const result = runNode(
      [INSTALL_SCRIPT, '--codex', '--local', '--profile=core'],
      { cwd: projectDir, env, timeoutMs: 60_000 },
    );

    assert.strictEqual(
      result.exitCode,
      0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
    );
    assert.ok(
      fs.existsSync(path.join(projectDir, '.codex', 'skills', 'gsd-help', 'SKILL.md')),
      'Codex local install must write gsd-help under the project .codex directory',
    );
    assert.ok(
      !fs.existsSync(path.join(homeDir, '.agents', 'skills', 'gsd-help', 'SKILL.md')),
      'Codex local install must not write gsd-help under the global .agents directory',
    );
  });
});

// ─── Defect #1 — Hermes upgrade: bare-stem dirs from #3664 era become stale ──
//
// #947 REVERSES #3664: the canonical layout is now skills/gsd/gsd-<stem>/ again.
// The migration now removes bare-stem dirs (from #3664: prefix='') and writes
// the gsd-prefixed layout. Pre-existing gsd-prefixed dirs (the "intermediate"
// layout from before #3664) are now the CANONICAL dirs and are kept / updated.

describe('Defect #1 regression (#3664 reversed by #947): bare-stem dirs removed, gsd- prefix written', () => {
  test('installRuntimeArtifacts removes bare-stem skills/gsd/<stem>/ dirs and writes gsd- prefixed layout', (t) => {
    const configDir = createTempDir('gsd-hermes-reg1-');
    t.after(() => cleanup(configDir));

    assert.strictEqual(typeof installRuntimeArtifacts, 'function',
      'installRuntimeArtifacts must be exported from install-engine.cjs');

    // Pre-create #3664-era bare-stem Hermes layout (no gsd- prefix, now stale).
    // Use real GSD command stems (help, quick) that readGsdCommandNames() knows about.
    const nestedGsdDir = path.join(configDir, 'skills', 'gsd');
    fs.mkdirSync(path.join(nestedGsdDir, 'help'), { recursive: true });
    fs.writeFileSync(path.join(nestedGsdDir, 'help', 'SKILL.md'), '# legacy bare-stem help\n');
    fs.mkdirSync(path.join(nestedGsdDir, 'quick'), { recursive: true });
    fs.writeFileSync(path.join(nestedGsdDir, 'quick', 'SKILL.md'), '# legacy bare-stem quick\n');

    // Sibling non-gsd dir inside skills/gsd/ must survive
    const userContentDir = path.join(nestedGsdDir, 'user-content');
    fs.mkdirSync(userContentDir, { recursive: true });
    fs.writeFileSync(path.join(userContentDir, 'SKILL.md'), '# user content\n');

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_CORE);

    // Bare-stem dirs from #3664 must be cleaned
    assert.ok(!fs.existsSync(path.join(nestedGsdDir, 'help')),
      'skills/gsd/help/ (bare-stem from #3664) must be removed (#947)');
    assert.ok(!fs.existsSync(path.join(nestedGsdDir, 'quick')),
      'skills/gsd/quick/ (bare-stem from #3664) must be removed (#947)');
    // Canonical gsd- prefixed layout must be written
    assert.ok(fs.existsSync(path.join(nestedGsdDir, 'gsd-help', 'SKILL.md')),
      'skills/gsd/gsd-help/SKILL.md must exist after install (#947 canonical layout)');
    // User content preserved
    assert.ok(fs.existsSync(path.join(userContentDir, 'SKILL.md')),
      'user-content must be preserved');
  });
});

// ─── Defect #2 — --qwen --profile=core falls through to wrong path ────────────

describe('Defect #2 regression (Qwen, #3664): --qwen --profile=core writes skills/gsd-*/, not commands/gsd/', () => {
  test('spawn --qwen --global --profile=core: skills/gsd-*/ written, no commands/gsd/', (t) => {
    const root = createTempDir('gsd-qwen-reg2-');
    t.after(() => cleanup(root));

    const result = runNode(
      [INSTALL_SCRIPT, '--qwen', '--global', '--config-dir', root, '--profile=core'],
      { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS },
    );

    assert.strictEqual(result.exitCode, 0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);

    const qwenSkillsDir = path.join(root, 'skills');
    assert.ok(fs.existsSync(qwenSkillsDir));

    const skillDirs = fs.readdirSync(qwenSkillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillDirs.length >= 1, 'at least one gsd-* skill dir must exist');
    assert.ok(
      skillDirs.some(e => fs.existsSync(path.join(qwenSkillsDir, e.name, 'SKILL.md'))),
      'at least one skills/gsd-*/SKILL.md must exist'
    );

    const commandsGsd = path.join(root, 'commands', 'gsd');
    if (fs.existsSync(commandsGsd)) {
      const mdFiles = fs.readdirSync(commandsGsd).filter(f => f.endsWith('.md'));
      assert.strictEqual(mdFiles.length, 0, `commands/gsd/ must not contain .md files (Defect #2). Found: ${mdFiles.join(', ')}`);
    }
  });
});

describe('Defect #2 regression (Hermes, #3664): --hermes --profile=core writes skills/gsd/, not commands/gsd/', () => {
  test('spawn --hermes --global --profile=core: skills/gsd/ written, no commands/gsd/', (t) => {
    const root = createTempDir('gsd-hermes-reg2-');
    t.after(() => cleanup(root));

    const result = runNode(
      [INSTALL_SCRIPT, '--hermes', '--global', '--config-dir', root, '--profile=core'],
      { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS },
    );

    assert.strictEqual(result.exitCode, 0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);

    const hermesSkillsGsd = path.join(root, 'skills', 'gsd');
    assert.ok(fs.existsSync(hermesSkillsGsd));

    const skillDirs = fs.readdirSync(hermesSkillsGsd, { withFileTypes: true })
      .filter(e => e.isDirectory());
    assert.ok(skillDirs.length >= 1);
    assert.ok(
      skillDirs.some(e => fs.existsSync(path.join(hermesSkillsGsd, e.name, 'SKILL.md'))),
    );

    const commandsGsd = path.join(root, 'commands', 'gsd');
    if (fs.existsSync(commandsGsd)) {
      const mdFiles = fs.readdirSync(commandsGsd).filter(f => f.endsWith('.md'));
      assert.strictEqual(mdFiles.length, 0, `commands/gsd/ must not contain .md files (Defect #2). Found: ${mdFiles.join(', ')}`);
    }
  });
});

// ─── M1 — Hermes minimal-mode migrates dev-preferences (#2973) ───────────────

describe('M1 (#2973, #947): --hermes --global --profile=core migrates dev-preferences → skills/gsd/gsd-dev-preferences/SKILL.md', () => {
  test('dev-preferences migrated to nested Hermes location, legacy source removed', (t) => {
    const root = createTempDir('gsd-hermes-m1-');
    t.after(() => cleanup(root));

    const legacyDir = path.join(root, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dev-preferences.md'), '# my hermes prefs\n');

    const result = runNode(
      [INSTALL_SCRIPT, '--hermes', '--global', '--config-dir', root, '--profile=core'],
      { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS },
    );

    assert.strictEqual(result.exitCode, 0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);

    // #947: Hermes uses prefix='gsd-' so dev-preferences lands at gsd-dev-preferences/ (not dev-preferences/)
    const skillFile = path.join(root, 'skills', 'gsd', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile),
      'skills/gsd/gsd-dev-preferences/SKILL.md must exist (M1+#947: gsd- prefix, nested)');
    assert.strictEqual(fs.readFileSync(skillFile, 'utf8'), '# my hermes prefs\n');
    assert.ok(!fs.existsSync(path.join(legacyDir, 'dev-preferences.md')),
      'legacy source must be removed');
  });
});

// ─── M2 — Qwen minimal-mode migrates dev-preferences (#2973) ────────────────

describe('M2 (#2973): --qwen --global --profile=core migrates dev-preferences → skills/gsd-dev-preferences/SKILL.md', () => {
  test('dev-preferences migrated to flat Qwen location, legacy source removed', (t) => {
    const root = createTempDir('gsd-qwen-m2-');
    t.after(() => cleanup(root));

    const legacyDir = path.join(root, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dev-preferences.md'), '# my qwen prefs\n');

    const result = runNode(
      [INSTALL_SCRIPT, '--qwen', '--global', '--config-dir', root, '--profile=core'],
      { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS },
    );

    assert.strictEqual(result.exitCode, 0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);

    const skillFile = path.join(root, 'skills', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile),
      'skills/gsd-dev-preferences/SKILL.md must exist (M2: flat Qwen layout)');
    assert.strictEqual(fs.readFileSync(skillFile, 'utf8'), '# my qwen prefs\n');
    assert.ok(!fs.existsSync(path.join(legacyDir, 'dev-preferences.md')));
  });
});

// ─── M3 — Claude global minimal-mode migrates dev-preferences (#2973) ────────

describe('M3 (#2973): --claude --global --profile=core migrates dev-preferences → skills/gsd-dev-preferences/SKILL.md', () => {
  test('dev-preferences migrated to flat Claude-global location, legacy source removed', (t) => {
    const root = createTempDir('gsd-claude-m3-');
    t.after(() => cleanup(root));

    const legacyDir = path.join(root, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dev-preferences.md'), '# my claude prefs\n');

    const result = runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root, '--profile=core'],
      { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS },
    );

    assert.strictEqual(result.exitCode, 0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);

    const skillFile = path.join(root, 'skills', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile),
      'skills/gsd-dev-preferences/SKILL.md must exist (M3)');
    assert.strictEqual(fs.readFileSync(skillFile, 'utf8'), '# my claude prefs\n');
    assert.ok(!fs.existsSync(path.join(legacyDir, 'dev-preferences.md')));
  });
});

// ─── U1 — Qwen uninstall preserves dev-preferences via migration (#2973) ─────

describe('U1 (#2973): uninstallRuntimeArtifacts qwen migrates dev-preferences → skills/gsd-dev-preferences/SKILL.md', () => {
  test('commands/gsd/ removed, dev-preferences migrated to skills skill', (t) => {
    const configDir = createTempDir('gsd-qwen-uninstall-u1-');
    t.after(() => cleanup(configDir));

    assert.strictEqual(typeof uninstallRuntimeArtifacts, 'function',
      'uninstallRuntimeArtifacts must be exported from install-engine.cjs');

    const legacyDir = path.join(configDir, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dev-preferences.md'), '# my qwen prefs\n');
    fs.writeFileSync(path.join(legacyDir, 'help.md'), '# help content\n');

    uninstallRuntimeArtifacts('qwen', configDir, 'global');

    assert.ok(!fs.existsSync(path.join(legacyDir, 'help.md')));
    assert.ok(!fs.existsSync(path.join(legacyDir, 'dev-preferences.md')));

    const skillFile = path.join(configDir, 'skills', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile), 'skills/gsd-dev-preferences/SKILL.md must exist (U1)');
    assert.strictEqual(fs.readFileSync(skillFile, 'utf8'), '# my qwen prefs\n');
  });
});

// ─── U2 — Claude-global uninstall preserves dev-preferences (#2973) ──────────

describe('U2 (#2973): uninstallRuntimeArtifacts claude/global migrates dev-preferences → skills/gsd-dev-preferences/SKILL.md', () => {
  test('commands/gsd/ removed, dev-preferences migrated to skills skill', (t) => {
    const configDir = createTempDir('gsd-claude-uninstall-u2-');
    t.after(() => cleanup(configDir));

    assert.strictEqual(typeof uninstallRuntimeArtifacts, 'function');

    const legacyDir = path.join(configDir, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dev-preferences.md'), '# my claude prefs\n');

    uninstallRuntimeArtifacts('claude', configDir, 'global');

    assert.ok(!fs.existsSync(path.join(legacyDir, 'dev-preferences.md')));

    const skillFile = path.join(configDir, 'skills', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile), 'skills/gsd-dev-preferences/SKILL.md must exist (U2)');
    assert.strictEqual(fs.readFileSync(skillFile, 'utf8'), '# my claude prefs\n');
  });
});

// ─── U3 — Hermes uninstall migrates dev-preferences to NESTED location (#2973) ─

describe('U3 (#2973, #947): uninstallRuntimeArtifacts hermes migrates dev-preferences → skills/gsd/gsd-dev-preferences/SKILL.md', () => {
  test('commands/gsd/ NOT recreated, dev-preferences at nested Hermes location with gsd- prefix', (t) => {
    const configDir = createTempDir('gsd-hermes-uninstall-u3-');
    t.after(() => cleanup(configDir));

    assert.strictEqual(typeof uninstallRuntimeArtifacts, 'function');

    const legacyDir = path.join(configDir, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dev-preferences.md'), '# my hermes prefs\n');

    uninstallRuntimeArtifacts('hermes', configDir, 'global');

    assert.ok(!fs.existsSync(path.join(legacyDir, 'dev-preferences.md')),
      'commands/gsd/dev-preferences.md must not exist after hermes uninstall (U3)');

    // #947: Hermes uses prefix='gsd-' so dev-preferences lands at gsd-dev-preferences/ (not dev-preferences/)
    const skillFile = path.join(configDir, 'skills', 'gsd', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile),
      'skills/gsd/gsd-dev-preferences/SKILL.md must exist at HERMES nested location (U3+#947)');
    assert.strictEqual(fs.readFileSync(skillFile, 'utf8'), '# my hermes prefs\n');
  });
});

// ─── #768 — mergeClaudePermissions: pre-populate permissions.allow/deny ──────

describe('mergeClaudePermissions (#768): exports and permission constants', () => {
  test('mergeClaudePermissions is exported', () => {
    assert.strictEqual(typeof mergeClaudePermissions, 'function',
      'mergeClaudePermissions must be exported from bin/install.js');
  });

  test('GSD_CLAUDE_ALLOW_PERMISSIONS is a non-empty array of strings', () => {
    assert.ok(Array.isArray(GSD_CLAUDE_ALLOW_PERMISSIONS),
      'GSD_CLAUDE_ALLOW_PERMISSIONS must be an array');
    assert.ok(GSD_CLAUDE_ALLOW_PERMISSIONS.length > 0,
      'GSD_CLAUDE_ALLOW_PERMISSIONS must not be empty');
    for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
      assert.strictEqual(typeof entry, 'string', `allow entry must be a string, got: ${JSON.stringify(entry)}`);
    }
  });

  test('GSD_CLAUDE_LEGACY_DENY_PERMISSIONS lists exactly the three retired Read() deny rules (#4221)', () => {
    assert.ok(Array.isArray(GSD_CLAUDE_LEGACY_DENY_PERMISSIONS),
      'GSD_CLAUDE_LEGACY_DENY_PERMISSIONS must be an array');
    assert.deepStrictEqual(
      [...GSD_CLAUDE_LEGACY_DENY_PERMISSIONS].sort(),
      ['Read(.env)', 'Read(.env.*)', 'Read(.secrets)'].sort(),
      'the legacy deny list must be exactly the three strings #768 used to write'
    );
  });
});

describe('mergeClaudePermissions (#768): fresh settings object', () => {
  test('populates permissions.allow on empty settings and never creates permissions.deny (#4221)', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    assert.ok(Array.isArray(settings.permissions?.allow), 'permissions.allow must be an array');
    assert.strictEqual(settings.permissions.deny, undefined,
      'permissions.deny must not be created — the Read(.env*) deny rules are retired (#4221)');
    for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
      assert.ok(settings.permissions.allow.includes(entry),
        `permissions.allow must contain "${entry}"`);
    }
  });

  test('includes Bash(npx gsd-core *) in allow', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    assert.ok(settings.permissions.allow.includes('Bash(npx gsd-core *)'),
      'permissions.allow must contain Bash(npx gsd-core *)');
  });

  test('includes planning path entries in allow (#2278: Edit, not Write)', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    assert.ok(settings.permissions.allow.includes('Read(.planning/*)'),
      'permissions.allow must contain Read(.planning/*)');
    assert.ok(settings.permissions.allow.includes('Edit(.planning/*)'),
      'permissions.allow must contain Edit(.planning/*)');
    assert.ok(!settings.permissions.allow.includes('Write(.planning/*)'),
      'permissions.allow must NOT contain the unmatched Write(.planning/*) form (#2278)');
  });

  test('includes STATE.md entries in allow (#2278: Edit, not Write)', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    assert.ok(settings.permissions.allow.includes('Read(STATE.md)'),
      'permissions.allow must contain Read(STATE.md)');
    assert.ok(settings.permissions.allow.includes('Edit(STATE.md)'),
      'permissions.allow must contain Edit(STATE.md)');
    assert.ok(!settings.permissions.allow.includes('Write(STATE.md)'),
      'permissions.allow must NOT contain the unmatched Write(STATE.md) form (#2278)');
  });

  test('never adds Read(.env*) / Read(.secrets) deny rules (#4221: retired in favor of gsd-secret-read-guard.js)', () => {
    const settings = { permissions: { deny: ['WebSearch'] } };
    mergeClaudePermissions(settings);
    for (const entry of GSD_CLAUDE_LEGACY_DENY_PERMISSIONS) {
      assert.ok(!settings.permissions.deny.includes(entry),
        `permissions.deny must NOT contain the retired "${entry}"`);
    }
    assert.deepStrictEqual(settings.permissions.deny, ['WebSearch']);
  });
});

describe('mergeClaudePermissions (#768): non-destructive merge', () => {
  test('appends to existing allow/deny arrays without overwriting user entries', () => {
    const settings = {
      permissions: {
        allow: ['Bash(git *)'],
        deny: ['WebSearch'],
      },
    };
    mergeClaudePermissions(settings);
    // User entries must be preserved
    assert.ok(settings.permissions.allow.includes('Bash(git *)'),
      'existing allow entries must be preserved');
    assert.ok(settings.permissions.deny.includes('WebSearch'),
      'existing deny entries must be preserved');
    // GSD allow entries must be added; the retired deny rules must not be
    assert.ok(settings.permissions.allow.includes('Bash(npx gsd-core *)'),
      'GSD allow entry must be added');
    assert.ok(!settings.permissions.deny.includes('Read(.env)'),
      'the retired Read(.env) deny rule must not be added (#4221)');
  });

  test('does not duplicate entries on repeated calls (idempotent)', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    mergeClaudePermissions(settings);
    for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
      const count = settings.permissions.allow.filter((e) => e === entry).length;
      assert.strictEqual(count, 1, `allow entry "${entry}" must appear exactly once after two merges`);
    }
    assert.strictEqual(settings.permissions.deny, undefined,
      'permissions.deny must still be absent after two merges (#4221)');
  });

  test('preserves other permission sub-keys (ask, disableBypassPermissionsMode)', () => {
    const settings = {
      permissions: {
        ask: ['Bash'],
        disableBypassPermissionsMode: 'disable',
        allow: [],
        deny: [],
      },
    };
    mergeClaudePermissions(settings);
    assert.deepStrictEqual(settings.permissions.ask, ['Bash'],
      'permissions.ask must be preserved');
    assert.strictEqual(settings.permissions.disableBypassPermissionsMode, 'disable',
      'permissions.disableBypassPermissionsMode must be preserved');
  });

  test('handles permissions with non-array allow/deny gracefully (replaces with array)', () => {
    // If allow/deny exist but are not arrays (malformed settings), must not crash
    // and must result in valid arrays.
    const settings = { permissions: { allow: null, deny: null } };
    mergeClaudePermissions(settings);
    assert.ok(Array.isArray(settings.permissions.allow));
    assert.ok(Array.isArray(settings.permissions.deny));
    assert.ok(settings.permissions.allow.includes('Bash(npx gsd-core *)'));
  });

  test('handles settings that are not plain objects (returns unchanged)', () => {
    // Guard: if settings is not a plain object, do nothing
    const badInputs = [null, undefined, [], 'string', 42];
    for (const bad of badInputs) {
      // Must not throw
      assert.doesNotThrow(() => mergeClaudePermissions(bad),
        `mergeClaudePermissions must not throw on: ${JSON.stringify(bad)}`);
    }
  });
});

// ─── #2278 — Claude Code has no standalone `Write` permission gate; the
// pre-populated allow-rules must use `Edit(pattern)`, and a merge against an
// existing install must retire the stale unmatched `Write(...)` forms.
describe('mergeClaudePermissions (#2278): legacy Write(...) → Edit(...) migration', () => {
  test('GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS is exported and lists the stale Write(...) forms', () => {
    assert.ok(Array.isArray(GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS),
      'GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS must be an array');
    assert.deepStrictEqual(
      [...GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS].sort(),
      ['Write(.planning/*)', 'Write(STATE.md)'].sort(),
      'GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS must contain exactly the retired Write(...) forms'
    );
  });

  test('fresh/empty settings: allow ends with Edit(...) forms, never Write(...)', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    assert.ok(settings.permissions.allow.includes('Edit(.planning/*)'),
      'fresh merge must add Edit(.planning/*)');
    assert.ok(settings.permissions.allow.includes('Edit(STATE.md)'),
      'fresh merge must add Edit(STATE.md)');
    assert.ok(!settings.permissions.allow.includes('Write(.planning/*)'),
      'fresh merge must never add Write(.planning/*)');
    assert.ok(!settings.permissions.allow.includes('Write(STATE.md)'),
      'fresh merge must never add Write(STATE.md)');
  });

  test('existing install with legacy Write(...) entries: migrated to Edit(...), user entries untouched', () => {
    const settings = {
      permissions: {
        allow: ['Write(.planning/*)', 'Write(STATE.md)', 'Bash(git *)'],
        deny: ['WebSearch'],
      },
    };
    mergeClaudePermissions(settings);

    // Stale legacy forms must be gone.
    assert.ok(!settings.permissions.allow.includes('Write(.planning/*)'),
      'legacy Write(.planning/*) must be removed by merge');
    assert.ok(!settings.permissions.allow.includes('Write(STATE.md)'),
      'legacy Write(STATE.md) must be removed by merge');

    // Replaced by the working Edit(...) forms.
    assert.ok(settings.permissions.allow.includes('Edit(.planning/*)'),
      'Edit(.planning/*) must be present after migration');
    assert.ok(settings.permissions.allow.includes('Edit(STATE.md)'),
      'Edit(STATE.md) must be present after migration');

    // Unrelated user-added entries must survive untouched.
    assert.ok(settings.permissions.allow.includes('Bash(git *)'),
      'unrelated user allow entry must survive migration');
    assert.ok(settings.permissions.deny.includes('WebSearch'),
      'unrelated user deny entry must survive migration');
  });

  test('mixed state: settings.allow containing BOTH legacy and current forms simultaneously collapses to exactly one Edit(...) each', () => {
    const settings = {
      permissions: {
        allow: ['Write(.planning/*)', 'Edit(.planning/*)', 'Write(STATE.md)', 'Edit(STATE.md)', 'Bash(git *)'],
        deny: [],
      },
    };
    mergeClaudePermissions(settings);

    // Legacy forms must be gone.
    assert.ok(!settings.permissions.allow.includes('Write(.planning/*)'),
      'legacy Write(.planning/*) must be removed even when Edit(.planning/*) was already present');
    assert.ok(!settings.permissions.allow.includes('Write(STATE.md)'),
      'legacy Write(STATE.md) must be removed even when Edit(STATE.md) was already present');

    // Current forms must appear exactly once (no duplicate from the pre-existing entry).
    assert.strictEqual(
      settings.permissions.allow.filter((e) => e === 'Edit(.planning/*)').length,
      1,
      'Edit(.planning/*) must appear exactly once, not duplicated'
    );
    assert.strictEqual(
      settings.permissions.allow.filter((e) => e === 'Edit(STATE.md)').length,
      1,
      'Edit(STATE.md) must appear exactly once, not duplicated'
    );

    // Unrelated user entry must survive.
    assert.ok(settings.permissions.allow.includes('Bash(git *)'),
      'unrelated user allow entry must survive the mixed-state migration');
  });

  test('idempotent: repeated merge produces no dupes and never re-adds legacy entries', () => {
    const settings = {
      permissions: {
        allow: ['Write(.planning/*)', 'Write(STATE.md)'],
        deny: [],
      },
    };
    mergeClaudePermissions(settings);
    mergeClaudePermissions(settings);
    mergeClaudePermissions(settings);

    for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
      const count = settings.permissions.allow.filter((e) => e === entry).length;
      assert.strictEqual(count, 1, `allow entry "${entry}" must appear exactly once after repeated merges`);
    }
    for (const legacy of GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS) {
      assert.ok(!settings.permissions.allow.includes(legacy),
        `legacy entry "${legacy}" must never reappear after repeated merges`);
    }
  });
});

// ─── #4221 — the Read(.env*) / Read(.secrets) deny rules are retired in favor
// of the managed gsd-secret-read-guard.js hook. A merge against an existing
// install must remove exactly the retired strings and leave no `deny: []`.
describe('mergeClaudePermissions (#4221): legacy Read(.env*) deny-rule retirement', () => {
  test('existing install with the three retired rules + a user entry: retired rules removed, user entry kept', () => {
    const settings = {
      permissions: {
        allow: ['Bash(git *)'],
        deny: ['Read(.env)', 'Read(.env.*)', 'Read(.secrets)', 'WebSearch'],
      },
    };
    mergeClaudePermissions(settings);
    assert.deepStrictEqual(settings.permissions.deny, ['WebSearch']);
    assert.ok(settings.permissions.allow.includes('Bash(git *)'));
  });

  test('a partial set of retired rules is removed', () => {
    const settings = { permissions: { deny: ['WebSearch', 'Read(.env.*)'] } };
    mergeClaudePermissions(settings);
    assert.deepStrictEqual(settings.permissions.deny, ['WebSearch']);
  });

  test('near-miss user strings are not byte-equal and survive', () => {
    const settings = { permissions: { deny: ['Read(./.env)', 'Read(.env) ', 'read(.env)', 'Read(.env.*.bak)'] } };
    mergeClaudePermissions(settings);
    assert.deepStrictEqual(settings.permissions.deny, ['Read(./.env)', 'Read(.env) ', 'read(.env)', 'Read(.env.*.bak)']);
  });

  test('idempotent across repeated merges', () => {
    const settings = { permissions: { deny: ['Read(.env)', 'WebSearch'] } };
    mergeClaudePermissions(settings);
    mergeClaudePermissions(settings);
    assert.deepStrictEqual(settings.permissions.deny, ['WebSearch']);
  });

  test('a GSD-only deny array is deleted, not left as an empty array', () => {
    const settings = { permissions: { deny: ['Read(.env)', 'Read(.env.*)', 'Read(.secrets)'] } };
    mergeClaudePermissions(settings);
    assert.strictEqual(settings.permissions.deny, undefined,
      'a deny array emptied by the retirement filter must be removed (no `"deny": []` residue)');
    assert.ok(Array.isArray(settings.permissions.allow), 'allow is still populated');
  });

  test('a pre-existing empty deny array the user wrote is preserved untouched', () => {
    const settings = { permissions: { deny: [] } };
    mergeClaudePermissions(settings);
    assert.deepStrictEqual(settings.permissions.deny, []);
  });

  test('a malformed non-array deny is still repaired to an empty array', () => {
    const settings = { permissions: { deny: 'Read(.env)' } };
    mergeClaudePermissions(settings);
    assert.deepStrictEqual(settings.permissions.deny, []);
  });

  test('uninstall: GSD-only allow + deny leaves no permissions key at all', (t) => {
    const root = createTempDir('gsd-claude-perm-uninstall-4221-');
    t.after(() => cleanup(root));
    const runOpts = { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS };

    const r1 = runNode([INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root], runOpts);
    assert.strictEqual(r1.exitCode, 0, `install failed: ${r1.stderr}`);

    const settingsPath = path.join(root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.permissions.deny = ['Read(.env)', 'Read(.env.*)', 'Read(.secrets)'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    const r2 = runNode([INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root, '--uninstall'], runOpts);
    assert.strictEqual(r2.exitCode, 0, `uninstall failed: ${r2.stderr}`);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(after.permissions, undefined,
      'with only GSD-owned allow and deny entries, uninstall must remove the whole permissions key');
  });

  test('uninstall: a foreign allow entry keeps permissions.allow while the emptied deny key goes', (t) => {
    const root = createTempDir('gsd-claude-perm-uninstall-4221-foreign-');
    t.after(() => cleanup(root));
    const runOpts = { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS };

    const r1 = runNode([INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root], runOpts);
    assert.strictEqual(r1.exitCode, 0, `install failed: ${r1.stderr}`);

    const settingsPath = path.join(root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.permissions.allow.push('Bash(git *)');
    settings.permissions.deny = ['Read(.env)', 'Read(.env.*)', 'Read(.secrets)'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    const r2 = runNode([INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root, '--uninstall'], runOpts);
    assert.strictEqual(r2.exitCode, 0, `uninstall failed: ${r2.stderr}`);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepStrictEqual(after.permissions.allow, ['Bash(git *)']);
    assert.strictEqual(after.permissions.deny, undefined, 'emptied deny key must be removed');
  });
});

describe('mergeClaudePermissions (#768): end-to-end install writes permissions to settings.json', () => {
  test('--claude --global install writes GSD allow/deny entries to settings.json', (t) => {
    const root = createTempDir('gsd-claude-perm-install-');
    t.after(() => cleanup(root));

    const result = runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root],
      { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS },
    );

    assert.strictEqual(result.exitCode, 0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);

    const settingsPath = path.join(root, 'settings.json');
    assert.ok(fs.existsSync(settingsPath), 'settings.json must exist after claude install');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(settings.permissions?.allow),
      'settings.json must have permissions.allow array');
    assert.strictEqual(settings.permissions.deny, undefined,
      'a fresh install must not write permissions.deny at all (#4221)');

    assert.ok(settings.permissions.allow.includes('Bash(npx gsd-core *)'),
      'settings.json permissions.allow must include Bash(npx gsd-core *)');
    assert.ok(settings.permissions.allow.includes('Read(.planning/*)'),
      'settings.json permissions.allow must include Read(.planning/*)');
  });

  test('non-claude runtime (antigravity) does NOT write GSD allow/deny permissions to settings.json', (t) => {
    const root = createTempDir('gsd-antigravity-perm-install-');
    t.after(() => cleanup(root));

    const result = runNode(
      [INSTALL_SCRIPT, '--antigravity', '--global', '--config-dir', root],
      { env: { ...process.env, HOME: root, USERPROFILE: root }, timeoutMs: INSTALL_TIMEOUT_MS },
    );

    assert.strictEqual(result.exitCode, 0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);

    const settingsPath = path.join(root, 'settings.json');
    // If settings.json doesn't exist, permissions are definitely not written — pass.
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const allow = settings.permissions?.allow ?? [];
      assert.ok(!allow.includes('Bash(npx gsd-core *)'),
        'Antigravity settings.json must NOT include Bash(npx gsd-core *) in permissions.allow');
    }
  });

  test('--claude --global reinstall is idempotent (no duplicate permission entries)', (t) => {
    const root = createTempDir('gsd-claude-perm-idempotent-');
    t.after(() => cleanup(root));

    const runOpts = {
      env: { ...process.env, HOME: root, USERPROFILE: root },
      timeoutMs: INSTALL_TIMEOUT_MS,
    };
    const args = [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root];

    // First install
    const r1 = runNode(args, runOpts);
    assert.strictEqual(r1.exitCode, 0, `first install failed: ${r1.stderr}`);

    // Second install (reinstall)
    const r2 = runNode(args, runOpts);
    assert.strictEqual(r2.exitCode, 0, `reinstall failed: ${r2.stderr}`);

    const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
    for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
      const count = (settings.permissions?.allow ?? []).filter((e) => e === entry).length;
      assert.strictEqual(count, 1,
        `allow entry "${entry}" must appear exactly once after two installs`);
    }
    assert.strictEqual(settings.permissions?.deny, undefined,
      'permissions.deny must still be absent after two installs (#4221)');
  });

  test('--claude --global uninstall removes GSD permission entries from settings.json', (t) => {
    const root = createTempDir('gsd-claude-perm-uninstall-');
    t.after(() => cleanup(root));

    const runOpts = {
      env: { ...process.env, HOME: root, USERPROFILE: root },
      timeoutMs: INSTALL_TIMEOUT_MS,
    };

    // Install first
    const r1 = runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root],
      runOpts,
    );
    assert.strictEqual(r1.exitCode, 0, `install failed: ${r1.stderr}`);

    // Verify permissions were written
    const settingsPath = path.join(root, 'settings.json');
    const afterInstall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok((afterInstall.permissions?.allow ?? []).includes('Bash(npx gsd-core *)'),
      'permissions.allow must contain GSD entry after install');

    // Now add a user permission to make sure we don't nuke it, and simulate
    // a pre-#4221 install that still carries the retired deny rules.
    afterInstall.permissions.allow.push('Bash(git *)');
    afterInstall.permissions.deny = ['Read(.env)', 'Read(.env.*)', 'Read(.secrets)', 'WebSearch'];
    fs.writeFileSync(settingsPath, JSON.stringify(afterInstall, null, 2) + '\n');

    // Uninstall
    const r2 = runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root, '--uninstall'],
      runOpts,
    );
    assert.strictEqual(r2.exitCode, 0, `uninstall failed: ${r2.stderr}`);

    const afterUninstall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allow = afterUninstall.permissions?.allow ?? [];
    const deny = afterUninstall.permissions?.deny ?? [];

    // GSD entries must be removed
    assert.ok(!allow.includes('Bash(npx gsd-core *)'),
      'GSD Bash allow entry must be removed by uninstall');
    assert.ok(!allow.includes('Read(.planning/*)'),
      'GSD Read(.planning/*) allow entry must be removed by uninstall');
    for (const entry of GSD_CLAUDE_LEGACY_DENY_PERMISSIONS) {
      assert.ok(!deny.includes(entry),
        `retired GSD deny entry "${entry}" must be removed by uninstall (#4221)`);
    }

    // User entries must survive
    assert.ok(allow.includes('Bash(git *)'),
      'user Bash(git *) allow entry must survive uninstall');
    assert.deepStrictEqual(afterUninstall.permissions.deny, ['WebSearch'],
      'user WebSearch deny entry must survive uninstall');
  });

  test('#2278: uninstall removes GSD entries in both legacy Write(...) and current Edit(...) form', (t) => {
    const root = createTempDir('gsd-claude-perm-uninstall-legacy-');
    t.after(() => cleanup(root));

    const runOpts = {
      env: { ...process.env, HOME: root, USERPROFILE: root },
      timeoutMs: INSTALL_TIMEOUT_MS,
    };

    // Install first (writes the current Edit(...) forms).
    const r1 = runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root],
      runOpts,
    );
    assert.strictEqual(r1.exitCode, 0, `install failed: ${r1.stderr}`);

    // Simulate a pre-fix install that still carries the stale Write(...)
    // forms alongside the current Edit(...) forms and a user entry.
    const settingsPath = path.join(root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.permissions.allow.push('Write(.planning/*)', 'Write(STATE.md)', 'Bash(git *)');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    // Uninstall
    const r2 = runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root, '--uninstall'],
      runOpts,
    );
    assert.strictEqual(r2.exitCode, 0, `uninstall failed: ${r2.stderr}`);

    const afterUninstall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allow = afterUninstall.permissions?.allow ?? [];

    // Both legacy and current GSD-owned forms must be removed.
    assert.ok(!allow.includes('Write(.planning/*)'),
      'legacy Write(.planning/*) entry must be removed by uninstall');
    assert.ok(!allow.includes('Write(STATE.md)'),
      'legacy Write(STATE.md) entry must be removed by uninstall');
    assert.ok(!allow.includes('Edit(.planning/*)'),
      'current Edit(.planning/*) entry must be removed by uninstall');
    assert.ok(!allow.includes('Edit(STATE.md)'),
      'current Edit(STATE.md) entry must be removed by uninstall');

    // User entry must survive.
    assert.ok(allow.includes('Bash(git *)'),
      'user Bash(git *) allow entry must survive uninstall');
  });
});

// ─── #976 — args-form hook presence detection ─────────────────────────────────
//
// Claude Code hooks support a command+args form (executable in `command`,
// script path in `args[]`) used by windowless-launcher wrappers on Windows.
// Pre-fix, hasGsdUpdateHook (and sibling checks) only inspected h.command,
// so an args-form entry was invisible and a stock string-command entry was
// appended on every install/update, running the hook twice.

describe('#976 regression: installer does not duplicate managed hooks when registered in command+args form', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-976-args-form-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    assert.strictEqual(typeof install, 'function',
      'install must be exported from bin/install.js');
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('does not add a second SessionStart entry when gsd-check-update is already in args-form', () => {
    const targetDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(targetDir, { recursive: true });

    // Pass 1: run install with no pre-existing settings to create the
    // gsd-file-manifest.json that the installer migration uses to decide
    // whether a hook file is managed (kept) or foreign (removed).
    // Without a manifest, the installer migration removes any hook stubs we
    // place in hooks/ as "unrecognized GSD-looking files", which would make
    // fs.existsSync(checkUpdateFile) return false and skip duplicate-adding.
    install(false, 'claude');

    // Now stub the hook files so fs.existsSync guards pass on pass 2.
    // At this point the manifest exists, so migration classifies the stubs as
    // manifest-managed and leaves them alone.
    stubHooksIntoDir(targetDir, ['gsd-check-update.js']);

    // Local Claude installs read/write settings.local.json (not settings.json).
    // Overwrite settings.local.json with the hook in command+args form
    // (wrapped launcher). The GSD hook filename appears in args[], not in command.
    const launcherCommand = '/usr/local/bin/node-launcher';
    const hookPath = path.join(targetDir, 'hooks', 'gsd-check-update.js');
    const preExistingSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: launcherCommand,
                args: [hookPath],
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(targetDir, 'settings.local.json'),
      JSON.stringify(preExistingSettings, null, 2) + '\n',
    );

    // Pass 2: run install again — the pre-existing args-form entry must
    // suppress the duplicate stock string-command registration.
    const result = install(false, 'claude');
    const settings = result && result.settings;

    assert.ok(settings && settings.hooks && Array.isArray(settings.hooks.SessionStart),
      'settings.hooks.SessionStart must be an array after install');

    // Count all hook entries (at any nesting level) that reference gsd-check-update.
    const allEntries = settings.hooks.SessionStart.flatMap(entry =>
      Array.isArray(entry && entry.hooks) ? entry.hooks : []
    );
    const matching = allEntries.filter(h =>
      (typeof h.command === 'string' && h.command.includes('gsd-check-update')) ||
      (Array.isArray(h.args) && h.args.some(a => typeof a === 'string' && a.includes('gsd-check-update')))
    );

    assert.strictEqual(
      matching.length,
      1,
      [
        'Expected exactly 1 hook entry referencing gsd-check-update after install,',
        `got ${matching.length}.`,
        'The installer added a duplicate because it could not detect the args-form registration.',
        `All matching entries: ${JSON.stringify(matching)}`,
      ].join(' '),
    );
  });

  test('rewriteLegacyManagedNodeHookCommands leaves args-form launcher entries unchanged', () => {
    assert.strictEqual(typeof rewriteLegacyManagedNodeHookCommands, 'function',
      'rewriteLegacyManagedNodeHookCommands must be exported from runtime-hooks-surface.cjs');

    const launcherCommand = '/usr/local/bin/node-launcher';
    const hookPath = '/Users/user/.claude/hooks/gsd-check-update.js';
    const settings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: launcherCommand,
                args: [hookPath],
              },
            ],
          },
        ],
      },
    };

    const runner = resolveNodeRunner() || '/usr/local/bin/node';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: process.platform });

    // The args-form launcher entry must NOT be rewritten — it is an intentional
    // user wrapper and the script path lives in args[], not command.
    assert.strictEqual(changed, false,
      'rewriteLegacyManagedNodeHookCommands must not rewrite args-form entries (#976)');
    assert.strictEqual(
      settings.hooks.SessionStart[0].hooks[0].command,
      launcherCommand,
      'args-form command must remain unchanged after rewrite pass',
    );
    assert.deepStrictEqual(
      settings.hooks.SessionStart[0].hooks[0].args,
      [hookPath],
      'args-form args must remain unchanged after rewrite pass',
    );
  });
});

// ─── #1004 — http-form hook presence detection ────────────────────────────────
//
// Claude Code hooks support a type:"http" form where the hook identity lives
// in h.url (no command, no args).  Pre-fix, referencesHook() only inspected
// h.command and h.args, so an http-form entry was invisible and a stock
// string-command entry was appended on every install, running the hook twice.
// This is the same duplicate-append failure as #976 (args-form), one shape further.

describe('#1004 regression: installer does not duplicate managed hooks when registered in http form', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-1004-http-form-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    assert.strictEqual(typeof install, 'function',
      'install must be exported from bin/install.js');
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('does not add a second SessionStart entry when gsd-check-update is already in http form', () => {
    const targetDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(targetDir, { recursive: true });

    // Pass 1: run install with no pre-existing settings to create the
    // gsd-file-manifest.json that the installer migration uses to decide
    // whether a hook file is managed (kept) or foreign (removed).
    // Without a manifest, migration removes any hook stubs as "unrecognized
    // GSD-looking files", making fs.existsSync(checkUpdateFile) return false
    // and skipping the duplicate-adding path.
    install(false, 'claude');

    // Now stub the hook files so fs.existsSync guards pass on pass 2.
    // The manifest now exists, so migration classifies the stubs as
    // manifest-managed and leaves them alone.
    stubHooksIntoDir(targetDir, ['gsd-check-update.js']);

    // Local Claude installs read/write settings.local.json (not settings.json).
    // Overwrite settings.local.json with the hook in http form.
    // The GSD hook name appears only in h.url — no command, no args.
    const hookUrl = 'http://127.0.0.1:18923/hooks/gsd-check-update';
    const preExistingSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'http',
                url: hookUrl,
                timeout: 5,
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(targetDir, 'settings.local.json'),
      JSON.stringify(preExistingSettings, null, 2) + '\n',
    );

    // Pass 2: run install again — the pre-existing http-form entry must
    // suppress the duplicate stock string-command registration.
    const result = install(false, 'claude');
    const settings = result && result.settings;

    assert.ok(settings && settings.hooks && Array.isArray(settings.hooks.SessionStart),
      'settings.hooks.SessionStart must be an array after install');

    // Count all hook entries (at any nesting level) that reference gsd-check-update,
    // including the url arm so http-form entries are visible.
    const allEntries = settings.hooks.SessionStart.flatMap(entry =>
      Array.isArray(entry && entry.hooks) ? entry.hooks : []
    );
    const matching = allEntries.filter(h =>
      (typeof h.command === 'string' && h.command.includes('gsd-check-update')) ||
      (Array.isArray(h.args) && h.args.some(a => typeof a === 'string' && a.includes('gsd-check-update'))) ||
      (typeof h.url === 'string' && h.url.includes('gsd-check-update'))
    );

    assert.strictEqual(
      matching.length,
      1,
      [
        'Expected exactly 1 hook entry referencing gsd-check-update after install,',
        `got ${matching.length}.`,
        'The installer added a duplicate because it could not detect the http-form registration.',
        'referencesHook() must check h.url in addition to h.command and h.args. (#1004)',
        `All matching entries: ${JSON.stringify(matching)}`,
      ].join(' '),
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1924-preserve-user-artifacts.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1924-preserve-user-artifacts (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #1924)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for bug #1924: gsd-update silently deletes user-generated files
 *
 * Running the installer (gsd-update / re-install) must not delete:
 *   - gsd-core/USER-PROFILE.md  (created by /gsd-profile-user)
 *   - commands/gsd/dev-preferences.md  (created by /gsd-profile-user)
 *
 * Root cause:
 *   1. copyWithPathReplacement() calls fs.rmSync(destDir, {recursive:true}) before
 *      copying — no preserve allowlist. This wipes USER-PROFILE.md.
 *   2. ~line 5211 explicitly rmSync's commands/gsd/ during global install legacy
 *      cleanup — no preserve. This wipes dev-preferences.md.
 *
 * Fix requirement:
 *   - install() must preserve USER-PROFILE.md across the gsd-core/ wipe
 *   - install() must preserve dev-preferences.md across the commands/gsd/ wipe
 *
 * Closes: #1924
 */

'use strict';

const { describe, test, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// ─── Ensure hooks/dist/ is populated before any install test ─────────────────

before(() => {
  throwIfFailed(
    runNode([BUILD_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
    `node ${BUILD_SCRIPT}`,
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup() helper wrapping rmSync; cannot use imported cleanup() without naming collision
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Run the installer with CLAUDE_CONFIG_DIR redirected to a temp directory.
 * Explicitly removes GSD_TEST_MODE so the subprocess actually runs the installer
 * (not just the export block). Uses --yes to suppress interactive prompts.
 */
function runInstaller(configDir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.GSD_TEST_MODE;
  // --no-sdk: this test covers user-artifact preservation only; skip SDK
  // build (covered by install-smoke.yml) to keep the test deterministic.
  throwIfFailed(
    runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'],
      { env, timeoutMs: INSTALL_TIMEOUT_MS },
    ),
    `node ${INSTALL_SCRIPT} --claude --global --yes --no-sdk`,
  );
}

// ─── Test 1: USER-PROFILE.md is preserved across re-install ─────────────────

describe('#1924: USER-PROFILE.md preserved across re-install (global Claude)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-1924-userprofile-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('USER-PROFILE.md exists after initial install + user creation', () => {
    runInstaller(tmpDir);

    // Simulate /gsd-profile-user creating USER-PROFILE.md inside gsd-core/
    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# My Profile\n\nCustom user content.\n');

    assert.ok(
      fs.existsSync(profilePath),
      'USER-PROFILE.md should exist after being created by /gsd-profile-user'
    );
  });

  test('USER-PROFILE.md is preserved after re-install', () => {
    // First install
    runInstaller(tmpDir);

    // User runs /gsd-profile-user, creating USER-PROFILE.md
    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    const originalContent = '# My Profile\n\nThis is my custom user profile content.\n';
    fs.writeFileSync(profilePath, originalContent);

    // Re-run installer (simulating gsd-update)
    runInstaller(tmpDir);

    assert.ok(
      fs.existsSync(profilePath),
      'USER-PROFILE.md must survive re-install — gsd-update must not delete user-generated profiles'
    );

    const afterContent = fs.readFileSync(profilePath, 'utf8');
    assert.strictEqual(
      afterContent,
      originalContent,
      'USER-PROFILE.md content must be identical after re-install'
    );
  });

  test('USER-PROFILE.md is preserved even when gsd-core/ is wiped and recreated', () => {
    runInstaller(tmpDir);

    const gsdDir = path.join(tmpDir, 'gsd-core');
    const profilePath = path.join(gsdDir, 'USER-PROFILE.md');

    // Confirm gsd-core/ was created by install
    assert.ok(fs.existsSync(gsdDir), 'gsd-core/ must exist after install');

    // Write profile
    fs.writeFileSync(profilePath, '# Profile\n\nMy coding style preferences.\n');

    // Re-install
    runInstaller(tmpDir);

    // gsd-core/ must still exist AND profile must be intact
    assert.ok(fs.existsSync(gsdDir), 'gsd-core/ must still exist after re-install');
    assert.ok(
      fs.existsSync(profilePath),
      'USER-PROFILE.md must still exist after gsd-core/ was wiped and recreated'
    );
  });
});

// ─── Test 2: dev-preferences.md is preserved across re-install ───────────────

describe('#1924: dev-preferences.md preserved across re-install (global Claude)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-1924-devprefs-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('dev-preferences.md is preserved when commands/gsd/ is cleaned up during re-install', () => {
    // First install (creates skills/ structure for global Claude)
    runInstaller(tmpDir);

    // User runs /gsd-profile-user — it creates dev-preferences.md in commands/gsd/
    const commandsGsdDir = path.join(tmpDir, 'commands', 'gsd');
    fs.mkdirSync(commandsGsdDir, { recursive: true });
    const devPrefsPath = path.join(commandsGsdDir, 'dev-preferences.md');
    const originalContent = '# Dev Preferences\n\nI prefer TDD. I like short functions.\n';
    fs.writeFileSync(devPrefsPath, originalContent);

    // Re-run installer (simulating gsd-update).
    // In the layout-driven path (B2), legacy commands/gsd/ is removed and
    // dev-preferences.md is migrated to skills/gsd-dev-preferences/SKILL.md (#2973).
    runInstaller(tmpDir);

    // Content is migrated to the new canonical skills location (#2973).
    // The old commands/gsd/ path is cleaned up; the skill file carries the content.
    const devPrefSkillPath = path.join(tmpDir, 'skills', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(
      fs.existsSync(devPrefSkillPath),
      'dev-preferences.md must be migrated to skills/gsd-dev-preferences/SKILL.md — gsd-update legacy cleanup must not silently drop user-generated content'
    );

    const afterContent = fs.readFileSync(devPrefSkillPath, 'utf8');
    assert.strictEqual(
      afterContent,
      originalContent,
      'migrated dev-preferences content must be identical to the original'
    );
  });

  test('legacy non-user GSD commands are still cleaned up during re-install', () => {
    // First install
    runInstaller(tmpDir);

    // Simulate a legacy GSD command file being left in commands/gsd/
    const commandsGsdDir = path.join(tmpDir, 'commands', 'gsd');
    fs.mkdirSync(commandsGsdDir, { recursive: true });
    const legacyFile = path.join(commandsGsdDir, 'next.md');
    fs.writeFileSync(legacyFile, '---\nname: gsd:next\n---\n\nLegacy content.');

    // But dev-preferences.md is also there (user-generated)
    const devPrefsContent = '# Dev Preferences\n\nMy preferences.\n';
    const devPrefsPath = path.join(commandsGsdDir, 'dev-preferences.md');
    fs.writeFileSync(devPrefsPath, devPrefsContent);

    // Re-install
    runInstaller(tmpDir);

    // In the layout-driven path (B2), commands/gsd/ is fully removed but
    // dev-preferences.md content is migrated to the new canonical skill location.
    const devPrefSkillPath = path.join(tmpDir, 'skills', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(
      fs.existsSync(devPrefSkillPath),
      'dev-preferences.md content must be migrated to skills/gsd-dev-preferences/SKILL.md'
    );

    // The legacy GSD command (next.md) is NOT user-generated, must be removed
    // (it would exist only as a skill now in skills/gsd-next/SKILL.md)
    assert.ok(
      !fs.existsSync(legacyFile),
      'legacy GSD command next.md in commands/gsd/ must be removed during cleanup'
    );
  });
});

// ─── Test 3: profile-user.md backup path is outside gsd-core/ ───────────

describe('#1924: profile-user.md backup path must be outside gsd-core/', () => {
  test('profile-user.md backup uses ~/.claude/USER-PROFILE.backup.md not ~/.claude/gsd-core/USER-PROFILE.backup.md', () => {
    const workflowPath = path.join(
      __dirname, '..', 'gsd-core', 'workflows', 'profile-user.md'
    );
    const content = fs.readFileSync(workflowPath, 'utf8');

    // The backup must NOT be inside gsd-core/ because that directory is wiped on update
    assert.ok(
      !content.includes('gsd-core/USER-PROFILE.backup.md'),
      'backup path must NOT be inside gsd-core/ — that directory is wiped on gsd-update'
    );

    // The backup should be at ~/.claude/USER-PROFILE.backup.md (outside gsd-core/)
    assert.ok(
      content.includes('USER-PROFILE.backup.md') &&
      !content.includes('/gsd-core/USER-PROFILE.backup.md'),
      'backup path must be outside gsd-core/ (e.g. ~/.claude/USER-PROFILE.backup.md)'
    );
  });
});

// ─── Test 4: user artifacts survive a wipe via the durable staging path ──────
//
// preserveUserArtifacts/restoreUserArtifacts (an in-memory Map, the #1924
// fix's original mechanism) were retired by #2875 — nothing calls them any
// more, so a `typeof preserveUserArtifacts === 'function'` assertion would
// guard a function that never runs: vacuous. #1924's actual point was never
// "this specific helper is exported" — it was "user artifacts survive a
// reinstall wipe". This asserts that SAME property through the durable
// on-disk staging path that replaced the in-memory one, including surviving
// a crash BETWEEN the wipe and the restore (#1874-F19) — a stronger
// guarantee than the retired helper ever gave, and one a plain in-process
// round-trip would not prove.

describe('#1924: user artifacts survive a wipe via the durable staging path (user-artifact-staging.cjs exports)', () => {
  test('user-artifact-staging.cjs exports the staging primitives, and content staged through them survives a destDir wipe + crash', (t) => {
    const mod = require('../gsd-core/bin/lib/user-artifact-staging.cjs');

    for (const name of ['stageUserArtifacts', 'restoreStagedUserArtifacts', 'discardStagedUserArtifacts', 'recoverOrphanedUserArtifacts']) {
      assert.strictEqual(
        typeof mod[name],
        'function',
        `user-artifact-staging.cjs must export ${name} — the mechanism that now makes the #1924 durability property testable`,
      );
    }

    // user-artifact-staging.cts's recoverOrphanedUserArtifacts re-confines the
    // record's destDir against configDir (module doc "Confinement"/E2) before
    // recovering anything: `path.relative(configHome, record.destDir)` must
    // resolve to a path that never leaves configHome, exactly matching every
    // real call site (bin/install.js always stages/recovers a destDir that is
    // a SUBDIRECTORY of configDir). destDir must therefore live under
    // configDir here too — two unrelated sibling temp dirs (the smoke script's
    // shortcut) trip E2's outside-confinement refusal and recovered stays
    // empty, which is what silently diverged the smoke check from this suite.
    //
    // Second, separate divergence: the owner-liveness guard
    // (recoverOrphanedUserArtifacts) skips an entry entirely, reason
    // 'owner-still-live', whenever the record's `runId` names a currently-
    // alive process — and `stageUserArtifacts` defaults `runId` to
    // `String(process.pid)`, i.e. THIS test process, which is alive for the
    // whole in-process round trip. A real crashed run has a genuinely DEAD
    // pid; simulate that explicitly (same convention
    // tests/user-artifact-staging.test.cjs's C15 uses) or recovery always
    // reports this as "not an orphan yet" and never restores anything.
    const configDir = createTempDir('gsd-1924-staging-cfg-');
    const destDir = path.join(configDir, 'skills');
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const content = '# My Profile\n\nSurvives via durable staging (#2875).\n';
      fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), content);
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      const deadPid = '999999';
      mod.stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot, { runId: deadPid });

      // Simulate the #1874-F19 crash window: the wipe ran, the process died
      // before any restore. #2875 AC: inject via genuine `fs`-method
      // monkeypatching (CLAUDE.md §4 / the established idiom in
      // planning-lock-mkdir-failure-1884.test.cjs) rather than deleting
      // destDir out-of-band — `t.mock.method` auto-restores the original
      // after this test (no manual try/finally; CONTRIBUTING.md bans
      // try/finally in test bodies), and the mock delegates to the captured
      // original so destDir genuinely vanishes exactly as production's own
      // `fs.rmSync(destDir, {recursive:true})` would — the injected crash
      // boundary is "execution never proceeds past this call to any
      // restore", not a thrown error from the wipe itself. The actual
      // removal is driven through `helpers.cleanup()` (never a raw
      // `fs.rmSync` in a test body — `local/no-raw-rmsync-in-tests`), which
      // reads the SAME mutated `fs.rmSync` property (module singleton), so
      // the mock still observes and performs the wipe.
      const realRmSync = fs.rmSync;
      t.mock.method(fs, 'rmSync', (targetPath, opts) => realRmSync.call(fs, targetPath, opts));
      cleanup(destDir);
      assert.ok(!fs.existsSync(path.join(destDir, 'USER-PROFILE.md')));

      // Recovery — not an ordinary restore call — is what must bring it
      // back, proving the property survives a crash, not merely an
      // in-process round-trip.
      const result = mod.recoverOrphanedUserArtifacts(stagingRoot, configDir);
      assert.strictEqual(result.recovered.length, 1);
      assert.strictEqual(
        fs.readFileSync(path.join(destDir, 'USER-PROFILE.md'), 'utf8'),
        content,
        'user artifact content must survive the wipe, byte-identical, via the durable staging path',
      );
    } finally {
      cleanup(destDir);
      cleanup(configDir);
    }
  });
});
  });
}

// ─── #3333 — copyWithPathReplacement TOCTOU: source vanishes mid-copy ────────
//
// copyWithPathReplacement enumerates srcDir via readdirSync, then later reads
// (or copies) each listed entry. A filesystem is not transactional: the file
// readdirSync named can be deleted by a concurrent process before the loop
// reaches it, throwing an unhandled ENOENT and crashing the whole install.
// This is not hypothetical — tests/planning-prompt-drift.test.cjs writes a
// throwaway fixture directly into the real, shared gsd-core/workflows/ and
// deletes it in t.after(); a concurrently-running install path that lists
// that directory can observe the fixture in its readdirSync snapshot but hit
// ENOENT reading it once the writer's cleanup fires. Confirmed crash from a
// real remote gsd-test run:
//   Error: ENOENT: no such file or directory, open
//   '/work/gsd-core/workflows/zzz-e5-drift-fixture.md'
//       at Object.readFileSync (node:fs:441:20)
//       at copyWithPathReplacement (/work/bin/install.js:7888:24)

describe('#3333 regression: copyWithPathReplacement tolerates a source file vanishing mid-copy (TOCTOU)', () => {
  test('a .md file deleted between readdirSync and read is skipped, siblings still copied, no crash', (t) => {
    assert.strictEqual(typeof copyWithPathReplacement, 'function',
      'copyWithPathReplacement must be exported from bin/install.js');

    const srcDir = createTempDir('gsd-3333-src-');
    const destRoot = createTempDir('gsd-3333-dest-');
    t.after(() => {
      cleanup(srcDir);
      cleanup(destRoot);
    });

    fs.writeFileSync(path.join(srcDir, 'alpha.md'), '# alpha\n');
    fs.writeFileSync(path.join(srcDir, 'vanish.md'), '# vanish\n');
    fs.writeFileSync(path.join(srcDir, 'beta.md'), '# beta\n');

    const vanishPath = path.join(srcDir, 'vanish.md');

    // Deterministically inject the race at its true origin point: readdirSync
    // (called inside copyWithPathReplacement) returns the snapshot that still
    // includes 'vanish.md', but the file is removed from disk immediately
    // after that snapshot is taken and before the entry loop reaches it — the
    // same shape as a concurrent test suite's t.after() cleanup firing mid-copy.
    const origReaddirSync = fs.readdirSync;
    fs.readdirSync = function (dir, opts) {
      const result = origReaddirSync.call(fs, dir, opts);
      if (dir === srcDir) {
        try { fs.unlinkSync(vanishPath); } catch { /* already gone */ }
      }
      return result;
    };
    t.after(() => { fs.readdirSync = origReaddirSync; });

    const destDir = path.join(destRoot, 'out');

    assert.doesNotThrow(() => {
      copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, destRoot);
    }, 'copyWithPathReplacement must not throw when a listed source file vanishes before it is read (#3333)');

    assert.ok(fs.existsSync(path.join(destDir, 'alpha.md')),
      'alpha.md (unaffected sibling before the vanished entry) must still be copied');
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'alpha.md'), 'utf8'), '# alpha\n');

    assert.ok(fs.existsSync(path.join(destDir, 'beta.md')),
      'beta.md (unaffected sibling after the vanished entry) must still be copied');
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'beta.md'), 'utf8'), '# beta\n');

    assert.ok(!fs.existsSync(path.join(destDir, 'vanish.md')),
      'vanish.md destination must not exist — the vanished source must be skipped, not partially written');
  });
});

// ─── #3329 — /gsd-update never migrates stale .sh hook commands ───────────────
//
// /gsd-update re-invokes the installer (workflows/update.md), but
// applySettingsJsonHooks registers the four `.sh` managed hooks only-if-absent:
// an already-registered entry keeps whatever command shape an older installer
// emitted. On Windows+Claude that left the pre-#580/#3393 bash-runner-prefixed
// commands (`bash "<script>.sh"` / `"<git>/bash.exe" "<script>.sh"`) in place
// forever — each hook fire spawns a nested bash grandchild. The fix adds
// reconcileManagedShellHookCommands, wired into applySettingsJsonHooks, which
// rewrites existing managed `.sh` entries to the command this install would
// generate today — gated on shellHookOmitsBashRunner so it never fires where
// the bash runner is correct, and scoped to exact managed basenames so
// user-authored hooks are untouched.

describe('#3329 regression: stale managed .sh hook commands are reconciled on install/update', () => {
  const GLOBAL_EXPECTED = {
    'gsd-validate-commit.sh': '"C:/Users/u/.claude/hooks/gsd-validate-commit.sh"',
    'gsd-graphify-update.sh': '"C:/Users/u/.claude/hooks/gsd-graphify-update.sh"',
    'gsd-session-state.sh': '"C:/Users/u/.claude/hooks/gsd-session-state.sh"',
    'gsd-phase-boundary.sh': '"C:/Users/u/.claude/hooks/gsd-phase-boundary.sh"',
  };

  const LOCAL_EXPECTED = {
    'gsd-validate-commit.sh': '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-validate-commit.sh',
    'gsd-graphify-update.sh': '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-graphify-update.sh',
    'gsd-session-state.sh': '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-session-state.sh',
    'gsd-phase-boundary.sh': '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-phase-boundary.sh',
  };

  function settingsWith(entriesByEvent) {
    const hooks = {};
    for (const [event, commands] of Object.entries(entriesByEvent)) {
      hooks[event] = commands.map(command => ({
        hooks: [{ type: 'command', command }],
      }));
    }
    return { hooks };
  }

  function allCommands(settings) {
    const out = [];
    for (const entries of Object.values(settings.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks || []) out.push(h.command);
      }
    }
    return out;
  }

  test('reconcileManagedShellHookCommands is exported from runtime-hooks-surface.cjs', () => {
    assert.strictEqual(typeof reconcileManagedShellHookCommands, 'function',
      'reconcileManagedShellHookCommands must be exported from runtime-hooks-surface.cjs (#3329)');
  });

  test('win32+claude: bare `bash`-prefixed global entries are rewritten to the bare script path', () => {
    // Exact stale shapes reported in #3329 (global install, ~/.claude/settings.json).
    const settings = settingsWith({
      SessionStart: ['bash "C:/Users/u/.claude/hooks/gsd-session-state.sh"'],
      PreToolUse: ['bash "C:/Users/u/.claude/hooks/gsd-validate-commit.sh"'],
      PostToolUse: ['"C:/Program Files/Git/bin/bash.exe" "C:/Users/u/.claude/hooks/gsd-graphify-update.sh"'],
    });

    const changed = reconcileManagedShellHookCommands(settings, GLOBAL_EXPECTED, {
      platform: 'win32',
      runtime: 'claude',
    });

    assert.strictEqual(changed, true, 'stale entries must be reported as changed');
    assert.deepStrictEqual(allCommands(settings), [
      '"C:/Users/u/.claude/hooks/gsd-session-state.sh"',
      '"C:/Users/u/.claude/hooks/gsd-validate-commit.sh"',
      '"C:/Users/u/.claude/hooks/gsd-graphify-update.sh"',
    ], 'all three stale shapes must be rewritten to the shellHookOmitsBashRunner form');
  });

  test('win32+claude: local anchored-prefix entries are rewritten (buildLocalShellHookCommand shape)', () => {
    const settings = settingsWith({
      PreToolUse: ['bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-validate-commit.sh'],
      PostToolUse: ['"C:/Program Files/Git/bin/bash.exe" "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-phase-boundary.sh'],
    });

    const changed = reconcileManagedShellHookCommands(settings, LOCAL_EXPECTED, {
      platform: 'win32',
      runtime: 'claude',
    });

    assert.strictEqual(changed, true);
    assert.deepStrictEqual(allCommands(settings), [
      '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-validate-commit.sh',
      '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-phase-boundary.sh',
    ], 'local-install .sh entries must reconcile to the anchored bare script path');
  });

  test('idempotent: already-current entries are left untouched and report no change', () => {
    const settings = settingsWith({
      SessionStart: ['"C:/Users/u/.claude/hooks/gsd-session-state.sh"'],
    });

    const changed = reconcileManagedShellHookCommands(settings, GLOBAL_EXPECTED, {
      platform: 'win32',
      runtime: 'claude',
    });

    assert.strictEqual(changed, false, 'no-op when nothing is stale');
    assert.strictEqual(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"C:/Users/u/.claude/hooks/gsd-session-state.sh"',
    );
  });

  test('over-fire guard: non-Windows platforms are untouched even when commands are stale', () => {
    const original = 'bash "/home/u/.claude/hooks/gsd-session-state.sh"';
    const settings = settingsWith({ SessionStart: [original] });

    const changed = reconcileManagedShellHookCommands(settings, {
      'gsd-session-state.sh': 'bash "/home/u/.claude/hooks/gsd-session-state.sh"',
    }, { platform: 'linux', runtime: 'claude' });

    assert.strictEqual(changed, false, 'linux must not reconcile (bash runner is correct there)');
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, original);
  });

  test('over-fire guard: win32 non-claude runtimes are untouched', () => {
    const original = 'bash "C:/Users/u/.claude/hooks/gsd-session-state.sh"';
    const settings = settingsWith({ SessionStart: [original] });

    const changed = reconcileManagedShellHookCommands(settings, GLOBAL_EXPECTED, {
      platform: 'win32',
      runtime: 'qwen',
    });

    assert.strictEqual(changed, false, 'win32+qwen keeps the bash runner by design');
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, original);
  });

  test('scope guard: non-managed and user-authored hooks are never rewritten', () => {
    const entries = [
      'bash "/home/u/hooks/my-own-hook.sh"',                       // user hook, foreign basename
      'node "C:/Users/u/.claude/hooks/gsd-check-update.js"',       // .js hook — owned by the #2979 rewriter
      'FOO=1 bash "C:/Users/u/.claude/hooks/gsd-session-state.sh"', // 3-token wrapper, not the managed shape
      'bash "C:/Users/u/.claude/hooks/gsd-session-state.sh" --flag', // extra args after the script
    ];
    const settings = settingsWith({ SessionStart: entries.slice() });

    const changed = reconcileManagedShellHookCommands(settings, GLOBAL_EXPECTED, {
      platform: 'win32',
      runtime: 'claude',
    });

    assert.strictEqual(changed, false, 'no managed 2-token entry present — nothing to rewrite');
    assert.deepStrictEqual(allCommands(settings), entries, 'every entry must be byte-identical');
  });

  test('scope guard: args-form launcher entries are skipped (#976 parity)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '/usr/local/bin/node-launcher',
            args: ['C:/Users/u/.claude/hooks/gsd-session-state.sh'],
          }],
        }],
      },
    };

    const changed = reconcileManagedShellHookCommands(settings, GLOBAL_EXPECTED, {
      platform: 'win32',
      runtime: 'claude',
    });

    assert.strictEqual(changed, false, 'args-form entries are intentional wrappers');
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, '/usr/local/bin/node-launcher');
  });

  test('null expected commands are never written (bash-runner-unavailable installs stay intact)', () => {
    const original = 'bash "C:/Users/u/.claude/hooks/gsd-session-state.sh"';
    const settings = settingsWith({ SessionStart: [original] });

    const changed = reconcileManagedShellHookCommands(settings, {
      'gsd-session-state.sh': null,
    }, { platform: 'win32', runtime: 'claude' });

    assert.strictEqual(changed, false, 'a null expected command must disable rewriting for that hook');
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, original);
  });
});

// ─── #3664 — config-dir foreign-agent destination warning ───────────────────
//
// --config-dir aimed at a directory that is not a supported runtime's config
// home must never be a SILENT success: the installer emits the selected
// runtime's artifacts verbatim (Claude-only Skill tool IDs, mcp__server__tool
// grants), which are inert or invalid in a foreign harness and surface only
// at dispatch time. Warn-and-proceed when the destination already holds
// foreign (non-GSD) agent files; fresh custom dirs, gsd-only dirs (updates,
// the --all shared dir), the no-flag default-home path, and test temp dirs
// stay silent. Folded into this suite per the lint-test-file-count cap
// (primary + one integration per production module).

const installerMod = require('../bin/install.js');

function capturedLogs(t, fn) {
  const lines = [];
  const mock = t.mock.method(console, 'log', (...args) => {
    lines.push(args.join(' '));
  });
  const result = fn();
  mock.mock.restore();
  return { lines, result };
}

function makeForeignDest(t, name, agentFiles) {
  const dest = createTempDir(`gsd-3664-${name}-`);
  const agentsDir = path.join(dest, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const file of agentFiles) {
    fs.writeFileSync(path.join(agentsDir, file), '---\ntools: Read\n---\nbody\n');
  }
  t.after(() => cleanup(dest));
  return { dest, agentsDir };
}

describe('#3664 — config-dir foreign-agent destination warning', () => {
  test('warns when the destination holds foreign agent files', (t) => {
    const { dest } = makeForeignDest(t, 'foreign', ['junie-guide.md']);
    const { lines } = capturedLogs(t, () =>
      installerMod.warnIfForeignAgentDest('claude', dest, 'global', true),
    );
    const warning = lines.find((l) => l.includes('(#3664)'));
    assert.ok(warning, `expected a #3664 warning, got: ${lines.join(' | ') || '(none)'}`);
    assert.ok(warning.includes('claude'), `warning must name the selected runtime: ${warning}`);
    assert.ok(
      /tool IDs and MCP grants may (be inert|not apply)/.test(warning),
      `warning must name the tool/MCP risk: ${warning}`,
    );
  });

  test('installer warns and proceeds on a foreign-agent destination', (t) => {
    const home = createTempDir('gsd-3664-e2e-home-');
    t.after(() => cleanup(home));
    const dest = createTempDir('gsd-3664-e2e-dest-');
    t.after(() => cleanup(dest));
    fs.mkdirSync(path.join(dest, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'agents', 'junie-guide.md'), '---\ntools: Read\n---\nbody\n');

    const result = runNode(
      [path.join(__dirname, '..', 'bin', 'install.js'), '--claude', '--global', '--config-dir', dest],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          GSD_HOME: home,
          CI: '1',
        },
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    assert.equal(result.exitCode, 0, `warn-and-proceed must exit 0; stderr: ${result.stderr.slice(0, 500)}`);
    assert.ok(
      result.stdout.includes('(#3664)'),
      `stdout must carry the #3664 warning: ${result.stdout.slice(-800)}`,
    );
    const emitted = fs.existsSync(path.join(dest, 'agents'))
      ? fs.readdirSync(path.join(dest, 'agents')).filter((f) => /^gsd-.*\.md$/.test(f))
      : [];
    assert.ok(emitted.length > 0, 'install must still emit the gsd-* agents');
    assert.ok(fs.existsSync(path.join(dest, 'agents', 'junie-guide.md')));
  });

  test('silent on a fresh custom dir', (t) => {
    const { dest } = makeForeignDest(t, 'fresh', []);
    const { lines } = capturedLogs(t, () =>
      installerMod.warnIfForeignAgentDest('claude', dest, 'global', true),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `fresh dir must be silent: ${lines.join(' | ')}`);
  });

  test('silent on a gsd-only agents dir', (t) => {
    const { dest } = makeForeignDest(t, 'gsdonly', ['gsd-executor.md', 'gsd-verifier.md']);
    const { lines } = capturedLogs(t, () =>
      installerMod.warnIfForeignAgentDest('claude', dest, 'global', true),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `gsd-only dir must be silent: ${lines.join(' | ')}`);
  });

  test('silent when the config-dir flag was not passed', (t) => {
    const { dest } = makeForeignDest(t, 'noflag', ['personal-agent.md']);
    const { lines } = capturedLogs(t, () =>
      installerMod.warnIfForeignAgentDest('claude', dest, 'global', false),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `no-flag path must be silent: ${lines.join(' | ')}`);
  });

  test('warns on mixed gsd and personal agents', (t) => {
    const { dest } = makeForeignDest(t, 'mixed', ['gsd-executor.md', 'my-own-agent.md']);
    const { lines } = capturedLogs(t, () =>
      installerMod.warnIfForeignAgentDest('claude', dest, 'global', true),
    );
    const warning = lines.find((l) => l.includes('(#3664)'));
    assert.ok(warning, 'mixed dir with a foreign agent must warn');
    assert.ok(warning.includes('contains 1 non-GSD agent file'), `warning reports the foreign count: ${warning}`);
  });

  test('ignores non-markdown files', (t) => {
    const { dest, agentsDir } = makeForeignDest(t, 'nonmd', []);
    fs.writeFileSync(path.join(agentsDir, 'notes.txt'), 'not an agent');
    const { lines } = capturedLogs(t, () =>
      installerMod.warnIfForeignAgentDest('claude', dest, 'global', true),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `non-agent files are not harness evidence: ${lines.join(' | ')}`);
  });

  test('warns for the kimi runtime (kimi-agents kind)', (t) => {
    const { dest } = makeForeignDest(t, 'kimi-foreign', ['junie-guide.md']);
    const { lines } = capturedLogs(t, () =>
      installerMod.warnIfForeignAgentDest('kimi', dest, 'global', true),
    );
    assert.ok(
      lines.some((l) => l.includes('(#3664)') && l.includes('kimi')),
      `kimi's kimi-agents kind must take the gate: ${lines.join(' | ')}`,
    );
  });

  test('silent on kimi\'s own gsd.md in a shared multi-runtime dir', (t) => {
    // kimi's root agent is agents/gsd.md — a bare stem, no gsd- prefix. A
    // shared --all dir accumulates it alongside gsd-*.md; none of it is
    // foreign, so every runtime's install into that dir must stay silent.
    const { dest } = makeForeignDest(t, 'shared-kimi', ['gsd-executor.md', 'gsd.md']);
    const { lines } = capturedLogs(t, () => {
      installerMod.warnIfForeignAgentDest('kimi', dest, 'global', true);
      installerMod.warnIfForeignAgentDest('claude', dest, 'global', true);
    });
    assert.ok(
      !lines.some((l) => l.includes('(#3664)')),
      `GSD-owned gsd.md must not read as a foreign agent: ${lines.join(' | ')}`,
    );
  });

  test('degrades silently when the layout cannot resolve', (t) => {
    const dest = createTempDir('gsd-3664-unknown-');
    t.after(() => cleanup(dest));
    const { lines } = capturedLogs(t, () =>
      installerMod.warnIfForeignAgentDest('not-a-registered-runtime', dest, 'global', true),
    );
    assert.ok(!lines.some((l) => l.includes('(#3664)')), `unresolvable layout must degrade silently: ${lines.join(' | ')}`);
  });
});

// ─── #1874 F6 — malformed settings.local.json is preserved by the #338 migration ───

describe('#1874 F6 (#338 migration): a malformed settings.local.json is preserved', () => {
  test('local file stays byte-identical and shared GSD entries are not stripped', (t) => {
    const root = createTempDir('gsd-1874-f6-');
    t.after(() => cleanup(root));

    const claudeDir = path.join(root, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Shared settings carries GSD-shaped entries, so the #338 migration branch fires.
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(sharedSettingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `${process.execPath} ${path.join(claudeDir, 'hooks', 'gsd-check-update.js')}` }] },
        ],
      },
    }, null, 2) + '\n');

    // Unparseable local settings — the stray brace defeats both the JSON and the
    // JSONC path — carrying user content that must survive.
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    const malformedLocal = '{\n  "permissions": { "allow": ["Bash(npm test)"] },\n}}\n';
    fs.writeFileSync(localSettingsPath, malformedLocal);

    const env = { ...process.env, HOME: root, USERPROFILE: root };
    delete env.GSD_TEST_MODE;
    const result = runNode(
      [INSTALL_SCRIPT, '--claude', '--local'],
      { cwd: root, env, timeoutMs: 60_000 },
    );
    assert.strictEqual(result.exitCode, 0,
      `installer exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);

    // Byte-equality, not parse-equality: the file is unparseable by construction.
    assert.strictEqual(
      fs.readFileSync(localSettingsPath, 'utf8'),
      malformedLocal,
      'a malformed settings.local.json must be left byte-for-byte intact'
    );

    // Aborting only the local write would still strip the shared file below,
    // destroying the GSD entries outright instead of relocating them. The whole
    // migration must stand down so it can retry once the user fixes the file.
    const sharedAfter = JSON.parse(fs.readFileSync(sharedSettingsPath, 'utf8'));
    const sessionStart = (sharedAfter.hooks && sharedAfter.hooks.SessionStart) || [];
    assert.ok(
      sessionStart.some(
        entry => entry && entry.hooks && Array.isArray(entry.hooks) &&
          entry.hooks.some(h => h && h.command && h.command.includes('gsd-check-update'))
      ),
      'GSD entries must remain in settings.json when the migration is skipped'
    );
  });
});

// ─── #1874 F6 (adjacent): a malformed settings file must not crash the install ───
// The bare `return;` in the unparseable-settings guard returned undefined while
// every sibling early exit returns the full result shape, so installAllRuntimes'
// statusline lookup (results.find(r => r.runtime)) threw. Reachable on its own —
// no #338 migration required.

describe('#1874 F6 adjacent: malformed settings.local.json does not crash the install', () => {
  test('installer exits 0 and preserves the malformed file when no migration applies', (t) => {
    const root = createTempDir('gsd-1874-f6-nocrash-');
    t.after(() => cleanup(root));

    const claudeDir = path.join(root, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    const malformedLocal = '{\n  "permissions": { "allow": ["Bash(npm test)"] },\n}}\n';
    fs.writeFileSync(localSettingsPath, malformedLocal);

    const env = { ...process.env, HOME: root, USERPROFILE: root };
    delete env.GSD_TEST_MODE;
    const result = runNode(
      [INSTALL_SCRIPT, '--claude', '--local'],
      { cwd: root, env, timeoutMs: 60_000 },
    );

    assert.strictEqual(result.exitCode, 0,
      `installer must not crash on an unparseable settings file\n${result.stdout}\n${result.stderr}`);
    assert.strictEqual(
      fs.readFileSync(localSettingsPath, 'utf8'),
      malformedLocal,
      'the unparseable file must be left intact'
    );
  });
});

// ─── #1874 F18 — ~/.gsd/defaults.json is machine-global: lock it, write it once ───
//
// Every runtime and project on the box reads this file. The read-modify-write
// took no lock (so concurrent installs lost each other's key) and issued two
// separate whole-file writes (so a crash could truncate it, and the second
// write bought nothing).

describe('#1874 F18: ~/.gsd/defaults.json read-modify-write is locked and atomic', () => {
  const { writeNonClaudeDefaults } = installExports || {};

  // The function early-returns under GSD_TEST_MODE, and resolves its target via
  // os.homedir() — which reads HOME on POSIX and USERPROFILE on Windows.
  function withRealInstallHome(root, fn) {
    const saved = {
      testMode: process.env.GSD_TEST_MODE,
      home: process.env.HOME,
      userProfile: process.env.USERPROFILE,
    };
    delete process.env.GSD_TEST_MODE;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    try {
      return fn();
    } finally {
      if (saved.testMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = saved.testMode;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
      if (saved.userProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.userProfile;
    }
  }

  test('a clean install writes defaults.json exactly once, not twice', (t) => {
    const root = createTempDir('gsd-1874-f18-once-');
    t.after(() => cleanup(root));

    const defaultsPath = path.join(root, '.gsd', 'defaults.json');
    const writes = [];
    const origWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (target, ...rest) => {
      // Count writes aimed at defaults.json, including the atomic temp sibling.
      const resolved = path.resolve(String(target));
      if (resolved === defaultsPath || resolved.startsWith(`${defaultsPath}.tmp-`)) writes.push(resolved);
      return origWriteFileSync.call(fs, target, ...rest);
    };
    t.after(() => { fs.writeFileSync = origWriteFileSync; });

    withRealInstallHome(root, () => {
      const origLog = console.log;
      console.log = () => {};
      t.after(() => { console.log = origLog; });
      writeNonClaudeDefaults('codex');
    });

    // Both keys change on a clean install; that is one file state, so one write.
    assert.strictEqual(writes.length, 1,
      `defaults.json must be written once per install, got ${writes.length}`);

    const after = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
    assert.strictEqual(after.resolve_model_ids, 'omit');
    assert.strictEqual(after.runtime, 'codex');
  });

  test('the read-modify-write holds the install-migration lock', (t) => {
    const root = createTempDir('gsd-1874-f18-lock-');
    t.after(() => cleanup(root));

    const gsdDir = path.join(root, '.gsd');
    const lockPath = path.join(gsdDir, 'gsd-install-migration.lock');
    const defaultsPath = path.join(gsdDir, 'defaults.json');
    let lockHeldDuringWrite = null;

    const origWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (target, ...rest) => {
      const resolved = path.resolve(String(target));
      if (resolved === defaultsPath || resolved.startsWith(`${defaultsPath}.tmp-`)) {
        lockHeldDuringWrite = fs.existsSync(lockPath);
      }
      return origWriteFileSync.call(fs, target, ...rest);
    };
    t.after(() => { fs.writeFileSync = origWriteFileSync; });

    withRealInstallHome(root, () => {
      const origLog = console.log;
      console.log = () => {};
      t.after(() => { console.log = origLog; });
      writeNonClaudeDefaults('codex');
    });

    assert.strictEqual(lockHeldDuringWrite, true,
      'the lock must be held while defaults.json is being written');
    assert.strictEqual(fs.existsSync(lockPath), false,
      'the lock must be released when the write completes');
  });

  test('a failure mid-write leaves the previous defaults.json intact and parseable', (t) => {
    const root = createTempDir('gsd-1874-f18-crash-');
    t.after(() => cleanup(root));

    const gsdDir = path.join(root, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    const defaultsPath = path.join(gsdDir, 'defaults.json');
    // A pre-existing file carrying settings other installs depend on.
    const prior = JSON.stringify({ model_profile: 'balanced', resolve_model_ids: true }, null, 2) + '\n';
    fs.writeFileSync(defaultsPath, prior);

    // Faithful crash window: the bytes written before the failure DO land, then
    // the call fails.
    t.after(mockPartialWriteThenThrow(
      fs,
      (target) => {
        const resolved = path.resolve(String(target));
        return resolved === defaultsPath || resolved.startsWith(`${defaultsPath}.tmp-`);
      },
      10,
      { code: 'ENOSPC', message: 'ENOSPC: no space left on device' },
    ));

    withRealInstallHome(root, () => {
      const origLog = console.log;
      console.log = () => {};
      t.after(() => { console.log = origLog; });
      // The installer treats this as best-effort and logs rather than throwing.
      writeNonClaudeDefaults('codex');
    });

    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf8'), prior,
      'defaults.json must be byte-identical to its pre-write contents');
    // The read path swallows parse errors and treats a corrupt file as absent,
    // so a truncated write would silently degrade model resolution box-wide.
    const recovered = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
    assert.strictEqual(recovered.model_profile, 'balanced');
    assert.strictEqual(recovered.resolve_model_ids, true);

    assert.deepStrictEqual(
      fs.readdirSync(gsdDir).filter(n => n.startsWith('defaults.json.tmp-')),
      [],
      'no atomic temp residue may survive a failed write'
    );
    assert.strictEqual(fs.existsSync(path.join(gsdDir, 'gsd-install-migration.lock')), false,
      'the lock must be released even when the write fails');
  });

  test('an install that changes nothing does not rewrite the file', (t) => {
    const root = createTempDir('gsd-1874-f18-noop-');
    t.after(() => cleanup(root));

    const gsdDir = path.join(root, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    const defaultsPath = path.join(gsdDir, 'defaults.json');
    const prior = JSON.stringify({ resolve_model_ids: 'omit', runtime: 'codex' }, null, 2) + '\n';
    fs.writeFileSync(defaultsPath, prior);

    const writes = [];
    const origWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (target, ...rest) => {
      const resolved = path.resolve(String(target));
      if (resolved === defaultsPath || resolved.startsWith(`${defaultsPath}.tmp-`)) writes.push(resolved);
      return origWriteFileSync.call(fs, target, ...rest);
    };
    t.after(() => { fs.writeFileSync = origWriteFileSync; });
    withRealInstallHome(root, () => {
      const origLog = console.log;
      console.log = () => {};
      t.after(() => { console.log = origLog; });
      writeNonClaudeDefaults('codex');
    });

    assert.deepStrictEqual(writes, [], 'an unchanged defaults.json must not be rewritten');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf8'), prior);
  });

  test('a read-only .gsd directory blocks the lock and the RMW never partially applies', (t) => {
    const root = createTempDir('gsd-1874-f18-readonly-');
    t.after(() => cleanup(root));

    const gsdDir = path.join(root, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    const lockPath = path.join(gsdDir, 'gsd-install-migration.lock');
    const defaultsPath = path.join(gsdDir, 'defaults.json');
    // A pre-existing file the RMW must never touch if the lock cannot be taken.
    const prior = JSON.stringify({ model_profile: 'balanced', resolve_model_ids: true }, null, 2) + '\n';
    fs.writeFileSync(defaultsPath, prior);

    // fs-method override rather than chmod — root bypasses mode bits, so a
    // permission-based test silently passes with zero coverage in root CI.
    // Simulates a read-only .gsd directory: the exclusive lock-file create
    // fails with EACCES before any read-modify-write is attempted.
    const origOpenSync = fs.openSync;
    fs.openSync = (target, flags, ...rest) => {
      if (path.resolve(String(target)) === lockPath) {
        throw Object.assign(new Error('EACCES: permission denied, open ' + lockPath), { code: 'EACCES' });
      }
      return origOpenSync.call(fs, target, flags, ...rest);
    };
    t.after(() => { fs.openSync = origOpenSync; });

    let threw = false;
    withRealInstallHome(root, () => {
      const origLog = console.log;
      console.log = () => {};
      t.after(() => { console.log = origLog; });
      // writeNonClaudeDefaults treats lock/write failure as best-effort and
      // must not let it escape as an uncaught exception.
      try { writeNonClaudeDefaults('codex'); } catch { threw = true; }
    });

    assert.strictEqual(threw, false,
      'a blocked lock must not crash the installer — writeNonClaudeDefaults degrades gracefully');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf8'), prior,
      'defaults.json must be untouched when the lock could not be acquired — no partial RMW');
    assert.strictEqual(fs.existsSync(lockPath), false,
      'no lock file may be left behind when its creation itself failed');
  });
});
