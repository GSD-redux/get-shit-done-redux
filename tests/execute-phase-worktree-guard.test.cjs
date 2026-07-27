// allow-test-rule: runtime-contract-is-the-product see #1856
// The orchestrator cwd-drift guard (#48) is shell EMBEDDED in execute-phase.md.
// The shipped text IS the runtime contract, so these tests extract the block and
// EXECUTE it against real git fixtures rather than asserting on its characters —
// the readFileSync here is extraction for execution, not a source-grep assertion.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const GUARD_MARKER = 'gsd:guard=orchestrator-cwd-drift';

/**
 * Pull the guard's bash block out of the workflow. Anchored on a stable marker
 * comment rather than a line range so the test does not rot when the file moves.
 */
function guardScript() {
  const md = fs.readFileSync(WORKFLOW, 'utf8');
  const fences = md.split('```');
  for (let i = 1; i < fences.length; i += 2) {
    const body = fences[i].replace(/^bash\r?\n/, '');
    if (body.includes(GUARD_MARKER)) return body;
  }
  throw new Error(
    `no fenced block carrying "${GUARD_MARKER}" in ${WORKFLOW} — the guard must be ` +
      'marked so this contract test can execute the shipped text.',
  );
}

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A real repo with a base branch and one commit. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1856-'));
  git(dir, 'init', '--quiet', '--initial-branch', 'next');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'base');
  return dir;
}

function commitFile(dir, name, msg) {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', msg);
}

/** Run the extracted guard in `dir`. Never throws — returns the observed result. */
function runGuard(dir) {
  const res = spawnSync('bash', ['-c', guardScript()], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('#1856: refusal names the stranded commits and the dirty tree', () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '--quiet', '-b', 'worktree-agent-36.12-05-090827');
    for (const m of ['wire roto toggle', 'preserve roto keys', 'simplify controls',
      'count semantics', 'bound regeneration']) {
      commitFile(dir, m.replace(/\s/g, '-') + '.txt', `fix(36.12-05): ${m}`);
    }
    fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'work in progress\n');

    const r = runGuard(dir);
    assert.equal(r.status, 1, 'the guard must still REFUSE — #48 is load-bearing');
    assert.match(r.stderr, /worktree-agent-36\.12-05-090827/, 'names the branch');

    // The whole point of #1856: the refusal must not be a dead end.
    assert.match(
      r.stderr,
      /5\s+commit/i,
      'must report how many commits are stranded on the agent branch — without this the ' +
        'user cannot tell that switching away loses work (#1856)',
    );
    assert.match(
      r.stderr,
      /uncommitted|dirty|unstaged/i,
      'must report that the worktree still has uncommitted changes (#1856)',
    );
    assert.match(
      r.stderr,
      /cherry-pick|merge/i,
      'must give an integration command, not just "re-run from the orchestrator worktree"',
    );
  } finally {
    cleanup(dir);
  }
});

test('#1856: the bare agent- namespace is handled identically', () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '--quiet', '-b', 'agent-a1b2c3');
    commitFile(dir, 'one.txt', 'feat: one');
    const r = runGuard(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /agent-a1b2c3/);
    assert.match(r.stderr, /1\s+commit/i);
  } finally {
    cleanup(dir);
  }
});

test('#1856: a clean agent worktree still refuses, without a wall of empty sections', () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '--quiet', '-b', 'agent-clean');
    const r = runGuard(dir);
    assert.equal(r.status, 1, 'still refuses');
    // Nothing is stranded, so nothing must be claimed to be.
    assert.doesNotMatch(
      r.stderr,
      /\b[1-9]\d*\s+commit/i,
      'a branch with no commits ahead must not report stranded commits',
    );
    assert.doesNotMatch(
      r.stderr,
      /uncommitted changes/i,
      'a clean tree must not be reported as dirty',
    );
  } finally {
    cleanup(dir);
  }
});

test('#1856: boundary — 1 and 2 commits ahead are both reported accurately', () => {
  for (const n of [1, 2]) {
    const dir = makeRepo();
    try {
      git(dir, 'checkout', '--quiet', '-b', 'agent-count');
      for (let i = 0; i < n; i += 1) commitFile(dir, `c${i}.txt`, `feat: c${i}`);
      const r = runGuard(dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`\\b${n}\\s+commit`, 'i'), `${n} ahead reported`);
    } finally {
      cleanup(dir);
    }
  }
});

test('#1856: does not fire on an ordinary orchestrator branch', () => {
  const dir = makeRepo();
  try {
    const r = runGuard(dir); // still on `next`
    assert.equal(r.status, 0, `guard must not fire on a normal branch: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /refusing to execute waves/);
  } finally {
    cleanup(dir);
  }
});

test('#1856: does not fire on a branch that merely starts with "agent"', () => {
  const dir = makeRepo();
  try {
    // The discriminator is the `agent-` NAMESPACE. `agentic-refactor` is an
    // ordinary feature branch and must run.
    git(dir, 'checkout', '--quiet', '-b', 'agentic-refactor');
    const r = runGuard(dir);
    assert.equal(r.status, 0, `guard must not fire on agentic-refactor: ${r.stderr}`);
  } finally {
    cleanup(dir);
  }
});

test('#1856: does not fire on a legitimate feature worktree', () => {
  // Recorded constraint in the guard's own comment: the discriminator is the branch
  // namespace, NOT the .claude/worktrees/ path — the orchestrator may legitimately
  // run from a feature worktree there, and a path check would break that.
  const dir = makeRepo();
  try {
    const wt = path.join(dir, '.claude', 'worktrees', 'feature');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(dir, 'worktree', 'add', '--quiet', '-b', 'feat/legit', wt);
    const r = runGuard(wt);
    assert.equal(r.status, 0, `a feature worktree must run: ${r.stderr}`);
  } finally {
    cleanup(dir);
  }
});

test('#1856: reporting degrades to the plain refusal when no base ref resolves', () => {
  // No origin, no main/next to compare against — the guard must still refuse
  // cleanly rather than crash or hang before printing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1856-nobase-'));
  try {
    git(dir, 'init', '--quiet', '--initial-branch', 'agent-orphan');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', 'only');
    const r = runGuard(dir);
    assert.equal(r.status, 1, 'still refuses with no resolvable base');
    assert.match(r.stderr, /refusing to execute waves/);
  } finally {
    cleanup(dir);
  }
});

test('#1856: detached HEAD does not crash the guard', () => {
  const dir = makeRepo();
  try {
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '--quiet', '--detach', sha);
    const r = runGuard(dir);
    // `rev-parse --abbrev-ref HEAD` yields "HEAD" when detached — not an agent
    // branch, so the guard must pass through without erroring.
    assert.equal(r.status, 0, `detached HEAD must not crash the guard: ${r.stderr}`);
  } finally {
    cleanup(dir);
  }
});
