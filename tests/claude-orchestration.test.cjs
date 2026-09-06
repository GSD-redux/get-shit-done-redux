'use strict';

/**
 * claude-orchestration.test.cjs — Behavioral tests for the Claude orchestration
 * capability (#1143): Workflow-tool backend detection, Workflow-script emission,
 * capability-declaration validation, registry integration, and inline-fallback parity.
 *
 * The capability is default-off + BETA + claude-only. On any runtime lacking the
 * Workflow tool it must be a byte-identical no-op. These tests encode that contract.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('fast-check');

// #2590: gsd-tools subprocess tests in this file spawn the real CLI; keep it in
// test mode for the whole process.
process.env.GSD_TEST_MODE = '1';

const {
  detectWorkflowBackend,
  emitWorkflowScript,
  resolveWaveDispatch,
  WORKFLOW_TOOL_FLOOR_VERSION,
  BACKEND_VALUES,
  compareSemver,
} = require('../gsd-core/bin/lib/claude-orchestration.cjs');

const {
  validateCapability,
  validateAgainstContract,
  loadAndValidate,
  buildRegistry,
  serializeRegistry,
  normalizeLineEndings,
  stripGeneratedComment,
} = require('../scripts/gen-capability-registry.cjs');

const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.resolve(__dirname, '..');
const CAP_PATH = path.join(ROOT, 'capabilities', 'claude-orchestration', 'capability.json');
const REGISTRY_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A host-integration descriptor whose dispatch axis signals Workflow-tool capability. */
const CAPABLE_HOST = {
  dispatch: { namedDispatch: true, nested: true, background: true, backgroundDispatch: false },
};

/** Read the real capability declaration (data file — not a source grep). */
function loadCap() {
  return JSON.parse(fs.readFileSync(CAP_PATH, 'utf8'));
}

/** A minimal single-plan wave manifest. */
function singleWaveManifest() {
  return {
    phaseDir: '.planning/phases/01-foo',
    runId: 'run-abc-1143',
    waves: [
      {
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'Implement the foo module', files_modified: ['src/foo.cts'] },
        ],
      },
    ],
  };
}

/** Two plans in one wave that DO NOT overlap (parallel-safe in a single stage). */
function nonOverlappingManifest() {
  return {
    phaseDir: '.planning/phases/01-foo',
    runId: 'run-abc-1143',
    waves: [
      {
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'Plan A', files_modified: ['src/a.cts'] },
          { id: 'p2', brief: 'Plan B', files_modified: ['src/b.cts'] },
        ],
      },
    ],
  };
}

/** Two plans in one wave that DO overlap on files_modified (must split into stages). */
function overlappingManifest() {
  return {
    phaseDir: '.planning/phases/01-foo',
    runId: 'run-abc-1143',
    waves: [
      {
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'Plan A', files_modified: ['src/shared.cts', 'src/a.cts'] },
          { id: 'p2', brief: 'Plan B', files_modified: ['src/shared.cts', 'src/b.cts'] },
        ],
      },
    ],
  };
}

// ─── 1. detectWorkflowBackend ─────────────────────────────────────────────────

describe('detectWorkflowBackend', () => {

  test('capability disabled (default-off) -> inline, even on Claude with the tool', () => {
    const r = detectWorkflowBackend({
      runtimeId: 'claude',
      hostIntegration: CAPABLE_HOST,
      agentSdkVersion: '1.0.0',
      config: { 'claude_orchestration.enabled': false },
    });
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.backend, 'inline');
    assert.match(r.reason, /disabled/);
  });

  test('non-Claude runtime -> inline (criterion 6: no change to non-Claude loop)', () => {
    for (const runtimeId of ['codex', 'cursor', 'opencode', 'copilot', ' Windsurf'.trim()]) {
      const r = detectWorkflowBackend({
        runtimeId,
        hostIntegration: CAPABLE_HOST,
        agentSdkVersion: '1.0.0',
        config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'workflow' },
      });
      assert.strictEqual(r.backend, 'inline', runtimeId + ' should be inline');
      assert.strictEqual(r.available, false, runtimeId + ' should be unavailable');
      assert.match(r.reason, /claude/i, runtimeId + ' reason should mention claude');
    }
  });

  test('Claude + auto + capable host + new-enough SDK -> workflow', () => {
    const r = detectWorkflowBackend({
      runtimeId: 'claude',
      hostIntegration: CAPABLE_HOST,
      agentSdkVersion: '1.2.0',
      config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'auto' },
    });
    assert.strictEqual(r.backend, 'workflow');
    assert.strictEqual(r.available, true);
  });

  test('Claude + execution_backend:"workflow" forces workflow when tool is capable', () => {
    const r = detectWorkflowBackend({
      runtimeId: 'claude',
      hostIntegration: CAPABLE_HOST,
      agentSdkVersion: '1.0.0',
      config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'workflow' },
    });
    assert.strictEqual(r.backend, 'workflow');
    assert.strictEqual(r.available, true);
  });

  test('Claude + execution_backend:"inline" -> inline even when tool is capable', () => {
    const r = detectWorkflowBackend({
      runtimeId: 'claude',
      hostIntegration: CAPABLE_HOST,
      agentSdkVersion: '1.0.0',
      config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'inline' },
    });
    assert.strictEqual(r.backend, 'inline');
    assert.match(r.reason, /inline/);
  });

  test('Claude + auto + host lacking nested dispatch -> inline (fail-closed)', () => {
    const r = detectWorkflowBackend({
      runtimeId: 'claude',
      hostIntegration: { dispatch: { nested: false, background: true } },
      agentSdkVersion: '1.0.0',
      config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'auto' },
    });
    assert.strictEqual(r.backend, 'inline');
    assert.strictEqual(r.available, false);
  });

  test('Claude + unknown agentSdkVersion -> inline fail-closed (criterion 3 fallback)', () => {
    const r = detectWorkflowBackend({
      runtimeId: 'claude',
      hostIntegration: CAPABLE_HOST,
      agentSdkVersion: undefined,
      config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'auto' },
    });
    assert.strictEqual(r.backend, 'inline');
    assert.strictEqual(r.available, false);
    assert.match(r.reason, /version|sdk|unknown/i);
  });

  test('agent SDK version boundary: floor-1 -> inline, floor -> workflow, floor+patch -> workflow', () => {
    const floor = WORKFLOW_TOOL_FLOOR_VERSION;
    const [maj, min, pat] = floor.split('.').map((n) => parseInt(n, 10));
    // Robust "below" derivation with full borrow chain (works for .0.0 floors too).
    let below;
    if (pat > 0) below = `${maj}.${min}.${pat - 1}`;
    else if (min > 0) below = `${maj}.${min - 1}.999`;
    else if (maj > 0) below = `${maj - 1}.999.999`;
    else { assert.ok(false, 'cannot derive below for 0.0.0 floor'); return; }
    const above = `${maj}.${min}.${pat + 1}`;
    // Sanity: confirm below really is below per the comparator under test.
    assert.ok(compareSemver(below, floor) < 0, below + ' must compare below ' + floor);

    const cfg = { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'auto' };

    const rBelow = detectWorkflowBackend({ runtimeId: 'claude', hostIntegration: CAPABLE_HOST, agentSdkVersion: below, config: cfg });
    assert.strictEqual(rBelow.backend, 'inline', below + ' (floor-1) must be inline');

    const rAt = detectWorkflowBackend({ runtimeId: 'claude', hostIntegration: CAPABLE_HOST, agentSdkVersion: floor, config: cfg });
    assert.strictEqual(rAt.backend, 'workflow', floor + ' (exact floor) must be workflow');

    const rAbove = detectWorkflowBackend({ runtimeId: 'claude', hostIntegration: CAPABLE_HOST, agentSdkVersion: above, config: cfg });
    assert.strictEqual(rAbove.backend, 'workflow', above + ' (floor+patch) must be workflow');
  });

  test('config-level min_agent_sdk_version override raises/lowers the floor', () => {
    const cfg = {
      'claude_orchestration.enabled': true,
      'claude_orchestration.execution_backend': 'auto',
      'claude_orchestration.min_agent_sdk_version': '2.0.0',
    };
    const r1 = detectWorkflowBackend({ runtimeId: 'claude', hostIntegration: CAPABLE_HOST, agentSdkVersion: '1.9.9', config: cfg });
    assert.strictEqual(r1.backend, 'inline', 'below raised floor -> inline');
    const r2 = detectWorkflowBackend({ runtimeId: 'claude', hostIntegration: CAPABLE_HOST, agentSdkVersion: '2.0.0', config: cfg });
    assert.strictEqual(r2.backend, 'workflow', 'at raised floor -> workflow');
  });

  test('execution_backend:"workflow" + SDK below floor -> inline (M-1: floor applies in both modes)', () => {
    const cfg = {
      'claude_orchestration.enabled': true,
      'claude_orchestration.execution_backend': 'workflow',
    };
    const r = detectWorkflowBackend({ runtimeId: 'claude', hostIntegration: CAPABLE_HOST, agentSdkVersion: '0.3.0', config: cfg });
    assert.strictEqual(r.backend, 'inline', 'workflow mode must still honor the SDK floor (fail-closed)');
    assert.strictEqual(r.available, false);
    assert.match(r.reason, /floor|version/);
  });

  test('pre-release of the floor (0.3.149-rc.1) -> inline (pre-release < GA per SemVer)', () => {
    const cfg = { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'auto' };
    // Explicitly assert the precedence rule: a pre-release tag is below the GA release.
    assert.ok(compareSemver('0.3.149-rc.1', '0.3.149') < 0, 'pre-release must compare below GA');
    const r = detectWorkflowBackend({ runtimeId: 'claude', hostIntegration: CAPABLE_HOST, agentSdkVersion: '0.3.149-rc.1', config: cfg });
    assert.strictEqual(r.backend, 'inline', 'pre-release of the floor must not activate the BETA backend');
    assert.strictEqual(r.available, false);
  });

  test('two pre-releases of the same triple order by their identifiers (SemVer §11)', () => {
    assert.ok(compareSemver('0.3.149-rc.0', '0.3.149-rc.1') < 0, 'rc.0 < rc.1');
    assert.ok(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.2') < 0, 'alpha.1 < alpha.2');
    assert.ok(compareSemver('1.0.0-rc.1', '1.0.0-rc.2') < 0, 'rc.1 < rc.2');
    // numeric < alphanumeric at the same position
    assert.ok(compareSemver('1.0.0-1', '1.0.0-alpha') < 0, 'numeric identifier < alphanumeric');
  });

  test('missing/empty input -> inline, never throws (Postel: liberal-in-input)', () => {
    assert.strictEqual(detectWorkflowBackend({}).backend, 'inline');
    assert.strictEqual(detectWorkflowBackend(null).backend, 'inline');
    assert.strictEqual(detectWorkflowBackend(undefined).backend, 'inline');
    assert.strictEqual(detectWorkflowBackend({ runtimeId: 'claude' }).backend, 'inline');
  });

  test('BACKEND_VALUES exposes the closed enum', () => {
    assert.deepStrictEqual([...BACKEND_VALUES].sort(), ['auto', 'inline', 'workflow']);
  });

  test('property: pure & deterministic (same input -> same output)', () => {
    fc.assert(fc.property(
      fc.record({
        runtimeId: fc.constantFrom('claude', 'codex', 'cursor', 'opencode'),
        sdk: fc.option(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^\d/.test(s)), { nil: undefined }),
        backend: fc.constantFrom('auto', 'workflow', 'inline'),
        enabled: fc.boolean(),
      }),
      (input) => {
        const cfg = {
          'claude_orchestration.enabled': input.enabled,
          'claude_orchestration.execution_backend': input.backend,
        };
        const a = detectWorkflowBackend({ runtimeId: input.runtimeId, hostIntegration: CAPABLE_HOST, agentSdkVersion: input.sdk, config: cfg });
        const b = detectWorkflowBackend({ runtimeId: input.runtimeId, hostIntegration: CAPABLE_HOST, agentSdkVersion: input.sdk, config: cfg });
        assert.deepStrictEqual(a, b);
        assert.ok(['workflow', 'inline'].includes(a.backend));
      },
    ));
  });
});

// ─── 2. compareSemver helper ──────────────────────────────────────────────────

describe('compareSemver', () => {
  test('ordering', () => {
    assert.ok(compareSemver('1.0.0', '0.9.9') > 0);
    assert.ok(compareSemver('1.0.0', '1.0.0') === 0);
    assert.ok(compareSemver('1.0.0', '1.0.1') < 0);
    assert.ok(compareSemver('2.0.0', '1.9.9') > 0);
  });
  test('garbage versions compare as -1 (fail-closed)', () => {
    assert.strictEqual(compareSemver('garbage', '1.0.0'), -1);
    assert.strictEqual(compareSemver('1.0.0', ''), -1);
  });
});

// ─── 3. emitWorkflowScript ────────────────────────────────────────────────────

describe('emitWorkflowScript', () => {

  test('single-wave single-plan -> one parallel barrier, one agent, executor+worktree', () => {
    const { ok, script, summary } = emitWorkflowScript(singleWaveManifest());
    assert.strictEqual(ok, true);
    assert.ok(typeof script === 'string' && script.length > 0);

    const parallelCount = (script.match(/parallel\s*\(/g) || []).length;
    assert.ok(parallelCount >= 1, 'at least one parallel() barrier');
    assert.ok(script.includes('agent('), 'agent() call per plan');
    assert.ok(script.includes('gsd-executor'), 'uses gsd-executor agentType');
    assert.ok(script.includes('worktree'), 'uses worktree isolation');
    assert.ok(script.includes('SUMMARY.md'), 'produces SUMMARY.md (same artifact as inline path)');

    assert.deepStrictEqual(summary.waves, 1);
    assert.deepStrictEqual(summary.plans, 1);
  });

  test('multi-wave -> one parallel() barrier per wave (sequential barriers)', () => {
    const r = emitWorkflowScript({
      phaseDir: '.planning/phases/01-foo',
      runId: 'run-multi',
      waves: [
        { id: 'w1', plans: [{ id: 'p1', brief: 'A', files_modified: ['src/a.cts'] }] },
        { id: 'w2', plans: [{ id: 'p2', brief: 'B', files_modified: ['src/b.cts'] }] },
        { id: 'w3', plans: [{ id: 'p3', brief: 'C', files_modified: ['src/c.cts'] }] },
      ],
    });
    assert.strictEqual(r.ok, true);
    const parallelCount = (r.script.match(/parallel\s*\(/g) || []).length;
    assert.strictEqual(parallelCount, 3, 'one parallel() per wave');
    assert.strictEqual(r.summary.waves, 3);
    assert.strictEqual(r.summary.plans, 3);
  });

  test('overlapping files_modified -> plans split into separate sequential stages (criterion 2)', () => {
    const r = emitWorkflowScript(overlappingManifest());
    assert.strictEqual(r.ok, true);
    // Two plans sharing src/shared.cts must NOT be in the same stage.
    const stages = r.summary.stagesByWave[0]; // wave w1
    assert.ok(Array.isArray(stages), 'stagesByWave present');
    assert.strictEqual(stages.length, 2, 'overlapping plans split into 2 stages');
    const stagePlanSets = stages.map((s) => s.slice().sort());
    const allPlans = stagePlanSets.flat().sort();
    assert.deepStrictEqual(allPlans, ['p1', 'p2']);
    // p1 and p2 must be in different stages
    assert.ok(stages[0].length === 1 && stages[1].length === 1, 'one plan per stage when they overlap');
  });

  test('non-overlapping plans -> coalesced into a single parallel stage', () => {
    const r = emitWorkflowScript(nonOverlappingManifest());
    assert.strictEqual(r.ok, true);
    const stages = r.summary.stagesByWave[0];
    assert.strictEqual(stages.length, 1, 'non-overlapping plans share one stage');
    assert.deepStrictEqual(stages[0].slice().sort(), ['p1', 'p2']);
  });

  test('runId carried for the caller, never CALLED as resumeFromRunId (criterion 4, #2590)', () => {
    const r = emitWorkflowScript(singleWaveManifest());
    // resumeFromRunId is a Workflow TOOL INPUT parameter, not a script function;
    // emitting a call threw "resumeFromRunId is not defined" and rejected the
    // whole script. The id reaches the caller via summary.resumeRunId.
    assert.ok(!/^\s*resumeFromRunId\s*\(/m.test(r.script), 'must not CALL resumeFromRunId');
    assert.ok(r.script.includes('run-abc-1143'), 'carries the run id for the caller');
    assert.strictEqual(r.summary.resumeRunId, 'run-abc-1143');
  });

  test('budgetTokens recorded as intent, never CALLED as budget() (#2590)', () => {
    const r = emitWorkflowScript({ ...singleWaveManifest(), budgetTokens: 500000 });
    // `budget` is a read-only object { total, spent(), remaining() } supplied by
    // the caller's token directive; `budget(500000)` threw "budget is not a
    // function". The intent is recorded in a comment and in the summary.
    assert.ok(!/^\s*budget\s*\(/m.test(r.script), 'must not CALL budget()');
    assert.ok(r.script.includes('500000'), 'records the intended budget');
    assert.strictEqual(r.summary.budgetTokens, 500000);
  });

  test('no budget() emitted when budgetTokens omitted', () => {
    const r = emitWorkflowScript(singleWaveManifest());
    assert.ok(!r.script.includes('budget('), 'no budget() when unset');
  });

  test('invalid input -> ok:false with a reason, never throws', () => {
    const empty = emitWorkflowScript({ phaseDir: '.p', runId: 'r', waves: [] });
    assert.strictEqual(empty.ok, false);
    assert.ok(typeof empty.reason === 'string' && empty.reason.length > 0);

    const noRun = emitWorkflowScript({ phaseDir: '.p', runId: '', waves: singleWaveManifest().waves });
    assert.strictEqual(noRun.ok, false);

    const noPhase = emitWorkflowScript({ phaseDir: '', runId: 'r', waves: singleWaveManifest().waves });
    assert.strictEqual(noPhase.ok, false);

    const badWave = emitWorkflowScript({ phaseDir: '.p', runId: 'r', waves: [{ id: 'w1', plans: [] }] });
    assert.strictEqual(badWave.ok, false);
  });

  test('SECURITY: runId/phaseDir/wave.id/plan.id with injection chars -> ok:false (never reach the script)', () => {
    // runId is interpolated inside resumeFromRunId("...") — a quote/backslash/newline
    // could break out of the call. Identifier validation must reject it.
    const injectRun = emitWorkflowScript({ phaseDir: '.p', runId: 'x");evil("y', waves: singleWaveManifest().waves });
    assert.strictEqual(injectRun.ok, false);
    assert.match(injectRun.reason, /runId/i);

    const newlineRun = emitWorkflowScript({ phaseDir: '.p', runId: 'r\nbreakout', waves: singleWaveManifest().waves });
    assert.strictEqual(newlineRun.ok, false);

    const injectPhase = emitWorkflowScript({ phaseDir: '.p"; drop table', runId: 'r', waves: singleWaveManifest().waves });
    assert.strictEqual(injectPhase.ok, false);

    const injectWave = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1\nagent("evil")', plans: [{ id: 'p1', brief: 'b', files_modified: ['a.cts'] }] }],
    });
    assert.strictEqual(injectWave.ok, false);

    const injectPlan = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1', plans: [{ id: 'p1";x("y', brief: 'b', files_modified: ['a.cts'] }] }],
    });
    assert.strictEqual(injectPlan.ok, false);
  });

  test('SECURITY: a brief containing quotes/backslash/newlines is neutralised (never breaks the string literal)', () => {
    const r = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1', plans: [{ id: 'p1', brief: 'he said "hi" \\ then \n newline', files_modified: ['a.cts'] }] }],
    });
    assert.strictEqual(r.ok, true);
    // The emitted script must not contain a raw unescaped quote that closes the
    // agent() string literal, nor a raw newline inside the brief.
    assert.ok(!r.script.includes('he said "hi" \\\\'), 'no unescaped breakout');
    // The full brief text never appears verbatim with its dangerous chars intact.
    assert.ok(!r.script.includes('"hi"'), 'the inner quote must be JSON-escaped, not raw');
  });

  test('duplicate plan id within a wave -> ok:false (L-5: no silent brief loss)', () => {
    const r = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1', plans: [
        { id: 'p1', brief: 'first', files_modified: ['a.cts'] },
        { id: 'p1', brief: 'second', files_modified: ['b.cts'] },
      ] }],
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /duplicate/i);
  });

  test('non-string files_modified entries -> ok:false (L-7: strict element typing)', () => {
    const r = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1', plans: [{ id: 'p1', brief: 'b', files_modified: ['ok.cts', 42, { path: 'x' }] }] }],
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /files_modified/);
  });

  test('property: deterministic (same input -> identical script)', () => {
    fc.assert(fc.property(
      fc.record({
        runId: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /^[a-zA-Z0-9-]+$/.test(s)),
        nPlans: fc.integer({ min: 1, max: 5 }),
      }),
      ({ runId, nPlans }) => {
        const waves = [{
          id: 'w1',
          plans: Array.from({ length: nPlans }, (_, i) => ({
            id: 'p' + i,
            brief: 'brief ' + i,
            files_modified: ['src/file' + i + '.cts'],
          })),
        }];
        const a = emitWorkflowScript({ phaseDir: '.planning/phases/01-x', runId, waves });
        const b = emitWorkflowScript({ phaseDir: '.planning/phases/01-x', runId, waves });
        assert.strictEqual(a.script, b.script);
        assert.deepStrictEqual(a.summary, b.summary);
      },
    ));
  });
});

// ─── 3.5. Per-plan use_worktree (#2772 / #2285 finding 1) ─────────────────────
//
// The Workflow backend must NEVER force worktree isolation on a plan the
// inline path (execute-phase.md step 2.5's USE_WORKTREES_FOR_PLAN) keeps out
// of worktrees — e.g. a submodule-touching plan, where the executor commit
// protocol cannot correctly handle submodule commits inside an isolated
// worktree. `use_worktree` is the per-plan signal that threads that decision
// into the emitted script.

describe('emitWorkflowScript — per-plan use_worktree (#2772 / #2285 finding 1)', () => {
  test('[happy] use_worktree omitted (default) -> isolation: "worktree" (backward-compatible default)', () => {
    const r = emitWorkflowScript(singleWaveManifest());
    assert.strictEqual(r.ok, true);
    assert.match(r.script, /agent\("Implement the foo module", \{ agentType: "gsd-executor", isolation: "worktree" \}\)/);
  });

  test('[happy] use_worktree: true explicit -> isolation: "worktree" (same as default)', () => {
    const r = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1', plans: [{ id: 'p1', brief: 'b', files_modified: ['a.cts'], use_worktree: true }] }],
    });
    assert.strictEqual(r.ok, true);
    assert.match(r.script, /agent\("b", \{ agentType: "gsd-executor", isolation: "worktree" \}\)/);
  });

  test('[negative] use_worktree: false -> isolation OMITTED entirely for that plan', () => {
    const r = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1', plans: [{ id: 'p1', brief: 'submodule plan', files_modified: ['vendor/lib.c'], use_worktree: false }] }],
    });
    assert.strictEqual(r.ok, true);
    assert.match(r.script, /agent\("submodule plan", \{ agentType: "gsd-executor" \}\)/);
    assert.ok(!/agent\("submodule plan"[^)]*isolation/.test(r.script), 'isolation must not appear for this plan\'s agent() call');
  });

  test('[happy] mixed wave: one worktree plan + one non-worktree plan in the SAME parallel() batch — each carries its own isolation independently', () => {
    const r = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1', plans: [
        { id: 'p1', brief: 'normal plan', files_modified: ['src/a.ts'] },
        { id: 'p2', brief: 'submodule plan', files_modified: ['vendor/b.c'], use_worktree: false },
      ] }],
    });
    assert.strictEqual(r.ok, true);
    // Both plans have disjoint files_modified -> coalesce into ONE parallel() stage.
    assert.strictEqual(r.summary.stagesByWave[0].length, 1, 'non-overlapping plans share one stage');
    assert.match(r.script, /agent\("normal plan", \{ agentType: "gsd-executor", isolation: "worktree" \}\)/);
    assert.match(r.script, /agent\("submodule plan", \{ agentType: "gsd-executor" \}\)/);
    assert.ok(!/agent\("submodule plan"[^)]*isolation/.test(r.script), 'the submodule plan must never gain isolation from being batched with a worktree plan');
  });

  test('[negative] use_worktree with a non-boolean value -> ok:false (strict typing, no silent coercion)', () => {
    const r = emitWorkflowScript({
      phaseDir: '.p', runId: 'r',
      waves: [{ id: 'w1', plans: [{ id: 'p1', brief: 'b', files_modified: ['a.cts'], use_worktree: 'false' }] }],
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /use_worktree/);
  });

  test('property: use_worktree never flips to isolation:"worktree" when explicitly false, across random plan shapes', () => {
    fc.assert(fc.property(
      fc.array(
        fc.record({
          id: fc.integer({ min: 0, max: 999 }).map((n) => 'p' + n),
          brief: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/[\r\n"\\]/.test(s)),
          useWorktree: fc.boolean(),
        }),
        { minLength: 1, maxLength: 4 },
      ).filter((plans) => new Set(plans.map((p) => p.id)).size === plans.length), // unique ids
      (planSpecs) => {
        // Only plan IDs are unique — briefs may legitimately collide (fast-check
        // shrinks toward short/empty strings, so duplicate briefs are common).
        // emitWorkflowScript emits one agent() per plan keyed by the brief label
        // and is correct for duplicate briefs, but the per-plan line lookup below
        // (indexOf) would find the FIRST occurrence and misattribute its isolation
        // when two plans share a brief. Make each agent() label unique by suffixing
        // the unique id, so the lookup is unambiguous — this disambiguates the TEST
        // probe, it does not change what the code under test does.
        const labelFor = (p) => p.brief + ' [' + p.id + ']';
        const waves = [{
          id: 'w1',
          plans: planSpecs.map((p, i) => ({
            id: p.id,
            brief: labelFor(p),
            files_modified: ['src/file' + i + '.cts'], // disjoint -> no overlap-driven staging noise
            use_worktree: p.useWorktree,
          })),
        }];
        const r = emitWorkflowScript({ phaseDir: '.p', runId: 'r', waves });
        assert.strictEqual(r.ok, true);
        for (const p of planSpecs) {
          const briefEsc = JSON.stringify(labelFor(p));
          const idx = r.script.indexOf('agent(' + briefEsc + ',');
          assert.ok(idx !== -1, 'agent() call for plan must exist');
          const lineEnd = r.script.indexOf('\n', idx);
          const line = r.script.slice(idx, lineEnd === -1 ? undefined : lineEnd);
          if (p.useWorktree === false) {
            assert.ok(!line.includes('isolation'), 'use_worktree:false must never carry isolation');
          } else {
            assert.ok(line.includes('isolation: "worktree"'), 'use_worktree:true must carry isolation: "worktree"');
          }
        }
      },
    ));
  });
});

// ─── 3.6. #3674 — pre-extraction characterization (golden output pins) ────────
//
// `partitionStages` is being extracted into a standalone, generic module
// (`file-overlap-partitioner.cts`). The extraction's acceptance bar is
// byte-identical output from `resolveWaveDispatch` and `emitWorkflowScript`
// (#3674's own callers) — NOT improved output. These tests pin the ACTUAL
// current production output (captured from the unmodified, pre-extraction
// code) for representative multi-plan fixtures, so the extraction cannot
// silently change what either function returns. They must pass BOTH before
// AND after the extraction lands.

describe('#3674 — pre-extraction characterization (golden output pins)', () => {

  test('characterization: chain-overlap plans (A∩B, B∩C, A∌C) produce the greedy, non-optimal stage assignment', () => {
    // A and B share f2; B and C share f3; A and C share nothing. A minimal
    // packing could put A and C together after B — greedy first-fit does NOT
    // find that; it processes in input order and is not required to be optimal.
    const r = emitWorkflowScript({
      phaseDir: '.planning/phases/01-chain',
      runId: 'run-chain-3674',
      waves: [{
        id: 'w1',
        plans: [
          { id: 'A', brief: 'Plan A', files_modified: ['f1.ts', 'f2.ts'] },
          { id: 'B', brief: 'Plan B', files_modified: ['f2.ts', 'f3.ts'] },
          { id: 'C', brief: 'Plan C', files_modified: ['f3.ts', 'f4.ts'] },
        ],
      }],
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.summary.stagesByWave, [[['A', 'C'], ['B']]]);
  });

  test('characterization: two plans with empty files_modified coalesce into stage 0 without colliding', () => {
    const r = emitWorkflowScript({
      phaseDir: '.planning/phases/01-empty',
      runId: 'run-empty-3674',
      waves: [{
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'Plan with no files', files_modified: [] },
          { id: 'p2', brief: 'Another empty plan', files_modified: [] },
        ],
      }],
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.summary.stagesByWave, [[['p1', 'p2']]]);
  });

  test('characterization: resolveWaveDispatch output is captured before extraction and is byte-identical after (multi-wave, multi-stage fixture)', () => {
    const CAPABLE_HOST_3674 = { dispatch: { namedDispatch: true, nested: true, background: true, backgroundDispatch: false } };
    const input = {
      runtimeId: 'claude',
      hostIntegration: CAPABLE_HOST_3674,
      agentSdkVersion: '1.2.0',
      config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'workflow' },
      phaseDir: '.planning/phases/01-resolve3674',
      runId: 'run-resolve-3674',
      waves: [
        { id: 'w1', plans: [
          { id: 'p1', brief: 'Plan P1', files_modified: ['src/shared.cts', 'src/a.cts'] },
          { id: 'p2', brief: 'Plan P2', files_modified: ['src/shared.cts', 'src/b.cts'] },
          { id: 'p3', brief: 'Plan P3', files_modified: ['src/c.cts'] },
        ] },
        { id: 'w2', plans: [
          { id: 'p4', brief: 'Plan P4', files_modified: [] },
        ] },
      ],
    };

    const r = resolveWaveDispatch(input);

    assert.strictEqual(r.backend, 'workflow');
    assert.strictEqual(r.reason, 'workflow_backend_active');
    assert.deepStrictEqual(r.summary, {
      waves: 2,
      plans: 4,
      worktreePlans: 4,
      stagesByWave: [[['p1', 'p3'], ['p2']], [['p4']]],
      resumeRunId: 'run-resolve-3674',
      budgetTokens: null,
    });

    // Golden script captured verbatim from the unmodified pre-extraction
    // production code (`node -e` against `gsd-core/bin/lib/claude-orchestration.cjs`
    // before any source under this phase was touched). Any divergence here is
    // an observable behavior change in the emitted Workflow script.
    const GOLDEN_SCRIPT_3674 = [
      'export const meta = {',
      '  name: "gsd-execute-run-resolve-3674",',
      '  description: "GSD wave dispatch for .planning/phases/01-resolve3674",',
      '  phases: [',
      '    { title: "Wave w1", detail: "3 plan(s)" },',
      '    { title: "Wave w2", detail: "1 plan(s)" },',
      '  ],',
      '}',
      '',
      '// GSD Workflow script — generated by the claude-orchestration capability (#1143)',
      '// phase: .planning/phases/01-resolve3674',
      '// BETA: preview-grade; on any failure the orchestrator falls back to inline dispatch.',
      '// Composes the SAME gsd-executor agent as the inline path, so artifacts (SUMMARY.md)',
      '// and commits are produced identically. Worktree isolation is per-plan (use_worktree)',
      '// and mirrors execute-phase.md step 2.5\'s submodule gate exactly (#2772 / #2285).',
      '// model: none applied — resolved to "inherit"/empty, so each agent inherits the',
      '// orchestrator model (#2517: emitting an empty model 404s on some runtimes).',
      '//',
      '// resume: pass "run-resolve-3674" as the Workflow tool\'s resumeFromRunId input',
      '// (it is a tool parameter, NOT a script function).',
      '',
      '// #3302: extract the executor-returned <worktree_metadata> JSON so the',
      '// orchestrator can record it into WAVE_WORKTREE_MANIFEST after the run',
      '// (worktree.record-agent -> worktree.cleanup-wave, the same manifest-scoped',
      '// merge chain inline dispatch feeds). null = absent/unparseable/interrupted.',
      'function gsdWorktreeMetadata(agentResult) {',
      '  if (typeof agentResult !== \'string\') return null;',
      '  const m = agentResult.match(/<worktree_metadata>([\\s\\S]*?)<\\/worktree_metadata>/);',
      '  if (m === null) return null;',
      '  try {',
      '    const parsed = JSON.parse(m[1]);',
      '    return (parsed !== null && typeof parsed === \'object\') ? parsed : null;',
      '  } catch (e) {',
      '    return null;',
      '  }',
      '}',
      'const gsdAgentOutcomes = [];',
      '',
      '// Wave w1',
      'phase("Wave w1")',
      '// Stage 0',
      'const gsdStage_0_0 = await parallel([',
      '  () => agent("Plan P1", { agentType: "gsd-executor", isolation: "worktree" }),',
      '  () => agent("Plan P3", { agentType: "gsd-executor", isolation: "worktree" }),',
      '])',
      'gsdAgentOutcomes.push(',
      '  { plan: "p1", expects_worktree: true, metadata: gsdWorktreeMetadata(gsdStage_0_0[0]) },',
      '  { plan: "p3", expects_worktree: true, metadata: gsdWorktreeMetadata(gsdStage_0_0[1]) }',
      ')',
      '// Stage 1 (sequential — files_modified overlap)',
      'const gsdStage_0_1 = await parallel([',
      '  () => agent("Plan P2", { agentType: "gsd-executor", isolation: "worktree" }),',
      '])',
      'gsdAgentOutcomes.push(',
      '  { plan: "p2", expects_worktree: true, metadata: gsdWorktreeMetadata(gsdStage_0_1[0]) }',
      ')',
      '',
      '// Wave w2',
      'phase("Wave w2")',
      'const gsdStage_1_0 = await parallel([',
      '  () => agent("Plan P4", { agentType: "gsd-executor", isolation: "worktree" }),',
      '])',
      'gsdAgentOutcomes.push(',
      '  { plan: "p4", expects_worktree: true, metadata: gsdWorktreeMetadata(gsdStage_1_0[0]) }',
      ')',
      'return gsdAgentOutcomes',
    ].join('\n');

    assert.strictEqual(r.script, GOLDEN_SCRIPT_3674);
  });
});

// ─── 4. Capability declaration validation ─────────────────────────────────────

describe('capability declaration (capabilities/claude-orchestration/capability.json)', () => {

  test('file exists and parses', () => {
    const cap = loadCap();
    assert.strictEqual(cap.id, 'claude-orchestration');
  });

  test('passes per-file validateCapability', () => {
    const errors = validateCapability(loadCap(), 'claude-orchestration');
    assert.deepEqual(errors, [], 'Expected no validation errors: ' + JSON.stringify(errors));
  });

  test('passes contract validation (contribution.into roles, when references)', () => {
    const errors = validateAgainstContract(loadCap(), 'claude-orchestration');
    assert.deepEqual(errors, [], 'Expected no contract errors: ' + JSON.stringify(errors));
  });

  test('default-off: activationKey default is false and points at the enabled key', () => {
    const cap = loadCap();
    assert.strictEqual(cap.activationKey, 'claude_orchestration.enabled');
    assert.strictEqual(cap.config['claude_orchestration.enabled'].default, false);
    assert.strictEqual(cap.config['claude_orchestration.enabled'].type, 'boolean');
  });

  test('runtimeCompat is claude-only (criterion 6)', () => {
    const cap = loadCap();
    assert.deepStrictEqual(cap.runtimeCompat.supported, ['claude']);
    assert.deepStrictEqual(cap.runtimeCompat.unsupported, []);
  });

  test('BETA posture: tier full, role feature', () => {
    const cap = loadCap();
    assert.strictEqual(cap.role, 'feature');
    assert.strictEqual(cap.tier, 'full');
  });

  test('execution_backend is an enum with auto|workflow|inline defaulting to auto', () => {
    const slice = loadCap().config['claude_orchestration.execution_backend'];
    assert.strictEqual(slice.type, 'enum');
    assert.deepStrictEqual(slice.values, ['auto', 'workflow', 'inline']);
    assert.strictEqual(slice.default, 'auto');
  });

  test('registers at WIRED points only (execute:wave:pre, plan:post)', () => {
    const cap = loadCap();
    const points = cap.contributions.map((c) => c.point);
    for (const p of points) {
      assert.ok(
        ['discuss:pre', 'discuss:post', 'plan:pre', 'plan:post', 'execute:pre', 'execute:wave:pre', 'execute:post', 'verify:post', 'ship:pre', 'ship:post'].includes(p),
        'contribution point ' + p + ' must be a wired point',
      );
    }
    // #2285: the dispatch-backend selector moved from execute:wave:post (fires
    // AFTER the wave already dispatched inline — too late to select a backend)
    // to execute:wave:pre (fires BEFORE step 3's Agent() dispatch).
    assert.ok(points.includes('execute:wave:pre'), 'registers the pre-wave dispatch-selector hook');
    assert.ok(points.includes('plan:post'), 'declares plan:* ownership for ultraplan (criterion 5)');
  });

  test('all contributions gated by the enabled key + onError:skip (default-resilient)', () => {
    const cap = loadCap();
    for (const c of cap.contributions) {
      assert.strictEqual(c.when, 'claude_orchestration.enabled', 'every contribution gated by enabled');
      assert.strictEqual(c.onError, 'skip', 'every contribution onError:skip');
    }
  });
});

// ─── 5. Registry integration ──────────────────────────────────────────────────

describe('registry integration', () => {

  test('loadAndValidate includes claude-orchestration with no errors', () => {
    const { capMap, errors } = loadAndValidate(new Set()); // empty central keys = no collision noise
    // Filter errors to only those touching our capability.
    const ours = errors.filter((e) => e.includes('claude-orchestration'));
    assert.deepEqual(ours, [], 'our capability produced errors: ' + JSON.stringify(ours));
    assert.ok(capMap.has('claude-orchestration'), 'capMap includes claude-orchestration');
  });

  test('buildRegistry surfaces the federated config keys in configSchema', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    assert.ok(registry.configSchema['claude_orchestration.enabled'], 'enabled key federated');
    assert.ok(registry.configSchema['claude_orchestration.execution_backend'], 'execution_backend key federated');
    assert.strictEqual(registry.configSchema['claude_orchestration.enabled'].owner, 'claude-orchestration');
    assert.strictEqual(registry.configSchema['claude_orchestration.execution_backend'].default, 'auto');
  });

  test('byLoopPoint[execute:wave:pre].contributions includes our capability (#2285)', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const contribs = registry.byLoopPoint['execute:wave:pre'].contributions;
    const ours = contribs.find((c) => c.capId === 'claude-orchestration');
    assert.ok(ours, 'our execute:wave:pre contribution is registered');
    assert.strictEqual(ours.into, 'executor');
  });

  test('byLoopPoint[execute:wave:post] no longer carries our contribution (#2285 moved it to wave:pre)', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const contribs = registry.byLoopPoint['execute:wave:post'].contributions;
    const ours = contribs.find((c) => c.capId === 'claude-orchestration');
    assert.strictEqual(ours, undefined, 'claude-orchestration must not remain at execute:wave:post');
  });

  test('committed registry is in sync (gen-capability-registry --check)', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const live = serializeRegistry(registry, capMap);
    const committed = fs.readFileSync(REGISTRY_PATH, 'utf8');
    assert.strictEqual(
      normalizeLineEndings(stripGeneratedComment(committed)),
      normalizeLineEndings(stripGeneratedComment(live)),
      'registry is stale — run: node scripts/gen-capability-registry.cjs --write',
    );
  });
});

// ─── 6. Inline-fallback parity (criterion 3 + 6) ──────────────────────────────

describe('inline-fallback parity', () => {

  test('default config (capability off) -> inline on every runtime, including Claude', () => {
    // The capability ships default-off; with no user opt-in the backend is always inline.
    const defaultCfg = {}; // nothing set
    for (const runtimeId of ['claude', 'codex', 'cursor', 'opencode']) {
      const r = detectWorkflowBackend({
        runtimeId,
        hostIntegration: CAPABLE_HOST,
        agentSdkVersion: '1.0.0',
        config: defaultCfg,
      });
      assert.strictEqual(r.backend, 'inline', runtimeId + ' default must be inline');
      assert.strictEqual(r.available, false, runtimeId + ' default must be unavailable');
    }
  });

  test('generated Workflow script preserves the inline-path contract (same agent + isolation + artifact)', () => {
    // Criterion 2: the emitted Workflow composes the SAME gsd-executor agent and worktree
    // isolation the inline path uses, and produces the same SUMMARY.md artifact.
    const r = emitWorkflowScript(singleWaveManifest());
    assert.ok(r.script.includes('gsd-executor'), 'same executor agent as inline dispatch');
    assert.ok(r.script.includes('worktree'), 'same worktree isolation as inline dispatch');
    assert.ok(r.script.includes('SUMMARY.md'), 'same SUMMARY.md artifact as inline dispatch');
  });
});

// ─── #2686 — executor-model threading ────────────────────────────────────────
//
// The Workflow backend emitted every agent() call with no model at all, so
// model_overrides / model_policy / model_profile were silently inert on that
// path while the inline path honored them — the invisible partial application
// ADR-1411 prohibits. These pin the parity the generated script already claims.

describe('#2686 — Workflow backend model threading', () => {
  const {
    resolveWaveDispatch: resolveWaveDispatch2686,
  } = require('../gsd-core/bin/lib/claude-orchestration.cjs');
  const modelResolver2686 = require('../gsd-core/bin/lib/model-resolver.cjs');
  const { runGsdTools: runTools2686, createTempProject: mkProject2686, cleanup: rm2686 } =
    require('./helpers.cjs');

  const WAVES_2686 = [
    { id: '1', plans: [
      { id: '01', brief: 'Implement the auth module', files_modified: ['src/auth.ts'] },
      { id: '02', brief: 'Add the config loader', files_modified: ['src/config.ts'] },
    ] },
  ];

  const emit2686 = (extra) => emitWorkflowScript({
    phaseDir: '.planning/phases/01-demo',
    runId: 'wf_test2686',
    waves: WAVES_2686,
    ...extra,
  });

  // The emitted agent() options objects only. Scoped deliberately: the #2686
  // provenance header legitimately contains the token "model:", so a whole-script
  // regex would report a false positive on the omit path.
  //
  // Brace-and-string aware rather than /\{[^}]*\}/: a model value may legitimately
  // contain a brace, and a naive class would truncate the object there and silently
  // stop testing what it claims to test.
  const optionsOf = (script) => {
    const out = [];
    const re = /\bagent\(/g;
    let m;
    while ((m = re.exec(script)) !== null) {
      const open = script.indexOf('{', m.index);
      if (open === -1) continue;
      let i = open + 1;
      let depth = 1;
      let str = null;
      while (i < script.length && depth > 0) {
        const ch = script[i];
        if (str) {
          if (ch === '\\') i += 1;
          else if (ch === str) str = null;
        } else if (ch === '"' || ch === "'") str = ch;
        else if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        i += 1;
      }
      if (depth === 0) out.push(script.slice(open, i));
    }
    return out.filter((o) => o.includes('agentType'));
  };

  test('#2686: the Workflow backend dispatches the same model the inline path would use', () => {
    const dir = mkProject2686('gsd-2686-');
    try {
      fs.writeFileSync(
        path.join(dir, '.planning', 'config.json'),
        JSON.stringify({ model_profile: 'balanced', model_overrides: { 'gsd-executor': 'opus' } }),
      );
      // The inline path reads exactly this. Deriving BOTH sides from the resolver
      // (rather than hardcoding either) is what makes this a parity assertion.
      const inlineModel = modelResolver2686.resolveModelInternal(dir, 'gsd-executor');
      assert.equal(inlineModel, 'opus', 'precondition: the override must resolve');

      const res = emit2686({ executorModel: inlineModel });
      assert.ok(res.ok, `emit failed: ${res.reason}`);
      const calls = res.script.match(/agent\([\s\S]*?\{[^}]*\}/g) || [];
      assert.ok(calls.length >= 2, `expected >=2 agent() calls, got ${calls.length}`);
      for (const call of calls) {
        assert.match(
          call,
          /model:\s*"opus"/,
          'every dispatched plan must carry the model the inline path resolved — ' +
            'without it model_overrides/model_policy are silently inert on this backend (#2686).',
        );
      }
    } finally {
      rm2686(dir);
    }
  });

  test('#2686: omits the model key when the resolved model is inherit or empty', () => {
    // #2517: an empty/inherit model must be OMITTED, never emitted — emitting it
    // 404s on runtimes without native tier aliases.
    for (const value of ['inherit', 'INHERIT', '  inherit  ', ' ', '', undefined, null, 42, {}, []]) {
      const res = emit2686({ executorModel: value });
      assert.ok(res.ok, `emit failed for ${JSON.stringify(value)}: ${res.reason}`);
      const opts = optionsOf(res.script);
      assert.ok(opts.length >= 2, `expected per-plan options objects, got ${opts.length}`);
      for (const o of opts) {
        assert.doesNotMatch(
          o,
          /model:/,
          `executorModel=${JSON.stringify(value)} must omit the model key entirely (#2517)`,
        );
      }
    }
  });

  test('#2686: emits byte-identical output when no model resolves', () => {
    // The compatibility contract: every existing caller and assertion is unaffected
    // unless a model actually resolves.
    const withNothing = emit2686({});
    const withInherit = emit2686({ executorModel: 'inherit' });
    const withEmpty = emit2686({ executorModel: '' });
    assert.ok(withNothing.ok && withInherit.ok && withEmpty.ok);
    assert.equal(withInherit.script, withNothing.script);
    assert.equal(withEmpty.script, withNothing.script);
  });

  test('#2686: model threading does not disturb the per-plan worktree gate', () => {
    // #2772 / #2285 finding 1 — agentOptions is "the single place that decides
    // worktree isolation; it must never diverge from the inline path's per-plan gate."
    const res = emitWorkflowScript({
      phaseDir: '.planning/phases/01-demo',
      runId: 'wf_test2686b',
      executorModel: 'sonnet',
      waves: [{ id: '1', plans: [
        { id: '01', brief: 'plan without isolation', files_modified: ['a.ts'], use_worktree: false },
        { id: '02', brief: 'plan with isolation', files_modified: ['b.ts'] },
      ] }],
    });
    assert.ok(res.ok, `emit failed: ${res.reason}`);
    const calls = res.script.match(/agent\([\s\S]*?\{[^}]*\}/g) || [];
    assert.equal(calls.length, 2, 'per-plan options objects must remain one per plan');

    const noWt = calls.find((c) => c.includes('plan without isolation'));
    const wt = calls.find((c) => c.includes('plan with isolation'));
    assert.ok(noWt && wt, 'both plans must be present');
    assert.doesNotMatch(noWt, /isolation:/, 'use_worktree:false must still suppress isolation');
    assert.match(noWt, /model:\s*"sonnet"/, 'model must still be threaded on the no-worktree plan');
    assert.match(wt, /isolation:\s*"worktree"/, 'default plan must still get worktree isolation');
    assert.match(wt, /model:\s*"sonnet"/, 'model must be threaded on the worktree plan');
  });

  test('#2686: a model id carrying a script-breaking character is rejected outright', () => {
    // The model id is externally-supplied config (model_overrides / model_policy)
    // reaching a CODE GENERATOR. It is interpolated into BOTH an object literal
    // and a `//` provenance comment.
    //
    // quoteString (JSON.stringify) is sufficient for the object literal but NOT
    // for the comment: U+2028 / U+2029 are ECMAScript LineTerminators that END a
    // single-line comment in every engine — the ES2019 change legalized them
    // inside string LITERALS only. A raw one would close the comment and make the
    // rest of the line live top-level code. Hence: reject, do not merely quote.
    const hostile = [
      'evil\u2028process.exit(42);//',   // proven comment-terminator injection
      'evil\u2029process.exit(42);//',
      'a\nb', 'a\rb', 'a"b', 'a\\b', 'a\tb', 'a\u0000b', 'a\u007fb',
    ];
    for (const id of hostile) {
      const res = emit2686({ executorModel: id });
      assert.equal(
        res.ok,
        false,
        `executorModel ${JSON.stringify(id)} must be REJECTED, not emitted — it can ` +
          'terminate the provenance comment and execute as top-level code.',
      );
      assert.match(res.reason, /executorModel must not contain/);
    }
  });

  test('#2686: the emitted provenance comment cannot become live code', () => {
    // Execution-level proof, not a shape check: run the emitted header through a
    // parser and confirm the model value never escapes its comment/literal. A
    // previous version of this test asserted only that JSON.stringify was used,
    // which passed against the vulnerable generator.
    const good = emit2686({ executorModel: 'opus' });
    assert.ok(good.ok);
    const header = good.script.split('\n').filter((l) => l.startsWith('// model:'));
    assert.equal(header.length, 1, 'exactly one provenance line');
    for (const line of header) {
      assert.doesNotMatch(line, /[\u2028\u2029\r\n]/, 'no LineTerminator may survive into the comment');
    }
    // Every emitted comment line must still be a comment after parsing: wrapping
    // the header in a function body must produce no executable statement.
    const commentBlock = good.script.split('\n').filter((l) => l.startsWith('//')).join('\n');
    assert.doesNotThrow(() => new Function(commentBlock + '\nreturn 1;'));
    assert.equal(new Function(commentBlock + '\nreturn 1;')(), 1);
  });

  test('#2686: resolveWaveDispatch forwards the executor model to emission', () => {
    const res = resolveWaveDispatch2686({
      runtimeId: 'claude',
      hostIntegration: { dispatch: { nested: true, background: true } },
      config: { 'claude_orchestration.enabled': true },
      agentSdkVersion: '99.0.0',
      phaseDir: '.planning/phases/01-demo',
      runId: 'wf_test2686c',
      waves: WAVES_2686,
      executorModel: 'haiku',
    });
    assert.equal(res.backend, 'workflow', `expected workflow backend, got ${res.backend}: ${res.reason}`);
    assert.match(
      res.script,
      /model:\s*"haiku"/,
      'the #2285 composed seam the orchestrator actually calls must forward the model',
    );
  });

  test('#2686: the CLI defaults the executor model from project config', () => {
    const dir = mkProject2686('gsd-2686-cli-');
    try {
      fs.writeFileSync(
        path.join(dir, '.planning', 'config.json'),
        JSON.stringify({ model_profile: 'balanced', model_overrides: { 'gsd-executor': 'opus' } }),
      );
      const wavesPath = path.join(dir, 'waves.json');
      fs.writeFileSync(wavesPath, JSON.stringify({ waves: WAVES_2686 }));

      // No --executor-model: the router must resolve it from config, so the fix
      // applies with NO caller change.
      const dflt = runTools2686(
        ['claude-orchestration', 'emit-workflow', '--waves', wavesPath, '--run-id', 'wf_cli1'],
        dir,
      );
      assert.ok(dflt.success, `emit-workflow failed: ${dflt.error}`);
      assert.match(JSON.parse(dflt.output).script, /model:\s*"opus"/);

      // Explicit flag wins.
      const pinned = runTools2686(
        ['claude-orchestration', 'emit-workflow', '--waves', wavesPath, '--run-id', 'wf_cli2',
          '--executor-model', 'haiku'],
        dir,
      );
      assert.ok(pinned.success, `emit-workflow failed: ${pinned.error}`);
      assert.match(JSON.parse(pinned.output).script, /model:\s*"haiku"/);
    } finally {
      rm2686(dir);
    }
  });

  test('#2686: emitted options round-trip any resolved model (property)', () => {
    // Three-way contract over ARBITRARY strings:
    //   unscriptable char  → ok:false (rejected; it could terminate the // comment)
    //   trims to empty or "inherit" (any case) → ok:true, model key OMITTED (#2517)
    //   otherwise          → ok:true, model key emitted as the TRIMMED value
    // Mirrors UNSCRIPTABLE_CHAR_RE in src/claude-orchestration.cts, which is not
    // exported. The control-character class is the POINT of the check — these are
    // exactly the bytes that must be rejected — so the rule is disabled here rather
    // than the class weakened.
    // eslint-disable-next-line no-control-regex
    const UNSCRIPTABLE = /[\r\n"\\\x00-\x1f\x7f\u2028\u2029]/;
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (model) => {
        const res = emit2686({ executorModel: model });
        if (UNSCRIPTABLE.test(model)) {
          assert.equal(res.ok, false, `${JSON.stringify(model)} must be rejected`);
          return;
        }
        assert.ok(res.ok, `${JSON.stringify(model)} should emit: ${res.reason}`);
        const opts = optionsOf(res.script);
        assert.ok(opts.length >= 2, `expected per-plan options, got ${opts.length}`);
        const trimmed = model.trim();
        const shouldEmit = trimmed.length > 0 && trimmed.toLowerCase() !== 'inherit';
        for (const o of opts) {
          if (shouldEmit) {
            assert.ok(
              o.includes('model: ' + JSON.stringify(trimmed)),
              `expected model ${JSON.stringify(trimmed)} in ${o}`,
            );
          } else {
            assert.doesNotMatch(o, /model:/);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ─── #2285 — resolveWaveDispatch fail-closed gate ladder (folded from
// fix-2285-claude-orchestration-wiring.test.cjs) ──────────────────────────────
//
// #2285 — the `claude-orchestration` capability (Workflow backend, #1143) was
// registered `active` but fully INERT: `detectWorkflowBackend`/`emitWorkflowScript`
// had zero callers outside their own CLI router, and execute-phase.md declared
// `execute:wave:pre` as a hook point in its frontmatter but never rendered it —
// the wave loop only ever dispatched `execute:pre`, `execute:wave:post`, and
// `execute:post`. `claude_orchestration.enabled:true` therefore had no effect on
// a real execute-phase run.
//
// Fix (Approach B):
//   1. execute-phase.md now renders `execute:wave:pre` immediately before each
//      wave's agents are dispatched (step 2.75, before step 3's Agent() loop).
//   2. The claude-orchestration contribution moved from `execute:wave:post`
//      (fires too late — after the wave already dispatched inline) to
//      `execute:wave:pre` (fires before dispatch, where a backend selector
//      actually has to run to matter).
//   3. `resolveWaveDispatch` in src/claude-orchestration.cts composes
//      `detectWorkflowBackend` + `emitWorkflowScript` into ONE decision seam,
//      giving both functions a real caller outside their CLI router and outside
//      tests. It is also exposed via `gsd-tools claude-orchestration
//      resolve-wave-dispatch`.
//
// These drive the real seam (no source-grep on implementation files) and
// assert the fail-closed contract: disabled or any gate miss => inline,
// byte-identical to today's dispatch shape.

/** A host-integration descriptor whose dispatch axis signals Workflow-tool capability (#2285 fixture shape). */
const CAPABLE_HOST_2285 = { dispatch: { nested: true, background: true } };
/** A descriptor that fails the nested/background dispatch gate. */
const INCAPABLE_HOST = { dispatch: { nested: false, background: true } };

const ABOVE_FLOOR_SDK = '0.3.150';
const AT_FLOOR_SDK = WORKFLOW_TOOL_FLOOR_VERSION; // '0.3.149'
const BELOW_FLOOR_SDK = '0.3.148';

function enabledConfig(overrides = {}) {
  return {
    'claude_orchestration.enabled': true,
    'claude_orchestration.execution_backend': 'auto',
    ...overrides,
  };
}

function singleWave() {
  return {
    phaseDir: '.planning/phases/01-foo',
    runId: 'run-2285-1',
    waves: [
      {
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'Implement the foo module', files_modified: ['src/foo.cts'] },
        ],
      },
    ],
  };
}

function baseInput(overrides = {}) {
  return {
    runtimeId: 'claude',
    hostIntegration: CAPABLE_HOST_2285,
    agentSdkVersion: ABOVE_FLOOR_SDK,
    config: enabledConfig(),
    ...singleWave(),
    ...overrides,
  };
}

// ─── Section A: happy path — every gate satisfied → workflow backend ────────

describe('A. resolveWaveDispatch — enabled + all gates satisfied → workflow backend with emitted script', () => {
  test('[happy] enabled, claude runtime, capable host, SDK above floor, auto backend → backend:"workflow"', () => {
    const result = resolveWaveDispatch(baseInput());
    assert.strictEqual(result.backend, 'workflow');
    assert.strictEqual(result.reason, 'workflow_backend_active');
    assert.ok(typeof result.script === 'string' && result.script.length > 0, 'script must be a non-empty string');
    // #2590: resumeFromRunId is a Workflow TOOL INPUT, not a script function —
    // calling it threw "resumeFromRunId is not defined". The run id must still
    // reach the caller (which passes it as that input), but never as a call.
    assert.ok(!/^\s*resumeFromRunId\s*\(/m.test(result.script), 'must not CALL resumeFromRunId');
    assert.strictEqual(result.summary.resumeRunId, 'run-2285-1');
    assert.match(result.script, /agentType: "gsd-executor", isolation: "worktree"/);
    assert.ok(result.summary && result.summary.plans === 1, 'summary.plans must reflect the manifest');
  });

  test('[happy] execution_backend explicitly "workflow" (not just "auto") also activates', () => {
    const result = resolveWaveDispatch(baseInput({
      config: enabledConfig({ 'claude_orchestration.execution_backend': 'workflow' }),
    }));
    assert.strictEqual(result.backend, 'workflow');
  });

  test('[bva] SDK version boundary: floor-1 → inline, floor exact → workflow, floor+1 → workflow', () => {
    const below = resolveWaveDispatch(baseInput({ agentSdkVersion: BELOW_FLOOR_SDK }));
    assert.strictEqual(below.backend, 'inline', 'below floor must be inline');
    assert.strictEqual(below.reason, 'agent_sdk_version_below_floor');

    const at = resolveWaveDispatch(baseInput({ agentSdkVersion: AT_FLOOR_SDK }));
    assert.strictEqual(at.backend, 'workflow', 'exactly at floor must activate workflow');

    const above = resolveWaveDispatch(baseInput({ agentSdkVersion: ABOVE_FLOOR_SDK }));
    assert.strictEqual(above.backend, 'workflow', 'above floor must activate workflow');
  });
});

// ─── Section B: fail-closed contract — disabled / each gate individually failing → inline ──

describe('B. resolveWaveDispatch — fail-closed contract: disabled or any gate miss → inline, matches detectWorkflowBackend 1:1', () => {
  const GATE_MISS_CASES = [
    {
      label: 'capability disabled',
      overrides: { config: {} },
      expectedReason: 'capability_disabled',
    },
    {
      label: 'capability explicitly disabled',
      overrides: { config: enabledConfig({ 'claude_orchestration.enabled': false }) },
      expectedReason: 'capability_disabled',
    },
    {
      label: 'runtime is not claude',
      overrides: { runtimeId: 'codex' },
      expectedReason: 'runtime_not_claude',
    },
    {
      label: 'execution_backend explicitly "inline"',
      overrides: { config: enabledConfig({ 'claude_orchestration.execution_backend': 'inline' }) },
      expectedReason: 'backend_inline',
    },
    {
      label: 'host descriptor incapable (nested:false)',
      overrides: { hostIntegration: INCAPABLE_HOST },
      expectedReason: 'workflow_tool_unavailable',
    },
    {
      label: 'host descriptor missing entirely',
      overrides: { hostIntegration: null },
      expectedReason: 'workflow_tool_unavailable',
    },
    {
      label: 'agent SDK version missing',
      overrides: { agentSdkVersion: undefined },
      expectedReason: 'agent_sdk_version_unknown',
    },
    {
      label: 'agent SDK version malformed (not semver)',
      overrides: { agentSdkVersion: 'not-a-version' },
      expectedReason: 'agent_sdk_version_unknown',
    },
    {
      label: 'agent SDK version below floor',
      overrides: { agentSdkVersion: BELOW_FLOOR_SDK },
      expectedReason: 'agent_sdk_version_below_floor',
    },
  ];

  for (const { label, overrides, expectedReason } of GATE_MISS_CASES) {
    test(`[negative] ${label} → backend:"inline", reason:"${expectedReason}"`, () => {
      const input = baseInput(overrides);
      const result = resolveWaveDispatch(input);

      assert.strictEqual(result.backend, 'inline', `${label}: must resolve to inline`);
      assert.strictEqual(result.reason, expectedReason, `${label}: reason mismatch`);

      // Fail-closed CONTRACT: today's (byte-identical) inline dispatch carries no
      // script/summary. Verify the shape never leaks emitter fields on a gate miss.
      assert.deepStrictEqual(
        Object.keys(result).sort(),
        ['backend', 'reason'],
        `${label}: inline result must be exactly {backend, reason}, got keys: ${Object.keys(result).join(',')}`,
      );

      // Parity: resolveWaveDispatch must not reimplement the gate ladder — its
      // reason for a detect-side miss must be IDENTICAL to calling
      // detectWorkflowBackend directly with the same gate-relevant fields.
      const direct = detectWorkflowBackend({
        runtimeId: input.runtimeId,
        hostIntegration: input.hostIntegration,
        config: input.config,
        agentSdkVersion: input.agentSdkVersion,
      });
      assert.strictEqual(direct.backend, 'inline', `${label}: detectWorkflowBackend parity check must also be inline`);
      assert.strictEqual(result.reason, direct.reason, `${label}: resolveWaveDispatch must surface detectWorkflowBackend's own reason verbatim`);
    });
  }

  test('[negative] null/undefined/non-object input → inline, reason:"invalid_input" (never throws)', () => {
    assert.deepStrictEqual(resolveWaveDispatch(null), { backend: 'inline', reason: 'invalid_input' });
    assert.deepStrictEqual(resolveWaveDispatch(undefined), { backend: 'inline', reason: 'invalid_input' });
    assert.deepStrictEqual(resolveWaveDispatch('not-an-object'), { backend: 'inline', reason: 'invalid_input' });
  });

  test('[happy] a valid, dispatch-ready waves manifest never flips a gate-missed decision to workflow', () => {
    // Prove the gate ladder short-circuits BEFORE emitWorkflowScript ever runs:
    // even with a perfectly valid wave manifest, a disabled capability stays inline.
    const result = resolveWaveDispatch(baseInput({ config: {}, ...singleWave() }));
    assert.strictEqual(result.backend, 'inline');
    assert.strictEqual(result.reason, 'capability_disabled');
  });
});

// ─── Section C: composition correctness — detect + emit have a real, non-CLI, non-test caller ──

describe('C. resolveWaveDispatch composes detectWorkflowBackend + emitWorkflowScript (the seam itself)', () => {
  test('[happy] resolveWaveDispatch is exported as a function from the core module', () => {
    assert.strictEqual(typeof resolveWaveDispatch, 'function');
  });

  test('[happy] on a workflow-hit, the emitted script/summary are IDENTICAL to calling emitWorkflowScript directly with the same wave data', () => {
    const input = baseInput();
    const composed = resolveWaveDispatch(input);
    assert.strictEqual(composed.backend, 'workflow');

    const directEmit = emitWorkflowScript({
      phaseDir: input.phaseDir,
      waves: input.waves,
      runId: input.runId,
    });
    assert.strictEqual(directEmit.ok, true);
    assert.strictEqual(composed.script, directEmit.script, 'resolveWaveDispatch must not re-implement emission — script must match emitWorkflowScript byte-for-byte');
    assert.deepStrictEqual(composed.summary, directEmit.summary);
  });

  test('[negative] detect-hit but a malformed wave manifest (emit failure) → inline, carrying emitWorkflowScript\'s own failure reason', () => {
    const input = baseInput({ waves: [] }); // emitWorkflowScript rejects empty waves
    const result = resolveWaveDispatch(input);
    assert.strictEqual(result.backend, 'inline');

    const directEmit = emitWorkflowScript({ phaseDir: input.phaseDir, waves: input.waves, runId: input.runId });
    assert.strictEqual(directEmit.ok, false);
    assert.strictEqual(result.reason, 'emit_failed: ' + directEmit.reason, 'the emit failure reason must be surfaced verbatim, prefixed');

    // Still byte-identical inline shape — no partial/broken script ever leaks.
    assert.deepStrictEqual(Object.keys(result).sort(), ['backend', 'reason']);
  });

  test('[happy] the CLI subcommand `claude-orchestration resolve-wave-dispatch` is ALSO a caller and matches the pure function output', (t) => {
    const tmp = createTempDir('fix-2285-');
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ claude_orchestration: { enabled: true, execution_backend: 'auto' } }),
    );
    const wavesPath = path.join(tmp, 'waves.json');
    fs.writeFileSync(wavesPath, JSON.stringify({ waves: singleWave().waves }));

    const res = runGsdTools([
      'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', wavesPath,
      '--run-id', 'run-2285-1',
      '--phase-dir', '.planning/phases/01-foo',
      '--runtime', 'claude',
      '--agent-sdk-version', ABOVE_FLOOR_SDK,
      // #2686: the router now DEFAULTS the executor model from project config,
      // so pin it on both sides — otherwise this compares a config-resolved CLI
      // run against a pure call that was given no model, and the equality this
      // test exists to prove would be testing the default instead of the seam.
      '--executor-model', 'sonnet',
      '--raw',
    ], tmp);
    assert.strictEqual(res.success, true, 'CLI command must succeed; stderr: ' + (res.error || ''));
    const parsed = JSON.parse(res.output);

    const direct = resolveWaveDispatch(baseInput({ executorModel: 'sonnet' }));
    assert.strictEqual(parsed.backend, direct.backend);
    assert.strictEqual(parsed.script, direct.script);
    assert.deepStrictEqual(parsed.summary, direct.summary);
  });

  test('[negative] CLI subcommand fails closed to inline exactly like the pure function when disabled', (t) => {
    const tmp = createTempDir('fix-2285-off-');
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), '{}');
    const wavesPath = path.join(tmp, 'waves.json');
    fs.writeFileSync(wavesPath, JSON.stringify({ waves: singleWave().waves }));

    const res = runGsdTools([
      'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', wavesPath, '--run-id', 'run-x', '--raw',
    ], tmp);
    assert.strictEqual(res.success, true, 'CLI command must succeed (fail-closed, not error); stderr: ' + (res.error || ''));
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.backend, 'inline');
    assert.strictEqual(parsed.reason, 'capability_disabled');
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['backend', 'reason']);
  });

  test('property: for ANY input, resolveWaveDispatch never throws, backend is always "inline"|"workflow", and "inline" results carry exactly {backend, reason}', () => {
    fc.assert(fc.property(
      fc.record({
        runtimeId: fc.oneof(fc.constant('claude'), fc.constant('codex'), fc.constant(undefined), fc.string()),
        agentSdkVersion: fc.oneof(fc.constant(ABOVE_FLOOR_SDK), fc.constant(BELOW_FLOOR_SDK), fc.constant(undefined), fc.string()),
        enabled: fc.boolean(),
        capableHost: fc.boolean(),
        backendPref: fc.constantFrom('auto', 'workflow', 'inline'),
      }),
      ({ runtimeId, agentSdkVersion, enabled, capableHost, backendPref }) => {
        const input = {
          runtimeId,
          hostIntegration: capableHost ? CAPABLE_HOST_2285 : INCAPABLE_HOST,
          agentSdkVersion,
          config: {
            'claude_orchestration.enabled': enabled,
            'claude_orchestration.execution_backend': backendPref,
          },
          ...singleWave(),
        };
        const result = resolveWaveDispatch(input);
        assert.ok(result.backend === 'inline' || result.backend === 'workflow');
        if (result.backend === 'inline') {
          assert.deepStrictEqual(Object.keys(result).sort(), ['backend', 'reason']);
        } else {
          assert.ok(typeof result.script === 'string' && result.script.length > 0);
        }
      },
    ));
  });
});

// ─── Section D: capability declaration now targets execute:wave:pre ─────────

describe('D. capability.json declares the contribution at execute:wave:pre (#2285)', () => {
  test('[happy] contribution point is execute:wave:pre, not execute:wave:post', () => {
    const cap = JSON.parse(fs.readFileSync(CAP_PATH, 'utf8'));
    const wavePreContrib = cap.contributions.find((c) => c.point === 'execute:wave:pre');
    assert.ok(wavePreContrib, 'capability.json must declare a contribution at execute:wave:pre');
    assert.strictEqual(wavePreContrib.into, 'executor');
    assert.strictEqual(wavePreContrib.when, 'claude_orchestration.enabled');
    assert.strictEqual(wavePreContrib.onError, 'skip');
    assert.strictEqual(wavePreContrib.fragment.path, 'fragments/execute-wave-pre.md');

    const wavePostContrib = cap.contributions.find((c) => c.point === 'execute:wave:post');
    assert.strictEqual(wavePostContrib, undefined, 'the capability must no longer contribute at execute:wave:post');
  });

  test('[happy] the declared fragment file exists on disk', () => {
    const fragPath = path.join(ROOT, 'capabilities', 'claude-orchestration', 'fragments', 'execute-wave-pre.md');
    assert.ok(fs.existsSync(fragPath), 'fragments/execute-wave-pre.md must exist');
    const content = fs.readFileSync(fragPath, 'utf8');
    assert.match(content, /execute:wave:pre/);
    assert.match(content, /resolve-wave-dispatch/);
  });
});

// ─── Section E: source-contract guard — execute-phase.md renders execute:wave:pre BEFORE dispatch ──

// allow-test-rule: source-text-is-the-product, see #2285 — reads gsd-core/workflows/execute-phase.md
// prose to verify the render-hooks call site + ordering. The workflow markdown IS the runtime
// contract executed by the orchestrator; there is no behavioral seam to drive this assertion
// through other than the rendered prose itself.

describe('E. execute-phase.md actually renders execute:wave:pre (the dead hook is now live)', () => {
  test('[happy] execute-phase.md invokes `loop render-hooks execute:wave:pre`', () => {
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      /loop render-hooks execute:wave:pre/.test(doc),
      'execute-phase.md must dispatch execute:wave:pre hooks (was declared in frontmatter but never rendered — #2285)',
    );
  });

  test('[happy] the execute:wave:pre render-hooks call site appears BEFORE the wave\'s Agent() dispatch (pre-wave, not post)', () => {
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const preHooksIdx = doc.indexOf('loop render-hooks execute:wave:pre');
    // Anchor on the actual per-wave dispatch call (step 3), not the generic
    // `subagent_type="gsd-executor"` mention in <runtime_compatibility> near the
    // top of the file — that mention predates the wave loop entirely and would
    // give a false "before" reading.
    const agentDispatchIdx = doc.indexOf('description="Execute plan {plan_number}');
    assert.ok(preHooksIdx !== -1, 'execute:wave:pre render-hooks call site must exist');
    assert.ok(agentDispatchIdx !== -1, 'the gsd-executor Agent() dispatch call site (step 3) must exist');
    assert.ok(
      preHooksIdx < agentDispatchIdx,
      `execute:wave:pre render-hooks (idx ${preHooksIdx}) must appear BEFORE the wave's Agent() dispatch (idx ${agentDispatchIdx}) — it is a pre-wave hook`,
    );
  });

  test('[happy] the frontmatter still declares all four execute:* points (regression guard)', () => {
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const frontmatterMatch = doc.match(/points:\s*(.+)/);
    assert.ok(frontmatterMatch, 'frontmatter must declare a points: line');
    for (const point of ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post']) {
      assert.ok(frontmatterMatch[1].includes(point), `frontmatter points: line must include ${point}`);
    }
  });

  test('[happy] execute:wave:post is still rendered too (regression guard — did not accidentally remove the post-wave gate dispatch)', () => {
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      /loop render-hooks execute:wave:post/.test(doc),
      'execute-phase.md must still dispatch execute:wave:post hooks (drift/ui gates unaffected by #2285)',
    );
  });
});

// ─── Section F: orthogonal-review finding 1 — submodule plans never forced into worktree isolation ──
//
// #2772 / #2285 finding 1: emitWorkflowScript previously hardcoded
// `isolation: "worktree"` for EVERY plan. execute-phase.md step 2.5 computes
// USE_WORKTREES_FOR_PLAN per plan specifically to keep submodule-touching
// plans OUT of worktree isolation (the executor commit protocol cannot
// correctly handle submodule commits inside an isolated worktree). The
// Workflow backend must honor the SAME per-plan decision via `use_worktree`.

function waveWithSubmodulePlan() {
  return {
    phaseDir: '.planning/phases/01-foo',
    runId: 'run-2285-submodule',
    waves: [
      {
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'normal plan', files_modified: ['src/a.ts'] },
          { id: 'p2', brief: 'submodule plan', files_modified: ['vendor/lib.c'], use_worktree: false },
        ],
      },
    ],
  };
}

describe('F. Workflow backend never forces worktree isolation on a submodule / use_worktree:false plan', () => {
  test('[happy] resolveWaveDispatch (pure seam): the submodule plan\'s agent() call carries NO isolation, the normal plan\'s does', () => {
    const result = resolveWaveDispatch(baseInput({ ...waveWithSubmodulePlan() }));
    assert.strictEqual(result.backend, 'workflow');
    assert.match(result.script, /agent\("normal plan", \{ agentType: "gsd-executor", isolation: "worktree" \}\)/);
    // #2686: the options object legitimately gained an optional `model` key, so assert
    // the invariant this test exists to protect — agentType present, isolation absent —
    // rather than a frozen literal that any future additive key would break.
    assert.match(result.script, /agent\("submodule plan", \{ agentType: "gsd-executor"[^}]*\}\)/);
    assert.ok(
      !/agent\("submodule plan"[^)]*isolation/.test(result.script),
      'the submodule-touching plan must NEVER be emitted with forced worktree isolation',
    );
  });

  test('[happy] CLI `resolve-wave-dispatch`: same per-plan guarantee end-to-end through the subprocess', (t) => {
    const tmp = createTempDir('fix-2285-submodule-');
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ claude_orchestration: { enabled: true, execution_backend: 'auto' } }),
    );
    const wavesPath = path.join(tmp, 'waves.json');
    fs.writeFileSync(wavesPath, JSON.stringify({ waves: waveWithSubmodulePlan().waves }));

    const res = runGsdTools([
      'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', wavesPath,
      '--run-id', 'run-2285-submodule',
      '--phase-dir', '.planning/phases/01-foo',
      '--runtime', 'claude',
      '--agent-sdk-version', ABOVE_FLOOR_SDK,
      '--raw',
    ], tmp);
    assert.strictEqual(res.success, true, 'CLI command must succeed; stderr: ' + (res.error || ''));
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.backend, 'workflow');
    // #2686: additive `model` key — see the note on the pure-seam test above.
    assert.match(parsed.script, /agent\("submodule plan", \{ agentType: "gsd-executor"[^}]*\}\)/);
    assert.ok(!/agent\("submodule plan"[^)]*isolation/.test(parsed.script));
  });

  test('[negative] use_worktree defaults to true when omitted — a manifest with NO submodule info stays backward-compatible', () => {
    const result = resolveWaveDispatch(baseInput());
    assert.strictEqual(result.backend, 'workflow');
    assert.match(result.script, /isolation: "worktree"/, 'default (no use_worktree field) must still isolate — backward compatible');
  });
});

// ─── Section G: orthogonal-review finding 2 — missing top-level `waves` key must never silently exit 0 ──
//
// readWavesManifest previously collapsed "read/parse threw" and "parsed OK but
// no top-level `waves` key" into the same `undefined` sentinel. The call sites'
// `if (waves === undefined) return;` made the missing-key case exit 0 with ZERO
// output — fail-silent, breaking the "exit 0 => parseable JSON verdict" contract.
// A missing key must now flow through to emitWorkflowScript's own validation,
// exactly like an explicit `{"waves": null}` manifest already does.

describe('G. missing top-level `waves` key never silently exits 0 with no output', () => {
  function projectWithEnabledCapability(prefix) {
    const tmp = createTempDir(prefix);
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ claude_orchestration: { enabled: true, execution_backend: 'auto' } }),
    );
    return tmp;
  }

  test('[negative] resolve-wave-dispatch with a {"notwaves":[]} manifest → non-empty JSON verdict (NOT silent exit 0)', (t) => {
    const tmp = projectWithEnabledCapability('fix-2285-missingkey-resolve-');
    t.after(() => cleanup(tmp));
    const wavesPath = path.join(tmp, 'waves.json');
    fs.writeFileSync(wavesPath, JSON.stringify({ notwaves: [] }));

    const res = runGsdTools([
      'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', wavesPath, '--run-id', 'run-x',
      '--runtime', 'claude', '--agent-sdk-version', ABOVE_FLOOR_SDK,
      '--raw',
    ], tmp);

    assert.strictEqual(res.success, true, 'command must exit 0 (fail-closed to inline, not error); stderr: ' + (res.error || ''));
    assert.ok(res.output.length > 0, 'FAIL-SILENT REGRESSION: missing waves key must NOT produce empty stdout on exit 0');
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.backend, 'inline');
    assert.match(parsed.reason, /waves must be a non-empty array/, 'reason must surface emitWorkflowScript\'s own validation message');
  });

  test('[negative] resolve-wave-dispatch: {"notwaves":[]} and {"waves": null} produce the IDENTICAL verdict (parity)', (t) => {
    const tmp = projectWithEnabledCapability('fix-2285-missingkey-parity-');
    t.after(() => cleanup(tmp));
    const missingKeyPath = path.join(tmp, 'missing.json');
    fs.writeFileSync(missingKeyPath, JSON.stringify({ notwaves: [] }));
    const nullWavesPath = path.join(tmp, 'null.json');
    fs.writeFileSync(nullWavesPath, JSON.stringify({ waves: null }));

    const argsFor = (p) => [
      'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', p, '--run-id', 'run-x',
      '--runtime', 'claude', '--agent-sdk-version', ABOVE_FLOOR_SDK,
      '--raw',
    ];
    const missingRes = runGsdTools(argsFor(missingKeyPath), tmp);
    const nullRes = runGsdTools(argsFor(nullWavesPath), tmp);
    assert.strictEqual(missingRes.success, true);
    assert.strictEqual(nullRes.success, true);
    assert.deepStrictEqual(JSON.parse(missingRes.output), JSON.parse(nullRes.output), 'a missing `waves` key must behave identically to an explicit `waves: null`');
  });

  test('[negative] emit-workflow with a {"notwaves":[]} manifest → loud non-zero exit (NOT silent exit 0)', (t) => {
    const tmp = createTempDir('fix-2285-missingkey-emit-');
    t.after(() => cleanup(tmp));
    const wavesPath = path.join(tmp, 'waves.json');
    fs.writeFileSync(wavesPath, JSON.stringify({ notwaves: [] }));

    const res = runGsdTools([
      'claude-orchestration', 'emit-workflow',
      '--waves', wavesPath, '--run-id', 'run-x',
    ], tmp);

    assert.strictEqual(res.success, false, 'FAIL-SILENT REGRESSION: missing waves key must produce a loud, non-zero-exit error, not a silent success');
    assert.ok(res.exitCode !== 0, 'non-zero exit');
    assert.match(res.error || '', /waves must be a non-empty array/);
  });

  test('[happy] a genuinely malformed (unparseable) --waves file still fails loudly, unaffected by the fix', (t) => {
    const tmp = createTempDir('fix-2285-badjson-');
    t.after(() => cleanup(tmp));
    const wavesPath = path.join(tmp, 'waves.json');
    fs.writeFileSync(wavesPath, 'not json at all');

    const res = runGsdTools([
      'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', wavesPath, '--run-id', 'run-x', '--raw',
    ], tmp);
    assert.strictEqual(res.success, false, 'a real parse failure must still error');
    assert.match(res.error || '', /could not read\/parse --waves file/);
  });
});

// ─── Section H: orthogonal-review finding 3 — manifest construction guidance is concrete ──

describe('H. the execute:wave:pre fragment documents concrete manifest construction (finding 3)', () => {
  test('[happy] the fragment explains how to build WAVE_MANIFEST_PATH, PHASE_RUN_ID, and per-plan use_worktree', () => {
    const fragPath = path.join(ROOT, 'capabilities', 'claude-orchestration', 'fragments', 'execute-wave-pre.md');
    const content = fs.readFileSync(fragPath, 'utf8');
    assert.match(content, /Manifest construction/, 'fragment must have concrete manifest-construction guidance, not just reference undefined vars');
    assert.match(content, /PHASE_RUN_ID/);
    assert.match(content, /WAVE_MANIFEST_PATH/);
    assert.match(content, /use_worktree/);
    assert.match(content, /USE_WORKTREES_FOR_PLAN/, 'must tie use_worktree back to step 2.5\'s per-plan decision');
  });

  test('[happy] execute-phase.md step 2.75 stays minimal — manifest/use_worktree detail lives ONLY in the fragment (#1168 byte-budget conformance)', () => {
    // Per the ADR-857 Phase 6 conformance gate (tests/phase6-capstone-conformance.test.cjs),
    // the host loop must stay small — optional-feature detail (manifest construction,
    // per-plan use_worktree carry-through) belongs in the capability fragment, not the
    // host workflow. Step 2.75 is intentionally just a render-hooks call + a one-line
    // "follow the contribution or fall through to step 3" instruction.
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const stepStart = doc.indexOf('2.75. **Execute:wave:pre capability dispatch:**');
    const stepEnd = doc.indexOf('\n3. **Spawn executor agents:**', stepStart);
    assert.ok(stepStart !== -1 && stepEnd !== -1, 'step 2.75 must exist and precede step 3');
    const stepBody = doc.slice(stepStart, stepEnd);
    assert.match(stepBody, /loop render-hooks execute:wave:pre/, 'step 2.75 must still render the hook point');
    assert.doesNotMatch(stepBody, /use_worktree/, 'manifest-construction detail (use_worktree) must live in the fragment, not the host step');
    assert.doesNotMatch(stepBody, /USE_WORKTREES_FOR_PLAN/, 'per-plan worktree gate detail must live in the fragment, not the host step');
  });

  test('[happy] execute-phase.md is below the ADR-857 Phase 6 pre-phase-6 byte ceiling (#1168)', () => {
    // No separate self-imposed margin here: a tighter number than the ADR's own
    // frozen ceiling just gets re-tripped by growth this PR does not own (#4148
    // review history) — the tier hard cap in workflow-size-budget.test.cjs (98304
    // bytes, "extract, not bump") is the correct backstop for that.
    //
    // #4030: raised from 93600 to 93700 in lockstep with the same-named ceiling in
    // tests/phase6-capstone-conformance.test.cjs — threading --phase/--ws onto the
    // execute:post and execute:wave:pre/post render-hooks call sites (ADR-857
    // Decision #1 core dispatch-seam machinery, not optional-feature inline logic).
    const { lfByteCount } = require('../scripts/workflow-size.cjs');
    const bytes = lfByteCount(WORKFLOW_PATH);
    assert.ok(bytes < 93700, `execute-phase.md must stay below the frozen pre-phase-6 ceiling (93700); got ${bytes}`);
  });
});

// ─── Section I: orthogonal-review finding 4 — stale doc fixed ───────────────

describe('I. docs/explanation/claude-orchestration-capability.md reflects the execute:wave:pre move (finding 4)', () => {
  test('[happy] the doc no longer claims the capability registers at execute:wave:post', () => {
    const docPath = path.join(ROOT, 'docs', 'explanation', 'claude-orchestration-capability.md');
    const content = fs.readFileSync(docPath, 'utf8');
    assert.match(content, /execute:wave:pre/, 'doc must mention execute:wave:pre as the wired point');
    assert.ok(
      !/execute:wave:post.*\(into the executor\)/.test(content),
      'doc must not still claim the wired point is execute:wave:post',
    );
  });
});

// ─── #2590 — emitted Workflow scripts satisfy the Workflow tool contract
// (folded from fix-2590-workflow-script-contract.test.cjs) ────────────────────
//
// `emitWorkflowScript` generated four constructs the tool does not accept. The
// first was fatal on its own, so the backend could never dispatch a wave:
//
//   1. no `export const meta = {…}` first statement  -> whole script rejected
//   2. `resumeFromRunId("<id>")`  -> "resumeFromRunId is not defined"
//      (it is a Workflow TOOL INPUT parameter, not a script function)
//   3. `budget(<n>)`             -> "budget is not a function"
//      (`budget` is a read-only object { total, spent(), remaining() })
//   4. `parallel(agent(…), agent(…))` -> "parallel() expects an array of functions"
//
// Plus two secondary defects that kept the emitted script from ever being
// REACHED, which is why this shipped undetected:
//
//   5. nothing resolved the Agent SDK version, so gate 5 returned
//      `agent_sdk_version_unknown` on every automated run
//   6. the runtime fallback was `--runtime > GSD_RUNTIME > 'unknown'`, diverging
//      from the canonical `GSD_RUNTIME > config.runtime > 'claude'`, so any
//      invocation without --runtime reported `runtime_not_claude`
//
// The script assertions parse the emitted text as a real ES module rather than
// pattern-matching it, so a syntactically invalid script fails outright.

const TOOLS_2590 = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

function emit(overrides) {
  const input = Object.assign({
    phaseDir: '.planning/phases/01',
    runId: 'execute-1',
    waves: [{ id: 'wave-1', plans: [{ id: '01-01', brief: 'noop', files_modified: ['a.ts'] }] }],
  }, overrides || {});
  const r = emitWorkflowScript(input);
  assert.ok(r.ok, `emit failed: ${JSON.stringify(r)}`);
  return r;
}

/** First non-comment, non-blank line — the script's first actual statement. */
function firstStatement(script) {
  return script.split('\n').map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('//')) || '';
}

describe('#2590: emitted Workflow scripts satisfy the Workflow tool contract', () => {
  test('the emitted script parses in the Workflow tool\'s evaluation context', (t) => {
    // #3302: the script now carries a top-level `return` (the documented way a
    // Workflow script hands its result to the invoking model — see
    // code.claude.com/docs/en/workflows), which plain ESM parsing rejects.
    // The tool lifts the `export const meta` block out and evaluates the rest
    // as an async function body — top-level `await` AND `return` are both
    // valid there. Emulate that context: strip the export keyword and wrap the
    // body in an async arrow, still parsed as ESM so everything else surfaces.
    const { script } = emit({
      waves: [
        { id: 'w1', plans: [
          { id: 'a', brief: 'one', files_modified: ['a.ts'] },
          { id: 'b', brief: 'two', files_modified: ['b.ts'] },
        ] },
        { id: 'w2', plans: [{ id: 'c', brief: 'three', files_modified: ['c.ts'] }] },
      ],
    });
    // .mjs so node parses it in module context, inside a helper temp dir so
    // cleanup() carries the Windows-EBUSY retry budget.
    const dir = createTempDir('gsd-2590-parse-');
    t.after(() => cleanup(dir));
    const f = path.join(dir, 'emitted.mjs');
    fs.writeFileSync(
      f,
      'const gsdWorkflowScript = async () => {\n'
        + script.replace(/^export /m, '')
        + '\n};\nexport const __parsed = gsdWorkflowScript;\n',
    );
    const result = runNode(['--check', f], { timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(result, `node --check ${f} (emitted script must parse in the tool's async-body context)`);
  });

  test('1. `export const meta` is the first statement', () => {
    const { script } = emit();
    assert.match(
      firstStatement(script),
      /^export const meta = \{/,
      'the Workflow tool rejects any script whose first statement is not the meta block',
    );
  });

  test('meta.phases titles match the emitted phase() calls exactly', () => {
    // The tool matches phase titles by exact string; a mismatch silently splits
    // progress into an unnamed group.
    const { script } = emit({
      waves: [
        { id: 'alpha', plans: [{ id: 'a', brief: 'one', files_modified: ['a.ts'] }] },
        { id: 'beta', plans: [{ id: 'b', brief: 'two', files_modified: ['b.ts'] }] },
      ],
    });
    const metaTitles = [...script.matchAll(/\{ title: "([^"]+)"/g)].map((m) => m[1]);
    const phaseTitles = [...script.matchAll(/^phase\("([^"]+)"\)/gm)].map((m) => m[1]);
    assert.deepEqual(metaTitles, ['Wave alpha', 'Wave beta']);
    assert.deepEqual(phaseTitles, metaTitles, 'phase() titles must match meta.phases exactly');
  });

  test('duplicate wave ids are rejected (phase titles must map 1:1)', () => {
    // Two waves sharing an id emit two identical `phase("Wave x")` calls and two
    // identical meta.phases entries; the tool matches titles by exact string, so
    // the second wave's agents would be attributed to the first's progress group.
    const r = emitWorkflowScript({
      phaseDir: '.planning/phases/01',
      runId: 'execute-1',
      waves: [
        { id: 'dup', plans: [{ id: 'a', brief: 'one', files_modified: ['a.ts'] }] },
        { id: 'dup', plans: [{ id: 'b', brief: 'two', files_modified: ['b.ts'] }] },
      ],
    });
    assert.equal(r.ok, false, 'duplicate wave ids must be rejected, not silently merged');
    assert.match(String(r.reason), /duplicate wave id/);
  });

  test('distinct wave ids are still accepted (the boundary either side)', () => {
    const r = emitWorkflowScript({
      phaseDir: '.planning/phases/01',
      runId: 'execute-1',
      waves: [
        { id: 'w1', plans: [{ id: 'a', brief: 'one', files_modified: ['a.ts'] }] },
        { id: 'w2', plans: [{ id: 'b', brief: 'two', files_modified: ['b.ts'] }] },
      ],
    });
    assert.equal(r.ok, true, `distinct wave ids must pass: ${JSON.stringify(r)}`);
  });

  test('2. resumeFromRunId is never CALLED (it is a tool input, not a function)', () => {
    const { script, summary } = emit({ runId: 'execute-7' });
    assert.ok(
      !/^\s*resumeFromRunId\s*\(/m.test(script),
      'calling resumeFromRunId() throws "resumeFromRunId is not defined"',
    );
    // The run id must still reach the caller, which passes it as the tool input.
    assert.equal(summary.resumeRunId, 'execute-7');
  });

  test('3. budget is never CALLED, at and around the boundary', () => {
    // budgetTokens is floored at > 0; check 0 (rejected), 1 (accepted), and a
    // large value — none may produce a budget(...) call.
    for (const tokens of [0, 1, 500000]) {
      const { script, summary } = emit({ budgetTokens: tokens });
      assert.ok(
        !/^\s*budget\s*\(/m.test(script),
        `budgetTokens=${tokens}: calling budget() throws "budget is not a function"`,
      );
      assert.equal(summary.budgetTokens, tokens > 0 ? tokens : null);
    }
  });

  test('4. parallel() receives an array of thunks, not agent() results', () => {
    const { script } = emit({
      waves: [{ id: 'w', plans: [
        { id: 'a', brief: 'one', files_modified: ['a.ts'] },
        { id: 'b', brief: 'two', files_modified: ['b.ts'] },
      ] }],
    });
    assert.ok(/parallel\(\[/.test(script), 'parallel() expects an array of functions');
    assert.ok(
      !/parallel\(\s*agent\(/.test(script),
      'passing agent() results directly both throws and starts every agent eagerly',
    );
    // Each agent must be wrapped in a thunk so parallel() can bound concurrency.
    const agents = [...script.matchAll(/agent\("/g)].length;
    const thunks = [...script.matchAll(/\(\) => agent\("/g)].length;
    assert.equal(thunks, agents, 'every agent() must be wrapped in a () => thunk');
  });

  test('single-plan stages also emit an array (regression: the 1-plan branch)', () => {
    // The pre-fix code had a SEPARATE single-plan branch that emitted
    // `parallel(\n agent(...)\n)` — valid-looking but the same defect.
    const { script } = emit();
    assert.ok(/parallel\(\[/.test(script));
    assert.equal([...script.matchAll(/\(\) => agent\("/g)].length, 1);
  });

  test('per-plan worktree isolation still mirrors use_worktree', () => {
    const { script } = emit({
      waves: [{ id: 'w', plans: [
        { id: 'a', brief: 'iso', files_modified: ['a.ts'] },
        { id: 'b', brief: 'noiso', files_modified: ['b.ts'], use_worktree: false },
      ] }],
    });
    assert.match(script, /agent\("iso", \{ agentType: "gsd-executor", isolation: "worktree" \}\)/);
    assert.match(script, /agent\("noiso", \{ agentType: "gsd-executor" \}\)/);
  });
});

describe('#2590: the backend is reachable without hand-passed flags', () => {
  function repro() {
    const dir = createTempDir('gsd-2590-repro-');
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ claude_orchestration: { enabled: true } }),
    );
    fs.writeFileSync(
      path.join(dir, 'waves.json'),
      JSON.stringify({ waves: [{ id: 'wave-1', plans: [{ id: '01-01', brief: 'noop', files_modified: ['a.ts'] }] }] }),
    );
    return dir;
  }

  function resolve(dir, extraArgs) {
    const result = runNode([
      TOOLS_2590, 'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', 'waves.json', '--run-id', 'execute-1',
      '--phase-dir', '.planning/phases/01', '--raw',
      ...(extraArgs || []),
    ], { cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(result, 'gsd-tools claude-orchestration resolve-wave-dispatch');
    return JSON.parse(result.stdout);
  }

  test('5+6. no --runtime and no --agent-sdk-version still reaches the version gate', (t) => {
    const dir = repro();
    t.after(() => cleanup(dir));
    const r = resolve(dir);
    // Pre-fix this was `agent_sdk_version_unknown` (nothing resolved a
    // version) or `runtime_not_claude` (the divergent fallback). Either is a
    // regression; the version gate must now be reached and answer truthfully.
    assert.notEqual(r.reason, 'agent_sdk_version_unknown',
      'the router must resolve the installed SDK version itself');
    assert.notEqual(r.reason, 'runtime_not_claude',
      'runtime must fall back to the canonical config.runtime > claude chain');
  });

  test('an SDK version above the floor activates the workflow backend end to end', (t) => {
    const dir = repro();
    t.after(() => cleanup(dir));
    const r = resolve(dir, ['--agent-sdk-version', '0.3.149']);
    assert.equal(r.backend, 'workflow', `expected workflow backend, got ${JSON.stringify(r)}`);
    assert.ok(typeof r.script === 'string' && r.script.length > 0);
    assert.match(firstStatement(r.script), /^export const meta = \{/);
  });

  test('an explicit --agent-sdk-version still wins over the installed one', (t) => {
    const dir = repro();
    t.after(() => cleanup(dir));
    // A deliberately ancient pin must be honored (and decline), proving the
    // flag is not ignored now that a fallback exists.
    const r = resolve(dir, ['--agent-sdk-version', '0.0.1']);
    assert.equal(r.backend, 'inline');
    assert.equal(r.reason, 'agent_sdk_version_below_floor');
  });

  test('GSD_AGENT_SDK_VERSION is honored between the flag and the installed version', (t) => {
    const dir = repro();
    t.after(() => cleanup(dir));
    const result = runNode([
      TOOLS_2590, 'claude-orchestration', 'resolve-wave-dispatch',
      '--waves', 'waves.json', '--run-id', 'execute-1',
      '--phase-dir', '.planning/phases/01', '--raw',
    ], { cwd: dir, env: { ...process.env, GSD_AGENT_SDK_VERSION: '0.3.149' }, timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(result, 'gsd-tools claude-orchestration resolve-wave-dispatch (GSD_AGENT_SDK_VERSION)');
    assert.equal(JSON.parse(result.stdout).backend, 'workflow');
  });
});

// ─── #3302 — Workflow-backend manifest bridge (emit returns per-agent outcomes) ──
//
// The Workflow backend wrapped a whole wave in ONE tool call and discarded the
// per-agent results, so nothing ever fed WAVE_WORKTREE_MANIFEST and executor
// commits stayed stranded on worktree-wf_* branches while the phase looked
// green. The fix has two halves, both pinned here:
//
//   code        — emitWorkflowScript captures each parallel() barrier's results
//                 and top-level `return`s one { plan, expects_worktree, metadata }
//                 outcome per dispatched plan (metadata extracted in-script from
//                 the executor's <worktree_metadata> block, or null);
//   instructions — the execute:wave:pre fragment bridges those outcomes into the
//                 SAME record-agent -> cleanup-wave merge chain inline dispatch
//                 uses, halting loudly when metadata cannot be captured.
//
// The execution tests below run the EMITTED script the way the Workflow tool
// does (meta lifted out, body evaluated as an async function with phase()/
// parallel()/agent() supplied), asserting runtime behavior, not script text.

const ASYNC_FUNCTION_3302 = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Execute an emitted Workflow script in a stub runtime mirroring the documented
 * tool contract (code.claude.com/docs/en/workflows): phase() groups progress,
 * parallel() takes an array of thunks and resolves to their results in thunk
 * order, agent() resolves to the agent's final message (or null when
 * interrupted), and the script's top-level `return` value is what the invoking
 * model receives.
 */
async function executeEmittedScript3302(script, agentStub) {
  const body = script.replace(/^export /m, '');
  const harness = [
    'const phase = () => {};',
    'const parallel = async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t)));',
    'const agent = async (brief, opts) => agentStub(brief, opts);',
    body,
  ].join('\n');
  const fn = new ASYNC_FUNCTION_3302('agentStub', harness);
  return await fn(agentStub);
}

/** An executor final message carrying a valid <worktree_metadata> block. */
function agentResultWithMetadata3302(fields) {
  return [
    '## PLAN COMPLETE',
    '',
    '<worktree_metadata>',
    JSON.stringify(fields),
    '</worktree_metadata>',
    '',
    '**Commits:**',
    '- abc1234: fix(#000): example',
  ].join('\n');
}

describe('#3302: emitted Workflow script returns per-agent outcomes for the manifest bridge', () => {
  test('A1. the script returns one outcome entry per dispatched plan (today: undefined)', async () => {
    const r = emitWorkflowScript(nonOverlappingManifest());
    assert.strictEqual(r.ok, true);
    const ret = await executeEmittedScript3302(r.script, () => agentResultWithMetadata3302({}));
    assert.ok(Array.isArray(ret), 'the top-level return value must be the outcomes array');
    assert.strictEqual(ret.length, 2, 'one entry per dispatched plan');
  });

  test('A2. entries are { plan, expects_worktree, metadata } with correct attribution', async () => {
    const r = emitWorkflowScript(nonOverlappingManifest());
    // Distinct branch per brief proves the positional mapping through the
    // parallel() barrier attributes each agent's OWN metadata to its plan.
    const stub = (brief) => agentResultWithMetadata3302({
      agent_id: 'id-' + brief,
      worktree_path: '/wt/' + brief,
      branch: 'worktree-wf-run-' + brief,
      expected_base: 'deadbee',
    });
    const ret = await executeEmittedScript3302(r.script, stub);
    assert.deepEqual(
      ret.map((e) => [e.plan, e.metadata && e.metadata.branch]),
      [['p1', 'worktree-wf-run-Plan A'], ['p2', 'worktree-wf-run-Plan B']],
      'plan ids in dispatch order, each with its own agent\'s metadata',
    );
    for (const e of ret) {
      assert.strictEqual(e.expects_worktree, true, 'worktree plans expect metadata');
      assert.deepEqual(
        Object.keys(e.metadata).sort(),
        ['agent_id', 'branch', 'expected_base', 'worktree_path'],
        'metadata is the parsed <worktree_metadata> JSON object',
      );
    }
  });

  test('A3. expects_worktree mirrors use_worktree per plan (mixed wave)', async () => {
    const r = emitWorkflowScript({
      phaseDir: '.planning/phases/01-foo',
      runId: 'run-abc-1143',
      waves: [{
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'In worktree', files_modified: ['src/a.cts'] },
          { id: 'p2', brief: 'No worktree', files_modified: ['src/b.cts'], use_worktree: false },
        ],
      }],
    });
    const ret = await executeEmittedScript3302(r.script, (brief) => (
      brief === 'No worktree'
        ? '## PLAN COMPLETE (no metadata — ran on the main tree)'
        : agentResultWithMetadata3302({ agent_id: 'p1', worktree_path: '/wt/p1', branch: 'worktree-wf-run-1', expected_base: 'aa' })
    ));
    assert.strictEqual(ret[0].expects_worktree, true);
    assert.strictEqual(ret[0].metadata.branch, 'worktree-wf-run-1');
    assert.strictEqual(ret[1].expects_worktree, false, 'use_worktree:false -> expects_worktree:false');
    assert.strictEqual(ret[1].metadata, null, 'non-worktree plans carry no metadata — not an error');
    assert.strictEqual(r.summary.worktreePlans, 1, 'summary counts only worktree plans');
  });

  test('A4. null metadata is the loud-failure input: interrupted agent, missing block, bad JSON', async () => {
    const cases = [
      ['interrupted agent (agent() resolves to null)', null],
      ['result without a <worktree_metadata> block', '## PLAN COMPLETE\n\n**Commits:** - x'],
      ['unparseable JSON inside the block', '<worktree_metadata>{not json</worktree_metadata>'],
      ['non-object JSON inside the block', '<worktree_metadata>"just a string"</worktree_metadata>'],
    ];
    for (const [label, rawResult] of cases) {
      const r = emitWorkflowScript(singleWaveManifest());
      const ret = await executeEmittedScript3302(r.script, () => rawResult);
      assert.strictEqual(ret.length, 1, label);
      assert.strictEqual(ret[0].expects_worktree, true, label);
      assert.strictEqual(ret[0].metadata, null, `${label} -> metadata null (orchestrator must HALT, #3302)`);
    }
  });

  test('A5. multi-wave and multi-stage manifests: every plan appears exactly once, in dispatch order', async () => {
    const r = emitWorkflowScript({
      phaseDir: '.planning/phases/01-foo',
      runId: 'run-3302',
      waves: [
        { id: 'w1', plans: [
          { id: 'a1', brief: 'A1', files_modified: ['src/shared.cts'] },
          { id: 'a2', brief: 'A2', files_modified: ['src/shared.cts', 'src/b.cts'] }, // overlap -> stage split
          { id: 'a3', brief: 'A3', files_modified: ['src/c.cts'] },                    // coalesces with a1
        ] },
        { id: 'w2', plans: [{ id: 'b1', brief: 'B1', files_modified: ['src/d.cts'] }] },
      ],
    });
    const ret = await executeEmittedScript3302(r.script, (brief) => agentResultWithMetadata3302({ agent_id: brief, worktree_path: '/wt/' + brief, branch: 'br-' + brief, expected_base: 'ff' }));
    // w1 stages: [a1, a3] then [a2] (greedy first-fit); then w2: [b1].
    assert.deepEqual(ret.map((e) => e.plan), ['a1', 'a3', 'a2', 'b1']);
    assert.strictEqual(ret.length, r.summary.plans);
    assert.strictEqual(r.summary.worktreePlans, 4);
  });

  test('B1. the emitted script no longer claims an unbacked inline merge', () => {
    const r = emitWorkflowScript(nonOverlappingManifest());
    assert.ok(
      !r.script.includes('exactly as in inline wave dispatch'),
      'the pre-#3302 tail comment asserted a merge that no code performed',
    );
  });
});

describe('#3302: the execute:wave:pre fragment bridges Workflow results into the manifest merge chain', () => {
  const FRAG_3302 = path.join(ROOT, 'capabilities', 'claude-orchestration', 'fragments', 'execute-wave-pre.md');

  function fragContent() {
    return fs.readFileSync(FRAG_3302, 'utf8');
  }

  test('C1. instructs recording outcomes via worktree.record-agent after the run', () => {
    const c = fragContent();
    assert.match(c, /worktree\.record-agent/, 'the record verb inline dispatch uses must be named');
    assert.match(c, /WAVE_WORKTREE_MANIFEST/, 'against the wave manifest');
  });

  test('C2. instructs creating WAVE_WORKTREE_MANIFEST before invoking the tool (step 3 is skipped)', () => {
    const c = fragContent();
    assert.match(c, /orchestrator_root/, 'creation block must persist the orchestrator root (#630)');
    assert.match(c, /mktemp/, 'same mktemp pattern as inline step 3');
    assert.match(c, /worktrees:\[\]/, 'initialised empty — then populated from outcomes');
  });

  test('C3. mandates a HALT on uncapturable metadata — never a silently-empty manifest', () => {
    const c = fragContent();
    assert.match(c, /HALT on uncapturable metadata/);
    assert.match(c, /worktreePlans/, 'count check against summary.worktreePlans');
    assert.match(c, /do NOT run\s*\n?\s*`?worktree\.cleanup-wave/, 'cleanup must not run on a short manifest');
  });

  test('C4. covers resume: recover from the original run\'s journal or fail loudly', () => {
    const c = fragContent();
    assert.match(c, /journal\.jsonl/, 'the documented recovery source for per-agent results');
    assert.match(c, /[Rr]esume/, 'resume path addressed');
    assert.match(c, /never report\s*\n?\s*success over silently-dropped/, 'fail loudly, not silently');
  });

  test('C5. the false "exactly as inline dispatch" claim is gone', () => {
    const c = fragContent();
    assert.ok(
      !c.includes('exactly as it does for inline dispatch'),
      'the pre-#3302 fragment asserted steps 4-5.8 ran exactly as inline with no bridge',
    );
  });

  test('C6. still continues into the unchanged cleanup-wave merge chain', () => {
    const c = fragContent();
    assert.match(c, /worktree\.cleanup-wave/, 'step 5.5 merge chain referenced');
    assert.match(c, /UNCHANGED/, 'the chain itself is unchanged — only fed');
  });
});
