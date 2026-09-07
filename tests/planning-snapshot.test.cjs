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
const childProcess = require('node:child_process');
const fc = require('fast-check');

const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

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
const { normalizePhaseName } = require('../gsd-core/bin/lib/phase-id.cjs');

// Phase 11 (#3309) additions — agent-install fixture helper mirrors
// tests/agent-install-check.test.cjs's own EXPECTED_AGENTS/createCompleteAgents
// (design doc's "subject-surface gap" §, reused per its provenance rule).
const { MODEL_PROFILES } = require('../gsd-core/bin/lib/model-profiles.cjs');
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

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
// The plan carries `wave: 1` frontmatter so this fixture is also
// wave-complete — callers that assert `perPhaseWaveMissingPlans` is empty
// on a "healthy" phase (Phase 12, #3310) get a genuinely clean baseline
// rather than a false positive from a plan that predates the `wave:` field.
function makeCompletePhaseDir(cwd, relPhaseDir) {
  const phaseNum = normalizePhaseName(path.basename(relPhaseDir));
  writeFile(cwd, `${relPhaseDir}/01-01-PLAN.md`, '---\nwave: 1\n---\n\n# Plan\n');
  writeFile(cwd, `${relPhaseDir}/01-01-SUMMARY.md`, '# Summary\n');
  writeFile(cwd, `${relPhaseDir}/${phaseNum}-VERIFICATION.md`, '---\nstatus: passed\n---\n');
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

// ═════════════════════════════════════════════════════════════════════════
// Phase 11 (#3309) additions — config / agentInstall / worktreeHealth
//
// Design:      .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
//              ("The subject-surface gap: config.json, agent-install, git-worktree-list")
// Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
//              section 1, rows 1-8
//
// These three new fields wrap the SAME owner calls `cmdValidateHealth`
// (src/verify.cts) already makes (`checkAgentsInstalled`, `inspectWorktreeHealth`,
// a raw config.json read), so a later phase step can migrate the caller onto
// this snapshot without a shape mismatch.
// ═════════════════════════════════════════════════════════════════════════

function writeConfig(cwd, obj) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'config.json'), JSON.stringify(obj));
}

function writeRawConfig(cwd, rawText) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'config.json'), rawText);
}

// Env isolation for GSD_AGENTS_DIR — mirrors tests/agent-install-check.test.cjs's
// beforeEach/afterEach save-restore idiom, inlined per-test via t.after since this
// describe block does not otherwise need beforeEach/afterEach hooks.
function withAgentsDirOverride(t, agentsDir) {
  const saved = process.env['GSD_AGENTS_DIR'];
  process.env['GSD_AGENTS_DIR'] = agentsDir;
  t.after(() => {
    if (saved === undefined) delete process.env['GSD_AGENTS_DIR'];
    else process.env['GSD_AGENTS_DIR'] = saved;
  });
}

function createCompleteAgentsDir(agentsDir) {
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const agent of EXPECTED_AGENTS) {
    fs.writeFileSync(path.join(agentsDir, `${agent}.toml`), `name = "${agent}"\n`);
  }
}

// Simulates a successful `git worktree list --porcelain` at the spawnSync seam —
// mirrors tests/worktree-safety.test.cjs's "execGitDefault (real spawn seam)"
// section, the repo's convention for driving the real execGit rather than a
// hand-set deps.execGit stub (this module accepts no deps parameter to inject).
function mockGitWorktreeListOk(t, porcelain) {
  t.mock.method(childProcess, 'spawnSync', () => ({
    status: 0,
    stdout: porcelain,
    stderr: '',
    signal: null,
    error: null,
  }));
}

// Simulates a timed-out `git worktree list --porcelain` (ETIMEDOUT), the same
// shape shell-command-projection.cjs's execGit / isSpawnTimeout recognize.
function mockGitWorktreeListTimeout(t) {
  t.mock.method(childProcess, 'spawnSync', () => ({
    status: null,
    stdout: '',
    stderr: '',
    signal: null,
    error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  }));
}

describe('config field (Phase 11, #3309, matrix rows 1-3)', () => {
  test('row 1: well-formed config.json parses to {value, scope: COMPLETE}', (t) => {
    const cwd = createTempDir('gsd-3309-cfg1-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, { model_profile: 'balanced' });

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.config, { value: { model_profile: 'balanced' }, scope: SCOPE.COMPLETE, exists: true });
  });

  test('row 2: absent config.json is a real non-answer — {value: null, scope: UNREADABLE, exists: false}', (t) => {
    const cwd = createTempDir('gsd-3309-cfg2-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    // No config.json written at all.

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.deepStrictEqual(snap.config, { value: null, scope: SCOPE.UNREADABLE, exists: false });
    assert.strictEqual(emitted, 0, 'absence is not corruption — no diagnostic');
  });

  test('row 3: present-but-unparseable config.json degrades without throwing — {value: null, scope: UNREADABLE, exists: true}, emits CONFIG_UNREADABLE exactly once', (t) => {
    const cwd = createTempDir('gsd-3309-cfg3-');
    t.after(() => cleanup(cwd));
    writeRawConfig(cwd, '{ not valid json');

    let snap;
    let emitted;
    assert.doesNotThrow(() => {
      [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    });
    assert.deepStrictEqual(snap.config, { value: null, scope: SCOPE.UNREADABLE, exists: true });
    assert.strictEqual(emitted, 1, 'present-but-unparseable config.json is corruption — exactly one CONFIG_UNREADABLE diagnostic');
  });
});

describe('agentInstall field (Phase 11, #3309, matrix rows 4-5)', () => {
  test('row 4: all agents present reports zero missing/incomplete, scope COMPLETE', (t) => {
    const cwd = createTempDir('gsd-3309-agt4-');
    t.after(() => cleanup(cwd));
    const agentsDir = path.join(cwd, 'agents-complete');
    createCompleteAgentsDir(agentsDir);
    withAgentsDirOverride(t, agentsDir);

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.agentInstall.scope, SCOPE.COMPLETE);
    assert.strictEqual(snap.agentInstall.value.agents_installed, true);
    assert.deepStrictEqual(snap.agentInstall.value.missing_agents, []);
    assert.deepStrictEqual(snap.agentInstall.value.incomplete_agents, []);
  });

  test('row 5: missing agents dir reports the full missing set, scope COMPLETE (the scan itself succeeded)', (t) => {
    const cwd = createTempDir('gsd-3309-agt5-');
    t.after(() => cleanup(cwd));
    const agentsDir = path.join(cwd, 'agents-absent');
    withAgentsDirOverride(t, agentsDir);
    // agentsDir deliberately never created.

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.agentInstall.scope, SCOPE.COMPLETE);
    assert.strictEqual(snap.agentInstall.value.agents_installed, false);
    assert.deepStrictEqual(snap.agentInstall.value.missing_agents.slice().sort(), EXPECTED_AGENTS.slice().sort());
  });
});

describe('worktreeHealth field (Phase 11, #3309, matrix rows 6-7)', () => {
  test('row 6: git worktree list succeeds — value is the parsed findings array, scope COMPLETE', (t) => {
    const cwd = createTempDir('gsd-3309-wt6-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    mockGitWorktreeListOk(t, 'worktree /repo\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.worktreeHealth.scope, SCOPE.COMPLETE);
    assert.ok(Array.isArray(snap.worktreeHealth.value));
  });

  test('row 7: git worktree list times out — scope reflects degradation (mirrors W020)', (t) => {
    const cwd = createTempDir('gsd-3309-wt7-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    mockGitWorktreeListTimeout(t);

    const snap = buildPlanningSnapshot(cwd);
    assert.notStrictEqual(snap.worktreeHealth.scope, SCOPE.COMPLETE);
    assert.strictEqual(snap.worktreeHealth.scope, SCOPE.UNREADABLE);
    assert.deepStrictEqual(snap.worktreeHealth.value, []);
  });
});

describe('Phase-10 fields unchanged by the Phase-11 extension (matrix row 8)', () => {
  test('the four original fields keep their exact pre-extension values on the same fixture', (t) => {
    const cwd = createTempDir('gsd-3309-reg8-');
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
    // The extension is additive — the new fields must be present alongside
    // the untouched originals, not in place of them.
    assert.ok('config' in snap);
    assert.ok('agentInstall' in snap);
    assert.ok('worktreeHealth' in snap);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase 11 (#3309) — "Rule table organization" batch, 7 more fields
//
// Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
//         ("Rule table organization" table)
//
// Each field relocates (not reinvents) an existing verify.cts derivation —
// see the JSDoc above each builder in src/planning-snapshot.cts for the
// exact source lines. Fixture helpers below mirror the existing
// writeRoadmap/writeState/writeFile idiom.
// ═════════════════════════════════════════════════════════════════════════

function writeProject(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'PROJECT.md'), content);
}

function writeMilestoneArchiveRoadmap(cwd, version, content) {
  const archiveDir = path.join(planningDirOf(cwd), 'milestones');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, `${version}-ROADMAP.md`), content);
}

function writeMilestonesRegistry(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'MILESTONES.md'), content);
}

describe('projectSections field (Phase 11, #3309)', () => {
  test('happy: returns every ## heading actually present, unfiltered against any required list', (t) => {
    const cwd = createTempDir('gsd-3309-ps1-');
    t.after(() => cleanup(cwd));
    writeProject(cwd, [
      '# My Project',
      '',
      '## What This Is',
      '',
      'text',
      '',
      '## Custom Section',
      '',
      '### Not a top-level heading',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.projectSections, {
      value: ['What This Is', 'Custom Section'],
      scope: SCOPE.COMPLETE,
      exists: true,
    });
  });

  test('absence: no PROJECT.md is a real non-answer, not corruption', (t) => {
    const cwd = createTempDir('gsd-3309-ps2-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.deepStrictEqual(snap.projectSections, { value: null, scope: SCOPE.UNREADABLE, exists: false });
    assert.strictEqual(emitted, 0);
  });

  test('hostile: present-but-unreadable PROJECT.md degrades without throwing, emits PROJECT_UNREADABLE exactly once', (t) => {
    const cwd = createTempDir('gsd-3309-ps3-');
    t.after(() => cleanup(cwd));
    makeFileUnreadableAsDir(path.join(planningDirOf(cwd), 'PROJECT.md'));

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.deepStrictEqual(snap.projectSections, { value: null, scope: SCOPE.UNREADABLE, exists: true });
    assert.strictEqual(emitted, 1, 'present-but-unreadable PROJECT.md is corruption — exactly one PROJECT_UNREADABLE diagnostic');
  });
});

describe('statePhaseTokens field (Phase 11, #3309)', () => {
  test('happy: every phase-number-shaped token anywhere in STATE.md text, in appearance order', (t) => {
    const cwd = createTempDir('gsd-3309-spt1-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    // The `Phase:`-field syntax ("Phase: 3 of 8") does NOT match this regex —
    // it requires `[Pp]hase\s+<digits>` (whitespace, not a colon, right
    // after "Phase"), exactly like verify.cts's own W002 relocation target.
    // Only prose-style "Phase N" references match, e.g. bracketed decision
    // annotations and free-text mentions.
    appendToState(cwd, [
      '',
      '## Current Position',
      '',
      'Phase: 3 of 8 (User Auth)',
      '',
      '### Decisions',
      '- [Phase 5]: revisit after Phase 2 wraps',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: ['5', '2'], scope: SCOPE.COMPLETE });
  });

  test('absence: no STATE.md yields an empty token list, non-answer scope, no diagnostic', (t) => {
    const cwd = createTempDir('gsd-3309-spt2-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.UNREADABLE });
    assert.strictEqual(emitted, 0);
  });

  test('hostile: unreadable-but-present STATE.md degrades statePhaseTokens together with currentPhaseLabel from ONE diagnostic', (t) => {
    const cwd = createTempDir('gsd-3309-spt3-');
    t.after(() => cleanup(cwd));
    makeFileUnreadableAsDir(path.join(planningDirOf(cwd), 'STATE.md'));

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.UNREADABLE });
    assert.deepStrictEqual(snap.currentPhaseLabel, { value: null, scope: SCOPE.UNREADABLE });
    assert.strictEqual(emitted, 1, 'the shared STATE.md read must not double-emit across fields');
  });

  // ─── #4257: harvest precision — a command MENTION is not a phase REFERENCE ──
  //
  // The pre-#4257 scan (`[Pp]hase\s+(TOKEN)`, unanchored, over the raw file)
  // harvested the `-phase 5` tail of GSD's own command names and any token
  // inside an inline code span / fenced block, so a ledger row quoting
  // `/gsd-execute-phase 5` fired W002 as an undeclared-phase reference. The
  // #4257 grammar: strip fenced blocks, then inline spans (the canonical
  // markdown-sectionizer seam + composition order, #2365), THEN match with a
  // left word boundary `(?<![-\w])` so a hyphen- or word-suffixed carrier
  // (`execute-phase`, `myphase`) is not a reference while `Phase 5`,
  // `**Phase 5:**`, `(Phase 5)` still are.
  test('#4257 row 1 (regression): `/gsd-execute-phase 5` in a Queue ledger row inside an inline code span is NOT harvested', (t) => {
    const cwd = createTempDir('gsd-4257-spt1-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Current Position',
      '',
      'Phase: 1 of 2',
      '',
      '## Queue',
      '',
      '- `/gsd-execute-phase 5`',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.COMPLETE });
  });

  test('#4257: a bare `/gsd-execute-phase 5` command mention (no backticks) is NOT harvested — left word boundary', (t) => {
    const cwd = createTempDir('gsd-4257-spt2-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Queue',
      '',
      '- Run /gsd-execute-phase 5 when the ledger clears',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.COMPLETE });
  });

  test('#4257: a quoted roadmap line `- [ ] **Phase 40:**` inside an inline code span is NOT harvested', (t) => {
    const cwd = createTempDir('gsd-4257-spt3-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Ledger',
      '',
      '- `- [ ] **Phase 40:** quoted from a sibling workstream roadmap`',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.COMPLETE });
  });

  test('#4257: a `Phase 9` mention inside a fenced code block is NOT harvested', (t) => {
    const cwd = createTempDir('gsd-4257-spt4-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Notes',
      '',
      '```',
      'Phase 9 was quoted here verbatim',
      '```',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.COMPLETE });
  });

  test('#4257 tradeoff (pinned by the issue): a GENUINE reference written in backticks stops counting', (t) => {
    const cwd = createTempDir('gsd-4257-spt5-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Decisions',
      '',
      '- see `Phase 5` notes for the rationale',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.COMPLETE });
  });

  test('#4257: word-suffixed carriers (myphase 5, alphaphase 3) are NOT harvested — boundary covers non-command suffixes too', (t) => {
    const cwd = createTempDir('gsd-4257-spt6-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Decisions',
      '',
      '- myphase 5 and alphaphase 3 are words, not references',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.COMPLETE });
  });

  test('#4257 mixed form: prose reference survives while command mention and quoted literal are dropped from the same file', (t) => {
    const cwd = createTempDir('gsd-4257-spt7-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Current Position',
      '',
      'Phase: 1 of 2',
      '',
      '## Queue',
      '',
      '- `/gsd-execute-phase 9` once Phase 5 wraps (see `Phase 12` notes)',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: ['5'], scope: SCOPE.COMPLETE });
  });

  // KEEP rows — the #4257 boundary must NOT narrow legitimate references.
  test('#4257 keep: bold `**Phase 5:**` and parenthesised `(Phase 5)` and heading `### Phase 5:` forms still harvest', (t) => {
    const cwd = createTempDir('gsd-4257-spt8-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '### Phase 5: Five',
      '',
      '- **Phase 5:** started',
      '- (Phase 5) pending review',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: ['5', '5', '5'], scope: SCOPE.COMPLETE });
  });

  test('#4257 keep: silent forms stay silent (Phase5, flag form, non-English word)', (t) => {
    const cwd = createTempDir('gsd-4257-spt9-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Queue',
      '',
      '- `gsd-tools phase --insert 5`',
      '- `Phase5` shorthand does not count',
      '- фаза 5 is not the token either',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: [], scope: SCOPE.COMPLETE });
  });
});

// ─── workstream field (#4257) ────────────────────────────────────────────────

describe('workstream field (#4257)', () => {
  // The env save/restore pattern mirrors tests/health-diagnostic.test.cjs:598-602
  // and tests/config-loader.test.cjs:499-509 — GSD_WORKSTREAM is the SAME
  // discriminator planningDir applies (planning-workspace.cts:130), and the
  // CLI bootstrap folds the stored active-workstream pointer into it
  // (active-workstream-store.cts:488-494), so setting it directly is the
  // faithful rule-level simulation of "workstream alpha is active".
  function withWorkstreamEnv(t, name) {
    const prev = process.env['GSD_WORKSTREAM'];
    if (name === null) delete process.env['GSD_WORKSTREAM'];
    else process.env['GSD_WORKSTREAM'] = name;
    t.after(() => {
      if (prev === undefined) delete process.env['GSD_WORKSTREAM'];
      else process.env['GSD_WORKSTREAM'] = prev;
    });
  }

  test('flat project (no GSD_WORKSTREAM): workstream is null', (t) => {
    const cwd = createTempDir('gsd-4257-ws1-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    withWorkstreamEnv(t, null);

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.workstream, null);
  });

  test('GSD_WORKSTREAM=alpha: workstream names the scope every workstream-aware read used', (t) => {
    const cwd = createTempDir('gsd-4257-ws2-');
    t.after(() => cleanup(cwd));
    writeFile(cwd, '.planning/workstreams/alpha/STATE.md', [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '## Decisions',
      '',
      '- Phase 2 wrapped',
      '',
    ].join('\n'));
    withWorkstreamEnv(t, 'alpha');

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.workstream, 'alpha');
  });

  test('non-divergence: the field names the base statePhaseTokens was actually read from', (t) => {
    const cwd = createTempDir('gsd-4257-ws3-');
    t.after(() => cleanup(cwd));
    // Root STATE.md carries Phase 7; workstream STATE.md carries Phase 5. The
    // tokens must come from the WORKSTREAM file (planningPaths scoped it) and
    // the field must name that same workstream — one resolution point, two
    // observable answers that cannot disagree.
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, ['', '- Phase 7 lives at root scope', ''].join('\n'));
    writeFile(cwd, '.planning/workstreams/alpha/STATE.md', [
      '---',
      'milestone: v1.0',
      '---',
      '',
      '- Phase 5 lives in the workstream',
      '',
    ].join('\n'));
    withWorkstreamEnv(t, 'alpha');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.statePhaseTokens, { value: ['5'], scope: SCOPE.COMPLETE });
    assert.strictEqual(snap.workstream, 'alpha');
  });
});

describe('stateStatus field (Phase 11, #3309)', () => {
  test('happy: Status field under Current Position is extracted verbatim, mirroring currentPhaseLabel', (t) => {
    const cwd = createTempDir('gsd-3309-ss1-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    appendToState(cwd, [
      '',
      '## Current Position',
      '',
      'Phase: 3 of 8 (User Auth)',
      'Status: In progress',
      '',
    ].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.stateStatus, { value: 'In progress', scope: SCOPE.COMPLETE });
  });

  test('boundary: missing Current Position section still resolves status from frontmatter, scope TRUNCATED', (t) => {
    const cwd = createTempDir('gsd-3309-ss2-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { status: 'planning' });

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.stateStatus.value, 'planning');
    assert.strictEqual(snap.stateStatus.scope, SCOPE.TRUNCATED);
  });

  test('absence: no STATE.md yields a non-answer, no diagnostic', (t) => {
    const cwd = createTempDir('gsd-3309-ss3-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const [snap, emitted] = emissionsDuring(() => buildPlanningSnapshot(cwd));
    assert.deepStrictEqual(snap.stateStatus, { value: null, scope: SCOPE.UNREADABLE });
    assert.strictEqual(emitted, 0);
  });
});

describe('roadmapDeclaredPhases field (Phase 11, #3309)', () => {
  test('happy: every declared phase id paired with the milestone section it was found under', (t) => {
    const cwd = createTempDir('gsd-3309-rdp1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.roadmapDeclaredPhases, {
      value: [
        { phaseId: '1', milestone: 'v1.0' },
        { phaseId: '2', milestone: 'v1.0' },
      ],
      scope: SCOPE.COMPLETE,
    });
  });

  test('boundary: a phase declared before any version heading gets milestone: null', (t) => {
    const cwd = createTempDir('gsd-3309-rdp2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['### Phase 9: Prelude', '', '## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    const prelude = snap.roadmapDeclaredPhases.value.find((p) => p.phaseId === '9');
    const foo = snap.roadmapDeclaredPhases.value.find((p) => p.phaseId === '1');
    assert.deepStrictEqual(prelude, { phaseId: '9', milestone: null });
    assert.deepStrictEqual(foo, { phaseId: '1', milestone: 'v1.0' });
  });

  test('absence: no ROADMAP.md is a non-answer', (t) => {
    const cwd = createTempDir('gsd-3309-rdp3-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.roadmapDeclaredPhases, { value: [], scope: SCOPE.UNREADABLE });
  });

  test('hostile: unreadable ROADMAP.md degrades to an empty list, scope UNREADABLE', (t) => {
    const cwd = createTempDir('gsd-3309-rdp4-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    makeFileUnreadableAsDir(path.join(planningDirOf(cwd), 'ROADMAP.md'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.roadmapDeclaredPhases, { value: [], scope: SCOPE.UNREADABLE });
  });
});

describe('roadmapPhaseCheckboxes field (Phase 11, #3309)', () => {
  test('happy: [x]/[ ] checkbox state parsed per phase id', (t) => {
    const cwd = createTempDir('gsd-3309-rpc1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## Progress', '', '- [x] Phase 1: Foo', '- [ ] Phase 2: Bar'].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.roadmapPhaseCheckboxes, { value: { '1': true, '2': false }, scope: SCOPE.COMPLETE });
  });

  test('boundary: no checklist lines present is a real empty answer, not a non-answer', (t) => {
    const cwd = createTempDir('gsd-3309-rpc2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.roadmapPhaseCheckboxes, { value: {}, scope: SCOPE.COMPLETE });
  });

  test('hostile: unreadable ROADMAP.md degrades to an empty map, scope UNREADABLE', (t) => {
    const cwd = createTempDir('gsd-3309-rpc3-');
    t.after(() => cleanup(cwd));
    makeFileUnreadableAsDir(path.join(planningDirOf(cwd), 'ROADMAP.md'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.roadmapPhaseCheckboxes, { value: {}, scope: SCOPE.UNREADABLE });
  });
});

describe('researchValidationStatus field (Phase 11, #3309)', () => {
  test('happy: RESEARCH.md carries the Validation Architecture heading and a VALIDATION.md exists', (t) => {
    const cwd = createTempDir('gsd-3309-rvs1-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    writeFile(cwd, '.planning/phases/01-foo/01-RESEARCH.md', '# Research\n\n## Validation Architecture\n\ntext\n');
    writeFile(cwd, '.planning/phases/01-foo/01-VALIDATION.md', '# Validation\n');

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.researchValidationStatus.value.find((r) => r.dir === '01-foo');
    assert.deepStrictEqual(entry, { dir: '01-foo', hasValidationArchitecture: true, hasValidationMd: true });
    assert.strictEqual(snap.researchValidationStatus.scope, SCOPE.COMPLETE);
  });

  test('negative: RESEARCH.md without the heading and no VALIDATION.md reports both false', (t) => {
    const cwd = createTempDir('gsd-3309-rvs2-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    writeFile(cwd, '.planning/phases/01-foo/01-RESEARCH.md', '# Research\n\nno special section\n');

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.researchValidationStatus.value.find((r) => r.dir === '01-foo');
    assert.deepStrictEqual(entry, { dir: '01-foo', hasValidationArchitecture: false, hasValidationMd: false });
  });

  test('#3511-class: a phase dir holding only ANOTHER phase\'s -RESEARCH.md/-VALIDATION.md does not set this phase\'s flags', (t) => {
    const cwd = createTempDir('gsd-3511-rvs4-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n'));
    // Phase 01's directory is empty. Phase 02's directory holds ONLY stray
    // artifacts whose filename token ("01-") belongs to phase 01, not to
    // this directory's own phase (02).
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', '01-foo'), { recursive: true });
    writeFile(cwd, '.planning/phases/02-bar/01-RESEARCH.md', '# Research\n\n## Validation Architecture\n\ntext\n');
    writeFile(cwd, '.planning/phases/02-bar/01-VALIDATION.md', '# Validation\n');

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.researchValidationStatus.value.find((r) => r.dir === '02-bar');
    assert.deepStrictEqual(entry, { dir: '02-bar', hasValidationArchitecture: false, hasValidationMd: false },
      'phase 2 must not report validation status from a file that belongs to phase 1');
  });

  test('hostile: an unreadable phase directory degrades that entry to false/false without throwing', (t) => {
    const cwd = createTempDir('gsd-3309-rvs3-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    const phaseDir = path.join(planningDirOf(cwd), 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    injectPhaseDirFault(t, phaseDir);

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.researchValidationStatus.value.find((r) => r.dir === '01-foo');
    assert.deepStrictEqual(entry, { dir: '01-foo', hasValidationArchitecture: false, hasValidationMd: false });
  });
});

describe('milestoneArchiveStatus field (Phase 11, #3309)', () => {
  test('happy: archived ROADMAP snapshot present and its version documented in MILESTONES.md', (t) => {
    const cwd = createTempDir('gsd-3309-mas1-');
    t.after(() => cleanup(cwd));
    writeMilestoneArchiveRoadmap(cwd, 'v1.0', '# v1.0 archive\n');
    writeMilestonesRegistry(cwd, '## v1.0\n\nShipped.\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.milestoneArchiveStatus, {
      value: { archivedVersions: ['v1.0'], documentedVersions: ['v1.0'] },
      scope: SCOPE.COMPLETE,
    });
  });

  test('negative: no milestones/ dir and no MILESTONES.md is a real empty answer, not a non-answer', (t) => {
    const cwd = createTempDir('gsd-3309-mas2-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.milestoneArchiveStatus, {
      value: { archivedVersions: [], documentedVersions: [] },
      scope: SCOPE.COMPLETE,
    });
  });

  test('boundary: an archived version missing from the registry is reported, not silently dropped', (t) => {
    const cwd = createTempDir('gsd-3309-mas3-');
    t.after(() => cleanup(cwd));
    writeMilestoneArchiveRoadmap(cwd, 'v1.0', '# v1.0 archive\n');
    // No MILESTONES.md at all.

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.milestoneArchiveStatus.value.archivedVersions, ['v1.0']);
    assert.deepStrictEqual(snap.milestoneArchiveStatus.value.documentedVersions, []);
  });

  test('hostile: an unreadable milestones/ dir degrades to scope UNREADABLE without throwing', (t) => {
    const cwd = createTempDir('gsd-3309-mas4-');
    t.after(() => cleanup(cwd));
    // Directory-vs-file swap: milestones/ is a regular FILE, so
    // fs.existsSync is true but readdirSync throws ENOTDIR.
    makeDirUnreadableAsFile(path.join(planningDirOf(cwd), 'milestones'));

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.milestoneArchiveStatus.scope, SCOPE.UNREADABLE);
  });
});

describe('planningRootFiles field (Phase 11, #3309)', () => {
  test('happy: lists files (not directories) directly under .planning/ root', (t) => {
    const cwd = createTempDir('gsd-3309-prf1-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));
    writeFile(cwd, '.planning/NOTES.md', 'stray file\n');
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases'), { recursive: true }); // a directory — must be excluded

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningRootFiles.value.slice().sort(), ['NOTES.md', 'ROADMAP.md', 'STATE.md']);
    assert.strictEqual(snap.planningRootFiles.scope, SCOPE.COMPLETE);
  });

  test('absence: no .planning/ directory at all degrades to an empty list, scope UNREADABLE', (t) => {
    const cwd = createTempDir('gsd-3309-prf2-');
    t.after(() => cleanup(cwd));
    // .planning/ deliberately never created.

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningRootFiles, { value: [], scope: SCOPE.UNREADABLE });
  });

  test('hostile: an unreadable .planning/ root degrades without throwing', (t) => {
    const cwd = createTempDir('gsd-3309-prf3-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    injectPhaseDirFault(t, planningDirOf(cwd));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningRootFiles, { value: [], scope: SCOPE.UNREADABLE });
  });
});

describe('allPhaseDirNames field (Phase 11, #3309 — health-diagnostic-rules/roadmap-disk-consistency batch)', () => {
  // Found while implementing W007 (`src/health-diagnostic-rules/
  // roadmap-disk-consistency.cts`): `phaseDirs` is windowed to directories
  // the ROADMAP already declares, so it can never expose a genuine orphan
  // directory. `allPhaseDirNames` is the unwindowed twin.

  test('happy: lists every directory under phases/, including one NOT declared anywhere in ROADMAP.md', (t) => {
    const cwd = createTempDir('gsd-3309-apdn1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', '01-foo'), { recursive: true });
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', '04-extra'), { recursive: true }); // undeclared

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.allPhaseDirNames.value.slice().sort(), ['01-foo', '04-extra']);
    assert.strictEqual(snap.allPhaseDirNames.scope, SCOPE.COMPLETE);
    // Sanity: `phaseDirs` (windowed) must NOT include the undeclared dir —
    // this is the exact gap `allPhaseDirNames` exists to close.
    assert.ok(!snap.phaseDirs.value.includes('04-extra'));
  });

  test('absence: no phases/ directory at all is a real empty, not a failure', (t) => {
    const cwd = createTempDir('gsd-3309-apdn2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.allPhaseDirNames, { value: [], scope: SCOPE.COMPLETE });
  });

  test('hostile: an unreadable phases/ directory degrades to an empty list, scope UNREADABLE, without throwing', (t) => {
    const cwd = createTempDir('gsd-3309-apdn3-');
    t.after(() => cleanup(cwd));
    const phasesDir = path.join(planningDirOf(cwd), 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });
    injectPhaseDirFault(t, phasesDir);

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.allPhaseDirNames, { value: [], scope: SCOPE.UNREADABLE });
  });

  test('#3882 §3.1: byte-identical to a HARDCODED literal, order INCLUDED — mixed sentinel/decimal/letter-suffix/colliding fixture', (t) => {
    // 40-design.md §3.1 claimed this proof existed ("proven byte-identical —
    // order included") before it did; the only existing assertion (above,
    // `.slice().sort()`) is order-BLIND, so it can only ever pass regardless
    // of what order buildAllPhaseDirNamesField returns. This row is what
    // makes that claim true: order asserted, expectation hardcoded (never
    // re-derived from listAllPhaseDirs or buildAllPhaseDirNamesField
    // themselves), over a fixture mixing every axis the delegation could get
    // wrong — sentinel (0-/999-), decimal (04.1-), letter-suffix (03A-), and
    // a genuinely COLLIDING phase-number pair (01-real / 01-duplicate, both
    // phase "01" — the shape where a raw-fs -> comparePhaseNum reorder could
    // silently change output order).
    const cwd = createTempDir('gsd-3882-apdn-order-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    const names = ['01-real', '01-duplicate', '999-icebox', '0-backlog', '04.1-decimal', '03A-suffix'];
    for (const name of names) {
      fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', name), { recursive: true });
    }

    const snap = buildPlanningSnapshot(cwd);
    // Hardcoded literal — plain JS default Array.prototype.sort() (UTF-16
    // code-unit order, a language guarantee) applied to the fixture list by
    // hand, not by calling into the code under test.
    assert.deepStrictEqual(snap.allPhaseDirNames, {
      value: ['0-backlog', '01-duplicate', '01-real', '03A-suffix', '04.1-decimal', '999-icebox'],
      scope: SCOPE.COMPLETE,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase 12 (#3310, ADR-3180 §8.4) additions — perPhasePlanNumbering /
// perPhaseOrphanSummaries / perPhaseWaveMissingPlans
//
// Design:      .gsd/phase/feat-3310-enhance-3180-the-sibling-validators-shar/40-design.md
//              ("New PlanningSnapshot fields")
// Test matrix: .gsd/phase/feat-3310-enhance-3180-the-sibling-validators-shar/50-test-matrix.md
//              section 1, rows 1-8
//
// Each relocates (not reinvents) `verify.cts:1556-1603`'s per-phase-directory
// plan scan — see `buildPerPhasePlanScanFields`'s doc comment in
// src/planning-snapshot.cts for the exact source lines. Fixture helpers
// mirror the existing writeRoadmap/writeState/writeFile idiom.
// ═════════════════════════════════════════════════════════════════════════

function writePlan(cwd, relPhasePath, planName, frontmatterLines) {
  const lines = frontmatterLines ? ['---', ...frontmatterLines, '---', '', '# Plan', ''] : ['# Plan', ''];
  writeFile(cwd, `${relPhasePath}/${planName}`, lines.join('\n'));
}

describe('perPhasePlanNumbering field (Phase 12, #3310, matrix rows 1-2)', () => {
  test('row 1: sequential plans (01, 02, 03) report the full sorted sequence, no gap', (t) => {
    const cwd = createTempDir('gsd-3310-ppn1-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');
    writePlan(cwd, '.planning/phases/01-foo', '01-02-PLAN.md');
    writePlan(cwd, '.planning/phases/01-foo', '01-03-PLAN.md');

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.perPhasePlanNumbering.value.find((e) => e.phaseDir === '01-foo');
    assert.deepStrictEqual(entry, { phaseDir: '01-foo', planNums: [1, 2, 3] });
    assert.strictEqual(snap.perPhasePlanNumbering.scope, SCOPE.COMPLETE);
  });

  test('row 2: a real gap (01, 03) is surfaced in the raw per-phase number list', (t) => {
    const cwd = createTempDir('gsd-3310-ppn2-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');
    writePlan(cwd, '.planning/phases/01-foo', '01-03-PLAN.md');

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.perPhasePlanNumbering.value.find((e) => e.phaseDir === '01-foo');
    assert.deepStrictEqual(entry, { phaseDir: '01-foo', planNums: [1, 3] });
  });

  test('boundary: zero phase directories yields an empty array, not a non-answer', (t) => {
    const cwd = createTempDir('gsd-3310-ppn3-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases'), { recursive: true });

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.perPhasePlanNumbering, { value: [], scope: SCOPE.COMPLETE });
  });

  test('boundary: a phase with zero plans reports an empty planNums list for that phase, not an absent entry', (t) => {
    const cwd = createTempDir('gsd-3310-ppn4-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', '01-foo'), { recursive: true });

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.perPhasePlanNumbering.value.find((e) => e.phaseDir === '01-foo');
    assert.deepStrictEqual(entry, { phaseDir: '01-foo', planNums: [] });
  });
});

describe('perPhaseOrphanSummaries field (Phase 12, #3310, matrix rows 3-5)', () => {
  test('row 3: a paired plan+summary produces no orphan entries', (t) => {
    const cwd = createTempDir('gsd-3310-pos1-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(
      snap.perPhaseOrphanSummaries.value.filter((e) => e.phaseDir === '01-foo'),
      [],
    );
  });

  test('row 4: a summary with no live plan at all is named as an orphan', (t) => {
    const cwd = createTempDir('gsd-3310-pos2-');
    t.after(() => cleanup(cwd));
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');

    const snap = buildPlanningSnapshot(cwd);
    const entries = snap.perPhaseOrphanSummaries.value.filter((e) => e.phaseDir === '01-foo');
    assert.deepStrictEqual(entries, [{ phaseDir: '01-foo', orphanSummary: '01-01-SUMMARY.md' }]);
  });

  test('row 5: a summary paired only to a superseded plan is still orphan — superseded plans are not live', (t) => {
    const cwd = createTempDir('gsd-3310-pos3-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md', ['status: superseded']);
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');

    const snap = buildPlanningSnapshot(cwd);
    const entries = snap.perPhaseOrphanSummaries.value.filter((e) => e.phaseDir === '01-foo');
    assert.deepStrictEqual(entries, [{ phaseDir: '01-foo', orphanSummary: '01-01-SUMMARY.md' }]);
  });
});

describe('perPhaseWaveMissingPlans field (Phase 12, #3310, matrix rows 6-7)', () => {
  test('row 6: a plan with wave: in frontmatter is not flagged', (t) => {
    const cwd = createTempDir('gsd-3310-pwm1-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md', ['wave: 1']);

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(
      snap.perPhaseWaveMissingPlans.value.filter((e) => e.phaseDir === '01-foo'),
      [],
    );
  });

  test('row 7: a plan without wave: in frontmatter is flagged', (t) => {
    const cwd = createTempDir('gsd-3310-pwm2-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');

    const snap = buildPlanningSnapshot(cwd);
    const entries = snap.perPhaseWaveMissingPlans.value.filter((e) => e.phaseDir === '01-foo');
    assert.deepStrictEqual(entries, [{ phaseDir: '01-foo', plan: '01-01-PLAN.md' }]);
  });

  test('boundary: a phase where every plan lacks wave: reports every one, none silently dropped', (t) => {
    const cwd = createTempDir('gsd-3310-pwm3-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');
    writePlan(cwd, '.planning/phases/01-foo', '01-02-PLAN.md');

    const snap = buildPlanningSnapshot(cwd);
    const entries = snap.perPhaseWaveMissingPlans.value.filter((e) => e.phaseDir === '01-foo');
    assert.deepStrictEqual(
      entries.map((e) => e.plan).sort(),
      ['01-01-PLAN.md', '01-02-PLAN.md'],
    );
  });

  test('boundary: a phase where every plan carries wave: reports none', (t) => {
    const cwd = createTempDir('gsd-3310-pwm4-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md', ['wave: 1']);
    writePlan(cwd, '.planning/phases/01-foo', '01-02-PLAN.md', ['wave: 2']);

    const snap = buildPlanningSnapshot(cwd);
    const entries = snap.perPhaseWaveMissingPlans.value.filter((e) => e.phaseDir === '01-foo');
    assert.deepStrictEqual(entries, []);
  });
});

describe('Phase-10/11 fields unchanged by the Phase-12 extension (matrix row 8)', () => {
  test('the new fields are additive alongside every prior field on the same fixture', (t) => {
    const cwd = createTempDir('gsd-3310-reg8-');
    t.after(() => cleanup(cwd));
    buildHealthyTwoPhaseFixture(cwd);

    const snap = buildPlanningSnapshot(cwd);

    assert.strictEqual(snap.milestone.scope, SCOPE.COMPLETE);
    assert.strictEqual(snap.phases.value.length, 2);
    assert.ok('config' in snap);
    assert.ok('agentInstall' in snap);
    assert.ok('worktreeHealth' in snap);
    // The extension is additive — the three new Phase 12 fields sit
    // alongside every prior field, not in place of them.
    assert.ok('perPhasePlanNumbering' in snap);
    assert.ok('perPhaseOrphanSummaries' in snap);
    assert.ok('perPhaseWaveMissingPlans' in snap);
    assert.strictEqual(snap.perPhasePlanNumbering.value.length, 2);
    for (const entry of snap.perPhasePlanNumbering.value) {
      assert.deepStrictEqual(entry.planNums, [1]);
    }
    assert.deepStrictEqual(snap.perPhaseOrphanSummaries.value, []);
    assert.deepStrictEqual(snap.perPhaseWaveMissingPlans.value, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// #3586 (Phase 2, epic #2292) — `planningTracked` field
//
// Design:      .gsd/phase/fix-3586-tracked-gitignored-planning/40-design.md
// Test matrix: .gsd/phase/fix-3586-tracked-gitignored-planning/50-test-matrix.md
//              section A (rows A1-A12)
//
// `.gitignore` has no effect on files git already tracks — this field detects
// the resulting contradiction: `.planning/` matches an ignore rule AND at
// least one path under it is still tracked. Backs W029
// (`src/health-diagnostic-rules/config-validation.cts`).
// ═════════════════════════════════════════════════════════════════════════

function initBareGitRepo(cwd) {
  gitOrThrow(['init'], { cwd });
  gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd });
  gitOrThrow(['config', 'user.name', 'Test'], { cwd });
  gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd });
}

function commitAll(cwd, message) {
  gitOrThrow(['add', '-A'], { cwd });
  gitOrThrow(['commit', '-m', message], { cwd });
}

function writeGitignore(cwd, content) {
  fs.writeFileSync(path.join(cwd, '.gitignore'), content);
}

// Simulates a timed-out `git ls-files` at the spawnSync seam — mirrors this
// file's existing `mockGitWorktreeListTimeout` convention (t.mock.method,
// auto-restored by node:test, never chmod 0o000).
function mockGitSpawnTimeout(t) {
  t.mock.method(childProcess, 'spawnSync', () => ({
    status: null,
    stdout: '',
    stderr: '',
    signal: null,
    error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  }));
}

// Simulates `git ls-files` exiting non-zero while the structural
// `rev-parse --is-inside-work-tree` probe (the builder's OWN follow-up call
// on the failure path, #3586) still succeeds — i.e. a real repo, but the
// `ls-files` invocation failed for some other reason. Differentiates by argv
// rather than blanket-mocking every spawnSync call, since the builder now
// issues a second git subprocess on this path.
function mockGitSpawnFailure(t) {
  t.mock.method(childProcess, 'spawnSync', (_cmd, args) => {
    if (Array.isArray(args) && args.includes('rev-parse')) {
      return { status: 0, stdout: 'true', stderr: '', signal: null, error: null };
    }
    return { status: 128, stdout: '', stderr: 'fatal: some other git failure', signal: null, error: null };
  });
}

// Simulates `git ls-files` overflowing spawnSync's Node-default 1MB stdout
// buffer (#3586 review F2) — Node reports this as `error.code === 'ENOBUFS'`,
// `status: null`. Discriminates by argv (mirrors `mockGitSpawnFailure` above)
// so the `check-ignore` call `isGitIgnored` issues on the same happy path
// still reaches the REAL spawnSync against the fixture's real `.gitignore` —
// a blanket mock here would falsely report `ignored: false` too.
function mockGitSpawnEnobufs(t) {
  const originalSpawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (cmd, args, opts) => {
    if (Array.isArray(args) && args.includes('ls-files')) {
      return {
        status: null,
        stdout: '',
        stderr: '',
        signal: null,
        error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }),
      };
    }
    return originalSpawnSync.call(childProcess, cmd, args, opts);
  });
}

// Simulates a directory that is genuinely not inside any git work tree: both
// `ls-files` AND the structural `rev-parse --is-inside-work-tree` probe fail.
// Used to prove the `not_a_git_repo` classification does NOT depend on
// stderr content — both calls here carry EMPTY stderr.
function mockGitSpawnNotARepoNoStderr(t) {
  t.mock.method(childProcess, 'spawnSync', () => ({
    status: 128,
    stdout: '',
    stderr: '',
    signal: null,
    error: null,
  }));
}

describe('planningTracked field (#3586, matrix rows A1-A12)', () => {
  test('A1: ignored + tracked is detected', (t) => {
    const cwd = createTempGitProject('gsd-3586-a1-');
    t.after(() => cleanup(cwd));
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'add gitignore');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked, {
      value: { tracked: true, ignored: true },
      scope: SCOPE.COMPLETE,
      reason: 'ok',
    });
  });

  test('A2: ignored + untracked is clean', (t) => {
    const cwd = createTempDir('gsd-3586-a2-');
    t.after(() => cleanup(cwd));
    initBareGitRepo(cwd);
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'initial (gitignore only)');
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'PROJECT.md'), '# Project\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked, {
      value: { tracked: false, ignored: true },
      scope: SCOPE.COMPLETE,
      reason: 'ok',
    });
  });

  test('A3: tracked + NOT ignored is the normal (default) project — must NOT read as detected', (t) => {
    const cwd = createTempGitProject('gsd-3586-a3-');
    t.after(() => cleanup(cwd));
    // No .gitignore at all — the default state of essentially every project.

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked, {
      value: { tracked: true, ignored: false },
      scope: SCOPE.COMPLETE,
      reason: 'ok',
    });
  });

  test('A4: fresh project (untracked, not ignored) is clean', (t) => {
    const cwd = createTempDir('gsd-3586-a4-');
    t.after(() => cleanup(cwd));
    initBareGitRepo(cwd);
    gitOrThrow(['commit', '--allow-empty', '-m', 'initial'], { cwd });
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'PROJECT.md'), '# Project\n');
    // Deliberately never `git add`.

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked, {
      value: { tracked: false, ignored: false },
      scope: SCOPE.COMPLETE,
      reason: 'ok',
    });
  });

  test('A5: not a git repo degrades to UNREADABLE/not_a_git_repo, silently', (t) => {
    const cwd = createTempDir('gsd-3586-a5-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'PROJECT.md'), '# Project\n');
    // No `git init` at all.

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.planningTracked.scope, SCOPE.UNREADABLE);
    assert.strictEqual(snap.planningTracked.reason, 'not_a_git_repo');
  });

  test('A6: git ls-files timeout degrades quietly (no throw)', (t) => {
    const cwd = createTempGitProject('gsd-3586-a6-');
    t.after(() => cleanup(cwd));
    mockGitSpawnTimeout(t);

    let snap;
    assert.doesNotThrow(() => {
      snap = buildPlanningSnapshot(cwd);
    });
    assert.strictEqual(snap.planningTracked.scope, SCOPE.UNREADABLE);
    assert.strictEqual(snap.planningTracked.reason, 'git_timed_out');
  });

  test('A7: git ls-files non-zero exit degrades quietly (no throw)', (t) => {
    const cwd = createTempGitProject('gsd-3586-a7-');
    t.after(() => cleanup(cwd));
    mockGitSpawnFailure(t);

    let snap;
    assert.doesNotThrow(() => {
      snap = buildPlanningSnapshot(cwd);
    });
    assert.strictEqual(snap.planningTracked.scope, SCOPE.UNREADABLE);
    assert.strictEqual(snap.planningTracked.reason, 'git_list_failed');
  });

  test('A8: .planning/ absent from disk is silent (untracked, not ignored)', (t) => {
    const cwd = createTempDir('gsd-3586-a8-');
    t.after(() => cleanup(cwd));
    initBareGitRepo(cwd);
    gitOrThrow(['commit', '--allow-empty', '-m', 'initial'], { cwd });
    // .planning/ never created at all.

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked, {
      value: { tracked: false, ignored: false },
      scope: SCOPE.COMPLETE,
      reason: 'ok',
    });
  });

  test('A9: exactly ONE tracked file under an ignored .planning/ is enough to detect', (t) => {
    const cwd = createTempGitProject('gsd-3586-a9-');
    t.after(() => cleanup(cwd));
    // createTempGitProject seeds exactly .planning/PROJECT.md — one file.
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'add gitignore');

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.planningTracked.value.tracked, true);
    assert.strictEqual(snap.planningTracked.value.ignored, true);
  });

  test('A10: tracked in the index but deleted from the worktree is still detected', (t) => {
    const cwd = createTempGitProject('gsd-3586-a10-');
    t.after(() => cleanup(cwd));
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'add gitignore');
    // Delete the tracked file from disk WITHOUT `git rm` — it stays in the index.
    // (fs.unlinkSync, not fs.rmSync — this is a single tracked file, not a
    // directory teardown, so the Windows-EBUSY-retry rmSync rule does not apply.)
    fs.unlinkSync(path.join(cwd, '.planning', 'PROJECT.md'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked.value, { tracked: true, ignored: true });
  });

  test('A11: ignored via .git/info/exclude counts the same as .gitignore', (t) => {
    const cwd = createTempGitProject('gsd-3586-a11-');
    t.after(() => cleanup(cwd));
    // Local-only, never committed — check-ignore honors it all the same.
    fs.appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '.planning/\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked.value, { tracked: true, ignored: true });
  });

  test('A12: a .gitignore covering only .planning/cache/ does NOT count as the root ignored (sub-path ignore is not the contradictory state)', (t) => {
    const cwd = createTempGitProject('gsd-3586-a12-');
    t.after(() => cleanup(cwd));
    writeGitignore(cwd, '.planning/cache/\n');
    commitAll(cwd, 'add sub-path gitignore');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked.value, { tracked: true, ignored: false });
  });

  // ─── Locale-independence regression (#3586) ────────────────────────────────
  // The original defect: `not_a_git_repo` vs `git_list_failed` was
  // distinguished by regex-matching git's (localized) stderr prose. Under a
  // non-English `LANG`/`LC_ALL`, git prints the translated string and the
  // regex misses, misclassifying a plain non-git directory as
  // `git_list_failed`. The fix asks git a structural yes/no question
  // (`rev-parse --is-inside-work-tree`) instead of parsing stderr.

  test('A5-locale: not-a-git-repo classification holds with a non-English LANG/LC_ALL set', (t) => {
    const cwd = createTempDir('gsd-3586-a5-locale-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'PROJECT.md'), '# Project\n');

    const savedLang = process.env['LANG'];
    const savedLcAll = process.env['LC_ALL'];
    process.env['LANG'] = 'de_DE.UTF-8';
    process.env['LC_ALL'] = 'de_DE.UTF-8';
    t.after(() => {
      if (savedLang === undefined) delete process.env['LANG'];
      else process.env['LANG'] = savedLang;
      if (savedLcAll === undefined) delete process.env['LC_ALL'];
      else process.env['LC_ALL'] = savedLcAll;
    });

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.planningTracked.scope, SCOPE.UNREADABLE);
    assert.strictEqual(snap.planningTracked.reason, 'not_a_git_repo');
    // NOTE: this machine's `git` (Apple Git 2.50.1) ships no German NLS
    // catalog (verified: no `.mo` translation file under its install), so
    // this run does not actually exercise TRANSLATED stderr text — git still
    // prints English here even with the locale env vars set. This test
    // therefore does not, by itself, prove locale-independence; the test
    // below (A5-structural) is the real regression coverage: it fails
    // against the old stderr-regex implementation regardless of what
    // translations happen to be installed on the machine running the suite.
  });

  test('A5-structural: not_a_git_repo classification does not depend on stderr content (regression for #3586)', (t) => {
    const cwd = createTempDir('gsd-3586-a5-structural-');
    t.after(() => cleanup(cwd));
    mockGitSpawnNotARepoNoStderr(t);

    const snap = buildPlanningSnapshot(cwd);
    // Both `ls-files` and the structural `rev-parse` probe fail here with
    // EMPTY stderr (no "not a git repository" string anywhere) — the old
    // stderr-regex implementation would have misclassified this as
    // `git_list_failed`. The fix classifies structurally from the probe's
    // exit code alone, so this still correctly reads `not_a_git_repo`.
    assert.strictEqual(snap.planningTracked.scope, SCOPE.UNREADABLE);
    assert.strictEqual(snap.planningTracked.reason, 'not_a_git_repo');
  });

  test('happy path issues exactly ONE git subprocess for planningTracked (no rev-parse probe when ls-files succeeds)', (t) => {
    const cwd = createTempGitProject('gsd-3586-one-call-');
    t.after(() => cleanup(cwd));

    const originalSpawnSync = childProcess.spawnSync;
    let lsFilesCalls = 0;
    let revParseProbeCalls = 0;
    t.mock.method(childProcess, 'spawnSync', (cmd, args, opts) => {
      if (cmd === 'git' && Array.isArray(args)) {
        if (args.includes('ls-files')) lsFilesCalls += 1;
        if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) revParseProbeCalls += 1;
      }
      return originalSpawnSync.call(childProcess, cmd, args, opts);
    });

    const snap = buildPlanningSnapshot(cwd);
    assert.strictEqual(snap.planningTracked.scope, SCOPE.COMPLETE);
    assert.strictEqual(lsFilesCalls, 1, 'ls-files must run exactly once on the happy path');
    assert.strictEqual(
      revParseProbeCalls,
      0,
      'the rev-parse probe must NOT run when ls-files succeeds — the happy path stays a single subprocess',
    );
  });

  // ─── ENOBUFS overflow (#3586 review F2) ────────────────────────────────────
  // `execGit` sets no `maxBuffer`, so a `.planning/` tree with enough tracked
  // paths to exceed spawnSync's Node-default 1MB stdout cap makes `ls-files`
  // fail with `error.code === 'ENOBUFS'`. Treating that like any other
  // non-zero-exit failure (scope UNREADABLE, silent downstream) would hide
  // W029 in exactly the large-tracked-history case it exists to catch — the
  // overflow itself is proof `ls-files` had non-empty output, so `tracked`
  // must read `true`, not degrade.

  test('A13: git ls-files ENOBUFS overflow is treated as proof of tracking, not a failure', (t) => {
    const cwd = createTempGitProject('gsd-3586-a13-enobufs-');
    t.after(() => cleanup(cwd));
    writeGitignore(cwd, '.planning/\n');
    commitAll(cwd, 'add gitignore');
    mockGitSpawnEnobufs(t);

    const snap = buildPlanningSnapshot(cwd);
    assert.deepStrictEqual(snap.planningTracked, {
      value: { tracked: true, ignored: true },
      scope: SCOPE.COMPLETE,
      reason: 'ok_truncated',
    });
  });
});
