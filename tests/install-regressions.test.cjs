'use strict';
/**
 * Installer Module — date-stamped regression tests.
 *
 * Consolidates install-hermes-regressions.test.cjs into a single
 * regressions file for the installer module cluster.
 *
 * Defects covered:
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
const { spawnSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
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

const { install, mergeClaudePermissions, GSD_CLAUDE_ALLOW_PERMISSIONS, GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS, GSD_CLAUDE_DENY_PERMISSIONS, rewriteLegacyManagedNodeHookCommands, resolveNodeRunner } = installExports || {};

const {
  installRuntimeArtifacts,
  uninstallRuntimeArtifacts,
} = require('../gsd-core/bin/lib/install-engine.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
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

    const result = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--codex', '--local', '--profile=core'],
      { cwd: projectDir, encoding: 'utf8', env, timeout: 60_000 },
    );

    assert.strictEqual(
      result.status,
      0,
      `installer exited ${result.status}\n${result.stdout}\n${result.stderr}`,
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
      'installRuntimeArtifacts must be exported from bin/install.js');

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

    const result = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--qwen', '--global', '--config-dir', root, '--profile=core'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } },
    );

    assert.strictEqual(result.status, 0,
      `installer exited ${result.status}\n${result.stdout}\n${result.stderr}`);

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

    const result = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--hermes', '--global', '--config-dir', root, '--profile=core'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } },
    );

    assert.strictEqual(result.status, 0,
      `installer exited ${result.status}\n${result.stdout}\n${result.stderr}`);

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

    const result = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--hermes', '--global', '--config-dir', root, '--profile=core'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } },
    );

    assert.strictEqual(result.status, 0,
      `installer exited ${result.status}\n${result.stdout}\n${result.stderr}`);

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

    const result = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--qwen', '--global', '--config-dir', root, '--profile=core'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } },
    );

    assert.strictEqual(result.status, 0,
      `installer exited ${result.status}\n${result.stdout}\n${result.stderr}`);

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

    const result = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root, '--profile=core'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } },
    );

    assert.strictEqual(result.status, 0,
      `installer exited ${result.status}\n${result.stdout}\n${result.stderr}`);

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
      'uninstallRuntimeArtifacts must be exported from bin/install.js');

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

  test('GSD_CLAUDE_DENY_PERMISSIONS is a non-empty array of strings', () => {
    assert.ok(Array.isArray(GSD_CLAUDE_DENY_PERMISSIONS),
      'GSD_CLAUDE_DENY_PERMISSIONS must be an array');
    assert.ok(GSD_CLAUDE_DENY_PERMISSIONS.length > 0,
      'GSD_CLAUDE_DENY_PERMISSIONS must not be empty');
    for (const entry of GSD_CLAUDE_DENY_PERMISSIONS) {
      assert.strictEqual(typeof entry, 'string', `deny entry must be a string, got: ${JSON.stringify(entry)}`);
    }
  });
});

describe('mergeClaudePermissions (#768): fresh settings object', () => {
  test('populates permissions.allow and permissions.deny on empty settings', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    assert.ok(Array.isArray(settings.permissions?.allow), 'permissions.allow must be an array');
    assert.ok(Array.isArray(settings.permissions?.deny), 'permissions.deny must be an array');
    for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
      assert.ok(settings.permissions.allow.includes(entry),
        `permissions.allow must contain "${entry}"`);
    }
    for (const entry of GSD_CLAUDE_DENY_PERMISSIONS) {
      assert.ok(settings.permissions.deny.includes(entry),
        `permissions.deny must contain "${entry}"`);
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

  test('includes .env denial entries in deny', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    assert.ok(settings.permissions.deny.includes('Read(.env)'),
      'permissions.deny must contain Read(.env)');
    assert.ok(settings.permissions.deny.includes('Read(.env.*)'),
      'permissions.deny must contain Read(.env.*)');
    assert.ok(settings.permissions.deny.includes('Read(.secrets)'),
      'permissions.deny must contain Read(.secrets)');
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
    // GSD entries must be added
    assert.ok(settings.permissions.allow.includes('Bash(npx gsd-core *)'),
      'GSD allow entry must be added');
    assert.ok(settings.permissions.deny.includes('Read(.env)'),
      'GSD deny entry must be added');
  });

  test('does not duplicate entries on repeated calls (idempotent)', () => {
    const settings = {};
    mergeClaudePermissions(settings);
    mergeClaudePermissions(settings);
    for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
      const count = settings.permissions.allow.filter((e) => e === entry).length;
      assert.strictEqual(count, 1, `allow entry "${entry}" must appear exactly once after two merges`);
    }
    for (const entry of GSD_CLAUDE_DENY_PERMISSIONS) {
      const count = settings.permissions.deny.filter((e) => e === entry).length;
      assert.strictEqual(count, 1, `deny entry "${entry}" must appear exactly once after two merges`);
    }
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

describe('mergeClaudePermissions (#768): end-to-end install writes permissions to settings.json', () => {
  test('--claude --global install writes GSD allow/deny entries to settings.json', (t) => {
    const root = createTempDir('gsd-claude-perm-install-');
    t.after(() => cleanup(root));

    const result = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root],
      { encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } },
    );

    assert.strictEqual(result.status, 0,
      `installer exited ${result.status}\n${result.stdout}\n${result.stderr}`);

    const settingsPath = path.join(root, 'settings.json');
    assert.ok(fs.existsSync(settingsPath), 'settings.json must exist after claude install');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(settings.permissions?.allow),
      'settings.json must have permissions.allow array');
    assert.ok(Array.isArray(settings.permissions?.deny),
      'settings.json must have permissions.deny array');

    assert.ok(settings.permissions.allow.includes('Bash(npx gsd-core *)'),
      'settings.json permissions.allow must include Bash(npx gsd-core *)');
    assert.ok(settings.permissions.allow.includes('Read(.planning/*)'),
      'settings.json permissions.allow must include Read(.planning/*)');
    assert.ok(settings.permissions.deny.includes('Read(.env)'),
      'settings.json permissions.deny must include Read(.env)');
  });

  test('non-claude runtime (antigravity) does NOT write GSD allow/deny permissions to settings.json', (t) => {
    const root = createTempDir('gsd-antigravity-perm-install-');
    t.after(() => cleanup(root));

    const result = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--antigravity', '--global', '--config-dir', root],
      { encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } },
    );

    assert.strictEqual(result.status, 0,
      `installer exited ${result.status}\n${result.stdout}\n${result.stderr}`);

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

    const spawnOpts = {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, USERPROFILE: root },
    };
    const args = [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root];

    // First install
    const r1 = spawnSync(process.execPath, args, spawnOpts);
    assert.strictEqual(r1.status, 0, `first install failed: ${r1.stderr}`);

    // Second install (reinstall)
    const r2 = spawnSync(process.execPath, args, spawnOpts);
    assert.strictEqual(r2.status, 0, `reinstall failed: ${r2.stderr}`);

    const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
    for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
      const count = (settings.permissions?.allow ?? []).filter((e) => e === entry).length;
      assert.strictEqual(count, 1,
        `allow entry "${entry}" must appear exactly once after two installs`);
    }
    for (const entry of GSD_CLAUDE_DENY_PERMISSIONS) {
      const count = (settings.permissions?.deny ?? []).filter((e) => e === entry).length;
      assert.strictEqual(count, 1,
        `deny entry "${entry}" must appear exactly once after two installs`);
    }
  });

  test('--claude --global uninstall removes GSD permission entries from settings.json', (t) => {
    const root = createTempDir('gsd-claude-perm-uninstall-');
    t.after(() => cleanup(root));

    const spawnOpts = {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, USERPROFILE: root },
    };

    // Install first
    const r1 = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root],
      spawnOpts,
    );
    assert.strictEqual(r1.status, 0, `install failed: ${r1.stderr}`);

    // Verify permissions were written
    const settingsPath = path.join(root, 'settings.json');
    const afterInstall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok((afterInstall.permissions?.allow ?? []).includes('Bash(npx gsd-core *)'),
      'permissions.allow must contain GSD entry after install');

    // Now add a user permission to make sure we don't nuke it
    afterInstall.permissions.allow.push('Bash(git *)');
    afterInstall.permissions.deny.push('WebSearch');
    fs.writeFileSync(settingsPath, JSON.stringify(afterInstall, null, 2) + '\n');

    // Uninstall
    const r2 = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root, '--uninstall'],
      spawnOpts,
    );
    assert.strictEqual(r2.status, 0, `uninstall failed: ${r2.stderr}`);

    const afterUninstall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allow = afterUninstall.permissions?.allow ?? [];
    const deny = afterUninstall.permissions?.deny ?? [];

    // GSD entries must be removed
    assert.ok(!allow.includes('Bash(npx gsd-core *)'),
      'GSD Bash allow entry must be removed by uninstall');
    assert.ok(!allow.includes('Read(.planning/*)'),
      'GSD Read(.planning/*) allow entry must be removed by uninstall');
    assert.ok(!deny.includes('Read(.env)'),
      'GSD Read(.env) deny entry must be removed by uninstall');

    // User entries must survive
    assert.ok(allow.includes('Bash(git *)'),
      'user Bash(git *) allow entry must survive uninstall');
    assert.ok(deny.includes('WebSearch'),
      'user WebSearch deny entry must survive uninstall');
  });

  test('#2278: uninstall removes GSD entries in both legacy Write(...) and current Edit(...) form', (t) => {
    const root = createTempDir('gsd-claude-perm-uninstall-legacy-');
    t.after(() => cleanup(root));

    const spawnOpts = {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, USERPROFILE: root },
    };

    // Install first (writes the current Edit(...) forms).
    const r1 = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root],
      spawnOpts,
    );
    assert.strictEqual(r1.status, 0, `install failed: ${r1.stderr}`);

    // Simulate a pre-fix install that still carries the stale Write(...)
    // forms alongside the current Edit(...) forms and a user entry.
    const settingsPath = path.join(root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.permissions.allow.push('Write(.planning/*)', 'Write(STATE.md)', 'Bash(git *)');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    // Uninstall
    const r2 = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', root, '--uninstall'],
      spawnOpts,
    );
    assert.strictEqual(r2.status, 0, `uninstall failed: ${r2.stderr}`);

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
      'rewriteLegacyManagedNodeHookCommands must be exported from bin/install.js');

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
const { execFileSync } = require('child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

// ─── Ensure hooks/dist/ is populated before any install test ─────────────────

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
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
  execFileSync(process.execPath, [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
  });
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

// ─── Test 4: preserveUserArtifacts helper exported from install.js ────────────

describe('#1924: preserveUserArtifacts helper exists in install.js', () => {
  test('install.js exports preserveUserArtifacts function', () => {
    // Set GSD_TEST_MODE so require() reaches the module.exports block
    const origMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    let mod;
    try {
      mod = require(INSTALL_SCRIPT);
    } finally {
      if (origMode === undefined) {
        delete process.env.GSD_TEST_MODE;
      } else {
        process.env.GSD_TEST_MODE = origMode;
      }
    }

    assert.strictEqual(
      typeof mod.preserveUserArtifacts,
      'function',
      'install.js must export preserveUserArtifacts helper for testability'
    );
  });
});
  });
}
