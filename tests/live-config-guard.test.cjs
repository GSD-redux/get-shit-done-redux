'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fc = require('fast-check');

const {
  GSD_OWNED_ENTRIES,
  artifactTargets,
  MAX_DEPTH,
  resolveLiveConfigRoots,
  resolveExtraWatchTargets,
  snapshotLiveConfig,
  diffLiveConfig,
  formatViolations,
  newestMtime,
} = require('../scripts/live-config-guard.cjs');

const { cleanup } = require('./helpers.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'live-config-guard-'));
}

/** Create `n` flat files under a fresh dir; returns [dir, entryCount-including-dir]. */
function treeWithEntries(n) {
  const dir = tmpRoot();
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'x');
  return [dir, n + 1]; // +1: the directory itself is lstat'd and costs budget
}

describe('#2665: live-config hermeticity guard', () => {
  test('resolves real runtime config roots via the product resolver', () => {
    const roots = resolveLiveConfigRoots();
    // Guards the guard: an empty set would make every downstream assertion
    // vacuous, and run-tests.cjs would silently skip the check.
    assert.ok(roots.length > 5, `expected many runtime config roots, got ${roots.length}`);
    for (const root of roots) {
      assert.ok(path.isAbsolute(root), `root must be absolute: ${root}`);
    }
  });

  test('watches the HOME-derived fallback root, not only the ambient one', () => {
    // #2665 round 5: the guard resolves env-first, so it sees the AMBIENT root.
    // A child that blanks CLAUDE_CONFIG_DIR (which is exactly what TEST_ENV_BASE
    // does) falls back to <HOME>/.claude instead. Watching only the ambient path
    // leaves that fallback unwatched -- the escape route this PR closes, one
    // process deeper.
    const ambient = tmpRoot();
    const fakeHome = tmpRoot();
    const saved = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = ambient;
      const roots = resolveLiveConfigRoots({ os: { homedir: () => fakeHome } });
      assert.ok(
        roots.includes(path.resolve(ambient)),
        `ambient root missing from ${JSON.stringify(roots)}`,
      );
      assert.ok(
        roots.includes(path.resolve(path.join(fakeHome, '.claude'))),
        `HOME-derived fallback root missing from ${JSON.stringify(roots)}`,
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      cleanup(ambient);
      cleanup(fakeHome);
    }
  });

  test('a clean run produces no violations', () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gsd-core', 'bin', 'x.cjs'), 'x');

      const before = snapshotLiveConfig([root]);
      const after = snapshotLiveConfig([root]);
      assert.deepStrictEqual(diffLiveConfig(before, after), []);
    } finally {
      cleanup(root);
    }
  });

  test('detects a global install CREATED during the run', () => {
    const root = tmpRoot();
    try {
      const before = snapshotLiveConfig([root]);
      // Exactly the Blocker 1 shape: an in-process install(true, …) landing a
      // full global install in a live config dir that was previously empty.
      fs.mkdirSync(path.join(root, 'gsd-core'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gsd-file-manifest.json'), '{}');

      const violations = diffLiveConfig(before, snapshotLiveConfig([root]));
      const kinds = Object.fromEntries(violations.map((v) => [path.basename(v.path), v.kind]));
      assert.strictEqual(kinds['gsd-core'], 'created');
      assert.strictEqual(kinds['gsd-file-manifest.json'], 'created');
    } finally {
      cleanup(root);
    }
  });

  test('detects an existing install MODIFIED during the run', () => {
    const root = tmpRoot();
    try {
      const target = path.join(root, 'gsd-core', 'bin');
      fs.mkdirSync(target, { recursive: true });
      const file = path.join(target, 'gsd-tools.cjs');
      fs.writeFileSync(file, 'original');

      const before = snapshotLiveConfig([root]);
      // mtime resolution is coarse on some filesystems; set it forward explicitly
      // rather than racing the clock with a sleep.
      const future = new Date(Date.now() + 10000);
      fs.writeFileSync(file, 'clobbered');
      fs.utimesSync(file, future, future);

      const violations = diffLiveConfig(before, snapshotLiveConfig([root]));
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'modified');
      assert.strictEqual(path.basename(violations[0].path), 'gsd-core');
    } finally {
      cleanup(root);
    }
  });

  test('ignores non-GSD writes in a shared config root', () => {
    const root = tmpRoot();
    try {
      const before = snapshotLiveConfig([root]);
      // A concurrent host-agent session writing its own state must NOT trip the
      // guard — a guard that cries wolf gets disabled, and then catches nothing.
      fs.writeFileSync(path.join(root, 'history.jsonl'), '{}');
      fs.mkdirSync(path.join(root, 'todos'), { recursive: true });
      fs.writeFileSync(path.join(root, 'settings.json'), '{}');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([root])), []);
    } finally {
      cleanup(root);
    }
  });

  test('watches exactly the GSD-owned entry set', () => {
    const root = tmpRoot();
    try {
      const snap = snapshotLiveConfig([root]);
      const watched = Object.keys(snap).map((p) => path.relative(root, p)).sort();
      // Top-level owned entries PLUS the nested paths GSD owns wholesale inside a
      // shared root; prefixed children contribute nothing in an empty root.
      const expected = [
        ...GSD_OWNED_ENTRIES,
        ...artifactTargets().owned.map((o) => path.join(...o.split('/'))),
      ].sort();
      assert.deepStrictEqual(watched, expected);
    } finally {
      cleanup(root);
    }
  });

  test('detects a gsd-prefixed artifact written into a SHARED dir', () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
      const before = snapshotLiveConfig([root]);
      // The exact leak the first version of this guard MISSED: a writer that
      // sandboxed HOME but inherited an ambient CLAUDE_CONFIG_DIR landed
      // <live>/skills/gsd-dev-preferences/SKILL.md, outside the three
      // top-level GSD entries.
      fs.mkdirSync(path.join(root, 'skills', 'gsd-dev-preferences'), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills', 'gsd-dev-preferences', 'SKILL.md'), '# x');

      const violations = diffLiveConfig(before, snapshotLiveConfig([root]));
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'created');
      assert.strictEqual(path.basename(violations[0].path), 'gsd-dev-preferences');
    } finally {
      cleanup(root);
    }
  });

  test('ignores NON-gsd artifacts in a shared dir', () => {
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
      const before = snapshotLiveConfig([root]);
      // The host agent's own skills must not trip the guard.
      fs.mkdirSync(path.join(root, 'skills', 'my-personal-skill'), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills', 'my-personal-skill', 'SKILL.md'), '# mine');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([root])), []);
    } finally {
      cleanup(root);
    }
  });

  test('detects a leaked hook script and the install marker files', () => {
    // Self-found by re-deriving the census at round 5 rather than by a review
    // finding. bin/install.js writes hooks/gsd-*.js, .gsd-source and .gsd-profile
    // into the config ROOT; `hooks` was absent from GSD_PREFIXED_PARENTS and the
    // two dot-prefixed markers from GSD_OWNED_ENTRIES, so all three leaked past
    // the guard silently -- the same shape as the skills/gsd-dev-preferences miss
    // that motivated the prefixed-parent scan in the first place.
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
      const before = snapshotLiveConfig([root]);
      fs.writeFileSync(path.join(root, 'hooks', 'gsd-check-update.js'), '// x');
      fs.writeFileSync(path.join(root, '.gsd-source'), 'npm');
      fs.writeFileSync(path.join(root, '.gsd-profile'), 'default');

      const created = diffLiveConfig(before, snapshotLiveConfig([root]))
        .filter((v) => v.kind === 'created')
        .map((v) => path.basename(v.path))
        .sort();
      assert.deepStrictEqual(created, ['.gsd-profile', '.gsd-source', 'gsd-check-update.js']);
    } finally {
      cleanup(root);
    }
  });

  test('a NON-gsd hook belonging to the host agent is still ignored', () => {
    // Widening GSD_PREFIXED_PARENTS must not widen ownership: `hooks/` is shared
    // with the host agent, and a guard that flags its files gets switched off.
    const root = tmpRoot();
    try {
      fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
      const before = snapshotLiveConfig([root]);
      fs.writeFileSync(path.join(root, 'hooks', 'my-own-hook.js'), '// mine');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([root])), []);
    } finally {
      cleanup(root);
    }
  });

  test('artifact parents are DERIVED from the registry, not hand-listed', () => {
    // Round 5's adversarial review refuted the completeness claim of the
    // hand-list: it missed Kilo's SINGULAR `command/`, `workflows/`, and hermes'
    // `skills/gsd` -- a whole directory whose name carries no `gsd-` prefix, so
    // no prefix rule could ever reach it.
    const { parents, owned } = artifactTargets();
    // NB: `workflows` is declared only in LOCAL scope (windsurf), so it is
    // deliberately NOT a global config-root parent -- the derivation walks
    // artifactLayout.global only.
    for (const p of ['agents', 'commands', 'command', 'skills', 'hooks', 'plugins', 'scripts', 'extensions']) {
      assert.ok(p in parents, `expected derived parent ${p} in ${JSON.stringify(Object.keys(parents))}`);
    }
    // kimi's kimi-agents layout declares prefix `gsd` (no hyphen); a fixed `gsd-`
    // scan cannot see agents/gsd.yaml, which is the defect this derivation closes.
    assert.ok(
      parents.agents.includes('gsd'),
      `agents must carry kimi's bare 'gsd' prefix; got ${JSON.stringify(parents.agents)}`,
    );
    assert.ok(owned.includes('skills/gsd'), `expected hermes skills/gsd in ${JSON.stringify(owned)}`);
    // Exact GSD filenames only — never the shared directories that contain them.
    for (const o of ['scripts/fix-slash-commands.cjs', 'hooks/managed-hooks-registry.cjs']) {
      assert.ok(owned.includes(o), `expected owned nested ${o} in ${JSON.stringify(owned)}`);
    }
    for (const shared of ['hooks/lib', 'hooks/package.json', 'scripts/lib', 'scripts/changeset']) {
      assert.ok(!owned.includes(shared), `${shared} is shared ground and must NOT be watched wholesale`);
    }
  });

  test('detects leaks a single hardcoded gsd- prefix cannot see', () => {
    const root = tmpRoot();
    try {
      for (const d of ['skills/gsd', 'agents', 'plugins', 'command', 'extensions']) {
        fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
      }
      const before = snapshotLiveConfig([root]);
      const future = new Date(Date.now() + 10000);
      // kimi declares prefix `gsd` (no hyphen) and writes agents/gsd.yaml;
      // pi writes extensions/gsd.js. A fixed `gsd-` scan sees neither.
      const leaks = [
        ['skills', 'gsd', 'executor.md'],
        ['agents', 'gsd.yaml'],
        ['extensions', 'gsd.js'],
        ['plugins', 'gsd-core.js'],
        ['command', 'gsd-plan.md'],
      ];
      for (const seg of leaks) {
        const f = path.join(root, ...seg);
        fs.writeFileSync(f, '// leaked');
        fs.utimesSync(f, future, future);
        fs.utimesSync(path.dirname(f), future, future);
      }

      const hit = diffLiveConfig(before, snapshotLiveConfig([root])).map((v) => v.path);
      for (const expected of ['skills/gsd', 'agents/gsd.yaml', 'extensions/gsd.js', 'plugins/gsd-core.js', 'command/gsd-plan.md']) {
        const abs = path.join(root, ...expected.split('/'));
        assert.ok(hit.includes(abs), `${expected} leaked undetected; got ${JSON.stringify(hit)}`);
      }
    } finally {
      cleanup(root);
    }
  });

  test('a user editing their OWN files in a shared dir is not a violation', () => {
    // The false-positive case a prior commit shipped: hooks/lib, hooks/package.json,
    // scripts/lib and scripts/changeset were watched WHOLESALE, so touching a
    // user-authored helper in any of them tripped the guard. The installer itself
    // preserves foreign files in all four, so they are not GSD's to watch.
    const root = tmpRoot();
    try {
      for (const d of ['hooks/lib', 'scripts/lib', 'scripts/changeset']) {
        fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
      }
      const foreign = [
        ['hooks', 'package.json'],
        ['hooks', 'lib', 'user-helper.js'],
        ['scripts', 'lib', 'user-helper.cjs'],
        ['scripts', 'changeset', 'user-tool.cjs'],
      ];
      for (const seg of foreign) fs.writeFileSync(path.join(root, ...seg), 'mine');
      const before = snapshotLiveConfig([root]);
      const future = new Date(Date.now() + 10000);
      for (const seg of foreign) {
        const f = path.join(root, ...seg);
        fs.writeFileSync(f, 'mine, edited');
        fs.utimesSync(f, future, future);
        fs.utimesSync(path.dirname(f), future, future);
      }

      assert.deepStrictEqual(
        diffLiveConfig(before, snapshotLiveConfig([root])),
        [],
        'editing user-owned files in a shared dir must not trip the guard',
      );
    } finally {
      cleanup(root);
    }
  });

  test('extra watch targets cover the fallback root as well as the ambient one', () => {
    // The MISSED finding from round 5's review: B3 closed this for the registry
    // roots and left the identical hole in resolveExtraWatchTargets.
    const targets = resolveExtraWatchTargets({
      env: { GSD_HOME: '/ambient-gsd-home', KIMI_SHARE_DIR: '/ambient-kimi' },
      os: { homedir: () => '/fallback-home' },
    });
    assert.ok(targets.includes(path.resolve('/ambient-gsd-home/.gsd')), 'ambient $GSD_HOME/.gsd');
    assert.ok(targets.includes(path.resolve('/fallback-home/.gsd')), 'HOME-derived .gsd fallback');
    assert.ok(
      targets.some((t) => t === path.resolve('/fallback-home/.kimi/config.toml')),
      `HOME-derived kimi fallback missing from ${JSON.stringify(targets)}`,
    );
  });

  test('detects a DELETED top-level GSD entry', () => {
    const root = tmpRoot();
    try {
      // A fixed owned entry is recorded at BOTH ends whether or not it exists,
      // so a deletion reads {exists:true} -> {exists:false}. Before the union
      // walk that pair matched no branch at all and the run passed silently.
      fs.mkdirSync(path.join(root, 'gsd-core'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gsd-core', 'x'), 'x');
      const before = snapshotLiveConfig([root]);
      cleanup(path.join(root, 'gsd-core'));

      const violations = diffLiveConfig(before, snapshotLiveConfig([root]));
      const deleted = violations.filter((v) => v.kind === 'deleted');
      assert.strictEqual(deleted.length, 1, JSON.stringify(violations));
      assert.strictEqual(path.basename(deleted[0].path), 'gsd-core');
    } finally {
      cleanup(root);
    }
  });

  test('detects a DELETED gsd-prefixed child of a shared dir', () => {
    const root = tmpRoot();
    try {
      // The shape a `pre.exists && !post.exists` branch cannot reach on its own:
      // prefixed children are DISCOVERED by readdir, so a deleted one is absent
      // from the `after` snapshot entirely and never enters an after-keyed loop.
      fs.mkdirSync(path.join(root, 'skills', 'gsd-dev-preferences'), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills', 'gsd-dev-preferences', 'SKILL.md'), '# x');
      const before = snapshotLiveConfig([root]);
      cleanup(path.join(root, 'skills', 'gsd-dev-preferences'));

      const violations = diffLiveConfig(before, snapshotLiveConfig([root]));
      const deleted = violations.filter((v) => v.kind === 'deleted');
      assert.strictEqual(deleted.length, 1, JSON.stringify(violations));
      assert.strictEqual(path.basename(deleted[0].path), 'gsd-dev-preferences');
    } finally {
      cleanup(root);
    }
  });

  test('the scan budget is PER TARGET, so one big tree cannot cascade unverified', () => {
    // #2665 round 5: with a single running budget, target A exhausting it made
    // target B report `truncated` -> `unverified` -- a strict-mode FAILURE caused
    // by an unrelated directory. Each target now gets its own allotment.
    const [big] = treeWithEntries(8);
    const [small] = treeWithEntries(2);
    try {
      const snap = snapshotLiveConfig([], [big, small], { perTarget: 9, total: 1000 });
      assert.strictEqual(snap[path.resolve(big)].truncated, false, 'big target should fit its own budget');
      assert.strictEqual(
        snap[path.resolve(small)].truncated,
        false,
        'small target must NOT inherit exhaustion from a target scanned before it',
      );
    } finally {
      cleanup(big);
      cleanup(small);
    }
  });

  test('the truncation verdict does not depend on target ORDER (below the global ceiling)', () => {
    const [big] = treeWithEntries(8);
    const [small] = treeWithEntries(2);
    try {
      const limits = { perTarget: 9, total: 1000 };
      const a = snapshotLiveConfig([], [big, small], limits);
      const b = snapshotLiveConfig([], [small, big], limits);
      assert.strictEqual(a[path.resolve(small)].truncated, b[path.resolve(small)].truncated);
      assert.strictEqual(a[path.resolve(big)].truncated, b[path.resolve(big)].truncated);
    } finally {
      cleanup(big);
      cleanup(small);
    }
  });

  test('a non-finite injected limit falls back to the real bound, never fails open', () => {
    // Math.max(0, NaN) is NaN, and every budget comparison against NaN is false,
    // so the walk becomes unbounded — the one thing the bound exists to prevent.
    // The discriminator has to be a case where the two behaviours DIFFER: pair a
    // NaN perTarget with a small finite ceiling. Fixed, perTarget falls back to
    // MAX_ENTRIES and the ceiling still bites (truncated). Broken, min(NaN, 3) is
    // NaN and nothing truncates at all.
    const [dir] = treeWithEntries(6);
    try {
      const snap = snapshotLiveConfig([], [dir], { perTarget: NaN, total: 3 });
      assert.strictEqual(
        snap[path.resolve(dir)].truncated,
        true,
        'a NaN perTarget must fall back to a real bound, not disable budgeting',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('the GLOBAL ceiling still bounds the aggregate, and reports unverified', () => {
    // The bound the single budget was really for is kept -- but when it engages,
    // the curtailed target is reported rather than silently attested clean.
    const [a] = treeWithEntries(5);
    const [b] = treeWithEntries(5);
    try {
      const snap = snapshotLiveConfig([], [a, b], { perTarget: 6, total: 6 });
      assert.strictEqual(snap[path.resolve(a)].truncated, false);
      assert.strictEqual(snap[path.resolve(b)].truncated, true, 'ceiling-curtailed target must be truncated');
      const violations = diffLiveConfig(snap, snap);
      assert.ok(
        violations.some((v) => v.kind === 'unverified' && v.path === path.resolve(b)),
        `expected an unverified violation for the curtailed target: ${JSON.stringify(violations)}`,
      );
    } finally {
      cleanup(a);
      cleanup(b);
    }
  });

  test('the report names the path and the remedy', () => {
    const out = formatViolations([{ path: '/live/.claude/gsd-core', kind: 'created' }]);
    assert.match(out, /HERMETICITY WARNING/);
    assert.match(out, /\/live\/\.claude\/gsd-core/);
    assert.match(out, /scrubConfigLocationEnv/);
    assert.match(out, /GSD_SKIP_LIVE_CONFIG_GUARD/);
    assert.match(out, /GSD_STRICT_LIVE_CONFIG_GUARD/);
  });
});

// ── Round 3: the write surfaces that are not runtime config ROOTS ───────────
describe('#2665: guard watches non-root write surfaces', () => {
  test('resolveExtraWatchTargets covers $GSD_HOME/.gsd and kimi config.toml', () => {
    const home = tmpRoot();
    const share = tmpRoot();
    try {
      const targets = resolveExtraWatchTargets({
        env: { GSD_HOME: home, KIMI_SHARE_DIR: share },
        os: { homedir: () => home },
      });
      assert.ok(
        targets.includes(path.resolve(path.join(home, '.gsd'))),
        `expected $GSD_HOME/.gsd in ${JSON.stringify(targets)}`,
      );
      assert.ok(
        targets.some((t) => t === path.resolve(path.join(share, 'config.toml'))),
        `expected kimi config.toml in ${JSON.stringify(targets)}`,
      );
    } finally {
      cleanup(home);
      cleanup(share);
    }
  });

  test('extra targets are DERIVED from the descriptor array, not a named resolver', () => {
    const {
      NON_REGISTRY_CONFIG_HOME_DESCRIPTORS,
      resolveConfigHomeFromDescriptor,
    } = require('../gsd-core/bin/lib/runtime-homes.cjs');
    const home = tmpRoot();
    try {
      const env = { GSD_HOME: home };
      const targets = resolveExtraWatchTargets({ env, os: { homedir: () => home } });

      // Every descriptor in the array must contribute a target. Calling one
      // named resolver instead would cover one of today's two entries and silently
      // miss tomorrow's — the same partial-enumeration defect that put
      // KIMI_SHARE_DIR outside the scrub set, one layer over.
      //
      // SCOPE BOUNDARY (per round-2 Nit 7, and it bites here): this asserts one
      // target PER DESCRIPTOR and nothing about whether one target per descriptor
      // is ENOUGH. It is not — <root>/hooks/ is also GSD-written and unwatched
      // (named residual in resolveExtraWatchTargets). A test whose expectation is
      // derived from the same array it checks cannot see that class.
      for (const d of NON_REGISTRY_CONFIG_HOME_DESCRIPTORS) {
        const dir = resolveConfigHomeFromDescriptor(d, { env, home });
        assert.ok(
          targets.includes(path.resolve(path.join(dir, 'config.toml'))),
          `descriptor ${JSON.stringify(d.env)} contributed no watch target`,
        );
      }
      // The count is what actually catches a regression to a hardcoded call:
      // it fails the moment the array grows and the guard does not follow.
      assert.strictEqual(
        targets.length,
        1 + NON_REGISTRY_CONFIG_HOME_DESCRIPTORS.length,
        'expected the GSD store root plus exactly one target per descriptor',
      );
    } finally {
      cleanup(home);
    }
  });

  test('#2755: kimi-code config.toml is watched — named, not enumeration-relative', () => {
    // The test above derives its expectation FROM the descriptor array, so it
    // passes for whatever that array happens to contain and cannot see a
    // descriptor that was never added — the enumeration-relative scope boundary
    // this suite already calls out one layer down. #2755 landed kimi-code's
    // `~/.kimi-code` (KIMI_CODE_HOME) on `next` as an inline literal inside
    // resolveKimiHooksTomlDir's body; until it was hoisted into
    // NON_REGISTRY_CONFIG_HOME_DESCRIPTORS the guard watched Kimi CLI's
    // config.toml and not Kimi Code's. Naming the path is what makes dropping
    // the descriptor fail loudly instead of quietly shrinking the expectation.
    const home = tmpRoot();
    const codeHome = tmpRoot();
    try {
      const env = { GSD_HOME: home, KIMI_CODE_HOME: codeHome };
      const targets = resolveExtraWatchTargets({ env, os: { homedir: () => home } });
      assert.ok(
        targets.includes(path.resolve(path.join(codeHome, 'config.toml'))),
        `expected kimi-code config.toml in ${JSON.stringify(targets)}`,
      );
    } finally {
      cleanup(home);
      cleanup(codeHome);
    }
  });

  test('GSD_HOME falls back to homedir when unset', () => {
    const home = tmpRoot();
    try {
      const targets = resolveExtraWatchTargets({ env: {}, os: { homedir: () => home } });
      assert.ok(targets.includes(path.resolve(path.join(home, '.gsd'))));
    } finally {
      cleanup(home);
    }
  });

  test('detects a consent/defaults write into $GSD_HOME/.gsd', () => {
    const home = tmpRoot();
    try {
      const target = path.join(home, '.gsd');
      const before = snapshotLiveConfig([], [target]);
      // The Blocker-1 shape one family over: an ambient GSD_HOME sends real
      // consent records and defaults.json into the developer's own store.
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'consent.json'), '{}');

      const violations = diffLiveConfig(before, snapshotLiveConfig([], [target]));
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'created');
    } finally {
      cleanup(home);
    }
  });

  test('detects a [[hooks]] write into kimi config.toml', () => {
    const share = tmpRoot();
    try {
      const target = path.join(share, 'config.toml');
      const before = snapshotLiveConfig([], [target]);
      fs.writeFileSync(target, '[[hooks]]\n');

      const violations = diffLiveConfig(before, snapshotLiveConfig([], [target]));
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'created');
    } finally {
      cleanup(share);
    }
  });

  test('NEGATIVE CONTROL: without the extras both leaks are silent', () => {
    const home = tmpRoot();
    try {
      // This is the pre-round-3 guard shape — roots only. It is what let a leak
      // on either variable pass through the PR's own safety net unreported.
      const before = snapshotLiveConfig([]);
      fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gsd', 'consent.json'), '{}');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([])), []);
    } finally {
      cleanup(home);
    }
  });

  test('a whole-dir extra target does not watch unrelated siblings', () => {
    const home = tmpRoot();
    try {
      const target = path.join(home, '.gsd');
      fs.mkdirSync(target, { recursive: true });
      const before = snapshotLiveConfig([], [target]);
      // A sibling of .gsd is outside the watched target entirely.
      fs.writeFileSync(path.join(home, 'unrelated.json'), '{}');

      assert.deepStrictEqual(diffLiveConfig(before, snapshotLiveConfig([], [target])), []);
    } finally {
      cleanup(home);
    }
  });
});

// ── Round 3: the truncation budget — the module's own safety-critical case ───
describe('#2665: scan-budget truncation', () => {
  test('boundary: limit-1 truncates, limit and limit+1 do not', () => {
    const [dir, entries] = treeWithEntries(24);
    try {
      // RULESET.TESTS.boundary-coverage: N in {limit-1, limit, limit+1}. The
      // budget is injected, so the boundary is exercised at a real threshold
      // without materialising MAX_ENTRIES files.
      assert.strictEqual(
        newestMtime(dir, { remaining: entries - 1 }).truncated,
        true,
        'one entry short of the tree size MUST truncate',
      );
      assert.strictEqual(
        newestMtime(dir, { remaining: entries }).truncated,
        false,
        'a budget exactly equal to the tree size must NOT truncate',
      );
      assert.strictEqual(
        newestMtime(dir, { remaining: entries + 1 }).truncated,
        false,
        'a budget above the tree size must NOT truncate',
      );
    } finally {
      cleanup(dir);
    }
  });

  // RULESET.TESTS.boundary-coverage asks for {limit-1, limit, limit+1}. This was
  // exercised only at limit+2, which pins neither side of the edge: an off-by-one
  // that truncated a legal depth would have passed. `nestedDepth(n)` builds a tree
  // whose deepest entry sits at walk-depth n below the scanned root, and
  // newestMtime truncates iff that depth EXCEEDS MAX_DEPTH.
  const nestedDepth = (n) => {
    const dir = tmpRoot();
    let deep = dir;
    for (let i = 0; i < n; i++) deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep, { recursive: true });
    return dir;
  };

  test(`MAX_DEPTH boundary: depth ${MAX_DEPTH - 1} (limit-1) does NOT truncate`, () => {
    const dir = nestedDepth(MAX_DEPTH - 1);
    try {
      assert.strictEqual(newestMtime(dir, { remaining: 1e6 }).truncated, false);
    } finally {
      cleanup(dir);
    }
  });

  test(`MAX_DEPTH boundary: depth ${MAX_DEPTH} (limit) does NOT truncate`, () => {
    const dir = nestedDepth(MAX_DEPTH);
    try {
      assert.strictEqual(
        newestMtime(dir, { remaining: 1e6 }).truncated,
        false,
        'a tree exactly at MAX_DEPTH is within bounds and must be attested',
      );
    } finally {
      cleanup(dir);
    }
  });

  test(`MAX_DEPTH boundary: depth ${MAX_DEPTH + 1} (limit+1) truncates`, () => {
    const dir = nestedDepth(MAX_DEPTH + 1);
    try {
      assert.strictEqual(
        newestMtime(dir, { remaining: 1e6 }).truncated,
        true,
        'a tree deeper than MAX_DEPTH must truncate',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('a truncated scan reports UNVERIFIED, never clean', () => {
    const [dir, entries] = treeWithEntries(10);
    try {
      // The safety-critical branch named in this module's own docstring: a scan
      // that hit a bound must not read as an attestation of cleanliness.
      const snap = { [dir]: { exists: true, newest: 1, truncated: true } };
      const violations = diffLiveConfig(snap, {
        [dir]: { exists: true, newest: 1, truncated: true },
      });
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].kind, 'unverified');
      assert.match(formatViolations(violations), /UNVERIFIED \(scan bound hit/);
      assert.ok(entries > 0);
    } finally {
      cleanup(dir);
    }
  });

  test('a modified path outranks unverified (a real leak is never downgraded)', () => {
    const p = '/live/.claude/gsd-core';
    const violations = diffLiveConfig(
      { [p]: { exists: true, newest: 1, truncated: true } },
      { [p]: { exists: true, newest: 2, truncated: true } },
    );
    assert.strictEqual(violations[0].kind, 'modified');
  });

  test('property: truncation is monotone in the budget (boundary containment)', () => {
    const [dir, entries] = treeWithEntries(12);
    try {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: entries * 3 }), (budget) => {
          const { truncated } = newestMtime(dir, { remaining: budget });
          // The invariant: a budget at or above the tree size never truncates,
          // and one below it always does. A regression flipping `truncated` to
          // false on an exhausted budget — the exact silent-clean failure the
          // module warns about — breaks this for every budget < entries.
          return budget >= entries ? truncated === false : truncated === true;
        }),
        { numRuns: 100 },
      );
    } finally {
      cleanup(dir);
    }
  });

  test('property: newest mtime never exceeds the true maximum', () => {
    const [dir, entries] = treeWithEntries(8);
    try {
      const trueMax = Math.max(
        ...fs.readdirSync(dir).map((f) => fs.lstatSync(path.join(dir, f)).mtimeMs),
        fs.lstatSync(dir).mtimeMs,
      );
      fc.assert(
        fc.property(fc.integer({ min: 1, max: entries * 2 }), (budget) => {
          const { newest } = newestMtime(dir, { remaining: budget });
          return newest <= trueMax;
        }),
        { numRuns: 50 },
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('#2665 round 4: CI wires the guard to strict mode', () => {
  // The reversion this guards: dropping GSD_STRICT_LIVE_CONFIG_GUARD from
  // test.yml silently demotes the guard back to report-only, and a future
  // leak of exactly the class #2665 closes prints a warning and CI stays
  // green. Windows lanes are deliberately report-only until the documented
  // pre-existing USERPROFILE leak class is swept (SEVERITY note in
  // scripts/live-config-guard.cjs) — so the assertion is per-OS, not global.
  test('both guard env vars are documented for humans, not just in the source', () => {
    // A skip-switch on a safety guard has to be discoverable: an undocumented
    // bypass is one people eventually set without knowing what they turned off.
    // The Docs Required gate gets satisfied by ANY docs/ file in the diff --
    // including a generated index -- so it cannot stand in for this.
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'TESTING-SUITES.md'), 'utf8');
    for (const v of ['GSD_STRICT_LIVE_CONFIG_GUARD', 'GSD_SKIP_LIVE_CONFIG_GUARD']) {
      assert.ok(doc.includes(v), `${v} must be documented in docs/TESTING-SUITES.md`);
    }
  });

  // DERIVED, not hand-listed. The previous version named three jobs as literals,
  // so it could not see a FOURTH lane that runs the suite — and there was one:
  // qa-loop-walk reaches run-tests.cjs through `npm run test:qa` and escaped
  // strict mode entirely while this test stayed green. A hand-list that certifies
  // its own completeness is the exact defect this PR exists to fix, reproduced in
  // the test that guards the fix.
  test('EVERY job that runs the suite wires GSD_STRICT_LIVE_CONFIG_GUARD', () => {
    const yaml = require('js-yaml');
    const root = path.join(__dirname, '..');
    const wf = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    // A step reaches the runner directly OR through an npm script, transitively.
    // Grepping the filename alone misses the indirection that hid qa-loop-walk.
    const scriptRunsSuite = (name, seen = new Set()) => {
      if (seen.has(name)) return false;
      seen.add(name);
      const body = pkg.scripts?.[name];
      if (!body) return false;
      if (/run-tests\.cjs/.test(body)) return true;
      return [...body.matchAll(/npm run ([\w:.-]+)/g)].some((m) => scriptRunsSuite(m[1], seen));
    };
    const runsSuite = (run) =>
      /run-tests\.cjs/.test(run)
      || [...run.matchAll(/npm run ([\w:.-]+)/g)].some((m) => scriptRunsSuite(m[1]));

    const suiteJobs = Object.entries(wf.jobs ?? {})
      .filter(([, job]) => (job?.steps ?? []).some((s) => typeof s?.run === 'string' && runsSuite(s.run)))
      .map(([name]) => name)
      .sort();

    // Guards the guard: an empty derivation would make every assertion below
    // vacuously true, which is the failure mode of the literal list it replaces.
    assert.ok(
      suiteJobs.length >= 4,
      `expected at least 4 suite-running jobs, derived ${JSON.stringify(suiteJobs)}`,
    );

    const windowsMatrix = (job) => JSON.stringify(job?.strategy?.matrix ?? {}).includes('windows');
    const problems = [];
    for (const name of suiteJobs) {
      const job = wf.jobs[name];
      const v = String(job?.env?.GSD_STRICT_LIVE_CONFIG_GUARD ?? '');
      // Windows lanes stay report-only until the pre-existing USERPROFILE leak
      // class is swept (SEVERITY note in scripts/live-config-guard.cjs), so a
      // job whose matrix includes Windows carries the conditional; an
      // ubuntu/macOS-only lane must be strict outright.
      const ok = windowsMatrix(job)
        // The WHOLE expression, anchored — a prefix match accepted both
        // `&& '1' || '1'` (Windows silently strict) and a malformed tail.
        ? /^\$\{\{\s*matrix\.os\s*!=\s*'windows-latest'\s*&&\s*'1'\s*\|\|\s*''\s*\}\}$/.test(v)
        : v === '1';
      if (!ok) problems.push(`jobs.${name}: ${JSON.stringify(v)}`);
    }
    assert.deepStrictEqual(
      problems,
      [],
      `every job running run-tests.cjs must wire the guard to strict mode `
        + `(Windows matrices carved out). Derived jobs: ${JSON.stringify(suiteJobs)}`,
    );
  });
});
