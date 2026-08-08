'use strict';

/**
 * E2E content tests for execute:post hook resolution and tdd.review-checkpoint gate.
 *
 * Hook point: execute:post
 * Focus:
 *   - loop render-hooks execute:post typed envelope (step + gate ordering, both-on / tdd-off / both-off)
 *   - check tdd.review-checkpoint via CLI subprocess with real git fixtures:
 *     RED+GREEN → block:false,violations:0,Pass
 *     no commits → block:true,missing:[RED,GREEN]
 *     RED only → block:true,missing:[GREEN]
 *     no type:tdd plans → block:false,tddPlans:0
 *     violations=1 boundary → block:true with advisory table
 *     missing phase arg → exitCode:1
 *   - rendered text format: Step 1 code-review before Gate tdd
 *
 * HARD RULES followed:
 * - CONTENT/E2E only: every test drives a real CLI subprocess or real resolver
 * - No readFileSync source-grep (scripts/lint-no-source-grep.cjs would reject it)
 * - Genuine assertions: negative/BVA cases assert the SPECIFIC differing value
 * - Fully isolated: each test has its own createTempProject / createTempGitProject
 * - Git fixtures use real file commits (not --allow-empty) so git log --grep -- . matches
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ─── Git fixture helper (inlined — do NOT modify helpers.cjs) ──────────────────

/**
 * Create a temp dir with a git repo and initial commit containing a .planning/
 * phases directory structure. Commits real files (not --allow-empty) so that
 * git log --grep -- . works correctly (the -- path filter skips empty-tree commits).
 *
 * Returns { tmpDir } — cleanup() in afterEach.
 */
function createTddGitFixture({ planFiles = [] } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tdd-e2e-'));

  function git(...args) {
    return gitOrThrow(args, {
      cwd: tmpDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    }).trim();
  }

  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');

  // Create planning directory
  const planningDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(planningDir, { recursive: true });

  // Write plan files
  for (const { dir, filename, content } of planFiles) {
    const phaseDir = path.join(phasesDir, dir);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, filename), content, 'utf8');
  }

  // Write a config.json with git tracking so initial commit has a real file
  fs.writeFileSync(path.join(planningDir, 'config.json'), '{}', 'utf8');

  git('add', '.');
  git('commit', '-m', 'init: project scaffold');

  return { tmpDir, git };
}

/**
 * Build a type:tdd PLAN.md frontmatter block content.
 */
function tddPlan(phaseNum, planId) {
  return `---\ntype: tdd\nphase: ${phaseNum}\nslug: ${planId}\n---\n# Task: ${planId}\n`;
}

/**
 * Same as tddPlan but with CRLF line endings — reproduces #2449.
 * Some Windows editors / toolchains write PLAN.md with CRLF; with
 * core.autocrlf=input the working-tree CRLF is invisible to git diff/status
 * (the blob is normalized on commit), so the contributor cannot tell their
 * plan is being silently misclassified.
 */
function tddPlanCrlf(phaseNum, planId) {
  return `---\r\ntype: tdd\r\nphase: ${phaseNum}\r\nslug: ${planId}\r\n---\r\n# Task: ${planId}\r\n`;
}

/**
 * Mixed-endings variant: CRLF frontmatter + LF body. Realistic when a Windows
 * editor normalizes Markdown body text but preserves frontmatter byte-for-byte,
 * or when tooling concatenates CRLF + LF fragments. The frontmatter delimiter
 * still must match (the bug class), and the LF body must not be confused by
 * downstream code that splits on \n (it gets an LF-prefixed body).
 */
function tddPlanMixedCrlfLf(phaseNum, planId) {
  return `---\r\ntype: tdd\r\nphase: ${phaseNum}\r\nslug: ${planId}\r\n---\n# Task: ${planId}\n`;
}

/**
 * Build a type:execute PLAN.md (non-TDD) content.
 */
function executePlan(phaseNum, planId) {
  return `---\ntype: execute\nphase: ${phaseNum}\nslug: ${planId}\n---\n# Task: ${planId}\n`;
}

/**
 * Commit a real file in the git fixture with the given commit message.
 * Needed because git log --grep with -- path filter only matches commits
 * that changed at least one tracked file.
 */
function commitFile(git, tmpDir, filename, commitMessage) {
  const filepath = path.join(tmpDir, filename);
  // Append timestamp to make each file unique
  fs.writeFileSync(filepath, `${commitMessage}\n${Date.now()}\n`, 'utf8');
  git('add', filepath);
  git('commit', '-m', commitMessage);
}

// ─── Helpers for subprocess invocation ────────────────────────────────────────

const TEST_ENV_BASE = {
  GSD_SESSION_KEY: '',
  CODEX_THREAD_ID: '',
  CLAUDE_SESSION_ID: '',
  CLAUDE_CODE_SSE_PORT: '',
  OPENCODE_SESSION_ID: '',
  GEMINI_SESSION_ID: '',
  CURSOR_SESSION_ID: '',
  WINDSURF_SESSION_ID: '',
  TERM_SESSION_ID: '',
  WT_SESSION: '',
  TMUX_PANE: '',
  ZELLIJ_SESSION_NAME: '',
  TTY: '',
  SSH_TTY: '',
};

function runTools(args, cwd) {
  const argv = Array.isArray(args)
    ? args
    : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
        .map((t) => t.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1'));

  try {
    const stdout = execFileSync(process.execPath, [TOOLS_PATH, ...argv], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...TEST_ENV_BASE },
      timeout: 60000,
    });
    return { success: true, output: stdout.trim(), exitCode: 0, error: '' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message,
      exitCode: err.status ?? 1,
    };
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('execute:post render-hooks — typed envelope resolution', () => {
  let tmpDir;

  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('[happy] tdd_mode=true and code_review=true: both hooks in typed shape with step before gate', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ep-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { code_review: true, tdd_mode: true } }),
      'utf8'
    );

    const result = runTools('loop render-hooks execute:post --raw', tmpDir);
    assert.ok(result.success, `render-hooks should succeed. stderr: ${result.error}`);

    const envelope = JSON.parse(result.output);
    assert.strictEqual(envelope.point, 'execute:post', 'point field must be execute:post');
    assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be an array');
    assert.strictEqual(envelope.activeHooks.length, 2, 'both hooks (step + gate) must be active');

    // Step 1: code-review step (must come before gate)
    const step = envelope.activeHooks[0];
    assert.strictEqual(step.kind, 'step', 'first hook must be a step');
    assert.strictEqual(step.capId, 'code-review', 'step capId must be code-review');
    assert.deepStrictEqual(step.ref, { skill: 'code-review' }, 'step ref must point to code-review skill');
    assert.ok(Array.isArray(step.produces), 'produces must be array');
    assert.ok(step.produces.includes('REVIEW.md'), 'step must produce REVIEW.md');
    assert.strictEqual(step.onError, 'skip', 'code-review step onError must be skip');

    // Gate: tdd advisory gate (must come after step)
    const gate = envelope.activeHooks[1];
    assert.strictEqual(gate.kind, 'gate', 'second hook must be a gate');
    assert.strictEqual(gate.capId, 'tdd', 'gate capId must be tdd');
    assert.deepStrictEqual(gate.check, { query: 'tdd.review-checkpoint' }, 'gate check query must match');
    assert.strictEqual(gate.blocking, false, 'tdd gate must be advisory (blocking=false)');
  });

  test('[negative] code_review=false and tdd_mode=false: empty activeHooks with no-hooks rendered text', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ep-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { code_review: false, tdd_mode: false } }),
      'utf8'
    );

    const result = runTools('loop render-hooks execute:post --raw', tmpDir);
    assert.ok(result.success, `render-hooks should succeed even with both disabled. stderr: ${result.error}`);

    const envelope = JSON.parse(result.output);
    assert.strictEqual(envelope.point, 'execute:post');
    // SPECIFIC assertion: 0 hooks, not 1 or 2
    assert.strictEqual(envelope.activeHooks.length, 0, 'both disabled: must return ZERO active hooks, not any');
    assert.ok(
      envelope.rendered.includes('_No active hooks at execute:post._'),
      `rendered must contain placeholder text, got: ${envelope.rendered}`
    );
  });

  test('[negative] tdd_mode=false excludes tdd gate but code-review step active by schema default', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ep-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { tdd_mode: false } }),
      'utf8'
    );

    const result = runTools('loop render-hooks execute:post --raw', tmpDir);
    assert.ok(result.success, `render-hooks should succeed. stderr: ${result.error}`);

    const envelope = JSON.parse(result.output);
    // SPECIFIC assertion: exactly 1 hook (code-review only), not 0 or 2
    assert.strictEqual(envelope.activeHooks.length, 1, 'tdd_mode=false: exactly 1 hook (step only), not 2');
    assert.strictEqual(envelope.activeHooks[0].capId, 'code-review', 'sole hook must be code-review step');
    assert.strictEqual(envelope.activeHooks[0].kind, 'step', 'sole hook must be kind=step');
    // Confirm tdd gate is absent
    const tddHook = envelope.activeHooks.find((h) => h.capId === 'tdd');
    assert.strictEqual(tddHook, undefined, 'no tdd gate hook must be present when tdd_mode=false');
  });

  test('[happy] rendered text format: Step 1 code-review before Gate tdd in correct markdown', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ep-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { code_review: true, tdd_mode: true } }),
      'utf8'
    );

    const result = runTools('loop render-hooks execute:post --raw', tmpDir);
    assert.ok(result.success, `render-hooks should succeed. stderr: ${result.error}`);

    const envelope = JSON.parse(result.output);
    const rendered = envelope.rendered;

    // Step 1 code-review heading must appear first
    assert.ok(
      rendered.includes('### Step 1: skill:code-review (code-review)'),
      `rendered must start with Step 1 heading. got: ${rendered.slice(0, 200)}`
    );
    // produces and consumes in step section
    assert.ok(rendered.includes('produces: REVIEW.md'), 'rendered must include produces: REVIEW.md');
    assert.ok(rendered.includes('consumes: SUMMARY.md'), 'rendered must include consumes: SUMMARY.md');
    // when key for code-review step
    assert.ok(rendered.includes('when: `workflow.code_review`'), 'rendered must include when for code-review');
    // Gate tdd appears AFTER the step
    assert.ok(
      rendered.includes('**Gate** (tdd): check={"query":"tdd.review-checkpoint"}, blocking=false, onError=skip'),
      `rendered must include Gate tdd section. got: ${rendered}`
    );
    // Step 1 must come before the gate
    const step1Idx = rendered.indexOf('### Step 1');
    const gateIdx = rendered.indexOf('**Gate** (tdd)');
    assert.ok(step1Idx < gateIdx, 'Step 1 code-review must appear before Gate tdd in rendered text');
  });
});

// ─── check tdd.review-checkpoint via CLI — git fixture tests ───────────────────

describe('check tdd.review-checkpoint — CLI subprocess E2E with git fixtures', () => {
  test('[happy] RED+GREEN commits present: block:false, violations:0, status Pass', () => {
    const { tmpDir, git } = createTddGitFixture({
      planFiles: [
        { dir: '01-phase1', filename: '01-01-PLAN.md', content: tddPlan(1, '01-01') },
      ],
    });

    try {
      // RED: failing test commit (must touch a real file for git log --grep -- . to work)
      commitFile(git, tmpDir, 'test-login.js', 'test(01-01): failing test for login');
      // GREEN: implementation commit
      commitFile(git, tmpDir, 'login.js', 'feat(01-01): implement login');

      const result = runTools('check tdd.review-checkpoint 1 --raw', tmpDir);
      assert.ok(result.success, `check should succeed with exit 0. stderr: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.block, false, 'RED+GREEN present: block must be false, not true');
      assert.strictEqual(out.passed, true, 'passed must be true');
      assert.strictEqual(out.tddPlans, 1, 'must find 1 tdd plan');
      assert.strictEqual(out.violations, 0, 'violations must be 0 when both commits present');
      assert.ok(Array.isArray(out.rows), 'rows must be array');
      assert.strictEqual(out.rows.length, 1, 'must have 1 row');
      assert.strictEqual(out.rows[0].planId, '01-01', 'planId must be 01-01');
      assert.strictEqual(out.rows[0].red, true, 'red must be true');
      assert.strictEqual(out.rows[0].green, true, 'green must be true');
      assert.strictEqual(out.rows[0].status, 'Pass', 'status must be Pass');
      assert.strictEqual(out.rows[0].missing.length, 0, 'missing array must be empty');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('[negative] type:tdd plan with no commits: block:true, violations:1, missing includes RED and GREEN', () => {
    const { tmpDir } = createTddGitFixture({
      planFiles: [
        { dir: '01-phase1', filename: '01-01-PLAN.md', content: tddPlan(1, '01-01') },
      ],
    });

    try {
      // No additional commits — only the init commit exists

      const result = runTools('check tdd.review-checkpoint 1 --raw', tmpDir);
      assert.ok(result.success, `check should exit 0 (advisory gate). stderr: ${result.error}`);

      const out = JSON.parse(result.output);
      // SPECIFIC assertion: block must be TRUE (distinguishes from the passing case)
      assert.strictEqual(out.block, true, 'no commits: block must be TRUE, not false');
      assert.strictEqual(out.tddPlans, 1, 'must find 1 tdd plan');
      assert.strictEqual(out.violations, 1, 'violations must be 1');
      assert.strictEqual(out.rows[0].red, false, 'red must be false without test() commit');
      assert.strictEqual(out.rows[0].green, false, 'green must be false without feat() commit');
      assert.strictEqual(out.rows[0].status, 'FAIL', 'status must be FAIL');
      // missing must include both RED and GREEN
      assert.ok(out.rows[0].missing.includes('RED'), 'missing must include RED');
      assert.ok(out.rows[0].missing.includes('GREEN'), 'missing must include GREEN');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('[negative] RED present but GREEN missing: block:true, violations:1, missing deepEqual [GREEN]', () => {
    const { tmpDir, git } = createTddGitFixture({
      planFiles: [
        { dir: '01-phase1', filename: '01-01-PLAN.md', content: tddPlan(1, '01-01') },
      ],
    });

    try {
      // Only RED commit — no feat() commit
      commitFile(git, tmpDir, 'test-auth.js', 'test(01-01): failing auth test');

      const result = runTools('check tdd.review-checkpoint 1 --raw', tmpDir);
      assert.ok(result.success, `check should exit 0. stderr: ${result.error}`);

      const out = JSON.parse(result.output);
      // SPECIFIC assertion: block true, violations 1
      assert.strictEqual(out.block, true, 'RED only: block must be true');
      assert.strictEqual(out.violations, 1, 'violations must be exactly 1');
      assert.strictEqual(out.rows[0].red, true, 'red must be true (commit present)');
      assert.strictEqual(out.rows[0].green, false, 'green must be false (no feat commit)');
      assert.strictEqual(out.rows[0].status, 'FAIL', 'status must be FAIL');
      // missing must be exactly ['GREEN'] — not ['RED', 'GREEN']
      assert.deepStrictEqual(out.rows[0].missing, ['GREEN'], 'missing must deepEqual [GREEN] when RED present');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('[empty-resolution] no type:tdd plans (type:execute only): block:false, tddPlans:0, empty rows', () => {
    const { tmpDir } = createTddGitFixture({
      planFiles: [
        { dir: '01-phase1', filename: '01-01-PLAN.md', content: executePlan(1, '01-01') },
      ],
    });

    try {
      const result = runTools('check tdd.review-checkpoint 1 --raw', tmpDir);
      assert.ok(result.success, `check should succeed with exit 0. stderr: ${result.error}`);

      const out = JSON.parse(result.output);
      // SPECIFIC assertion: block false AND tddPlans 0 (distinguishes from a plan that passes)
      assert.strictEqual(out.block, false, 'no tdd plans: block must be false');
      assert.strictEqual(out.tddPlans, 0, 'tddPlans must be 0 when no type:tdd files');
      assert.strictEqual(out.violations, 0, 'violations must be 0');
      assert.strictEqual(out.rows.length, 0, 'rows must be empty array');
      assert.strictEqual(out.table, '', 'table must be empty string when no tdd plans');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('[crlf] type:tdd plan with CRLF endings is still detected (#2449)', () => {
    // src/check-command-router.cts:751 used /^---\n...\n---/ which can't match
    // CRLF frontmatter delimiters, so a CRLF PLAN.md was silently classified
    // as "no type:tdd plans" — output indistinguishable from a phase that
    // genuinely contains no TDD plans. The advisory gate then short-circuited
    // to a confident pass with no violations table.
    const { tmpDir } = createTddGitFixture({
      planFiles: [
        { dir: '01-phase1', filename: '01-01-PLAN.md', content: tddPlanCrlf(1, '01-01') },
      ],
    });

    try {
      const result = runTools('check tdd.review-checkpoint 1 --raw', tmpDir);
      assert.ok(result.success, `check should succeed. stderr: ${result.error}`);

      const out = JSON.parse(result.output);
      // SPECIFIC assertion: tddPlans must be 1, not 0 — this is the bug.
      // Before the fix, the CRLF frontmatter regex returned null, the plan was
      // never classified type:tdd, and tddPlanFiles stayed empty.
      assert.strictEqual(out.tddPlans, 1, 'CRLF type:tdd plan must be detected (was silently 0 before #2449 fix)');
      // No RED/GREEN commits in the fixture → block:true, violations:1.
      assert.strictEqual(out.block, true, 'no commits on the detected plan: block must be TRUE');
      assert.strictEqual(out.violations, 1, 'one violation expected for the detected plan');
      assert.strictEqual(out.rows.length, 1, 'the detected plan must produce a row');
      assert.strictEqual(out.rows[0].planId, '01-01', 'planId must be 01-01');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('[crlf-mixed] type:tdd plan with CRLF frontmatter + LF body is still detected (#2449)', () => {
    // Mixed-endings variant of the [crlf] test: frontmatter delimiters are CRLF
    // (the bug class) but the body is LF (e.g. an editor that normalizes body
    // text but preserves frontmatter bytes, or a toolchain that concatenates
    // CRLF + LF fragments). The classifier only reads frontmatter, so the LF
    // body must not change detection — but verify, since the original bug was
    // a parser differential and mixed endings are the most adversarial case.
    const { tmpDir } = createTddGitFixture({
      planFiles: [
        { dir: '01-phase1', filename: '01-01-PLAN.md', content: tddPlanMixedCrlfLf(1, '01-01') },
      ],
    });

    try {
      const result = runTools('check tdd.review-checkpoint 1 --raw', tmpDir);
      assert.ok(result.success, `check should succeed. stderr: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.strictEqual(out.tddPlans, 1, 'CRLF-frontmatter + LF-body type:tdd plan must be detected');
      assert.strictEqual(out.rows[0].planId, '01-01', 'planId must be 01-01');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('[bva] violations=1 boundary: exactly 1 violation sets block:true and advisory message present', () => {
    // Two tdd plans: 01-01 passes (both commits), 01-02 fails (no commits)
    // violations = 1 exactly — boundary test (violations > 0 → block:true)
    const { tmpDir, git } = createTddGitFixture({
      planFiles: [
        { dir: '01-phase1', filename: '01-01-PLAN.md', content: tddPlan(1, '01-01') },
        { dir: '01-phase1', filename: '01-02-PLAN.md', content: tddPlan(1, '01-02') },
      ],
    });

    try {
      // 01-01: both RED and GREEN commits (passes)
      commitFile(git, tmpDir, 'test1.js', 'test(01-01): failing test');
      commitFile(git, tmpDir, 'impl1.js', 'feat(01-01): implementation');
      // 01-02: no commits (fails)

      const result = runTools('check tdd.review-checkpoint 1 --raw', tmpDir);
      assert.ok(result.success, `check should exit 0. stderr: ${result.error}`);

      const out = JSON.parse(result.output);
      // SPECIFIC: block must be TRUE for violations=1 (not false as it would be for violations=0)
      assert.strictEqual(out.block, true, 'violations=1 boundary: block must be true');
      assert.strictEqual(out.violations, 1, 'violations must be exactly 1 (not 0, not 2)');
      assert.strictEqual(out.tddPlans, 2, 'tddPlans must be 2');
      assert.strictEqual(out.passed, true, 'advisory gate: passed stays true');

      // Check both rows
      const passRow = out.rows.find((r) => r.planId === '01-01');
      const failRow = out.rows.find((r) => r.planId === '01-02');
      assert.ok(passRow, '01-01 row must exist');
      assert.ok(failRow, '01-02 row must exist');
      assert.strictEqual(passRow.status, 'Pass', '01-01 must Pass');
      assert.strictEqual(failRow.status, 'FAIL', '01-02 must FAIL');

      // Advisory table must mention the warning text
      assert.ok(
        out.table.includes('⚠ Gate violations are advisory'),
        'table must include advisory warning when violations > 0'
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('[negative] missing phase argument: exitCode 1 and error contains required message', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tdd-noarg-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });

    try {
      const result = runTools('check tdd.review-checkpoint --raw', tmpDir);
      // SPECIFIC: exitCode must be 1 (non-zero), not 0
      assert.strictEqual(result.success, false, 'missing phase arg must cause failure (success=false)');
      assert.strictEqual(result.exitCode, 1, 'exitCode must be 1, not 0');
      // Error message must identify the command and what's missing
      const errText = result.error + result.output;
      assert.ok(
        errText.includes('tdd.review-checkpoint') || errText.includes('phase argument'),
        `error must reference tdd.review-checkpoint or phase argument. got: ${errText}`
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});
