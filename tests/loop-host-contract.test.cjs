'use strict';

/**
 * loop-host-contract.test.cjs — behavioral tests for gen-loop-host-contract.cjs.
 *
 * ADR-894 phase 3a-impl-2.
 * Uses node:test + node:assert/strict.
 * NO source-grep: tests use in-memory fixtures and real workflow files.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const {
  parseLoopHostBlock,
  crossCheckRoles,
  assertPointsCoverage,
  buildContract,
  serializeContract,
  normalizeLineEndings,
  STEP_WORKFLOWS,
  CANONICAL_POINTS,
  EXPECTED_POINTS_BY_STEP,
  ROLE_TO_AGENT,
} = require('../scripts/gen-loop-host-contract.cjs');

const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'loop-host-contract.cjs');

// ─── Helper: write a temporary workflows directory ────────────────────────────

function makeTempWorkflowsDir(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhc-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmpDir, name), content, 'utf8');
  }
  return tmpDir;
}

// ─── Minimal valid workflow content templates ─────────────────────────────────

function makeWorkflow(step, points, roles, produces, consumes, extraContent) {
  const pointsList = points.join(', ');
  const rolesList = roles.join(', ');
  const producesList = produces.join(', ');
  const consumesList = consumes.join(', ');
  return (
    '<!-- gsd:loop-host\n' +
    'step: ' + step + '\n' +
    'points: ' + pointsList + '\n' +
    'agent-roles: ' + rolesList + '\n' +
    'produces: ' + producesList + '\n' +
    'consumes: ' + consumesList + '\n' +
    '-->\n' +
    (extraContent || '')
  );
}

// Minimal valid set of 5 workflows matching the canonical contract
function makeValidWorkflowFiles() {
  return {
    'discuss-phase.md': makeWorkflow('discuss', ['discuss:pre', 'discuss:post'], ['orchestrator'], ['CONTEXT.md'], []),
    'plan-phase.md': makeWorkflow(
      'plan', ['plan:pre', 'plan:post'],
      ['researcher', 'planner', 'checker'],
      ['PLAN.md'], ['CONTEXT.md'],
      // Cross-check content: must contain the agent names
      'gsd-phase-researcher gsd-planner gsd-plan-checker',
    ),
    'quick.md': [
      'PLAN_PRE_HOOKS_JSON=$(gsd_run loop render-hooks plan:pre --raw)',
      'For each active entry where `kind == "contribution"`: inject.',
      '',
    ].join('\n'),
    'execute-phase.md': makeWorkflow(
      'execute', ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'],
      ['executor', 'verifier'],
      ['SUMMARY.md'], ['PLAN.md'],
      'gsd-executor gsd-verifier',
    ),
    'verify-work.md': makeWorkflow('verify', ['verify:pre', 'verify:post'], ['orchestrator'], ['UAT.md'], ['SUMMARY.md']),
    'ship.md': makeWorkflow('ship', ['ship:pre', 'ship:post'], ['orchestrator'], [], ['UAT.md']),
  };
}

// ─── 1. parseLoopHostBlock ────────────────────────────────────────────────────

describe('parseLoopHostBlock', () => {
  test('parses a valid block correctly', () => {
    const content = makeWorkflow(
      'plan', ['plan:pre', 'plan:post'],
      ['researcher', 'planner', 'checker'],
      ['PLAN.md'], ['CONTEXT.md'],
    );
    const result = parseLoopHostBlock(content, 'plan-phase.md');
    assert.strictEqual(result.step, 'plan');
    assert.deepEqual(result.points, ['plan:pre', 'plan:post']);
    assert.deepEqual(result.agentRoles, ['researcher', 'planner', 'checker']);
    assert.deepEqual(result.coreArtifacts.produces, ['PLAN.md']);
    assert.deepEqual(result.coreArtifacts.consumes, ['CONTEXT.md']);
  });

  test('parses empty produces field as empty array', () => {
    const content = makeWorkflow(
      'ship', ['ship:pre', 'ship:post'], ['orchestrator'], [], ['UAT.md'],
    );
    const result = parseLoopHostBlock(content, 'ship.md');
    assert.deepEqual(result.coreArtifacts.produces, []);
    assert.deepEqual(result.coreArtifacts.consumes, ['UAT.md']);
  });

  test('parses empty consumes field as empty array', () => {
    const content = makeWorkflow(
      'discuss', ['discuss:pre', 'discuss:post'], ['orchestrator'], ['CONTEXT.md'], [],
    );
    const result = parseLoopHostBlock(content, 'discuss-phase.md');
    assert.deepEqual(result.coreArtifacts.consumes, []);
    assert.deepEqual(result.coreArtifacts.produces, ['CONTEXT.md']);
  });

  test('throws when block is missing', () => {
    assert.throws(
      () => parseLoopHostBlock('no block here\n<purpose>hello</purpose>', 'test.md'),
      /missing.*gsd:loop-host/,
    );
  });

  test('throws when step field is missing from block', () => {
    const content =
      '<!-- gsd:loop-host\n' +
      'points: plan:pre, plan:post\n' +
      'agent-roles: orchestrator\n' +
      'produces:\n' +
      'consumes:\n' +
      '-->\n';
    assert.throws(
      () => parseLoopHostBlock(content, 'test.md'),
      /missing required field "step"/,
    );
  });

  test('throws when points field is empty', () => {
    const content =
      '<!-- gsd:loop-host\n' +
      'step: plan\n' +
      'points:\n' +
      'agent-roles: orchestrator\n' +
      'produces:\n' +
      'consumes:\n' +
      '-->\n';
    assert.throws(
      () => parseLoopHostBlock(content, 'test.md'),
      /"points" must have at least one value/,
    );
  });

  test('parses multi-value fields with spaces correctly', () => {
    const content = makeWorkflow(
      'execute',
      ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'],
      ['executor', 'verifier'],
      ['SUMMARY.md'], ['PLAN.md'],
    );
    const result = parseLoopHostBlock(content, 'execute-phase.md');
    assert.deepEqual(result.points, ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post']);
    assert.deepEqual(result.agentRoles, ['executor', 'verifier']);
  });
});

// ─── 2. crossCheckRoles ───────────────────────────────────────────────────────

describe('crossCheckRoles', () => {
  test('passes for orchestrator-only roles (no agent file needed)', () => {
    const errors = crossCheckRoles('anything', ['orchestrator'], 'discuss-phase.md');
    assert.deepEqual(errors, []);
  });

  test('passes when agent name is present in content', () => {
    const content = 'Agent(subagent_type="gsd-planner") Agent(subagent_type="gsd-phase-researcher") gsd-plan-checker';
    const errors = crossCheckRoles(content, ['researcher', 'planner', 'checker'], 'plan-phase.md');
    assert.deepEqual(errors, []);
  });

  test('fails when declared role has no agent reference in content', () => {
    const content = 'gsd-phase-researcher gsd-plan-checker'; // planner missing
    const errors = crossCheckRoles(content, ['researcher', 'planner', 'checker'], 'plan-phase.md');
    assert.strictEqual(errors.length, 1, 'expected exactly 1 error for missing planner');
    assert.match(errors[0], /planner.*gsd-planner/);
  });

  test('fails when declared role is unknown (not in ROLE_TO_AGENT)', () => {
    const content = 'gsd-executor gsd-verifier';
    const errors = crossCheckRoles(content, ['executor', 'nonexistent-role'], 'execute-phase.md');
    assert.ok(errors.some((e) => e.includes('nonexistent-role') && e.includes('ROLE_TO_AGENT')));
  });
});

// ─── 3. assertPointsCoverage ─────────────────────────────────────────────────

describe('assertPointsCoverage', () => {
  test('passes when all 12 canonical points are covered', () => {
    const entries = [
      { step: 'discuss', points: ['discuss:pre', 'discuss:post'] },
      { step: 'plan', points: ['plan:pre', 'plan:post'] },
      { step: 'execute', points: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'] },
      { step: 'verify', points: ['verify:pre', 'verify:post'] },
      { step: 'ship', points: ['ship:pre', 'ship:post'] },
    ];
    const errors = assertPointsCoverage(entries);
    assert.deepEqual(errors, []);
  });

  test('fails when a canonical point is missing', () => {
    const entries = [
      { step: 'discuss', points: ['discuss:pre'] }, // missing discuss:post
      { step: 'plan', points: ['plan:pre', 'plan:post'] },
      { step: 'execute', points: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'] },
      { step: 'verify', points: ['verify:pre', 'verify:post'] },
      { step: 'ship', points: ['ship:pre', 'ship:post'] },
    ];
    const errors = assertPointsCoverage(entries);
    assert.ok(errors.some((e) => e.includes('discuss:post') && e.includes('not declared')));
  });

  test('fails when an unknown point is declared', () => {
    const entries = [
      { step: 'discuss', points: ['discuss:pre', 'discuss:post', 'discuss:extra'] },
      { step: 'plan', points: ['plan:pre', 'plan:post'] },
      { step: 'execute', points: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'] },
      { step: 'verify', points: ['verify:pre', 'verify:post'] },
      { step: 'ship', points: ['ship:pre', 'ship:post'] },
    ];
    const errors = assertPointsCoverage(entries);
    assert.ok(errors.some((e) => e.includes('discuss:extra') && e.includes('not in the canonical')));
  });

  test('fails when a point is declared twice', () => {
    const entries = [
      { step: 'discuss', points: ['discuss:pre', 'discuss:post'] },
      { step: 'plan', points: ['plan:pre', 'plan:post', 'discuss:pre'] }, // duplicate
      { step: 'execute', points: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'] },
      { step: 'verify', points: ['verify:pre', 'verify:post'] },
      { step: 'ship', points: ['ship:pre', 'ship:post'] },
    ];
    const errors = assertPointsCoverage(entries);
    assert.ok(errors.some((e) => e.includes('discuss:pre') && e.includes('more than once')));
  });
});

// ─── 4. buildContract — from real workflows ───────────────────────────────────

describe('buildContract from real workflows', () => {
  test('produces a contract matching the inline LOOP_HOST_CONTRACT shape', () => {
    const contract = buildContract(); // reads real gsd-core/workflows/

    // Must be an array of 5 entries
    assert.strictEqual(contract.length, 5, 'contract must have 5 step entries');

    // Each entry must have step, points, agentRoles, coreArtifacts
    for (const entry of contract) {
      assert.ok(typeof entry.step === 'string', 'entry.step must be a string');
      assert.ok(Array.isArray(entry.points), 'entry.points must be an array');
      assert.ok(Array.isArray(entry.agentRoles), 'entry.agentRoles must be an array');
      assert.ok(typeof entry.coreArtifacts === 'object', 'entry.coreArtifacts must be an object');
      assert.ok(Array.isArray(entry.coreArtifacts.produces), 'entry.coreArtifacts.produces must be an array');
      assert.ok(Array.isArray(entry.coreArtifacts.consumes), 'entry.coreArtifacts.consumes must be an array');
    }

    // Verify exact match with the committed loop-host-contract.cjs
    assert.deepEqual(contract, LOOP_HOST_CONTRACT, 'built contract must match committed LOOP_HOST_CONTRACT');
  });

  test('covers exactly the 12 canonical points', () => {
    const contract = buildContract();
    const allPoints = contract.flatMap((e) => e.points);
    assert.strictEqual(allPoints.length, 12, 'must cover exactly 12 points');
    const pointSet = new Set(allPoints);
    assert.strictEqual(pointSet.size, 12, 'all 12 points must be distinct');
    for (const p of CANONICAL_POINTS) {
      assert.ok(pointSet.has(p), 'canonical point "' + p + '" must be declared');
    }
  });

  test('discuss step has orchestrator role and produces CONTEXT.md', () => {
    const contract = buildContract();
    const discuss = contract.find((e) => e.step === 'discuss');
    assert.ok(discuss, 'discuss step must be present');
    assert.deepEqual(discuss.agentRoles, ['orchestrator']);
    assert.deepEqual(discuss.coreArtifacts.produces, ['CONTEXT.md']);
    assert.deepEqual(discuss.coreArtifacts.consumes, []);
  });

  test('plan step has researcher/planner/checker roles and produces PLAN.md', () => {
    const contract = buildContract();
    const plan = contract.find((e) => e.step === 'plan');
    assert.ok(plan, 'plan step must be present');
    assert.deepEqual(plan.agentRoles, ['researcher', 'planner', 'checker']);
    assert.deepEqual(plan.coreArtifacts.produces, ['PLAN.md']);
    assert.deepEqual(plan.coreArtifacts.consumes, ['CONTEXT.md']);
  });

  test('execute step has executor/verifier roles and 4 points', () => {
    const contract = buildContract();
    const execute = contract.find((e) => e.step === 'execute');
    assert.ok(execute, 'execute step must be present');
    assert.deepEqual(execute.agentRoles, ['executor', 'verifier']);
    assert.deepEqual(execute.points, ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post']);
    assert.deepEqual(execute.coreArtifacts.produces, ['SUMMARY.md']);
    assert.deepEqual(execute.coreArtifacts.consumes, ['PLAN.md']);
  });

  test('verify step has orchestrator role and produces UAT.md', () => {
    const contract = buildContract();
    const verify = contract.find((e) => e.step === 'verify');
    assert.ok(verify, 'verify step must be present');
    assert.deepEqual(verify.agentRoles, ['orchestrator']);
    assert.deepEqual(verify.coreArtifacts.produces, ['UAT.md']);
    assert.deepEqual(verify.coreArtifacts.consumes, ['SUMMARY.md']);
  });

  test('ship step has orchestrator role and empty produces', () => {
    const contract = buildContract();
    const ship = contract.find((e) => e.step === 'ship');
    assert.ok(ship, 'ship step must be present');
    assert.deepEqual(ship.agentRoles, ['orchestrator']);
    assert.deepEqual(ship.coreArtifacts.produces, []);
    assert.deepEqual(ship.coreArtifacts.consumes, ['UAT.md']);
  });
});

// ─── 5. cross-check rejects nonexistent agent-role ───────────────────────────

describe('buildContract cross-check drift guard', () => {
  test('rejects a block declaring a nonexistent agent-role', () => {
    // Build a temporary workflows dir where plan-phase.md declares a role
    // that has no corresponding agent reference in the file content.
    const files = makeValidWorkflowFiles();
    // Override plan-phase.md to declare a "phantom" role with no agent reference
    files['plan-phase.md'] =
      '<!-- gsd:loop-host\n' +
      'step: plan\n' +
      'points: plan:pre, plan:post\n' +
      'agent-roles: researcher, planner, checker, phantom\n' +
      'produces: PLAN.md\n' +
      'consumes: CONTEXT.md\n' +
      '-->\n' +
      // Include real agents but NOT the phantom role's agent (phantom is not in ROLE_TO_AGENT)
      'gsd-phase-researcher gsd-planner gsd-plan-checker\n';

    const tmpDir = makeTempWorkflowsDir(files);
    try {
      assert.throws(
        () => buildContract(tmpDir),
        /ROLE_TO_AGENT|no entry/,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('rejects a block declaring a role whose agent is absent from the workflow', () => {
    // plan-phase.md declares 'researcher' but does NOT mention gsd-phase-researcher
    const files = makeValidWorkflowFiles();
    files['plan-phase.md'] =
      '<!-- gsd:loop-host\n' +
      'step: plan\n' +
      'points: plan:pre, plan:post\n' +
      'agent-roles: researcher, planner, checker\n' +
      'produces: PLAN.md\n' +
      'consumes: CONTEXT.md\n' +
      '-->\n' +
      // Only planner and checker present, researcher's agent is absent
      'gsd-planner gsd-plan-checker\n';

    const tmpDir = makeTempWorkflowsDir(files);
    try {
      assert.throws(
        () => buildContract(tmpDir),
        /gsd-phase-researcher.*not referenced|researcher.*gsd-phase-researcher/,
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── 6. --check: CRLF-agnostic + committed-file staleness guard ──────────────

describe('normalizeLineEndings', () => {
  test('normalizeLineEndings strips CR characters', () => {
    const crlf = 'line1\r\nline2\r\nline3';
    const lf = 'line1\nline2\nline3';
    assert.strictEqual(normalizeLineEndings(crlf), lf);
    assert.strictEqual(normalizeLineEndings(lf), lf);
  });
  // The committed-loop-host-contract.cjs freshness guard moved to
  // `npm run lint:generated-sync` (gen-loop-host-contract.cjs --check), where it
  // runs against the committed file in both local and CI lint lanes — instead of
  // being masked by gsd-test's `npm run build` leg regenerating the artifact.
});

// ─── 7. STEP_WORKFLOWS and CANONICAL_POINTS exported constants ────────────────

describe('module exports', () => {
  test('STEP_WORKFLOWS has 5 entries in pipeline order', () => {
    assert.strictEqual(STEP_WORKFLOWS.length, 5);
    assert.strictEqual(STEP_WORKFLOWS[0].step, 'discuss');
    assert.strictEqual(STEP_WORKFLOWS[1].step, 'plan');
    assert.strictEqual(STEP_WORKFLOWS[2].step, 'execute');
    assert.strictEqual(STEP_WORKFLOWS[3].step, 'verify');
    assert.strictEqual(STEP_WORKFLOWS[4].step, 'ship');
  });

  test('CANONICAL_POINTS has exactly 12 entries', () => {
    assert.strictEqual(CANONICAL_POINTS.length, 12);
  });

  test('ROLE_TO_AGENT covers all non-orchestrator roles', () => {
    // All non-orchestrator roles from the real contract
    const allRoles = new Set(
      LOOP_HOST_CONTRACT.flatMap((e) => e.agentRoles).filter((r) => r !== 'orchestrator'),
    );
    for (const role of allRoles) {
      assert.ok(
        ROLE_TO_AGENT[role] !== undefined,
        'ROLE_TO_AGENT must cover non-orchestrator role "' + role + '"',
      );
    }
  });

  test('EXPECTED_POINTS_BY_STEP covers all 5 steps', () => {
    assert.ok(EXPECTED_POINTS_BY_STEP, 'EXPECTED_POINTS_BY_STEP must be exported');
    assert.strictEqual(Object.keys(EXPECTED_POINTS_BY_STEP).length, 5);
    assert.ok(Array.isArray(EXPECTED_POINTS_BY_STEP.execute));
    assert.strictEqual(EXPECTED_POINTS_BY_STEP.execute.length, 4);
  });
});

// ─── #3778 — quick.md is auxiliary without becoming a 6th serialized step ────

describe('Quick auxiliary loop-host contract (#3778)', () => {
  function makeQuickWorkflow({ includePoint = true, includeKind = true, into = 'planner' } = {}) {
    return [
      includePoint ? 'PLAN_PRE_HOOKS_JSON=$(gsd_run loop render-hooks plan:pre --raw)' : '',
      includeKind ? `For each active entry where \`kind == "contribution"\` and \`into == "${into}"\`: inject.` : '',
      '',
    ].join('\n');
  }

  test('Quick is a generator-owned plan auxiliary host with its own contribution expectation', () => {
    const plan = STEP_WORKFLOWS.find((workflow) => workflow.step === 'plan');
    assert.deepEqual(plan.auxiliaryHosts, [
      { file: 'quick.md', point: 'plan:pre', kinds: ['contribution'], into: 'planner' },
    ]);

    const files = makeValidWorkflowFiles();
    files['quick.md'] = makeQuickWorkflow();
    const tmpDir = makeTempWorkflowsDir(files);
    try {
      const contract = buildContract(tmpDir);
      assert.strictEqual(contract.length, 5, 'auxiliary hosts must not create a sixth serialized step');
      assert.strictEqual(
        new Set(contract.flatMap((entry) => entry.points)).size,
        12,
        'auxiliary hosts must not create a duplicate lifecycle point',
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('buildContract rejects Quick without its plan:pre render seam', () => {
    const files = makeValidWorkflowFiles();
    files['quick.md'] = makeQuickWorkflow({ includePoint: false });
    const tmpDir = makeTempWorkflowsDir(files);
    try {
      assert.throws(
        () => buildContract(tmpDir),
        /quick\.md: auxiliary host missing expected point "plan:pre"/,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('buildContract rejects Quick without its contribution dispatch', () => {
    const files = makeValidWorkflowFiles();
    files['quick.md'] = makeQuickWorkflow({ includeKind: false });
    const tmpDir = makeTempWorkflowsDir(files);
    try {
      assert.throws(
        () => buildContract(tmpDir),
        /quick\.md: auxiliary host point "plan:pre" missing expected kind "contribution"/,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('buildContract rejects a Quick contribution dispatch targeting the wrong role', () => {
    const files = makeValidWorkflowFiles();
    files['quick.md'] = makeQuickWorkflow({ into: 'orchestrator' });
    const tmpDir = makeTempWorkflowsDir(files);
    try {
      assert.throws(
        () => buildContract(tmpDir),
        /quick\.md: auxiliary host point "plan:pre" missing expected kind "contribution"/,
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── 8. Regression: FIX 1 — per-step point ownership ────────────────────────

describe('assertPointsCoverage per-step ownership (FIX 1)', () => {
  test('fails when two steps swap a point (discuss declares plan:pre, plan declares discuss:pre)', () => {
    const entries = [
      { step: 'discuss', points: ['discuss:post', 'plan:pre'] },       // wrong: has plan:pre instead of discuss:pre
      { step: 'plan', points: ['discuss:pre', 'plan:post'] },          // wrong: has discuss:pre instead of plan:pre
      { step: 'execute', points: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'] },
      { step: 'verify', points: ['verify:pre', 'verify:post'] },
      { step: 'ship', points: ['ship:pre', 'ship:post'] },
    ];
    const errors = assertPointsCoverage(entries);
    assert.ok(errors.length > 0, 'expected per-step ownership errors');
    const combined = errors.join('\n');
    // Both steps should be named in the errors
    assert.ok(combined.includes('discuss'), 'error must mention discuss step');
    assert.ok(combined.includes('plan'), 'error must mention plan step');
  });

  test('fails when a step is missing one of its own points', () => {
    const entries = [
      { step: 'discuss', points: ['discuss:pre'] }, // missing discuss:post
      { step: 'plan', points: ['plan:pre', 'plan:post'] },
      { step: 'execute', points: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'] },
      { step: 'verify', points: ['verify:pre', 'verify:post'] },
      { step: 'ship', points: ['ship:pre', 'ship:post'] },
    ];
    const errors = assertPointsCoverage(entries);
    assert.ok(errors.length > 0, 'expected ownership error for missing point');
    assert.ok(
      errors.some((e) => e.includes('discuss') && e.includes('expected')),
      'error must name the step and expected points',
    );
  });

  test('fails when a step has an extra point beyond its own', () => {
    const entries = [
      { step: 'discuss', points: ['discuss:pre', 'discuss:post', 'plan:pre'] }, // extra: plan:pre
      { step: 'plan', points: ['plan:post'] }, // missing: plan:pre
      { step: 'execute', points: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'] },
      { step: 'verify', points: ['verify:pre', 'verify:post'] },
      { step: 'ship', points: ['ship:pre', 'ship:post'] },
    ];
    const errors = assertPointsCoverage(entries);
    assert.ok(errors.length > 0, 'expected ownership errors for extra and missing points');
  });

  test('buildContract with swapped points across steps throws a per-step ownership error', () => {
    const files = makeValidWorkflowFiles();
    // discuss declares plan:pre instead of discuss:pre, plan declares discuss:pre instead of plan:pre
    files['discuss-phase.md'] = makeWorkflow('discuss', ['discuss:post', 'plan:pre'], ['orchestrator'], ['CONTEXT.md'], []);
    files['plan-phase.md'] = makeWorkflow(
      'plan', ['discuss:pre', 'plan:post'],
      ['researcher', 'planner', 'checker'],
      ['PLAN.md'], ['CONTEXT.md'],
      'gsd-phase-researcher gsd-planner gsd-plan-checker',
    );
    const tmpDir = makeTempWorkflowsDir(files);
    let cleaned = false;
    try {
      assert.throws(
        () => buildContract(tmpDir),
        /step.*discuss.*expected|step.*plan.*expected/,
      );
    } finally {
      if (!cleaned) {
        cleanup(tmpDir);
        cleaned = true;
      }
    }
  });
});

// ─── 9. Regression: FIX 2 — multiple blocks + duplicate keys ─────────────────

describe('parseLoopHostBlock multiple-block and duplicate-key detection (FIX 2)', () => {
  test('throws when a file has two gsd:loop-host marker blocks', () => {
    const block =
      '<!-- gsd:loop-host\n' +
      'step: discuss\n' +
      'points: discuss:pre, discuss:post\n' +
      'agent-roles: orchestrator\n' +
      'produces: CONTEXT.md\n' +
      'consumes:\n' +
      '-->\n';
    const content = block + '\nSome prose.\n\n' + block;
    assert.throws(
      () => parseLoopHostBlock(content, 'discuss-phase.md'),
      /expected exactly one gsd:loop-host marker block, found 2/,
    );
  });

  test('throws when a block has a duplicate "points" key', () => {
    const content =
      '<!-- gsd:loop-host\n' +
      'step: discuss\n' +
      'points: discuss:pre, discuss:post\n' +
      'points: discuss:pre\n' +        // duplicate
      'agent-roles: orchestrator\n' +
      'produces: CONTEXT.md\n' +
      'consumes:\n' +
      '-->\n';
    assert.throws(
      () => parseLoopHostBlock(content, 'discuss-phase.md'),
      /duplicate key 'points' in gsd:loop-host marker/,
    );
  });

  test('throws when a block has a duplicate "step" key', () => {
    const content =
      '<!-- gsd:loop-host\n' +
      'step: discuss\n' +
      'step: plan\n' +                  // duplicate
      'points: discuss:pre, discuss:post\n' +
      'agent-roles: orchestrator\n' +
      'produces: CONTEXT.md\n' +
      'consumes:\n' +
      '-->\n';
    assert.throws(
      () => parseLoopHostBlock(content, 'discuss-phase.md'),
      /duplicate key 'step' in gsd:loop-host marker/,
    );
  });

  test('buildContract with a two-block file throws with "found 2" error', () => {
    const files = makeValidWorkflowFiles();
    const singleBlock =
      '<!-- gsd:loop-host\n' +
      'step: discuss\n' +
      'points: discuss:pre, discuss:post\n' +
      'agent-roles: orchestrator\n' +
      'produces: CONTEXT.md\n' +
      'consumes:\n' +
      '-->\n';
    files['discuss-phase.md'] = singleBlock + '\nDoc example:\n\n' + singleBlock;
    const tmpDir = makeTempWorkflowsDir(files);
    try {
      assert.throws(
        () => buildContract(tmpDir),
        /found 2/,
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── 10. Regression: FIX 3 — word-boundary agent cross-check ─────────────────

describe('crossCheckRoles word-boundary match (FIX 3)', () => {
  test('gsd-plan-checker-v2 does NOT satisfy required gsd-plan-checker reference', () => {
    // Content has gsd-plan-checker-v2 but NOT bare gsd-plan-checker
    const content = 'Agent("gsd-phase-researcher") Agent("gsd-planner") gsd-plan-checker-v2';
    const errors = crossCheckRoles(content, ['researcher', 'planner', 'checker'], 'plan-phase.md');
    assert.strictEqual(errors.length, 1, 'expected exactly 1 error for checker missing bare reference');
    assert.match(errors[0], /gsd-plan-checker/);
  });

  test('gsd-plan-checker (bare) still satisfies the checker role', () => {
    const content = 'Agent("gsd-phase-researcher") Agent("gsd-planner") gsd-plan-checker something-else';
    const errors = crossCheckRoles(content, ['researcher', 'planner', 'checker'], 'plan-phase.md');
    assert.deepEqual(errors, []);
  });

  test('gsd-plan-checker immediately followed by newline satisfies the checker role', () => {
    const content = 'gsd-phase-researcher\ngsd-planner\ngsd-plan-checker\n';
    const errors = crossCheckRoles(content, ['researcher', 'planner', 'checker'], 'plan-phase.md');
    assert.deepEqual(errors, []);
  });

  test('buildContract rejects workflow referencing only -v2 agent variant', () => {
    const files = makeValidWorkflowFiles();
    // plan-phase.md refers to gsd-plan-checker-v2 but not gsd-plan-checker
    files['plan-phase.md'] =
      '<!-- gsd:loop-host\n' +
      'step: plan\n' +
      'points: plan:pre, plan:post\n' +
      'agent-roles: researcher, planner, checker\n' +
      'produces: PLAN.md\n' +
      'consumes: CONTEXT.md\n' +
      '-->\n' +
      'gsd-phase-researcher gsd-planner gsd-plan-checker-v2\n';
    const tmpDir = makeTempWorkflowsDir(files);
    try {
      assert.throws(
        () => buildContract(tmpDir),
        /gsd-plan-checker.*not referenced|checker.*gsd-plan-checker/,
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── 11. Regression: FIX 4 — --check detects header/body tampering ───────────

describe('--check full-content comparison (FIX 4)', () => {
  test('committed file with tampered header is detected as stale', () => {
    const contract = buildContract();
    const live = serializeContract(contract);
    // Tamper: replace the DO-NOT-EDIT line with something else
    const tampered = live.replace(
      ' * DO NOT EDIT BY HAND. Run: node scripts/gen-loop-host-contract.cjs --write',
      ' * TAMPERED HEADER LINE',
    );
    assert.notStrictEqual(
      normalizeLineEndings(tampered),
      normalizeLineEndings(live),
      'tampered content must differ from live content (staleness detected)',
    );
  });

  test('committed file with tampered body JSON is detected as stale', () => {
    const contract = buildContract();
    const live = serializeContract(contract);
    // Tamper: add a phantom step name
    const tampered = live.replace('"step": "discuss"', '"step": "discuss-tampered"');
    assert.notStrictEqual(
      normalizeLineEndings(tampered),
      normalizeLineEndings(live),
      'tampered body must differ from live content (staleness detected)',
    );
  });

  test('un-tampered committed file passes full-content comparison', () => {
    const contract = buildContract();
    const live = serializeContract(contract);
    const committed = fs.readFileSync(CONTRACT_PATH, 'utf8');
    assert.strictEqual(
      normalizeLineEndings(committed),
      normalizeLineEndings(live),
      'committed file must match live serialization exactly (full-content comparison)',
    );
  });
});

// ─── 12. Regression: FIX 5 — temp-dir cleanup in existing cross-check tests ──
//  (cleanup is handled via try/finally in each test above that creates temp dirs;
//   this suite documents and verifies the makeTempWorkflowsDir helper itself)

describe('temp-dir lifecycle', () => {
  test('makeTempWorkflowsDir creates a directory that can be cleaned up', () => {
    const files = { 'dummy.md': '<!-- gsd:loop-host\nstep: discuss\n-->' };
    const tmpDir = makeTempWorkflowsDir(files);
    assert.ok(fs.existsSync(tmpDir), 'temp dir must exist after creation');
    cleanup(tmpDir);
    assert.ok(!fs.existsSync(tmpDir), 'temp dir must not exist after cleanup');
  });
});
