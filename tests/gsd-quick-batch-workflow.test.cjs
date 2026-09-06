'use strict';

/**
 * gsd-quick-batch-workflow.test.cjs — structural + byte-budget tests for the
 * `/gsd:quick-batch` command and workflow markdown (#3676, Phase 4 of epic
 * #3344, ADR-1239 "Quick-batch binding").
 *
 * Named `gsd-quick-batch-*` (not `quick-batch-*`) deliberately:
 * `scripts/lint-test-file-count.cjs` buckets any `quick-batch-*.test.cjs`
 * file under the `quick-batch`/`quick-batch-dispatch`/
 * `quick-batch-command-router` production-module buckets by longest-prefix
 * match, and all three are already at their 2-file cap from the CORE-layer
 * pass. This file tests MARKDOWN (no corresponding compiled `.cjs` module),
 * so a `gsd-` prefix keeps it out of every existing bucket.
 *
 * Follows the SAME established testing convention this repo already uses
 * for large workflow files — structural assertions on parsed sections/
 * fenced blocks (e.g. `tests/quick-research.test.cjs`, `tests/
 * quick-branching.test.cjs`) — not `.includes()` on production `.cjs`
 * SOURCE (the `local/no-source-grep` rule targets `.cjs`/`.js`/`.ts`
 * source files, not workflow/command markdown, which is data/prose).
 *
 * Design doc: `.gsd/phase/feat-3676-quick-batch-command-workflow/40-design.md`
 * Test matrix: `.gsd/phase/feat-3676-quick-batch-command-workflow/50-test-matrix.md`
 * Rows covered here: 13-21, 25, 29, 30, 31, 36, 38, 39 (byte cap), 44.
 * Rows 46/47 (CLI routing) are already covered end-to-end by
 * tests/quick-batch-command-router.test.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lfByteCount } = require('../scripts/workflow-size.cjs');
const { NEW_FILE_CAP } = require('./helpers/emitted-diff.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

/**
 * Extract the text strictly between an opening and closing tag, by line
 * index rather than a `[\s\S]*?` regex over readFileSync content (CWE-1333
 * catastrophic-backtracking class; `local/no-unbounded-quantifier`).
 */
function extractTagBody(content, openTag, closeTag) {
  const lines = splitLines(content);
  const startIdx = lines.findIndex((l) => l.includes(openTag));
  if (startIdx === -1) return null;
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(closeTag));
  if (endIdx === -1) return null;
  return lines.slice(startIdx + 1, endIdx).join('\n');
}

const COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'quick-batch.md');
const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick-batch.md');
const STEPS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick-batch', 'steps');

function readStep(name) {
  return fs.readFileSync(path.join(STEPS_DIR, name), 'utf-8');
}

// ─── Command frontmatter (rows 5,7,8,9,10,13-15) ────────────────────────────

describe('quick-batch command: frontmatter and objective', () => {
  test('commands/gsd/quick-batch.md exists', () => {
    assert.ok(fs.existsSync(COMMAND_PATH));
  });

  test('argument-hint advertises --jobs/--validate/--research/--resume/--file', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const hintLine = splitLines(content).find((l) => l.includes('argument-hint'));
    assert.ok(hintLine, 'should have argument-hint line');
    for (const flag of ['--file', '--jobs', '--validate', '--research', '--resume']) {
      assert.ok(hintLine.includes(flag), `argument-hint should mention ${flag}`);
    }
  });

  test('objective documents --discuss/--full as rejected in v1', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const objectiveBody = extractTagBody(content, '<objective>', '</objective>');
    assert.ok(objectiveBody, 'should have <objective> section');
    assert.match(objectiveBody, /--discuss/);
    assert.match(objectiveBody, /--full/);
    assert.match(objectiveBody, /rejected/i);
  });

  test('process routes argument validation through the quick-batch CLI verb, not inline re-derivation', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const processBody = extractTagBody(content, '<process>', '</process>');
    assert.ok(processBody, 'should have <process> section');
    assert.match(processBody, /quick-batch parse-args/);
  });

  // #3676 review pass 3 (Security finding 1): commands/gsd/quick.md carries a
  // <security_notes> block naming the DATA_START/DATA_END boundary
  // convention for content reaching agent prompts (line 176) — quick-batch.md
  // had no equivalent section at all.
  test('security_notes documents the $ARGUMENTS quoting fix and the DATA_START/DATA_END prompt boundary', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const securityBody = extractTagBody(content, '<security_notes>', '</security_notes>');
    assert.ok(securityBody, 'should have <security_notes> section');
    assert.match(securityBody, /--text/);
    assert.match(securityBody, /DATA_START/);
    assert.match(securityBody, /DATA_END/);
  });

  test('$ARGUMENTS is passed to quick-batch parse-args via quoted --text, never unquoted word-splitting', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const processBody = extractTagBody(content, '<process>', '</process>');
    assert.ok(processBody, 'should have <process> section');
    assert.match(processBody, /--text "\$ARGUMENTS"/);
  });
});

// ─── Workflow byte-size boundary (row 49, ADR 1610 NEW_FILE_CAP) ────────────

describe('quick-batch workflow: byte-size boundary (row 49)', () => {
  test('gsd-core/workflows/quick-batch.md exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH));
  });

  test(`main workflow file is under the ${NEW_FILE_CAP}-byte NEW_FILE_CAP (ADR 1610) — a brand-new workflow file gets the tighter cap, not the grandfathered DEFAULT_CAP`, () => {
    const bytes = lfByteCount(WORKFLOW_PATH);
    assert.ok(
      bytes <= NEW_FILE_CAP,
      `gsd-core/workflows/quick-batch.md is ${bytes} bytes, exceeding NEW_FILE_CAP (${NEW_FILE_CAP}) — extract more content into gsd-core/workflows/quick-batch/steps/*.md fragments`,
    );
  });

  test('quick-batch has at least 5 lazy-loaded step fragments (design doc requirement)', () => {
    const files = fs.readdirSync(STEPS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(files.length >= 5, `expected >= 5 step fragments, found ${files.length}: ${files.join(', ')}`);
  });

  // #3676 review pass 3 (Security finding 2): the workflow's own runtime
  // invocation must use quoted --text "$ARGUMENTS", not unquoted -- $ARGUMENTS
  // (shell word-splitting/pathname expansion before the parser sees raw,
  // attacker-influenced task text).
  test('main workflow passes $ARGUMENTS to quick-batch parse-args via quoted --text', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.match(content, /quick-batch parse-args --raw --text "\$ARGUMENTS"/);
    assert.doesNotMatch(content, /quick-batch parse-args --raw -- \$ARGUMENTS(?!")/, 'must never pass raw, unquoted $ARGUMENTS to the parser');
  });
});

// ─── Prompt-injection boundaries on raw task text (Security finding 1) ──────

describe('quick-batch leaf prompts: DATA_START/DATA_END boundary on every raw task description (Security finding 1)', () => {
  for (const [file, label] of [
    ['research-phase.md', 'researcher'],
    ['planner-wave.md', 'planner'],
    ['plan-checker-loop.md', 'plan-checker'],
    ['verification-wave.md', 'verifier'],
  ]) {
    test(`${file} (${label}) wraps \${description} in a DATA_START/DATA_END security_context boundary`, () => {
      const content = readStep(file);
      assert.match(content, /<security_context>/, `${file} must declare a <security_context> block`);
      assert.match(content, /SECURITY:.*DATA_START.*DATA_END/s, `${file}'s security_context must name the DATA_START/DATA_END boundary`);
      assert.match(content, /DATA_START\s*\n\s*\$\{description\}\s*\n\s*DATA_END/, `${file} must wrap \${description} itself between DATA_START/DATA_END, not just mention the convention`);
    });
  }

  test('planner-wave.md ALSO wraps the shared ${TASK_CATALOG_TABLE} (every item\'s raw description) in its own DATA_START/DATA_END boundary', () => {
    const content = readStep('planner-wave.md');
    assert.match(content, /DATA_START\s*\n\s*\$\{TASK_CATALOG_TABLE\}\s*\n\s*DATA_END/);
  });
});

// ─── Isolation model coverage (rows 20-22) ──────────────────────────────────

describe('quick-batch workflow: isolation model coverage (rows 20-22)', () => {
  test('worktree-dispatch.md covers harness-worktree, orchestrator-worktree, and none', () => {
    const content = readStep('worktree-dispatch.md');
    assert.match(content, /isolation == "harness-worktree"/);
    assert.match(content, /isolation == "orchestrator-worktree"/);
    assert.match(content, /isolation == "none"/);
  });

  test('worktree create/executor dispatch is serialized (one Agent() per message, run_in_background)', () => {
    const content = readStep('worktree-dispatch.md');
    assert.match(content, /ONE AT A TIME/);
    assert.match(content, /run_in_background: true/);
  });

  test('row 38: auto-degrades to sequential on stale worktree fork base', () => {
    const content = readStep('worktree-dispatch.md');
    assert.match(content, /worktree\.base-check/);
    assert.match(content, /shouldDegrade/);
  });
});

// ─── Single-writer invariant (row 18) ───────────────────────────────────────

describe('quick-batch workflow: single-writer invariant on the executor (row 18)', () => {
  test('executor prompt forbids invoking /gsd:quick and forbids writing BATCH.json/STATE/ROADMAP', () => {
    const content = readStep('worktree-dispatch.md');
    assert.match(content, /NEVER invoke \/gsd:quick/);
    assert.match(content, /NEVER write .*BATCH\.json/);
    assert.match(content, /Do NOT update STATE\.md or ROADMAP\.md/);
  });
});

// ─── Merge validation reuses the bounded primitive (row 25) ─────────────────

describe('quick-batch workflow: merge validated via the existing bounded primitive (row 25)', () => {
  test('merge-wave.md calls worktree.cleanup-wave, never hand-rolled git merge', () => {
    const content = readStep('merge-wave.md');
    assert.match(content, /worktree\.cleanup-wave/);
    assert.match(content, /never hand-roll `git merge`/);
  });

  test('merge-wave.md routes non-merged outcomes via quick-batch merge-routing and preserves the worktree', () => {
    const content = readStep('merge-wave.md');
    assert.match(content, /quick-batch merge-routing/);
    assert.match(content, /preserveWorktree/);
  });
});

// ─── Research / plan-checker / verification leaves (rows 16,17,19) ─────────

describe('quick-batch workflow: optional per-item leaves (rows 16,17,19)', () => {
  test('row 16: research-phase.md dispatches gsd-phase-researcher before planning', () => {
    const content = readStep('research-phase.md');
    assert.match(content, /subagent_type="gsd-phase-researcher"/);
  });

  test('row 17: plan-checker-loop.md caps revision at 2 iterations', () => {
    const content = readStep('plan-checker-loop.md');
    assert.match(content, /max 2 iterations/i);
    assert.match(content, /iteration >= 2/);
  });

  test('row 19: verification-wave.md routes status via the canonical verification.status query', () => {
    const content = readStep('verification-wave.md');
    assert.match(content, /query verification\.status/);
  });

  test('row 30: verification-wave.md never calls quick-batch complete for a human_needed item', () => {
    const content = readStep('verification-wave.md');
    assert.match(content, /human_needed/);
    assert.match(content, /Do NOT call `quick-batch complete`/);
  });

  test('row 31: verification-wave.md fails a gaps_found item without rollback or retry', () => {
    const content = readStep('verification-wave.md');
    assert.match(content, /gaps_found/);
    assert.match(content, /NO automatic gap-fix retry/);
    assert.match(content, /NO rollback/);
  });
});

// ─── Planning/checking failure blocks execution (row 29) ────────────────────

describe('quick-batch workflow: a plan/check failure blocks that item\'s execution (row 29)', () => {
  test('planner-wave.md marks a missing PLAN.md item failed rather than dispatching an executor for it', () => {
    const content = readStep('planner-wave.md');
    assert.match(content, /mark[\s\S]{0,10}that item `failed`/);
  });
});

// ─── Submodule guard (rows 36,44) ────────────────────────────────────────────

describe('quick-batch workflow: submodule fail-loud commit-time guard (rows 36,44)', () => {
  test('main workflow parses SUBMODULE_PATHS from .gitmodules', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.match(content, /SUBMODULE_PATHS/);
    assert.match(content, /\.gitmodules/);
  });

  test('worktree-dispatch.md embeds the submodule_commit_guard per executor prompt', () => {
    const content = readStep('worktree-dispatch.md');
    assert.match(content, /submodule_commit_guard/);
  });
});

// ─── Crash-window duplicate-dispatch guard (#3677, epic #3344 Phase 5) ──────

describe('quick-batch workflow: worktree-dispatch.md never re-dispatches an item that already finished executing (crash-window guard)', () => {
  test('Step 6 drops any quick_id whose SUMMARY.md already exists before computing spawn-plan, mirroring planner-wave.md\'s PLAN.md-existence check', () => {
    const content = readStep('worktree-dispatch.md');
    assert.match(content, /Crash-window guard/i, 'worktree-dispatch.md must document the crash-window duplicate-dispatch guard');
    assert.match(content, /NEVER re-dispatch it into a second worktree/, 'the guard must explicitly forbid re-dispatch');
    assert.match(content, /\$\{item_dir\}\/\$\{quick_id\}-SUMMARY\.md/, 'the guard must check the same on-disk SUMMARY.md path merge-wave.md already uses');
  });

  test('the guard is positioned before spawn-plan is computed, not after (a post-hoc check cannot prevent the duplicate dispatch)', () => {
    const content = readStep('worktree-dispatch.md');
    const lines = splitLines(content);
    const guardIdx = lines.findIndex((l) => /Crash-window guard/i.test(l));
    const spawnPlanIdx = lines.findIndex((l) => l.includes('quick-batch spawn-plan'));
    assert.ok(guardIdx !== -1, 'crash-window guard section must exist');
    assert.ok(spawnPlanIdx !== -1, 'spawn-plan call must exist');
    assert.ok(guardIdx < spawnPlanIdx, 'the crash-window guard must appear BEFORE the spawn-plan call, or it cannot prevent this round\'s duplicate dispatch');
  });

  test('the guard explains the item is not lost — merge-wave.md\'s own SUMMARY.md-on-disk criterion still picks it up', () => {
    const content = readStep('worktree-dispatch.md');
    assert.match(content, /merge-wave\.md/, 'the guard must point at merge-wave.md as the item\'s recovery path');
    assert.match(content, /not remove it from the batch/i);
  });
});

// ─── Durable worktree-recovery persistence (#3677) ──────────────────────────
//
// The ephemeral $QUICK_BATCH_WORKTREE_MANIFEST does not survive a
// coordinator crash/restart (fresh mktemp file every process) — Step 6 must
// durably persist worktree_path/branch/expected_base onto BATCH.json so a
// RESUMED process's Step 7 can recover them for an item the crash-window
// guard correctly did not re-dispatch.

describe('quick-batch workflow: durable worktree-recovery persistence (#3677)', () => {
  test('worktree-dispatch.md persists dispatchedWorktree/dispatchedBranch/dispatchedBase via quick-batch update right after recording the ephemeral manifest entry', () => {
    const content = readStep('worktree-dispatch.md');
    assert.match(content, /Durable worktree-recovery persistence/i);
    assert.match(content, /dispatchedWorktree/);
    assert.match(content, /dispatchedBranch/);
    assert.match(content, /dispatchedBase/);
    assert.match(content, /quick-batch update --batch/);
  });

  test('merge-wave.md falls back to the durable triple when the ephemeral manifest has no entry for a crash-recovered item', () => {
    const content = readStep('merge-wave.md');
    assert.match(content, /Durable fallback/i);
    assert.match(content, /dispatched_worktree/);
    assert.match(content, /dispatched_branch/);
    assert.match(content, /dispatched_base/);
  });

  test('merge-wave.md clears the durable triple back to null after a successful merge_removed (the worktree no longer exists on disk)', () => {
    const content = readStep('merge-wave.md');
    assert.match(content, /Clear the\s*\n?\s*durable worktree-recovery fields now/i);
    assert.match(content, /"dispatchedWorktree":null,"dispatchedBranch":null,"dispatchedBase":null/);
  });

  test('merge-wave.md fails closed (never guesses) when an item has no worktree record anywhere', () => {
    const content = readStep('merge-wave.md');
    assert.match(content, /still `null`/);
    assert.match(content, /missing durable worktree/);
  });
});

// ─── planner-quick-batch mode (rows 13-15) ──────────────────────────────────

describe('quick-batch planner mode: agents/gsd-planner.md extension (rows 13-15)', () => {
  const plannerPath = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
  const refPath = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-quick-batch.md');

  test('agents/gsd-planner.md additively wires the quick-batch mode reference', () => {
    const content = fs.readFileSync(plannerPath, 'utf-8');
    assert.match(content, /quick-batch.*planner-quick-batch\.md|planner-quick-batch\.md/);
  });

  test('gsd-core/references/planner-quick-batch.md exists and requires depends_on/files_modified ALWAYS', () => {
    assert.ok(fs.existsSync(refPath));
    const content = fs.readFileSync(refPath, 'utf-8');
    assert.match(content, /ALWAYS required, regardless of whether/);
    assert.match(content, /depends_on/);
    assert.match(content, /files_modified/);
  });

  test('planner-wave.md always requests depends_on/files_modified regardless of --validate (row 14)', () => {
    const content = readStep('planner-wave.md');
    assert.match(content, /ALWAYS emit `depends_on`/);
    assert.match(content, /ALWAYS emit `files_modified`/);
    assert.match(content, /required regardless of\s*\n?\s*`--validate`/);
  });

  test('planner-wave.md includes the full batch task catalog in every planner prompt (row 13)', () => {
    const content = readStep('planner-wave.md');
    assert.match(content, /Full batch task catalog/);
  });
});
