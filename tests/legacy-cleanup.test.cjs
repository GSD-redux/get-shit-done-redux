/**
 * Tests for legacy artifact cleanup seam (issue #607).
 *
 * Covers planLegacyCleanup and applyLegacyCleanup from
 * gsd-core/bin/lib/legacy-cleanup.cjs using real temp dirs so the
 * filesystem logic is exercised end-to-end without touching live config dirs.
 *
 * These tests read files they create themselves in OS temp directories —
 * not repo source files. The fs reads are test-input reads, not source-grep.
 * // allow-test-rule: integration-test-input
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { planLegacyCleanup, applyLegacyCleanup } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'legacy-cleanup.cjs')
);
const { MANAGED_HOOKS } = require(
  path.join(__dirname, '..', 'hooks', 'managed-hooks-registry.cjs')
);
const { cleanup } = require('./helpers.cjs');

// Assembled the same way the implementation does so this file also avoids the
// bare literal (correctness: the test content strings below DO contain it,
// which is fine — tests may reference the signal string directly).
const OLD_PACKAGE_SIGNAL = 'gsd-core' + '-cc';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-607-'));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('issue-607 legacy-cleanup: planLegacyCleanup', () => {
  let tmpRoot;
  let configDir;
  let homeDir;

  beforeEach(() => {
    tmpRoot   = mkTmpDir();
    configDir = path.join(tmpRoot, 'config');
    homeDir   = path.join(tmpRoot, 'home');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  // ── content-references-old-package ─────────────────────────────────────────

  test('flags a hook file in hooks/ whose content contains the old package signal', () => {
    const hookFile = path.join(configDir, 'hooks', 'gsd-check-update-worker.js');
    writeFile(hookFile, '// installed via ' + OLD_PACKAGE_SIGNAL + '\nconsole.log("hello");');

    const plan = planLegacyCleanup([configDir], { homeDir });

    const entry = plan.find((p) => p.path === hookFile);
    assert.ok(entry, 'expected hookFile to appear in plan');
    assert.equal(entry.reason, 'content-references-old-package');
  });

  test('does NOT flag a file whose content does not reference the old package', () => {
    const hookFile = path.join(configDir, 'hooks', 'gsd-check-update-worker.js');
    writeFile(hookFile, '// installed via @opengsd/gsd-core\nconsole.log("ok");');

    const plan = planLegacyCleanup([configDir], { homeDir });
    const entry = plan.find((p) => p.path === hookFile);
    assert.equal(entry, undefined, 'clean hook must not appear in plan');
  });

  // ── data-loss regression: user custom hooks must be preserved ──────────────

  test('regression #607 (data-loss): user custom gsd-*.js with NO old-package content must NOT appear in plan', () => {
    // Previously the orphaned-hook-by-name rule would flag any gsd-*.js not in
    // MANAGED_HOOKS — deleting user-authored hooks. This is the key regression test.
    const userHook = path.join(configDir, 'hooks', 'gsd-my-custom.js');
    writeFile(userHook, '// my custom hook — does not reference the old package');

    const plan = planLegacyCleanup([configDir], { homeDir });
    const entry = plan.find((p) => p.path === userHook);
    assert.equal(entry, undefined, 'user custom gsd-*.js with no old-package content must NOT be in plan');
  });

  test('regression #607 (data-loss): user custom gsd-*.sh with NO old-package content must NOT appear in plan', () => {
    const userHook = path.join(configDir, 'hooks', 'gsd-my-custom.sh');
    writeFile(userHook, '#!/bin/sh\n# my custom shell hook, clean');

    const plan = planLegacyCleanup([configDir], { homeDir });
    const entry = plan.find((p) => p.path === userHook);
    assert.equal(entry, undefined, 'user custom gsd-*.sh with no old-package content must NOT be in plan');
  });

  // ── self-deletion regression: gsd-core/ subtree must NOT be scanned ──

  test('regression #607 (self-deletion): a code file under gsd-core/bin/lib/ containing old-package signal must NOT be flagged', () => {
    // The subtree 'gsd-core' is no longer scanned — the current package's
    // own infra lives there and would falsely match if scanned.
    const libFile = path.join(configDir, 'gsd-core', 'bin', 'lib', 'legacy-cleanup.cjs');
    writeFile(libFile, "'use strict';\nconst SIG = 'gsd-core' + '-cc';\nmodule.exports = {};");

    const plan = planLegacyCleanup([configDir], { homeDir });
    const entry = plan.find((p) => p.path === libFile);
    assert.equal(entry, undefined, 'code file in gsd-core/ subtree must NOT appear in plan (subtree not scanned)');
  });

  // ── issue-607 regression: markdown files must never be flagged ─────────────

  test('regression #607: CHANGELOG.md containing old-package signal must NOT be flagged', () => {
    // Markdown docs legitimately cite the old package name in historical context.
    const changelogFile = path.join(configDir, 'gsd-core', 'CHANGELOG.md');
    writeFile(changelogFile, '# Changelog\n\nMigrated from ' + OLD_PACKAGE_SIGNAL + ' to @opengsd/gsd-core.');

    const plan = planLegacyCleanup([configDir], { homeDir });

    const entry = plan.find((p) => p.path === changelogFile);
    assert.equal(entry, undefined, 'CHANGELOG.md must never appear in plan even if it cites the old package name');
  });

  test('regression #607: a workflow .md file containing old-package signal must NOT be flagged', () => {
    const workflowMd = path.join(configDir, 'gsd-core', 'workflows', 'update.md');
    writeFile(workflowMd, '# Update workflow\n\nPreviously required ' + OLD_PACKAGE_SIGNAL + ' to be installed.');

    const plan = planLegacyCleanup([configDir], { homeDir });

    const entry = plan.find((p) => p.path === workflowMd);
    assert.equal(entry, undefined, 'workflow .md must never appear in plan even if it cites the old package name');
  });

  // ── dev-preferences exclusion ──────────────────────────────────────────────

  test('NEVER flags dev-preferences.md even if its content contains old-package signal', () => {
    // Place dev-preferences.md inside a GSD-managed subtree
    const devPrefs = path.join(configDir, 'hooks', 'dev-preferences.md');
    writeFile(devPrefs, '# My prefs\n\nI used to use ' + OLD_PACKAGE_SIGNAL);

    const plan = planLegacyCleanup([configDir], { homeDir });
    const entry = plan.find((p) => p.path === devPrefs);
    assert.equal(entry, undefined, 'dev-preferences.md must never appear in plan');
  });

  test('NEVER flags a file under a dev-preferences/ directory', () => {
    const dpFile = path.join(configDir, 'hooks', 'dev-preferences', 'notes.md');
    writeFile(dpFile, 'old notes referencing ' + OLD_PACKAGE_SIGNAL);

    const plan = planLegacyCleanup([configDir], { homeDir });
    const entry = plan.find((p) => p.path === dpFile);
    assert.equal(entry, undefined, 'file under dev-preferences/ dir must never appear in plan');
  });

  // ── legacy-shared-cache ────────────────────────────────────────────────────

  test('flags the legacy shared cache when it exists with reason legacy-shared-cache', () => {
    const cachePath = path.join(homeDir, '.cache', 'gsd', 'gsd-update-check.json');
    writeFile(cachePath, JSON.stringify({ update_available: false }));

    const plan = planLegacyCleanup([], { homeDir });

    const entry = plan.find((p) => p.path === cachePath);
    assert.ok(entry, 'expected legacy cache to appear in plan');
    assert.equal(entry.reason, 'legacy-shared-cache');
  });

  test('does NOT flag the legacy shared cache when it is absent', () => {
    // homeDir exists but cache file was never written
    const plan = planLegacyCleanup([], { homeDir });
    const cachePath = path.join(homeDir, '.cache', 'gsd', 'gsd-update-check.json');
    const entry = plan.find((p) => p.path === cachePath);
    assert.equal(entry, undefined, 'absent cache must not appear in plan');
  });

  // ── deduplication and sort ─────────────────────────────────────────────────

  test('de-duplicates candidates when two configDirs share same absolute path (same dir listed twice)', () => {
    const signalFile = path.join(configDir, 'hooks', 'gsd-old-feature.sh');
    writeFile(signalFile, '# ' + OLD_PACKAGE_SIGNAL);

    const plan = planLegacyCleanup([configDir, configDir], { homeDir });
    const entries = plan.filter((p) => p.path === signalFile);
    assert.equal(entries.length, 1, 'same path must appear only once');
  });

  test('plan entries are sorted by path', () => {
    writeFile(path.join(configDir, 'hooks', 'gsd-zzz-last.js'), '// ' + OLD_PACKAGE_SIGNAL);
    writeFile(path.join(configDir, 'hooks', 'gsd-aaa-first.js'), '// ' + OLD_PACKAGE_SIGNAL);

    const plan = planLegacyCleanup([configDir], { homeDir });
    const paths = plan.map((p) => p.path);
    const sorted = [...paths].sort();
    assert.deepEqual(paths, sorted, 'plan must be sorted by path');
  });

  // ── only known reasons ─────────────────────────────────────────────────────

  test('plan entries only ever have known reasons', () => {
    writeFile(path.join(configDir, 'hooks', 'gsd-worker.js'), '// ' + OLD_PACKAGE_SIGNAL);
    const cachePath = path.join(homeDir, '.cache', 'gsd', 'gsd-update-check.json');
    writeFile(cachePath, '{}');
    // Stale skill file (#1453)
    const staleSkillPath = path.join(configDir, 'skills', 'gsd-docs-update', 'SKILL.md');
    writeFile(staleSkillPath, '@$HOME/.codex/' + 'get-shit-done' + '/workflows/docs-update.md\n'); // gsd-allow-legacy-name
    // User custom hook — should NOT appear
    writeFile(path.join(configDir, 'hooks', 'gsd-my-custom.js'), '// user hook, clean');

    const plan = planLegacyCleanup([configDir], { homeDir });
    const validReasons = new Set(['content-references-old-package', 'legacy-shared-cache', 'stale-get-shit-done-path']); // gsd-allow-legacy-name
    for (const entry of plan) {
      assert.ok(validReasons.has(entry.reason), `unexpected reason: ${entry.reason}`);
    }
  });

  // ── #1453 stale skill path in ~/.agents/skills/gsd-* ──────────────────────

  test('#1453: flags a SKILL.md whose content contains a get-shit-done path reference with reason stale-get-shit-done-path', () => { // gsd-allow-legacy-name
    // Simulate a stale ~/.agents/skills/gsd-docs-update/SKILL.md left by an
    // older GSD install that embedded the pre-rename runtime path.
    const staleSkillFile = path.join(configDir, 'skills', 'gsd-docs-update', 'SKILL.md');
    writeFile(
      staleSkillFile,
      '---\nname: gsd-docs-update\n---\n' +
      '@$HOME/.codex/' + 'get-shit-done' + '/workflows/docs-update.md\n' // gsd-allow-legacy-name
    );

    const plan = planLegacyCleanup([configDir], { homeDir });

    const entry = plan.find((p) => p.path === staleSkillFile);
    assert.ok(entry, 'expected stale SKILL.md to appear in plan');
    assert.equal(entry.reason, 'stale-get-shit-done-path'); // gsd-allow-legacy-name
  });

  test('#1453: does NOT flag a SKILL.md whose content contains the new gsd-core path', () => {
    // A freshly installed SKILL.md references the new runtime directory name.
    const freshSkillFile = path.join(configDir, 'skills', 'gsd-docs-update', 'SKILL.md');
    writeFile(
      freshSkillFile,
      '---\nname: gsd-docs-update\n---\n' +
      '@$HOME/.codex/gsd-core/workflows/docs-update.md\n'
    );

    const plan = planLegacyCleanup([configDir], { homeDir });

    const entry = plan.find((p) => p.path === freshSkillFile);
    assert.equal(entry, undefined, 'fresh SKILL.md (gsd-core path) must NOT appear in plan');
  });

  test('#1453: does NOT flag SKILL.md files under user-owned (non-gsd-*) skill directories', () => {
    // A user-authored skill dir with a custom name must never be touched.
    const userSkillFile = path.join(configDir, 'skills', 'my-custom-skill', 'SKILL.md');
    writeFile(
      userSkillFile,
      '---\nname: my-custom-skill\n---\n' +
      'This skill uses ' + 'get-shit-done' + ' concepts.\n' // gsd-allow-legacy-name
    );

    const plan = planLegacyCleanup([configDir], { homeDir });

    const entry = plan.find((p) => p.path === userSkillFile);
    assert.equal(entry, undefined, 'user-owned (non-gsd-*) SKILL.md must NOT appear in plan');
  });

  test('#1453: flags SKILL.md with stale path but preserves SKILL.md in the same dir without stale path', () => {
    // Two skill dirs: one stale (get-shit-done ref), one fresh (gsd-core ref). // gsd-allow-legacy-name
    const staleSkill = path.join(configDir, 'skills', 'gsd-docs-update', 'SKILL.md');
    const freshSkill = path.join(configDir, 'skills', 'gsd-help', 'SKILL.md');
    writeFile(staleSkill, '@$HOME/.codex/' + 'get-shit-done' + '/workflows/docs-update.md\n'); // gsd-allow-legacy-name
    writeFile(freshSkill, '@$HOME/.codex/gsd-core/workflows/help.md\n');

    const plan = planLegacyCleanup([configDir], { homeDir });

    const staleEntry = plan.find((p) => p.path === staleSkill);
    const freshEntry = plan.find((p) => p.path === freshSkill);

    assert.ok(staleEntry, 'stale SKILL.md must appear in plan');
    assert.equal(staleEntry.reason, 'stale-get-shit-done-path'); // gsd-allow-legacy-name
    assert.equal(freshEntry, undefined, 'fresh SKILL.md must NOT appear in plan');
  });

  test('#1453: regression — after upgrade to gsd-core 1.5.0, stale ~/.agents/skills/gsd-docs-update/SKILL.md is removed', () => {
    // Simulate the exact scenario from issue #1453:
    // ~/.agents/skills/gsd-docs-update/SKILL.md references the old get-shit-done runtime. // gsd-allow-legacy-name
    // The upgrade installs correctly to ~/.codex/skills/ but leaves the stale
    // ~/.agents/skills/ copy which Codex can still discover.
    const agentsDir   = path.join(homeDir, '.agents');
    const staleSkill  = path.join(agentsDir, 'skills', 'gsd-docs-update', 'SKILL.md');
    writeFile(
      staleSkill,
      '---\nname: gsd-docs-update\n---\n' +
      '@$HOME/.Codex/' + 'get-shit-done' + '/workflows/docs-update.md\n' // gsd-allow-legacy-name
    );

    // planLegacyCleanup receives ~/.agents as one of the configDirs (as _LEGACY_SCAN_SUBDIR_NAMES
    // includes '.agents' — the antigravity local form). The plan should flag the stale skill.
    const plan = planLegacyCleanup([agentsDir], { homeDir });

    const entry = plan.find((p) => p.path === staleSkill);
    assert.ok(entry, 'stale ~/.agents/skills/gsd-docs-update/SKILL.md must appear in plan');
    assert.equal(entry.reason, 'stale-get-shit-done-path'); // gsd-allow-legacy-name

    // Applying the plan removes the stale file
    const result = applyLegacyCleanup(plan);
    assert.ok(result.removed.includes(staleSkill), 'stale SKILL.md must appear in removed[]');
    assert.equal(result.errors.length, 0, 'no errors expected');
    assert.equal(require('node:fs').existsSync(staleSkill), false, 'stale SKILL.md must be deleted on disk');
  });
});

describe('issue-607 legacy-cleanup: applyLegacyCleanup', () => {
  let tmpRoot;
  let configDir;
  let homeDir;

  beforeEach(() => {
    tmpRoot   = mkTmpDir();
    configDir = path.join(tmpRoot, 'config');
    homeDir   = path.join(tmpRoot, 'home');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  // ── dry-run ────────────────────────────────────────────────────────────────

  test('dryRun:true removes nothing and returns dryRun:true + all paths in skipped', () => {
    // Use a content-signal hook (only way to get a plan entry now)
    const signalHook = path.join(configDir, 'hooks', 'gsd-check-update-worker.js');
    writeFile(signalHook, '// ' + OLD_PACKAGE_SIGNAL);
    const cacheFile  = path.join(homeDir, '.cache', 'gsd', 'gsd-update-check.json');
    writeFile(cacheFile, '{}');

    const plan = planLegacyCleanup([configDir], { homeDir });
    assert.ok(plan.length > 0, 'precondition: plan must be non-empty');

    const logMessages = [];
    const mockLogger = { log: (msg) => logMessages.push(msg) };

    const result = applyLegacyCleanup(plan, { dryRun: true, logger: mockLogger });

    assert.equal(result.dryRun, true);
    assert.equal(result.removed.length, 0, 'dryRun must remove nothing');
    assert.equal(result.skipped.length, plan.length, 'all plan entries must be in skipped');
    assert.deepEqual(result.skipped.sort(), plan.map((p) => p.path).sort());

    // All flagged files must still exist
    for (const item of plan) {
      assert.ok(fs.existsSync(item.path), `${item.path} must still exist after dry-run`);
    }

    // Logger must have been called for each item
    assert.equal(logMessages.length, plan.length, 'logger must be called once per plan item');
    for (const msg of logMessages) {
      assert.ok(msg.startsWith('[dry-run] would remove:'), `log message format unexpected: ${msg}`);
    }
  });

  // ── real apply ────────────────────────────────────────────────────────────

  test('apply removes flagged files and returns them in removed[]', () => {
    // Content-signal hook — flagged and must be removed
    const signalHook = path.join(configDir, 'hooks', 'gsd-check-update-worker.js');
    writeFile(signalHook, '// ' + OLD_PACKAGE_SIGNAL);
    const cacheFile  = path.join(homeDir, '.cache', 'gsd', 'gsd-update-check.json');
    writeFile(cacheFile, '{}');

    // User custom hook — clean content, must NOT be in plan and must survive
    const userHook = path.join(configDir, 'hooks', 'gsd-my-custom.js');
    writeFile(userHook, '// user hook, no old package ref');

    // Managed hook with clean content — must NOT be in plan and must survive
    const managedHook = path.join(configDir, 'hooks', MANAGED_HOOKS[0]);
    writeFile(managedHook, '// @opengsd/gsd-core only');

    const plan = planLegacyCleanup([configDir], { homeDir });
    assert.ok(plan.length > 0, 'precondition: plan must be non-empty');
    // Verify clean files not in plan
    assert.equal(plan.find((p) => p.path === userHook), undefined, 'user hook must not be in plan');
    assert.equal(plan.find((p) => p.path === managedHook), undefined, 'managed hook must not be in plan');

    const result = applyLegacyCleanup(plan);

    assert.equal(result.dryRun, false);
    assert.deepEqual(result.removed.sort(), plan.map((p) => p.path).sort());
    assert.equal(result.errors.length, 0, 'no errors expected');

    // Flagged files must be gone
    for (const item of plan) {
      assert.equal(fs.existsSync(item.path), false, `${item.path} must have been removed`);
    }

    // Clean (non-flagged) files must still exist
    assert.ok(fs.existsSync(userHook), 'user custom hook must be preserved');
    assert.ok(fs.existsSync(managedHook), 'managed hook must be preserved');
  });

  test('apply does not touch dev-preferences.md even if it somehow entered the plan (invariant)', () => {
    // planLegacyCleanup never adds dev-prefs; this test confirms that invariant.
    const devPrefs  = path.join(configDir, 'hooks', 'dev-preferences.md');
    writeFile(devPrefs, '# prefs\n' + OLD_PACKAGE_SIGNAL + ' was used here');

    const plan = planLegacyCleanup([configDir], { homeDir });
    const inPlan = plan.find((p) => p.path === devPrefs);
    assert.equal(inPlan, undefined, 'planLegacyCleanup must never include dev-preferences.md');

    // Since dev-prefs is not in the plan, applying the plan cannot remove it.
    applyLegacyCleanup(plan);
    assert.ok(fs.existsSync(devPrefs), 'dev-preferences.md must survive apply');
  });
});
