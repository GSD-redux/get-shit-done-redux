/**
 * commit_docs bypass guard tests (#1783)
 *
 * When users set commit_docs: false during /gsd-new-project, .planning/
 * files should never be staged or committed. The gsd-tools.cjs commit
 * wrapper already checks this flag, but three locations in execute-phase.md
 * and quick.md used raw `git add .planning/` commands that bypassed it.
 *
 * These tests verify that every `git add .planning/` invocation (explicit
 * or via file_list) is preceded by a commit_docs config check.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXECUTE_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const QUICK_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

describe('commit_docs bypass guard (#1783)', () => {

  test('execute-phase.md: every git add .planning/ has a commit_docs guard', () => {
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (/git add\b.*\.planning\//.test(lines[i])) {
        // Search backwards from this line for a config-get commit_docs check
        const windowStart = Math.max(0, i - 10);
        const window = lines.slice(windowStart, i).join('\n');
        assert.ok(
          window.includes('config-get commit_docs'),
          `git add .planning/ at line ${i + 1} in execute-phase.md must be guarded by a commit_docs config check`
        );
      }
    }
  });

  test('quick.md: every git add .planning/ has a commit_docs guard', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (/git add\b.*\.planning\//.test(lines[i])) {
        const windowStart = Math.max(0, i - 10);
        const window = lines.slice(windowStart, i).join('\n');
        assert.ok(
          window.includes('config-get commit_docs'),
          `git add .planning/ at line ${i + 1} in quick.md must be guarded by a commit_docs config check`
        );
      }
    }
  });

  test('quick.md: git add ${file_list} has a commit_docs guard for .planning/ filtering', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);

    // Find the line(s) that do `git add ${file_list}` — this variable
    // includes .planning/STATE.md so it needs a commit_docs guard too
    for (let i = 0; i < lines.length; i++) {
      if (/git add\s+\$\{?file_list/.test(lines[i])) {
        const windowStart = Math.max(0, i - 10);
        const window = lines.slice(windowStart, i + 1).join('\n');
        assert.ok(
          window.includes('config-get commit_docs'),
          `git add \${file_list} at line ${i + 1} in quick.md must be guarded by a commit_docs check ` +
          `because file_list includes .planning/ files`
        );
      }
    }
  });

  test('no raw git add .planning/ without commit_docs guard in any workflow', () => {
    const workflows = [
      { name: 'execute-phase.md', path: EXECUTE_PHASE_PATH },
      { name: 'quick.md', path: QUICK_PATH },
    ];

    for (const wf of workflows) {
      const content = fs.readFileSync(wf.path, 'utf-8');

      // Find all occurrences of git add that reference .planning/
      const regex = /git add\b[^\r\n]*\.planning\//g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        // Get the 500-char window before this match
        const before = content.slice(Math.max(0, match.index - 500), match.index);
        assert.ok(
          before.includes('config-get commit_docs'),
          `${wf.name}: found unguarded git add .planning/ near offset ${match.index}. ` +
          `All raw git add .planning/ commands must check commit_docs config first.`
        );
      }
    }
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

// Frozen reason enum mirrors the SDK source — keep in sync with
// `cmdCommit` in gsd-core/bin/lib/commands.cjs.
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
