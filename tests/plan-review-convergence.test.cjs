/**
 * Tests for gsd:plan-review-convergence command (#2306)
 *
 * Validates that the command source and workflow contain the key structural
 * elements required for correct cross-AI plan convergence loop behavior:
 * initial planning gate, review agent spawning, CYCLE_SUMMARY contract for
 * unresolved review count extraction, stall detection, escalation gate, and STATE.md update
 * on convergence.
 *
 * v2 additions (#2306-v2):
 * - CYCLE_SUMMARY contract replaces raw grep (prevents false stalls from
 *   accumulated REVIEWS.md history across cycles)
 * - workflow.plan_review_convergence config gate (disabled by default)
 * - --ws forwarded to review agent (symmetric with replan agent)
 * - PARTIALLY RESOLVED / FULLY RESOLVED definitions in contract
 * - HIGH_LINES validation warning when HIGH_COUNT > 0 but section absent
 * - Success criteria updated to reflect CYCLE_SUMMARY parsing
 *
 * v3 additions (#724):
 * - CYCLE_SUMMARY includes current_actionable for unresolved actionable MEDIUM/LOW findings
 * - convergence requires HIGH_COUNT == 0 and ACTIONABLE_COUNT == 0
 * - reviews-mode planner/checker prompts require REVIEWS.md feedback to land in PLAN.md
 */

// allow-test-rule: source-text-is-the-product
// The workflow markdown IS the runtime instruction. Testing its text content
// tests the deployed contract — if the CYCLE_SUMMARY requirement is absent,
// the false-stall bug is absent from defenses too.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { readFileNormalized, readWorkflowCombined, createTempDir, cleanup } = require('./helpers.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('fast-check');

const COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'plan-review-convergence.md');
const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-review-convergence.md');
const CONFIG_DOC_PATH = path.join(__dirname, '..', 'docs', 'CONFIGURATION.md');
const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const PLANNER_REVIEWS_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-reviews.md');
const PLAN_CHECKER_PATH = path.join(__dirname, '..', 'agents', 'gsd-plan-checker.md');

// #2315: the workflow's reviewer-resolution block pipes through `jq`, which is
// a documented production dependency (review.md:244 "install jq if missing")
// but is NOT present in every test container (gsd-test's linux-node{22,24}
// images lack it; see tests/opencode-review-reconstruction.property.test.cjs
// for the same skip pattern). Behavioral tests that exercise the deployed jq
// pipeline skip when jq is absent; structural tests still run.
let jqAvailable = false;
try { execFileSync('jq', ['--version'], { stdio: 'ignore', timeout: 10000, killSignal: 'SIGKILL' }); jqAvailable = true; } catch { /* no jq on PATH */ }

// #2800: the hand-written per-flag `grep -q '\-\-<flag>'` whitelist lines were
// replaced by a loop deriving REVIEWER_FLAGS from `gsd_run review-lane flags`
// (the declared lane roster). These helpers extract the REAL deployed parse
// block (`REVIEWER_FLAGS=""` through the closing `done` of the for-loop) and
// execute it under a real `gsd_run` shim backed by the actual gsd-tools.cjs
// binary, so behavioral coverage proves pass-through against the real
// implementation rather than a stale hand-written literal. POSIX-only —
// callers must skip on win32.
const GSD_TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function extractReviewerFlagsParseBlock(workflowText) {
  const startIdx = workflowText.indexOf('REVIEWER_FLAGS=""');
  const doneIdx = workflowText.indexOf('\ndone\n', startIdx);
  if (startIdx === -1 || doneIdx === -1) return null;
  return workflowText.slice(startIdx, doneIdx + '\ndone'.length);
}

function runReviewerFlagsParseBlock(block, args) {
  const stub = 'gsd_run() { node "$GSD_TOOLS_PATH" "$@"; }';
  const script = `${stub}\n${block}\nprintf "%s" "$REVIEWER_FLAGS"`;
  return execFileSync('bash', ['-c', script], {
    env: { ...process.env, ARGUMENTS: args, GSD_TOOLS_PATH },
    encoding: 'utf8',
    // 30s covers the nested bash → node → gsd-tools.cjs cold-start chain this
    // helper spawns. 5s was too tight: on a loaded bench (30k tests running
    // in parallel) that budget was consumed by process-spawn scheduling
    // latency alone, producing a spurious ETIMEDOUT with no genuine hang.
    // 30_000 matches the convention other script-invocation tests in this
    // repo already use (see e.g. adr-index-gate.test.cjs, check-env.test.cjs).
    timeout: 30_000,
  }).trim();
}

// ─── Command source ────────────────────────────────────────────────────────

describe('plan-review-convergence command source (#2306)', () => {
  const command = fs.readFileSync(COMMAND_PATH, 'utf8');

  test('command name uses gsd: prefix (installer converts to gsd- on install)', () => {
    assert.ok(
      command.includes('name: gsd:plan-review-convergence'),
      'command name must use gsd: prefix so installer converts it to gsd-plan-review-convergence'
    );
  });

  test('command declares all reviewer flags in context', () => {
    assert.ok(command.includes('--codex'), 'must document --codex flag');
    assert.ok(command.includes('--gemini'), 'must document --gemini flag');
    assert.ok(command.includes('--claude'), 'must document --claude flag');
    assert.ok(command.includes('--opencode'), 'must document --opencode flag');
    assert.ok(command.includes('--all'), 'must document --all flag');
    assert.ok(command.includes('--max-cycles'), 'must document --max-cycles flag');
  });

  test('command documents local model reviewer flags (--ollama, --lm-studio, --llama-cpp)', () => {
    assert.ok(command.includes('--ollama'), 'must document --ollama flag for local Ollama server');
    assert.ok(command.includes('--lm-studio'), 'must document --lm-studio flag for local LM Studio server');
    assert.ok(command.includes('--llama-cpp'), 'must document --llama-cpp flag for local llama.cpp server');
  });

  // #2293: the 1.7.0 Antigravity adapter (successor to the discontinued Gemini
  // CLI) was unreachable from convergence because its reviewer whitelist dropped
  // --agy/--antigravity. The flag must be documented and in the argument-hint.
  test('command documents the --agy / --antigravity reviewer flag (#2293)', () => {
    assert.ok(command.includes('--agy'), 'must document --agy flag (Antigravity CLI reviewer)');
    assert.ok(command.includes('--antigravity'), 'must document the --antigravity alias');
  });

  test('argument-hint advertises --agy (#2293)', () => {
    const hint = command.match(/^argument-hint:\s*"(.*)"\s*$/m);
    assert.ok(hint, 'command must declare an argument-hint');
    assert.ok(hint[1].includes('--agy'), `argument-hint must list --agy, got: ${hint[1]}`);
  });

  test('command references the workflow file via execution_context', () => {
    assert.ok(
      command.includes('@$HOME/.claude/gsd-core/workflows/plan-review-convergence.md'),
      'execution_context must reference the workflow file'
    );
  });

  test('command references supporting reference files', () => {
    assert.ok(
      command.includes('revision-loop.md'),
      'must reference revision-loop.md for stall detection pattern'
    );
    assert.ok(
      command.includes('gates.md'),
      'must reference gates.md for gate taxonomy'
    );
    assert.ok(
      command.includes('agent-contracts.md'),
      'must reference agent-contracts.md for completion markers'
    );
  });

  test('command declares Agent in allowed-tools (required for spawning review sub-agents)', () => {
    assert.ok(
      command.includes('- Agent'),
      'Agent must be in allowed-tools — command spawns isolated agents for reviewing'
    );
  });

  test('command declares Skill in allowed-tools (required for inline plan-phase invocations)', () => {
    assert.ok(
      command.includes('- Skill'),
      'Skill must be in allowed-tools — command invokes gsd-plan-phase inline via Skill() at depth 0 (#936 fix)'
    );
  });

  test('command has Copilot runtime_note for AskUserQuestion fallback', () => {
    assert.ok(
      command.includes('vscode_askquestions'),
      'must document vscode_askquestions fallback for Copilot compatibility'
    );
  });

  test('--codex is the default reviewer when no flag is given AND review.default_reviewers is unset (#2315)', () => {
    // #2315: a bare invocation now respects review.default_reviewers per
    // ADR-0011. The command must document that --codex is the default ONLY
    // when review.default_reviewers is unset; otherwise the configured default
    // wins. The pre-fix claim ("default if no reviewer specified") was the
    // user-facing mirror of the #2315 bug.
    assert.ok(
      command.includes('default if no reviewer flag given') &&
      command.includes('review.default_reviewers'),
      'command must document that --codex is the default ONLY when review.default_reviewers is unset (#2315)'
    );
  });

  test('command documents the workflow.plan_review_convergence config key', () => {
    assert.ok(
      command.includes('workflow.plan_review_convergence') ||
      command.includes('plan_review_convergence'),
      'command must document the config key required to enable the feature (#2306-v2)'
    );
  });
});

// ─── #2293: Antigravity reviewer flag reachable from convergence ─────────────

describe('plan-review-convergence: --agy/--antigravity reviewer whitelist (#2293)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const SKILL_PATH = path.join(__dirname, '..', 'skills', 'gsd-plan-review-convergence', 'SKILL.md');

  test('workflow REVIEWER_FLAGS extraction derives its whitelist from review-lane flags, not a hand-written list (#2800)', () => {
    // #2800: the runtime contract used to be a hand-written grep-accumulation
    // block — one `grep -q '\-\-<flag>'` line per recognized flag. Absence meant
    // the flag was silently dropped, and that whitelist drifted three separate
    // times (--coderabbit, then --qwen/--cursor/--kimi-code, then the unanchored
    // --agy pattern matching inside --antigravity). The fix derives the whitelist
    // structurally from the declared lane roster via `gsd_run review-lane flags`,
    // so --agy/--antigravity (and every other lane flag) are guaranteed reachable
    // without being named individually here.
    assert.ok(
      workflow.includes('gsd_run review-lane flags'),
      'workflow must derive REVIEWER_FLAGS by iterating `gsd_run review-lane flags` (the declared lane roster), not a hand-written list'
    );
    // Anti-parity guard: re-introducing a hand-enumerated per-flag whitelist line
    // (the exact shape of the pre-#2800 bug) must fail this test, even though the
    // structural loop above would still make --agy/--antigravity work — a FUTURE
    // flag added only to a resurrected hand list, and never to the descriptor,
    // would otherwise silently regress to the #2293 failure mode.
    assert.ok(
      !/grep -q '\\-\\-[a-zA-Z0-9-]+'\s*&&\s*REVIEWER_FLAGS=/.test(workflow),
      'workflow must NOT contain a hand-written per-flag `grep -q \'--<flag>\' && REVIEWER_FLAGS=...` whitelist line — flags must be derived from the declared lane roster (#2800), never re-enumerated by hand'
    );
  });

  test('generated SKILL.md mirrors the --agy flag (argument-hint parity)', () => {
    const skill = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(skill.includes('--agy'), 'generated SKILL.md must document --agy (regenerate via gen:plugin-skills)');
  });

  // Behavioral: execute the ACTUAL deployed REVIEWER_FLAGS parse block and
  // assert --antigravity passes through instead of being dropped. POSIX-only —
  // the block is /bin/sh-style grep pipework; skip on Windows where a bash
  // shim is not guaranteed on PATH.
  //
  // #2315: the parse block no longer applies a --codex default. The endMarker
  // was previously the unconditional `if [ -z "$REVIEWER_FLAGS" ]; then
  // REVIEWER_FLAGS="--codex"; fi` line; that line was the #2315 bug and is now
  // gone. Default resolution moved to step 1.5 after the config gate (see the
  // #2315 describe block below). The bare-invocation assertion now expects an
  // empty REVIEWER_FLAGS from the parse block — the default is applied later,
  // respecting review.default_reviewers.
  test('[behavioral] the deployed parse block passes --antigravity through (parse block no longer applies a --codex default — #2315)', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX shell extraction; not run on Windows'); return; }
    const block = extractReviewerFlagsParseBlock(workflow);
    assert.ok(block, 'the REVIEWER_FLAGS parse block must exist in the workflow');
    const run = (args) => runReviewerFlagsParseBlock(block, args);

    const agy = run('5 --antigravity');
    assert.ok(agy.split(/\s+/).includes('--antigravity'), `--antigravity must pass through, got: "${agy}"`);
    // The parse block must NOT inject --codex when an explicit flag is present.
    assert.notStrictEqual(agy, '--codex', 'must NOT produce --codex-only when --antigravity is given');

    assert.ok(run('5 --agy').split(/\s+/).includes('--agy'), '--agy short form must pass through');

    // #2315 regression: the parse block no longer applies a default. The bare
    // invocation (no flag) MUST yield an empty REVIEWER_FLAGS here; the default
    // is resolved later in step 1.5 against review.default_reviewers.
    assert.strictEqual(run('5'), '', 'no reviewer flag → empty REVIEWER_FLAGS from parse (default applied in step 1.5 per #2315)');
    const mixed = run('5 --codex --gemini');
    assert.ok(mixed.includes('--codex') && mixed.includes('--gemini'), 'existing flags still recognized');
    // --agy must not be spuriously matched by an unrelated flag (independence).
    assert.ok(!run('5 --gemini').includes('--agy'), '--gemini must not trip the --agy whitelist');
  });
});

// ─── #2315: bare invocation respects review.default_reviewers ──────────────

describe('plan-review-convergence: #2315 respects review.default_reviewers (no-flag default)', () => {
  // readFileNormalized() strips \r\n -> \n before the two behavioral tests
  // below slice a bash block out of `workflow` and hand it to
  // execFileSync('bash', ...) — an un-normalized read on a Windows checkout
  // would break bash mid-script (DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE,
  // #2650). Those two tests already skip on win32 for an unrelated POSIX-
  // shell-extraction reason, but `workflow` is shared with non-skipped
  // structural assertions in this same describe block, so normalizing here
  // is the single correct fix rather than a per-test patch.
  const workflow = readFileNormalized(WORKFLOW_PATH);
  const command = fs.readFileSync(COMMAND_PATH, 'utf8');
  const SKILL_PATH = path.join(__dirname, '..', 'skills', 'gsd-plan-review-convergence', 'SKILL.md');
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');

  // Pre-fix #2315: the workflow unconditionally set REVIEWER_FLAGS="--codex" in
  // step 1 (line 37) BEFORE the workflow.plan_review_convergence config gate.
  // gsd-review sees the injected --codex as an explicit flag (precedence rule 1)
  // and never reaches rule 3 (review.default_reviewers), silently overriding
  // any configured default — a violation of ADR-0011 and ADR-0015.
  //
  // The buggy one-liner must not appear ANYWHERE in the workflow — the post-fix
  // resolution lives in step 1.5 as a config-gated if/else/fi block, never as
  // the bare one-liner. (Earlier versions of this test only asserted the line
  // was not BEFORE the gate, which still allowed a re-introduction after the
  // gate; the assertion is now unconditional per review.)
  test('workflow does NOT contain the unconditional REVIEWER_FLAGS=--codex one-liner anywhere', () => {
    const buggyLine = 'if [ -z "$REVIEWER_FLAGS" ]; then REVIEWER_FLAGS="--codex"; fi';
    assert.strictEqual(
      workflow.indexOf(buggyLine),
      -1,
      'the unconditional --codex one-liner must not appear anywhere in the workflow (#2315); ' +
      'default resolution is conditional on review.default_reviewers in step 1.5 (if/else/fi block).'
    );
  });

  test('workflow resolves REVIEWER_FLAGS against review.default_reviewers AFTER the config gate', () => {
    const resolutionIdx = workflow.indexOf('gsd_run query config-get review.default_reviewers');
    const configGateIdx = workflow.indexOf('CONVERGENCE_ENABLED=$(gsd_run query config-get workflow.plan_review_convergence');
    assert.ok(resolutionIdx !== -1, 'workflow must query review.default_reviewers to resolve the no-flag default (#2315)');
    assert.ok(
      resolutionIdx > configGateIdx,
      'review.default_reviewers resolution must come AFTER the config gate (only runs when convergence is enabled)'
    );
  });

  test('workflow documents that empty REVIEWER_FLAGS lets gsd-review apply review.default_reviewers', () => {
    // After the fix, an empty REVIEWER_FLAGS is INTENTIONAL — it signals "let
    // gsd-review apply its own precedence (rule 3: review.default_reviewers)".
    // A comment must document this so a future maintainer does not re-add the
    // unconditional --codex fallback and resurrect the #2315 bug.
    assert.ok(
      /gsd-review applies.*review\.default_reviewers|review\.default_reviewers.*gsd-review applies/i.test(workflow),
      'workflow must document that empty REVIEWER_FLAGS lets gsd-review apply review.default_reviewers (prevent #2315 regression)'
    );
  });

  test('startup banner uses REVIEWER_DISPLAY (not raw REVIEWER_FLAGS) so users see what will actually run', () => {
    // AC4 of #2315: banner must reflect actual reviewers, not a hardcoded value.
    // When REVIEWER_FLAGS is empty (because default_reviewers is configured),
    // the banner must show the resolved default — not an empty string and not
    // a misleading "--codex". Assert the literal banner placeholder so a
    // maintainer cannot satisfy this by defining REVIEWER_DISPLAY in a comment
    // while leaving the banner pointing at REVIEWER_FLAGS.
    assert.ok(
      workflow.includes('Reviewers: {REVIEWER_DISPLAY}'),
      'startup banner must use the {REVIEWER_DISPLAY} placeholder, not {REVIEWER_FLAGS} (#2315 AC4)'
    );
    assert.ok(
      !/\bReviewers:\s*\{REVIEWER_FLAGS\}/.test(workflow),
      'startup banner must NOT reference {REVIEWER_FLAGS} directly (#2315 AC4)'
    );
  });

  test('command and skill doc both document the review.default_reviewers precedence (content parity)', () => {
    // The #2315 fix updated the --codex flag description in BOTH the command
    // (commands/gsd/plan-review-convergence.md) and the generated skill mirror
    // (skills/gsd-plan-review-convergence/SKILL.md). The two are kept in sync
    // by `npm run gen:plugin-skills`; this assertion catches a manual edit to
    // one that the other doesn't mirror. Both must mention review.default_reviewers
    // alongside the --codex default claim.
    const expected = 'review.default_reviewers';
    assert.ok(
      command.includes(expected),
      `command file must document the review.default_reviewers precedence on the --codex flag (#2315)`
    );
    assert.ok(
      skill.includes(expected),
      `skill file must mirror the command file's review.default_reviewers precedence (#2315)`
    );
  });

  // Behavioral: extract the parse block + the post-config-gate resolution block
  // and execute them with a stubbed gsd_run. Proves the matrix:
  //   - bare + default_reviewers configured → empty REVIEWER_FLAGS (gsd-review applies default)
  //   - bare + default_reviewers unset      → --codex fallback (pre-fix behavior preserved)
  //   - bare + empty-array default          → --codex fallback (defensive — schema would reject)
  //   - explicit --gemini + default set     → --gemini wins (explicit flags unaffected, #2315 AC5)
  test('[behavioral] no-flag invocation resolves to default_reviewers when configured, --codex otherwise', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX shell extraction; not run on Windows'); return; }
    if (!jqAvailable) { t.skip('jq not on PATH — workflow resolution block pipes through jq (production dependency, review.md:244); structural tests above still validate the fix'); return; }
    const { execFileSync } = require('node:child_process');

    // Parse block: the REAL deployed REVIEWER_FLAGS derivation loop (#2800), from
    // `REVIEWER_FLAGS=""` through the closing `done`. It calls `gsd_run review-lane
    // flags`, so the stub below delegates that specific call to the real gsd-tools.cjs
    // binary rather than a hand-maintained flag list.
    const parseBlock = extractReviewerFlagsParseBlock(workflow);
    assert.ok(parseBlock, 'parse block must exist');

    // Resolution block: the `if [ -z "$REVIEWER_FLAGS" ]; then` that appears
    // AFTER the config gate (CONVERGENCE_ENABLED=). This is the #2315 fix.
    // Extract to the closing fence of the enclosing ```bash block — the block
    // contains a nested if/else/fi, so a naive "first \nfi\n" match would stop
    // at the inner fi and yield unbalanced bash.
    const configGateIdx = workflow.indexOf('CONVERGENCE_ENABLED=$(gsd_run query config-get workflow.plan_review_convergence');
    const resolutionStart = workflow.indexOf('if [ -z "$REVIEWER_FLAGS" ]; then', configGateIdx);
    assert.ok(resolutionStart !== -1, 'post-config-gate REVIEWER_FLAGS resolution block must exist (#2315)');
    const closingFence = workflow.indexOf('\n```\n', resolutionStart);
    assert.ok(closingFence !== -1, 'could not locate closing fence of resolution block');
    const resolutionBlock = workflow.slice(resolutionStart, closingFence);

    const run = ({ args, defaultReviewers }) => {
      // Stub gsd_run: `query config-get review.default_reviewers` returns the
      // stubbed value; `review-lane flags` delegates to the REAL gsd-tools.cjs
      // binary (so the parse block's loop is genuinely exercised, not stubbed
      // into a no-op); anything else is a no-op.
      //
      // The default_reviewers value is passed via env var ($GSD_TEST_DEFAULT_REVIEWERS)
      // rather than inline-interpolated into the bash script. This avoids a quoting
      // fragility: a future test input containing a single quote would otherwise
      // break the bash single-quoted string and execute as bash. With env-var
      // handoff, the value never crosses an interpreting shell context.
      const stub = `gsd_run() { case "$*" in *"config-get review.default_reviewers"*) printf '%s' "$GSD_TEST_DEFAULT_REVIEWERS";; *"review-lane flags"*) node "$GSD_TOOLS_PATH" review-lane flags;; *) return 0;; esac; }`;
      const script = `${stub}\n${parseBlock}\n${resolutionBlock}\nprintf 'REVIEWER_FLAGS=[%s] REVIEWER_DISPLAY=[%s]' "$REVIEWER_FLAGS" "$REVIEWER_DISPLAY"`;
      return execFileSync('bash', ['-c', script], {
        env: { ...process.env, ARGUMENTS: args, GSD_TEST_DEFAULT_REVIEWERS: defaultReviewers ?? '', GSD_TOOLS_PATH },
        encoding: 'utf8',
        // 30s covers the same nested bash → node → gsd-tools.cjs cold-start
        // chain as runReviewerFlagsParseBlock above; see that helper's
        // comment for why 5s flaked under bench load.
        timeout: 30_000,
      });
    };

    // AC1: bare invocation with default_reviewers configured → empty REVIEWER_FLAGS
    // (gsd-review applies configured default per its rule 3) and banner shows the resolved default.
    let r = run({ args: '5', defaultReviewers: '["gemini","claude"]' });
    assert.ok(/REVIEWER_FLAGS=\[\s*\]/.test(r), `configured default → REVIEWER_FLAGS empty, got: "${r}"`);
    assert.ok(/review\.default_reviewers \(gemini, claude\)/.test(r), `banner shows configured default, got: "${r}"`);

    // AC2: reviewer instances participate via default_reviewers — same path.
    r = run({ args: '5', defaultReviewers: '["opencode-deepseek","opencode-mimo"]' });
    assert.ok(/REVIEWER_FLAGS=\[\s*\]/.test(r), `instance default → REVIEWER_FLAGS empty, got: "${r}"`);

    // AC3: bare invocation with default_reviewers unset → --codex fallback preserved.
    r = run({ args: '5', defaultReviewers: '' });
    assert.ok(/REVIEWER_FLAGS=\[--codex\]/.test(r), `unset default → --codex fallback, got: "${r}"`);

    // AC3 defensive: empty-array default → --codex fallback (schema rejects this, but be safe).
    r = run({ args: '5', defaultReviewers: '[]' });
    assert.ok(/REVIEWER_FLAGS=\[--codex\]/.test(r), `empty-array default → --codex fallback, got: "${r}"`);

    // AC5 (out of scope but must not regress): explicit --gemini overrides configured default.
    r = run({ args: '5 --gemini', defaultReviewers: '["claude"]' });
    assert.ok(/REVIEWER_FLAGS=\[.*--gemini.*\]/.test(r), `explicit flag wins over configured default, got: "${r}"`);
  });

  // Property test — CLAUDE.md mandates at least one fast-check (fc) property
  // test for parsers and bijective contracts. The resolution block parses the
  // configured review.default_reviewers JSON and classifies it into one of two
  // outcomes: "non-empty array → delegate to gsd-review" (REVIEWER_FLAGS empty)
  // or "anything else → fall back to --codex" (defensive — schema rejects most
  // of these at config-set time, but corruption/edge cases must not crash or
  // misclassify). Locks the contract so a future change can't subtly narrow or
  // widen the accepted shape.
  const fc = require('fast-check');
  test('[property] resolution classifies arbitrary JSON values: non-empty array → empty flags, anything else → --codex fallback', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX shell extraction; not run on Windows'); return; }
    if (!jqAvailable) { t.skip('jq not on PATH — workflow resolution block pipes through jq; structural tests above still validate the fix'); return; }

    // Re-extract the blocks (the test above proved extraction works; we re-use
    // the same logic rather than promoting to a helper to keep the test scope local).
    const parseBlock = extractReviewerFlagsParseBlock(workflow);
    const configGateIdx = workflow.indexOf('CONVERGENCE_ENABLED=$(gsd_run query config-get workflow.plan_review_convergence');
    const resolutionStart = workflow.indexOf('if [ -z "$REVIEWER_FLAGS" ]; then', configGateIdx);
    const closingFence = workflow.indexOf('\n```\n', resolutionStart);
    const resolutionBlock = workflow.slice(resolutionStart, closingFence);
    const { execFileSync } = require('node:child_process');
    const run = ({ args, defaultReviewers }) => {
      const stub = `gsd_run() { case "$*" in *"config-get review.default_reviewers"*) printf '%s' "$GSD_TEST_DEFAULT_REVIEWERS";; *"review-lane flags"*) node "$GSD_TOOLS_PATH" review-lane flags;; *) return 0;; esac; }`;
      const script = `${stub}\n${parseBlock}\n${resolutionBlock}\nprintf 'REVIEWER_FLAGS=[%s] REVIEWER_DISPLAY=[%s]' "$REVIEWER_FLAGS" "$REVIEWER_DISPLAY"`;
      return execFileSync('bash', ['-c', script], {
        env: { ...process.env, ARGUMENTS: args, GSD_TEST_DEFAULT_REVIEWERS: defaultReviewers ?? '', GSD_TOOLS_PATH },
        encoding: 'utf8',
        // 30s covers the same nested bash → node → gsd-tools.cjs cold-start
        // chain as runReviewerFlagsParseBlock above; see that helper's
        // comment for why 5s flaked under bench load.
        timeout: 30_000,
      });
    };

    // Slug pattern mirrors the schema (ADR-0011: ^[a-zA-Z0-9_-]+$).
    const slug = fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/);
    // Non-empty arrays of slugs → MUST classify as "use default" (REVIEWER_FLAGS empty).
    const nonEmptyArray = fc.array(slug, { minLength: 1, maxLength: 4 }).map((a) => JSON.stringify(a));
    // Defensive-corpus: empty array, scalar JSON, malformed JSON. All MUST fall
    // back to --codex. The schema rejects the first two at config-set time, but
    // a corruption/typo landing in the file directly would still reach this code.
    const emptyArray = fc.constant('[]');
    const scalarJson = fc.oneof(
      fc.string({ maxLength: 8 }).filter((s) => !s.includes('"')).map((s) => JSON.stringify(s)),
      fc.integer({ min: -10, max: 10 }).map((n) => JSON.stringify(n)),
      fc.constant('null'),
      fc.constant('true'),
      fc.constant('false')
    );
    const malformedJson = fc.oneof(
      fc.constant('[unclosed'),
      fc.constant('{bad json'),
      fc.constant('not json at all'),
      fc.constant('{"k":'),
      fc.string({ maxLength: 12 }).filter((s) => {
        try { JSON.parse(s); return false; } catch { return true; }
      })
    );

    // Property A: any non-empty array of slugs → empty REVIEWER_FLAGS.
    fc.assert(
      fc.property(nonEmptyArray, (dr) => /REVIEWER_FLAGS=\[\s*\]/.test(run({ args: '5', defaultReviewers: dr }))),
      { numRuns: 25 }
    );

    // Property B: anything in the defensive corpus → --codex fallback.
    fc.assert(
      fc.property(fc.oneof(emptyArray, scalarJson, malformedJson), (dr) => /REVIEWER_FLAGS=\[--codex\]/.test(run({ args: '5', defaultReviewers: dr }))),
      { numRuns: 25 }
    );
  });
});

// ─── Workflow: initialization ──────────────────────────────────────────────

describe('plan-review-convergence workflow: initialization (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow calls gsd-tools.cjs init plan-phase for initialization', () => {
    assert.ok(
      workflow.includes('gsd-tools.cjs') && workflow.includes('init') && workflow.includes('plan-phase'),
      'workflow must initialize via gsd-tools.cjs init plan-phase'
    );
  });

  test('workflow parses --max-cycles with default of 3', () => {
    assert.ok(
      workflow.includes('MAX_CYCLES') && workflow.includes('3'),
      'workflow must parse --max-cycles with default of 3'
    );
  });

  test('workflow displays a startup banner with phase number and reviewer flags', () => {
    assert.ok(
      workflow.includes('PLAN CONVERGENCE') || workflow.includes('Plan Convergence'),
      'workflow must display a startup banner'
    );
  });
});

// ─── Workflow: config gate (disabled by default) ───────────────────────────

describe('plan-review-convergence workflow: config gate (#2306-v2)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow checks workflow.plan_review_convergence config key before running', () => {
    assert.ok(
      workflow.includes('workflow.plan_review_convergence'),
      'workflow must check workflow.plan_review_convergence config key — feature is disabled by default (#2306-v2)'
    );
  });

  test('workflow exits with enable instructions when config key is false', () => {
    // Must tell the user how to enable the feature
    assert.ok(
      workflow.includes('gsd config-set workflow.plan_review_convergence true') ||
      workflow.includes('config-set workflow.plan_review_convergence'),
      'workflow must show the user how to enable the feature when disabled (#2306-v2)'
    );
  });

  test('workflow defaults config key to false (opt-in, not opt-out)', () => {
    // The config-get call must default to false, not true
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored workflow markdown, bounded prose, not adversarial input
    const configGetMatch = workflow.match(/config-get\s+workflow\.plan_review_convergence[^\r\n]*/);
    assert.ok(
      configGetMatch,
      'workflow must read workflow.plan_review_convergence via config-get'
    );
    assert.ok(
      configGetMatch[0].includes('"false"') || configGetMatch[0].includes("'false'") || configGetMatch[0].includes('false'),
      'workflow must default workflow.plan_review_convergence to false (disabled by default) (#2306-v2)'
    );
  });
});

// ─── Workflow: initial planning gate ──────────────────────────────────────

describe('plan-review-convergence workflow: initial planning gate (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow skips initial planning when plans already exist', () => {
    assert.ok(
      workflow.includes('has_plans') || workflow.includes('plan_count'),
      'workflow must check whether plans already exist before running inline planning'
    );
  });

  test('workflow runs gsd-plan-phase when no plans exist', () => {
    assert.ok(
      workflow.includes('gsd-plan-phase'),
      'workflow must invoke gsd-plan-phase when no plans exist'
    );
  });

  test('workflow errors if initial planning produces no PLAN.md files', () => {
    assert.ok(
      workflow.includes('PLAN_COUNT') || workflow.includes('plan_count'),
      'workflow must verify PLAN.md files were created after initial planning'
    );
  });
});

// ─── Workflow: convergence loop ────────────────────────────────────────────

describe('plan-review-convergence workflow: convergence loop (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow spawns isolated review agent each cycle', () => {
    assert.ok(
      workflow.includes('gsd-review'),
      'workflow must spawn Agent → gsd-review each cycle'
    );
  });

  test('workflow extracts HIGH and actionable counts from CYCLE_SUMMARY contract, NOT from grepping REVIEWS.md', () => {
    // Critical regression guard: REVIEWS.md accumulates history across cycles;
    // resolved HIGHs from cycle N remain in the file during cycle N+1 as audit trail,
    // inflating raw grep counts and causing false stalls. Counts must come from
    // the review agent's CYCLE_SUMMARY return message, not from the file.
    assert.ok(
      workflow.includes('CYCLE_SUMMARY'),
      'workflow must use CYCLE_SUMMARY contract from review agent return message, not raw grep (#2306-v2 false-stall fix)'
    );
    assert.ok(
      workflow.includes('current_high'),
      'workflow must parse current_high from CYCLE_SUMMARY line'
    );
    assert.ok(
      workflow.includes('ACTIONABLE_COUNT') && workflow.includes('current_actionable'),
      'workflow must parse current_actionable from CYCLE_SUMMARY line (#724)'
    );
  });

  test('workflow aborts if review agent omits CYCLE_SUMMARY contract', () => {
    assert.ok(
      workflow.includes('did not honor the CYCLE_SUMMARY contract') ||
      workflow.includes('CYCLE_SUMMARY contract'),
      'workflow must abort with clear error when review agent omits CYCLE_SUMMARY (#2306-v2)'
    );
  });

  test('workflow distinguishes malformed CYCLE_SUMMARY from absent CYCLE_SUMMARY', () => {
    // Helps debugging: "present but malformed" vs "completely missing" are different errors
    assert.ok(
      workflow.includes('malformed') ||
      (workflow.includes('CYCLE_SUMMARY') && workflow.includes('present')),
      'workflow must distinguish malformed CYCLE_SUMMARY from absent one for debuggability (#2306-v2)'
    );
  });

  test('workflow fails closed when current_actionable is missing or malformed', () => {
    assert.ok(
      workflow.includes('current_actionable is missing or malformed'),
      'missing or malformed current_actionable must abort instead of silently treating actionable findings as zero (#724)'
    );
  });

  test('review agent spawn forwards --ws via GSD_WS (symmetric with replan agent)', () => {
    // Critical correctness bug: if GSD_WS is not forwarded to the review agent,
    // the review reads from the wrong workspace while replanning reads from the correct one.
    const reviewAgentBlock = workflow.match(/gsd-review['"`,\s][\s\S]{0,300}?GSD_WS/);
    assert.ok(
      reviewAgentBlock ||
      (workflow.includes("'gsd-review'") && workflow.includes('{GSD_WS}') &&
       workflow.indexOf('{GSD_WS}') < workflow.indexOf("'gsd-plan-phase'")),
      'review agent spawn must forward {GSD_WS} — workspace flag must reach the reviewer (#2306-v2 --ws fix)'
    );
  });

  test('workflow exits loop only when HIGH_COUNT and ACTIONABLE_COUNT are zero', () => {
    assert.ok(
      workflow.includes('HIGH_COUNT == 0 and ACTIONABLE_COUNT == 0'),
      'workflow must require both HIGH_COUNT and ACTIONABLE_COUNT to be zero before convergence (#724)'
    );
    assert.ok(
      workflow.includes('If HIGH_COUNT > 0 or ACTIONABLE_COUNT > 0'),
      'current_high=0 with current_actionable>0 must continue to replan/escalation instead of converging (#724)'
    );
  });

  test('workflow updates STATE.md on convergence', () => {
    assert.ok(
      workflow.includes('planned-phase') || workflow.includes('state'),
      'workflow must update STATE.md via gsd-tools.cjs when converged'
    );
  });

  test('workflow invokes inline replan with --reviews flag', () => {
    assert.ok(
      workflow.includes('--reviews'),
      'inline replan must pass --reviews so gsd-plan-phase incorporates review feedback'
    );
  });

  test('workflow passes --skip-research to inline replan (research already done)', () => {
    assert.ok(
      workflow.includes('--skip-research'),
      'inline replan must skip research — only initial planning needs research'
    );
  });
});

// ─── Workflow: CYCLE_SUMMARY contract definition ──────────────────────────

describe('plan-review-convergence workflow: CYCLE_SUMMARY contract definition (#2306-v2)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('review agent prompt defines CYCLE_SUMMARY current_high/current_actionable format', () => {
    assert.ok(
      workflow.includes('CYCLE_SUMMARY: current_high=<N> current_actionable=<M>'),
      'review agent spawn prompt must define the CYCLE_SUMMARY current_high/current_actionable output format (#724)'
    );
  });

  test('CYCLE_SUMMARY contract defines PARTIALLY RESOLVED (acknowledged, mitigation incomplete)', () => {
    assert.ok(
      workflow.includes('PARTIALLY RESOLVED'),
      'CYCLE_SUMMARY INCLUDE list must define PARTIALLY RESOLVED — prevents under-counting of in-progress issues (#2306-v2)'
    );
  });

  test('CYCLE_SUMMARY contract defines FULLY RESOLVED (verified/closed)', () => {
    assert.ok(
      workflow.includes('FULLY RESOLVED'),
      'CYCLE_SUMMARY EXCLUDE list must define FULLY RESOLVED — prevents over-counting of closed issues (#2306-v2)'
    );
  });

  test('CYCLE_SUMMARY contract requires ## Current HIGH Concerns section in review return', () => {
    assert.ok(
      workflow.includes('## Current HIGH Concerns'),
      'review agent must provide ## Current HIGH Concerns section so escalation gate can show specific issues (#2306-v2)'
    );
  });

  test('CYCLE_SUMMARY contract defines ACTIONABLE non-HIGH findings and requires their section', () => {
    assert.ok(
      workflow.includes('ACTIONABLE') && workflow.includes('Current Actionable Non-HIGH Concerns'),
      'review agent must define actionable non-HIGH findings and list current unresolved actionable items (#724)'
    );
  });
});

// ─── Workflow: HIGH_LINES validation ──────────────────────────────────────

describe('plan-review-convergence workflow: HIGH_LINES validation (#2306-v2)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow warns when HIGH_COUNT > 0 but ## Current HIGH Concerns section is absent', () => {
    // Prevents silent UX degradation: escalation gate shows blank concern list
    assert.ok(
      workflow.includes('HIGH_LINES') &&
      (workflow.includes('incomplete escalation') || workflow.includes('Current HIGH Concerns')),
      'workflow must warn when HIGH_COUNT > 0 but HIGH_LINES is empty (contract partially violated) (#2306-v2)'
    );
  });

  test('workflow warns when ACTIONABLE_COUNT > 0 but actionable section is absent', () => {
    assert.ok(
      workflow.includes('ACTIONABLE_LINES') &&
      workflow.includes('Current Actionable Non-HIGH Concerns'),
      'workflow must warn when ACTIONABLE_COUNT > 0 but actionable details are empty (#724)'
    );
  });
});

// ─── Workflow: stall detection ─────────────────────────────────────────────

describe('plan-review-convergence workflow: stall detection (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow tracks previous unresolved count to detect stalls', () => {
    assert.ok(
      workflow.includes('prev_unresolved_count'),
      'workflow must track the previous total unresolved review count for stall detection (#724)'
    );
  });

  test('workflow warns when unresolved count is not decreasing', () => {
    assert.ok(
      workflow.includes('stall') || workflow.includes('Stall') || workflow.includes('not decreasing'),
      'workflow must warn user when unresolved review count is not decreasing between cycles'
    );
  });
});

// ─── Workflow: escalation gate ────────────────────────────────────────────

describe('plan-review-convergence workflow: escalation gate (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow escalates to user when max cycles reached with HIGHs remaining', () => {
    assert.ok(
      workflow.includes('MAX_CYCLES') &&
      (workflow.includes('AskUserQuestion') || workflow.includes('vscode_askquestions')),
      'workflow must escalate to user via AskUserQuestion when max cycles reached'
    );
  });

  test('escalation offers "Proceed anyway" option', () => {
    assert.ok(
      workflow.includes('Proceed anyway'),
      'escalation gate must offer "Proceed anyway" to accept plans with remaining HIGH concerns'
    );
  });

  test('escalation offers "Manual review" option', () => {
    assert.ok(
      workflow.includes('Manual review') || workflow.includes('manual'),
      'escalation gate must offer a manual review option'
    );
  });

  test('workflow has text-mode fallback for escalation (plain numbered list)', () => {
    assert.ok(
      workflow.includes('TEXT_MODE') || workflow.includes('text_mode'),
      'workflow must support TEXT_MODE for plain-text escalation prompt'
    );
  });

  test('#3771 "Proceed anyway" is withheld at max cycles when a plan-revision conflict is open', () => {
    const maxCyclesSection = workflow.slice(workflow.indexOf('**Max cycles check:**'));
    const branchPoint = maxCyclesSection.indexOf('**Otherwise (`OPEN_CONFLICTS` == 0):**');
    assert.notEqual(branchPoint, -1,
      'the max-cycles escalation must branch on OPEN_CONFLICTS before offering "Proceed anyway"');
    const openConflictBranch = maxCyclesSection.slice(0, branchPoint);
    const noConflictBranch = maxCyclesSection.slice(branchPoint);
    // Match the actual OFFER shapes (a numbered option or an AskUserQuestion label), not any
    // sentence that merely mentions the phrase while explaining it is withheld.
    const offersProceedAnyway = (text) =>
      /1\.\s*Proceed anyway/.test(text) || /label:\s*"Proceed anyway"/.test(text);
    assert.ok(!offersProceedAnyway(openConflictBranch),
      'an open plan-revision conflict is a blocker — the branch reached while OPEN_CONFLICTS > 0 must never offer to accept it silently');
    assert.match(openConflictBranch, /blocker/i,
      'the open-conflict branch must tell the user why "Proceed anyway" is unavailable');
    assert.ok(offersProceedAnyway(noConflictBranch),
      '"Proceed anyway" must still be offered when there is no open conflict, only HIGH/actionable concerns');
  });
});

// ─── Workflow: stall detection — behavioral ───────────────────────────────

describe('plan-review-convergence workflow: stall detection behavioral (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow surfaces stall warning when unresolved count stops decreasing', () => {
    assert.ok(
      workflow.includes('prev_unresolved_count'),
      'workflow must track prev_unresolved_count across cycles (#724)'
    );
    assert.ok(
      workflow.includes('UNRESOLVED_COUNT >= prev_unresolved_count') ||
      workflow.includes('not decreasing'),
      'workflow must compare current unresolved count against previous to detect stall (#724)'
    );
    assert.ok(
      workflow.includes('stall') || workflow.includes('Stall') || workflow.includes('not decreasing'),
      'workflow must emit a stall warning when unresolved review count is not decreasing'
    );
  });
});

// ─── Workflow: --max-cycles 1 immediate escalation — behavioral ────────────

describe('plan-review-convergence workflow: --max-cycles 1 immediate escalation behavioral (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow escalates immediately after cycle 1 when --max-cycles 1 and HIGH > 0', () => {
    assert.ok(
      workflow.includes('cycle >= MAX_CYCLES') ||
      workflow.includes('cycle >= max_cycles') ||
      (workflow.includes('MAX_CYCLES') && workflow.includes('AskUserQuestion')),
      'workflow must check cycle >= MAX_CYCLES so --max-cycles 1 triggers escalation after first cycle'
    );
    assert.ok(
      workflow.includes('HIGH_COUNT > 0') ||
      workflow.includes('ACTIONABLE_COUNT > 0') ||
      workflow.includes('HIGH concerns remain') ||
      workflow.includes('Proceed anyway'),
      'escalation gate must be reachable when unresolved findings remain after a single cycle'
    );
  });
});

// ─── Workflow: REVIEWS.md verification ────────────────────────────────────

describe('plan-review-convergence workflow: artifact verification (#2306)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow verifies REVIEWS.md exists after each review cycle', () => {
    assert.ok(
      workflow.includes('REVIEWS.md') || workflow.includes('REVIEWS_FILE'),
      'workflow must verify REVIEWS.md was produced by the review agent each cycle'
    );
  });

  test('workflow errors if review agent does not produce REVIEWS.md', () => {
    assert.ok(
      workflow.includes('REVIEWS_FILE') || workflow.includes('review agent did not produce'),
      'workflow must error if the review agent fails to produce REVIEWS.md'
    );
  });
});

// ─── Workflow: success criteria ────────────────────────────────────────────

describe('plan-review-convergence workflow: success criteria (#2306-v2)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('success criteria references CYCLE_SUMMARY parsing, not grep findings', () => {
    const successBlock = workflow.slice(workflow.lastIndexOf('<success_criteria>'));
    assert.ok(
      (successBlock.includes('CYCLE_SUMMARY') || successBlock.includes('parse')) &&
        successBlock.includes('actionable non-HIGH'),
      'success_criteria must reflect that orchestrator parses HIGH and actionable CYCLE_SUMMARY counts, not greps REVIEWS.md (#724)'
    );
    assert.ok(
      !successBlock.includes('grep HIGHs'),
      'success_criteria must NOT say "grep HIGHs" — that was the false-stall bug (#2306-v2)'
    );
  });
});

// ─── Config schema registration ───────────────────────────────────────────

describe('plan-review-convergence config schema registration (#2306-v2)', () => {
  // After Cycle 5 (#3536), config-schema.cjs is a thin adapter sourcing from
  // the manifest. Use the runtime Set instead of text-parsing the source file.
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

  test('workflow.plan_review_convergence is registered in config-schema.cjs', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.plan_review_convergence'),
      "workflow.plan_review_convergence must be registered in VALID_CONFIG_KEYS in config-schema.cjs so gsd config-set accepts it (#2306-v2)"
    );
  });
});

// ─── CONFIGURATION.md documentation ──────────────────────────────────────

describe('plan-review-convergence CONFIGURATION.md documentation (#2306-v2)', () => {
  const configDoc = fs.readFileSync(CONFIG_DOC_PATH, 'utf8');

  test('workflow.plan_review_convergence is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('workflow.plan_review_convergence'),
      'workflow.plan_review_convergence must be documented in docs/CONFIGURATION.md — schema/docs parity test enforces this (#2306-v2)'
    );
  });

  test('CONFIGURATION.md entry documents disabled-by-default behavior', () => {
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored docs/CONFIGURATION.md, bounded prose, not adversarial input
    const row = configDoc.match(/workflow\.plan_review_convergence[^\r\n]*/);
    assert.ok(row, 'workflow.plan_review_convergence row must exist in CONFIGURATION.md');
    assert.ok(
      row[0].includes('false') || row[0].includes('disabled'),
      'CONFIGURATION.md entry must document that the feature defaults to false (disabled by default) (#2306-v2)'
    );
  });
});

// ─── Reviews-mode incorporation contract (#724) ────────────────────────────

describe('plan-review-convergence reviews-mode incorporation contract (#724)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const planPhase = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
  const plannerReviews = fs.readFileSync(PLANNER_REVIEWS_PATH, 'utf8');
  const planChecker = fs.readFileSync(PLAN_CHECKER_PATH, 'utf8');

  test('workflow replans while actionable non-HIGH findings remain', () => {
    assert.ok(
      workflow.includes('Actionable MEDIUM/LOW findings must be incorporated into executable PLAN.md content'),
      'inline replan must route actionable non-HIGH findings back through plan-phase --reviews (#724)'
    );
  });

  test('plan-phase planner prompt says REVIEWS.md is feedback input, not the execution contract', () => {
    assert.ok(
      planPhase.includes('<review_incorporation_contract>') &&
        planPhase.includes('REVIEWS.md is feedback input') &&
        planPhase.includes('/gsd:execute-phase primarily consumes PLAN.md'),
      'planner prompt must explain that actionable review feedback must land in PLAN.md for execute-phase (#724)'
    );
  });

  test('plan-phase checker prompt reads REVIEWS.md in reviews mode and fails hidden actionable findings', () => {
    assert.ok(
      planPhase.includes('{reviews_path}') &&
        planPhase.includes('<review_incorporation_verification>') &&
        planPhase.includes('return `## ISSUES FOUND`'),
      'checker prompt must read REVIEWS.md and fail if actionable findings remain only there (#724)'
    );
  });

  test('planner reviews reference requires actionable findings to appear in PLAN.md or be deferred there', () => {
    assert.ok(
      plannerReviews.includes('/gsd:execute-phase primarily consumes PLAN.md') &&
        plannerReviews.includes('Every current actionable review finding') &&
        plannerReviews.includes('deferral/rejection rationale in that PLAN.md'),
      'planner reviews reference must keep REVIEWS.md from becoming a hidden execution contract (#724)'
    );
  });

  test('gsd-plan-checker has a Review Incorporation dimension for reviews mode', () => {
    assert.ok(
      planChecker.includes('Review Incorporation') &&
        planChecker.includes('current_actionable=<M>') &&
        planChecker.includes('remains only in REVIEWS.md'),
      'plan checker must validate review incorporation when REVIEWS.md is present (#724)'
    );
    // The current_actionable=<M> reference must appear in a prohibition context,
    // not as an instruction to parse machine-readable fields from REVIEWS.md.
    // The CYCLE_SUMMARY line exists only in the convergence orchestrator's return message.
    assert.ok(
      planChecker.includes('Do NOT look for') || planChecker.includes('do NOT look for'),
      'plan checker must explicitly prohibit looking for CYCLE_SUMMARY/current_actionable=<M> in REVIEWS.md — those machine-readable fields are only on the orchestrator return message, never in the file'
    );
    assert.ok(
      planChecker.includes('CYCLE_SUMMARY') &&
        (planChecker.includes('Do NOT look for') || planChecker.includes('do NOT look for')),
      'CYCLE_SUMMARY must appear in plan-checker only as a prohibited pattern, not as a parsing instruction'
    );
  });
});

// ─── Local model reviewer support ────────────────────────────────────────

describe('plan-review-convergence local model reviewer flags (#2306-local)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  // #2800: local-model flags are no longer hand-listed in the workflow — they
  // reach REVIEWER_FLAGS via the derived `gsd_run review-lane flags` loop (see
  // the #2293 describe block above). Prove pass-through behaviorally against
  // the REAL deployed parse block instead of grepping for a literal string
  // that no longer exists in the workflow source.
  test('[behavioral] --ollama, --lm-studio, --llama-cpp pass through the derived REVIEWER_FLAGS loop', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX shell extraction; not run on Windows'); return; }
    const block = extractReviewerFlagsParseBlock(workflow);
    assert.ok(block, 'the REVIEWER_FLAGS parse block must exist in the workflow');
    for (const flag of ['--ollama', '--lm-studio', '--llama-cpp']) {
      const out = runReviewerFlagsParseBlock(block, `5 ${flag}`);
      assert.ok(
        out.split(/\s+/).includes(flag),
        `${flag} must pass through the derived REVIEWER_FLAGS loop, got: "${out}"`
      );
    }
  });
});

describe('plan-review-convergence local model config schema registration (#2306-local)', () => {
  // After Cycle 5 (#3536), config-schema.cjs is a thin adapter sourcing from
  // the manifest. Use the runtime Set instead of text-parsing the source file.
  //
  // #2797 (ADR-2782 D9): these three host keys are no longer in VALID_CONFIG_KEYS
  // — they are federated to their reviewer-lane capabilities (`ollama`,
  // `lm-studio`, `llama-cpp`), and the exclusivity invariant forbids a key living
  // in both places. What #2306-local actually protects is that `gsd config-set`
  // ACCEPTS these keys, so that is what is asserted now, via isValidConfigKey —
  // the predicate config-set itself uses, which spans both the central schema and
  // federated capability slices. Asserting central membership would now be
  // asserting the migration did not happen.
  const { isValidConfigKey, isCapabilityConfigKey } =
    require('../gsd-core/bin/lib/config-schema.cjs');

  for (const key of ['review.ollama_host', 'review.lm_studio_host', 'review.llama_cpp_host']) {
    test(`${key} is accepted by config-set`, () => {
      assert.ok(
        isValidConfigKey(key),
        `${key} must be a valid config key so gsd config-set accepts it`
      );
    });

    test(`${key} is owned by its reviewer-lane capability (#2797)`, () => {
      assert.ok(
        isCapabilityConfigKey(key),
        `${key} must be federated to its lane capability, not stranded centrally`
      );
    });
  }
});

// ─── Workflow: source-grounding pass (#22) ───────────────────────────────────

describe('plan-review-convergence workflow: source-grounding reviewer pass (#22)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  test('workflow documents plan_review.source_grounding config key (default on)', () => {
    assert.ok(
      workflow.includes('plan_review.source_grounding'),
      'workflow must document the plan_review.source_grounding config key that gates the source-grounding pass (#22)'
    );
  });

  test('source-grounding section defines all four symbol verdicts and their severity mappings within the section prose', () => {
    // Extract the source-grounding section slice so verdicts buried in dead text,
    // comments, or success-criteria prose outside this section cannot produce a
    // false green.  The section runs from the '### Source-grounding pass' heading
    // to the 'After agent returns' paragraph that immediately follows it.
    const SECTION_ANCHOR = '### Source-grounding pass';
    const SECTION_END    = 'After agent returns';
    const anchorIdx = workflow.indexOf(SECTION_ANCHOR);
    assert.ok(
      anchorIdx !== -1,
      `workflow must contain a '${SECTION_ANCHOR}' heading as the canonical location for verdict definitions (#22)`
    );
    const endIdx = workflow.indexOf(SECTION_END, anchorIdx);
    assert.ok(
      endIdx !== -1,
      `'${SECTION_END}' paragraph must follow '${SECTION_ANCHOR}' to bound the section (#22)`
    );
    const section = workflow.slice(anchorIdx, endIdx);

    // ── Four verdicts must appear in the resolve-step of the section ──────────
    assert.ok(
      section.includes('VERIFIED'),
      'source-grounding section must define VERIFIED verdict within its prose (not just in surrounding text)'
    );
    assert.ok(
      section.includes('MISSING'),
      'source-grounding section must define MISSING verdict within its prose'
    );
    assert.ok(
      section.includes('AMBIGUOUS'),
      'source-grounding section must define AMBIGUOUS verdict within its prose'
    );
    assert.ok(
      section.includes('UNCHECKABLE'),
      'source-grounding section must define UNCHECKABLE verdict within its prose'
    );

    // ── Severity mappings: AMBIGUOUS→MEDIUM and UNCHECKABLE→INFO must appear
    //    on the SAME line inside the section, not just anywhere in the file ────
    const severityLine = section.split(/\r?\n/).find((line) =>
      line.includes('AMBIGUOUS') && line.includes('MEDIUM') &&
      line.includes('UNCHECKABLE') && line.includes('INFO')
    );
    assert.ok(
      severityLine !== undefined,
      'source-grounding section must have a single severity-mapping line that states ' +
      'AMBIGUOUS→MEDIUM AND UNCHECKABLE→INFO together (e.g. "**AMBIGUOUS** → MEDIUM. **UNCHECKABLE** → INFO.") (#22)'
    );

    // ── Guard the exact direction of each mapping ─────────────────────────────
    // The line must pair AMBIGUOUS with MEDIUM (not INFO) and UNCHECKABLE with
    // INFO (not MEDIUM) — a swap would be a contract bug the old tests couldn't catch.
    const ambiguousBeforeMedium = severityLine.indexOf('AMBIGUOUS') < severityLine.indexOf('MEDIUM');
    const uncheckableBeforeInfo = severityLine.indexOf('UNCHECKABLE') < severityLine.indexOf('INFO');
    assert.ok(
      ambiguousBeforeMedium,
      'severity-mapping line must list AMBIGUOUS before MEDIUM (AMBIGUOUS→MEDIUM) (#22)'
    );
    assert.ok(
      uncheckableBeforeInfo,
      'severity-mapping line must list UNCHECKABLE before INFO (UNCHECKABLE→INFO) (#22)'
    );
  });

  test('workflow specifies needs-acknowledgement gating for MISSING symbols', () => {
    assert.ok(
      workflow.includes('needs-acknowledgement'),
      'workflow must specify needs-acknowledgement (not hard block) for MISSING at grep/intel authority (#22)'
    );
  });

  test('workflow instructs reviewer to exclude symbols declared under "Artifacts this phase produces"', () => {
    assert.ok(
      workflow.includes('Artifacts this phase produces'),
      'workflow must exclude new artifacts declared by the plan from symbol verification (#22)'
    );
  });

  test('workflow requires "Verification coverage" section appended to REVIEWS.md', () => {
    assert.ok(
      workflow.includes('Verification coverage'),
      'workflow must require a Verification coverage section in REVIEWS.md listing every UNCHECKABLE/skipped symbol (#22)'
    );
  });
});

describe('plan-review-convergence local model CONFIGURATION.md documentation (#2306-local)', () => {
  const configDoc = fs.readFileSync(CONFIG_DOC_PATH, 'utf8');

  test('review.ollama_host is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.ollama_host'),
      'review.ollama_host must be documented in docs/CONFIGURATION.md'
    );
  });

  test('review.lm_studio_host is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.lm_studio_host'),
      'review.lm_studio_host must be documented in docs/CONFIGURATION.md'
    );
  });

  test('review.llama_cpp_host is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.llama_cpp_host'),
      'review.llama_cpp_host must be documented in docs/CONFIGURATION.md'
    );
  });

  test('review.models.ollama is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.models.ollama'),
      'review.models.ollama must be documented so users know how to configure the local model name'
    );
  });

  test('review.models.lm_studio is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.models.lm_studio'),
      'review.models.lm_studio must be documented so users know how to configure the local model name'
    );
  });

  test('review.models.llama_cpp is documented in CONFIGURATION.md', () => {
    assert.ok(
      configDoc.includes('review.models.llama_cpp'),
      'review.models.llama_cpp must be documented so users know how to configure the local model name'
    );
  });
});

// ─── Bug #936: plan-phase must run inline, not inside Agent() ─────────────
//
// Regression guard: inverted from the pre-#936 behavior that locked in the bug.
// On Claude Code a depth-1 Agent has no Agent tool, so gsd-plan-phase wrapped in
// Agent() cannot spawn gsd-planner / gsd-plan-checker → the replan loop breaks.
// Fix: run plan-phase inline (bare Skill()) from the depth-0 convergence orchestrator.
//
// These tests FAIL on pre-fix code and PASS after the fix.

describe('plan-review-convergence workflow: inline plan-phase dispatch (#936)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  // Helper: extract Agent() block bodies from workflow text
  function extractAgentBlocks(content) {
    const blocks = [];
    let pos = 0;
    while (pos < content.length) {
      const start = content.indexOf('Agent(', pos);
      if (start === -1) break;
      let depth = 0;
      let i = start + 'Agent('.length - 1;
      for (; i < content.length; i++) {
        if (content[i] === '(') depth++;
        else if (content[i] === ')') { depth--; if (depth === 0) break; }
      }
      blocks.push({ start, end: i + 1, blockText: content.slice(start, i + 1) });
      pos = i + 1;
    }
    return blocks;
  }

  test('initial planning does NOT wrap gsd-plan-phase inside Agent() (#936 fix)', () => {
    // Pre-fix: Agent( ... Skill('gsd-plan-phase') ... ) in step 4
    // Post-fix: bare Skill(skill="gsd-plan-phase") at orchestrator level
    const blocks = extractAgentBlocks(workflow);
    const wrapping = blocks.filter((b) =>
      /Skill\(\s*skill=['"]gsd-plan-phase['"]/.test(b.blockText)
    );
    assert.deepStrictEqual(
      wrapping.map((b) => b.blockText.slice(0, 80).replace(/\r?\n/g, '\\n')),
      [],
      'Initial planning must NOT wrap gsd-plan-phase inside Agent() — run it inline so ' +
      'it can spawn gsd-planner/gsd-plan-checker at depth 1. See: bug #936'
    );
  });

  test('replan step does NOT wrap gsd-plan-phase inside Agent() (#936 fix)', () => {
    // Same check as above; explicitly named for the replan site (step 5d)
    const blocks = extractAgentBlocks(workflow);
    const wrapping = blocks.filter((b) =>
      /Skill\(\s*skill=['"]gsd-plan-phase['"]/.test(b.blockText) &&
      /--reviews/.test(b.blockText)
    );
    assert.deepStrictEqual(
      wrapping.map((b) => b.blockText.slice(0, 80).replace(/\r?\n/g, '\\n')),
      [],
      'Replan step must NOT wrap gsd-plan-phase inside Agent() — the replan loop can ' +
      'never produce a plan on Claude Code when plan-phase is at depth 1. See: bug #936'
    );
  });

  test('workflow calls gsd-plan-phase inline (bare Skill outside Agent block) (#936 fix)', () => {
    // After the fix there must be at least one bare Skill(skill="gsd-plan-phase")
    // OUTSIDE any Agent() block.
    const blocks = extractAgentBlocks(workflow);
    let masked = workflow;
    const sorted = [...blocks].sort((a, b) => b.start - a.start);
    for (const b of sorted) {
      masked = masked.slice(0, b.start) + ' '.repeat(b.end - b.start) + masked.slice(b.end);
    }
    assert.ok(
      /Skill\(\s*skill=["']gsd-plan-phase["']/.test(masked),
      'plan-review-convergence must contain at least one bare Skill(skill="gsd-plan-phase") ' +
      'outside any Agent() block — the inline call that preserves depth-0 Agent availability. See: bug #936'
    );
  });

  test('success_criteria describes inline plan-phase, not Agent → Skill (#936 fix)', () => {
    const successBlock = workflow.slice(workflow.lastIndexOf('<success_criteria>'));
    // The broken criterion said "Initial planning via Agent → Skill"
    assert.ok(
      !successBlock.includes('via Agent → Skill("gsd-plan-phase")'),
      'success_criteria must NOT describe plan-phase as Agent → Skill — that was the broken pattern. See: bug #936'
    );
    // The broken criterion said "isolated, not inline" for the replan
    assert.ok(
      !successBlock.includes('isolated, not inline'),
      'success_criteria must NOT say "isolated, not inline" for plan-phase — the fix makes it inline. See: bug #936'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-936-no-nested-spawner-wrap.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-936-no-nested-spawner-wrap (consolidation epic #1969 B4 #1973)", () => {
'use strict';
/**
 * Structural guard — bug(#936): plan-review-convergence wrapped gsd-plan-phase
 * in Agent() at TWO sites (initial planning + replan). On Claude Code, a depth-1
 * Agent has no Agent tool, so plan-phase cannot spawn gsd-planner / gsd-plan-checker
 * → the replan loop never works when HIGHs are found.
 *
 * Fix: run plan-phase INLINE (bare Skill()) from the convergence orchestrator,
 * which runs at depth 0 and has Agent available — exactly how autonomous.md,
 * manager.md, and discuss-phase-assumptions.md already chain plan-phase.
 *
 * This guard dynamically derives the set of "spawner" workflows (those containing
 * `subagent_type=`) and asserts that NO workflow wraps a spawner inside Agent()
 * UNLESS the wrapping block includes a RUNTIME != claude carve-out (the #853
 * pattern already applied to autonomous.md / manager.md).
 */

// allow-test-rule: source-text-is-the-product (see #936)
// The workflow markdown IS the runtime instruction — static guards over
// workflow text are the canonical regression-test mechanism (per CONTRIBUTING
// exception matrix and tests/bug-853-bg-dispatch-runtime-gating.test.cjs).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// ── 1. Derive spawner skill names dynamically ──────────────────────────────
// A "spawner" workflow is one that contains `subagent_type=` — it NEEDS the
// Agent tool to run and therefore cannot safely be wrapped in another Agent()
// on Claude Code (where depth-1 agents have no Agent tool).

// Recursively collect all *.md files under WORKFLOWS_DIR (covers nested fragments
// like discuss-phase/modes/*.md and execute-phase/steps/*.md).
function collectWorkflowFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...collectWorkflowFiles(fullPath));
    } else if (e.name.endsWith('.md')) {
      results.push({
        name: path.relative(WORKFLOWS_DIR, fullPath),
        path: fullPath,
        content: fs.readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return results;
}

const allWorkflowFiles = collectWorkflowFiles(WORKFLOWS_DIR);

// Map: base-slug → workflow filename (e.g. "plan-phase" → "plan-phase.md")
// Skill() calls use the "gsd-<slug>" convention in all workflow files.
// We build BOTH the bare slug set and the gsd-prefixed skill-name set.
const SPAWNER_BASE_SLUGS = new Set(
  allWorkflowFiles
    .filter((w) => w.content.includes('subagent_type='))
    .map((w) => w.name.replace(/\.md$/, ''))
);

// Skill invocations use "gsd-<slug>" (e.g. gsd-plan-phase, gsd-execute-phase).
// Build the regex from the prefixed names so it actually matches what workflows write.
const SPAWNER_GSD_NAMES = new Set([...SPAWNER_BASE_SLUGS].map((s) => `gsd-${s}`));

// Build a regex that matches Skill(skill='gsd-<spawner>') or Skill(skill="gsd-<spawner>")
const spawnerPattern = new RegExp(
  `Skill\\(\\s*skill=['"](?:${[...SPAWNER_GSD_NAMES].join('|')})['"]`,
  's'
);

// ── 2. Helper: extract Agent() blocks from a workflow ─────────────────────
// Each block starts at "Agent(" and ends at the balancing ")".  We collect
// the text of each such block together with the surrounding context (a 400
// char window before the block) so we can check for RUNTIME carve-outs.

function extractAgentBlocks(content) {
  const blocks = [];
  let pos = 0;
  while (pos < content.length) {
    const start = content.indexOf('Agent(', pos);
    if (start === -1) break;
    // Walk forward to find the balancing closing paren
    let depth = 0;
    let i = start + 'Agent('.length - 1; // at the '('
    for (; i < content.length; i++) {
      if (content[i] === '(') depth++;
      else if (content[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const end = i + 1;
    const blockText = content.slice(start, end);
    // Capture context: 400 chars before the block (for RUNTIME gate detection)
    const contextBefore = content.slice(Math.max(0, start - 400), start);
    blocks.push({ start, end, blockText, contextBefore });
    pos = end;
  }
  return blocks;
}

// ── 3. Helper: does a block have a RUNTIME != claude carve-out nearby? ────
// The #853 pattern looks like: "RUNTIME is `claude`" in a preceding condition
// that switches to inline Skill() instead of the Agent() block.  A block is
// considered guarded when the 400-char context window before it (or the block
// body itself for block-internal guards) contains any of these markers.

function hasRuntimeCarveout(block) {
  const haystack = block.contextBefore + block.blockText;
  return (
    /RUNTIME[^`\n]{0,30}(?:!=|≠|is not|!==)\s*[`'"]?claude/i.test(haystack) ||
    /RUNTIME[^`\n]{0,30}claude[^`\n]{0,30}(?:inline|not.*Agent|do NOT)/i.test(haystack) ||
    /If `RUNTIME` is `claude`/i.test(haystack) ||
    /On Claude Code.*inline/is.test(haystack)
  );
}

// ── 4. The guard: scan every workflow for unguarded Agent→spawner wraps ───

describe('bug-936 — no workflow wraps a spawner skill inside Agent() without a RUNTIME carve-out', () => {
  test('spawner set is non-empty (self-check: subagent_type= grep must find files)', () => {
    assert.ok(SPAWNER_BASE_SLUGS.size > 0, `No spawner workflows found in ${WORKFLOWS_DIR} — SPAWNER_BASE_SLUGS derivation is broken`);
    // plan-phase must be a spawner (base slug)
    assert.ok(SPAWNER_BASE_SLUGS.has('plan-phase'), 'plan-phase.md must be in the spawner set (contains subagent_type=)');
    // gsd-plan-phase must be in the prefixed set used by the regex
    assert.ok(SPAWNER_GSD_NAMES.has('gsd-plan-phase'), 'gsd-plan-phase must be in SPAWNER_GSD_NAMES — the prefixed form used in Skill() calls');
  });

  for (const wf of allWorkflowFiles) {
    // Only scan files that have at least one Agent( call
    if (!wf.content.includes('Agent(')) continue;

    test(`${wf.name}: no Agent() block wraps a spawner Skill without a RUNTIME carve-out`, () => {
      const blocks = extractAgentBlocks(wf.content);
      const violations = blocks.filter((b) => {
        const wrapsSpawner = spawnerPattern.test(b.blockText);
        if (!wrapsSpawner) return false;
        return !hasRuntimeCarveout(b);
      });

      assert.deepStrictEqual(
        violations.map((v) => v.blockText.slice(0, 120).replace(/\n/g, '\\n')),
        [],
        `${wf.name} wraps a spawner Skill inside Agent() without a RUNTIME != claude carve-out.\n` +
        `Fix: run the spawner Skill inline (bare Skill() call at depth 0) OR add a RUNTIME gate.\n` +
        `See: bug #936, tests/bug-853-bg-dispatch-runtime-gating.test.cjs for the guarded pattern.`
      );
    });
  }
});

// ── 5. Focused regression: plan-review-convergence never wraps plan-phase ─

describe('bug-936 — plan-review-convergence runs plan-phase inline, not inside Agent()', () => {
  const CONVERGENCE = fs.readFileSync(
    path.join(WORKFLOWS_DIR, 'plan-review-convergence.md'),
    'utf8'
  );

  test('plan-review-convergence does NOT wrap gsd-plan-phase inside Agent()', () => {
    // The anti-pattern: Agent( block whose body contains Skill(skill='gsd-plan-phase')
    const blocks = extractAgentBlocks(CONVERGENCE);
    const wrapping = blocks.filter((b) =>
      /Skill\(\s*skill=['"]gsd-plan-phase['"]/.test(b.blockText) &&
      !hasRuntimeCarveout(b)
    );
    assert.deepStrictEqual(
      wrapping.map((v) => v.blockText.slice(0, 120).replace(/\n/g, '\\n')),
      [],
      'plan-review-convergence must NOT wrap gsd-plan-phase inside Agent(). ' +
      'Run it inline (bare Skill() at depth 0) so it can spawn gsd-planner/gsd-plan-checker. ' +
      'See: bug #936'
    );
  });

  test('plan-review-convergence calls gsd-plan-phase inline (bare Skill call outside Agent block)', () => {
    // After the fix: at least one bare Skill(skill="gsd-plan-phase") must appear
    // outside any Agent( block — that is the inline call from the depth-0 orchestrator.
    const blocks = extractAgentBlocks(CONVERGENCE);
    // Remove all Agent block ranges from the text
    let masked = CONVERGENCE;
    // Work from end to start so offsets stay valid
    const sorted = [...blocks].sort((a, b) => b.start - a.start);
    for (const b of sorted) {
      masked = masked.slice(0, b.start) + ' '.repeat(b.end - b.start) + masked.slice(b.end);
    }
    const hasInlineCall = /Skill\(\s*skill=["']gsd-plan-phase["']/.test(masked);
    assert.ok(
      hasInlineCall,
      'plan-review-convergence must contain at least one bare Skill(skill="gsd-plan-phase") ' +
      'outside any Agent() block — this is the inline call that lets plan-phase spawn its sub-agents. ' +
      'See: bug #936'
    );
  });

  test('plan-review-convergence still wraps gsd-review inside Agent() (leaf — isolation is correct)', () => {
    // gsd-review is a leaf (shells out via Bash, no subagent_type) so the Agent wrap is fine and intentional.
    const blocks = extractAgentBlocks(CONVERGENCE);
    const reviewWrap = blocks.some((b) => /Skill\(\s*skill=['"]gsd-review['"]/.test(b.blockText));
    assert.ok(reviewWrap, 'gsd-review must still be wrapped in Agent() — it is a Bash leaf and isolation is intentional');
  });
});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// #1956 — Cross-artifact fact-drift pass (second axis of the plan drift guard)
//
// The source-grounding pass answers "does this symbol exist in the source?".
// This pass answers "does the project state the same FACT in two planning
// artifacts, and do the two disagree?" — the DRY hazard the issue names, where
// one copy is updated and the other silently steers a fresh-context agent wrong.
//
// ## What this suite locks
//
// The deployed contract, plus the two Hyrum contracts that are invisible from
// the new section itself and would be silently broken by a plausible edit:
//   1. the pass is ORCHESTRATOR-side, not inside the Agent(prompt=…) string —
//      the review agent's return message must end with its two "## " sections
//      and carry no others, because the workflow awk-parses them;
//   2. the pass can never reach the convergence gate. Convergence is
//      HIGH_COUNT + ACTIONABLE_COUNT == 0, and the workflow's own ACTIONABLE
//      definition would otherwise swallow a fact-drift finding — which would
//      turn an advisory check into an infinite replan loop for any project that
//      already carries drift.
//
// ## What it cannot prove
//
// That the model acts on the text. The subject is an LLM prompt; no test in
// this repo proves behavior for the source-grounding pass either. Stated so the
// coverage claim is honest rather than implied.
//
// The file is read through readFileNormalized, the same LF-normalizing seam the
// rest of this suite uses, so a CRLF checkout cannot skew the offsets.
// ─────────────────────────────────────────────────────────────────────────────

describe('plan-review-convergence: cross-artifact fact-drift pass (#1956)', () => {
  const WORKFLOW = readFileNormalized(WORKFLOW_PATH);

  const DRIFT_HEADING = /^### Cross-artifact fact-drift pass/m;
  const GROUNDING_HEADING = /^### Source-grounding pass/m;
  const AFTER_AGENT_LINE = /^After agent returns, verify REVIEWS\.md exists/m;

  function offsetOf(content, pattern) {
    const m = content.match(pattern);
    return m && typeof m.index === 'number' ? m.index : -1;
  }

  function driftSpan() {
    const start = offsetOf(WORKFLOW, DRIFT_HEADING);
    const end = offsetOf(WORKFLOW, AFTER_AGENT_LINE);
    assert.ok(start >= 0, 'workflow must define a "### Cross-artifact fact-drift pass" heading');
    assert.ok(end >= 0, 'workflow must retain the "After agent returns…" line that bounds the pass');
    assert.ok(end > start, 'the fact-drift pass must precede the "After agent returns…" line');
    return WORKFLOW.slice(start, end);
  }

  /**
   * Top-level ordered-list items in a span — the trigger gate's arity, i.e. the
   * "flag only when ALL N hold" conjunction. Widening it from 3 to 2 is exactly
   * what turns a precise heuristic into a noise generator, so the COUNT is
   * asserted rather than the prose.
   */
  function countOrderedItems(span) {
    const matches = span.match(/^\d+\. /gm);
    return matches ? matches.length : 0;
  }

  /**
   * Conjunction clauses — the indented sub-list under step 3's "FLAG only when
   * ALL THREE hold". Counted separately from the STEPS above because they are
   * different things: `countOrderedItems` measures the pass's procedure, this
   * measures the trigger gate's arity. Asserting one while claiming the other
   * is how a weakened gate slips through a green suite.
   */
  function countConjunctionItems(span) {
    const matches = span.match(/^ {3}\d+\. /gm);
    return matches ? matches.length : 0;
  }

  describe('the pass exists and extends the drift guard in place', () => {
    test('defines a cross-artifact fact-drift pass', () => {
      const heading = WORKFLOW.match(/^### Cross-artifact fact-drift pass(.*)$/m);
      assert.ok(heading, 'workflow must define a "### Cross-artifact fact-drift pass" heading');
    });

    test('the pass extends the drift guard, in place', () => {
      const grounding = offsetOf(WORKFLOW, GROUNDING_HEADING);
      const drift = offsetOf(WORKFLOW, DRIFT_HEADING);
      const after = offsetOf(WORKFLOW, AFTER_AGENT_LINE);
      assert.ok(grounding >= 0 && drift >= 0 && after >= 0, 'all three anchors must be present');
      assert.ok(grounding < drift, 'the fact-drift pass must follow the source-grounding pass — it extends it');
      assert.ok(drift < after, 'the fact-drift pass must sit before the post-agent REVIEWS.md check');
    });

    test('the pass region is outside the review-agent prompt', () => {
      // Anchor on the review-agent return contract itself — the sentence inside
      // the Agent(prompt=…) string that this test exists to protect — rather than
      // on a generic mode-argument literal that a later Agent() block could reuse
      // and thereby relocate the anchor past this section.
      const RETURN_CONTRACT = 'These two sections MUST be the final content of your response';
      const contractAt = WORKFLOW.indexOf(RETURN_CONTRACT);
      assert.ok(contractAt >= 0, 'the review agent prompt must still carry its return-message contract');
      assert.strictEqual(
        WORKFLOW.indexOf(RETURN_CONTRACT, contractAt + 1),
        -1,
        'the return-message contract must appear exactly once — a second copy makes this anchor ambiguous'
      );
      assert.ok(
        offsetOf(WORKFLOW, GROUNDING_HEADING) > contractAt,
        'source-grounding pass must remain orchestrator-side (after the Agent prompt)'
      );
      assert.ok(
        offsetOf(WORKFLOW, DRIFT_HEADING) > contractAt,
        'the fact-drift pass must be orchestrator-side — inside the Agent prompt its findings ' +
        'would break the "no additional ## headings" return contract the workflow parses'
      );
    });
  });

  describe('it adds no config surface', () => {
    test('the pass is gated on the existing drift-guard key', () => {
      assert.match(
        driftSpan(),
        /plan_review\.source_grounding/,
        'the fact-drift pass must name plan_review.source_grounding as its gate — issue #1956 ' +
        'scopes it as an extension of the existing guard, gated by the existing config'
      );
    });

    test('the pass introduces no new config key', () => {
      // The issue's pre-submission checklist asserts the change adds no new
      // concept, and its breaking-change mitigation reads "gated behind the
      // EXISTING plan_review config". A third key would also force a 25th
      // setting into gsd-core/workflows/settings.md's six-section UX.
      //
      // Two halves, both required. The gate must still be NAMED — otherwise a
      // deleted or empty section would satisfy a bare "no novel keys" check
      // vacuously — and nothing beyond the two keys the drift guard already owns
      // may appear. (`source_grounding_authority` is resolved through
      // `gsd_run drift-guard authority` and is not spelled out in this file
      // today; it stays on the allowed list so naming it later is not a failure.)
      const keys = new Set([...WORKFLOW.matchAll(/plan_review\.([a-z_]+)/g)].map((m) => m[1]));
      assert.ok(
        keys.has('source_grounding'),
        'the workflow must still name plan_review.source_grounding as the drift-guard gate'
      );
      const novel = [...keys]
        .filter((k) => k !== 'source_grounding' && k !== 'source_grounding_authority')
        .sort();
      assert.deepStrictEqual(
        novel,
        [],
        `plan-review-convergence must introduce no new plan_review key, found: ${novel.join(', ')}`
      );
    });
  });

  describe('the trigger gate is a three-way conjunction', () => {
    test('the pass runs four procedure steps', () => {
      assert.strictEqual(
        countOrderedItems(driftSpan()),
        4,
        'the fact-drift pass must run four steps (deterministic phase-status, pair up judgment ' +
        'facts, judge them, record). This counts the PROCEDURE; the trigger gate arity is ' +
        'counted separately.'
      );
    });

    test('the trigger gate enumerates exactly three conditions', () => {
      assert.strictEqual(
        countConjunctionItems(driftSpan()),
        3,
        'the fact-drift pass must gate on exactly three AND-ed conditions (same fact named on ' +
        'both sides, the two representations contradict, and the pair is one of the declared ' +
        'authority pairs). Dropping one widens it into a noise generator; adding one silently ' +
        'narrows what it can catch.'
      );
    });

    test('condition counter fires at 2 / 3 / 4', () => {
      // The assertion above can only ever observe the real document's arity, so
      // its inequality branch never executes. Exercise the counter at
      // limit-1 / limit / limit+1 through the SAME function the guard uses, in
      // both LF and CRLF form, so a future edit cannot neuter it.
      const item = (n) => `${n}. condition ${n}`;
      const indentedItem = (n) => `   ${n}. condition ${n}`;
      for (const eol of ['\n', '\r\n']) {
        const spanOf = (count) =>
          ['### Cross-artifact fact-drift pass', ...Array.from({ length: count }, (_, i) => item(i + 1))]
            .join(eol);
        const indentedSpanOf = (count) =>
          ['### Cross-artifact fact-drift pass', ...Array.from({ length: count }, (_, i) => indentedItem(i + 1))]
            .join(eol);
        assert.strictEqual(countOrderedItems(spanOf(2)), 2, `2 items must count as 2 (eol=${JSON.stringify(eol)})`);
        assert.strictEqual(countOrderedItems(spanOf(3)), 3, `3 items must count as 3 (eol=${JSON.stringify(eol)})`);
        assert.strictEqual(countOrderedItems(spanOf(4)), 4, `4 items must count as 4 (eol=${JSON.stringify(eol)})`);
        assert.strictEqual(countConjunctionItems(indentedSpanOf(2)), 2, `2 indented items must count as 2 (eol=${JSON.stringify(eol)})`);
        assert.strictEqual(countConjunctionItems(indentedSpanOf(3)), 3, `3 indented items must count as 3 (eol=${JSON.stringify(eol)})`);
        assert.strictEqual(countConjunctionItems(indentedSpanOf(4)), 4, `4 indented items must count as 4 (eol=${JSON.stringify(eol)})`);
        // The two counters must not see each other's items — a column-0-only
        // span has no conjunction items, and an indented-only span has no
        // procedure items.
        assert.strictEqual(countOrderedItems(indentedSpanOf(3)), 0, `indented-only span must count 0 procedure items (eol=${JSON.stringify(eol)})`);
        assert.strictEqual(countConjunctionItems(spanOf(3)), 0, `column-0-only span must count 0 conjunction items (eol=${JSON.stringify(eol)})`);
      }
    });
  });

  describe('severity is advisory, and can never gate convergence', () => {
    test('the finding is advisory and never a blocker', () => {
      assert.match(
        driftSpan(),
        /never\s+a\s+blocker/i,
        'the fact-drift pass must state that its finding is never a blocker — issue #1956 asks ' +
        'for an advisory finding, and blocking would strand every project carrying prior drift'
      );
    });

    test('the pass can never gate convergence', () => {
      // Convergence is HIGH_COUNT + ACTIONABLE_COUNT == 0, and the workflow's
      // own ACTIONABLE definition ("a non-HIGH finding invisible to
      // execute-phase unless incorporated into PLAN.md") would otherwise
      // swallow a fact-drift finding — making pre-existing drift an infinite
      // replan loop. This has to be WRITTEN DOWN, not merely true today.
      const span = driftSpan();
      assert.match(span, /HIGH_COUNT/, 'the pass must name HIGH_COUNT when disclaiming the convergence gate');
      assert.match(span, /ACTIONABLE_COUNT/, 'the pass must name ACTIONABLE_COUNT when disclaiming the convergence gate');
      assert.match(
        span,
        /never sets\s+`?hardBlock/,
        'the pass must state that it never sets hardBlock — the source-grounding pass uses ' +
        'hardBlock to stop the review cycle, and this pass must not inherit that'
      );
    });

    test('findings land in REVIEWS.md', () => {
      assert.match(
        driftSpan(),
        /REVIEWS\.md/,
        'the fact-drift pass must write to REVIEWS.md, matching the source-grounding pass — ' +
        'not to the review agent\'s return message'
      );
    });

    test('the phase-status axis is delegated to the deterministic seam', () => {
      const span = driftSpan();
      assert.match(
        span,
        /gsd_run drift-guard phase-status/,
        'the phase-status axis must be decided by the drift-guard seam, not by model judgment — ' +
        'issue #1956 requires a drifted STATE/ROADMAP pair to yield a finding deterministically'
      );
      for (const verdict of [/\bdrifted\b/, /\blag\b/, /\buncheckable\b/]) {
        assert.match(span, verdict, `the pass must say how it treats the ${verdict} verdict`);
      }
    });
  });

  describe('negative space is enumerated', () => {
    test('the pass keys on knowledge, not similar text', () => {
      // The maintainer's own research comment on #1956: "The check must key on
      // 'same knowledge, drifting representations,' not 'similar-looking text,'
      // or it will produce false positives."
      const span = driftSpan();
      assert.match(span, /knowledge/i, 'the pass must frame the check in terms of knowledge');
      assert.match(
        span,
        /contradict/i,
        'the pass must require a CONTRADICTION, not a resemblance — this is the rule that ' +
        'keeps it from firing on every restatement'
      );
    });

    test('the pass enumerates its non-triggering cases', () => {
      assert.match(driftSpan(), /Do NOT flag/, 'the fact-drift pass must carry an explicit non-triggering list');
    });

    test('non-triggering list covers every exclusion class', () => {
      const span = driftSpan();
      // Each token is a distinct exclusion class from the design's negative
      // space. Their absence is what produces the false positives the issue's
      // research comment warns about.
      for (const [token, why] of [
        [/wording/i, 'a wording-only difference asserting the same thing is not drift'],
        [/single-source/i, 'a fact held in one artifact only is the TARGET state, not a finding'],
        [/\bADDS\b/, 'a PLAN may ADD truths beyond the roadmap SCs — only subtraction/contradiction counts'],
        [/lifecycle/i, 'STATE trailing ROADMAP by one lifecycle step is lag, not drift'],
        [/Deferred Ideas/, 'CONTEXT.md non-authoritative sections must not be compared'],
      ]) {
        assert.match(span, token, `the non-triggering list must cover: ${why}`);
      }
    });

    test('the pass defers overlapping axes to the plan checker', () => {
      // Report once, not twice. plan-checker already owns requirement coverage
      // (D1), scope reduction (D7b) and cross-plan data contracts (D9).
      const span = driftSpan();
      for (const dimension of [/Dimension 1\b/, /Dimension 7b\b/, /Dimension 9\b/]) {
        assert.match(span, dimension, `the pass must defer the overlapping axis to ${dimension}`);
      }
    });

    test('a completion disagreement is never exempted as lag', () => {
      // The issue's canonical example is "complete in STATE.md but in progress
      // in ROADMAP.md" — one lifecycle step apart, and exactly the case it wants
      // FLAGGED. An exemption phrased purely as "one step apart" would exempt it.
      const span = driftSpan();
      assert.match(
        span,
        /completion[^.]*never lag|never lag|Completeness is terminal/i,
        'the pass must state that a disagreement about completion is never lag'
      );
    });
  });

  describe('authority and coverage', () => {
    test('the pass names an authority for every artifact pair', () => {
      const span = driftSpan();
      for (const artifact of ['ROADMAP.md', 'PLAN.md', 'STATE.md', 'CONTEXT.md']) {
        assert.ok(
          span.includes(artifact),
          `the fact-drift pass must name ${artifact} — issue #1956 spans all four planning artifacts`
        );
      }
      assert.match(
        span,
        /Authority/i,
        'the pass must declare which side of each pair is the source of truth — a finding that ' +
        'names a divergence without naming the authority cannot be acted on'
      );
    });

    test('a skipped axis is recorded, never silent', () => {
      const span = driftSpan();
      assert.match(span, /skip(ped)?/i, 'the pass must describe what happens when an artifact is absent');
      assert.match(
        span,
        /coverage/i,
        'a skipped axis must be recorded in the Verification coverage block — a clean pass must ' +
        'never silently mean "nothing was compared"'
      );
    });
  });

  describe('independence — the surrounding contracts are unchanged', () => {
    test('the source-grounding pass keeps its hard block', () => {
      const start = offsetOf(WORKFLOW, GROUNDING_HEADING);
      const end = offsetOf(WORKFLOW, DRIFT_HEADING);
      assert.ok(start >= 0 && end > start, 'source-grounding pass must still precede the fact-drift pass');
      const groundingSpan = WORKFLOW.slice(start, end);
      assert.match(
        groundingSpan,
        /hardBlock: true/,
        'the source-grounding pass must keep its hardBlock gating — #1956 is additive and must ' +
        'not downgrade the existing guard'
      );
    });

    test('the review-agent return contract is unchanged', () => {
      assert.match(
        WORKFLOW,
        /no additional "## " headings after them/,
        'the review agent\'s return-message contract must survive — the workflow awk-parses ' +
        'those sections and a stray "## " heading breaks escalation-detail extraction'
      );
    });
  });

  describe('docs parity', () => {
    test('CONFIGURATION.md documents both drift-guard axes', () => {
      const configDoc = readFileNormalized(CONFIG_DOC_PATH);
      const row = configDoc
        .split('\n')
        .find((l) => l.startsWith('|') && l.includes('`plan_review.source_grounding`'));
      assert.ok(row, 'docs/CONFIGURATION.md must carry a table row for plan_review.source_grounding');
      assert.match(
        row,
        /cross-artifact|fact drift/i,
        'the plan_review.source_grounding row must document the second (fact-drift) axis — the ' +
        'key now gates two checks, and a reader disabling it must know what else goes dark'
      );
    });

    test('USER-GUIDE.md documents the second axis', () => {
      const guide = readFileNormalized(path.join(__dirname, '..', 'docs', 'USER-GUIDE.md'));
      const start = guide.indexOf('plan_review.source_grounding: true');
      assert.ok(start >= 0, 'docs/USER-GUIDE.md must retain its Drift Guard section');
      const section = guide.slice(start, start + 4000);
      assert.match(
        section,
        /cross-artifact|fact drift/i,
        'the USER-GUIDE Drift Guard section must describe the cross-artifact fact-drift axis'
      );
    });

    test('ARCHITECTURE.md documents the second axis', () => {
      // The issue's Scope of changes names ARCHITECTURE.md explicitly, and its
      // existing drift-guard paragraph is the one place the architecture doc
      // describes this guard at all — leaving it single-axis would state, in the
      // architecture reference, that the guard does less than it does.
      const arch = readFileNormalized(path.join(__dirname, '..', 'docs', 'ARCHITECTURE.md'));
      const start = arch.indexOf('The plan drift guard (`plan_review.source_grounding`)');
      assert.ok(start >= 0, 'docs/ARCHITECTURE.md must retain its plan drift guard paragraph');
      const section = arch.slice(start, start + 2000);
      assert.match(
        section,
        /cross-artifact|fact-drift/i,
        'the ARCHITECTURE.md drift-guard paragraph must describe the cross-artifact fact-drift axis'
      );
    });
  });
});

// ══ #2398 — consensus gate for CYCLE_SUMMARY with multi-reviewer runs ═══════════════════
//
// Supersedes PR #2417, which its author closed on the unresolved B2 finding: the approved
// wording let a lone HIGH count if "the source-grounding pass independently confirms it",
// but that pass verifies "every symbol THE PLAN cites" — it never takes reviewer claims as
// input. For a genuine architectural HIGH raised by one reviewer and missed by another:
// ungroundable, uncorroborated, so it stopped gating. Net effect, in the #2417 review's
// words: configuring MORE reviewers produced a WEAKER gate than configuring one.
//
// The gate therefore splits by what a claim ASSERTS:
//   - existence/citation-class  -> source-grounding OR corroboration (catches fabricated cites)
//   - judgment/architectural    -> counts unless the RAISER carries an evidence-quality
//                                  discount marker  <- this is the B2 fix
//
// Linus's Law is the reason: "different reviewers think differently" — demanding two of them
// independently raise the SAME architectural finding destroys the mechanism a multi-reviewer
// setup exists for. Its limits clause supplies the other half: "rubber-stamp reviews don't
// count", and a reviewer that produced no file:line evidence is a rubber-stamp for that cycle.
//
// Assertions are on parsed structure and typed sets. The contract SENTENCES are themselves the
// deliverable (source-text-is-the-product), and carry no allow-test-rule marker deliberately:
// no-source-grep never inspects .md reads, so a marker suppresses nothing and consumes the
// ceilinged unverified-marker budget (measured 2026-08-21, 280 -> 281 fails the gate).
//
// See https://github.com/open-gsd/gsd-core/issues/2398

const WORKFLOW_2398 = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-review-convergence.md');
const REVIEWER_INSTANCES_2398 = path.join(__dirname, '..', 'gsd-core', 'references', 'reviewer-instances.md');
const runner2398 = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const lf2398 = (t) => String(t == null ? '' : t).replace(/\r\n/g, '\n');

function read2398(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** The `### 5a` step body, bounded by the next `### ` heading. */
function step5a2398(text) {
  const lines = lf2398(text).split('\n');
  const start = lines.findIndex((l) => /^###\s+5a[.\s]/.test(l));
  if (start === -1) return '';
  let end = start + 1;
  while (end < lines.length && !/^###\s/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

/** The consensus-gate block: from its heading to the line before `Counting rules:`. */
function consensusGate2398(text) {
  const body = lf2398(text);
  const gateAt = body.search(/^\s*Consensus gate\b/m);
  if (gateAt === -1) return '';
  const countingAt = body.indexOf('Counting rules:', gateAt);
  return countingAt === -1 ? body.slice(gateAt) : body.slice(gateAt, countingAt);
}

/** Every `[reviewed-without-*]` marker literal named in `text`, deduped and sorted. */
function markerNames2398(text) {
  return [...new Set([...lf2398(text).matchAll(/\[reviewed-without-[a-z-]+\]/g)].map((m) => m[0]))].sort();
}

/** Ordered positions of the contract landmarks the gate must sit between. */
function landmarks2398(text) {
  const body = lf2398(text);
  return {
    contract: body.indexOf('IMPORTANT — CYCLE_SUMMARY contract'),
    gate: body.search(/^\s*Consensus gate\b/m),
    counting: body.indexOf('Counting rules:'),
    definitions: body.indexOf('Definitions:'),
  };
}

describe('#2398 — consensus gate is declared and correctly positioned', () => {
  const workflow = read2398(WORKFLOW_2398);

  test('step 5a declares a consensus gate', () => {
    assert.notEqual(consensusGate2398(step5a2398(workflow)), '', 'no Consensus gate block found in step 5a');
  });

  test('gate precedes the counting rules it constrains', () => {
    const at = landmarks2398(step5a2398(workflow));
    assert.ok(at.contract >= 0 && at.gate >= 0 && at.counting >= 0 && at.definitions >= 0,
      `missing landmark: ${JSON.stringify(at)}`);
    assert.ok(at.contract < at.gate, 'gate must sit inside the CYCLE_SUMMARY contract');
    assert.ok(at.gate < at.counting, 'gate must precede Counting rules, or it constrains nothing');
    assert.ok(at.counting < at.definitions, 'existing Counting rules -> Definitions order must survive');
  });

  test('the CYCLE_SUMMARY contract line itself is unchanged', () => {
    // The orchestrator greps `current_high=[0-9]+` at :320-321. This change alters the NUMBER
    // the agent computes, never the line's shape — that is the Hyrum-safe boundary.
    assert.ok(lf2398(workflow).includes('CYCLE_SUMMARY: current_high=<N> current_actionable=<M>'));
  });

  test('step 5a fences stay balanced', () => {
    const fences = (lf2398(step5a2398(workflow)).match(/^\s*```/gm) || []).length;
    assert.equal(fences % 2, 0, `odd fence count (${fences}) in step 5a — a fence was left open`);
  });
});

describe('#2398 — gate semantics: the clauses that make it correct', () => {
  const gate = () => lf2398(consensusGate2398(step5a2398(read2398(WORKFLOW_2398)))).toLowerCase();

  test('gate engages only when 2+ reviewers actually ran', () => {
    const g = gate();
    assert.ok(/2\+|two or more|at least two/.test(g), 'gate must state its 2+ reviewer trigger');
    assert.ok(/\bran\b|produced|returned/.test(g),
      'trigger must be reviewers that RAN, not merely configured — a failed reviewer must not arm the gate');
  });

  test('single reviewer is documented as unchanged', () => {
    assert.ok(/single reviewer|one reviewer|exactly one/.test(gate()),
      'the single-reviewer no-op is the backward-compatibility promise and must be stated');
  });

  test('threshold is two, not three', () => {
    const g = gate();
    assert.ok(!/three or more|3\+ reviewers/.test(g), 'threshold must be 2, matching the approved scope');
  });

  // ── the B2 regression ──────────────────────────────────────────────────────────────────
  test('judgment-class lone HIGH is exempt from corroboration (B2)', () => {
    const g = gate();
    assert.ok(/judgment|architectural/.test(g), 'gate must name the judgment/architectural class');
    assert.ok(/counts?\b[\s\S]{0,200}?(unless|except)[\s\S]{0,200}?marker/.test(g),
      'a judgment-class lone HIGH must COUNT unless the raiser is marked — if it instead requires '
      + 'corroboration, B2 is back and more reviewers produce a weaker gate');
  });

  test('existence-class lone HIGH requires grounding or corroboration', () => {
    const g = gate();
    assert.ok(/existence|citation-class|cites a symbol/.test(g), 'gate must name the checkable class');
    assert.ok(/source-ground/.test(g) && /corroborat/.test(g),
      'the checkable class keeps both original paths: grounding OR corroboration');
  });

  test('classification is by assertion, not by citation presence (row 14)', () => {
    assert.ok(/asserts?\b/.test(gate()),
      'gate must classify by what the claim ASSERTS — keying on the presence of a file:line '
      + 'silently reclassifies every architectural finding that cites context, reintroducing B2');
  });

  test('an all-marked cycle fails open', () => {
    const g = gate();
    assert.ok(/every reviewer|all reviewers/.test(g) && /(does not (apply|engage)|fails? open)/.test(g),
      'if every reviewer is marked the gate must disengage — a gate must never manufacture convergence');
  });

  test('a suppressed HIGH remains listed and tagged', () => {
    const g = gate();
    assert.ok(/current high concerns/.test(g), 'suppressed HIGHs must still be listed');
    assert.ok(/tag|unconfirmed|single-reviewer/.test(g), 'and must be visibly tagged, not silently dropped');
  });

  test('gate governs current_high only, and says so explicitly', () => {
    const g = gate();
    assert.ok(/current_high/.test(g), 'gate must name the count it governs');
    // Asserting the gate never MENTIONS current_actionable was the wrong test: stating the
    // exclusion is what keeps a future editor from quietly widening the gate's reach.
    assert.ok(/current_actionable is unaffected|does not affect current_actionable|current_actionable is out of scope/.test(g),
      'gate must state explicitly that current_actionable is out of scope');
  });

  test('gate keys on a leading marker, not a quoted one', () => {
    // stampBlindReview's own doc warns a review that merely QUOTES a marker must not be
    // mis-stamped; the stamp is a LEADING blockquote, so the gate must say so.
    assert.ok(/leading|opens|begins|first line|blockquote/.test(gate()),
      'gate must require the marker to OPEN the reviewer section, or a review quoting a marker '
      + 'gets its own findings suppressed');
  });
});

describe('#2398 — marker parity: the gate names markers the runner actually PRODUCES', () => {
  // Earlier this asserted the marker string appeared somewhere in the runner's SOURCE TEXT.
  // That would pass even if stampUngroundedReview were broken or never called — string
  // co-occurrence, not behavior. These invoke the real exported stampers instead.

  /** Markers the runner genuinely emits, observed by calling it. */
  function emittedMarkers2398() {
    const observed = new Set();
    const ungrounded = runner2398.stampUngroundedReview('HIGH: no idempotency on retried writes.');
    const blind = runner2398.stampBlindReview('REVIEWED-WITHOUT-REPO-ACCESS\nHIGH: something.');
    for (const stamped of [ungrounded, blind]) {
      const m = /^> (\[reviewed-without-[a-z-]+\])/.exec(stamped);
      if (m) observed.add(m[1]);
    }
    return [...observed].sort();
  }

  test('the runner stamps an uncited review, and the marker LEADS the output', () => {
    const stamped = runner2398.stampUngroundedReview('HIGH: no idempotency on retried writes.');
    assert.match(stamped, /^> \[reviewed-without-source-citations\]/,
      'the marker must be the leading blockquote — the gate keys on that position');
    assert.ok(stamped.includes('HIGH: no idempotency on retried writes.'),
      'the original review must be preserved beneath the marker');
  });

  test('the runner does NOT stamp a review carrying a file:line citation', () => {
    const cited = 'HIGH: see src/a.ts:42 — the race is real.';
    assert.equal(runner2398.stampUngroundedReview(cited), cited);
  });

  test('the runner stamps a self-reported blind review', () => {
    assert.match(
      runner2398.stampBlindReview('REVIEWED-WITHOUT-REPO-ACCESS\nHIGH: something.'),
      /^> \[reviewed-without-repo-access\]/,
    );
  });

  test('stamping is idempotent — an already-stamped review gains no second marker', () => {
    const once = runner2398.stampUngroundedReview('bare review');
    assert.equal(runner2398.stampUngroundedReview(once), once);
  });

  test('gate names only markers the runner actually produces', () => {
    const emitted = emittedMarkers2398();
    const named = markerNames2398(consensusGate2398(step5a2398(read2398(WORKFLOW_2398))));
    assert.deepEqual(emitted, ['[reviewed-without-repo-access]', '[reviewed-without-source-citations]'],
      'runner must produce both markers when invoked');
    assert.ok(named.length >= 1, 'the gate must name at least one concrete marker literal');
    assert.deepEqual(named.filter((m) => !emitted.includes(m)), [],
      'gate names a marker the runner never produces — the gate would be inert');
  });

  test('parity fails when the gate names a marker the runner does not produce', () => {
    // Non-vacuity: a guard that only reads a correct tree never runs its failure branch.
    const emitted = emittedMarkers2398();
    const mutated = markerNames2398('[reviewed-without-source-citations] and [reviewed-without-telemetry]');
    assert.deepEqual(mutated.filter((m) => !emitted.includes(m)), ['[reviewed-without-telemetry]']);
  });

  test('parsers are total on empty, whitespace-only and absent input', () => {
    for (const input of ['', '   \n\t\n ', null, undefined, read2398('/nonexistent/2398.md')]) {
      assert.equal(step5a2398(input), '');
      assert.equal(consensusGate2398(input), '');
      assert.deepEqual(markerNames2398(input), []);
    }
  });

  test('parsers are newline-agnostic (CRLF === LF)', () => {
    for (const p of [WORKFLOW_2398, REVIEWER_INSTANCES_2398]) {
      const lfText = lf2398(read2398(p));
      const crlf = lfText.replace(/\n/g, '\r\n');
      assert.equal(step5a2398(crlf), step5a2398(lfText));
      assert.deepEqual(markerNames2398(crlf), markerNames2398(lfText));
    }
  });

  test('property: parity is strictly sensitive to a marker the runner never produces', () => {
    const emitted = emittedMarkers2398();
    fc.assert(
      fc.property(
        fc.subarray(emitted, { minLength: 1 }),
        fc.constantFrom('telemetry', 'network', 'sandbox', 'cache'),
        (subset, novel) => {
          assert.deepEqual(markerNames2398(subset.join(' ')).filter((m) => !emitted.includes(m)), []);
          const withNovel = `${subset.join(' ')} [reviewed-without-${novel}]`;
          assert.deepEqual(markerNames2398(withNovel).filter((m) => !emitted.includes(m)),
            [`[reviewed-without-${novel}]`]);
        },
      ),
      { seed: 2398, numRuns: 100 },
    );
  });
});

describe('#2398 — reviewer-instances cross-reference', () => {
  test('reviewer-instances documents the convergence-gate interaction', () => {
    const ref = lf2398(read2398(REVIEWER_INSTANCES_2398)).toLowerCase();
    assert.ok(/consensus gate/.test(ref), 'the reference must name the gate');
    assert.ok(/plan-review-convergence|current_high/.test(ref),
      'and must point at where it takes effect, so a reader configuring instances finds it');
  });
});

// ── #3899 ────────────────────────────────────────────────────────────────────
//
// The line that resolves REVIEWS.md is real shell an orchestrator executes, and it
// was wrong: `REVIEWS_FILE=$(ls ${phase_dir}/${padded_phase}-REVIEWS.md 2>/dev/null)`
// word-splits an unquoted `${phase_dir}`, so a project path containing a space
// resolves to the empty string with `ls`'s error discarded — and the workflow then
// blamed the review agent for a path-quoting defect. A glob metacharacter is worse:
// it does not resolve to empty, it resolves to whatever sibling the pattern happens
// to match, so the convergence loop reads a different phase's REVIEWS.md and never
// notices.
//
// Every text assertion in this file would have passed against that line. So this
// block EXECUTES the fragment against real fixtures instead of reading it.

/**
 * The REVIEWS.md resolution fragment, extracted from the workflow and RUN.
 *
 * Anchored to the post-review verification step, not searched document-wide: filtering
 * the whole file for "a bash fence that assigns REVIEWS_FILE" would keep passing if the
 * real fence stopped assigning it and some unrelated fence started — the harness would
 * then execute the wrong block and report green. The span runs from the step's opening
 * sentence to the next `###` heading, which is the same boundary the #1956 fact-drift
 * suite anchors on above (`AFTER_AGENT_LINE`).
 */
function extractReviewsFileResolution3899() {
  // The workflow markdown IS the runtime instruction; this fence is the shell an
  // orchestrator runs. It is extracted to be executed below, not string-matched.
  const workflow = readWorkflowCombined(WORKFLOW_PATH);
  const start = workflow.search(/^After agent returns, verify REVIEWS\.md exists/m);
  assert.ok(start >= 0, 'workflow must retain the "After agent returns…" verification step');
  const rest = workflow.slice(start);
  const nextHeading = rest.search(/^### /m);
  const span = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;

  const blocks = span.split('```').filter((f) => /^bash\n/.test(f) && /^REVIEWS_FILE=/m.test(f));
  assert.equal(
    blocks.length,
    1,
    `expected exactly one bash fence assigning REVIEWS_FILE in the verification step, found ${blocks.length}`,
  );
  return blocks[0].replace(/^bash\n/, '');
}

/** Run the extracted fragment with `phase_dir` / `padded_phase` bound, and echo what it resolved. */
function runReviewsFileResolution3899(phaseDir, paddedPhase = '01') {
  const dir = createTempDir('gsd-3899-gate-');
  try {
    const script = path.join(dir, 'resolve.sh');
    fs.writeFileSync(
      script,
      `${extractReviewsFileResolution3899()}\nprintf '%s' "\${REVIEWS_FILE}"\n`,
    );
    return runHook(script, [], {
      interpreter: 'bash',
      env: { ...process.env, phase_dir: phaseDir, padded_phase: paddedPhase },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } finally {
    cleanup(dir);
  }
}

/**
 * Build a phase directory literally named `dirName` under a fresh temp root and hand
 * its absolute path to `fn`. `siblings` create decoy phase directories beside it, each
 * carrying its own REVIEWS.md — that is what turns a glob metacharacter from
 * "resolves by accident" into "resolves to the wrong file".
 */
function withPhaseDir3899(dirName, { reviews = 'real', siblings = [] }, fn) {
  const root = createTempDir('gsd-3899-phase-');
  try {
    for (const sibling of siblings) {
      fs.mkdirSync(path.join(root, sibling), { recursive: true });
      fs.writeFileSync(path.join(root, sibling, '01-REVIEWS.md'), 'decoy\n');
    }
    const phaseDir = path.join(root, dirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    const reviewsFile = path.join(phaseDir, '01-REVIEWS.md');
    if (reviews !== null) fs.writeFileSync(reviewsFile, `${reviews}\n`);
    return fn(phaseDir, reviewsFile);
  } finally {
    cleanup(root);
  }
}

describe('#3899 REVIEWS.md path resolution is path-safe and fails closed', () => {
  const posixOnly = { skip: process.platform === 'win32' ? 'POSIX-only bash fragment' : false };

  test('a phase_dir containing a space resolves to the real file', posixOnly, () => {
    withPhaseDir3899('My Projects', {}, (phaseDir, reviewsFile) => {
      const r = runReviewsFileResolution3899(phaseDir);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, 0, `guard rejected an existing file: ${r.stderr}`);
      assert.equal(r.stdout, reviewsFile);
    });
  });

  test('a glob metacharacter resolves to the real file, never a decoy sibling', posixOnly, () => {
    // `glob[1]dir` is a bash character class matching the literal directory `glob1dir`,
    // so the unquoted form silently reads the decoy's REVIEWS.md and reports success.
    withPhaseDir3899('glob[1]dir', { siblings: ['glob1dir'] }, (phaseDir, reviewsFile) => {
      const r = runReviewsFileResolution3899(phaseDir);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, 0, `guard rejected an existing file: ${r.stderr}`);
      assert.equal(r.stdout, reviewsFile);
      assert.equal(fs.readFileSync(r.stdout, 'utf8').trim(), 'real');
    });
  });

  test('a missing reviews file exits non-zero and names the path, not the agent', posixOnly, () => {
    withPhaseDir3899('My Projects', { reviews: null }, (phaseDir, reviewsFile) => {
      const r = runReviewsFileResolution3899(phaseDir);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.notEqual(r.exitCode, 0, 'an absent reviews file must fail closed');
      assert.ok(
        r.stderr.includes(reviewsFile),
        `the error must identify the expected location, got: ${r.stderr}`,
      );
      assert.ok(
        !/review agent did not produce/i.test(r.stderr),
        `a path failure must not be attributed to the review agent, got: ${r.stderr}`,
      );
    });
  });

  test('an empty phase_dir fails with a diagnostic naming phase_dir', posixOnly, () => {
    const r = runReviewsFileResolution3899('');
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.notEqual(r.exitCode, 0, 'an empty phase_dir must fail closed');
    assert.match(r.stderr, /phase_dir/, `the error must identify phase_dir, got: ${r.stderr}`);
  });

  // This -r arm is developer-box-only when CI runs as root or on Windows.
  test('an unreadable reviews file exits non-zero', {
    skip:
      process.platform === 'win32'
        ? 'POSIX permission bits'
        : typeof process.getuid === 'function' && process.getuid() === 0
          ? 'root bypasses the read permission bit'
          : false,
  }, () => {
    withPhaseDir3899('My Projects', {}, (phaseDir, reviewsFile) => {
      fs.chmodSync(reviewsFile, 0o000);
      const r = runReviewsFileResolution3899(phaseDir);
      fs.chmodSync(reviewsFile, 0o600); // let cleanup() remove it
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.notEqual(r.exitCode, 0, 'an unreadable reviews file must fail closed');
      assert.ok(r.stderr.includes(reviewsFile), `the error must name the path, got: ${r.stderr}`);
    });
  });

  test('a directory standing in for the reviews file exits non-zero', posixOnly, () => {
    withPhaseDir3899('My Projects', { reviews: null }, (phaseDir, reviewsFile) => {
      // `[ -r ]` alone is true for a readable DIRECTORY, so the gate would pass and hand
      // a directory to the consumers that read the file.
      fs.mkdirSync(reviewsFile);
      const r = runReviewsFileResolution3899(phaseDir);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.notEqual(r.exitCode, 0, 'a directory is not a reviews file — it must fail closed');
      assert.ok(r.stderr.includes(reviewsFile), `the error must name the path, got: ${r.stderr}`);
    });
  });

  test('the resolution keeps no silent-empty path — no subshell, no discarded stderr', () => {
    const fragment = extractReviewsFileResolution3899();
    const lines = fragment.split('\n');
    const assignment = lines.find((line) => /^REVIEWS_FILE=/.test(line));
    assert.ok(assignment, 'no REVIEWS_FILE assignment in the extracted fence');
    // Both subshell spellings: `$(ls …)` is what shipped, and a backtick rewrite would
    // reintroduce the identical word-splitting through a form `$(`-only matching misses.
    assert.ok(
      !/\$\(|`/.test(assignment),
      `the assignment must not run a subshell, got: ${assignment}`,
    );
    // Scoped to the lines that touch REVIEWS_FILE rather than the whole fence: an unrelated
    // future redirect elsewhere in the block is not this bug, and banning it globally would
    // red the suite for a change that cannot reintroduce the defect.
    const discarded = lines.filter((l) => /REVIEWS_FILE/.test(l) && /2>\s*\/dev\/null/.test(l));
    assert.deepEqual(
      discarded,
      [],
      'the existence check must not discard stderr — that is what hid the path error',
    );
  });
});
