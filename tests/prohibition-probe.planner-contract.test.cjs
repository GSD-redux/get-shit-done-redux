// allow-test-rule: source-text-is-the-product (see #644) — plan-phase.md's planner prompt is the deployed
// runtime contract under assertion (the workflow PROSE is the product).
//
// RED-first PROSE-PRESENCE contract for the plan-phase lift of confirmed prohibitions. plan-phase.md
// spawns the planner from its own inline <downstream_consumer> block; the load-bearing lift instruction
// must live THERE (not in templates/planner-subagent-prompt.md, which nothing loads at runtime — the
// edge-probe orphan-prompt regression, edge planner test 145-153). Assertions scope to extracted
// sub-blocks to avoid false positives.
//
// ADR-550 Decision 2: resolved prohibitions lift into must_haves.PROHIBITIONS — NOT must_haves.truths.
// EXPECTED RED until Wave 3 adds the plan-phase lift + quality_gate item.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const PROMPT_PATH = path.join(__dirname, '..', 'gsd-core', 'templates', 'planner-subagent-prompt.md');

function readPlanPhase() {
  return fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
}

// Extract the planner <downstream_consumer> block from plan-phase.md (the runtime planner surface).
function extractDownstreamConsumerBlock(content) {
  const start = content.indexOf('<downstream_consumer>');
  if (start === -1) return '';
  const end = content.indexOf('</downstream_consumer>', start);
  if (end === -1) return '';
  return content.slice(start, end + '</downstream_consumer>'.length);
}

// Extract the planner <quality_gate> block (the last one in plan-phase.md, inside the planner prompt).
function extractQualityGateBlock(content) {
  const start = content.lastIndexOf('<quality_gate>');
  if (start === -1) return '';
  const end = content.indexOf('</quality_gate>', start);
  if (end === -1) return '';
  return content.slice(start, end + '</quality_gate>'.length);
}

// PROB-04 consumer: the lift instruction lives in the RUNTIME planner surface and lifts resolved
// prohibitions into must_haves.prohibitions (ADR-550 D2 — NOT truths).
test('PROB-04 consumer: downstream_consumer lifts SPEC Prohibitions into must_haves.prohibitions', () => {
  const block = extractDownstreamConsumerBlock(readPlanPhase());
  assert.ok(block.length > 0, 'sanity: plan-phase.md must contain a <downstream_consumer> block to scope this test');

  assert.match(
    block,
    /Prohibitions/,
    'plan-phase.md <downstream_consumer> must reference the SPEC Prohibitions section'
  );
  assert.match(
    block,
    /must_haves\.prohibitions/,
    'plan-phase.md <downstream_consumer> must lift resolved prohibitions into must_haves.prohibitions (ADR-550 D2 — NOT truths)'
  );

  // ADR-550 D2 GUARD: prohibitions must NOT be lifted into truths.
  assert.doesNotMatch(
    block,
    /prohibition[^.\n]*must_haves\.truths|must_haves\.truths[^.\n]*prohibition/i,
    'prohibitions must NOT be lifted into must_haves.truths — truths keeps its positive-observable semantics (ADR-550 D2)'
  );
});

// Orphan-prompt regression guard (mirror edge planner test 145-153): the lift instruction must NOT
// be relocated into templates/planner-subagent-prompt.md (which nothing loads at runtime).
test('PROB-04 regression: the prohibitions lift does not live in the orphaned planner-subagent-prompt.md', () => {
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  assert.doesNotMatch(
    prompt,
    /must_haves\.prohibitions/,
    'planner-subagent-prompt.md is not loaded at runtime — the prohibitions lift instruction must not live there'
  );
});

// PROB-04: quality_gate covers every resolved SPEC Prohibition being represented in must_haves.prohibitions.
test('PROB-04: planner quality_gate requires every resolved SPEC Prohibition represented in must_haves.prohibitions', () => {
  const qgBlock = extractQualityGateBlock(readPlanPhase());
  assert.ok(qgBlock.length > 0, 'sanity: plan-phase.md must contain a <quality_gate> block to scope this test');

  assert.match(
    qgBlock,
    /prohibition/i,
    'planner quality_gate must contain a checklist item covering SPEC prohibitions (PROB-04)'
  );
  assert.match(
    qgBlock,
    /must_haves\.prohibitions/,
    'planner quality_gate must tie SPEC prohibitions to must_haves.prohibitions with no silent drops (PROB-04)'
  );
});
