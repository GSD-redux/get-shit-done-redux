/**
 * Tests for #683: installer sets worktree.baseRef:"head" in settings.local.json
 * for local Claude Code installs.
 *
 * Cases:
 *  1. Fresh local install: writes worktree.baseRef:"head" automatically (no-clobber).
 *  2. Fresh install with pre-existing explicit baseRef: does NOT clobber it.
 *  3a. Upgrade + isLocalClaude + use_worktrees absent/true → auto-applies baseRef.
 *  3b. Upgrade + use_worktrees === false → does NOT apply baseRef.
 *  3c. Upgrade + explicit baseRef already present (local or shared) → unchanged (no-clobber).
 *  4. Idempotency: re-running a fresh-style install when baseRef is already "head"
 *     does not duplicate or error.
 *  5. Global Claude install: does NOT set worktree.baseRef (only local Claude).
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install, finishInstall } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────
before(() => {
  const r = runNode([BUILD_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS });
  throwIfFailed(r, 'build-hooks.js (before install tests)');
});

// ─── Helper: run both install phases (mirrors installAllRuntimes two-phase) ──

function runInstall(isGlobal, opts = {}) {
  const { shouldInstallStatusline = false } = opts;
  const result = install(isGlobal, 'claude');
  finishInstall(
    result.settingsPath,
    result.settings,
    result.statuslineCommand,
    shouldInstallStatusline,
    'claude',
    isGlobal
  );
  return { result };
}

// ─── Helper: write .planning/config.json in the project root ─────────────────
// For a local Claude install, targetDir = <cwd>/.claude, so project root = cwd.
// .planning/config.json lives at <cwd>/.planning/config.json.

function writePlanningConfig(projectRoot, config) {
  const planningDir = path.join(projectRoot, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

// ─── Case 1: fresh local install writes worktree.baseRef:"head" ──────────────

describe('#683 case 1: fresh local Claude install sets worktree.baseRef:"head"', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-fresh-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('settings.local.json contains worktree.baseRef:"head" after fresh install', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    runInstall(false);

    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after local Claude install'
    );

    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.ok(
      settings && typeof settings === 'object',
      'settings.local.json must be a valid JSON object'
    );
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      'head',
      'worktree.baseRef must be "head" after a fresh local Claude install (#683)'
    );
  });
});

// ─── Case 2: fresh install does not clobber a pre-existing explicit baseRef ──

describe('#683 case 2: fresh install does not clobber existing explicit worktree.baseRef', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-noclobber-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('pre-existing explicit baseRef is preserved on fresh install', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Pre-populate settings.local.json with an explicit non-"head" baseRef
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    fs.writeFileSync(localSettingsPath, JSON.stringify({ worktree: { baseRef: 'main' } }, null, 2) + '\n');

    runInstall(false);

    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      'main',
      'An explicit worktree.baseRef must not be overwritten by the installer (#683 no-clobber)'
    );
  });
});

// ─── Case 3a: upgrade + use_worktrees absent → auto-applies baseRef ──────────

describe('#683 case 3a: upgrade + use_worktrees absent → auto-applies worktree.baseRef', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-upgrade-on-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('upgrade auto-applies worktree.baseRef:"head" when use_worktrees is absent', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Simulate a prior install by pre-creating the VERSION file.
    const versionPath = path.join(tmpDir, '.claude', 'gsd-core', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, '1.0.0');
    // No .planning/config.json — use_worktrees defaults to enabled (true).

    runInstall(false);

    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after upgrade'
    );
    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      'head',
      'upgrade must auto-apply worktree.baseRef:"head" when use_worktrees is absent (#683)'
    );
  });

  test('upgrade auto-applies worktree.baseRef:"head" when use_worktrees is true', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Simulate a prior install by pre-creating the VERSION file.
    const versionPath = path.join(tmpDir, '.claude', 'gsd-core', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, '1.0.0');
    // .planning/config.json with use_worktrees: true
    writePlanningConfig(tmpDir, { workflow: { use_worktrees: true } });

    runInstall(false);

    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(fs.existsSync(localSettingsPath), '.claude/settings.local.json must exist after upgrade');
    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      'head',
      'upgrade must auto-apply worktree.baseRef:"head" when use_worktrees:true (#683)'
    );
  });
});

// ─── Case 3b: upgrade + use_worktrees === false → does NOT apply baseRef ─────

describe('#683 case 3b: upgrade + use_worktrees:false → does NOT apply worktree.baseRef', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-upgrade-off-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('upgrade does not apply worktree.baseRef when use_worktrees is false', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Simulate a prior install by pre-creating the VERSION file.
    const versionPath = path.join(tmpDir, '.claude', 'gsd-core', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, '1.0.0');
    // .planning/config.json with use_worktrees: false
    writePlanningConfig(tmpDir, { workflow: { use_worktrees: false } });

    runInstall(false);

    // finishInstall always writes settings.local.json for local Claude installs.
    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after upgrade (finishInstall writes it)'
    );
    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree,
      undefined,
      'upgrade must NOT apply worktree block when use_worktrees:false (#683)'
    );
  });
});

// ─── Case 3c: upgrade + explicit baseRef already present → no-clobber ─────────

describe('#683 case 3c: upgrade + explicit baseRef present → no-clobber (unchanged)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-upgrade-noclobber-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('upgrade preserves an explicit worktree.baseRef set by the user in local settings', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Simulate prior install with user-set explicit baseRef
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const versionPath = path.join(claudeDir, 'gsd-core', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, '1.0.0');

    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    fs.writeFileSync(localSettingsPath, JSON.stringify({ worktree: { baseRef: 'fresh' } }, null, 2) + '\n');

    runInstall(false);

    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      'fresh',
      'upgrade must preserve an explicit user-set worktree.baseRef in local settings (#683 no-clobber)'
    );
  });

  test('upgrade does not inject baseRef when shared settings.json already has one', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Simulate prior install
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const versionPath = path.join(claudeDir, 'gsd-core', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, '1.0.0');

    // Shared settings.json has an explicit baseRef; settings.local.json does not.
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(sharedSettingsPath, JSON.stringify({ worktree: { baseRef: 'main' } }, null, 2) + '\n');

    runInstall(false);

    // finishInstall always writes settings.local.json for local Claude installs.
    // Shared no-clobber: sharedBaseRef !== null → installer must not inject.
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after upgrade (finishInstall writes it)'
    );
    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      undefined,
      'upgrade must NOT inject worktree.baseRef to settings.local.json when shared settings.json already has one (#683 no-clobber)'
    );
  });
});

// ─── Case 4: idempotency — re-running fresh-style install when already "head" ─

describe('#683 case 4: idempotency — re-installing when worktree.baseRef already "head"', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-idem-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('second install does not error or duplicate worktree block', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Run once (sets baseRef:"head")
    runInstall(false);

    // Remove the VERSION file to simulate a fresh-style re-install (e.g. forced reinstall)
    const versionPath = path.join(tmpDir, '.claude', 'gsd-core', 'VERSION');
    if (fs.existsSync(versionPath)) {
      fs.unlinkSync(versionPath);
    }

    // Run again — should be idempotent
    runInstall(false);

    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      'head',
      'worktree.baseRef must still be "head" after idempotent re-install (#683)'
    );
    // Ensure worktree block wasn't duplicated into an array or otherwise corrupted
    assert.strictEqual(
      typeof settings.worktree,
      'object',
      'worktree must be a plain object after idempotent re-install'
    );
    assert.ok(
      !Array.isArray(settings.worktree),
      'worktree must not have been duplicated into an array'
    );
  });
});

// ─── Case 2b (FIX 1): fresh install does not clobber baseRef set in shared settings.json ──

describe('#683 case 2b (FIX 1): fresh install does not clobber worktree.baseRef in shared settings.json', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-shared-noclobber-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('shared settings.json with worktree.baseRef:"fresh" → installer must NOT write baseRef to settings.local.json and must NOT print ✓ notice', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Pre-populate only the SHARED settings.json with an explicit baseRef.
    // settings.local.json does NOT exist — this is a fresh install otherwise.
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(sharedSettingsPath, JSON.stringify({ worktree: { baseRef: 'fresh' } }, null, 2) + '\n');

    runInstall(false);

    // settings.local.json must either not exist or have no worktree.baseRef.
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    if (fs.existsSync(localSettingsPath)) {
      const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
      assert.strictEqual(
        localSettings.worktree && localSettings.worktree.baseRef,
        undefined,
        'installer must NOT write worktree.baseRef to settings.local.json when shared settings.json already has an explicit baseRef (#683 FIX 1)'
      );
    }
    // If settings.local.json wasn't written, the test passes (no injection occurred).
  });
});

// ─── Case 6 (FIX 1): non-object settings.local.json does not crash installer ──

describe('#683 FIX 1: non-object settings.local.json does not crash the installer', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-nonobj-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('settings.local.json containing [] does not throw during fresh local install', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Pre-populate settings.local.json with an array — valid JSON but non-object
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    fs.writeFileSync(localSettingsPath, '[]');

    // Must not throw — baseRef logic must be silently skipped for non-objects
    assert.doesNotThrow(() => runInstall(false));
  });

  test('settings.local.json containing JSON null does not crash installer and leaves no worktree.baseRef (#683 guard)', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Pre-populate settings.local.json with the JSON value `null` — valid JSON,
    // but non-object.  The install() function special-cases a null parsed result
    // (indistinguishable from a parse error) and returns early, so we call install()
    // directly here instead of runInstall() which calls finishInstall and would
    // crash on the undefined result.
    // The #683 guard in install() is:
    //   `settings !== null && typeof settings === 'object' && !Array.isArray(settings)`
    // That guard prevents applyWorktreeBaseRef from being invoked with null (which
    // would throw TypeError); this test verifies that guard fires and no crash occurs.
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    fs.writeFileSync(localSettingsPath, 'null');

    // install() must not throw; it returns undefined early for unparseable settings.
    assert.doesNotThrow(() => install(false, 'claude'));

    // settings.local.json must still read as null (installer bailed out and did not
    // overwrite it), which means no worktree.baseRef was injected.
    const raw = fs.readFileSync(localSettingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // The file was not rewritten (install returned early), so it is still `null`.
    // Either way, no worktree block should be present.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      assert.strictEqual(
        parsed.worktree,
        undefined,
        'installer must NOT write worktree block when settings.local.json held JSON null (#683 FIX 1 guard)'
      );
    } else {
      // File is still null (or non-object) — no worktree.baseRef was written.
      assert.ok(
        parsed === null || Array.isArray(parsed) || typeof parsed !== 'object',
        'settings.local.json remained non-object after install — no worktree.baseRef was injected'
      );
    }
  });
});

// ─── Case 7: fresh + use_worktrees:false → does NOT write worktree.baseRef ───

describe('#683 case 7: fresh local Claude install + use_worktrees:false → does NOT set worktree.baseRef', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-fresh-off-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('fresh install with use_worktrees:false does not write worktree.baseRef', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // No VERSION file → fresh install.
    // .planning/config.json with use_worktrees: false → must suppress baseRef.
    writePlanningConfig(tmpDir, { workflow: { use_worktrees: false } });

    runInstall(false);

    // finishInstall always writes settings.local.json for local Claude installs.
    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after fresh local Claude install'
    );
    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree,
      undefined,
      'fresh install must NOT write worktree.baseRef when use_worktrees:false (#683 FIX A)'
    );
  });

  test('fresh install with absent .planning/config.json still applies worktree.baseRef (default enabled)', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // No VERSION file → fresh install.
    // No .planning/config.json → worktreesEnabled defaults to true.

    runInstall(false);

    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after fresh local Claude install'
    );
    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      'head',
      'fresh install must apply worktree.baseRef:"head" when .planning/config.json is absent (default enabled; #683 FIX A)'
    );
  });
});

// ─── Case 8: upgrade idempotency — two upgrade runs produce exactly one baseRef ─

describe('#683 case 8: upgrade→upgrade idempotency — two upgrade runs do not duplicate worktree.baseRef', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-idem2-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('two consecutive upgrade runs leave settings.local.json with exactly one worktree.baseRef:"head"', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // First upgrade run: VERSION present → upgrade path.
    const versionPath = path.join(tmpDir, '.claude', 'gsd-core', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, '1.0.0');
    // use_worktrees defaults to enabled (no .planning/config.json)

    runInstall(false);

    // Restore VERSION so the second run is also an upgrade.
    if (!fs.existsSync(versionPath)) {
      fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    }
    fs.writeFileSync(versionPath, '1.0.0');

    runInstall(false);

    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after two upgrade runs'
    );
    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.worktree && settings.worktree.baseRef,
      'head',
      'worktree.baseRef must be "head" after two upgrade runs (#683 idempotency)'
    );
    assert.strictEqual(
      typeof settings.worktree,
      'object',
      'worktree must be a plain object after two upgrade runs'
    );
    assert.ok(
      !Array.isArray(settings.worktree),
      'worktree must not have been duplicated into an array after two upgrade runs'
    );
  });
});

// ─── Case 5: global Claude install does NOT set worktree.baseRef ─────────────

describe('#683 case 5: global Claude install does NOT set worktree.baseRef', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-683-global-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('global install does not write worktree.baseRef', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });

    // Point CLAUDE_CONFIG_DIR at a tmpDir subdir to avoid polluting ~/.claude
    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const origEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    t.after(() => {
      if (origEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origEnv;
      }
    });

    runInstall(true);

    const settingsPath = path.join(configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.strictEqual(
        settings.worktree,
        undefined,
        'global Claude install must not write worktree.baseRef into settings.json (#683)'
      );
    }
  });
});
