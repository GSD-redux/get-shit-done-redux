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
const runtimeArtifactLayout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const commandRoster = require('../gsd-core/bin/lib/command-roster.cjs');
const slashCommandTransformer = require('../scripts/fix-slash-commands.cjs');

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

// The full write+read surface installRuntimeArtifacts's call tree is known to
// reach once every gap named in the #2874 follow-up round is closed: the
// direct mkdirSync/existsSync/rmSync calls, _copyStaged's readdirSync/cpSync/
// copyFileSync/mkdirSync, _removeGsdEntries's directory scan+delete,
// _snapshotDir/_restoreDir's read/write of preserved skill dirs, the
// symlink-escape guard's lstatSync/realpathSync probes, commonjs-marker.cts's
// lstatSync/writeFileSync/unlinkSync, and installer-migrations.cts's
// existsSync/readFileSync (readInstallManifest, classifyArtifact,
// sha256File). mkdtempSync/openSync/readSync/closeSync are poisoned too even
// though nothing in the routed call tree should ever reach them anymore
// (every former mkdtempSync site now uses mkInstallTempDir; sha256File was
// converted off raw-fd streaming) — a tripwire, not a documented gap.
const REAL_FS_WRITE_SURFACE = [
  'mkdirSync', 'existsSync', 'rmSync', 'readdirSync',
  'cpSync', 'copyFileSync', 'readFileSync', 'writeFileSync', 'lstatSync',
  'realpathSync', 'unlinkSync', 'rmdirSync',
  'mkdtempSync', 'openSync', 'readSync', 'closeSync',
];

/**
 * A genuinely functional in-memory filesystem, not a set of no-op stubs —
 * required to drive the branches F2 now exercises (opencode-family legacy-dir
 * migration, a nativePlugin runtime, a retiredArtifacts runtime) far enough
 * to reach commonjs-marker.cts and installer-migrations.cts's routed
 * classifyArtifact/readInstallManifest, not just the happy path's first
 * existsSync check. Every method operates against one flat `Map<absPath,
 * entry>` store; `readdirSync` derives listings by prefix-scanning the same
 * store (an entry that readdirSync reports a directory contains is, by
 * construction, also existsSync-true at that exact path — same invariant a
 * real filesystem holds).
 *
 * @param seed - Array<[absPath, {type:'file'|'dir', content?:string|Buffer}]>
 *   pre-populated entries.
 */
function createFakeInstallFs(seed = []) {
  const store = new Map();
  for (const [p, entry] of seed) store.set(path.normalize(String(p)), entry);

  const norm = (p) => path.normalize(String(p));
  const childPrefix = (dir) => {
    const n = norm(dir);
    return n.endsWith(path.sep) ? n : n + path.sep;
  };
  const enoent = (p) => {
    const err = new Error(`ENOENT: no such file or directory, '${p}'`);
    err.code = 'ENOENT';
    return err;
  };

  const fakeFs = {
    existsSync: (p) => store.has(norm(p)),
    lstatSync: (p) => {
      const e = store.get(norm(p));
      if (!e) throw enoent(p);
      return {
        isFile: () => e.type === 'file',
        isDirectory: () => e.type === 'dir',
        isSymbolicLink: () => e.type === 'symlink',
      };
    },
    mkdirSync: (p) => { store.set(norm(p), { type: 'dir' }); return undefined; },
    rmSync: (p) => {
      const n = norm(p);
      store.delete(n);
      const prefix = childPrefix(n);
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    },
    unlinkSync: (p) => {
      const n = norm(p);
      if (!store.has(n)) throw enoent(p);
      store.delete(n);
    },
    rmdirSync: (p) => { store.delete(norm(p)); },
    readdirSync: (p, opts) => {
      const prefix = childPrefix(p);
      const names = new Set();
      for (const k of store.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const sepIdx = rest.indexOf(path.sep);
        const name = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
        if (name) names.add(name);
      }
      const arr = [...names];
      if (opts && opts.withFileTypes) {
        return arr.map((name) => {
          const full = norm(path.join(String(p), name));
          const e = store.get(full);
          return {
            name,
            isFile: () => (e ? e.type === 'file' : false),
            isDirectory: () => (e ? e.type === 'dir' : true),
          };
        });
      }
      return arr;
    },
    readFileSync: (p, encoding) => {
      const e = store.get(norm(p));
      if (!e || e.type !== 'file') throw enoent(p);
      const buf = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '', 'utf8');
      return encoding ? buf.toString(encoding) : buf;
    },
    writeFileSync: (p, data, opts) => {
      // Emulate `{ flag: 'wx' }` (exclusive create): REAL_ADAPTER.writeFileSync
      // (install-fs-adapter.cts:138) passes `opts` straight through to real
      // `fs.writeFileSync`, which throws EEXIST for `wx` against an existing
      // path. A fake that silently overwrote here would certify something
      // the real implementation refuses — see commonjs-marker.cts's
      // `ensureCommonJsMarker`, which relies on `wx` to close the
      // classify-then-write gap.
      const flag = typeof opts === 'object' && opts !== null ? opts.flag : undefined;
      const n = norm(p);
      if (flag === 'wx' && store.has(n)) {
        const err = new Error(`EEXIST: file already exists, open '${p}'`);
        err.code = 'EEXIST';
        throw err;
      }
      store.set(n, { type: 'file', content: data });
    },
    copyFileSync: (src, dest) => {
      const e = store.get(norm(src));
      store.set(norm(dest), { type: 'file', content: e ? e.content : Buffer.alloc(0) });
    },
    cpSync: (src, dest) => {
      const sn = norm(src);
      const dn = norm(dest);
      const e = store.get(sn);
      if (e) store.set(dn, { ...e });
      const prefix = childPrefix(sn);
      for (const [k, v] of [...store.entries()]) {
        if (k.startsWith(prefix)) store.set(dn + k.slice(sn.length), { ...v });
      }
    },
    realpathSync: (p) => norm(p),
  };
  fakeFs._store = store;
  return fakeFs;
}

// ─── createFakeInstallFs — wx exclusive-create emulation ────────────────────
//
// REAL_ADAPTER.writeFileSync (install-fs-adapter.cts:138) passes `opts`
// through untouched to real fs.writeFileSync, so `{ flag: 'wx' }` throws
// EEXIST against an existing target (commonjs-marker.cts's
// ensureCommonJsMarker relies on exactly this to close the
// classify-then-write TOCTOU gap). A fake that ignored `opts` would silently
// overwrite where the real adapter refuses — this covers the emulation
// itself rather than assuming it.
describe('createFakeInstallFs — wx exclusive-create emulation', () => {
  test('refuses an exclusive create against an existing path (EEXIST)', () => {
    const target = path.join(os.tmpdir(), 'gsd-fake-wx-existing.txt');
    const fakeFs = createFakeInstallFs([[target, { type: 'file', content: 'original' }]]);

    assert.throws(
      () => fakeFs.writeFileSync(target, 'clobber', { flag: 'wx' }),
      (err) => err.code === 'EEXIST',
      'wx write against an existing fake-store path must throw EEXIST, matching real fs.writeFileSync',
    );
    assert.strictEqual(
      fakeFs.readFileSync(target, 'utf8'),
      'original',
      'a refused wx write must leave the existing content untouched',
    );
  });

  test('allows an exclusive create against an absent path', () => {
    const target = path.join(os.tmpdir(), 'gsd-fake-wx-absent.txt');
    const fakeFs = createFakeInstallFs();

    fakeFs.writeFileSync(target, 'created', { flag: 'wx' });

    assert.strictEqual(fakeFs.readFileSync(target, 'utf8'), 'created');
  });
});

/** sha256 hex digest matching installer-migrations.cts's sha256File — used to
 *  seed a manifest entry that classifies a fake file as 'managed-pristine'. */
function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('installRuntimeArtifacts — F2: fake-adapter install touches no real filesystem', () => {
  test('fake-adapter install touches no real filesystem (claude, skills-only)', (t) => {
    // Every real fs method this call tree could reach is poisoned for the
    // duration of this test via node:test's mock tracker (auto-restored when
    // the test ends — no try/finally in the test body, per CONTRIBUTING.md's
    // "Never use try/finally inside test bodies").
    for (const method of REAL_FS_WRITE_SURFACE) {
      t.mock.method(fs, method, () => {
        throw new Error(
          `F2: real fs.${method}() was reached during an install driven by an injected ` +
          'fake adapter',
        );
      });
    }

    const fakeFs = createFakeInstallFs();

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

  test('fake-adapter install touches no real filesystem (opencode-family legacy command/ dir migration)', (t) => {
    for (const method of REAL_FS_WRITE_SURFACE) {
      t.mock.method(fs, method, () => {
        throw new Error(`F2 (opencode legacy migration): real fs.${method}() was reached`);
      });
    }

    const configDir = path.join(os.tmpdir(), `gsd-f2-opencode-legacy-${crypto.randomUUID()}`);
    const legacyDir = path.join(configDir, 'command');
    const legacyFile = path.join(legacyDir, 'gsd-old-cmd.md');
    const content = '# stale legacy command\n';
    const manifestPath = path.join(configDir, 'gsd-file-manifest.json');
    const manifestJson = JSON.stringify({ files: { 'command/gsd-old-cmd.md': sha256Hex(content) } });

    const fakeFs = createFakeInstallFs([
      [configDir, { type: 'dir' }],
      [legacyDir, { type: 'dir' }],
      [legacyFile, { type: 'file', content }],
      [manifestPath, { type: 'file', content: manifestJson }],
    ]);

    const result = installRuntimeArtifacts(
      'opencode', configDir, 'global', RESOLVED_CORE, undefined, undefined,
      { fs: fakeFs },
    );

    assert.notStrictEqual(result, undefined, 'F2 (opencode legacy migration): must still return a plan');
    // The manifest hash matches the seeded content exactly, so
    // _migrateLegacyOpencodeCommandDir's classifyArtifact call must have
    // classified it 'managed-pristine' and unlinked it (real
    // installerMigrations.readInstallManifest/classifyArtifact/sha256File —
    // all routed through installFs() — computed this via the fake, not real
    // fs, or the poisoned methods above would have thrown first).
    assert.strictEqual(
      fakeFs._store.has(path.normalize(legacyFile)),
      false,
      'F2 (opencode legacy migration): the managed-pristine legacy file must have been removed via the fake store',
    );
  });

  test('fake-adapter install touches no real filesystem (nativePlugin runtime: pi)', (t) => {
    for (const method of REAL_FS_WRITE_SURFACE) {
      t.mock.method(fs, method, () => {
        throw new Error(`F2 (nativePlugin): real fs.${method}() was reached`);
      });
    }

    // Resolve the SAME pluginSrc path _installNativePluginIfDeclared
    // (install-engine.cts) computes for pi's declared nativePlugin, using the
    // real (unrouted, package-own-source) findInstallSourceRoot — this read
    // happens BEFORE the poison mocks above are installed... no: it must
    // happen before `t.mock.method` calls would matter for IT, but
    // findInstallSourceRoot's own walk uses `fs.statSync`, which is NOT on
    // the poisoned list (see install-fs-adapter.cts's module doc — it is
    // deliberately unrouted, real-fs-only, package-source introspection), so
    // resolving this here is safe even after poisoning existsSync et al.
    const commandsGsdDir = runtimeArtifactLayout.findInstallSourceRoot();
    const repoRoot = path.dirname(path.dirname(commandsGsdDir));
    const nativePlugin = registry.runtimes.pi.runtime.hostBehaviors.nativePlugin;
    assert.ok(nativePlugin && nativePlugin.source, 'pi must declare hostBehaviors.nativePlugin.source (registry drifted)');
    const pluginSrc = path.join(repoRoot, nativePlugin.source);

    const configDir = path.join(os.tmpdir(), `gsd-f2-pi-nativeplugin-${crypto.randomUUID()}`);
    const fakeFs = createFakeInstallFs([
      [pluginSrc, { type: 'file', content: '// fake plugin adapter\n' }],
    ]);

    const result = installRuntimeArtifacts(
      'pi', configDir, 'global', RESOLVED_CORE, undefined, undefined,
      { fs: fakeFs },
    );

    assert.notStrictEqual(result, undefined, 'F2 (nativePlugin): must still return a plan');
    assert.strictEqual(result.postSteps.nativePlugin, true, 'F2 (nativePlugin): postSteps.nativePlugin must be true for pi');
    const destPath = path.join(configDir, nativePlugin.dir, nativePlugin.file);
    assert.strictEqual(
      fakeFs._store.has(path.normalize(destPath)),
      true,
      'F2 (nativePlugin): the plugin file must have been copied via the fake store (copyFileSync routed)',
    );
    const markerPath = path.join(configDir, nativePlugin.dir, 'package.json');
    assert.strictEqual(
      fakeFs._store.has(path.normalize(markerPath)),
      true,
      'F2 (nativePlugin): ensureCommonJsMarker (commonjs-marker.cts) must have written the CommonJS marker via the fake store',
    );
  });

  test('fake-adapter install touches no real filesystem (retiredArtifacts runtime: cursor)', (t) => {
    for (const method of REAL_FS_WRITE_SURFACE) {
      t.mock.method(fs, method, () => {
        throw new Error(`F2 (retiredArtifacts): real fs.${method}() was reached`);
      });
    }

    const retired = registry.runtimes.cursor.runtime.hostBehaviors.retiredArtifacts;
    assert.ok(Array.isArray(retired) && retired.length > 0, 'cursor must declare hostBehaviors.retiredArtifacts (registry drifted)');
    const { destSubpath, prefix, suffix } = retired[0];

    const configDir = path.join(os.tmpdir(), `gsd-f2-cursor-retired-${crypto.randomUUID()}`);
    const destDir = path.resolve(configDir, destSubpath);
    const staleName = `${prefix}retired-probe${suffix}`;
    const staleFile = path.join(destDir, staleName);
    const content = '# stale retired artifact\n';
    const relPath = `${destSubpath.replace(/\\/g, '/')}/${staleName}`;
    const manifestPath = path.join(configDir, 'gsd-file-manifest.json');
    const manifestJson = JSON.stringify({ files: { [relPath]: sha256Hex(content) } });

    const fakeFs = createFakeInstallFs([
      [configDir, { type: 'dir' }],
      [destDir, { type: 'dir' }],
      [staleFile, { type: 'file', content }],
      [manifestPath, { type: 'file', content: manifestJson }],
    ]);

    const result = installRuntimeArtifacts(
      'cursor', configDir, 'global', RESOLVED_CORE, undefined, undefined,
      { fs: fakeFs },
    );

    assert.notStrictEqual(result, undefined, 'F2 (retiredArtifacts): must still return a plan');
    // manifest hash matches the seeded content exactly -> classifyArtifact
    // must classify 'managed-pristine' -> pruneRetiredRuntimeArtifacts
    // (retired-artifact-cleanup.cts, routed) unlinks it via the fake store.
    assert.strictEqual(
      fakeFs._store.has(path.normalize(staleFile)),
      false,
      'F2 (retiredArtifacts): the managed-pristine retired artifact must have been removed via the fake store',
    );
  });
});

// ─── readGsdCommandNames — single-source parity ──────────────────────────────
//
// command-roster.cts's readGsdCommandNames reimplements
// scripts/fix-slash-commands.cjs's readCmdNames' directory-scan rule against
// the injectable install-fs seam instead of delegating to it — see
// command-roster.cts's module comment for why (readCmdNames is deliberately
// a zero-dependency standalone CLI/library with no build-order dependency on
// gsd-core/bin/lib, so it cannot itself require the compiled
// install-fs-adapter.cjs). Two implementations of one filtering rule is this
// repo's recorded Generative Fix Divergence class; this test is the
// enforcement the coordinator required in exchange for keeping the
// reimplementation: it fails the moment the two disagree about which stems
// commands/gsd/ contains.

describe('readGsdCommandNames — single-source parity (command-roster.cts vs scripts/fix-slash-commands.cjs)', () => {
  test('both implementations report the identical stem set for commands/gsd/', () => {
    const fromCommandRoster = [...commandRoster.readGsdCommandNames()].sort();
    const fromSlashCommandTransformer = [...slashCommandTransformer.readCmdNames()].sort();
    assert.deepStrictEqual(
      fromCommandRoster,
      fromSlashCommandTransformer,
      'command-roster.cts readGsdCommandNames() and scripts/fix-slash-commands.cjs readCmdNames() ' +
      'diverged — these are two implementations of the SAME directory-scan rule (Generative Fix ' +
      'Divergence); fix the one that is wrong, do not just silence this test',
    );
    assert.ok(fromCommandRoster.length > 0, 'sanity: commands/gsd/ must contain at least one command');
  });
});
