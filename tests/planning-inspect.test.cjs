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
  writeState(cwd, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
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
  // phaseDirOf only computes a path; only writeAbs creates directories, as a
  // side effect of writing a file. A declared-but-absent directory silently
  // produces an empty `phases[]`, so create it explicitly here.
  const phaseDir = phaseDirOf(cwd, slugPhaseDirName(token, name));
  fs.mkdirSync(phaseDir, { recursive: true });
  return phaseDir;
}

/** A healthy two-phase project: both phases complete, requirements mapped. */
function buildHealthyFixture(cwd, eol = '\n') {
  writeState(cwd, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'], [], eol);
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
  'complete', 'dependencies', 'dir', 'goal', 'phase_id', 'plan_count', 'plans',
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

  test('schemaKeySetIsDecoupledFromPlanningSnapshotShape', (t) => {
    // Row 4: the top-level key set is a FROZEN mapping this module owns, not
    // a reflection of `PlanningSnapshot`'s own (additive, still-growing)
    // shape. Proven by locking the map itself — EXPECTED_TOP_LEVEL_KEYS is a
    // hand-authored constant in this file, not derived from the snapshot
    // module — so a field added to `PlanningSnapshot` cannot silently widen
    // what `planning.inspect` emits without this test also being edited.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const planningSnapshotLib = require('../gsd-core/bin/lib/planning-snapshot.cjs');
    const snapshot = planningSnapshotLib.buildPlanningSnapshot(tmpDir);
    // PlanningSnapshot's own key set is whatever it is (additive, churning) —
    // asserted only to prove this test is exercising the real module, not a
    // stub.
    assert.ok(Object.keys(snapshot).length > 0);

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

  test('rejectsEmptyAndValuelessFlagForms', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Row 12: `--phase ""` and `--phase` (no value at all) both land on the
    // same "planning inspect takes no arguments" usage rejection as any other
    // unrecognized flag — v1 takes no flags at all, so neither form is
    // special-cased into a different failure shape.
    const emptyValue = runInspectJsonError(tmpDir, ['--phase', '']);
    assert.strictEqual(emptyValue.reason, 'usage');
    const noValue = runInspectJsonError(tmpDir, ['--phase']);
    assert.strictEqual(noValue.reason, 'usage');
  });

  test('toleratesDuplicateGlobalFlag', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);
    // Row 13: `--raw --raw` — v1 takes no flags, so `--raw` (recognized by
    // other query commands) is itself rejected by this command's own usage
    // check. The row's contract is "no crash; deterministic", which this
    // proves by running twice and asserting the two failures are identical.
    const first = runInspect(tmpDir, ['--raw', '--raw']);
    const second = runInspect(tmpDir, ['--raw', '--raw']);
    assert.strictEqual(first.success, false);
    assert.strictEqual(second.success, false);
    assert.strictEqual(first.error, second.error);
    assert.strictEqual(/\n\s*at\s/.test(first.error), false, `stderr must not carry a stack trace: ${first.error}`);
  });

  test('rejectsFlagShapedValueWithoutStackTrace', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Row 14: a value that itself looks like a flag (`--pick --weird`) must
    // still fail as a plain usage error, never crash with a raw stack trace.
    const result = runInspect(tmpDir, ['--pick', '--weird']);
    assert.strictEqual(result.success, false);
    assert.strictEqual(/\n\s*at\s/.test(result.error), false, `stderr must not carry a stack trace: ${result.error}`);
  });

  test('emitsTypedReasonCodesUnderJsonErrors', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Row 15: every usage/dispatch failure in rows 7-11 must carry a TYPED
    // `reason` under `--json-errors` — never require a caller to regex the
    // human `message` prose.
    const noSubcommand = runGsdTools(['query', 'planning', '--json-errors'], tmpDir);
    assert.strictEqual(noSubcommand.success, false);
    assert.strictEqual(JSON.parse(noSubcommand.error).reason, 'sdk_unknown_command');

    const unknownSubcommand = runGsdTools(['query', 'planning', 'bogus', '--json-errors'], tmpDir);
    assert.strictEqual(unknownSubcommand.success, false);
    assert.strictEqual(JSON.parse(unknownSubcommand.error).reason, 'sdk_unknown_command');

    assert.strictEqual(runInspectJsonError(tmpDir, ['extra']).reason, 'usage');
    assert.strictEqual(runInspectJsonError(tmpDir, ['--nope']).reason, 'usage');
    assert.strictEqual(runInspectJsonError(tmpDir, ['--phase', '3']).reason, 'usage');
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

  test('carriesTheRequirementUnmappedCodeOnTheRowItselfForCorrelation', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      '- [ ] **REQ-04**: Something to build',
      '',
    ].join('\n'));

    const payload = parseInspect(tmpDir);
    const row = payload.requirements.find((r) => r.id === 'REQ-04');
    assert.ok(row, 'REQ-04 row must be present');
    // Per-row diagnostics is a correlation convenience over the SAME global
    // diagnostics array — never a second, independent answer.
    assert.ok(row.diagnostics.includes('requirement_unmapped'));
    assert.ok(payload.diagnostics.some((d) => d.code === 'requirement_unmapped' && d.subject === 'REQ-04'));
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
    // Row 30: the SECOND occurrence, specifically — the first wins (its text
    // survives), there is exactly one row (never two), and the row itself
    // carries the correlation diagnostic naming the collision.
    const matching = payload.requirements.filter((r) => r.id === 'REQ-03');
    assert.strictEqual(matching.length, 1, 'a duplicate ID must produce exactly one row, not two');
    assert.strictEqual(matching[0].text, 'First occurrence');
    assert.ok(matching[0].diagnostics.includes('requirement_duplicate'));
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

  test('withholdsPercentWhenRoadmapAbsent', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Row 20: ROADMAP.md deliberately not written (STATE.md alone is not
    // enough to scope a milestone). getMilestoneInfo's own absent-file path
    // reports SCOPE.UNREADABLE, not COMPLETE.
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);

    const payload = parseInspect(tmpDir);
    assert.notStrictEqual(payload.milestone.scope, 'complete');
    assert.strictEqual(payload.progress.accepted_phases.percent, null);
  });

  test('doesNotInventAMilestoneVersionForFreeFormRoadmap', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning']);
    writeRoadmap(tmpDir, [
      '# Project Roadmap',
      '',
      'Some free-form notes with no version token anywhere in this document.',
      '',
      '### Phase 1: Foo',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Foo')), { recursive: true });

    const payload = parseInspect(tmpDir);
    assert.strictEqual(payload.milestone.scope, 'unscoped');
    assert.strictEqual(payload.milestone.version, null);
    // The absence of any version evidence must never be filled with a
    // plausible-looking default such as "v1.0".
    assert.notStrictEqual(payload.milestone.version, 'v1.0');
  });

  test('reportsTruncatedIdentityForProseOnlyVersionToken', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning']);
    writeRoadmap(tmpDir, [
      '# Project Roadmap',
      '',
      'We are targeting v1.4 sometime this quarter.',
      '',
      '### Phase 1: Foo',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Foo')), { recursive: true });

    const payload = parseInspect(tmpDir);
    assert.strictEqual(payload.milestone.scope, 'truncated');
    assert.strictEqual(payload.milestone.version, 'v1.4');
    assert.strictEqual(payload.milestone.name, null);
  });

  test('derivesNameFromTheHeadingsOwnVersionToken', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Row 23: STATE.md declares "v2.0"; ROADMAP's heading is "v2.0.1 —
    // Portability" — the milestone name must derive from the heading's OWN
    // version token ("Portability"), never the raw remainder text after a
    // naive prefix strip (".1 — Portability").
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v2.0']);
    writeRoadmap(tmpDir, [
      '## v2.0.1 — Portability',
      '',
      '### Phase 1: Foo',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Foo')), { recursive: true });

    const payload = parseInspect(tmpDir);
    assert.strictEqual(payload.milestone.name, 'Portability');
    assert.ok(!payload.milestone.name.includes('.1'));
  });

  test('treatsWhitespaceOnlyRequirementsAsEmpty', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    writeRequirements(tmpDir, '   \n\n\t\n');

    const payload = parseInspect(tmpDir);
    assert.deepStrictEqual(payload.requirements, []);
    assert.ok(!payload.diagnostics.some((d) => d.code === 'requirements_absent'));
  });

  test('emitsUnknownForRequirementWithNoCheckbox', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    // Row 28: a Traceability-table-only requirement — present as a table row
    // (`parseRequirements`'s pipe-table path), with NO checkbox bullet
    // anywhere. `text` is a real non-answer (null, not ''); `complete` is
    // `unknown`, never inferred `false`.
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## Traceability',
      '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| REQ-05 | Phase 1 | Pending |',
      '',
    ].join('\n'));

    const payload = parseInspect(tmpDir);
    const row = payload.requirements.find((r) => r.id === 'REQ-05');
    assert.ok(row, 'REQ-05 row must be present from the Traceability row alone');
    assert.strictEqual(row.text, null);
    assert.strictEqual(row.complete, 'unknown');
    assert.ok(payload.diagnostics.some((d) => d.code === 'requirement_completion_unknown' && d.subject === 'REQ-05'));
  });

  test('acceptsPrefixAgnosticRequirementIds', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    // Row 31: the ID format is prefix-agnostic — AUTH-01 and INSP-04 are
    // accepted exactly like REQ-01, sharing the SAME `[A-Z][A-Z0-9]*-...`
    // pattern `parseRequirements` (gap-checker.cts) uses.
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      '- [x] **AUTH-01**: User can sign up',
      '- [ ] **INSP-04**: Inspection works',
      '',
      '## Traceability',
      '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| AUTH-01 | Phase 1 | Complete |',
      '| INSP-04 | Phase 1 | Pending |',
      '',
    ].join('\n'));

    const payload = parseInspect(tmpDir);
    const ids = payload.requirements.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ['AUTH-01', 'INSP-04']);
    const auth = payload.requirements.find((r) => r.id === 'AUTH-01');
    assert.strictEqual(auth.complete, true);
    const insp = payload.requirements.find((r) => r.id === 'INSP-04');
    assert.strictEqual(insp.complete, false);
  });

  test('doesNotTreatTableSeparatorAsARequirementRow', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## Traceability',
      '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| REQ-06 | Phase 1 | Pending |',
      '',
    ].join('\n'));

    const payload = parseInspect(tmpDir);
    // The header row and the `|---|---|` separator row must never themselves
    // be parsed as requirement rows — exactly one requirement, REQ-06.
    assert.strictEqual(payload.requirements.length, 1);
    assert.strictEqual(payload.requirements[0].id, 'REQ-06');
  });
});

// ─── 4b. Phase completion and plan liveness (§7.4/§7.5) ───────────────────────

describe('planning inspect — phase completion and plan liveness', () => {
  test('treatsZeroPlanPhaseWithPassingVerificationAsComplete', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    // Row 34: no plans at all, but a passing VERIFICATION.md — §7.4 gates
    // completion on verification alone; plan count is not a precondition.
    writeVerification(phaseDir, '01', 'passed');

    const payload = parseInspect(tmpDir);
    assert.strictEqual(payload.phases[0].complete, true);
    assert.strictEqual(payload.phases[0].plan_count, 0);
  });

  test('treatsAbsentVerificationAsNotComplete', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    // Row 35: plans exist and are summarized, but no *-VERIFICATION.md was
    // ever written — completion still requires the verification record.
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks></tasks>',
    ]);
    writeSummaryDoc(phaseDir, '1-01-SUMMARY.md', [], [
      '# Summary', '', '## Files Created/Modified',
    ]);

    const payload = parseInspect(tmpDir);
    assert.strictEqual(payload.phases[0].complete, false);
    assert.strictEqual(payload.phases[0].verification.status, 'missing');
  });

  test('excludesSupersededPlanFromLiveCounts', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'live one', '</objective>', '<tasks></tasks>',
    ]);
    writeSummaryDoc(phaseDir, '1-01-SUMMARY.md', [], [
      '# Summary', '', '## Files Created/Modified', '- `src/a.ts` - a',
    ]);
    // Row 37: a plan whose frontmatter declares `status: superseded` — still
    // LISTED in `plans`, but excluded from the live plan_count/summary_count.
    writePlanDoc(phaseDir, '1-02-PLAN.md', ['status: superseded'], [
      '<objective>', 'old one', '</objective>', '<tasks></tasks>',
    ]);

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.strictEqual(phase.plan_count, 1, 'superseded plan must not inflate the live plan count');
    const supersededRow = phase.plans.find((p) => p.id === '1-02');
    assert.ok(supersededRow, 'the superseded plan is still listed');
    assert.strictEqual(supersededRow.superseded, true);
    const liveRow = phase.plans.find((p) => p.id === '1-01');
    assert.strictEqual(liveRow.superseded, false);
  });

  test('countsProseRetiredPlanAsLive', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    // Row 38 (§7.5 GAP, deliberately characterized): a plan whose PROSE says
    // "RETIRED" but carries no `status:` frontmatter key is still counted
    // LIVE — the parser never compensates for a prose-only retirement claim.
    writePlanDoc(phaseDir, '1-01-PLAN.md', [], [
      '<objective>',
      'RETIRED — this plan was abandoned, see prose below.',
      '</objective>',
      '<tasks></tasks>',
    ]);

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.strictEqual(phase.plan_count, 1, 'a prose-only retirement claim must not remove the plan from the live count');
    assert.strictEqual(phase.plans[0].superseded, false);
  });

  test('blockedSummaryIsNotACompletionRecord', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>',
      '<task type="auto"><name>Task 1</name><files>src/a.ts</files><action>a</action><done>done</done></task>',
      '</tasks>',
    ]);
    // Row 39: SUMMARY declares `status: blocked` — a failure record, not a
    // completion record. The plan/SUMMARY filename pairing still resolves
    // (hasSummary true, provenance still parsed), but the phase-level
    // summary_count must NOT count it.
    writeSummaryDoc(phaseDir, '1-01-SUMMARY.md', ['status: blocked'], [
      '# Summary', '', '## Files Created/Modified', '- `src/a.ts` - a',
    ]);

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.strictEqual(phase.summary_count, 0, 'a blocked SUMMARY must not count as a completion record');
    assert.strictEqual(phase.plans[0].hasSummary, true, 'filename pairing itself is unaffected by status');
  });

  test('haltedSummaryIsStillACompletionRecord', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'Ship it', '</objective>', '',
      '<tasks>',
      '<task type="auto"><name>Task 1</name><files>src/a.ts</files><action>a</action><done>done</done></task>',
      '</tasks>',
    ]);
    // Row 40: `status: halted` (#2830) — a DESIGNED stop still writes a
    // completion record, unlike `status: blocked` above.
    writeSummaryDoc(phaseDir, '1-01-SUMMARY.md', ['status: halted'], [
      '# Summary', '', '## Files Created/Modified', '- `src/a.ts` - a',
    ]);

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.strictEqual(phase.plan_count, 1);
    assert.strictEqual(phase.summary_count, 1, 'a halted SUMMARY still counts as a completion record');
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
  test('uatAbsenceDoesNotAffectAcceptedPhases', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Row 50: no UAT.md at all — `uat: []` plus a `uat_absent` diagnostic,
    // and — the load-bearing half of the row — phase acceptance is entirely
    // unaffected by UAT's absence (UAT never gates `accepted_phases`).
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writeVerification(phaseDir, '01', 'passed');

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.deepStrictEqual(phase.uat.unresolved, []);
    assert.ok(payload.diagnostics.some((d) => d.code === 'uat_absent'));
    assert.strictEqual(phase.complete, true);
    assert.strictEqual(payload.progress.accepted_phases.percent, 100);
  });

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
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
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

// ─── 6b. Per-phase goal / dependency evidence (#2790) ─────────────────────────

describe('planning inspect — per-phase goal and dependency evidence', () => {
  test('reportsThePhaseHeadingProseAsGoalWithCompleteScope', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
    writeRoadmap(tmpDir, [
      '## v1.0 Current 🚧',
      '',
      '## Phases',
      '',
      '- [ ] **Phase 1: Auth** - stub',
      '',
      '### Phase 1: Auth',
      '',
      'Build authentication.',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Auth')), { recursive: true });

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.strictEqual(phase.goal.value, 'Build authentication.');
    assert.strictEqual(phase.goal.scope, 'complete');
  });

  test('reportsDependsOnPhaseTokensAsAStringArray', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
    writeRoadmap(tmpDir, [
      '## v1.0 Current 🚧',
      '',
      '## Phases',
      '',
      '- [ ] **Phase 1: Auth** - stub',
      '- [ ] **Phase 2: Billing** - stub',
      '',
      '### Phase 1: Auth',
      '',
      '### Phase 2: Billing',
      '',
      'Charge the customer.',
      '',
      '**Depends on:** Phase 1',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Auth')), { recursive: true });
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('2', 'Billing')), { recursive: true });

    const payload = parseInspect(tmpDir);
    const billing = payload.phases.find((p) => p.dir === '02-billing');
    assert.ok(billing, '02-billing phase row must be present');
    assert.ok(billing.dependencies.value.includes('1'));
    assert.strictEqual(billing.dependencies.scope, 'complete');
  });

  test('reportsNoDependsOnLineAsAnEmptyArrayNotADegradedScope', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    // Absent is a real answer, not a failure — same scope as a found section
    // that simply carries no dependency line.
    assert.deepStrictEqual(phase.dependencies.value, []);
    assert.strictEqual(phase.dependencies.scope, 'complete');
  });

  test('excludesTheDependsOnAnnotationFromGoalEvenThoughItIsSurfacedSeparately', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
    writeRoadmap(tmpDir, [
      '## v1.0 Current 🚧',
      '',
      '## Phases',
      '',
      '- [ ] **Phase 1: Auth** - stub',
      '',
      '### Phase 1: Auth',
      '',
      'Build authentication.',
      '',
      '**Depends on:** Phase 1',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Auth')), { recursive: true });

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    // The annotation is data this payload already surfaces via
    // `dependencies` — asserted together so it appears in exactly one place.
    assert.strictEqual(phase.goal.value, 'Build authentication.');
    assert.ok(!phase.goal.value.includes('Depends on'));
    assert.ok(phase.dependencies.value.includes('1'));
  });

  test('excludesThePlansChecklistFromGoalProse', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
    writeRoadmap(tmpDir, [
      '## v1.0 Current 🚧',
      '',
      '## Phases',
      '',
      '- [ ] **Phase 1: Auth** - stub',
      '',
      '### Phase 1: Auth',
      '',
      'Build authentication.',
      '',
      'Plans:',
      '- [ ] 01-PLAN.md',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Auth')), { recursive: true });

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    assert.strictEqual(phase.goal.value, 'Build authentication.');
    assert.ok(!phase.goal.value.includes('Plans:'));
    assert.ok(!phase.goal.value.includes('- [ ]'));
  });

  test('reportsNullGoalWithCompleteScopeWhenTheSectionIsPureMetadata', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
    writeRoadmap(tmpDir, [
      '## v1.0 Current 🚧',
      '',
      '## Phases',
      '',
      '- [ ] **Phase 1: Auth** - stub',
      '',
      '### Phase 1: Auth',
      '',
      '**Depends on:** Phase 1',
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', 'Auth')), { recursive: true });

    const payload = parseInspect(tmpDir);
    const phase = payload.phases[0];
    // A section that is pure metadata genuinely has no goal prose — a real
    // answer, not a failed read: `complete` still means "the section was
    // found", never "prose was found".
    assert.strictEqual(phase.goal.value, null);
    assert.strictEqual(phase.goal.scope, 'complete');
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
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
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

// ─── 7b. Per-document/per-phase fault isolation (D33/D34) and combinations ───

describe('planning inspect — fault isolation and combinations', () => {
  test('reportsTruncatedScopeForUnreadableNestedPlansDir', (t) => {
    // Row 53: the phase directory itself is readable, but its NESTED
    // `plans/` subdirectory is not — scanPhasePlans (plan-scan.cts) reports
    // this as TRUNCATED, never COMPLETE-with-zero, and that folds into the
    // phase row's own `scope`.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    const nestedDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(nestedDir, { recursive: true });
    writeAbs(path.join(nestedDir, 'PLAN-01-x.md'), ['<objective>', 'a', '</objective>', '<tasks></tasks>'].join('\n'));

    const planningInspectLib = require('../gsd-core/bin/lib/planning-inspect.cjs');
    const originalReaddirSync = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', function mockedReaddirSync(target, ...rest) {
      if (target === nestedDir) {
        const err = new Error(`EACCES: permission denied, scandir '${nestedDir}'`);
        err.code = 'EACCES';
        throw err;
      }
      return originalReaddirSync.call(this, target, ...rest);
    });

    const payload = planningInspectLib.buildPlanningInspect(tmpDir);
    assert.strictEqual(payload.phases[0].scope, 'truncated');
    assert.ok(payload.diagnostics.some((d) => d.code === 'phase_scope_degraded'));
  });

  test('isolatesAnUnreadablePlanFromItsSiblings', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', [], ['<objective>', 'good one', '</objective>', '<tasks></tasks>']);
    // Row 54: a SECOND plan that cannot be read (directory-in-file-position —
    // no chmod, root-proof). Its own row must degrade; the sibling plan's
    // row must be entirely unaffected.
    fs.mkdirSync(path.join(phaseDir, '1-02-PLAN.md'), { recursive: true });

    const payload = parseInspect(tmpDir);
    const rows = payload.phases[0].plans;
    const good = rows.find((p) => p.id === '1-01');
    const bad = rows.find((p) => p.id === '1-02');
    assert.strictEqual(good.scope, 'complete');
    assert.strictEqual(good.objective, 'good one');
    assert.strictEqual(bad.scope, 'unreadable');
    assert.strictEqual(bad.objective, null);
    assert.ok(payload.diagnostics.some((d) => d.code === 'plan_unreadable' && d.subject === '1-02-PLAN.md'));
  });

  test('treatsDirectoryInPlanPositionAsUnreadable', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', [], ['<objective>', 'good one', '</objective>', '<tasks></tasks>']);
    // Row 55: the SAME technique as row 54, named explicitly for the
    // "PLAN.md is a directory" input class — a directory sitting exactly
    // where a plan file is expected. `readDocument`'s `statSync().isFile()`
    // guard rejects it before any `readFileSync` on THIS path, so it degrades
    // to `unreadable` rather than crashing on EISDIR.
    fs.mkdirSync(path.join(phaseDir, '2-01-PLAN.md'), { recursive: true });

    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected exit 0 even with a directory in plan position: ${result.error}`);
    const payload = JSON.parse(result.output);
    const bad = payload.phases[0].plans.find((p) => p.id === '2-01');
    assert.ok(bad, 'the directory-shaped plan entry must still be listed as a row');
    assert.strictEqual(bad.scope, 'unreadable');
    assert.ok(payload.diagnostics.some((d) => d.code === 'plan_unreadable' && d.subject === '2-01-PLAN.md'));
  });

  test('rejectsPlanSymlinkEscapingThePlanningRoot', (t) => {
    // Row 56 — SECURITY FIX (#2790 follow-up). Previously CHARACTERIZED as
    // leaking: `readDocument` (planning-inspect.cts) opened a document via
    // `fs.statSync`/`fs.readFileSync`, both of which FOLLOW symlinks, so a
    // `*-PLAN.md` that was actually a symlink pointing outside `.planning/`
    // had its target's content surfaced into the schema-v1 payload — an
    // exfiltration path, since these documents are UNTRUSTED input (a clone,
    // a PR branch, a teammate's working tree) and the payload is handed to
    // downstream tooling verbatim. `readDocument` now resolves both the
    // document and the planning root via `fs.realpathSync` and refuses to
    // read a target that resolves outside the root; the escaping plan must
    // degrade exactly like any other unreadable plan, and a sibling readable
    // plan in the SAME phase must be entirely unaffected.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const secretDir = createTempDir('gsd-2790-secret-');
    t.after(() => cleanup(secretDir));
    const secretFile = path.join(secretDir, 'secret.txt');
    const sentinel = 'TOP_SECRET_OBJECTIVE_VALUE_9f3c1a';
    fs.writeFileSync(secretFile, ['<objective>', sentinel, '</objective>', ''].join('\n'));

    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    // A sibling, legitimately-readable plan in the SAME phase — proves the
    // escaping symlink degrades ALONE and does not drag its sibling down.
    writePlanDoc(phaseDir, '1-01-PLAN.md', [], ['<objective>', 'good one', '</objective>', '<tasks></tasks>']);
    try {
      fs.symlinkSync(secretFile, path.join(phaseDir, '1-02-PLAN.md'));
    } catch (_symlinkErr) {
      t.skip('symlink creation unsupported on this platform/privilege');
      return;
    }

    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected exit 0 even with an escaping symlink: ${result.error}`);
    // Raw-string ABSENCE proof is the sanctioned exception to the no-raw-text
    // rule: the entire point of this assertion is that the sentinel is NEVER
    // emitted anywhere in stdout, so only a substring-absence check — not a
    // value-level assertion — can express that.
    assert.ok(!result.output.includes(sentinel), 'the secret sentinel must never appear anywhere in the payload');

    const payload = JSON.parse(result.output);
    const good = payload.phases[0].plans.find((p) => p.id === '1-01');
    const escaped = payload.phases[0].plans.find((p) => p.id === '1-02');
    assert.strictEqual(good.scope, 'complete');
    assert.strictEqual(good.objective, 'good one');
    assert.strictEqual(escaped.scope, 'unreadable');
    assert.strictEqual(escaped.objective, null);
    assert.ok(payload.diagnostics.some((d) => d.code === 'plan_unreadable' && d.subject === '1-02-PLAN.md'));
  });

  test('stillReadsPlansWhenTheWholePlanningRootIsALegitimateSymlinkElsewhere', (t) => {
    // Companion to `rejectsPlanSymlinkEscapingThePlanningRoot`: containment
    // must not over-reject the case it exists to preserve — "so a legitimately
    // symlinked `.planning/` directory ... still works" (per brief). Both
    // `filePath` and `root` are resolved with `fs.realpathSync` before the
    // boundary check, so a project that relocates its ENTIRE `.planning/`
    // directory to elsewhere on disk (a synced folder, a monorepo shared
    // location, etc.) and symlinks it back in keeps reading normally — the
    // resolved plan target still nests under the resolved root, it just does
    // so via the relocated location rather than the literal `cwd/.planning`
    // path. Without this test, the fix above could silently regress into
    // rejecting every document in such a project.
    const bareDir = createTempDir('gsd-2790-bare-');
    t.after(() => cleanup(bareDir));
    const realPlanningDir = createTempDir('gsd-2790-real-planning-');
    t.after(() => cleanup(realPlanningDir));
    try {
      fs.symlinkSync(realPlanningDir, path.join(bareDir, '.planning'));
    } catch (_symlinkErr) {
      t.skip('symlink creation unsupported on this platform/privilege');
      return;
    }

    const phaseDir = declarePhase(bareDir, '1', 'Foo');
    writePlanDoc(phaseDir, '1-01-PLAN.md', [], ['<objective>', 'relocated plan', '</objective>', '<tasks></tasks>']);

    const payload = parseInspect(bareDir);
    const plan = payload.phases[0].plans.find((p) => p.id === '1-01');
    assert.ok(plan, 'plan row must exist through the symlinked planning root');
    assert.strictEqual(plan.scope, 'complete');
    assert.strictEqual(plan.objective, 'relocated plan');
  });

  test('oneDocumentsFaultDoesNotDowngradeAnother', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Row 57: REQUIREMENTS.md is unreadable (directory-in-file-position);
    // ROADMAP.md is clean. Requirements degrades ALONE — milestone identity
    // and phase completion must stay unaffected.
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    writeVerification(phaseDir, '01', 'passed');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), { recursive: true });

    const payload = parseInspect(tmpDir);
    assert.strictEqual(payload.milestone.scope, 'complete');
    assert.strictEqual(payload.phases[0].complete, true);
    assert.deepStrictEqual(payload.requirements, []);
    assert.ok(payload.diagnostics.some((d) => d.code === 'requirements_unreadable'));
  });

  test('foldsWorstScopeAcrossPhasesAndWithholdsPercent', (t) => {
    // Row 58: phase A is unreadable (its own directory listing fails), phase
    // B is clean and complete. The top-level `accepted_phases.percent` must
    // withhold (fold via worstScope) rather than silently computing a
    // fraction from only the phases that happened to be readable.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
    writeRoadmap(tmpDir, [
      '## v1.0 Current 🚧', '', '### Phase 1: A', '', '### Phase 2: B', '',
    ]);
    const phaseADir = phaseDirOf(tmpDir, slugPhaseDirName('1', 'A'));
    const phaseBDir = phaseDirOf(tmpDir, slugPhaseDirName('2', 'B'));
    fs.mkdirSync(phaseADir, { recursive: true });
    writePlanDoc(phaseBDir, '2-01-PLAN.md', [], ['<objective>', 'b', '</objective>', '<tasks></tasks>']);
    writeSummaryDoc(phaseBDir, '2-01-SUMMARY.md', [], ['# s', '', '## Files Created/Modified']);
    writeVerification(phaseBDir, '02', 'passed');

    const planningInspectLib = require('../gsd-core/bin/lib/planning-inspect.cjs');
    const originalReaddirSync = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', function mockedReaddirSync(target, ...rest) {
      if (target === phaseADir) {
        const err = new Error(`EACCES: permission denied, scandir '${phaseADir}'`);
        err.code = 'EACCES';
        throw err;
      }
      return originalReaddirSync.call(this, target, ...rest);
    });

    const payload = planningInspectLib.buildPlanningInspect(tmpDir);
    const a = payload.phases.find((p) => p.dir === '01-a');
    const b = payload.phases.find((p) => p.dir === '02-b');
    assert.strictEqual(a.scope, 'unreadable');
    assert.strictEqual(a.complete, false);
    assert.strictEqual(b.scope, 'complete');
    assert.strictEqual(b.complete, true);
    assert.strictEqual(payload.progress.accepted_phases.percent, null);
  });
});

// ─── 7c. The 50 KB @file: spill boundary (io.cjs's own `> 50000` predicate) ──

const ioLib = require('../gsd-core/bin/lib/io.cjs');

/**
 * Build a JSON payload whose `serializeForOutput` byte length is EXACTLY
 * `targetLen` — calibrated once against the real overhead of `{"padding":
 * "..."}` at 2-space indent, then padded with ASCII (`'a'`, no JSON escaping)
 * so one added character is exactly one added byte. Asserts the calibration
 * landed exactly, so a future change to `serializeForOutput`'s formatting
 * fails this helper loudly rather than silently testing the wrong boundary.
 */
function paddedPayloadOfSerializedLength(targetLen) {
  const overhead = ioLib.serializeForOutput({ padding: '' }).length;
  const padLen = Math.max(targetLen - overhead, 0);
  const payload = { padding: 'a'.repeat(padLen) };
  const actualLen = ioLib.serializeForOutput(payload).length;
  assert.strictEqual(actualLen, targetLen, `padding calibration failed: expected length ${targetLen}, got ${actualLen}`);
  return payload;
}

describe('planning inspect — the 50 KB @file: spill boundary', () => {
  test('emitsInlineJsonJustBelowTheSpillThreshold', () => {
    // Row 60 (limit-1): io.cjs's own predicate is `json.length > 50000` —
    // 49999 bytes must NOT spill.
    const payload = paddedPayloadOfSerializedLength(49999);
    assert.strictEqual(ioLib.serializeForOutput(payload).length > 50000, false);
  });

  test('matchesIoSpillThresholdAtTheBoundary', () => {
    // Row 61 (limit): exactly 50000 bytes — the predicate is strictly
    // GREATER THAN, so the boundary value itself does NOT spill.
    const payload = paddedPayloadOfSerializedLength(50000);
    assert.strictEqual(ioLib.serializeForOutput(payload).length > 50000, false);
  });

  test('spillsOverThresholdAndResolvesBackToJsonOnStdout', (t) => {
    // Row 62 (limit+1), part A: the exact boundary+1 byte value against the
    // serializer's own predicate.
    const payload = paddedPayloadOfSerializedLength(50001);
    assert.strictEqual(ioLib.serializeForOutput(payload).length > 50000, true);

    // Row 62, part B: a genuinely oversized END-TO-END fixture through the
    // real CLI — proving `resolveAtFileOutput` (gsd-tools.cjs) transparently
    // resolves the `@file:` spill back into full JSON on stdout, so the
    // caller never has to know the spill happened.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    const lines = ['# Requirements', '', '## v1 Requirements', ''];
    const padding = 'x'.repeat(400);
    for (let i = 1; i <= 300; i += 1) {
      lines.push(`- [ ] **REQ-${String(i).padStart(3, '0')}**: padded description ${padding}`);
    }
    writeRequirements(tmpDir, lines.join('\n'));

    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected exit 0 for an oversized payload: ${result.error}`);
    assert.ok(result.output.length > 50000, 'the raw fixture text alone should already exceed the spill threshold');
    const parsedPayload = JSON.parse(result.output);
    assert.deepStrictEqual(sortedKeys(parsedPayload), EXPECTED_TOP_LEVEL_KEYS);
    assert.strictEqual(parsedPayload.requirements.length, 300);
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

  test('characterizesFenceBlindMarkdownTaskFallback', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Foo');
    // Row 44 (deliberately characterized, not endorsed — see
    // plan-document.cts's own header comment): a `## Task N` heading inside a
    // FENCED code block still counts under the markdown fallback, exactly as
    // `cmdPhasePlanIndex` has always counted it. This plan has no `<task>`
    // blocks at all, so the fence-blind markdown fallback is what runs.
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'ship', '</objective>', '',
      '```markdown',
      '## Task 1: fenced, still counted by the legacy fallback',
      '```',
      '',
    ]);

    const payload = parseInspect(tmpDir);
    const tasks = payload.phases[0].plans[0].tasks;
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].name, 'Task 1: fenced, still counted by the legacy fallback');
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
    // Positive proof: parse first (CONTRIBUTING.md "Prohibited: Raw Text
    // Matching on Test Outputs") and assert the hostile payload survives
    // verbatim in the structured field, not merely somewhere in the stream.
    const payload = JSON.parse(raw);
    const row = payload.requirements.find((r) => r.id === 'HOSTILE-01');
    assert.ok(row, 'HOSTILE-01 row must be present');
    assert.equal(row.text, '`$(id)`; rm -rf / && echo `whoami`');
    // Negative proof (legitimate raw-string check — this proves the ABSENCE
    // of shell-command output anywhere in the stream, which no amount of JSON
    // parsing can strengthen; do not "fix" this into a parsed check).
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

  test('toleratesLoneCarriageReturnLineEndings', (t) => {
    // Row 64: old-Mac lone `\r` line endings (no `\n` at all). No crash; the
    // command's output is deterministic across two runs.
    const tmpDir = createTempProject('gsd-2790-cr-');
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir, '\r');

    const first = runInspect(tmpDir);
    assert.strictEqual(first.success, true, `expected success: ${first.error}`);
    const second = runInspect(tmpDir);
    assert.strictEqual(second.success, true, `expected success: ${second.error}`);
    assert.strictEqual(first.output, second.output);
  });

  test('handlesNullByteAndReplacementCharInDocumentText', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    // Row 65: a NUL byte and a U+FFFD replacement character embedded in a
    // requirement description. Both are valid UTF-8 payload bytes/codepoints
    // — the value must be carried verbatim, never silently truncated at the
    // NUL.
    const nul = String.fromCharCode(0);
    const replacementChar = '�';
    const description = `has a${nul}nul and a ${replacementChar} replacement char inline`;
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      `- [ ] **REQ-10**: ${description}`,
      '',
    ].join('\n'));

    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    const payload = JSON.parse(result.output);
    const row = payload.requirements.find((r) => r.id === 'REQ-10');
    assert.ok(row, 'REQ-10 row must be present');
    assert.ok(row.text.includes(nul), 'the NUL byte must be carried verbatim, not silently dropped');
    assert.ok(row.text.includes(replacementChar), 'U+FFFD must be carried verbatim');
  });

  test('neverResolvesTraversalShapedPhaseTokenToAPath', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    // Row 66: a `../../x`-shaped token in a traceability row's Phase cell.
    // The phase-token extractor only pulls DIGIT tokens out of that cell
    // (`parseTraceability`'s `\d+(?:\.\d+)*` scan) — a traversal shape simply
    // yields no numeric token, so it is never resolved to a filesystem path.
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      '- [ ] **REQ-09**: something',
      '',
      '## Traceability',
      '',
      '| Requirement | Phase | Status |',
      '|-------------|-------|--------|',
      '| REQ-09 | ../../../etc | Pending |',
      '',
    ].join('\n'));

    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    const raw = result.output;
    const payload = JSON.parse(raw);
    const row = payload.requirements.find((r) => r.id === 'REQ-09');
    assert.ok(row, 'REQ-09 row must be present');
    assert.deepStrictEqual(row.mappedPhases, []);
    // Negative proof: no path-resolution artifact (a resolved root path, or
    // the traversal string itself surviving into a filesystem-shaped field)
    // leaks anywhere in the stream.
    assert.ok(!raw.includes('../../../etc'));
  });

  test('boundsAPathologicallyLongDocumentValue', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    declarePhase(tmpDir, '1', 'Foo');
    // Row 70: a single requirement description ~1 MB long. The command must
    // still complete and exit 0 — no unbounded read, no hang.
    const longValue = 'x'.repeat(1024 * 1024);
    writeRequirements(tmpDir, [
      '# Requirements',
      '',
      '## v1 Requirements',
      '',
      `- [ ] **REQ-11**: ${longValue}`,
      '',
    ].join('\n'));

    // Assert via `--pick schema_version` rather than the full JSON payload.
    // gsd-tools handles this correctly end-to-end: output() spills the >50KB
    // JSON to a tmpfile and resolves the @file: reference back to stdout, so
    // the full 1 MB document IS read and parsed — but resolved stdout is then
    // well over runGsdTools's subprocess maxBuffer, which makes the HELPER
    // report BUFFER_OVERFLOW/ENOBUFS. That failure is the test harness's
    // buffer ceiling, not the product. `--pick` makes gsd-tools extract a
    // single small field and print only that, so stdout stays tiny while the
    // full 1 MB document is still read and parsed end to end — proving the
    // command completes successfully on a pathologically long value without
    // measuring runGsdTools's maxBuffer instead of the product.
    const result = runInspect(tmpDir, ['--pick', 'schema_version']);
    assert.strictEqual(result.success, true, `expected success for a 1MB value: ${result.error}`);
    assert.strictEqual(result.output, '1', 'schema_version must round-trip as 1 through --pick');
  });

  test('preservesUnicodeAndRtlDocumentText', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // Row 71: Unicode + RTL headings and names must round-trip byte-identical
    // into the payload — no width/parse corruption.
    const rtlName = 'المصادقة'; // Arabic: "Authentication"
    writeState(tmpDir, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0']);
    writeRoadmap(tmpDir, [
      '## v1.0 Current 🚧',
      '',
      '## Phases',
      '',
      `- [ ] **Phase 1: ${rtlName}** - stub`,
      '',
      `### Phase 1: ${rtlName}`,
      '',
      rtlName,
      '',
    ]);
    fs.mkdirSync(phaseDirOf(tmpDir, slugPhaseDirName('1', rtlName)), { recursive: true });

    const result = runInspect(tmpDir);
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    const payload = JSON.parse(result.output);
    const phase = payload.phases[0];
    assert.strictEqual(phase.goal.value, rtlName);
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

  test('phasePlanIndexBehaviorUnchangedByPlanDocumentExtraction', (t) => {
    // Row 73: `phase-plan-index`'s wave/depends_on/incomplete/runnable shape
    // — the live regression surface named by the matrix's own risk section —
    // exercised directly, independent of `planning.inspect`, to prove the
    // `plan-document.cts` extraction did not change this command's output.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const phaseDir = declarePhase(tmpDir, '1', 'Regress');
    writePlanDoc(phaseDir, '1-01-PLAN.md', ['wave: 1'], [
      '<objective>', 'First', '</objective>', '',
      '<tasks>',
      '<task type="auto"><name>Task 1</name><files>src/a.ts</files><action>a</action><done>done</done></task>',
      '</tasks>',
    ]);
    writeSummaryDoc(phaseDir, '1-01-SUMMARY.md', ['status: complete'], [
      '# Summary', '', '## Files Created/Modified', '- `src/a.ts` - a',
    ]);
    writePlanDoc(phaseDir, '1-02-PLAN.md', ['wave: 2', 'depends_on: 1-01'], [
      '<objective>', 'Second', '</objective>', '',
      '<tasks>',
      '<task type="auto"><name>Task 1</name><files>src/b.ts</files><action>b</action><done>done</done></task>',
      '</tasks>',
    ]);
    // No SUMMARY for 1-02 — it stays incomplete/runnable.

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    assert.strictEqual(result.success, true, `expected success: ${result.error}`);
    const payload = JSON.parse(result.output);

    const first = payload.plans.find((p) => p.id === '1-01');
    const second = payload.plans.find((p) => p.id === '1-02');
    assert.ok(first, '1-01 must be present');
    assert.ok(second, '1-02 must be present');
    assert.strictEqual(first.wave, 1);
    assert.strictEqual(second.wave, 2);
    assert.deepStrictEqual(second.depends_on, ['1-01']);
    assert.deepStrictEqual(payload.incomplete, ['1-02']);
    assert.deepStrictEqual(payload.runnable, ['1-02']);
    assert.ok(Array.isArray(payload.waves['1']));
    assert.ok(payload.waves['1'].includes('1-01'));
    assert.ok(Array.isArray(payload.waves['2']));
    assert.ok(payload.waves['2'].includes('1-02'));
  });

  test('producesDeterministicOutputAcrossRuns', (t) => {
    // Row 75: two runs over the same fixture must produce byte-identical
    // stdout — array ordering (task rows, plan rows, diagnostics) is
    // deterministic, not incidentally stable.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    buildHealthyFixture(tmpDir);

    const first = runInspect(tmpDir);
    const second = runInspect(tmpDir);
    assert.strictEqual(first.success, true, `expected success: ${first.error}`);
    assert.strictEqual(second.success, true, `expected success: ${second.error}`);
    assert.strictEqual(first.output, second.output);
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
    writeState(cwd, ["gsd_state_version: '1.0'", 'status: planning', 'milestone: v1.0'], [], cfg.eol);
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
  test('parsesWithTheArgumentShapeProductionActuallyPasses', () => {
    // Row 74: `planning-inspect.cjs`'s OWN call site (`buildPlanRows`) is
    // `parsePlanDocument(doc.text)` — `planPath` OMITTED. Proven directly
    // against that exact shape, not a hand-passed `(content, path)` pair.
    const content = [
      '---',
      'wave: 2',
      'depends_on: 1-01',
      'files_modified: src/a.ts, src/b.ts',
      '---',
      '',
      '<objective>',
      'Ship the omitted-argument case',
      '</objective>',
      '',
      '<tasks>',
      '<task type="auto"><name>Task 1</name><files>src/a.ts</files><action>do it</action><done>done</done></task>',
      '</tasks>',
    ].join('\n');

    const parsed = parsePlanDocument(content);
    assert.strictEqual(parsed.objective, 'Ship the omitted-argument case');
    assert.strictEqual(parsed.declaredWave, 2);
    assert.deepStrictEqual(parsed.dependsOn, ['1-01']);
    // A single scalar frontmatter value is NOT comma-split — only an actual
    // YAML array is mapped element-wise (see parsePlanDocument's `fmFiles`
    // handling). One frontmatter line yields one array element verbatim.
    assert.deepStrictEqual(parsed.filesModified, ['src/a.ts, src/b.ts']);
    assert.strictEqual(parsed.tasks.length, 1);
    assert.strictEqual(parsed.taskCount, 1);
  });

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
