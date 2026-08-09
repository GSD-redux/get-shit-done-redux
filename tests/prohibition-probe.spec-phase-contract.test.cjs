// allow-test-rule: source-text-is-the-product (see #644) — spec-phase.md Step 5.6 is the deployed workflow
// runtime contract under assertion (the workflow PROSE is the product; ADR-550 D5 forbids a JS engine here).
//
// RED-first PROSE-PRESENCE contract for the prohibition probe's Step 5.6 (ADR-550 D1 DIVERGENCE,
// RESEARCH Pitfall 2 / PATTERNS D1): the prohibition probe is LLM-propose (ADR-550 D7b) — there is NO
// compiled engine. DO NOT assert a node-engine / prohibition-probe.cjs invocation; a prohibition-probe.cjs
// path here is a DEFECT. Assert the protocol PROSE is present in the Step 5.6 slice instead. Assertions
// scope to the extracted Step 5.6 block to avoid false positives from mentions elsewhere in the file.
//
// EXPECTED RED until Wave 2/3 add Step 5.6 to spec-phase.md.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SPEC_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'spec-phase.md');

function readSpecPhase() {
  return fs.readFileSync(SPEC_PHASE_PATH, 'utf8');
}

// Slice the Step 5.6 block: from the "Step 5.6" heading to the next "## " or "Step N" heading.
// This scopes assertions to Step 5.6 only, preventing false positives from mentions elsewhere.
function extractStep56Block(content) {
  const startIdx = content.indexOf('## Step 5.6');
  if (startIdx === -1) {
    const altIdx = content.indexOf('Step 5.6');
    if (altIdx === -1) return '';
    const rest = content.slice(altIdx + 'Step 5.6'.length);
    const nextHeading = rest.search(/\n## |\nStep \d/);
    if (nextHeading === -1) return content.slice(altIdx);
    return content.slice(altIdx, altIdx + 'Step 5.6'.length + nextHeading);
  }
  const rest = content.slice(startIdx + '## Step 5.6'.length);
  const nextHeading = rest.search(/\n## /);
  if (nextHeading === -1) return content.slice(startIdx);
  return content.slice(startIdx, startIdx + '## Step 5.6'.length + nextHeading);
}

// D1 DIVERGENCE GUARD: there is no compiled prohibition engine. Assert the Step 5.6 block does NOT
// reference a prohibition-probe.cjs node invocation (RESEARCH Pitfall 2: a copied edge-probe.cjs
// wire is the defect — prohibition is LLM-propose, ADR-550 D7b).
test('D1: Step 5.6 does NOT invoke a prohibition-probe.cjs engine (LLM-propose, not compiled)', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.ok(block.length > 0, 'Step 5.6 block must be extractable from spec-phase.md');
  assert.doesNotMatch(
    block,
    /prohibition-probe\.cjs/,
    'Step 5.6 must NOT reference a prohibition-probe.cjs engine — the prohibition probe is LLM-propose (ADR-550 D7b); a node-engine wire here is a defect'
  );
});

// PROB-01: adversarial recall question is present (the model-robust recall stage).
test('PROB-01: Step 5.6 poses the adversarial recall question', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.ok(block.length > 0, 'Step 5.6 block must be extractable from spec-phase.md');
  assert.match(
    block,
    /silently become|would NOT want|must.?not|adversarial/i,
    'Step 5.6 must pose the adversarial recall question (what could this feature silently become that the author would NOT want)'
  );
});

// PROB-02: precision classifier drops routine-engineering items.
test('PROB-02: Step 5.6 precision stage drops routine engineering items', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.match(
    block,
    /routine engineering|drop[a-z]*\b[^.]*engineering|precision[^.]*classif/i,
    'Step 5.6 must describe a precision classifier that drops routine engineering items (PROB-02)'
  );
});

// PROB-06: soft-gate write-anyway-with-flags.
test('PROB-06: Step 5.6 is a soft gate (write-anyway-with-flags)', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.match(
    block,
    /write.?anyway|soft.?gate|with.?flags/i,
    'Step 5.6 must be a soft gate (write-anyway-with-flags), not a hard halt (PROB-06)'
  );
});

// PROB-05: dismissals require a non-empty reason.
test('PROB-05: Step 5.6 requires a non-empty reason to dismiss', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.match(
    block,
    /dismiss[a-z]*\b[^.]*reason|reason[^.]*dismiss/i,
    'Step 5.6 must require a non-empty reason when dismissing a prohibition (PROB-05)'
  );
});

// PROB-06: --auto never auto-dismisses.
test('PROB-06: Step 5.6 --auto never auto-dismisses prohibitions', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.match(
    block,
    /--auto[^.]*(never|not)[^.]*dismiss|never auto.?dismiss/i,
    'Step 5.6 must specify that --auto never auto-dismisses prohibitions (PROB-06)'
  );
});

// PROB-09: text-mode has no hard AskUserQuestion dependency.
test('PROB-09: Step 5.6 text-mode handling has no hard AskUserQuestion dependency', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.match(
    block,
    /text.?mode|non-?Claude|AskUserQuestion/i,
    'Step 5.6 must handle text-mode (non-Claude, no hard AskUserQuestion) (PROB-09)'
  );
});

// SPEC population: confirmed prohibitions populate a SPEC Prohibitions section.
test('Step 5.6 populates a SPEC Prohibitions section', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.match(
    block,
    /Prohibitions/,
    'Step 5.6 must populate a SPEC Prohibitions section with confirmed prohibitions'
  );
});

// PROB-13: ADR-550 D6 canon-referral breadcrumb to /gsd:secure-phase.
test('PROB-13: Step 5.6 emits the canon-referral breadcrumb to /gsd:secure-phase', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.match(
    block,
    /secure-phase|canon[^.]*security|OWASP|GDPR/i,
    'Step 5.6 must emit a canon-referral breadcrumb (e.g. owned by /gsd:secure-phase) for canon-security items (ADR-550 D6, PROB-13)'
  );
});

// @-include reference to references/prohibition-probe.md.
test('Step 5.6 @-includes the references/prohibition-probe.md core', () => {
  const block = extractStep56Block(readSpecPhase());
  assert.match(
    block,
    /references\/prohibition-probe\.md/,
    'Step 5.6 must @-include references/prohibition-probe.md (the portable probe core)'
  );
});
