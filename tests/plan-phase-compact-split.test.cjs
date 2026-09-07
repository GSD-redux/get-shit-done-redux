'use strict';

/**
 * Issue #4402 (ADR-4139 Decision 5): verifies the plan-phase.md spine /
 * plan-phase/detail/ split is complete (nothing lost), disjoint (nothing
 * duplicated), size-capped, and preserves the protected-content sentinels
 * this pilot draws from gsd-core/references/compact-content-protected-content.md.
 *
 * Scoped to this one split — Phase 3 (#4403) owns the generalized guard that
 * runs this class of check against every future split.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
// The commit immediately before this branch split plan-phase.md (PR #4441's merge to next).
const PARENT_SHA = 'e54d3aa159810b2308cd777047b9de9c04de418a';
const SPINE_REL = 'gsd-core/workflows/plan-phase.md';
const DETAIL_REL = 'gsd-core/workflows/plan-phase/detail/elaboration.md';

/** Trivial lines (fences, rules, bare headings) are excluded from both the
 * completeness and disjointness checks — they are boilerplate that
 * legitimately repeats throughout any markdown file with code blocks, not
 * content that could be silently lost or duplicated in a meaningful sense. */
function isTrivial(line) {
  if (line.length <= 15) return true;
  if (/^`{3,}/.test(line)) return true;
  if (/^-{3,}$/.test(line)) return true;
  if (/^#+\s*$/.test(line)) return true;
  return false;
}

function normalizeNonTrivialLines(content) {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isTrivial(l));
}

function readParentSpine() {
  return execFileSync('git', ['show', `${PARENT_SHA}:${SPINE_REL}`], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
  });
}

function readCurrent(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

describe('plan-phase compact-content spine/detail split (#4402, ADR-4139 Decision 5)', () => {
  test('union of spine + detail contains every non-trivial line the parent commit carried', () => {
    const parentLines = normalizeNonTrivialLines(readParentSpine());
    const spineLines = normalizeNonTrivialLines(readCurrent(SPINE_REL));
    const detailLines = normalizeNonTrivialLines(readCurrent(DETAIL_REL));
    const unionSet = new Set([...spineLines, ...detailLines]);

    const missing = parentLines.filter((l) => !unionSet.has(l));
    assert.deepStrictEqual(
      missing,
      [],
      `${missing.length} line(s) from the parent commit are missing from spine+detail:\n${missing.slice(0, 15).join('\n')}${missing.length > 15 ? `\n(+${missing.length - 15} more)` : ''}`,
    );
  });

  test('no non-trivial line appears in both spine and detail', () => {
    const spineLines = normalizeNonTrivialLines(readCurrent(SPINE_REL));
    const detailLines = normalizeNonTrivialLines(readCurrent(DETAIL_REL));
    const spineSet = new Set(spineLines);
    const duplicated = detailLines.filter((l) => spineSet.has(l));
    assert.deepStrictEqual(
      duplicated,
      [],
      `${duplicated.length} line(s) appear in both spine and detail:\n${duplicated.slice(0, 15).join('\n')}`,
    );
  });

  test('detail.md is a new shipped file under the NEW_FILE_CAP (32768 bytes, tests/helpers/emitted-diff.cjs)', () => {
    const size = fs.statSync(path.join(ROOT, DETAIL_REL)).size;
    assert.ok(size < 32768, `plan-phase/detail/elaboration.md is ${size} bytes; NEW_FILE_CAP is 32768`);
  });

  test('the spine is smaller than the parent commit\'s file (eager-window byte reduction is real)', () => {
    const parentSize = Buffer.byteLength(readParentSpine(), 'utf-8');
    const spineSize = fs.statSync(path.join(ROOT, SPINE_REL)).size;
    assert.ok(
      spineSize < parentSize,
      `spine (${spineSize}B) is not smaller than the parent commit's plan-phase.md (${parentSize}B)`,
    );
  });

  test('the spine references the shared compact-content gate exactly once', () => {
    const spine = readCurrent(SPINE_REL);
    const matches = spine.match(/compact-content-gate\.md/g) || [];
    assert.strictEqual(matches.length, 1, `expected exactly one reference to compact-content-gate.md, found ${matches.length}`);
  });

  test('every gsd:protected sentinel in the spine is well-formed (start/end paired, or a single-line marker followed by content)', () => {
    const spine = readCurrent(SPINE_REL);
    const lines = spine.split(/\r?\n/);
    let openStart = -1;
    const singleMarkers = [];
    const pairedBlocks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '<!-- gsd:protected:start -->') {
        assert.strictEqual(openStart, -1, `nested/unclosed gsd:protected:start at line ${i + 1}`);
        openStart = i;
      } else if (line === '<!-- gsd:protected:end -->') {
        assert.notStrictEqual(openStart, -1, `gsd:protected:end with no matching start at line ${i + 1}`);
        pairedBlocks.push({ start: openStart, end: i });
        openStart = -1;
      } else if (line === '<!-- gsd:protected -->') {
        singleMarkers.push(i);
      }
    }
    assert.strictEqual(openStart, -1, 'a gsd:protected:start sentinel was never closed');
    assert.ok(pairedBlocks.length >= 4, `expected at least 4 paired protected blocks, found ${pairedBlocks.length}`);
    assert.ok(singleMarkers.length >= 2, `expected at least 2 single-line protected markers, found ${singleMarkers.length}`);

    // Each paired block must actually enclose non-trivial content (not an empty/decorative wrap).
    for (const block of pairedBlocks) {
      const enclosed = lines.slice(block.start + 1, block.end).join('\n').trim();
      assert.ok(enclosed.length > 0, `protected block at lines ${block.start + 1}-${block.end + 1} encloses no content`);
    }
    // Each single marker must be immediately followed by non-trivial content on the next non-empty line.
    for (const idx of singleMarkers) {
      let j = idx + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      assert.ok(j < lines.length && lines[j].trim().length > 0, `single protected marker at line ${idx + 1} has no following content`);
    }
  });

  test('the four protected-content categories named in gsd-core/references/compact-content-protected-content.md are represented among the spine\'s protected blocks', () => {
    const spine = readCurrent(SPINE_REL);
    // Output-format contracts:
    assert.match(spine, /<!-- gsd:protected:start -->\s*<quality_gate>/, 'quality_gate output-format contract must be protected');
    assert.match(spine, /<!-- gsd:protected:start -->\s*<success_criteria>/, 'success_criteria output-format contract must be protected');
    assert.match(spine, /<!-- gsd:protected:start -->\s*<downstream_consumer>/, 'downstream_consumer output-format contract must be protected');
    // Few-shot example the workflow's own steps depend on:
    assert.match(spine, /<!-- gsd:protected:start -->\s*<failing_direction_contract>/, 'failing_direction_contract few-shot example must be protected');
    // Negative instruction / guardrail:
    const guardrailCount = (spine.match(/<!-- gsd:protected -->\n> \*\*ORCHESTRATOR RULE[^]*?Never call `ScheduleWakeup`/g) || []).length;
    assert.strictEqual(guardrailCount, 2, `expected 2 protected ScheduleWakeup guardrail paragraphs, found ${guardrailCount}`);
  });
});
