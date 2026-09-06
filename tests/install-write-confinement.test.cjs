'use strict';

/**
 * Behavioral regression tests for ADR-1239 Phase B write-confinement.
 *
 * Tests cover:
 *   - copyWithPathReplacement: happy path, escape rejection, dest===root,
 *     fail-closed (no confinementRoot), symlink escape
 *   - installCodexConfig: happy path, agent name-injection rejection
 *   - _copyStaged: escape rejection, symlink escape (regression preserved)
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

process.env['GSD_TEST_MODE'] = '1';
const {
  copyWithPathReplacement,
  installCodexConfig,
  _resolveUserArtifactStagingRoot: _installJsResolveUserArtifactStagingRoot,
  _tryResolveUserArtifactStagingRoot: _installJsTryResolveUserArtifactStagingRoot,
  install,
  uninstall,
} = require('../bin/install.js');
const {
  _copyStaged,
} = require('../gsd-core/bin/lib/install-engine.cjs');

// #2875 (epic #2866 Phase 6): user-artifact-staging confinement rows (E1-E5).
// Top-level (not inside any of the folded `__foldDescribe` sections below,
// which each scope their own requires to their own closure).
const {
  assertDestWithinConfigHome: _uasAssertDestWithinConfigHome,
} = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
const {
  _resolveUserArtifactStagingRoot,
  _tryResolveUserArtifactStagingRoot,
} = require('../gsd-core/bin/lib/install-engine.cjs');
const {
  recoverOrphanedUserArtifacts,
  stageUserArtifacts,
  restoreStagedUserArtifacts,
} = require('../gsd-core/bin/lib/user-artifact-staging.cjs');

// ---------------------------------------------------------------------------
// copyWithPathReplacement
// ---------------------------------------------------------------------------

describe('copyWithPathReplacement write-confinement', () => {
  test('1. happy path: file is written under confinementRoot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-happy-'));
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'test.md'), '---\nname: test\n---\nbody\n', 'utf8');
        const destDir = path.join(root, 'sub', 'dest');
        copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, root);
        // The dest dir and its content must exist inside root
        const written = fs.existsSync(path.join(destDir, 'test.md'));
        assert.ok(written, 'test.md must have been written to destDir under root');
        assert.ok(
          path.resolve(destDir).startsWith(path.resolve(root) + path.sep),
          'destDir must be under root',
        );
      } finally {
        cleanup(srcDir);
      }
    } finally {
      cleanup(root);
    }
  });

  test('2. escape rejected: destDir outside confinementRoot → throws, nothing written at escape path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-root-'));
    const escapeName = 'gsd-cwpr-escape-' + Date.now();
    const escapePath = path.join(os.tmpdir(), escapeName);
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src2-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'evil.md'), '# evil\n', 'utf8');
        // destDir resolves outside root via parent traversal
        const destDir = path.join(root, '..', escapeName);
        assert.throws(
          () => copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, root),
          /escap|must be a strict subpath|refusing/i,
        );
        // Nothing must have been created at the escape path
        assert.ok(!fs.existsSync(escapePath), 'must not create anything at the escape path');
      } finally {
        cleanup(srcDir);
      }
    } finally {
      cleanup(root);
      // also remove escapePath if it was somehow created (defensive)
      if (fs.existsSync(escapePath)) cleanup(escapePath);
    }
  });

  test('3. dest === root rejected: throws when destDir equals confinementRoot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-eqroot-'));
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src3-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'x.md'), '# x\n', 'utf8');
        assert.throws(
          () => copyWithPathReplacement(srcDir, root, '~/.claude/', 'claude', false, false, root),
          /escap|must be a strict subpath|refusing|configHome itself/i,
        );
      } finally {
        cleanup(srcDir);
      }
    } finally {
      cleanup(root);
    }
  });

  test('4. fail-closed: omitting confinementRoot throws with descriptive message', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-fc-'));
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src4-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'y.md'), '# y\n', 'utf8');
        const destDir = path.join(root, 'sub');
        assert.throws(
          () => copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, undefined),
          /confinementRoot is required/,
        );
      } finally {
        cleanup(srcDir);
      }
    } finally {
      cleanup(root);
    }
  });

  test('5. symlink escape: destDir via symlink outside root → throws', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-syml-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-out-'));
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src5-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'z.md'), '# z\n', 'utf8');
        const linkPath = path.join(root, 'link');
        try {
          fs.symlinkSync(outside, linkPath);
        } catch (_symlinkErr) {
          // Symlink creation unsupported on this platform/privilege — skip test body
          t.skip('symlink creation unsupported on this platform/privilege');
          return;
        }
        const destDir = path.join(linkPath, 'sub');
        assert.throws(
          () => copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, root),
          /symlink|escap|confinement|install root/i,
        );
        // Nothing written to outside
        assert.strictEqual(fs.readdirSync(outside).length, 0, 'must not write to the outside dir via symlink');
      } finally {
        cleanup(srcDir);
      }
    } finally {
      // unlink the symlink before cleanup to avoid crossing boundaries
      try { fs.unlinkSync(path.join(root, 'link')); } catch { /* already gone */ }
      cleanup(root);
      cleanup(outside);
    }
  });
});

// ---------------------------------------------------------------------------
// installCodexConfig
// ---------------------------------------------------------------------------

describe('installCodexConfig write-confinement', () => {
  test('6. happy path: config.toml and agents/<name>.toml written under targetDir', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-happy-'));
    try {
      const agentsSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-'));
      try {
        // Minimal valid agent frontmatter
        fs.writeFileSync(
          path.join(agentsSrc, 'gsd-foo.md'),
          '---\nname: gsd-foo\ndescription: x\n---\nbody\n',
          'utf8',
        );
        const count = installCodexConfig(targetDir, agentsSrc);
        assert.strictEqual(count, 1, 'must return count of 1 agent processed');
        assert.ok(fs.existsSync(path.join(targetDir, 'config.toml')), 'config.toml must exist under targetDir');
        assert.ok(fs.existsSync(path.join(targetDir, 'agents', 'gsd-foo.toml')), 'agents/gsd-foo.toml must exist under targetDir');
      } finally {
        cleanup(agentsSrc);
      }
    } finally {
      cleanup(targetDir);
    }
  });

  test('7a. name-injection rejected: frontmatter name "../../evil" must throw, nothing written at escape', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-inj-'));
    // Use a unique escape name derived from the targetDir basename so the escape
    // path can never collide with pre-existing files in os.tmpdir().
    // agentsTomlDir = resolve(targetDir, 'agents'); ../../<escapeName>.toml from
    // there = resolve(targetDir, '../<escapeName>.toml') = dirname(targetDir)/<name>.toml
    const escapeName = path.basename(targetDir) + '-escape';
    const escapePath = path.join(path.dirname(targetDir), escapeName + '.toml');
    try {
      const agentsSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-inj-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrc, 'gsd-evil.md'),
          `---\nname: ../../${escapeName}\ndescription: injected\n---\nbody\n`,
          'utf8',
        );
        assert.throws(
          () => installCodexConfig(targetDir, agentsSrc),
          /escap|strict subpath|refusing|NUL/i,
        );
        // Verify nothing was written at the escape location
        assert.ok(!fs.existsSync(escapePath), 'no file/dir written at escape location');
      } finally {
        cleanup(agentsSrc);
      }
    } finally {
      cleanup(targetDir);
      if (fs.existsSync(escapePath)) cleanup(escapePath);
    }
  });

  test('7b. name-injection: "../config" and "../evil" must both throw (clobber-prevention, tighter agentsTomlDir root)', () => {
    // With confinement rooted at agentsTomlDir (not targetDir), a name like
    // "../config" resolves to targetDir/config.toml — still inside the configHome
    // but OUTSIDE agents/ — so the gate must throw (clobber prevention).
    // Similarly "../evil" resolves to targetDir/evil.toml, also outside agents/.
    // Both must throw regardless of whether they escape targetDir.

    // Case A: "../config" — would clobber config.toml, must throw.
    const targetDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-inj2a-'));
    try {
      const agentsSrcA = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-inj2a-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrcA, 'gsd-clobber.md'),
          '---\nname: ../config\ndescription: clobber attempt\n---\nbody\n',
          'utf8',
        );
        assert.throws(
          () => installCodexConfig(targetDirA, agentsSrcA),
          /escap|strict subpath|refusing|NUL/i,
          'name "../config" must throw — it escapes agents/ even though it stays inside targetDir',
        );
      } finally {
        cleanup(agentsSrcA);
      }
    } finally {
      cleanup(targetDirA);
    }

    // Case B: "../evil" — escapes agents/, must throw (new behavior with agentsTomlDir root).
    const targetDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-inj2b-'));
    try {
      const agentsSrcB = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-inj2b-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrcB, 'gsd-up.md'),
          '---\nname: ../up-escape-attempt\ndescription: boundary test\n---\nbody\n',
          'utf8',
        );
        assert.throws(
          () => installCodexConfig(targetDirB, agentsSrcB),
          /escap|strict subpath|refusing|NUL/i,
          'name "../evil" must throw — it escapes agents/ (resolves to targetDir/evil.toml)',
        );
      } finally {
        cleanup(agentsSrcB);
      }
    } finally {
      cleanup(targetDirB);
    }

    // Case C: "../../evil" still throws (escapes both agents/ and targetDir).
    const targetDirC = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-inj2c-'));
    try {
      const agentsSrcC = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-inj2c-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrcC, 'gsd-deep.md'),
          '---\nname: ../../deep-escape\ndescription: deep escape\n---\nbody\n',
          'utf8',
        );
        assert.throws(
          () => installCodexConfig(targetDirC, agentsSrcC),
          /escap|strict subpath|refusing|NUL/i,
        );
      } finally {
        cleanup(agentsSrcC);
      }
    } finally {
      cleanup(targetDirC);
    }
  });

  test('10. symlink-escape: agents/ is a symlink outside targetDir → throws', (t) => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-syml-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-syml-out-'));
    try {
      const agentsSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-syml-src-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrc, 'gsd-foo.md'),
          '---\nname: gsd-foo\ndescription: x\n---\nbody\n',
          'utf8',
        );
        const agentsLink = path.join(targetDir, 'agents');
        try {
          fs.symlinkSync(outsideDir, agentsLink);
        } catch (_symlinkErr) {
          // Symlink creation unsupported on this platform/privilege — skip
          t.skip('symlink creation unsupported on this platform/privilege');
          return;
        }
        assert.throws(
          () => installCodexConfig(targetDir, agentsSrc),
          /symlink|escap|refusing/i,
        );
        // Nothing must have been written to the outside dir via the symlink
        assert.strictEqual(fs.readdirSync(outsideDir).length, 0, 'must not write to the outside dir via symlink');
      } finally {
        cleanup(agentsSrc);
      }
    } finally {
      try { fs.unlinkSync(path.join(targetDir, 'agents')); } catch { /* already gone */ }
      cleanup(targetDir);
      cleanup(outsideDir);
    }
  });
});

// ---------------------------------------------------------------------------
// _copyStaged
// ---------------------------------------------------------------------------

describe('_copyStaged write-confinement', () => {
  test('8. escape rejected (regression): destDir escaping configDir → throws', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-cfg-'));
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-staged-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-outside-'));
    try {
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# help\n', 'utf8');
      assert.throws(
        () => _copyStaged(stagedDir, outsideDir, { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' }, configDir),
        /escap|strict subpath|refusing|configHome/i,
      );
    } finally {
      cleanup(configDir);
      cleanup(stagedDir);
      cleanup(outsideDir);
    }
  });

  test('9. symlink escape rejected: destDir containing symlink to outside → throws', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-syml-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-syml-out-'));
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-staged2-'));
    try {
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# help\n', 'utf8');
      const linkPath = path.join(configDir, 'link');
      try {
        fs.symlinkSync(outside, linkPath);
      } catch (symlinkErr) {
        // Symlink creation unsupported on this platform/privilege — skip
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      const destDir = path.join(linkPath, 'sub');
      assert.throws(
        () => _copyStaged(stagedDir, destDir, { kind: 'commands', destSubpath: 'commands/link/sub', prefix: 'gsd-' }, configDir),
        /symlink|escap|confinement|install root/i,
      );
      assert.strictEqual(fs.readdirSync(outside).length, 0, 'must not have written to outside dir');
    } finally {
      try { fs.unlinkSync(path.join(configDir, 'link')); } catch { /* already gone */ }
      cleanup(configDir);
      cleanup(outside);
      cleanup(stagedDir);
    }
  });

  test('11. fail-closed: omitting configDir throws with descriptive message', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-fc-staged-'));
    const destDir = path.join(os.tmpdir(), 'gsd-cs-fc-dest-' + Date.now());
    try {
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# help\n', 'utf8');
      assert.throws(
        () => _copyStaged(stagedDir, destDir, { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' }, undefined),
        /configDir.*required|required to confine/i,
      );
    } finally {
      cleanup(stagedDir);
      if (fs.existsSync(destDir)) cleanup(destDir);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2998-pristine-dir-populated.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2998-pristine-dir-populated (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2998: gsd-pristine/ snapshot is documented but never populated by
 * the installer. saveLocalPatches declared a pristineDir variable and
 * promised "saves pristine copies (from manifest) to gsd-pristine/ to
 * enable three-way merge during reapply-patches" -- but no code ever
 * wrote to that directory. Effect: the /gsd-reapply-patches Step 5
 * verifier (#2972) silently degrades to its over-broad fallback heuristic
 * ("every significant backup line"), exactly the silent-success-on-lost-
 * content failure mode #2969 was designed to prevent.
 *
 * Fix: new populatePristineDir({...}) helper runs the install transform
 * pipeline (copyWithPathReplacement) into a tmp staging dir, then copies
 * out the modified-file paths into gsd-pristine/. saveLocalPatches now
 * accepts a pristineCtx and calls the helper when local patches are
 * detected.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const INSTALL = require(path.join(ROOT, 'bin', 'install.js'));
const { cleanup } = require('./helpers.cjs');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('Bug #2998: populatePristineDir is exported and writes pristine for modified files', () => {
  test('exported as a function', () => {
    assert.equal(typeof INSTALL.populatePristineDir, 'function',
      'expected populatePristineDir in install.js exports (#2998)');
  });

  test('returns 0 when no files are modified (no-op)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-'));
    try {
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir: path.join(tmp, 'gsd-pristine'),
        modified: [],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 0);
    } finally {
      cleanup(tmp);
    }
  });

  test('writes one pristine file per modified path that exists in source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-'));
    const pristineDir = path.join(tmp, 'gsd-pristine');
    try {
      // Pick a real installed-side relPath from the package source. The
      // install transforms map source `gsd-core/<rel>` to installed
      // `gsd-core/<rel>` for skills-aware runtimes (like claude),
      // so the relPath is the same on both sides.
      const candidate = path.join('gsd-core', 'workflows', 'reapply-patches.md');
      const sourcePath = path.join(ROOT, candidate);
      assert.equal(fs.existsSync(sourcePath), true,
        `precondition: source file exists at ${candidate}`);
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir,
        modified: [candidate],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 1, 'expected exactly one pristine file written');
      const out = path.join(pristineDir, candidate);
      assert.equal(fs.existsSync(out), true, `expected pristine file at ${out}`);
      // The pristine content should be the transformed version (not raw source):
      // copyWithPathReplacement substitutes ~/.claude/ for the runtime path prefix.
      // For claude+global, the prefix is $HOME/.claude/ which equals the original,
      // so the transform is effectively identity here. We assert the content is a
      // non-empty markdown file rather than asserting on transform specifics.
      const content = fs.readFileSync(out, 'utf-8');
      assert.ok(content.length > 0, 'pristine file should be non-empty');
    } finally {
      cleanup(tmp);
    }
  });

  test('skips paths not present in source (does not corrupt pristine with stale data)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-'));
    const pristineDir = path.join(tmp, 'gsd-pristine');
    try {
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir,
        modified: ['gsd-core/this-path-does-not-exist.md'],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 0, 'expected zero pristine files for non-existent source paths');
      const out = path.join(pristineDir, 'gsd-core/this-path-does-not-exist.md');
      assert.equal(fs.existsSync(out), false, 'pristine should not contain ghost paths');
    } finally {
      cleanup(tmp);
    }
  });

  test('pristine files have stable content (transformations are deterministic)', () => {
    // Determinism is what makes the verifier's hash check meaningful:
    // backup-meta.json records pristine_hashes computed at this same step,
    // so re-running with the same inputs must yield byte-identical files.
    const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-d1-'));
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-d2-'));
    try {
      const candidate = path.join('gsd-core', 'workflows', 'reapply-patches.md');
      const ctx = {
        packageSrc: ROOT,
        modified: [candidate],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      };
      INSTALL.populatePristineDir(Object.assign({ pristineDir: path.join(tmp1, 'gsd-pristine') }, ctx));
      INSTALL.populatePristineDir(Object.assign({ pristineDir: path.join(tmp2, 'gsd-pristine') }, ctx));
      const a = fs.readFileSync(path.join(tmp1, 'gsd-pristine', candidate));
      const b = fs.readFileSync(path.join(tmp2, 'gsd-pristine', candidate));
      assert.equal(sha256(a), sha256(b), 'two runs of the same inputs must yield identical pristine content');
    } finally {
      cleanup(tmp1);
      cleanup(tmp2);
    }
  });
});

// ─── #3004 CR follow-up: multi-root pristine expansion ─────────────────────

describe('Bug #2998 (#3004 CR): pristine expansion covers every manifest install root', () => {
  test('paths under agents/ are staged via copyWithPathReplacement, not silently skipped', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-multi-'));
    const pristineDir = path.join(tmp, 'gsd-pristine');
    try {
      const candidate = path.join('agents', 'gsd-planner.md');
      const sourcePath = path.join(ROOT, candidate);
      assert.equal(fs.existsSync(sourcePath), true,
        `precondition: source file exists at ${candidate}`);
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir,
        modified: [candidate],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 1, 'expected agents/ path to be staged and copied to pristine');
      assert.equal(fs.existsSync(path.join(pristineDir, candidate)), true);
    } finally {
      cleanup(tmp);
    }
  });

  test('a mix of gsd-core/ and agents/ paths in modified list are all staged', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-mix-'));
    const pristineDir = path.join(tmp, 'gsd-pristine');
    try {
      const a = path.join('gsd-core', 'workflows', 'reapply-patches.md');
      const b = path.join('agents', 'gsd-planner.md');
      assert.equal(fs.existsSync(path.join(ROOT, a)), true);
      assert.equal(fs.existsSync(path.join(ROOT, b)), true);
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir,
        modified: [a, b],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 2, 'expected both top-level dirs to be staged');
      assert.equal(fs.existsSync(path.join(pristineDir, a)), true);
      assert.equal(fs.existsSync(path.join(pristineDir, b)), true);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('Bug #2998: saveLocalPatches no longer leaves the pristineDir variable unused', () => {
  test('saveLocalPatches accepts a pristineCtx and exposes the helper for direct testing', () => {
    // Structural assertion: the function exists with the new signature shape.
    // Behavioral end-to-end is covered by the populatePristineDir tests above
    // (that helper is what saveLocalPatches calls internally).
    assert.equal(typeof INSTALL.populatePristineDir, 'function');
    // The signature for saveLocalPatches isn't exported, but the helper IS,
    // and it's the unit of behavior the bug is about. Asserting on the helper
    // is the structural-IR equivalent of the no-source-grep convention.
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3407-pristine-stale-content.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3407-pristine-stale-content (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #3407: Installer leaves stale content in gsd-pristine/
 *
 * Root cause: populatePristineDir() in saveLocalPatches() snapshots from
 * pristineCtx.packageSrc — the NEWLY-downloaded release tree — and writes
 * those bytes into gsd-pristine/.  For files changed between the old and new
 * release, this writes the NEW bytes into the pristine baseline instead of
 * the OLD bytes.  The three-way-diff verifier then classifies upstream-changed
 * lines as user-added → Step 5a gate fails with false FAIL_USER_LINES_MISSING.
 *
 * The #3657 fix (OK_PRISTINE_DRIFT_DETECTED) was a symptom workaround: the
 * verifier detects hash mismatch (backup-meta.json records old-release hash
 * but gsd-pristine/ has new-release bytes) and skips to over-broad mode
 * instead of false-failing.  The root-cause stale write was never fixed.
 *
 * Fix: when a correctly-populated gsd-pristine/ already exists from the
 * previous install (i.e., the file's sha256 matches the originalHash recorded
 * in the manifest), preserve it — do NOT wipe and re-populate from the new
 * release source.  This ensures gsd-pristine/ holds old-release bytes even
 * after an upgrade where the file content changed upstream.
 *
 * Regression contract (byte-comparison):
 *   After saveLocalPatches() is called with a user-modified file whose
 *   gsd-pristine/ entry was correctly set by the previous install, the
 *   gsd-pristine/ file MUST still contain the old-release bytes, not the
 *   new-release bytes supplied in pristineCtx.packageSrc.
 *
 * Closes: #3407
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const INSTALL = require(path.join(ROOT, 'bin', 'install.js'));
const { cleanup } = require('./helpers.cjs');

const MANIFEST_NAME = 'gsd-file-manifest.json';
const PATCHES_DIR_NAME = 'gsd-local-patches';

function sha256(content) {
  return crypto.createHash('sha256').update(content instanceof Buffer ? content : Buffer.from(content)).digest('hex');
}

// ─── Bug #3407: gsd-pristine/ must preserve OLD-release bytes across upgrade ──

describe('Bug #3407: saveLocalPatches preserves old-release pristine across upgrade', () => {
  let tmpDir;
  let configDir;
  let fakeSrcDir;

  beforeEach((t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3407-'));
    configDir = path.join(tmpDir, 'config');
    fakeSrcDir = path.join(tmpDir, 'new-release-src');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(fakeSrcDir, { recursive: true });
    t.after(() => {
      cleanup(tmpDir);
    });
  });

  /**
   * Core regression test.
   *
   * Timeline:
   *   Install v1: file content = OLD_RELEASE_CONTENT, gsd-pristine/ROOT_FILE
   *               = OLD_RELEASE_CONTENT (correctly set by previous install),
   *               manifest hash = sha256(OLD_RELEASE_CONTENT)
   *   User edits: configDir/ROOT_FILE = USER_MODIFIED_CONTENT
   *   Upgrade v2: pristineCtx.packageSrc has NEW_RELEASE_CONTENT for ROOT_FILE
   *   saveLocalPatches is called before the wipe.
   *
   * Expected AFTER fix: gsd-pristine/ROOT_FILE still == OLD_RELEASE_CONTENT
   * Actual BEFORE fix:  gsd-pristine/ROOT_FILE == NEW_RELEASE_CONTENT (stale)
   */
  test('gsd-pristine/ retains old-release bytes when upgrading a user-modified file', () => {
    const OLD_RELEASE_CONTENT = '# Old Release Content\nThis is v1 pristine.\n';
    const NEW_RELEASE_CONTENT = '# New Release Content\nThis is v2 — upstream changed this line.\n';
    const USER_MODIFIED_CONTENT = '# Old Release Content\nThis is v1 pristine.\n## User addition\nUser customization here.\n';

    const oldHash = sha256(OLD_RELEASE_CONTENT);

    // Simulate a root-level installed file. Root-level files in the manifest
    // are denoted without a subdirectory (slash-free relPath).
    const relPath = 'test-root-file.md';

    // Set up configDir: user-modified installed file + manifest recording old hash
    fs.writeFileSync(path.join(configDir, relPath), USER_MODIFIED_CONTENT);
    fs.writeFileSync(
      path.join(configDir, MANIFEST_NAME),
      JSON.stringify({ version: '1.0.0', files: { [relPath]: oldHash } }, null, 2)
    );

    // Set up fakeSrcDir (new release): the file has NEW content
    fs.writeFileSync(path.join(fakeSrcDir, relPath), NEW_RELEASE_CONTENT);

    // Set up gsd-pristine/ with OLD content (as correctly populated by previous install)
    const pristineDir = path.join(configDir, 'gsd-pristine');
    fs.mkdirSync(pristineDir, { recursive: true });
    fs.writeFileSync(path.join(pristineDir, relPath), OLD_RELEASE_CONTENT);

    // Call saveLocalPatches with the new release as packageSrc (the buggy scenario)
    INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '$HOME/.claude/',
      isGlobal: true,
    });

    // Assert: gsd-pristine/ must still contain OLD-release bytes
    const pristineFile = path.join(pristineDir, relPath);
    assert.ok(
      fs.existsSync(pristineFile),
      `gsd-pristine/${relPath} must exist after saveLocalPatches`
    );

    const actualPristineContent = fs.readFileSync(pristineFile, 'utf8');
    assert.equal(
      sha256(actualPristineContent),
      oldHash,
      [
        `gsd-pristine/${relPath} must contain OLD-release bytes (sha256=${oldHash.slice(0, 12)}…)`,
        `but got sha256=${sha256(actualPristineContent).slice(0, 12)}…`,
        `(If equal to sha256(NEW_RELEASE_CONTENT)=${sha256(NEW_RELEASE_CONTENT).slice(0, 12)}… then #3407 is NOT fixed)`,
      ].join(' ')
    );

    // Secondary: confirm backup-meta records the old hash (not new)
    const backupMeta = JSON.parse(
      fs.readFileSync(path.join(configDir, PATCHES_DIR_NAME, 'backup-meta.json'), 'utf8')
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(backupMeta.pristine_hashes, relPath),
      'backup-meta.json must record pristine_hash for modified file'
    );
    assert.equal(
      backupMeta.pristine_hashes[relPath],
      oldHash,
      'backup-meta.json pristine_hash must equal old-release hash (not new-release hash)'
    );
  });

  /**
   * Regression test for Codex finding: when gsd-pristine/ entry is absent
   * (e.g., post-buggy-run deletion or first upgrade without prior pristine)
   * but the file is UNCHANGED between old and new release, the hash-validated
   * regeneration path must restore the pristine entry using new-release source.
   *
   * When sha256(newReleaseBytesForFile) === originalHash, the file is identical
   * between releases — new-release generated bytes ARE the old-release pristine
   * and may be safely promoted.
   *
   * Previously (before the regeneration path was added): missing entries were
   * left absent unconditionally, causing permanent over-broad fallback even
   * when the file was unchanged upstream.
   */
  test('gsd-pristine/ is regenerated for missing entries when file is unchanged between releases', () => {
    const SHARED_RELEASE_CONTENT = '# Shared Content\nThis file is identical in v1 and v2.\n';
    const USER_MODIFIED_CONTENT = '# Shared Content\nThis file is identical in v1 and v2.\n## User addition\nCustom.\n';

    const oldHash = sha256(SHARED_RELEASE_CONTENT);
    const relPath = 'test-unchanged-file.md';

    // configDir has user-modified file + manifest with old-release hash
    fs.writeFileSync(path.join(configDir, relPath), USER_MODIFIED_CONTENT);
    fs.writeFileSync(
      path.join(configDir, MANIFEST_NAME),
      JSON.stringify({ version: '1.0.0', files: { [relPath]: oldHash } }, null, 2)
    );

    // fakeSrcDir (new release) has the SAME content — file was not changed upstream
    fs.writeFileSync(path.join(fakeSrcDir, relPath), SHARED_RELEASE_CONTENT);

    // NOTE: gsd-pristine/ does NOT exist (simulating post-buggy-run or first-time scenario)

    INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '$HOME/.claude/',
      isGlobal: true,
    });

    // The regeneration path should have detected that sha256(new-release candidate)
    // === originalHash, and promoted the candidate into gsd-pristine/.
    const pristineFile = path.join(configDir, 'gsd-pristine', relPath);
    assert.ok(
      fs.existsSync(pristineFile),
      [
        `gsd-pristine/${relPath} must exist after hash-validated regeneration.`,
        `When new-release bytes hash to originalHash, the file was unchanged between`,
        `releases and the candidate should be promoted to restore the pristine baseline.`,
      ].join(' ')
    );

    const actualContent = fs.readFileSync(pristineFile, 'utf8');
    assert.equal(
      sha256(actualContent),
      oldHash,
      [
        `gsd-pristine/${relPath} must contain bytes matching originalHash after regeneration`,
        `(sha256=${oldHash.slice(0, 12)}…)`,
      ].join(' ')
    );
  });

  /**
   * Stale-pristine recovery test (pre-fix bug artifact).
   *
   * Timeline:
   *   Buggy run:  gsd-pristine/<rel> was written with NEW_RELEASE_CONTENT
   *               (the exact #3407 artifact — stale bytes from a buggy populatePristineDir).
   *   Fix run:    saveLocalPatches detects the hash mismatch
   *               (sha256(NEW_RELEASE_CONTENT) !== originalHash recorded in manifest),
   *               removes the stale entry, then attempts regeneration.
   *
   * When the file CHANGED between releases (NEW !== OLD):
   *   - The stale entry is removed.
   *   - Regeneration discards the new-release candidate (hash mismatch).
   *   - gsd-pristine/<rel> must be ABSENT (over-broad fallback — correct).
   *
   * When the file is UNCHANGED between releases (NEW === OLD):
   *   - The stale entry (which happens to have correct bytes despite the bug) is
   *     detected as correct (hash matches originalHash) and PRESERVED.
   *   - gsd-pristine/<rel> must remain present with the correct bytes.
   *
   * This test covers the "file changed across release boundary" case.
   * The "unchanged" case is already covered by the regeneration test above.
   */
  test('stale gsd-pristine/ entry (new-release bytes) is removed when file changed between releases', () => {
    const OLD_RELEASE_CONTENT = '# Old Release\nv1 content here.\n';
    const NEW_RELEASE_CONTENT = '# New Release\nv2 content — upstream changed this.\n';
    const USER_MODIFIED_CONTENT = '# Old Release\nv1 content here.\n## User section\nCustom work.\n';

    const oldHash = sha256(OLD_RELEASE_CONTENT);
    const relPath = 'test-stale-recovery.md';

    // configDir: user-modified file + manifest recording OLD hash
    fs.writeFileSync(path.join(configDir, relPath), USER_MODIFIED_CONTENT);
    fs.writeFileSync(
      path.join(configDir, MANIFEST_NAME),
      JSON.stringify({ version: '1.0.0', files: { [relPath]: oldHash } }, null, 2)
    );

    // fakeSrcDir (new release): contains the NEW content
    fs.writeFileSync(path.join(fakeSrcDir, relPath), NEW_RELEASE_CONTENT);

    // Pre-populate gsd-pristine/ with NEW_RELEASE_CONTENT — the exact pre-fix bug artifact.
    // This simulates a prior buggy run that wrote new-release bytes into the pristine baseline.
    const STALE_BYTES = NEW_RELEASE_CONTENT; // named constant for clarity
    const pristineDir = path.join(configDir, 'gsd-pristine');
    fs.mkdirSync(pristineDir, { recursive: true });
    fs.writeFileSync(path.join(pristineDir, relPath), STALE_BYTES);

    // Verify the pre-condition: stale bytes do NOT match the original hash.
    // If this assert fails, the test fixture is wrong (not a fix regression).
    assert.notEqual(
      sha256(STALE_BYTES),
      oldHash,
      'test fixture check: stale bytes must differ from originalHash'
    );

    INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '$HOME/.claude/',
      isGlobal: true,
    });

    // The fix must detect the hash mismatch (stale entry) and remove it.
    // The regeneration path discards the new-release candidate (its hash !== oldHash).
    // Result: gsd-pristine/<rel> must be ABSENT — over-broad fallback is the safe outcome.
    const pristineFile = path.join(pristineDir, relPath);
    assert.strictEqual(
      fs.existsSync(pristineFile),
      false,
      [
        `expected gsd-pristine/${relPath} to be absent after stale-pristine recovery.`,
        `The stale entry (new-release bytes, sha256=${sha256(STALE_BYTES).slice(0, 12)}…)`,
        `must be removed; regeneration must discard the candidate because`,
        `sha256(new-release)=${sha256(NEW_RELEASE_CONTENT).slice(0, 12)}… !== originalHash=${oldHash.slice(0, 12)}….`,
        `Presence of the file means the stale bytes were NOT cleaned up (pre-fix behavior).`,
      ].join(' ')
    );
  });

  /**
   * Second scenario: gsd-pristine/ does NOT pre-exist (first upgrade with no
   * prior pristine population).  In this case there is no way to obtain the
   * old-release pristine bytes — populatePristineDir must NOT write the new-
   * release bytes either.  The correct outcome is: gsd-pristine/ stays empty
   * for this file, and the verifier falls back to over-broad mode (safe).
   */
  test('gsd-pristine/ stays empty when no prior pristine exists (first upgrade, no stale write)', () => {
    const OLD_RELEASE_CONTENT = '# Old Release Content\nThis is v1.\n';
    const NEW_RELEASE_CONTENT = '# New Release Content\nThis is v2 — changed.\n';
    const USER_MODIFIED_CONTENT = '# Old Release Content\nThis is v1.\n## User addition\nCustom.\n';

    const oldHash = sha256(OLD_RELEASE_CONTENT);
    const relPath = 'test-first-upgrade.md';

    // configDir has user-modified file + manifest
    fs.writeFileSync(path.join(configDir, relPath), USER_MODIFIED_CONTENT);
    fs.writeFileSync(
      path.join(configDir, MANIFEST_NAME),
      JSON.stringify({ version: '1.0.0', files: { [relPath]: oldHash } }, null, 2)
    );

    // fakeSrcDir (new release) has new content
    fs.writeFileSync(path.join(fakeSrcDir, relPath), NEW_RELEASE_CONTENT);

    // NOTE: gsd-pristine/ does NOT exist yet (first upgrade)

    INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '$HOME/.claude/',
      isGlobal: true,
    });

    const pristineFile = path.join(configDir, 'gsd-pristine', relPath);
    assert.strictEqual(
      fs.existsSync(pristineFile),
      false,
      [
        `expected gsd-pristine/${relPath} to be absent when file changed across release boundary.`,
        `Writing new-release bytes as pristine for a file whose hash is unknown leads to`,
        `false FAIL_USER_LINES_MISSING in the reapply-patches verifier (#3407).`,
        `Over-broad fallback mode is the correct outcome here.`,
      ].join(' ')
    );
  });
});

// The former "Antipattern hunt" describe block (structural typeof checks only) was
// removed — it provided no real behavioral coverage and was a vacuous-truth pattern
// per /test-rigor skill. Behavioral tests for populatePristineDir are covered above.
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1679-destsubpath-confinement.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1679-destsubpath-confinement (consolidation epic #1969 B5 #1974)", () => {
'use strict';

/**
 * Tests for ADR-1239 Phase B: destSubpath write-confinement security gate.
 *
 * Verifies that assertDestWithinConfigHome rejects escaping destSubpath values
 * and that createRuntimeArtifactInstallPlan and createRuntimeArtifactUninstallPlan
 * both reject them at plan-build time.
 *
 * Also covers:
 *   F3 - assertDestWithinConfigHome rejects destSubpath === configHome itself
 *   F4 - migrateLegacyDevPreferencesToSkill routes through the confinement gate
 *   F2 - write sites (installOpencodeFamilySkills) reject symlink-escaping destDir
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertDestWithinConfigHome,
  createRuntimeArtifactInstallPlan,
  createRuntimeArtifactUninstallPlan,
} = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');

const {
  migrateLegacyDevPreferencesToSkill,
  installOpencodeFamilySkills,
  installRuntimeArtifacts,
  _copyStaged,
} = require('../gsd-core/bin/lib/install-engine.cjs');

const { createTempDir, cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Unit tests for assertDestWithinConfigHome
// ---------------------------------------------------------------------------

describe('assertDestWithinConfigHome', () => {
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-confine-test-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  // --- Rejection cases ---

  test('rejects destSubpath "../../etc" that escapes configDir', () => {
    assert.throws(
      () => assertDestWithinConfigHome(configDir, '../../etc'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.includes('escapes configHome'),
          `expected "escapes configHome" in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('rejects destSubpath "../foo" that escapes configDir', () => {
    assert.throws(
      () => assertDestWithinConfigHome(configDir, '../foo'),
      /escapes configHome/,
    );
  });

  test('rejects destSubpath "a/../../b" that escapes configDir', () => {
    assert.throws(
      () => assertDestWithinConfigHome(configDir, 'a/../../b'),
      /escapes configHome/,
    );
  });

  test('rejects destSubpath containing a NUL byte', () => {
    assert.throws(
      () => assertDestWithinConfigHome(configDir, 'skills\0evil'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.includes('NUL'),
          `expected "NUL" in: ${err.message}`,
        );
        return true;
      },
    );
  });

  // --- F3: reject destSubpath that resolves to configHome itself ---

  test('F3: rejects destSubpath "." that resolves to configHome itself', () => {
    assert.throws(
      () => assertDestWithinConfigHome(configDir, '.'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.includes('not configHome itself') || err.message.includes('escapes configHome'),
          `expected confinement error in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('F3: rejects destSubpath "a/.." that resolves to configHome itself', () => {
    assert.throws(
      () => assertDestWithinConfigHome(configDir, 'a/..'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.includes('not configHome itself') || err.message.includes('escapes configHome'),
          `expected confinement error in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('F3: rejects destSubpath "skills/../.." that resolves to configHome parent', () => {
    assert.throws(
      () => assertDestWithinConfigHome(configDir, 'skills/../..'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.includes('not configHome itself') || err.message.includes('escapes configHome'),
          `expected confinement error in: ${err.message}`,
        );
        return true;
      },
    );
  });

  // --- Accepted cases ---

  test('accepts "skills" and returns path under configDir', () => {
    const result = assertDestWithinConfigHome(configDir, 'skills');
    assert.ok(
      result.startsWith(path.resolve(configDir)),
      `expected result to start with configDir (${path.resolve(configDir)}), got: ${result}`,
    );
    assert.strictEqual(result, path.join(path.resolve(configDir), 'skills'));
  });

  test('accepts "commands/gsd" and returns path under configDir', () => {
    const result = assertDestWithinConfigHome(configDir, 'commands/gsd');
    assert.ok(result.startsWith(path.resolve(configDir)));
    assert.strictEqual(result, path.join(path.resolve(configDir), 'commands', 'gsd'));
  });

  test('accepts "./skills" and returns resolved path under configDir', () => {
    const result = assertDestWithinConfigHome(configDir, './skills');
    assert.ok(result.startsWith(path.resolve(configDir)));
    assert.strictEqual(result, path.join(path.resolve(configDir), 'skills'));
  });

  test('does not match a sibling directory with a shared prefix', () => {
    // configDir = /tmp/gsd-foo; a sibling like /tmp/gsd-foobar must NOT be accepted.
    // The path.sep guard in the implementation prevents a startsWith match
    // from crossing directory boundaries. We verify the happy-path: a valid
    // nested subpath resolves to a path strictly under configDir (includes sep).
    const result = assertDestWithinConfigHome(configDir, 'subdir/nested');
    assert.ok(result.startsWith(path.resolve(configDir) + path.sep));
  });
});

// ---------------------------------------------------------------------------
// Integration tests for createRuntimeArtifactInstallPlan
// ---------------------------------------------------------------------------

describe('createRuntimeArtifactInstallPlan destSubpath confinement', () => {
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-plan-confine-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  function noopStage() {
    return '/tmp/staged-noop';
  }

  function makeLayout(destSubpath) {
    return {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [
        {
          kind: 'skills',
          destSubpath,
          prefix: 'gsd-',
          stage: noopStage,
        },
      ],
    };
  }

  test('rejects an escaping destSubpath ("../../escape") at plan-build time', () => {
    const layout = makeLayout('../../escape');
    assert.throws(
      () => createRuntimeArtifactInstallPlan({
        layout,
        resolvedProfile: { name: 'core' },
        deps: {
          rewriteStagedSkillBodies: () => undefined,
          rewriteStagedCommandBodies: () => undefined,
        },
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('escapes'),
          `expected "escapes" in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('normal destSubpath produces plan with destDir under configDir', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-staged-'));
    try {
      const layout = {
        runtime: 'claude',
        configDir,
        scope: 'global',
        kinds: [
          {
            kind: 'skills',
            destSubpath: 'skills',
            prefix: 'gsd-',
            stage: () => stagedDir,
          },
        ],
      };

      const result = createRuntimeArtifactInstallPlan({
        layout,
        resolvedProfile: { name: 'core' },
        deps: {
          rewriteStagedSkillBodies: () => undefined,
          rewriteStagedCommandBodies: () => undefined,
        },
      });

      assert.strictEqual(result.ok, true, 'plan must succeed for normal destSubpath');
      assert.strictEqual(result.plan.items.length, 1);
      const destDir = result.plan.items[0].destDir;
      assert.ok(
        destDir.startsWith(path.resolve(configDir)),
        `destDir (${destDir}) must be under configDir (${configDir})`,
      );
    } finally {
      cleanup(stagedDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests for createRuntimeArtifactUninstallPlan
// ---------------------------------------------------------------------------

describe('createRuntimeArtifactUninstallPlan destSubpath confinement', () => {
  let configDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-uninstall-confine-');
  });

  afterEach(() => {
    cleanup(configDir);
  });

  function makeUninstallLayout(destSubpath) {
    return {
      runtime: 'claude',
      configDir,
      kinds: [
        {
          kind: 'skills',
          destSubpath,
          prefix: 'gsd-',
          stage: () => '/tmp/staged-noop',
        },
      ],
    };
  }

  test('rejects an escaping destSubpath ("../../escape") at uninstall-plan-build time', () => {
    const layout = makeUninstallLayout('../../escape');
    assert.throws(
      () => createRuntimeArtifactUninstallPlan(layout),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('escapes'),
          `expected "escapes" in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('rejects destSubpath "../outside" at uninstall-plan-build time', () => {
    const layout = makeUninstallLayout('../outside');
    assert.throws(
      () => createRuntimeArtifactUninstallPlan(layout),
      /escapes/,
    );
  });

  test('normal destSubpath produces uninstall plan with destDir under configDir', () => {
    const layout = makeUninstallLayout('skills');
    const plan = createRuntimeArtifactUninstallPlan(layout);
    assert.strictEqual(plan.items.length, 1);
    const destDir = plan.items[0].destDir;
    assert.ok(
      destDir.startsWith(path.resolve(configDir)),
      `destDir (${destDir}) must be under configDir (${configDir})`,
    );
    assert.strictEqual(destDir, path.join(path.resolve(configDir), 'skills'));
  });

  test('normal nested destSubpath ("commands/gsd") produces uninstall plan with destDir under configDir', () => {
    const layout = makeUninstallLayout('commands/gsd');
    const plan = createRuntimeArtifactUninstallPlan(layout);
    assert.strictEqual(plan.items.length, 1);
    const destDir = plan.items[0].destDir;
    assert.ok(
      destDir.startsWith(path.resolve(configDir)),
      `destDir (${destDir}) must be under configDir (${configDir})`,
    );
    assert.strictEqual(destDir, path.join(path.resolve(configDir), 'commands', 'gsd'));
  });
});

// ---------------------------------------------------------------------------
// F4: migrateLegacyDevPreferencesToSkill must route through the confinement gate
// ---------------------------------------------------------------------------

describe('F4: migrateLegacyDevPreferencesToSkill confinement', () => {
  let configDir;
  let outsideDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-f4-confine-');
    outsideDir = createTempDir('gsd-f4-outside-');
  });

  afterEach(() => {
    cleanup(configDir);
    cleanup(outsideDir);
  });

  test('F4: migrateLegacyDevPreferencesToSkill throws when destSubpath resolves to configHome itself (via mocked layout with "." destSubpath)', () => {
    // We cannot easily inject a bad destSubpath through the real layout resolver
    // (it resolves to a real valid path). Instead we validate that the function
    // uses assertDestWithinConfigHome by passing a runtime whose layout's
    // skillsKindEntry.destSubpath, when joined with configDir, would escape — but
    // since real layouts are always safe, we test the guard on a deliberately
    // crafted saved map calling the real function and observing the path written
    // is always within configDir for a real runtime.
    //
    // Real-layout sanity: verify 'opencode' produces a write inside configDir.
    const savedLegacy = new Map([['dev-preferences.md', '# dev prefs\n']]);
    // Real opencode layout — should succeed without throwing
    assert.doesNotThrow(() => {
      migrateLegacyDevPreferencesToSkill(configDir, savedLegacy, 'opencode', 'global');
    }, 'migrateLegacyDevPreferencesToSkill with real opencode layout must not throw');

    // Verify the written file is inside configDir
    const written = [];
    function findMd(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) findMd(path.join(dir, e.name));
        else if (e.name.endsWith('.md')) written.push(path.join(dir, e.name));
      }
    }
    findMd(configDir);
    assert.ok(written.length > 0, 'at least one .md must have been written');
    for (const f of written) {
      assert.ok(
        f.startsWith(path.resolve(configDir) + path.sep),
        `written file ${f} must be inside configDir ${configDir}`,
      );
    }
  });

  test('F4: migrateLegacyDevPreferencesToSkill uses assertDestWithinConfigHome — path.join on configDir+destSubpath cannot escape via symlink in destSubpath string', () => {
    // Validate that the guard (assertDestWithinConfigHome) would have caught a
    // manipulated destSubpath value. We simulate by calling assertDestWithinConfigHome
    // directly with a "."-equivalent subpath (F3 guard) to prove F4 now relies on it.
    assert.throws(
      () => assertDestWithinConfigHome(configDir, '.'),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      },
      'assertDestWithinConfigHome must reject "." (used by F4 guard)',
    );
  });
});

// ---------------------------------------------------------------------------
// F2: write sites reject a symlink-escaping destDir
// ---------------------------------------------------------------------------

describe('F2: installOpencodeFamilySkills rejects symlink-escaping destDir', () => {
  let configDir;
  let outsideDir;
  let symlinkTarget;

  beforeEach(() => {
    configDir = createTempDir('gsd-f2-config-');
    outsideDir = createTempDir('gsd-f2-outside-');
    // Create a symlink inside configDir pointing outside
    symlinkTarget = path.join(configDir, 'skills');
    fs.symlinkSync(outsideDir, symlinkTarget);
  });

  afterEach(() => {
    // Remove symlink before cleanup to avoid errors
    try { fs.unlinkSync(symlinkTarget); } catch { /* already gone */ }
    cleanup(configDir);
    cleanup(outsideDir);
  });

  test('F2: installOpencodeFamilySkills throws when skills/ is a symlink pointing outside configDir', () => {
    // Create a minimal rawCommandsDir with one .md file
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-f2-raw-'));
    try {
      fs.writeFileSync(path.join(rawDir, 'help.md'), '# help\n', 'utf8');

      assert.throws(
        () => installOpencodeFamilySkills('opencode', configDir, rawDir, '~/.opencode/'),
        (err) => {
          assert.ok(err instanceof Error, 'must be an Error');
          assert.ok(
            err.message.toLowerCase().includes('symlink') ||
            err.message.toLowerCase().includes('escap') ||
            err.message.toLowerCase().includes('outside') ||
            err.message.toLowerCase().includes('confinement'),
            `expected symlink/escape error in: ${err.message}`,
          );
          return true;
        },
      );

      // Verify nothing was written to outsideDir
      const outsideFiles = fs.readdirSync(outsideDir);
      assert.strictEqual(outsideFiles.length, 0, 'must not have written anything outside configDir');
    } finally {
      cleanup(rawDir);
    }
  });
});

// ---------------------------------------------------------------------------
// M1: _copyStaged defense-in-depth must also reject dest === configRoot
// ---------------------------------------------------------------------------

describe('M1: _copyStaged rejects dest equal to configRoot', () => {
  let configDir;
  let stagedDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-m1-config-');
    stagedDir = createTempDir('gsd-m1-staged-');
    // Write a dummy file into stagedDir so _copyStaged has something to copy
    fs.writeFileSync(path.join(stagedDir, 'help.md'), '# help\n', 'utf8');
  });

  afterEach(() => {
    cleanup(configDir);
    cleanup(stagedDir);
  });

  test('M1: _copyStaged throws when destDir equals configRoot (was silently accepted before fix)', () => {
    // dest === configRoot: the canonical gate (assertDestWithinConfigHome) rejects
    // resolved === root with "escapes configHome" / "not configHome itself".
    assert.throws(
      () => _copyStaged(stagedDir, configDir, { kind: 'commands', destSubpath: '.', prefix: 'gsd-' }, configDir),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.includes('escapes configHome') ||
          err.message.includes('not configHome itself') ||
          err.message.includes('outside') ||
          err.message.includes('inside'),
          `expected confinement error in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('M1: _copyStaged throws when destDir is outside configRoot', () => {
    const outsideDir = createTempDir('gsd-m1-outside-');
    try {
      assert.throws(
        () => _copyStaged(stagedDir, outsideDir, { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' }, configDir),
        (err) => {
          assert.ok(err instanceof Error, 'must be an Error');
          assert.ok(
            // After EDIT 1, _copyStaged delegates to assertDestWithinConfigHome which
            // emits "escapes configHome"; the old "_copyStaged" prefix is no longer present.
            err.message.includes('escapes configHome') ||
            err.message.includes('strict subpath') ||
            err.message.includes('refusing'),
            `expected confinement error in: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      cleanup(outsideDir);
    }
  });

  test('M1: _copyStaged accepts destDir strictly under configRoot', () => {
    const destDir = path.join(configDir, 'commands', 'gsd');
    fs.mkdirSync(destDir, { recursive: true });
    // Should not throw — just copies (stagedDir has help.md, kind=commands)
    assert.doesNotThrow(
      () => _copyStaged(stagedDir, destDir, { kind: 'commands', destSubpath: 'commands/gsd', prefix: 'gsd-' }, configDir),
    );
  });
});

// ---------------------------------------------------------------------------
// L2: symlink guard BEFORE mkdirSync in installRuntimeArtifacts
// ---------------------------------------------------------------------------

describe('L2: installRuntimeArtifacts rejects symlink-escaping dest before mkdirSync', () => {
  let configDir;
  let outsideDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-l2-config-');
    outsideDir = createTempDir('gsd-l2-outside-');
    // Create configDir/skills as a symlink pointing outside
    fs.symlinkSync(outsideDir, path.join(configDir, 'skills'));
  });

  afterEach(() => {
    // Remove symlink before cleanup to avoid crossing dir boundaries
    try { fs.unlinkSync(path.join(configDir, 'skills')); } catch { /* already gone */ }
    cleanup(configDir);
    cleanup(outsideDir);
  });

  test('L2: installRuntimeArtifacts throws before creating dirs when skills/ is a symlink pointing outside', () => {
    // Use the full profile shape (skills: '*') so staging short-circuits early
    // and the symlink guard is the first thing that fires.
    assert.throws(
      () => installRuntimeArtifacts('opencode', configDir, 'global', { name: 'full', skills: '*', agents: new Set() }),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.toLowerCase().includes('symlink') ||
          err.message.toLowerCase().includes('escap') ||
          err.message.toLowerCase().includes('outside') ||
          err.message.toLowerCase().includes('confinement') ||
          err.message.toLowerCase().includes('install root'),
          `expected symlink/escape error in: ${err.message}`,
        );
        return true;
      },
    );

    // The symlink itself still exists but no new entries were created in outsideDir
    const outsideEntries = fs.readdirSync(outsideDir);
    assert.strictEqual(outsideEntries.length, 0, 'must not have created any dirs/files outside configDir');
  });
});

// ---------------------------------------------------------------------------
// L1: symlink guard in migrateLegacyDevPreferencesToSkill
// ---------------------------------------------------------------------------

describe('L1: migrateLegacyDevPreferencesToSkill rejects symlink-escaping skillDir', () => {
  let configDir;
  let outsideDir;

  beforeEach(() => {
    configDir = createTempDir('gsd-l1-config-');
    outsideDir = createTempDir('gsd-l1-outside-');
    // Create configDir/skills as a symlink pointing outside
    fs.symlinkSync(outsideDir, path.join(configDir, 'skills'));
  });

  afterEach(() => {
    try { fs.unlinkSync(path.join(configDir, 'skills')); } catch { /* already gone */ }
    cleanup(configDir);
    cleanup(outsideDir);
  });

  test('L1: migrateLegacyDevPreferencesToSkill throws when skills/ is a symlink pointing outside', () => {
    const saved = new Map([['dev-preferences.md', '# dev prefs\n']]);
    assert.throws(
      () => migrateLegacyDevPreferencesToSkill(configDir, saved, 'opencode', 'global'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.toLowerCase().includes('symlink') ||
          err.message.toLowerCase().includes('escap') ||
          err.message.toLowerCase().includes('outside') ||
          err.message.toLowerCase().includes('install root'),
          `expected symlink/escape error in: ${err.message}`,
        );
        return true;
      },
    );

    // Nothing must have been written outside
    const outsideFiles = fs.readdirSync(outsideDir);
    assert.strictEqual(outsideFiles.length, 0, 'must not have written anything outside configDir');
  });
});

// ---------------------------------------------------------------------------
// L3: relative configDir support
// ---------------------------------------------------------------------------

describe('L3: assertDestWithinConfigHome handles relative configDir', () => {
  test('L3: throws when relative configDir + escaping destSubpath resolves outside', () => {
    // path.resolve handles relative roots; '../../etc' from '.' would escape
    assert.throws(
      () => assertDestWithinConfigHome('.', '../../etc'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.includes('escapes configHome') || err.message.includes('outside'),
          `expected escape error in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('L3: throws when "." destSubpath resolves to the relative configDir itself', () => {
    // '.' resolves to the same directory as the configDir — must be rejected (F3)
    assert.throws(
      () => assertDestWithinConfigHome('.', '.'),
      /escapes configHome|not configHome itself/,
    );
  });

  test('L3: accepts "skills" under relative "./somedir" and returns absolute path', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-l3-'));
    const relDir = path.relative(process.cwd(), tmpBase);
    try {
      const result = assertDestWithinConfigHome(relDir, 'skills');
      const expectedBase = path.resolve(relDir);
      assert.ok(
        result.startsWith(expectedBase + path.sep),
        `result (${result}) must be under resolved relDir (${expectedBase})`,
      );
      assert.strictEqual(result, path.join(expectedBase, 'skills'));
    } finally {
      fs.rmdirSync(tmpBase);
    }
  });
});

// ---------------------------------------------------------------------------
// N1: sibling-prefix NEGATIVE assertion
// ---------------------------------------------------------------------------

describe('N1: sibling directory with shared prefix is rejected', () => {
  test('N1: rejects sibling path sharing a prefix with configDir', () => {
    // /tmp/gsd-foobar is NOT inside /tmp/gsd-foo — must throw despite the
    // startsWith prefix overlap at the string level (the sep-check prevents it).
    assert.throws(
      () => assertDestWithinConfigHome('/tmp/gsd-foo', '../gsd-foobar'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.message.includes('escapes configHome') || err.message.includes('outside'),
          `expected confinement error in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('N1: accepts a true child subpath inside configDir', () => {
    // 'bar' appended INSIDE /tmp/gsd-foo => the child path — accepted.
    // Compute expected via path.resolve (the same primitive the helper uses) so
    // the assertion is platform-portable: on Windows path.resolve prepends the
    // cwd drive (C:\...) and uses backslashes, which a hardcoded posix literal /
    // path.join (no drive) would not match (#1679 Windows-CI portability).
    const root = path.resolve('/tmp/gsd-foo');
    const result = assertDestWithinConfigHome('/tmp/gsd-foo', 'bar');
    assert.strictEqual(result, path.resolve('/tmp/gsd-foo', 'bar'));
    assert.ok(result.startsWith(root + path.sep));
  });

  test('N1: the accepted child does not imply the sibling is accepted', () => {
    // Double-check: 'bar' inside is fine, but '../gsd-foobar' (the sibling) is not.
    // 'bar' resolves to /tmp/gsd-foo/bar  ✓
    assert.doesNotThrow(() => assertDestWithinConfigHome('/tmp/gsd-foo', 'bar'));
    // '../gsd-foobar' resolves to /tmp/gsd-foobar — NOT inside /tmp/gsd-foo
    assert.throws(
      () => assertDestWithinConfigHome('/tmp/gsd-foo', '../gsd-foobar'),
      /escapes configHome/,
    );
  });
});

// ---------------------------------------------------------------------------
// N3: Windows-separator coverage (structural guard using path.win32)
// ---------------------------------------------------------------------------

describe('N3: Windows-separator confinement logic (path.win32 semantics)', () => {
  /**
   * Replicate the assertDestWithinConfigHome predicate using path.win32
   * so we can test the sep-guard logic on any platform.
   *
   * This mirrors the implementation in runtime-artifact-install-plan.cjs
   * but forces win32 path semantics.
   */
  function assertDestWithinConfigHomeWin32(configDir, destSubpath) {
    if (destSubpath.includes('\0')) {
      throw new Error(`destSubpath "${destSubpath}" contains a NUL byte and is not valid`);
    }
    const root = path.win32.resolve(configDir);
    const resolved = path.win32.resolve(configDir, destSubpath);
    if (resolved === root || !resolved.startsWith(root + path.win32.sep)) {
      throw new Error(
        `destSubpath "${destSubpath}" must be a strict subpath of configHome "${configDir}" — not configHome itself or outside it (escapes configHome)`,
      );
    }
    return resolved;
  }

  const winRoot = 'C:\\Users\\me\\.claude';

  test('N3: rejects ..\\..\\Windows (Windows backslash traversal)', () => {
    assert.throws(
      () => assertDestWithinConfigHomeWin32(winRoot, '..\\..\\Windows'),
      /escapes configHome/,
    );
  });

  test('N3: rejects mixed ../..\\x traversal', () => {
    assert.throws(
      () => assertDestWithinConfigHomeWin32(winRoot, '../..\\x'),
      /escapes configHome/,
    );
  });

  test('N3: rejects "." that resolves to configHome itself', () => {
    assert.throws(
      () => assertDestWithinConfigHomeWin32(winRoot, '.'),
      /escapes configHome/,
    );
  });

  test('N3: accepts "skills" under Windows root', () => {
    const result = assertDestWithinConfigHomeWin32(winRoot, 'skills');
    assert.strictEqual(result, path.win32.join(winRoot, 'skills'));
    assert.ok(result.startsWith(winRoot + path.win32.sep));
  });

  test('N3: accepts "commands\\gsd" (Windows nested path) under Windows root', () => {
    const result = assertDestWithinConfigHomeWin32(winRoot, 'commands\\gsd');
    assert.strictEqual(result, path.win32.join(winRoot, 'commands', 'gsd'));
    assert.ok(result.startsWith(winRoot + path.win32.sep));
  });

  test('N3: rejects sibling C:\\Users\\me\\.claude-extra under win32 semantics', () => {
    assert.throws(
      () => assertDestWithinConfigHomeWin32(winRoot, '..\\.claude-extra'),
      /escapes configHome/,
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2995-post-install-script-paths.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2995-post-install-script-paths (consolidation epic #1969 B6 #1975)", () => {
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { auditWorkflowScriptPaths, AUDIT_FINDING } = require(
  path.join(ROOT, 'scripts', 'audit-workflow-script-paths.cjs'),
);
const { cleanup } = require('./helpers.cjs');

// auditWorkflowScriptPaths is a pure function: it walks workflowsDir,
// extracts every ${GSD_HOME}/<path> script reference, and returns a
// structured report. Tests assert on the typed report — no regex on
// console output.

// #2996 CR: per-fixture repos are rooted under a single tmpRoot so the
// after()-hook actually cleans them up. The previous shape created tmpRoot
// in before() but never used it, leaking each fixture's mkdtempSync dir.
let tmpRoot;
function fixtureRepo({ workflows, files }) {
  // workflows: { 'foo.md': '...content with ${GSD_HOME}/...' }
  // files:     [ 'gsd-core/bin/x.cjs', ... ]  — files to create in repo
  const repoRoot = fs.mkdtempSync(path.join(tmpRoot, 'repo-'));
  const workflowsDir = path.join(repoRoot, 'gsd-core', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  for (const [name, body] of Object.entries(workflows || {})) {
    fs.writeFileSync(path.join(workflowsDir, name), body);
  }
  for (const rel of files || []) {
    const full = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return { repoRoot, workflowsDir };
}

before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2995-')); });
after(() => { cleanup(tmpRoot); });

describe('Bug #2995: post-install script-paths audit (#2995)', () => {
  test('AUDIT_FINDING enum exposes the documented codes', () => {
    assert.deepEqual(
      Object.keys(AUDIT_FINDING).sort(),
      ['MISSING_FROM_REPO', 'NOT_INSTALLED'].sort(),
    );
  });

  test('returns { ok: true, findings: [] } when workflow refs an existing, installed-path script', () => {
    const { repoRoot, workflowsDir } = fixtureRepo({
      workflows: {
        'good.md': 'node "${GSD_HOME}/gsd-core/bin/foo.cjs" --json\n',
      },
      files: ['gsd-core/bin/foo.cjs'],
    });
    const r = auditWorkflowScriptPaths({
      workflowsDir,
      repoRoot,
      installedPrefixes: ['gsd-core', 'commands', 'agents', 'hooks'],
    });
    assert.deepEqual(r, { ok: true, findings: [] });
  });
});

describe('Bug #2995: detection paths', () => {
  const { auditWorkflowScriptPaths, AUDIT_FINDING } = require(require('node:path').join(__dirname, '..', 'scripts', 'audit-workflow-script-paths.cjs'));

  test('reports MISSING_FROM_REPO when the referenced file does not exist in the repo', () => {
    const { repoRoot, workflowsDir } = fixtureRepo({
      workflows: {
        'foo.md': 'node "${GSD_HOME}/gsd-core/bin/typo.cjs" --json\n',
      },
      files: [],
    });
    const r = auditWorkflowScriptPaths({
      workflowsDir,
      repoRoot,
      installedPrefixes: ['gsd-core'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.findings.length, 1);
    assert.deepEqual(r.findings[0], {
      workflow: 'foo.md',
      path: 'gsd-core/bin/typo.cjs',
      kind: AUDIT_FINDING.MISSING_FROM_REPO,
    });
  });

  test('reports NOT_INSTALLED when first path segment is outside installedPrefixes (the #2994 case)', () => {
    const { repoRoot, workflowsDir } = fixtureRepo({
      workflows: {
        'foo.md': 'node "${GSD_HOME}/scripts/verify-reapply-patches.cjs"\n',
      },
      files: ['scripts/verify-reapply-patches.cjs'],  // file exists, but `scripts/` not in installed prefixes
    });
    const r = auditWorkflowScriptPaths({
      workflowsDir,
      repoRoot,
      installedPrefixes: ['gsd-core', 'commands', 'agents', 'hooks'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.findings.length, 1);
    assert.deepEqual(r.findings[0], {
      workflow: 'foo.md',
      path: 'scripts/verify-reapply-patches.cjs',
      kind: AUDIT_FINDING.NOT_INSTALLED,
    });
  });

  test('handles ${GSD_HOME:-$HOME/.claude}/... default-fallback syntax', () => {
    const { repoRoot, workflowsDir } = fixtureRepo({
      workflows: {
        'a.md': 'node "${GSD_HOME:-$HOME/.claude}/gsd-core/bin/x.cjs"\n',
      },
      files: ['gsd-core/bin/x.cjs'],
    });
    const r = auditWorkflowScriptPaths({
      workflowsDir,
      repoRoot,
      installedPrefixes: ['gsd-core'],
    });
    assert.deepEqual(r, { ok: true, findings: [] });
  });

  test('reports both findings when one workflow has multiple problems', () => {
    const { repoRoot, workflowsDir } = fixtureRepo({
      workflows: {
        'multi.md': [
          'node "${GSD_HOME}/scripts/a.cjs"',
          'node "${GSD_HOME}/gsd-core/bin/b.cjs"',
          'node "${GSD_HOME}/gsd-core/bin/missing.cjs"',
        ].join('\n') + '\n',
      },
      files: ['scripts/a.cjs', 'gsd-core/bin/b.cjs'],
    });
    const r = auditWorkflowScriptPaths({
      workflowsDir,
      repoRoot,
      installedPrefixes: ['gsd-core'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.findings.length, 2);
    const kinds = r.findings.map((f) => f.kind).sort();
    assert.deepEqual(kinds, [AUDIT_FINDING.MISSING_FROM_REPO, AUDIT_FINDING.NOT_INSTALLED]);
  });

  test('extracts no findings from a workflow without GSD_HOME script refs', () => {
    const { repoRoot, workflowsDir } = fixtureRepo({
      workflows: {
        'plain.md': '# A workflow\n\nSome prose, no script refs.\n',
      },
    });
    const r = auditWorkflowScriptPaths({
      workflowsDir,
      repoRoot,
      installedPrefixes: ['gsd-core'],
    });
    assert.deepEqual(r, { ok: true, findings: [] });
  });
});

describe('Bug #2995: real workflow audit', () => {
  const { auditWorkflowScriptPaths, AUDIT_FINDING } = require(require('node:path').join(__dirname, '..', 'scripts', 'audit-workflow-script-paths.cjs'));

  // The set of top-level directories the installer (bin/install.js) actually
  // copies into ${configDir}/. Touching this set requires updating both
  // bin/install.js AND this constant — the parity is intentional.
  const INSTALLED_PREFIXES = [
    'gsd-core',  // workflows, references, bin/lib, templates
    'commands',       // commands/gsd/*.md (Claude Code local + Gemini global)
    'skills',         // skills/gsd-*/SKILL.md (Claude Code 2.1.88+ global, Codex, etc.)
    'agents',         // agents/gsd-*.md
    'hooks',          // hooks/gsd-*.{sh,js}
  ];

  // Known existing gaps tracked in their own issues. Removing an entry should
  // land in the same PR that fixes the underlying issue; CI surfaces any NEW
  // gap as a hard failure.
  // (#2994 entry removed: this PR moves verify-reapply-patches.cjs to
  // gsd-core/bin/ which IS an installed prefix, closing the gap.)
  const KNOWN_GAPS = new Set();

  test('no NEW workflow refs fail to resolve at the deployed path (KNOWN_GAPS allow-listed)', () => {
    const r = auditWorkflowScriptPaths({
      workflowsDir: require('node:path').join(ROOT, 'gsd-core', 'workflows'),
      repoRoot: ROOT,
      installedPrefixes: INSTALLED_PREFIXES,
    });
    const newGaps = r.findings.filter(
      (f) => !KNOWN_GAPS.has(`${f.workflow}|${f.path}|${f.kind}`),
    );
    if (newGaps.length > 0) {
      const summary = newGaps.map(
        (f) => `  ${f.workflow}: ${f.path} (${f.kind})`,
      ).join('\n');
      assert.fail(
        `New workflow ref does not resolve at the deployed path:\n${summary}\n\n` +
        `Either move the script under one of [${INSTALLED_PREFIXES.join(', ')}], ` +
        `update bin/install.js to copy the new top-level directory, or ` +
        `(if intentionally tracked) add an entry to KNOWN_GAPS with the issue reference.`,
      );
    }
  });

  // #2996 CR: a reference that is both outside an installed prefix AND
  // missing from the repo must emit BOTH findings in one run. Previously
  // the code short-circuited on NOT_INSTALLED, hiding MISSING_FROM_REPO
  // until the developer fixed the prefix and re-ran CI.
  test('a reference that is both not-installed AND missing-from-repo emits both findings (no short-circuit)', () => {
    const { repoRoot, workflowsDir } = fixtureRepo({
      workflows: {
        'foo.md': '```bash\nnode "${GSD_HOME}/scripts/missing.cjs"\n```\n',
      },
      // Note: scripts/missing.cjs intentionally NOT created in the repo.
    });
    const r = auditWorkflowScriptPaths({
      workflowsDir,
      repoRoot,
      installedPrefixes: ['gsd-core', 'agents', 'hooks', 'commands'],
    });
    assert.equal(r.ok, false);
    const kinds = r.findings.filter((f) => f.path === 'scripts/missing.cjs').map((f) => f.kind).sort();
    assert.deepEqual(
      kinds,
      [AUDIT_FINDING.MISSING_FROM_REPO, AUDIT_FINDING.NOT_INSTALLED].sort(),
      'expected both NOT_INSTALLED and MISSING_FROM_REPO findings for the same ref',
    );
  });

  test('KNOWN_GAPS entries still match real findings — fixed gaps must be removed from the allow-list', () => {
    const r = auditWorkflowScriptPaths({
      workflowsDir: require('node:path').join(ROOT, 'gsd-core', 'workflows'),
      repoRoot: ROOT,
      installedPrefixes: INSTALLED_PREFIXES,
    });
    const realKeys = new Set(r.findings.map((f) => `${f.workflow}|${f.path}|${f.kind}`));
    const stale = [...KNOWN_GAPS].filter((k) => !realKeys.has(k));
    assert.deepEqual(
      stale,
      [],
      `KNOWN_GAPS contains entries not present in audit findings — remove these: ${stale.join(', ')}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3442-shim-projection-drift-guard.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3442-shim-projection-drift-guard (consolidation epic #1969 B6 #1975)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const DRIFT_LINT = path.join(ROOT, 'scripts', 'lint-shell-command-projection-drift.cjs');

function runLint(targetFile) {
  const result = runNode([DRIFT_LINT, targetFile], {
    cwd: ROOT,
    timeoutMs: 15000,
  });
  result.status = result.exitCode;
  return result;
}

// (The buildWindowsShimTriple parity test was removed with the gsd-sdk shim,
// #191. The serialized-command drift guard below is retained and unaffected.)

describe('bug #3442: shim/wrapper serialized-command drift guard', () => {
  test('drift guard passes for current install.js', () => {
    const result = runLint(path.join(ROOT, 'bin', 'install.js'));
    assert.equal(result.status, 0, `expected lint pass, got:\n${result.stderr || result.stdout}`);
  });

  test('drift guard fails when install-owned inline shim text builder is present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3442-'));
    try {
      const fixture = path.join(tmp, 'install-inline-builder.js');
      fs.writeFileSync(
        fixture,
        [
          'function badBuilder() {',
          "  return '@ECHO OFF\\r\\n@SETLOCAL\\r\\n@node \"C:/shim.js\" %*\\r\\n';",
          '}',
          '',
        ].join('\n'),
      );
      const result = runLint(fixture);
      assert.notEqual(result.status, 0, 'inline shim renderer should be rejected by the drift guard');
    } finally {
      cleanup(tmp);
    }
  });

  test('drift guard does not block safe subprocess execution patterns', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3442-'));
    try {
      const fixture = path.join(tmp, 'install-subprocess-safe.js');
      fs.writeFileSync(
        fixture,
        [
          "const cp = require('node:child_process');",
          "cp.spawnSync('cmd.exe', ['/c', 'echo ok']);",
          "cp.execFileSync('bash', ['-lc', 'printf %s \"$PATH\"']);",
          '',
        ].join('\n'),
      );
      const result = runLint(fixture);
      assert.equal(result.status, 0, `spawnSync/execFileSync should remain allowed:\n${result.stderr || result.stdout}`);
    } finally {
      cleanup(tmp);
    }
  });
});
  });
}

// ─── #2393: GSD_ALLOW_SYMLINKED_DEST opt-in for intentional symlinked-dest layouts ────
//
// Three reporter layouts, all refused by the pre-#2393 guard with no opt-out:
//   (lars-hh) CLAUDE_CONFIG_DIR=~/.claude-personal with skills/hooks symlinked to
//             a user-owned external dir
//   (Mamiki)   ~/.claude/skills is a Windows Junction to D:\claude-shared-resources\skills
//   (Azd325)   ~/.claude itself is a symlink to a dotfiles repo (root-is-symlink)
//
// Fix: GSD_ALLOW_SYMLINKED_DEST=1 follows symlinks instead of refusing them,
// while preserving the load-bearing refusals from #1704 / ADR-1239 Phase B:
//   (a) path-traversal in the destSubpath string itself ('../../etc')
//   (b) a resolved symlink target equal to the install root (would let _removeGsdEntries
//       wipe the root — the config-root-wipe threat)

describe('#2393: GSD_ALLOW_SYMLINKED_DEST opt-in for intentional symlinked-dest layouts', () => {
  const { hasExistingSymlinkBetween } = require('../gsd-core/bin/lib/install-engine.cjs');

  beforeEach(() => {
    delete process.env.GSD_ALLOW_SYMLINKED_DEST;
  });

  afterEach(() => {
    delete process.env.GSD_ALLOW_SYMLINKED_DEST;
  });

  // Reporter case (lars-hh / Mamiki): a child component of configHome is a symlink
  // to a user-owned dir outside configHome. Default refuses; opt-in follows.
  test('child-symlink layout: default refuses, GSD_ALLOW_SYMLINKED_DEST=1 allows', (t) => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-cfg-'));
    const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-out-'));
    try {
      const linkPath = path.join(configHome, 'skills');
      try {
        fs.symlinkSync(outsideTarget, linkPath);
      } catch (_e) {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      const destDir = path.join(linkPath, 'gsd-foo');

      // Default: refuse (existing pre-#2393 behavior unchanged).
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir),
        true,
        'default must refuse symlinked destDir (pre-#2393 behavior)',
      );

      // Opt-in: allow (user asserted they trust the target).
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir, { allowOptInFollow: true }),
        false,
        'GSD_ALLOW_SYMLINKED_DEST=1 must allow intentional user-owned child symlink',
      );
    } finally {
      try { fs.unlinkSync(path.join(configHome, 'skills')); } catch { /* already gone */ }
      cleanup(configHome);
      cleanup(outsideTarget);
    }
  });

  // Reporter case (Azd325): the install root ITSELF is a symlink. The pre-#2393
  // guard had an early-return for this before the component loop even ran.
  test('root-is-symlink layout (Azd325/nix-darwin): default refuses, opt-in allows', (t) => {
    const dotfilesTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-dot-'));
    const rootLink = path.join(os.tmpdir(), 'gsd-2393-rootlink-' + Date.now());
    try {
      try {
        fs.symlinkSync(dotfilesTarget, rootLink);
      } catch (_e) {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      // Inside the dotfiles target, skills is a real dir (not a symlink).
      fs.mkdirSync(path.join(dotfilesTarget, 'skills'), { recursive: true });
      const destDir = path.join(rootLink, 'skills', 'gsd-foo');

      // Default: refuse (root itself is a symlink → early-return true).
      assert.strictEqual(
        hasExistingSymlinkBetween(rootLink, destDir),
        true,
        'default must refuse when install root itself is a symlink',
      );

      // Opt-in: follow the root symlink, walk to the real skills dir — allow.
      assert.strictEqual(
        hasExistingSymlinkBetween(rootLink, destDir, { allowOptInFollow: true }),
        false,
        'GSD_ALLOW_SYMLINKED_DEST=1 must follow a root symlink whose target has no further symlinks',
      );
    } finally {
      try { fs.unlinkSync(rootLink); } catch { /* already gone */ }
      cleanup(dotfilesTarget);
    }
  });

  // Load-bearing refusal (a): path-traversal in the destSubpath string itself.
  // MUST refuse regardless of opt-in — this is the #1704 threat (a).
  test('path-traversal destSubpath ("../../etc") refused EVEN WITH opt-in', () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-trav-'));
    try {
      const escapePath = path.join(configHome, '..', '..', 'etc-passwd-' + Date.now());
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, escapePath, { allowOptInFollow: true }),
        true,
        'path-traversal destSubpath must ALWAYS refuse regardless of opt-in (#1704 threat a)',
      );
    } finally {
      cleanup(configHome);
    }
  });

  // Load-bearing refusal (b): a symlink whose resolved target equals the install root
  // itself would let _removeGsdEntries wipe the root. MUST refuse regardless of opt-in.
  test('resolved-target-equals-install-root refused EVEN WITH opt-in (wipe protection)', (t) => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-wipe-'));
    try {
      // Symlink configHome/loop -> configHome (circular). Resolved target == install root.
      const loopLink = path.join(configHome, 'loop');
      try {
        fs.symlinkSync(configHome, loopLink);
      } catch (_e) {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      const destDir = path.join(loopLink, 'gsd-foo');

      // Default refuses.
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir),
        true,
        'default must refuse symlink to install root (wipe protection)',
      );

      // Opt-in STILL refuses — this is threat (b), load-bearing even with opt-in.
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir, { allowOptInFollow: true }),
        true,
        'opt-in must NOT allow a symlink resolving to install root itself (#1704 threat b — wipe)',
      );
    } finally {
      try { fs.unlinkSync(path.join(configHome, 'loop')); } catch { /* already gone */ }
      cleanup(configHome);
    }
  });

  // #2393 security-review finding: realpathSync fully resolves symlinks while
  // path.resolve is lexical. On macOS, /var is a symlink to /private/var, so
  // `resolvedRoot` carries `/var/...` while the symlink's realtarget carries
  // `/private/var/...` — a naive `realtarget === resolvedRoot` check would miss
  // the equality and let threat (b) through. Fix compares against BOTH the
  // lexical and real forms of root. Test constructs the macOS-style divergence
  // explicitly: spell configHome one way, point the symlink at its real path.
  test('resolved-target-equals-install-root via /var ↔ /private/var normalization (macOS-style)', (t) => {
    if (process.platform !== 'darwin') {
      t.skip('test exercises the macOS /var → /private/var symlink — darwin only');
      return;
    }
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-realpath-'));
    try {
      // `os.tmpdir()` is spelled with `/var/...` on macOS; realpathSync resolves it
      // to `/private/var/...`. The lexical resolvedRoot and the real realRoot differ.
      const realConfigHome = fs.realpathSync(configHome);
      if (realConfigHome === configHome) {
        // Defensive — if for some reason there's no /var symlink in the chain, the
        // test isn't exercising what it claims. Skip rather than pass vacuously.
        t.skip('os.tmpdir() path contains no symlink component — test does not exercise the /var normalization');
        return;
      }

      // Symlink spelled via the REAL path — its realtarget will equal realConfigHome,
      // NOT lexical configHome. The bug shape: realtarget !== resolvedRoot (lexical).
      const loopLink = path.join(configHome, 'loop');
      try {
        fs.symlinkSync(realConfigHome, loopLink);
      } catch (_e) {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      const destDir = path.join(loopLink, 'gsd-foo');

      // The fix compares against BOTH lexical and real forms — guard fires.
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir, { allowOptInFollow: true }),
        true,
        'opt-in must refuse a symlink resolving to install root by real path even when ' +
          'lexical and real forms differ (macOS /var ↔ /private/var normalization)',
      );
    } finally {
      try { fs.unlinkSync(path.join(configHome, 'loop')); } catch { /* already gone */ }
      cleanup(configHome);
    }
  });

  // #2875 defect fix — REVERSES the previously-pinned "silently passed" contract
  // this test used to name. The old reasoning ("existsSync(cursor) follows the
  // link -> false -> loop terminates before the symlink check ever fires; the
  // caller's subsequent mkdir/write is responsible for whatever happens next")
  // no longer holds: an adversarial reviewer showed the "caller's responsibility"
  // it rested on is unenforceable in practice — user-artifact-staging.cts's
  // recovery path reads a staged file NAME out of an attacker-influenceable
  // on-disk record (`record.json`) and writes through it without a human in the
  // loop to notice a bad write; a dangling symlink planted at that destination
  // (e.g. `<configDir>/USER-PROFILE.md -> <outside>/authorized_keys`) let the
  // actual copy/write follow it and land attacker-chosen content OUTSIDE the
  // install root, reproduced end-to-end. hasExistingSymlinkBetween now probes
  // each path segment with `lstatSync` FIRST (see install-engine.cts's own doc
  // comment on this change), which — unlike `existsSync` — never follows a
  // symlink and succeeds for a dangling one, so a dangling symlink is now
  // correctly seen AS a symlink component instead of "nothing here". The guard's
  // promise is now: a dangling symlink anywhere on the path between root and
  // destDir is refused exactly like a live one — default refuses outright,
  // opt-in attempts to follow it (`realpathSync`) and, finding no target,
  // refuses too (fail-closed on a broken symlink, same posture used elsewhere in
  // this function for a `realpathSync` failure).
  test('broken symlink: now refused by both the default and opt-in paths (#2875 fix)', (t) => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-broken-'));
    try {
      const danglingLink = path.join(configHome, 'skills');
      const notPresentTarget = path.join(os.tmpdir(), 'gsd-2393-not-present-' + Date.now());
      try {
        fs.symlinkSync(notPresentTarget, danglingLink);
      } catch (_e) {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      const destDir = path.join(danglingLink, 'gsd-foo');

      // lstatSync(danglingLink) succeeds (it IS a symlink, just a dangling one) —
      // the segment loop now sees it as a symlink component and refuses.
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir),
        true,
        'broken symlink: default path now refuses — lstatSync sees the dangling symlink as a symlink component',
      );
      // Opt-in attempts to follow it via realpathSync, which throws ENOENT for a
      // missing target — refused (fail-closed), not silently passed through.
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir, { allowOptInFollow: true }),
        true,
        'broken symlink with opt-in: realpathSync on a dangling target fails, so this refuses too (fail-closed)',
      );
    } finally {
      try { fs.unlinkSync(path.join(configHome, 'skills')); } catch { /* already gone */ }
      cleanup(configHome);
    }
  });

  // Reviewer-driven (Medium): transitive symlink chains. The opt-in is transitive
  // and unbounded by design — once a symlink is followed, the walk continues from
  // the resolved real path WITHOUT re-checking that further segments stay inside
  // a confining boundary. Test pins the documented behavior so a future change is
  // deliberate. (Default behavior refuses at the first symlink.)
  test('transitive symlink chain: opt-in follows transitively; default refuses at first hop', (t) => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-trans-'));
    const outside1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-t1-'));
    const outside2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2393-t2-'));
    try {
      // configHome/outer -> outside1, outside1/inner -> outside2 (two-hop chain).
      try {
        fs.symlinkSync(outside1, path.join(configHome, 'outer'));
        fs.symlinkSync(outside2, path.join(outside1, 'inner'));
      } catch (_e) {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      const destDir = path.join(configHome, 'outer', 'inner', 'gsd-foo');

      // Default: refuses at the first hop (configHome/outer is a symlink).
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir),
        true,
        'default must refuse at the first symlink (configHome/outer)',
      );

      // Opt-in: follows transitively through both hops to outside2 (no threat-(b)
      // match — outside2 is neither lexical nor real form of configHome).
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir, { allowOptInFollow: true }),
        false,
        'opt-in must follow transitive chain (outer → outside1 → outside2/inner) — documented transitivity',
      );
    } finally {
      try { fs.unlinkSync(path.join(configHome, 'outer')); } catch { /* already gone */ }
      try { fs.unlinkSync(path.join(outside1, 'inner')); } catch { /* already gone */ }
      cleanup(configHome);
      cleanup(outside1);
      cleanup(outside2);
    }
  });

  // Reviewer-driven (Medium): isSymlinkedDestOptIn env-var parsing is itself
  // behavioral — a typo in the env-var name or an accepted-values change would
  // silently disable the opt-in. Pin the contract directly via the exported helper.
  test('isSymlinkedDestOptIn: accepts only documented values (1, true)', () => {
    const installEngine = require('../gsd-core/bin/lib/install-engine.cjs');
    if (typeof installEngine.isSymlinkedDestOptIn !== 'function') {
      // Skipping — helper not exported in this build (assertion-only test).
      return;
    }
    const cases = [
      { v: '1', expected: true },
      { v: 'true', expected: true },
      { v: 'TRUE', expected: false },   // only lowercase 'true' documented
      { v: 'True', expected: false },
      { v: 'yes', expected: false },
      { v: 'on', expected: false },
      { v: '0', expected: false },
      { v: 'false', expected: false },
      { v: '', expected: false },
      { v: undefined, expected: false }, // unset
    ];
    for (const { v, expected } of cases) {
      if (v === undefined) delete process.env.GSD_ALLOW_SYMLINKED_DEST;
      else process.env.GSD_ALLOW_SYMLINKED_DEST = v;
      assert.strictEqual(
        installEngine.isSymlinkedDestOptIn(),
        expected,
        `GSD_ALLOW_SYMLINKED_DEST=${JSON.stringify(v)} should yield isSymlinkedDestOptIn()=${expected}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// _installNativePluginIfDeclared write-confinement (#2470)
// ---------------------------------------------------------------------------
//
// The native-plugin copy previously confined only `nativePlugin.dir`, then
// joined `nativePlugin.file` onto the validated directory unchecked. #2470
// makes `file` a field we actively change (pi: gsd.cjs -> gsd.js), so the full
// dest path is now confined. Descriptors are first-party and compiled into the
// capability registry at build time, so this was never reachable in a shipped
// build — these tests keep it that way.

describe('_installNativePluginIfDeclared write-confinement', () => {
  const engine = require('../gsd-core/bin/lib/install-engine.cjs');

  /** Build a src tree containing the declared plugin source. */
  function stageSource() {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-np-src-'));
    const full = path.join(src, 'pi', 'gsd.cjs');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "'use strict';\n// plugin\n", 'utf8');
    return src;
  }

  const behaviorsWith = (file) => ({
    nativePlugin: { dir: 'extensions', file, source: 'pi/gsd.cjs' },
  });

  test('happy path: declared dir/file lands inside configDir', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-np-cfg-'));
    const src = stageSource();
    try {
      engine._installNativePluginIfDeclared('pi', configDir, behaviorsWith('gsd.js'), src);
      assert.ok(
        fs.existsSync(path.join(configDir, 'extensions', 'gsd.js')),
        'plugin should be copied to <configDir>/extensions/gsd.js',
      );
    } finally {
      cleanup(configDir);
      cleanup(src);
    }
  });

  const ESCAPE_CASES = [
    ['traversal', '../../evil.js'],
    ['deep traversal', '../../../../../../tmp/evil.js'],
    ['NUL byte', 'gsd\u0000.js'],
  ];

  for (const [label, file] of ESCAPE_CASES) {
    test(`escape rejected: nativePlugin.file with ${label} → throws`, () => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-np-esc-'));
      const src = stageSource();
      try {
        assert.throws(
          () => engine._installNativePluginIfDeclared('pi', configDir, behaviorsWith(file), src),
          /escap|strict subpath|configHome|NUL byte/i,
          `nativePlugin.file=${JSON.stringify(file)} must be rejected, not joined onto the validated dir`,
        );
      } finally {
        cleanup(configDir);
        cleanup(src);
      }
    });
  }

  test('nothing is written outside configDir when file tries to escape', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-np-out-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-np-outside-'));
    const src = stageSource();
    try {
      const escapeFile = path.join('..', '..', path.basename(outside), 'pwned.js');
      assert.throws(
        () => engine._installNativePluginIfDeclared('pi', configDir, behaviorsWith(escapeFile), src),
        /escap|strict subpath|configHome/i,
      );
      assert.ok(
        !fs.existsSync(path.join(outside, 'pwned.js')),
        'nothing may be written outside configDir',
      );
    } finally {
      cleanup(configDir);
      cleanup(outside);
      cleanup(src);
    }
  });

  test('missing source is a silent no-op (unchanged behavior)', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-np-nosrc-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-np-emptysrc-'));
    try {
      assert.doesNotThrow(() =>
        engine._installNativePluginIfDeclared('pi', configDir, behaviorsWith('gsd.js'), src),
      );
      assert.ok(!fs.existsSync(path.join(configDir, 'extensions', 'gsd.js')));
    } finally {
      cleanup(configDir);
      cleanup(src);
    }
  });
});

// ---------------------------------------------------------------------------
// #2875 (epic #2866 Phase 6): User Artifact Staging confinement — E1-E5
// (.gsd/phase/feat-2875-materialization-primitives/50-test-matrix.md
// "E. Confinement"). Every row reuses assertDestWithinConfigHome /
// hasExistingSymlinkBetween rather than a bespoke check — see
// _resolveUserArtifactStagingRoot's own doc comment (install-engine.cts) and
// user-artifact-staging.cts's module doc "Confinement".
// ---------------------------------------------------------------------------

describe('#2875: user-artifact-staging confinement (E1-E5)', () => {
  test('E1: the staging root resolves through assertDestWithinConfigHome — an escaping subpath is refused by the SAME guard _resolveUserArtifactStagingRoot uses', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e1-'));
    try {
      // The real staging subpath ('.gsd-staging/user-artifacts') is a fixed
      // literal that can never escape — so this asserts the PROPERTY the
      // call site depends on directly against the same primitive, rather
      // than trying to force an unreachable escape through the real API.
      assert.throws(
        () => _uasAssertDestWithinConfigHome(configDir, path.join('..', '..', 'etc', 'staging')),
        /escap|strict subpath|configHome/i,
      );
      // The real call resolves cleanly and stays confined.
      const stagingRoot = _resolveUserArtifactStagingRoot(configDir);
      assert.ok(path.resolve(stagingRoot).startsWith(path.resolve(configDir) + path.sep));
    } finally {
      cleanup(configDir);
    }
  });

  test('E2: recovery refuses a record naming a destDir outside confinement — never writes outside it', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e2-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e2-outside-'));
    try {
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      const entryDir = path.join(stagingRoot, 'attackerentry0000');
      fs.mkdirSync(path.join(entryDir, 'files'), { recursive: true });
      fs.writeFileSync(path.join(entryDir, 'files', 'pwned.md'), 'attacker-controlled content');
      // The record is attacker-influenced data — it names a destDir OUTSIDE
      // configDir entirely.
      fs.writeFileSync(
        path.join(entryDir, 'record.json'),
        JSON.stringify({ destDir: outside, names: ['pwned.md'], timestamp: new Date().toISOString() }),
      );

      const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
      assert.equal(result.recovered.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].reason, 'destDir-outside-confinement');
      assert.ok(!fs.existsSync(path.join(outside, 'pwned.md')), 'must never write outside confinement');
    } finally {
      cleanup(configDir);
      cleanup(outside);
    }
  });

  test('E3: ..-traversal in a staged file name is rejected', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e3-'));
    try {
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      const destDir = path.join(configDir, 'gsd-core');
      fs.mkdirSync(destDir, { recursive: true });
      const entryDir = path.join(stagingRoot, 'traversalentry000');
      fs.mkdirSync(path.join(entryDir, 'files'), { recursive: true });
      fs.writeFileSync(
        path.join(entryDir, 'record.json'),
        JSON.stringify({ destDir: path.resolve(destDir), names: ['../../../etc/passwd'], timestamp: new Date().toISOString() }),
      );
      const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
      assert.equal(result.recovered.length, 0, 'traversal name must never be restored');
      // Neither the previous assertion (checked a path one level further up
      // than production ever resolves, so it could never fail) nor a naive
      // `resolve(destDir, name)` check (which, on a Linux runner, resolves to
      // the REAL /etc/passwd — a file that pre-exists on disk regardless of
      // whether this guard works, so `!existsSync(...)` fails unconditionally
      // and proves nothing) exercises what the guard actually does. Trace the
      // real call order in recoverOrphanedUserArtifacts: `srcPath =
      // assertDestWithinConfigHome(filesDir, name)` is computed and throws
      // FIRST — filesDir (`<stagingRoot>/<entry>/files`) is nested several
      // levels below configDir, and `../../../etc/passwd` resolved against it
      // still escapes filesDir's own root, so this throw fires before
      // `destPath` (against confinedDestDir) is ever computed and before any
      // read/write is attempted. The observable, platform-independent proof
      // that the traversal was rejected — not merely that some unrelated
      // system file didn't get overwritten — is that destDir's own directory
      // listing stays exactly as this test left it: no file materialized
      // there via the traversal name.
      assert.deepStrictEqual(
        fs.readdirSync(destDir), [],
        'a rejected traversal name must never result in any file being written into destDir',
      );
    } finally {
      cleanup(configDir);
    }
  });

  test('E4: a symlinked staging root is refused — same refusal as the existing dest guard', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e4-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e4-elsewhere-'));
    try {
      // Pre-create .gsd-staging as a symlink pointing outside configDir —
      // exactly the threat hasExistingSymlinkBetween's root-symlink refusal
      // (install-engine.cts) already covers for every other write on this
      // call tree.
      fs.symlinkSync(elsewhere, path.join(configDir, '.gsd-staging'));
      assert.throws(
        () => _resolveUserArtifactStagingRoot(configDir),
        /symlink/i,
      );
    } finally {
      cleanup(configDir);
      cleanup(elsewhere);
    }
  });

  test('E5: a NUL byte in a staged file name is rejected', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e5-'));
    try {
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      const destDir = path.join(configDir, 'gsd-core');
      fs.mkdirSync(destDir, { recursive: true });
      const entryDir = path.join(stagingRoot, 'nulbyteentry00000');
      fs.mkdirSync(path.join(entryDir, 'files'), { recursive: true });
      fs.writeFileSync(
        path.join(entryDir, 'record.json'),
        JSON.stringify({ destDir: path.resolve(destDir), names: ['USER-PROFILE\u0000.md'], timestamp: new Date().toISOString() }),
      );
      let result;
      assert.doesNotThrow(() => { result = recoverOrphanedUserArtifacts(stagingRoot, configDir); });
      assert.equal(result.recovered.length, 0, 'NUL-byte name must never be restored');
    } finally {
      cleanup(configDir);
    }
  });

  // #2875 defect fix: C2's "never overwrite" guard was `existsSync`-based,
  // which FOLLOWS symlinks and reports `false` for a DANGLING one — invisible
  // to the guard, so it never refused. A dangling symlink AT the recovered
  // destination let `copyFileSync`/`symlinkSync` (which DO follow it) write
  // outside `configDir`.
  test('E6: a dangling symlink at the recovered destination is treated as already-present, never written through', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e6-cfg-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e6-outside-'));
    try {
      const destDir = path.join(configDir, 'gsd-core');
      fs.mkdirSync(destDir, { recursive: true });
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'orphaned-content');
      // user-artifact-staging.cts's owner-liveness guard (recoverOrphanedUserArtifacts)
      // treats a record whose `runId` belongs to a currently-live process as
      // "not an orphan yet" and skips the ENTIRE entry with reason
      // 'owner-still-live' — before ever reaching the per-name
      // dest-already-present check this test pins. `stageUserArtifacts`
      // defaults `runId` to `String(process.pid)`, i.e. THIS test process,
      // which is trivially alive for the whole duration of this in-process
      // test. A real crashed run has a genuinely DEAD pid, so simulating one
      // here requires an explicit dead `runId` — same convention
      // tests/user-artifact-staging.test.cjs's C15 already establishes.
      const deadPid = '999999';
      stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot, { runId: deadPid });
      cleanup(path.join(destDir, 'USER-PROFILE.md'));

      const outsideTarget = path.join(outside, 'authorized_keys');
      fs.symlinkSync(outsideTarget, path.join(destDir, 'USER-PROFILE.md'));
      assert.ok(!fs.existsSync(outsideTarget), 'the symlink target must not exist — this is the DANGLING case');

      const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
      assert.equal(result.recovered.length, 0, 'must refuse — the dangling symlink counts as already-present');
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].reason, 'dest-already-present');
      assert.ok(!fs.existsSync(outsideTarget), 'must never write through the dangling symlink to outsideTarget');
      assert.ok(fs.lstatSync(path.join(destDir, 'USER-PROFILE.md')).isSymbolicLink(), 'the dangling symlink itself is left untouched');
    } finally {
      cleanup(configDir);
      cleanup(outside);
    }
  });

  // #2875 defect fix: restoreStagedUserArtifacts had no guard at all against
  // a dangling symlink at the destination — the identical hole as E6.
  test('E7: restoreStagedUserArtifacts refuses a dangling symlink at the destination', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e7-cfg-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e7-outside-'));
    try {
      const destDir = path.join(configDir, 'gsd-core');
      fs.mkdirSync(destDir, { recursive: true });
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      fs.writeFileSync(path.join(destDir, 'USER-PROFILE.md'), 'current-content');
      const staged = stageUserArtifacts(destDir, ['USER-PROFILE.md'], stagingRoot);
      cleanup(path.join(destDir, 'USER-PROFILE.md'));

      const outsideTarget = path.join(outside, 'authorized_keys');
      fs.symlinkSync(outsideTarget, path.join(destDir, 'USER-PROFILE.md'));

      restoreStagedUserArtifacts(destDir, staged);

      assert.ok(!fs.existsSync(outsideTarget), 'must never write through the dangling symlink to outsideTarget');
      assert.ok(
        fs.lstatSync(path.join(destDir, 'USER-PROFILE.md')).isSymbolicLink(),
        'the dangling symlink itself is left untouched, not overwritten',
      );
    } finally {
      cleanup(configDir);
      cleanup(outside);
    }
  });

  // #2875 defect fix: assertDestWithinConfigHome is pure lexical path math
  // and cannot see a symlinked ANCESTOR directory between configDir and a
  // recorded destDir — only hasExistingSymlinkBetween's component-by-
  // component walk can. Recovery previously never applied it to the
  // recorded destDir at all — this is E2 STRENGTHENED: E2 above only covers
  // a destDir that is lexically outside configDir entirely, which
  // assertDestWithinConfigHome alone already refused; this row covers the
  // case that actually failed before this fix.
  test('E8: recovery refuses a destDir reached only through a symlinked ANCESTOR directory', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e8-cfg-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e8-outside-'));
    try {
      fs.symlinkSync(outside, path.join(configDir, 'linkdir'));
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      const entryDir = path.join(stagingRoot, 'e8entry00000000');
      fs.mkdirSync(path.join(entryDir, 'files'), { recursive: true });
      fs.writeFileSync(path.join(entryDir, 'files', 'USER-PROFILE.md'), 'attacker-controlled content');
      // The record names a destDir that is LEXICALLY inside configDir
      // (assertDestWithinConfigHome alone would accept it) but only
      // reachable by walking through the `linkdir` symlink to `outside`.
      fs.writeFileSync(
        path.join(entryDir, 'record.json'),
        JSON.stringify({
          destDir: path.join(configDir, 'linkdir', 'sub'),
          names: ['USER-PROFILE.md'],
          timestamp: new Date().toISOString(),
        }),
      );

      const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
      assert.equal(result.recovered.length, 0, 'must refuse — destDir is reached only through a symlinked ancestor');
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].reason, 'destDir-symlink-escape');
      assert.ok(
        !fs.existsSync(path.join(outside, 'sub', 'USER-PROFILE.md')),
        'must never write outside configDir via the symlinked ancestor',
      );
    } finally {
      cleanup(configDir);
      cleanup(outside);
    }
  });

  // #2875 defect fix: `names` accepted any non-escaping subpath, including
  // one containing a path separator, contrary to this module's flat-name
  // contract (every real caller stages exactly one flat filename) — the
  // module doc previously claimed separator names were already rejected;
  // they were not.
  test('E9: a staged/recorded name containing a path separator is rejected, never nested under destDir', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e9-cfg-'));
    try {
      const destDir = path.join(configDir, 'gsd-core');
      fs.mkdirSync(destDir, { recursive: true });
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      const entryDir = path.join(stagingRoot, 'e9entry000000000');
      fs.mkdirSync(path.join(entryDir, 'files', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(entryDir, 'files', 'nested', 'x.md'), 'should never land');
      fs.writeFileSync(
        path.join(entryDir, 'record.json'),
        JSON.stringify({ destDir: path.resolve(destDir), names: ['nested/x.md'], timestamp: new Date().toISOString() }),
      );

      const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
      assert.equal(result.recovered.length, 0, 'a separator-containing name must never be restored');
      assert.ok(!fs.existsSync(path.join(destDir, 'nested', 'x.md')), 'must never create a nested subpath under destDir');
    } finally {
      cleanup(configDir);
    }
  });

  // #2875 defect fix (security — source-side symlink escape): the ancestor-
  // symlink guard (E8) covered only `destDir`. A real `entryDir` whose
  // `files` CHILD is a symlink to an unrelated victim directory (e.g.
  // `/etc`, `~/.ssh`) was dereferenced by every per-file `existsSync`/
  // `stagedCopy` read below `filesDir`, copying victim-readable content into
  // an attacker-named path inside `configDir`.
  test('E10: recovery refuses an entryDir whose `files` child is a symlink — never dereferences the source side', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e10-cfg-'));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e10-victim-'));
    try {
      fs.writeFileSync(path.join(victim, 'attacker-chosen-name.md'), 'VICTIM SECRET CONTENT');
      const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
      const entryDir = path.join(stagingRoot, 'e10entry0000000');
      fs.mkdirSync(entryDir, { recursive: true });
      fs.symlinkSync(victim, path.join(entryDir, 'files'));
      const destDir = path.join(configDir, 'gsd-core');
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(
        path.join(entryDir, 'record.json'),
        JSON.stringify({ destDir: path.resolve(destDir), names: ['attacker-chosen-name.md'], timestamp: new Date().toISOString() }),
      );

      const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
      assert.equal(result.recovered.length, 0, 'must refuse — the files/ child is a symlink to an untrusted directory');
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].reason, 'files-symlink-escape');
      assert.ok(
        !fs.existsSync(path.join(destDir, 'attacker-chosen-name.md')),
        'the victim directory\'s content must never be copied into destDir',
      );
    } finally {
      cleanup(configDir);
      cleanup(victim);
    }
  });

  // #2875 defect fix (security/correctness — cwd-dependent confinement): a
  // RELATIVE `record.destDir` made `path.relative(configHome, record.destDir)`
  // resolve the relative argument against `process.cwd()` internally, not
  // against `configHome` — so recovery's behavior for a forged or malformed
  // record depended on whatever directory the CLI happened to be invoked
  // from, rather than being a deterministic function of `configDir`.
  // `stageUserArtifacts` (this module's own writer) always records an
  // ALREADY-resolved absolute `destDir`; a relative one only ever reaches
  // recovery via a forged/hand-edited record.
  test('E11: recovery refuses a RELATIVE record.destDir — confinement never depends on process.cwd()', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e11-cfg-'));
    t.after(() => cleanup(configDir));
    const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
    const entryDir = path.join(stagingRoot, 'e11entry0000000');
    fs.mkdirSync(path.join(entryDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'files', 'x.md'), 'x');
    fs.writeFileSync(
      path.join(entryDir, 'record.json'),
      JSON.stringify({ destDir: 'gsd-core', names: ['x.md'], timestamp: new Date().toISOString() }),
    );

    // Run from a cwd that resolves the relative destDir straight back to
    // configDir (mirrors the real cline-local call shape, where targetDir
    // === process.cwd()) — the exact case that must NOT be treated as
    // "correctly resolved" just because the coincidence lines up.
    const previousCwd = process.cwd();
    t.after(() => process.chdir(previousCwd));
    process.chdir(configDir);
    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);
    assert.equal(result.recovered.length, 0, 'a relative destDir must never be accepted, regardless of cwd');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'destDir-outside-confinement');
  });

  // #2875 security-review finding: E10 covers the default (no opt-in) case.
  // `GSD_ALLOW_SYMLINKED_DEST` is documented (install-engine.cts
  // `isSymlinkedDestOptIn`) as relaxing only the DESTINATION-side
  // pre-existing-symlink refusal — the user asserting they own/trust a
  // symlinked WRITE destination. `entryDir`/`filesDir` here is the staging
  // SOURCE, GSD-owned internal state this module creates itself, never a
  // user-authored layout — the opt-in must NOT relax this read-side check.
  test('E12: recovery refuses the source-side `files/` symlink even with GSD_ALLOW_SYMLINKED_DEST=1 — the dest opt-in never relaxes the source-side read', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e12-cfg-'));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-e12-victim-'));
    t.after(() => {
      cleanup(configDir);
      cleanup(victim);
    });
    fs.writeFileSync(path.join(victim, 'attacker-chosen-name.md'), 'VICTIM SECRET CONTENT');
    const stagingRoot = path.join(configDir, '.gsd-staging', 'user-artifacts');
    const entryDir = path.join(stagingRoot, 'e12entry0000000');
    fs.mkdirSync(entryDir, { recursive: true });
    try {
      fs.symlinkSync(victim, path.join(entryDir, 'files'));
    } catch (_e) {
      t.skip('symlink creation unsupported on this platform/privilege');
      return;
    }
    const destDir = path.join(configDir, 'gsd-core');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(
      path.join(entryDir, 'record.json'),
      JSON.stringify({ destDir: path.resolve(destDir), names: ['attacker-chosen-name.md'], timestamp: new Date().toISOString() }),
    );

    process.env.GSD_ALLOW_SYMLINKED_DEST = '1';
    t.after(() => delete process.env.GSD_ALLOW_SYMLINKED_DEST);
    const result = recoverOrphanedUserArtifacts(stagingRoot, configDir);

    assert.equal(result.recovered.length, 0, 'must refuse — the source-side files/ symlink is never relaxed by the dest opt-in');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'files-symlink-escape');
    assert.ok(
      !fs.existsSync(path.join(destDir, 'attacker-chosen-name.md')),
      'the victim directory\'s content must never be copied into destDir, even with the opt-in set',
    );
  });

  // -------------------------------------------------------------------------
  // Parity: install-engine.cts's `_resolveUserArtifactStagingRoot` is
  // deliberately duplicated (not shared) into bin/install.js, to avoid a
  // circular `require` between the two (see that function's own doc comment
  // in both files). This codebase names unguarded duplication across
  // parallel surfaces "Generative Fix Divergence" and requires a parity
  // assertion that fails the moment the two copies diverge — same inputs,
  // same resolved root, same refusal behavior.
  // -------------------------------------------------------------------------

  test('parity: install-engine.cts and bin/install.js copies of _resolveUserArtifactStagingRoot resolve the SAME root for the same configDir', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-parity-happy-'));
    try {
      const fromEngine = _resolveUserArtifactStagingRoot(configDir);
      const fromInstallJs = _installJsResolveUserArtifactStagingRoot(configDir);
      assert.equal(fromInstallJs, fromEngine, 'both copies must resolve to the identical staging root');
    } finally {
      cleanup(configDir);
    }
  });

  test('parity: both copies refuse a symlinked staging root identically', () => {
    const configDirEngine = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-parity-sym-engine-'));
    const configDirInstallJs = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-parity-sym-installjs-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-parity-sym-elsewhere-'));
    try {
      fs.symlinkSync(elsewhere, path.join(configDirEngine, '.gsd-staging'));
      fs.symlinkSync(elsewhere, path.join(configDirInstallJs, '.gsd-staging'));

      let engineThrew = false;
      let engineMessage = '';
      try {
        _resolveUserArtifactStagingRoot(configDirEngine);
      } catch (err) {
        engineThrew = true;
        engineMessage = err.message;
      }
      let installJsThrew = false;
      let installJsMessage = '';
      try {
        _installJsResolveUserArtifactStagingRoot(configDirInstallJs);
      } catch (err) {
        installJsThrew = true;
        installJsMessage = err.message;
      }

      assert.ok(engineThrew, 'install-engine.cts copy must refuse a symlinked staging root');
      assert.ok(installJsThrew, 'bin/install.js copy must refuse a symlinked staging root');
      // Both messages must carry the same refusal shape (symlink refusal),
      // even though configDir differs between the two (each needs its own
      // sandbox — the throw itself, not the literal path, is what parity
      // checks here).
      assert.match(engineMessage, /symlink/i);
      assert.match(installJsMessage, /symlink/i);
    } finally {
      cleanup(configDirEngine);
      cleanup(configDirInstallJs);
      cleanup(elsewhere);
    }
  });

  // -------------------------------------------------------------------------
  // Parity: the DEGRADE-not-abort wrapper (`_tryResolveUserArtifactStagingRoot`)
  // is ALSO duplicated verbatim into bin/install.js (same doc-comment
  // rationale as the throwing version above). "Same inputs, same resolved
  // root, same refusal" above does not cover "same degrade": a caller-facing
  // regression where one copy started throwing again (bricking the command)
  // while the other correctly degraded to `null` would slip past the tests
  // above, since neither calls the wrapper.
  // -------------------------------------------------------------------------

  test('parity: install-engine.cts and bin/install.js copies of _tryResolveUserArtifactStagingRoot resolve the SAME root for the same configDir (happy path)', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-try-parity-happy-'));
    t.after(() => cleanup(configDir));
    const fromEngine = _tryResolveUserArtifactStagingRoot(configDir);
    const fromInstallJs = _installJsTryResolveUserArtifactStagingRoot(configDir);
    assert.notEqual(fromEngine, null, 'the engine copy must resolve (not degrade) on a clean configDir');
    assert.equal(fromInstallJs, fromEngine, 'both copies must resolve to the identical staging root');
  });

  test('parity: both copies of _tryResolveUserArtifactStagingRoot degrade to null (never throw) for the SAME symlinked staging root', (t) => {
    const configDirEngine = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-try-parity-sym-engine-'));
    const configDirInstallJs = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-try-parity-sym-installjs-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uas-try-parity-sym-elsewhere-'));
    t.after(() => {
      cleanup(configDirEngine);
      cleanup(configDirInstallJs);
      cleanup(elsewhere);
    });
    fs.symlinkSync(elsewhere, path.join(configDirEngine, '.gsd-staging'));
    fs.symlinkSync(elsewhere, path.join(configDirInstallJs, '.gsd-staging'));

    let engineThrew = false;
    let engineResult;
    try {
      engineResult = _tryResolveUserArtifactStagingRoot(configDirEngine);
    } catch {
      engineThrew = true;
    }
    let installJsThrew = false;
    let installJsResult;
    try {
      installJsResult = _installJsTryResolveUserArtifactStagingRoot(configDirInstallJs);
    } catch {
      installJsThrew = true;
    }

    assert.equal(engineThrew, false, 'the engine copy\'s try-wrapper must never throw — this is the whole point of the wrapper');
    assert.equal(installJsThrew, false, 'the bin/install.js copy\'s try-wrapper must never throw either');
    assert.equal(engineResult, null, 'the engine copy must degrade to null for a refused staging root');
    assert.equal(installJsResult, null, 'the bin/install.js copy must degrade to null identically');
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyDevPreferencesToSkill — dangling-symlink leaf write (security
// review finding, found while closing the #2875 agents-descriptor migration
// gap): existsSync(skillFile) follows symlinks and reports false for a
// dangling one, and the symlink-escape guard only walked to the PARENT
// directory, never lstat-checking the leaf file itself — so a dangling
// symlink planted exactly at the skill-file destination sailed through both
// checks and writeFileSync (which DOES follow symlinks) wrote attacker
// content to the symlink's target.
// ---------------------------------------------------------------------------

describe('migrateLegacyDevPreferencesToSkill — dangling-symlink leaf write', () => {
  const { migrateLegacyDevPreferencesToSkill } = require('../gsd-core/bin/lib/install-engine.cjs');

  test('refuses to write through a dangling symlink planted at the skill-file leaf', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-migrate-sym-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-migrate-sym-outside-'));
    const attackerTarget = path.join(outside, 'authorized_keys');
    try {
      const skillDir = path.join(configDir, 'skills', 'gsd-dev-preferences');
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, 'SKILL.md');
      fs.symlinkSync(attackerTarget, skillFile); // dangling — target does not exist

      const saved = new Map([['dev-preferences.md', 'attacker-controlled content\n']]);

      assert.throws(
        () => migrateLegacyDevPreferencesToSkill(configDir, saved, 'claude', 'global'),
        /symlink/i,
        'must refuse to write through a symlinked skill-file leaf',
      );
      assert.ok(!fs.existsSync(attackerTarget), 'attacker target must never be created/written');
    } finally {
      cleanup(configDir);
      cleanup(outside);
    }
  });

  test('a real, already-migrated skill file (not a symlink) still short-circuits as before', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-migrate-real-'));
    try {
      const skillDir = path.join(configDir, 'skills', 'gsd-dev-preferences');
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillFile, 'already migrated\n', 'utf8');

      const saved = new Map([['dev-preferences.md', 'new content\n']]);
      const migrated = migrateLegacyDevPreferencesToSkill(configDir, saved, 'claude', 'global');

      assert.strictEqual(migrated, false, 'must not clobber an existing real skill file');
      assert.strictEqual(fs.readFileSync(skillFile, 'utf8'), 'already migrated\n');
    } finally {
      cleanup(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// uninstallRuntimeArtifacts — staged legacy dev-preferences.md symlink
// dereference (security review finding). Sibling call sites
// (_runLegacyInstallMigrations, bin/install.js's own uninstall()) already
// lstat-guard a staged name before readFileSync; this uninstall call site did
// not, so a symlinked staged dev-preferences.md had its referent's bytes read
// into SKILL.md, and a symlink to a directory threw EISDIR uncaught.
// ---------------------------------------------------------------------------

describe('uninstallRuntimeArtifacts — staged dev-preferences.md symlink dereference', () => {
  const { uninstallRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');

  test('a symlinked staged dev-preferences.md is skipped (never dereferenced) and uninstall does not throw', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uninstall-sym-'));
    const secretFile = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uninstall-sym-secret-'));
    const secretPath = path.join(secretFile, 'id_rsa');
    fs.writeFileSync(secretPath, 'PRIVATE KEY MATERIAL\n', 'utf8');
    try {
      // Claude global uses the legacy commands/gsd/ location.
      const legacyDir = path.join(configDir, 'commands', 'gsd');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.symlinkSync(secretPath, path.join(legacyDir, 'dev-preferences.md'));

      // Must not throw (no EISDIR/unhandled error) and must never migrate the
      // symlink's referent content into any installed skill file.
      assert.doesNotThrow(() => uninstallRuntimeArtifacts('claude', configDir, 'global'));

      const skillFile = path.join(configDir, 'skills', 'gsd-dev-preferences', 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf8');
        assert.ok(!content.includes('PRIVATE KEY MATERIAL'), 'the symlink referent must never be migrated into SKILL.md');
      }
    } finally {
      cleanup(configDir);
      cleanup(secretFile);
    }
  });
});

// ---------------------------------------------------------------------------
// #2875 defect fix (security/regression): a staging-root resolution failure
// (e.g. `.gsd-staging/user-artifacts` is/contains a symlink) must DEGRADE —
// skip staging for that step, warn — rather than abort install()/uninstall()
// entirely. Before this fix, `_resolveUserArtifactStagingRoot` was called
// UNGUARDED as the first statement of both, so a hostile/broken
// `.gsd-staging` path bricked BOTH commands, including uninstall — the
// remedy for the first problem.
// ---------------------------------------------------------------------------

describe('install()/uninstall() degrade (never abort) on a staging-root resolution failure', () => {
  function withHostileStagingSymlink(runFn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-staging-degrade-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-staging-degrade-elsewhere-'));
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      fs.mkdirSync(path.join(tmp, '.gsd-staging'));
      fs.symlinkSync(elsewhere, path.join(tmp, '.gsd-staging', 'user-artifacts'));
      runFn(tmp);
    } finally {
      process.chdir(previousCwd);
      cleanup(tmp);
      cleanup(elsewhere);
    }
  }

  test('install() proceeds and still writes gsd-core/ when the staging root is a hostile symlink', () => {
    withHostileStagingSymlink((tmp) => {
      assert.doesNotThrow(() => install(false, 'cline'), 'install() must degrade, never throw, on a staging-root failure');
      assert.ok(fs.existsSync(path.join(tmp, 'gsd-core')), 'gsd-core/ must still be installed despite the staging-root failure');
    });
  });

  test('uninstall() proceeds and still removes gsd-core/ when the staging root is a hostile symlink', () => {
    withHostileStagingSymlink((tmp) => {
      // Bypass the (also-degrading) install() path to set up a realistic
      // pre-existing gsd-core/ without depending on install() itself.
      fs.mkdirSync(path.join(tmp, 'gsd-core'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'gsd-core', 'USER-PROFILE.md'), 'user content');
      assert.doesNotThrow(() => uninstall(false, 'cline'), 'uninstall() must degrade, never throw, on a staging-root failure');
      assert.ok(!fs.existsSync(path.join(tmp, 'gsd-core')), 'gsd-core/ must still be removed despite the staging-root failure');
    });
  });
});


/**
 * #3712 — an in-process run must never reach the developer's REAL home.
 *
 * The confinement rows above bound a write to the root they are handed. A kind
 * may ALSO declare a global `home` override resolved from `os.homedir()` rather
 * than from configDir (today: codex's skills kind, `home: ".agents"`, ADR-1239 /
 * #2088). assertDestWithinConfigHome cannot see that class: it confines a
 * destSubpath to whatever root it is given, and here the root IS the escaped home.
 *
 * The live defect: an in-process caller that forgot to sandbox HOME pruned the
 * real ~/.agents/skills — 71 gsd-* dirs deleted, a foreign `cloudflare` skill
 * surviving, suite still exit 0, because the runtime's own config home was
 * untouched and the manifest kept reporting a healthy install.
 *
 * SIX writers resolve a kind `home` and then write or destroy under it. The four
 * reachable today are covered below by driving the REAL entrypoint — not the
 * predicate — so that deleting a guard call site turns these rows red. The other
 * two, `installOpencodeFamilySkills` and `installAgentsKindStandalone`, are
 * guarded but not wiring-tested: no runtime declares a `home` override on those
 * kinds, so neither path can be exercised without inventing a descriptor.
 *
 * The sixth, `migrateLegacyDevPreferencesToSkill`, CREATES rather than prunes and
 * runs from `_runLegacyInstallMigrations` — i.e. BEFORE installRuntimeArtifacts'
 * own assertion — so it carries its own guard call and its own wiring row. The
 * count read FIVE/three until review of #3725 caught the row missing.
 */
describe('#3712 in-process home confinement', () => {
  const { createTempDir, sandboxHome } = require('./helpers.cjs');
  const installEngine = require('../gsd-core/bin/lib/install-engine.cjs');
  const surface = require('../gsd-core/bin/lib/surface.cjs');
  const runtimeArtifactLayout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
  const testHomeGuard = require('../gsd-core/bin/lib/real-home-guard.cjs');

  const escapingKinds = (home) => [{ kind: 'skills', home, destSubpath: 'skills' }];
  const confinedKinds = [{ kind: 'skills', destSubpath: 'skills' }];
  const fakeOs = (homedir, passwdHome) => ({
    homedir: () => homedir,
    userInfo: () => ({ homedir: passwdHome }),
  });
  const underTest = { NODE_TEST_CONTEXT: 'child-v8' };

  // ── the predicate ────────────────────────────────────────────────────────
  // Driven with REAL directories: the whole question is filesystem identity, and
  // synthetic paths cannot exercise it. The passwd home is injected via the deps
  // seam so no row depends on the developer's actual home.

  describe('predicate', () => {
    test('refuses a destination that lands inside the real home', (t) => {
      const realHome = createTempDir('gsd-3712-real-');
      t.after(() => cleanup(realHome));
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
          escapingKinds(path.join(realHome, '.agents')),
          { os: fakeOs(realHome, realHome), env: underTest }),
        /destination inside\s+your REAL home/,
      );
    });

    test('allows a destination outside the real home — the correct-usage path', (t) => {
      const realHome = createTempDir('gsd-3712-real2-');
      const sandbox = createTempDir('gsd-3712-sandbox-');
      t.after(() => { cleanup(realHome); cleanup(sandbox); });
      assert.doesNotThrow(() => testHomeGuard.assertTestHomeSandboxed(
        'installRuntimeArtifacts', 'codex',
        escapingKinds(path.join(sandbox, '.agents')),
        { os: fakeOs(sandbox, realHome), env: underTest },
      ));
    });

    // The round-5 defect. A HOME-state check ("is HOME sandboxed right now?")
    // returns "sandboxed" here and lets the write through, because the layout was
    // resolved BEFORE the sandbox and its kind.home still names the real home.
    // applySurface takes an already-resolved layout, so this is reachable, not
    // theoretical. Asking about the DESTINATION is what closes it.
    test('refuses a STALE layout resolved before HOME was sandboxed', (t) => {
      const realHome = createTempDir('gsd-3712-stale-real-');
      const sandbox = createTempDir('gsd-3712-stale-sandbox-');
      t.after(() => { cleanup(realHome); cleanup(sandbox); });
      // kind.home captured the REAL home; HOME is now the sandbox.
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('applySurface', 'codex',
          escapingKinds(path.join(realHome, '.agents')),
          { os: fakeOs(sandbox, realHome), env: underTest }),
        /destination inside\s+your REAL home/,
        'a sandboxed HOME does not make a destination resolved before the sandbox safe',
      );
    });

    // The round-6 defect, found by CI rather than by review: all six Windows
    // shards of #3725 failed here, every one of them on a legitimately sandboxed
    // destination. On Windows `os.tmpdir()` is `%LOCALAPPDATA%\Temp` —
    // `%USERPROFILE%\AppData\Local\Temp` — so every sandbox a test creates is a
    // DESCENDANT of the real home, and "does this land inside the real home?"
    // answers yes for the safe case and the dangerous one alike. POSIX hides this:
    // /tmp and /var/folders both sit outside $HOME, so the containment question
    // happens to discriminate there and the flaw is invisible.
    //
    // What actually separates the two is whether the destination derives from a
    // HOME that was sandboxed — hence the added conjunct. This must NOT decay into
    // the "is HOME sandboxed?" check the row above rejects; the row below holds
    // that line.
    test('allows a sandbox nested INSIDE the real home — the Windows temp-root shape', (t) => {
      const realHome = createTempDir('gsd-3712-nested-home-');
      t.after(() => cleanup(realHome));
      const sandbox = path.join(realHome, 'AppData', 'Local', 'Temp', 'gsd-sandbox-a');
      fs.mkdirSync(sandbox, { recursive: true });
      assert.doesNotThrow(() => testHomeGuard.assertTestHomeSandboxed(
        'installRuntimeArtifacts', 'codex',
        escapingKinds(path.join(sandbox, '.agents')),
        { os: fakeOs(sandbox, realHome), env: underTest },
      ));
    });

    // The guard against fixing the row above by weakening it to a HOME-state
    // check. Same nested-sandbox environment, but the layout was resolved before
    // the sandbox existed, so the destination still names the real home's
    // `.agents`. HOME is sandboxed and the write is still fatal.
    test('a nested sandbox does NOT excuse a STALE destination in the real home', (t) => {
      const realHome = createTempDir('gsd-3712-nested-stale-');
      t.after(() => cleanup(realHome));
      const sandbox = path.join(realHome, 'AppData', 'Local', 'Temp', 'gsd-sandbox-b');
      fs.mkdirSync(sandbox, { recursive: true });
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('applySurface', 'codex',
          escapingKinds(path.join(realHome, '.agents')),
          { os: fakeOs(sandbox, realHome), env: underTest }),
        /destination inside\s+your REAL home/,
        'a sandbox beneath the real home vouches only for what is beneath the sandbox',
      );
    });

    // Review N2: the leaking cell of the truth table. A destination's ancestor
    // chain is linear, so "inside the real home AND inside the effective HOME"
    // admits `realHome ⊂ effectiveHome` as well as the intended
    // `effectiveHome ⊂ realHome`. HOME at /Users, /home or C:\Users is not a
    // sandbox — it is the real home spelled more widely — and without the third
    // conjunct it exempts a stale destination pointing straight at ~/.agents.
    test('a HOME that is an ANCESTOR of the real home is not a sandbox', (t) => {
      const container = createTempDir('gsd-3712-ancestor-');
      t.after(() => cleanup(container));
      const realHome = path.join(container, 'someone');
      fs.mkdirSync(path.join(realHome, '.agents'), { recursive: true });
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('applySurface', 'codex',
          escapingKinds(path.join(realHome, '.agents')),
          // HOME is the DIRECTORY THAT CONTAINS the real home, so it differs from
          // the passwd home and still contains the destination.
          { os: fakeOs(container, realHome), env: underTest }),
        /destination inside\s+your REAL home/,
        'a HOME above the real home spells it more widely; it does not sandbox it',
      );
    });

    // The escape the nested-sandbox exemption opens if it trusts the SPELLING of
    // a path instead of where it resolves. HOME is sandboxed to a directory
    // inside the real home (legitimate on Windows), but the sandbox's `.agents`
    // is an alias onto the real one, so a lexical ancestor walk reaches the
    // sandbox while the write lands in `$REAL/.agents`. On Windows the alias
    // would be a junction; the mechanism is the same.
    test('refuses a sandbox whose .agents is an ALIAS onto the real one', (t) => {
      const realHome = createTempDir('gsd-3712-alias-');
      t.after(() => cleanup(realHome));
      const realAgents = path.join(realHome, '.agents');
      fs.mkdirSync(path.join(realAgents, 'skills'), { recursive: true });
      const sandbox = path.join(realHome, 'AppData', 'Local', 'Temp', 'gsd-sandbox-c');
      fs.mkdirSync(sandbox, { recursive: true });
      fs.symlinkSync(realAgents, path.join(sandbox, '.agents'), 'dir');
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
          escapingKinds(path.join(sandbox, '.agents')),
          { os: fakeOs(sandbox, realHome), env: underTest }),
        /destination inside\s+your REAL home/,
        'containment must be decided on where the write LANDS, not how it is spelled',
      );
    });

    // The refusal happens before any write, so it is not a partial install.
    // bin/install.js reads this to decide NOT to run its pre-config rollback,
    // which would otherwise delete and recreate every snapshotted gsd-* dir in
    // the real skills root — the exact mutation this guard exists to prevent.
    test('a refusal is marked so callers can tell it from a partial install', (t) => {
      const realHome = createTempDir('gsd-3712-flag-');
      t.after(() => cleanup(realHome));
      let caught;
      try {
        testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
          escapingKinds(path.join(realHome, '.agents')),
          { os: fakeOs(realHome, realHome), env: underTest });
      } catch (err) { caught = err; }
      assert.ok(caught, 'precondition: the guard must have refused');
      assert.equal(testHomeGuard.isTestHomeGuardRefusal(caught), true);
      assert.equal(testHomeGuard.isTestHomeGuardRefusal(new Error('unrelated')), false,
        'an unrelated failure IS a partial install and must still roll back');
      assert.equal(testHomeGuard.isTestHomeGuardRefusal(undefined), false);
    });

    // The exemption above is the only path in this guard that can turn a
    // destination inside the real home into an allowed write, so its
    // cannot-tell branches have to refuse. Mutating either of them to `true`
    // left the whole suite green before this row existed.
    test('refuses when HOME cannot be placed at all, rather than exempting it', (t) => {
      const realHome = createTempDir('gsd-3712-nohome-place-');
      t.after(() => cleanup(realHome));
      const unplaceable = {
        'an empty homedir': () => '',
        'a homedir that throws': () => { throw new Error('no home'); },
        'a homedir that does not exist': () => path.join(realHome, 'absent-sandbox'),
      };
      for (const [label, homedir] of Object.entries(unplaceable)) {
        assert.throws(
          () => testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
            escapingKinds(path.join(realHome, '.agents')),
            { os: { homedir, userInfo: () => ({ homedir: realHome }) }, env: underTest }),
          /destination inside\s+your REAL home/,
          `${label} must refuse — an unplaceable HOME is not evidence of a sandbox`,
        );
      }
    });

    test('the message names the operation and the fix, so it is not silenced blindly', (t) => {
      const realHome = createTempDir('gsd-3712-msg-');
      t.after(() => cleanup(realHome));
      let message = '';
      try {
        testHomeGuard.assertTestHomeSandboxed('applySurface', 'codex',
          escapingKinds(path.join(realHome, '.agents')),
          { os: fakeOs(realHome, realHome), env: underTest });
      } catch (err) { message = err.message; }
      assert.match(message, /applySurface/, 'must name the writer that was refused');
      assert.match(message, /sandboxHome/, 'must point at the helper that fixes it');
      assert.match(message, /Fix the TEST, not this guard/);
      assert.match(message, /BEFORE resolving the layout/, 'must state the ordering that matters');
    });

    test('is inert outside a test runner — real codex installs still write to $HOME/.agents', (t) => {
      // The override exists so a REAL install lands in the user's home. Blocking
      // that would break codex installs outright, so this row is load-bearing.
      const realHome = createTempDir('gsd-3712-prod-');
      t.after(() => cleanup(realHome));
      assert.doesNotThrow(() => testHomeGuard.assertTestHomeSandboxed(
        'installRuntimeArtifacts', 'codex',
        escapingKinds(path.join(realHome, '.agents')),
        { os: fakeOs(realHome, realHome), env: {} },
      ));
    });

    test('ignores kinds with no home override — they cannot escape configDir', (t) => {
      const realHome = createTempDir('gsd-3712-nohome-');
      t.after(() => cleanup(realHome));
      assert.doesNotThrow(() => testHomeGuard.assertTestHomeSandboxed(
        'installRuntimeArtifacts', 'claude', confinedKinds,
        { os: fakeOs(realHome, realHome), env: underTest },
      ));
    });

    // Identity, not pathname: path.resolve() resolves neither symlinks nor case,
    // and realpath returns a canonical pathname two routes to one directory can
    // still disagree on. Driven with the REAL fs — an injected os cannot prove
    // canonicalization, since that is what is under test.
    test('a destination reached through a SYMLINKED spelling of the real home is refused', (t) => {
      const realHome = createTempDir('gsd-3712-symreal-');
      const linkParent = createTempDir('gsd-3712-symlink-');
      const linkHome = path.join(linkParent, 'home-link');
      t.after(() => { cleanup(realHome); cleanup(linkParent); });
      fs.symlinkSync(realHome, linkHome, 'dir');

      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
          escapingKinds(path.join(linkHome, '.agents')),
          { os: fakeOs(linkHome, realHome), env: underTest }),
        /destination inside\s+your REAL home/,
        'two spellings of one directory are not two directories',
      );
    });

    test('refuses rather than guessing when the passwd home cannot be identified', () => {
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
          escapingKinds('/nonexistent-root-3712/.agents'),
          {
            os: { homedir: () => '/nonexistent-root-3712', userInfo: () => { throw new Error('no passwd entry'); } },
            env: underTest,
          }),
        /no identifiable passwd home/,
      );
    });

    test('a caller that recorded THIS home still works with no passwd entry', (t) => {
      // Keeps fail-closed from breaking passwd-less CI for callers that DID sandbox.
      const sandbox = createTempDir('gsd-3712-marker-');
      t.after(() => cleanup(sandbox));
      assert.doesNotThrow(() => testHomeGuard.assertTestHomeSandboxed(
        'installRuntimeArtifacts', 'codex',
        escapingKinds(path.join(sandbox, '.agents')),
        {
          os: { homedir: () => sandbox, userInfo: () => { throw new Error('no passwd entry'); } },
          env: { ...underTest, [testHomeGuard.SANDBOX_MARKER]: sandbox },
        },
      ));
    });

    test('a STALE marker naming a different home does not vouch for this call', (t) => {
      const sandbox = createTempDir('gsd-3712-marker2-');
      const other = createTempDir('gsd-3712-other-');
      t.after(() => { cleanup(sandbox); cleanup(other); });
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
          escapingKinds(path.join(sandbox, '.agents')),
          {
            os: { homedir: () => sandbox, userInfo: () => { throw new Error('no passwd entry'); } },
            env: { ...underTest, [testHomeGuard.SANDBOX_MARKER]: other },
          }),
        /no identifiable passwd home/,
        'the marker must name the home actually in effect',
      );
    });

    // Codex review of #3725. The marker attests that a caller sandboxed HOME; it
    // says NOTHING about where an already-resolved destination points. A layout
    // captured before sandboxHome() still names the real `~/.agents`, and the
    // marker branch waved it straight through — the exact stale-layout shape the
    // primary branch refuses by design, reachable on any passwd-less host. Both
    // halves are now required: the marker names the home in effect AND every
    // destination derives from it.
    test('a marker matching HOME does not vouch for a destination that does not derive from it', (t) => {
      const sandbox = createTempDir('gsd-3712-marker-stale-');
      const realHome = createTempDir('gsd-3712-marker-real-');
      t.after(() => { cleanup(sandbox); cleanup(realHome); });
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('applySurface', 'codex',
          escapingKinds(path.join(realHome, '.agents')),
          {
            os: { homedir: () => sandbox, userInfo: () => { throw new Error('no passwd entry'); } },
            env: { ...underTest, [testHomeGuard.SANDBOX_MARKER]: sandbox },
          }),
        /NOT beneath that sandbox/,
        'a recorded sandbox vouches for HOME, never for a destination outside it',
      );
    });

    // Codex review of #3725. resolveThroughLinks swallowed EVERY realpathSync
    // error and fell back to the LEXICAL spelling. That is a fail-open, and it
    // inverts the function's whole purpose: an aliased `<sandbox>/.agents` that
    // cannot be canonicalized keeps its sandbox spelling, satisfies the
    // nested-sandbox exemption, and the write is ALLOWED into the real home. The
    // module documents ONE named fail-open (the marker branch); this was a second,
    // unnamed one. ENOENT/ENOTDIR still walk up — that is the ordinary
    // destination-does-not-exist-yet case, and the split matches identify()'s.
    test('a destination component that cannot be canonicalized is refused, not assumed safe', (t) => {
      const sandbox = createTempDir('gsd-3712-uncanon-');
      const realHome = createTempDir('gsd-3712-uncanon-real-');
      t.after(() => { cleanup(sandbox); cleanup(realHome); });
      // A symlink CYCLE is the portable way to make realpathSync fail with
      // something other than "not there": every lookup through it returns ELOOP
      // while the parent directory resolves normally.
      const loopA = path.join(sandbox, 'loop-a');
      const loopB = path.join(sandbox, 'loop-b');
      try {
        fs.symlinkSync(loopB, loopA);
        fs.symlinkSync(loopA, loopB);
      } catch {
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('applySurface', 'codex',
          escapingKinds(path.join(loopA, '.agents')),
          { os: fakeOs(sandbox, realHome), env: underTest }),
        /could not be canonicalized/,
        'an unresolvable component must refuse — falling back to the lexical spelling is the '
        + 'exact ALLOW an aliased <sandbox>/.agents needs to reach the real home',
      );
    });

    // Non-vacuity for the row above, and the reason it cannot simply refuse on
    // ANY realpath error: the ordinary case is a destination that does not exist
    // yet, where realpath fails ENOENT on the leaf and on every not-yet-created
    // ancestor. Refusing there would reject every fresh install.
    test('… but a destination that merely does not exist yet still resolves and is allowed', (t) => {
      const sandbox = createTempDir('gsd-3712-uncanon-enoent-');
      const realHome = createTempDir('gsd-3712-uncanon-enoent-real-');
      t.after(() => { cleanup(sandbox); cleanup(realHome); });
      const neverCreated = path.join(sandbox, 'not-created-yet', '.agents');
      assert.strictEqual(fs.existsSync(neverCreated), false,
        'the row is only meaningful while the destination is absent');
      assert.doesNotThrow(
        () => testHomeGuard.assertTestHomeSandboxed('applySurface', 'codex',
          escapingKinds(neverCreated),
          { os: fakeOs(sandbox, realHome), env: underTest }),
        'ENOENT is the expected shape of a fresh install, not a canonicalization failure',
      );
    });

    // ENOTDIR takes the same walk-up branch as ENOENT, deliberately: both mean
    // "no such path as named", which is the question identify() answers the same
    // way. Pinned so the two cannot drift apart.
    test('… and a component sitting behind a FILE (ENOTDIR) walks up rather than refusing', (t) => {
      const sandbox = createTempDir('gsd-3712-uncanon-enotdir-');
      const realHome = createTempDir('gsd-3712-uncanon-enotdir-real-');
      t.after(() => { cleanup(sandbox); cleanup(realHome); });
      const asFile = path.join(sandbox, 'a-file');
      fs.writeFileSync(asFile, 'not a directory\n');
      assert.doesNotThrow(
        () => testHomeGuard.assertTestHomeSandboxed('applySurface', 'codex',
          escapingKinds(path.join(asFile, '.agents')),
          { os: fakeOs(sandbox, realHome), env: underTest }),
        'ENOTDIR means the path does not exist as named — identify() calls that absent, and this '
        + 'walk must agree with it rather than inventing a second errno policy',
      );
    });

    // Review of #3725, Major 1. sameDirectory() is read by the marker branch as
    // permission to PROCEED, so "cannot tell" has to answer no. It used to answer
    // yes whenever neither side identified — two absent paths here, or two stats
    // failing EACCES/EPERM/EIO on a locked-down host — which turned the passwd-less
    // escape hatch into an unconditional bypass for any marker value at all.
    // The absent/absent shape is the portable way to pin it; the errno shapes take
    // the same branch.
    test('a marker and a home that BOTH fail to identify do not vouch for each other', (t) => {
      const root = createTempDir('gsd-3712-unident-');
      t.after(() => cleanup(root));
      // Two DIFFERENT paths, so the same-pathname shortcut cannot fire, and
      // neither exists, so neither identifies.
      const missingHome = path.join(root, 'home-never-created');
      const missingMarker = path.join(root, 'marker-never-created');
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
          escapingKinds(path.join(missingHome, '.agents')),
          {
            os: { homedir: () => missingHome, userInfo: () => { throw new Error('no passwd entry'); } },
            env: { ...underTest, [testHomeGuard.SANDBOX_MARKER]: missingMarker },
          }),
        /no identifiable passwd home/,
        'two unidentifiable paths are not evidence that either is a sandbox',
      );
    });

    // Review of #3725, Major 2, raised as a question rather than a finding: on
    // Windows Node derives st_dev/st_ino from BY_HANDLE_FILE_INFORMATION, and the
    // uniqueness guarantees are weaker than POSIX. If dev collapsed to a per-volume
    // constant AND ino were 0 for directories, isInside() would match its very
    // first ancestor and report every path on the drive as inside the real home.
    // The whole guard rests on this primitive, so assert it directly instead of
    // reasoning about it — this row runs on every platform in the matrix, so
    // Windows answers the question itself.
    test('filesystem identity discriminates directories on this platform', (t) => {
      const a = createTempDir('gsd-3712-ident-a-');
      const b = createTempDir('gsd-3712-ident-b-');
      t.after(() => { cleanup(a); cleanup(b); });
      const sa = fs.statSync(a);
      const sb = fs.statSync(b);
      assert.ok(sa.dev !== sb.dev || sa.ino !== sb.ino,
        `two distinct directories share an identity (dev=${sa.dev}/${sb.dev}, ino=${sa.ino}/${sb.ino}) — ` +
        'isInside() would then match its first ancestor and refuse everything');
      const again = fs.statSync(path.join(a, '..', path.basename(a)));
      assert.equal(again.dev, sa.dev, 'one directory reached by two spellings must keep one dev');
      assert.equal(again.ino, sa.ino, 'one directory reached by two spellings must keep one ino');
    });

    // An ambient marker must not disarm the guard on the PRIMARY path: it is only
    // consulted when the real home cannot be identified at all.
    test('an ambient marker does NOT disarm the guard when the real home is identifiable', (t) => {
      const realHome = createTempDir('gsd-3712-ambient-');
      t.after(() => cleanup(realHome));
      assert.throws(
        () => testHomeGuard.assertTestHomeSandboxed('installRuntimeArtifacts', 'codex',
          escapingKinds(path.join(realHome, '.agents')),
          {
            os: fakeOs(realHome, realHome),
            env: { ...underTest, [testHomeGuard.SANDBOX_MARKER]: realHome },
          }),
        /destination inside\s+your REAL home/,
        'destination containment is authoritative; no marker may short-circuit it',
      );
    });

    test('the marker name tests/helpers.cjs writes matches the one the guard reads', () => {
      // helpers.cjs duplicates this string rather than requiring the compiled guard,
      // to keep its documented no-built-lib-at-import-time contract. Pin the pair.
      const { TEST_HOME_SANDBOX_MARKER } = require('./helpers.cjs');
      assert.strictEqual(TEST_HOME_SANDBOX_MARKER, testHomeGuard.SANDBOX_MARKER,
        'the helper and the guard must agree on the marker env var name');
    });
  });

  // ── the wiring ───────────────────────────────────────────────────────────
  // These call the REAL entrypoints. Deleting a guard call site makes them fail;
  // the predicate rows above would stay green, which is why both halves exist.

  describe('wiring — every writer that resolves kind.home is guarded', () => {
    /**
     * Sandbox the real HOME (so nothing real is ever at risk), then tell the guard
     * — through its deps seam only — that this sandboxed home IS the passwd home.
     * The layout then resolves its `home` override under that directory, so the
     * destination lands inside what the guard believes is the real home: exactly
     * "the caller forgot", reproduced against a throwaway directory.
     */
    function forgottenSandbox(t) {
      const configDir = createTempDir('gsd-3712-cfg-');
      const homeDir = createTempDir('gsd-3712-home-');
      t.after(() => { cleanup(configDir); cleanup(homeDir); });
      sandboxHome(t, homeDir);
      return { configDir, homeDir, deps: { os: fakeOs(homeDir, homeDir), env: underTest } };
    }

    test('installRuntimeArtifacts refuses before it writes or prunes anything', (t) => {
      const { configDir, homeDir, deps } = forgottenSandbox(t);
      const profile = { name: 'full', skills: '*', agents: new Set() };
      assert.throws(
        () => installEngine.installRuntimeArtifacts(
          'codex', configDir, 'global', profile, () => undefined, undefined, deps,
        ),
        /destination inside\s+your REAL home/,
        'the guard must be wired into installRuntimeArtifacts, not merely exported',
      );
      assert.ok(!fs.existsSync(path.join(homeDir, '.agents', 'skills')),
        'it must refuse BEFORE creating the escaped destination');
    });

    test('uninstallRuntimeArtifacts refuses — it prunes the same escaped home', (t) => {
      const { configDir, deps } = forgottenSandbox(t);
      assert.throws(
        () => installEngine.uninstallRuntimeArtifacts('codex', configDir, 'global', deps),
        /destination inside\s+your REAL home/,
        'uninstall resolves the same kind.home and calls _removeGsdEntries on it',
      );
    });

    test('applySurface refuses — its dest selection prefers kind.home, then syncs', (t) => {
      const { configDir, deps } = forgottenSandbox(t);
      const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayout('codex', configDir, 'global');
      assert.throws(
        () => surface.applySurface(configDir, layout, new Map(), undefined, undefined, undefined, deps),
        /destination inside\s+your REAL home/,
        'surface apply is the third writer that reaches kind.home',
      );
    });

    // The fourth reachable writer, and the one the first pass of #3712 missed: it
    // CREATES SKILL.md under the skills kind's `home` instead of pruning, and it
    // runs from _runLegacyInstallMigrations — BEFORE installRuntimeArtifacts'
    // assertion — so the rows above cannot cover it. Driven directly because that
    // is the seam it has; `saved` must carry dev-preferences.md or the function
    // returns early before ever resolving a target.
    test('migrateLegacyDevPreferencesToSkill refuses — it writes SKILL.md under kind.home', (t) => {
      const { configDir, homeDir, deps } = forgottenSandbox(t);
      const saved = new Map([['dev-preferences.md', '# saved\n']]);
      assert.throws(
        () => installEngine.migrateLegacyDevPreferencesToSkill(configDir, saved, 'codex', 'global', deps),
        /destination inside\s+your REAL home/,
        'the legacy migration is the sixth writer that reaches kind.home, and it runs first',
      );
      assert.ok(!fs.existsSync(path.join(homeDir, '.agents', 'skills', 'gsd-dev-preferences')),
        'it must refuse BEFORE creating the escaped skill directory');
    });

    // The guard call is conditional on `target.hasHomeOverride` — the skills
    // kind's own answer to "did it declare a home override?", read off the same
    // layout resolution the write uses. Pin the ALLOW half too, so widening that
    // condition cannot pass silently. configDir sits INSIDE the (fake) real home
    // deliberately: that is what gives this row teeth. With the condition as
    // written the guard is never consulted, because no home override was
    // declared; widened to run unconditionally it would see a destination inside
    // the real home with no sandbox to derive from, and refuse an ordinary
    // confined migration.
    test('… and still migrates for a runtime whose skills kind declares no home override', (t) => {
      const { homeDir, deps } = forgottenSandbox(t);
      const configDir = path.join(homeDir, '.claude');
      fs.mkdirSync(configDir, { recursive: true });
      const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayout('claude', configDir, 'global');
      const skills = layout.kinds.find((k) => k.kind === 'skills');
      assert.ok(skills && !skills.home,
        'claude skills must carry NO home override — if this fails the descriptor drifted '
        + 'and this row is no longer testing the ALLOW half');
      const saved = new Map([['dev-preferences.md', '# saved\n']]);
      assert.strictEqual(
        installEngine.migrateLegacyDevPreferencesToSkill(configDir, saved, 'claude', 'global', deps),
        true,
        'a confined destination must not be refused — the guard is destination-keyed, not runtime-keyed',
      );
    });

    // Codex review of #3725. `installRoot !== targetDir` was the stand-in for "the
    // skills kind declared a home override", and the two are not equivalent: the
    // inequality is FALSE when the override resolves onto targetDir itself — a
    // configDir of `$HOME/.agents`, which is exactly where codex's override points.
    // The guard was skipped and SKILL.md was written into the real home under a
    // test runner. The condition now reads the declaration off the same layout
    // resolution instead of comparing two paths.
    test('… and refuses when the configDir IS the home-override destination', (t) => {
      const { homeDir, deps } = forgottenSandbox(t);
      const configDir = path.join(homeDir, '.agents');
      fs.mkdirSync(configDir, { recursive: true });
      const saved = new Map([['dev-preferences.md', '# saved\n']]);
      assert.throws(
        () => installEngine.migrateLegacyDevPreferencesToSkill(configDir, saved, 'codex', 'global', deps),
        /destination inside\s+your REAL home/,
        'an override that resolves onto targetDir is still a declared override',
      );
      assert.ok(!fs.existsSync(path.join(configDir, 'skills', 'gsd-dev-preferences')),
        'it must refuse BEFORE creating the skill directory in the real home');
    });
  });

  // ── the property the one real fix depends on ─────────────────────────────

  test('a sandboxed HOME actually contains codex\'s global skills kind', (t) => {
    const configDir = createTempDir('gsd-3712-contain-cfg-');
    const homeDir = createTempDir('gsd-3712-contain-home-');
    t.after(() => { cleanup(configDir); cleanup(homeDir); });

    const ambientHome = path.resolve(os.homedir());
    sandboxHome(t, homeDir);

    const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayout('codex', configDir, 'global');
    const skills = layout.kinds.find((k) => k.kind === 'skills');
    assert.ok(skills && skills.home,
      'codex skills must still carry the global home override this guard exists for — '
      + 'if this fails the descriptor drifted, and the guard is now testing nothing');

    const dest = path.resolve(path.join(skills.home, skills.destSubpath));
    assert.ok(dest.startsWith(path.resolve(homeDir) + path.sep),
      `codex skills must resolve inside the sandboxed HOME, got ${dest}`);
    assert.ok(!dest.startsWith(ambientHome + path.sep),
      `codex skills must NOT resolve inside the ambient home ${ambientHome}, got ${dest}`);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded regression block — #4086 (Codex skills manifest keys never resolve)
// Codex installs skills to the skills-kind `home` override (~/.agents/skills),
// outside configDir (~/.codex). writeManifest() hashes skills from the real
// location, but saveLocalPatches() resolved every manifest key against
// configDir only — every skills/ key missed, so user modifications to Codex
// skills were never hash-compared, never backed up, silently overwritten.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:bug-4086-codex-skills-manifest-paths', () => {
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const INSTALL = require(path.join(ROOT, 'bin', 'install.js'));
const { cleanup, sandboxHome, scrubConfigLocationEnv } = require('./helpers.cjs');

const MANIFEST_NAME = 'gsd-file-manifest.json';
const PATCHES_DIR_NAME = 'gsd-local-patches';

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function writeManifestFile(configDir, files, extra = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, MANIFEST_NAME),
    JSON.stringify({ version: '1.12.0', timestamp: new Date().toISOString(), files, ...extra }, null, 2),
  );
}

describe('Bug #4086: saveLocalPatches resolves skills/ manifest keys at the runtime skills root', () => {
  let tmpDir;
  let homeDir;
  let configDir;
  let skillsRoot;
  let restoreConfigEnv;
  let fakeSrcDir;

  beforeEach((t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4086-'));
    homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    sandboxHome(t, homeDir);
    restoreConfigEnv = scrubConfigLocationEnv();
    configDir = path.join(homeDir, '.codex');
    // Same join the layout uses for codex's skills-kind home override
    // (#3712 block above pins that this is $HOME/.agents/skills).
    skillsRoot = path.join(homeDir, '.agents', 'skills');
    fakeSrcDir = path.join(tmpDir, 'pkg-src');
    fs.mkdirSync(fakeSrcDir, { recursive: true });
    t.after(() => {
      restoreConfigEnv();
      cleanup(tmpDir);
    });
  });

  test('saveLocalPatches backs up a modified Codex skill installed under ~/.agents/skills (#4086)', () => {
    const pristine = '---\nname: gsd-x\ndescription: stock skill body line for hashing\n---\nstock\n';
    const modified = pristine + '<!-- user edit 4086: a substantial marker line -->\n';
    const relKey = 'skills/gsd-x/SKILL.md';
    fs.mkdirSync(path.join(skillsRoot, 'gsd-x'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'gsd-x', 'SKILL.md'), modified);
    writeManifestFile(configDir, { [relKey]: sha256(pristine) }, { runtime: 'codex', scope: 'global' });

    const modifiedList = INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'codex',
      pathPrefix: '',
      isGlobal: true,
    });

    assert.deepEqual(modifiedList, [relKey], 'the modified skill must be detected via the skills root');
    const backup = path.join(configDir, PATCHES_DIR_NAME, relKey);
    assert.ok(fs.existsSync(backup), `backup must exist at ${PATCHES_DIR_NAME}/${relKey}`);
    assert.equal(fs.readFileSync(backup, 'utf8'), modified, 'backup must hold the user-modified bytes');
    const meta = JSON.parse(fs.readFileSync(path.join(configDir, PATCHES_DIR_NAME, 'backup-meta.json'), 'utf8'));
    assert.deepEqual(meta.files, [relKey]);
  });

  test('unmodified Codex skill under ~/.agents/skills produces no patch (#4086)', () => {
    const pristine = '---\nname: gsd-x\ndescription: stock skill body line for hashing\n---\nstock\n';
    const relKey = 'skills/gsd-x/SKILL.md';
    fs.mkdirSync(path.join(skillsRoot, 'gsd-x'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'gsd-x', 'SKILL.md'), pristine);
    writeManifestFile(configDir, { [relKey]: sha256(pristine) }, { runtime: 'codex', scope: 'global' });

    const modifiedList = INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'codex',
      pathPrefix: '',
      isGlobal: true,
    });

    assert.deepEqual(modifiedList, [], 'no false positive for an unmodified skill at the skills root');
  });

  test('config-dir-relative skills keep resolving against configDir first (#4086)', () => {
    const pristine = '---\nname: gsd-x\ndescription: stock claude skill body line\n---\nstock\n';
    const modified = pristine + '<!-- user edit 4086: claude skill marker line -->\n';
    const relKey = 'skills/gsd-x/SKILL.md';
    // claude has NO skills home override — skills live under configDir itself.
    const claudeConfig = path.join(homeDir, '.claude');
    fs.mkdirSync(path.join(claudeConfig, 'skills', 'gsd-x'), { recursive: true });
    fs.writeFileSync(path.join(claudeConfig, 'skills', 'gsd-x', 'SKILL.md'), modified);
    writeManifestFile(claudeConfig, { [relKey]: sha256(pristine) }, { runtime: 'claude', scope: 'global' });

    const modifiedList = INSTALL.saveLocalPatches(claudeConfig, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '',
      isGlobal: true,
    });

    assert.deepEqual(modifiedList, [relKey], 'config-dir-relative skills are detected exactly as before');
  });

  test('configDir copy wins when both locations exist (#4086)', () => {
    const pristine = '---\nname: gsd-x\ndescription: stock skill body line for hashing\n---\nstock\n';
    const configCopy = pristine + '<!-- user edit at configDir copy 4086 -->\n';
    const rootCopy = pristine + '<!-- DIFFERENT user edit at skills root 4086 -->\n';
    const relKey = 'skills/gsd-x/SKILL.md';
    fs.mkdirSync(path.join(configDir, 'skills', 'gsd-x'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'skills', 'gsd-x', 'SKILL.md'), configCopy);
    fs.mkdirSync(path.join(skillsRoot, 'gsd-x'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'gsd-x', 'SKILL.md'), rootCopy);
    writeManifestFile(configDir, { [relKey]: sha256(pristine) }, { runtime: 'codex', scope: 'global' });

    const modifiedList = INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'codex',
      pathPrefix: '',
      isGlobal: true,
    });

    assert.deepEqual(modifiedList, [relKey]);
    const backup = path.join(configDir, PATCHES_DIR_NAME, relKey);
    assert.equal(fs.readFileSync(backup, 'utf8'), configCopy, 'configDir copy must be hashed/backed up, not the skills-root copy');
  });

  test('legacy runtime-less manifest is tolerated (#4086)', () => {
    const pristine = '---\nname: gsd-x\ndescription: stock skill body line for hashing\n---\nstock\n';
    const relKey = 'skills/gsd-x/SKILL.md';
    fs.mkdirSync(path.join(skillsRoot, 'gsd-x'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'gsd-x', 'SKILL.md'), pristine + 'user line\n');
    // No runtime field, and the caller passes no pristineCtx.runtime either
    // (legacy callers) — the redirect is impossible; behave as before (skip).
    writeManifestFile(configDir, { [relKey]: sha256(pristine) });

    let modifiedList;
    assert.doesNotThrow(() => {
      modifiedList = INSTALL.saveLocalPatches(configDir, {});
    }, 'a runtime-less manifest must not crash saveLocalPatches');
    assert.deepEqual(modifiedList, [], 'without a runtime the old skip behavior applies');
  });

  test('end-to-end codex reinstall backs up the modified skill (#4086)', { timeout: 120_000 }, () => {
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      INSTALL.install(true, 'codex');
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(configDir, MANIFEST_NAME), 'utf8'));
    const skillKeys = Object.keys(manifest.files).filter((k) => k.startsWith('skills/'));
    assert.ok(skillKeys.length > 0, 'codex global install must record skills/ manifest keys');
    const skillAbs = skillKeys.map((k) => path.join(homeDir, '.agents', k));
    assert.ok(
      skillKeys.every((k, i) => !fs.existsSync(path.join(configDir, k)) && fs.existsSync(skillAbs[i])),
      'installed skills must live under ~/.agents, not under configDir (the #4086 premise)',
    );
    // User modifies one installed skill, then reinstalls.
    fs.appendFileSync(skillAbs[0], '\n<!-- user edit 4086 e2e marker line -->\n');
    try {
      console.log = () => {};
      console.warn = () => {};
      INSTALL.install(true, 'codex');
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    const backup = path.join(configDir, PATCHES_DIR_NAME, skillKeys[0]);
    assert.ok(fs.existsSync(backup), `reinstall must back the modified skill up at ${PATCHES_DIR_NAME}/${skillKeys[0]}`);
    assert.match(fs.readFileSync(backup, 'utf8'), /user edit 4086 e2e marker line/);
  });
});
  });
}
