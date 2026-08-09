/**
 * Regression tests for bug #2136
 *
 * gsd-check-update-worker.js uses a MANAGED_HOOKS array (now in the shared
 * managed-hooks-registry.cjs module) to detect stale hooks after a GSD update.
 * It must list every hook file that GSD ships so that all deployed hooks are
 * checked for staleness — not just the .js ones.
 *
 * The original bug: the 3 bash hooks (gsd-phase-boundary.sh,
 * gsd-session-state.sh, gsd-validate-commit.sh) were missing from
 * MANAGED_HOOKS, so they would never be detected as stale after an update.
 *
 * Migration note (#455): previously used fs.readFileSync + regex on the worker
 * source to extract the array. Now requires the typed export directly from
 * hooks/managed-hooks-registry.cjs.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
// Typed import — no source-grep needed (#455)
const { MANAGED_HOOKS } = require(path.join(HOOKS_DIR, 'managed-hooks-registry.cjs'));

describe('bug #2136: MANAGED_HOOKS must include all shipped hook files', () => {
  // List all GSD-managed hook files in hooks/ (names starting with "gsd-")
  const shippedHooks = fs.readdirSync(HOOKS_DIR)
    .filter(f => f.startsWith('gsd-') && (f.endsWith('.js') || f.endsWith('.sh')));

  test('MANAGED_HOOKS is a non-empty array', () => {
    assert.ok(Array.isArray(MANAGED_HOOKS), 'MANAGED_HOOKS must be an array');
    assert.ok(MANAGED_HOOKS.length > 0, 'MANAGED_HOOKS must not be empty');
  });

  test('every shipped gsd-*.js hook is in MANAGED_HOOKS', () => {
    const jsHooks = shippedHooks.filter(f => f.endsWith('.js'));
    for (const hookFile of jsHooks) {
      assert.ok(
        MANAGED_HOOKS.includes(hookFile),
        `${hookFile} is shipped in hooks/ but missing from MANAGED_HOOKS in managed-hooks-registry.cjs`
      );
    }
  });

  test('every shipped gsd-*.sh hook is in MANAGED_HOOKS', () => {
    const shHooks = shippedHooks.filter(f => f.endsWith('.sh'));
    for (const hookFile of shHooks) {
      assert.ok(
        MANAGED_HOOKS.includes(hookFile),
        `${hookFile} is shipped in hooks/ but missing from MANAGED_HOOKS in managed-hooks-registry.cjs`
      );
    }
  });

  test('MANAGED_HOOKS contains no entries for hooks that do not exist', () => {
    for (const entry of MANAGED_HOOKS) {
      const exists = fs.existsSync(path.join(HOOKS_DIR, entry));
      assert.ok(
        exists,
        `MANAGED_HOOKS entry '${entry}' has no corresponding file in hooks/ — remove stale entry`
      );
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2136-sh-hook-version.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2136-sh-hook-version (consolidation epic #1969 B6 #1975)", () => {
  // Consolidation #1969: this block spawns a REAL install and asserts side effects.
  // The host suite sets GSD_TEST_MODE=1 at collection time, which the install child
  // inherits via process.env and which suppresses hook/skill writes. Clear it for
  // this block's duration (standalone had it unset); restore after.
  const { before: __gtmBefore, after: __gtmAfter } = require('node:test');
  let __savedGsdTestMode;
  __gtmBefore(() => { __savedGsdTestMode = process.env.GSD_TEST_MODE; delete process.env.GSD_TEST_MODE; });
  __gtmAfter(() => { if (__savedGsdTestMode === undefined) delete process.env.GSD_TEST_MODE; else process.env.GSD_TEST_MODE = __savedGsdTestMode; });

// allow-test-rule: structural-regression-guard (see #2136)
// The shebang line must be `#!/usr/bin/env bash` (PATH-resolved) rather than
// `#!/bin/bash` for cross-distro portability (NixOS, minimal Alpine do not
// ship /bin/bash). This is an architectural constraint that cannot be verified
// by executing the hooks — they run fine with either shebang on distros that
// have /bin/bash, so only a source assertion catches a future regression.

/**
 * Regression tests for bug #2136 / #2206
 *
 * Root cause: three bash hooks (gsd-phase-boundary.sh, gsd-session-state.sh,
 * gsd-validate-commit.sh) shipped without a gsd-hook-version header, and the
 * stale-hook detector in gsd-check-update.js only matched JavaScript comment
 * syntax (//) — not bash comment syntax (#).
 *
 * Result: every session showed "⚠ stale hooks — run /gsd-update" immediately
 * after a fresh install, because the detector saw hookVersion: 'unknown' for
 * all three bash hooks.
 *
 * This fix requires THREE parts working in concert:
 *   1. Bash hooks ship with "# gsd-hook-version: {{GSD_VERSION}}"
 *   2. install.js substitutes {{GSD_VERSION}} in .sh files at install time
 *   3. gsd-check-update.js regex matches both "//" and "#" comment styles
 *
 * Neither fix alone is sufficient:
 *   - Headers + regex fix only (no install.js fix): installed hooks contain
 *     literal "{{GSD_VERSION}}" — the {{-guard silently skips them, making
 *     bash hook staleness permanently undetectable after future updates.
 *   - Headers + install.js fix only (no regex fix): installed hooks are
 *     stamped correctly but the detector still can't read bash "#" comments,
 *     so they still land in the "unknown / stale" branch on every session.
 */

'use strict';

// NOTE: Do NOT set GSD_TEST_MODE here — the E2E install tests spawn the
// real installer subprocess, which skips all install logic when GSD_TEST_MODE=1.

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const _CHECK_UPDATE_FILE = path.join(HOOKS_DIR, 'gsd-check-update.js');
const WORKER_FILE = path.join(HOOKS_DIR, 'gsd-check-update-worker.js');
const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { INSTALL_TIMEOUT_MS, PROBE_TIMEOUT_MS, BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const SH_HOOKS = [
  'gsd-phase-boundary.sh',
  'gsd-session-state.sh',
  'gsd-validate-commit.sh',
];

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────

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

function runInstaller(configDir) {
  // --no-sdk: this test covers .sh hook version stamping only; skip SDK
  // build (covered by install-smoke.yml).
  throwIfFailed(
    runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, timeoutMs: INSTALL_TIMEOUT_MS },
    ),
    `node ${INSTALL_SCRIPT} --claude --global --yes --no-sdk`,
  );
  return path.join(configDir, 'hooks');
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: Bash hook sources carry the version header placeholder
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2136 part 1: bash hook sources carry gsd-hook-version placeholder', () => {
  for (const sh of SH_HOOKS) {
    test(`${sh} contains "# gsd-hook-version: {{GSD_VERSION}}"`, () => {
      const content = fs.readFileSync(path.join(HOOKS_DIR, sh), 'utf8');
      assert.ok(
        content.includes('# gsd-hook-version: {{GSD_VERSION}}'),
        `${sh} must include "# gsd-hook-version: {{GSD_VERSION}}" so the ` +
        `installer can stamp it and gsd-check-update.js can detect staleness`
      );
    });
  }

  test('version header is on line 2 (immediately after shebang)', () => {
    // Placing the header immediately after the shebang ensures it is always
    // found regardless of how much of the file is read. The shebang itself
    // must use `#!/usr/bin/env bash` (PATH-resolved) rather than `#!/bin/bash`
    // — POSIX guarantees /bin/sh but not /bin/bash, and distros like NixOS
    // do not ship /bin/bash by default.
    for (const sh of SH_HOOKS) {
      const lines = fs.readFileSync(path.join(HOOKS_DIR, sh), 'utf8').split(/\r?\n/);
      assert.strictEqual(
        lines[0],
        '#!/usr/bin/env bash',
        `${sh} line 1 must be "#!/usr/bin/env bash" for cross-distro portability`
      );
      assert.ok(
        lines[1].startsWith('# gsd-hook-version:'),
        `${sh} line 2 must be the gsd-hook-version header (got: "${lines[1]}")`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: gsd-check-update-worker.js regex handles bash "#" comment syntax
// (Logic moved from inline -e template literal to dedicated worker file)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2136 part 2: stale-hook detector handles bash comment syntax', () => {
  let src;

  before(() => {
    src = fs.readFileSync(WORKER_FILE, 'utf8');
  });

  test('version regex in source matches "#" comment syntax in addition to "//"', () => {
    // The regex string in the source must contain the alternation for "#".
    // The worker uses plain JS (no template-literal escaping), so the form is
    // "(?:\/\/|#)" directly in source.
    const hasBashAlternative =
      src.includes('(?:\\/\\/|#)') ||     // escaped form (old template-literal style)
      src.includes('(?://|#)');          // direct form in plain JS worker
    assert.ok(
      hasBashAlternative,
      'gsd-check-update-worker.js version regex must include an alternative for bash "#" comments. ' +
      'Expected to find (?:\\/\\/|#) or (?://|#) in the source. ' +
      'The original "//" only regex causes bash hooks to always report hookVersion: "unknown"'
    );
  });

  test('version regex does not use the old JS-only form as the sole pattern', () => {
    // The old regex inside the template literal was the string:
    //   /\\/\\/ gsd-hook-version:\\s*(.+)/
    // which, when evaluated in the subprocess, produced: /\/\/ gsd-hook-version:\s*(.+)/
    // That only matched JS "//" comments — never bash "#".
    // We verify that the old exact string no longer appears.
    assert.ok(
      !src.includes('\\/\\/ gsd-hook-version'),
      'gsd-check-update-worker.js must not use the old JS-only (\\/\\/ gsd-hook-version) ' +
      'escape form as the sole version matcher — it cannot match bash "#" comments'
    );
  });

  test('version regex correctly matches both bash and JS hook version headers', () => {
    // Verify that the versionMatch line in the source uses a regex that matches
    // both bash "#" and JS "//" comment styles. We check the source contains the
    // expected alternation, then directly test the known required pattern.
    //
    // We do NOT try to extract and evaluate the regex from source (it contains ")"
    // which breaks simple extraction), so instead we confirm the source matches
    // our expectation and run the regex itself.
    assert.ok(
      src.includes('gsd-hook-version'),
      'gsd-check-update-worker.js must contain a gsd-hook-version version check'
    );

    // The fixed regex that must be present: matches both comment styles
    const fixedRegex = /(?:\/\/|#) gsd-hook-version:\s*(.+)/;

    assert.ok(
      fixedRegex.test('# gsd-hook-version: 1.36.0'),
      'bash-style "# gsd-hook-version: X" must be matchable by the required regex'
    );
    assert.ok(
      fixedRegex.test('// gsd-hook-version: 1.36.0'),
      'JS-style "// gsd-hook-version: X" must still match (no regression)'
    );
    assert.ok(
      !fixedRegex.test('gsd-hook-version: 1.36.0'),
      'line without a comment prefix must not match (prevents false positives)'
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Part 4: End-to-end — installed .sh hooks have stamped version, not placeholder
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2136 part 4: installed .sh hooks contain stamped concrete version', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-2136-install-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('installed .sh hooks contain a concrete version string, not the template placeholder', () => {
    const hooksDir = runInstaller(tmpDir);

    for (const sh of SH_HOOKS) {
      const hookPath = path.join(hooksDir, sh);
      assert.ok(fs.existsSync(hookPath), `${sh} must be installed`);

      const content = fs.readFileSync(hookPath, 'utf8');

      assert.ok(
        content.includes('# gsd-hook-version:'),
        `installed ${sh} must contain a "# gsd-hook-version:" header`
      );
      assert.ok(
        !content.includes('{{GSD_VERSION}}'),
        `installed ${sh} must not contain literal "{{GSD_VERSION}}" — ` +
        `install.js must substitute it with the concrete package version`
      );

      const versionMatch = content.match(/# gsd-hook-version:\s*(\S+)/);
      assert.ok(versionMatch, `installed ${sh} version header must have a version value`);
      assert.match(
        versionMatch[1],
        /^\d+\.\d+\.\d+/,
        `installed ${sh} version "${versionMatch[1]}" must be a semver-like string`
      );
    }
  });

  test('stale-hook detector reports zero stale bash hooks immediately after fresh install', () => {
    // This is the definitive end-to-end proof: after install, run the actual
    // version-check logic (extracted from gsd-check-update.js) against the
    // installed hooks and verify none are flagged stale.
    const hooksDir = runInstaller(tmpDir);
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    const installedVersion = pkg.version;

    // Build a subprocess that runs the staleness check logic in isolation.
    // We pass the installed version, hooks dir, and hook filenames as JSON
    // to avoid any injection risk.
    const checkScript = `
      'use strict';
      const fs = require('fs');
      const path = require('path');

      function isNewer(a, b) {
        const pa = (a || '').split('.').map(s => Number(s.replace(/-.*/, '')) || 0);
        const pb = (b || '').split('.').map(s => Number(s.replace(/-.*/, '')) || 0);
        for (let i = 0; i < 3; i++) {
          if (pa[i] > pb[i]) return true;
          if (pa[i] < pb[i]) return false;
        }
        return false;
      }

      const hooksDir = ${JSON.stringify(hooksDir)};
      const installed = ${JSON.stringify(installedVersion)};
      const shHooks = ${JSON.stringify(SH_HOOKS)};
      // Use the same regex that the fixed gsd-check-update.js uses
      const versionRe = /(?:\\/\\/|#) gsd-hook-version:\\s*(.+)/;

      const staleHooks = [];
      for (const hookFile of shHooks) {
        const hookPath = path.join(hooksDir, hookFile);
        if (!fs.existsSync(hookPath)) {
          staleHooks.push({ file: hookFile, hookVersion: 'missing' });
          continue;
        }
        const content = fs.readFileSync(hookPath, 'utf8');
        const m = content.match(versionRe);
        if (m) {
          const hookVersion = m[1].trim();
          if (isNewer(installed, hookVersion) && !hookVersion.includes('{{')) {
            staleHooks.push({ file: hookFile, hookVersion, installedVersion: installed });
          }
        } else {
          staleHooks.push({ file: hookFile, hookVersion: 'unknown', installedVersion: installed });
        }
      }
      process.stdout.write(JSON.stringify(staleHooks));
    `;

    const probeResult = runNode(['-e', checkScript], { timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(probeResult, 'node -e <bug-2136 stale-hook probe script>');
    const staleHooks = JSON.parse(probeResult.stdout);

    assert.deepStrictEqual(
      staleHooks,
      [],
      `Fresh install must produce zero stale bash hooks.\n` +
      `Got: ${JSON.stringify(staleHooks, null, 2)}\n` +
      `This indicates either the version header was not stamped by install.js, ` +
      `or the detector regex cannot match bash "#" comment syntax.`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-941-managed-hooks-registry-manifest.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-941-managed-hooks-registry-manifest (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression test for bug #941
 *
 * `managed-hooks-registry.cjs` is shipped alongside gsd-check-update-worker.js
 * in hooks/dist/ (it is listed in HOOKS_TO_COPY in scripts/build-hooks.js).
 * However, the manifest-writing loop in bin/install.js gated on
 *   file.startsWith('gsd-') && (file.endsWith('.js') || file.endsWith('.sh'))
 * — which `managed-hooks-registry.cjs` fails on both predicates (wrong prefix,
 * .cjs extension).  The result: after every install, `detect-custom-files`
 * found the installed file in the hooks/ dir but had no manifest entry for it
 * and reported a perpetual false-positive "Found 1 custom file(s)" warning on
 * every `/gsd-update`.
 *
 * Fix: drive the manifest hooks loop from HOOKS_TO_COPY (the canonical build
 * set), so the manifest set is structurally identical to what was installed.
 *
 * Closes: #941
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const crypto = require('node:crypto');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const MANIFEST_NAME = 'gsd-file-manifest.json';
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { INSTALL_TIMEOUT_MS, PROBE_TIMEOUT_MS, BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const { HOOKS_TO_COPY } = require('../scripts/build-hooks.js');

// ─── Ensure hooks/dist/ is populated before any install test ────────────────

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
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup helper, swallows ENOENT
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Run the installer targeting a temp directory as the claude global config dir.
 * Returns the path to configDir.
 */
function runInstaller(configDir) {
  // Clear GSD_TEST_MODE so the installer's main() block actually runs.
  // The test file sets GSD_TEST_MODE=1 (top of file) to suppress in-process
  // import side effects, but when install.js is spawned as a subprocess it
  // must not skip the main() gate or the install is a no-op.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.GSD_TEST_MODE;
  throwIfFailed(
    runNode(
      [INSTALL_SCRIPT, '--claude', '--global', '--yes'],
      { env, timeoutMs: INSTALL_TIMEOUT_MS },
    ),
    `node ${INSTALL_SCRIPT} --claude --global --yes`,
  );
  return configDir;
}

/**
 * Run detect-custom-files and return parsed JSON output.
 */
function detectCustomFiles(configDir) {
  const result = runNode(
    [TOOLS_PATH, 'detect-custom-files', '--config-dir', configDir],
    { env: { ...process.env, GSD_SESSION_KEY: '' }, timeoutMs: PROBE_TIMEOUT_MS },
  );
  throwIfFailed(result, `node ${TOOLS_PATH} detect-custom-files --config-dir ${configDir}`);
  return JSON.parse(result.stdout.trim());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('bug #941 — managed-hooks-registry.cjs recorded in file manifest', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-bug-941-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('managed-hooks-registry.cjs appears in gsd-file-manifest.json after install', () => {
    runInstaller(tmpDir);

    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    assert.ok(
      fs.existsSync(manifestPath),
      `${MANIFEST_NAME} must exist after install (not found at ${manifestPath})`,
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.ok(
      typeof manifest.files === 'object' && manifest.files !== null,
      'manifest must have a files map',
    );

    // The key must use forward slashes (cross-platform manifest format)
    const key = 'hooks/managed-hooks-registry.cjs';
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest.files, key),
      [
        `manifest.files must contain '${key}' — managed-hooks-registry.cjs is`,
        'shipped to users but was not recorded in the manifest, causing',
        `detect-custom-files to flag it as a perpetual false-positive custom file.`,
        `Actual manifest hook keys: ${Object.keys(manifest.files).filter(k => k.startsWith('hooks/')).join(', ')}`,
      ].join(' '),
    );
  });

  test('gsd-file-manifest.json covers the full HOOKS_TO_COPY set (forward-proof)', () => {
    runInstaller(tmpDir);

    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    assert.ok(fs.existsSync(manifestPath), `${MANIFEST_NAME} must exist after install`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const hooksDir = path.join(tmpDir, 'hooks');

    // Every hook in HOOKS_TO_COPY that was actually installed must have a
    // manifest entry. This assertion is forward-proof: adding any new hook to
    // HOOKS_TO_COPY without updating the manifest loop will fail this test.
    for (const hook of HOOKS_TO_COPY) {
      const installed = path.join(hooksDir, hook);
      if (!fs.existsSync(installed)) {
        // Skip hooks that weren't installed (e.g. .sh hooks on non-unix skip
        // chmod but still install — only skip if truly absent).
        continue;
      }
      const key = `hooks/${hook}`;
      assert.ok(
        Object.prototype.hasOwnProperty.call(manifest.files, key),
        [
          `manifest.files must contain '${key}'.`,
          `HOOKS_TO_COPY lists '${hook}' and it was installed, but the manifest`,
          `loop in writeManifest() did not record it.`,
          `Actual manifest hook keys: ${Object.keys(manifest.files).filter(k => k.startsWith('hooks/')).join(', ')}`,
        ].join(' '),
      );
    }
  });

  test('detect-custom-files reports zero custom files after a clean install (no false positives)', () => {
    runInstaller(tmpDir);

    let detected;
    try {
      detected = detectCustomFiles(tmpDir);
    } catch (err) {
      assert.fail(
        `detect-custom-files failed: ${err.message}\nstderr: ${err.stderr || '(none)'}`,
      );
    }

    assert.ok(
      detected.manifest_found,
      'detect-custom-files must find the manifest after install',
    );

    const hookCustomFiles = (detected.custom_files || []).filter(f => f.startsWith('hooks/'));
    assert.strictEqual(
      hookCustomFiles.length,
      0,
      [
        `detect-custom-files must report 0 custom hook files after a clean install, but got ${hookCustomFiles.length}:`,
        JSON.stringify(hookCustomFiles, null, 2),
        'This is the perpetual false-positive bug #941 — hooks in HOOKS_TO_COPY that',
        'were not recorded in the manifest appear as custom files.',
      ].join('\n'),
    );
  });

  test('manifest hook keys use forward slashes (cross-platform compatibility)', () => {
    runInstaller(tmpDir);

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, MANIFEST_NAME), 'utf-8'));
    const hookKeys = Object.keys(manifest.files).filter(k => k.startsWith('hooks/'));

    assert.ok(hookKeys.length > 0, 'manifest must contain at least one hooks/ entry');

    for (const key of hookKeys) {
      assert.ok(
        !key.includes('\\'),
        `manifest key '${key}' must use forward slashes, not backslashes`,
      );
    }
  });

  test('manifest hash for managed-hooks-registry.cjs matches the installed file contents', () => {
    // Strengthened assertion: proves the manifest not only records the right KEY
    // but stores a hash that matches the ACTUAL installed file bytes.  A future
    // refactor that records the key from the wrong path/content would fail here
    // even if the key is present.
    runInstaller(tmpDir);

    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    const key = 'hooks/managed-hooks-registry.cjs';
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest.files, key),
      `manifest.files must contain '${key}' before hash comparison`,
    );

    // Recompute the hash the same way the installer's fileHash() does:
    // sha256 of the raw file bytes as a hex string.
    const installedPath = path.join(tmpDir, 'hooks', 'managed-hooks-registry.cjs');
    assert.ok(
      fs.existsSync(installedPath),
      `installed file must exist at ${installedPath}`,
    );
    const actualHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(installedPath))
      .digest('hex');

    assert.strictEqual(
      manifest.files[key],
      actualHash,
      [
        `manifest hash for '${key}' does not match the installed file's actual contents.`,
        `This means writeManifest() hashed the wrong path or wrong content.`,
        `Expected (from installed file): ${actualHash}`,
        `Got (from manifest):            ${manifest.files[key]}`,
      ].join('\n'),
    );
  });
});
  });
}
