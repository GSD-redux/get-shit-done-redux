/**
 * Regression tests for #4217 (split A of #3754): artifact-complete executor
 * not reconciled — SUMMARY + matching commits present yet closed as turn_aborted.
 *
 * The supervision contract lives in shipped workflow text
 * (gsd-core/workflows/execute-phase.md + its completion-reconciliation step
 * fragment), which is the instruction the orchestrator executes at runtime.
 * Reading the .md and asserting on its clauses tests the deployed contract
 * (the source-text-is-the-product category; .md reads are outside
 * no-source-grep's .cjs-only scope).
 *
 * Red on `next` before the fix: rows 1-7 of
 * .gsd/bug/fix-4217-codex-artifact-complete-reconcile/50-test-matrix.md.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const FRAGMENT_PATH = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'completion-reconciliation.md'
);

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf-8');
}

function readFragment() {
  return fs.readFileSync(FRAGMENT_PATH, 'utf-8');
}

/**
 * Slice the step-4 "Wait for all agents in wave to complete" region — the
 * supervision surface that governs executor outcomes while/after waiting.
 */
function waitStepRegion(content) {
  const from = content.indexOf('4. **Wait for all agents in wave to complete.**');
  assert.ok(from !== -1, 'execute-phase.md must contain the step-4 wait region');
  const to = content.indexOf('5. **Post-wave hook validation', from);
  assert.ok(to !== -1, 'execute-phase.md step 4 must be followed by step 5');
  return content.slice(from, to);
}

/** The abnormal-termination shapes the contract must name (#3754 / #4217). */
const ABNORMAL_SHAPES = ['interrupted', 'aborted', 'closed', 'killed', 'timed out', 'turn_aborted'];

describe('execute-phase completion reconciliation (#4217 — split A of #3754)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  // ── Row 1: the #4217 lifecycle regression ────────────────────────────────
  describe('row 1 — artifact-complete executor with an abnormal end is reconciled, not failed', () => {
    test('step 4 carries an abnormal-end clause covering every termination shape', () => {
      const region = waitStepRegion(readWorkflow());
      for (const shape of ABNORMAL_SHAPES) {
        assert.ok(
          region.includes(shape),
          `step 4 must name the abnormal-termination shape "${shape}" so no runtime reads its own case as unlisted (#4217)`
        );
      }
    });

    test('step 4 requires reconciliation BEFORE classifying an abnormally-ended executor', () => {
      const region = waitStepRegion(readWorkflow());
      assert.match(
        region,
        /reconcil[\s\S]{0,400}FIRST[\s\S]{0,200}classify[\s\S]{0,20}SECOND/i,
        'step 4 must state the order outright: reconcile the artifacts FIRST, classify SECOND (#4217)'
      );
    });

    test('step 4 covers ends the orchestrator itself initiated (interrupt/close)', () => {
      const region = waitStepRegion(readWorkflow());
      assert.match(
        region,
        /orchestrator itself (interrupted|closed|initiated)/i,
        'the abnormal-end clause must survive an orchestrator-initiated close — the exact reported case (#4217)'
      );
    });

    test('step 7 requires reconciliation before classifying an abnormal end as failure', () => {
      const content = readWorkflow();
      const from = content.indexOf('7. **Handle failures:**');
      assert.ok(from !== -1, 'execute-phase.md must contain the step-7 failure handler');
      const step7 = content.slice(from, content.indexOf('@~/.claude/gsd-core/references/execute-phase-quota-recovery.md', from));
      assert.match(
        step7,
        /reconcil[\s\S]{0,200}BEFORE classifying|BEFORE classifying[\s\S]{0,200}reconcil/i,
        'step 7 must route abnormal session ends through artifact reconciliation BEFORE classifying the failure (#4217 D4 gap)'
      );
    });

    test('fragment verdict: SUMMARY AND matching commits resolve complete without another terminal response', () => {
      const fragment = readFragment();
      assert.match(
        fragment,
        /SUMMARY[\s\S]{0,200}(AND|and)[\s\S]{0,200}matching[\s\S]{0,300}complete/i,
        'the fragment must spell out the complete verdict: SUMMARY present AND matching commits present => complete (#4217)'
      );
      assert.match(
        fragment,
        /(without requiring|no) another terminal|terminal child response/i,
        'the complete verdict must not require another terminal child response (#4217)'
      );
    });

    test('fragment verdict forbids re-dispatch on the reconciled-complete path', () => {
      const fragment = readFragment();
      assert.match(
        fragment,
        /do NOT re-?dispatch/i,
        'a reconciled-complete plan must not be re-dispatched — a second executor would redo committed work on top of itself (#4217)'
      );
    });
  });

  // ── Row 2: runtime-neutral fallback scope ────────────────────────────────
  describe('row 2 — the fallback is scoped to EVERY runtime, not Copilot', () => {
    test('step-4 fallback heading is runtime-neutral', () => {
      const region = waitStepRegion(readWorkflow());
      assert.match(
        region,
        /Completion reconciliation \(EVERY runtime/i,
        'the fallback heading must not scope to Copilot or to runtimes where Agent() may not return (#4217)'
      );
      assert.doesNotMatch(
        region,
        /Completion signal fallback \(Copilot and runtimes where Agent\(\) may not return\)/,
        'the Copilot-scoped heading was the scope gap that kept Codex out (#4217)'
      );
    });

    test('step 4 names the completion-reconciliation fragment by exact path', () => {
      const region = waitStepRegion(readWorkflow());
      assert.ok(
        region.includes('gsd-core/workflows/execute-phase/steps/completion-reconciliation.md'),
        'step 4 must direct the orchestrator to the reconciliation fragment by exact path (also proves response-language inheritance)'
      );
    });
  });

  // ── Rows 3-5: negative space — the reconciliation must NOT over-complete ──
  describe('rows 3-5 — evidence-less or partial-evidence ends are never auto-completed', () => {
    test('fragment: SUMMARY alone is not sufficient evidence', () => {
      const fragment = readFragment();
      assert.match(
        fragment,
        /BOTH probes or neither/i,
        'the reconciliation must take BOTH probes together — never one alone (#4217 negative space)'
      );
      assert.match(
        fragment,
        /SUMMARY without matching commits[\s\S]{0,160}commits without a SUMMARY[\s\S]{0,160}incomplete evidence/i,
        'SUMMARY-without-commits and commits-without-SUMMARY must each be named as incomplete evidence'
      );
    });

    test('fragment: commits without SUMMARY keep the wait-longer arm', () => {
      const fragment = readFragment();
      assert.match(
        fragment,
        /commits are still appearing, wait longer|wait longer/i,
        'commits-without-SUMMARY must keep the existing wait-longer arm (still working / closeout incomplete)'
      );
      assert.match(
        fragment,
        /If SUMMARY\.md does NOT exist/i,
        'the incomplete arm must remain: SUMMARY missing after a reasonable wait routes to activity check / failure handler'
      );
    });

    test('fragment: the abnormal-end clause never converts an evidence-less abnormal end into success', () => {
      const fragment = readFragment();
      assert.match(
        fragment,
        /not evidence of failure/i,
        'the clause must say an abnormally-ended child is not evidence of failure — and the converse holds: no evidence, no completion (#4217)'
      );
      assert.match(
        fragment,
        /route to the failure handler/i,
        'when reconciliation finds no completion evidence, the abnormal end still routes to the failure handler (stays failed)'
      );
    });
  });

  // ── Row 6: the Codex wait rule is bounded and linked ─────────────────────
  describe('row 6 — the Codex orchestrator wait rule is bound to the reconciliation', () => {
    test('every CODEX RUNTIME wait rule references the reconciliation/surveillance surface', () => {
      const content = readWorkflow();
      const blocks = [...content.matchAll(/ORCHESTRATOR RULE — CODEX RUNTIME([\s\S]{0,700}?)(?=\n\s*\n)/g)];
      assert.ok(blocks.length >= 2, 'both CODEX RUNTIME wait rules must exist (dispatch + verify dispatch)');
      for (const [, body] of blocks) {
        assert.match(
          body,
          /completion reconciliation|reconcil|spot-check|surveillance/i,
          'a CODEX RUNTIME wait rule must bind the wait to the step-4 reconciliation — an unbounded wait is the #4217 deadlock'
        );
      }
    });
  });

  // ── Row 7: runtime_compatibility names Codex ─────────────────────────────
  describe('row 7 — runtime_compatibility declares Codex covered', () => {
    test('runtime_compatibility names Codex and defers completion to artifact reconciliation', () => {
      const content = readWorkflow();
      const from = content.indexOf('<runtime_compatibility>');
      const to = content.indexOf('</runtime_compatibility>', from);
      assert.ok(from !== -1 && to !== -1, 'runtime_compatibility block must exist');
      const rtc = content.slice(from, to);
      assert.match(rtc, /\*\*Codex:/, 'runtime_compatibility must name Codex (#4217)');
      assert.match(
        rtc,
        /SUMMARY[\s\S]{0,160}(and|\+)[\s\S]{0,160}commits|spot-check/i,
        'the Codex entry must point completion decisions at the artifact reconciliation (SUMMARY + matching commits)'
      );
    });
  });

  // ── Rows 8-10: preserved-behavior guards ─────────────────────────────────
  describe('rows 8-10 — preserved behavior and seam boundaries', () => {
    test('host still carries the spot-check vocabulary (agent-frontmatter contract)', () => {
      const content = readWorkflow();
      assert.ok(content.includes('spot-check'), 'execute-phase must keep spot-check fallback vocabulary');
      assert.ok(
        content.includes('sequential inline execution'),
        'execute-phase must keep the Copilot sequential inline fallback wording'
      );
    });

    test('stall surveillance block is untouched (#4218 seam)', () => {
      const content = readWorkflow();
      const from = content.indexOf('**Configurable stall surveillance (#3212):**');
      assert.ok(from !== -1, 'the #3212 stall surveillance block must remain in step 4');
      const block = content.slice(from, content.indexOf('If the stalled executor', from));
      assert.match(block, /EXECUTOR_STALL_INTERVAL_MINUTES/, 'stall interval config unchanged');
      assert.match(block, /EXECUTOR_STALL_THRESHOLD_MINUTES/, 'stall threshold config unchanged');
    });

    test('host stays under the frozen ADR-857 Phase 6 ceiling (#1168)', () => {
      const { lfByteCount } = require('../scripts/workflow-size.cjs');
      const bytes = lfByteCount(WORKFLOW_PATH);
      assert.ok(bytes < 93600, `execute-phase.md must stay below the frozen pre-phase-6 ceiling (93600); got ${bytes}`);
    });

    test('fragment keeps the #4003 anchored commit-scope probe and dispatch bound', () => {
      const fragment = readFragment();
      assert.match(fragment, /0\*\$\{SPOT_PHASE_N\}/, 'probe keeps the zero-pad-tolerant anchored scope (#4003)');
      assert.match(fragment, /--since="\$\{DISPATCH_TS\}"/, 'probe keeps the dispatch-time bound');
      assert.match(fragment, /SUMMARY_EXISTS/, 'probe keeps the SUMMARY existence check');
    });
  });
});
