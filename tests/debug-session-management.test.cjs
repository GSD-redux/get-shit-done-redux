// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

describe('debug session management implementation', () => {
  test('DEBUG.md template contains reasoning_checkpoint field', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/templates/DEBUG.md'),
      'utf8'
    );
    assert.ok(content.includes('reasoning_checkpoint'), 'DEBUG.md must contain reasoning_checkpoint field');
  });

  test('DEBUG.md template contains tdd_checkpoint field', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/templates/DEBUG.md'),
      'utf8'
    );
    assert.ok(content.includes('tdd_checkpoint'), 'DEBUG.md must contain tdd_checkpoint field');
  });

  test('debug command contains list subcommand logic', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('SUBCMD=list') || content.includes('"list"'),
      'debug.md must contain list subcommand logic'
    );
  });

  test('debug command contains continue subcommand logic', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('SUBCMD=continue') || content.includes('"continue"'),
      'debug.md must contain continue subcommand logic'
    );
  });

  test('debug command contains status subcommand logic', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('SUBCMD=status') || content.includes('"status"'),
      'debug.md must contain status subcommand logic'
    );
  });

  test('debug command contains TDD gate logic', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('TDD_MODE') || content.includes('tdd_mode'),
      'debug.md must contain TDD gate logic'
    );
  });

  test('debug.md reads tdd_mode via workflow.tdd_mode key (not bare tdd_mode)', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    // #3149: tdd_mode now arrives on the `init.debug` bundle rather than a
    // `config-get` call in this workflow, so the old literal-call assertion no
    // longer describes reality. The invariant it protected is unchanged and is
    // asserted at its new home: `cmdInitDebug` resolves `config.workflow`'s
    // `tdd_mode`, never a bare top-level key — proven behaviorally in
    // tests/init-debug.test.cjs ('honors workflow.tdd_mode, ignores a bare
    // top-level tdd_mode'). What must remain true HERE is only that this
    // workflow never reintroduces a bare-key read of its own.
    assert.ok(
      !content.includes('config-get tdd_mode'),
      'debug.md must not use bare "tdd_mode" key — use "workflow.tdd_mode" to match every other consumer'
    );
    assert.ok(
      content.includes('tdd_mode'),
      'debug.md must still consume tdd_mode (now from the init.debug bundle)'
    );
  });

  test('debug command contains security hardening', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(content.includes('DATA_START'), 'debug.md must contain DATA_START injection boundary marker');
  });

  test('debug command surfaces next_action before spawn', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('[debug] Next:') || content.includes('next_action'),
      'debug.md must surface next_action before agent spawn'
    );
  });

  test('gsd-debugger contains structured reasoning checkpoint', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'agents/gsd-debugger.md'),
      'utf8'
    );
    assert.ok(content.includes('reasoning_checkpoint'), 'gsd-debugger.md must contain reasoning_checkpoint');
  });

  test('gsd-debugger contains TDD checkpoint mode', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'agents/gsd-debugger.md'),
      'utf8'
    );
    assert.ok(content.includes('tdd_mode'), 'gsd-debugger.md must contain tdd_mode');
    assert.ok(content.includes('TDD CHECKPOINT'), 'gsd-debugger.md must contain TDD CHECKPOINT return format');
  });

  test('gsd-debugger contains delta debugging technique', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'agents/gsd-debugger.md'),
      'utf8'
    );
    assert.ok(content.includes('Delta Debugging'), 'gsd-debugger.md must contain Delta Debugging technique');
  });

  test('gsd-debugger contains security note about DATA_START', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'agents/gsd-debugger.md'),
      'utf8'
    );
    assert.ok(content.includes('DATA_START'), 'gsd-debugger.md must contain DATA_START security reference');
  });
});

// Tests for #2148 and #2151
describe('debug skill dispatch and sub-orchestrator (#2148, #2151)', () => {
  test('gsd-debugger ROOT CAUSE FOUND format includes specialist_hint field', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debugger.md'), 'utf8');
    assert.ok(content.includes('specialist_hint'), 'gsd-debugger missing specialist_hint in ROOT CAUSE FOUND');
    assert.ok(content.includes('swift_concurrency'), 'gsd-debugger missing specialist_hint derivation guidance');
  });

  test('debug.md orchestrator has specialist skill dispatch step', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'gsd-core/workflows/debug.md'), 'utf8');
    assert.ok(content.includes('specialist_hint'), 'debug.md missing specialist dispatch logic');
    assert.ok(content.includes('typescript-expert'), 'debug.md missing skill dispatch mapping');
  });

  test('debug.md specialist dispatch prompt uses DATA_START/DATA_END boundaries', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'gsd-core/workflows/debug.md'), 'utf8');
    assert.ok(content.includes('DATA_START') && content.includes('DATA_END'),
      'debug.md specialist dispatch prompt missing security boundaries');
  });

  test('gsd-debug-session-manager agent exists with correct tools', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('Agent'), 'gsd-debug-session-manager missing Agent tool');
    assert.ok(content.includes('AskUserQuestion'), 'gsd-debug-session-manager missing AskUserQuestion tool');
  });

  test('gsd-debug-session-manager spawns debugger with Agent() dispatcher', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('\nAgent('), 'session manager must dispatch debugger with Agent(');
  });

  test('gsd-debug-session-manager uses DATA_START/DATA_END for checkpoint responses', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('DATA_START') && content.includes('DATA_END'),
      'gsd-debug-session-manager missing security boundaries on checkpoint responses');
  });

  test('gsd-debug-session-manager has compact summary output format', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('DEBUG SESSION COMPLETE'), 'session manager missing compact summary format');
  });

  test('gsd-debug-session-manager includes anti-heredoc rule', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('heredoc'), 'session manager missing anti-heredoc rule');
  });

  test('debug.md delegates to gsd-debug-session-manager', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'gsd-core', 'workflows', 'debug.md'), 'utf8');
    assert.ok(content.includes('gsd-debug-session-manager'),
      'debug.md does not delegate to session manager');
  });

  test('DEBUG.md reasoning_checkpoint field-count claim matches gsd-debugger.md YAML keys (parity)', () => {
    // Parallel-surface drift guard (DEFECT.GENERATIVE-FIX): the field-count
    // claim in the DEBUG.md section_rules prose must equal the number of keys
    // enumerated in the gsd-debugger.md reasoning_checkpoint YAML block.
    // CRLF-safe regex/split per DEFECT.WINDOWS-TEST-PORTABILITY. Accepts either
    // digit ("7-field") or word ("seven-field") count form.
    const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const debugContent = fs.readFileSync(path.join(process.cwd(), 'gsd-core', 'templates', 'DEBUG.md'), 'utf8');
    const agentContent = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debugger.md'), 'utf8');
    const debugMatch = debugContent.match(/reasoning_checkpoint[^.\r\n]*?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)-field structured reasoning record/i);
    assert.ok(debugMatch, 'DEBUG.md must state a "N-field structured reasoning record" claim for reasoning_checkpoint');
    const claimedCount = /^\d+$/.test(debugMatch[1]) ? parseInt(debugMatch[1], 10) : NUMWORDS[debugMatch[1].toLowerCase()];
    assert.ok(typeof claimedCount === 'number', `unrecognized field-count token: ${debugMatch[1]}`);
    const agentLines = agentContent.split(/\r?\n/);
    let yamlBody = null;
    for (const block of scanFencedBlocks(agentLines)) {
      if (block.closeLineIdx === -1) continue;
      const bodyLines = agentLines.slice(block.openLineIdx + 1, block.closeLineIdx);
      const labelIdx = bodyLines.findIndex((l) => /^reasoning_checkpoint:\s*$/.test(l));
      if (labelIdx !== -1) {
        yamlBody = bodyLines.slice(labelIdx + 1).join('\n');
        break;
      }
    }
    assert.ok(yamlBody, 'gsd-debugger.md must define a fenced reasoning_checkpoint YAML block');
    const keys = new Set();
    for (const line of yamlBody.split(/\r?\n/)) {
      // Match 2-space-indented YAML keys (with OR without an inline value —
      // array-valued keys like confirming_evidence: have no trailing space).
      const m = line.match(/^ {2}([a-z_]+):/);
      if (m) keys.add(m[1]);
    }
    assert.strictEqual(
      keys.size,
      claimedCount,
      `parity drift: DEBUG.md claims ${claimedCount}-field but gsd-debugger.md enumerates ${keys.size} keys (${[...keys].join(', ')}). Update BOTH surfaces together.`
    );
  });

  // #2376: debug_file_path handed to the spawned gsd-debug-session-manager
  // must resolve regardless of that subagent's own cwd, which may differ
  // from the orchestrator's — debug.md must reference the absolute
  // {debug_dir} field from `state load`, not a bare .planning/debug/...
  // literal, in both the `continue` and new-session Agent() spawns.
  test('debug.md session_params reference {debug_dir}/{slug}.md, not bare .planning/debug/... literals (#2376)', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'gsd-core/workflows/debug.md'), 'utf8');
    assert.ok(content.includes('debug_file_path: {debug_dir}/{SLUG}.md'),
      'debug.md continue-subcommand spawn must reference {debug_dir}/{SLUG}.md, not a bare .planning/debug/{SLUG}.md literal');
    assert.ok(content.includes('debug_file_path: {debug_dir}/{slug}.md'),
      'debug.md new-session spawn must reference {debug_dir}/{slug}.md, not a bare .planning/debug/{slug}.md literal');
    assert.ok(!content.includes('debug_file_path: .planning/debug/'),
      'debug.md session_params must not hardcode .planning/debug/... as debug_file_path (#2376)');
  });
});

// Tests for #2196 (folded from tests/fix-2196-debug-agent-handoff.test.cjs):
// the /gsd-debug orchestrator misused the foreground session-manager Agent()
// spawn as a background task, then queried the returned agent ID via
// TaskOutput (which expects a task ID) — yielding "No task found with ID"
// and leaving the workflow waiting on a handoff that was never queryable,
// with no recovery. The fix makes debug.md state explicitly that the spawn
// is foreground/blocking, that an agent ID must never be passed to
// TaskOutput, and that a lost handoff must be recovered (preserve
// checkpoint + resume).
describe('#2196 debug.md session-manager spawn contract', () => {
  // allow-test-rule: source-text-is-the-product (#2196)
  const DEBUG_MD_2196 = path.join(__dirname, '..', 'gsd-core', 'workflows', 'debug.md');
  const content = fs.readFileSync(DEBUG_MD_2196, 'utf-8');
  const sectionStart = content.indexOf('Session Management');
  const section = sectionStart !== -1 ? content.slice(sectionStart) : '';

  test('debug.md has the Session Management section', () => {
    assert.notEqual(sectionStart, -1, 'debug.md must contain the Session Management section');
  });

  test('the session-manager spawn is declared foreground/blocking (not backgrounded)', () => {
    assert.ok(/foreground/i.test(section) && /blocking/i.test(section),
      'the Agent() spawn must be declared foreground and blocking so it is not polled');
  });

  test('an agent ID must not be passed to TaskOutput', () => {
    assert.ok(/TaskOutput/.test(section),
      'the contract must mention TaskOutput by name');
    assert.ok(/agent ID is NOT a task ID|agent ID is not a task ID/i.test(section),
      'the contract must state an agent ID is not a task ID');
  });

  test('a lost handoff has a recovery path (preserve checkpoint + resume)', () => {
    // Pin the CANONICAL colon form — the retired /gsd-debug hyphen syntax is
    // rejected by the slash-command-namespace guard, so this must be /gsd:debug.
    assert.ok(/\/gsd:debug continue \{slug\}/.test(section),
      'the contract must point to /gsd:debug continue {slug} (canonical colon form) as the resume path');
    assert.ok(/do not claim|do NOT claim/i.test(section),
      'the contract must forbid claiming a lost-handoff session is still running');
  });
});

// Tests for #2257 (folded from tests/fix-2257-debug-nonterminal-resume.test.cjs):
// the /gsd-debug orchestrator had no contract for a foreground
// gsd-debug-session-manager return that is usable but non-terminal. Section 4
// "Session Management" (and the `continue` subcommand's return handling in
// Section 1c) recognized only two literal-string returns — `DEBUG SESSION
// COMPLETE` and `ABANDONED` — with no else branch. Any other return (e.g. a
// mid-investigation progress summary emitted when the manager's own
// turn/context budget runs out) matched neither and fell through to the user
// as if the debug session were complete, silently abandoning the
// investigation mid-flight.
//
// The fix defines an explicit non-terminal marker, `CONTINUE_REQUIRED`, that
// the session manager emits when it must stop before reaching a terminal
// state (distinct from the two terminal returns and from a genuine
// user-input/approval `CHECKPOINT REACHED`, which already correctly pauses
// via AskUserQuestion). The orchestrator treats anything that is not one of
// the two terminal markers as non-terminal and auto-resumes by re-spawning
// the session manager from the on-disk checkpoint, bounded by an anti-loop
// guard.
//
// Correction (orthogonal review): the first cut of the anti-loop guard
// required BOTH `next_action` AND `updated` to be unchanged across two
// resumes to detect no-progress — but `agents/gsd-debugger.md` overwrites
// `updated` on every checkpoint write ("Update the file BEFORE taking
// action"), so `updated` changes every cycle and the AND-condition could
// never be true, making the guard dead (unbounded auto-resume / DoS
// regression). The corrected guard keys no-progress detection off
// `next_action` ALONE and adds an absolute, content-independent hard cap of
// 3 total auto-resumes per slug per `/gsd:debug` invocation as the real
// termination bound.
describe('#2257 debug non-terminal session-manager return contract', () => {
  const DEBUG_MD_2257 = path.join(__dirname, '..', 'gsd-core', 'workflows', 'debug.md');
  const SESSION_MANAGER_MD = path.join(__dirname, '..', 'agents', 'gsd-debug-session-manager.md');

  // allow-test-rule: source-text-is-the-product (#2257)
  // workflow/agent prose IS the runtime contract under test
  const debugContent = fs.readFileSync(DEBUG_MD_2257, 'utf-8');
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

// Tests for #3448 (folded into the owning module's test file per
// lint-regression-test-names): after a legitimate mid-investigation checkpoint is
// answered (e.g. a native permission prompt for the first focused RED command) and the
// session-manager instance returns non-terminal (## CONTINUE_REQUIRED — its own
// turn/context budget ran out), the orchestrator's auto-resume re-spawned
// gsd-debug-session-manager with IDENTICAL session_params. The respawn was therefore
// prompt-indistinguishable from a cold start: the durable checkpoint's recorded
// next_action — read only for terminal classification and the blocker message — never
// reached the respawned agent, and neither did the fact that the earlier checkpoint had
// already been answered. Two auto-resumes then made no progress and the
// (correctly-behaving) no-progress guard stopped the loop, even though everything needed
// to proceed was on disk.
//
// The fix threads resume state through BOTH orchestrator call sites (Section 1c
// `continue` return handling and Section 4's non-terminal branch — textual duplicates,
// so fixing one leaves the other broken) and makes the manager's Step 2 gsd-debugger
// template consume it, using Step 3d's DATA_START/DATA_END checkpoint-response shape.
// The anti-loop guard itself (next_action-only heuristic + absolute 3-resume hard cap)
// is deliberately NOT weakened — out of scope, confirmed correct.
describe('#3448 debug auto-resume must thread the recorded next_action', () => {
  const debugContent3448 = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'debug.md'),
    'utf-8'
  );
  const managerContent3448 = fs.readFileSync(
    path.join(__dirname, '..', 'agents', 'gsd-debug-session-manager.md'),
    'utf-8'
  );

  const section4Start3448 = debugContent3448.indexOf('## 4. Session Management');
  const section43448 = section4Start3448 !== -1 ? debugContent3448.slice(section4Start3448) : '';

  const section1cStart3448 = debugContent3448.indexOf('## 1c. CONTINUE subcommand');
  const section1dStart3448 = debugContent3448.indexOf('## 1d. Check Active Sessions');
  const section1c3448 =
    section1cStart3448 !== -1 && section1dStart3448 !== -1
      ? debugContent3448.slice(section1cStart3448, section1dStart3448)
      : '';

  test('both auto-resume sections exist', () => {
    assert.notEqual(section4Start3448, -1, 'debug.md must contain Section 4');
    assert.notEqual(section1cStart3448, -1, 'debug.md must contain Section 1c');
  });

  // AC1 + AC3: the resume spawn must carry the checkpoint's recorded next_action,
  // symmetrically across both resume trigger paths.
  for (const [label, section] of [['Section 4', section43448], ['Section 1c', section1c3448]]) {
    describe(`${label} resume spawn (#3448)`, () => {
      test('forwards the recorded next_action into the resume spawn parameters', () => {
        assert.ok(
          /resume_next_action/i.test(section),
          `${label} must pass the checkpoint's next_action into the respawn as an explicit resume parameter (not just read it for classification)`
        );
        assert.ok(
          /next_action.{0,200}from.{0,40}\.planning\/debug\/\{sl?ug\}\.md/i.test(section) ||
            /\.planning\/debug\/\{sl?ug\}\.md.{0,120}next_action/i.test(section),
          `${label} must source resume_next_action from the on-disk checkpoint file`
        );
      });

      test('forwards the checkpoint status so the respawn is not a cold start', () => {
        assert.ok(
          /resume_status/i.test(section),
          `${label} must pass the checkpoint's status into the respawn`
        );
      });

      test('resume spawn is explicitly NOT parameter-identical to the original spawn', () => {
        assert.ok(
          /not.{0,30}identical session_params|session_params.{0,80}plus|plus.{0,40}resume/i.test(section),
          `${label} must append resume parameters to (not reuse verbatim) the original session_params — an identical-params respawn is the #3448 stall`
        );
      });

      test('states the prior answered checkpoint must not be re-raised', () => {
        assert.ok(
          /already (been )?answered|answered checkpoint/i.test(section),
          `${label} must carry the disposition that an earlier checkpoint was already answered, so the respawn does not re-raise it`
        );
      });
    });
  }

  // AC1 + AC4: the manager must consume what the orchestrator now sends.
  describe('gsd-debug-session-manager.md consumes resume state (#3448)', () => {
    test('session_parameters documents the resume parameters', () => {
      assert.ok(/resume_next_action/i.test(managerContent3448),
        'the session_parameters list must document resume_next_action');
      assert.ok(/resume_status/i.test(managerContent3448),
        'the session_parameters list must document resume_status');
    });

    test("Step 2's gsd-debugger prompt conditionally carries the recorded next_action, DATA-bounded", () => {
      const step2Start = managerContent3448.indexOf('## Step 2: Spawn gsd-debugger Agent');
      const step3Start = managerContent3448.indexOf('## Step 3: Handle Agent Return');
      assert.ok(step2Start !== -1 && step3Start !== -1, 'Step 2 must exist');
      const step2 = managerContent3448.slice(step2Start, step3Start);
      assert.ok(
        /resume_next_action/i.test(step2),
        'Step 2 template must reference resume_next_action when present'
      );
      assert.ok(
        /DATA_START[\s\S]{0,600}resume_next_action[\s\S]{0,600}DATA_END/i.test(step2),
        'the forwarded next_action must be bounded by DATA_START/DATA_END (checkpoint content is data — Step 3d shape)'
      );
    });

    test("Step 2 instructs the debugger to proceed directly on the recorded next action without re-raising answered checkpoints", () => {
      const step2Start = managerContent3448.indexOf('## Step 2: Spawn gsd-debugger Agent');
      const step3Start = managerContent3448.indexOf('## Step 3: Handle Agent Return');
      const step2 = managerContent3448.slice(step2Start, step3Start);
      assert.ok(
        /proceed (directly )?on|resume (from|with)|pick up/i.test(step2),
        'Step 2 must tell the resumed debugger to act on the recorded next action'
      );
      assert.ok(
        /already (been )?answered|do not re-?raise/i.test(step2),
        'Step 2 must state that prior checkpoints were already answered and must not be re-raised'
      );
    });
  });

  // AC2: the circuit breaker must survive the fix unchanged.
  describe('anti-loop guard unchanged by the #3448 fix (out-of-scope surface)', () => {
    test('no-progress heuristic still keys off next_action alone with the 3-resume hard cap in both sections', () => {
      for (const [label, section] of [['Section 4', section43448], ['Section 1c', section1c3448]]) {
        assert.ok(/anti-loop guard/i.test(section), `${label} must still name the anti-loop guard`);
        assert.ok(/\b3\b/.test(section) && /total auto-resumes/i.test(section),
          `${label} must still encode the absolute 3-total-auto-resume hard cap`);
        assert.ok(/next_action.{0,5}UNCHANGED/i.test(section),
          `${label} no-progress detection must still compare next_action across resumes`);
      }
    });

    test('resume directive must not suppress genuinely NEW human-input checkpoints', () => {
      assert.ok(
        /genuine|new human|pending user|AskUserQuestion/i.test(managerContent3448),
        'the manager must still route genuine user-input checkpoints through AskUserQuestion (Step 3d), independent of resume dispatch'
      );
    });
  });
});

// Tests for #4395: the orchestrator's own spawn of gsd-debug-session-manager
// carries `run_in_background: false` (#2196), but the manager's OWN Step 2
// spawn of its internal gsd-debugger sub-agent did not — Claude Code
// backgrounds subagents by default, so that nested spawn could return before
// gsd-debugger genuinely finished. The manager then reached Step 3/Step 4 with
// no real completion behind it, returned a non-terminal summary, the
// orchestrator's (correctly-behaving) #2257 auto-resume re-spawned a fresh
// session manager, and THAT spawned a second gsd-debugger — colliding with
// the still-live first one on the same `.planning/debug/{slug}.md` file.
// Reported 3x in one /gsd:debug invocation, surfaced only because a peer
// agent self-reported the write collision.
//
// The fix adds the same `run_in_background: false` requirement to the
// manager's Step 2 spawn that #2196 already established for the
// orchestrator's spawn of the manager one level up, so gsd-debugger can never
// be left running detached across a Step 3/Step 4 return.
describe('#4395 gsd-debug-session-manager gsd-debugger spawn must be blocking', () => {
  const SESSION_MANAGER_MD_4395 = path.join(__dirname, '..', 'agents', 'gsd-debug-session-manager.md');
  // allow-test-rule: source-text-is-the-product (#4395)
  // agent prose IS the runtime contract under test
  const managerContent4395 = fs.readFileSync(SESSION_MANAGER_MD_4395, 'utf-8');

  const step2Start4395 = managerContent4395.indexOf('## Step 2: Spawn gsd-debugger Agent');
  const step3Start4395 = managerContent4395.indexOf('## Step 3: Handle Agent Return');
  const step2Section4395 = step2Start4395 !== -1 && step3Start4395 !== -1
    ? managerContent4395.slice(step2Start4395, step3Start4395)
    : '';

  test('Step 2 exists', () => {
    assert.notEqual(step2Start4395, -1, 'gsd-debug-session-manager.md must contain Step 2');
  });

  test('the gsd-debugger Agent() spawn carries run_in_background: false', () => {
    assert.ok(/run_in_background\s*[:=]\s*false/.test(step2Section4395),
      'Step 2 gsd-debugger spawn must declare run_in_background: false so it is never left running detached');
  });

  test('Step 2 documents WHY the spawn must be blocking (references the #2196 precedent and the collision failure mode)', () => {
    assert.ok(/#2196/.test(step2Section4395),
      'Step 2 must reference #2196 as the precedent for this same blocking requirement one level up');
    assert.ok(/detached|collid/i.test(step2Section4395),
      'Step 2 must explain the failure mode this guards against (a detached/colliding second gsd-debugger)');
  });
});
