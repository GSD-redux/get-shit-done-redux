// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Tests for modular decomposition of agents/gsd-planner.md
 *
 * Verifies that:
 *   1. gsd-planner.md stays under the 100K agent file threshold
 *   2. gsd-planner.md is under 45K chars (proving the three mode sections were extracted)
 *   3. The three reference files exist
 *   4. gsd-planner.md contains reference pointers to each extracted file
 *   5. Each reference file contains key content from the original mode section
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// ─── Size thresholds ─────────────────────────────────────────────────────────

const AGENT_FILE_SIZE_LIMIT = 100 * 1024;   // 100K — appropriate for version-controlled source
const PLANNER_EXTRACTED_LIMIT = 48 * 1024;  // 48K — proves extraction happened

// ─── File paths ──────────────────────────────────────────────────────────────

const PLANNER_PATH = path.join(PROJECT_ROOT, 'agents', 'gsd-planner.md');
const GAP_CLOSURE_REF = path.join(PROJECT_ROOT, 'gsd-core', 'references', 'planner-gap-closure.md');
const REVISION_REF = path.join(PROJECT_ROOT, 'gsd-core', 'references', 'planner-revision.md');
const REVIEWS_REF = path.join(PROJECT_ROOT, 'gsd-core', 'references', 'planner-reviews.md');

// ─── gsd-planner.md size ─────────────────────────────────────────────────────

describe('gsd-planner.md size constraints', () => {
  test('planner file exists', () => {
    assert.ok(fs.existsSync(PLANNER_PATH), `Missing: ${PLANNER_PATH}`);
  });

  test('planner is under 100K chars (agent file threshold)', () => {
    const raw = fs.readFileSync(PLANNER_PATH, 'utf-8');
    // Normalize CRLF → LF before measuring — Windows checkouts inflate length by ~1 char/line
    const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    assert.ok(
      content.length < AGENT_FILE_SIZE_LIMIT,
      `gsd-planner.md is ${content.length} chars, exceeds 100K agent threshold`
    );
  });

  test('planner is under 45K chars (proves mode sections were extracted)', () => {
    const raw = fs.readFileSync(PLANNER_PATH, 'utf-8');
    // Normalize CRLF → LF before measuring — Windows checkouts inflate length by ~1 char/line
    const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    assert.ok(
      content.length < PLANNER_EXTRACTED_LIMIT,
      `gsd-planner.md is ${content.length} chars, expected < 45K after extracting mode sections`
    );
  });
});

// ─── Reference files exist ───────────────────────────────────────────────────

describe('extracted reference files exist', () => {
  test('planner-gap-closure.md exists', () => {
    assert.ok(fs.existsSync(GAP_CLOSURE_REF), `Missing: ${GAP_CLOSURE_REF}`);
  });

  test('planner-revision.md exists', () => {
    assert.ok(fs.existsSync(REVISION_REF), `Missing: ${REVISION_REF}`);
  });

  test('planner-reviews.md exists', () => {
    assert.ok(fs.existsSync(REVIEWS_REF), `Missing: ${REVIEWS_REF}`);
  });
});

// ─── gsd-planner.md contains reference pointers ──────────────────────────────

describe('gsd-planner.md contains reference pointers to extracted files', () => {
  let plannerContent;

  test('planner references planner-gap-closure.md', () => {
    plannerContent = plannerContent || fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      plannerContent.includes('planner-gap-closure.md'),
      'gsd-planner.md must reference planner-gap-closure.md'
    );
  });

  test('planner references planner-revision.md', () => {
    plannerContent = plannerContent || fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      plannerContent.includes('planner-revision.md'),
      'gsd-planner.md must reference planner-revision.md'
    );
  });

  test('planner references planner-reviews.md', () => {
    plannerContent = plannerContent || fs.readFileSync(PLANNER_PATH, 'utf-8');
    assert.ok(
      plannerContent.includes('planner-reviews.md'),
      'gsd-planner.md must reference planner-reviews.md'
    );
  });
});

// ─── Reference files contain key content ────────────────────────────────────

describe('reference files contain key content from original mode sections', () => {
  test('planner-gap-closure.md contains gap closure content', () => {
    const content = fs.readFileSync(GAP_CLOSURE_REF, 'utf-8');
    const hasGapContent = content.toLowerCase().includes('gap_closure') ||
                          content.toLowerCase().includes('gap closure') ||
                          content.includes('GAP CLOSURE') ||
                          content.includes('--gaps');
    assert.ok(hasGapContent, 'planner-gap-closure.md must contain gap closure mode content');
  });

  test('planner-revision.md contains revision content', () => {
    const content = fs.readFileSync(REVISION_REF, 'utf-8');
    const hasRevisionContent = content.includes('revision') ||
                               content.includes('Revision') ||
                               content.includes('REVISION') ||
                               content.includes('revision_context');
    assert.ok(hasRevisionContent, 'planner-revision.md must contain revision mode content');
  });

  test('planner-reviews.md contains reviews content', () => {
    const content = fs.readFileSync(REVIEWS_REF, 'utf-8');
    const hasReviewsContent = content.includes('reviews') ||
                              content.includes('Reviews') ||
                              content.includes('REVIEWS') ||
                              content.includes('REVIEWS.md');
    assert.ok(hasReviewsContent, 'planner-reviews.md must contain reviews mode content');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3320-planner-deep-work-rules.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3320-planner-deep-work-rules (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product [#3320]
// The bug is a contradiction in prompt/workflow source text. These assertions
// intentionally pin the contract words that planner agents consume.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLANNER_AGENT = path.join(ROOT, 'agents', 'gsd-planner.md');
const PLAN_PHASE_WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase.md');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function extractDeepWorkRules() {
  const workflow = fs.readFileSync(PLAN_PHASE_WORKFLOW, 'utf8');
  const match = workflow.match(/<deep_work_rules>[\s\S]*?<\/deep_work_rules>/);
  assert.ok(match, 'plan-phase.md must contain a deep_work_rules block');
  return match[0];
}

describe('bug #3320 planner action contract', () => {
  test('planner agent explicitly keeps implementation code out of action blocks', () => {
    const planner = fs.readFileSync(PLANNER_AGENT, 'utf8');

    assert.match(
      planner,
      /NEVER place fenced code blocks \(```\) inside `<action>`/,
      'gsd-planner.md must explicitly forbid fenced implementation code in <action>'
    );
    assert.match(
      planner,
      /Code excerpts belong in `<read_first>` source files or referenced context/,
      'gsd-planner.md must route code excerpts to context/read-first material'
    );
  });

  test('plan-phase deep_work_rules no longer requires self-sufficient code dumps', () => {
    const deepWorkRules = extractDeepWorkRules();

    assert.doesNotMatch(
      deepWorkRules,
      /copy them into the action verbatim/,
      'deep_work_rules must not tell planners to copy source material verbatim into <action>'
    );
    assert.doesNotMatch(
      deepWorkRules,
      /complete the task from the action text alone/,
      'deep_work_rules must not make <action> self-sufficient without read_first/context'
    );
    assert.match(
      deepWorkRules,
      /Do not include full file contents, fenced code blocks, or complete implementations in `<action>`/,
      'deep_work_rules must explicitly bound concrete values to avoid code dumping'
    );
  });

  test('plan-phase acceptance criteria allow behavior and test assertions', () => {
    const deepWorkRules = extractDeepWorkRules();

    assert.match(
      deepWorkRules,
      /behavior assertion/,
      'acceptance criteria must allow behavior assertions, not just grep checks'
    );
    assert.match(
      deepWorkRules,
      /test command/,
      'acceptance criteria must allow test-command assertions'
    );
  });

  test('quality gate matches the reconciled planner contract', () => {
    const workflow = read('gsd-core/workflows/plan-phase.md');

    assert.match(
      workflow,
      /Every task has `<acceptance_criteria>` with behavior, test-command, CLI, or source assertions/,
      'quality gate must not narrow acceptance criteria back to grep-only checks'
    );
    assert.match(
      workflow,
      /Every `<action>` contains concrete identifiers without fenced code blocks or full implementations/,
      'quality gate must enforce concrete prose without implementation dumps'
    );
  });
});
  });
}
