'use strict';

/**
 * Install fs seam — two real-fs leaks that AC2 ("an install can be exercised
 * end-to-end against an injected fs adapter with no real filesystem") does
 * not tolerate.
 *
 * #2874 (epic #2866 Phase 5), governed by ADR-58
 * (docs/adr/58-runtime-install-policy-module.md).
 *
 * (a) command-roster.cts's `readGsdCommandNames` reads the PACKAGE'S OWN
 *     `commands/gsd/` tree — not an install destination — so it must stay on
 *     real `node:fs`, unrouted, even while a fake install adapter is active
 *     for the surrounding call (mirrors findInstallSourceRoot /
 *     findAgentsSourceRoot's documented precedent in
 *     runtime-artifact-layout.cts).
 *
 * (b) install-profiles.cts's `cleanupStagedSkills` runs from a
 *     `process.on('exit'/'SIGINT'/…)` handler — AFTER `withInstallFs` has
 *     already restored the real adapter — so a dir staged during a
 *     fake-adapter call must be cleaned up with the SAME fake adapter that
 *     staged it, never with real fs.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createTempDir, cleanup } = require('./helpers.cjs');

const commandRoster = require('../gsd-core/bin/lib/command-roster.cjs');
const {
  withInstallFs,
} = require('../gsd-core/bin/lib/install-fs-adapter.cjs');
const {
  findInstallSourceRoot,
  resolveRuntimeArtifactLayout,
} = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const {
  stageSkillsForRuntimeAsSkills,
  cleanupStagedSkills,
  STAGED_DIRS,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

/**
 * A minimal in-memory fake install adapter. Every method that
 * `stageSkillsForRuntimeAsSkills` (nested=false path) can reach is
 * implemented against one flat Map store — deliberately NOT seeded with
 * anything under the real `commands/gsd/` tree, so a call that accidentally
 * routes a package-source read through this fake would either throw or
 * return the wrong (empty) stems instead of the real package's own names.
 */
function createFakeFs(seed = []) {
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
  return {
    _store: store,
    existsSync: (p) => store.has(norm(p)),
    mkdirSync: (p) => { store.set(norm(p), { type: 'dir' }); return undefined; },
    rmSync: (p) => {
      const n = norm(p);
      store.delete(n);
      const prefix = childPrefix(n);
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    },
    readdirSync: (p, opts) => {
      const e = store.get(norm(p));
      if (!e) throw enoent(p);
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
          const fe = store.get(full);
          return { name, isFile: () => (fe ? fe.type === 'file' : false) };
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
    writeFileSync: (p, data) => { store.set(norm(p), { type: 'file', content: data }); },
    copyFileSync: (src, dest) => {
      const e = store.get(norm(src));
      store.set(norm(dest), { type: 'file', content: e ? e.content : Buffer.alloc(0) });
    },
    lstatSync: (p) => {
      const e = store.get(norm(p));
      if (!e) throw enoent(p);
      return { isFile: () => e.type === 'file', isDirectory: () => e.type === 'dir', isSymbolicLink: () => false };
    },
    realpathSync: (p) => norm(p),
    unlinkSync: (p) => { store.delete(norm(p)); },
    rmdirSync: (p) => { store.delete(norm(p)); },
  };
}

// ─── (a) command-roster reads the package's OWN source, unrouted ───────────

describe('command-roster readGsdCommandNames — package-source read stays unrouted', () => {
  test('returns the real package command stems even while a poisoning fake adapter is active', () => {
    const expectedStems = fs.readdirSync(REAL_COMMANDS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    assert.ok(expectedStems.length > 0, 'REAL_COMMANDS_DIR must contain real .md command files (fixture drift)');

    // A fake whose readdirSync/existsSync ALWAYS throw or lie — if
    // readGsdCommandNames routed its read through installFs(), this would
    // either throw (poisoned) or return the wrong (empty) set instead of the
    // real package's own stems.
    const poisonFs = {
      existsSync: () => { throw new Error('leak (a): installFs().existsSync reached for the package-own commands dir'); },
      readdirSync: () => { throw new Error('leak (a): installFs().readdirSync reached for the package-own commands dir'); },
      readFileSync: () => { throw new Error('leak (a): installFs().readFileSync reached for the package-own commands dir'); },
      mkdirSync: () => { throw new Error('leak (a): installFs().mkdirSync reached'); },
      writeFileSync: () => { throw new Error('leak (a): installFs().writeFileSync reached'); },
      copyFileSync: () => { throw new Error('leak (a): installFs().copyFileSync reached'); },
      rmSync: () => { throw new Error('leak (a): installFs().rmSync reached'); },
    };

    const actualStems = withInstallFs(poisonFs, () => commandRoster.readGsdCommandNames()).sort();

    assert.deepStrictEqual(
      actualStems,
      expectedStems,
      'readGsdCommandNames must return the real package command stems, reading real fs directly, ' +
      'not the injected (poisoning) fake install adapter',
    );
  });
});

describe('runtime artifact source identity — destination probes stay routed', () => {
  test('#4132: installed provider admission streams hashes before reading corpus content', (t) => {
    const configDir = createTempDir('gsd-installed-provider-');
    t.after(() => cleanup(configDir));
    const installedCommands = path.join(configDir, 'gsd-core', 'commands', 'gsd');
    const installedAgents = path.join(configDir, 'gsd-core', 'agents');
    const commandPath = path.join(installedCommands, 'help.md');
    const agentPath = path.join(installedAgents, 'gsd-planner.md');
    const manifestPath = path.join(configDir, 'gsd-file-manifest.json');
    fs.mkdirSync(installedCommands, { recursive: true });
    fs.mkdirSync(installedAgents, { recursive: true });
    fs.writeFileSync(commandPath, '# installed command\n');
    fs.writeFileSync(agentPath, '# installed agent\n');
    fs.writeFileSync(manifestPath, JSON.stringify({ files: {
      'gsd-core/commands/gsd/help.md': crypto.createHash('sha256').update(fs.readFileSync(commandPath)).digest('hex'),
      'gsd-core/agents/gsd-planner.md': crypto.createHash('sha256').update(fs.readFileSync(agentPath)).digest('hex'),
    } }));

    const corpusPaths = new Set([commandPath, agentPath].map((candidate) => path.resolve(candidate)));
    const hashingDescriptors = new Map();
    const streamedHashes = new Set();
    const hashedBeforeRead = new Set();
    const corpusReadsBeforeHash = [];
    const readCalls = [];
    const recordingFs = {
      ...fs,
      readFileSync: (candidate, ...args) => {
        const resolved = path.resolve(String(candidate));
        readCalls.push(resolved);
        if (corpusPaths.has(resolved) && !hashedBeforeRead.has(resolved)) {
          corpusReadsBeforeHash.push(resolved);
        }
        return fs.readFileSync(candidate, ...args);
      },
      openSync: (candidate, ...args) => {
        const fd = fs.openSync(candidate, ...args);
        const resolved = path.resolve(String(candidate));
        if (corpusPaths.has(resolved)) hashingDescriptors.set(fd, resolved);
        return fd;
      },
      readSync: (fd, ...args) => {
        const resolved = hashingDescriptors.get(fd);
        if (resolved) streamedHashes.add(resolved);
        return fs.readSync(fd, ...args);
      },
      closeSync: (fd) => {
        fs.closeSync(fd);
        const resolved = hashingDescriptors.get(fd);
        if (resolved) hashedBeforeRead.add(resolved);
      },
    };

    const layout = resolveRuntimeArtifactLayout('claude', configDir, 'global');
    let stagedSkills;
    let stagedAgents;
    t.after(() => {
      if (stagedSkills) cleanup(stagedSkills);
      if (stagedAgents) cleanup(stagedAgents);
    });
    withInstallFs(recordingFs, () => {
      stagedSkills = layout.kinds.find((kind) => kind.kind === 'skills').stage({ skills: '*', agents: '*' });
      stagedAgents = layout.kinds.find((kind) => kind.kind === 'agents').stage({ skills: '*', agents: '*' });
    });

    assert.deepStrictEqual(corpusReadsBeforeHash, [], 'installed corpus files must not be pre-read before manifest hashing');
    assert.deepStrictEqual(streamedHashes, corpusPaths, 'commands and agents hashes must stream through readSync');
    assert.deepStrictEqual(hashedBeforeRead, corpusPaths, 'commands and agents hashes must use the streaming fd path');
    assert.ok(readCalls.includes(path.resolve(manifestPath)), 'provider admission must still read the install manifest');
    assert.match(fs.readFileSync(path.join(stagedSkills, 'gsd-help', 'SKILL.md'), 'utf8'), /installed command/);
    assert.match(fs.readFileSync(path.join(stagedAgents, 'gsd-planner.md'), 'utf8'), /installed agent/);
  });

  test('#4132: an installed-root alias is resolved through installFs without routing the package root', () => {
    const configDir = path.join(os.tmpdir(), `gsd-fake-config-${crypto.randomUUID()}`);
    const installedCommands = path.join(configDir, 'gsd-core', 'commands', 'gsd');
    const probes = [];
    const missing = (p) => {
      const error = new Error(`ENOENT: no such file or directory, '${p}'`);
      error.code = 'ENOENT';
      throw error;
    };
    const fakeFs = {
      existsSync: () => false,
      lstatSync: missing,
      realpathSync: (p) => {
        probes.push(path.normalize(String(p)));
        return path.normalize(String(p)) === path.normalize(installedCommands)
          ? fs.realpathSync(REAL_COMMANDS_DIR)
          : path.normalize(String(p));
      },
    };

    assert.throws(
      () => withInstallFs(fakeFs, () => findInstallSourceRoot(configDir)),
      /install or upgrade gsd-core/,
    );
    assert.deepStrictEqual(
      probes,
      [path.normalize(installedCommands)],
      'installed destination identity must use installFs, while package-source identity stays on raw fs',
    );
  });

  test('#4132: an unreadable physical root cannot prove a marker is independent', () => {
    const configDir = path.join(os.tmpdir(), `gsd-fake-config-${crypto.randomUUID()}`);
    const installedCommands = path.join(configDir, 'gsd-core', 'commands', 'gsd');
    const markerCommands = path.join(configDir, 'independent', 'commands', 'gsd');
    const fakeFs = createFakeFs([
      [configDir, { type: 'dir' }],
      [path.join(configDir, 'gsd-core'), { type: 'dir' }],
      [path.join(configDir, 'gsd-core', 'commands'), { type: 'dir' }],
      [installedCommands, { type: 'dir' }],
      [path.join(installedCommands, 'help.md'), { type: 'file', content: '# unverified installed command\n' }],
      [path.join(configDir, 'independent'), { type: 'dir' }],
      [path.join(configDir, 'independent', 'commands'), { type: 'dir' }],
      [markerCommands, { type: 'dir' }],
      [path.join(markerCommands, 'help.md'), { type: 'file', content: '# marker command\n' }],
      [path.join(configDir, '.gsd-source'), { type: 'file', content: markerCommands + '\n' }],
    ]);
    fakeFs.realpathSync = (p) => {
      if ([installedCommands, markerCommands].includes(path.normalize(String(p)))) {
        const error = new Error(`EACCES: permission denied, realpath '${p}'`);
        error.code = 'EACCES';
        throw error;
      }
      return path.normalize(String(p));
    };

    assert.throws(
      () => withInstallFs(fakeFs, () => findInstallSourceRoot(configDir)),
      /install or upgrade gsd-core/,
    );
  });
});

// ─── (b) cleanupStagedSkills must not perform real IO on fake-staged dirs ──

describe('install-profiles cleanupStagedSkills — deferred cleanup does not leak past the restore', () => {
  test('a fake-adapter install followed by the exit handler performs zero real fs.rmSync calls', (t) => {
    const fakeSrcDir = path.join(os.tmpdir(), `gsd-fake-src-${crypto.randomUUID()}`);
    const fakeFs = createFakeFs([
      [fakeSrcDir, { type: 'dir' }],
      [path.join(fakeSrcDir, 'alpha.md'), { type: 'file', content: '# alpha\n' }],
    ]);

    // Poison real fs.rmSync for the duration of this test — auto-restored by
    // node:test's mock tracker when the test ends (no try/finally needed).
    let realRmSyncCalls = 0;
    t.mock.method(fs, 'rmSync', () => {
      realRmSyncCalls++;
      throw new Error('leak (b): real fs.rmSync() was reached for a dir staged under a fake adapter');
    });

    const converter = (content, _skillName) => content;
    const stagedDir = withInstallFs(
      fakeFs,
      () => stageSkillsForRuntimeAsSkills(fakeSrcDir, { skills: '*' }, converter, 'gsd-'),
    );

    assert.ok(STAGED_DIRS.has(stagedDir), 'stageSkillsForRuntimeAsSkills must register the staged dir for cleanup');
    assert.ok(fakeFs._store.has(path.normalize(stagedDir)), 'staged dir must exist in the fake store');

    // Simulate the exit handler: `current` (install-fs-adapter.cts) is back
    // to the real adapter here — withInstallFs already restored it above.
    cleanupStagedSkills();

    assert.strictEqual(realRmSyncCalls, 0, 'cleanupStagedSkills must never call real fs.rmSync for a fake-staged dir');
    assert.strictEqual(fakeFs._store.has(path.normalize(stagedDir)), false, 'the fake-staged dir must be removed via the fake adapter');
    assert.strictEqual(STAGED_DIRS.has(stagedDir), false, 'STAGED_DIRS must be cleared after cleanup');
  });

  test('negative proof: a REAL install still cleans up its own staged dirs', (t) => {
    const srcDir = createTempDir('gsd-real-src-');
    t.after(() => cleanup(srcDir));
    fs.writeFileSync(path.join(srcDir, 'alpha.md'), '# alpha\n');

    const converter = (content, _skillName) => content;
    const stagedDir = stageSkillsForRuntimeAsSkills(srcDir, { skills: '*' }, converter, 'gsd-');
    t.after(() => { if (fs.existsSync(stagedDir)) cleanup(stagedDir); });

    assert.ok(fs.existsSync(stagedDir), 'real staged dir must exist on real fs before cleanup');
    assert.ok(STAGED_DIRS.has(stagedDir), 'real staged dir must be registered');

    cleanupStagedSkills();

    assert.strictEqual(fs.existsSync(stagedDir), false, 'a REAL install must still remove its staged dir on cleanup — no temp-dir leak');
    assert.strictEqual(STAGED_DIRS.has(stagedDir), false, 'STAGED_DIRS must be cleared after cleanup');
  });
});
