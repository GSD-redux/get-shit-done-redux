// allow-test-rule: source-text-is-the-product
// plan-phase.md's planner prompt is the deployed runtime contract under assertion
// plan-phase.md is the deployed planning workflow contract; these checks lock
// the SPEC path wiring and quality-gate that the edge-probe review (RR-01/02/03)
// requires — assertions scope to extracted sub-blocks to avoid false positives.

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

// Extract the planner <downstream_consumer> block from plan-phase.md. The runtime planner is
// spawned from plan-phase.md's own inline <planning_context>/<downstream_consumer>, so the
// load-bearing lift instruction must live here — NOT in templates/planner-subagent-prompt.md,
// which nothing loads at runtime (no @-import in agents/gsd-planner.md, no read in plan-phase.md).
function extractDownstreamConsumerBlock(content) {
  const start = content.indexOf('<downstream_consumer>');
  if (start === -1) return '';
  const end = content.indexOf('</downstream_consumer>', start);
  if (end === -1) return '';
  return content.slice(start, end + '</downstream_consumer>'.length);
}

// Extract the planner <files_to_read> block that contains {UI_SPEC_PATH}
// There are multiple <files_to_read> blocks in plan-phase.md; we need the one
// at ~line 890-912 inside the planning_context markdown block.
function extractPlannerFilesBlock(content) {
  let pos = 0;
  while (true) {
    const start = content.indexOf('<files_to_read>', pos);
    if (start === -1) return '';
    const end = content.indexOf('</files_to_read>', start);
    if (end === -1) return '';
    const block = content.slice(start, end + '</files_to_read>'.length);
    if (block.includes('{UI_SPEC_PATH}')) {
      return block;
    }
    pos = end + 1;
  }
}

// Extract the planner <quality_gate> block (the last one in plan-phase.md,
// inside the planner prompt template)
function extractQualityGateBlock(content) {
  const start = content.lastIndexOf('<quality_gate>');
  if (start === -1) return '';
  const end = content.indexOf('</quality_gate>', start);
  if (end === -1) return '';
  return content.slice(start, end + '</quality_gate>'.length);
}

// Test A (RR-01): plan-phase.md resolves a phase *-SPEC.md into SPEC_FILE/SPEC_PATH
// Uses new RegExp to correctly match literal $ and ( characters in bash snippets.
// This MUST FAIL before the RR-01 fix (no SPEC_PATH resolution exists today)
test('RR-01: plan-phase.md resolves phase *-SPEC.md (excluding AI/UI variants) into SPEC_FILE/SPEC_PATH', () => {
  const content = readPlanPhase();

  // Assert the canonical SPEC_FILE resolution form is present.
  // new RegExp used so that \$ and \( are treated as literal dollar-sign and open-paren
  // (JS regex literals interpret \$ as end-anchor and \( as group open).
  assert.match(
    content,
    new RegExp('SPEC_FILE=\\$\\(ls "\\$\\{[A-Z_]*PHASE_DIR[A-Z_]*\\}"[/][*]-SPEC\\.md'),
    'plan-phase.md must resolve SPEC_FILE using ls "${...PHASE_DIR...}"/*-SPEC.md pattern'
  );

  // Assert {SPEC_PATH} token appears in the planner files_to_read block
  const filesBlock = extractPlannerFilesBlock(content);
  assert.match(
    filesBlock,
    /[{]SPEC_PATH[}]/,
    'The planner <files_to_read> block (containing {UI_SPEC_PATH}) must also contain {SPEC_PATH}'
  );
});

// Test B (RR-01): The {SPEC_PATH} entry is labelled as carrying the ## Edge Coverage section
// This MUST FAIL before the RR-01 fix (no {SPEC_PATH} entry exists today)
test('RR-01: {SPEC_PATH} entry in files_to_read is labelled with Edge Coverage', () => {
  const content = readPlanPhase();
  const filesBlock = extractPlannerFilesBlock(content);

  assert.match(
    filesBlock,
    /[{]SPEC_PATH[}][^\n]*Edge Coverage/,
    '{SPEC_PATH} entry in planner files_to_read must be labelled as carrying the ## Edge Coverage section'
  );
});

// Extract a "## " section from its heading until the next "## " heading (or EOF).
function extractSection(content, heading) {
  const start = content.indexOf(heading);
  if (start === -1) return '';
  const next = content.indexOf('\n## ', start + heading.length);
  return content.slice(start, next === -1 ? content.length : next);
}

// Test E (RR-01 REACHABILITY — the assertion that catches the original no-op):
// Token presence is not enough. The SPEC resolution must live on an UN-GATED path. §4.5
// "Check AI-SPEC" is skipped on every non-AI phase (ai_integration_phase_enabled false /
// --skip-ai-spec), so a resolution placed there leaves SPEC_PATH unbound and the planner
// never receives the SPEC — exactly the #550 silent no-op. Assert it is NOT in §4.5.
test('RR-01 reachability: SPEC_FILE resolution is NOT gated inside the AI-SPEC artifact section', () => {
  const content = readPlanPhase();
  const aiSpecSection = extractSection(content, '## 4.5. Resolve AI-SPEC Artifact');
  const specResolution = new RegExp('SPEC_FILE=\\$\\(ls "\\$\\{[A-Z_]*PHASE_DIR[A-Z_]*\\}"[/][*]-SPEC\\.md');
  assert.ok(aiSpecSection.length > 0, 'sanity: the §4.5 AI-SPEC artifact section must exist to scope this test');
  assert.doesNotMatch(
    aiSpecSection,
    specResolution,
    'SPEC_FILE resolution must NOT live inside the §4.5 AI-SPEC artifact block — gating it there silently starves the planner of the SPEC on non-AI phases (the original #550 no-op)'
  );
  assert.match(content, specResolution, 'SPEC_FILE resolution must still exist on an un-gated path elsewhere in plan-phase.md');
});

// Test C (RR-02 consumer end): the lift instruction lives in the RUNTIME planner surface.
// plan-phase.md spawns the planner from its own inline <planning_context>; the
// templates/planner-subagent-prompt.md file is orphaned (loaded by nothing), so asserting the
// contract there is false assurance — the test stays green even if the runtime never consumes it.
// Pin the contract to the <downstream_consumer> block plan-phase.md actually sends the planner.
test('RR-02 consumer: plan-phase.md downstream_consumer instructs lifting resolved edges into must_haves.truths', () => {
  const block = extractDownstreamConsumerBlock(readPlanPhase());

  assert.ok(block.length > 0, 'sanity: plan-phase.md must contain a <downstream_consumer> block to scope this test');
  assert.match(
    block,
    /##\s*Edge Coverage/,
    'plan-phase.md <downstream_consumer> must reference ## Edge Coverage'
  );
  assert.match(
    block,
    /must_haves\.truths/,
    'plan-phase.md <downstream_consumer> must reference must_haves.truths as the lift target'
  );

  // Regression guard against re-orphaning: the lift instruction must NOT be relocated back into
  // templates/planner-subagent-prompt.md (which nothing loads) and presented as the consumer
  // contract — that is exactly the false-assurance this retarget fixes.
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  assert.doesNotMatch(
    prompt,
    /Edge Coverage/,
    'planner-subagent-prompt.md is not loaded at runtime — the Edge Coverage lift instruction must not live there'
  );
});

// Test D (RR-03): plan-phase.md <quality_gate> contains a resolved-edge ↔ must_haves item
// #3132: vocabulary realigned from covered/backstop-as-status to resolved+verification
test('RR-03: planner quality_gate requires resolved edges represented in must_haves', () => {
  const content = readPlanPhase();
  const qgBlock = extractQualityGateBlock(content);

  assert.match(
    qgBlock,
    /resolved.*edge.*must_haves/i,
    'planner quality_gate must contain a checklist item tying resolved edges to must_haves'
  );
});
