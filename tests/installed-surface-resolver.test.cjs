'use strict';

/**
 * Failing-first suite for `resolveInstalledSurfaces` (#2872 Phase 3).
 *
 * Implements sections 3 ("resolveInstalledSurfaces") and 4 ("stem derivation
 * bijection") of `.gsd/phase/feat-2872-manifest-scope-runtime/50-test-matrix.md`
 * (rows S1-S21, B1-B16). Sections 1, 2 and 5 are owned by sibling suites —
 * `tests/install-manifest-scope-runtime.test.cjs`,
 * `tests/installer-migrations-manifest-schema.test.cjs`,
 * `tests/agent-install-check.test.cjs`.
 *
 * The module under test exposes only ONE runtime value —
 * `resolveInstalledSurfaces` itself (the private stem-derivation helpers are
 * not exported) — so every row, including the bijection rows in section 4,
 * is driven end to end through that single entry point and asserted against
 * the `InstalledScopeRecord.stems` field it returns.
 *
 * ── Why `resolveScope` is never overridden by `opts.registry` ──────────────
 * Per the design doc's "Correction" note (`40-design.md`, bottom): an
 * injected `opts.registry` reaches only the layout lookup
 * (`resolveRuntimeArtifactLayoutFromRegistry`) and `resolveTriggerSurface` —
 * never `resolveScope`, which always consults the REAL
 * `capability-registry.cjs`. So every test below uses a REAL registered
 * runtime id (`claude`, `cursor`, `cline`, `windsurf`) for scope resolution,
 * and reaches for `opts.registry` only when a row needs a layout shape the
 * real registry does not currently ship (namespaced-by-dir commands, B2/B8).
 * C7/C8 (the all-runtimes sweep) are asserted against the real registry only
 * — a fully synthetic registry of invented ids would make `resolveScope`
 * throw for every one of them and the sweep would vacuously return `[]`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const { resolveInstalledSurfaces } = require('../gsd-core/bin/lib/installed-surface-resolver.cjs');
const { resolveScope } = require('../gsd-core/bin/lib/install-scope.cjs');
const capabilityRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { isNamespacedByDir, composeCommandFilename } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

// ─── Fixture helpers ─────────────────────────────────────────────────────

/** The `readInstallManifest` result shape for "nothing here". */
const ABSENT_MANIFEST = Object.freeze({ manifestVersion: null, runtime: null, scope: null, files: {} });

/** Build a normalized manifest-read result (the shape `opts.readManifest`
 *  must already return — no re-normalization happens inside the resolver). */
function manifest({ manifestVersion = null, runtime = null, scope = null, files = {} } = {}) {
  return { manifestVersion, runtime, scope, files };
}

/**
 * Injectable `readManifest` backed by a plain Map keyed on the EXACT
 * `configHome` string `resolveScope` will produce for a given runtime/scope
 * under the same `home`/`cwd`/`env`/`existsSync` passed to
 * `resolveInstalledSurfaces`. Never a hardcoded path literal — keys are
 * always computed via the real `resolveScope` (see `scopeHomes` below), so a
 * platform-specific separator can never leak into a fixture.
 */
function mkReadManifest(byConfigHome) {
  return (configDir) => byConfigHome.get(configDir) ?? ABSENT_MANIFEST;
}

/** The real global/local `configHome` for `runtime` under `home`/`cwd` —
 *  computed via the actual `resolveScope`, never re-derived by hand, so a
 *  fixture can never silently drift from what the module under test will
 *  itself resolve to. */
function scopeHomes(runtime, home, cwd) {
  const base = { runtime, env: {}, home, existsSync: () => false, cwd };
  return {
    global: resolveScope({ ...base, id: 'global' }).configHome,
    local: resolveScope({ ...base, id: 'local' }).configHome,
  };
}

function baseOpts(home, cwd, overrides = {}) {
  return { home, cwd, env: {}, existsSync: () => false, ...overrides };
}

function scopeOf(result, scopeId) {
  return result[0].scopes.find((s) => s.scope === scopeId);
}

describe('resolveInstalledSurfaces — scope presence (S1-S3)', () => {
  test('reports both scopes uninstalled when nothing is present', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(new Map()) }));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].scopes.length, 2);
    for (const record of result[0].scopes) {
      assert.strictEqual(record.installed, false);
      assert.strictEqual(record.manifestVersion, null);
      assert.deepStrictEqual(record.stems, []);
    }
    assert.deepStrictEqual(result[0].triggers, []);
  });

  test('a global-only install shadows nothing', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    const global = scopeOf(result, 'global');
    const local = scopeOf(result, 'local');
    assert.strictEqual(global.installed, true);
    assert.deepStrictEqual(global.stems, ['plan-phase']);
    assert.strictEqual(local.installed, false);
    assert.ok(result[0].triggers.length > 0, 'expected at least one trigger');
    for (const t of result[0].triggers) assert.strictEqual(t.shadowedBy, null);
  });

  test('a local-only install shadows nothing', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: { 'commands/gsd-plan-phase.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    const global = scopeOf(result, 'global');
    const local = scopeOf(result, 'local');
    assert.strictEqual(local.installed, true);
    assert.deepStrictEqual(local.stems, ['plan-phase']);
    assert.strictEqual(global.installed, false);
    assert.ok(result[0].triggers.length > 0, 'expected at least one trigger');
    for (const t of result[0].triggers) assert.strictEqual(t.shadowedBy, null);
  });
});

describe('resolveInstalledSurfaces — shadowing (S4-S7, acceptance criterion S4)', () => {
  test('a claude install at both scopes reports the local command surface as shadowed', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: { 'commands/gsd-plan-phase.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    const triggers = result[0].triggers;
    const localCommands = triggers.filter((t) => t.kind === 'commands' && t.scope === 'local');
    const globalSkills = triggers.filter((t) => t.kind === 'skills' && t.scope === 'global');
    assert.ok(localCommands.length > 0, 'expected at least one local commands trigger');
    assert.ok(globalSkills.length > 0, 'expected at least one global skills trigger');
    for (const t of localCommands) {
      assert.deepStrictEqual(t.shadowedBy, { kind: 'skills', scope: 'global' });
    }
    for (const t of globalSkills) {
      assert.strictEqual(t.shadowedBy, null);
    }
  });

  test('a skills-at-both-scopes runtime reports a same-kind shadow', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('cursor', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'local', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('cursor', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    const group = result[0].triggers.filter((t) => t.trigger === 'gsd-plan-phase' && t.kind === 'skills');
    const winner = group.find((t) => t.scope === 'global');
    const loser = group.find((t) => t.scope === 'local');
    assert.ok(winner);
    assert.ok(loser);
    assert.strictEqual(winner.shadowedBy, null);
    assert.deepStrictEqual(loser.shadowedBy, { kind: 'skills', scope: 'global' });
  });

  test('windsurf does not report a shadow it does not have', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('windsurf', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'windsurf', scope: 'global', files: { 'agents/gsd-planner.md': 'a' } })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'windsurf', scope: 'local', files: { 'workflows/gsd-plan-phase.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('windsurf', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(scopeOf(result, 'global').installed, true);
    assert.strictEqual(scopeOf(result, 'local').installed, true);
    // Global emits agents only — not trigger-bearing — so its stems are empty.
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
    assert.ok(result[0].triggers.length > 0, 'expected at least the local trigger');
    assert.ok(result[0].triggers.every((t) => t.shadowedBy === null), 'windsurf must report no shadow at all');
  });

  test('a runtime with no local emission reports no shadow', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('cline', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cline', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
      // cline's local layout declares no kinds at all — a manifest present
      // there still counts as "installed", but contributes no stems.
      [homes.local, manifest({ manifestVersion: 2, runtime: 'cline', scope: 'local', files: { 'commands/gsd-plan-phase.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('cline', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'local').stems, []);
    assert.ok(result[0].triggers.length > 0);
    assert.ok(result[0].triggers.every((t) => t.shadowedBy === null));
    assert.ok(result[0].triggers.every((t) => t.scope === 'global'));
  });
});

describe('resolveInstalledSurfaces — the all-runtimes sweep (S8-S11)', () => {
  test('sweeps every installable runtime in a stable order, excluding vscode (S8/S9)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const result = resolveInstalledSurfaces(undefined, baseOpts(home, cwd, { readManifest: mkReadManifest(new Map()) }));
    const registeredSorted = Object.keys(capabilityRegistry.runtimes).sort();
    assert.ok(registeredSorted.includes('vscode'), 'fixture assumption: vscode is registered');
    const expected = registeredSorted.filter((id) => id !== 'vscode');
    const actual = result.map((r) => r.runtime);
    assert.ok(expected.length > 0);
    assert.deepStrictEqual(actual, expected, 'the sweep must be sorted and exclude non-installable runtimes');
  });

  test('throws for an explicitly requested non-installable runtime (S10)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    assert.throws(
      () => resolveInstalledSurfaces('vscode', baseOpts(home, cwd, { readManifest: mkReadManifest(new Map()) })),
      (err) => err instanceof TypeError,
    );
  });

  test('throws for an unknown runtime (S11)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    assert.throws(
      () => resolveInstalledSurfaces('not-a-real-runtime-xyz', baseOpts(home, cwd, { readManifest: mkReadManifest(new Map()) })),
      (err) => err instanceof TypeError,
    );
  });
});

describe('resolveInstalledSurfaces — v1/v2 manifest reporting (S12-S14, acceptance criterion S12)', () => {
  test('a v1 manifest is fully functional without reinstall', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 1, runtime: null, scope: null, files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    const global = scopeOf(result, 'global');
    assert.strictEqual(global.installed, true);
    assert.strictEqual(global.manifestVersion, 1);
    assert.strictEqual(global.declaredRuntime, null);
    assert.strictEqual(global.declaredScope, null);
    assert.strictEqual(global.declaredScopeMatchesProbe, null);
    assert.strictEqual(global.declaredRuntimeMatchesProbe, null);
    assert.deepStrictEqual(global.stems, ['plan-phase']);
    assert.ok(result[0].triggers.length > 0, 'triggers must still be resolved for a v1 install');
  });

  test('reports a declared-scope mismatch instead of correcting it', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      // Declares 'local' while probed at 'global' — e.g. a manifest copied
      // between config dirs.
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: {} })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    const global = scopeOf(result, 'global');
    assert.strictEqual(global.scope, 'global', 'the record stays keyed by the PROBED scope');
    assert.strictEqual(global.declaredScope, 'local');
    assert.strictEqual(global.declaredScopeMatchesProbe, false);
  });

  test('reports a declared-runtime mismatch', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'global', files: {} })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    const global = scopeOf(result, 'global');
    assert.strictEqual(global.declaredRuntime, 'cursor');
    assert.strictEqual(global.declaredRuntimeMatchesProbe, false);
  });
});

describe('resolveInstalledSurfaces — negative space (S15, S16, S20, S21)', () => {
  test('one physical install is never reported as shadowing itself (S15)', () => {
    // claude: global name '.claude', local localConfigDir '.claude' — setting
    // cwd === home makes both scopes resolve to the SAME configHome (the
    // "project at $HOME" case the design calls out).
    const shared = '/fixture/shared-home';
    const homes = scopeHomes('claude', shared, shared);
    assert.strictEqual(homes.global, homes.local, 'fixture assumption: both scopes collapse to one configHome');
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(shared, shared, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(scopeOf(result, 'global').installed, true);
    assert.strictEqual(scopeOf(result, 'local').installed, true);
    assert.ok(result[0].triggers.length > 0);
    assert.ok(result[0].triggers.every((t) => t.shadowedBy === null), 'a single physical install must never shadow itself');
  });

  test('an empty manifest is installed with no triggers (S16)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: {} })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    const global = scopeOf(result, 'global');
    assert.strictEqual(global.installed, true);
    assert.deepStrictEqual(global.stems, []);
    assert.deepStrictEqual(result[0].triggers, []);
  });

  test('non-trigger-bearing manifest keys yield no stems (S20)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({
        manifestVersion: 2, runtime: 'claude', scope: 'global',
        files: { 'hooks/foo.json': 'a', 'gsd-core/VERSION': 'b', 'settings.json': 'c' },
      })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });

  test('a gsd-prefixed key outside a declared subpath is not a trigger (S21)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'gsd-something.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });
});

describe('resolveInstalledSurfaces — filesystem failure and the STEP 1 fix (S17)', () => {
  test('an unreadable config home degrades instead of throwing', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, {
      readManifest: () => { throw new Error('EACCES: permission denied'); },
    }));
    assert.strictEqual(result.length, 1);
    for (const record of result[0].scopes) {
      assert.strictEqual(record.installed, false);
      assert.strictEqual(record.manifestVersion, null);
      assert.deepStrictEqual(record.stems, []);
    }
    assert.deepStrictEqual(result[0].triggers, []);
  });

  test('a layout failure yields no stems but never reports the scope uninstalled', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
    ]);
    // A synthetic registry that reproduces the exact TypeError
    // `resolveRuntimeArtifactLayoutFromRegistry` throws for a skills entry
    // with `converter: null` (`dispatchKindEntry`'s `case 'skills'` guard).
    // `resolveTriggerSurface` does not call `dispatchKindEntry` at all, so it
    // is unaffected by this — which is exactly what isolates "stems failed"
    // from "the trigger call failed" in this fixture.
    const realClaude = JSON.parse(JSON.stringify(capabilityRegistry.runtimes.claude));
    realClaude.runtime.artifactLayout.global[0].converter = null;
    const registry = { runtimes: { claude: realClaude } };

    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, {
      readManifest: mkReadManifest(byConfigHome),
      registry,
    }));
    const global = scopeOf(result, 'global');
    assert.strictEqual(global.installed, true, 'a layout failure must not report the scope uninstalled');
    assert.strictEqual(global.manifestVersion, 2);
    assert.deepStrictEqual(global.stems, [], 'stems degrade to empty on a layout-lookup failure');
  });
});

describe('resolveInstalledSurfaces — purity (S18, S19)', () => {
  test('a mutated result cannot corrupt a later call (S18)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: { 'commands/gsd-plan-phase.md': 'a' } })],
    ]);
    const opts = baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) });

    const first = resolveInstalledSurfaces('claude', opts);
    const pristine = JSON.parse(JSON.stringify(first));

    first[0].scopes[0].installed = false;
    first[0].scopes[0].stems.push('HACKED');
    first[0].triggers.push({ trigger: 'INJECTED' });
    first.push({ runtime: 'INJECTED' });

    const second = resolveInstalledSurfaces('claude', opts);
    assert.deepStrictEqual(second, pristine, 'a second call must be unaffected by mutation of the first result');
  });

  test('resolveInstalledSurfaces mutates nothing on disk (S19, acceptance criterion)', (t) => {
    const root = createTempDir('gsd-installed-surface-resolver-');
    t.after(() => cleanup(root));

    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const globalDir = path.join(home, '.claude');
    const localDir = path.join(cwd, '.claude');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });

    const nowIso = new Date().toISOString();
    const globalManifest = {
      version: '1.10.0',
      timestamp: nowIso,
      mode: 'full',
      files: { 'skills/gsd-plan-phase/SKILL.md': 'sha-global' },
      manifestVersion: 2,
      runtime: 'claude',
      scope: 'global',
    };
    const localManifest = {
      version: '1.10.0',
      timestamp: nowIso,
      mode: 'full',
      files: { 'commands/gsd-plan-phase.md': 'sha-local' },
      manifestVersion: 2,
      runtime: 'claude',
      scope: 'local',
    };
    fs.writeFileSync(path.join(globalDir, 'gsd-file-manifest.json'), JSON.stringify(globalManifest, null, 2));
    fs.writeFileSync(path.join(localDir, 'gsd-file-manifest.json'), JSON.stringify(localManifest, null, 2));
    // A stray, unrelated file — proves the resolver doesn't touch anything it
    // doesn't need either.
    fs.writeFileSync(path.join(globalDir, 'settings.json'), '{}');

    function snapshot(dir) {
      const out = [];
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            out.push([full, { dir: true }]);
            walk(full);
          } else if (entry.isFile()) {
            const st = fs.statSync(full);
            out.push([full, { dir: false, size: st.size, mtimeMs: st.mtimeMs }]);
          }
        }
      };
      walk(dir);
      return out;
    }

    const before = snapshot(root);
    const result = resolveInstalledSurfaces('claude', { home, cwd, env: {}, existsSync: fs.existsSync });
    const after = snapshot(root);

    assert.strictEqual(scopeOf(result, 'global').installed, true);
    assert.strictEqual(scopeOf(result, 'local').installed, true);
    assert.deepStrictEqual(after, before, 'the resolver must perform no writes and create no new files/dirs');
    assert.deepStrictEqual(after.map((e) => e[0]), before.map((e) => e[0]), 'no new paths must appear');
  });
});

// ─── Section 4 — stem derivation bijection + hostile-stem rejection (B1-B16) ─
//
// The private derivation helpers (`deriveStemsForKindEntry`,
// `deriveStemsFromManifest`) are not exported — every row here is driven
// through `resolveInstalledSurfaces` and asserted against the returned
// `InstalledScopeRecord.stems` field, exactly as the module's own public
// contract exposes it.

describe('resolveInstalledSurfaces — stem derivation (B1-B15)', () => {
  test('derives a stem from a skills manifest key (B1)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills/gsd-plan-phase/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, ['plan-phase']);
  });

  test('derives a stem from a namespaced-by-dir command key (B2)', () => {
    // No shipped runtime declares a namespaced-by-dir commands layout today
    // (destSubpath's basename === prefix minus its trailing '-') — same gap
    // the sibling resolveTriggerSurface suite documents for its own row 12.
    // `opts.registry` overrides ONLY the layout lookup (never `resolveScope`,
    // per the design's Correction note), so `claude` still resolves via the
    // REAL registry while its layout is read from this synthetic one.
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const registry = {
      runtimes: {
        claude: {
          runtime: {
            artifactLayout: {
              global: [],
              local: [
                { kind: 'commands', destSubpath: 'commands/gsd', prefix: 'gsd-', nesting: 'flat', recursive: false, converter: null },
              ],
            },
          },
        },
      },
    };
    const byConfigHome = new Map([
      [homes.local, manifest({ manifestVersion: 2, files: { 'commands/gsd/plan-phase.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome), registry }));
    assert.deepStrictEqual(scopeOf(result, 'local').stems, ['plan-phase']);
  });

  test('derives a stem from a prefixed command key (B3)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.local, manifest({ manifestVersion: 2, files: { 'commands/gsd-plan-phase.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'local').stems, ['plan-phase']);
  });

  test('multiple files under one skill dir yield one stem (B4)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({
        manifestVersion: 2,
        files: {
          'skills/gsd-plan-phase/SKILL.md': 'a',
          'skills/gsd-plan-phase/reference.md': 'b',
        },
      })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, ['plan-phase']);
  });

  test('normalizes backslash keys unconditionally (B5)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills\\gsd-plan-phase\\SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, ['plan-phase']);
  });

  test('a non-markdown command key yields no stem (B6)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.local, manifest({ manifestVersion: 2, files: { 'commands/gsd-plan-phase': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'local').stems, []);
  });

  test('an empty stem is not emitted (B7)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.local, manifest({ manifestVersion: 2, files: { 'commands/gsd-.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'local').stems, []);
  });

  test('a traversal segment in a skills key is rejected (B9)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills/gsd-../SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });

  test("the reviewer's exact hostile payload yields no stem (B10)", () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills/gsd-../../../x/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });

  test('a stem containing a control character / newline is rejected (B11)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills/gsd-x\ny/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });

  test('a stem containing an ANSI escape sequence is rejected (B12)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills/gsd-x[31my/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });

  test('a stem containing an RTL-override codepoint is rejected (B13)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills/gsd-x‮y/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });

  test('an uppercase stem is rejected (B14)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills/gsd-PlanPhase/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });

  test('a stem starting with a hyphen is rejected (B15)', () => {
    const home = '/fixture/home';
    const cwd = '/fixture/project';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, files: { 'skills/gsd--x/SKILL.md': 'a' } })],
    ]);
    const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
  });
});

describe('resolveInstalledSurfaces — stem derivation is the exact inverse of Phase 2 filename composition (B8, property)', () => {
  // Real stem alphabet: lowercase alnum segments joined by single hyphens
  // (e.g. 'plan-phase', 'x', 'a1-b2-c3'), bounded so generated manifest keys
  // stay realistic in length.
  const stemArb = fc.stringMatching(/^[a-z0-9]{1,8}(-[a-z0-9]{1,8}){0,2}$/);

  const PREFIX = 'gsd-';
  const home = '/fixture/home';
  const cwd = '/fixture/project';
  const homes = scopeHomes('claude', home, cwd);

  // The namespaced-by-dir shape needs a synthetic layout override (no shipped
  // runtime declares one today — see B2 above); built once, outside the
  // property body, since it never varies across runs.
  const namespacedRegistry = {
    runtimes: {
      claude: {
        runtime: {
          artifactLayout: {
            global: [],
            local: [
              { kind: 'commands', destSubpath: 'commands/gsd', prefix: PREFIX, nesting: 'flat', recursive: false, converter: null },
            ],
          },
        },
      },
    },
  };

  test('property: prefixed commands round-trip', () => {
    fc.assert(
      fc.property(stemArb, (stem) => {
        // isNamespacedByDir/composeCommandFilename are the SAME two exports
        // the resolver's own derivation consumes — binding both halves of
        // the bijection genuinely, not by re-deriving either rule here.
        const namespacedByDir = isNamespacedByDir('commands', 'commands', PREFIX);
        assert.strictEqual(namespacedByDir, false, 'fixture assumption: claude local commands is the prefixed shape');
        const filename = composeCommandFilename(namespacedByDir, PREFIX, stem);
        const byConfigHome = new Map([
          [homes.local, manifest({ manifestVersion: 2, files: { [`commands/${filename}`]: 'a' } })],
        ]);
        const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
        assert.deepStrictEqual(scopeOf(result, 'local').stems, [stem]);
      }),
      { numRuns: 50 },
    );
    // On failure, fast-check prints the pinned seed and the exact failing
    // stem (its shrunk counterexample) as part of the thrown AssertionError
    // — sufficient to replay the run deterministically without re-running
    // the whole suite.
  });

  test('property: namespaced-by-dir commands round-trip', () => {
    fc.assert(
      fc.property(stemArb, (stem) => {
        const namespacedByDir = isNamespacedByDir('commands', 'commands/gsd', PREFIX);
        assert.strictEqual(namespacedByDir, true, 'fixture assumption: the synthetic layout is the namespaced-by-dir shape');
        const filename = composeCommandFilename(namespacedByDir, PREFIX, stem);
        const byConfigHome = new Map([
          [homes.local, manifest({ manifestVersion: 2, files: { [`commands/gsd/${filename}`]: 'a' } })],
        ]);
        const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, {
          readManifest: mkReadManifest(byConfigHome),
          registry: namespacedRegistry,
        }));
        assert.deepStrictEqual(scopeOf(result, 'local').stems, [stem]);
      }),
      { numRuns: 50 },
    );
  });

  test('property: skills round-trip', () => {
    fc.assert(
      fc.property(stemArb, (stem) => {
        const byConfigHome = new Map([
          [homes.global, manifest({ manifestVersion: 2, files: { [`skills/${PREFIX}${stem}/SKILL.md`]: 'a' } })],
        ]);
        const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
        assert.deepStrictEqual(scopeOf(result, 'global').stems, [stem]);
      }),
      { numRuns: 50 },
    );
  });

  test('property: any dirSegment suffix that is not a bare kebab-case token yields no stem', () => {
    // Complement of `SAFE_STEM` (`^[a-z0-9][a-z0-9-]*$`) — any non-empty
    // string that does not match it must never survive into `stems`, no
    // matter what a manifest key throws at the derivation (security
    // boundary; see FINDING 1). Bounded and seeded like the round-trip
    // properties above.
    const hostileArb = fc.string({ minLength: 1, maxLength: 12 })
      // Excludes '/' and '\\' — either would split the manifest key into
      // extra path segments and stop `hostile` from landing whole inside
      // `dirSegment`, which is what this property needs to exercise.
      .filter((s) => s.length > 0 && !s.includes('/') && !s.includes('\\') && !/^[a-z0-9][a-z0-9-]*$/.test(s));
    fc.assert(
      fc.property(hostileArb, (hostile) => {
        const byConfigHome = new Map([
          [homes.global, manifest({ manifestVersion: 2, files: { [`skills/${PREFIX}${hostile}/SKILL.md`]: 'a' } })],
        ]);
        const result = resolveInstalledSurfaces('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
        assert.deepStrictEqual(scopeOf(result, 'global').stems, []);
      }),
      { numRuns: 100, seed: 42 },
    );
  });
});
