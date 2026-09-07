// allow-test-rule: source-text-is-the-product (see #4465)
// Reads .md product files whose deployed text IS what the runtime loads —
// testing text content tests the deployed contract.

/**
 * #4465 — /gsd:undo commit selection must be milestone-bounded and HEAD-reachable.
 *
 * The defect: `--phase` documented a primary path reading `.planning/.phase-manifest.json`,
 * a file nothing in the repository writes, so the documented fallback was the only real
 * path — `git log --oneline --no-merges --all | grep -E "\(0*${TARGET_PHASE}...` — with no
 * milestone bound and no reachability bound. Feeding that selection to `git revert
 * --no-commit` stages deletion of a previous milestone's files.
 *
 * The fix ports #3995's PHASE_START anchor (already live in code-review.md) to both
 * `--phase` and `--plan`, drops `--all`, and fails closed instead of widening.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const UNDO_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'undo.md');

/** Return the raw text of every ```bash fenced block in `content`. */
function extractBashBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    if ((block.infoString || '').trim().toLowerCase() !== 'bash') continue;
    blocks.push(lines.slice(block.openLineIdx, block.closeLineIdx + 1).join('\n'));
  }
  return blocks;
}

describe('#4465: undo commit selection is bounded', () => {
  const content = fs.readFileSync(UNDO_PATH, 'utf-8');
  const bash = extractBashBlocks(content).join('\n');

  test('A: no commit-selection git log uses --all', () => {
    // `--all` searches every ref, so a commit unreachable from HEAD can be selected
    // for revert. Every selection block must be HEAD-reachable.
    const offenders = extractBashBlocks(content).filter(
      (b) => /git log/.test(b) && /--all\b/.test(b),
    );
    assert.deepEqual(
      offenders, [],
      `undo.md must not select commits with 'git log ... --all' (#4465). Offending block(s):\n${offenders.join('\n---\n')}`,
    );
  });

  test('B: the dead .phase-manifest.json path is gone', () => {
    // Nothing in the repository writes this file, so the documented primary path was
    // permanently unreachable and the unbounded fallback was the only real path.
    assert.ok(
      !/phase-manifest/.test(content),
      'undo.md must not read or assert .planning/.phase-manifest.json — nothing writes it (#4465)',
    );
  });

  test('C: both modes anchor on the phase directory via PHASE_START', () => {
    assert.ok(
      /PHASE_START=\$\(git log --format="%H" --diff-filter=A -- "\$\{PHASE_DIR\}"/.test(bash),
      'undo.md must derive PHASE_START from the phase directory (the #3995 anchor)',
    );
    // Two derivations: one for MODE=phase, one for MODE=plan.
    const anchors = (bash.match(/--diff-filter=A -- "\$\{PHASE_DIR\}"/g) || []).length;
    assert.equal(anchors, 2, 'both --phase and --plan must anchor on PHASE_DIR (#4465)');
  });

  test('D: PHASE_DIR is resolved through find-phase, so it is workstream-correct', () => {
    // find-phase resolves through planningDir, which roots an active workstream at
    // .planning/workstreams/<ws>/ — a hardcoded .planning/phases/ would read the
    // root's same-numbered phase instead.
    const uses = (bash.match(/gsd_run query find-phase/g) || []).length;
    assert.equal(uses, 2, 'both modes must resolve PHASE_DIR via find-phase (#4465)');
  });

  test('E: the selection window is bounded above by HEAD', () => {
    assert.ok(
      /UNDO_RANGE="\$\{PHASE_START\}\^\.\.HEAD"/.test(bash),
      'the selection range must be bounded at HEAD (#4465)',
    );
    assert.ok(
      /UNDO_RANGE="\$\{PHASE_START\}\.\.HEAD"/.test(bash),
      'the root-commit case must still bound at HEAD (#4465)',
    );
  });

  test('F: selection greps run against the bounded range, not the whole repo', () => {
    const selectionBlocks = extractBashBlocks(content).filter((b) => /grep -E/.test(b));
    assert.ok(selectionBlocks.length >= 2, 'expected a selection grep for each of --phase and --plan');
    for (const block of selectionBlocks) {
      assert.ok(
        /\$\{UNDO_RANGE\}/.test(block),
        `every commit-selection grep must run over \${UNDO_RANGE} (#4465). Block:\n${block}`,
      );
    }
  });

  test('G: the workflow fails closed rather than widening when no anchor resolves', () => {
    assert.ok(
      /do NOT fall back to an unbounded search/i.test(content),
      'undo.md must state that an unresolved phase does not widen the search (#4465)',
    );
    assert.ok(
      /An unbounded repository-wide search is never the fallback/i.test(content),
      'undo.md must state the fail-closed rule for an unresolvable anchor (#4465)',
    );
  });

  test('H: dependency_check reads the workstream-resolved planning root', () => {
    assert.ok(
      /PLANNING_DIR=\$\(gsd_run query planning inspect --pick generated_from\.planning_root/.test(bash),
      'dependency_check must resolve the planning root rather than hardcoding .planning/ (#4465)',
    );
    assert.ok(
      !/`\.planning\/ROADMAP\.md`/.test(content),
      'dependency_check must not read a hardcoded .planning/ROADMAP.md — wrong file under a workstream (#4465)',
    );
    assert.ok(
      !/\.planning\/phases\/\$\{/.test(content),
      'dependency_check must not glob a hardcoded .planning/phases/ — wrong tree under a workstream (#4465)',
    );
  });

  test('I: the revert verb is still git revert --no-commit, never git reset --hard', () => {
    // Guard the property the original workflow got right, so this fix cannot regress it.
    assert.ok(/git revert --no-commit/.test(bash), 'undo.md must still use git revert --no-commit');
    // Scoped to bash blocks: the success-criteria checklist legitimately contains the
    // prose "git reset --hard is NEVER used anywhere in this workflow".
    assert.ok(
      !/git reset --hard/.test(bash),
      'undo.md must never execute git reset --hard',
    );
  });
});
