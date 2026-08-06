'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

function workflow(name) {
  return fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', name), 'utf8');
}

function doc(name) {
  return fs.readFileSync(path.join(ROOT, 'docs', name), 'utf8');
}

function sectionBetween(content, startNeedle, endNeedle) {
  const start = content.indexOf(startNeedle);
  assert.ok(start !== -1, `${startNeedle} section must exist`);
  const end = endNeedle ? content.indexOf(endNeedle, start) : -1;
  return content.slice(start, end === -1 ? undefined : end);
}

function hookAt(point, kind, capId) {
  return registry.byLoopPoint[point][kind].find((hook) => hook.capId === capId);
}

describe('ADR-857 phase 6 verification and review capability migration', () => {
  test('registry declares code-review, security, and nyquist feature capabilities', () => {
    for (const capId of ['code-review', 'security', 'nyquist']) {
      assert.ok(registry.capabilities[capId], `${capId} capability must exist`);
      assert.equal(registry.capabilities[capId].role, 'feature');
    }
  });

  test('code-review capability owns review skills, agents, config, and execute hook', () => {
    assert.equal(registry.bySkill['code-review'], 'code-review');
    assert.equal(registry.byAgent['gsd-code-reviewer'], 'code-review');
    assert.equal(registry.byAgent['gsd-code-fixer'], 'code-review');
    assert.equal(registry.configKeys['workflow.code_review'], 'code-review');
    assert.equal(registry.configKeys['workflow.code_review_depth'], 'code-review');

    const hook = hookAt('execute:post', 'steps', 'code-review');
    assert.ok(hook, 'code-review must register an execute:post step');
    assert.deepEqual(hook.ref, { skill: 'code-review' });
    assert.equal(hook.when, 'workflow.code_review');
    assert.deepEqual(hook.produces, ['REVIEW.md']);
    assert.ok(hook.consumes.includes('SUMMARY.md'));
  });

  test('security capability owns secure-phase wiring and blocking ship gate', () => {
    assert.equal(registry.bySkill['secure-phase'], 'security');
    assert.equal(registry.byAgent['gsd-security-auditor'], 'security');
    assert.equal(registry.configKeys['workflow.security_enforcement'], 'security');
    assert.equal(registry.configKeys['workflow.security_asvs_level'], 'security');
    assert.equal(registry.configKeys['workflow.security_block_on'], 'security');

    const step = hookAt('verify:post', 'steps', 'security');
    assert.ok(step, 'security must register a verify:post step');
    assert.deepEqual(step.ref, { skill: 'secure-phase' });
    assert.equal(step.when, 'workflow.security_enforcement');
    assert.equal(step.onError, 'halt');

    const gate = hookAt('ship:pre', 'gates', 'security');
    assert.ok(gate, 'security must register a blocking ship:pre gate');
    assert.equal(gate.blocking, true);
    assert.equal(gate.onError, 'halt');

    const planContribution = hookAt('plan:pre', 'contributions', 'security');
    assert.ok(planContribution, 'security must register a plan:pre contribution for threat-model guidance');
    assert.equal(planContribution.into, 'planner');
    assert.equal(planContribution.when, 'workflow.security_enforcement');
  });

  test('nyquist capability owns validate-phase wiring and config', () => {
    assert.equal(registry.bySkill['validate-phase'], 'nyquist');
    assert.equal(registry.byAgent['gsd-nyquist-auditor'], 'nyquist');
    assert.equal(registry.configKeys['workflow.nyquist_validation'], 'nyquist');

    const hook = hookAt('verify:post', 'steps', 'nyquist');
    assert.ok(hook, 'nyquist must register a verify:post step');
    assert.deepEqual(hook.ref, { skill: 'validate-phase' });
    assert.equal(hook.when, 'workflow.nyquist_validation');
    assert.deepEqual(hook.produces, ['VALIDATION.md']);
    assert.ok(hook.consumes.includes('SUMMARY.md'));
  });

  test('autonomous code review resolves execute:post hooks instead of inlining code_review config', () => {
    const content = workflow('autonomous.md');
    const section = sectionBetween(
      content,
      '**3c.5. Code Review and Fix**',
      '**3d. Post-Execution Routing**',
    );

    assert.ok(section.includes('loop render-hooks execute:post'));
    assert.ok(section.includes('gsd-${ref.skill}'));
    assert.ok(!section.includes('config-get workflow.code_review'));
  });

  test('execute-phase code-review gate resolves execute:post hooks instead of inlining code_review config', () => {
    const content = workflow('execute-phase.md');
    // close_parent_artifacts was extracted to
    // gsd-core/workflows/execute-phase/steps/gap-closure-artifacts.md; the parent now
    // marks that boundary with a <!-- gsd:section id="gap-closure-artifacts" --> comment
    // immediately after code_review_gate's closing </step>, so it remains the correct
    // end-of-step delimiter for isolating this step's body.
    const section = sectionBetween(content, '<step name="code_review_gate"', '<!-- gsd:section id="gap-closure-artifacts"');

    assert.ok(section.includes('loop render-hooks execute:post'));
    assert.ok(section.includes('gsd-${ref.skill}'));
    assert.ok(!section.includes('config-get workflow.code_review'));
  });

  test('quick full-mode code review resolves execute:post hooks instead of inlining code_review config', () => {
    const content = workflow('quick.md');
    // #2994 fragmentization moved Step 6.5 (Verification) out of quick.md into
    // gsd-core/workflows/quick/steps/quick-verification.md; the parent now marks
    // that boundary with a `<!-- gsd:section id="quick-verification" -->` comment
    // immediately after Step 6.25's content, so it remains the correct
    // end-of-step delimiter (mirrors the execute-phase.md gap-closure-artifacts
    // pattern above) instead of bleeding to end-of-file.
    const section = sectionBetween(content, '**Step 6.25: Code review (auto)**', '<!-- gsd:section id="quick-verification"');

    assert.ok(section.includes('loop render-hooks execute:post'));
    assert.ok(section.includes('gsd-code-reviewer'));
    assert.ok(!section.includes('config-get workflow.code_review'));
  });

  test('code-review command self-gates through execute:post hooks', () => {
    const content = workflow('code-review.md');
    const section = sectionBetween(content, '<step name="check_config_gate">', '<step name="resolve_depth">');

    assert.ok(section.includes('loop render-hooks execute:post'));
    assert.ok(section.includes('ref.skill == "code-review"'));
    assert.ok(!section.includes('config-get workflow.code_review'));
  });

  test('code-review-fix command self-gates through execute:post hooks', () => {
    const content = workflow('code-review-fix.md');
    const section = sectionBetween(content, '<step name="check_config_gate">', '<step name="check_review_exists">');

    assert.ok(section.includes('loop render-hooks execute:post'));
    assert.ok(section.includes('ref.skill == "code-review"'));
    assert.ok(!section.includes('config-get workflow.code_review'));
  });

  test('verify-work resolves verify:post security hooks instead of inlining security_enforcement config', () => {
    const content = workflow('verify-work.md');
    const transitionStart = content.indexOf('If issues == 0:');
    assert.ok(transitionStart !== -1, 'verify-work transition block must exist');
    const section = content.slice(transitionStart, content.indexOf('</step>', transitionStart));

    assert.ok(section.includes('loop render-hooks verify:post'));
    assert.ok(section.includes('gsd-${ref.skill}'));
    assert.ok(!section.includes('config-get workflow.security_enforcement'));
  });

  test('plan-phase threat model gate resolves plan:pre security capability hooks', () => {
    const content = workflow('plan-phase.md');
    const section = sectionBetween(content, '## 5.55. Security Threat Model Gate', '## 5.6. UI Design Contract Gate');

    assert.ok(section.includes('loop render-hooks plan:pre'));
    assert.ok(section.includes('capId == "security"'));
    assert.ok(!section.includes('config-get workflow.security_enforcement'));
  });

  test('secure-phase command self-gates through verify:post hooks', () => {
    const content = workflow('secure-phase.md');
    const initFence = ['```bash', 'AUDITOR_MODEL='].join('\n');
    const section = sectionBetween(content, initFence, 'Display banner:');

    assert.ok(section.includes('loop render-hooks verify:post'));
    assert.ok(section.includes('ref.skill == "secure-phase"'));
    assert.ok(!section.includes('config-get workflow.security_enforcement'));
  });

  test('validate-phase command self-gates through verify:post hooks', () => {
    const content = workflow('validate-phase.md');
    const initFence = ['```bash', 'AUDITOR_MODEL='].join('\n');
    const section = sectionBetween(content, initFence, 'Display banner:');

    assert.ok(section.includes('loop render-hooks verify:post'));
    assert.ok(section.includes('ref.skill == "validate-phase"'));
    assert.ok(!section.includes('config-get workflow.nyquist_validation'));
  });

  test('documentation covers migrated review and verification capability hooks', () => {
    const content = doc('reference/review-verification-capabilities.md');
    const manual = doc('how-to/develop-a-capability.md');
    const index = doc('README.md');

    for (const term of [
      '`code-review`',
      '`security`',
      '`nyquist`',
      '`execute:post`',
      '`verify:post`',
      '`ship:pre`',
      'gsd-tools loop render-hooks <point>',
    ]) {
      assert.ok(content.includes(term), `capability reference must document ${term}`);
    }

    assert.ok(
      index.includes('reference/review-verification-capabilities.md'),
      'docs index must link the review and verification capabilities reference',
    );
    assert.ok(
      manual.includes('`security` registers a `plan:pre` contribution, a `verify:post` step, and a blocking `ship:pre` gate.'),
      'capability developer manual must mention review/verification hook examples',
    );
  });
});
