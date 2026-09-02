/**
 * execute-phase MVP+TDD gate — contract test
 * Verifies the workflow markdown documents the gate's resolution chain,
 * per-task firing condition, and end-of-phase review escalation.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

function parseGateContract(content) {
  const lines = content.split(/\r?\n/);
  const lowerLines = lines.map(line => line.toLowerCase());

  // Detect whether the proceed-past-tdd-escalation is conditional on the MVP+TDD block
  // being ABSENT (correct) or unconditional (contradicts the block — regression).
  //
  // A contradicting unconditional proceed looks like:
  //   "regardless ... gate results ... always proceed"
  // That pattern is illegal once the MVP+TDD block is documented, because it nullifies it.
  // The proceed must be guarded ("if ... not blocked ... proceed").
  const hasUnconditionalProceed = /regardless[\s\S]{0,60}gate results[\s\S]{0,60}always proceed/i.test(content)
    || /always proceed[\s\S]{0,80}regardless/i.test(content);

  // The corrected proceed must co-occur with a conditional guard near the block mention.
  // We accept either: explicit conditional keyword ("if ... not ... block" / "otherwise proceed")
  // adjacent to the block text, OR absence of the unconditional pattern altogether.
  const hasProceedConditional = !hasUnconditionalProceed;

  return {
    hasMvpModeVariable: lowerLines.some(line => line.includes('mvp_mode')),
    hasRoadmapModeResolution: lowerLines.some(line => line.includes('phase.mvp-mode') || line.includes('roadmap') && line.includes('mode')),
    // #4011: the gate keys on TDD_MODE ALONE. Any line conjoining MVP_MODE and
    // TDD_MODE re-couples a discipline gate to a product-scope flag and makes
    // workflow.tdd_mode=true silently inert on non-MVP phases.
    hasTddOnlyGateCondition: lines.some(line => /\$TDD_MODE.{0,40}=.{0,20}"true"/.test(line) && !/MVP_MODE/.test(line)),
    hasNoMvpTddConjunct: !lines.some(line => /MVP_MODE/.test(line) && /TDD_MODE/.test(line) && /(if|&&|and)/i.test(line)),
    hasTddOnlyEscalation: !/mvp_mode\s*(=|&&|and)/i.test((content.split('tdd review escalation')[1] || '') ),
    hasGateLabel: lowerLines.some(line => line.includes('mvp+tdd gate') || line.includes('mvp-tdd gate') || line.includes('tdd gate')),
    hasRedCommitRule: lowerLines.some(line => line.includes('failing-test commit') || line.includes('missing red commit') || line.includes('test(')),
    // Must assert the REAL refusal semantics, not merely the words "blocking" + "mvp+tdd"
    // (which "advisory (blocking: false) ... under MVP+TDD" would satisfy as a false green).
    hasBlockingEscalation:
      content.toLowerCase().includes('mvp+tdd')
      && (content.toLowerCase().includes('refuse to mark the phase complete')
        || content.toLowerCase().includes('phase blocked')),
    hasReferenceDoc: lowerLines.some(line => line.includes('execute-mvp-tdd.md')),
    // Must NOT have an unconditional "proceed regardless of gate results" that overrides the block.
    // hasProceedConditional is true when the proceed is properly gated (or absent entirely).
    hasProceedConditional,
  };
}

describe('execute-phase — MVP+TDD gate', () => {
  const contract = parseGateContract(fs.readFileSync(WORKFLOW, 'utf-8'));

  test('Step 1 resolves MVP_MODE from roadmap mode field', () => {
    assert.ok(contract.hasMvpModeVariable, 'workflow must declare MVP_MODE');
    assert.ok(contract.hasRoadmapModeResolution, 'must consult phase mode from roadmap');
  });

  test('gate fires on TDD_MODE alone — no MVP conjunct (#4011)', () => {
    assert.ok(contract.hasTddOnlyGateCondition, 'the per-task gate must key on TDD_MODE alone');
    assert.ok(contract.hasNoMvpTddConjunct,
      'no shipped line may conjoin MVP_MODE with TDD_MODE as a gate condition — workflow.tdd_mode=true must enforce TDD on non-MVP phases too (#4011)');
  });

  test('per-task gate is documented before behavior-adding task execution', () => {
    assert.ok(contract.hasGateLabel, 'must label the gate');
    assert.ok(contract.hasRedCommitRule, 'must reference failing-test commit check');
  });

  test('end-of-phase TDD review escalates to blocking under TDD (#4011)', () => {
    assert.ok(contract.hasBlockingEscalation, 'must escalate end-of-phase review to blocking');
    assert.ok(contract.hasTddOnlyEscalation, 'the escalation must not require MVP_MODE (#4011)');
  });

  test('proceed past TDD escalation is conditional — not an unconditional override', () => {
    assert.ok(
      contract.hasProceedConditional,
      'workflow must NOT contain an unconditional "regardless of gate results, ALWAYS proceed" that nullifies the MVP+TDD block; the proceed must be guarded by the absence of an MVP+TDD block',
    );
  });

  test('workflow references execute-mvp-tdd.md', () => {
    assert.ok(contract.hasReferenceDoc, 'must reference the gate semantics file');
  });
});

describe('execute-phase MVP+TDD — resolution chain integration', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('roadmap.get-phase --pick mode returns mvp when **Mode:** mvp set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## v1.0.0\n\n### Phase 1: User Auth\n**Goal:** As a user, I want to log in, so that I can access.\n**Mode:** mvp\n`
    );
    const result = runGsdTools('roadmap get-phase 1 --pick mode', tmpDir);
    assert.ok(result.success, `roadmap get-phase should succeed, stderr: ${result.error || '(none)'}`);
    assert.strictEqual(result.output.trim(), 'mvp');
  });

  test('roadmap.get-phase --pick mode returns null/empty when no Mode line', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## v1.0.0\n\n### Phase 1: User Auth\n**Goal:** Users can log in.\n`
    );
    const result = runGsdTools('roadmap get-phase 1 --pick mode', tmpDir);
    assert.ok(result.success, `roadmap get-phase should succeed, stderr: ${result.error || '(none)'}`);
    assert.ok(result.output.trim() === '' || result.output.trim() === 'null');
  });

  test('config-get workflow.mvp_mode default is unset in fresh project', () => {
    const result = runGsdTools('config-get workflow.mvp_mode', tmpDir);
    if (result.success) {
      assert.notStrictEqual(result.output.trim(), 'true');
    }
  });
});

// ─── #4011: the gate semantics reference loads on TDD_MODE alone ─────────────

describe('execute-mvp-tdd.md — load condition decoupled from MVP (#4011)', () => {
  const REF = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-mvp-tdd.md');
  const content = fs.readFileSync(REF, 'utf-8');

  test('reference no longer requires MVP_MODE to load', () => {
    const head = content.slice(0, 1200);
    assert.ok(!/MVP_MODE\s*=\s*true\s*(AND|&&|and)\s*TDD_MODE|both.{0,20}MVP_MODE\s*=\s*true\s*AND/i.test(head),
      'execute-mvp-tdd.md must load on TDD_MODE alone (#4011)');
    assert.ok(/TDD_MODE\s*=\s*true/i.test(head), 'load condition must still name TDD_MODE');
  });
});
