'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3799 — legacy cleanup must honor the install's resolved destination.
//
// `install()` called `cleanupLegacyGsdCc({ dryRun: false })` with no
// arguments, so the scan always ran against `os.homedir()` +
// `_LEGACY_SCAN_SUBDIR_NAMES` — an install redirected with `--config-dir
// ~/.sandbox` planned removals of a LIVE legacy install under the DEFAULT
// home (the reporter's dry-run listed 60 default-home paths; a real install
// would have deleted 59 files). The cleanup now accepts an explicit
// `configDirs` scope (install() passes `[targetDir]` when --config-dir
// redirected the destination), and `--no-legacy-cleanup` skips the scan.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.GSD_TEST_MODE = '1';

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_BIN = path.join(REPO_ROOT, 'bin', 'install.js');
const { cleanupLegacyGsdCc } = require(INSTALL_BIN);
const { createTempDir, cleanup } = require('./helpers.cjs');

const LEGACY_PKG_SIGNAL = 'get-shit-done-cc';

function seedLegacySkill(configDir) {
  // configDir is a CONFIG DIR root (like ~/.claude): artifacts live at
  // <configDir>/skills/gsd-*/SKILL.md. The scan's content signal is a stale
  // '/get-shit-done/' PATH reference (legacy-cleanup.cjs  // gsd-allow-legacy-name
  // LEGACY_SKILL_PATH_SIGNAL), not the bare package name.
  const skillDir = path.join(configDir, 'skills', 'gsd-add-tests');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `<!-- installed via ${LEGACY_PKG_SIGNAL} -->\nSee ~/.claude/get-shit-done/skills/gsd-add-tests/SKILL.md\n`, // gsd-allow-legacy-name
  );
  return path.join(skillDir, 'SKILL.md');
}

describe('#3799: cleanupLegacyGsdCc honors an explicit configDirs scope', () => {
  let tmpRoot;
  let defaultHome;
  let sandboxDir;

  beforeEach(() => {
    tmpRoot = createTempDir('gsd-3799-cleanup-');
    defaultHome = path.join(tmpRoot, 'home');
    sandboxDir = path.join(tmpRoot, 'pilot-sandbox');
    fs.mkdirSync(defaultHome, { recursive: true });
    fs.mkdirSync(sandboxDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('#3799: an explicit configDirs scope never plans removals outside it', () => {
    // A LIVE legacy install under the default home (at <home>/.claude, one
    // of _LEGACY_SCAN_SUBDIR_NAMES)…
    const liveArtifact = seedLegacySkill(path.join(defaultHome, '.claude'));
    // …and one stale artifact inside the redirected sandbox.
    const sandboxArtifact = seedLegacySkill(sandboxDir);

    const { plan } = cleanupLegacyGsdCc({
      homeDir: defaultHome,
      configDirs: [sandboxDir],
      dryRun: true,
      logger: { log: () => {} },
    });

    const paths = plan.map((p) => p.path);
    assert.ok(
      paths.every((p) => p.startsWith(sandboxDir)),
      `#3799: every plan entry must live inside the explicit scope; got ${JSON.stringify(paths)}`,
    );
    assert.ok(paths.includes(sandboxArtifact), 'the sandbox artifact is in scope and planned');
    assert.ok(
      !paths.includes(liveArtifact),
      '#3799: the default home\'s live legacy install must not be planned for removal',
    );
    assert.ok(
      fs.existsSync(liveArtifact),
      'dry-run leaves everything in place',
    );
  });

  test('#3799 control: without the override, the home scan is unchanged', () => {
    const liveArtifact = seedLegacySkill(path.join(defaultHome, '.claude'));
    const { plan } = cleanupLegacyGsdCc({
      homeDir: defaultHome,
      dryRun: true,
      logger: { log: () => {} },
    });
    assert.ok(
      plan.map((p) => p.path).includes(liveArtifact),
      'default behavior (no scope) still scans homeDir subdirs as before',
    );
  });
});

describe('#3799: --no-legacy-cleanup and --config-dir CLI flags', () => {
  const HELP_TEXT = fs.readFileSync(INSTALL_BIN, 'utf-8');

  test('the --no-legacy-cleanup flag exists and is documented in --help', () => {
    assert.ok(
      HELP_TEXT.includes('--no-legacy-cleanup'),
      'the escape hatch must be documented in the installer help text',
    );
  });

  test('the install() call site threads the config-dir scope and the skip flag', () => {
    const src = HELP_TEXT; // same file read — the shipped installer source
    // Slice the install() body up to its cleanup call so the conditional
    // spread's braces cannot defeat a single-regex match.
    const fnStart = src.indexOf('function install(isGlobal, runtime = DEFAULT_RUNTIME');
    const callIdx = src.indexOf('cleanupLegacyGsdCc({ dryRun: false', fnStart);
    assert.ok(fnStart > 0 && callIdx > fnStart, 'install() still calls cleanupLegacyGsdCc');
    const callSite = src.slice(callIdx, callIdx + 240);
    assert.ok(
      /configDirs/.test(callSite),
      '#3799: the call site must pass a configDirs scope',
    );
    assert.ok(
      /skipNoLegacyCleanup/.test(src.slice(fnStart, callIdx + 400)),
      '#3799: the call site must honor the --no-legacy-cleanup skip',
    );
  });
});
