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

  test('workflow REVIEWER_FLAGS extraction whitelists --agy and --antigravity', () => {
    // The runtime contract is the grep-accumulation block: each recognized flag
    // has its own `grep -q '\\-\\-<flag>'` line. Absence = the flag is silently dropped.
    assert.ok(/grep -q '\\-\\-agy'/.test(workflow), 'workflow must whitelist --agy');
    assert.ok(/grep -q '\\-\\-antigravity'/.test(workflow), 'workflow must whitelist --antigravity');
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
    const { execFileSync } = require('node:child_process');
    const startIdx = workflow.indexOf('REVIEWER_FLAGS=""');
    const endMarker = "echo \"$ARGUMENTS\" | grep -q '\\-\\-all' && REVIEWER_FLAGS=\"$REVIEWER_FLAGS --all\"";
    const endIdx = workflow.indexOf(endMarker);
    assert.ok(startIdx !== -1 && endIdx !== -1, 'the REVIEWER_FLAGS parse block must exist in the workflow');
    const block = workflow.slice(startIdx, endIdx + endMarker.length) + '\nprintf "%s" "$REVIEWER_FLAGS"';
    const run = (args) => execFileSync('bash', ['-c', block], {
      env: { ...process.env, ARGUMENTS: args },
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

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
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
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

    // Parse block: from REVIEWER_FLAGS="" to the last grep line (--all).
    const parseStart = workflow.indexOf('REVIEWER_FLAGS=""');
    const parseEndMarker = "echo \"$ARGUMENTS\" | grep -q '\\-\\-all' && REVIEWER_FLAGS=\"$REVIEWER_FLAGS --all\"";
    const parseEnd = workflow.indexOf(parseEndMarker);
    assert.ok(parseStart !== -1 && parseEnd !== -1, 'parse block must exist');
    const parseBlock = workflow.slice(parseStart, parseEnd + parseEndMarker.length);

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
      // Stub gsd_run: only `query config-get review.default_reviewers` is exercised.
      // Empty/default → unset key (gsd_run returns nothing → empty stdout).
      //
      // The default_reviewers value is passed via env var ($GSD_TEST_DEFAULT_REVIEWERS)
      // rather than inline-interpolated into the bash script. This avoids a quoting
      // fragility: a future test input containing a single quote would otherwise
      // break the bash single-quoted string and execute as bash. With env-var
      // handoff, the value never crosses an interpreting shell context.
      const stub = `gsd_run() { case "$*" in *"config-get review.default_reviewers"*) printf '%s' "$GSD_TEST_DEFAULT_REVIEWERS";; *) return 0;; esac; }`;
      const script = `${stub}\n${parseBlock}\n${resolutionBlock}\nprintf 'REVIEWER_FLAGS=[%s] REVIEWER_DISPLAY=[%s]' "$REVIEWER_FLAGS" "$REVIEWER_DISPLAY"`;
      return execFileSync('bash', ['-c', script], {
        env: { ...process.env, ARGUMENTS: args, GSD_TEST_DEFAULT_REVIEWERS: defaultReviewers ?? '' },
        encoding: 'utf8',
        timeout: 5000,
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
    const parseStart = workflow.indexOf('REVIEWER_FLAGS=""');
    const parseEndMarker = "echo \"$ARGUMENTS\" | grep -q '\\-\\-all' && REVIEWER_FLAGS=\"$REVIEWER_FLAGS --all\"";
    const parseEnd = workflow.indexOf(parseEndMarker);
    const parseBlock = workflow.slice(parseStart, parseEnd + parseEndMarker.length);
    const configGateIdx = workflow.indexOf('CONVERGENCE_ENABLED=$(gsd_run query config-get workflow.plan_review_convergence');
    const resolutionStart = workflow.indexOf('if [ -z "$REVIEWER_FLAGS" ]; then', configGateIdx);
    const closingFence = workflow.indexOf('\n```\n', resolutionStart);
    const resolutionBlock = workflow.slice(resolutionStart, closingFence);
    const { execFileSync } = require('node:child_process');
    const run = ({ args, defaultReviewers }) => {
      const stub = `gsd_run() { case "$*" in *"config-get review.default_reviewers"*) printf '%s' "$GSD_TEST_DEFAULT_REVIEWERS";; *) return 0;; esac; }`;
      const script = `${stub}\n${parseBlock}\n${resolutionBlock}\nprintf 'REVIEWER_FLAGS=[%s] REVIEWER_DISPLAY=[%s]' "$REVIEWER_FLAGS" "$REVIEWER_DISPLAY"`;
      return execFileSync('bash', ['-c', script], {
        env: { ...process.env, ARGUMENTS: args, GSD_TEST_DEFAULT_REVIEWERS: defaultReviewers ?? '' },
        encoding: 'utf8',
        timeout: 5000,
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

// ─── #2272: Cursor and Qwen reviewer flags reachable from convergence ────────

describe('plan-review-convergence: --cursor/--qwen reviewer whitelist (#2272)', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const SKILL_PATH = path.join(__dirname, '..', 'skills', 'gsd-plan-review-convergence', 'SKILL.md');
  const command = fs.readFileSync(COMMAND_PATH, 'utf8');

  test('workflow REVIEWER_FLAGS extraction whitelists --cursor and --qwen', () => {
    // The runtime contract is the grep-accumulation block: each recognized flag
    // has its own `grep -q '\\-\\-<flag>'` line. Absence = the flag is silently
    // dropped to the --codex default (the silent-fallback footgun in #2272).
    assert.ok(/grep -q '\\-\\-cursor'/.test(workflow), 'workflow must whitelist --cursor');
    assert.ok(/grep -q '\\-\\-qwen'/.test(workflow), 'workflow must whitelist --qwen');
  });

  test('command documents the --cursor and --qwen reviewer flags (#2272)', () => {
    assert.ok(command.includes('--cursor'), 'command must document --cursor flag (Cursor agent reviewer)');
    assert.ok(command.includes('--qwen'), 'command must document --qwen flag (Qwen Code reviewer)');
  });

  test('argument-hint advertises --cursor and --qwen (#2272)', () => {
    const hint = command.match(/^argument-hint:\s*"(.*)"\s*$/m);
    assert.ok(hint, 'command must declare an argument-hint');
    assert.ok(hint[1].includes('--cursor'), `argument-hint must list --cursor, got: ${hint[1]}`);
    assert.ok(hint[1].includes('--qwen'), `argument-hint must list --qwen, got: ${hint[1]}`);
  });

  test('generated SKILL.md mirrors the --cursor and --qwen flags (argument-hint parity)', () => {
    const skill = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(skill.includes('--cursor'), 'generated SKILL.md must document --cursor (regenerate via gen:plugin-skills)');
    assert.ok(skill.includes('--qwen'), 'generated SKILL.md must document --qwen (regenerate via gen:plugin-skills)');
  });

  // Behavioral: execute the ACTUAL deployed REVIEWER_FLAGS accumulation block and
  // assert --cursor/--qwen pass through instead of being dropped to the --codex
  // default. POSIX-only: the block is /bin/sh-style grep pipework; skip on Windows
  // where a bash shim is not guaranteed on PATH.
  test('[behavioral] the deployed extraction passes --cursor/--qwen through (not the --codex fallback)', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX shell extraction; not run on Windows'); return; }
    const { execFileSync } = require('node:child_process');
    const startIdx = workflow.indexOf('REVIEWER_FLAGS=""');
    const endMarker = "echo \"$ARGUMENTS\" | grep -q '\\-\\-all' && REVIEWER_FLAGS=\"$REVIEWER_FLAGS --all\"";
    const endIdx = workflow.indexOf(endMarker);
    assert.ok(startIdx !== -1 && endIdx !== -1, 'the REVIEWER_FLAGS parse block must exist in the workflow');
    const block = workflow.slice(startIdx, endIdx + endMarker.length) + '\nprintf "%s" "$REVIEWER_FLAGS"';
    const run = (args) => execFileSync('bash', ['-c', block], {
      env: { ...process.env, ARGUMENTS: args },
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    const cursor = run('5 --cursor');
    assert.ok(cursor.split(/\s+/).includes('--cursor'), `--cursor must pass through, got: "${cursor}"`);
    assert.notStrictEqual(cursor, '--codex', 'must NOT collapse to the --codex-only fallback when --cursor is given');

    const qwen = run('5 --qwen');
    assert.ok(qwen.split(/\s+/).includes('--qwen'), `--qwen must pass through, got: "${qwen}"`);
    assert.notStrictEqual(qwen, '--codex', 'must NOT collapse to the --codex-only fallback when --qwen is given');

    // #2315 regression: the parse block no longer applies a default, so a bare
    // invocation and an unknown reviewer both yield empty here. The default is
    // resolved later in step 1.5 against review.default_reviewers.
    assert.strictEqual(run('5'), '', 'no reviewer flag → empty from parse (default applied in step 1.5 per #2315)');
    assert.strictEqual(run('5 --bogus-reviewer'), '', 'unknown reviewer flag → empty from parse (no silent --codex injection)');
    const mixed = run('5 --cursor --qwen');
    assert.ok(mixed.includes('--cursor') && mixed.includes('--qwen'), 'both new flags accumulate together');
    // The new flags must not be spuriously matched by an unrelated flag (independence).
    assert.ok(!run('5 --gemini').includes('--cursor'), '--gemini must not trip the --cursor whitelist');
    assert.ok(!run('5 --gemini').includes('--qwen'), '--gemini must not trip the --qwen whitelist');
  });
});

// ─── #2272: upstream CONVERGENCE_ARGS allowlists stay in parity ─────────────

describe('convergence reviewer-flag parity across upstream forwarders (#2272)', () => {
  const AUTONOMOUS_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md');
  const NEXT_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'next.md');

  // autonomous.md and next.md forward ONLY the flags their CONVERGENCE_ARGS loop
  // recognizes; raw $ARGUMENTS never reaches the skill call. So a flag the
  // convergence workflow accepts but these loops omit is silently dropped to the
  // --codex default one hop upstream: the same footgun #2272 exists to kill.
  //
  // Non-reviewer flags (--text, --max-cycles) are intentionally excluded: --text
  // is an output-format flag and --max-cycles is parsed separately with its value.
  const NON_REVIEWER_FLAGS = new Set(['--text', '--max-cycles']);

  /** Reviewer flags the convergence workflow whitelists, from its grep-accumulation block. */
  function convergenceReviewerFlags() {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const flags = [...workflow.matchAll(/REVIEWER_FLAGS="\$REVIEWER_FLAGS (--[a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(flags.length > 0, 'could not parse REVIEWER_FLAGS whitelist from the convergence workflow');
    return new Set(flags.filter((f) => !NON_REVIEWER_FLAGS.has(f)));
  }

  /** Flags the CONVERGENCE_ARGS for-loop iterates over in an upstream forwarder. */
  function forwarderFlags(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const loop = src.match(/for REVIEW_FLAG in ([^;]+); do/);
    assert.ok(loop, `could not find the CONVERGENCE_ARGS for-loop in ${path.basename(filePath)}`);
    return new Set(loop[1].trim().split(/\s+/).filter((f) => !NON_REVIEWER_FLAGS.has(f)));
  }

  for (const [label, filePath] of [['autonomous.md', () => AUTONOMOUS_PATH], ['next.md', () => NEXT_PATH]]) {
    test(`${label} CONVERGENCE_ARGS forwards every reviewer flag the convergence workflow accepts`, () => {
      const expected = convergenceReviewerFlags();
      const actual = forwarderFlags(filePath());
      const missing = [...expected].filter((f) => !actual.has(f)).sort();
      assert.deepStrictEqual(
        missing,
        [],
        `${label} drops reviewer flag(s) the convergence workflow accepts: ${missing.join(', ')}. ` +
        'Only CONVERGENCE_ARGS is forwarded to gsd-plan-review-convergence (raw $ARGUMENTS is not), ' +
        'so an omitted flag silently falls back to --codex. Add it to the for-loop.'
      );
    });
  }

  // Behavioral: run the ACTUAL deployed loop and assert the new flags survive.
  // POSIX-only: the block is /bin/sh-style grep pipework.
  test('[behavioral] both forwarders pass --cursor/--qwen/--agy through to CONVERGENCE_ARGS', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX shell extraction; not run on Windows'); return; }
    const { execFileSync } = require('node:child_process');

    const runLoop = (filePath, args) => {
      const src = fs.readFileSync(filePath, 'utf8');
      const startIdx = src.indexOf('CONVERGENCE_ARGS=""');
      assert.ok(startIdx !== -1, `CONVERGENCE_ARGS block must exist in ${path.basename(filePath)}`);
      const doneIdx = src.indexOf('\ndone', startIdx);
      assert.ok(doneIdx !== -1, `CONVERGENCE_ARGS loop must terminate in ${path.basename(filePath)}`);
      const block = src.slice(startIdx, doneIdx + '\ndone'.length) + '\nprintf "%s" "$CONVERGENCE_ARGS"';
      return execFileSync('bash', ['-c', block], {
        env: { ...process.env, ARGUMENTS: args },
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
    };

    for (const [label, filePath] of [['autonomous.md', AUTONOMOUS_PATH], ['next.md', NEXT_PATH]]) {
      for (const flag of ['--cursor', '--qwen', '--agy']) {
        const out = runLoop(filePath, `--converge ${flag}`);
        assert.ok(
          out.split(/\s+/).includes(flag),
          `${label} must forward ${flag} into CONVERGENCE_ARGS, got: "${out}"`
        );
      }
      // Independence: a longer flag sharing a prefix must not trip a shorter entry.
      const antigravity = runLoop(filePath, '--converge --antigravity');
      assert.ok(
        !antigravity.split(/\s+/).includes('--agy'),
        `${label}: --antigravity must not also match the --agy entry, got: "${antigravity}"`
      );
      // Regression: no reviewer flag → nothing accumulated (convergence applies its own default).
      assert.strictEqual(runLoop(filePath, '--converge'), '', `${label}: bare --converge must accumulate no reviewer flags`);
    }
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

  test('workflow parses --ollama flag into REVIEWER_FLAGS', () => {
    assert.ok(
      workflow.includes('--ollama'),
      'workflow must parse --ollama flag so it is forwarded to the review agent'
    );
  });

  test('workflow parses --lm-studio flag into REVIEWER_FLAGS', () => {
    assert.ok(
      workflow.includes('--lm-studio'),
      'workflow must parse --lm-studio flag so it is forwarded to the review agent'
    );
  });

  test('workflow parses --llama-cpp flag into REVIEWER_FLAGS', () => {
    assert.ok(
      workflow.includes('--llama-cpp'),
      'workflow must parse --llama-cpp flag so it is forwarded to the review agent'
    );
  });
});

describe('plan-review-convergence local model config schema registration (#2306-local)', () => {
  // After Cycle 5 (#3536), config-schema.cjs is a thin adapter sourcing from
  // the manifest. Use the runtime Set instead of text-parsing the source file.
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

  test('review.ollama_host is registered in config-schema.cjs', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('review.ollama_host'),
      "review.ollama_host must be in VALID_CONFIG_KEYS so gsd config-set accepts it"
    );
  });

  test('review.lm_studio_host is registered in config-schema.cjs', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('review.lm_studio_host'),
      "review.lm_studio_host must be in VALID_CONFIG_KEYS so gsd config-set accepts it"
    );
  });

  test('review.llama_cpp_host is registered in config-schema.cjs', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('review.llama_cpp_host'),
      "review.llama_cpp_host must be in VALID_CONFIG_KEYS so gsd config-set accepts it"
    );
  });
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
