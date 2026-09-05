// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * Prompt Thinning Tests (#1978)
 *
 * Validates context-window-aware prompt thinning for sub-200K models.
 * When CONTEXT_WINDOW < 200000, agent prompts strip extended examples
 * and anti-pattern lists, referencing them as @-required_reading files instead.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const EXECUTE_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const EXECUTOR_AGENT = path.join(__dirname, '..', 'agents', 'gsd-executor.md');
const PLANNER_AGENT = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
const EXECUTOR_EXAMPLES_REF = path.join(__dirname, '..', 'gsd-core', 'references', 'executor-examples.md');
const PLANNER_ANTIPATTERNS_REF = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-antipatterns.md');

describe('prompt thinning — sub-200K context window support (#1978)', () => {

  describe('execute-phase.md — thinning conditional', () => {
    test('has a CONTEXT_WINDOW < 200000 thinning conditional', () => {
      const content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
      assert.ok(
        content.includes('CONTEXT_WINDOW < 200000') || content.includes('CONTEXT_WINDOW< 200000'),
        'execute-phase.md must contain a CONTEXT_WINDOW < 200000 conditional for prompt thinning'
      );
    });

    test('preserves the existing CONTEXT_WINDOW >= 500000 enrichment conditional', () => {
      const content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
      assert.ok(
        content.includes('CONTEXT_WINDOW >= 500000'),
        'execute-phase.md must preserve the existing 500K enrichment conditional'
      );
    });

    test('thinning block references executor-examples.md for on-demand loading', () => {
      const content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
      assert.ok(
        content.includes('executor-examples.md'),
        'execute-phase.md thinning block must reference executor-examples.md'
      );
    });
  });

  describe('gsd-executor.md — reference to extracted examples', () => {
    test('references executor-examples.md for extended examples', () => {
      const content = fs.readFileSync(EXECUTOR_AGENT, 'utf-8');
      assert.ok(
        content.includes('executor-examples.md'),
        'gsd-executor.md must reference executor-examples.md for extended deviation/checkpoint examples'
      );
    });
  });

  describe('gsd-planner.md — reference to extracted anti-patterns', () => {
    test('references planner-antipatterns.md for extended anti-patterns', () => {
      const content = fs.readFileSync(PLANNER_AGENT, 'utf-8');
      assert.ok(
        content.includes('planner-antipatterns.md'),
        'gsd-planner.md must reference planner-antipatterns.md for extended checkpoint anti-patterns and specificity examples'
      );
    });

    test('sequences known external review after internal review fixes (#4107)', () => {
      const planner = fs.readFileSync(PLANNER_AGENT, 'utf-8');
      const assignWaves = planner.match(/<step name="assign_waves">([\s\S]{0,3000}?)<\/step>/)?.[1] || '';
      assert.match(assignWaves, /known automatic external review/i);
      assert.match(assignWaves, /plan includes internal review lanes/i);
      assert.match(assignWaves, /accepted internal-review fixes[^.]*before[^.]*open/i);
      assert.match(assignWaves, /run internal review and apply the accepted internal-review fixes before the final open/i);
      assert.match(assignWaves, /if an open-time property exists[^.]*re-check it immediately before opening[^.]*nothing intervening/i);
      assert.match(assignWaves, /post-open CI[^.]*review[^.]*tracking may follow/i);
      // Directionality fixture (#4107): an inverted-order sentence — PR opens
      // first, fixes land after — must fail the ordering-sensitive assertion
      // above. Proves the regex tests sequence, not mere keyword co-occurrence.
      const invertedOrdering = 'Open the PR before scheduling the accepted internal-review fixes.';
      assert.doesNotMatch(invertedOrdering, /accepted internal-review fixes[^.]*before[^.]*open/i);
      const invertedPlannerText = 'Open the PR, then run internal review and apply the accepted internal-review fixes.';
      assert.doesNotMatch(invertedPlannerText, /run internal review and apply the accepted internal-review fixes before the final open/i);
      assert.match(assignWaves, /planner-antipatterns\.md \("External Review Before PR Open \(#4107\)"\)/);

      const reference = fs.readFileSync(PLANNER_ANTIPATTERNS_REF, 'utf-8');
      const example = collectSection(reference, (heading) => heading.text === 'External Review Before PR Open (#4107)')?.body || '';
      assert.match(example, /Bad[\s\S]*open[^\n]*PR[\s\S]*internal review/i);
      assert.match(example, /Good[\s\S]*internal review[\s\S]*accepted fixes[\s\S]*if applicable[^\n]*re-check[^\n]*then immediately open PR/i);
      assert.match(example, /nothing may intervene[^.]*re-check[^.]*open/i);
      assert.match(example, /post-open work may follow/i);
      // Directionality fixture: a Good section that opens the PR before
      // internal review must fail the "Good" assertion above.
      const invertedExample = 'Good:\nWave 1: If applicable, re-check the open-time property; then immediately open PR\nWave 2: Run internal review\nWave 3: Apply accepted fixes\n';
      assert.doesNotMatch(invertedExample, /Good[\s\S]*internal review[\s\S]*accepted fixes[\s\S]*if applicable[^\n]*re-check[^\n]*then immediately open PR/i);
    });
  });

  describe('executor-examples.md — extracted reference file', () => {
    test('file exists', () => {
      assert.ok(
        fs.existsSync(EXECUTOR_EXAMPLES_REF),
        'gsd-core/references/executor-examples.md must exist'
      );
    });

    test('contains deviation rule examples', () => {
      const content = fs.readFileSync(EXECUTOR_EXAMPLES_REF, 'utf-8');
      assert.ok(
        content.includes('Rule 1') || content.includes('RULE 1'),
        'executor-examples.md must contain deviation rule examples'
      );
    });

    test('contains checkpoint examples', () => {
      const content = fs.readFileSync(EXECUTOR_EXAMPLES_REF, 'utf-8');
      assert.ok(
        content.includes('checkpoint') || content.includes('Checkpoint'),
        'executor-examples.md must contain checkpoint examples'
      );
    });

    test('contains edge case examples', () => {
      const content = fs.readFileSync(EXECUTOR_EXAMPLES_REF, 'utf-8');
      assert.ok(
        content.includes('Edge case') || content.includes('edge case') || content.includes('Edge Case'),
        'executor-examples.md must contain edge case guidance'
      );
    });
  });

  describe('planner-antipatterns.md — extracted reference file', () => {
    test('file exists', () => {
      assert.ok(
        fs.existsSync(PLANNER_ANTIPATTERNS_REF),
        'gsd-core/references/planner-antipatterns.md must exist'
      );
    });

    test('contains checkpoint anti-patterns', () => {
      const content = fs.readFileSync(PLANNER_ANTIPATTERNS_REF, 'utf-8');
      assert.ok(
        content.includes('anti-pattern') || content.includes('Anti-Pattern') || content.includes('Bad'),
        'planner-antipatterns.md must contain checkpoint anti-pattern examples'
      );
    });

    test('contains specificity examples', () => {
      const content = fs.readFileSync(PLANNER_ANTIPATTERNS_REF, 'utf-8');
      assert.ok(
        content.includes('TOO VAGUE') || content.includes('Specificity') || content.includes('specificity'),
        'planner-antipatterns.md must contain specificity examples'
      );
    });
  });

  describe('three-tier consistency', () => {
    test('thinning tier (< 200K), standard tier (200K-500K), and enrichment tier (>= 500K) all coexist', () => {
      const content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
      const hasThinning = content.includes('CONTEXT_WINDOW < 200000');
      const hasEnrichment = content.includes('CONTEXT_WINDOW >= 500000');
      assert.ok(hasThinning, 'must have thinning conditional (< 200K)');
      assert.ok(hasEnrichment, 'must have enrichment conditional (>= 500K)');
    });
  });
});
