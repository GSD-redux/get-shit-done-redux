// allow-test-rule: source-text-is-the-product [#1949]
// Agent .md, reference .md, and docs/reference/*.md files — their text IS what the
// runtime loads. Per CONTRIBUTING.md exception matrix, asserting these files
// document the <precondition> contract tests the deployed surface, not derived
// behavior. The behavioral test (cmdVerifyPlanStructure) asserts the validator
// stays additive. Issue #1949.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLANNER = path.join(ROOT, 'agents', 'gsd-planner.md');
const EXECUTOR = path.join(ROOT, 'agents', 'gsd-executor.md');
const PLAN_MD_DOC = path.join(ROOT, 'docs', 'reference', 'plan-md.md');
const PRECONDITIONS_REF = path.join(ROOT, 'gsd-core', 'references', 'planner-preconditions.md');

function read(rel) {
  return fs.readFileSync(rel, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ─── Schema documentation (docs/reference/plan-md.md) ────────────────────────

describe('issue #1949: plan-md.md documents <precondition>', () => {
  test('plan-md.md mentions <precondition> as an optional task element', () => {
    const doc = read(PLAN_MD_DOC);
    assert.match(
      doc,
      /<precondition>/,
      'docs/reference/plan-md.md must document the <precondition> element'
    );
  });

  test('plan-md.md states <precondition> is optional and does not break plans that omit it', () => {
    const doc = read(PLAN_MD_DOC);
    assert.ok(
      /optional/.test(doc) && /precondition/.test(doc),
      'plan-md.md must describe <precondition> as optional'
    );
  });
});

// ─── Planner emission contract (agents/gsd-planner.md) ──────────────────────

describe('issue #1949: gsd-planner.md declares <precondition> emission', () => {
  test('planner references the precondition reference file', () => {
    const planner = read(PLANNER);
    assert.ok(
      planner.includes('planner-preconditions.md'),
      'gsd-planner.md must @-reference planner-preconditions.md (progressive disclosure)'
    );
  });

  test('planner is under the 49152-char cap after adding <precondition> content', () => {
    const planner = read(PLANNER);
    assert.ok(
      planner.length < 49152,
      `gsd-planner.md is ${planner.length} chars, must be < 49152 (LF-normalized)`
    );
  });
});

// ─── Planner-preconditions reference file (progressive disclosure) ───────────

describe('issue #1949: planner-preconditions.md exists with the three emission cases', () => {
  test('reference file exists', () => {
    assert.ok(fs.existsSync(PRECONDITIONS_REF), `Missing: ${PRECONDITIONS_REF}`);
  });

  test('reference documents the user_setup emission case', () => {
    const ref = read(PRECONDITIONS_REF);
    assert.ok(
      /user_setup/.test(ref) || /external service setup/i.test(ref),
      'planner-preconditions.md must document the user_setup / external-setup emission case'
    );
  });

  test('reference documents the prior-phase artifact emission case', () => {
    const ref = read(PRECONDITIONS_REF);
    assert.ok(
      /prior.?phase artifact/i.test(ref) || /artifact from (a )?prior/i.test(ref),
      'planner-preconditions.md must document the prior-phase-artifact emission case'
    );
  });

  test('reference documents the env-var emission case', () => {
    const ref = read(PRECONDITIONS_REF);
    assert.ok(
      /env(ironment)? var/i.test(ref),
      'planner-preconditions.md must document the env-var emission case'
    );
  });

  test('reference maps the contract triad (precondition / postcondition / invariant)', () => {
    const ref = read(PRECONDITIONS_REF);
    assert.ok(
      /postcondition|<verify>|<done>/.test(ref),
      'planner-preconditions.md must map <precondition> to existing postconditions (<verify>/<done>)'
    );
  });
});

// ─── Executor assertion contract (agents/gsd-executor.md) ────────────────────

describe('issue #1949: gsd-executor.md asserts <precondition> before task execution', () => {
  test('executor mentions <precondition>', () => {
    const exec = read(EXECUTOR);
    assert.match(
      exec,
      /<precondition>/,
      'gsd-executor.md must reference <precondition>'
    );
  });

  test('executor routes an unmet precondition through checkpoint machinery (halt, no partial commit)', () => {
    const exec = read(EXECUTOR);
    assert.ok(
      /precondition/i.test(exec) && /checkpoint/.test(exec),
      'gsd-executor.md must route unmet <precondition> through checkpoint machinery'
    );
  });

  test('executor treats a met/absent precondition as a no-op (does not change flow)', () => {
    const exec = read(EXECUTOR);
    assert.ok(
      /no.op|no visible change|continue/i.test(exec),
      'gsd-executor.md must state that a met or absent precondition produces no visible change'
    );
  });

  test('executor is under the 49152-char cap after adding <precondition> content', () => {
    const exec = read(EXECUTOR);
    assert.ok(
      exec.length < 49152,
      `gsd-executor.md is ${exec.length} chars, must be < 49152 (LF-normalized)`
    );
  });
});

// ─── Behavioral test: validator stays additive (cmdVerifyPlanStructure) ──────
//
// `cmdVerifyPlanStructure` checks for PRESENCE of required tags. It must not
// reject unknown optional tags. This is the "does not break plans that omit it"
// plus "does not break plans that include it" guarantee from acceptance #1.
// Pattern mirrors tests/tracer-bullet.test.cjs (companion feature #1945).

function planWith({ precondition = null } = {}) {
  const lines = [
    '<task type="auto">',
    '  <name>Task 1: Test</name>',
  ];
  if (precondition !== null) {
    lines.push(`  <precondition>${precondition}</precondition>`);
  }
  lines.push(
    '  <files>src/x.ts</files>',
    '  <action>Do the thing.</action>',
    '  <verify><automated>echo ok</automated></verify>',
    '  <done>Done</done>',
    '</task>',
    '',
  );
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [src/x.ts]',
    'autonomous: true',
    'must_haves:',
    '  truths:',
    '    - "something is true"',
    '---',
    '',
    '<tasks>',
    '',
    ...lines,
    '</tasks>',
  ].join('\n');
}

function verifyPlan(tmpDir, content) {
  const rel = path.join('.planning', 'phases', '01-test', '01-01-PLAN.md');
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, rel), content);
  const result = runGsdTools(`verify plan-structure ${rel}`, tmpDir);
  assert.ok(result.success, `verify plan-structure failed to run: ${result.error}`);
  return JSON.parse(result.output);
}

describe('issue #1949: cmdVerifyPlanStructure accepts <precondition> (additive)', () => {
  test('plan with <precondition> passes structural validation', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ precondition: 'OPENAI_API_KEY is set in the environment' }));
    assert.strictEqual(out.valid, true, `plan with <precondition> must be valid, errors: ${JSON.stringify(out.errors)}`);
    assert.deepStrictEqual(out.errors, [], 'no validation path may reject a <precondition> task');
    assert.ok(
      !(out.warnings || []).some((w) => /precondition/i.test(w)),
      'nothing may flag the <precondition> element specifically',
    );
  });

  test('plan without <precondition> still passes structural validation (back-compat)', (t) => {
    const tmp = createTempProject();
    t.after(() => cleanup(tmp));

    const out = verifyPlan(tmp, planWith({ precondition: null }));
    assert.strictEqual(out.valid, true, `plan without <precondition> must be valid (back-compat), errors: ${JSON.stringify(out.errors)}`);
  });
});

// ─── Parity: docs/reference/plan-md.md and planner-preconditions.md agree ────
//
// DEFECT.GENERATIVE-FIX-DIVERGENCE: two surfaces describing the same schema
// must agree on the canonical tag spelling. This is the parity guard against
// silent drift.

describe('issue #1949: parity between plan-md.md and planner-preconditions.md', () => {
  test('both surfaces spell the canonical tag <precondition>', () => {
    const doc = read(PLAN_MD_DOC);
    const ref = read(PRECONDITIONS_REF);
    assert.ok(doc.includes('<precondition>'), 'plan-md.md must spell <precondition>');
    assert.ok(ref.includes('<precondition>'), 'planner-preconditions.md must spell <precondition>');
  });
});

// ─── Issue #3210: the precondition-unmet checkpoint must be human-gated ──────
//
// The executor's own invariant ("unmet preconditions are NEVER auto-approved,
// even under AUTO_CFG=true") was unenforceable: the checkpoint it returns for an
// unmet <precondition> carried no gate, and both auto-mode bypass rules only
// exempt `gate="blocking-human"`. Auto-mode therefore auto-approved it with a
// synthetic "approved", the task's <verify> failed closed, and the loop read
// the failure as an executable gap — retrying an operator gate forever (#3210).

describe('issue #3210: executor gates the precondition-unmet checkpoint as blocking-human', () => {
  const CHECKPOINTS_REF = path.join(ROOT, 'gsd-core', 'references', 'checkpoints.md');

  test('unmet-precondition branch stamps the returned checkpoint with Gate: blocking-human', () => {
    const exec = read(EXECUTOR);
    const unmet = exec.split('\n').find((l) => l.includes('**Unmet:**'));
    assert.ok(unmet, 'gsd-executor.md must keep the **Unmet:** precondition branch');
    assert.match(
      unmet,
      /blocking-human/,
      'the unmet-precondition branch must report the checkpoint with **Gate:** blocking-human — ' +
      'that gate is what both auto-mode bypass layers check (#3210)'
    );
  });

  test('auto-mode human-verify rule explicitly exempts precondition-unmet checkpoints', () => {
    const exec = read(EXECUTOR);
    const rule = exec.split('\n').find((l) => l.includes('**checkpoint:human-verify**') && /Auto-approve/.test(l));
    assert.ok(rule, 'gsd-executor.md must keep the auto-mode human-verify bypass rule');
    assert.match(
      rule,
      /precondition/i,
      'the executor auto-mode bypass rule must name precondition-unmet checkpoints as never ' +
      'auto-approved, not only gate="blocking-human" tasks (#3210)'
    );
  });

  test('checkpoints.md maps precondition-unmet checkpoints onto the blocking-human gate', () => {
    const ref = read(CHECKPOINTS_REF);
    const rule = ref.split('\n').find((l) => l.includes('never auto-approved'));
    assert.ok(rule, 'checkpoints.md must keep golden rule 6 (blocking-human is never auto-approved)');
    assert.match(
      rule,
      /precondition/i,
      'golden rule 6 must name the executor\'s precondition-unmet checkpoint as a carrier of ' +
      'gate="blocking-human" (#3210)'
    );
  });

  test('planner-preconditions.md documents the blocking-human gate on the unmet path', () => {
    const ref = read(PRECONDITIONS_REF);
    const unmet = ref.split('\n').find((l) => l.includes('**Unmet**'));
    assert.ok(unmet, 'planner-preconditions.md must keep the executor-behavior Unmet row');
    assert.match(
      unmet,
      /blocking-human/,
      'the Unmet row must state the returned checkpoint carries gate="blocking-human", matching ' +
      'agents/gsd-executor.md (#3210)'
    );
  });
});
