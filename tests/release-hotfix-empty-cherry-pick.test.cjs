// allow-test-rule: source-text-is-the-product (see #2913)
// .github/workflows/release.yml is the deployed CI contract; the cherry-pick
// error handler is bash inside the YAML. This test has two layers:
//   1. Real-git: proves the DISCRIMINATION LOGIC (check for unmerged paths →
//      skip if empty, abort if conflict) is correct by exercising it against
//      a real git repo with both scenarios.
//   2. Source-text: asserts the discrimination logic AND the separate summary
//      heading actually made it into release.yml — so a regression that
//      removes the check from the workflow is caught even if the logic test
//      still passes.

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runGit } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { cleanup } = require('./helpers.cjs');

const RELEASE_WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// ─── git helpers ────────────────────────────────────────────────────────────

// Migrated from a hand-rolled throw-on-non-zero over spawnSync's `-C cwd`
// argv form to gitOrThrow's `{ cwd }` option — same external behavior (throws
// on non-zero exit, returns trimmed stdout on success), no caller reads the
// old custom error message so the throw-shape swap is safe.
function git(cwd, ...args) {
  return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS }).trim();
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  gitOrThrow(['init', dir], { timeoutMs: GIT_TIMEOUT_MS });
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Ensure the default branch is 'main' regardless of the system's
  // init.defaultBranch setting (older Git defaults to 'master').
  gitOrThrow(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  return dir;
}

function commitFile(dir, file, content, message) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * The discrimination logic extracted from release.yml's cherry-pick error
 * handler. This mirrors what the bash does after `git cherry-pick -x "$SHA"`
 * exits non-zero:
 *   - Check for unmerged paths (`git diff --name-only --diff-filter=U`).
 *   - Empty → skip (already applied by content), record, continue.
 *   - Non-empty → genuine conflict, abort, return conflict info.
 *
 * @returns {{ status: 'empty' | 'conflict', unmerged: string[] }}
 */
function discriminateCherryPick(dir) {
  const unmerged = git(dir, 'diff', '--name-only', '--diff-filter=U');
  const unmergedFiles = unmerged.split('\n').filter(Boolean);
  if (unmergedFiles.length === 0) {
    git(dir, 'cherry-pick', '--skip');
    return { status: 'empty', unmerged: [] };
  }
  git(dir, 'cherry-pick', '--abort');
  return { status: 'conflict', unmerged: unmergedFiles };
}

// ─── real-git tests: prove the discrimination logic ─────────────────────────

describe('#2913 — cherry-pick empty-vs-conflict discrimination (real git)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2913-'));
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('an already-applied-by-content commit is detected as empty and skipped', () => {
    const repo = makeRepo(path.join(tmpDir, 'empty-pick'));
    // Seed: create file.txt with "v1"
    commitFile(repo, 'file.txt', 'v1\n', 'init');
    const baseSha = git(repo, 'rev-parse', 'HEAD');

    // On "next": bump file.txt to v2, then create a chore commit that sets it back to v1 then to v2
    git(repo, 'checkout', '-b', 'next');
    commitFile(repo, 'file.txt', 'v2\n', 'feat: bump to v2');
    // Now create a commit that is a no-op against base by content: set file.txt to "v1\n"
    // then immediately set it back — but that creates a non-empty diff. Instead,
    // simulate the exact scenario: a commit whose PATCH applies empty because
    // the content is already present.
    //
    // Create the "chore" commit on a throwaway branch from base, then cherry-pick
    // it onto next where the change is already present.
    git(repo, 'checkout', baseSha);
    git(repo, 'checkout', '-b', 'throwaway');
    // Apply a change that sets file.txt to v2 (same content as next already has)
    const choreSha = commitFile(repo, 'file.txt', 'v2\n', 'chore: sync version to v2');

    // Go back to next and try to cherry-pick the chore commit.
    // file.txt is already v2 on next → the patch applies empty.
    git(repo, 'checkout', 'next');

    // Attempt the cherry-pick — it exits non-zero (empty).
    const r = runGit(['cherry-pick', '-x', choreSha], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    assert.notStrictEqual(r.exitCode, 0, 'cherry-pick of an already-applied commit must exit non-zero');

    // Apply the discrimination logic.
    const result = discriminateCherryPick(repo);
    assert.strictEqual(result.status, 'empty', 'an empty pick must be classified as "empty", not "conflict"');
    assert.deepStrictEqual(result.unmerged, []);

    // After skip, HEAD should be back on next (no cherry-pick state).
    const headAfter = git(repo, 'rev-parse', 'next');
    const currentHead = git(repo, 'rev-parse', 'HEAD');
    assert.strictEqual(currentHead, headAfter, 'after skip, HEAD should be unchanged (no new commit applied)');

    // #2913 MINOR 1: after --skip, the sequencer must be clean so the next
    // iteration's cherry-pick succeeds. A regression that switched --skip to
    // --quit (which leaves sequencer state) would fail here.
    git(repo, 'checkout', baseSha);
    git(repo, 'checkout', '-b', 'throwaway2');
    const realSha = commitFile(repo, 'other.txt', 'real change\n', 'fix: a real fix');
    git(repo, 'checkout', 'next');
    const realPick = runGit(['cherry-pick', '-x', realSha], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    assert.strictEqual(realPick.exitCode, 0,
      `after --skip, the sequencer must be clean so the next cherry-pick succeeds; got status ${realPick.exitCode}:\n${realPick.stderr || realPick.stdout}`);
  });

  test('a genuine cherry-pick conflict is detected as conflict and aborted', () => {
    const repo = makeRepo(path.join(tmpDir, 'conflict-pick'));
    // Seed: file.txt with "base line"
    commitFile(repo, 'file.txt', 'base line\n', 'init');

    // On "next": change line 1 to "next version"
    git(repo, 'checkout', '-b', 'next');
    const conflictingSha = commitFile(repo, 'file.txt', 'next version\n', 'fix: change to next version');

    // Go back to main and make a DIFFERENT change to the same line.
    git(repo, 'checkout', 'main');
    commitFile(repo, 'file.txt', 'main version\n', 'fix: change to main version');

    // Attempt to cherry-pick the next commit — it conflicts (same line, different content).
    const r = runGit(['cherry-pick', '-x', conflictingSha], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    assert.notStrictEqual(r.exitCode, 0, 'cherry-pick of a conflicting commit must exit non-zero');

    // Apply the discrimination logic.
    const result = discriminateCherryPick(repo);
    assert.strictEqual(result.status, 'conflict', 'a genuine conflict must be classified as "conflict"');
    assert.ok(result.unmerged.length > 0, 'a genuine conflict must have unmerged files');
    assert.ok(result.unmerged.includes('file.txt'), 'file.txt must be in the unmerged list');
  });
});

// ─── source-text assertions: prove the logic is in release.yml ──────────────

describe('#2913 — release.yml cherry-pick error handler discriminates empty from conflict', () => {
  const text = fs.existsSync(RELEASE_WORKFLOW)
    ? fs.readFileSync(RELEASE_WORKFLOW, 'utf8')
    : '';

  test('the cherry-pick error handler checks for unmerged paths before aborting', () => {
    // The fix adds a `git diff --name-only --diff-filter=U` check inside the
    // `if ! git cherry-pick` block. Without it, every empty pick aborts the run.
    assert.ok(text.length > 0, 'release.yml must exist');
    assert.ok(
      text.includes('--diff-filter=U'),
      'release.yml cherry-pick error handler must check for unmerged paths (git diff --diff-filter=U) before aborting — without this, an already-applied commit aborts the entire hotfix create (#2913)',
    );
  });

  test('empty picks are skipped (git cherry-pick --skip), not aborted', () => {
    assert.ok(text.length > 0, 'release.yml must exist');
    assert.ok(
      text.includes('cherry-pick --skip'),
      'release.yml must skip (not abort) already-applied cherry-picks — git cherry-pick --skip continues the loop (#2913)',
    );
  });

  test('the job summary distinguishes already-applied from not-fix-chore skips', () => {
    assert.ok(text.length > 0, 'release.yml must exist');
    // The fix introduces a separate variable/heading for already-applied commits
    // so they are not silently dropped or confused with not-fix/chore skips.
    assert.ok(
      /already applied|applied by content|SKIPPED_EMPTY|empty pick/i.test(text),
      'release.yml job summary must distinguish "skipped (already applied)" from "skipped (not fix/chore)" — a separate heading or variable for empty picks (#2913)',
    );
  });
});
