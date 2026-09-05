// docs-guard-exempt: 'docs/readme.md' is a fast-check filler token and 'commit_docs' is a config key name, not a docs/ path read.
/**
 * commit_docs bypass guard (#1783; superseded/widened by #3585)
 *
 * #1783: when users set commit_docs: false during /gsd-new-project,
 * .planning/ files should never be staged or committed. The gsd-tools.cjs
 * commit wrapper already checks this flag, but three locations in
 * execute-phase.md and quick.md used raw `git add .planning/` commands that
 * bypassed it.
 *
 * The original guard here was a two-file allowlist (execute-phase.md,
 * quick.md) whose regex required the literal substring `.planning/` on the
 * SAME line as `git add`. That is structurally blind to `git add -A` /
 * `git add .` / `git add -u` — none of those lines mention `.planning/` at
 * all, yet every one of them stages the whole index, including
 * `.planning/`, regardless of the config. #3585 replaces it with a
 * repo-wide scan that classifies `git add` invocations by what they can
 * actually reach (the blanket/wildcard forms, `.planning`-qualified paths in
 * either separator convention, and any argument carrying an unresolved
 * shell variable, fail-closed), across every scan root that carries live
 * workflow/agent/command/skill/reference content — not just the original
 * two files.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fc = require('fast-check');
const {
  hasReachingGitAdd, scanText, scanRepo, SCAN_ROOTS,
} = require('./helpers/planning-add-guard.cjs');

const REPO_ROOT = path.join(__dirname, '..');

describe('commit_docs bypass guard (#1783, repo-wide per #3585)', () => {
  // ── Layer 1: the pure classifier, over inline string fixtures ──────────

  describe('A: argument-reach rules', () => {
    test('A1: git add .planning/STATE.md reaches', () => {
      assert.strictEqual(hasReachingGitAdd('git add .planning/STATE.md'), true);
    });

    test('A2: git add -A reaches', () => {
      assert.strictEqual(hasReachingGitAdd('git add -A'), true);
    });

    test('A3: git add --all reaches', () => {
      assert.strictEqual(hasReachingGitAdd('git add --all'), true);
    });

    test('A4: git add . reaches', () => {
      assert.strictEqual(hasReachingGitAdd('git add .'), true);
    });

    test('A5: git add -u reaches', () => {
      assert.strictEqual(hasReachingGitAdd('git add -u'), true);
    });

    test('A6: git add src/api/auth.ts does NOT reach', () => {
      assert.strictEqual(hasReachingGitAdd('git add src/api/auth.ts'), false);
    });

    test('A7: git add {test_files} does NOT reach (brace placeholder, no $)', () => {
      assert.strictEqual(hasReachingGitAdd('git add {test_files}'), false);
    });

    test('A8: git add "${QUICK_DIR}/x-PLAN.md" reaches (rule c: unresolved variable)', () => {
      assert.strictEqual(hasReachingGitAdd('git add "${QUICK_DIR}/x-PLAN.md"'), true);
    });

    test('A9: git add .planning\\STATE.md reaches (Windows separator)', () => {
      assert.strictEqual(hasReachingGitAdd('git add .planning\\STATE.md'), true);
    });

    test("A10: git add -A -- ':!.planning' does NOT reach (exclude pathspec overrides -A)", () => {
      assert.strictEqual(hasReachingGitAdd("git add -A -- ':!.planning'"), false);
    });

    test('A11: V=$(git add -A) reaches (substitution-glued assignment prefix, #3585)', () => {
      assert.strictEqual(hasReachingGitAdd('V=$(git add -A)'), true);
    });

    test('A12: FOO=1 git add -A still reaches (plain assignment prefix, not a substitution)', () => {
      assert.strictEqual(hasReachingGitAdd('FOO=1 git add -A'), true);
    });

    test('A13: git -C /tmp/x add -A reaches (git-level -C flag consumes its value, #3585)', () => {
      assert.strictEqual(hasReachingGitAdd('git -C /tmp/x add -A'), true);
    });

    test('A14: git --no-pager add -A reaches (a value-less flag must not swallow "add")', () => {
      assert.strictEqual(hasReachingGitAdd('git --no-pager add -A'), true);
    });

    test('A15: git -c foo.bar=1 add -A reaches (git-level -c flag consumes its value)', () => {
      assert.strictEqual(hasReachingGitAdd('git -c foo.bar=1 add -A'), true);
    });

    test('A16: git add "$(cat list.txt)" reaches (command substitution, #3585 F2)', () => {
      assert.strictEqual(hasReachingGitAdd('git add "$(cat list.txt)"'), true);
    });

    test('A17: git add --pathspec-from-file=paths.txt reaches (#3585 F2)', () => {
      assert.strictEqual(hasReachingGitAdd('git add --pathspec-from-file=paths.txt'), true);
    });

    test('A18: git commit -a -m "x" reaches (#3585 F3)', () => {
      assert.strictEqual(hasReachingGitAdd('git commit -a -m "x"'), true);
    });

    test('A19: git commit -am "x" reaches (combined short cluster, #3585 F3)', () => {
      assert.strictEqual(hasReachingGitAdd('git commit -am "x"'), true);
    });

    test('A20: git commit -m "x" does NOT reach (no -a/--all flag, #3585 F3)', () => {
      assert.strictEqual(hasReachingGitAdd('git commit -m "x"'), false);
    });
  });

  describe('B: invocation recognition', () => {
    test('B1: a bare fenced line is an invocation', () => {
      assert.strictEqual(hasReachingGitAdd('git add -A'), true);
    });

    test('B3: a quoted echo of "git add -A" is NOT an invocation', () => {
      assert.strictEqual(
        hasReachingGitAdd('[ -n "$X" ] && echo "  1. git add -A && git commit -m \'wip\'" >&2'),
        false,
      );
    });

    test('B5: bash -c "git add -A" IS an invocation', () => {
      assert.strictEqual(hasReachingGitAdd('bash -c "git add -A"'), true);
    });

    test('B6: echo bash -c "git add -A" is NOT an invocation (echo prints, does not run)', () => {
      assert.strictEqual(hasReachingGitAdd('echo bash -c "git add -A"'), false);
    });

    test('B7: cd "$X" && git add -A IS an invocation', () => {
      assert.strictEqual(hasReachingGitAdd('cd "$X" && git add -A'), true);
    });

    test('B8: # git add -A (a shell comment) is NOT an invocation', () => {
      assert.strictEqual(hasReachingGitAdd('# git add -A'), false);
    });
  });

  // ── Layer 1 continued: fence + commit_docs guard state (needs multi-line
  // file context, so these drive scanText over small synthetic documents) ──

  describe('C: fence and commit_docs guard tracking', () => {
    const fenced = (bodyLines) => ['```bash', ...bodyLines, '```'].join('\n');

    test('C1: a guard enclosing the add is guarded (no offender)', () => {
      const { offenders } = scanText('fixture.md', fenced([
        'COMMIT_DOCS=$(gsd_run query config-get commit_docs --default true)',
        'if [ "$COMMIT_DOCS" != "false" ]; then',
        '  git add .planning/STATE.md',
        'fi',
      ]));
      assert.deepStrictEqual(offenders, []);
    });

    test('C2: an add BEFORE the if is unguarded', () => {
      const { offenders } = scanText('fixture.md', fenced([
        'git add .planning/STATE.md',
        'if [ "$COMMIT_DOCS" != "false" ]; then',
        '  echo noop',
        'fi',
      ]));
      assert.strictEqual(offenders.length, 1);
    });

    test('C3: an add AFTER the fi is unguarded', () => {
      const { offenders } = scanText('fixture.md', fenced([
        'if [ "$COMMIT_DOCS" != "false" ]; then',
        '  echo noop',
        'fi',
        'git add .planning/STATE.md',
      ]));
      assert.strictEqual(offenders.length, 1);
    });

    test('C4: markdown prose "**If commit_docs is true:**" outside the fence is not a guard', () => {
      const text = [
        '**If `commit_docs` is true:**',
        '```bash',
        'git add "${EVAL_REVIEW_FILE}"',
        '```',
      ].join('\n');
      const { offenders } = scanText('fixture.md', text);
      assert.strictEqual(offenders.length, 1);
    });

    test('C5: the real eval-review.md shape (prose line immediately before the fence) is not a guard', () => {
      const text = [
        '## 6. Commit',
        '',
        '**If `commit_docs` is true:**',
        '```bash',
        'git add "${EVAL_REVIEW_FILE}"',
        'git commit -m "docs: add EVAL-REVIEW.md"',
        '```',
      ].join('\n');
      const { offenders } = scanText('fixture.md', text);
      assert.strictEqual(offenders.length, 1);
    });

    test('C6: a nested if inside the guard stays guarded', () => {
      const { offenders } = scanText('fixture.md', fenced([
        'COMMIT_DOCS=$(gsd_run query config-get commit_docs --default true)',
        'if [ "$COMMIT_DOCS" != "false" ]; then',
        '  if [ -f somefile ]; then',
        '    git add .planning/STATE.md',
        '  fi',
        'fi',
      ]));
      assert.deepStrictEqual(offenders, []);
    });

    test('C7: a guard in a DIFFERENT fenced block does not carry over', () => {
      const text = [
        '```bash',
        'if [ "$COMMIT_DOCS" != "false" ]; then',
        '```',
        '',
        '```bash',
        'git add .planning/STATE.md',
        '```',
      ].join('\n');
      const { offenders } = scanText('fixture.md', text);
      assert.strictEqual(offenders.length, 1);
    });

    test('C8: CRLF line endings behave identically to LF (the C1 fixture, \\r\\n joined)', () => {
      const { offenders } = scanText('fixture.md', fenced([
        'COMMIT_DOCS=$(gsd_run query config-get commit_docs --default true)',
        'if [ "$COMMIT_DOCS" != "false" ]; then',
        '  git add .planning/STATE.md',
        'fi',
      ]).split('\n').join('\r\n'));
      assert.deepStrictEqual(offenders, []);
    });

    test('C9: the = "true" polarity is a guard too (both polarities accepted)', () => {
      const { offenders } = scanText('fixture.md', fenced([
        'COMMIT_DOCS=$(gsd_run query config-get commit_docs --default true)',
        'if [ "$COMMIT_DOCS" = "true" ]; then',
        '  git add .planning/STATE.md',
        'fi',
      ]));
      assert.deepStrictEqual(offenders, []);
    });

    // PIN, not a failing-first regression test (#3585 F6): this assertion
    // does not distinguish the unclamped-ifDepth code from the clamped
    // fix — a 200k-case differential fuzz over `if`/`fi` nestings found zero
    // divergence between them, and this exact fixture passes identically on
    // pre-fix code. That is because guardOpenDepth is only ever SET from a
    // commit_docs/tracked-var-mentioning `if`, and that guard's own `fi`
    // always closes it via a RELATIVE depth comparison regardless of the
    // (possibly negative, pre-clamp) baseline. The `Math.max(0, ...)` clamp
    // is kept anyway as DEFENSIVELY correct — no input was found, in 200k
    // fuzzed cases, that makes the unclamped code diverge from the clamped
    // one. This test PINS the malformed-shell ("stray fi") behavior for
    // both versions; it does not demonstrate a fix for a reproduced defect.
    test('C10: pins malformed-shell behavior — a stray fi before an unrelated if does not manufacture a guard (fails closed)', () => {
      const { offenders } = scanText('fixture.md', fenced([
        'fi',
        'if [ "$X" = "1" ]; then',
        '  git add -A',
        'fi',
      ]));
      assert.strictEqual(offenders.length, 1, 'git add -A must still be reported as unguarded');
    });
  });

  describe('D: gsd-scan-ignore declaration handling', () => {
    const fenced = (line) => ['```bash', line, '```'].join('\n');

    test('D1: declared with a tracked issue (#3585) is exempt', () => {
      const { offenders, untracked } = scanText(
        'fixture.md',
        fenced('git add -A # gsd-scan-ignore: #3585 demonstrating the unscoped shape'),
      );
      assert.deepStrictEqual(offenders, []);
      assert.deepStrictEqual(untracked, []);
    });

    test('D2: an empty reason is malformed, not exempt', () => {
      const { offenders, untracked } = scanText(
        'fixture.md',
        fenced('git add -A # gsd-scan-ignore:'),
      );
      assert.strictEqual(offenders.length, 1, 'not exempted — still an offender');
      assert.strictEqual(untracked.length, 1, 'and reported as a malformed declaration');
    });

    test('D3: "just a note" (no tracking reference) is malformed, not exempt', () => {
      const { offenders, untracked } = scanText(
        'fixture.md',
        fenced('git add -A # gsd-scan-ignore: just a note'),
      );
      assert.strictEqual(offenders.length, 1, 'not exempted — still an offender');
      assert.strictEqual(untracked.length, 1, 'and reported as a malformed declaration');
    });

    test('D4: a marker surviving as an argv token declares nothing', () => {
      const { offenders, untracked } = scanText(
        'fixture.md',
        fenced('git add .planning/STATE.md "gsd-scan-ignore: #3585"'),
      );
      assert.strictEqual(offenders.length, 1, 'plain unguarded offender');
      assert.deepStrictEqual(untracked, [], 'the marker never reached comment position, so no declaration was attempted');
    });
  });

  // ── Property test (#3585 F5): a parser needs a property test, per
  // CLAUDE.md, mirroring the fast-check coverage already carried by the
  // sibling classifier in tests/commit-files-pathspec.test.cjs. ───────────

  describe('P: property — hasReachingGitAdd', () => {
    // Bounded alphabet, deliberately small and non-overlapping with the
    // trigger set below so a filler token never accidentally reaches on its
    // own — every failure the property can find is attributable to the
    // trigger token, not to generator noise.
    const fillerToken = fc.constantFrom('src/a.ts', 'docs/readme.md', 'foo', 'bar123', 'lib/x.js');
    const blanketFlag = fc.constantFrom('-A', '--all', '.', '-u');
    const planningPath = fc.constantFrom(
      '.planning/STATE.md',
      '.planning/todos/pending/x.md',
      '.planning/ROADMAP.md',
    );
    const triggerToken = fc.oneof(blanketFlag, planningPath);

    test('P1: a line with a blanket flag or a .planning-rooted path, and no exclude pathspec, always reaches', () => {
      fc.assert(
        fc.property(
          fc.array(fillerToken, { maxLength: 4 }),
          triggerToken,
          fc.array(fillerToken, { maxLength: 4 }),
          (before, trigger, after) => {
            const line = ['git', 'add', ...before, trigger, ...after].join(' ');
            assert.strictEqual(
              hasReachingGitAdd(line),
              true,
              `a git add line carrying a blanket flag or a .planning-rooted path, with no `
                + `exclude pathspec, must reach .planning/: ${line}`,
            );
          },
        ),
        // Pinned seed + bounded numRuns per CONTRIBUTING.md/CLAUDE.md
        // determinism rule — deterministic, replayable failures.
        { seed: 3585, numRuns: 200 },
      );
    });
  });

  // ── Layer 2: the real tree ──────────────────────────────────────────────

  test('every git add invocation in shipped content is guarded or declared', () => {
    const { offenders, untracked } = scanRepo(REPO_ROOT, SCAN_ROOTS);

    assert.deepStrictEqual(
      untracked,
      [],
      'gsd-scan-ignore: declarations without a tracking reference. Add a #NNN issue '
        + 'number or an http(s):// URL to the reason, per ADR-456:\n'
        + untracked.map((u) => `${u.file}:${u.line}: ${u.text}`).join('\n'),
    );

    assert.deepStrictEqual(
      offenders,
      [],
      'git add invocations that can reach .planning/ without a commit_docs guard or a '
        + 'tracked gsd-scan-ignore declaration (#1783 / #3585):\n\n'
        + offenders.map((o) => `${o.file}:${o.line}: ${o.text}`).join('\n'),
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2399-commit-docs-plan-phase.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2399-commit-docs-plan-phase (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2399)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #2399: commit_docs:true is ignored in plan-phase
 *
 * The plan-phase workflow generates plan artifacts but never commits them even
 * when commit_docs is true. A step between 13b and 14 must commit the PLAN.md
 * files and updated STATE.md when commit_docs is set.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');

describe('plan-phase commit_docs support (#2399)', () => {
  test('plan-phase.md exists', () => {
    assert.ok(fs.existsSync(PLAN_PHASE_PATH), 'gsd-core/workflows/plan-phase.md must exist');
  });

  test('plan-phase.md has a commit step for plan artifacts', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // Must contain a commit call that references PLAN.md files
    assert.ok(
      content.includes('PLAN.md') && content.includes('commit'),
      'plan-phase.md must include a commit step that references PLAN.md files'
    );
  });

  test('plan-phase.md commit step is gated on commit_docs', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // The commit step must be conditional on commit_docs
    assert.ok(
      content.includes('commit_docs'),
      'plan-phase.md must reference commit_docs to gate the plan commit step'
    );
  });

  test('plan-phase.md commit step references STATE.md', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // Should commit STATE.md alongside PLAN.md files
    assert.ok(
      content.includes('STATE.md'),
      'plan-phase.md commit step should include STATE.md to capture planning completion state'
    );
  });

  test('plan-phase.md has a step 13c that commits plan artifacts', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    const step13b = content.indexOf('## 13b.');
    const step14 = content.indexOf('## 14.');
    // Look for the step 13c section (or any commit step between 13b and 14)
    const step13c = content.indexOf('## 13c.');

    assert.ok(step13b !== -1, '## 13b. section must exist');
    assert.ok(step14 !== -1, '## 14. section must exist');
    assert.ok(step13c !== -1, '## 13c. step must exist (commit plans step)');
    assert.ok(
      step13c > step13b && step13c < step14,
      `Step 13c (at ${step13c}) must appear between step 13b (at ${step13b}) and step 14 (at ${step14})`
    );
  });

  test('plan-phase.md uses gsd-sdk query commit for the plan commit', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    // Must use gsd-sdk query commit (not raw git) so commit_docs guard in gsd-tools is respected
    assert.ok(
      content.includes('gsd-sdk query commit') || content.includes('gsd-tools') || content.includes('gsd-sdk'),
      'plan-phase.md plan commit step must use gsd-sdk query commit (not raw git commit)'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3678-executor-commit-docs-respect.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3678-executor-commit-docs-respect (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #3678)
// Three of the assertions in this file (A1, A2, C) inspect agent / workflow
// `.md` bodies. Those files ARE the runtime contract that GSD loads into agent
// prompts at run time, so source-text inspection is exactly what the
// `source-text-is-the-product` exception covers.
//
// The remaining assertions (B1, B2, B3) are behavioral — they invoke
// `gsd-tools commit` against a temp project and assert on its structured
// JSON return envelope plus the git index state. No raw-text matching on
// rendered output.

/**
 * Regression for #3678 — gsd-executor force-commits .planning/ files when
 * commit_docs is false.
 *
 * Root cause: the executor agent prompt (agents/gsd-executor.md) tells the
 * agent to call `gsd-sdk query commit "docs(...)" --files .planning/...`
 * in the per-plan final_commit block, but the prompt says nothing about
 * what to do when the SDK returns `{committed: false, skipped: true,
 * reason: 'skipped_commit_docs_false'}`. With no explicit instruction, the
 * agent improvises raw `git add` / `git commit` against `.planning/` paths
 * (and uses `-f` to bypass gitignore), which is exactly the leakage the
 * reporter observed.
 *
 * Fix surface:
 *   1. Agent prompt: explicit handling text in the final_commit section.
 *   2. SDK envelope: add `skipped: true` field so agents see "skipped" as a
 *      first-class success signal, not "committed is missing, must improvise."
 *   3. Structural guard: ban `git add -f` / `git add --force` from agent and
 *      workflow bodies entirely (no GSD-managed surface should force-stage
 *      gitignored content).
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// Repo root resolution. This test file lives in `<repo>/tests/`. Use a single
// parent reference (the established repo-wide pattern, e.g. tests/helpers.cjs
// `path.resolve(__dirname, '..', 'gsd-core', ...)`). A `.git`-anchored
// walker is not portable because the docker test mirror at `/work` strips the
// `.git/` directory before running tests.
const REPO_ROOT = path.resolve(__dirname, '..');

const EXECUTOR_AGENT = path.join(REPO_ROOT, 'agents', 'gsd-executor.md');

// Frozen reason enum mirrors the SDK source. Both members are now
// behaviorally pinned against the live envelope returned by `cmdCommit` in
// gsd-core/bin/lib/commands.cjs, not kept in sync by hand-reading the
// source: SKIPPED_COMMIT_DOCS_FALSE by describe block B (B1-B3, explicit
// `commit_docs: false`) and SKIPPED_GITIGNORED by describe block G (G1-G3,
// gitignore auto-detect). A production rename of either string now fails
// these tests instead of drifting silently behind the comment (#3585).
const COMMIT_REASON = Object.freeze({
  SKIPPED_COMMIT_DOCS_FALSE: 'skipped_commit_docs_false',
  SKIPPED_GITIGNORED: 'skipped_gitignored',
});

function git(args, cwd) {
  return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
}

describe('bug #3678 — executor must respect commit_docs:false', () => {

  describe('A — agent prompt teaches the agent how to handle commit_docs:false', () => {
    test('A1: agent body explicitly references the SDK skipped envelope', () => {
      const body = fs.readFileSync(EXECUTOR_AGENT, 'utf-8');
      // The prompt must contain at least one literal mention of the skipped
      // reason code OR the `committed: false` envelope so the agent knows
      // that skipping is an intentional control flow, not a failure to work
      // around.
      const mentionsSkipReason = body.includes(COMMIT_REASON.SKIPPED_COMMIT_DOCS_FALSE);
      const mentionsCommittedFalse = /committed:\s*false/i.test(body);
      const mentionsSkippedTrue = /skipped:\s*true/i.test(body);
      assert.ok(
        mentionsSkipReason || mentionsCommittedFalse || mentionsSkippedTrue,
        'agents/gsd-executor.md must teach the agent how to recognize the '
        + 'skipped envelope from `gsd-sdk query commit` (one of: '
        + `'${COMMIT_REASON.SKIPPED_COMMIT_DOCS_FALSE}', 'committed: false', `
        + "'skipped: true').",
      );
    });

    test('A2: agent body explicitly forbids raw git fallback when SDK skips', () => {
      const body = fs.readFileSync(EXECUTOR_AGENT, 'utf-8');
      // Look for an explicit instruction tying the SDK-skipped signal to the
      // forbidden-fallback rule. Accept any of three shapes the doc writer
      // might use: "do not", "must not", or "never" + a verb that names the
      // forbidden action.
      const forbidsFallbackText = /(do not|must not|never)\s+(fall back|fallback|use .*git add|run .*git commit|force[- ]?add)/i;
      assert.ok(
        forbidsFallbackText.test(body),
        'agents/gsd-executor.md must contain an explicit "do not fall back to '
        + 'raw git" instruction tied to the commit_docs:false / skipped envelope. '
        + 'Without it, the agent improvises raw `git add` / `git add -f` to '
        + 'fulfill its "complete plan" goal.',
      );
    });
  });

  describe('B — SDK behavior: commit_docs:false leaves repo state untouched', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempGitProject();
      // .planning/ already exists from createTempGitProject's setup.
      // Set commit_docs to false on the config.
      const configPath = path.join(tmpDir, '.planning', 'config.json');
      let config = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      config.commit_docs = false;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      // Make a token edit to .planning/STATE.md so there IS something the SDK
      // could in principle stage (or that an improvising agent could leak).
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      if (!fs.existsSync(statePath)) {
        fs.writeFileSync(statePath, '---\nproject: test\n---\n# State\n');
      }
      fs.appendFileSync(statePath, '\n<!-- token edit for #3678 repro -->\n');
    });

    afterEach(() => cleanup(tmpDir));

    test('B1: commit returns committed:false with skipped envelope', () => {
      const result = runGsdTools(
        'commit "docs(test): noop" --files .planning/STATE.md',
        tmpDir,
      );
      assert.ok(result.success, `gsd-tools commit should exit 0 even when skipped: ${result.error || ''}`);
      const envelope = JSON.parse(result.output);
      assert.strictEqual(envelope.committed, false, 'committed must be false when commit_docs is false');
      assert.strictEqual(
        envelope.skipped,
        true,
        'envelope must carry skipped:true so agents see skip as a first-class signal (envelope contract for #3678)',
      );
      assert.strictEqual(
        envelope.reason,
        COMMIT_REASON.SKIPPED_COMMIT_DOCS_FALSE,
        'reason must be the canonical skipped_commit_docs_false code (frozen enum)',
      );
    });

    test('B2: commit_docs:false leaves the git index empty (no .planning/ staged)', () => {
      runGsdTools(
        'commit "docs(test): noop" --files .planning/STATE.md',
        tmpDir,
      );
      const stagedAll = git(['diff', '--cached', '--name-only'], tmpDir);
      const stagedPlanning = stagedAll
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s.startsWith('.planning/'));
      assert.deepStrictEqual(
        stagedPlanning,
        [],
        'no .planning/ files should be staged when commit_docs is false',
      );
    });

    test('B3: commit_docs:false produces no new commits', () => {
      const headBefore = git(['rev-parse', 'HEAD'], tmpDir).trim();
      runGsdTools(
        'commit "docs(test): noop" --files .planning/STATE.md',
        tmpDir,
      );
      const headAfter = git(['rev-parse', 'HEAD'], tmpDir).trim();
      assert.strictEqual(
        headAfter,
        headBefore,
        'HEAD must not advance when commit_docs is false',
      );
    });
  });

  describe('G — gitignore auto-detect pins the other COMMIT_REASON member', () => {
    // Parity anchor for #3585's Generative Fix Divergence finding: describe
    // block B above behaviorally pins SKIPPED_COMMIT_DOCS_FALSE (an explicit
    // `commit_docs: false` in config.json), but SKIPPED_GITIGNORED was pinned
    // by nothing except the "keep in sync" comment on COMMIT_REASON above —
    // production could rename that string and every existing test here would
    // still pass. This block drives the OTHER path: `.planning/config.json`
    // is left absent entirely (not present-with-key-unset — a present,
    // even-empty config.json routes through loadConfigResolved's own
    // gitignore auto-detect override, which resolves `commit_docs` to
    // `false` and returns SKIPPED_COMMIT_DOCS_FALSE first, never reaching
    // the gitignored reason), so `commit_docs` is never set anywhere and the
    // skip is driven purely by `.gitignore` containing `.planning/`.
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempGitProject();
      // .planning/ already exists from createTempGitProject's setup, and no
      // config.json is written — commit_docs is left completely absent.
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '.planning/\n');
      git(['add', gitignorePath], tmpDir);
      git(['commit', '-m', 'chore: add gitignore'], tmpDir);

      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      if (!fs.existsSync(statePath)) {
        fs.writeFileSync(statePath, '---\nproject: test\n---\n# State\n');
      }
      fs.appendFileSync(statePath, '\n<!-- token edit for #3585 gitignore-auto-detect parity anchor -->\n');
    });

    afterEach(() => cleanup(tmpDir));

    test('G1: commit returns skipped:true with reason SKIPPED_GITIGNORED (parity anchor for the enum member the comment claims is kept in sync)', () => {
      const result = runGsdTools(
        'commit "docs(test): noop" --files .planning/STATE.md',
        tmpDir,
      );
      assert.ok(result.success, `gsd-tools commit should exit 0 even when skipped: ${result.error || ''}`);
      const envelope = JSON.parse(result.output);
      assert.strictEqual(envelope.skipped, true, 'envelope must carry skipped:true for the gitignore auto-detect path');
      assert.strictEqual(
        envelope.reason,
        COMMIT_REASON.SKIPPED_GITIGNORED,
        'reason must be the canonical skipped_gitignored code (frozen enum) — this is the '
        + 'behavioral pin for the member describe block B never exercises',
      );
    });

    test('G2: gitignore auto-detect skip leaves the git index empty (no .planning/ staged)', () => {
      runGsdTools(
        'commit "docs(test): noop" --files .planning/STATE.md',
        tmpDir,
      );
      const stagedAll = git(['diff', '--cached', '--name-only'], tmpDir);
      const stagedPlanning = stagedAll
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s.startsWith('.planning/'));
      assert.deepStrictEqual(
        stagedPlanning,
        [],
        'no .planning/ files should be staged when .planning/ is gitignored',
      );
    });

    test('G3: gitignore auto-detect skip produces no new commits', () => {
      const headBefore = git(['rev-parse', 'HEAD'], tmpDir).trim();
      runGsdTools(
        'commit "docs(test): noop" --files .planning/STATE.md',
        tmpDir,
      );
      const headAfter = git(['rev-parse', 'HEAD'], tmpDir).trim();
      assert.strictEqual(
        headAfter,
        headBefore,
        'HEAD must not advance when .planning/ is gitignored',
      );
    });
  });

  test('checklist carve-out preserved for intentional skip', () => {
    const body = fs.readFileSync(EXECUTOR_AGENT, 'utf-8');
    const checklistLine = body
      .split(/\r?\n/)
      .find(line => /Final metadata commit made/.test(line));
    assert.ok(
      checklistLine,
      'agents/gsd-executor.md must contain a "Final metadata commit made" checklist line',
    );
    assert.ok(
      checklistLine.includes('Final metadata commit'),
      'checklist line must reference "Final metadata commit"',
    );
    assert.ok(
      checklistLine.includes('skipped_commit_docs_false'),
      'checklist line must carve out the intentional-skip case by referencing '
      + '"skipped_commit_docs_false" — prevents executor from treating an '
      + 'unchecked mandatory box as a raw-git TODO (regression guard for #3679)',
    );
  });

  describe('C — structural ban on raw force-add in GSD-managed bodies', () => {
    function scanForForceAdd(rootDir) {
      const offenders = [];
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const body = fs.readFileSync(full, 'utf-8');
          const lines = body.split(/\r?\n/);
          const danger = lines.filter((line) => {
            if (!/git\s+add\s+(-f|--force)\b/.test(line)) return false;
            // Allow prohibition / warning sentences and code-fence prose that
            // frames `git add -f` AS the bug (so an audit comment doesn't
            // create a false positive).
            if (/(do not|don'?t|must not|never|forbidden|prohibited)/i.test(line)) return false;
            if (/(bug|wrong|incorrect|antipattern|anti-pattern|forces?\s+gitignored|leak)/i.test(line)) return false;
            return true;
          });
          if (danger.length > 0) {
            offenders.push({
              file: full.replace(REPO_ROOT + '/', ''),
              lines: danger.map(l => l.trim().slice(0, 120)),
            });
          }
        }
      }
      walk(rootDir);
      return offenders;
    }

    test('C1: no agent body contains `git add -f` / `git add --force`', () => {
      const offenders = scanForForceAdd(path.join(REPO_ROOT, 'agents'));
      assert.deepStrictEqual(
        offenders,
        [],
        'no agent body may use `git add -f` / `git add --force` outside a '
        + 'prohibition sentence — agents must never force-stage gitignored '
        + 'content (regression guard for #3678).',
      );
    });

    test('C2: no workflow body contains `git add -f` / `git add --force`', () => {
      const offenders = scanForForceAdd(path.join(REPO_ROOT, 'gsd-core', 'workflows'));
      assert.deepStrictEqual(
        offenders,
        [],
        'no workflow body may use `git add -f` / `git add --force` outside a '
        + 'prohibition sentence (regression guard for #3678).',
      );
    });
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/phase-commit-docs.test.cjs — #3587 (epic #2292 Phase 3)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:phase-commit-docs (#3587, epic #2292 Phase 3)", () => {
'use strict';

/**
 * #3587 (epic #2292 Phase 3) — per-phase `commit_docs` override.
 *
 * A tech lead can mark a single phase's docs to be committed (or suppressed)
 * independently of the project-wide `commit_docs` setting, via the dynamic
 * config key `phase_commit_docs.<phase-id>`. See
 * `.gsd/phase/feat-3587-per-phase-commit-docs/40-design.md` for the
 * precedence chain (phase > config > gitignore > default) and
 * `50-test-matrix.md` for the matrix this file implements (A/B/C/D/F —
 * E lives in this file's own 'E' describe block below).
 *
 * All assertions are on STRUCTURED values (`resolved`, `source`, `reason`),
 * never on rendered/prose text (CONTRIBUTING.md — Prohibited: Raw Text
 * Matching on Test Outputs).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, createTempGitProject, captureFdSync } = require('./helpers.cjs');
const { seedPhase } = require('./fixtures/index.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const commands = require('../gsd-core/bin/lib/commands.cjs');
const configCli = require('../gsd-core/bin/lib/config.cjs');
const { loadConfigResolved, CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/config-loader.cjs');
const io = require('../gsd-core/bin/lib/io.cjs');
const { ExitError } = require('../gsd-core/bin/lib/cli-exit.cjs');
const { PHASE_NUMBER_TOKEN_SOURCE } = require('../gsd-core/bin/lib/phase-id.cjs');
const { DYNAMIC_KEY_PATTERNS } = require('../gsd-core/bin/lib/config-schema.cjs');

const {
  detectPhaseNumberFromFiles,
  resolvePhaseCommitDocsOverride,
  resolveCommitDocsPolicy,
  COMMIT_DOCS_SKIP_REASON,
  cmdCommit,
} = commands;

function git(args, cwd) {
  return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
}

function writeConfig(tmpDir, config) {
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
}

/**
 * bin/lib/io.cjs's output()/error() write directly to the raw fd via
 * fs.writeSync (bypassing console), so console-capture helpers cannot see
 * them. Monkeypatch fs.writeSync, save/restore in a finally — mirrors
 * tests/config-get-default.test.cjs's captureFdWrite.
 */
function captureFdWrite(fd, fn) {
  return captureFdSync(fd, fn);
}

function runCommit(tmpDir, message, files) {
  const out = captureFdWrite(1, () => {
    cmdCommit(tmpDir, message, files, false, false, false);
  });
  return JSON.parse(out);
}

/** Drives cmdConfigSet in-process (mirrors tests/config-get-default.test.cjs's
 * runExpectError) for the one negative (A4) case that must exercise error()'s
 * ExitError-throwing path (ADR-3889 — error() throws ExitError directly, it
 * no longer calls process.exit()). */
function runConfigSetExpectError(tmpDir, keyPath, value) {
  io.setJsonErrorMode(true);
  let capturedStderr = '';
  try {
    capturedStderr = captureFdSync(2, () => {
      try {
        configCli.cmdConfigSet(tmpDir, keyPath, value, true);
        assert.fail('expected cmdConfigSet to throw ExitError');
      } catch (inner) {
        if (!(inner instanceof ExitError)) throw inner;
      }
    });
  } finally {
    io.setJsonErrorMode(false);
  }
  const parts = capturedStderr.split('\n').filter(Boolean);
  let payload = {};
  try { payload = JSON.parse(parts[parts.length - 1]); } catch { /* leave {} */ }
  return payload;
}

describe('#3587 per-phase commit_docs override', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempGitProject(); });
  afterEach(() => cleanup(tmpDir));

  // ── A: registration — the key must actually exist ──────────────────────
  describe('A: registration', () => {
    test('A1: perPhaseKeyRoundTripsThroughCli — config-set phase_commit_docs.03 true persists to config.json', () => {
      captureFdWrite(1, () => configCli.cmdConfigSet(tmpDir, 'phase_commit_docs.03', 'true', true));
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
      assert.deepStrictEqual(onDisk.phase_commit_docs, { '03': true });
    });

    test('A2: perPhaseKeyReadsBack — config-get phase_commit_docs.03 returns the value', () => {
      writeConfig(tmpDir, { phase_commit_docs: { '03': true } });
      const out = captureFdWrite(1, () => configCli.cmdConfigGet(tmpDir, 'phase_commit_docs.03', true, undefined));
      assert.strictEqual(out.trim(), 'true');
    });

    test('A3: perPhaseKeySurvivesLoadConfig — present in schema but absent from defaults manifest is NOT silently dropped', () => {
      writeConfig(tmpDir, { phase_commit_docs: { '03': true, '07': false } });
      const { config } = loadConfigResolved(tmpDir, { workstream: null });
      assert.deepStrictEqual(config.phase_commit_docs, { '03': true, '07': false });
    });

    test('A3b: with no phase_commit_docs key at all, loadConfig projects an empty object (never undefined)', () => {
      writeConfig(tmpDir, { commit_docs: true });
      const { config } = loadConfigResolved(tmpDir, { workstream: null });
      assert.deepStrictEqual(config.phase_commit_docs, {});
    });

    test('A4: malformedPhaseKeyIsRejectedNotFatal — phase_commit_docs.<malformed> is rejected as unknown, not fatal', () => {
      const payload = runConfigSetExpectError(tmpDir, 'phase_commit_docs.not-a-phase-number', 'true');
      assert.strictEqual(payload.reason, io.ERROR_REASON.CONFIG_INVALID_KEY);
      // Non-fatal to the process itself: no exception escaped runConfigSetExpectError,
      // i.e. error() was reached and returned control via the sentinel exit only.
    });

    test('A5: configDefaultsProjectionParity — the CONFIG_DEFAULTS flat projection needs no entry, matching the agent_skills/features dynamic-key precedent', () => {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, 'phase_commit_docs'),
        false,
        'phase_commit_docs is an object-shaped dynamic-key family (like agent_skills/features); ' +
        'the flat CONFIG_DEFAULTS projection in config-loader.cjs carries no entry for either ' +
        'precedent, and phase_commit_docs is read purely from parsed config, never from defaults.phase_commit_docs',
      );
    });
  });

  // ── B: resolution — the precedence chain (pure function, no I/O) ───────
  describe('B: resolution', () => {
    const noGitIgnore = () => false;
    const gitIgnored = () => true;

    test('B1: perPhaseBeatsConfig — P=true, C=false resolves true, source phase', () => {
      const config = { commit_docs: false, phase_commit_docs: { '03': true } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' });
    });

    test('B2: perPhaseSuppressesAgainstConfig — P=false, C=true resolves false, source phase', () => {
      const config = { commit_docs: true, phase_commit_docs: { '03': false } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: false, source: 'phase' });
    });

    test('B3: perPhaseBeatsGitignoreAutoDetect — P=true, G=true resolves true, source phase', () => {
      const config = { commit_docs: true, phase_commit_docs: { '03': true } };
      const r = resolveCommitDocsPolicy(config, '03', gitIgnored);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' });
    });

    test('B4: phaseIdNormalizesAcrossForms — P set as "3", phase committed is "03"', () => {
      const config = { commit_docs: false, phase_commit_docs: { '3': true } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' });
    });

    test('B4b: phaseIdNormalizesAcrossForms — a project-code-prefixed committed phase ("PROJ-03") hits the bare "03" entry', () => {
      const config = { commit_docs: false, phase_commit_docs: { '03': true } };
      const r = resolveCommitDocsPolicy(config, 'PROJ-03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' });
    });

    test('B5: perPhaseDoesNotLeakAcrossPhases — P set for phase 04, committing phase 03 falls to tier 2', () => {
      const config = { commit_docs: true, phase_commit_docs: { '04': false } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'default' });
    });

    test('B6: nonBooleanPerPhaseValueIsNotCoerced — string "true" is not coerced, falls through to config', () => {
      const config = { commit_docs: false, phase_commit_docs: { '03': 'true' } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: false, source: 'config' });
    });

    test('B6b: nonBooleanPerPhaseValueIsNotCoerced — numeric 1 is not coerced', () => {
      const config = { commit_docs: true, phase_commit_docs: { '03': 1 } };
      const r = resolveCommitDocsPolicy(config, '03', gitIgnored);
      assert.deepStrictEqual(r, { resolved: false, source: 'gitignore' });
    });

    test('B6c: nonBooleanPerPhaseValueIsNotCoerced — null is not coerced', () => {
      const config = { commit_docs: true, phase_commit_docs: { '03': null } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'default' });
    });

    test('B7: noPhaseFallsToProjectSetting — commit names no phase-scoped file, tier 1 inapplicable', () => {
      const config = { commit_docs: false, phase_commit_docs: { '03': true } };
      const r = resolveCommitDocsPolicy(config, null, noGitIgnore);
      assert.deepStrictEqual(r, { resolved: false, source: 'config' });
    });

    test('B8: projectCodeDigitDoesNotMisresolvePhase — a project code ending in a digit resolves phase 07, not 2 (#2539 shape)', () => {
      const files = ['.planning/phases/PROJECT_V2-07-widgets/07-PLAN.md'];
      const phaseNum = detectPhaseNumberFromFiles(files);
      assert.strictEqual(phaseNum, 'PROJECT_V2-07');
      const config = { commit_docs: false, phase_commit_docs: { '07': true } };
      const r = resolveCommitDocsPolicy(config, phaseNum, noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' },
        'must resolve against phase 07 (the real phase), never phase 2 (the digit inside "V2-")');
    });

    test('B9: an override map that is not an object is inert, not thrown', () => {
      const config = { commit_docs: false, phase_commit_docs: 'not-an-object' };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: false, source: 'config' });
    });

    test('resolvePhaseCommitDocsOverride returns undefined for a null phase', () => {
      assert.strictEqual(resolvePhaseCommitDocsOverride({ phase_commit_docs: { '03': true } }, null), undefined);
    });

    // Pin, not a bug (#3587 F3 — security review): detectPhaseNumberFromFiles is
    // pre-existing, hardened, widely-used logic that this phase deliberately does
    // not touch. It returns the phase of the FIRST matching path in `--files`, so
    // a commit whose `--files` spans two phase directories resolves the tier-1
    // override against whichever phase appears first, not the majority. A pinned,
    // named behavior is not a bug; an unpinned surprise is. See "Known limits" in
    // `.gsd/phase/feat-3587-per-phase-commit-docs/40-design.md` and
    // `docs/CONFIGURATION.md`'s per-phase section.
    test('multiPhaseFilesResolvesAgainstFirstPhase — --files spanning two phase directories with DIFFERENT phase_commit_docs values resolves against the FIRST phase, not the majority', () => {
      const files = [
        '.planning/phases/03-widgets/03-PLAN.md',
        '.planning/phases/04-gadgets/04-PLAN.md',
      ];
      const phaseNum = detectPhaseNumberFromFiles(files);
      assert.strictEqual(phaseNum, '03', 'detectPhaseNumberFromFiles returns the phase of the first matching path');

      const config = { commit_docs: false, phase_commit_docs: { '03': true, '04': false } };
      const r = resolveCommitDocsPolicy(config, phaseNum, () => false);
      assert.deepStrictEqual(
        r,
        { resolved: true, source: 'phase' },
        'the override resolves against phase 03 (first in --files) even though phase 04 disagrees',
      );
    });
  });

  // ── C: AC4 — regression, the release blocker ────────────────────────────
  // C1-C3 assert the byte-identical-to-`next` behavior using ONLY pre-existing
  // surfaces (cmdCommit's envelope, loadConfigResolved) — no #3587 API — so
  // this exact test code is valid evidence run against the unmodified tree
  // too (see the dispatch's VERIFY step 1: these were run against `next`
  // first, before the tier-1 change landed, and passed identically).
  describe('C: AC4 regression (must hold identically with no per-phase key set)', () => {
    test('C1: unsetPerPhaseIsByteIdenticalConfigFalse — no per-phase key, C=false skips with the pre-existing reason', () => {
      writeConfig(tmpDir, { commit_docs: false });
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, '# State\n');
      const envelope = runCommit(tmpDir, 'docs(test): noop', ['.planning/STATE.md']);
      assert.strictEqual(envelope.committed, false);
      assert.strictEqual(envelope.skipped, true);
      assert.strictEqual(envelope.reason, 'skipped_commit_docs_false');
    });

    test('C2: unsetPerPhaseIsByteIdenticalGitignored — no per-phase key, C unset, G=true skips with the pre-existing reason', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.planning/\n');
      git(['add', '.gitignore'], tmpDir);
      git(['commit', '-m', 'chore: gitignore'], tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, '# State\n');
      const envelope = runCommit(tmpDir, 'docs(test): noop', ['.planning/STATE.md']);
      assert.strictEqual(envelope.committed, false);
      assert.strictEqual(envelope.skipped, true);
      assert.strictEqual(envelope.reason, 'skipped_gitignored');
    });

    test('C3: unsetPerPhaseIsByteIdenticalDefault — no per-phase key, C unset, G=false commits as today', () => {
      writeConfig(tmpDir, {});
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, '# State\n');
      const headBefore = git(['rev-parse', 'HEAD'], tmpDir).trim();
      const envelope = runCommit(tmpDir, 'docs(test): noop', ['.planning/STATE.md']);
      assert.strictEqual(envelope.committed, true);
      const headAfter = git(['rev-parse', 'HEAD'], tmpDir).trim();
      assert.notStrictEqual(headAfter, headBefore, 'a real commit must have been made');
    });

    test('C5: loadConfigUnchangedWithoutPerPhaseKey — loadConfigResolved output is unchanged in shape/values with no per-phase key', () => {
      writeConfig(tmpDir, { commit_docs: true, model_profile: 'balanced' });
      const { config, source, degraded, reason } = loadConfigResolved(tmpDir, { workstream: null });
      assert.strictEqual(config.commit_docs, true);
      assert.strictEqual(config.model_profile, 'balanced');
      assert.strictEqual(source, 'root');
      assert.strictEqual(degraded, false);
      assert.strictEqual(reason, 'resolved');
      // The universal seam gained a harmless empty-object projection (A3b) —
      // additive, never a behavior change for a caller that never reads the key.
      assert.deepStrictEqual(config.phase_commit_docs, {});
    });
  });

  // ── D: envelope contract ─────────────────────────────────────────────────
  describe('D: envelope contract', () => {
    test('D1: perPhaseSuppressionHasOwnReason — per-phase suppression gets a reason distinct from skipped_commit_docs_false', () => {
      writeConfig(tmpDir, { commit_docs: true, phase_commit_docs: { '03': false } });
      seedPhase(tmpDir, '03-widgets', { '03-PLAN.md': '# Plan\n' });
      const envelope = runCommit(tmpDir, 'docs(test): noop', ['.planning/phases/03-widgets/03-PLAN.md']);
      assert.strictEqual(envelope.committed, false);
      assert.strictEqual(envelope.skipped, true);
      assert.strictEqual(envelope.reason, COMMIT_DOCS_SKIP_REASON.phase);
      assert.notStrictEqual(envelope.reason, 'skipped_commit_docs_false');
    });

    test('D2: existingReasonStringsUnchanged — the two pre-existing reason strings are unchanged (agents/gsd-executor.md pattern-matches on them)', () => {
      assert.strictEqual(COMMIT_DOCS_SKIP_REASON.config, 'skipped_commit_docs_false');
      assert.strictEqual(COMMIT_DOCS_SKIP_REASON.gitignore, 'skipped_gitignored');
    });

    test('D3: perPhaseEnableActuallyCommits — per-phase override ENABLES a commit under project commit_docs:false; the file lands', () => {
      writeConfig(tmpDir, { commit_docs: false, phase_commit_docs: { '03': true } });
      seedPhase(tmpDir, '03-widgets', { '03-PLAN.md': '# Plan\n' });
      const headBefore = git(['rev-parse', 'HEAD'], tmpDir).trim();
      const envelope = runCommit(tmpDir, 'docs(test): plan', ['.planning/phases/03-widgets/03-PLAN.md']);
      assert.strictEqual(envelope.committed, true);
      const headAfter = git(['rev-parse', 'HEAD'], tmpDir).trim();
      assert.notStrictEqual(headAfter, headBefore);
      const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD'], tmpDir)
        .split('\n').map((s) => s.trim()).filter(Boolean);
      assert.ok(
        committedFiles.includes('.planning/phases/03-widgets/03-PLAN.md'),
        `expected the per-phase-enabled file to land in the commit; got: ${committedFiles.join(', ')}`,
      );
    });
  });

  // ── E: parity — the divergence the design named ─────────────────────────
  // config-schema.manifest.json is hand-maintained JSON, so its
  // phase_commit_docs.<phase-id> pattern is necessarily a SECOND, hand-copied
  // statement of the canonical PHASE_NUMBER_TOKEN_SOURCE grammar
  // (src/phase-id.cts, #2128) — this repo's "Generative Fix Divergence" class
  // (CLAUDE.md). BEHAVIORAL over a shared shape list — not a source-grep of
  // the regex text — because the point is that the two surfaces agree on
  // INPUTS, not that they share characters.
  describe('E: manifest/canonical-grammar parity for phase_commit_docs.<phase-id>', () => {
    const manifestEntry = DYNAMIC_KEY_PATTERNS.find((p) => p.topLevel === 'phase_commit_docs');

    // No 'i' flag: PHASE_NUMBER_TOKEN_SOURCE's own default reading is
    // case-sensitive (uppercase-only `[A-Z]` letter suffix), and the
    // manifest's regex (recompiled via `new RegExp(p.source)` in
    // src/configuration.cts, no flags) is built from the same case-sensitive
    // source string. Parity must hold at that same case sensitivity, or a
    // divergence in flags would go undetected.
    const canonicalPhaseIdRe = new RegExp(`^${PHASE_NUMBER_TOKEN_SOURCE}$`);
    const canonicalAccepts = (shape) => canonicalPhaseIdRe.test(shape);
    const manifestAccepts = (shape) => manifestEntry.test(`phase_commit_docs.${shape}`);

    test('the dynamicKeyPatterns entry for phase_commit_docs exists', () => {
      assert.ok(manifestEntry, 'config-schema.manifest.json must carry a phase_commit_docs dynamicKeyPatterns entry');
    });

    const acceptedShapes = [
      '0', '1', '01', '003', '12A', '1.2', '12.34', '1.2.3', '999', '12A.3', '0.0.0',
    ];

    describe('E1: manifestPhasePatternMatchesCanonicalGrammar', () => {
      for (const shape of acceptedShapes) {
        test(`accepted shape "${shape}" is accepted by both surfaces`, () => {
          assert.strictEqual(canonicalAccepts(shape), true, `test fixture bug: canonical grammar must accept "${shape}"`);
          assert.strictEqual(manifestAccepts(shape), true, `manifest pattern rejected canonical-accepted shape "${shape}"`);
        });
      }
    });

    const rejectedShapes = [
      '', 'a', '1a', '01-a', '.1', '1.', '1..2', 'PROJ-01', '01 02', '1_2', '12AB', '1.a', '-1', '1-2', 'AB',
    ];

    describe('E2: manifestPhasePatternRejectsSameShapes', () => {
      for (const shape of rejectedShapes) {
        test(`rejected shape "${JSON.stringify(shape)}" is rejected by both surfaces`, () => {
          assert.strictEqual(canonicalAccepts(shape), false, `test fixture bug: canonical grammar must reject "${shape}"`);
          assert.strictEqual(manifestAccepts(shape), false, `manifest pattern accepted canonical-rejected shape "${shape}"`);
        });
      }
    });

    // Bonus robustness: over a bounded, seeded fuzz of arbitrary short
    // strings, the two surfaces must never disagree — catches a shape
    // neither hand-picked list happened to cover.
    test('property: manifest and canonical grammar agree on arbitrary short strings', () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 8 }),
          (shape) => {
            assert.strictEqual(
              manifestAccepts(shape),
              canonicalAccepts(shape),
              `disagreement on shape ${JSON.stringify(shape)}`,
            );
          },
        ),
      );
    });
  });

  // ── F: property — resolution is total, and source is honest ────────────
  describe('F: property', () => {
    const phaseArb = fc.constantFrom(null, '03', '3', '04', 'PROJ-03', '12A', '3.2');
    const overrideValueArb = fc.oneof(
      fc.boolean(),
      fc.constant('true'),
      fc.constant(1),
      fc.constant(null),
      fc.string({ maxLength: 5 }),
    );
    const overridesArb = fc.dictionary(
      fc.constantFrom('03', '3', '04', '12A', '3.2', 'not-a-phase'),
      overrideValueArb,
      { maxKeys: 4 },
    );
    const commitDocsArb = fc.boolean();
    const gitIgnoredArb = fc.boolean();

    test('F1: resolutionIsTotalAndSourceIsHonest — resolution is total (boolean + a valid source), and the reported source names the tier that actually decided', () => {
      fc.assert(
        fc.property(
          phaseArb, overridesArb, commitDocsArb, gitIgnoredArb,
          (phaseNum, overrides, commitDocs, gitIgnored) => {
            const config = { commit_docs: commitDocs, phase_commit_docs: overrides };
            const r = resolveCommitDocsPolicy(config, phaseNum, () => gitIgnored);

            // Totality: always a boolean resolution and a known source.
            assert.strictEqual(typeof r.resolved, 'boolean');
            assert.ok(['phase', 'config', 'gitignore', 'default'].includes(r.source));

            // Honesty: recompute independently what SHOULD have decided it, and
            // require the reported source to match.
            const override = resolvePhaseCommitDocsOverride(config, phaseNum);
            if (override !== undefined) {
              assert.strictEqual(r.source, 'phase');
              assert.strictEqual(r.resolved, override);
              return;
            }
            if (!commitDocs) {
              assert.strictEqual(r.source, 'config');
              assert.strictEqual(r.resolved, false);
              return;
            }
            if (gitIgnored) {
              assert.strictEqual(r.source, 'gitignore');
              assert.strictEqual(r.resolved, false);
              return;
            }
            assert.strictEqual(r.source, 'default');
            assert.strictEqual(r.resolved, true);
          },
        ),
      );
    });
  });
});
  });
}
