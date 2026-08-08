/**
 * Tests for the phase-ENUMERATION single-owner contract (#3185, epic #3180
 * Phase 3, ADR-3180 Decision 1 row "Phase enumeration").
 * Matrix: .gsd/phase/refactor-3185-phase-enumeration-single-owner/50-test-matrix.md
 *
 * This file lands FAILING-FIRST. Every test below asserts the behavior the
 * design requires and that the tree does NOT have yet, so the remote runner
 * records a real RED before the fix.
 *
 * Rows covered here are the ones with direct code evidence in the design:
 *   - row 36  `progress` lists 999.* backlog dirs as current-milestone phases
 *   - row 39  a `0-*` sentinel directory is listed by `stats`/`progress`
 *   - row 14  negative space: `P0.0-foundation` is a REAL phase (#1324
 *             letter-prefixed-decimal family), not sentinel milestone 0
 *   - row 38  a `### Phase 999.1:` ROADMAP heading produces a `stats` row
 *   - row 43  `phases clear --confirm` DELETES a `0-*` directory, because
 *             cmdPhasesClear carries its own 5th sentinel copy
 *             (`/^999(?:\.|$)/`) excluding 999 but NOT 0 — while
 *             `roadmap analyze` treats Phase 0 as a sentinel to preserve.
 *
 * Assertions are on `--json` output (a typed surface), never on rendered
 * prose — CONTRIBUTING.md bans raw-text matching on test outputs. Row 43 also
 * carries the NEGATIVE PROOF that the directory still exists on disk, because
 * an exit code alone cannot distinguish "refused" from "deleted and reported
 * success".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTempProject,
  createTempGitProject,
  cleanup,
  runGsdTools,
} = require('./helpers.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');

// ─── Fixture helpers ───────────────────────────────────────────────────────

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, lines) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), lines.join('\n'));
}

function writeState(cwd, fields) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), lines.join('\n'));
}

/** Create `<cwd>/.planning/phases/<dirName>/` and optionally seed files. */
function makePhaseDir(cwd, dirName, files = {}) {
  const dir = path.join(planningDirOf(cwd), 'phases', dirName);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/** A ROADMAP with a real current milestone plus a 999 backlog heading. */
function roadmapWithBacklog() {
  return [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foundation',
    '',
    '**Goal:** lay the foundation',
    '',
    '### Phase 999.1: Icebox item',
    '',
    '**Goal:** someday',
    '',
  ];
}

function parseJson(result, label) {
  assert.ok(result.success, `${label} should exit 0: ${result.error || ''}`);
  try {
    return JSON.parse(result.output);
  } catch (err) {
    throw new Error(`${label} did not emit parseable JSON: ${err.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Row 36 — `progress` must not list 999.* backlog dirs as milestone phases
// ═════════════════════════════════════════════════════════════════════════

test('progress does not list a 999 backlog directory as a current-milestone phase', (t) => {
  const cwd = createTempProject('gsd-phase-enum-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithBacklog());
  makePhaseDir(cwd, '01-foundation', { '01-PLAN.md': '# Plan\n' });
  makePhaseDir(cwd, '999.1-icebox', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('progress json', cwd), 'progress json');

  const numbers = (report.phases || []).map((p) => String(p.number));
  assert.ok(
    !numbers.some((n) => n.startsWith('999')),
    `999.* backlog directories must not appear as current-milestone phases; got ${JSON.stringify(numbers)}`,
  );
  assert.ok(
    numbers.includes('01') || numbers.includes('1'),
    `the real in-window phase must still be listed; got ${JSON.stringify(numbers)}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Row 39 / row 14 — phase-0 sentinel vs the letter-prefixed-decimal family
// ═════════════════════════════════════════════════════════════════════════

test('progress does not list a phase-0 sentinel directory', (t) => {
  const cwd = createTempProject('gsd-phase-enum-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithBacklog());
  makePhaseDir(cwd, '0-prep', { '01-PLAN.md': '# Plan\n' });
  makePhaseDir(cwd, '01-foundation', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('progress json', cwd), 'progress json');

  const numbers = (report.phases || []).map((p) => String(p.number));
  assert.ok(
    !numbers.some((n) => /^0+$/.test(n)),
    `phase-0 sentinel directories must not appear as milestone phases; got ${JSON.stringify(numbers)}`,
  );
});

test('a letter-prefixed decimal directory is NOT read as a phase-0 sentinel', (t) => {
  // Negative space (matrix row 14): `P0.0-foundation` is a real phase from the
  // #1324 letter-prefixed-decimal family, NOT sentinel milestone 0. A sentinel
  // rule that strips a bare letter prefix would silently delete this family
  // from three commands.
  const cwd = createTempProject('gsd-phase-enum-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    '### Phase P0.0: Foundation',
    '',
    '**Goal:** real work',
    '',
  ]);
  makePhaseDir(cwd, 'P0.0-foundation', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('progress json', cwd), 'progress json');
  const numbers = (report.phases || []).map((p) => String(p.number));
  assert.ok(
    numbers.length > 0,
    'a letter-prefixed decimal phase must survive the sentinel filter, not be dropped as milestone 0',
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Row 38 — a 999 ROADMAP heading must not produce a `stats` row
// ═════════════════════════════════════════════════════════════════════════

test('stats does not emit a row for a 999 backlog heading with no directory', (t) => {
  const cwd = createTempProject('gsd-phase-enum-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithBacklog());
  makePhaseDir(cwd, '01-foundation', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('stats json', cwd), 'stats json');

  const numbers = (report.phases || []).map((p) => String(p.number));
  assert.ok(
    !numbers.some((n) => n.startsWith('999')),
    `a 999 heading must not seed a stats row; got ${JSON.stringify(numbers)}`,
  );
});

test('stats does not list a phase-0 sentinel directory', (t) => {
  const cwd = createTempProject('gsd-phase-enum-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithBacklog());
  makePhaseDir(cwd, '0-prep', { '01-PLAN.md': '# Plan\n' });
  makePhaseDir(cwd, '01-foundation', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('stats json', cwd), 'stats json');
  const numbers = (report.phases || []).map((p) => String(p.number));
  assert.ok(
    !numbers.some((n) => /^0+$/.test(n)),
    `phase-0 sentinel directories must not appear in stats; got ${JSON.stringify(numbers)}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Row 43 — the destructive path: `phases clear` must not delete a sentinel
// ═════════════════════════════════════════════════════════════════════════

test('phases clear preserves a phase-0 sentinel directory, with negative proof on disk', (t) => {
  // cmdPhasesClear carries the FIFTH copy of the sentinel rule and the THIRD
  // regex variant — `/^999(?:\.|$)/` — which excludes 999 but NOT 0. So a
  // `0-*` directory that `roadmap analyze` treats as a preserved sentinel is
  // DELETED here. The exit code alone cannot show this, so the load-bearing
  // assertion is that the directory still exists afterwards.
  const cwd = createTempGitProject('gsd-phase-enum-clear-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithBacklog());
  const zeroDir = makePhaseDir(cwd, '0-prep', { '01-PLAN.md': '# Plan\n' });
  const backlogDir = makePhaseDir(cwd, '999.1-icebox', { '01-PLAN.md': '# Plan\n' });
  makePhaseDir(cwd, '01-foundation', { '01-PLAN.md': '# Plan\n' });

  runGsdTools('phases clear --confirm --force', cwd);

  assert.ok(
    fs.existsSync(zeroDir),
    'a phase-0 sentinel directory must be preserved by `phases clear`, exactly as the 999 sentinel already is',
  );
  assert.ok(
    fs.existsSync(backlogDir),
    'the 999 sentinel directory must remain preserved (unchanged behavior)',
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Rows 7-9 — the PASS-ALL degrade, which is where the defect actually lives
//
// When the milestone window yields NO phase headings, getMilestonePhaseFilter
// degrades to a literal `() => true` predicate and stops consulting its
// heading set at all — so its `/^999\b/` heading-side sentinel exclusion
// becomes unreachable and every directory on disk is reported as a
// current-milestone phase. A fixture that contains phase headings keeps the
// filter ACTIVE and never exercises this path, which is why the sibling
// phase-0 test above passes today for the wrong reason.
// ═════════════════════════════════════════════════════════════════════════

/** A ROADMAP whose current milestone declares NO phases — the pass-all path. */
function roadmapWithNoPhaseHeadings() {
  return [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    'This milestone has been declared but has no phases yet.',
    '',
  ];
}

test('pass-all degrade still excludes a 999 sentinel directory', (t) => {
  const cwd = createTempProject('gsd-phase-enum-passall-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithNoPhaseHeadings());
  makePhaseDir(cwd, '999.1-icebox', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('progress json', cwd), 'progress json');
  const numbers = (report.phases || []).map((p) => String(p.number));
  assert.ok(
    !numbers.some((n) => n.startsWith('999')),
    `the pass-all degrade must still filter sentinels; got ${JSON.stringify(numbers)}`,
  );
});

test('pass-all degrade still excludes a phase-0 sentinel directory', (t) => {
  const cwd = createTempProject('gsd-phase-enum-passall-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithNoPhaseHeadings());
  makePhaseDir(cwd, '0-prep', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('progress json', cwd), 'progress json');
  const numbers = (report.phases || []).map((p) => String(p.number));
  assert.ok(
    !numbers.some((n) => /^0+$/.test(n)),
    `the pass-all degrade must still filter phase-0 sentinels; got ${JSON.stringify(numbers)}`,
  );
});

test('pass-all degrade stays over-inclusive for NON-sentinel directories', (t) => {
  // Negative space (matrix row 9): the narrowing is sentinel-only. The
  // documented "over-inclusive, never under-inclusive" promise in
  // getMilestonePhaseFilter's own comment is narrowed minimally, not revoked —
  // an ordinary phase directory must still be listed when the window declares
  // no phases, or a project mid-migration loses its real phases from view.
  const cwd = createTempProject('gsd-phase-enum-passall-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithNoPhaseHeadings());
  makePhaseDir(cwd, '04-thing', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('progress json', cwd), 'progress json');
  const numbers = (report.phases || []).map((p) => String(p.number));
  assert.ok(
    numbers.length > 0,
    'an ordinary phase directory must still be listed under the pass-all degrade',
  );
});

// ═════════════════════════════════════════════════════════════════════════
// `phases list` — ADR-3180 Decision 4(c): the identity assertion belongs at
// EACH consumer's own observable output, not only at progress/stats.
// ═════════════════════════════════════════════════════════════════════════

test('phases list excludes a 999 backlog dir and a 0-sentinel dir, keeps the real one', (t) => {
  const cwd = createTempProject('gsd-phase-enum-list-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithBacklog());
  makePhaseDir(cwd, '01-foundation', { '01-PLAN.md': '# Plan\n' });
  makePhaseDir(cwd, '999.1-icebox', { '01-PLAN.md': '# Plan\n' });
  makePhaseDir(cwd, '0-prep', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('phases list', cwd), 'phases list');
  const dirs = report.directories || [];

  assert.ok(
    !dirs.some((d) => d.startsWith('999')),
    `999.* backlog directories must not appear in phases list; got ${JSON.stringify(dirs)}`,
  );
  assert.ok(
    !dirs.some((d) => /^0(?:[-.]|$)/.test(d)),
    `phase-0 sentinel directories must not appear in phases list; got ${JSON.stringify(dirs)}`,
  );
  assert.ok(
    dirs.includes('01-foundation'),
    `the real in-window phase directory must still be listed; got ${JSON.stringify(dirs)}`,
  );
});

test('phases list --phase still finds an out-of-window phase (documented exemption)', (t) => {
  const cwd = createTempProject('gsd-phase-enum-list-lookup-');
  t.after(() => cleanup(cwd));

  // v1.0 is current; phase 5 belongs to a different (later) milestone and is
  // never mentioned in v1.0's window, so it is genuinely OUT-OF-WINDOW.
  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foundation',
    '',
    '## v2.0 Next',
    '',
    '### Phase 5: Later Work',
    '',
  ]);
  makePhaseDir(cwd, '01-foundation', { '01-PLAN.md': '# Plan\n' });
  makePhaseDir(cwd, '05-later-work', { '01-PLAN.md': '# Plan\n' });

  const result = runGsdTools('phases list --phase 5', cwd);
  const report = parseJson(result, 'phases list --phase 5');

  assert.strictEqual(
    report.error,
    undefined,
    `--phase lookup must find an out-of-window phase by design (ADR-3180 Decision 4a); got ${JSON.stringify(report)}`,
  );
  assert.deepStrictEqual(report.directories, ['05-later-work']);
});

// ═════════════════════════════════════════════════════════════════════════
// `phase_scope` — epic #3180 Done-when #7: the enumeration path can fail
// distinguishably. Mirrors the TRUNCATED fixture shape from
// tests/milestone-window-single-owner.test.cjs's buildTruncatedFixture: an
// ACTIVE milestone heading with no phase headings inside its own window,
// followed by a later milestone heading whose section DOES carry phase
// headings -- the window closes before the phase region.
// ═════════════════════════════════════════════════════════════════════════

function writeTruncatedRoadmap(cwd) {
  writeRoadmap(cwd, [
    '# Roadmap',
    '',
    '## v3.0 In Progress 🚧',
    '',
    'Some preamble notes. No phase headings here.',
    '',
    '## v4.0 Next',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
    '',
  ]);
}

test('progress json phase_scope is not complete when the milestone window is truncated', (t) => {
  const cwd = createTempProject('gsd-phase-enum-scope-truncated-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v3.0' });
  writeTruncatedRoadmap(cwd);
  makePhaseDir(cwd, '1-foo', { '01-PLAN.md': '# Plan\n' });
  makePhaseDir(cwd, '2-bar', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('progress json', cwd), 'progress json');
  assert.notStrictEqual(
    report.phase_scope,
    SCOPE.COMPLETE,
    `a truncated window must not report phase_scope: "complete"; got ${JSON.stringify(report.phase_scope)}`,
  );
});

test('progress json phase_scope is complete for a healthy, in-window fixture', (t) => {
  const cwd = createTempProject('gsd-phase-enum-scope-complete-');
  t.after(() => cleanup(cwd));

  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, roadmapWithBacklog());
  makePhaseDir(cwd, '01-foundation', { '01-PLAN.md': '# Plan\n' });

  const report = parseJson(runGsdTools('progress json', cwd), 'progress json');
  assert.strictEqual(report.phase_scope, SCOPE.COMPLETE);
});
