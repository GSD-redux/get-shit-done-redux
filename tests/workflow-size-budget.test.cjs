// allow-test-rule: source-text-is-the-product
// Tests measure byte sizes of workflow files — the workflow file text IS the
// product loaded by agents at runtime. No command output is parsed.
// Migrated from pending-migration-to-typed-ir per #455.

/**
 * Workflow size budget (measured in BYTES — see #717).
 *
 * Workflow definitions in `gsd-core/workflows/*.md` are loaded verbatim
 * into the agent's context every time the corresponding `/gsd:*` command is
 * invoked. Unbounded growth is paid on every invocation across every session.
 *
 * ## Why bytes, not lines (#717)
 *
 * Line count is a poor proxy: markdown tables and fenced code blocks are
 * token-dense, so a line budget over-penalizes prose and under-catches dense
 * additions. Bytes are cheap, deterministic, and need no tokenizer. They are
 * also the UNIT our vendors bound on — Codex caps instruction docs at 32,768
 * bytes (`project_doc_max_bytes`) and truncates past it. We adopt that unit,
 * not that exact number: our XL/LARGE ceilings sit above 32,768 because these
 * are grandfathered top-level orchestrators loaded by Claude, not Codex
 * AGENTS.md docs — the goal is a bounded, ratcheting budget, not Codex parity.
 *
 * ## Why the budget exists at all (the quality argument, not just cost)
 *
 * With prompt caching the per-invocation *cost* premise is weak (cache reads
 * are ~10% of input). The stronger, caching-independent reason is QUALITY:
 * larger context degrades recall and reasoning ("context rot" / attention
 * budget). Lean, high-signal instructions produce better plans. The ceiling
 * protects the agent's attention, not just the token bill.
 *
 * ## The goal this metric is a proxy for (read before gaming it — #717)
 *
 * The real target is bounded *loaded* context. This test measures one file's
 * bytes, but `@~/.claude/gsd-core/references/...` imports are loaded EAGERLY
 * into context. Moving prose into an eagerly @-imported reference shrinks the
 * measured file while leaving (or growing) total loaded context — that is
 * gaming the proxy, not improving the goal. Legitimate extraction is LAZY:
 * content Read only at the step that needs it (see the discuss-phase mode/
 * template tests below, which forbid templates in <required_reading>).
 *
 * ## Enforcement model (issue #1074)
 *
 * Two complementary guards, neither of which is a tier-max ceiling:
 *
 *   1. Differential attribution size ratchet (the anti-creep): every workflow's
 *      byte growth against the base ref is reported with its exact delta by
 *      `tests/emitted-attribution.test.cjs` (via `tests/helpers/emitted-diff.cjs`'s
 *      size ratchet), which fails unless the growth is acknowledged in
 *      `tests/emitted-drift-ack.json` (ADR-2719 §4). This REPLACED the per-file
 *      `tests/workflow-size-baseline.json` snapshot (removed by #2724, ADR-2719
 *      Phase 4 — it conflicted on 7 of 7 PRs that touched it), which itself had
 *      replaced the original tier-max tighten-only ratchet (#597), which only
 *      bound the single largest file per tier and left the other ~85 files able
 *      to grow silently.
 *
 *   2. Tier hard caps (the outer bound): XL/LARGE/DEFAULT are absolute red
 *      lines with real headroom, never raised in normal work. Crossing one
 *      means lazy extraction (the `workflows/discuss-phase/modes/`
 *      progressive-disclosure pattern), not a +N bump. New workflow files get
 *      the Codex `project_doc_max_bytes` anchor (32 KiB) unless explicitly
 *      tiered in the same PR — see `NEW_FILE_CAP` in `tests/helpers/emitted-diff.cjs`.
 *
 * Tiers:
 *   - XL       : top-level orchestrators (e.g., execute-phase, plan-phase)
 *   - LARGE    : multi-step planners
 *   - DEFAULT  : focused single-purpose workflows (target tier)
 *
 * See:
 *   - https://github.com/open-gsd/gsd-core/issues/1074 (per-file baseline + hard caps)
 *   - https://github.com/open-gsd/gsd-core/issues/717  (bytes re-base + rationale)
 *   - https://github.com/open-gsd/gsd-core/issues/683  (LF-normalized byte count)
 *   - https://developers.openai.com/codex/guides/agents-md (Codex 32 KiB cap)
 *   - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const {
  lfByteCount: byteCount,
  listWorkflowStems,
  measureWorkflows,
  MARGIN_RATIO,
  marginFor,
  buildHeadroomRows,
  formatHeadroomTable,
  appendHeadroomStepSummary,
} = require('../scripts/workflow-size.cjs');
const { cleanup } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// Tier HARD CAPS (#1074) — absolute red lines, not high-water-hugging ceilings.
// Day-to-day creep is caught per-file by the baseline guard below; these exist
// only as the outer bound where the correct response is lazy extraction, never
// a raise. Each sits above its tier's current high-water mark with real
// headroom (vs the old GRACE=3000 hug):
//   XL      96 KiB
//   LARGE   60 KiB
//   DEFAULT 40 KiB
//
// #4261: the per-tier high-water marks that used to be written out here are
// gone rather than refreshed. They were measured once and then quietly
// diverged from the tree — the XL line named execute-phase.md as the
// high-water when plan-phase.md had passed it — so the comment meant to
// document the remaining headroom became a reason to believe there was more
// of it than there was. The headroom census below emits the live numbers on
// every run instead of asking a comment to stay true.
// (DEFAULT is deliberately the tightest: a single-purpose workflow approaching
// 40 KiB is the strongest extraction signal of the three. The previous DEFAULT
// high-water, verify-phase.md at 40,931 (29 bytes of headroom), was deleted as
// an orphan in #1892 — 0 loaders, with its still-live gates migrated to
// gsd-core/references/verifier-phase-gates.md behind the gsd-verifier agent.
// Measured 2026-08-13 via measureWorkflows() after that deletion; the note
// before that named settings-advanced.md at 39,160, stale on both counts.)
const XL_CAP = 98304;       // 96 KiB
const LARGE_CAP = 61440;    // 60 KiB
const DEFAULT_CAP = 40960;  // 40 KiB


// Top-level orchestrators that own end-to-end multi-phase rubrics.
// Grandfathered at current sizes — see the discuss-phase/modes split (#717) for the progressive-disclosure
// pattern that future shrinks should follow. Byte counts noted for reference.
const XL_WORKFLOWS = new Set([
  'execute-phase',  // 92880 bytes (grew in #381 CLAUDE_ENV_FILE persist clause)
  'plan-phase',     // 93130 bytes (tier high-water mark; grew in #381 CLAUDE_ENV_FILE persist clause)
  'new-project',    // 61685 bytes
]);

// Multi-step planners and bigger feature workflows. Grandfathered.
// Byte counts updated in #891 (launcher shim expanded with 17 runtime home arms).
const LARGE_WORKFLOWS = new Set([
  'docs-update',           // 54410 bytes (tier high-water mark)
  'autonomous',            // 38030
  'complete-milestone',    // 29510
  'verify-work',           // 30122
  'transition',            // 21427
  'discuss-phase-assumptions', // 26624
  'progress',              // 26287
  'new-milestone',         // 29808
  'update',                // 20766
  'quick',                 // 45710
  'code-review',           // 28726
  'review',                // multi-reviewer orchestration; outgrew DEFAULT (was at the 40960 ceiling) when the OpenCode reviewer gained JSON reconstruction + a diagnosable empty-output stub (#1936)
]);

// Single source of truth for BOTH enumeration and measurement (#1074; finishes
// the consolidation flagged in trek-e's #1089 review). The tier guards below
// iterate exactly the files measureWorkflows() measured and read their bytes
// from the same map, so enumeration and byte-counting can never split-brain.
// `byteCount` (lfByteCount) is retained only for the single-file discuss-phase
// checks below, which target files outside the workflow root.
const SIZES = measureWorkflows();           // { 'execute-phase.md': 92880, ... }
const ALL_WORKFLOWS = listWorkflowStems();  // ['execute-phase', ...] — same source

function capFor(workflow) {
  if (XL_WORKFLOWS.has(workflow)) return { tier: 'XL', cap: XL_CAP };
  if (LARGE_WORKFLOWS.has(workflow)) return { tier: 'LARGE', cap: LARGE_CAP };
  return { tier: 'DEFAULT', cap: DEFAULT_CAP };
}

// byteCount (LF-normalized, #683) is imported as `lfByteCount` from
// scripts/workflow-size.cjs — the single source of truth shared with the
// baseline generator so the guard and the snapshot can never measure
// differently. See the #683 regression test at the bottom of this file.

// ─── #4261: headroom visibility + reserved margin ──────────────────────────
//
// See the twin block in tests/agent-size-budget.test.cjs for the rationale.
// The short version: a green run used to say nothing, so the difference
// between a file at 60% of its cap and one at 99.9% was invisible until the
// day someone crossed the line — and because each PR's CI measures only its
// own base plus its own diff, two individually-green PRs can be jointly over
// with no run either of them produces able to show it.
const WORKFLOW_HEADROOM_ROWS = buildHeadroomRows(SIZES, capFor);

describe('SIZE: workflow headroom census (issue #4261)', () => {
  test('reports every workflow\'s remaining bytes, and never fails for it', (t) => {
    for (const line of formatHeadroomTable(WORKFLOW_HEADROOM_ROWS)) t.diagnostic(line);
    const pressured = WORKFLOW_HEADROOM_ROWS.filter((r) => r.overMargin);
    t.diagnostic(
      `workflows: ${WORKFLOW_HEADROOM_ROWS.length} | over the ${Math.round(MARGIN_RATIO * 100)}% margin: ${pressured.length}`,
    );
    appendHeadroomStepSummary('Workflow size headroom', WORKFLOW_HEADROOM_ROWS);

    // Reporting, not a gate — assert only that the corpus was measured, so an
    // empty census cannot read as good news.
    assert.equal(WORKFLOW_HEADROOM_ROWS.length, ALL_WORKFLOWS.length);
  });

  test('names the workflows inside the reserved margin', (t) => {
    for (const r of WORKFLOW_HEADROOM_ROWS.filter((row) => row.overMargin)) {
      t.diagnostic(
        `RESERVED MARGIN: ${r.name}.md is ${r.bytes} bytes — ${r.headroom} under the ${r.tier} cap ` +
        `(${r.usedPct.toFixed(1)}%), past the ${r.margin}-byte margin. The cap is not moving: ` +
        `extract per-mode bodies to workflows/${r.name}/modes/, templates to ` +
        `workflows/${r.name}/templates/, or shared references to gsd-core/references/ — lazily.`,
      );
    }
    // No assertion on the count, deliberately: pinning it would recreate the
    // per-file size baseline #2724 deleted for conflicting on 7 of 7 PRs.
  });

  test('the reserved margin sits strictly below every tier cap', () => {
    // Negative proof for the margin arithmetic, mirroring the hard-cap
    // boundary fixtures: a ratio or operator edit that widened the margin to
    // the cap would silently disable the warning, and no real-corpus test
    // would notice.
    for (const cap of [DEFAULT_CAP, LARGE_CAP, XL_CAP]) {
      const margin = marginFor(cap);
      assert.ok(margin < cap, `margin ${margin} must sit below cap ${cap}`);
      assert.equal(margin > margin, false, 'a file exactly at the margin is NOT over it');
      assert.equal(margin + 1 > margin, true, 'one byte past the margin IS over it');
    }
  });
});

describe('SIZE: workflow tier hard caps (issue #1074)', () => {
  // Absolute outer bound per tier. Unlike the old tighten-only ceiling, a cap
  // is NOT raised when a file approaches it — crossing it means extract, not
  // bump. Per-file creep is handled by the baseline guard below; this only
  // catches a file that has grown to the point where lazy extraction is the
  // only correct answer.
  for (const workflow of ALL_WORKFLOWS) {
    const { tier, cap } = capFor(workflow);
    test(`${workflow} (${tier}) stays under the ${tier} hard cap (${cap} bytes)`, () => {
      const bytes = SIZES[`${workflow}.md`];
      assert.ok(
        bytes <= cap,
        `${workflow}.md is ${bytes} bytes — exceeds the ${tier} hard cap of ${cap}. ` +
        `This cap is a red line, NOT a budget to raise: extract per-mode bodies to a ` +
        `workflows/${workflow}/modes/ subdirectory, templates to ` +
        `workflows/${workflow}/templates/, or shared references to gsd-core/references/ — ` +
        `and load them LAZILY (not via @-required_reading, which would shrink this ` +
        `file's bytes without shrinking loaded context). See workflows/discuss-phase/.`
      );
    });
  }

  // A prior "new workflow files (not yet baselined) stay under the 32 KiB Codex
  // anchor" test lived here, keyed on `tests/workflow-size-baseline.json` to tell a
  // brand-new file (not yet in the baseline) from an existing grandfathered one
  // (ADR-1610 Decision point 3). #2724 (ADR-2719 Phase 4) deletes that baseline, but
  // the cap is NOT lost: it is revived as `NEW_FILE_CAP` inside the differential
  // attribution check's size ratchet (tests/helpers/emitted-diff.cjs), which already
  // computes "present in sizeCurrent, absent from sizeBaseline" for its own reasons —
  // exactly the same "is this file new" signal, with no additional git dependency.
  // It could not live here: this test is pure and fast (no baseline/base-ref of any
  // kind), and the differential's real-tree test is the only place that dependency
  // already exists. Narrower than the original — the pure differential module cannot
  // see XL_WORKFLOWS/LARGE_WORKFLOWS tiering, so a legitimately large new file must
  // extract rather than tier in — a disclosed, deliberate simplification.
});

// A prior "SIZE: per-file workflow baseline (issue #1074)" describe block lived here,
// asserting every workflow file's exact byte count against the committed
// `tests/workflow-size-baseline.json` snapshot. #2724 (ADR-2719 Phase 4) deletes that
// snapshot: it was a pure function of the source tree, conflicted on 7 of 7 PRs that
// touched it, and its purpose — "growth must be noticed and justified" — is now served
// by the same differential machine that replaced the golden-install-parity fixtures
// (tests/emitted-attribution.test.cjs's real-tree test, via `emitted-diff.cjs`'s size
// ratchet: growth is reported with its exact byte delta and requires an entry in
// tests/emitted-drift-ack.json, ADR-2719 §4 / must-have 6). The tier hard caps above
// are unaffected — they are independent of the deleted baseline and remain the outer
// bound.

describe('SIZE: discuss-phase progressive disclosure (#717 byte budget)', () => {
  // The discuss-phase progressive-disclosure split (#717) targets discuss-phase.md as a thin dispatcher, separate from
  // the per-tier grandfathered budgets above. Originally expressed as <500
  // lines; re-based to bytes for #717 (500 lines ≈ 28 KB at these files'
  // density; set to 30 KB to preserve the thin-dispatcher intent with modest
  // headroom). This is the headline metric of the refactor — every other
  // workflow above its tier is grandfathered and may shrink later via the
  // same pattern.
  // Target raised from 30000 to 32000 in #891 (launcher shim expansion added 17 runtime home arms,
  // adding ~960 bytes to the preamble; the thin-dispatcher intent is preserved — actual=30935).
  const DISCUSS_PHASE_TARGET = 32000;
  test(`discuss-phase.md is under ${DISCUSS_PHASE_TARGET} bytes (#717 byte budget)`, () => {
    const filePath = path.join(WORKFLOWS_DIR, 'discuss-phase.md');
    const bytes = byteCount(filePath);
    assert.ok(
      bytes < DISCUSS_PHASE_TARGET,
      `discuss-phase.md is ${bytes} bytes — must be under ${DISCUSS_PHASE_TARGET} per #717. ` +
      `Per-mode logic belongs in workflows/discuss-phase/modes/<mode>.md, ` +
      `templates in workflows/discuss-phase/templates/.`
    );
  });

  const SUBDIR = path.join(WORKFLOWS_DIR, 'discuss-phase');

  test('mode files exist for every documented mode', () => {
    const expected = ['power', 'all', 'auto', 'chain', 'text', 'batch', 'analyze', 'default', 'advisor'];
    for (const mode of expected) {
      const p = path.join(SUBDIR, 'modes', `${mode}.md`);
      assert.ok(
        fs.existsSync(p),
        `Expected mode file ${path.relative(WORKFLOWS_DIR, p)} — missing. ` +
        `Each --flag in commands/gsd/discuss-phase.md must have a matching mode file.`
      );
    }
  });

  test('every mode file is a real, non-empty workflow doc', () => {
    const modesDir = path.join(SUBDIR, 'modes');
    if (!fs.existsSync(modesDir)) {
      assert.fail(`workflows/discuss-phase/modes/ directory does not exist`);
    }
    for (const file of fs.readdirSync(modesDir)) {
      if (!file.endsWith('.md')) continue;
      const p = path.join(modesDir, file);
      const content = fs.readFileSync(p, 'utf-8');
      assert.ok(content.trim().length > 100,
        `${file} is empty or near-empty (${content.length} chars) — extraction must preserve behavior, not stub it out`);
    }
  });

  test('templates extracted to discuss-phase/templates/', () => {
    const expected = ['context.md', 'discussion-log.md', 'checkpoint.json'];
    for (const t of expected) {
      const p = path.join(SUBDIR, 'templates', t);
      assert.ok(fs.existsSync(p),
        `Expected template ${path.relative(WORKFLOWS_DIR, p)} — missing.`);
    }
  });

  test('parent discuss-phase.md dispatches to mode files (power)', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    assert.ok(
      /discuss-phase\/modes\/power\.md/.test(parent) ||
      /discuss-phase-power\.md/.test(parent),
      `Parent discuss-phase.md must reference workflows/discuss-phase/modes/power.md ` +
      `(or the legacy discuss-phase-power.md alias) somewhere in its dispatch logic.`
    );
  });

  test('parent dispatches to all extracted modes (auto, chain, all, advisor)', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    for (const mode of ['auto', 'chain', 'all', 'advisor']) {
      assert.ok(
        new RegExp(`discuss-phase/modes/${mode}\\.md`).test(parent),
        `Parent discuss-phase.md must reference workflows/discuss-phase/modes/${mode}.md`
      );
    }
  });

  test('parent reads CONTEXT.md template at the write step (not at top)', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    // The template reference must appear inside or near the write_context step,
    // not in the top-level <required_reading> block (which would defeat lazy load).
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const requiredReadingMatch = parent.match(/<required_reading>([\s\S]*?)<\/required_reading>/);
    if (requiredReadingMatch) {
      assert.ok(
        !/discuss-phase\/templates\/context\.md/.test(requiredReadingMatch[1]),
        `CONTEXT.md template must NOT be in <required_reading> — that defeats lazy loading. ` +
        `Read it inside the write_context step, just before writing the file.`
      );
    }
    assert.ok(
      /discuss-phase\/templates\/context\.md/.test(parent),
      `Parent must reference workflows/discuss-phase/templates/context.md somewhere ` +
      `(inside write_context step) so the template loads only when CONTEXT.md is being written.`
    );
  });

  test('advisor block is gated behind USER-PROFILE.md existence check', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    // The guard MUST be a file-existence check (test -f or equivalent), not an
    // unconditional Read of the advisor mode file.
    assert.ok(
      /USER-PROFILE\.md/.test(parent),
      'Parent must reference USER-PROFILE.md to detect advisor mode'
    );
    assert.ok(
      /test\s+-[ef]\s+["'$].*USER-PROFILE/.test(parent) ||
      /\[\[\s+-[ef]\s+["'$].*USER-PROFILE/.test(parent) ||
      /\[\s+-[ef]\s+["'$].*USER-PROFILE/.test(parent),
      'Advisor mode detection must use a file-existence guard (test -f / [ -f ]) ' +
      'so the advisor mode file is only Read when USER-PROFILE.md exists.'
    );
    // Confirm advisor.md Read is conditional on ADVISOR_MODE
    const advisorReadGuarded =
      /ADVISOR_MODE[\s\S]{0,200}?modes\/advisor\.md/.test(parent) ||
      /modes\/advisor\.md[\s\S]{0,200}?ADVISOR_MODE/.test(parent) ||
      /if[\s\S]{0,200}?ADVISOR_MODE[\s\S]{0,400}?advisor\.md/.test(parent);
    assert.ok(
      advisorReadGuarded,
      'Read of modes/advisor.md must be guarded by ADVISOR_MODE (which derives from USER-PROFILE.md existence). ' +
      'Skip the Read entirely when no profile is present.'
    );
  });

  test('auto mode file documents skipping interactive questions (regression)', () => {
    const auto = fs.readFileSync(path.join(SUBDIR, 'modes', 'auto.md'), 'utf-8');
    assert.ok(
      /skip[\s\S]{0,80}interactive|without\s+(?:using\s+)?AskUserQuestion|recommended\s+(?:option|default)/i.test(auto),
      `auto.md must preserve the documented behavior: skip interactive questions ` +
      `and pick the recommended option without using AskUserQuestion.`
    );
  });

  test('auto mode preserves the single-pass cap (regression for inline rule)', () => {
    const auto = fs.readFileSync(path.join(SUBDIR, 'modes', 'auto.md'), 'utf-8');
    assert.ok(
      /single\s+pass|max_discuss_passes|MAX_PASSES|pass\s+cap/i.test(auto),
      `auto.md must preserve the auto-mode pass cap rule from the original workflow. ` +
      `Without it, the workflow can self-feed and consume unbounded resources.`
    );
  });

  test('all mode file documents auto-selecting all gray areas (regression)', () => {
    const allMode = fs.readFileSync(path.join(SUBDIR, 'modes', 'all.md'), 'utf-8');
    assert.ok(
      /auto-select(?:ed)?\s+ALL|select\s+ALL|all\s+gray\s+areas/i.test(allMode),
      `all.md must preserve the documented behavior: auto-select ALL gray areas ` +
      `without asking the user.`
    );
  });

  test('chain mode documents auto-advance to plan-phase (regression)', () => {
    const chain = fs.readFileSync(path.join(SUBDIR, 'modes', 'chain.md'), 'utf-8');
    assert.ok(
      /plan-phase/.test(chain) && /(auto-advance|auto\s+plan)/i.test(chain),
      `chain.md must preserve the documented auto-advance to plan-phase behavior.`
    );
  });

  test('text mode documents replacing AskUserQuestion (regression)', () => {
    const textMode = fs.readFileSync(path.join(SUBDIR, 'modes', 'text.md'), 'utf-8');
    assert.ok(
      /AskUserQuestion/.test(textMode) && /(numbered\s+list|plain[-\s]text)/i.test(textMode),
      `text.md must preserve the rule: replace AskUserQuestion with plain-text numbered lists.`
    );
  });

  test('batch mode documents 2-5 question grouping (regression)', () => {
    const batch = fs.readFileSync(path.join(SUBDIR, 'modes', 'batch.md'), 'utf-8');
    assert.ok(
      /2[-\s–]5|2\s+to\s+5|--batch=N|--batch\s+N/.test(batch),
      `batch.md must preserve the 2-5 questions-per-batch rule.`
    );
  });

  test('analyze mode documents trade-off table presentation (regression)', () => {
    const analyze = fs.readFileSync(path.join(SUBDIR, 'modes', 'analyze.md'), 'utf-8');
    assert.ok(
      /trade[-\s]off|tradeoff|pros[\s\S]{0,30}cons/i.test(analyze),
      `analyze.md must preserve the trade-off analysis presentation rule.`
    );
  });

  test('CONTEXT.md template preserves all required sections', () => {
    const tpl = fs.readFileSync(path.join(SUBDIR, 'templates', 'context.md'), 'utf-8');
    for (const section of ['<domain>', '<decisions>', '<canonical_refs>', '<code_context>', '<specifics>', '<deferred>']) {
      assert.ok(tpl.includes(section),
        `CONTEXT.md template missing required section ${section} — extraction dropped content.`);
    }
    // spec_lock is conditional but the template still has to include it as a documented option
    assert.ok(/spec_lock/i.test(tpl),
      `CONTEXT.md template must document the conditional <spec_lock> section for SPEC.md integration.`);
  });

  test('checkpoint template is valid JSON', () => {
    const raw = fs.readFileSync(path.join(SUBDIR, 'templates', 'checkpoint.json'), 'utf-8');
    assert.doesNotThrow(() => JSON.parse(raw),
      `checkpoint.json template must parse as valid JSON — downstream code reads it.`);
    const parsed = JSON.parse(raw);
    for (const key of ['phase', 'phase_name', 'timestamp', 'areas_completed', 'areas_remaining', 'decisions']) {
      assert.ok(key in parsed,
        `checkpoint.json template missing required field "${key}" — schema regression vs original workflow.`);
    }
  });

  test('parent does not leak per-mode bodies inline (would defeat extraction)', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    // Heuristic: the parent should not contain the full DISCUSSION-LOG.md template body
    // (extracted to templates/discussion-log.md) — that's the heaviest single block.
    // Look for unique strings that ONLY appear in the original inline template.
    const inlineDiscussionLogSignal = /\| Option \| Description \| Selected \|/g;
    const occurrences = (parent.match(inlineDiscussionLogSignal) || []).length;
    assert.ok(occurrences === 0,
      `Parent discuss-phase.md still contains the inline DISCUSSION-LOG.md table — ` +
      `that block must move to workflows/discuss-phase/templates/discussion-log.md.`);
  });

  test('negative: invalid mode flag combinations document a clear error path', () => {
    // Sanity check: the parent file should explicitly handle the mode dispatch
    // rather than silently doing nothing on an unknown flag pattern.
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    assert.ok(
      /ARGUMENTS|--auto|--chain|--all|--power/.test(parent),
      'Parent must dispatch on $ARGUMENTS — losing the flag-parsing block would silently ' +
      'fall back to default mode and obscure user errors.'
    );
  });
});

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

describe('workflow progressive disclosure — MVP bodies lazy-loaded (#720)', () => {
  // MVP-only reference bodies (planner-mvp-mode.md, skeleton-template.md,
  // execute-mvp-tdd.md) must NOT be eagerly @-imported at the top level of the
  // always-loaded workflow files or agent definitions. An @-prefixed path is
  // expanded into context the moment the file loads — regardless of whether
  // MVP_MODE is true — inflating every session's token cost. Use a plain
  // backtick path or a conditional "Read ..." instruction instead. See issue #720.

  test('plan-phase.md does not eagerly @-import planner-mvp-mode.md', () => {
    const planPhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*planner-mvp-mode\.md/.test(planPhaseContent),
      'plan-phase.md contains an eager @-import of planner-mvp-mode.md — ' +
      'this loads the MVP body into context for every session, even when MVP_MODE is false. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('plan-phase.md does not eagerly @-import skeleton-template.md', () => {
    const planPhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*skeleton-template\.md/.test(planPhaseContent),
      'plan-phase.md contains an eager @-import of skeleton-template.md — ' +
      'this loads the template into context on every plan-phase invocation. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('plan-phase.md still references both MVP bodies (lazy reference preserved)', () => {
    const planPhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    assert.ok(
      /planner-mvp-mode\.md/.test(planPhaseContent) && /skeleton-template\.md/.test(planPhaseContent),
      'plan-phase.md must still reference planner-mvp-mode.md and skeleton-template.md ' +
      '(as lazy backtick paths or Read instructions) so agents know where to find them. ' +
      'Do not delete the references — only remove the leading @ sigil. See #720.'
    );
  });

  test('plan-phase.md does not list MVP bodies in <required_reading>', () => {
    const planPhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const requiredReadingMatch = planPhaseContent.match(/<required_reading>([\s\S]*?)<\/required_reading>/);
    if (requiredReadingMatch) {
      const block = requiredReadingMatch[1];
      assert.ok(
        !/planner-mvp-mode\.md/.test(block),
        'planner-mvp-mode.md must NOT appear in plan-phase.md <required_reading> — ' +
        'that block is always loaded regardless of MVP_MODE. See #720.'
      );
      assert.ok(
        !/skeleton-template\.md/.test(block),
        'skeleton-template.md must NOT appear in plan-phase.md <required_reading> — ' +
        'that block is always loaded regardless of MVP_MODE. See #720.'
      );
    }
  });

  test('execute-phase.md does not eagerly @-import execute-mvp-tdd.md', () => {
    const executePhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*execute-mvp-tdd\.md/.test(executePhaseContent),
      'execute-phase.md contains an eager @-import of execute-mvp-tdd.md — ' +
      'this loads the MVP TDD body into context for every session. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('execute-phase.md still references execute-mvp-tdd.md (lazy reference preserved)', () => {
    const executePhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    assert.ok(
      /execute-mvp-tdd\.md/.test(executePhaseContent),
      'execute-phase.md must still reference execute-mvp-tdd.md (as a lazy backtick path ' +
      'or Read instruction) so agents know where to find it. ' +
      'Do not delete the reference — only ensure there is no leading @ sigil. See #720.'
    );
  });

  test('gsd-planner.md does not eagerly @-import planner-mvp-mode.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*planner-mvp-mode\.md/.test(content),
      'gsd-planner.md contains an eager @-import of planner-mvp-mode.md — ' +
      'this loads the MVP body into context for every session, even when MVP_MODE is false. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('gsd-planner.md does not eagerly @-import skeleton-template.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*skeleton-template\.md/.test(content),
      'gsd-planner.md contains an eager @-import of skeleton-template.md — ' +
      'this loads the template into context on every planner invocation. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('gsd-planner.md does not eagerly @-import user-story-template.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*user-story-template\.md/.test(content),
      'gsd-planner.md contains an eager @-import of user-story-template.md — ' +
      'this loads the template into context on every planner invocation. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('gsd-planner.md still references the three MVP bodies', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      /planner-mvp-mode\.md/.test(content),
      'gsd-planner.md must still reference planner-mvp-mode.md (as a lazy path or Read instruction). ' +
      'Do not delete the reference — only remove the leading @ sigil. See #720.'
    );
    assert.ok(
      /skeleton-template\.md/.test(content),
      'gsd-planner.md must still reference skeleton-template.md (as a lazy path or Read instruction). ' +
      'Do not delete the reference — only remove the leading @ sigil. See #720.'
    );
    assert.ok(
      /user-story-template\.md/.test(content),
      'gsd-planner.md must still reference user-story-template.md (as a lazy path or Read instruction). ' +
      'Do not delete the reference — only remove the leading @ sigil. See #720.'
    );
  });

  test('gsd-executor.md does not eagerly @-import execute-mvp-tdd.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*execute-mvp-tdd\.md/.test(content),
      'gsd-executor.md contains an eager @-import of execute-mvp-tdd.md — ' +
      'this loads the MVP TDD body into context for every session. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('gsd-executor.md still references execute-mvp-tdd.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor.md'), 'utf-8');
    assert.ok(
      /execute-mvp-tdd\.md/.test(content),
      'gsd-executor.md must still reference execute-mvp-tdd.md (as a lazy path or Read instruction). ' +
      'Do not delete the reference — only remove the leading @ sigil. See #720.'
    );
  });
});

describe('SIZE: byteCount is line-ending independent (#683 regression)', () => {
  // The budget ceilings are calibrated against an LF (Unix) checkout; Windows
  // checks these .md files out as CRLF, which previously inflated the count by
  // one byte per line and failed CI only on Windows for the high-water file.
  test('CRLF and LF content of the same logical file count identically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-size-eol-'));
    try {
      const body = 'line one\nline two\nthree — with a multibyte dash\n';
      const lfPath = path.join(dir, 'lf.md');
      const crlfPath = path.join(dir, 'crlf.md');
      fs.writeFileSync(lfPath, body);
      fs.writeFileSync(crlfPath, body.replace(/\n/g, '\r\n'));
      assert.strictEqual(
        byteCount(crlfPath),
        byteCount(lfPath),
        'byteCount must normalize CRLF so the byte budget is platform-independent'
      );
      // And it must remain a real LF byte count (not stripped/whitespace-trimmed).
      assert.strictEqual(byteCount(lfPath), Buffer.byteLength(body, 'utf-8'));
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #3324 — @-include lines inside Agent() prompt strings never expand
// ---------------------------------------------------------------------------
// Claude Code expands @path only in natively-loaded markdown bodies (CLAUDE.md,
// slash-command/skill bodies, agent definitions) — never inside the prompt
// parameter of a dynamically constructed Agent() call, which is delivered as
// literal turn text. A bare @-include line in a prompt string means the
// subagent never sees the referenced file (#3324).
describe('#3324: no @-include lines inside Agent() prompt strings', () => {
  const BARE_INCLUDE_LINE = /^\s*@(\$HOME|~)\//;

  function listWorkflowFilesRecursive(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) listWorkflowFilesRecursive(p, out);
      else if (entry.name.endsWith('.md')) out.push(p);
    }
    return out;
  }

  // A prompt region opens at a line ending in `prompt="` and closes at the
  // first subsequent line that is only whitespace + a double quote.
  function bareIncludeLinesInPromptRegions(content) {
    const hits = [];
    let inPrompt = false;
    content.split('\n').forEach((line, i) => {
      if (!inPrompt && /prompt="\s*$/.test(line)) { inPrompt = true; return; }
      if (inPrompt && /^\s*"\s*$/.test(line)) { inPrompt = false; return; }
      if (inPrompt && BARE_INCLUDE_LINE.test(line)) {
        hits.push({ line: i + 1, text: line.trim() });
      }
    });
    return hits;
  }

  test('no workflow prompt string contains a bare @-include line (repo-wide guard)', () => {
    const offenders = [];
    for (const file of listWorkflowFilesRecursive(WORKFLOWS_DIR)) {
      const rel = path.relative(path.join(__dirname, '..'), file);
      for (const hit of bareIncludeLinesInPromptRegions(fs.readFileSync(file, 'utf-8'))) {
        offenders.push(`${rel}:${hit.line} ${hit.text}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Claude Code never expands @path inside a dynamically built Agent() ' +
      'prompt="..." string — the include arrives as literal text and the ' +
      'subagent never sees the referenced file. Use the ORCHESTRATOR ' +
      'build-time embed pattern (see execute-phase.md <worktree_branch_check> ' +
      'and <execution_context>) or inline the content. See #3324.'
    );
  });

  test('execute-phase.md <execution_context> build-time embeds execute-plan.md instead of @-including it', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    const block = content.match(/<execution_context>([\s\S]{0,4000}?)<\/execution_context>/);
    assert.ok(
      block,
      'execute-phase.md must keep an <execution_context> block in the executor dispatch prompt'
    );
    assert.ok(
      /ORCHESTRATOR build-time embed/.test(block[1]),
      '<execution_context> must carry the ORCHESTRATOR build-time embed instruction (#3324)'
    );
    assert.ok(
      /`~\/\.claude\/gsd-core\/workflows\/execute-plan\.md`/.test(block[1]),
      '<execution_context> must list execute-plan.md (backticked, no @ sigil) for build-time embed (#3324)'
    );
  });

  // #3370 — the executor dispatch prompts must carry checkpoint gate semantics so the
  // orchestrator cannot compose anti-auto-approval prompt text that conflates
  // gate="blocking" (the default, auto-approvable) with gate="blocking-human"
  // (always surfaces). The dispatch prompt text IS the product here — the templates
  // below are what gets composed into the Agent() call — so region asserts on the
  // template text are the behavioral seam, same precedent as the #3324 guards above.
  const ANTI_AUTO_APPROVAL = /never auto-approve|do not auto-approve|must not auto-approve|under any circumstance, including/;

  function dispatchRegion(file, fromAnchor, toAnchor) {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8');
    const from = content.indexOf(fromAnchor);
    assert.ok(from !== -1, `${file}: anchor "${fromAnchor}" not found`);
    const to = content.indexOf(toAnchor, from);
    assert.ok(to !== -1, `${file}: anchor "${toAnchor}" not found after "${fromAnchor}"`);
    return content.slice(from, to);
  }

  test('execute-phase step-3 routes checkpoint gate semantics through the per-plan routing fragment (#3370)', () => {
    // The host file sits under the frozen ADR-857 Phase 6 ceiling (≤93400 bytes), so the
    // gate rule lives in the per-plan-executor-routing fragment — the same
    // keep-the-host-lean pattern #1689/#3417 used — which step 3 loads for EVERY plan
    // in every isolation mode (harness-worktree, orchestrator-worktree, sequential)
    // immediately before the dispatch prompt is composed.
    const step = dispatchRegion(
      'execute-phase.md',
      '**Spawn executor agents:**',
      '**Wait for all agents in wave to complete.**',
    );
    assert.match(
      step,
      /Executor routing \([^)]*#3370/,
      'step 3\'s executor-routing line must cite #3370 so the gate rule is loaded with it',
    );

    const fragment = fs.readFileSync(
      path.join(WORKFLOWS_DIR, 'execute-phase', 'steps', 'per-plan-executor-routing.md'),
      'utf-8',
    );
    // AC 1 + AC 3, phase-level: blocking is the auto-approvable default, blocking-human
    // is the only always-surface gate, and the orchestrator is forbidden from injecting
    // dispatch text that refuses auto-approval.
    assert.match(fragment, /#3370/, 'the routing fragment must carry the gate rule');
    assert.match(fragment, /gate="blocking"/, 'the gate rule must name gate="blocking"');
    assert.match(fragment, /auto-approv/i, 'the gate rule must state blocking is auto-approvable in auto-mode');
    assert.match(fragment, /blocking-human/, 'the gate rule must name gate="blocking-human" as the always-surface carve-out');
    assert.match(
      fragment,
      /do NOT add text refusing or overriding\s+auto-approval/,
      'the gate rule must forbid composing dispatch text that refuses or overrides auto-approval',
    );
    // Negative guard: the fix must not itself introduce the anti-auto-approval phrasing.
    assert.doesNotMatch(
      fragment,
      ANTI_AUTO_APPROVAL,
      'the gate rule must not contain anti-auto-approval instructions (#3370)',
    );
  });

  test('execute-phase.md executor Agent() prompt contains no anti-auto-approval instruction in any block (#3370)', () => {
    const step = dispatchRegion(
      'execute-phase.md',
      '**Spawn executor agents:**',
      '**Wait for all agents in wave to complete.**',
    );
    // The gate rule lives in the step-3 instructions (previous test), which every
    // isolation mode executes; the prompt template itself never carried gate text and
    // must stay free of anti-auto-approval phrasing — the executor's semantics come
    // from its own <checkpoint_protocol> plus the build-time-embedded checkpoints.md
    // (#3324), which this guards against the template contradicting.
    assert.doesNotMatch(
      step,
      ANTI_AUTO_APPROVAL,
      'the step-3 dispatch region (instructions + Agent() prompt template) must not '
      + 'contain anti-auto-approval instructions (#3370)',
    );
  });

  test('execute-plan.md Pattern A dispatch carries the same gate semantics (#3370)', () => {
    const patternA = dispatchRegion(
      'execute-plan.md',
      '**Pattern A:** init_agent_tracking',
      '**Pattern B:** Execute segment-by-segment',
    );
    // AC 4: the single-plan-level dispatch path is covered, not just execute-phase.
    assert.match(patternA, /#3370/, 'Pattern A must cite the gate-semantics rule');
    assert.match(patternA, /gate="blocking"/, 'Pattern A must name gate="blocking"');
    assert.match(patternA, /blocking-human/, 'Pattern A must name gate="blocking-human"');
    assert.match(patternA, /auto-approv/i, 'Pattern A must state blocking is auto-approvable in auto-mode');
    assert.match(
      patternA,
      /no instruction (?:that )?overrid/i,
      'Pattern A must forbid adding instructions that override the executor checkpoint protocol',
    );
    assert.doesNotMatch(
      patternA,
      ANTI_AUTO_APPROVAL,
      'Pattern A must not contain anti-auto-approval instructions (#3370)',
    );
  });

  test('execute-plan.md still defines the steps only it carries into the dispatch', () => {
    const content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-plan.md'), 'utf-8');
    for (const marker of [
      'segment_execution',
      'previous_phase_check',
      'verification_failure_gate',
      'update_codebase_map',
    ]) {
      assert.ok(
        content.includes(marker),
        `execute-plan.md must still define ${marker} — it reaches executors only via the build-time embed (#3324)`
      );
    }
  });
});
