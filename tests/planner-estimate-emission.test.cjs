// allow-test-rule: source-text-is-the-product see #2631
// agents/gsd-planner.md, agents/gsd-plan-checker.md and docs/reference/plan-md.md — their text IS what the runtime loads and what
// the planner emits against. Per CONTRIBUTING.md exception matrix.

/**
 * Planner estimate emission + over-budget surfacing.
 *
 * Epic #1952 Phase 2 (#2631). Design lock: docs/adr/2629-phase-effort-estimation-calibration.md.
 *
 * Phase 1 (#2630) landed the estimation module and its CLI verbs deliberately
 * unconsumed. This phase wires them: the planner emits `estimate` into PLAN.md
 * frontmatter, and plan-phase surfaces the over-budget warning. These tests pin
 * the wiring so the module cannot silently go back to being dead code.
 *
 * The parity test at the bottom is the load-bearing one: the confidence
 * vocabulary appears in BOTH agent prose and the module's frozen enum, which is
 * exactly the "generative fix divergence" shape CLAUDE.md requires a parity
 * assertion for.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PLANNER = 'agents/gsd-planner.md';
const PLAN_CHECKER = 'agents/gsd-plan-checker.md';
const PLAN_MD_REF = 'docs/reference/plan-md.md';

/**
 * Extract the PLAN.md frontmatter template the planner tells agents to emit.
 *
 * The template is a bare `---`-delimited YAML block, NOT a fenced ```yaml
 * region — an earlier version of this helper looked for a fence and silently
 * matched nothing, which made every assertion below fail for the wrong reason.
 */
function plannerFrontmatterTemplate(src) {
  for (const m of src.matchAll(/^---\r?\n([\s\S]*?)^---\r?$/gm)) {
    const body = m[1];
    if (/^phase:/m.test(body) && /^must_haves:/m.test(body)) return body;
  }
  return null;
}

describe('planner emits an estimate block (AC1)', () => {
  const src = read(PLANNER);

  test('the PLAN.md frontmatter template carries an estimate block', () => {
    const tmpl = plannerFrontmatterTemplate(src);
    assert.ok(tmpl, 'could not locate the PLAN.md frontmatter template in the planner');
    assert.match(tmpl, /^estimate:/m, 'template must declare an `estimate:` block');
    for (const field of ['tokens', 'tasks', 'confidence']) {
      assert.match(tmpl, new RegExp(`^\\s+${field}:`, 'm'), `estimate block must carry \`${field}\``);
    }
  });

  test('the frontmatter field table documents estimate', () => {
    assert.match(src, /\|\s*`estimate`\s*\|/, 'field reference table must have an `estimate` row');
  });

  test('the planner is told to apply the calibration factor, not invent confidence', () => {
    assert.match(src, /estimate-calibration|calibration factor/i,
      'planner must consume the calibration surface Phase 1 exposed');
    assert.match(src, /derived|sample count/i,
      'planner must be told confidence is derived from sample count, not self-rated');
  });
});

describe('the over-budget flag is surfaced (AC2)', () => {
  // Surfaced by gsd-plan-checker, not plan-phase.md: that workflow sits ~74
  // bytes under the phase-6 capstone ratchet (94519) and cannot take new
  // content without an unrelated extraction. Dimension 5 already owns scope
  // sanity, so the estimate check belongs there.
  const src = read(PLAN_CHECKER);

  test('the checker resolves the configured smart-zone budget', () => {
    assert.match(src, /workflow\.smart_zone_tokens/,
      'must read the configured budget, not hardcode one');
  });

  test('the checker invokes the estimate-check verb', () => {
    assert.match(src, /estimate-check/,
      'the flag must be computed by the Phase 1 verb, not re-derived in prose');
  });

  test('over budget recommends splitting and is never a blocker', () => {
    assert.match(src, /re-slic|split/i, 'must recommend splitting');
    assert.match(src, /WARNING, never a blocker|never a blocker/i,
      'ADR-2629 Decision 5: the flag is advisory');
  });
});

describe('plan-checker validates the estimate (Dimension 5)', () => {
  const src = read(PLAN_CHECKER);

  test('Dimension 5 checks the emitted estimate against the budget', () => {
    const idx = src.indexOf('Dimension 5');
    assert.ok(idx !== -1, 'Dimension 5 section must exist');
    const section = src.slice(idx, idx + 2500);
    assert.match(section, /estimate/i,
      'Scope Sanity must consult the emitted estimate now that one exists');
  });
});

describe('plan-md reference documents the field', () => {
  const src = read(PLAN_MD_REF);

  test('the frontmatter field reference has an estimate row', () => {
    assert.match(src, /\|\s*`estimate`\s*\|/, 'plan-md.md must document `estimate`');
  });

  test('the row records that it is optional and additive', () => {
    const row = src.split('\n').find((l) => /\|\s*`estimate`\s*\|/.test(l));
    assert.ok(row, 'estimate row not found');
    assert.match(row, /\bNo\b/, 'estimate must be documented as NOT required (additive/optional)');
  });
});

describe('prose ↔ module parity (generative fix divergence guard)', () => {
  // The confidence vocabulary now lives in two surfaces: the frozen enum in
  // phase-estimation.cjs and the prose the planner emits against. If they
  // diverge, the planner starts writing values the parser rejects — silently,
  // because the estimate block is optional. Fail loudly instead.
  const est = require('../gsd-core/bin/lib/phase-estimation.cjs');

  test('every confidence value the planner may emit is accepted by the parser', () => {
    const tmpl = plannerFrontmatterTemplate(read(PLANNER));
    assert.ok(tmpl, 'template not found');

    const line = tmpl.split('\n').find((l) => /^\s+confidence:/.test(l));
    assert.ok(line, 'template must show the confidence field');

    // Pull every bare word on the confidence line that looks like a vocabulary
    // token (the comment enumerates the allowed values).
    const words = line.match(/\b(low|med|high)\b/g) || [];
    assert.ok(words.length > 0, 'confidence line must enumerate the allowed values');

    for (const w of words) {
      assert.ok(
        est.CONFIDENCE_VALUES.includes(w),
        `planner prose offers confidence "${w}" but the module's CONFIDENCE_VALUES does not accept it`,
      );
    }
  });

  test('the documented budget default matches the shipped manifest default', () => {
    const manifest = require('../gsd-core/bin/shared/config-defaults.manifest.json');
    const shipped = manifest.workflow.smart_zone_tokens;
    assert.ok(Number.isSafeInteger(shipped) && shipped > 0, 'manifest must ship a usable default');

    // docs/CONFIGURATION.md states the default in prose; a drifted doc silently
    // misdescribes the gate to every reader.
    const docs = read('docs/CONFIGURATION.md');
    const row = docs.split('\n').find((l) => l.includes('workflow.smart_zone_tokens'));
    assert.ok(row, 'CONFIGURATION.md must document the key');
    assert.ok(row.includes(String(shipped)),
      `CONFIGURATION.md documents a default that is not the shipped ${shipped}`);
  });
});
