'use strict';

/**
 * tests/shadow-report.test.cjs — pure IR unit suite for
 * `install-shadow-report.cts`'s `buildShadowReport` (#2873, epic #2866 Phase
 * 4a — governed by `.gsd/phase/feat-2873-cross-scope-shadowing/40-design.md`).
 *
 * Implements matrix section A (`buildShadowReport()`, rows A1-A24) and
 * properties F1/F4 from `.gsd/phase/feat-2873-cross-scope-shadowing/50-test-matrix.md`.
 * The matrix's own "Suites" section names this file `install-shadow-report
 * .test.cjs`; it is shipped as `shadow-report.test.cjs` instead so its
 * `lint-test-file-count.cjs` prefix is `shadow` (0 files before this PR, at
 * the 2-file cap after it) rather than colliding with the already
 * grandfathered, already-at-cap `install` prefix bucket.
 *
 * A21-A24 cover the per-scope truth filter (#2873 Task 1): a `full`-profile
 * global install alongside a `core`-profile local install must never report
 * the profile-only stems as shadowed local artifacts that do not exist on
 * disk. F1 is updated in lockstep — its expected shadowed set is now the
 * INTERSECTION of the two scopes' stems, not their union.
 *
 * F4 ("4b transform is idempotent over arbitrary bodies") targets
 * `resolveSpecRootReference` (`runtime-artifact-conversion.cts`, #2873 Phase
 * 4b), which has since landed — see the "F4" describe block below.
 *
 * Fixture strategy mirrors `tests/installed-surface-resolver.test.cjs`
 * (`buildShadowReport` forwards its `opts` verbatim to
 * `resolveInstalledSurfaces`): an injectable `readManifest` keyed by the
 * REAL `configHome` `resolveScope` computes for a given runtime/scope, never
 * a hand-typed path literal.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  buildShadowReport,
  renderShadowReport,
  sanitizeForRender,
  SHADOW_REASON,
} = require('../gsd-core/bin/lib/install-shadow-report.cjs');
const { resolveScope } = require('../gsd-core/bin/lib/install-scope.cjs');
const { MANIFEST_NAME } = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { resolveSpecRootReference } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

// ─── Fixture helpers (mirrors tests/installed-surface-resolver.test.cjs) ───

const ABSENT_MANIFEST = Object.freeze({ manifestVersion: null, runtime: null, scope: null, files: {} });

function manifest({ manifestVersion = null, runtime = null, scope = null, files = {} } = {}) {
  return { manifestVersion, runtime, scope, files };
}

function mkReadManifest(byConfigHome) {
  return (configDir) => byConfigHome.get(configDir) ?? ABSENT_MANIFEST;
}

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

/** `commands/gsd/*.md` stems shipped by the real repo — used so A1's "71
 *  entries" tracks the real roster instead of a hardcoded, driftable count. */
const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const REAL_STEMS = fs.readdirSync(REAL_COMMANDS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort();

function skillFilesFor(stems) {
  const files = {};
  for (const s of stems) files[`skills/gsd-${s}/SKILL.md`] = 'x';
  return files;
}

function commandFilesFor(stems) {
  const files = {};
  for (const s of stems) files[`commands/gsd-${s}.md`] = 'x';
  return files;
}

/** Build a claude coexistence fixture: `stems` installed as global skills AND
 *  local commands (so every one of them is a shadowed trigger). */
function coexistenceOpts(home, cwd, stems, overrides = {}) {
  const homes = scopeHomes('claude', home, cwd);
  const byConfigHome = new Map([
    [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(stems) })],
    [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(stems) })],
  ]);
  return baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome), ...overrides });
}

// ─── A1-A6 — shape happy/negative paths ────────────────────────────────────

describe('buildShadowReport — shape (A1-A6)', () => {
  test('reports shadowing for a claude coexistence, full real roster (A1)', () => {
    const home = '/fixture/a1-home';
    const cwd = '/fixture/a1-cwd';
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, REAL_STEMS));
    assert.strictEqual(report.shadowed, true);
    assert.strictEqual(report.reason, SHADOW_REASON.SCOPE_SHADOWED);
    assert.strictEqual(report.triggers.length, REAL_STEMS.length);
    assert.deepStrictEqual(report.winner, { kind: 'skills', scope: 'global' });
    assert.deepStrictEqual(report.shadowedSide, { kind: 'commands', scope: 'local' });
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger).sort(), REAL_STEMS.map((s) => `gsd-${s}`));
  });

  test('no report for a single scope, global only (A2)', () => {
    const home = '/fixture/a2-home';
    const cwd = '/fixture/a2-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.strictEqual(report.reason, SHADOW_REASON.NOT_SHADOWED);
    assert.deepStrictEqual(report.triggers, []);
  });

  test('no report for local-only (A3)', () => {
    const home = '/fixture/a3-home';
    const cwd = '/fixture/a3-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
  });

  test('same-kind shadowing is reported as override, not a vanished tree (A4)', () => {
    const home = '/fixture/a4-home';
    const cwd = '/fixture/a4-cwd';
    const homes = scopeHomes('cursor', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'local', files: skillFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('cursor', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, true);
    assert.strictEqual(report.kindsDiffer, false);
    assert.deepStrictEqual(report.winner, { kind: 'skills', scope: 'global' });
    assert.deepStrictEqual(report.shadowedSide, { kind: 'skills', scope: 'local' });
  });

  test('windsurf asymmetry does not collide (A5)', () => {
    const home = '/fixture/a5-home';
    const cwd = '/fixture/a5-cwd';
    const homes = scopeHomes('windsurf', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'windsurf', scope: 'global', files: { 'agents/gsd-planner.md': 'a' } })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'windsurf', scope: 'local', files: { 'workflows/gsd-plan-phase.md': 'a' } })],
    ]);
    const report = buildShadowReport('windsurf', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
  });

  test('same config home is not self-shadowing (A6)', () => {
    const shared = '/fixture/a6-shared-home';
    const homes = scopeHomes('claude', shared, shared);
    assert.strictEqual(homes.global, homes.local, 'fixture assumption: both scopes collapse to one configHome');
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(shared, shared, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
  });
});

// ─── A7-A10 — SAMPLE_LIMIT boundary (limit-1, limit, limit+1) ──────────────

describe('buildShadowReport — sample-limit boundary (A7-A10)', () => {
  test('zero triggers renders nothing (A7, limit-1 in the sense of "below any sample")', () => {
    const home = '/fixture/a7-home';
    const cwd = '/fixture/a7-cwd';
    const homes = scopeHomes('claude', home, cwd);
    // Both scopes installed (manifestVersion set) but with an empty `files`
    // map each — `deriveStemsFromManifest` short-circuits to `[]` for an
    // empty `files` BEFORE resolving a layout at all (installed-surface-
    // resolver.cts's C13), so the stem union across both scopes is empty and
    // no trigger is ever synthesized. NOT a disjoint-stems fixture: because
    // `resolveInstalledSurfaces` unions stems across every INSTALLED scope
    // (not per-scope), two scopes installed with genuinely DIFFERENT,
    // non-empty stem sets still produce a shadowed entry for each stem in
    // the union — see A12's comment for the same mechanism.
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: {} })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: {} })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
    assert.deepStrictEqual(renderShadowReport(report), []);
  });

  test('single trigger has no overflow tail (A8, limit=1)', () => {
    const home = '/fixture/a8-home';
    const cwd = '/fixture/a8-cwd';
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, ['solo']));
    assert.strictEqual(report.triggers.length, 1);
    const lines = renderShadowReport(report);
    // header + exactly one sample line, no "...and N more" tail, no mismatch notes.
    assert.strictEqual(lines.length, 2);
  });

  test('sample limit exactly, 5 shadowed (A9)', () => {
    const home = '/fixture/a9-home';
    const cwd = '/fixture/a9-cwd';
    const stems = ['s1', 's2', 's3', 's4', 's5'];
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, stems));
    assert.strictEqual(report.triggers.length, 5);
    const lines = renderShadowReport(report);
    // header + 5 samples, still no tail.
    assert.strictEqual(lines.length, 6);
  });

  test('sample limit plus one, 6 shadowed (A10)', () => {
    const home = '/fixture/a10-home';
    const cwd = '/fixture/a10-cwd';
    const stems = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, stems));
    assert.strictEqual(report.triggers.length, 6);
    const lines = renderShadowReport(report);
    // header + 5 samples + one overflow-tail line.
    assert.strictEqual(lines.length, 7);
  });
});

// ─── A11-A13 — manifest content edge cases ─────────────────────────────────

describe('buildShadowReport — manifest content edge cases (A11-A13)', () => {
  test('v1 manifest still reports shadowing, identical to v2, no reinstall signal in the IR (A11)', () => {
    const home = '/fixture/a11-home';
    const cwd = '/fixture/a11-cwd';
    const homesV1 = scopeHomes('claude', home, cwd);
    const byConfigHomeV1 = new Map([
      [homesV1.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      // v1: no manifestVersion key at all, normalized to 1; no declared runtime/scope.
      [homesV1.local, manifest({ manifestVersion: 1, runtime: null, scope: null, files: commandFilesFor(['plan-phase']) })],
    ]);
    const reportV1 = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHomeV1) }));

    const byConfigHomeV2 = new Map([
      [homesV1.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      [homesV1.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const reportV2 = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHomeV2) }));

    assert.strictEqual(reportV1.shadowed, true);
    assert.deepStrictEqual(reportV1, reportV2, 'a v1-backed report must be structurally identical to its v2 counterpart');

    // No reinstall/version signal anywhere in the IR's shape.
    assert.ok(!('manifestVersion' in reportV1));
    for (const trig of reportV1.triggers) assert.ok(!('manifestVersion' in trig));
    for (const m of reportV1.mismatches) assert.ok(!('manifestVersion' in m));
  });

  test('empty manifest yields no triggers (A12)', () => {
    const home = '/fixture/a12-home';
    const cwd = '/fixture/a12-cwd';
    const homes = scopeHomes('claude', home, cwd);
    // Deliberately only ONE scope present, with an empty `files` map — the
    // clean exercise of the empty-files short-circuit (deriveStemsFromManifest's
    // C13) in isolation. A COEXISTENCE fixture (both scopes installed, one
    // side's `files: {}`) does NOT stay `shadowed: false`: because
    // `resolveInstalledSurfaces` unions stems across every scope it counts as
    // installed (manifestVersion set, regardless of that scope's own file
    // count) rather than per-scope, a real stem contributed by the OTHER,
    // populated scope still gets a synthesized trigger at this empty one —
    // see `installed-surface-resolver.cts`'s `stemUnion` computation. That is
    // established, already-tested Phase 3 (#2872) behavior (the roster is
    // assumed uniform across installed scopes), not something this row
    // exercises.
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: {} })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
  });

  test('unreadable manifest degrades, never throws (A13)', () => {
    const home = '/fixture/a13-home';
    const cwd = '/fixture/a13-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['plan-phase']) })],
    ]);
    const readManifest = (configDir) => {
      if (configDir === homes.local) throw new Error('EACCES: permission denied');
      return byConfigHome.get(configDir) ?? ABSENT_MANIFEST;
    };
    let report;
    assert.doesNotThrow(() => {
      report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest }));
    });
    assert.strictEqual(report.shadowed, false);
  });
});

// ─── A14-A15 — declared-runtime/scope mismatch surfaced, not corrected ─────

describe('buildShadowReport — mismatches are reported, never corrected (A14-A15)', () => {
  test('declared runtime mismatch is surfaced (A14)', () => {
    const home = '/fixture/a14-home';
    const cwd = '/fixture/a14-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].scope, 'global');
    assert.strictEqual(report.mismatches[0].declaredRuntime, 'cursor');
    assert.strictEqual(report.mismatches[0].declaredRuntimeMatchesProbe, false);
  });

  test('declared scope mismatch is surfaced (A15)', () => {
    const home = '/fixture/a15-home';
    const cwd = '/fixture/a15-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: skillFilesFor(['plan-phase']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].scope, 'global');
    assert.strictEqual(report.mismatches[0].declaredScope, 'local');
    assert.strictEqual(report.mismatches[0].declaredScopeMatchesProbe, false);
  });
});

// ─── A16-A17 — malformed runtime degrades, never propagates ───────────────

describe('buildShadowReport — non-installable / unknown runtime degrades (A16-A17)', () => {
  test('non-installable runtime degrades to no report (A16, vscode)', () => {
    const home = '/fixture/a16-home';
    const cwd = '/fixture/a16-cwd';
    let report;
    assert.doesNotThrow(() => {
      report = buildShadowReport('vscode', baseOpts(home, cwd, { readManifest: mkReadManifest(new Map()) }));
    });
    assert.strictEqual(report.reason, SHADOW_REASON.RESOLVER_UNAVAILABLE);
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(renderShadowReport(report), []);
  });

  test('unknown runtime degrades to no report (A17)', () => {
    const home = '/fixture/a17-home';
    const cwd = '/fixture/a17-cwd';
    let report;
    assert.doesNotThrow(() => {
      report = buildShadowReport('not-a-real-runtime-xyz', baseOpts(home, cwd, { readManifest: mkReadManifest(new Map()) }));
    });
    assert.strictEqual(report.reason, SHADOW_REASON.RESOLVER_UNAVAILABLE);
    assert.strictEqual(report.shadowed, false);
  });
});

// ─── A18 — caller mutation cannot corrupt a later call ─────────────────────

describe('buildShadowReport — independence across calls (A18)', () => {
  test('report is not shared across calls', () => {
    const home = '/fixture/a18-home';
    const cwd = '/fixture/a18-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'cursor', scope: 'global', files: skillFilesFor(['plan-phase']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['plan-phase']) })],
    ]);
    const opts = baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) });

    const first = buildShadowReport('claude', opts);
    const pristine = JSON.parse(JSON.stringify(first));

    first.winner.kind = 'HACKED';
    first.triggers[0].trigger = 'HACKED';
    first.triggers.push({ trigger: 'INJECTED' });
    first.mismatches[0].declaredRuntime = 'HACKED';
    first.mismatches.push({ scope: 'INJECTED' });

    const second = buildShadowReport('claude', opts);
    assert.deepStrictEqual(second, pristine, 'a second call must be unaffected by mutation of the first result');
  });
});

// ─── A19 — the production call shape ───────────────────────────────────────

describe('buildShadowReport — production call shape (A19)', () => {
  test('production call shape resolves, matches the injected-dep rows\' shape', (t) => {
    const home = createTempDir('gsd-shadow-a19-home-');
    const cwd = createTempDir('gsd-shadow-a19-cwd-');
    t.after(() => { cleanup(home); cleanup(cwd); });

    const globalDir = path.join(home, '.claude');
    const localDir = path.join(cwd, '.claude');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, MANIFEST_NAME), JSON.stringify({
      manifestVersion: 2, runtime: 'claude', scope: 'global',
      files: skillFilesFor(['plan-phase']),
    }));
    fs.writeFileSync(path.join(localDir, MANIFEST_NAME), JSON.stringify({
      manifestVersion: 2, runtime: 'claude', scope: 'local',
      files: commandFilesFor(['plan-phase']),
    }));

    let report;
    assert.doesNotThrow(() => {
      // The exact production call shape: no injected registry, no injected
      // readManifest — real fs, real capability registry.
      report = buildShadowReport('claude', { home, cwd });
    });
    assert.strictEqual(report.shadowed, true);
    assert.deepStrictEqual(report.winner, { kind: 'skills', scope: 'global' });
    assert.deepStrictEqual(report.shadowedSide, { kind: 'commands', scope: 'local' });
    assert.strictEqual(report.triggers.length, 1);
    assert.deepStrictEqual(
      Object.keys(report).sort(),
      ['kindsDiffer', 'mismatches', 'reason', 'runtime', 'shadowed', 'shadowedSide', 'triggers', 'winner'],
    );
  });
});

// ─── A20 — frozen reason-code enum key set is locked ───────────────────────

describe('SHADOW_REASON (A20)', () => {
  test('reason enum key set is locked', () => {
    assert.deepStrictEqual(
      Object.keys(SHADOW_REASON).sort(),
      ['NOT_SHADOWED', 'RESOLVER_UNAVAILABLE', 'SCOPE_SHADOWED'],
    );
  });

  test('is frozen', () => {
    assert.strictEqual(Object.isFrozen(SHADOW_REASON), true);
  });
});

// ─── A21-A24 — per-scope truth filter (cross-scope stem-union false positive) ─

describe('buildShadowReport — per-scope truth filter (A21-A24)', () => {
  test('both scopes carry the same stems: every shadowed trigger reported (A21)', () => {
    const home = '/fixture/a21-home';
    const cwd = '/fixture/a21-cwd';
    const stems = ['plan-phase', 'milestone-complete', 'phase-create'];
    const report = buildShadowReport('claude', coexistenceOpts(home, cwd, stems));
    assert.strictEqual(report.shadowed, true);
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger).sort(), stems.map((s) => `gsd-${s}`).sort());
  });

  test('global strict superset of local (full vs core profile): only the intersection is reported (A22)', () => {
    const home = '/fixture/a22-home';
    const cwd = '/fixture/a22-cwd';
    const homes = scopeHomes('claude', home, cwd);
    // global = 'full' profile (a, b, c) — local = 'core' profile (a only).
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['a', 'b', 'c']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['a']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, true);
    // Only 'a' is a REAL local artifact — 'b' and 'c' must never be reported
    // as shadowed local commands; there is no local artifact for either.
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger), ['gsd-a']);
  });

  test('local has a stem global does not: not reported as shadowed (A23)', () => {
    const home = '/fixture/a23-home';
    const cwd = '/fixture/a23-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['a']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['a', 'z']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, true);
    // 'z' exists ONLY at local (no global artifact "wins" it) — must not
    // appear in the shadowed set at all.
    assert.deepStrictEqual(report.triggers.map((t) => t.trigger), ['gsd-a']);
  });

  test('disjoint stem sets: shadowed is false (A24)', () => {
    const home = '/fixture/a24-home';
    const cwd = '/fixture/a24-cwd';
    const homes = scopeHomes('claude', home, cwd);
    const byConfigHome = new Map([
      [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(['a', 'b']) })],
      [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(['x', 'y']) })],
    ]);
    const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));
    assert.strictEqual(report.shadowed, false);
    assert.deepStrictEqual(report.triggers, []);
  });
});

// ─── F1 — bijective property: every trigger has exactly one winner ────────

describe('buildShadowReport — property (F1)', () => {
  test('every trigger has exactly one winner', () => {
    const stemArb = fc.stringMatching(/^[a-z0-9]{1,6}(-[a-z0-9]{1,6}){0,2}$/);
    const setArb = fc.uniqueArray(stemArb, { maxLength: 6 });

    fc.assert(
      fc.property(setArb, setArb, (globalStems, localStems) => {
        const home = '/fixture/f1-home';
        const cwd = '/fixture/f1-cwd';
        const homes = scopeHomes('claude', home, cwd);
        const byConfigHome = new Map([
          [homes.global, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'global', files: skillFilesFor(globalStems) })],
          [homes.local, manifest({ manifestVersion: 2, runtime: 'claude', scope: 'local', files: commandFilesFor(localStems) })],
        ]);
        const report = buildShadowReport('claude', baseOpts(home, cwd, { readManifest: mkReadManifest(byConfigHome) }));

        // Both scopes are always "installed" here (manifestVersion set
        // regardless of file-list length), so `resolveOneRuntime`'s
        // `stemUnion` still synthesizes a candidate trigger for every stem
        // observed at EITHER scope. `buildShadowReport`'s per-scope truth
        // filter (#2873 Task 1 — see install-shadow-report.cts's module
        // comment) then narrows that down to the INTERSECTION: a trigger is
        // only reported when a real artifact exists at BOTH scopes.
        const expectedShadowed = globalStems
          .filter((s) => localStems.includes(s))
          .map((s) => `gsd-${s}`)
          .sort();
        const actualShadowed = report.triggers.map((t) => t.trigger).sort();
        assert.deepStrictEqual(actualShadowed, expectedShadowed);

        // Bijection: each shadowed trigger names exactly one winner (kind,scope).
        for (const trig of report.triggers) {
          assert.strictEqual(trig.winnerKind, 'skills');
          assert.strictEqual(trig.winnerScope, 'global');
          assert.strictEqual(trig.shadowedKind, 'commands');
          assert.strictEqual(trig.shadowedScope, 'local');
        }
        // No trigger name appears twice in the shadowed set.
        assert.strictEqual(new Set(actualShadowed).size, actualShadowed.length);
      }),
      // Explicit seed + bounded numRuns (CONTRIBUTING: unseeded property
      // tests are a review blocker). On failure, fast-check's thrown error
      // carries the pinned seed and the shrunk counterexample needed to
      // replay deterministically.
      { seed: 20260814, numRuns: 50 },
    );
  });
});

// ─── F2/F3 — sanitizeForRender properties (idempotence, stripped-class-free) ─

describe('sanitizeForRender — properties (F2, F3)', () => {
  // Explicit seed + bounded numRuns (CONTRIBUTING: unseeded property tests
  // are a review blocker), matching F1/F4's seed above.
  const SEED = 20260814;
  const NUM_RUNS = 300;

  // Hostile-input generator: ANSI CSI/OSC escape sequences, C0 controls
  // (including bare \x00 and a lone unterminated \x1b), DEL/C1, Unicode bidi
  // embedding/override + isolate controls, combining marks ("zalgo",
  // U+0300-U+036F), zero-width characters (ZWSP/ZWNJ/ZWJ/BOM), astral-plane
  // characters (surrogate-pair-backed — real emoji/supplementary-plane text,
  // not just printable ASCII), CRLF/LF/CR newlines, and plain text —
  // interleaved so a single generated string usually mixes several hostile
  // classes at once, per the brief's "not just printable ASCII, or the
  // properties are vacuous" requirement.
  //
  // #2873 PR review Finding 2 (MINOR): `sanitizeForRender` originally
  // stripped ANSI/control/bidi only, missing combining marks and zero-width
  // characters — neither is a JS `\s`, so both survived the 64-char cap and
  // the whitespace-collapse step undetected. `combiningArb`/`zeroWidthArb`
  // and the extended `STRIPPED_CLASS_RE` below close that generator gap.
  const c0ControlArb = fc.integer({ min: 0x00, max: 0x1f }).map((c) => String.fromCharCode(c));
  const delC1Arb = fc.integer({ min: 0x7f, max: 0x9f }).map((c) => String.fromCharCode(c));
  const ansiCsiArb = fc.constantFrom('\x1b[31m', '\x1b[0m', '\x1b[2K', '\x1b[1;37;40m');
  const ansiOscArb = fc.constantFrom('\x1b]0;title\x07', '\x1b]8;;http://example\x1b\\');
  // Bidi embedding/override controls (U+202A-U+202E) and isolates
  // (U+2066-U+2069), written as `\u{...}` escapes rather than literal
  // characters — see the #2873 PR review Finding 2 note above.
  const BIDI_LRE = '\u{202A}'; // Left-to-Right Embedding
  const BIDI_RLE = '\u{202B}'; // Right-to-Left Embedding
  const BIDI_PDF = '\u{202C}'; // Pop Directional Formatting
  const BIDI_LRO = '\u{202D}'; // Left-to-Right Override
  const BIDI_RLO = '\u{202E}'; // Right-to-Left Override
  const BIDI_LRI = '\u{2066}'; // Left-to-Right Isolate
  const BIDI_RLI = '\u{2067}'; // Right-to-Left Isolate
  const BIDI_FSI = '\u{2068}'; // First Strong Isolate
  const BIDI_PDI = '\u{2069}'; // Pop Directional Isolate
  const bidiArb = fc.constantFrom(
    BIDI_LRE, BIDI_RLE, BIDI_PDF, BIDI_LRO, BIDI_RLO, // embedding/override
    BIDI_LRI, BIDI_RLI, BIDI_FSI, BIDI_PDI,            // isolates
  );
  const combiningArb = fc.constantFrom('\u{0300}', '\u{0301}', '\u{0302}', '\u{036F}');
  const zeroWidthArb = fc.constantFrom('\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}');
  const astralArb = fc.constantFrom('\u{1F600}', '\u{1F4A9}', '\u{10000}', '\u{1F469}\u{200D}\u{1F4BB}');
  const newlineArb = fc.constantFrom('\n', '\r\n', '\r');
  const plainArb = fc.string({ maxLength: 12 });

  const hostileChunkArb = fc.oneof(
    c0ControlArb, delC1Arb, ansiCsiArb, ansiOscArb, bidiArb, combiningArb, zeroWidthArb, astralArb, newlineArb, plainArb,
  );
  const hostileStringArb = fc.array(hostileChunkArb, { maxLength: 10 }).map((parts) => parts.join(''));

  // The stripped classes sanitizeForRender documents (ANSI escapes, C0
  // controls + DEL/C1, Unicode bidi override/isolate, combining marks,
  // zero-width characters), checked with an INDEPENDENT regex here rather
  // than re-requiring the module's private ANSI_RE/CONTROL_RE/BIDI_RE/
  // COMBINING_MARK_RE/ZERO_WIDTH_RE — so F3 is a real invariant check
  // against the module's documented contract, not a tautology against its
  // own internals.
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  const STRIPPED_CLASS_RE = /[\x00-\x1f\x7f-\x9f\u{202A}-\u{202E}\u{2066}-\u{2069}\u{0300}-\u{036F}\u{200B}-\u{200D}\u{FEFF}]/u;

  test('sanitizer is idempotent: s(s(x)) === s(x) for arbitrary strings (F2)', () => {
    let changedCount = 0;
    fc.assert(
      fc.property(hostileStringArb, (input) => {
        const once = sanitizeForRender(input);
        if (once !== input) changedCount += 1;
        const twice = sanitizeForRender(once);
        assert.strictEqual(
          twice,
          once,
          `not idempotent — input: ${JSON.stringify(input)}\nonce: ${JSON.stringify(once)}\ntwice: ${JSON.stringify(twice)}`,
        );
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
    // Non-vacuity (mirrors F4's real-shape-generator rationale above): prove
    // the generator actually produced input sanitizeForRender changed at
    // least once, or this property would pass trivially over inert strings.
    assert.ok(changedCount > 0, 'generator never produced a string sanitizeForRender actually changed — F2 would be vacuous');
  });

  test('sanitizer output never contains a stripped-class character, for arbitrary input (F3)', () => {
    let hostileInputCount = 0;
    fc.assert(
      fc.property(hostileStringArb, (input) => {
        if (STRIPPED_CLASS_RE.test(input)) hostileInputCount += 1;
        const output = sanitizeForRender(input);
        assert.ok(
          output === null || !STRIPPED_CLASS_RE.test(output),
          `stripped-class character survived sanitization — input: ${JSON.stringify(input)}\noutput: ${JSON.stringify(output)}`,
        );
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
    // Non-vacuity: prove the generator actually exercised at least one
    // stripped-class character, or F3 would hold trivially over clean input.
    assert.ok(hostileInputCount > 0, 'generator never produced a stripped-class character — F3 would be vacuous');
  });
});

// ─── E1-E12 — resolveSpecRootReference direct unit coverage ───────────────
// Matrix section E (`.gsd/phase/feat-2873-cross-scope-shadowing/50-test-matrix.md`).
// Only the E13/E14 installed-output integration pair (in
// tests/install-runtime-artifacts.test.cjs) and F4's idempotence property
// (above) touched this exported function before this block — these rows
// exercise it DIRECTLY, one behavior at a time.
describe('resolveSpecRootReference — direct unit coverage (E1-E12)', () => {
  test('global skill body: the include is replaced by the two-step imperative form naming both candidates (E1)', () => {
    const body = '@~/.claude/gsd-core/workflows/plan-phase.md';
    const result = resolveSpecRootReference(body);
    assert.notStrictEqual(result, body);
    assert.ok(!result.startsWith('@'), 'the static @-include must be gone');
    assert.ok(
      result.includes('.claude/gsd-core/workflows/plan-phase.md') && result.includes('~/.claude/gsd-core/workflows/plan-phase.md'),
      `expected both the project-local and global candidate paths named in: ${JSON.stringify(result)}`,
    );
  });

  test('local command body: byte-identical to today (E2)', () => {
    // The REAL literal a local claude install emits for this same source
    // line (verified empirically against a real --local install): the
    // installer's path-prefix rewrite resolves the local scope's absolute
    // config dir, never `~`, so this never has the `@~/.claude/` shape
    // WORKFLOW_SPEC_ROOT_INCLUDE_RE requires in the first place — a genuine
    // non-qualifying condition, not a hand-waved one.
    const body = '@/Users/dev/myrepo/.claude/gsd-core/workflows/plan-phase.md';
    assert.strictEqual(resolveSpecRootReference(body), body);
  });

  test('every non-claude runtime, both scopes: byte-identical to today (E3)', () => {
    // Real literal shapes emitted for other runtimes (verified empirically
    // against a real --cursor --global install): no `.claude/` segment at
    // all, so none of them ever match the claude-only spec-root regex.
    const cursorGlobal = '@$HOME/gsd-core/workflows/plan-phase.md';
    const genericLocal = '@./gsd-core/workflows/plan-phase.md';
    assert.strictEqual(resolveSpecRootReference(cursorGlobal), cursorGlobal);
    assert.strictEqual(resolveSpecRootReference(genericLocal), genericLocal);
  });

  test('a references/ include is a different spec root and stays static (E4)', () => {
    const body = '@~/.claude/gsd-core/references/ui-brand.md';
    assert.strictEqual(resolveSpecRootReference(body), body);
  });

  test('an @.planning/… include is untouched (E5)', () => {
    const body = '@.planning/notes.md';
    assert.strictEqual(resolveSpecRootReference(body), body);
  });

  test('an include inside a fenced code block is untouched, byte-identical (E6)', () => {
    const body = ['```', '@~/.claude/gsd-core/workflows/plan-phase.md', '```'].join('\n');
    assert.strictEqual(resolveSpecRootReference(body), body);
  });

  test('an include mentioned in inline backticks is untouched, byte-identical (E7)', () => {
    const body = 'See `@~/.claude/gsd-core/workflows/plan-phase.md` for the spec.';
    assert.strictEqual(resolveSpecRootReference(body), body);
  });

  test('a body with no workflow include is a no-op (E8)', () => {
    const body = 'Just some ordinary command prose with no includes at all.';
    assert.strictEqual(resolveSpecRootReference(body), body);
  });

  test('two independent workflow includes both resolve (E9)', () => {
    const body = [
      '@~/.claude/gsd-core/workflows/plan-phase.md',
      '@~/.claude/gsd-core/workflows/execute-phase.md',
    ].join('\n');
    const result = resolveSpecRootReference(body);
    assert.ok(!result.includes('@~/.claude/gsd-core/workflows/plan-phase.md'));
    assert.ok(!result.includes('@~/.claude/gsd-core/workflows/execute-phase.md'));
    assert.ok(result.includes('.claude/gsd-core/workflows/plan-phase.md'));
    assert.ok(result.includes('.claude/gsd-core/workflows/execute-phase.md'));
  });

  test('prose merely mentioning gsd-core/workflows/x.md is untouched (E10)', () => {
    const body = 'See gsd-core/workflows/plan-phase.md for background on how this works.';
    assert.strictEqual(resolveSpecRootReference(body), body);
  });

  test('a CRLF body emits identically to LF, no orphaned \\r (E11)', () => {
    const bodyLf = '@~/.claude/gsd-core/workflows/plan-phase.md\nSecond line.';
    const bodyCrlf = '@~/.claude/gsd-core/workflows/plan-phase.md\r\nSecond line.';
    const resultLf = resolveSpecRootReference(bodyLf);
    const resultCrlf = resolveSpecRootReference(bodyCrlf);
    assert.strictEqual(resultCrlf, resultLf.replace('\n', '\r\n'));
    // Every `\r` in the result must be immediately followed by `\n` — an
    // orphaned CR (one not paired with the LF that owns it) would mean the
    // transform dropped or duplicated a line-ending byte.
    assert.ok(!/\r(?!\n)/.test(resultCrlf), `orphaned CR found in: ${JSON.stringify(resultCrlf)}`);
  });

  test('applying the transform twice over an installed tree is idempotent (E12)', () => {
    const body = 'intro\n@~/.claude/gsd-core/workflows/plan-phase.md\noutro';
    const once = resolveSpecRootReference(body);
    const twice = resolveSpecRootReference(once);
    assert.strictEqual(twice, once);
  });
});

// ─── E-rows — resolveSpecRootReference fence-detection regressions ────────
// (#2873 PR review Finding 1, MEDIUM): the hand-rolled `FENCE_DELIMITER_RE`
// tracker toggled open/closed on ANY delimiter line regardless of type,
// which is wrong under CommonMark (a closer must share the opener's
// delimiter character and have run length >= the opener's). The fix reuses
// `scanFencedBlocks` (`markdown-sectionizer.cts`). These cases pin the exact
// failure the review constructed plus the sibling CommonMark edge cases
// named in the review (nested fences, an unterminated fence, and a
// longer-run opener closed by a too-short run).
describe('resolveSpecRootReference — unit (fence detection, #2873 review Finding 1)', () => {
  test('mismatched fence types (``` opened, ~~~ inside, ``` closes) leave BOTH includes untouched', () => {
    const body = [
      '```',
      '@~/.claude/gsd-core/workflows/alpha.md',
      '~~~',
      '@~/.claude/gsd-core/workflows/beta.md',
      '```',
    ].join('\n');

    const result = resolveSpecRootReference(body);

    assert.strictEqual(result, body, 'a ``` fence is not closed by a ~~~ line — both includes must stay inside the one open block');
    assert.ok(!result.includes('To load this command'), 'no rewrite marker should appear when both includes are fenced');
  });

  test('nested fences (outer run longer than an inner same-char run) leave the enclosed include untouched', () => {
    const body = [
      '````',
      '```',
      '@~/.claude/gsd-core/workflows/nested.md',
      '```',
      '````',
    ].join('\n');

    const result = resolveSpecRootReference(body);

    assert.strictEqual(result, body, 'the inner 3-backtick lines are content, not closers, for a 4-backtick opener');
  });

  test('an unterminated fence covers to end-of-string, leaving the include untouched', () => {
    const body = [
      '```',
      '@~/.claude/gsd-core/workflows/orphan.md',
    ].join('\n');

    const result = resolveSpecRootReference(body);

    assert.strictEqual(result, body, 'a fence with no closer is still open through EOF');
  });

  test('a fence opened with a longer run (````) is NOT closed by a shorter run (```)', () => {
    const body = [
      '````',
      '@~/.claude/gsd-core/workflows/longshort.md',
      '```',
      '@~/.claude/gsd-core/workflows/other.md',
      '````',
    ].join('\n');

    const result = resolveSpecRootReference(body);

    assert.strictEqual(
      result,
      body,
      'a 3-backtick line cannot close a 4-backtick opener per CommonMark run-length rule — both includes stay inside the one fence',
    );
  });
});

// ─── F4 — resolveSpecRootReference is idempotent over arbitrary bodies ────

describe('resolveSpecRootReference — property (F4)', () => {
  test('spec-root transform is idempotent over arbitrary bodies', () => {
    // A bare fc.string() body would almost never contain the exact
    // `@~/.claude/gsd-core/workflows/<stem>.md` shape `resolveSpecRootReference`
    // matches, making the property vacuous (see this suite's F4 comment and
    // CONTRIBUTING's writer-seeded-vs-document-shaped generator guidance).
    // Instead, bodies are assembled from chunks that actually exercise every
    // branch of the transform: a real include line (rewritten), a fenced
    // block wrapping the SAME include shape (left untouched — Claude Code
    // documents backticks as the way to prevent an `@`-import), a
    // `@.planning/…` include (a different spec root, untouched), plain prose
    // that merely MENTIONS `gsd-core/workflows/<stem>.md` without the
    // line-start `@` (untouched), and arbitrary free text.
    const stemArb = fc.stringMatching(/^[a-z][a-z0-9._-]{0,20}$/);
    const includeLineArb = stemArb.map((s) => `@~/.claude/gsd-core/workflows/${s}.md`);
    const proseMentionArb = stemArb.map((s) => `See gsd-core/workflows/${s}.md for background.`);
    const planningIncludeArb = stemArb.map((s) => `@.planning/${s}.md`);
    const fencedIncludeArb = fc.tuple(fc.constantFrom('```', '~~~'), stemArb).map(
      ([fence, s]) => `${fence}\n@~/.claude/gsd-core/workflows/${s}.md\n${fence}`,
    );
    // #2873 review Finding 1: a same-type-only generator is structurally
    // incapable of producing the mismatched-delimiter defect the review
    // constructed (a ``` fence "closed" by a ~~~ line). Also emit
    // mismatched-type and nested-run shapes so the property actually
    // exercises the CommonMark same-type/same-or-longer-run closing rule,
    // not just the trivial same-fence-twice case.
    const mismatchedFencedIncludeArb = fc.tuple(
      fc.constantFrom(['```', '~~~'], ['~~~', '```']),
      stemArb,
      stemArb,
    ).map(
      ([[openFence, midFence], s1, s2]) =>
        `${openFence}\n@~/.claude/gsd-core/workflows/${s1}.md\n${midFence}\n@~/.claude/gsd-core/workflows/${s2}.md\n${openFence}`,
    );
    const nestedFencedIncludeArb = fc.tuple(fc.constantFrom('```', '~~~'), stemArb).map(
      ([fenceChar, s]) => {
        const inner = fenceChar.repeat(3);
        const outer = fenceChar.repeat(4);
        return `${outer}\n${inner}\n@~/.claude/gsd-core/workflows/${s}.md\n${inner}\n${outer}`;
      },
    );
    const plainTextArb = fc.string({ maxLength: 40 });

    const chunkArb = fc.oneof(
      includeLineArb,
      proseMentionArb,
      planningIncludeArb,
      fencedIncludeArb,
      mismatchedFencedIncludeArb,
      nestedFencedIncludeArb,
      plainTextArb,
    );
    const bodyArb = fc.array(chunkArb, { maxLength: 12 }).map((chunks) => chunks.join('\n'));

    fc.assert(
      fc.property(bodyArb, (body) => {
        const once = resolveSpecRootReference(body);
        const twice = resolveSpecRootReference(once);
        assert.strictEqual(
          twice,
          once,
          `not idempotent — body: ${JSON.stringify(body)}\nonce: ${JSON.stringify(once)}\ntwice: ${JSON.stringify(twice)}`,
        );
      }),
      // Explicit seed + bounded numRuns, replay data printed on failure via
      // the assertion message above (fast-check's own thrown error additionally
      // carries the pinned seed + shrunk counterexample needed to replay).
      { seed: 20260814, numRuns: 300 },
    );
  });
});
