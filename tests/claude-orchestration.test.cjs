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

const {
  detectWorkflowBackend,
  emitWorkflowScript,
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

const ROOT = path.resolve(__dirname, '..');
const CAP_PATH = path.join(ROOT, 'capabilities', 'claude-orchestration', 'capability.json');
const REGISTRY_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');

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
