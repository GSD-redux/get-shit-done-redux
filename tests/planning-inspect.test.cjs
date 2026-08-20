'use strict';

/**
 * Tests for `src/planning-inspect.cts` — the schema-v1 canonical planning
 * snapshot (`query planning inspect` / `query planning.inspect`, #2790).
 *
 * Design:       .gsd/phase/feat-2790-planning-inspect/40-design.md
 * Test matrix:  .gsd/phase/feat-2790-planning-inspect/50-test-matrix.md
 *
 * Fixture provenance (CONTRIBUTING.md "Fixture provenance (#2371)"): every
 * `.planning/` document shape written by this file's fixture builders is
 * derived from the SHIPPED templates the product author wrote —
 * `gsd-core/templates/requirements.md` (checkbox bullets, `## Traceability`
 * table), `gsd-core/templates/phase-prompt.md` (the `<task>` XML grammar and
 * `## Task N` legacy heading fallback), `gsd-core/templates/summary.md`
 * (`## Files Created/Modified`, `## Deviations from Plan` / `**Found
 * during:**` / `**Files modified:**`), `gsd-core/templates/state.md`
 * (`## Current Position`), and `gsd-core/templates/roadmap.md` (`## Phases`
 * checkbox list, `### Phase N: Name` headings) — never from
 * `planning-inspect.cts`'s own parsing model. `planning.inspect` has no
 * writer of its own (it is read-only), so the property-test generator in
 * this file (`propertySchemaIsTotalOverDocumentShapedInputs`) is
 * document-shaped from those same templates, not seeded from the module
 * under test.
 *
 * `runGsdTools(['query', 'planning', 'inspect'], tmpDir)` is the invocation
 * shape used throughout — array form, shell-bypassed, safe for hostile
 * fixture values (CONTRIBUTING "CLI and command routing").
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempProject, createTempDir, cleanup, runGsdTools, toPosixPath } = require('./helpers.cjs');

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function phasesDirOf(cwd) {
  return path.join(planningDirOf(cwd), 'phases');
}

function phaseDirOf(cwd, token) {
  return path.join(phasesDirOf(cwd), token);
}

function writeAbs(fullPath, content) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function writeFile(cwd, relPath, content) {
  writeAbs(path.join(cwd, relPath), content);
}

function frontmatterDoc(frontmatterLines, bodyLines, eol) {
  return ['---', ...frontmatterLines, '---', '', ...bodyLines].join(eol);
}

function writeRoadmap(cwd, lines, eol = '\n') {
  writeFile(cwd, '.planning/ROADMAP.md', lines.join(eol));
}

function writeState(cwd, frontmatterLines, bodyLines = [], eol = '\n') {
  writeFile(cwd, '.planning/STATE.md', frontmatterDoc(frontmatterLines, bodyLines, eol));
}

function writeRequirements(cwd, content) {
  writeFile(cwd, '.planning/REQUIREMENTS.md', content);
}

function writePlanDoc(phaseDir, fileName, frontmatterLines, bodyLines, eol = '\n') {
  writeAbs(path.join(phaseDir, fileName), frontmatterDoc(frontmatterLines, bodyLines, eol));
}

function writeSummaryDoc(phaseDir, fileName, frontmatterLines, bodyLines, eol = '\n') {
  writeAbs(path.join(phaseDir, fileName), frontmatterDoc(frontmatterLines, bodyLines, eol));
}

function writeVerification(phaseDir, phaseToken, status, eol = '\n') {
  writeAbs(path.join(phaseDir, `${phaseToken}-VERIFICATION.md`), ['---', `status: ${status}`, '---', ''].join(eol));
}

function writeUatDoc(phaseDir, phaseToken, bodyLines, eol = '\n') {
  writeAbs(path.join(phaseDir, `${phaseToken}-UAT.md`), bodyLines.join(eol));
}

/** Slugify a phase name the same way `getPhaseDirFromPhaseId` (`src/phase-id.cts`) does. */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The on-disk directory token for phase `token`/`name` — zero-padded numeric
 * prefix + slug (`"01-auth"`), matching `tests/planning-snapshot.test.cjs`'s
 * fixtures and every real project (phases are never named by a bare `"1"`).
 * Deliberately DIFFERENT from the bare numeric token the ROADMAP prose itself
 * carries (`"Phase 1"`) — that mismatch (directory `phaseKeyFromDir`-keyed,
 * ROADMAP `phaseKeyFromToken`-keyed) is exactly what a real project looks
 * like, and exactly what `planning-inspect.cts`'s roadmap-checkbox lookup
 * must reconcile through the phase-id owners rather than raw string equality.
 */
function slugPhaseDirName(token, name) {
  return `${String(token).padStart(2, '0')}-${slugify(name)}`;
}

/**
 * Declare one phase in STATE.md + ROADMAP.md (milestone window), matching
 * `gsd-core/templates/roadmap.md`'s `### Phase N: Name` heading shape and
 * `gsd-core/templates/state.md`'s frontmatter shape. The ROADMAP prose
 * (heading + checkbox bullet) carries the BARE numeric token, exactly as real
 * ROADMAP.md documents do — `buildRoadmapPhaseCheckboxesField` and the
 * requirement-traceability parser both capture this bare form. The returned
 * directory is the SLUGGED convention (`slugPhaseDirName`), matching real
 * projects and `tests/planning-snapshot.test.cjs`'s own fixtures.
 */
function declarePhase(cwd, token, name, { checkedInPhaseList = false } = {}) {
  writeState(cwd, ["gsd_state_version: '1.0'", 'status: planning']);
  const phaseListLine = checkedInPhaseList
    ? `- [x] **Phase ${token}: ${name}** - stub`
    : `- [ ] **Phase ${token}: ${name}** - stub`;
  writeRoadmap(cwd, [
    '## v1.0 Current 🚧',
    '',
    '## Phases',
    '',
    phaseListLine,
    '',
    `### Phase ${token}: ${name}`,
    '',
  ]);
  return phaseDirOf(cwd, slugPhaseDirName(token, name));
}

/** A healthy two-phase project: both phases complete, requirements mapped. */
function buildHealthyFixture(cwd, eol = '\n') {
  writeState(cwd, ["gsd_state_version: '1.0'", 'status: planning'], [], eol);
  writeRoadmap(cwd, [
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
    '',
  ], eol);
  writeRequirements(cwd, [
    '# Requirements: Test',
    '',
    '## v1 Requirements',
    '',
    '- [x] **AUTH-01**: User can sign up',
    '- [ ] **AUTH-02**: User can log in',
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    '| AUTH-01 | Phase 1 | Complete |',
    '| AUTH-02 | Phase 2 | Pending |',
    '',
  ].join(eol));

  for (const [token, name] of [['1', 'foo'], ['2', 'bar']]) {
    const phaseDir = phaseDirOf(cwd, slugPhaseDirName(token, name));
    writePlanDoc(phaseDir, `${token}-01-PLAN.md`, ['wave: 1'], [
      '<objective>',
      `Ship ${name}`,
      '</objective>',
      '',
      '<tasks>',
      '',
      '<task type="auto">',
      `  <name>Task 1: Build ${name}</name>`,
      `  <files>src/${name}.ts</files>`,
      '  <action>Build it</action>',
      '  <done>Done</done>',
      '</task>',
      '',
      '</tasks>',
    ], eol);
    writeSummaryDoc(phaseDir, `${token}-01-SUMMARY.md`, ['status: complete'], [
      '# Summary',
      '',
      '## Files Created/Modified',
      `- \`src/${name}.ts\` - ${name}`,
    ], eol);
    writeVerification(phaseDir, token, 'passed', eol);
  }
}

/** Recursive {relPath -> {size, mtimeMs}} snapshot of `.planning/`, for read-only proof. */
function snapshotPlanningTree(cwd) {
  const root = planningDirOf(cwd);
  const snap = {};
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      snap[rel] = { size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }
  if (fs.existsSync(root)) walk(root);
  return snap;
}

/** JSON round-trip with the fixture's own absolute cwd replaced by a stable placeholder. */
function stripCwd(payload, cwd) {
  const cwdPosix = toPosixPath(cwd);
  const json = JSON.stringify(payload).split(cwdPosix).join('<CWD>').split(cwd).join('<CWD>');
  return JSON.parse(json);
}

const EXPECTED_TOP_LEVEL_KEYS = [
  'active', 'diagnostics', 'generated_from', 'milestone', 'orphan_phase_dirs',
  'phases', 'progress', 'requirements', 'schema_version',
].sort();

const EXPECTED_PHASE_ROW_KEYS = [
  'complete', 'dir', 'phase_id', 'plan_count', 'plans',
  'roadmap_acceptance', 'scope', 'summary_count', 'uat', 'verification',
].sort();

function sortedKeys(obj) {
  return Object.keys(obj).sort();
}

function runInspect(tmpDir, extraArgs = []) {
  return runGsdTools(['query', 'planning', 'inspect', ...extraArgs], tmpDir);
}

function parseInspect(tmpDir, extraArgs = []) {
  const result = runInspect(tmpDir, extraArgs);
  assert.strictEqual(result.success, true, `planning inspect should succeed: ${result.error}`);
  return JSON.parse(result.output);
}

function runInspectJsonError(tmpDir, extraArgs) {
  const result = runGsdTools(['query', 'planning', 'inspect', ...extraArgs, '--json-errors'], tmpDir);
  assert.strictEqual(result.success, false, `expected failure for args: ${extraArgs.join(' ')}`);
  let parsed;
  try {
    parsed = JSON.parse(result.error);
  } catch (e) {
    throw new Error(`--json-errors must emit valid JSON on stderr; got: ${result.error}\nparse error: ${e.message}`);
  }
  assert.strictEqual(parsed.ok, false);
  return parsed;
}

// ─── 1. Schema contract ─────────────────────────────────────────────────────────

describe('planning inspect — schema contract', () => {
  test('emitsSchemaV1SnapshotForPopulatedProject', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.strictEqual(payload.schema_version, 1);
  });

  test('locksTopLevelSchemaKeySet', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const payload = parseInspect(tmpDir);
    assert.deepStrictEqual(sortedKeys(payload), EXPECTED_TOP_LEVEL_KEYS);
  });

  test('locksSchemaVersionConstantAgainstTheExportedModule', () => {
    // Loading a module's exported runtime value, not source-grepping text.
    const planningInspectLib = require('../gsd-core/bin/lib/planning-inspect.cjs');
    assert.strictEqual(planningInspectLib.PLANNING_INSPECT_SCHEMA_VERSION, 1);
  });

  test('locksDiagnosticTaskStatusProvenanceAndAgreementEnums', () => {
    const planningInspectLib = require('../gsd-core/bin/lib/planning-inspect.cjs');

    const expectedDiagnosticKeys = [
      'PLANNING_ROOT_ABSENT', 'ROADMAP_UNSCOPED', 'REQUIREMENTS_ABSENT', 'REQUIREMENTS_UNREADABLE',
      'REQUIREMENT_DUPLICATE', 'REQUIREMENT_UNMAPPED', 'REQUIREMENT_PHASE_UNKNOWN',
      'REQUIREMENT_COMPLETION_UNKNOWN', 'ORPHAN_PHASE_DIR', 'PHASE_SCOPE_DEGRADED',
      'PLAN_UNREADABLE', 'SUMMARY_UNREADABLE', 'TASK_SHAPE_CHECKPOINT',
      'TASK_CHANGED_FILES_PLAN_SCOPED', 'TASK_CHANGED_FILES_CONFLICTING',
      'UAT_ABSENT', 'UAT_UNREADABLE', 'PERCENT_WITHHELD',
    ].sort();
    assert.deepStrictEqual(sortedKeys(planningInspectLib.INSPECT_DIAGNOSTIC), expectedDiagnosticKeys);

    assert.deepStrictEqual(sortedKeys(planningInspectLib.TASK_STATUS), ['DONE', 'PENDING', 'UNKNOWN'].sort());
    assert.deepStrictEqual(sortedKeys(planningInspectLib.PROVENANCE), ['ABSENT', 'PLAN_SCOPED', 'TASK_SCOPED'].sort());
    assert.deepStrictEqual(sortedKeys(planningInspectLib.AGREEMENT), ['AGREED', 'CONFLICTING', 'UNKNOWN'].sort());
  });

  test('dottedAndSpacedInvocationsAgree', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const spaced = parseInspect(tmpDir);
    const dottedResult = runGsdTools(['query', 'planning.inspect'], tmpDir);
    assert.strictEqual(dottedResult.success, true, `expected success: ${dottedResult.error}`);
    const dotted = JSON.parse(dottedResult.output);

    assert.deepStrictEqual(dotted, spaced);
  });
});

// ─── 2. Dispatch / usage ──────────────────────────────────────────────────────

describe('planning inspect — dispatch and usage', () => {
  test('rejectsPlanningFamilyWithNoSubcommand', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['query', 'planning'], tmpDir);
    assert.strictEqual(result.success, false);
  });

  test('rejectsUnknownPlanningSubcommand', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['query', 'planning', 'bogus'], tmpDir);
    assert.strictEqual(result.success, false);
  });

  test('rejectsStrayPositionalArgumentWithUsageReason', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const parsed = runInspectJsonError(tmpDir, ['extra']);
    assert.strictEqual(parsed.reason, 'usage');
  });

  test('rejectsUnknownFlagWithUsageReason', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const parsed = runInspectJsonError(tmpDir, ['--nope']);
    assert.strictEqual(parsed.reason, 'usage');
  });

  test('rejectsScopingFlagsNotSupportedInV1WithUsageReason', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const parsed = runInspectJsonError(tmpDir, ['--phase', '3']);
    assert.strictEqual(parsed.reason, 'usage');
  });

  test('neverPrintsStackTraceOnUsageFailure', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runInspect(tmpDir, ['extra']);
    assert.strictEqual(result.success, false);
    // Structural "did our own error envelope leak a raw stack" proof — the
    // established repo pattern (tests/commands.test.cjs, tests/config-get-default.test.cjs).
    assert.strictEqual(/\n\s*at\s/.test(result.error), false, `stderr must not carry a stack trace: ${result.error}`);
  });
});

// ─── 3. Read-only proof ───────────────────────────────────────────────────────

describe('planning inspect — read-only proof', () => {
  test('mutatesNothingUnderPlanningDirOnASuccessfulRun', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const before = snapshotPlanningTree(tmpDir);
    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    const after = snapshotPlanningTree(tmpDir);
    assert.deepStrictEqual(after, before);
  });

  test('mutatesNothingEvenWhenAPlanDocumentIsUnreadable', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    // Directory-in-file-position (no chmod; root-proof, cross-platform):
    // readDocument() sees `!stat.isFile()` and reports unreadable.
    fs.mkdirSync(path.join(phaseDir, '1-01-PLAN.md'), { recursive: true });

    const before = snapshotPlanningTree(tmpDir);
    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    const after = snapshotPlanningTree(tmpDir);
    assert.deepStrictEqual(after, before);
  });
});

// ─── 4. Degradation and scope ─────────────────────────────────────────────────

describe('planning inspect — degradation and scope', () => {
  test('degradesCleanlyWithNoPlanningDirAtAll', (t) => {
    const tmpDir = createTempDir();
    t.after(() => cleanup(tmpDir));

    const payload = parseInspect(tmpDir);
    assert.deepStrictEqual(sortedKeys(payload), EXPECTED_TOP_LEVEL_KEYS);
    assert.ok(payload.diagnostics.some((d) => d.code === 'planning_root_absent'));
  });

  test('distinguishesAbsentRequirementsFileFromEmpty', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    // REQUIREMENTS.md deliberately not written.

    const payload = parseInspect(tmpDir);
    assert.deepStrictEqual(payload.requirements, []);
    assert.ok(payload.diagnostics.some((d) => d.code === 'requirements_absent'));
  });

  test('treatsAnEmptyRequirementsFileAsARealEmptyAnswerNotAnAbsentOne', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    writeRequirements(tmpDir, '');

    const payload = parseInspect(tmpDir);
    assert.deepStrictEqual(payload.requirements, []);
    assert.ok(!payload.diagnostics.some((d) => d.code === 'requirements_absent'));
  });

  test('flagsCheckboxOnlyRequirementWithNoTraceabilityRowAsUnmapped', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      '- [ ] **REQ-01**: Something to build',
      '',
    ].join('\n'));

    const payload = parseInspect(tmpDir);
    const row = payload.requirements.find((r) => r.id === 'REQ-01');
    assert.ok(row, 'REQ-01 row must be present');
    assert.deepStrictEqual(row.mappedPhases, []);
    assert.ok(payload.diagnostics.some((d) => d.code === 'requirement_unmapped' && d.subject === 'REQ-01'));
  });

  test('flagsRequirementMappedToAPhaseNotPresentOnDisk', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      '- [ ] **REQ-02**: Something',
      '',
      '## Traceability',
      '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| REQ-02 | Phase 9 | Pending |',
      '',
    ].join('\n'));

    const payload = parseInspect(tmpDir);
    const row = payload.requirements.find((r) => r.id === 'REQ-02');
    assert.ok(row, 'REQ-02 row must be present');
    assert.deepStrictEqual(row.mappedPhases, ['9']);
    assert.ok(payload.diagnostics.some((d) => d.code === 'requirement_phase_unknown' && d.subject === 'REQ-02->9'));
  });

  test('flagsDuplicateRequirementIdNamingTheDuplicatedId', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      '- [ ] **REQ-03**: First occurrence',
      '- [ ] **REQ-03**: Second occurrence (duplicate)',
      '',
    ].join('\n'));

    const payload = parseInspect(tmpDir);
    assert.ok(payload.diagnostics.some((d) => d.code === 'requirement_duplicate' && d.subject === 'REQ-03'));
  });

  test('reportsUndeclaredPhaseDirAsOrphanNotAsAPhase', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    fs.mkdirSync(phaseDirOf(tmpDir, '99-stray'), { recursive: true });

    const payload = parseInspect(tmpDir);
    assert.deepStrictEqual(payload.orphan_phase_dirs, ['99-stray']);
    assert.ok(!payload.phases.some((p) => p.dir === '99-stray'));
    assert.ok(payload.diagnostics.some((d) => d.code === 'orphan_phase_dir' && d.subject === '99-stray'));
  });
});

// ─── 5. Never-infer boundary ──────────────────────────────────────────────────

describe('planning inspect — never infers task-level file provenance', () => {
  test('reportsAbsentProvenanceWhenATaskHasFilesButNoSummaryExists', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>', '',
      '<task type="auto">',
      '  <name>Task 1: Do it</name>',
      '  <files>src/a.ts</files>',
      '  <action>Do it</action>',
      '  <done>Done</done>',
      '</task>',
      '',
      '</tasks>',
    ]);
    // No SUMMARY.md written.

    const payload = parseInspect(tmpDir);
    const task = payload.phases[0].plans[0].tasks[0];
    assert.strictEqual(task.changedFiles, null);
    assert.strictEqual(task.provenance, 'absent');
  });

  test('neverAttributesPlanScopedSummaryFilesToAnIndividualTask', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>', '',
      '<task type="auto">',
      '  <name>Task 1: Build</name>',
      '  <files>src/a.ts</files>',
      '  <action>Build it</action>',
      '  <done>Done</done>',
      '</task>',
      '',
      '</tasks>',
    ]);
    writeSummaryDoc(phaseDir, '1-01-SUMMARY.md', ['status: complete'], [
      '# Summary',
      '',
      '## Files Created/Modified',
      '- `src/a.ts` - built',
    ]);

    const payload = parseInspect(tmpDir);
    const plan = payload.phases[0].plans[0];
    const task = plan.tasks[0];
    // Task-level half of the contract.
    assert.strictEqual(task.changedFiles, null);
    assert.strictEqual(task.provenance, 'plan_scoped');
    assert.ok(payload.diagnostics.some((d) => d.code === 'task_changed_files_plan_scoped'));
    // Plan-level half of the contract — the plan-scoped list still surfaces,
    // just never spread across tasks.
    assert.deepStrictEqual(plan.changedFiles, ['src/a.ts']);
  });

  test('attributesOnlyTheTaskTheSummaryDeviationBlockNames', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>', '',
      '<task type="auto">',
      '  <name>Task 1: Build</name>',
      '  <files>src/a.ts</files>',
      '  <action>Build it</action>',
      '  <done>Done</done>',
      '</task>',
      '',
      '<task type="auto">',
      '  <name>Task 2: Fix</name>',
      '  <files>src/b.ts, src/c.ts</files>',
      '  <action>Fix it</action>',
      '  <done>Done</done>',
      '</task>',
      '',
      '</tasks>',
    ]);
    writeSummaryDoc(phaseDir, '1-01-SUMMARY.md', ['status: complete'], [
      '# Summary',
      '',
      '## Files Created/Modified',
      '- `src/a.ts` - built',
      '',
      '## Deviations from Plan',
      '',
      '### Auto-fixed Issues',
      '',
      '**1. Some fix**',
      '- **Found during:** Task 2 (Fix)',
      '- **Issue:** something',
      '- **Files modified:** src/b.ts, src/c.ts',
      '- **Verification:** tests pass',
    ]);

    const payload = parseInspect(tmpDir);
    const tasks = payload.phases[0].plans[0].tasks;
    assert.deepStrictEqual(tasks[1].changedFiles, ['src/b.ts', 'src/c.ts']);
    assert.strictEqual(tasks[1].provenance, 'task_scoped');
    // Task 1 is untouched by the deviation block naming Task 2.
    assert.strictEqual(tasks[0].changedFiles, null);
    assert.strictEqual(tasks[0].provenance, 'plan_scoped');
  });

  test('emitsConflictingProvenanceWithoutReconcilingPlannedAndChangedFiles', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>', '',
      '<task type="auto">',
      '  <name>Task 1: Build</name>',
      '  <files>src/a.ts</files>',
      '  <action>Build it</action>',
      '  <done>Done</done>',
      '</task>',
      '',
      '</tasks>',
    ]);
    writeSummaryDoc(phaseDir, '1-01-SUMMARY.md', ['status: complete'], [
      '# Summary',
      '',
      '## Deviations from Plan',
      '',
      '### Auto-fixed Issues',
      '',
      '**1. Scope change**',
      '- **Found during:** Task 1 (Build)',
      '- **Issue:** plan undershot',
      '- **Files modified:** src/b.ts',
      '- **Verification:** tests pass',
    ]);

    const payload = parseInspect(tmpDir);
    const task = payload.phases[0].plans[0].tasks[0];
    assert.strictEqual(task.agreement, 'conflicting');
    assert.deepStrictEqual(task.plannedFiles, ['src/a.ts']);
    assert.deepStrictEqual(task.changedFiles, ['src/b.ts']);
    assert.ok(payload.diagnostics.some((d) => d.code === 'task_changed_files_conflicting'));
  });
});

// ─── 6. Evidence kept separate ─────────────────────────────────────────────────

describe('planning inspect — evidence kept separate, never folded', () => {
  test('keepsUnresolvedUatAndPassingVerificationSeparateWithNoCombinedVerdict', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writeVerification(phaseDir, '1', 'passed');
    writeUatDoc(phaseDir, '1', [
      '### 1. Check something',
      'expected: it works',
      'result: pending',
      '',
    ]);

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.strictEqual(phase.complete, true);
    assert.ok(phase.uat.unresolved.length > 0);
    // No combined verdict field exists alongside the raw evidence sources.
    assert.deepStrictEqual(sortedKeys(phase), EXPECTED_PHASE_ROW_KEYS);
  });

  test('roadmapAcceptanceIsNeverAuthoritativeOnAnyPhaseRow', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const payload = parseInspect(tmpDir);
    assert.ok(payload.phases.length > 0);
    for (const phase of payload.phases) {
      assert.strictEqual(phase.roadmap_acceptance.authoritative, false);
    }
  });

  test('roadmapCheckboxNeverOverridesDiskCompletion', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Checkbox ticked in ROADMAP, but no passing VERIFICATION on disk.
    declarePhase(tmpDir, '1', 'Foo', { checkedInPhaseList: true });

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.strictEqual(phase.complete, false);
    assert.strictEqual(phase.roadmap_acceptance.checkbox, true);
  });

  test('reports a ticked ROADMAP checkbox for a slugged phase directory', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // ROADMAP prose carries the BARE numeric token ("Phase 1"/"Phase 2"/
    // "Phase 3"), while the phase directories are the SLUGGED on-disk
    // convention ("01-auth" etc) — the real-world mismatch that made
    // `roadmap_acceptance.checkbox` always null: comparing
    // `checkboxes["1"]` against `phase.dir === "01-auth"` by raw string
    // equality never matches. Three phases distinguish all three checkbox
    // states so none of them collapses into another: ticked (true), unticked
    // (false), and no checkbox bullet at all (null, NOT false).
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning']);
    writeRoadmap(tmpDir, [
      '## v1.0 Current 🚧',
      '',
      '## Phases',
      '',
      '- [x] **Phase 1: Auth** - stub',
      '- [ ] **Phase 2: Billing** - stub',
      '',
      '### Phase 1: Auth',
      '',
      '### Phase 2: Billing',
      '',
      '### Phase 3: Reports',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Auth')), { recursive: true });
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('2', 'Billing')), { recursive: true });
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('3', 'Reports')), { recursive: true });

    const payload = parseInspect(tmpDir);
    const auth = payload.phases.find((p) => p.dir === '01-auth');
    const billing = payload.phases.find((p) => p.dir === '02-billing');
    const reports = payload.phases.find((p) => p.dir === '03-reports');
    assert.ok(auth, 'slugged phase directory 01-auth must be present as a phase row');
    assert.ok(billing, 'slugged phase directory 02-billing must be present as a phase row');
    assert.ok(reports, 'slugged phase directory 03-reports must be present as a phase row');

    assert.strictEqual(auth.roadmap_acceptance.checkbox, true);
    assert.strictEqual(auth.roadmap_acceptance.authoritative, false);
    assert.strictEqual(billing.roadmap_acceptance.checkbox, false);
    assert.strictEqual(billing.roadmap_acceptance.authoritative, false);
    // Phase 3 has no checkbox bullet under `## Phases` at all — `null` (no
    // evidence), never collapsed into `false` (unticked evidence).
    assert.strictEqual(reports.roadmap_acceptance.checkbox, null);
    assert.strictEqual(reports.roadmap_acceptance.authoritative, false);
  });
});

// ─── 7. Percent withholding ───────────────────────────────────────────────────

describe('planning inspect — percent withholding', () => {
  test('percentIsAnIntegerZeroToHundredForAHealthyProject', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const payload = parseInspect(tmpDir);
    const percent = payload.progress.accepted_phases.percent;
    assert.ok(Number.isInteger(percent) && percent >= 0 && percent <= 100, `got ${percent}`);
  });

  test('emitsZeroPercentNotNullNotHundredForAZeroPhaseButReadableProject', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning']);
    writeRoadmap(tmpDir, ['## v1.0 Current 🚧', '']);
    // No phase directories at all.

    const payload = parseInspect(tmpDir);
    assert.strictEqual(payload.progress.accepted_phases.percent, 0);
  });

  test('withholdsPercentAndFlagsItWhenThePhasesDirectoryIsUnreadable', (t) => {
    // Fault-injection level (CONTRIBUTING QA matrix "Integration + mock.method"):
    // mock.method cannot reach a spawned CLI subprocess, so this row calls the
    // built module directly — the same pattern tests/planning-snapshot.test.cjs
    // uses for its own readdirSync fault-injection rows.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const planningInspectLib = require('../gsd-core/bin/lib/planning-inspect.cjs');
    const phasesDir = phasesDirOf(tmpDir);
    const originalReaddirSync = fs.readdirSync;

    t.mock.method(fs, 'readdirSync', function mockedReaddirSync(target, ...rest) {
      if (target === phasesDir) {
        const err = new Error(`EACCES: permission denied, scandir '${phasesDir}'`);
        err.code = 'EACCES';
        throw err;
      }
      return originalReaddirSync.call(this, target, ...rest);
    });

    const payload = planningInspectLib.buildPlanningInspect(tmpDir);
    assert.strictEqual(payload.progress.accepted_phases.percent, null);
    assert.ok(payload.diagnostics.some((d) => d.code === 'percent_withheld'));
  });
});

// ─── 8. Task grammar ──────────────────────────────────────────────────────────

describe('planning inspect — task grammar', () => {
  test('emitsOneRowPerXmlTaskBlockInDocumentOrder', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>', '',
      '<task type="auto"><name>Task A</name><files>src/a.ts</files><action>a</action><done>done</done></task>',
      '<task type="auto"><name>Task B</name><files>src/b.ts</files><action>b</action><done>done</done></task>',
      '</tasks>',
    ]);

    const payload = parseInspect(tmpDir);
    const tasks = payload.phases[0].plans[0].tasks;
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].name, 'Task A');
    assert.strictEqual(tasks[1].name, 'Task B');
    assert.deepStrictEqual(tasks.map((task) => task.index), [1, 2]);
  });

  test('fallsBackToMarkdownTaskHeadingsWhenNoXmlTaskBlocksExist', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '## Task 1: First',
      '',
      '## Task 2: Second',
      '',
    ]);

    const payload = parseInspect(tmpDir);
    const tasks = payload.phases[0].plans[0].tasks;
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].kind, 'auto');
    assert.strictEqual(tasks[0].name, 'Task 1: First');
    assert.strictEqual(tasks[1].name, 'Task 2: Second');
  });

  test('xmlTaskBlocksWinOverMarkdownHeadingsWhenBothArePresent', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>',
      '<task type="auto"><name>Only XML task</name><files>src/a.ts</files><action>a</action><done>done</done></task>',
      '</tasks>',
      '',
      '## Task 1: Legacy heading one',
      '## Task 2: Legacy heading two',
      '## Task 3: Legacy heading three',
    ]);

    const payload = parseInspect(tmpDir);
    const tasks = payload.phases[0].plans[0].tasks;
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].name, 'Only XML task');
  });

  test('emitsCheckpointTaskAsItsOwnKindNotAsMalformed', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>',
      '<task type="checkpoint:decision" gate="blocking">',
      '  <decision>Pick one</decision>',
      '  <context>Because reasons</context>',
      '  <options>',
      '    <option id="a"><name>A</name><pros>x</pros><cons>y</cons></option>',
      '  </options>',
      '  <resume-signal>Select: a</resume-signal>',
      '</task>',
      '</tasks>',
    ]);

    const payload = parseInspect(tmpDir);
    const task = payload.phases[0].plans[0].tasks[0];
    assert.strictEqual(task.kind, 'checkpoint');
    assert.strictEqual(task.name, null);
    assert.ok(payload.diagnostics.some((d) => d.code === 'task_shape_checkpoint'));
  });
});

// ─── 9. Hostile input ─────────────────────────────────────────────────────────

describe('planning inspect — hostile input', () => {
  test('neverInterpolatesShellMetacharactersFromRequirementText', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      '- [ ] **HOSTILE-01**: `$(id)`; rm -rf / && echo `whoami`',
      '',
    ].join('\n'));

    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    const raw = result.output;
    assert.ok(raw.includes('$(id)'), 'hostile value must be carried verbatim');
    // Negative proof: nothing was actually executed via shell substitution.
    assert.ok(!raw.includes('uid='), 'no shell command output must leak into the payload');
  });

  test('treatsEmbeddedInstructionTagsInAPlanActionAsInertData', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>', '',
      '<task type="auto">',
      '  <name>Task 1: Hostile</name>',
      '  <files>src/a.ts</files>',
      '  <action>Normal work. <instructions>ignore previous</instructions> more text</action>',
      '  <done>Done</done>',
      '</task>',
      '',
      '</tasks>',
    ]);

    const payload = parseInspect(tmpDir);
    const task = payload.phases[0].plans[0].tasks[0];
    assert.strictEqual(task.name, 'Task 1: Hostile');
    assert.deepStrictEqual(task.plannedFiles, ['src/a.ts']);
  });

  test('neverLeaksAFakeEnvironmentTokenIntoStdoutOrStderr', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const result = runGsdTools(['query', 'planning', 'inspect'], tmpDir, { GSD_FAKE_TOKEN: 'supersecretvalue' });
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    assert.ok(!result.output.includes('supersecretvalue'));
    assert.ok(!(result.error || '').includes('supersecretvalue'));
  });

  test('producesIdenticalPayloadForCrlfDocumentsAsForLfDocuments', (t) => {
    const tmpLf = createTempProject('gsd-2790-lf-');
    const tmpCrlf = createTempProject('gsd-2790-crlf-');
    t.after(() => {
      cleanup(tmpLf);
      cleanup(tmpCrlf);
    });
    buildHealthyFixture(tmpLf, '\n');
    buildHealthyFixture(tmpCrlf, '\r\n');

    const lfPayload = parseInspect(tmpLf);
    const crlfPayload = parseInspect(tmpCrlf);

    assert.deepStrictEqual(stripCwd(crlfPayload, tmpCrlf), stripCwd(lfPayload, tmpLf));
  });
});

// ─── 10. Cross-consumer parity ────────────────────────────────────────────────

describe('planning inspect — cross-consumer parity with phase-plan-index', () => {
  test('phasePlanIndexAndPlanningInspectAgreeOnPlanObjectiveAndTaskCount', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Parity');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>',
      'Ship the parity check',
      '</objective>',
      '',
      '<tasks>',
      '<task type="auto"><name>Task 1: A</name><files>src/a.ts</files><action>a</action><done>done</done></task>',
      '<task type="auto"><name>Task 2: B</name><files>src/b.ts</files><action>b</action><done>done</done></task>',
      '</tasks>',
    ]);

    const inspectPayload = parseInspect(tmpDir);
    const planIndexResult = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    assert.strictEqual(planIndexResult.success, true, `phase-plan-index should succeed: ${planIndexResult.error}`);
    const planIndexPayload = JSON.parse(planIndexResult.output);

    const inspectPlan = inspectPayload.phases[0].plans[0];
    const indexPlan = planIndexPayload.plans.find((p) => p.id === inspectPlan.id);
    assert.ok(indexPlan, 'phase-plan-index must report the same plan id');

    assert.strictEqual(inspectPlan.objective, indexPlan.objective);
    assert.strictEqual(inspectPlan.tasks.length, indexPlan.task_count);
  });
});

// ─── 11. Property tests ───────────────────────────────────────────────────────

const EOL_ARB = fc.constantFrom('\n', '\r\n');

/**
 * Document-shaped: presence/absence of each document, 0..3 phases, 0..3
 * requirements, CRLF vs LF, empty vs populated — NOT seeded from
 * `planning-inspect.cts`'s own parsing model (see file-header provenance note).
 */
const PLANNING_PROJECT_SHAPE_ARB = fc.record({
  hasState: fc.boolean(),
  hasRoadmap: fc.boolean(),
  hasRequirements: fc.boolean(),
  requirementsEmpty: fc.boolean(),
  phaseCount: fc.integer({ min: 0, max: 3 }),
  requirementCount: fc.integer({ min: 0, max: 3 }),
  eol: EOL_ARB,
});

function buildDocumentShapedProject(cwd, cfg) {
  if (cfg.hasState) {
    writeState(cwd, ["gsd_state_version: '1.0'", 'status: planning'], [], cfg.eol);
  }
  if (cfg.hasRoadmap) {
    const lines = ['## v1.0 Current 🚧', ''];
    for (let i = 1; i <= cfg.phaseCount; i += 1) {
      lines.push(`### Phase ${i}: Phase${i}`, '');
    }
    writeRoadmap(cwd, lines, cfg.eol);
  }
  for (let i = 1; i <= cfg.phaseCount; i += 1) {
    const token = String(i);
    const phaseDir = phaseDirOf(cwd, slugPhaseDirName(token, `Phase${i}`));
    writePlanDoc(phaseDir, `${token}-01-PLAN.md`, ['wave: 1'], [
      '<objective>', `Ship phase ${i}`, '</objective>', '',
      '<tasks>',
      '<task type="auto"><name>Task 1</name><files>src/x.ts</files><action>do it</action><done>done</done></task>',
      '</tasks>',
    ], cfg.eol);
    writeSummaryDoc(phaseDir, `${token}-01-SUMMARY.md`, ['status: complete'], [
      '# Summary', '', '## Files Created/Modified', '- `src/x.ts` - x',
    ], cfg.eol);
    writeVerification(phaseDir, token, 'passed', cfg.eol);
  }
  if (cfg.hasRequirements) {
    if (cfg.requirementsEmpty) {
      writeRequirements(cwd, '');
    } else {
      const lines = ['# Requirements', '', '## v1 Requirements', ''];
      for (let i = 1; i <= cfg.requirementCount; i += 1) {
        lines.push(`- [ ] **REQ-0${i}**: Requirement ${i}`);
      }
      writeRequirements(cwd, lines.join(cfg.eol));
    }
  }
}

describe('planning inspect — property tests', () => {
  test('propertySchemaIsTotalOverDocumentShapedInputs', (t) => {
    const createdDirs = [];
    t.after(() => {
      for (const d of createdDirs) cleanup(d);
    });

    fc.assert(
      fc.property(PLANNING_PROJECT_SHAPE_ARB, (cfg) => {
        const tmpDir = createTempProject('gsd-2790-prop-');
        createdDirs.push(tmpDir);
        buildDocumentShapedProject(tmpDir, cfg);

        const result = runInspect(tmpDir);
        assert.strictEqual(result.success, true, `command must exit 0 for cfg=${JSON.stringify(cfg)}: ${result.error}`);
        const payload = JSON.parse(result.output);
        assert.deepStrictEqual(sortedKeys(payload), EXPECTED_TOP_LEVEL_KEYS);

        const percent = payload.progress.accepted_phases.percent;
        assert.ok(
          percent === null || (Number.isInteger(percent) && percent >= 0 && percent <= 100),
          `percent must be null or an integer in [0,100], got ${percent} for cfg=${JSON.stringify(cfg)}`,
        );
      }),
      { numRuns: 20, seed: 279040, verbose: true },
    );
  });
});

// ─── 12. plan-document task-count parity (property, direct require) ──────────

const { parsePlanDocument } = require('../gsd-core/bin/lib/plan-document.cjs');

const TASK_COUNT_ARB = fc.record({
  xmlCount: fc.integer({ min: 0, max: 5 }),
  mdCount: fc.integer({ min: 0, max: 5 }),
});

describe('plan-document — task count parity (property)', () => {
  test('propertyTaskCountMatchesLegacyFallbackRule', () => {
    fc.assert(
      fc.property(TASK_COUNT_ARB, ({ xmlCount, mdCount }) => {
        const xmlBlocks = [];
        for (let i = 0; i < xmlCount; i += 1) {
          xmlBlocks.push(`<task type="auto"><name>Task ${i + 1}</name></task>`);
        }
        const mdBlocks = [];
        for (let i = 0; i < mdCount; i += 1) {
          mdBlocks.push(`## Task ${i + 1}`);
        }
        const content = [
          '<objective>',
          'Objective',
          '</objective>',
          '<tasks>',
          ...xmlBlocks,
          '</tasks>',
          ...mdBlocks,
        ].join('\n');

        // Default-argument caller shape — `parsePlanDocument(content)` with
        // `planPath` omitted, matching how `planning-inspect.cts` calls it.
        const parsed = parsePlanDocument(content);
        const expected = xmlCount > 0 ? xmlCount : mdCount;
        assert.strictEqual(parsed.tasks.length, expected);
      }),
      { numRuns: 40, seed: 279041, verbose: true },
    );
  });
});
