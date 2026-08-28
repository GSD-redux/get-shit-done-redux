/**
 * GSD Tools Tests - Verify
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { runHook } = require('./helpers/process-seam.cjs');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/**
 * Bound for the grep/sed availability probes and region-extraction calls in
 * the region-scoped negative-gate proof below (#3144). These are not git —
 * reusing `GIT_TIMEOUT_MS` for them would tie an unrelated tool's budget to
 * git's, so they get their own named constant even though the value happens
 * to match; a `grep -Eq`/`sed -n` over a small temp file is well under this.
 */
const TEXT_TOOL_TIMEOUT_MS = 15000;

// ─── helpers ──────────────────────────────────────────────────────────────────

// Build a minimal valid PLAN.md content with all required frontmatter fields
function validPlanContent({ wave = 1, dependsOn = '[]', autonomous = 'true', extraTasks = '' } = {}) {
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    `wave: ${wave}`,
    `depends_on: ${dependsOn}`,
    'files_modified: [some/file.ts]',
    `autonomous: ${autonomous}`,
    'must_haves:',
    '  truths:',
    '    - "something is true"',
    '---',
    '',
    '<tasks>',
    '',
    '<task type="auto">',
    '  <name>Task 1: Do something</name>',
    '  <files>some/file.ts</files>',
    '  <action>Do the thing</action>',
    '  <verify><automated>echo ok</automated></verify>',
    '  <done>Thing is done</done>',
    '</task>',
    extraTasks,
    '',
    '</tasks>',
  ].join('\n');
}

describe('validate consistency command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('passes for consistent project', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n### Phase 2: B\n### Phase 3: C\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-c'), { recursive: true });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.passed, true, 'should pass');
    assert.strictEqual(output.warning_count, 0, 'no warnings');
  });

  test('warns about phase on disk but not in roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-orphan'), { recursive: true });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.warning_count > 0, 'should have warnings');
    assert.ok(
      output.warnings.some(w => w.message.includes('disk but not in ROADMAP')),
      'should warn about orphan directory'
    );
    // W007 is REUSED verbatim from `validate.health`'s rule table (design doc,
    // "Which rules run where") — the code is proof of reuse, not a mistake.
    assert.ok(
      output.warnings.some(w => w.code === 'W007'),
      `expected code W007 for the orphan-on-disk warning; got: ${JSON.stringify(output.warnings)}`
    );
  });

  test('#3225: sentinel phase dirs (999/0) do not warn; real orphans still do', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    // Sentinel dirs — never-on-roadmap by convention (SENTINEL_RANGES=[0,999]).
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '999-interim'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '0-drafts'), { recursive: true });
    // A real orphan (non-sentinel) that SHOULD still warn.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-orphan'), { recursive: true });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    const sentinelWarnings = output.warnings.filter(
      w => w.message.includes('disk but not in ROADMAP') && /\b(0|999)\b/.test(w.message)
    );
    assert.strictEqual(
      sentinelWarnings.length, 0,
      `sentinel phase dirs must not warn; got: ${JSON.stringify(sentinelWarnings)}`
    );
    // Negative space: the real orphan must still warn.
    assert.ok(
      output.warnings.some(w => w.message.includes('disk but not in ROADMAP') && /02\b/.test(w.message)),
      `expected a warning for the real orphan 02; got: ${JSON.stringify(output.warnings)}`
    );
    // #3225 (review finding): a sentinel dir must NOT produce a spurious
    // "Gap in phase numbering: N → 999" either (the gap check builds its integer
    // sequence from diskPhases and would otherwise include 999).
    const sentinelGaps = output.warnings.filter(
      w => w.message.includes('Gap in phase numbering') && /999\b/.test(w.message)
    );
    assert.strictEqual(
      sentinelGaps.length, 0,
      `sentinel 999 must not create a spurious numbering gap; got: ${JSON.stringify(sentinelGaps)}`
    );
  });

  test('warns about gaps in phase numbering', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n### Phase 3: C\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-c'), { recursive: true });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.message.includes('Gap in phase numbering')),
      'should warn about gap'
    );
    // C001 — new code namespace (design doc, "Code namespace"): not a W0NN,
    // since this subject has no `validate.health` equivalent.
    assert.ok(
      output.warnings.some(w => w.code === 'C001'),
      `expected code C001 for the phase-numbering gap; got: ${JSON.stringify(output.warnings)}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify plan-structure command
// ─────────────────────────────────────────────────────────────────────────────

describe('verify plan-structure command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports missing required frontmatter fields', () => {
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, '# No frontmatter here\n\nJust a plan without YAML.\n');

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('Missing required frontmatter field')),
      `Expected "Missing required frontmatter field" in errors: ${JSON.stringify(output.errors)}`
    );
  });

  test('validates complete plan with all required fields and tasks', () => {
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, validPlanContent());

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, `should be valid, errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], 'should have no errors');
    assert.strictEqual(output.task_count, 1, 'should have 1 task');
  });

  test('reports task missing name element', () => {
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [some/file.ts]',
      'autonomous: true',
      'must_haves:',
      '  truths:',
      '    - "something"',
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      '  <action>Do it</action>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>Done</done>',
      '</task>',
      '</tasks>',
    ].join('\n');

    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, content);

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.errors.some(e => e.includes('Task missing <name>')),
      `Expected "Task missing <name>" in errors: ${JSON.stringify(output.errors)}`
    );
  });

  test('reports task missing action element', () => {
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [some/file.ts]',
      'autonomous: true',
      'must_haves:',
      '  truths:',
      '    - "something"',
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      '  <name>Task 1: No action</name>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>Done</done>',
      '</task>',
      '</tasks>',
    ].join('\n');

    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, content);

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.errors.some(e => e.includes('missing <action>')),
      `Expected "missing <action>" in errors: ${JSON.stringify(output.errors)}`
    );
  });

  test('warns about wave > 1 with empty depends_on', () => {
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, validPlanContent({ wave: 2, dependsOn: '[]' }));

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.includes('Wave > 1 but depends_on is empty')),
      `Expected "Wave > 1 but depends_on is empty" in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('errors when checkpoint task but autonomous is true', () => {
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [some/file.ts]',
      'autonomous: true',
      'must_haves:',
      '  truths:',
      '    - "something"',
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      '  <name>Task 1: Normal</name>',
      '  <files>some/file.ts</files>',
      '  <action>Do it</action>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>Done</done>',
      '</task>',
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Task 2: Verify UI</name>',
      '  <what-built>UI at localhost:3000</what-built>',
      '  <how-to-verify>Visit the app</how-to-verify>',
      '  <resume-signal>Type "approved"</resume-signal>',
      '</task>',
      '</tasks>',
    ].join('\n');

    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, content);

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.errors.some(e => e.includes('checkpoint tasks but autonomous is not false')),
      `Expected checkpoint/autonomous error in errors: ${JSON.stringify(output.errors)}`
    );
  });

  test('returns error for nonexistent file', () => {
    const result = runGsdTools('verify plan-structure .planning/phases/01-test/nonexistent.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error, `Expected error field in output: ${JSON.stringify(output)}`);
    assert.ok(
      output.error.includes('File not found'),
      `Expected "File not found" in error: ${output.error}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify plan-structure — checkpoint task types (#2444)
// A checkpoint:* task uses type-specific required fields (per
// gsd-core/references/checkpoints.md), NOT the auto-task <action>/<verify>/<done>.
// ─────────────────────────────────────────────────────────────────────────────

describe('verify plan-structure — checkpoint task types (#2444)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: wrap a task body in a complete valid PLAN.md scaffold.
  function planWithTask(taskBody, { autonomous = 'false' } = {}) {
    return [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [some/file.ts]',
      `autonomous: ${autonomous}`,
      'must_haves:',
      '  truths:',
      '    - "something"',
      '---',
      '',
      '<tasks>',
      taskBody,
      '</tasks>',
    ].join('\n');
  }

  function runVerify(planContent) {
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  // ── AC1: canonical checkpoint tasks pass with zero findings ────────────────

  test('checkpoint:human-verify with canonical triple passes (AC1)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: verify UI</name>',
      '  <what-built>Dashboard at localhost:3000</what-built>',
      '  <how-to-verify>Visit /dashboard, check layout</how-to-verify>',
      '  <resume-signal>Type "approved" or describe issues</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
    assert.strictEqual(output.task_count, 1, 'should count the checkpoint task');
  });

  test('checkpoint:decision with canonical fields passes (AC1)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:decision" gate="blocking">',
      '  <name>Checkpoint: pick auth provider</name>',
      '  <decision>Select authentication provider</decision>',
      '  <context>Need user authentication.</context>',
      '  <options>',
      '    <option id="supabase"><name>Supabase Auth</name><pros>Built-in</pros><cons>Lock-in</cons></option>',
      '    <option id="clerk"><name>Clerk</name><pros>DX</pros><cons>Paid</cons></option>',
      '  </options>',
      '  <resume-signal>Select: supabase or clerk</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
  });

  test('checkpoint:human-action with canonical fields passes (AC1)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-action" gate="blocking">',
      '  <name>Checkpoint: complete email verification</name>',
      '  <action>Click the verification link in your inbox</action>',
      '  <instructions>I created the account; check your email.</instructions>',
      '  <verification>API key works via curl</verification>',
      '  <resume-signal>Type "done" when email verified</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
  });

  test('unknown checkpoint:* subtype passes with just <resume-signal> (forward-compat)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:custom-future-type">',
      '  <name>Checkpoint: future</name>',
      '  <resume-signal>Type "ok"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
  });

  test('mixed plan: auto task + checkpoint:human-verify task passes (AC1 realistic)', () => {
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: build dashboard</name>',
      '  <files>src/dashboard.ts</files>',
      '  <action>Scaffold the dashboard</action>',
      '  <verify><automated>npm test</automated></verify>',
      '  <done>Dashboard renders</done>',
      '</task>',
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: visual review</name>',
      '  <what-built>Dashboard at localhost:3000</what-built>',
      '  <how-to-verify>Visit /dashboard, check responsive layout</how-to-verify>',
      '  <resume-signal>Type "approved"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
    assert.strictEqual(output.task_count, 2, 'should count both tasks');
  });

  // ── AC2: checkpoint tasks missing required fields are still flagged ────────

  test('checkpoint:human-verify missing <how-to-verify> is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: verify UI</name>',
      '  <what-built>UI at localhost:3000</what-built>',
      '  <resume-signal>Type "approved"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <how-to-verify>')),
      `Expected "missing <how-to-verify>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint:human-verify missing <what-built> is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: verify UI</name>',
      '  <how-to-verify>Visit /dashboard</how-to-verify>',
      '  <resume-signal>Type "approved"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <what-built>')),
      `Expected "missing <what-built>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint:decision missing <options> is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:decision" gate="blocking">',
      '  <name>Checkpoint: pick</name>',
      '  <decision>Select provider</decision>',
      '  <resume-signal>Select: a or b</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <options>')),
      `Expected "missing <options>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint:human-action missing <instructions> is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-action" gate="blocking">',
      '  <name>Checkpoint: act</name>',
      '  <action>Do the thing</action>',
      '  <verification>curl returns 200</verification>',
      '  <resume-signal>Type "done"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <instructions>')),
      `Expected "missing <instructions>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint:decision missing <decision> is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:decision" gate="blocking">',
      '  <name>Checkpoint: pick</name>',
      '  <options>',
      '    <option id="a"><name>A</name><pros>p</pros><cons>c</cons></option>',
      '  </options>',
      '  <resume-signal>Select: a</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <decision>')),
      `Expected "missing <decision>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint:human-action missing <action> is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-action" gate="blocking">',
      '  <name>Checkpoint: act</name>',
      '  <instructions>Do it.</instructions>',
      '  <verification>curl returns 200</verification>',
      '  <resume-signal>Type "done"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <action>')),
      `Expected "missing <action>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint:human-action missing <verification> is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-action" gate="blocking">',
      '  <name>Checkpoint: act</name>',
      '  <action>Do it</action>',
      '  <instructions>Do it.</instructions>',
      '  <resume-signal>Type "done"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <verification>')),
      `Expected "missing <verification>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('any checkpoint:* missing <resume-signal> is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: verify UI</name>',
      '  <what-built>UI</what-built>',
      '  <how-to-verify>Visit</how-to-verify>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <resume-signal>')),
      `Expected "missing <resume-signal>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint task without a type attribute still gets non-checkpoint rules (regression guard)', () => {
    // A bare <task> (no type=) is NOT treated as a checkpoint; current rules apply.
    const output = runVerify(planWithTask([
      '<task>',
      '  <name>Bare task</name>',
      '  <files>x.ts</files>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>ok</done>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid (missing <action>)');
    assert.ok(
      output.errors.some(e => e.includes('missing <action>')),
      `Expected "missing <action>" error: ${JSON.stringify(output.errors)}`
    );
  });

  // ── AC3: non-checkpoint tasks missing fields are still flagged (no regression) ──

  test('non-checkpoint task missing <action> is still flagged (AC3)', () => {
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: no action</name>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>Done</done>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    assert.ok(
      output.errors.some(e => e.includes('missing <action>')),
      `Expected "missing <action>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('non-checkpoint task missing <verify> still warns (AC3)', () => {
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: no verify</name>',
      '  <files>x.ts</files>',
      '  <action>Do it</action>',
      '  <done>Done</done>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    assert.ok(
      output.warnings.some(w => w.includes('missing <verify>')),
      `Expected "missing <verify>" warning: ${JSON.stringify(output.warnings)}`
    );
  });

  test('non-checkpoint task missing <done> still warns (AC3)', () => {
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: no done</name>',
      '  <files>x.ts</files>',
      '  <action>Do it</action>',
      '  <verify><automated>echo ok</automated></verify>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    assert.ok(
      output.warnings.some(w => w.includes('missing <done>')),
      `Expected "missing <done>" warning: ${JSON.stringify(output.warnings)}`
    );
  });

  test('non-checkpoint task missing <files> still warns (AC3)', () => {
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: no files</name>',
      '  <action>Do it</action>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>Done</done>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    assert.ok(
      output.warnings.some(w => w.includes('missing <files>')),
      `Expected "missing <files>" warning: ${JSON.stringify(output.warnings)}`
    );
  });

  // ── Security: type-attribute charset is bounded (no markup injection) ──────

  test('task type attribute with hostile markup fragment is not surfaced unsanitized', () => {
    // Per CONTRIBUTING.md §"Security and prompt-injection surfaces": a hostile
    // PLAN.md cannot inject unclosed-tag fragments into the verifier's typed
    // JSON output via the type= attribute. The charset [a-zA-Z0-9_:-] rejects
    // '<', '>', '(', '&', etc., so a payload like type=evil<fragment captures
    // only `evil` (the `<` terminates the match); the surfaced `type` field
    // carries no markup.
    const output = runVerify(planWithTask([
      '<task type=evil<fragment>',
      '  <name>Hostile</name>',
      '  <action>do</action>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>ok</done>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    const hostile = output.tasks.find(t => t.name === 'Hostile');
    assert.ok(hostile, `Expected to find Hostile task in output.tasks: ${JSON.stringify(output.tasks)}`);
    assert.ok(
      !/[<>()&]/.test(hostile.type),
      `Expected type to contain no markup chars; got: ${JSON.stringify(hostile.type)}`
    );
    assert.strictEqual(hostile.type, 'evil', `Expected capture to stop at '<'; got: ${JSON.stringify(hostile.type)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify plan-structure — attributed child tags (#3193)
// A task's child elements (files/action/verify/done + every checkpoint-specific
// field) must be recognized as present even when the opening tag carries an
// attribute (e.g. <verify mode="auto">…</verify>), consistent with how the
// parent <task type="…"> is already read. The presence regexes were literal
// (/<verify>/.test(body)) and were defeated by any attribute.
// ─────────────────────────────────────────────────────────────────────────────

describe('verify plan-structure — attributed child tags (#3193)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: wrap a task body in a complete valid PLAN.md scaffold. Mirrors the
  // #2444 suite's planWithTask so each test reads as a one-task plan.
  function planWithTask(taskBody, { autonomous = 'false' } = {}) {
    return [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [some/file.ts]',
      `autonomous: ${autonomous}`,
      'must_haves:',
      '  truths:',
      '    - "something"',
      '---',
      '',
      '<tasks>',
      taskBody,
      '</tasks>',
    ].join('\n');
  }

  function runVerify(planContent) {
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  // ── AC1: attributed child tags pass with zero findings ──────────────────────

  test('auto task with every required field attributed passes (AC1)', () => {
    // Every required auto-task child carries a `mode="auto"` attribute on its
    // opening tag — the exact shape the issue reports as false-flagged.
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: attributed</name>',
      '  <files mode="auto">some/file.ts</files>',
      '  <action mode="auto">Do the thing</action>',
      '  <verify mode="auto"><automated>echo ok</automated></verify>',
      '  <done mode="auto">Thing is done</done>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.warnings, [], `expected no warnings; got: ${JSON.stringify(output.warnings)}`);
  });

  test('checkpoint:human-verify with attributed triple passes (AC1)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: verify UI</name>',
      '  <what-built mode="auto">Dashboard at localhost:3000</what-built>',
      '  <how-to-verify mode="human">Visit /dashboard, check layout</how-to-verify>',
      '  <resume-signal mode="blocking">Type "approved"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
  });

  test('checkpoint:decision with attributed fields passes (AC1)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:decision" gate="blocking">',
      '  <name>Checkpoint: pick auth provider</name>',
      '  <decision mode="human">Select authentication provider</decision>',
      '  <options mode="human">',
      '    <option id="supabase"><name>Supabase Auth</name><pros>Built-in</pros><cons>Lock-in</cons></option>',
      '  </options>',
      '  <resume-signal mode="blocking">Select: supabase</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
  });

  test('checkpoint:human-action with attributed fields passes (AC1)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-action" gate="blocking">',
      '  <name>Checkpoint: complete email verification</name>',
      '  <action mode="human">Click the verification link in your inbox</action>',
      '  <instructions mode="human">I created the account; check your email.</instructions>',
      '  <verification mode="auto">API key works via curl</verification>',
      '  <resume-signal mode="blocking">Type "done"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
  });

  test('mixed plan: attributed auto task + attributed checkpoint task passes (AC1 realistic)', () => {
    // Mirrors the issue's "two plans in one project" shape: every required
    // field across BOTH task types carries an attribute.
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: build dashboard</name>',
      '  <files mode="auto">src/dashboard.ts</files>',
      '  <action mode="auto">Scaffold the dashboard</action>',
      '  <verify mode="auto"><automated>npm test</automated></verify>',
      '  <done mode="auto">Dashboard renders</done>',
      '</task>',
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: visual review</name>',
      '  <what-built mode="auto">Dashboard at localhost:3000</what-built>',
      '  <how-to-verify mode="human">Visit /dashboard</how-to-verify>',
      '  <resume-signal mode="blocking">Type "approved"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.errors, [], `expected no errors; got: ${JSON.stringify(output.errors)}`);
    assert.strictEqual(output.task_count, 2, 'should count both tasks');
  });

  // ── AC2: genuinely absent child tag is still flagged (no false negatives) ───

  test('auto task with attributed siblings but verify omitted still warns (AC2)', () => {
    // files/action/done are attributed; verify is entirely absent (not bare,
    // not attributed). The fix must not invent presence from nothing.
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: no verify</name>',
      '  <files mode="auto">some/file.ts</files>',
      '  <action mode="auto">Do it</action>',
      '  <done mode="auto">Done</done>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    assert.ok(
      output.warnings.some(w => w.includes('missing <verify>')),
      `Expected "missing <verify>" warning: ${JSON.stringify(output.warnings)}`
    );
  });

  test('checkpoint:human-verify with attributed siblings but how-to-verify omitted is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: verify UI</name>',
      '  <what-built mode="auto">UI at localhost:3000</what-built>',
      '  <resume-signal mode="blocking">Type "approved"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <how-to-verify>')),
      `Expected "missing <how-to-verify>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint:human-action with attributed siblings but instructions omitted is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-action" gate="blocking">',
      '  <name>Checkpoint: act</name>',
      '  <action mode="human">Do the thing</action>',
      '  <verification mode="auto">curl returns 200</verification>',
      '  <resume-signal mode="blocking">Type "done"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <instructions>')),
      `Expected "missing <instructions>" error: ${JSON.stringify(output.errors)}`
    );
  });

  test('checkpoint task with attributed siblings but resume-signal omitted is flagged (AC2)', () => {
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-verify" gate="blocking">',
      '  <name>Checkpoint: verify UI</name>',
      '  <what-built mode="auto">UI</what-built>',
      '  <how-to-verify mode="human">Visit</how-to-verify>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <resume-signal>')),
      `Expected "missing <resume-signal>" error: ${JSON.stringify(output.errors)}`
    );
  });

  // ── AC3: bare + attributed tags mix cleanly (no regression on bare form) ────

  test('mixed bare and attributed tags within one task pass (AC3)', () => {
    // <action> is bare; <verify>/<done>/<files> are attributed. Proves the
    // attribute-tolerant regex did not stop matching the bare opener.
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: mixed</name>',
      '  <files mode="auto">some/file.ts</files>',
      '  <action>Do the thing</action>',
      '  <verify mode="auto"><automated>echo ok</automated></verify>',
      '  <done mode="auto">Done</done>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    assert.strictEqual(output.valid, true, `expected valid; errors: ${JSON.stringify(output.errors)}`);
    assert.deepStrictEqual(output.warnings, [], `expected no warnings; got: ${JSON.stringify(output.warnings)}`);
  });

  // ── AC4: boundary — a hyphenated sibling tag must not satisfy a shorter tag ─

  test('<verify-mode> present, <verify> absent does not satisfy <verify> (AC4 boundary)', () => {
    // The fix uses /<tag[\s>]/ so that `<verify` followed by `-` (as in
    // `<verify-mode>`) does NOT count as `<verify>` presence. A bare
    // hyphenated opener must not mask a genuinely-missing shorter tag.
    const output = runVerify(planWithTask([
      '<task type="auto">',
      '  <name>Task 1: hyphen sibling</name>',
      '  <files>some/file.ts</files>',
      '  <action>Do it</action>',
      '  <verify-mode>not a real verify tag</verify-mode>',
      '  <done>Done</done>',
      '</task>',
    ].join('\n'), { autonomous: 'true' }));

    assert.ok(
      output.warnings.some(w => w.includes('missing <verify>')),
      `Expected "missing <verify>" warning despite <verify-mode>: ${JSON.stringify(output.warnings)}`
    );
  });

  test('<verify> does not satisfy the checkpoint:human-action <verification> requirement (AC4 boundary)', () => {
    // The [\s>] terminator after the tag name must keep <verify> and
    // <verification> distinct: a <verify> opener is NOT a <verification>
    // opener, so a human-action task with only <verify> must still be flagged
    // for the missing <verification>.
    const output = runVerify(planWithTask([
      '<task type="checkpoint:human-action" gate="blocking">',
      '  <name>Checkpoint: act</name>',
      '  <action>Do it</action>',
      '  <instructions>Do it.</instructions>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <resume-signal>Type "done"</resume-signal>',
      '</task>',
    ].join('\n')));

    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.errors.some(e => e.includes('missing <verification>')),
      `Expected "missing <verification>" error (not satisfied by <verify>): ${JSON.stringify(output.errors)}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify phase-completeness command
// ─────────────────────────────────────────────────────────────────────────────

describe('verify phase-completeness command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create ROADMAP.md referencing phase 01 so findPhaseInternal can locate it
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Test\n**Goal**: Test phase\n'
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports complete phase with matching plans and summaries', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('verify phase-completeness 01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.complete, true, `should be complete, errors: ${JSON.stringify(output.errors)}`);
    assert.strictEqual(output.plan_count, 1, 'should have 1 plan');
    assert.strictEqual(output.summary_count, 1, 'should have 1 summary');
    assert.deepStrictEqual(output.incomplete_plans, [], 'should have no incomplete plans');
  });

  test('reports incomplete phase with plan missing summary', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('verify phase-completeness 01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.complete, false, 'should be incomplete');
    assert.ok(
      output.incomplete_plans.some(id => id.includes('01-01')),
      `Expected "01-01" in incomplete_plans: ${JSON.stringify(output.incomplete_plans)}`
    );
    assert.ok(
      output.errors.some(e => e.includes('Plans without summaries')),
      `Expected "Plans without summaries" in errors: ${JSON.stringify(output.errors)}`
    );
  });

  test('warns about orphan summaries', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('verify phase-completeness 01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.includes('Summaries without plans')),
      `Expected "Summaries without plans" in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('returns error for nonexistent phase', () => {
    const result = runGsdTools('verify phase-completeness 99', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error, `Expected error field in output: ${JSON.stringify(output)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify-summary command
// ─────────────────────────────────────────────────────────────────────────────

describe('verify summary command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns not found for nonexistent summary', () => {
    const result = runGsdTools('verify-summary .planning/phases/01-test/nonexistent.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.passed, false, 'should not pass');
    assert.strictEqual(output.checks.summary_exists, false, 'summary should not exist');
    assert.ok(
      output.errors.some(e => e.includes('SUMMARY.md not found')),
      `Expected "SUMMARY.md not found" in errors: ${JSON.stringify(output.errors)}`
    );
  });

  test('passes for valid summary with real files and commits', () => {
    // Create a source file and commit it
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'console.log("hello");\n');
    gitOrThrow(['add', '-A'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'add app.js'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    const hash = gitOrThrow(['rev-parse', '--short', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();

    // Write SUMMARY.md referencing the file and commit hash
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      `Created: \`src/app.js\``,
      '',
      `Commit: ${hash}`,
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.passed, true, `should pass, errors: ${JSON.stringify(output.errors)}`);
    assert.strictEqual(output.checks.summary_exists, true, 'summary should exist');
    assert.strictEqual(output.checks.commits_exist, true, 'commits should exist');
  });

  test('reports missing files mentioned in summary', () => {
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      'Created: `src/nonexistent.js`',
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.checks.files_created.missing.includes('src/nonexistent.js'),
      `Expected missing to include "src/nonexistent.js": ${JSON.stringify(output.checks.files_created.missing)}`
    );
  });

  test('detects self-check section with pass indicators', () => {
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      '## Self-Check',
      '',
      'All tests pass',
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.checks.self_check, 'passed', `Expected self_check "passed": ${JSON.stringify(output.checks)}`);
  });

  test('detects self-check section with fail indicators', () => {
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      '## Verification',
      '',
      'Tests failed',
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.checks.self_check, 'failed', `Expected self_check "failed": ${JSON.stringify(output.checks)}`);
  });

  test('REG-03: returns self_check "not_found" when no self-check section exists', () => {
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      '## Accomplishments',
      '',
      'Everything went well.',
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.checks.self_check, 'not_found', `Expected self_check "not_found": ${JSON.stringify(output.checks)}`);
    assert.strictEqual(output.passed, true, `Missing self-check should not fail: ${JSON.stringify(output)}`);
  });

  test('search(-1) regression: self-check guard prevents entry when no heading', () => {
    // No Self-Check/Verification/Quality Check heading — guard on line 79 prevents
    // content.search(selfCheckPattern) from ever being called, so -1 is impossible
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      '## Notes',
      '',
      'Some content here without a self-check heading.',
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Guard works: selfCheckPattern.test() is false, if block not entered, selfCheck stays 'not_found'
    assert.strictEqual(output.checks.self_check, 'not_found', `Expected not_found since no heading: ${JSON.stringify(output.checks)}`);
  });

  test('respects checkFileCount parameter', () => {
    // Write summary referencing 5 files (none exist)
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      'Files: `src/a.js`, `src/b.js`, `src/c.js`, `src/d.js`, `src/e.js`',
    ].join('\n'));

    // Pass checkFileCount = 1 so only 1 file is checked
    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md --check-count 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.checks.files_created.checked <= 1,
      `Expected checked <= 1, got ${output.checks.files_created.checked}`
    );
  });

  // #2844: a prose MENTION of a path (not a creation claim) must not be treated
  // as a file claim. Pre-fix Pattern 1 matched any backticked path-like token, so
  // `shared/types.ts` in a "next phase will add…" sentence was checked for
  // existence and its absence failed the verdict on a healthy phase.
  test('#2844 a prose path mention is not treated as a missing file claim', () => {
    // Real created file exists.
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'real.ts'), 'export const x = 1;\n');
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      'This phase investigated the schema surface.',
      '', // PROSE mention — NOT a creation claim; shared/types.ts does NOT exist.
      'Next phase will add `shared/types.ts` for the shared schema.',
      '',
      'Created: `src/real.ts`',
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.passed, true,
      `prose mention must not fail the verdict; errors: ${JSON.stringify(output.errors)}`);
    assert.ok(!JSON.stringify(output.checks.files_created.missing).includes('shared/types.ts'),
      'shared/types.ts (a prose mention, absent) must NOT be reported missing');
  });

  test('#2844 a SUMMARY with only future/prose path mentions passes', () => {
    // The mentioned paths are FUTURE deliverables (not produced this phase) and
    // are absent — they must not be probed. isFutureMention excludes the lines.
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      'Investigation only. No artifacts created this phase.',
      '`docs/schema.md` is planned for a later phase.',
      'Next phase will add `shared/types.ts` for the shared schema.',
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.passed, true,
      `future/prose mentions must not fail the verdict; errors: ${JSON.stringify(output.errors)}`);
  });

  test('#2844 negative-space: a real Created claim for an ABSENT file still fails', () => {
    // src/missing.ts is claimed but does NOT exist — must still be caught.
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, [
      '# Summary',
      '',
      'Created: `src/missing.ts`',
    ].join('\n'));

    const result = runGsdTools('verify-summary .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.passed, false, 'an absent claimed file must fail the verdict');
    assert.ok(JSON.stringify(output.checks.files_created.missing).includes('src/missing.ts'),
      'src/missing.ts must be reported missing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify references command
// ─────────────────────────────────────────────────────────────────────────────

describe('verify references command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports valid when all referenced files exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'console.log("app");\n');
    const filePath = path.join(tmpDir, '.planning', 'phases', '01-test', 'doc.md');
    fs.writeFileSync(filePath, '@src/app.js\n');

    const result = runGsdTools('verify references .planning/phases/01-test/doc.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, `should be valid: ${JSON.stringify(output)}`);
    assert.strictEqual(output.found, 1, `should find 1 file: ${JSON.stringify(output)}`);
  });

  test('reports missing for nonexistent referenced files', () => {
    const filePath = path.join(tmpDir, '.planning', 'phases', '01-test', 'doc.md');
    fs.writeFileSync(filePath, '@src/missing.js\n');

    const result = runGsdTools('verify references .planning/phases/01-test/doc.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, 'should be invalid');
    assert.ok(
      output.missing.includes('src/missing.js'),
      `Expected missing to include "src/missing.js": ${JSON.stringify(output.missing)}`
    );
  });

  test('detects backtick file paths', () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.js'), 'module.exports = {};\n');
    const filePath = path.join(tmpDir, '.planning', 'phases', '01-test', 'doc.md');
    fs.writeFileSync(filePath, 'See `src/utils/helper.js` for details.\n');

    const result = runGsdTools('verify references .planning/phases/01-test/doc.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.found >= 1, `Expected at least 1 found, got ${output.found}`);
  });

  test('skips backtick template expressions', () => {
    // Template expressions like ${variable} in backtick paths are skipped
    // @-refs with http are processed but not found on disk
    const filePath = path.join(tmpDir, '.planning', 'phases', '01-test', 'doc.md');
    fs.writeFileSync(filePath, '`${variable}/path/file.js`\n');

    const result = runGsdTools('verify references .planning/phases/01-test/doc.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Template expression is skipped entirely — total should be 0
    assert.strictEqual(output.total, 0, `Expected total 0 (template skipped): ${JSON.stringify(output)}`);
  });

  test('returns error for nonexistent file', () => {
    const result = runGsdTools('verify references .planning/phases/01-test/nonexistent.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error, `Expected error field: ${JSON.stringify(output)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify commits command
// ─────────────────────────────────────────────────────────────────────────────

describe('verify commits command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('validates real commit hashes', () => {
    const hash = gitOrThrow(['rev-parse', '--short', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();

    const result = runGsdTools(`verify commits ${hash}`, tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_valid, true, `Expected all_valid true: ${JSON.stringify(output)}`);
    assert.ok(output.valid.includes(hash), `Expected valid to include ${hash}: ${JSON.stringify(output.valid)}`);
  });

  test('reports invalid for fake hashes', () => {
    const result = runGsdTools('verify commits abcdef1234567', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_valid, false, `Expected all_valid false: ${JSON.stringify(output)}`);
    assert.ok(
      output.invalid.includes('abcdef1234567'),
      `Expected invalid to include "abcdef1234567": ${JSON.stringify(output.invalid)}`
    );
  });

  test('handles mixed valid and invalid hashes', () => {
    const hash = gitOrThrow(['rev-parse', '--short', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();

    const result = runGsdTools(`verify commits ${hash} abcdef1234567`, tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid.length, 1, `Expected 1 valid: ${JSON.stringify(output)}`);
    assert.strictEqual(output.invalid.length, 1, `Expected 1 invalid: ${JSON.stringify(output)}`);
    assert.strictEqual(output.all_valid, false, `Expected all_valid false: ${JSON.stringify(output)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify artifacts command
// ─────────────────────────────────────────────────────────────────────────────

describe('verify artifacts command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writePlanWithArtifacts(tmpDir, artifactsYaml) {
    // parseMustHavesBlock expects 4-space indent for block name, 6-space for items, 8-space for keys
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [src/app.js]',
      'autonomous: true',
      'must_haves:',
      '    artifacts:',
      ...artifactsYaml.map(line => `      ${line}`),
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      '  <name>Task 1: Do thing</name>',
      '  <files>src/app.js</files>',
      '  <action>Do it</action>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>Done</done>',
      '</task>',
      '</tasks>',
    ].join('\n');
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, content);
  }

  test('passes when all artifacts exist and match criteria', () => {
    writePlanWithArtifacts(tmpDir, [
      '- path: "src/app.js"',
      '  min_lines: 2',
      '  contains: "export"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'const x = 1;\nexport default x;\nconst y = 2;\n');

    const result = runGsdTools('verify artifacts .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_passed, true, `Expected all_passed true: ${JSON.stringify(output)}`);
  });

  test('reports missing artifact file', () => {
    writePlanWithArtifacts(tmpDir, [
      '- path: "src/nonexistent.js"',
    ]);

    const result = runGsdTools('verify artifacts .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_passed, false, 'Expected all_passed false');
    assert.ok(
      output.artifacts[0].issues.some(i => i.includes('File not found')),
      `Expected "File not found" in issues: ${JSON.stringify(output.artifacts[0].issues)}`
    );
  });

  test('reports insufficient line count', () => {
    writePlanWithArtifacts(tmpDir, [
      '- path: "src/app.js"',
      '  min_lines: 10',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'const x = 1;\n');

    const result = runGsdTools('verify artifacts .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_passed, false, 'Expected all_passed false');
    assert.ok(
      output.artifacts[0].issues.some(i => i.includes('Only') && i.includes('lines, need 10')),
      `Expected line count issue: ${JSON.stringify(output.artifacts[0].issues)}`
    );
  });

  test('reports missing pattern', () => {
    writePlanWithArtifacts(tmpDir, [
      '- path: "src/app.js"',
      '  contains: "module.exports"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'const x = 1;\n');

    const result = runGsdTools('verify artifacts .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_passed, false, 'Expected all_passed false');
    assert.ok(
      output.artifacts[0].issues.some(i => i.includes('Missing pattern')),
      `Expected "Missing pattern" in issues: ${JSON.stringify(output.artifacts[0].issues)}`
    );
  });

  test('reports missing export', () => {
    writePlanWithArtifacts(tmpDir, [
      '- path: "src/app.js"',
      '  exports:',
      '    - GET',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'const x = 1;\nexport const POST = () => {};\n');

    const result = runGsdTools('verify artifacts .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_passed, false, 'Expected all_passed false');
    assert.ok(
      output.artifacts[0].issues.some(i => i.includes('Missing export')),
      `Expected "Missing export" in issues: ${JSON.stringify(output.artifacts[0].issues)}`
    );
  });

  test('returns error when no artifacts in frontmatter', () => {
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [src/app.js]',
      'autonomous: true',
      'must_haves:',
      '  truths:',
      '    - "something is true"',
      '---',
      '',
      '<tasks></tasks>',
    ].join('\n');
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, content);

    const result = runGsdTools('verify artifacts .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error, `Expected error field: ${JSON.stringify(output)}`);
    assert.ok(
      output.error.includes('No must_haves.artifacts'),
      `Expected "No must_haves.artifacts" in error: ${output.error}`
    );
  });

  // A non-empty artifacts block whose items are all bare strings (prose bullets
  // with no `path:` key) is item-by-item skipped, leaving zero checked results.
  // The verdict must not read GREEN over an empty result set — mirrors the
  // positive-evidence floor at src/uat-predicate.cts (no vacuous pass). (#3956)
  test('does not report a vacuous pass for an all-string artifacts block (#3956)', () => {
    writePlanWithArtifacts(tmpDir, [
      '- login flow implemented',
      '- user can reset password',
    ]);

    const result = runGsdTools('verify artifacts .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.total, 0, `Expected zero checked artifacts: ${JSON.stringify(output)}`);
    assert.strictEqual(
      output.all_passed,
      false,
      `Expected all_passed false over a zero-check block: ${JSON.stringify(output)}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify key-links command
// ─────────────────────────────────────────────────────────────────────────────

describe('verify key-links command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writePlanWithKeyLinks(tmpDir, keyLinksYaml) {
    // parseMustHavesBlock expects 4-space indent for block name, 6-space for items, 8-space for keys
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [src/a.js]',
      'autonomous: true',
      'must_haves:',
      '    key_links:',
      ...keyLinksYaml.map(line => `      ${line}`),
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      '  <name>Task 1: Do thing</name>',
      '  <files>src/a.js</files>',
      '  <action>Do it</action>',
      '  <verify><automated>echo ok</automated></verify>',
      '  <done>Done</done>',
      '</task>',
      '</tasks>',
    ].join('\n');
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, content);
  }

  test('verifies link when pattern found in source', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/a.js"',
      '  to: "src/b.js"',
      '  pattern: "import.*b"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), "import { x } from './b';\n");
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'exports.x = 1;\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_verified, true, `Expected all_verified true: ${JSON.stringify(output)}`);
  });

  test('verifies link when pattern found in target', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/a.js"',
      '  to: "src/b.js"',
      // ADR-3473 §8.1 (#3881): a bare `\.` inside a YAML double-quoted scalar is not a
      // recognized escape sequence — `\\.` (a real backslash escaping itself, then a literal
      // dot) is the valid spelling for the same intended pattern string `exports\.targetFunc`.
      // The old hand-rolled parseMustHavesBlock never validated YAML escape rules and
      // silently accepted the invalid form; the vendored js-yaml parser correctly refuses it.
      '  pattern: "exports\\\\.targetFunc"',
    ]);
    // pattern NOT in source, but found in target
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'const x = 1;\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'exports.targetFunc = () => {};\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_verified, true, `Expected verified via target: ${JSON.stringify(output)}`);
    assert.ok(
      output.links[0].detail.includes('target'),
      `Expected detail about target: ${output.links[0].detail}`
    );
  });

  test('fails when pattern not found in source or target', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/a.js"',
      '  to: "src/b.js"',
      '  pattern: "missingPattern"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'const x = 1;\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'const y = 2;\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_verified, false, `Expected all_verified false: ${JSON.stringify(output)}`);
    assert.strictEqual(output.links[0].verified, false, 'link should not be verified');
  });

  test('verifies link without pattern using string inclusion', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/a.js"',
      '  to: "src/b.js"',
    ]);
    // source file contains the 'to' value as a string
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), "const b = require('./src/b.js');\n");
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'module.exports = {};\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_verified, true, `Expected all_verified true: ${JSON.stringify(output)}`);
    assert.ok(
      output.links[0].detail.includes('Target referenced in source'),
      `Expected "Target referenced in source" in detail: ${output.links[0].detail}`
    );
  });

  test('reports source file not found', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/nonexistent.js"',
      '  to: "src/b.js"',
      '  pattern: "something"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'module.exports = {};\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.links[0].detail.includes('Source file not found'),
      `Expected "Source file not found" in detail: ${output.links[0].detail}`
    );
  });

  test('a formerly-ReDoS-shaped pattern (nested quantifiers) is evaluated normally via RE2 (#3477)', () => {
    // Pre-RE2 this pattern was neutralized (hand-rolled screen) to avoid
    // catastrophic backtracking in the JS regex engine. RE2 (re2js) matches
    // in linear time by construction, so this is no longer a neutralization
    // case at all — the pattern is compiled and evaluated for real.
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/a.js"',
      '  to: "src/b.js"',
      '  pattern: "(a+)+$"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'a'.repeat(25) + 'b\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'module.exports = {};\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.links[0].verified, false, 'link should not be verified — subject does not end in "a"');
    assert.strictEqual(output.all_verified, false, `Expected all_verified false: ${JSON.stringify(output)}`);
    assert.strictEqual(
      output.links[0].pattern_neutralized,
      undefined,
      `RE2 evaluates this pattern normally — pattern_neutralized must be absent: ${JSON.stringify(output.links[0])}`
    );
  });

  test('a refused pattern (unsupported RE2 syntax) never reports verified: true (#3477 regression)', () => {
    // pattern: "(?!x)a" is a negative lookahead — RE2 has no backtracking
    // engine and does not support look-around, so this is refused outright
    // (neutralized: 'unsupported') rather than guessed at via a literal
    // fallback. Pre-#3477-fix, a similarly unparseable pattern neutralized to
    // a literal-escaped match that happened to match nearly any source file,
    // producing a false verified: true / all_verified: true.
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/a.js"',
      '  to: "src/b.js"',
      '  pattern: "(?!x)a"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'function f(x) { return x; }\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'module.exports = {};\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.links[0].verified, false, 'a neutralized pattern must never report verified: true');
    assert.strictEqual(output.all_verified, false, `Expected all_verified false: ${JSON.stringify(output)}`);
    assert.strictEqual(
      output.links[0].pattern_neutralized,
      'unsupported',
      `Expected pattern_neutralized: 'unsupported': ${JSON.stringify(output.links[0])}`
    );
  });

  test('returns error when no key_links in frontmatter', () => {
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [src/a.js]',
      'autonomous: true',
      'must_haves:',
      '  truths:',
      '    - "something is true"',
      '---',
      '',
      '<tasks></tasks>',
    ].join('\n');
    const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
    fs.writeFileSync(planPath, content);

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.error, `Expected error field: ${JSON.stringify(output)}`);
    assert.ok(
      output.error.includes('No must_haves.key_links'),
      `Expected "No must_haves.key_links" in error: ${output.error}`
    );
  });

  // A non-empty key_links block whose items are all bare strings (prose bullets
  // with no `from:` key) is item-by-item skipped, leaving zero checked results.
  // A pending link (a `from:` file promised by a same-or-later-wave plan) is a
  // real parsed object that IS pushed to results, so this floor keys on the
  // empty-result case only and does not disturb #1202 pending semantics. (#3956)
  test('does not report a vacuous pass for an all-string key_links block (#3956)', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- source calls the reset endpoint',
      '- token is persisted',
    ]);

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.total, 0, `Expected zero checked links: ${JSON.stringify(output)}`);
    assert.strictEqual(
      output.all_verified,
      false,
      `Expected all_verified false over a zero-check block: ${JSON.stringify(output)}`
    );
  });

  // ── #3493: path confinement — from:/to: are untrusted plan frontmatter and
  // must never be readable outside the project directory. ────────────────────

  test('from: traversal outside project is rejected — not read, per-link failure only (#3493)', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3493-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'top-secret-oracle-bait\n');
      const traversalFrom = path.relative(tmpDir, outsideFile);

      writePlanWithKeyLinks(tmpDir, [
        `- from: "${traversalFrom.split(path.sep).join('/')}"`,
        '  to: "src/b.js"',
      ]);
      fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'module.exports = {};\n');

      const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.links[0].verified, false);
      assert.strictEqual(output.links[0].path_rejected, 'from');
      assert.strictEqual(output.all_verified, false);
      // Load-bearing: pins the confinement-specific detail text. This is NOT
      // the same as asserting the secret content is absent from the JSON —
      // that assertion is tautological here (no code path ever echoes file
      // *content* into `detail`/output, confined or not — a no-pattern link
      // only ever reports whether `to:` text appears in the source, never
      // the source's own bytes), so it would pass even without the
      // path-confinement fix. This assertion, by contrast, DOES fail
      // pre-fix: without confinement the outside file is actually read, the
      // no-pattern branch falls through to "Target not referenced in
      // source", and `path_rejected` is never set at all.
      assert.strictEqual(
        output.links[0].detail,
        'Source path rejected — resolves outside the project directory',
      );
    } finally {
      cleanup(outsideDir);
    }
  });

  test('to: traversal is rejected — outside file content never read even when pattern would match it (#3493)', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3493-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'oracleMarkerXYZ\n');
      const traversalTo = path.relative(tmpDir, outsideFile);

      writePlanWithKeyLinks(tmpDir, [
        '- from: "src/a.js"',
        `  to: "${traversalTo.split(path.sep).join('/')}"`,
        '  pattern: "oracleMarkerXYZ"',
      ]);
      // Pattern deliberately absent from the (valid) source so the check must
      // fall through to the target read — proving the oracle stays closed.
      fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'const x = 1;\n');

      const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(
        output.links[0].verified,
        false,
        `Expected verified:false — a matching outside file must never flip this true: ${JSON.stringify(output.links[0])}`,
      );
      assert.strictEqual(output.links[0].path_rejected, 'to');
    } finally {
      cleanup(outsideDir);
    }
  });

  test('absolute from: path is rejected (#3493)', () => {
    const absoluteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3493-absolute-'));
    try {
      const absoluteFrom = path.join(absoluteDir, 'gsd-3493-absolute-probe.txt');
      fs.writeFileSync(absoluteFrom, 'irrelevant\n');

      writePlanWithKeyLinks(tmpDir, [
        `- from: "${absoluteFrom.split(path.sep).join('/')}"`,
        '  to: "src/b.js"',
      ]);
      fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'module.exports = {};\n');

      const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.links[0].verified, false);
      assert.strictEqual(output.links[0].path_rejected, 'from');
    } finally {
      cleanup(absoluteDir);
    }
  });

  test('a symlink inside the project pointing outside it is rejected as from: (#3493)', (t) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3493-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'top-secret-oracle-bait\n');
      const symlinkPath = path.join(tmpDir, 'src', 'linked.js');
      try {
        fs.symlinkSync(outsideFile, symlinkPath, 'file');
      } catch (error) {
        if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          t.skip('symlink creation is not available on this platform');
          return;
        }
        throw error;
      }

      writePlanWithKeyLinks(tmpDir, [
        '- from: "src/linked.js"',
        '  to: "src/b.js"',
      ]);
      fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'module.exports = {};\n');

      const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.links[0].verified, false);
      assert.strictEqual(output.links[0].path_rejected, 'from');
    } finally {
      cleanup(outsideDir);
    }
  });

  test('normal in-project from:/to: still verifies with no path_rejected field (#3493 no-regression)', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/a.js"',
      '  to: "src/b.js"',
      '  pattern: "import.*b"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), "import { x } from './b';\n");
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'exports.x = 1;\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_verified, true);
    assert.strictEqual(output.links[0].verified, true);
    assert.strictEqual(output.links[0].path_rejected, undefined);
  });

  test('a rejected first link does not abort the second, valid link (#3493 per-link failure)', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3493-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'irrelevant\n');
    const traversalFrom = path.relative(tmpDir, outsideFile);

    writePlanWithKeyLinks(tmpDir, [
      `- from: "${traversalFrom.split(path.sep).join('/')}"`,
      '  to: "src/b.js"',
      '- from: "src/a.js"',
      '  to: "src/b.js"',
      '  pattern: "import.*b"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), "import { x } from './b';\n");
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'exports.x = 1;\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.links.length, 2, `Expected both links reported: ${JSON.stringify(output.links)}`);
    assert.strictEqual(output.links[0].path_rejected, 'from');
    assert.strictEqual(output.links[0].verified, false);
    assert.strictEqual(output.links[1].path_rejected, undefined);
    assert.strictEqual(output.links[1].verified, true, `Second link must still evaluate: ${JSON.stringify(output.links[1])}`);
    assert.strictEqual(output.all_verified, false);

    cleanup(outsideDir);
  });

  test('empty from: is a malformed link, not a path-confinement rejection (#3493)', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: ""',
      '  to: "src/b.js"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'b.js'), 'module.exports = {};\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.links[0].verified, false);
    assert.strictEqual(output.links[0].path_rejected, undefined);
    assert.strictEqual(
      output.links[0].detail,
      'Source file not found (from: must be a relative file path; describe components/endpoints in via:)',
    );
  });

  test('empty to: with a non-matching pattern is a malformed link, not a path-confinement rejection (#3493)', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/a.js"',
      '  to: ""',
      '  pattern: "oracleMarkerXYZ"',
    ]);
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'const x = 1;\n');

    const result = runGsdTools('verify key-links .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.links[0].verified, false);
    assert.strictEqual(output.links[0].path_rejected, undefined);
    assert.strictEqual(
      output.links[0].detail,
      'Pattern "oracleMarkerXYZ" not found in source or target',
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-967-verify-key-links-strict-paths.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-967-verify-key-links-strict-paths (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression test for bug #967: verify key-links reads from:/to: as literal
 * relative file paths; the reference docs wrongly implied component/endpoint
 * values were valid. Fix direction: author-strict — docs corrected to match code.
 *
 * Contract pinned here:
 * 1. from: must be a relative file path; pattern: is evaluated against its content.
 * 2. from: pointing to a non-existent file → verified:false, detail "Source file not found".
 * 3. docs/reference/plan-md.md reference example uses a file path for to: (NOT /api/feed).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function writePlanWithKeyLinks(tmpDir, keyLinksYaml, opts) {
  // parseMustHavesBlock expects 4-space indent for block name, 6-space for items
  const wave = (opts && opts.wave != null) ? opts.wave : 1;
  const filesModified = (opts && opts.filesModified) ? opts.filesModified : ['src/a.js'];
  const filesModifiedYaml = filesModified.length === 1
    ? `[${filesModified[0]}]`
    : `[${filesModified.join(', ')}]`;
  const content = [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    `wave: ${wave}`,
    'depends_on: []',
    `files_modified: ${filesModifiedYaml}`,
    'autonomous: true',
    'must_haves:',
    '    key_links:',
    ...keyLinksYaml.map(line => `      ${line}`),
    '---',
    '',
    '<tasks>',
    '<task type="auto">',
    '  <name>Task 1: Do thing</name>',
    '  <files>src/a.js</files>',
    '  <action>Do it</action>',
    '  <verify><automated>echo ok</automated></verify>',
    '  <done>Done</done>',
    '</task>',
    '</tasks>',
  ].join('\n');
  const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, content);
}

/**
 * Write an additional plan file in the same phase directory with specific
 * wave + files_modified (no key_links, just declaring future artifacts).
 */
function writeCompanionPlan(tmpDir, planFileName, wave, filesModified) {
  const filesModifiedYaml = `[${filesModified.join(', ')}]`;
  const content = [
    '---',
    'phase: 01-test',
    'plan: 02',
    'type: execute',
    `wave: ${wave}`,
    'depends_on: []',
    `files_modified: ${filesModifiedYaml}`,
    'autonomous: true',
    'must_haves:',
    '    key_links: []',
    '---',
    '',
    '<tasks>',
    '<task type="auto">',
    '  <name>Task 2: Create file</name>',
    '  <files>src/b.js</files>',
    '  <action>Create it</action>',
    '  <verify><automated>echo ok</automated></verify>',
    '  <done>Done</done>',
    '</task>',
    '</tasks>',
  ].join('\n');
  const planPath = path.join(tmpDir, '.planning', 'phases', '01-test', planFileName);
  fs.writeFileSync(planPath, content);
}

describe('bug-967 verify key-links strict file-path contract', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── 1. Happy path: from: is a real file path and pattern: matches ──────────
  test('verified:true when from: is a relative file path and pattern: matches', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/component.js"',
      '  to: "src/api/feed.js"',
      '  via: "fetch in useEffect"',
      '  pattern: "fetch.*api/feed"',
    ]);
    // Create the source file containing the pattern
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'component.js'),
      "fetch('/api/feed').then(r => r.json());\n",
    );
    // Create the target file too (not strictly needed for this path, but realistic)
    fs.mkdirSync(path.join(tmpDir, 'src', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api', 'feed.js'), 'module.exports = {};\n');

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.all_verified,
      true,
      `Expected all_verified:true (file-path from: + matching pattern:). Got: ${JSON.stringify(output)}`,
    );
    assert.strictEqual(output.links[0].verified, true);
  });

  // ── 2. Contract: missing source file → verified:false, explicit detail ─────
  test('verified:false with "Source file not found" detail when from: file does not exist', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/missing-file.js"',
      '  to: "src/api/feed.js"',
      '  via: "fetch in useEffect"',
      '  pattern: "fetch.*api/feed"',
    ]);
    // Deliberately do NOT create src/missing-file.js

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.links[0].verified,
      false,
      `Expected verified:false for absent source file. Got: ${JSON.stringify(output.links[0])}`,
    );
    assert.ok(
      output.links[0].detail.includes('Source file not found'),
      `Expected detail to include "Source file not found". Got: "${output.links[0].detail}"`,
    );
  });

  // ── 3. Regression #1202: missing from: file promised by a same-wave plan → pending:true ──
  //
  // A from: file absent on disk but listed in files_modified of another plan at
  // the same wave must be reported pending:true (not verified:false) and must NOT
  // count against the all_verified gate.
  //
  // This test MUST FAIL before the fix is applied (the gate hard-fails today).
  test('pending:true and all_verified:true when from: file is promised by a same-wave plan', () => {
    // Plan under test is wave 2; it references src/future-artifact.js which does not
    // exist on disk yet.
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/future-artifact.js"',
      '  to: "src/consumer.js"',
      '  via: "requires future-artifact"',
      '  pattern: "future-artifact"',
    ], { wave: 2, filesModified: ['src/consumer.js'] });

    // A companion plan also at wave 2 declares src/future-artifact.js in files_modified
    writeCompanionPlan(tmpDir, '01-02-PLAN.md', 2, ['src/future-artifact.js']);

    // Do NOT create src/future-artifact.js on disk — it is a planned future file

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(
      out.links[0].pending,
      true,
      `Expected pending:true for a from: file promised by a same-wave plan. Got: ${JSON.stringify(out.links[0])}`,
    );
    assert.strictEqual(
      out.all_verified,
      true,
      `Expected all_verified:true (pending links should not fail the gate). Got: ${JSON.stringify(out)}`,
    );
    assert.strictEqual(
      out.links[0].verified,
      false,
      `Expected verified:false (file is not yet verified — just pending). Got: ${JSON.stringify(out.links[0])}`,
    );
  });

  // ── 4. Regression #1202: missing from: file promised by a LATER-wave plan → pending:true ──
  test('pending:true and all_verified:true when from: file is promised by a later-wave plan', () => {
    // Plan under test is wave 1; companion plan is wave 3 (later wave promises the file)
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/later-artifact.js"',
      '  to: "src/consumer.js"',
      '  via: "later wave dependency"',
    ], { wave: 1, filesModified: ['src/consumer.js'] });

    writeCompanionPlan(tmpDir, '01-02-PLAN.md', 3, ['src/later-artifact.js']);

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(
      out.links[0].pending,
      true,
      `Expected pending:true for from: file promised by a later-wave plan. Got: ${JSON.stringify(out.links[0])}`,
    );
    assert.strictEqual(
      out.all_verified,
      true,
      `Expected all_verified:true (pending links not counted against gate). Got: ${JSON.stringify(out)}`,
    );
  });

  // ── 5. Regression #1202: missing from: file NOT promised by any plan → hard failure ──
  //
  // Absence of from: file with no plan promising it must remain a genuine verified:false failure.
  test('verified:false and all_verified:false when from: file is absent and not promised by any plan', () => {
    writePlanWithKeyLinks(tmpDir, [
      '- from: "src/truly-missing.js"',
      '  to: "src/consumer.js"',
      '  via: "no plan promises this"',
    ], { wave: 1, filesModified: ['src/consumer.js'] });

    // No companion plan that promises src/truly-missing.js

    const result = runGsdTools(
      'verify key-links .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(
      out.links[0].verified,
      false,
      `Expected verified:false for absent+unpromised from: file. Got: ${JSON.stringify(out.links[0])}`,
    );
    assert.strictEqual(
      out.all_verified,
      false,
      `Expected all_verified:false (hard failure). Got: ${JSON.stringify(out)}`,
    );
    // pending must not be true
    assert.notStrictEqual(
      out.links[0].pending,
      true,
      `Expected pending not to be true for an absent+unpromised file. Got: ${JSON.stringify(out.links[0])}`,
    );
  });

  // ── 6. Doc-contract guard: reference example must use a file path for to: ──
  //
  // The old reference example had  to: "/api/feed"  (an HTTP endpoint).
  // After fix #967, to: must be a relative file path like "app/api/feed/route.ts".
  // This test reads the canonical docs file and asserts the example is consistent
  // with the strict-path contract.
  //
  // allow-test-rule: source-text-is-the-product the plan-md.md reference (see #967)
  // example IS the documented authoring surface for key_links; asserting it uses
  // a file path (not an endpoint) directly tests the documented contract.
  test('docs/reference/plan-md.md key_links example uses a relative file path for to:, not an HTTP endpoint', () => {
    // Locate plan-md.md relative to this test file's repo root
    const docPath = path.join(__dirname, '..', 'docs', 'reference', 'plan-md.md');
    assert.ok(fs.existsSync(docPath), `plan-md.md not found at ${docPath}`);
    const content = fs.readFileSync(docPath, 'utf-8'); // allow-test-rule: source-text-is-the-product the plan-md.md reference example IS the documented authoring surface for key_links; asserting it uses a file path (not an endpoint) directly tests the documented contract. (see #967)

    // Find the key_links block in the annotated example (the first YAML frontmatter fence)
    // The bad old value was:  to: "/api/feed"
    assert.ok(
      !content.includes('to: "/api/feed"'),
      'docs/reference/plan-md.md still contains the endpoint-style to: "/api/feed" — ' +
      'the reference example must use a relative file path (e.g. "app/api/feed/route.ts") ' +
      'to match the strict file-path contract.',
    );

    // Also assert the corrected example actually uses a path-like value
    // (must contain at least one '/' and not start with 'http')
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored docs/reference/plan-md.md, bounded prose, not adversarial input
    const toMatch = content.match(/key_links:[\s\S]*?to:\s*"([^"]+)"/);
    assert.ok(
      toMatch,
      'Could not find a to: field in the key_links example in plan-md.md',
    );
    const toValue = toMatch[1];
    assert.ok(
      !toValue.startsWith('/api') && !toValue.startsWith('http'),
      `to: value in the docs example looks like an HTTP endpoint: "${toValue}". ` +
      'It must be a relative file path.',
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2446-milestones-drift.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2446-milestones-drift (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2446)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for gsd-health MILESTONES.md drift detection (#2446).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const helpers = require('./helpers.cjs');

const { cmdValidateHealth } = require('../gsd-core/bin/lib/verify.cjs');

const _dirsToClean = [];
after(() => { for (const d of _dirsToClean) helpers.cleanup(d); });

function makeTempProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2446-'));
  _dirsToClean.push(dir);
  fs.mkdirSync(path.join(dir, '.planning', 'milestones'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

test('W018: warns when archived snapshot has no MILESTONES.md entry', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# P\n\n## What This Is\n\nX\n\n## Core Value\n\nY\n\n## Requirements\n\nZ\n',
    '.planning/ROADMAP.md': '# Roadmap\n',
    '.planning/STATE.md': '# State\n',
    '.planning/config.json': '{}',
    '.planning/milestones/v1.0-ROADMAP.md': '# Milestone v1.0\n',
    // No MILESTONES.md entry for v1.0
  });

  const result = cmdValidateHealth(dir, { repair: false }, false);

  const w018 = result.warnings.find(w => w.code === 'W018');
  assert.ok(w018, 'W018 warning should be emitted');
  assert.ok(w018.message.includes('v1.0'), 'warning should mention v1.0');
  assert.ok(w018.repairable, 'W018 should be marked repairable');
});

test('no W018 when all snapshots have MILESTONES.md entries', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# P\n\n## What This Is\n\nX\n\n## Core Value\n\nY\n\n## Requirements\n\nZ\n',
    '.planning/ROADMAP.md': '# Roadmap\n',
    '.planning/STATE.md': '# State\n',
    '.planning/config.json': '{}',
    '.planning/milestones/v1.0-ROADMAP.md': '# Milestone v1.0\n',
    '.planning/MILESTONES.md': '# Milestones\n\n## v1.0 My App (Shipped: 2026-01-01)\n\n---\n\n',
  });

  const result = cmdValidateHealth(dir, { repair: false }, false);

  const w018 = result.warnings.find(w => w.code === 'W018');
  assert.strictEqual(w018, undefined, 'no W018 when entries are present');
});

test('no W018 when milestones archive dir is empty', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# P\n\n## What This Is\n\nX\n\n## Core Value\n\nY\n\n## Requirements\n\nZ\n',
    '.planning/ROADMAP.md': '# Roadmap\n',
    '.planning/STATE.md': '# State\n',
    '.planning/config.json': '{}',
    // No snapshots in milestones/
  });

  const result = cmdValidateHealth(dir, { repair: false }, false);

  const w018 = result.warnings.find(w => w.code === 'W018');
  assert.strictEqual(w018, undefined, 'no W018 with empty archive dir');
});

test('--backfill synthesizes missing MILESTONES.md entry from snapshot', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# P\n\n## What This Is\n\nX\n\n## Core Value\n\nY\n\n## Requirements\n\nZ\n',
    '.planning/ROADMAP.md': '# Roadmap\n',
    '.planning/STATE.md': '# State\n',
    '.planning/config.json': '{}',
    '.planning/milestones/v1.0-ROADMAP.md': '# Milestone v1.0 First Release\n',
  });

  cmdValidateHealth(dir, { repair: true, backfill: true }, false);

  const milestonesPath = path.join(dir, '.planning', 'MILESTONES.md');
  assert.ok(fs.existsSync(milestonesPath), 'MILESTONES.md should be created');
  const content = fs.readFileSync(milestonesPath, 'utf-8');
  assert.ok(content.includes('## v1.0'), 'backfilled entry should contain v1.0');
  assert.ok(content.includes('Backfilled'), 'should note it was backfilled');
});

// Phase 11 (#3309): pre-migration, `--backfill` ALONE (without `--repair`)
// was dead code — `verify.cts:2504`'s inner backfill gate was unreachable
// because the outer `if (options['repair'] && repairs.length > 0)` gate
// already required `repair`. The migrated `applyRepairs` threads `backfill`
// as its own boolean (`repair || backfill` for `backfillMilestones`
// specifically), so `--backfill` alone now actually works — a disclosed
// latent-bug fix (design doc, "Known limits"), not a preservation
// requirement.
test('--backfill alone (without --repair) now synthesizes the missing MILESTONES.md entry', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# P\n\n## What This Is\n\nX\n\n## Core Value\n\nY\n\n## Requirements\n\nZ\n',
    '.planning/ROADMAP.md': '# Roadmap\n',
    '.planning/STATE.md': '# State\n',
    '.planning/config.json': '{}',
    '.planning/milestones/v1.0-ROADMAP.md': '# Milestone v1.0 First Release\n',
  });

  cmdValidateHealth(dir, { repair: false, backfill: true }, false);

  const milestonesPath = path.join(dir, '.planning', 'MILESTONES.md');
  assert.ok(fs.existsSync(milestonesPath), '--backfill alone should create MILESTONES.md');
  const content = fs.readFileSync(milestonesPath, 'utf-8');
  assert.ok(content.includes('## v1.0'), 'backfilled entry should contain v1.0');
  assert.ok(content.includes('Backfilled'), 'should note it was backfilled');
});

test('--backfill alone does NOT apply an unrelated NONE-risk repair (createConfig) — only backfillMilestones is gated by backfill', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# P\n\n## What This Is\n\nX\n\n## Core Value\n\nY\n\n## Requirements\n\nZ\n',
    '.planning/ROADMAP.md': '# Roadmap\n',
    '.planning/STATE.md': '# State\n',
    // No config.json — W003 (createConfig) would fire and be repairable, but
    // must NOT be applied by --backfill alone (only --repair applies it).
    '.planning/milestones/v1.0-ROADMAP.md': '# Milestone v1.0 First Release\n',
  });

  cmdValidateHealth(dir, { repair: false, backfill: true }, false);

  const configPath = path.join(dir, '.planning', 'config.json');
  assert.strictEqual(fs.existsSync(configPath), false, 'config.json must not be created by --backfill alone');
  const milestonesPath = path.join(dir, '.planning', 'MILESTONES.md');
  assert.ok(fs.existsSync(milestonesPath), '--backfill alone should still create MILESTONES.md');
});

// Phase 11 (#3309): W021 (phase_id_convention integer-prefix/milestone
// mismatch) and W026 (STATE milestone-complete vs. unstarted ROADMAP
// phases) are the split-off halves of the pre-migration 'W021' code — two
// genuinely unrelated subjects (design doc, "New codes for the two split
// subjects" section). This fixture triggers ONLY the phase_id_convention
// mismatch (W021's remaining subject) and must not also produce W026.
test('W021 (phase_id_convention mismatch) fires independently of W026 — same fixture never also emits W026', () => {
  const dir = makeTempProject({
    '.planning/PROJECT.md': '# P\n\n## What This Is\n\nX\n\n## Core Value\n\nY\n\n## Requirements\n\nZ\n',
    '.planning/ROADMAP.md': '# Roadmap\n\n## [GSD] v2.0 — Expansion\n\n### Phase 1-01: Setup\n**Goal:** g\n',
    // STATE.md status is plainly "In progress" — never "milestone complete"
    // or "archived", so W026's precondition never holds for this fixture.
    '.planning/STATE.md': '# State\n\n## Current Position\n\nPhase: 1-01\n\n**Status:** In progress\n',
    '.planning/config.json': JSON.stringify({ phase_id_convention: 'milestone-prefixed' }),
  });

  const result = cmdValidateHealth(dir, { repair: false }, false);

  const w021 = result.warnings.find(w => w.code === 'W021');
  assert.ok(w021, `expected W021 for phase 1-01 (implies v1.0) listed under v2.0: ${JSON.stringify(result.warnings)}`);
  assert.ok(
    result.warnings.every(w => w.code !== 'W026'),
    `W021 fixture must not also fire W026: ${JSON.stringify(result.warnings.map(w => w.code))}`
  );
});

test('health.md mentions --backfill flag', () => {
  const healthMd = fs.readFileSync(
    path.join(__dirname, '../gsd-core/workflows/health.md'), 'utf-8'
  );
  assert.ok(healthMd.includes('--backfill'), 'health.md should document --backfill');
  assert.ok(healthMd.includes('W018'), 'health.md should list W018 error code');
  assert.ok(healthMd.includes('backfillMilestones'), 'repair_actions should include backfillMilestones');
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-968-region-scoped-negative-grep.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-968-region-scoped-negative-grep (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product #968
// Enhancement #968: region-scoped negative gate detector + guidance docs.
// Tests the pure function scanFileWideNegativeGateConflict exported from
// verify.cjs, plus CLI integration and doc-contract assertions.

'use strict';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

// Build path to built verify.cjs
const VERIFY_CJS = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verify.cjs');

// Build paths to doc files
const PLANNER_MD = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
const ANTIPATTERNS_MD = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-antipatterns.md');
// PLAN_MD_REF removed — was unused (doc-contract cases test PLANNER_MD and ANTIPATTERNS_MD only)

// ─── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Build a minimal two-task plan fixture.
 * taskA: file=app/page.py, gateText=the verify/acceptance_criteria block, actionText=action block
 * taskB: file=app/page.py (default) or otherFile, action text
 * allowlistMarker: optional HTML comment to insert at the top
 */
function makeTwoTaskPlan({
  taskAFile = 'app/page.py',
  taskAGate = '! grep -Eq \'await .*refresh\' app/page.py',
  taskAAction = 'Refactor the factory to be synchronous.',
  taskBFile = 'app/page.py',
  taskBAction = 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
  allowlistMarker = '',
} = {}) {
  const lines = [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    `files_modified: [${taskAFile}, ${taskBFile}]`,
    'autonomous: true',
    'must_haves:',
    '  - AC1',
    '---',
    '',
    '# Test Plan',
    '',
  ];

  if (allowlistMarker) {
    lines.push(allowlistMarker, '');
  }

  // Task A: the one with the negative gate
  lines.push('<task>');
  lines.push('<name>Task A: factory refactor</name>');
  lines.push(`<files>${taskAFile}</files>`);
  lines.push(`<action>${taskAAction}</action>`);
  lines.push(`<verify><automated>${taskAGate}</automated></verify>`);
  lines.push('<done>Factory is synchronous.</done>');
  lines.push('</task>');
  lines.push('');

  // Task B: the sibling that requires the construct
  lines.push('<task>');
  lines.push('<name>Task B: reindex handler</name>');
  lines.push(`<files>${taskBFile}</files>`);
  lines.push(`<action>${taskBAction}</action>`);
  lines.push('<verify><automated>npm test</automated></verify>');
  lines.push('<done>Handler is in place.</done>');
  lines.push('</task>');

  return lines.join('\n');
}

/**
 * Build a single-task plan (no sibling).
 */
function makeSingleTaskPlan({
  taskFile = 'app/page.py',
  taskGate = '! grep -Eq \'await .*refresh\' app/page.py',
  taskAction = 'Refactor the factory to be synchronous.',
} = {}) {
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    `files_modified: [${taskFile}]`,
    'autonomous: true',
    'must_haves:',
    '  - AC1',
    '---',
    '',
    '# Test Plan',
    '',
    '<task>',
    '<name>Task A: factory refactor</name>',
    `<files>${taskFile}</files>`,
    `<action>${taskAction}</action>`,
    `<verify><automated>${taskGate}</automated></verify>`,
    '<done>Factory is synchronous.</done>',
    '</task>',
  ].join('\n');
}

// ─── Group 1: pure-function unit tests ────────────────────────────────────────

describe('scanFileWideNegativeGateConflict — pure unit tests', () => {
  let scan;

  before(() => {
    const verify = require(VERIFY_CJS);
    scan = verify.scanFileWideNegativeGateConflict;
    assert.ok(typeof scan === 'function', 'scanFileWideNegativeGateConflict must be exported');
  });

  // Case 1: basic WARN path — Task A bans PAT file-wide, Task B requires it in same file
  test('case 1 — file-wide ban + sibling requires → WARN', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(Array.isArray(result.warnings), 'must return { warnings: [] }');
    assert.ok(
      result.warnings.length >= 1,
      `expected at least 1 warning, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings[0].includes('Region-scope conflict (#968)'),
      `warning must mention Region-scope conflict (#968), got: ${result.warnings[0]}`,
    );
    assert.ok(
      result.warnings[0].includes('await .*refresh'),
      `warning must mention the PAT, got: ${result.warnings[0]}`,
    );
    assert.ok(
      result.warnings[0].includes('app/page.py'),
      `warning must mention the file, got: ${result.warnings[0]}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 2: region-scoped via sed → NO warn
  test('case 1b — entity-escaped chain: positive clause pattern must not be harvested as a file-wide ban (#3611)', () => {
    // Task A bans banned_thing file-wide (== 0) AND positively asserts
    // required_thing (-ge 1), joined by &amp;&amp;. Task B mentions only
    // required_thing. Pre-fix, the literal-only split kept the chain as ONE
    // segment: zeroCmp saw the == 0 and the harvest took BOTH patterns,
    // falsely warning that B conflicts with a file-wide ban on required_thing.
    const content = makeTwoTaskPlan({
      taskAGate: "grep -c 'banned_thing' app/page.py == 0 &amp;&amp; grep -c 'required_thing' app/page.py -ge 1",
      taskBAction: 'Introduce required_thing usage the plan asserts positively.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `a positively-asserted pattern (-ge 1) joined by &amp;&amp; must not warn as a file-wide ban, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  test('case 2 — region-scoped via sed pipe → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! sed -n '12,40p' app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `sed-piped grep is region-scoped — must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 2b: region-scoped via awk → NO warn
  test('case 2b — region-scoped via awk pipe → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! awk '/^def make_page/,/^def /' app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `awk-piped grep is region-scoped — must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 3: single task file-wide ban, no sibling → NO warn
  test('case 3 — single task, no sibling → NO warn', () => {
    const content = makeSingleTaskPlan({
      taskGate: "! grep -Eq 'await .*refresh' app/page.py",
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `single task (no sibling) must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 4: sibling requires PAT but lists a different file → NO warn
  test('case 4 — sibling lists different file → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAFile: 'app/page.py',
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBFile: 'app/other.py',
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `sibling with different file must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 5: sibling lists same file but action lacks PAT → NO warn
  test('case 5 — sibling lists same file but action lacks PAT → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls bridge.sync() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `sibling with no PAT in action must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 6: positive grep (no !) + sibling → NO warn (positive requirement, not a ban)
  test('case 6 — positive grep (no !) + sibling → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "grep -q 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `positive grep must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 7: inverted grep -v with ! + sibling → NO warn
  test('case 7 — inverted grep -vq with ! + sibling → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -vq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `inverted grep (-v) must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 8: allowlist marker present → NO warn
  test('case 8 — allowlist marker suppresses warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
      allowlistMarker: '<!-- planner-region-allow: await .*refresh -->',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `allowlist marker must suppress warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 9: one task both bans and requires same PAT in same file (no second task) → NO warn
  test('case 9 — one task bans and requires PAT (no sibling) → NO warn', () => {
    const content = makeSingleTaskPlan({
      taskGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskAction: 'Refactor to avoid await refresh, but note that bridge.refresh() is used later.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `single task (no sibling B) must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 10: count form `grep -c 'PAT' FILE == 0` + sibling → WARN
  test('case 10 — count form (grep -c PAT FILE == 0) + sibling → WARN', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "grep -c 'await .*refresh' app/page.py == 0",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `count form (grep -c ... == 0) must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 11: bracket form `[ $(grep -c PAT FILE) -eq 0 ]` + sibling → WARN
  test('case 11 — bracket form ([ $(grep -c PAT FILE) -eq 0 ]) + sibling → WARN', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "[ $(grep -c 'await .*refresh' app/page.py) -eq 0 ]",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `bracket form must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 12: CRLF variant of case 1 → WARN
  test('case 12 — CRLF line endings → WARN', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const crlfContent = content.split('\n').join('\r\n');
    const result = scan(crlfContent);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `CRLF content must still warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 13: backslash line-continuation variant → WARN
  test('case 13 — backslash line continuation → WARN', () => {
    // Build manually to control exact line continuation
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [app/page.py]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Task A: factory refactor</name>',
      '<files>app/page.py</files>',
      '<action>Refactor the factory to be synchronous.</action>',
      // Gate split across lines with backslash continuation
      "<verify><automated>! grep -Eq 'await .*refresh' \\\napp/page.py</automated></verify>",
      '<done>Factory is synchronous.</done>',
      '</task>',
      '',
      '<task>',
      '<name>Task B: reindex handler</name>',
      '<files>app/page.py</files>',
      '<action>Add a post-reindex handler that calls await bridge.refresh() to repopulate state.</action>',
      '<verify><automated>npm test</automated></verify>',
      '<done>Handler is in place.</done>',
      '</task>',
    ].join('\n');
    const result = scan(lines);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `backslash continuation must still warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 14: mixed line with positive gate AND a negative gate, sibling → WARN (on the negative only)
  test('case 14 — mixed positive+negative on one segment + sibling → WARN for negative', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "grep -c 'X' app/page.py == 1 && ! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `mixed line with negative gate + sibling must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 15: glob file arg `app/*.py` → NO warn (unresolvable path)
  test('case 15 — glob file arg → NO warn (unresolvable)', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/*.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `glob file arg must not warn (unresolvable), got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 16: invalid-regex PAT literal fallback → WARN, no exception
  test('case 16 — invalid-regex PAT → literal fallback, WARN, no exception', () => {
    // "await (refresh" — unbalanced paren, invalid regex
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await (refresh' app/page.py",
      taskBAction: 'The handler calls await (refresh on bridge to repopulate state.',
    });
    let result;
    assert.doesNotThrow(() => {
      result = scan(content);
    }, 'scan must not throw on invalid regex PAT');
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `invalid-regex PAT with literal match must warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 17: ReDoS-ish PAT (catastrophic backtracking) → no hang, no false warn.
  // The sibling action is 5000 'a's — classic ReDoS trigger if we call new RegExp('(a+)+$').
  // Proof-of-no-hang: the test runner's own timeout catches it; a hanging test fails here.
  // No timing assertion (flaky) — the linear patternRequiredIn implementation is microsecond-fast.
  test('case 17 — catastrophic ReDoS pattern is instant, no hang, no false warn', () => {
    const longAs = 'a'.repeat(5000);
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq '(a+)+$' app/page.py",
      taskBAction: `Reindex handler that processes ${longAs} records and calls bridge.refresh().`,
    });
    let result;
    assert.doesNotThrow(() => {
      result = scan(content);
    }, 'scan must not throw on ReDoS-ish PAT');
    // The literal '(a+)+$' is not present in the action text as a substring → no warn.
    // (If new RegExp were used, this test would hang before reaching this assertion.)
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `catastrophic PAT '(a+)+$' not literally in action — must not warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(Array.isArray(result.warnings), 'valid result shape');
  });

  // Case 23 (mutation-catching): cat producer = file-wide → WARN; sed producer = region-scoped → NO warn
  test('case 23a — cat pipe: ! cat app/page.py | grep -Eq PAT + sibling → WARN (file-wide via cat)', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! cat app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `cat-piped grep is file-wide — must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.valid !== false, 'valid must remain true even when #968 warns');
  });

  test('case 23b — sed pipe: ! sed -n "12,40p" app/page.py | grep -Eq PAT + sibling → NO warn (region-scoped)', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! sed -n '12,40p' app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `sed-piped grep is region-scoped — must NOT warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 24: awk region → NO warn
  test('case 24 — awk region pipe: ! awk \'/^def make_page/,/^def /\' app/page.py | grep -Eq PAT + sibling → NO warn', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! awk '/^def make_page/,/^def /' app/page.py | grep -Eq 'await .*refresh'",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `awk-piped grep is region-scoped — must NOT warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 25: basename non-over-match — different dirs, same basename → NO warn
  test('case 25 — basename non-over-match: different dirs same filename → NO warn', () => {
    // Task A bans on apps/web/config.py; Task B lists apps/admin/config.py
    // Same basename "config.py" but different dirs → must NOT warn
    const content = makeTwoTaskPlan({
      taskAFile: 'apps/web/config.py',
      taskAGate: "! grep -Eq 'await .*refresh' apps/web/config.py",
      taskBFile: 'apps/admin/config.py',
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `different dirs (apps/web/config.py vs apps/admin/config.py) — same basename but must NOT warn, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 26: extensionless known file (Dockerfile) recognized via knownFiles → WARN
  test('case 26 — extensionless known file (Dockerfile) via knownFiles → WARN', () => {
    // Task A has ! grep -Eq 'FROM scratch' Dockerfile
    // Dockerfile has no extension, so looksLikePath would miss it — but knownFiles should catch it
    // Task B lists Dockerfile in <files> and action requires 'FROM scratch'
    const content = makeTwoTaskPlan({
      taskAFile: 'Dockerfile',
      taskAGate: "! grep -Eq 'FROM scratch' Dockerfile",
      taskBFile: 'Dockerfile',
      taskBAction: 'Update the image base: FROM scratch ensures minimal surface area.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `Dockerfile (extensionless, known via <files>) should be recognized — must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.valid !== false, 'valid must remain true');
  });

  // Case 27: wildcard semantic match — patternRequiredIn handles .* correctly
  test('case 27 — wildcard semantic match: "await .*refresh" (gate) warns when action has "await bridge.refresh()"', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `patternRequiredIn must match "await .*refresh" against "await bridge.refresh()" — must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 4b: same-file positive control — sibling lists the SAME banned file + requires PAT → WARN
  // Paired with case 4: proves the no-warn in case 4 is due to the file mismatch, not a dead detector.
  test('case 4b — same-file positive control: sibling lists same file → WARN (proves case 4 no-warn is file-mismatch)', () => {
    const content = makeTwoTaskPlan({
      taskAFile: 'app/page.py',
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBFile: 'app/page.py',
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `same-file sibling must warn — proves case 4's no-warn is due to file mismatch, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 7b: non-inverted positive control — without -v the ban IS detected → WARN
  // Paired with case 7: proves the -v skip is what suppresses case 7.
  test('case 7b — non-inverted positive control: ! grep -q (no -v) + sibling → WARN (proves case 7 no-warn is -v skip)', () => {
    const content = makeTwoTaskPlan({
      taskAGate: "! grep -q 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `non-inverted ! grep -q must warn — proves the -v flag is what suppresses case 7, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 25b: basename-fallback positive — bare unqualified filename matches sibling's qualified path → WARN
  // Paired with case 25: proves the bare-name basename fallback at src ~line 525 actually fires.
  // Case 25 only proves qualified paths don't over-match; this proves the bare fallback does fire.
  test('case 25b — basename-fallback positive: bare gate file matches sibling qualified path → WARN (proves basename fallback fires)', () => {
    // Task A gate uses bare "config.py" (no directory prefix — unqualified).
    // Task B lists "apps/admin/config.py" (qualified). basename("apps/admin/config.py") === "config.py".
    // The basename fallback (line 525) should match → WARN.
    const content = makeTwoTaskPlan({
      taskAFile: 'config.py',
      taskAGate: "! grep -Eq 'await .*refresh' config.py",
      taskBFile: 'apps/admin/config.py',
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `bare gate file "config.py" must match sibling "apps/admin/config.py" via basename fallback — must warn, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 28: anchored pattern warns after ^ strip — proves anchor stripping works
  // Gate: ! grep -Eq '^FROM scratch' Dockerfile
  // Sibling B lists Dockerfile, action requires 'FROM scratch' (no anchor in prose).
  // Without anchor stripping, "^FROM scratch" would be treated as containing metacharacters
  // and fall back to literal-substring: "^FROM scratch" not in B's prose → no warn.
  // With anchor stripping, "FROM scratch" is the effective literal → found in B's prose → WARN.
  test('case 28 — anchored pattern warns: ! grep -Eq \'^FROM scratch\' Dockerfile + sibling → WARN (proves ^ strip)', () => {
    const content = makeTwoTaskPlan({
      taskAFile: 'Dockerfile',
      taskAGate: "! grep -Eq '^FROM scratch' Dockerfile",
      taskBFile: 'Dockerfile',
      taskBAction: 'Update the image base: FROM scratch ensures minimal surface area.',
    });
    const result = scan(content);
    assert.ok(
      result.warnings.filter(w => w.includes('#968')).length >= 1,
      `anchored pattern "^FROM scratch" must warn after ^ is stripped — "FROM scratch" is in sibling action, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.strictEqual(result.valid, true, '#968 is warn-only: valid must be true');
  });

  // Case 29: alternation falls back conservatively — documents the known limitation.
  // Gate: ! grep -Eq 'debug|trace' src/logger.ts
  // Sibling B lists src/logger.ts, action says "remove debug calls" (contains "debug" but NOT "debug|trace").
  // patternRequiredIn sees unhandled `|` in joined frags → literal-substring fallback on raw pattern.
  // "debug|trace" is NOT literally in B's prose → conservative NO warn.
  // This is intentional: false-negative is the safe direction for a warn-only advisory.
  test('case 29 — alternation conservative fallback: "debug|trace" → NO warn (documents alternation limitation)', () => {
    // NOTE: This is intended conservative behavior, not a bug.
    // patternRequiredIn falls back to literal-substring for patterns containing `|` (alternation),
    // because safely expanding alternation without new RegExp would require a mini-parser.
    // The literal "debug|trace" is not present verbatim in the action, so no warn fires.
    // A planner who writes `debug|trace` gets no advisory — acceptable, since a false-negative
    // is always safer than a false-positive for a warn-only gate.
    const content = makeTwoTaskPlan({
      taskAFile: 'src/logger.ts',
      taskAGate: "! grep -Eq 'debug|trace' src/logger.ts",
      taskBFile: 'src/logger.ts',
      taskBAction: 'Remove debug calls from the logger module to reduce noise.',
    });
    const result = scan(content);
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      `alternation pattern "debug|trace" must conservatively NOT warn — literal "debug|trace" not in action, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  // Case 18: empty content → no crash, no #968 warn
  test('case 18 — empty content → no crash', () => {
    let result;
    assert.doesNotThrow(() => {
      result = scan('');
    });
    assert.ok(Array.isArray(result.warnings), 'must return { warnings: [] }');
    assert.strictEqual(
      result.warnings.filter(w => w.includes('#968')).length,
      0,
      'empty content must produce no #968 warn',
    );
  });

  // Case 18b: no-task plan → no crash
  test('case 18b — no-task plan → no crash', () => {
    const content = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: []',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '# No tasks here',
    ].join('\n');
    let result;
    assert.doesNotThrow(() => {
      result = scan(content);
    });
    assert.strictEqual(result.warnings.filter(w => w.includes('#968')).length, 0);
  });
});

// ─── Group 2: end-to-end via runGsdTools ──────────────────────────────────────

describe('scanFileWideNegativeGateConflict — end-to-end via verify plan-structure', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Case 19: integration — valid stays true despite warning (warn-only)
  test('case 19 — integration: valid===true despite #968 warning', () => {
    const planContent = makeTwoTaskPlan({
      taskAGate: "! grep -Eq 'await .*refresh' app/page.py",
      taskBAction: 'Add a post-reindex handler that calls await bridge.refresh() to repopulate state.',
    });
    const planDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-01-PLAN.md'), planContent);

    const result = runGsdTools(
      'verify plan-structure .planning/phases/01-test/01-01-PLAN.md',
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.valid,
      true,
      `#968 is warn-only: valid must be true, got: ${JSON.stringify(parsed)}`,
    );
    assert.ok(
      parsed.warnings.some(w => w.includes('#968')),
      `must have a #968 warning, got: ${JSON.stringify(parsed.warnings)}`,
    );
  });
});

// ─── Group 3: doc-contract ────────────────────────────────────────────────────

describe('doc-contract: guidance prose is in place', () => {
  // Case 20: gsd-planner.md has the new guidance
  test('case 20 — gsd-planner.md contains Region-scoped negative gates + reference', () => {
    const content = fs.readFileSync(PLANNER_MD, 'utf8');
    assert.ok(
      content.includes('Region-scoped negative gates'),
      'gsd-planner.md must include "Region-scoped negative gates"',
    );
    assert.ok(
      content.includes('planner-antipatterns.md'),
      'gsd-planner.md must reference planner-antipatterns.md',
    );
  });

  // Case 21: planner-antipatterns.md has the new section
  test('case 21 — planner-antipatterns.md has ## Region-Scoped Negative Gates + examples', () => {
    const content = fs.readFileSync(ANTIPATTERNS_MD, 'utf8');
    assert.ok(
      content.includes('## Region-Scoped Negative Gates'),
      'planner-antipatterns.md must include "## Region-Scoped Negative Gates"',
    );
    assert.ok(
      content.includes('await .*refresh'),
      'planner-antipatterns.md must include the worked example pattern "await .*refresh"',
    );
    // Verify sed or awk region example is present
    const hasSedOrAwk = content.includes('sed -n') || content.includes('awk ');
    assert.ok(
      hasSedOrAwk,
      'planner-antipatterns.md must include sed-n or awk region example',
    );
  });
});

// ─── Group 4: AC3 executable proof ───────────────────────────────────────────

describe('AC3: executable proof — file-wide ban vs region-scoped simultaneously satisfiable', () => {
  test('case 22 — grep/sed proof: both gates simultaneously satisfiable', () => {
    // Check if grep and sed are available
    const grepAvail = runHook('--version', [], { interpreter: 'grep', timeoutMs: TEXT_TOOL_TIMEOUT_MS }).exitCode === 0;
    const sedAvail = runHook('--version', [], { interpreter: 'sed', timeoutMs: TEXT_TOOL_TIMEOUT_MS }).exitCode === 0 ||
                    runHook('-n', ['1p', '/dev/null'], { interpreter: 'sed', timeoutMs: TEXT_TOOL_TIMEOUT_MS }).exitCode === 0;

    if (!grepAvail || !sedAvail) {
      // Skip gracefully if tools are unavailable
      return;
    }

    // Write a temp Python file with:
    //   def make_page(): — no await refresh
    //   async def reindex_handler(): — awaits bridge.refresh()
    const tmpFile = path.join(os.tmpdir(), `gsd-968-proof-${process.pid}.py`);
    const pyContent = [
      'def make_page():',
      '    """Synchronous factory — must not block on a refresh."""',
      '    return {"title": "My Page"}',
      '',
      '',
      'async def reindex_handler():',
      '    """Post-reindex callback — must await bridge.refresh() to repopulate state."""',
      '    await bridge.refresh()',
      '    return True',
    ].join('\n');
    fs.writeFileSync(tmpFile, pyContent);

    try {
      // (a) File-wide: grep -Eq 'await .*refresh' <file> — should EXIT 0 (pattern found)
      //     This means a file-wide ban (! grep -Eq ...) WOULD FAIL
      const fileWide = runHook('-Eq', ['await .*refresh', tmpFile], { interpreter: 'grep', timeoutMs: TEXT_TOOL_TIMEOUT_MS });
      assert.strictEqual(
        fileWide.exitCode,
        0,
        'grep file-wide should find the pattern (exits 0) — proving the file-wide ban would fail',
      );

      // (b) Region-scoped (make_page only): sed extracts lines 1-3, piped to grep → pattern NOT found
      //     The factory region is clean: ban PASSES
      const makePageLines = runHook('-n', ['1,3p', tmpFile], { interpreter: 'sed', timeoutMs: TEXT_TOOL_TIMEOUT_MS });
      assert.strictEqual(makePageLines.exitCode, 0, 'sed should succeed');
      const makePageRegion = makePageLines.stdout.toString();

      // Write to a temp file and grep it
      const regionFile = path.join(os.tmpdir(), `gsd-968-region-${process.pid}.py`);
      fs.writeFileSync(regionFile, makePageRegion);
      try {
        const regionBan = runHook('-Eq', ['await .*refresh', regionFile], { interpreter: 'grep', timeoutMs: TEXT_TOOL_TIMEOUT_MS });
        assert.strictEqual(
          regionBan.exitCode,
          1,
          'grep in make_page region should NOT find pattern (exits 1) — ban PASSES in factory region',
        );

        // (c) Region-scoped (reindex_handler): grep should FIND the pattern → requirement met
        const reindexLines = runHook('-n', ['6,9p', tmpFile], { interpreter: 'sed', timeoutMs: TEXT_TOOL_TIMEOUT_MS });
        const reindexRegion = reindexLines.stdout.toString();
        const reindexFile = path.join(os.tmpdir(), `gsd-968-reindex-${process.pid}.py`);
        fs.writeFileSync(reindexFile, reindexRegion);
        try {
          const reindexCheck = runHook('-Eq', ['await .*refresh', reindexFile], { interpreter: 'grep', timeoutMs: TEXT_TOOL_TIMEOUT_MS });
          assert.strictEqual(
            reindexCheck.exitCode,
            0,
            'grep in reindex_handler region MUST find pattern (exits 0) — requirement met',
          );
        } finally {
          try { fs.unlinkSync(reindexFile); } catch { /* ignore */ }
        }
      } finally {
        try { fs.unlinkSync(regionFile); } catch { /* ignore */ }
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});
  });
}

// ─── #2572: verify-summary pure core, callable without the CLI wrapper ───────

describe('verifySummaryCore — reusable structured contract (#2572)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { after } = require('node:test');
  const { cleanup } = require('./helpers.cjs');
  const { verifySummaryCore } = require('../gsd-core/bin/lib/verify.cjs');

  const dirs = [];
  after(() => { while (dirs.length) cleanup(dirs.pop()); });

  function repo(summaryBody, extraFiles = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2572-'));
    dirs.push(dir);
    gitOrThrow(['init', '-q'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['config', 'user.email', 't@t.com'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['config', 'user.name', 'T'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    for (const [rel, body] of Object.entries(extraFiles)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    fs.writeFileSync(path.join(dir, 'SUMMARY.md'), summaryBody);
    gitOrThrow(['add', '-A'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-q', '-m', 'seed'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    return dir;
  }

  test('returns the structured contract without writing to stdout', () => {
    const dir = repo('# Summary\n\nCreated: `src/a.ts`\n', { 'src/a.ts': 'x\n' });
    const r = verifySummaryCore(dir, 'SUMMARY.md', 2);
    assert.strictEqual(typeof r, 'object');
    assert.deepStrictEqual(Object.keys(r).sort(), ['checks', 'errors', 'passed']);
    assert.strictEqual(r.checks.summary_exists, true);
    assert.strictEqual(r.passed, true);
  });

  test('reports a missing referenced file as a structured check, not a throw', () => {
    const dir = repo('# Summary\n\nCreated: `src/gone.ts`\n');
    const r = verifySummaryCore(dir, 'SUMMARY.md', 2);
    assert.strictEqual(r.passed, false);
    assert.ok(r.checks.files_created.missing.includes('src/gone.ts'),
      `expected src/gone.ts in missing, got ${JSON.stringify(r.checks.files_created)}`);
  });

  test('absent SUMMARY yields summary_exists false — never throws', () => {
    const dir = repo('# Summary\n');
    let r;
    assert.doesNotThrow(() => { r = verifySummaryCore(dir, 'nope/SUMMARY.md', 2); });
    assert.strictEqual(r.checks.summary_exists, false);
    assert.strictEqual(r.passed, false);
  });

  test('unresolvable commit hash is reported via commits_exist', () => {
    const dir = repo('# Summary\n\nCommit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
    const r = verifySummaryCore(dir, 'SUMMARY.md', 2);
    assert.strictEqual(r.checks.commits_exist, false);
    assert.ok(r.errors.some((e) => /commit/i.test(e)), `expected a commit error, got ${JSON.stringify(r.errors)}`);
  });

  // ── Blocker 1 (#2685 review): frontmatter must be stripped before extraction ──
  //
  // All three SUMMARY templates prescribe a YAML flow sequence for key-files:
  //   key-files:
  //     created: [src/auth/login.ts, src/auth/session.ts]
  // The prose pattern would otherwise capture the literal '[' as part of the
  // first path, producing a candidate that can never exist on disk — firing on
  // a healthy project built from GSD's own shipped template.

  test('#2685 B1: a template-shaped frontmatter flow sequence yields no phantom "[path" candidate', () => {
    const body = [
      '---',
      'phase: 04-auth',
      'key-files:',
      '  created: [src/auth/login.ts, src/auth/session.ts]',
      '  modified: [src/auth/session.ts]',
      'status: complete',
      '---',
      '',
      '# Phase 4 Summary',
      '',
      'Built the login flow in `src/auth/login.ts`.',
      '',
    ].join('\n');
    const dir = repo(body, { 'src/auth/login.ts': 'x\n', 'src/auth/session.ts': 'x\n' });
    const r = verifySummaryCore(dir, 'SUMMARY.md', Infinity, { checkCommits: false });
    assert.deepStrictEqual(
      r.checks.files_created.missing, [],
      `#2685 B1 FAILED: every named file exists on disk, so nothing may be reported missing. ` +
      `Got: ${JSON.stringify(r.checks.files_created)}`,
    );
    assert.ok(
      !r.checks.files_created.missing.some((f) => f.includes('[')),
      'a bracket-prefixed candidate must never reach the missing list',
    );
  });

  test('#2685 B1: the check is still ABSENT for a clean phase and PRESENT for a dirty one', () => {
    const clean = repo('# Summary\n\nBuilt `src/kept.ts` here.\n', { 'src/kept.ts': 'x\n' });
    const rc = verifySummaryCore(clean, 'SUMMARY.md', Infinity, { checkCommits: false });
    assert.strictEqual(rc.checks.files_created.checked, 1, 'the clean fixture must actually extract a candidate (not vacuously pass)');
    assert.deepStrictEqual(rc.checks.files_created.missing, [], 'clean phase must not warn');

    const dirty = repo('# Summary\n\nBuilt `src/kept.ts` and `src/never-landed.ts`.\n', { 'src/kept.ts': 'x\n' });
    const rd = verifySummaryCore(dirty, 'SUMMARY.md', Infinity, { checkCommits: false });
    assert.deepStrictEqual(
      rd.checks.files_created.missing, ['src/never-landed.ts'],
      `dirty phase must name exactly the file that never landed, got ${JSON.stringify(rd.checks.files_created.missing)}`,
    );
  });

  // ── Major 1: checkCount is the single most behavior-defining constant here ──

  test('#2685 M1: checkCount boundary — 1, 2, 3 extractable paths against the default cap', () => {
    const mk = (n) => repo('# Summary\n\n' + Array.from({ length: n }, (_, i) => `- \`src/m${i}.ts\``).join('\n') + '\n');
    assert.strictEqual(verifySummaryCore(mk(1), 'SUMMARY.md', undefined, { checkCommits: false }).checks.files_created.checked, 1);
    assert.strictEqual(verifySummaryCore(mk(2), 'SUMMARY.md', undefined, { checkCommits: false }).checks.files_created.checked, 2);
    assert.strictEqual(
      verifySummaryCore(mk(3), 'SUMMARY.md', undefined, { checkCommits: false }).checks.files_created.checked, 2,
      'the CLI default must remain capped at 2 — unchanged from before #2572',
    );
    assert.strictEqual(
      verifySummaryCore(mk(3), 'SUMMARY.md', Infinity, { checkCommits: false }).checks.files_created.checked, 3,
      'Infinity must lift the cap so an interrupted phase reports every missing file',
    );
  });

  test('#2685 M1: an interrupted phase listing 12 files of which 9 are missing reports all 9', () => {
    const refs = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const present = Object.fromEntries(refs.slice(0, 3).map((f) => [f, 'x\n']));
    const dir = repo('# Summary\n\n' + refs.map((f) => `- built \`${f}\``).join('\n') + '\n', present);

    const capped = verifySummaryCore(dir, 'SUMMARY.md', undefined, { checkCommits: false });
    assert.strictEqual(
      capped.checks.files_created.missing.length, 0,
      'precondition: at the 2-file default this real defect is invisible — that is exactly Major 1',
    );

    const all = verifySummaryCore(dir, 'SUMMARY.md', Infinity, { checkCommits: false });
    assert.strictEqual(all.checks.files_created.missing.length, 9,
      `expected all 9 missing, got ${JSON.stringify(all.checks.files_created.missing)}`);
  });

  // ── Major 3: the advisory path must spawn no git subprocesses ──

  test('#2685 M3: checkCommits:false skips hash resolution entirely', () => {
    const body = '# Summary\n\n## Task Commits\n- deadbeefdeadbeefdeadbeefdeadbeefdeadbeef initial\n';
    const dir = repo(body);
    const r = verifySummaryCore(dir, 'SUMMARY.md', Infinity, { checkCommits: false });
    assert.strictEqual(r.checks.commits_exist, false, 'commits_exist is false meaning NOT CHECKED');
    assert.deepStrictEqual(
      r.errors.filter((e) => /commit/i.test(e)), [],
      'with commit checking off, an unresolvable hash must not manufacture an error',
    );
  });

  // ── Major 4 residue: confirmed false-positive classes stay filtered ──

  test('#2685 M4: globs, bare hostnames, and traversal references are never probed', () => {
    const body = [
      '# Summary',
      '',
      // Each noise class is BACKTICKED on purpose: pattern 1 extracts any
      // backticked `<something>.<ext>`, so these genuinely reach the candidate
      // filter. An un-backticked fixture would pass vacuously.
      'Touched `src/**/*.ts` across the tree.',
      'See `docs.example.com/guide.html` for background.',
      'Also `../../../../etc/passwd` and `https://example.com/x.html`.',
      'Real file: `src/real.ts`.',
      '',
    ].join('\n');
    const dir = repo(body, { 'src/real.ts': 'x\n' });
    const r = verifySummaryCore(dir, 'SUMMARY.md', Infinity, { checkCommits: false });
    assert.strictEqual(
      r.checks.files_created.checked, 1,
      `only src/real.ts is a probeable candidate, got checked=${r.checks.files_created.checked}`,
    );
    assert.deepStrictEqual(r.checks.files_created.missing, [], 'no noise class may be reported missing');
  });

  test('#2685 minor: a dotfile directory is still a valid first segment', () => {
    const dir = repo('# Summary\n\nAdded `.github/workflows/ci.yml`.\n', { '.github/workflows/ci.yml': 'x\n' });
    const r = verifySummaryCore(dir, 'SUMMARY.md', Infinity, { checkCommits: false });
    assert.strictEqual(r.checks.files_created.checked, 1,
      '.github/... must not be mistaken for a hostname');
    assert.deepStrictEqual(r.checks.files_created.missing, []);
  });

  // ── Minor: property coverage over the extractor (it is a parser) ──

  test('#2685 property: no synthesized SUMMARY body yields a malformed candidate', () => {
    const fc = require('./helpers/fast-check-setup.cjs');
    const dir = repo('# seed\n');
    const summaryPath = path.join(dir, 'SUMMARY.md');
    fc.assert(
      fc.property(fc.string(), fc.array(fc.string(), { maxLength: 8 }), (prose, paths) => {
        const body = [
          '---',
          'key-files:',
          `  created: [${paths.join(', ')}]`,
          '---',
          '',
          prose,
          ...paths.map((p) => `- built \`${p}\``),
        ].join('\n');
        fs.writeFileSync(summaryPath, body);
        const r = verifySummaryCore(dir, 'SUMMARY.md', Infinity, { checkCommits: false });
        for (const c of r.checks.files_created.missing) {
          assert.ok(!c.includes('['), `bracket artifact leaked: ${JSON.stringify(c)}`);
          assert.ok(!c.includes('*') && !c.includes('?'), `glob leaked: ${JSON.stringify(c)}`);
          assert.ok(
            path.resolve(dir, c).startsWith(path.resolve(dir) + path.sep),
            `candidate escaped the project root: ${JSON.stringify(c)}`,
          );
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2701-nul-corrupted-validators.test.cjs — test-hygiene sweep #3338 (H3 wave 6)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:issue-2701-nul-corrupted-validators", () => {
// Regression tests for #2701 — plan/summary/verification/state validators silently
// accept NUL-corrupted files and report valid:true.
//
// A NUL-corrupted text artifact is binary-classified by file(1) and silently
// OMITTED from recursive / binary-skipping search results (rg -l, grep -rI,
// exit 0), so the corruption reads downstream as "file absent" rather than
// "file corrupt." The validators must fail loud, naming the encoding problem and
// its consequence, before any schema/structure check. The fix is at the
// validator entry points (a shared textEncodingError helper in validate.cjs),
// NOT inside the broadly-shared platformReadSync read primitive.
//
// NUL bytes are written via Buffer so they survive onto disk (a string write
// would not). Cleanup via t.after(() => cleanup(tmpDir)).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { writeState } = require('./fixtures/index.cjs');

// A structurally-complete PLAN.md that passes both validators when clean.
function validPlanBody() {
  return [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [some/file.ts]',
    'autonomous: true',
    'must_haves:',
    '  truths:',
    '    - "something is true"',
    '---',
    '',
    '<tasks>',
    '',
    '<task type="auto">',
    '  <name>Task 1: Do something</name>',
    '  <files>some/file.ts</files>',
    '  <action>Do the thing</action>',
    '  <verify><automated>npx vitest run</automated></verify>',
    '  <done>Thing is done</done>',
    '</task>',
    '',
    '</tasks>',
  ].join('\n');
}

/** Write `body` to a fresh phase plan path, optionally injecting a NUL at `nulAt`. */
function writePlan(tmpDir, name, body, nulAt) {
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  const p = path.join(tmpDir, '.planning', 'phases', '01-test', name);
  let buf = Buffer.from(body, 'utf8');
  if (nulAt !== undefined) {
    buf = Buffer.concat([buf.subarray(0, nulAt), Buffer.from([0x00]), buf.subarray(nulAt)]);
  }
  fs.writeFileSync(p, buf);
  return p;
}

function parseResult(t, argv, tmpDir) {
  const r = runGsdTools(argv, tmpDir);
  assert.ok(r.success, `command failed: ${r.error}`);
  return JSON.parse(r.output);
}

// ─── frontmatter validate --schema plan|summary|verification ────────────────

describe('#2701: frontmatter validate rejects NUL-corrupted artifacts', () => {
  test('PLAN.md with an embedded NUL byte → valid:false, error names encoding + consequence', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    writePlan(tmpDir, '01-01-PLAN.md', validPlanBody(), 200);

    const out = parseResult(t, ['frontmatter', 'validate', rel, '--schema', 'plan'], tmpDir);
    assert.strictEqual(out.valid, false, `expected valid:false; got ${JSON.stringify(out)}`);
    assert.ok(Array.isArray(out.errors) && out.errors.length > 0, 'must report errors');
    const msg = out.errors.join(' ');
    assert.ok(/NUL/i.test(msg), `error must name NUL/encoding: ${msg}`);
    assert.ok(/skip|search|absent|missing/i.test(msg), `error must name the downstream consequence: ${msg}`);
  });

  test('SUMMARY.md with an embedded NUL byte → valid:false', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const dir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(dir, { recursive: true });
    const body = ['---', 'phase: 01-test', 'plan: 01', 'status: in_progress', '---', '', '# Summary', 'did the work'].join('\n');
    const buf = Buffer.concat([Buffer.from(body, 'utf8').subarray(0, 30), Buffer.from([0x00]), Buffer.from(body, 'utf8').subarray(30)]);
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), buf);

    const out = parseResult(t, ['frontmatter', 'validate', '.planning/phases/01-test/01-01-SUMMARY.md', '--schema', 'summary'], tmpDir);
    assert.strictEqual(out.valid, false);
    assert.ok(out.errors.some((e) => /NUL/i.test(e)));
  });

  test('VERIFICATION.md with an embedded NUL byte → valid:false', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const dir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(dir, { recursive: true });
    const body = ['---', 'phase: 01-test', 'plan: 01', 'status: passed', '---', '', '# Verification', 'all green'].join('\n');
    const buf = Buffer.concat([Buffer.from(body, 'utf8').subarray(0, 40), Buffer.from([0x00]), Buffer.from(body, 'utf8').subarray(40)]);
    fs.writeFileSync(path.join(dir, '01-01-VERIFICATION.md'), buf);

    const out = parseResult(t, ['frontmatter', 'validate', '.planning/phases/01-test/01-01-VERIFICATION.md', '--schema', 'verification'], tmpDir);
    assert.strictEqual(out.valid, false);
    assert.ok(out.errors.some((e) => /NUL/i.test(e)));
  });
});

// ─── verify plan-structure ──────────────────────────────────────────────────

describe('#2701: verify plan-structure rejects NUL-corrupted PLAN.md', () => {
  test('PLAN.md with an embedded NUL byte → valid:false, error names encoding', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    writePlan(tmpDir, '01-01-PLAN.md', validPlanBody(), 200);

    const out = parseResult(t, ['verify', 'plan-structure', rel], tmpDir);
    assert.strictEqual(out.valid, false, `expected valid:false; got ${JSON.stringify(out)}`);
    assert.ok(out.errors.some((e) => /NUL/i.test(e)), `error must name NUL: ${JSON.stringify(out.errors)}`);
  });
});

// ─── state validate ─────────────────────────────────────────────────────────

describe('#2701: state validate rejects NUL-corrupted STATE.md', () => {
  test('STATE.md with an embedded NUL byte → valid:false', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // createTempProject() does NOT seed STATE.md; use writeState to create one,
    // then corrupt it in place with a NUL byte (Buffer write so it survives).
    const seed = [
      '# Project',
      '',
      '## Status',
      'executing',
      '## Current Phase',
      '01 of 01',
      '## Total Plans in Phase',
      '1',
    ].join('\n');
    const statePath = writeState(tmpDir, seed);
    const body = Buffer.from(seed, 'utf8');
    const buf = Buffer.concat([body.subarray(0, 50), Buffer.from([0x00]), body.subarray(50)]);
    fs.writeFileSync(statePath, buf);

    const out = parseResult(t, ['state', 'validate'], tmpDir);
    assert.strictEqual(out.valid, false, `expected valid:false; got ${JSON.stringify(out)}`);
    // `state validate` (Phase 12 migration) emits coded warning objects
    // ({code, severity, message, remedy}), not bare strings — assert on the
    // code as the primary check, with a message substring as a secondary,
    // human-readable confirmation.
    assert.ok(
      out.warnings.some((w) => w.code === 'S001'),
      `warning must carry code S001: ${JSON.stringify(out.warnings)}`,
    );
    assert.ok(
      out.warnings.some((w) => /NUL/i.test(w.message)),
      `warning must name NUL: ${JSON.stringify(out.warnings)}`,
    );
  });
});

// ─── negative space: clean files still pass; non-ASCII UTF-8 not over-rejected ─

describe('#2701: clean and valid-UTF-8 files are not over-rejected', () => {
  test('clean PLAN.md (no NUL) → frontmatter validate valid:true', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    writePlan(tmpDir, '01-01-PLAN.md', validPlanBody());

    const out = parseResult(t, ['frontmatter', 'validate', rel, '--schema', 'plan'], tmpDir);
    assert.strictEqual(out.valid, true, `clean plan must pass; got ${JSON.stringify(out)}`);
  });

  test('clean PLAN.md (no NUL) → verify plan-structure valid:true', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    writePlan(tmpDir, '01-01-PLAN.md', validPlanBody());

    const out = parseResult(t, ['verify', 'plan-structure', rel], tmpDir);
    assert.strictEqual(out.valid, true, `clean plan must pass; got ${JSON.stringify(out)}`);
  });

  test('non-ASCII UTF-8 (é, emoji) without NUL is NOT rejected', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = '.planning/phases/01-test/01-01-PLAN.md';
    // High bytes are valid UTF-8; only a NUL (0x00) is the corruption signal.
    const body = validPlanBody().replace('Do the thing', 'Do the thing — café ☕ naïve');
    writePlan(tmpDir, '01-01-PLAN.md', body);

    const out = parseResult(t, ['frontmatter', 'validate', rel, '--schema', 'plan'], tmpDir);
    assert.strictEqual(out.valid, true, `valid UTF-8 high bytes must not be rejected; got ${JSON.stringify(out)}`);
  });
});

// ─── boundary: NUL at offset 0 and mid-file both rejected ───────────────────

describe('#2701: NUL position does not matter (start and middle both rejected)', () => {
  for (const nulAt of [0, 5, 250]) {
    test(`NUL at offset ${nulAt} → frontmatter validate valid:false`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const rel = '.planning/phases/01-test/01-01-PLAN.md';
      writePlan(tmpDir, '01-01-PLAN.md', validPlanBody(), nulAt);

      const out = parseResult(t, ['frontmatter', 'validate', rel, '--schema', 'plan'], tmpDir);
      assert.strictEqual(out.valid, false, `NUL at offset ${nulAt} must be rejected; got ${JSON.stringify(out)}`);
    });
  }
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-429-comment-text-gate.test.cjs — test-hygiene sweep #3338 (H3 wave 6)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:issue-429-comment-text-gate", () => {
// allow-test-rule: source-text-is-the-product (#3338)
// Issue #429: the gate logic is tested behaviorally via the exported pure
// function + runGsdTools; the discipline rule + allowlist escape hatch are
// asserted against the agent/reference .md whose text IS the deployed contract.

'use strict';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

// Build path to built verify.cjs
const VERIFY_CJS = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verify.cjs');

// fast-check: loaded at top level so skip flags evaluate correctly
let fc;
try { fc = require('fast-check'); } catch { fc = null; }
// Build path to agent/reference files
const PLANNER_MD = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
const ANTIPATTERNS_MD = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-antipatterns.md');

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makePlan({ negativeGrep, actionEcho, allowlistMarker, positiveGrep } = {}) {
  const lines = [
    '---',
    'phase: 01-test',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [src/animal-detail.tsx]',
    'autonomous: true',
    'must_haves:',
    '  - AC1',
    '---',
    '',
    '# Test Plan',
    '',
  ];

  if (allowlistMarker) {
    lines.push(allowlistMarker, '');
  }

  lines.push('<task>');
  lines.push('<name>Test task</name>');
  lines.push('<action>');
  if (actionEcho) {
    lines.push(actionEcho);
  } else {
    lines.push('Do the work.');
  }
  lines.push('</action>');

  if (positiveGrep) {
    lines.push(`<verify><automated>${positiveGrep}</automated></verify>`);
  } else if (negativeGrep) {
    lines.push(`<verify><automated>${negativeGrep}</automated></verify>`);
  } else {
    lines.push('<verify><automated>npm test</automated></verify>');
  }

  lines.push('<done>Task complete</done>');
  lines.push('</task>');

  return lines.join('\n');
}

// ─── Group 1: pure-function unit tests ────────────────────────────────────────

describe('scanNegativeGrepCommentEcho — pure unit tests', () => {
  let scanNegativeGrepCommentEcho;

  before(() => {
    const verify = require(VERIFY_CJS);
    scanNegativeGrepCommentEcho = verify.scanNegativeGrepCommentEcho;
  });

  test('case 1 — regression Plan 12-04: action echoes the forbidden literal', () => {
    const content = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `expected 1 error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('?from='), `error should mention ?from=, got: ${result.errors[0]}`);
  });

  test('case 2 — regression Plan 11-04: JSDoc head-comment echoes CardModalHost', () => {
    const content = makePlan({
      negativeGrep: "grep -c 'CardModalHost' file == 0",
      actionEcho: '* @see CardModalHost for the deprecated pattern.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `expected 1 error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('CardModalHost'), `error should mention CardModalHost, got: ${result.errors[0]}`);
  });

  test('case 3 — regression Plan 12-02: head-comment echoes .catch(() => null) (regex-special chars)', () => {
    const content = makePlan({
      negativeGrep: "grep -c '.catch(() => null)' file == 0",
      actionEcho: '// Old pattern: .catch(() => null)',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `expected 1 error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('.catch(() => null)'), `error should mention the literal, got: ${result.errors[0]}`);
  });

  test('case 4 — boundary: positive count gate (== 60) must NOT be flagged (AC#2)', () => {
    const content = makePlan({
      positiveGrep: "grep -c '= makeParallel(' file == 60",
      actionEcho: 'Use makeParallel() for concurrent processing.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, `positive count gate must not flag, errors: ${JSON.stringify(result.errors)}`);
  });

  test('case 5 — no echo: literal only in verify, not in action', () => {
    const content = makePlan({
      negativeGrep: "grep -c 'LEGACY_TOKEN' file == 0",
      actionEcho: 'Remove the old token handling.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, 'should be no errors');
    assert.strictEqual(result.warnings.length, 0, 'should be no warnings');
  });

  test('case 6 — allowlist marker suppresses the error', () => {
    const content = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
      allowlistMarker: '<!-- planner-discipline-allow: ?from= -->',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, `allowlist should suppress error, got: ${JSON.stringify(result.errors)}`);
  });

  test('case 7 — ambiguous unquoted bareword echo: warning not error', () => {
    const content = makePlan({
      negativeGrep: 'grep -c badToken file == 0',
      actionEcho: 'Remove badToken from codebase.',
    });
    const result = scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, `ambiguous token must not error, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.warnings.length, 1, `ambiguous token should warn once, got: ${JSON.stringify(result.warnings)}`);
    assert.ok(result.warnings[0].includes('badToken'), `warning should mention badToken, got: ${result.warnings[0]}`);
  });

  test('case 8 — negative-grep command inside an <action> does NOT self-flag', () => {
    // action tells executor to ADD the verify command — the grep itself is in the action
    // but there is no echo of selfToken outside the grep command
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Add verify command</name>',
      '<action>',
      "Add this to the CI script: grep -c 'selfToken' file == 0",
      '</action>',
      '<verify><automated>npm test</automated></verify>',
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const r = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(r.errors.length, 0, `grep command in action must not self-flag, errors: ${JSON.stringify(r.errors)}`);
  });

  test('case 9 — CRLF newlines are normalized', () => {
    const content = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
    });
    const crlfContent = content.split('\n').join('\r\n');
    const result = scanNegativeGrepCommentEcho(crlfContent);
    assert.strictEqual(result.errors.length, 1, `CRLF content should still find error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('?from='));
  });

  test('case 10 — multiple distinct echoed literals each produce their own error', () => {
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Multi literal task</name>',
      '<action>',
      "Remove tokA and tokB from the codebase.",
      '</action>',
      "<verify><automated>grep -c 'tokA' file == 0 && grep -c 'tokB' file == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 2, `expected 2 errors (one per literal), got: ${JSON.stringify(result.errors)}`);
  });

  test('case 11 — != 0 and >= 0 are NOT negative gates', () => {
    const verify = require(VERIFY_CJS);
    const content1 = makePlan({
      negativeGrep: "grep -c 'nz' file != 0",
      actionEcho: 'Ensure nz is present.',
    });
    const r1 = verify.scanNegativeGrepCommentEcho(content1);
    assert.strictEqual(r1.errors.length, 0, `!= 0 must not trigger, errors: ${JSON.stringify(r1.errors)}`);

    const content2 = makePlan({
      negativeGrep: "grep -c 'nz' file >= 0",
      actionEcho: 'Ensure nz is present.',
    });
    const r2 = verify.scanNegativeGrepCommentEcho(content2);
    assert.strictEqual(r2.errors.length, 0, `>= 0 must not trigger, errors: ${JSON.stringify(r2.errors)}`);
  });

  // ── Bug-fix regression tests (adversarial-review findings) ───────────────────

  test('case 12 — mixed positive+negative on one line: no false positive for positive gate token', () => {
    // Bug 1: mixed positive+negative greps on one physical line — presentTok is a
    // *positive* gate (== 1) and absentTok is a *negative* gate (== 0). Only absentTok
    // should be flagged; presentTok must not produce a spurious error.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Mixed gate task</name>',
      '<action>',
      'Use presentTok for the new pattern.',
      'Do not use absentTok any more.',
      '</action>',
      "<verify><automated>grep -c 'presentTok' f == 1 && grep -c 'absentTok' f == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `expected exactly 1 error (absentTok only), got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('absentTok'), `error must name absentTok, got: ${result.errors[0]}`);
    assert.ok(!result.errors[0].includes('presentTok'), `error must NOT name presentTok, got: ${result.errors[0]}`);
  });

  test('case 12b — mixed gates joined by entity-escaped &amp;&amp;: no false positive for the positive token (#3611)', () => {
    // #3611: planners emit <automated> bodies with the ampersands entity-escaped
    // (&amp;&amp;). The literal-only segment splitter did not match that spelling,
    // so the negative clause's `= 0` poisoned count-grep literals from the
    // POSITIVE clause in the same chain — a `-ge 3` literal flagged as forbidden.
    // Identical to case 12 except for the ampersand spelling.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Entity-escaped chain task</name>',
      '<action>',
      'Use presentTok for the new pattern.',
      'Do not use absentTok any more.',
      '</action>',
      "<verify><automated>test \"$(grep -c 'absentTok' f)\" = 0 &amp;&amp; test \"$(grep -c 'presentTok' f)\" -ge 3</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `expected exactly 1 error (absentTok only), got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('absentTok'), `error must name absentTok, got: ${result.errors[0]}`);
    assert.ok(!result.errors[0].includes('presentTok'), `a positively-asserted literal (-ge 3) must never be flagged regardless of ampersand spelling, got: ${result.errors[0]}`);
  });

  test('case 12c — entity-escaped literals and action echoes decode consistently (#3611)', () => {
    // A literal that itself contains &amp; (e.g. "a&amp;b" as the grep pattern)
    // and an action echo carrying the same entity spelling must still match
    // after the decode — the flag stays correct for entity-bearing literals.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Entity literal task</name>',
      '<action>',
      'Remove the old a&amp;b join.',
      '</action>',
      "<verify><automated>grep -c 'a&amp;b' f == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `the entity-bearing literal must still flag its action echo, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('a&b'), `error must carry the decoded literal a&b, got: ${result.errors[0]}`);
  });

  test('case 12d — a quoted literal CONTAINING && is not shattered by the segment split (#3611 review)', () => {
    // A negative grep banning a boolean shape (`grep -c 'a&&b' f == 0`) and an
    // action echo mentioning a&&b. The split must be quote-aware: splitting on
    // the operator inside the quotes would destroy the literal and silently
    // disarm the gate — exactly the plans that spell patterns with ampersands.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Quoted operator literal task</name>',
      '<action>',
      'Remove the a&&b join.',
      '</action>',
      "<verify><automated>grep -c 'a&&b' f == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `the quoted a&&b literal must still flag its action echo, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('a&&b'), `error must carry the intact literal, got: ${result.errors[0]}`);
  });

  test('case 13 — grep -c -F (separate count+fixed flags) extracts literal', () => {
    // Bug 2: grep -c -F 'LIT' was not extracted by the old regex that required -c
    // immediately before the pattern without intervening flags.
    const verify = require(VERIFY_CJS);
    const content = makePlan({
      negativeGrep: "grep -c -F '.catch(() => null)' f == 0",
      actionEcho: '// Old pattern: .catch(() => null)',
    });
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `grep -c -F must extract literal, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('.catch(() => null)'), `error must name the literal, got: ${result.errors[0]}`);
  });

  test('case 14 — grep -F -c (reversed flag order) extracts literal', () => {
    // Bug 2: grep -F -c 'LIT' — count flag not in the first position after grep.
    const verify = require(VERIFY_CJS);
    const content = makePlan({
      negativeGrep: "grep -F -c 'CardModalHost' f == 0",
      actionEcho: '* @see CardModalHost for the deprecated pattern.',
    });
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `grep -F -c must extract literal, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('CardModalHost'), `error must name CardModalHost, got: ${result.errors[0]}`);
  });

  test('case 15 — grep --count (long option) extracts literal', () => {
    // Bug 2: grep --count 'LIT' was not matched by the old -c pattern.
    const verify = require(VERIFY_CJS);
    const content = makePlan({
      negativeGrep: "grep --count 'longCountTok' f == 0",
      actionEcho: 'Remove longCountTok from the codebase.',
    });
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, `grep --count must extract literal, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('longCountTok'), `error must name longCountTok, got: ${result.errors[0]}`);
  });

  test('case 16 — same-line command span stripped but prose echo on same line is still caught', () => {
    // Bug 3: the old code filtered entire lines; a line with a pasted grep command AND
    // a prose echo would be dropped, silencing the error. Only the command SPAN should
    // be stripped; prose on the same line that echoes the token must still be detected.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Span strip task</name>',
      '<action>',
      // Single line: pasted command PLUS a prose mention of spanTok outside the command
      "Run grep -c 'spanTok' f == 0 to confirm; note spanTok must be gone.",
      '</action>',
      "<verify><automated>grep -c 'spanTok' f == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `prose echo outside command span must still be caught, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('spanTok'), `error must name spanTok, got: ${result.errors[0]}`);
  });

  test('case 17 — command-only action (no prose echo) still does NOT self-flag', () => {
    // Bug 3 regression guard: when the ONLY occurrence of the token in an action is
    // inside the grep command span itself, no error should fire.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Solo command task</name>',
      '<action>',
      "grep -c 'soloTok' file == 0",
      '</action>',
      "<verify><automated>grep -c 'soloTok' file == 0</automated></verify>",
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 0, `command-only action must not self-flag, errors: ${JSON.stringify(result.errors)}`);
  });

  test('case 18 — multi-line backslash continuation in verify command is joined and detected', () => {
    // Bug 4: a verify command split with trailing backslash was not joined, so the
    // == 0 appeared on a continuation line without the grep prefix → missed.
    const lines = [
      '---',
      'phase: 01-test',
      'plan: 01',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: [file.ts]',
      'autonomous: true',
      'must_haves:',
      '  - AC1',
      '---',
      '',
      '<task>',
      '<name>Multi-line verify task</name>',
      '<action>',
      'Remove mlTok from all modules.',
      '</action>',
      '<verify><automated>grep -c \'mlTok\' file \\\n  == 0</automated></verify>',
      '<done>Done</done>',
      '</task>',
    ].join('\n');
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(lines);
    assert.strictEqual(result.errors.length, 1, `backslash-continued verify must be detected, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors[0].includes('mlTok'), `error must name mlTok, got: ${result.errors[0]}`);
  });

  // ── (A) assignment is not a gate ──────────────────────────────────────────────

  test('case 19 — bare STATUS=0 assignment after semicolon is not a negative gate', () => {
    // grep -c '...' f > /dev/null; STATUS=0 is an assignment, not a == 0 gate.
    // deprecatedTok is echoed in the action but the verify line has no == 0 gate,
    // so no error should fire.
    const content = makePlan({
      negativeGrep: "grep -c 'deprecatedTok' src/m.ts > /dev/null; STATUS=0",
      actionEcho: 'Remove deprecatedTok from the module.',
    });
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, [
      'assignment after semicolon must not be treated as a negative gate,',
      `errors: ${JSON.stringify(result.errors)}`,
    ].join(' '));
  });

  test('case 19b — positive control: spaced == 0 IS a gate and fires when token is echoed', () => {
    // Same plan as case 19 but the verify line now uses the real == 0 gate form.
    // deprecatedTok is echoed in the action → expect exactly 1 error.
    const content = makePlan({
      negativeGrep: "grep -c 'deprecatedTok' src/m.ts == 0",
      actionEcho: 'Remove deprecatedTok from the module.',
    });
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 1, [
      'spaced == 0 gate with echoed token must produce exactly 1 error,',
      `errors: ${JSON.stringify(result.errors)}`,
    ].join(' '));
    assert.ok(result.errors[0].includes('deprecatedTok'), `error must name deprecatedTok, got: ${result.errors[0]}`);
  });

  // ── (B) inverted count is not a negative gate ─────────────────────────────────

  test('case 20 — grep -cv with == 0 is NOT a negative gate', () => {
    // -cv counts non-matching lines; "== 0" on a -cv result is a positive assertion
    // (all lines match), which is out of scope for the negative-grep gate rule.
    // invTok is echoed in the action but no error should fire.
    const content = makePlan({
      negativeGrep: "grep -cv 'invTok' file == 0",
      actionEcho: 'Ensure every line contains invTok.',
    });
    const verify = require(VERIFY_CJS);
    const result = verify.scanNegativeGrepCommentEcho(content);
    assert.strictEqual(result.errors.length, 0, [
      'grep -cv counts non-matching lines; == 0 is a positive assertion — must not flag,',
      `errors: ${JSON.stringify(result.errors)}`,
    ].join(' '));
  });
});

// ─── Group 2: end-to-end via runGsdTools ──────────────────────────────────────

describe('scanNegativeGrepCommentEcho — end-to-end via verify plan-structure', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('e2e case 1 — echoed literal causes valid:false', () => {
    const planContent = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
    });
    const planDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-01-PLAN.md'), planContent);

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false, `expected valid:false, got: ${JSON.stringify(output)}`);
    assert.ok(
      output.errors.some(e => e.includes('?from=')),
      `expected an error mentioning ?from=, got: ${JSON.stringify(output.errors)}`,
    );
  });

  test('e2e case 2 — allowlist marker causes valid:true', () => {
    const planContent = makePlan({
      negativeGrep: "grep -c '?from=' src/animal-detail.tsx == 0",
      actionEcho: 'Do NOT reintroduce the old ?from= referrer hack.',
      allowlistMarker: '<!-- planner-discipline-allow: ?from= -->',
    });
    const planDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-01-PLAN.md'), planContent);

    const result = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmpDir);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, true, `expected valid:true with allowlist, got: ${JSON.stringify(output)}`);
  });
});

// ─── Group 3: doc-contract (source-text-is-the-product) ───────────────────────

describe('doc-contract: agent/reference .md files carry the deployed contract text', () => {
  test('gsd-planner.md contains <comment_text_discipline> block', () => {
    const content = fs.readFileSync(PLANNER_MD, 'utf8');
    assert.ok(content.includes('<comment_text_discipline>'), 'gsd-planner.md must contain <comment_text_discipline>');
  });

  test('gsd-planner.md contains a usage example (<!-- planner-discipline-allow: ...)', () => {
    const content = fs.readFileSync(PLANNER_MD, 'utf8');
    assert.ok(
      content.includes('<!-- planner-discipline-allow:'),
      'gsd-planner.md must contain an HTML comment example of the allowlist syntax',
    );
  });

  test('planner-antipatterns.md contains Comment-Text Discipline section heading', () => {
    const content = fs.readFileSync(ANTIPATTERNS_MD, 'utf8');
    assert.ok(
      content.includes('Comment-Text Discipline'),
      'planner-antipatterns.md must contain a Comment-Text Discipline section',
    );
  });

  test('planner-antipatterns.md contains planner-discipline-allow: syntax', () => {
    const content = fs.readFileSync(ANTIPATTERNS_MD, 'utf8');
    assert.ok(
      content.includes('planner-discipline-allow:'),
      'planner-antipatterns.md must contain planner-discipline-allow: syntax',
    );
  });
});

// ─── Group 4: property-based (fast-check) ────────────────────────────────────

describe('property-based: scanNegativeGrepCommentEcho — fast-check', () => {
  let scanNegativeGrepCommentEcho;

  before(() => {
    const verify = require(VERIFY_CJS);
    scanNegativeGrepCommentEcho = verify.scanNegativeGrepCommentEcho;
  });

  // Two-arm property (alphanumeric literals — DEFECT.GENERATIVE-FIX parity guard):
  // both arms in one property so no stub can pass.
  // arm1: lit only in gate (no echo) → 0 errors
  // arm2: lit in gate AND echoed in action → exactly 1 error naming lit
  test('property (two-arm): gate-only → 0 errors; gate+echo → 1 error', { skip: !fc }, () => {
    if (!fc) return;
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{2,12}$/),
        (lit) => {
          const base = [
            '---',
            'phase: 01-test',
            'plan: 01',
            'type: execute',
            'wave: 1',
            'depends_on: []',
            'files_modified: [f.ts]',
            'autonomous: true',
            'must_haves:',
            '  - AC1',
            '---',
            '',
            '<task>',
            '<name>T</name>',
          ];
          const verifyLine = `<verify><automated>grep -c '${lit}' f.ts == 0</automated></verify>`;

          // arm1: no echo in action
          const arm1 = base.concat([
            '<action>Do work, not the forbidden thing.</action>',
            verifyLine,
            '<done>Done</done>',
            '</task>',
          ]).join('\n');
          const r1 = scanNegativeGrepCommentEcho(arm1);
          if (r1.errors.length !== 0) return false;

          // arm2: echo in action
          const arm2 = base.concat([
            `<action>Remove ${lit} from codebase.</action>`,
            verifyLine,
            '<done>Done</done>',
            '</task>',
          ]).join('\n');
          const r2 = scanNegativeGrepCommentEcho(arm2);
          return r2.errors.length === 1 && r2.errors[0].includes(lit);
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  // Two-arm property (regex-special literal alphabet): proves substring matching, not regex.
  // Generates literals from safe chars that include regex-special characters.
  // Same two-arm structure: gate-only → 0 errors; gate+echo → 1 error naming lit.
  test('property (two-arm, regex-special chars): gate-only → 0 errors; gate+echo → 1 error', { skip: !fc }, () => {
    if (!fc) return;
    const safeChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.()?=*+[]{}-.'.split('');
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...safeChars), { minLength: 3, maxLength: 15 }).map(a => a.join('')),
        (lit) => {
          // skip if lit contains single-quote (would break fixture shell quoting)
          if (lit.includes("'")) return true;
          const base = [
            '---',
            'phase: 01-test',
            'plan: 01',
            'type: execute',
            'wave: 1',
            'depends_on: []',
            'files_modified: [f.ts]',
            'autonomous: true',
            'must_haves:',
            '  - AC1',
            '---',
            '',
            '<task>',
            '<name>T</name>',
          ];
          const verifyLine = `<verify><automated>grep -c '${lit}' f.ts == 0</automated></verify>`;

          // arm1: no echo in action
          const arm1 = base.concat([
            '<action>Do work, not the forbidden thing.</action>',
            verifyLine,
            '<done>Done</done>',
            '</task>',
          ]).join('\n');
          const r1 = scanNegativeGrepCommentEcho(arm1);
          if (r1.errors.length !== 0) return false;

          // arm2: echo in action (wrap in prose so it is unambiguously a prose echo)
          const arm2 = base.concat([
            `<action>Remove the token ${lit} from codebase.</action>`,
            verifyLine,
            '<done>Done</done>',
            '</task>',
          ]).join('\n');
          const r2 = scanNegativeGrepCommentEcho(arm2);
          return r2.errors.length === 1 && r2.errors[0].includes(lit);
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });
});

// ─── Group 5: allowlist-syntax parity (DEFECT.GENERATIVE-FIX) ─────────────────
// Couples the documented marker syntax to runtime behaviour.
// If the marker prefix is renamed in code without updating docs (or vice versa), this
// test breaks — preventing silent drift between the two surfaces.

describe('allowlist-syntax parity: doc marker == runtime marker', () => {
  let scanNegativeGrepCommentEcho;

  before(() => {
    const verify = require(VERIFY_CJS);
    scanNegativeGrepCommentEcho = verify.scanNegativeGrepCommentEcho;
  });

  test('ALLOW_PREFIX appears in both gsd-planner.md and planner-antipatterns.md', () => {
    // allow-test-rule: source-text-is-the-product (#3338)
    const ALLOW_PREFIX = '<!-- planner-discipline-allow:';
    const plannerContent = fs.readFileSync(PLANNER_MD, 'utf8');
    const antipatternContent = fs.readFileSync(ANTIPATTERNS_MD, 'utf8');
    assert.ok(
      plannerContent.includes(ALLOW_PREFIX),
      `gsd-planner.md must contain "${ALLOW_PREFIX}"`,
    );
    assert.ok(
      antipatternContent.includes(ALLOW_PREFIX),
      `planner-antipatterns.md must contain "${ALLOW_PREFIX}"`,
    );
  });

  test('ALLOW_PREFIX gates runtime: without marker → error; with marker → 0 errors', () => {
    const ALLOW_PREFIX = '<!-- planner-discipline-allow:';

    // Without marker: parityTok is echoed in action and gated in verify → must error
    const withoutMarker = makePlan({
      negativeGrep: "grep -c 'parityTok' src/m.ts == 0",
      actionEcho: 'Remove parityTok from the module.',
    });
    const r1 = scanNegativeGrepCommentEcho(withoutMarker);
    assert.ok(r1.errors.length >= 1, [
      'expected at least 1 error without allowlist marker,',
      `got: ${JSON.stringify(r1.errors)}`,
    ].join(' '));

    // With marker: same plan but allowlist marker suppresses the error
    const withMarker = makePlan({
      negativeGrep: "grep -c 'parityTok' src/m.ts == 0",
      actionEcho: 'Remove parityTok from the module.',
      allowlistMarker: `${ALLOW_PREFIX} parityTok -->`,
    });
    const r2 = scanNegativeGrepCommentEcho(withMarker);
    assert.strictEqual(r2.errors.length, 0, [
      `allowlist marker "${ALLOW_PREFIX} parityTok -->" must suppress error,`,
      `got: ${JSON.stringify(r2.errors)}`,
    ].join(' '));
  });
});
  });
}
