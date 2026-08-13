'use strict';

/**
 * Tests for `src/planning-snapshot.cts` (Phase 10, #3308, ADR-3180 §8.1).
 *
 * Design:       .gsd/phase/refactor-3308-planning-snapshot-parsed-projection/40-design.md
 * Test matrix:  .gsd/phase/refactor-3308-planning-snapshot-parsed-projection/50-test-matrix.md
 *
 * TDD RED: `src/planning-snapshot.cts` does not exist yet — this file's
 * `require('../gsd-core/bin/lib/planning-snapshot.cjs')` throws
 * MODULE_NOT_FOUND until a companion implementation phase adds it. That is
 * the intended starting state.
 *
 * Fixture provenance (CONTRIBUTING.md / repo rule): every case calls the REAL
 * compiled owners (`getMilestoneInfo`, `listMilestonePhaseDirs`,
 * `isPhaseComplete`, `scanPhasePlans`, `stateFieldValue`, `planningPaths`)
 * against real temp `.planning/` trees — no hand-built in-memory mocks of any
 * owner. Fixture helpers mirror `tests/completion-ratio-scope-withholding.test.cjs`
 * verbatim (`writeRoadmap`/`writeState`/`writeFile`, and the directory-vs-file
 * swap technique for IO-failure rows), and the readdirSync fault-injection
 * helper mirrors `tests/verify.test.cjs`'s `injectMilestonesFault` (`t.mock`,
 * auto-restored — never `chmod 0o000`, which root bypasses in CI/Docker).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');

// `export =` shape TBD by the implementing phase — this module is "the sole
// export consumers reach for" per the design doc, with `worstScope` also
// exported for direct unit testing per this phase's brief. Support either a
// callable-with-properties export (mirrors plan-scan.cjs) or a plain object
// export (mirrors verification.cjs) so this file does not lock in a shape the
// design doc leaves to the implementer.
const planningSnapshotLib = require('../gsd-core/bin/lib/planning-snapshot.cjs');
const buildPlanningSnapshot = planningSnapshotLib.buildPlanningSnapshot ?? planningSnapshotLib;
const { worstScope } = planningSnapshotLib;

const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');
const { _unusableInputEmissionCountForTests } = require('../gsd-core/bin/lib/unusable-input.cjs');

// ─── Fixture helpers (mirrors tests/completion-ratio-scope-withholding.test.cjs) ─

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeState(cwd, fields) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), lines.join('\n'));
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Appends raw text to an already-written STATE.md (writeState above writes
// only the frontmatter block) — used by the currentPhaseLabel rows to add a
// body carrying `## Current Position` / a bare `Phase:` line.
function appendToState(cwd, body) {
  const statePath = path.join(planningDirOf(cwd), 'STATE.md');
  fs.writeFileSync(statePath, fs.readFileSync(statePath, 'utf-8') + body);
}

// Makes a FILE unreadable-as-a-file: a DIRECTORY node where callers expect a
// regular file (ROADMAP.md / STATE.md). `platformReadSync` -> `fs.readFileSync`
// throws EISDIR on it, deterministically and cross-platform — no chmod.
function makeFileUnreadableAsDir(fullPath) {
  fs.mkdirSync(fullPath, { recursive: true });
}

// Makes a DIRECTORY unreadable-as-a-directory: a REGULAR FILE where callers
// expect a directory (a phase's nested `plans/` subdirectory). `readdirSync`
// throws ENOTDIR on it, deterministically and cross-platform — no chmod.
// (This is the inverse of `makePhasesDirUnreadable` in the sibling test file.)
function makeDirUnreadableAsFile(fullPath) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, 'not a directory\n');
}

// A matched plan/summary pair plus a passing `*-VERIFICATION.md` —
// `isPhaseComplete` requires `verification.status === 'passed'` for
// `complete: true`, which plan/summary pairing alone does not establish.
function makeCompletePhaseDir(cwd, relPhaseDir) {
  writeFile(cwd, `${relPhaseDir}/01-01-PLAN.md`, '# Plan\n');
  writeFile(cwd, `${relPhaseDir}/01-01-SUMMARY.md`, '# Summary\n');
  writeFile(cwd, `${relPhaseDir}/01-VERIFICATION.md`, '---\nstatus: passed\n---\n');
}

function buildHealthyTwoPhaseFixture(cwd) {
  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, [
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
  ].join('\n'));
  makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
  makeCompletePhaseDir(cwd, '.planning/phases/02-bar');
}

// ─── fs fault injection (mirrors tests/verify.test.cjs's injectMilestonesFault) ─

function fsError(code, targetPath) {
  const err = new Error(`${code}: operation failed, scandir '${targetPath}'`);
  err.code = code;
  err.syscall = 'scandir';
  err.path = targetPath;
  return err;
}

// Scoped readdirSync fault: throws ONLY for the exact `targetPhaseDir` path.
// Every other path (crucially, the phases/ enumeration read that must still
// list this directory's NAME) passes through to the real implementation.
// `t.mock` auto-restores after the test.
function injectPhaseDirFault(t, targetPhaseDir) {
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', function (p, ...rest) {
    if (p === targetPhaseDir) throw fsError('EACCES', targetPhaseDir);
    return original.call(this, p, ...rest);
  });
}

// Measure NEW unusable-input diagnostics emitted while `fn` runs, with
// stderr stubbed to keep the suite's own output clean (mirrors
// tests/unusable-input.test.cjs's emissionsDuring).
function emissionsDuring(fn) {
  const before = _unusableInputEmissionCountForTests();
  const original = process.stderr.write;
  process.stderr.write = () => true;
  let result;
  try {
    result = fn();
  } finally {
    process.stderr.write = original;
  }
  return [result, _unusableInputEmissionCountForTests() - before];
}

// ═════════════════════════════════════════════════════════════════════════
// Happy path — rows 1-4
// ═════════════════════════════════════════════════════════════════════════

describe('happy path', () => {
  test('builds a fully-COMPLETE snapshot for a healthy two-phase milestone', (t) => {
    const cwd = createTempDir('gsd-3308-h1-');
    t.after(() => cleanup(cwd));
    buildHealthyTwoPhaseFixture(cwd);

    const snap = buildPlanningSnapshot(cwd);

    assert.strictEqual(snap.milestone.scope, SCOPE.COMPLETE);
    assert.strictEqual(snap.phaseDirs.scope, SCOPE.COMPLETE);
    assert.strictEqual(snap.phases.scope, SCOPE.COMPLETE);
    assert.strictEqual(snap.phases.value.length, 2);
    for (const p of snap.phases.value) {
      assert.strictEqual(p.complete, true);
      assert.strictEqual(p.scope, SCOPE.COMPLETE);
      assert.strictEqual(p.verificationStatus, 'passed');
      assert.strictEqual(p.planCount, 1);
      assert.strictEqual(p.summaryCount, 1);
    }
  });

  test('zero phase directories is a COMPLETE empty array, not a non-answer', (t) => {
    const cwd = createTempDir('gsd-3308-h2-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases'), { recursive: true });

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.phaseDirs, { value: [], scope: SCOPE.COMPLETE });
    assert.deepStrictEqual(snap.phases, { value: [], scope: SCOPE.COMPLETE });
  });

  test('single phase directory produces a one-element phases array', (t) => {
    const cwd = createTempDir('gsd-3308-h3-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.phaseDirs.value.length, 1);
    assert.strictEqual(snap.phases.value.length, 1);
    assert.strictEqual(snap.phases.value[0].dir, '01-foo');
  });

  test('three phase directories each carry independent completion', (t) => {
    const cwd = createTempDir('gsd-3308-h4-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, [
      '## v1.0 Current 🚧', '',
      '### Phase 1: Foo', '',
      '### Phase 2: Bar', '',
      '### Phase 3: Baz',
    ].join('\n'));
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo'); // complete
    writeFile(cwd, '.planning/phases/02-bar/02-01-PLAN.md', '# Plan\n'); // no summary/verification
    writeFile(cwd, '.planning/phases/03-baz/03-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/03-baz/03-01-SUMMARY.md', '# Summary\n');
    writeFile(cwd, '.planning/phases/03-baz/03-VERIFICATION.md', '---\nstatus: gaps_found\n---\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.phases.value.length, 3);
    const foo = snap.phases.value.find((p) => p.dir === '01-foo');
    const bar = snap.phases.value.find((p) => p.dir === '02-bar');
    const baz = snap.phases.value.find((p) => p.dir === '03-baz');

    assert.strictEqual(foo.complete, true);
    assert.strictEqual(bar.complete, false);
    assert.strictEqual(bar.verificationStatus, 'missing');
    assert.strictEqual(baz.complete, false);
    assert.strictEqual(baz.verificationStatus, 'gaps_found');
  });

  test('Phase field under Current Position is extracted verbatim as currentPhaseLabel', (t) => {
    const cwd = createTempDir('gsd-3308-h12-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, ['', '## Current Position', '', 'Phase: 3 of 8 (User Auth)', ''].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.currentPhaseLabel, { value: '3 of 8 (User Auth)', scope: SCOPE.COMPLETE });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Negative space — rows 5, 9, 11, 14
// ═════════════════════════════════════════════════════════════════════════

describe('negative space', () => {
  test('absent ROADMAP.md yields a non-COMPLETE milestone but does not crash phase enumeration', (t) => {
    const cwd = createTempDir('gsd-3308-n5-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/02-bar/02-01-PLAN.md', '# Plan\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.notStrictEqual(snap.milestone.scope, SCOPE.COMPLETE);
    assert.strictEqual(snap.milestone.value, null);
    assert.ok(Array.isArray(snap.phaseDirs.value), 'phase enumeration must not throw');
    assert.deepStrictEqual(snap.phaseDirs.value.slice().sort(), ['01-foo', '02-bar']);
  });

  test('absent STATE.md is a non-answer but not an unusable-input diagnostic', (t) => {
    const cwd = createTempDir('gsd-3308-n9-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    // No STATE.md at all.

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.deepStrictEqual(snap.currentPhaseLabel, { value: null, scope: SCOPE.UNREADABLE });
    assert.strictEqual(emitted, 0, 'a project that never ran state.init is not corruption');
  });

  test('missing Current Position section yields TRUNCATED scope with a whole-body fallback value', (t) => {
    const cwd = createTempDir('gsd-3308-n11-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, ['', '## Notes', '', 'Phase: 3 of 8 (User Auth)', ''].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.currentPhaseLabel.scope, SCOPE.TRUNCATED);
    assert.strictEqual(snap.currentPhaseLabel.value, '3 of 8 (User Auth)');
  });

  test('a truncated milestone window still forwards its over-inclusive phase set, not an empty one', (t) => {
    const cwd = createTempDir('gsd-3308-n14-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v2.0' });
    writeRoadmap(cwd, [
      '## v1.0 Planned', '',
      '### Phase 1: Foo', '',
      '## v2.0 Current 🚧',
    ].join('\n'));
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/02-bar/02-01-PLAN.md', '# Plan\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.phaseDirs.scope, SCOPE.TRUNCATED);
    assert.deepStrictEqual(snap.phaseDirs.value.slice().sort(), ['01-foo', '02-bar']);
  });

  test('a legitimately-missing verification file is not conflated with an unreadable phase directory', (t) => {
    const cwd = createTempDir('gsd-3308-ns18-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n'));
    // 01-foo: real, readable directory with no *-VERIFICATION.md at all —
    // a well-formed 'missing' answer, scope COMPLETE.
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
    // 02-bar: real directory on disk, but faulted below — a non-answer,
    // scope UNREADABLE, even though readVerificationStatus's own no-throw
    // fail-open contract still reports 'missing' for the same reason.
    const barDir = path.join(planningDirOf(cwd), 'phases', '02-bar');
    fs.mkdirSync(barDir, { recursive: true });
    injectPhaseDirFault(t, barDir);

    const snap = buildPlanningSnapshot(cwd);
    const foo = snap.phases.value.find((p) => p.dir === '01-foo');
    const bar = snap.phases.value.find((p) => p.dir === '02-bar');

    assert.strictEqual(foo.complete, false);
    assert.strictEqual(foo.verificationStatus, 'missing');
    assert.strictEqual(foo.scope, SCOPE.COMPLETE, 'a genuinely missing verification file is a real answer');

    assert.strictEqual(bar.complete, false);
    assert.strictEqual(bar.verificationStatus, 'missing');
    assert.strictEqual(bar.scope, SCOPE.UNREADABLE, 'an unreadable directory is a non-answer, not a real one');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Hostile input — rows 6, 7, 8, 10, 13
// ═════════════════════════════════════════════════════════════════════════

describe('hostile input', () => {
  test('unreadable ROADMAP.md reports milestone scope UNREADABLE', (t) => {
    const cwd = createTempDir('gsd-3308-h6-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    makeFileUnreadableAsDir(path.join(planningDirOf(cwd), 'ROADMAP.md'));

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.milestone.scope, SCOPE.UNREADABLE);
  });

  test('an unreadable nested plans dir taints the phase record to TRUNCATED via worstScope, not COMPLETE', (t) => {
    const cwd = createTempDir('gsd-3308-h7-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    // Swap the nested plans/ subdirectory for a regular file: readdirSync
    // throws ENOTDIR inside scanPhasePlans, independent of isPhaseComplete's
    // own (unaffected) readdirSync(phaseDir) call on the same phase.
    makeDirUnreadableAsFile(path.join(planningDirOf(cwd), 'phases', '01-foo', 'plans'));

    const snap = buildPlanningSnapshot(cwd);
    const phase = snap.phases.value.find((p) => p.dir === '01-foo');
    assert.ok(phase, 'expected phase 01-foo in the snapshot');
    assert.strictEqual(phase.complete, true, 'isPhaseComplete alone still reads COMPLETE');
    assert.strictEqual(phase.scope, SCOPE.TRUNCATED, 'worstScope must promote the record to TRUNCATED');
  });

  test('an unreadable phase directory reports scope UNREADABLE from both owners combined', (t) => {
    const cwd = createTempDir('gsd-3308-h8-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    const phaseDir = path.join(planningDirOf(cwd), 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    injectPhaseDirFault(t, phaseDir);

    const snap = buildPlanningSnapshot(cwd);
    const phase = snap.phases.value.find((p) => p.dir === '01-foo');
    assert.ok(phase, 'the phase must still be enumerated — listMilestonePhaseDirs reads the phases/ dir, not this one');
    assert.strictEqual(phase.scope, SCOPE.UNREADABLE, 'worst of two independently-UNREADABLE owner calls');
  });

  test('unreadable-but-present STATE.md emits exactly one STATE_UNREADABLE diagnostic', (t) => {
    const cwd = createTempDir('gsd-3308-h10-');
    t.after(() => cleanup(cwd));
    makeFileUnreadableAsDir(path.join(planningDirOf(cwd), 'STATE.md'));

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.deepStrictEqual(snap.currentPhaseLabel, { value: null, scope: SCOPE.UNREADABLE });
    assert.strictEqual(emitted, 1);
  });

  test('unterminated frontmatter does not double-emit and still yields a body-only phase label', (t) => {
    const cwd = createTempDir('gsd-3308-h13-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    // Opens `---` and never closes it. Every non-empty line in the tail is
    // frontmatter-shaped (>= 2 keys), so extractFrontmatter's own
    // FRONTMATTER_UNTERMINATED diagnostic fires exactly once. stripFrontmatter
    // is then a no-op (no closing fence to strip), so `body` is the full raw
    // content — the bare `Phase:` line inside it is still reachable via
    // stateExtractField's plain line-start pattern.
    fs.writeFileSync(
      path.join(planningDirOf(cwd), 'STATE.md'),
      ['---', 'gsd_state_version: 1', 'Phase: 3 of 8 (User Auth)', ''].join('\n'),
    );

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.strictEqual(emitted, 1, 'exactly one diagnostic reaches the operator, from extractFrontmatter itself');
    assert.strictEqual(snap.currentPhaseLabel.value, '3 of 8 (User Auth)');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Independence — rows 15, 16, 17, 19
// ═════════════════════════════════════════════════════════════════════════

describe('independence', () => {
  test('phases-level scope is the worst of every individual PhaseSnapshot scope, not the first or last', (t) => {
    const cwd = createTempDir('gsd-3308-i15-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n'));
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    makeCompletePhaseDir(cwd, '.planning/phases/02-bar');
    makeDirUnreadableAsFile(path.join(planningDirOf(cwd), 'phases', '02-bar', 'plans'));

    const snap = buildPlanningSnapshot(cwd);
    const foo = snap.phases.value.find((p) => p.dir === '01-foo');
    const bar = snap.phases.value.find((p) => p.dir === '02-bar');
    assert.strictEqual(foo.scope, SCOPE.COMPLETE);
    assert.strictEqual(bar.scope, SCOPE.TRUNCATED);
    assert.strictEqual(snap.phases.scope, SCOPE.TRUNCATED, 'array-level scope must be the worst-of, not first/last-wins');
  });

  test('a truncated phase-enumeration window taints phases.scope even when every phase itself reads COMPLETE', (t) => {
    const cwd = createTempDir('gsd-3308-i16-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v2.0' });
    writeRoadmap(cwd, [
      '## v1.0 Planned', '',
      '### Phase 1: Foo', '',
      '## v2.0 Current 🚧',
    ].join('\n'));
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.phaseDirs.scope, SCOPE.TRUNCATED);
    const foo = snap.phases.value.find((p) => p.dir === '01-foo');
    assert.strictEqual(foo.scope, SCOPE.COMPLETE, 'the individual phase read cleanly');
    assert.strictEqual(snap.phases.scope, SCOPE.TRUNCATED, 'the array-level scope must still fold in phaseDirs.scope');
  });

  test('two calls against unchanged disk state produce identical snapshots', (t) => {
    const cwd = createTempDir('gsd-3308-i19-');
    t.after(() => cleanup(cwd));
    buildHealthyTwoPhaseFixture(cwd);

    const first = buildPlanningSnapshot(cwd);
    const second = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(first, second, 'buildPlanningSnapshot must be pure w.r.t. disk state — no hidden mutation/caching');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// worstScope — pure unit coverage, row 17 (independence / boundary)
// ═════════════════════════════════════════════════════════════════════════

describe('worstScope — pure unit coverage', () => {
  const SCOPES = [SCOPE.COMPLETE, SCOPE.TRUNCATED, SCOPE.UNSCOPED, SCOPE.UNREADABLE];

  test('COMPLETE only when every input is COMPLETE', () => {
    assert.strictEqual(worstScope(SCOPE.COMPLETE), SCOPE.COMPLETE);
    assert.strictEqual(worstScope(SCOPE.COMPLETE, SCOPE.COMPLETE), SCOPE.COMPLETE);
    assert.strictEqual(worstScope(SCOPE.COMPLETE, SCOPE.COMPLETE, SCOPE.COMPLETE), SCOPE.COMPLETE);
    for (const bad of [SCOPE.TRUNCATED, SCOPE.UNSCOPED, SCOPE.UNREADABLE]) {
      assert.notStrictEqual(worstScope(SCOPE.COMPLETE, bad), SCOPE.COMPLETE);
      assert.notStrictEqual(worstScope(bad, SCOPE.COMPLETE), SCOPE.COMPLETE);
    }
  });

  test('UNREADABLE wins over every other combination', () => {
    for (const other of SCOPES) {
      assert.strictEqual(worstScope(SCOPE.UNREADABLE, other), SCOPE.UNREADABLE);
      assert.strictEqual(worstScope(other, SCOPE.UNREADABLE), SCOPE.UNREADABLE);
    }
    assert.strictEqual(worstScope(SCOPE.COMPLETE, SCOPE.TRUNCATED, SCOPE.UNSCOPED, SCOPE.UNREADABLE), SCOPE.UNREADABLE);
  });

  test('worstScope picks the most severe of any scope combination, order-independent', () => {
    // Seeded explicitly (no unseeded fc.assert — the Wave-3 defect this
    // directive's own text names, PR #3335).
    fc.assert(
      fc.property(fc.constantFrom(...SCOPES), fc.constantFrom(...SCOPES), (a, b) => {
        assert.strictEqual(worstScope(a, b), worstScope(b, a));
      }),
      { seed: 20261012 },
    );
  });
});
