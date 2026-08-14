'use strict';

/**
 * E2E content tests for plan:post hook — gap-analysis gate.
 *
 * ADR-857 phase 6 backlog: check-gap-analysis-plan-post-e2e.test.cjs
 *
 * Tests exercise:
 *   - loop render-hooks plan:post (gate discovery)
 *   - check gap-analysis.plan-post (advisory gate check)
 *
 * HARD RULES enforced here:
 *   - Every test runs a real CLI subprocess or the real resolver + real registry.
 *   - No readFileSync + .includes() source-grep on workflow files.
 *   - Asserts TYPED CONTENT (JSON fields, counts, booleans, strings).
 *   - Each test fully isolated (own fixture), cleanup in afterEach.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Write REQUIREMENTS.md with REQ-IDs in checkbox format.
 * @param {string} planningDir
 * @param {string[]} ids
 */
function writeRequirements(planningDir, ids) {
  const lines = ids.map((id, i) => `- [ ] **${id}** Requirement ${i + 1} description`);
  fs.writeFileSync(
    path.join(planningDir, 'REQUIREMENTS.md'),
    `# Requirements\n\n${lines.join('\n')}\n`
  );
}

/**
 * Write CONTEXT.md with a <decisions> block containing decisions.
 * @param {string} phaseDir
 * @param {{id: string, text: string}[]} decisions
 */
function writeContext(phaseDir, decisions) {
  const dLines = decisions.map(d => `- **${d.id}:** ${d.text}`).join('\n');
  fs.writeFileSync(
    path.join(phaseDir, 'CONTEXT.md'),
    `# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n${dLines}\n</decisions>\n`
  );
}

/**
 * Write a PLAN.md with the given body.
 * @param {string} phaseDir
 * @param {string} name  e.g. '01'
 * @param {string} body
 */
function writePlan(phaseDir, name, body) {
  fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
}

/**
 * Run loop render-hooks via spawnSync for low-level exit-code control.
 * @param {string} point
 * @param {string} cwd
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function spawnRenderHooks(point, cwd) {
  const result = spawnSync(process.execPath, [GSD_TOOLS, 'loop', 'render-hooks', point, '--raw'], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, GSD_SESSION_KEY: '', CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' },
  });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * Run check gap-analysis.plan-post via CLI with controlled args.
 * @param {string[]} extraArgs  args after 'gap-analysis.plan-post'
 * @param {string} cwd
 * @returns {{ success: boolean, output: string, error: string, exitCode: number }}
 */
function runGapCheck(extraArgs, cwd) {
  return runGsdTools(['check', 'gap-analysis.plan-post', ...extraArgs, '--raw'], cwd);
}

// ─── Section 1: render-hooks plan:post ───────────────────────────────────────

describe('render-hooks plan:post — gate discovery', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    // Initialize a valid config so schema defaults apply
    const init = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(init.success, `config-ensure-section failed: ${init.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  test('[happy] render-hooks plan:post returns gap-analysis gate hook with correct typed shape when workflow.post_planning_gaps=true (default)', () => {
    // Default config → post_planning_gaps=true (schema default)
    const r = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout);
    assert.strictEqual(envelope.point, 'plan:post');
    assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be array');
    assert.strictEqual(envelope.activeHooks.length, 1, 'exactly one active hook expected');

    const hook = envelope.activeHooks[0];
    assert.strictEqual(hook.capId, 'gap-analysis', 'capId must be gap-analysis');
    assert.strictEqual(hook.kind, 'gate', 'kind must be gate');
    assert.strictEqual(hook.blocking, false, 'blocking must be false (advisory)');
    assert.strictEqual(hook.onError, 'skip', 'onError must be skip');
    assert.strictEqual(hook.when, 'workflow.post_planning_gaps', 'when must be workflow.post_planning_gaps');
    assert.deepStrictEqual(hook.check, { query: 'gap-analysis.plan-post' }, 'check.query must be gap-analysis.plan-post');

    // rendered must mention the gate
    assert.ok(typeof envelope.rendered === 'string', 'rendered must be string');
    assert.ok(envelope.rendered.includes('gap-analysis'), 'rendered must mention gap-analysis');
    assert.ok(envelope.rendered.includes('gap-analysis.plan-post'), 'rendered must include check query');
  });

  test('[negative] render-hooks plan:post returns empty activeHooks when workflow.post_planning_gaps=false (gate deactivated)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { post_planning_gaps: false } })
    );

    const r = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout);
    assert.strictEqual(envelope.point, 'plan:post');
    // GENUINE check: must be EMPTY, not length 1
    assert.deepStrictEqual(envelope.activeHooks, [], 'activeHooks must be empty when gate disabled');
    assert.strictEqual(envelope.rendered, '_No active hooks at plan:post._',
      'rendered placeholder must match exactly when no hooks active');
  });

  test('[happy] render-hooks plan:post with explicit post_planning_gaps=true in config returns same hook as default', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { post_planning_gaps: true } })
    );

    const r = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout);
    assert.strictEqual(envelope.activeHooks.length, 1, 'exactly one hook with explicit true');
    assert.strictEqual(envelope.activeHooks[0].capId, 'gap-analysis');
    assert.strictEqual(envelope.activeHooks[0].blocking, false);
  });

  test('[bva] render-hooks plan:post envelope has exactly 3 keys (point, activeHooks, rendered) — Hyrum\'s law shape pin', () => {
    const r = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(r.status, 0, `exit non-zero: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout);
    const keys = Object.keys(envelope).sort();
    assert.deepStrictEqual(keys, ['activeHooks', 'point', 'rendered'],
      `envelope must have exactly 3 keys, got: ${keys.join(',')}`);
  });
});

// ─── Section 2: check gap-analysis.plan-post — content tests ─────────────────

describe('check gap-analysis.plan-post — gate content E2E', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const init = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(init.success, `config-ensure-section failed: ${init.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  // ── Coverage table tests ────────────────────────────────────────────────────

  test('[happy] check gap-analysis.plan-post returns block:false with coverage table when phaseDir has plans covering some REQ-IDs', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01', 'REQ-02']);
    writePlan(phaseDir, '01', '# Plan 1\n\nImplements REQ-01 only.\n');

    const r = runGapCheck([phaseDir, 'REQ-01,REQ-02'], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    // GENUINE typed field assertions
    assert.strictEqual(out.block, false, 'block must be false (gap-analysis is always advisory)');
    assert.strictEqual(out.passed, true);
    assert.strictEqual(out.enabled, true);
    assert.strictEqual(out.counts.total, 2, 'total must be 2');
    assert.strictEqual(out.counts.covered, 1, 'covered must be 1 (REQ-01 only)');
    assert.strictEqual(out.counts.uncovered, 1, 'uncovered must be 1 (REQ-02 not in plan)');

    // Table content — assert specific coverage rows
    assert.ok(out.table.includes('REQ-01'), 'table must include REQ-01');
    assert.ok(out.table.includes('REQ-02'), 'table must include REQ-02');
    assert.ok(out.table.includes('✓ Covered'), 'table must show covered row');
    assert.ok(out.table.includes('✗ Not covered'), 'table must show not-covered row');
  });

  test('[happy] check gap-analysis.plan-post returns block:false with all-covered summary when all REQ-IDs and D-IDs are in plans', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writeContext(phaseDir, [{ id: 'D-01', text: 'Use pattern X for consistency' }]);
    writePlan(phaseDir, '01', '# Plan 1\n\nImplements REQ-01 and D-01.\n');

    const r = runGapCheck([phaseDir], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.block, false);
    assert.strictEqual(out.enabled, true);
    assert.strictEqual(out.counts.total, 2, 'total must be 2 (1 req + 1 decision)');
    assert.strictEqual(out.counts.covered, 2, 'both items must be covered');
    // GENUINE: uncovered must be 0, not 1
    assert.strictEqual(out.counts.uncovered, 0, 'uncovered must be 0 when all covered');
    assert.ok(/all 2 items covered/i.test(out.summary), `summary must say "all 2 items covered", got: ${out.summary}`);
  });

  test('[empty-resolution] check gap-analysis.plan-post returns block:false with empty rows when no REQUIREMENTS.md and no CONTEXT.md exist', () => {
    // No REQUIREMENTS.md, no CONTEXT.md — only a PLAN.md
    writePlan(phaseDir, '01', '# Plan\n\nSome content.\n');

    const r = runGapCheck([phaseDir], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.block, false);
    assert.strictEqual(out.enabled, true);
    // GENUINE: total must be 0 (nothing to check)
    assert.strictEqual(out.counts.total, 0, 'total must be 0 with no requirements/decisions');
    assert.strictEqual(out.counts.uncovered, 0);
    assert.ok(/no requirements or decisions/i.test(out.summary),
      `summary must mention "no requirements or decisions", got: ${out.summary}`);
  });

  // ── Disabled gate tests ─────────────────────────────────────────────────────

  test('[negative] check gap-analysis.plan-post returns enabled:false with block:false when workflow.post_planning_gaps=false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { post_planning_gaps: false } })
    );
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writePlan(phaseDir, '01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGapCheck([phaseDir], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.block, false, 'block must be false when disabled');
    assert.strictEqual(out.passed, true);
    // GENUINE: enabled must be FALSE when gate is disabled
    assert.strictEqual(out.enabled, false, 'enabled must be false when post_planning_gaps=false');
    assert.strictEqual(out.table, '', 'table must be empty string when disabled');
    assert.ok(/disabled/i.test(out.summary), `summary must mention disabled, got: ${out.summary}`);
    assert.strictEqual(out.counts.total, 0);
  });

  // ── Missing arg tests ───────────────────────────────────────────────────────

  test('[negative] check gap-analysis.plan-post exits non-zero with error string when phaseDir argument is omitted', () => {
    // Pass only --raw, no phaseDir
    const r = runGsdTools(['check', 'gap-analysis.plan-post', '--raw'], tmpDir);
    // GENUINE: must fail, not succeed
    assert.strictEqual(r.success, false, 'must fail when phaseDir omitted');
    assert.strictEqual(r.exitCode, 1, 'exit code must be 1');
    assert.ok(r.error.includes('requires a phase-dir argument'),
      `stderr must say "requires a phase-dir argument", got: ${r.error}`);
    // Output should NOT be valid JSON (it's an error message, not JSON)
    let parsed;
    try { parsed = JSON.parse(r.output); } catch (_) { parsed = null; }
    assert.strictEqual(parsed, null, 'output must not be valid JSON when phase-dir is missing');
  });

  // ── BVA: phaseReqIds=TBD ────────────────────────────────────────────────────

  test('[bva] check gap-analysis.plan-post with phaseReqIds=TBD returns zero requirement rows but still reports CONTEXT.md decisions', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['OTHER-01', 'OTHER-02']);
    writeContext(phaseDir, [{ id: 'D-01', text: 'Use canonical pattern for this module' }]);
    writePlan(phaseDir, '01', '# Plan\n\nNo decisions addressed here.\n');

    // TBD means: skip requirements, but still report CONTEXT.md decisions
    const r = runGapCheck([phaseDir, 'TBD'], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.enabled, true);
    // GENUINE: only D-01 (from CONTEXT.md) — OTHER-01/OTHER-02 must be excluded
    assert.strictEqual(out.counts.total, 1, 'total must be 1 (only D-01 from CONTEXT.md)');
    // REQUIREMENTS.md rows must not appear
    assert.ok(!out.table.includes('OTHER-01'), 'OTHER-01 must not appear in table when phaseReqIds=TBD');
    assert.ok(!out.table.includes('OTHER-02'), 'OTHER-02 must not appear in table when phaseReqIds=TBD');
    // D-01 must appear
    assert.ok(out.table.includes('D-01'), 'D-01 from CONTEXT.md must still appear');
  });

  // ── BVA: mapped REQ-ID absent from REQUIREMENTS.md ─────────────────────────

  test('[bva] check gap-analysis.plan-post with mapped REQ-ID absent from REQUIREMENTS.md emits Missing-from-REQUIREMENTS.md status in table', () => {
    // REQUIREMENTS.md has only REQ-01, but phaseReqIds includes REQ-99 (absent)
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writePlan(phaseDir, '01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGapCheck([phaseDir, 'REQ-01,REQ-99'], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.enabled, true);
    // GENUINE: uncovered must be 1 (REQ-99 is "missing" which counts as uncovered)
    assert.strictEqual(out.counts.uncovered, 1, 'uncovered must be 1 for missing REQ-99');
    assert.strictEqual(out.counts.total, 2, 'total must be 2 (REQ-01 + REQ-99)');
    assert.ok(out.table.includes('REQ-99'), 'table must include REQ-99');
    // GENUINE: the status row for REQ-99 must say "Missing from REQUIREMENTS.md"
    assert.ok(out.table.includes('Missing from REQUIREMENTS.md'),
      `table must contain "Missing from REQUIREMENTS.md" for REQ-99, got table: ${out.table}`);
    // REQ-01 must still be covered
    assert.ok(out.table.includes('✓ Covered'), 'REQ-01 must show as covered');
  });

  // ── #3189: prose trailing a real ID list must not be reported as missing ──
  //
  // ROADMAP `**Requirements:**` lines carry prose after the ID list (locked-
  // decision annotations, ambiguity scores, prohibitions, dates). The workflow
  // passes that value verbatim into --phase-req-ids. Pre-fix, every prose word
  // was reported as an individually-missing requirement (8 real IDs became 21
  // reported uncovered in the issue). Post-fix, only ID-shaped tokens reach the
  // comparison.
  //
  // NOTE: the issue's exact reproduction uses hyphen-less `R1`..`R8`, but the
  // codebase's REQUIREMENTS.md parser (`parseRequirements`, `ID_PATTERN =
  // [A-Z][A-Z0-9]*-[A-Za-z0-9_-]+`) REQUIRES a hyphen, so `R1` is not a valid
  // REQUIREMENTS.md ID in this codebase. The `R1`..`R8` shape is covered
  // directly against `normalizePhaseReqIds` in tests/gap-checker.property.test.cjs
  // (the filter accepts hyphen-less digit-bearing IDs per the issue spec). These
  // E2E fixtures use the hyphenated `REQ-01`..`REQ-08` family so the full
  // pipeline (parseRequirements → normalizePhaseReqIds → coverage compare) is
  // exercised end-to-end; the prose annotations are the issue's verbatim.

  test('[#3189] check gap-analysis.plan-post with prose-annotated phase-req-ids drops every prose fragment, keeps only ID-shaped tokens', () => {
    // REQUIREMENTS.md defines exactly REQ-01..REQ-08 — the real requirement set.
    writeRequirements(path.join(tmpDir, '.planning'),
      ['REQ-01', 'REQ-02', 'REQ-03', 'REQ-04', 'REQ-05', 'REQ-06', 'REQ-07', 'REQ-08']);
    // The plan addresses all eight real IDs.
    writePlan(phaseDir, '01',
      '# Plan\n\nImplements REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, and REQ-08.\n');

    // The issue's prose-annotated shape, with REQ-01..REQ-08 as the ID list.
    // The trailing clause is the issue's verbatim prose (locked-decision
    // annotation, ambiguity score, prohibition range).
    const rawReqIds = 'REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08 (locked <date> — canonical source `NN-SPEC.md ## Requirements`; ambiguity 0.12; + prohibitions P1-P3)';

    const r = runGapCheck([phaseDir, rawReqIds], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    // After the #3189 shape filter, the ID-shaped tokens that survive are
    // REQ-01..REQ-08 PLUS `P1-P3` (from "prohibitions P1-P3"). `P1-P3` is
    // syntactically ID-shaped — it matches `PHASE_REQ_ID_SHAPE_RE` exactly as
    // `SEL-01` does, and the codebase's `ID_PATTERN` accepts it too, so dropping
    // it would create a false mismatch for projects using `P1-P3`-shape IDs. It
    // is NOT in REQUIREMENTS.md, so it correctly surfaces as a single "Missing
    // from REQUIREMENTS.md" ghost row.
    //
    // Pre-fix, this same input produced a report where every prose word was a
    // separate "Missing from REQUIREMENTS.md" row. Post-fix the prose noise is
    // gone: 8 covered REQ-IDs + 1 ID-shaped ghost (P1-P3).
    assert.strictEqual(out.counts.total, 9,
      `total must be 9 (REQ-01..REQ-08 + the ID-shaped P1-P3); got ${out.counts.total}. Full table:\n${out.table}`);
    assert.strictEqual(out.counts.covered, 8, 'all 8 REQ-IDs are covered by the plan');
    assert.strictEqual(out.counts.uncovered, 1, 'the one uncovered item is P1-P3 (ID-shaped ghost, not prose)');

    // The reported item set must be exactly REQ-01..REQ-08 + P1-P3.
    const reqItems = out.rows.filter(row => row.source === 'REQUIREMENTS.md').map(row => row.item);
    assert.deepStrictEqual(reqItems.sort(),
      ['P1-P3', 'REQ-01', 'REQ-02', 'REQ-03', 'REQ-04', 'REQ-05', 'REQ-06', 'REQ-07', 'REQ-08'],
      `the reported requirement items must be exactly REQ-01..REQ-08 + P1-P3; got ${JSON.stringify(reqItems)}`);

    // No prose fragment may appear anywhere in the table — these are the exact
    // fragments the issue reported as fake missing requirements.
    const proseFragments = ['—', '##', '`NN-SPEC.md', '+', '0.12;', '<date>',
      'ambiguity', 'locked', 'prohibitions', 'Requirements', 'canonical', 'source'];
    for (const frag of proseFragments) {
      assert.ok(!out.table.includes(frag),
        `prose fragment ${JSON.stringify(frag)} must NOT appear in the table. Full table:\n${out.table}`);
    }
  });

  test('[#3189] a genuinely-missing real requirement ID is still reported (no narrowing) — prose-annotated mixed list', () => {
    // REQUIREMENTS.md defines REQ-01..REQ-03 only; REQ-99 is cited in
    // phase-req-ids but absent (a real missing-requirement signal). The trailing
    // prose must be dropped, but REQ-99 (a real ID shape) must still be reported
    // as Missing — the fix must not narrow real coverage detection.
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01', 'REQ-02', 'REQ-03']);
    writePlan(phaseDir, '01', '# Plan\n\nImplements REQ-01, REQ-02, REQ-03.\n');

    const rawReqIds = 'REQ-01, REQ-02, REQ-03, REQ-99 (locked 2026-08-07 — ambiguity 0.12)';
    const r = runGapCheck([phaseDir, rawReqIds], tmpDir);
    assert.ok(r.success, `check failed: ${r.error}`);

    const out = JSON.parse(r.output);
    // GENUINE: total must be 4 — REQ-01..REQ-03 (covered) + REQ-99 (ghost). The
    // prose is dropped, but the real missing ID REQ-99 is preserved.
    assert.strictEqual(out.counts.total, 4,
      `total must be 4 (REQ-01..REQ-03 + REQ-99; prose dropped, REQ-99 preserved); got ${out.counts.total}`);
    assert.strictEqual(out.counts.uncovered, 1, 'REQ-99 is the one uncovered item');
    assert.ok(out.table.includes('REQ-99'), 'REQ-99 (real missing ID) must appear in the table');
    assert.ok(out.table.includes('Missing from REQUIREMENTS.md'),
      'REQ-99 must be flagged Missing from REQUIREMENTS.md');
    // Prose fragments still dropped.
    assert.ok(!out.table.includes('locked'), 'prose "locked" must NOT appear');
    assert.ok(!out.table.includes('ambiguity'), 'prose "ambiguity" must NOT appear');
  });
});

// ─── Section 3: Full pipeline — render-hooks → check dispatch ─────────────────

describe('Full pipeline: render-hooks plan:post discovers gate, then check dispatched', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const init = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(init.success, `config-ensure-section failed: ${init.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  test('[happy] Full pipeline: render-hooks plan:post discovers gate hook, then check dispatched with hook.check.query returns advisory table — gate never blocking', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01', 'REQ-02']);
    writePlan(phaseDir, '01', '# Plan 1\n\nImplements REQ-01 only.\n');

    // Step 1: discover the gate hook via render-hooks
    const hookResult = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(hookResult.status, 0, `render-hooks exited non-zero: ${hookResult.stderr}`);

    const envelope = JSON.parse(hookResult.stdout);
    assert.strictEqual(envelope.activeHooks.length, 1, 'must discover exactly 1 gate hook');
    const hook = envelope.activeHooks[0];

    // GENUINE: gate must be advisory (blocking=false)
    assert.strictEqual(hook.blocking, false, 'gap-analysis gate must be non-blocking');
    assert.strictEqual(hook.check.query, 'gap-analysis.plan-post', 'check.query must be gap-analysis.plan-post');

    // Step 2: dispatch the check using the discovered query
    const checkResult = runGapCheck([phaseDir], tmpDir);
    assert.ok(checkResult.success, `check failed: ${checkResult.error}`);

    const out = JSON.parse(checkResult.output);
    // GENUINE: the check result must also say block:false
    assert.strictEqual(out.block, false, 'check must return block:false (advisory gate)');
    assert.strictEqual(out.counts.uncovered, 1, 'one uncovered item: REQ-02');
    assert.ok(out.table.length > 0, 'table must be non-empty');
    assert.ok(out.table.includes('REQ-01'), 'table must show REQ-01');
    assert.ok(out.table.includes('REQ-02'), 'table must show REQ-02');
  });

  test('[happy] Full pipeline: when post_planning_gaps=true and all items covered, check returns zero uncovered', () => {
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writePlan(phaseDir, '01', '# Plan\n\nImplements REQ-01.\n');

    // Confirm hook exists via render-hooks
    const hookResult = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(hookResult.status, 0);
    const envelope = JSON.parse(hookResult.stdout);
    assert.strictEqual(envelope.activeHooks.length, 1);

    // Run the check
    const checkResult = runGapCheck([phaseDir], tmpDir);
    assert.ok(checkResult.success, `check failed: ${checkResult.error}`);
    const out = JSON.parse(checkResult.output);

    assert.strictEqual(out.block, false);
    assert.strictEqual(out.enabled, true);
    assert.strictEqual(out.counts.total, 1);
    assert.strictEqual(out.counts.covered, 1);
    assert.strictEqual(out.counts.uncovered, 0);
  });

  test('[negative] Full pipeline: when post_planning_gaps=false, render-hooks returns empty and check returns enabled:false — dual contract agreement', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { post_planning_gaps: false } })
    );
    writeRequirements(path.join(tmpDir, '.planning'), ['REQ-01']);
    writePlan(phaseDir, '01', '# Plan\n\nSome content.\n');

    // Step 1: render-hooks must return empty (gate suppressed)
    const hookResult = spawnRenderHooks('plan:post', tmpDir);
    assert.strictEqual(hookResult.status, 0);
    const envelope = JSON.parse(hookResult.stdout);
    // GENUINE: both render-hooks and check must agree on suppression
    assert.deepStrictEqual(envelope.activeHooks, [],
      'render-hooks must return empty activeHooks when gate disabled');
    assert.strictEqual(envelope.rendered, '_No active hooks at plan:post._');

    // Step 2: check must return enabled:false, confirming dual-contract agreement
    writePlan(phaseDir, '01', '# Plan\n\nSome content.\n');
    const checkResult = runGapCheck([phaseDir], tmpDir);
    assert.ok(checkResult.success, `check failed: ${checkResult.error}`);
    const out = JSON.parse(checkResult.output);
    // GENUINE: enabled must be false (both surfaces agree gate is suppressed)
    assert.strictEqual(out.enabled, false,
      'check must return enabled:false when render-hooks also shows empty — dual contract parity');
  });
});

// ─── Section 3b: issue #2316 (Secondary B) — all-unregistered ghost REQ-IDs ──
//
// runGapAnalysis's `items.length === 0` short-circuit fires BEFORE ghostReqIds
// (phaseReqIds cited by ROADMAP but absent from REQUIREMENTS.md) is folded
// into `rows`. When EVERY cited REQ-ID is a ghost, reqItems is filtered down
// to [] and there is no CONTEXT.md, so items.length === 0 and the ghost rows
// never appear — the phase reports "No requirements or decisions to check."
// instead of the ⚠ Missing from REQUIREMENTS.md rows. A phase with ONE
// unregistered ID mixed with a registered one already surfaces correctly
// (see the mapped-REQ-ID-absent test in Section 2 above) — only the
// ALL-unregistered case is broken.

describe('issue #2316 (Secondary B): all-unregistered phaseReqIds must still emit ghost rows, not the empty-state message', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const init = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(init.success, `config-ensure-section failed: ${init.error}`);
    writeRequirements(path.join(tmpDir, '.planning'), ['KNOWN-01']);
    writePlan(phaseDir, '01', '# Plan\n\nImplements KNOWN-01.\n');
  });

  afterEach(() => cleanup(tmpDir));

  test(
    '#2316-6a (control, mixed known+ghost): a phase mapping one registered and one ghost REQ-ID already surfaces the ghost row',
    () => {
      const r = runGapCheck([phaseDir, 'KNOWN-01,ORPHAN-01'], tmpDir);
      assert.ok(r.success, `check failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assert.ok(
        out.table.includes('ORPHAN-01') && out.table.includes('Missing from REQUIREMENTS.md'),
        `#2316-6a FAILED: mixed control must still list ORPHAN-01 as Missing, got table: ${out.table}`,
      );
      assert.strictEqual(out.counts.total, 2, '#2316-6a FAILED: total must count both REQ-IDs');
    },
  );

  test(
    '#2316-6b: a phase whose EVERY cited REQ-ID is unregistered must still return the ghost rows, not "No requirements or decisions to check."',
    () => {
      const r = runGapCheck([phaseDir, 'ORPHAN-01,ORPHAN-02'], tmpDir);
      assert.ok(r.success, `check failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assert.ok(
        !/No requirements or decisions to check/.test(out.table),
        `#2316-6b FAILED: all-unregistered REQ-IDs must not collapse to the empty-state message.\nFull table: ${out.table}`,
      );
      assert.ok(
        out.table.includes('ORPHAN-01') && out.table.includes('ORPHAN-02'),
        `#2316-6b FAILED: table must list both ghost REQ-IDs, got: ${out.table}`,
      );
      assert.ok(
        out.table.includes('Missing from REQUIREMENTS.md'),
        `#2316-6b FAILED: table must show "Missing from REQUIREMENTS.md" status for the ghost IDs, got: ${out.table}`,
      );
      assert.strictEqual(out.counts.total, 2, '#2316-6b FAILED: total must count both ghost REQ-IDs, not 0');
      assert.strictEqual(out.counts.uncovered, 2, '#2316-6b FAILED: uncovered must count both ghost REQ-IDs, not 0');
      assert.strictEqual(out.enabled, true, '#2316-6b FAILED: enabled must still be true');
    },
  );

  test(
    '#2334 HIGH 1: all-ghost REQ-IDs + a malformed CONTEXT.md <decisions> line (could-not-parse) must still return the ghost rows, not silently drop to the mismatch-only message',
    () => {
      // Same "items.length === 0" defect #2316-6b fixed ~34 lines below in
      // runGapAnalysis, but in the sibling `ctxExtraction.outcome ===
      // 'could-not-parse'` branch a few lines ABOVE it: that branch gated its
      // own ghost-row inclusion on the unguarded `items.length > 0`, so a
      // malformed <decisions> line made both ghost rows vanish and `total`
      // drop 2 -> 0 for the exact same all-ghost phase #2316-6b already
      // covers on the happy (non-malformed) CONTEXT.md path.
      fs.writeFileSync(
        path.join(phaseDir, 'CONTEXT.md'),
        '# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n' +
        '- **D-01 this line is malformed and has no closing bold/colon\n</decisions>\n',
      );
      const r = runGapCheck([phaseDir, 'ORPHAN-01,ORPHAN-02'], tmpDir);
      assert.ok(r.success, `check failed: ${r.error}`);
      const out = JSON.parse(r.output);
      assert.ok(
        !/No requirements or decisions to check/.test(out.table),
        `#2334 HIGH 1 FAILED: all-ghost + could-not-parse must not collapse to the empty-state message.\nFull table: ${out.table}`,
      );
      assert.ok(
        out.table.includes('ORPHAN-01') && out.table.includes('ORPHAN-02'),
        `#2334 HIGH 1 FAILED: table must still list both ghost REQ-IDs despite the malformed decisions line, got: ${out.table}`,
      );
      assert.ok(
        /format mismatch/i.test(out.table),
        `#2334 HIGH 1 FAILED: the could-not-parse signal must still be present in the table, got: ${out.table}`,
      );
      assert.strictEqual(out.counts.total, 2, '#2334 HIGH 1 FAILED: total must count both ghost REQ-IDs, not 0');
      assert.strictEqual(out.counts.uncovered, 2, '#2334 HIGH 1 FAILED: uncovered must count both ghost REQ-IDs, not 0');
    },
  );
});

// ─── Section 4: Pure resolver tests against real registry ────────────────────

describe('resolveLoopHooks plan:post — pure function against real registry', () => {
  const { resolveLoopHooks, renderLoopHooks } = require('../gsd-core/bin/lib/loop-resolver.cjs');
  const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

  test('[happy] resolveLoopHooks plan:post with post_planning_gaps=true returns one gap-analysis gate', () => {
    const result = resolveLoopHooks({
      point: 'plan:post',
      registry: realRegistry,
      config: { workflow: { post_planning_gaps: true } },
    });
    assert.strictEqual(result.point, 'plan:post');
    assert.ok(Array.isArray(result.activeHooks));
    assert.strictEqual(result.activeHooks.length, 1, 'must be exactly 1 hook with post_planning_gaps=true');
    const hook = result.activeHooks[0];
    assert.strictEqual(hook.capId, 'gap-analysis');
    assert.strictEqual(hook.kind, 'gate');
    assert.strictEqual(hook.blocking, false);
    assert.strictEqual(hook.onError, 'skip');
  });

  test('[negative] resolveLoopHooks plan:post with post_planning_gaps=false returns empty activeHooks', () => {
    const result = resolveLoopHooks({
      point: 'plan:post',
      registry: realRegistry,
      config: { workflow: { post_planning_gaps: false } },
    });
    assert.strictEqual(result.point, 'plan:post');
    // GENUINE: must be empty array (not length-1)
    assert.deepStrictEqual(result.activeHooks, [],
      'activeHooks must be empty when post_planning_gaps=false');
  });

  test('[happy] renderLoopHooks plan:post with empty activeHooks returns exact placeholder string', () => {
    const result = resolveLoopHooks({
      point: 'plan:post',
      registry: realRegistry,
      config: { workflow: { post_planning_gaps: false } },
    });
    const rendered = renderLoopHooks(result);
    // GENUINE: must be exact placeholder, not a hook string
    assert.strictEqual(rendered, '_No active hooks at plan:post._',
      'rendered must be exact placeholder when no active hooks');
  });

  test('[bva] resolveLoopHooks plan:post with absent config uses schema default (post_planning_gaps=true)', () => {
    // No workflow key in config → schema default should be true → hook active
    const result = resolveLoopHooks({
      point: 'plan:post',
      registry: realRegistry,
      config: {},
    });
    // GENUINE: schema default=true means the hook should activate even with empty config
    assert.strictEqual(result.activeHooks.length, 1,
      'schema default for post_planning_gaps is true — hook must activate with empty config');
    assert.strictEqual(result.activeHooks[0].capId, 'gap-analysis');
  });

  test('[happy] real registry byLoopPoint plan:post has 1 step (mempalace), 2 contributions (external-job planner + claude-orchestration ultraplan ownership), and 1 gate (gap-analysis)', () => {
    const entry = realRegistry.byLoopPoint['plan:post'];
    assert.ok(entry, 'plan:post must exist in byLoopPoint');
    assert.ok(Array.isArray(entry.steps), 'steps must be an array');
    assert.ok(Array.isArray(entry.contributions), 'contributions must be an array');
    assert.ok(Array.isArray(entry.gates), 'gates must be an array');
    assert.strictEqual(entry.steps.length, 1, 'plan:post must have 1 step (mempalace capture)');
    assert.strictEqual(entry.steps[0].capId, 'mempalace', 'plan:post step must be from mempalace');
    // #1143: claude-orchestration registers a plan:post contribution declaring
    // ultraplan plan-offload ownership under its runtime gate (default-off).
    assert.strictEqual(entry.contributions.length, 2, 'plan:post must have 2 contributions (external-job planner + claude-orchestration ultraplan ownership)');
    const capIds = entry.contributions.map(c => c.capId).sort();
    assert.deepStrictEqual(capIds, ['claude-orchestration', 'external-job'],
      `plan:post contributions must be external-job + claude-orchestration; got ${capIds.join(',')}`);
    assert.strictEqual(entry.gates.length, 1, 'plan:post must have exactly one gate');
    assert.strictEqual(entry.gates[0].capId, 'gap-analysis');
  });
});
