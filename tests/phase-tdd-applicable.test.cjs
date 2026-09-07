'use strict';

/**
 * Unit tests for `gsd-tools phase tdd-applicable` (#4273, Phase 1 of epic #4272).
 *
 * Matrix rows referenced below are from
 * .gsd/phase/feat-4273-tdd-applicable-query-verb/50-test-matrix.md
 */

const path = require('node:path');
const fs = require('node:fs');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

function writePlan(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

describe('phase.tdd-applicable', () => {
  test('row 9 — --cli-flag wins regardless of plan content', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', `---
type: standard
---
<task type="auto"><name>a</name></task>
`);
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath, '--cli-flag'], tmpDir);
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.applicable, true);
    assert.equal(parsed.source, 'cli_flag');
  });

  test('row 10 — plan frontmatter type: tdd, no flag', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', `---
type: tdd
---
<task type="auto"><name>a</name></task>
`);
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath], tmpDir);
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.applicable, true);
    assert.equal(parsed.source, 'plan_frontmatter');
  });

  test('row 11 — mixed-mode plan: standard plan, one tdd="true" task (the #4265 shape)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', `---
type: standard
---
<task type="auto"><name>a</name></task>
<task type="auto" tdd="true"><name>b</name></task>
`);
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath], tmpDir);
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.applicable, true);
    assert.equal(parsed.source, 'task_attribute');
  });

  test('row 12 — config.workflow.tdd_mode true, nothing else set', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', `<task type="auto"><name>a</name></task>\n`);
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ workflow: { tdd_mode: true } }), 'utf8');
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath], tmpDir);
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.applicable, true);
    assert.equal(parsed.source, 'config');
  });

  test('row 13 — nothing set: applicable false, source none', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', `<task type="auto"><name>a</name></task>\n`);
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath], tmpDir);
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.applicable, false);
    assert.equal(parsed.source, 'none');
  });

  test('row 14 — missing plan file: non-zero exit, no silent false', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const missingPath = path.join(tmpDir, '.planning', 'phases', '01-x', 'does-not-exist-PLAN.md');
    const result = runGsdTools(['query', 'phase.tdd-applicable', missingPath], tmpDir);
    assert.equal(result.success, false);
  });

  test('row 15 — missing plan-id argument: USAGE error, non-zero exit', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['query', 'phase.tdd-applicable'], tmpDir);
    assert.equal(result.success, false);
  });

  test('row 16 — independence: --cli-flag wins over type: standard', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', `---
type: standard
---
<task type="auto"><name>a</name></task>
`);
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath, '--cli-flag'], tmpDir);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.source, 'cli_flag');
  });

  test('row 17 — independence: type: tdd wins over a task with no tdd attribute (task tier never consulted)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', `---
type: tdd
---
<task type="auto"><name>a</name></task>
`);
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath], tmpDir);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.source, 'plan_frontmatter');
  });

  test('row 18 — JSON output shape names every source field', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', `<task type="auto"><name>a</name></task>\n`);
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath], tmpDir);
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.ok('applicable' in parsed);
    assert.ok('source' in parsed);
    assert.ok('plan_type' in parsed);
    assert.ok('config_tdd_mode' in parsed);
    assert.ok('cli_flag_present' in parsed);
  });

  test('row 19 — empty plan file (no frontmatter, no tasks) falls through, not an error', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const planPath = writePlan(tmpDir, '.planning/phases/01-x/01-PLAN.md', '');
    const result = runGsdTools(['query', 'phase.tdd-applicable', planPath], tmpDir);
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.applicable, false);
    assert.equal(parsed.source, 'none');
  });
});
