/**
 * Quick task branching tests
 *
 * Validates that /gsd-quick exposes branch_name from init and that the Step 2.5
 * "Handle quick-task branching" block:
 *   1. Reuses an existing branch as-is (no rebase / no reset).
 *   2. When the branch does not exist, creates it from origin/HEAD's default
 *      branch — never off the previous task's HEAD (#2916).
 *
 * Assertions are behavioral (run the bash block in a fixture git repo and
 * inspect git state) and structural (parse the markdown for the step's bash
 * block). No `.includes()` / regex grepping of raw markdown content — see
 * CONTRIBUTING.md "no-source-grep" testing standard.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup, readFileNormalized } = require('./helpers.cjs');

const QUICK_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

const GIT_ENV = Object.freeze({
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

/**
 * Structurally extract the bash code under the "Step 2.5: Handle quick-task
 * branching" heading. We:
 *   1. Locate the Step 2.5 heading.
 *   2. Find the next horizontal rule (`---`) that ends the section.
 *   3. Concatenate every fenced ```bash block in between.
 *
 * No `.includes()` content checks — fenced code blocks are parsed the same way
 * a markdown parser would.
 */
function extractStep25Bash() {
  const content = readFileNormalized(QUICK_PATH);
  const lines = content.split('\n');

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (start === -1 && /^\*\*Step 2\.5:\s*Handle quick-task branching\*\*\s*$/.test(lines[i])) {
      start = i + 1;
    } else if (start !== -1 && /^---\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error('quick.md does not contain a "Step 2.5: Handle quick-task branching" section');
  }
  if (end === -1) end = lines.length;

  const bashBlocks = [];
  let inBash = false;
  let buffer = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (!inBash && /^```bash\s*$/.test(line)) {
      inBash = true;
      buffer = [];
      continue;
    }
    if (inBash && /^```\s*$/.test(line)) {
      bashBlocks.push(buffer.join('\n'));
      inBash = false;
      continue;
    }
    if (inBash) buffer.push(line);
  }
  if (bashBlocks.length === 0) {
    throw new Error('Step 2.5 contains no ```bash code blocks to execute');
  }
  return bashBlocks.join('\n');
}

/**
 * Build a fixture: a bare "origin" repo with a non-`main` default branch
 * (`trunk`) so the test fails if the workflow silently falls back to "main"
 * instead of consulting `origin/HEAD`. The clone has `origin/HEAD` pointed at
 * `trunk` and a checked-out previous-task branch carrying its own unmerged
 * commit.
 *
 * Using `trunk` here locks in the symbolic-ref code path: if the
 * implementation skips `git symbolic-ref refs/remotes/origin/HEAD` and just
 * defaults to `main`, every assertion below collapses (#2921 CR nitpick).
 */
function setupFixture(defaultBranch = 'trunk') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-quick-branching-'));
  const seedPath = path.join(root, 'seed');
  const originPath = path.join(root, 'origin.git');
  const clonePath = path.join(root, 'clone');

  fs.mkdirSync(seedPath);
  git(seedPath, 'init', '-b', defaultBranch);
  git(seedPath, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(seedPath, 'README.md'), '# seed\n');
  git(seedPath, 'add', 'README.md');
  git(seedPath, 'commit', '-m', 'initial');

  git(root, 'clone', '--bare', seedPath, originPath);
  git(originPath, 'symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`);

  git(root, 'clone', originPath, clonePath);
  git(clonePath, 'config', 'commit.gpgsign', 'false');
  git(clonePath, 'config', 'user.email', 'test@test.com');
  git(clonePath, 'config', 'user.name', 'Test');

  // Simulate finishing a previous quick task: branch off the default branch,
  // add a commit, and stay on it (this is the failure scenario from #2916).
  git(clonePath, 'checkout', '-b', 'quick/01-prev-task');
  fs.writeFileSync(path.join(clonePath, 'prev.txt'), 'prev work\n');
  git(clonePath, 'add', 'prev.txt');
  git(clonePath, 'commit', '-m', 'prev quick task work');

  return { root, clonePath, defaultBranch };
}

function runStep(bash, cwd, branchName) {
  // Write the script to a sibling tempdir, not inside the repo — putting it in
  // `cwd` would create an untracked file that trips `git status --porcelain`
  // and steers the step into the dirty-tree path.
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-quick-step-'));
  const scriptPath = path.join(scriptDir, 'step25.sh');
  const script = `#!/usr/bin/env bash\nset -uo pipefail\nbranch_name="${branchName}"\n${bash}\n`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  try {
    return execFileSync('bash', [scriptPath], {
      cwd,
      env: GIT_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } finally {
    cleanup(scriptDir);
  }
}

describe('quick workflow: branching support', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(QUICK_PATH), 'workflows/quick.md should exist');
  });

  test('init parse list includes branch_name', () => {
    // Structural: the workflow's init step (Step 2) must declare branch_name as
    // a parseable field of the init JSON. Restrict the scan to the init step's
    // section only — a global walk over every bash fence could be fooled by an
    // unrelated step that happens to mention branch_name (#2921 CR).
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);

    // Locate the "Step 2: Initialize" heading and the next "Step N" heading
    // that ends the section. We match the markdown bold-step convention used
    // throughout quick.md: `**Step N[.M]: Title**`.
    let start = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (start === -1 && /^\*\*Step 2:\s*Initialize\*\*\s*$/.test(lines[i])) {
        start = i + 1;
      } else if (start !== -1 && /^\*\*Step \d+(?:\.\d+)?:\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    assert.notEqual(start, -1, 'quick.md should contain a "Step 2: Initialize" section');
    if (end === -1) end = lines.length;

    // Within that section, look for the branch_name token inside fenced bash
    // blocks AND in the surrounding markdown prose that documents the JSON
    // fields. Both are part of the init contract.
    let found = false;
    for (let i = start; i < end; i += 1) {
      if (/\bbranch_name\b/.test(lines[i])) { found = true; break; }
    }
    assert.ok(
      found,
      'Step 2 (Initialize) of quick workflow should expose branch_name as part of the init contract'
    );
  });

  test('Step 2.5 section is present and contains executable bash', () => {
    const bash = extractStep25Bash();
    assert.ok(bash.length > 0, 'Step 2.5 should contain at least one bash block');
  });

  test('Step 2.5 runs before Step 3 (task directory creation)', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    const branchingIndex = content.indexOf('Step 2.5: Handle quick-task branching');
    const createDirIndex = content.indexOf('Step 3: Create task directory');
    assert.ok(
      branchingIndex !== -1 && createDirIndex !== -1,
      'workflow should contain both branching and directory steps'
    );
    assert.ok(
      branchingIndex < createDirIndex,
      'branching should happen before quick task directories and commits'
    );
  });

  // Run against both `main` (the conventional default) and `trunk` (a non-
  // main default that exercises the symbolic-ref code path). Keeping both
  // restores main coverage that was removed when the fixture switched
  // wholesale to trunk in 80f14cac.
  for (const defaultBranch of ['main', 'trunk']) {
    test(`new quick-task branch branches off origin/${defaultBranch} (#2916)`, () => {
      const bash = extractStep25Bash();
      const { root, clonePath } = setupFixture(defaultBranch);

      try {
        const upstream = `origin/${defaultBranch}`;

        assert.equal(
          git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
          'quick/01-prev-task'
        );
        assert.equal(
          git(clonePath, 'rev-list', '--count', `${upstream}..HEAD`),
          '1',
          `fixture should be 1 commit ahead of ${upstream}`
        );

        runStep(bash, clonePath, 'quick/02-new-task');

        assert.equal(
          git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
          'quick/02-new-task',
          'Step 2.5 should switch to the new quick-task branch'
        );

        const inherited = git(clonePath, 'rev-list', '--count', `${upstream}..HEAD`);
        assert.equal(
          inherited,
          '0',
          `new quick-task branch must branch off ${upstream}, but inherited ${inherited} commit(s) from previous-task HEAD`
        );
        assert.equal(
          git(clonePath, 'rev-parse', 'HEAD'),
          git(clonePath, 'rev-parse', upstream),
          `new quick-task branch tip must equal ${upstream} tip`
        );
      } finally {
        cleanup(root);
      }
    });
  }

  test('Step 2.5 reuses an existing quick-task branch instead of forking again', () => {
    const bash = extractStep25Bash();
    const { root, clonePath } = setupFixture();

    try {
      // Pre-create the target branch off origin/trunk with its own commit, then
      // walk away to a different branch — the step must switch back to it.
      git(clonePath, 'checkout', '-B', 'quick/02-new-task', 'origin/trunk');
      fs.writeFileSync(path.join(clonePath, 'task02.txt'), 'task 2 work\n');
      git(clonePath, 'add', 'task02.txt');
      git(clonePath, 'commit', '-m', 'task 02 wip');
      const task02Sha = git(clonePath, 'rev-parse', 'HEAD');
      git(clonePath, 'checkout', 'quick/01-prev-task');

      runStep(bash, clonePath, 'quick/02-new-task');

      assert.equal(
        git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
        'quick/02-new-task'
      );
      assert.equal(
        git(clonePath, 'rev-parse', 'HEAD'),
        task02Sha,
        'existing-branch tip must be preserved (no rebase/reset)'
      );
    } finally {
      cleanup(root);
    }
  });
});
