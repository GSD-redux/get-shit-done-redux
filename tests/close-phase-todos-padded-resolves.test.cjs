// allow-test-rule: source-text-is-the-product see #2576
// Workflow .md files — their text IS what the runtime loads. Testing text content
// tests the deployed contract. Per CONTRIBUTING.md exception matrix. The behavioral
// cases below also extract the actual bash helper from the workflow text and
// exercise it, so the test is pinned to the deployed logic, not a paraphrase.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const EXECUTE_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

// Extract the close_phase_todos step body so assertions never match unrelated
// steps elsewhere in the workflow (same isolation pattern as the #2415 test).
function readClosePhaseTodosStep() {
  const content = fs.readFileSync(EXECUTE_PHASE, 'utf8');
  const stepStart = content.indexOf('<step name="close_phase_todos">');
  assert.ok(stepStart > -1, 'close_phase_todos step must exist in execute-phase.md');
  const stepEnd = content.indexOf('</step>', stepStart);
  assert.ok(stepEnd > stepStart, 'close_phase_todos step must be properly closed');
  return content.slice(stepStart, stepEnd);
}

// Strip bash `#` comment lines so doc prose mentioning a name doesn't satisfy a
// structural assertion about the actual command. Same approach as the #2415 test.
function stripBashComments(text) {
  return text.replace(/^\s*#.*$/gm, '');
}

describe('#2576: close_phase_todos normalizes padded vs unpadded resolves_phase before comparing', () => {
  // ── Structural: the step must normalize BOTH sides of the comparison ──
  // The bug was a raw string compare: `[ "$RP" = "$PHASE_NUM" ]`. PHASE_NUM is
  // zero-padded ("05") but new-milestone.md writes resolves_phase unpadded ("5"),
  // so every single-digit phase silently failed to auto-close its todos.

  test('close_phase_todos defines a normalize_phase_num bash helper', () => {
    const step = stripBashComments(readClosePhaseTodosStep());
    // The helper name documents intent at the call site; pin the name so a future
    // contributor cannot quietly revert to a raw compare without renaming it.
    assert.match(
      step,
      /normalize_phase_num\s*\(\)\s*\{/,
      'close_phase_todos must define a normalize_phase_num() bash helper'
    );
  });

  test('close_phase_todos normalizes PHASE_NUM into PHASE_NUM_NORM before the loop', () => {
    const step = stripBashComments(readClosePhaseTodosStep());
    assert.match(
      step,
      /PHASE_NUM_NORM\s*=\s*\$\(\s*normalize_phase_num\s+"\$PHASE_NUM"\s*\)/,
      'PHASE_NUM (zero-padded) must be normalized into PHASE_NUM_NORM once before the loop'
    );
  });

  test('close_phase_todos normalizes the extracted RP into RP_NORM inside the loop', () => {
    const step = stripBashComments(readClosePhaseTodosStep());
    assert.match(
      step,
      /RP_NORM\s*=\s*\$\(\s*normalize_phase_num\s+"\$RP"\s*\)/,
      'the extracted resolves_phase value (RP) must be normalized into RP_NORM before comparing'
    );
  });

  test('close_phase_todos compares NORMALIZED values (RP_NORM = PHASE_NUM_NORM), not raw strings', () => {
    const step = stripBashComments(readClosePhaseTodosStep());
    assert.match(
      step,
      /\[\s*"\$RP_NORM"\s*=\s*"\$PHASE_NUM_NORM"\s*\]/,
      'the comparison must be between normalized values: [ "$RP_NORM" = "$PHASE_NUM_NORM" ]'
    );
    // The #2576 bug itself: the old raw-string compare must NOT remain.
    assert.doesNotMatch(
      step,
      /\[\s*"\$RP"\s*=\s*"\$PHASE_NUM"\s*\]/,
      'the raw [ "$RP" = "$PHASE_NUM" ] compare must be gone — it is the #2576 defect'
    );
  });

  test('close_phase_todos guards against empty RP_NORM (missing/blank resolves_phase never matches)', () => {
    const step = stripBashComments(readClosePhaseTodosStep());
    // A todo with no resolves_phase (or an unparseable one) must NOT match phase 0
    // via empty-string equality. The `-n` guard is the defensive seam.
    assert.match(
      step,
      /\[\s*-n\s+"\$RP_NORM"\s*\]/,
      'comparison must be guarded by [ -n "$RP_NORM" ] so empty resolves_phase never matches'
    );
  });

  // ── Behavioral: extract the actual helper from the deployed workflow text and
  // exercise it against the #2576 acceptance criteria. This pins the test to the
  // real logic rather than a paraphrase, and proves the normalization is correct
  // for every padded/unpadded pair the bug affected.

  function extractNormalizeHelper() {
    const step = readClosePhaseTodosStep();
    // Match `normalize_phase_num() { ... \n}` up to the first newline-anchored `}`.
    // Exact today because no interior line of the helper ends in a bare `}` (they
    // end in quotes / then / else / fi). If the helper is ever refactored so an
    // interior line ends in `}`, tighten this to a brace-counting parser.
    const m = step.match(/normalize_phase_num\s*\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(m, 'normalize_phase_num helper must exist in the step for behavioral extraction');
    return m[0];
  }

  function runHelper(t, input) {
    const helper = extractNormalizeHelper();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2576-'));
    t.after(() => cleanup(tmp));
    const script = path.join(tmp, 'normalize.sh');
    // argv array (no shell string) so a quoted input like '"05"' is passed verbatim.
    fs.writeFileSync(script, `${helper}\nnormalize_phase_num "$1"\n`);
    return execFileSync('bash', [script, input], { encoding: 'utf8' });
  }

  // The headline #2576 case: single-digit phase, padded vs unpadded.
  test('acceptance: "05" and "5" both normalize to "5" (the reported bug)', (t) => {
    assert.equal(runHelper(t, '05'), '5');
    assert.equal(runHelper(t, '5'), '5');
    assert.equal(runHelper(t, '05'), runHelper(t, '5'));
  });

  // Acceptance: decimal sub-phases — strip leading zeros from the leading integer
  // run only, leave the dotted tail untouched.
  test('acceptance: decimal sub-phase "04.1" normalizes to "4.1" (decimal preserved)', (t) => {
    assert.equal(runHelper(t, '04.1'), '4.1');
    assert.equal(runHelper(t, '4.1'), '4.1');
    assert.equal(runHelper(t, '4.1'), runHelper(t, '04.1'));
  });

  // Acceptance: letter suffixes must compare correctly.
  test('acceptance: letter suffix "03A" normalizes to "3A", "12A" stays "12A"', (t) => {
    assert.equal(runHelper(t, '03A'), '3A');
    assert.equal(runHelper(t, '12A'), '12A');
    assert.equal(runHelper(t, '3A'), runHelper(t, '03A'));
  });

  // Acceptance: the "00"/"0" edge case must compare equal (not collapse to empty).
  test('acceptance: "00" and "0" both normalize to "0" (all-zeros collapse to one zero)', (t) => {
    assert.equal(runHelper(t, '0'), '0');
    assert.equal(runHelper(t, '00'), '0');
    assert.equal(runHelper(t, '0'), runHelper(t, '00'));
  });

  // Acceptance: quoted YAML values ("5") must compare correctly. The helper strips
  // surrounding double quotes before normalizing.
  test('acceptance: quoted YAML value "5" normalizes to "5" (quotes stripped)', (t) => {
    assert.equal(runHelper(t, '"5"'), '5');
    assert.equal(runHelper(t, '"05"'), '5');
    assert.equal(runHelper(t, '"5"'), runHelper(t, '5'));
  });

  // Defensive: double-digit phases already matched before the fix; they must still.
  test('regression: double-digit "12" stays "12" (no leading zero, no change)', (t) => {
    assert.equal(runHelper(t, '12'), '12');
  });

  // Defensive: arbitrary over-padding (e.g. a hand-edited "012") is tolerated too.
  test('defensive: "012" normalizes to "12" (over-padding tolerated beyond the 2-digit convention)', (t) => {
    assert.equal(runHelper(t, '012'), '12');
    assert.equal(runHelper(t, '12'), runHelper(t, '012'));
  });

  // Defensive: a blank or non-numeric resolves_phase must not crash and must not
  // spuriously match any phase (the `[ -n "$RP_NORM" ]` guard relies on empty out).
  test('defensive: empty input returns empty (no crash, no spurious match)', (t) => {
    assert.equal(runHelper(t, ''), '');
  });

  test('defensive: non-numeric "abc" passes through unchanged (will not equal any phase number)', (t) => {
    assert.equal(runHelper(t, 'abc'), 'abc');
  });
});
