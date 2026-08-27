/**
 * Quick plan:pre capability dispatch (#3778)
 *
 * Validates that /gsd-quick's Step 5 (Spawn planner) renders `plan:pre` loop
 * hooks and dispatches planner-targeted `contribution` fragments into the
 * planner prompt, mirroring the pattern already established by
 * `plan-phase.md:420-424` / `:797` for phase planning.
 *
 * Assertions run over real exported functions from
 * `scripts/gen-loop-host-contract.cjs` (`scanWiredPoints`, `scanWiredKinds`,
 * `coveredKindsInRegion`) and structurally extracted regions of quick.md —
 * never a whole-file substring/`.includes()` scan of raw Markdown. See
 * CONTRIBUTING.md "no-source-grep" testing standard.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');
const { scanWiredPoints, scanWiredKinds, coveredKindsInRegion } = require('../scripts/gen-loop-host-contract.cjs');

const QUICK_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

describe('quick workflow: plan:pre capability dispatch (#3778)', () => {
  test('quick.md wires a plan:pre render call (scanWiredPoints)', () => {
    const content = readFileNormalized(QUICK_PATH);
    const points = scanWiredPoints(content);
    assert.ok(points.has('plan:pre'), 'quick.md should render-hooks plan:pre');
  });

  test('the plan:pre dispatch text covers the contribution kind, generator parity (D-01)', () => {
    // Whole-file parity check: the same derivation `gen-loop-host-contract.cjs`
    // itself uses (REGION_CAP-bounded, last-call-site-relative). This proves
    // the generator agrees quick.md's plan:pre dispatch covers `contribution`.
    const content = readFileNormalized(QUICK_PATH);
    const kinds = scanWiredKinds(content);
    const covered = kinds.get('plan:pre');
    assert.ok(covered, 'scanWiredKinds should report a plan:pre entry');
    assert.ok(covered.has('contribution'), 'plan:pre dispatch should cover kind "contribution"');
  });

  test('the contribution kind is covered by a self-bounded dispatch slice, not neighbouring prose (cycle-1 review MEDIUM #3)', () => {
    // REGION_CAP in scanWiredKinds binds only the LAST call site in the file;
    // quick.md's plan:pre call is not last (execute:post follows it at
    // :535), so the region scanWiredKinds effectively used above runs
    // uncapped for ~13.8 KB. Bind our own slice — from the call site to the
    // first of the next bold step marker or the planner spawn — so credit
    // can only come from the dispatch paragraph itself.
    const content = readFileNormalized(QUICK_PATH);
    const callSiteIdx = content.indexOf('loop render-hooks plan:pre');
    assert.notEqual(callSiteIdx, -1, 'plan:pre call site should exist in quick.md');

    const stepMarkerRe = /^\*\*Step [0-9]/m;
    const rest = content.slice(callSiteIdx + 1);
    const stepMatch = stepMarkerRe.exec(rest);
    const nextStepIdx = stepMatch ? callSiteIdx + 1 + stepMatch.index : Infinity;
    const spawnIdx = content.indexOf('subagent_type="gsd-planner"');
    assert.notEqual(spawnIdx, -1, 'gsd-planner spawn should exist in quick.md');

    const sliceEnd = Math.min(nextStepIdx, spawnIdx);
    const slice = content.slice(callSiteIdx, sliceEnd);
    assert.ok(slice.length > 0, 'bounded dispatch slice should be non-empty');
    assert.ok(slice.length < 4000, `bounded dispatch slice should stay under 4000 bytes, got ${slice.length}`);

    const covered = coveredKindsInRegion(slice);
    assert.ok(covered.has('contribution'), 'bounded dispatch slice should cover kind "contribution"');
  });

  test('the dispatch text names no capId, plugin, or runtime — generic dispatch only (D-01)', () => {
    const content = readFileNormalized(QUICK_PATH);
    const callSiteIdx = content.indexOf('loop render-hooks plan:pre');
    const spawnIdx = content.indexOf('subagent_type="gsd-planner"');
    const dispatchSlice = content.slice(callSiteIdx, spawnIdx);
    assert.doesNotMatch(dispatchSlice, /capId\s*={2,3}/, 'dispatch text must not narrow on a specific capId');
  });

  test('the dispatch paragraph states injection is in array order (D-06)', () => {
    const content = readFileNormalized(QUICK_PATH);
    const callSiteIdx = content.indexOf('loop render-hooks plan:pre');
    const spawnIdx = content.indexOf('subagent_type="gsd-planner"');
    const dispatchSlice = content.slice(callSiteIdx, spawnIdx);
    assert.match(dispatchSlice, /array order/, 'dispatch paragraph should state injection is in array order');
  });

  /**
   * Extract the single brace-delimited injection instruction inside
   * <planning_context> (open brace through its matching close). The literal
   * `{For each active entry` prefix is used as the search anchor rather than
   * a bare `content.indexOf('{', ...)` scan — `${AGENT_SKILLS_PLANNER}` and
   * every `${VALIDATE_MODE ? ... : ...}` ternary in the surrounding prompt
   * string also contain brace pairs, so a naive first-`{` search would match
   * inside one of those instead.
   */
  function extractInjectionBlock() {
    const content = readFileNormalized(QUICK_PATH);
    const start = content.indexOf('{For each active entry');
    assert.notEqual(start, -1, 'quick.md should contain the plan:pre injection instruction');
    const end = content.indexOf('}', start);
    assert.notEqual(end, -1, 'injection instruction should have a matching close brace');
    return { content, start, end: end + 1, block: content.slice(start, end + 1) };
  }

  test('the injection block names the planner role — non-planner contributions excluded (D-07)', () => {
    const { block } = extractInjectionBlock();
    assert.match(block, /into\s*={2,3}\s*"planner"/, 'injection block must name the planner role discriminator');
  });

  test('the omit-when-empty (silent no-op) guarantee sits inside the injection block itself (D-02, prose-contract)', () => {
    // Prose-contract assertion: no behavioral seam exists to observe prompt
    // byte-identity when no contributions are active, because the prompt is
    // assembled by an agent reading Markdown, not by code. This asserts the
    // omit-when-empty clause is present INSIDE the same brace-delimited
    // injection instruction, not merely somewhere in the surrounding region.
    const { block } = extractInjectionBlock();
    assert.match(
      block,
      /no active planner contributions exist.*omit this block entirely/i,
      'injection block must state the silent no-op guarantee for the empty case',
    );
  });

  test('exactly one gsd-planner spawn in quick.md (D-03: standard, --full, --validate share it)', () => {
    const content = readFileNormalized(QUICK_PATH);
    const matches = content.match(/subagent_type="gsd-planner"/g) || [];
    assert.strictEqual(matches.length, 1, 'quick.md must contain exactly one gsd-planner spawn');
  });

  test('render call, agent-skills placeholder, injection block, and spawn are in the required order (D-08)', () => {
    const { content, start: injectionIdx } = extractInjectionBlock();
    const renderCallIdx = content.indexOf('loop render-hooks plan:pre');
    const agentSkillsIdx = content.indexOf('${AGENT_SKILLS_PLANNER}');
    const spawnIdx = content.indexOf('subagent_type="gsd-planner"');

    assert.ok(renderCallIdx !== -1 && agentSkillsIdx !== -1 && spawnIdx !== -1, 'all four anchors must exist');
    assert.ok(renderCallIdx < agentSkillsIdx, 'the render call must precede the agent-skills placeholder');
    assert.ok(
      agentSkillsIdx < injectionIdx,
      'the agent-skills placeholder must remain BEFORE the contribution injection block (D-08)',
    );
    assert.ok(injectionIdx < spawnIdx, 'the injection block must precede the planner spawn');
  });
});
