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
});
