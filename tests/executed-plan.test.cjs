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

const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');

const { installRuntimeArtifacts, hasExistingSymlinkBetween } = require('../gsd-core/bin/lib/install-engine.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
const runtimeArtifactLayout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const runtimeArtifactInstallPlan = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
const { withInstallFs } = require('../gsd-core/bin/lib/install-fs-adapter.cjs');
const commandRoster = require('../gsd-core/bin/lib/command-roster.cjs');
const slashCommandTransformer = require('../scripts/fix-slash-commands.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const REAL_PACKAGE_ROOT = path.resolve(__dirname, '..');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });
const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });
const TEST_ATTRIBUTION = () => 'Co-Authored-By: Test <t@example.com>';

/**
 * Sandbox HOME/USERPROFILE for the duration of a test. Some runtimes (e.g.
 * codex) resolve a kind's `home` via os.homedir(); without this, an in-process
 * install would write into the developer's real home directory.
 *
 * #3712: promoted to tests/helpers.cjs, from the byte-identical copy that used
 * to live here. It now also sets the sandbox marker src/real-home-guard.cts
 * needs to stay permissive on hosts with no readable passwd entry.
 */
const { sandboxHome } = require('./helpers.cjs');

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
// existsSync/readFileSync/openSync/readSync/closeSync (readInstallManifest,
// classifyArtifact, sha256File — sha256File streams via openSync/readSync/
// closeSync, restored after a brief round-trip through readFileSync broke
// tests/installer-migrations.test.cjs's large-file-streaming contract; the
// fake below implements all three against its store so a fake-adapter
// install still never touches real fs for hashing).
//
// mkdtempSync stays poisoned as a genuine tripwire, not a reachable case:
// mkInstallTempDir (install-fs-adapter.cts) only ever calls real
// `fs.mkdtempSync` when `current === REAL_ADAPTER` (no adapter injected at
// all) — a fake-adapter call always makes `current` a distinct merged
// object, so it takes the synthesize-name-and-mkdirSync branch instead and
// never reaches this poison. If this ever fires, `current`'s identity check
// broke, not a documented gap.
//
// One exception this poison list does NOT cover: readGsdCommandNames
// (command-roster.cts) reads the PACKAGE'S OWN commands/gsd/ source tree via
// real fs.readdirSync — deliberately unrouted (see install-fs-adapter.cts's
// module doc, "DELIBERATELY NOT ROUTED"). `poisonRealFsAgainstDestination`
// below allows real calls scoped to that known package-source root and
// poisons everything else, rather than poisoning every real fs call
// wholesale regardless of path.
const REAL_FS_WRITE_SURFACE = [
  'mkdirSync', 'existsSync', 'rmSync', 'readdirSync',
  'cpSync', 'copyFileSync', 'readFileSync', 'writeFileSync', 'lstatSync',
  'realpathSync', 'unlinkSync', 'rmdirSync',
  'mkdtempSync', 'openSync', 'readSync', 'closeSync',
];

// The provider resolver probes upward through the executing package before it
// reaches commands/gsd and agents. All read-only package-tree probes are valid
// real IO while a fake DESTINATION adapter is active; destination paths remain
// poisoned below.
const PACKAGE_SOURCE_ROOTS = [path.resolve(__dirname, '..')];

function isPackageSourcePath(resolvedPath) {
  return PACKAGE_SOURCE_ROOTS.some(
    (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep),
  );
}

/**
 * F2's real-fs poisoning, derived from the rule (40-design.md "Known
 * limits"/install-fs-adapter.cts's module doc) rather than aligned with it by
 * coincidence: a real fs call against the install DESTINATION is a failure —
 * the seam exists precisely so a fake adapter can intercept those — but a
 * real call against the package's OWN source tree (commands/gsd/, agents/)
 * is expected and allowed, because that read is deliberately unrouted
 * (readGsdCommandNames et al.). Poisoning every real fs method wholesale,
 * regardless of path, makes a correct install fail for the wrong reason.
 *
 * Returns a Map<method, count> of package-source hits, so a caller can
 * assert POSITIVELY that the expected package-source read actually happened
 * — proving the boundary was exercised, not merely tolerated.
 */
function poisonRealFsAgainstDestination(t, label) {
  const packageSourceHits = new Map();
  for (const method of REAL_FS_WRITE_SURFACE) {
    const original = fs[method].bind(fs);
    t.mock.method(fs, method, (...args) => {
      const target = args[0];
      const resolved = (typeof target === 'string' || target instanceof URL || Buffer.isBuffer(target))
        ? path.resolve(String(target))
        : null;
      if (resolved !== null && isPackageSourcePath(resolved)) {
        packageSourceHits.set(method, (packageSourceHits.get(method) ?? 0) + 1);
        return original(...args);
      }
      throw new Error(
        `F2${label}: real fs.${method}() was reached against a non-package-source path ` +
        `(${resolved ?? String(target)}) during an install driven by an injected fake adapter`,
      );
    });
  }
  return packageSourceHits;
}

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
  const fdTable = new Map();
  let nextFd = 1;

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
    // sha256File (installer-migrations.cts) streams via openSync/readSync/
    // closeSync instead of readFileSync (large-file hashing must not buffer
    // the whole file — tests/installer-migrations.test.cjs pins this). fdTable
    // maps a synthetic fd to {buf, pos} so this fake never needs a real fd.
    openSync: (p) => {
      const e = store.get(norm(p));
      if (!e || e.type !== 'file') throw enoent(p);
      const buf = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '', 'utf8');
      const fd = nextFd++;
      fdTable.set(fd, { buf, pos: 0 });
      return fd;
    },
    readSync: (fd, buffer, offset, length, position) => {
      const entry = fdTable.get(fd);
      if (!entry) {
        const err = new Error(`EBADF: bad file descriptor, read (fake fd ${fd})`);
        err.code = 'EBADF';
        throw err;
      }
      const readAt = position === null || position === undefined ? entry.pos : position;
      const bytesToRead = Math.max(0, Math.min(length, entry.buf.length - readAt));
      entry.buf.copy(buffer, offset, readAt, readAt + bytesToRead);
      if (position === null || position === undefined) entry.pos += bytesToRead;
      return bytesToRead;
    },
    closeSync: (fd) => { fdTable.delete(fd); },
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

function fakeInstalledCorpusSeed(configDir) {
  const coreDir = path.join(configDir, 'gsd-core');
  const commandsDir = path.join(coreDir, 'commands');
  const commandsGsdDir = path.join(commandsDir, 'gsd');
  const agentsDir = path.join(coreDir, 'agents');
  return [
    [configDir, { type: 'dir' }],
    [coreDir, { type: 'dir' }],
    [commandsDir, { type: 'dir' }],
    [commandsGsdDir, { type: 'dir' }],
    [path.join(commandsGsdDir, 'fixture.md'), { type: 'file', content: '# Fixture command\n' }],
    [agentsDir, { type: 'dir' }],
    [path.join(agentsDir, 'fixture-agent.md'), { type: 'file', content: '# Fixture agent\n' }],
  ];
}

function fakeInstalledCorpusManifestFiles() {
  return {
    'gsd-core/commands/gsd/fixture.md': sha256Hex('# Fixture command\n'),
    'gsd-core/agents/fixture-agent.md': sha256Hex('# Fixture agent\n'),
  };
}

describe('installRuntimeArtifacts — F2: fake-adapter install touches no real filesystem', () => {
  test('fake-adapter install touches no real filesystem (claude, skills-only)', (t) => {
    // Every real fs method this call tree could reach is poisoned BY PATH
    // (see poisonRealFsAgainstDestination) for the duration of this test via
    // node:test's mock tracker (auto-restored when the test ends — no
    // try/finally in the test body, per CONTRIBUTING.md's "Never use
    // try/finally inside test bodies").
    const packageSourceHits = poisonRealFsAgainstDestination(t, '');

    const configDir = path.join(os.tmpdir(), `gsd-f2-must-not-exist-${crypto.randomUUID()}`);
    const fakeFs = createFakeInstallFs(fakeInstalledCorpusSeed(configDir));

    // configDir exists only in the fake store — F2 asserts nothing real ever
    // gets written under it. The installed corpus seed is the new provider
    // contract, not destination setup on the host filesystem.

    const result = installRuntimeArtifacts(
      'claude', configDir, 'global', RESOLVED_CORE, undefined, undefined,
      { fs: fakeFs, packageRoot: REAL_PACKAGE_ROOT },
    );

    assert.notStrictEqual(
      result,
      undefined,
      'F2: a fake-adapter install must still return an executed plan (matrix row F1/E1 shape)',
    );
    // No post-hoc fs.existsSync(configDir) check follows: fs.existsSync is
    // one of the poisoned (non-package-source) methods above for the
    // duration of this test, so the proof of "zero real DESTINATION fs
    // contact" IS that installRuntimeArtifacts returned at all without
    // tripping one of the throws — not a probe that would itself have to
    // touch the poisoned surface.
    assert.ok(
      (packageSourceHits.get('readdirSync') ?? 0) > 0,
      'F2: readGsdCommandNames must have read the real, unrouted commands/gsd/ package-source ' +
      'tree at least once — proving the poison boundary was exercised, not merely tolerated',
    );
  });

  test('fake-adapter install touches no real filesystem (opencode-family legacy command/ dir migration)', (t) => {
    poisonRealFsAgainstDestination(t, ' (opencode legacy migration)');

    const configDir = path.join(os.tmpdir(), `gsd-f2-opencode-legacy-${crypto.randomUUID()}`);
    const legacyDir = path.join(configDir, 'command');
    const legacyFile = path.join(legacyDir, 'gsd-old-cmd.md');
    const content = '# stale legacy command\n';
    const manifestPath = path.join(configDir, 'gsd-file-manifest.json');
    const manifestJson = JSON.stringify({ files: {
      ...fakeInstalledCorpusManifestFiles(),
      'command/gsd-old-cmd.md': sha256Hex(content),
    } });

    const fakeFs = createFakeInstallFs([
      ...fakeInstalledCorpusSeed(configDir),
      [legacyDir, { type: 'dir' }],
      [legacyFile, { type: 'file', content }],
      [manifestPath, { type: 'file', content: manifestJson }],
    ]);

    const result = installRuntimeArtifacts(
      'opencode', configDir, 'global', RESOLVED_CORE, undefined, undefined,
      { fs: fakeFs, packageRoot: REAL_PACKAGE_ROOT },
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
    poisonRealFsAgainstDestination(t, ' (nativePlugin)');

    // Resolve the SAME pluginSrc path _installNativePluginIfDeclared
    // (install-engine.cts) computes for pi's declared nativePlugin, using the
    // real (unrouted, package-own-source) findInstallSourceRoot — this read
    // happens BEFORE the poison mocks above are installed... no: it must
    // happen before `t.mock.method` calls would matter for IT, but
    // findInstallSourceRoot's own walk uses `fs.statSync`, which is NOT on
    // the poisoned list (see install-fs-adapter.cts's module doc — it is
    // deliberately unrouted, real-fs-only, package-source introspection), so
    // resolving this here is safe even after poisoning existsSync et al.
    const commandsGsdDir = REAL_COMMANDS_DIR;
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
      { fs: fakeFs, packageRoot: REAL_PACKAGE_ROOT },
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
    const packageSourceHits = poisonRealFsAgainstDestination(t, ' (retiredArtifacts)');

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
    const manifestJson = JSON.stringify({ files: {
      ...fakeInstalledCorpusManifestFiles(),
      [relPath]: sha256Hex(content),
    } });

    const fakeFs = createFakeInstallFs([
      ...fakeInstalledCorpusSeed(configDir),
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
    assert.ok(
      (packageSourceHits.get('readdirSync') ?? 0) > 0,
      'F2 (retiredArtifacts): readGsdCommandNames must have read the real, unrouted commands/gsd/ ' +
      'package-source tree at least once — proving the poison boundary was exercised, not merely tolerated',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #2874 follow-up round — 50-test-matrix.md rows E1/E2/E4-E12, F4-F6, G2,
// H1-H5, I1-I5, K3, L1-L2. Extends the F2/E3/E13 coverage above rather than a
// new file (install's file-count prefix is grandfathered at 8, must not grow).
// ═══════════════════════════════════════════════════════════════════════════

// ─── E. Executed-plan return shape (E1, E2, E4-E12) ──────────────────────────

describe('installRuntimeArtifacts — E1: claude global, normal install', () => {
  test('returns an executed plan for a normal install', (t) => {
    const configDir = createTempDir('gsd-e1-claude-global-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);

    assert.ok(Array.isArray(result.kinds) && result.kinds.length > 0, 'E1: plan must name at least one kind');
    for (const k of result.kinds) {
      assert.strictEqual(typeof k.kind, 'string', 'E1: every kind entry must name its kind');
      assert.strictEqual(typeof k.sourceDir, 'string', 'E1: every kind entry must name its sourceDir');
      assert.strictEqual(typeof k.destDir, 'string', 'E1: every kind entry must name its destDir');
    }
  });
});

describe('installRuntimeArtifacts — E2: claude local', () => {
  test('executed plan records the scope', (t) => {
    const configDir = createTempDir('gsd-e2-claude-local-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('claude', configDir, 'local', RESOLVED_CORE);

    assert.strictEqual(result.scope, 'local', 'E2: local scope must be reflected verbatim on the returned plan');
  });
});

describe('installRuntimeArtifacts — E4: kilo (second family member)', () => {
  test('kilo family install still returns a plan', (t) => {
    const configDir = createTempDir('gsd-e4-kilo-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('kilo', configDir, 'global', RESOLVED_CORE);

    assert.notStrictEqual(
      result, undefined,
      'E4: kilo, the SECOND combined-family runtime, must ALSO return a plan — E3 is not a one-runtime special case',
    );
    // 'agents' was added here deliberately by #2875 Part 2 Task A
    // (installAgentsKindStandalone, install-engine.cts:1614-1618): the
    // combined-family (opencode/kilo) executed plan now also reports the
    // agents kind it stages via installAgentsKindStandalone, mirroring the
    // generic layout-driven loop's own top-level shape (install-engine.cts:1627-1637).
    // This test was written under #2874 (Phase 5), before that kind was
    // wired in — its expected list was never updated. Kilo's resolved layout
    // declares an `agents` kind, so a correct plan MUST include it; a
    // ['commands', 'skills']-only expectation encoded the pre-#2875 shape,
    // not a real contract.
    assert.deepStrictEqual(result.kinds.map((k) => k.kind).sort(), ['agents', 'commands', 'skills']);
  });
});

describe('installRuntimeArtifacts — E5/E7: empty layout + nativePlugin post-step (pi)', () => {
  test('empty layout returns an empty plan', (t) => {
    const configDir = createTempDir('gsd-e5-pi-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('pi', configDir, 'global', RESOLVED_CORE);

    assert.ok(Array.isArray(result.kinds), 'E5: kinds must be an array even when layout.kinds is empty');
    assert.strictEqual(result.kinds.length, 0, 'E5: pi declares an empty artifactLayout — kinds must be [], never undefined');
  });

  test('native plugin post-step is recorded', (t) => {
    const configDir = createTempDir('gsd-e7-pi-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('pi', configDir, 'global', RESOLVED_CORE);

    assert.strictEqual(
      result.postSteps.nativePlugin, true,
      'E7: pi declares hostBehaviors.nativePlugin — postSteps.nativePlugin must record it as a post-step',
    );
  });
});

describe('installRuntimeArtifacts — E6: hermes post-step is recorded', () => {
  test('hermes post-step is recorded', (t) => {
    const configDir = createTempDir('gsd-e6-hermes-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_CORE);

    assert.strictEqual(
      result.postSteps.hermesBareStemCleanup, true,
      'E6: hermes must record _removeHermesBareStemDirs having run as a post-step',
    );
  });
});

describe('installRuntimeArtifacts — E8: preserved user skill dirs are recorded', () => {
  test('preserved user skill dirs are recorded', (t) => {
    const configDir = createTempDir('gsd-e8-claude-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);
    const preservedSkillDir = path.join(configDir, 'skills', 'gsd-dev-preferences');
    fs.mkdirSync(preservedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(preservedSkillDir, 'SKILL.md'), '# my custom prefs\n');

    const result = installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);

    const skillsKind = result.kinds.find((k) => k.kind === 'skills');
    assert.ok(skillsKind, 'E8 precondition: claude global must write a skills kind');
    assert.deepStrictEqual(
      skillsKind.preserved, ['gsd-dev-preferences'],
      'E8: the plan must record gsd-dev-preferences as preserved',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(preservedSkillDir, 'SKILL.md'), 'utf8'),
      '# my custom prefs\n',
      'E8: the preserved content must actually have been restored after the prune+copy, not just recorded on the plan',
    );
  });
});

describe('installRuntimeArtifacts — E9: non-skills kind records its writes', () => {
  test('non-skills kind records its writes', (t) => {
    const configDir = createTempDir('gsd-e9-claude-local-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('claude', configDir, 'local', RESOLVED_CORE);

    const commandsKind = result.kinds.find((k) => k.kind === 'commands');
    assert.ok(commandsKind, 'E9 precondition: claude local must write a commands kind');
    assert.strictEqual(commandsKind.destDir, path.join(configDir, 'commands'));
    assert.ok(
      fs.existsSync(commandsKind.destDir) && fs.readdirSync(commandsKind.destDir).length > 0,
      'E9: the destDir the plan records must actually contain the copied files',
    );
  });
});

describe('installRuntimeArtifacts — E10: plan item naming a kind absent from layout.kinds', () => {
  test('unknown kind still throws', (t) => {
    const configDir = createTempDir('gsd-e10-claude-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const original = runtimeArtifactInstallPlan.createRuntimeArtifactInstallPlan;
    t.after(() => { runtimeArtifactInstallPlan.createRuntimeArtifactInstallPlan = original; });
    // Module-ref monkeypatch (same pattern as
    // tests/runtime-artifact-layout-surface.test.cjs) — install-engine.cts
    // reads this via the module reference, not a destructured local, so
    // reassigning the export is observed at call time.
    runtimeArtifactInstallPlan.createRuntimeArtifactInstallPlan = (args) => {
      const real = original(args);
      if (!real.ok) return real;
      return {
        ok: true,
        plan: {
          items: [...real.plan.items, { kind: 'not-a-real-kind', sourceDir: configDir, destDir: configDir }],
          cleanupDirs: real.plan.cleanupDirs,
        },
      };
    };

    assert.throws(
      () => installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE),
      /unknown artifact kind/i,
      'E10: a plan item naming a kind absent from layout.kinds must still throw "unknown artifact kind"',
    );
  });
});

describe('installRuntimeArtifacts — E11: plan is not shared across calls', () => {
  test('plan is not shared across calls', (t) => {
    const configDir = createTempDir('gsd-e11-claude-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const first = installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);
    first.kinds.push({ kind: 'mutated-by-caller', sourceDir: 'x', destDir: 'y', preserved: [] });
    first.postSteps.mutatedFlag = true;

    const second = installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);

    assert.notStrictEqual(second, first, 'E11: each call must return a fresh object, not the same reference');
    assert.notStrictEqual(second.kinds, first.kinds, 'E11: kinds array must not be shared across calls');
    assert.ok(
      !second.kinds.some((k) => k.kind === 'mutated-by-caller'),
      'E11: mutating the first result must not leak into the second call\'s plan',
    );
    assert.strictEqual(
      second.postSteps.mutatedFlag, undefined,
      'E11: mutating the first result\'s postSteps must not leak into the second call',
    );
  });
});

describe('installRuntimeArtifacts — E12: executed plan key set is locked', () => {
  test('executed plan key set is locked', (t) => {
    const configDir = createTempDir('gsd-e12-claude-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);

    assert.deepStrictEqual(
      Object.keys(result).sort(),
      ['cleanup', 'kinds', 'postSteps', 'runtime', 'scope'],
      'E12: the executed-plan top-level key set is a locked contract — an added/renamed/removed key ' +
      'here is a breaking change to AC1/AC4 and must be a deliberate, reviewed decision, not an ' +
      'incidental refactor',
    );
  });
});

// ─── F. Fs adapter seam — F4-F6 ───────────────────────────────────────────────

/**
 * Build a fs object that implements EVERY InstallFsAdapter method by
 * delegating to real `node:fs` (mirroring install-fs-adapter.cts's own
 * REAL_ADAPTER), then applies `overrides` on top. buildGuardedAdapter
 * (install-fs-adapter.cts) now throws for any method an injected partial
 * omits (the module doc's "PARTIAL-ADAPTER TRAP" fix), so an end-to-end test
 * that drives a REAL install against a REAL destDir (F4/I2/I5 below — these
 * need real command/agent source content actually copied) while
 * intercepting only one or two specific calls needs a COMPLETE fake that
 * only fakes what it overrides — exactly the "documented, intended usage"
 * install-fs-adapter.cts's own module doc calls out, as opposed to
 * `createFakeInstallFs`'s fully in-memory store (used where the test itself
 * controls all content, e.g. F2/F5/F6).
 */
function createRealDelegatingFs(overrides = {}) {
  const base = {
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- delegate for a fake-adapter method, not test cleanup
    rmSync: (p, opts) => fs.rmSync(p, opts),
    readdirSync: (p, opts) => (opts ? fs.readdirSync(p, opts) : fs.readdirSync(p)),
    readFileSync: (p, encoding) => (encoding ? fs.readFileSync(p, encoding) : fs.readFileSync(p)),
    writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
    copyFileSync: (src, dest) => fs.copyFileSync(src, dest),
    cpSync: (src, dest, opts) => fs.cpSync(src, dest, opts),
    lstatSync: (p) => fs.lstatSync(p),
    realpathSync: (p) => fs.realpathSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
    rmdirSync: (p) => fs.rmdirSync(p),
    symlinkSync: (target, p) => fs.symlinkSync(target, p),
    readlinkSync: (p) => fs.readlinkSync(p),
    openSync: (p, flags) => fs.openSync(p, flags),
    readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
    closeSync: (fd) => fs.closeSync(fd),
  };
  return { ...base, ...overrides };
}

describe('installRuntimeArtifacts — F4: adapter errors propagate, cleanup still runs', () => {
  test('adapter errors propagate, cleanup still runs', (t) => {
    const configDir = createTempDir('gsd-f4-augment-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    let capturedCleanupDir;
    const fakeFs = createRealDelegatingFs({
      writeFileSync: (p, data, opts) => {
        if (String(p).includes('gsd-cmd-rewrites-') && capturedCleanupDir === undefined) {
          capturedCleanupDir = path.dirname(p);
        }
        fs.writeFileSync(p, data, opts);
      },
      copyFileSync: (src, dest) => {
        const err = new Error(`EACCES: permission denied, copyfile '${src}' -> '${dest}'`);
        err.code = 'EACCES';
        throw err;
      },
    });

    assert.throws(
      () => installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_FULL, TEST_ATTRIBUTION, undefined, { fs: fakeFs }),
      (err) => err.code === 'EACCES',
      'F4: an EACCES from the injected adapter mid-copy must propagate to the caller unchanged, exactly as a real EACCES would today',
    );
    assert.ok(capturedCleanupDir, 'F4 test precondition: the commands kind rewrite must have run before the copy failure');
    assert.strictEqual(
      fs.existsSync(capturedCleanupDir), false,
      'F4: cleanup must still run (the finally block) even though the copy step threw',
    );
  });
});

describe('installRuntimeArtifacts — F5: fake existsSync drives the same branch', () => {
  test('fake existsSync drives the same branch', () => {
    const configDir = path.join(os.tmpdir(), `gsd-f5-must-not-exist-${crypto.randomUUID()}`);
    const skillsDest = path.join(configDir, 'skills');
    // Seed ONLY the skills destDir as a pre-existing (empty) directory in the
    // fake store — configDir is never created for real, so existsSync(dest)
    // reports true purely because the FAKE says so, driving the exact same
    // `kind.kind === 'skills' && installFs().existsSync(dest)` pre-existing-
    // dest branch a real pre-existing dir would take.
    const fakeFs = createFakeInstallFs([[skillsDest, { type: 'dir' }]]);

    const result = installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE, undefined, undefined, { fs: fakeFs });

    assert.notStrictEqual(result, undefined, 'F5: must still return a plan');
    const skillsKind = result.kinds.find((k) => k.kind === 'skills');
    assert.ok(skillsKind, 'F5 precondition: claude global writes a skills kind');
    assert.strictEqual(skillsKind.destDir, skillsDest);
    assert.deepStrictEqual(
      skillsKind.preserved, [],
      'F5: the branch ran off the fake\'s existsSync=true, found an empty pre-existing dir, and preserved ' +
      'nothing — the same outcome the real existsSync-true branch produces for an empty pre-existing dir',
    );
  });
});

describe('installRuntimeArtifacts — F6: incomplete adapter fails loudly, never silently falls back to real fs', () => {
  // #2875 REVERSES this row's earlier pinned contract ("falls back to real
  // fs, never silently no-ops"). That contract was itself the defect
  // buildGuardedAdapter closes (install-fs-adapter.cts's "PARTIAL-ADAPTER
  // TRAP" doc comment): merging an injected partial OVER the real adapter
  // meant any method the partial omitted was silently REAL `node:fs` — e.g.
  // user-artifact-staging.cts's `stageUserArtifacts` calling
  // `installFs().rmSync(entryDir)` unconditionally, where a test fake
  // missing `rmSync` would silently delete the real
  // `<configDir>/.gsd-staging/<key>` on disk. Falling through to real fs is
  // exactly how a fake-adapter test can end up performing real, uncontrolled
  // IO — the bug, not a feature. The guarded contract instead throws
  // immediately, naming the missing method, the moment the exercised path
  // reaches it: never a silent no-op AND never a silent real-fs write.
  test('incomplete adapter fails loudly (never silently skips the write)', () => {
    const configDir = path.join(os.tmpdir(), `gsd-f6-must-not-exist-${crypto.randomUUID()}`);

    // Deliberately incomplete: only mkdirSync is implemented, to prove the
    // FIRST other method the call path reaches throws immediately instead of
    // silently degrading to real fs or a no-op.
    const incompleteFs = {
      mkdirSync: () => undefined,
    };

    assert.throws(
      () => installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE, undefined, undefined, { fs: incompleteFs }),
      (err) => /does not implement it/.test(err.message) && /PARTIAL-ADAPTER TRAP/.test(err.message),
      'F6: an incomplete adapter must fail loudly, naming the missing method, the moment the call path ' +
      'reaches a method it does not implement — never silently no-op or fall back to real fs',
    );
  });
});

// ─── G. Additive contract — G2 ────────────────────────────────────────────────

describe('installRuntimeArtifacts — G2: bin/install.js production call site unchanged', () => {
  test('installer call site unchanged', (t) => {
    const binInstall = require('../bin/install.js');
    const tmpDir = createTempDir('gsd-g2-');
    const previousCwd = process.cwd();
    process.chdir(tmpDir);
    t.after(() => { process.chdir(previousCwd); cleanup(tmpDir); });

    const result = binInstall.install(false, 'claude');

    assert.strictEqual(
      result.runtime, 'claude',
      'G2: bin/install.js\'s production call site (6 positional args, no deps) must be unaffected by the new optional deps param',
    );
    // install(false, ...) is a LOCAL install — claude's local layout writes
    // commands+agents, not skills (skills is global-only for claude).
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'commands')),
      'G2: the production install must still write commands/ end-to-end',
    );
    binInstall.uninstall(false, 'claude');
  });
});

// ─── H. Security boundaries must NOT move behind the adapter ─────────────────

describe('installRuntimeArtifacts — H1: symlink escape still refuses', () => {
  test('symlink escape still refuses', (t) => {
    const configDir = createTempDir('gsd-h1-');
    const outsideDir = createTempDir('gsd-h1-outside-');
    t.after(() => { cleanup(configDir); cleanup(outsideDir); });
    sandboxHome(t, configDir);
    // Pre-create the skills destDir AS a symlink pointing outside configDir —
    // the guard must refuse before mkdirSync ever follows it.
    fs.symlinkSync(outsideDir, path.join(configDir, 'skills'), 'dir');

    assert.throws(
      () => installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE),
      /GSD_ALLOW_SYMLINKED_DEST/,
      'H1: a destDir that is itself a symlink pointing outside the install root must be refused',
    );
  });
});

describe('installRuntimeArtifacts — H2: opt-in still follows', () => {
  test('opt-in still follows', (t) => {
    const configDir = createTempDir('gsd-h2-');
    const outsideDir = createTempDir('gsd-h2-outside-');
    t.after(() => { cleanup(configDir); cleanup(outsideDir); });
    sandboxHome(t, configDir);
    fs.symlinkSync(outsideDir, path.join(configDir, 'skills'), 'dir');

    const savedOptIn = process.env.GSD_ALLOW_SYMLINKED_DEST;
    process.env.GSD_ALLOW_SYMLINKED_DEST = '1';
    t.after(() => {
      if (savedOptIn === undefined) delete process.env.GSD_ALLOW_SYMLINKED_DEST;
      else process.env.GSD_ALLOW_SYMLINKED_DEST = savedOptIn;
    });

    const result = installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);

    assert.notStrictEqual(result, undefined, 'H2: opt-in must still succeed and return a plan');
    const skillsKind = result.kinds.find((k) => k.kind === 'skills');
    assert.ok(skillsKind, 'H2 precondition: claude global writes a skills kind');
    assert.ok(
      fs.readdirSync(outsideDir).length > 0,
      'H2: with the opt-in set, writes must actually follow the symlink into outsideDir',
    );
  });
});

describe('installRuntimeArtifacts — H3: fake adapter cannot bypass the symlink guard', () => {
  test('fake adapter cannot bypass the symlink guard', () => {
    // hasExistingSymlinkBetween's path-traversal refusal (install-engine.cts,
    // part (a) of the guard: "resolvedFullPath !== resolvedRoot &&
    // !resolvedFullPath.startsWith(resolvedRoot + path.sep)") is PURE PATH
    // MATH — path.resolve/startsWith on strings, no fs call at all. Pin that
    // invariant directly: even a fake adapter that lies "nothing exists,
    // nothing is a symlink" everywhere cannot make this refusal pass for an
    // escaping path, because this branch never asks the adapter anything.
    const root = path.join(os.tmpdir(), 'gsd-h3-fake-root');
    const escapingPath = path.join(root, '..', '..', 'etc', 'passwd');
    const lyingFs = {
      existsSync: () => false,
      lstatSync: () => {
        throw new Error('H3: lstatSync must never be reached — the path-traversal refusal is pure path math');
      },
      realpathSync: (p) => p,
    };

    const refused = withInstallFs(lyingFs, () => hasExistingSymlinkBetween(root, escapingPath));

    assert.strictEqual(
      refused, true,
      'H3: a fake adapter reporting "nothing exists, nothing is a symlink" must not be able to certify ' +
      'an install the real filesystem would refuse — the path-traversal decision does not consult the ' +
      'adapter at all',
    );
  });
});

describe('installRuntimeArtifacts — H4: dest confinement still enforced', () => {
  test('dest confinement still enforced', () => {
    assert.throws(
      () => runtimeArtifactInstallPlan.assertDestWithinConfigHome('/fake/config/home', '../../etc'),
      /escapes configHome|strict subpath/i,
      'H4: assertDestWithinConfigHome must still throw for a destSubpath escaping configHome',
    );
  });
});

describe('installRuntimeArtifacts — H5: nul byte in dest is rejected', () => {
  test('nul byte in dest is rejected', () => {
    assert.throws(
      () => runtimeArtifactInstallPlan.assertDestWithinConfigHome('/fake/config/home', 'skills\0evil'),
      /NUL/,
      'H5: assertDestWithinConfigHome must still throw for a destSubpath containing a NUL byte',
    );
  });
});

// ─── I. Cleanup visibility ─────────────────────────────────────────────────

describe('installRuntimeArtifacts — I1: successful cleanup is recorded', () => {
  test('successful cleanup is recorded', (t) => {
    const configDir = createTempDir('gsd-i1-augment-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_FULL, TEST_ATTRIBUTION);

    assert.ok(result.cleanup.length > 0, 'I1: augment install must produce at least one cleanupDirs entry to prove this row');
    for (const entry of result.cleanup) {
      assert.strictEqual(typeof entry.dir, 'string');
      assert.strictEqual(entry.ok, true, `I1: successful cleanup entries must record ok:true (dir=${entry.dir})`);
      assert.strictEqual(fs.existsSync(entry.dir), false, 'I1: a successfully cleaned dir must no longer exist on disk');
    }
  });
});

describe('installRuntimeArtifacts — I2: failed cleanup is visible, not silent', () => {
  test('failed cleanup is visible, not silent', (t) => {
    const configDir = createTempDir('gsd-i2-augment-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const fakeFs = createRealDelegatingFs({
      rmSync: (p, opts) => {
        if (String(p).includes('gsd-cmd-rewrites-')) {
          throw new Error('I2: simulated cleanup failure');
        }
        // eslint-disable-next-line local/no-raw-rmsync-in-tests -- delegate, not test cleanup
        return fs.rmSync(p, opts);
      },
    });

    const result = installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_FULL, TEST_ATTRIBUTION, undefined, { fs: fakeFs });

    assert.notStrictEqual(result, undefined, 'I2: install must still succeed (never fail) even when cleanup throws');
    assert.ok(result.cleanup.length > 0, 'I2: augment must have at least one cleanupDirs entry to fail');
    assert.ok(
      result.cleanup.every((c) => c.ok === false),
      'I2: a cleanup rmSync throw must be reported as ok:false on the returned plan, never silently dropped',
    );
  });
});

describe('installRuntimeArtifacts — I3: no cleanup dirs is an empty array', () => {
  test('no cleanup dirs is an empty array', (t) => {
    const configDir = createTempDir('gsd-i3-claude-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    const result = installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);

    assert.ok(Array.isArray(result.cleanup), 'I3: cleanup must be an array even when empty');
    assert.strictEqual(
      result.cleanup.length, 0,
      'I3: a claude/core install with no rewritten temp dirs must report an EMPTY cleanup array, not undefined/absent',
    );
  });
});

describe('installRuntimeArtifacts — I4: stage failure before any item cleans up and throws', () => {
  test('stage failure cleans up and throws', (t) => {
    const configDir = createTempDir('gsd-i4-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    assert.throws(
      () => installRuntimeArtifacts('claude', configDir, 'global', { skills: 123, agents: 123 }),
      (err) => err instanceof Error,
      'I4: a malformed resolvedProfile that fails the FIRST kind\'s stage() (before any cleanupDirs exist) ' +
      'must still surface as a thrown Error, with the (empty) cleanupDirs still swept by the finally block',
    );
  });
});

describe('installRuntimeArtifacts — I5: rewrite failure mid-plan cleans up and throws', () => {
  test('rewrite failure cleans up and throws', (t) => {
    const configDir = createTempDir('gsd-i5-augment-');
    t.after(() => cleanup(configDir));
    sandboxHome(t, configDir);

    let capturedCleanupDir;
    const fakeFs = createRealDelegatingFs({
      mkdirSync: (p, opts) => {
        if (String(p).includes('gsd-profile-runtime-skills-')) {
          throw new Error('I5: simulated skills-stage failure AFTER commands already rewrote+registered a cleanup dir');
        }
        fs.mkdirSync(p, opts);
        return undefined;
      },
      writeFileSync: (p, data, opts) => {
        if (String(p).includes('gsd-cmd-rewrites-') && capturedCleanupDir === undefined) {
          capturedCleanupDir = path.dirname(p);
        }
        fs.writeFileSync(p, data, opts);
      },
    });

    assert.throws(
      () => installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_FULL, TEST_ATTRIBUTION, undefined, { fs: fakeFs }),
      /I5: simulated skills-stage failure/,
      'I5: a failure in a LATER kind\'s stage step must still propagate as a thrown error',
    );
    assert.ok(capturedCleanupDir, 'I5 test precondition: the commands kind\'s rewrite dir must have been observed before the skills-stage failure');
    assert.strictEqual(
      fs.existsSync(capturedCleanupDir), false,
      'I5: the EARLIER (successfully rewritten) commands cleanupDir must still be removed by the finally ' +
      'block even though a LATER kind\'s stage step failed',
    );
  });
});

// ─── K. Byte-identical writes — K3 ─────────────────────────────────────────

function walkFilesRecursively(root) {
  const out = new Map();
  const walk = (relPath, absPath) => {
    for (const entry of fs.readdirSync(absPath, { withFileTypes: true })) {
      const childRel = relPath ? path.join(relPath, entry.name) : entry.name;
      const childAbs = path.join(absPath, entry.name);
      if (entry.isDirectory()) walk(childRel, childAbs);
      else if (entry.isFile()) out.set(childRel, fs.readFileSync(childAbs));
    }
  };
  if (fs.existsSync(root)) walk('', root);
  return out;
}

describe('installRuntimeArtifacts — K3: real install before/after, full recursive diff', () => {
  test('writes are byte-identical', (t) => {
    for (const runtime of ['claude', 'qwen']) {
      const dirA = createTempDir(`gsd-k3-${runtime}-a-`);
      const dirB = createTempDir(`gsd-k3-${runtime}-b-`);
      // Two SEQUENTIAL sandboxes for one test: sandboxHome()'s per-call
      // t.after hooks each save the env as they found it, so the second call
      // saves the FIRST sandbox as its "original" — hook ordering then leaves
      // HOME pointing at dirA after the test, leaking into later tests in the
      // shard (observed on the windows matrix: a leaked gsd-k3-qwen-* home
      // made the L2 property's antigravity/global run refuse via the
      // #3712 real-home guard). Manage the env directly with ONE restore.
      const savedHome = process.env.HOME;
      const savedUserProfile = process.env.USERPROFILE;
      const savedMarker = process.env.GSD_TEST_HOME_SANDBOX;
      t.after(() => {
        if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
        if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
        if (savedMarker === undefined) delete process.env.GSD_TEST_HOME_SANDBOX; else process.env.GSD_TEST_HOME_SANDBOX = savedMarker;
        cleanup(dirA); cleanup(dirB);
      });

      for (const dir of [dirA, dirB]) {
        process.env.HOME = dir;
        process.env.USERPROFILE = dir;
        process.env.GSD_TEST_HOME_SANDBOX = dir;
        installRuntimeArtifacts(runtime, dir, 'global', RESOLVED_FULL);
      }

      const filesA = walkFilesRecursively(dirA);
      const filesB = walkFilesRecursively(dirB);
      assert.deepStrictEqual(
        [...filesA.keys()].sort(), [...filesB.keys()].sort(),
        `K3 (${runtime}): the file sets written by two independent installs must match`,
      );
      for (const [relPath, contentA] of filesA) {
        if (relPath === '.gsd-source') {
          assert.strictEqual(
            contentA.toString('utf8'),
            `${path.join(dirA, 'gsd-core', 'commands', 'gsd')}\n`,
            `K3 (${runtime}): first marker must target its own installed corpus`,
          );
          assert.strictEqual(
            filesB.get(relPath).toString('utf8'),
            `${path.join(dirB, 'gsd-core', 'commands', 'gsd')}\n`,
            `K3 (${runtime}): second marker must target its own installed corpus`,
          );
          continue;
        }
        assert.ok(
          contentA.equals(filesB.get(relPath)),
          `K3 (${runtime}): ${relPath} content drifted between two independent installs`,
        );
      }
    }
  });
});

// ─── L. Property tests ────────────────────────────────────────────────────

describe('installRuntimeArtifacts — L1: plan kinds mirror layout kinds (property)', () => {
  test('plan kinds mirror layout kinds', (t) => {
    const runtimes = Object.keys(registry.runtimes);
    const RUNTIME_ARB = fc.constantFrom(...runtimes);
    const SCOPE_ARB = fc.constantFrom('global', 'local');
    const observedKindSets = new Set();
    const createdDirs = [];
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    t.after(() => {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
      for (const d of createdDirs) cleanup(d);
    });

    // Seeded, bounded numRuns, replay data on failure (verbose:true prints
    // the failing/shrunk (runtime, scope) pair fast-check found).
    fc.assert(
      fc.property(RUNTIME_ARB, SCOPE_ARB, (runtime, scope) => {
        const configDir = createTempDir(`gsd-l1-${runtime}-`);
        createdDirs.push(configDir);
        process.env.HOME = configDir;
        process.env.USERPROFILE = configDir;

        const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayout(runtime, configDir, scope);
        const expectedKinds = [...new Set(layout.kinds.map((k) => k.kind))].sort();
        const plan = installRuntimeArtifacts(runtime, configDir, scope, RESOLVED_CORE);
        const actualKinds = [...new Set(plan.kinds.map((k) => k.kind))].sort();
        observedKindSets.add(JSON.stringify(actualKinds));

        assert.deepStrictEqual(
          actualKinds, expectedKinds,
          `L1 (${runtime}/${scope}): plan.kinds must be a bijection with layout.kinds — ` +
          `plan=${JSON.stringify(actualKinds)} vs layout=${JSON.stringify(expectedKinds)}`,
        );
      }),
      { numRuns: 30, seed: 2874, verbose: true },
    );

    // Non-vacuity: the registry has runtimes with empty, single-kind, and
    // multi-kind layouts (verified across the whole registry — see this
    // row's PR notes) — a generator that only ever produced ONE kind-set
    // would be exercising nothing.
    assert.ok(
      observedKindSets.size > 1,
      `L1 non-vacuity: the generator must exercise more than one distinct kind-set — observed only ` +
      `${observedKindSets.size} (${[...observedKindSets].join(', ')})`,
    );
  });
});

describe('installRuntimeArtifacts — L2: plan is deterministic (property)', () => {
  function normalizePlanForIdempotence(plan) {
    // mkInstallTempDir names every rewrite/staging temp dir with a random hex
    // suffix (install-fs-adapter.cts) — expected to differ between two
    // independent calls even when everything else about the plan is
    // identical. Normalize those away; everything else must match exactly.
    const stripTemp = (p) => (typeof p === 'string' && p.startsWith(os.tmpdir()) ? '<TEMP>' : p);
    return {
      runtime: plan.runtime,
      scope: plan.scope,
      kinds: plan.kinds.map((k) => ({
        kind: k.kind, sourceDir: stripTemp(k.sourceDir), destDir: k.destDir,
        preserved: k.preserved, written: k.written,
      })),
      cleanup: plan.cleanup.map((c) => ({ dir: stripTemp(c.dir), ok: c.ok })),
      postSteps: plan.postSteps,
    };
  }

  test('plan is deterministic', (t) => {
    const runtimes = Object.keys(registry.runtimes);
    const RUNTIME_ARB = fc.constantFrom(...runtimes);
    const SCOPE_ARB = fc.constantFrom('global', 'local');
    let hits = 0;
    // #3738: the per-run HOME sandbox must EXIST on disk — the #3712 guard's
    // sandbox exemption fails closed when it cannot stat the effective home
    // (identify() -> 'absent'), which is exactly what a never-created configDir
    // gives it on the windows matrix where tmpdir sits under the real home.
    const createdL2Dirs = [];
    t.after(() => { for (const d of createdL2Dirs) cleanup(d); });

    fc.assert(
      fc.property(RUNTIME_ARB, SCOPE_ARB, (runtime, scope) => {
        // configDir is never created for real — both calls run against fresh,
        // independent fake adapters, so no real fs cleanup is needed here.
        const configDir = path.join(os.tmpdir(), `gsd-l2-${runtime}-${crypto.randomUUID()}`);
        fs.mkdirSync(configDir, { recursive: true });
        createdL2Dirs.push(configDir);
        // #3738: a home-override runtime (antigravity → <HOME>/.gemini/config)
        // resolves its dest from os.homedir(), NOT configDir — sandbox HOME to
        // configDir for the duration of both calls (mirroring L1 above) so the
        // plan never escapes into an ambient or leaked home and the #3712
        // real-home guard stays satisfied on hosts where tmpdir sits under the
        // real home (windows).
        const savedL2Home = process.env.HOME;
        const savedL2UserProfile = process.env.USERPROFILE;
        process.env.HOME = configDir;
        process.env.USERPROFILE = configDir;
        try {
        const planA = installRuntimeArtifacts(runtime, configDir, scope, RESOLVED_CORE, undefined, undefined, { fs: createFakeInstallFs() });
        const planB = installRuntimeArtifacts(runtime, configDir, scope, RESOLVED_CORE, undefined, undefined, { fs: createFakeInstallFs() });
        hits++;

        assert.deepStrictEqual(
          normalizePlanForIdempotence(planA),
          normalizePlanForIdempotence(planB),
          `L2 (${runtime}/${scope}): two installs against fresh fake adapters with the same inputs must ` +
          'yield structurally identical plans (temp-dir names normalized — see normalizePlanForIdempotence)',
        );
        } finally {
          if (savedL2Home === undefined) delete process.env.HOME; else process.env.HOME = savedL2Home;
          if (savedL2UserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedL2UserProfile;
        }
      }),
      { numRuns: 30, seed: 2874, verbose: true },
    );

    assert.strictEqual(hits, 30, 'L2 non-vacuity: every generated (runtime, scope) pair must actually have exercised a comparison');
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
