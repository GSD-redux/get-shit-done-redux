'use strict';

/**
 * Tests for `src/health-diagnostic.cts` (Phase 11, #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * Design:       .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix:  .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * Covers test-matrix section 2 (rows 9-16) against the FULLY WIRED rule
 * table (`RULES` now carries all 31 rules — see the "RULES" describe block
 * below for the exact count and why it is 31, not 32 — extracted from
 * `cmdValidateHealth`, `src/verify.cts:1616-2577`). Rows 15-16 (the
 * DESTRUCTIVE-refusal proof and the NONE-risk apply proof) run against REAL
 * diagnostics emitted by REAL rules over a REAL `buildPlanningSnapshot`
 * projection of a temp fixture, not hand-constructed fakes — the
 * hand-constructed-fake coverage (rows 11-12 below) is kept alongside it
 * since it exercises `applyRepairs`'s gating logic in isolation from any
 * particular rule's shape.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const healthDiagnostic = require('../gsd-core/bin/lib/health-diagnostic.cjs');
const { buildPlanningSnapshot } = require('../gsd-core/bin/lib/planning-snapshot.cjs');
const { cmdValidateHealth } = require('../gsd-core/bin/lib/verify.cjs');
const { MANIFEST_NAME } = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { createTempProject, createTempGitProject, createTempDir, cleanup, captureConsole } = require('./helpers.cjs');

const {
  SEVERITY,
  REMEDY_ACTION,
  REMEDY_RISK,
  RULES,
  evaluateRules,
  evaluateRuleTable,
  applyRepairs,
} = healthDiagnostic;

// ─── Shared fixture helpers (mirror tests/orphan-worktree-detection.test.cjs's
// setupHealthyProject, the proven-healthy recipe for the pre-migration
// cmdValidateHealth) ────────────────────────────────────────────────────────

function writeMinimalProjectMd(tmpDir) {
  const sections = ['## What This Is', '## Core Value', '## Requirements'];
  const content = sections.map((s) => `${s}\n\nContent here.\n`).join('\n');
  fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), `# Project\n\n${content}`);
}

function writeMinimalRoadmap(tmpDir) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Setup\n');
}

function writeMinimalStateMd(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    '# Session State\n\n## Current Position\n\nPhase: 1\n',
  );
}

function writeValidConfigJson(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(
      {
        model_profile: 'balanced',
        commit_docs: true,
        workflow: { nyquist_validation: true, ai_integration_phase: true },
      },
      null,
      2,
    ),
  );
}

function setupHealthyProject(tmpDir) {
  writeMinimalProjectMd(tmpDir);
  writeMinimalRoadmap(tmpDir);
  writeMinimalStateMd(tmpDir);
  writeValidConfigJson(tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
}

// ─── Row 9 — REMEDY_ACTION locks exactly 7 members ─────────────────────────

describe('REMEDY_ACTION', () => {
  test('row 9: locks exactly 7 members (6 real repair actions + ADVISE)', () => {
    assert.deepEqual(Object.keys(REMEDY_ACTION).sort(), [
      'ADD_AI_INTEGRATION_PHASE_KEY',
      'ADD_NYQUIST_KEY',
      'ADVISE',
      'BACKFILL_MILESTONES',
      'CREATE_CONFIG',
      'REGENERATE_STATE',
      'RESET_CONFIG',
    ]);
    assert.deepEqual(
      Object.values(REMEDY_ACTION).sort(),
      [
        'addAiIntegrationPhaseKey',
        'addNyquistKey',
        'advise',
        'backfillMilestones',
        'createConfig',
        'regenerateState',
        'resetConfig',
      ],
    );
  });

  test('is frozen', () => {
    assert.equal(Object.isFrozen(REMEDY_ACTION), true);
  });
});

// ─── Row 10 — REMEDY_RISK locks exactly 2 members ──────────────────────────

describe('REMEDY_RISK', () => {
  test('row 10: locks exactly 2 members (NONE, DESTRUCTIVE)', () => {
    assert.deepEqual(Object.keys(REMEDY_RISK).sort(), ['DESTRUCTIVE', 'NONE']);
    assert.deepEqual(Object.values(REMEDY_RISK).sort(), ['destructive', 'none']);
  });

  test('is frozen', () => {
    assert.equal(Object.isFrozen(REMEDY_RISK), true);
  });
});

describe('SEVERITY', () => {
  test('locks exactly 3 members (ERROR, WARNING, INFO)', () => {
    assert.deepEqual(Object.keys(SEVERITY).sort(), ['ERROR', 'INFO', 'WARNING']);
    assert.deepEqual(Object.values(SEVERITY).sort(), ['error', 'info', 'warning']);
  });

  test('is frozen', () => {
    assert.equal(Object.isFrozen(SEVERITY), true);
  });
});

// ─── Rows 11-12 — applyRepairs risk-gating, hand-constructed diagnostics ───
//
// No real rule exists yet to emit these remedies (RULES is empty in this
// skeleton). These diagnostics are hand-built using the risk harvested from
// health.md's published table (design doc, "Risk assignment" section):
// resetConfig/regenerateState are DESTRUCTIVE; every other real action is
// NONE. This proves applyRepairs's gating logic is correct independent of
// whether any real rule exists to produce these shapes yet.

function fakeDiagnostic(code, action, risk) {
  return {
    code,
    severity: SEVERITY.WARNING,
    message: `fake diagnostic for ${code}`,
    remedy: { action, risk, args: {} },
  };
}

describe('applyRepairs — risk gating (hand-constructed diagnostics)', () => {
  test('row 11: resetConfig/regenerateState (DESTRUCTIVE) are refused, never applied, when --repair is requested', () => {
    const diagnostics = [
      fakeDiagnostic('E005', REMEDY_ACTION.RESET_CONFIG, REMEDY_RISK.DESTRUCTIVE),
      fakeDiagnostic('E004', REMEDY_ACTION.REGENERATE_STATE, REMEDY_RISK.DESTRUCTIVE),
    ];
    const result = applyRepairs('/fake/cwd', diagnostics, true, false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused.sort(), ['E004', 'E005']);
  });

  test('row 12: every other real action (NONE risk) is applied, not refused, when --repair is requested', (t) => {
    // Unlike the other tests in this block, these four codes now dispatch to
    // REAL handlers (runRepairAction, src/health-diagnostic.cts) that perform
    // real filesystem I/O — createConfig writes config.json, addNyquistKey /
    // addAiIntegrationPhaseKey read-then-patch it (throwing if absent). A
    // literal '/fake/cwd' makes every one of those genuinely fail (ENOENT),
    // which applyRepairs correctly reports as NOT applied. A real temp
    // project with a real, valid config.json already in place is required so
    // the read-then-patch handlers have something to read.
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeValidConfigJson(tmpDir);

    const diagnostics = [
      fakeDiagnostic('W003', REMEDY_ACTION.CREATE_CONFIG, REMEDY_RISK.NONE),
      fakeDiagnostic('W008', REMEDY_ACTION.ADD_NYQUIST_KEY, REMEDY_RISK.NONE),
      fakeDiagnostic('W016', REMEDY_ACTION.ADD_AI_INTEGRATION_PHASE_KEY, REMEDY_RISK.NONE),
      fakeDiagnostic('W018', REMEDY_ACTION.BACKFILL_MILESTONES, REMEDY_RISK.NONE),
    ];
    const result = applyRepairs(tmpDir, diagnostics, true, false);
    assert.deepEqual(result.applied.sort(), ['W003', 'W008', 'W016', 'W018']);
    assert.deepEqual(result.refused, []);
  });

  test('ADVISE-action diagnostics are never applied nor refused, regardless of --repair', () => {
    const diagnostics = [fakeDiagnostic('W001', REMEDY_ACTION.ADVISE, REMEDY_RISK.NONE)];
    const result = applyRepairs('/fake/cwd', diagnostics, true, true);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
  });

  test('non-backfillMilestones NONE-risk diagnostics are skipped (not applied) when --repair is not requested', () => {
    const diagnostics = [fakeDiagnostic('W003', REMEDY_ACTION.CREATE_CONFIG, REMEDY_RISK.NONE)];
    const result = applyRepairs('/fake/cwd', diagnostics, false, false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
  });

  test('DESTRUCTIVE-risk diagnostics are skipped (not refused) when --repair is not requested — refusal only fires when actually requested', () => {
    const diagnostics = [fakeDiagnostic('E005', REMEDY_ACTION.RESET_CONFIG, REMEDY_RISK.DESTRUCTIVE)];
    const result = applyRepairs('/fake/cwd', diagnostics, false, false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
  });

  test('backfillMilestones applies on --backfill alone, without --repair (mirrors verify.cts:2504 intent)', () => {
    const diagnostics = [fakeDiagnostic('W018', REMEDY_ACTION.BACKFILL_MILESTONES, REMEDY_RISK.NONE)];
    const result = applyRepairs('/fake/cwd', diagnostics, false, true);
    assert.deepEqual(result.applied, ['W018']);
    assert.deepEqual(result.refused, []);
  });

  test('backfillMilestones is skipped when neither --repair nor --backfill is set', () => {
    const diagnostics = [fakeDiagnostic('W018', REMEDY_ACTION.BACKFILL_MILESTONES, REMEDY_RISK.NONE)];
    const result = applyRepairs('/fake/cwd', diagnostics, false, false);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.refused, []);
  });
});

// ─── Row 13 — duplicate-code detection, LOCAL fake rule array ──────────────
//
// Proven against a small, locally-constructed fake rule array — independent
// of the real `RULES` table's own (already-unique, see the "RULES" describe
// block below) codes, so this guard's logic is covered in isolation.

describe('evaluateRuleTable — duplicate-code guard (row 13)', () => {
  test('throws when two rules share the same code', () => {
    const fakeRules = [
      { code: 'W999', severity: SEVERITY.WARNING, check: () => [] },
      { code: 'W999', severity: SEVERITY.WARNING, check: () => [] },
    ];
    assert.throws(() => evaluateRuleTable(fakeRules, {}), /W999/);
  });

  test('does not throw, and flattens all diagnostics, when codes are unique', () => {
    const fakeRules = [
      {
        code: 'W997',
        severity: SEVERITY.WARNING,
        check: () => [
          { code: 'W997', severity: SEVERITY.WARNING, message: 'a', remedy: { action: REMEDY_ACTION.ADVISE, risk: REMEDY_RISK.NONE, args: {} } },
        ],
      },
      {
        code: 'W998',
        severity: SEVERITY.WARNING,
        check: () => [
          { code: 'W998', severity: SEVERITY.WARNING, message: 'b', remedy: { action: REMEDY_ACTION.ADVISE, risk: REMEDY_RISK.NONE, args: {} } },
          { code: 'W998', severity: SEVERITY.WARNING, message: 'c', remedy: { action: REMEDY_ACTION.ADVISE, risk: REMEDY_RISK.NONE, args: {} } },
        ],
      },
    ];
    const diagnostics = evaluateRuleTable(fakeRules, {});
    assert.equal(diagnostics.length, 3);
    assert.deepEqual(diagnostics.map((d) => d.message), ['a', 'b', 'c']);
  });

  test('empty rule array never throws and returns []', () => {
    assert.deepEqual(evaluateRuleTable([], {}), []);
  });
});

// ─── RULES — the fully wired table ──────────────────────────────────────────
//
// 32 rule entries. Counted directly from each rule-group file's own exported
// `RULES` array: root-existence (4: E002/E003/E004/W001) + state-consistency
// (5: W024/W002/W011/W021/W026) + config-validation (10: W003/E005/W004/
// W008/W016/W012/W013/W014/W015/W022) + phase-structure (4: W005/W023/I001/
// W009) + agent-install (1: W010) + roadmap-disk-consistency (2: W006/W007)
// + worktree-health (3: W020/W017/W027) + milestone-archive-hygiene (2:
// W018/W019) + install-surface-shadowing (1: W028, #2873 epic #2866 Phase
// 4a) = 32. E001 and the home-directory guard (E010/I010) are deliberately
// NOT rows (design doc, "Two guards that stay OUTSIDE the rule table
// entirely").

describe('RULES', () => {
  test('is the full, frozen 32-rule table with every code unique', () => {
    assert.equal(Array.isArray(RULES), true);
    assert.equal(RULES.length, 32);
    const codes = RULES.map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length, 'every rule code must be unique');
  });

  test('every rule carries a code, severity, and check function', () => {
    for (const rule of RULES) {
      assert.equal(typeof rule.code, 'string');
      assert.ok(Object.values(SEVERITY).includes(rule.severity), `${rule.code}: unknown severity ${rule.severity}`);
      assert.equal(typeof rule.check, 'function');
    }
  });
});

// ─── W028 — install surface shadowing (#2873, epic #2866 Phase 4a; D1-D5) ──
//
// `src/health-diagnostic-rules/install-surface-shadowing.cts` reuses W010's
// (`agent-install.cts`) runtime-resolution mechanism: `resolveRuntime(cwd)`
// (`runtime-slash.cjs`) never throws (env/config/'claude'-default chain), and
// `buildShadowReport(runtime, { cwd: snapshot.cwd })` is called with `home`
// left un-injected so the resolver defaults to `os.homedir()` — the real
// machine, the same production call shape the installer uses. Every row
// below therefore drives the REAL global scope by monkeypatching
// `os.homedir()` (`installSpawnHome`-style DI is not available to this rule,
// which accepts no `home` option at all) rather than `fs.chmodSync`/mode-bit
// tricks — this repo's mandated IO-failure-injection technique
// (CLAUDE.md → "CROSS-PLATFORM TEST IO-FAILURE INJECTION").
//
// This suite chose `tests/health-diagnostic.test.cjs` over
// `tests/health-diagnostic-rules/agent-install.test.cjs`: the latter is
// W010's dedicated fixture file (closest *mechanism* match, cited above, but
// a different SUBJECT — agent installation, not install-scope shadowing);
// this file is the RULES-table-and-evaluator skeleton suite (`describe(
// 'RULES', ...)` immediately above already asserts the wired table includes
// every code, W028 included) and is where `evaluateRuleTable`'s own
// duplicate-code-guard rows (13) already live — the natural home for D4.
// Extending an existing file either way keeps `lint-test-file-count.cjs`'s
// `health-diagnostic` prefix bucket unchanged (still the 1 file it was
// before this PR).

function withHomedir(t, tmpHome) {
  const originalHomedir = os.homedir;
  os.homedir = () => tmpHome;
  t.after(() => {
    os.homedir = originalHomedir;
  });
}

function writeClaudeManifest(configDir, scope, files) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, MANIFEST_NAME), JSON.stringify({
    manifestVersion: 2, runtime: 'claude', scope, files,
  }));
}

describe('W028 (install surface shadowing)', () => {
  test('D1: health surfaces cross-scope shadowing when both scopes are installed', (t) => {
    const home = createTempDir('gsd-w028-d1-home-');
    const cwd = createTempDir('gsd-w028-d1-cwd-');
    t.after(() => { cleanup(home); cleanup(cwd); });
    withHomedir(t, home);

    writeClaudeManifest(path.join(home, '.claude'), 'global', { 'skills/gsd-plan-phase/SKILL.md': 'a' });
    writeClaudeManifest(path.join(cwd, '.claude'), 'local', { 'commands/gsd-plan-phase.md': 'a' });

    const snapshot = buildPlanningSnapshot(cwd);
    const rule = RULES.find((r) => r.code === 'W028');
    assert.ok(rule, 'RULES must contain a W028 entry');
    const diagnostics = rule.check(snapshot);
    assert.strictEqual(diagnostics.length, 1, `expected exactly one W028 diagnostic, got: ${JSON.stringify(diagnostics)}`);
    const [d] = diagnostics;
    assert.strictEqual(d.code, 'W028');
    assert.strictEqual(d.severity, SEVERITY.WARNING);
    assert.strictEqual(d.remedy.action, REMEDY_ACTION.ADVISE);
    assert.strictEqual(d.remedy.risk, REMEDY_RISK.NONE);
  });

  test('D2: health is quiet without shadowing', (t) => {
    const home = createTempDir('gsd-w028-d2-home-');
    const cwd = createTempDir('gsd-w028-d2-cwd-');
    t.after(() => { cleanup(home); cleanup(cwd); });
    withHomedir(t, home);
    // Neither scope has any GSD install at all — nothing to shadow.

    const snapshot = buildPlanningSnapshot(cwd);
    const rule = RULES.find((r) => r.code === 'W028');
    assert.deepStrictEqual(rule.check(snapshot), []);
  });

  test('D3: --json output (cmdValidateHealth raw=true) carries the W028 code structurally', (t) => {
    const home = createTempDir('gsd-w028-d3-home-');
    const cwd = createTempGitProject();
    t.after(() => { cleanup(home); cleanup(cwd); });
    withHomedir(t, home);

    // A real, otherwise-healthy .planning/ project — required so
    // cmdValidateHealth's own E001 pre-check does not short-circuit before
    // the rule table ever runs (that path is D5, below).
    const sections = ['## What This Is', '## Core Value', '## Requirements'];
    fs.writeFileSync(path.join(cwd, '.planning', 'PROJECT.md'), `# Project\n\n${sections.map((s) => `${s}\n\nContent here.\n`).join('\n')}`);
    fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Setup\n');
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '# Session State\n\n## Current Position\n\nPhase: 1\n');
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced', commit_docs: true,
      workflow: { nyquist_validation: true, ai_integration_phase: true },
    }, null, 2));
    fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-setup'), { recursive: true });

    writeClaudeManifest(path.join(home, '.claude'), 'global', { 'skills/gsd-plan-phase/SKILL.md': 'a' });
    writeClaudeManifest(path.join(cwd, '.claude'), 'local', { 'commands/gsd-plan-phase.md': 'a' });

    let result;
    captureConsole(() => {
      result = cmdValidateHealth(cwd, {}, true);
    });
    // Typed structured assertions on the RETURNED payload (the same object
    // `output(result, raw)` would JSON.stringify for `--json` mode) — never
    // a substring match against rendered/printed prose.
    assert.ok(result, 'cmdValidateHealth must return the result payload');
    const w028Entries = (result.warnings ?? []).filter((w) => w.code === 'W028');
    assert.strictEqual(w028Entries.length, 1, `expected one W028 warning entry, got: ${JSON.stringify(result.warnings)}`);
    assert.strictEqual(typeof w028Entries[0].message, 'string');
    assert.strictEqual(w028Entries[0].repairable, false);
  });

  test('D4: rule code is unique — W028 appears exactly once and the duplicate-code guard passes over the real, healthy-project RULES evaluation', (t) => {
    const codes = RULES.map((r) => r.code);
    assert.strictEqual(codes.filter((c) => c === 'W028').length, 1, 'W028 must appear exactly once in RULES');

    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir);
    writeMinimalStateMd(tmpDir);
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });

    // evaluateRuleTable's own duplicate-code guard (row 13, above) throws
    // BEFORE running any check() if two RULES entries share a code — running
    // the real, full RULES table end to end (via evaluateRules) over a real
    // snapshot is what proves that guard passes with the real, wired W028
    // present, not merely that a hand-built fake array behaves.
    assert.doesNotThrow(() => evaluateRules(buildPlanningSnapshot(tmpDir)));
  });

  test('D5: health run outside a project (no .planning/) never throws; rule degrades with no config dir', (t) => {
    const home = createTempDir('gsd-w028-d5-home-');
    const cwd = createTempDir('gsd-w028-d5-cwd-'); // deliberately no .planning/ created
    t.after(() => { cleanup(home); cleanup(cwd); });
    withHomedir(t, home);

    // A real coexistence fixture exists on disk — proves the outer E001
    // guard (verify.cts, "stays OUTSIDE the rule table entirely") short-
    // circuits BEFORE the rule table (and W028 specifically) ever runs, not
    // merely that nothing happens to be installed. `writeAllSync`-based
    // `output()` writes directly to fd 1 (io.cts), bypassing `console.log`
    // entirely, so `captureConsole` cannot observe it here — the CONTRACT
    // under test is `cmdValidateHealth`'s documented early-return shape
    // itself: `output(...); return;` with no explicit value, i.e. `undefined`.
    writeClaudeManifest(path.join(home, '.claude'), 'global', { 'skills/gsd-plan-phase/SKILL.md': 'a' });
    writeClaudeManifest(path.join(cwd, '.claude'), 'local', { 'commands/gsd-plan-phase.md': 'a' });

    let result;
    assert.doesNotThrow(() => {
      result = cmdValidateHealth(cwd, {}, true);
    });
    assert.strictEqual(result, undefined, 'the E001 no-.planning/ pre-check returns before the rule table (and W028) ever runs');

    // "no config dir" half of D5: the rule itself, driven directly, must
    // degrade to no diagnostic (never throw) when `os.homedir()` resolves to
    // a path that does not exist on disk at all.
    const rule = RULES.find((r) => r.code === 'W028');
    const missingHome = path.join(home, 'does-not-exist-at-all');
    withHomedir(t, missingHome);
    const bareCwd = createTempDir('gsd-w028-d5-barecwd-');
    t.after(() => cleanup(bareCwd));
    const snapshot = buildPlanningSnapshot(bareCwd);
    assert.doesNotThrow(() => {
      assert.deepStrictEqual(rule.check(snapshot), []);
    });
  });
});

// ─── Row 14 — evaluator against an all-clean REAL snapshot ────────────────

describe('evaluateRules (row 14)', () => {
  test('evaluateRules(buildPlanningSnapshot(healthyProject)) returns []', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    setupHealthyProject(tmpDir);

    const snapshot = buildPlanningSnapshot(tmpDir);
    const diagnostics = evaluateRules(snapshot);
    assert.deepEqual(diagnostics, [], `expected zero diagnostics for a healthy project, got: ${JSON.stringify(diagnostics)}`);
  });
});

// ─── Rows 15-16 — applyRepairs against REAL diagnostics from REAL rules ────

describe('applyRepairs — REAL diagnostics (rows 15-16)', () => {
  test('row 15: --repair given a real DESTRUCTIVE E004 finding (STATE.md missing) refuses regenerateState; STATE.md stays absent', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    setupHealthyProject(tmpDir);
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));

    const snapshot = buildPlanningSnapshot(tmpDir);
    const diagnostics = evaluateRules(snapshot);
    const e004 = diagnostics.find((d) => d.code === 'E004');
    assert.ok(e004, `expected E004 when STATE.md is missing, got: ${JSON.stringify(diagnostics)}`);
    assert.equal(e004.remedy.action, REMEDY_ACTION.REGENERATE_STATE);
    assert.equal(e004.remedy.risk, REMEDY_RISK.DESTRUCTIVE);

    const result = applyRepairs(tmpDir, diagnostics, true, false);
    assert.ok(!result.applied.includes('E004'), 'E004 must not be applied');
    assert.ok(result.refused.includes('E004'), 'E004 must be refused');
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.planning', 'STATE.md')),
      false,
      'STATE.md must remain absent — the DESTRUCTIVE remedy is refused, not silently applied',
    );
  });

  test('row 16: --repair given a real NONE-risk W003 finding (config.json missing) applies createConfig, exactly as pre-migration', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    setupHealthyProject(tmpDir);
    fs.unlinkSync(path.join(tmpDir, '.planning', 'config.json'));

    const snapshot = buildPlanningSnapshot(tmpDir);
    const diagnostics = evaluateRules(snapshot);
    const w003 = diagnostics.find((d) => d.code === 'W003');
    assert.ok(w003, `expected W003 when config.json is missing, got: ${JSON.stringify(diagnostics)}`);
    assert.equal(w003.remedy.action, REMEDY_ACTION.CREATE_CONFIG);
    assert.equal(w003.remedy.risk, REMEDY_RISK.NONE);

    const result = applyRepairs(tmpDir, diagnostics, true, false);
    assert.ok(result.applied.includes('W003'), 'W003 must be applied');
    assert.ok(!result.refused.includes('W003'), 'W003 must not be refused');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    assert.ok(fs.existsSync(configPath), 'config.json should now exist on disk');
    const diskConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(diskConfig.model_profile, 'balanced');
  });

  // Regression: a repair handler that THROWS (caught by applyRepairs's own
  // try/catch) must be recorded in `details` with `success: false` and must
  // NOT land in `applied` — `applied` means "succeeded", not "attempted".
  // Forced here via ADD_NYQUIST_KEY against a config.json that is genuinely
  // absent: `runRepairAction`'s `fs.readFileSync(configPath, ...)` throws
  // ENOENT.
  test('regression: a repair handler that throws is recorded in details with success:false and is NOT pushed to applied', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    setupHealthyProject(tmpDir);
    fs.unlinkSync(path.join(tmpDir, '.planning', 'config.json'));
    assert.equal(fs.existsSync(path.join(tmpDir, '.planning', 'config.json')), false);

    const diagnostics = [fakeDiagnostic('W008', REMEDY_ACTION.ADD_NYQUIST_KEY, REMEDY_RISK.NONE)];
    const result = applyRepairs(tmpDir, diagnostics, true, false);

    assert.ok(!result.applied.includes('W008'), 'W008 must not be applied — the handler threw');
    assert.ok(!result.refused.includes('W008'), 'a thrown handler is not a DESTRUCTIVE-risk refusal either');
    const detail = result.details.find((d) => d.code === 'W008');
    assert.ok(detail, 'a details row must still be recorded for the failed attempt');
    assert.equal(detail.success, false);
    assert.ok(detail.error, 'the details row must carry the thrown error message');
  });
});
