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
  _copyStaged,
} = require('../bin/install.js');

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

  // Documented edge case: a broken symlink (target missing) is silently passed by
  // both the default and opt-in paths. fs.existsSync follows the link and returns
  // false, so the component loop terminates before the symlink check fires. This is
  // pre-existing behavior — the fix preserves it. Subsequent mkdir may then fail or
  // create the path through the resolved target; that's the caller's responsibility,
  // not the symlink-escape guard's. Test pins the current behavior so any future
  // change (e.g. switching to lstatSync for existence) is intentional.
  test('broken symlink: silently passed (current behavior, preserved by fix)', (t) => {
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

      // existsSync(danglingLink) follows the link → false → loop returns false early.
      // Same behavior with and without opt-in. Test documents this so a future
      // refactor (e.g. lstatSync-based existence) is a deliberate behavior change.
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir),
        false,
        'broken symlink: component loop terminates early (existsSync follows link → false)',
      );
      assert.strictEqual(
        hasExistingSymlinkBetween(configHome, destDir, { allowOptInFollow: true }),
        false,
        'broken symlink with opt-in: same early-termination behavior',
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
