'use strict';

/**
 * #2257: the /gsd-debug orchestrator had no contract for a foreground
 * gsd-debug-session-manager return that is usable but non-terminal. Section 4
 * "Session Management" (and the `continue` subcommand's return handling in
 * Section 1c) recognized only two literal-string returns — `DEBUG SESSION
 * COMPLETE` and `ABANDONED` — with no else branch. Any other return (e.g. a
 * mid-investigation progress summary emitted when the manager's own
 * turn/context budget runs out) matched neither and fell through to the user
 * as if the debug session were complete, silently abandoning the
 * investigation mid-flight.
 *
 * The fix defines an explicit non-terminal marker, `CONTINUE_REQUIRED`, that
 * the session manager emits when it must stop before reaching a terminal
 * state (distinct from the two terminal returns and from a genuine
 * user-input/approval `CHECKPOINT REACHED`, which already correctly pauses
 * via AskUserQuestion). The orchestrator treats anything that is not one of
 * the two terminal markers as non-terminal and auto-resumes by re-spawning
 * the session manager from the on-disk checkpoint, bounded by an anti-loop
 * guard.
 *
 * Correction (orthogonal review): the first cut of the anti-loop guard
 * required BOTH `next_action` AND `updated` to be unchanged across two
 * resumes to detect no-progress — but `agents/gsd-debugger.md` overwrites
 * `updated` on every checkpoint write ("Update the file BEFORE taking
 * action"), so `updated` changes every cycle and the AND-condition could
 * never be true, making the guard dead (unbounded auto-resume / DoS
 * regression). The corrected guard keys no-progress detection off
 * `next_action` ALONE and adds an absolute, content-independent hard cap of
 * 3 total auto-resumes per slug per `/gsd:debug` invocation as the real
 * termination bound.
 *
 * debug.md and gsd-debug-session-manager.md ARE the product the runtime
 * loads, so this asserts the deployed text carries the contract — the
 * sanctioned source-text/contract-guard idiom (see
 * tests/fix-2196-debug-agent-handoff.test.cjs).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DEBUG_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'debug.md');
const SESSION_MANAGER_MD = path.join(__dirname, '..', 'agents', 'gsd-debug-session-manager.md');

describe('#2257 debug non-terminal session-manager return contract', () => {
  // allow-test-rule: source-text-is-the-product (#2257)
  // workflow/agent prose IS the runtime contract under test
  const debugContent = fs.readFileSync(DEBUG_MD, 'utf-8');
  // allow-test-rule: source-text-is-the-product (#2257)
  // workflow/agent prose IS the runtime contract under test
  const managerContent = fs.readFileSync(SESSION_MANAGER_MD, 'utf-8');

  const section4Start = debugContent.indexOf('## 4. Session Management');
  const section4 = section4Start !== -1 ? debugContent.slice(section4Start) : '';

  const section1cStart = debugContent.indexOf('## 1c. CONTINUE subcommand');
  const section1dStart = debugContent.indexOf('## 1d. Check Active Sessions');
  const section1c =
    section1cStart !== -1 && section1dStart !== -1
      ? debugContent.slice(section1cStart, section1dStart)
      : '';

  test('debug.md has Section 4 (Session Management) and Section 1c (CONTINUE subcommand)', () => {
    assert.notEqual(section4Start, -1, 'debug.md must contain Section 4 Session Management');
    assert.notEqual(section1cStart, -1, 'debug.md must contain Section 1c CONTINUE subcommand');
  });

  test('Section 4 has an exhaustive non-terminal branch that auto-resumes from the checkpoint', () => {
    assert.ok(/CONTINUE_REQUIRED/.test(section4),
      'Section 4 must reference the CONTINUE_REQUIRED non-terminal marker');
    assert.ok(/ANYTHING ELSE/i.test(section4),
      'Section 4 must exhaustively catch any return that is not one of the two terminal markers');
    assert.ok(/AUTO-RESUME/i.test(section4) && /re-spawning/i.test(section4),
      'Section 4 must auto-resume by re-spawning the session manager, not return control to the user');
    assert.ok(/same.{0,20}slug/i.test(section4),
      'Section 4 auto-resume must use the SAME slug/checkpoint as the original spawn');
  });

  test('Section 1c has the same exhaustive non-terminal auto-resume branch (not just the two literals)', () => {
    assert.ok(/CONTINUE_REQUIRED/.test(section1c),
      'Section 1c must reference the CONTINUE_REQUIRED non-terminal marker');
    assert.ok(/ANYTHING ELSE/i.test(section1c),
      'Section 1c must exhaustively catch any return that is not one of the two terminal markers');
    assert.ok(/AUTO-RESUME/i.test(section1c) && /re-spawning/i.test(section1c),
      'Section 1c must auto-resume by re-spawning the session manager, not return control to the user');
    assert.ok(/same.{0,20}slug/i.test(section1c),
      'Section 1c auto-resume must use the SAME slug/checkpoint as the original spawn (symmetric with Section 4)');
  });

  test('gsd-debug-session-manager.md defines CONTINUE_REQUIRED distinct from the two terminal formats', () => {
    assert.ok(/## CONTINUE_REQUIRED/.test(managerContent),
      'the agent must define an explicit ## CONTINUE_REQUIRED return heading');
    assert.ok(/## DEBUG SESSION COMPLETE/.test(managerContent),
      'the terminal DEBUG SESSION COMPLETE format must still be present');
    assert.ok(/ABANDONED/.test(managerContent),
      'the terminal ABANDONED format must still be present');
    assert.ok(/non-terminal/i.test(managerContent),
      'the agent must characterize CONTINUE_REQUIRED as non-terminal');
    assert.ok(/CHECKPOINT REACHED/.test(managerContent) && /distinct from/i.test(managerContent),
      'CONTINUE_REQUIRED must be explicitly distinguished from the genuine user-input CHECKPOINT REACHED shape');
    assert.ok(/\.planning\/debug\/\{slug\}\.md/.test(managerContent),
      'CONTINUE_REQUIRED must reference the on-disk checkpoint path');
    assert.ok(/next_action/.test(managerContent) && /status/.test(managerContent),
      'CONTINUE_REQUIRED must reference the checkpoint status/next_action fields');
  });

  test('an anti-loop bound exists so repeated no-progress auto-resumes do not loop indefinitely', () => {
    assert.ok(/anti-loop guard/i.test(section4),
      'Section 4 must name an anti-loop guard');
    assert.ok(/blocker report/i.test(section4),
      'Section 4 must emit a blocker report to the user once the bound is exceeded, instead of looping forever');

    assert.ok(/anti-loop guard/i.test(section1c),
      'Section 1c must name an anti-loop guard');
  });

  test('the anti-loop guard has an absolute hard cap independent of no-progress detection (#2257 correction)', () => {
    for (const [label, section] of [['Section 4', section4], ['Section 1c', section1c]]) {
      assert.ok(/hard cap/i.test(section), `${label} must name an absolute hard cap`);
      assert.ok(/\b3\b/.test(section) && /total auto-resumes/i.test(section),
        `${label} must encode a concrete numeric cap of 3 total auto-resumes`);
      assert.ok(/regardless/i.test(section),
        `${label} hard cap must trip regardless of whether next_action changed (content-independent)`);
    }
  });

  test('no-progress detection keys off next_action alone, never the always-changing updated timestamp (#2257 correction)', () => {
    for (const [label, section] of [['Section 4', section4], ['Section 1c', section1c]]) {
      assert.ok(/next_action/.test(section),
        `${label} no-progress heuristic must reference next_action`);
      assert.ok(/(do not|never).{0,40}updated/i.test(section),
        `${label} must explicitly forbid keying no-progress detection off updated`);
      assert.ok(/changes every cycle/i.test(section),
        `${label} must state WHY updated cannot be used: it is overwritten/changes every checkpoint cycle`);
    }
  });
});
