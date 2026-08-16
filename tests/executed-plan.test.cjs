'use strict';

/**
 * Executed-plan return + fs adapter seam — failing-first tests.
 *
 * #2874 (epic #2866 Phase 5), governed by ADR-58
 * (docs/adr/58-runtime-install-policy-module.md).
 *
 * Design:      .gsd/phase/feat-2874-executed-plan-return/40-design.md
 * Test matrix: .gsd/phase/feat-2874-executed-plan-return/50-test-matrix.md
 *
 * This file implements the Red-first order's rows 1-3 from 50-test-matrix.md:
 *   - E3  (section E, "Executed-plan return shape"): the opencode-family
 *     early return must ALSO return an executed plan, not `undefined`.
 *   - E13 (section E): every runtime in the capability registry must return
 *     something other than `undefined` — the completeness sweep proving the
 *     contract has no per-runtime holes.
 *   - F2  (section F, "Fs adapter seam"): a full install driven by an
 *     injected fake adapter must touch zero real filesystem paths.
 *
 * All three are RED against the current tree: `installRuntimeArtifacts`
 * (src/install-engine.cts:750) still returns `void` and accepts no `deps`/
 * adapter parameter to route IO through. No production code is touched here
 * — this package is tests only.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createTempDir, cleanup } = require('./helpers.cjs');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

/**
 * Sandbox HOME/USERPROFILE for the duration of a test. Some runtimes (e.g.
 * codex) resolve a kind's `home` via os.homedir(); without this, an
 * in-process install would write into the developer's real home directory.
 * Mirrors tests/install-runtime-artifacts.test.cjs's sandboxHome().
 */
function sandboxHome(t, dir) {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });
}

// ─── E3 — the opencode-family early return (matrix row E3) ──────────────────

describe('installRuntimeArtifacts — E3: opencode-family early return', () => {
  test('family install still returns a plan', (t) => {
    const configDir = createTempDir('gsd-e3-opencode-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('opencode', configDir, 'global', RESOLVED_CORE);

    assert.notStrictEqual(
      result,
      undefined,
      'E3: the combinedFamilyInstall early return (install-engine.cts:774) must return an ' +
      'executed plan, not undefined — a whole runtime family returning undefined is a hole ' +
      'in the contract, not an exemption (40-design.md behavior table row 2)',
    );
  });
});

// ─── E13 — the all-runtimes sweep (matrix row E13) ───────────────────────────

describe('installRuntimeArtifacts — E13: no runtime returns undefined', () => {
  const RUNTIMES = Object.keys(registry.runtimes);

  test('registry enumerates at least one runtime to sweep', () => {
    assert.ok(RUNTIMES.length > 0, 'capability-registry.cjs runtimes must be non-empty');
  });

  for (const runtime of RUNTIMES) {
    test(`${runtime}: installRuntimeArtifacts does not return undefined`, (t) => {
      const configDir = createTempDir(`gsd-e13-${runtime}-`);
      t.after(() => cleanup(configDir));
      sandboxHome(t, configDir);

      const result = installRuntimeArtifacts(runtime, configDir, 'global', RESOLVED_CORE);

      assert.notStrictEqual(
        result,
        undefined,
        `E13: ${runtime} returned undefined — every runtime in the registry must return an ` +
        'executed plan (40-design.md: "Legitimate undefined returns: none after this phase. ' +
        'If any path can still return undefined, that path is a defect, not an exemption.")',
      );
    });
  }
});

// ─── F2 — zero real filesystem contact (matrix row F2) ───────────────────────

// The write-surface installRuntimeArtifacts's own call tree touches directly,
// per 40-design.md's "Measured starting state" IO table: the direct
// mkdirSync/existsSync/rmSync calls, _copyStaged's readdirSync/cpSync/
// copyFileSync/mkdirSync, _removeGsdEntries's directory scan+delete, and
// _snapshotDir/_restoreDir's read/write of preserved skill dirs, plus the
// symlink-escape guard's lstatSync probe.
const REAL_FS_WRITE_SURFACE = [
  'mkdirSync', 'existsSync', 'rmSync', 'readdirSync',
  'cpSync', 'copyFileSync', 'readFileSync', 'writeFileSync', 'lstatSync',
];

describe('installRuntimeArtifacts — F2: fake-adapter install touches no real filesystem', () => {
  test('fake-adapter install touches no real filesystem', (t) => {
    // Every real fs method this call tree is known to use is poisoned for the
    // duration of this test via node:test's mock tracker (auto-restored when
    // the test ends — no try/finally in the test body, per CONTRIBUTING.md's
    // "Never use try/finally inside test bodies").
    for (const method of REAL_FS_WRITE_SURFACE) {
      t.mock.method(fs, method, () => {
        throw new Error(
          `F2: real fs.${method}() was reached during an install driven by an injected ` +
          'fake adapter — the fs seam does not exist yet (installRuntimeArtifacts accepts ' +
          'no deps/adapter parameter today), so there is no way to route around real fs',
        );
      });
    }

    // A minimal in-memory fake adapter, shaped after the precedent
    // createRuntimeArtifactInstallPlan's existing `deps` bag already sets
    // (40-design.md "Laws that apply" — Gall's Law: grow the seam from the
    // working simple system, do not invent a new one). This fake is never
    // actually reached today: the call throws from a real, poisoned fs
    // method before any deps routing could occur, which is exactly the hole
    // this row exists to prove.
    const store = new Map();
    const fakeFs = {
      existsSync: (p) => store.has(String(p)),
      mkdirSync: (p) => { store.set(String(p), 'dir'); },
      rmSync: (p) => { store.delete(String(p)); },
      readdirSync: () => [],
      cpSync: () => {},
      copyFileSync: () => {},
      readFileSync: () => Buffer.alloc(0),
      writeFileSync: (p, data) => { store.set(String(p), data); },
      lstatSync: () => ({ isSymbolicLink: () => false }),
    };

    // configDir deliberately never created for real — F2 asserts nothing
    // real ever gets written under it.
    const configDir = path.join(os.tmpdir(), `gsd-f2-must-not-exist-${crypto.randomUUID()}`);

    const result = installRuntimeArtifacts(
      'claude', configDir, 'global', RESOLVED_CORE, undefined, undefined,
      { fs: fakeFs },
    );

    assert.notStrictEqual(
      result,
      undefined,
      'F2: a fake-adapter install must still return an executed plan (matrix row F1/E1 shape)',
    );
    // No post-hoc fs.existsSync(configDir) check follows: fs.existsSync is
    // one of the poisoned methods above for the duration of this test, so
    // the proof of "zero real fs contact" IS that installRuntimeArtifacts
    // returned at all without tripping one of the throws — not a probe that
    // would itself have to touch the poisoned surface.
  });
});
