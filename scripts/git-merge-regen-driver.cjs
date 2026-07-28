#!/usr/bin/env node
'use strict';

/**
 * git-merge-regen-driver.cjs — the `gsd-regen` git merge driver (#2721, ADR-2719 Phase 1).
 *
 * ## Why
 *
 * `tests/fixtures/golden-install-parity/*.json` and the two size baselines are pure
 * functions of the source tree. Git offers ours or theirs; both are wrong, because the
 * only correct value is recomputed from the merged tree. 140 of 143 conflicted-file
 * instances across the open PR queue are these artifacts (ADR-2719).
 *
 * ## What this driver does — and deliberately does NOT do
 *
 * It does **not** regenerate. That is not implementable, and the constraint is git's, not
 * a design preference: at the moment git invokes a merge driver, **neither the working
 * tree nor the index reflects the merge**. Both hold the ours side; a file added by
 * theirs does not exist yet; `.git/MERGE_HEAD` has not been written. A driver that shelled
 * out to the generators there would read the ours-side tree and write a
 * plausible-but-wrong hash manifest — strictly worse than a conflict, because a conflict
 * is visible and a wrong manifest is not. Git also invokes the driver once **per
 * conflicted path** (20 in this repo), so a regenerating driver would run the full build
 * plus 19 installer spawns up to twenty times per merge.
 *
 * So it resolves deterministically and without content knowledge: it accepts `%A` (which
 * already holds ours verbatim), runs **zero subprocesses**, records the resolved paths
 * under the git dir, and prints **one** notice per operation pointing at
 * `npm run regen:derived`. Staleness is caught where it already was — by
 * `tests/golden-install-parity.test.cjs` in CI.
 *
 * Every failure path degrades toward *today's* behavior (a normal conflict), never toward
 * a silent wrong resolution.
 *
 * ## Bridge, not a destination
 *
 * This driver is explicitly temporary. #2724 deletes the artifacts it guards and retires
 * it. Keeping it past that point would preserve the problem it exists to relieve.
 *
 *   node scripts/git-merge-regen-driver.cjs --install     # register in .git/config
 *   node scripts/git-merge-regen-driver.cjs --uninstall
 *   node scripts/git-merge-regen-driver.cjs --status
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const { runMain, ExitError } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const MARKER_NAME = 'gsd-regen-pending.json';

/** Bounded per the repo's unbounded-subprocess rule (5-30s for git). */
const GIT_TIMEOUT_MS = 15_000;

/**
 * A single git operation's driver invocations land milliseconds apart, so this window is
 * ~4 orders of magnitude wider than it needs to be. It exists only so a *later* operation
 * does not inherit the previous one's silence.
 */
const NOTICE_WINDOW_MS = 60_000;

const ACTION = Object.freeze({
  ACCEPT_OURS: 'accept_ours',
  DECLINE: 'decline',
});

const REASON = Object.freeze({
  OK_RESOLVED: 'ok_resolved',
  FAIL_BAD_ARGV: 'fail_bad_argv',
  FAIL_OURS_UNREADABLE: 'fail_ours_unreadable',
});

const GITDIR_SOURCE = Object.freeze({
  DIRECTORY: 'directory',
  GITFILE: 'gitfile',
  UNRESOLVED: 'unresolved',
});

/**
 * Locate the git dir from `cwd` without spawning git — the driver runs up to twenty times
 * per merge, so a subprocess per invocation is not affordable.
 *
 * Handles both shapes: `.git` as a directory, and `.git` as a pointer file
 * (`gitdir: <path>`) in a linked worktree or submodule. Never throws; an unresolvable git
 * dir is a degraded-but-correct state, not an error.
 *
 * @param {string} cwd
 * @returns {{gitDir: string|null, source: string}}
 */
function resolveGitDir(cwd) {
  const unresolved = { gitDir: null, source: GITDIR_SOURCE.UNRESOLVED };
  const dotGit = path.join(cwd, '.git');

  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return unresolved;
  }
  if (stat.isDirectory()) return { gitDir: dotGit, source: GITDIR_SOURCE.DIRECTORY };

  let raw;
  try {
    raw = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return unresolved;
  }

  // Anchored /m with an explicit trailing-whitespace eat: `$` under /m sits before the
  // \n, so a CRLF checkout would otherwise carry the \r into the path.
  const match = /^gitdir:\s*(.*?)\s*$/m.exec(raw);
  if (!match || match[1] === '') return unresolved;
  return { gitDir: path.resolve(cwd, match[1]), source: GITDIR_SOURCE.GITFILE };
}

/**
 * Read the pending-resolution marker, treating anything unusable as absent.
 *
 * Valid JSON is not the same as a usable marker: `0`, `"str"`, `[]`, `null` and `true` all
 * parse. So does an object whose `startedAt` or `count` is a string. Every one of those
 * means "no previous invocation I can trust" — reset, do not throw.
 *
 * @returns {{startedAt: number, count: number}|null}
 */
function readMarker(markerPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (!Number.isFinite(parsed.startedAt)) return null;
  if (!Number.isFinite(parsed.count) || parsed.count < 0) return null;
  return { startedAt: parsed.startedAt, count: parsed.count };
}

function decline(reason) {
  return {
    action: ACTION.DECLINE,
    reason,
    exitCode: 1,
    notice: false,
    pendingCount: 0,
  };
}

/**
 * Decide how to resolve one conflicted path, and record it.
 *
 * Deliberately NOT named `plan*` like `planInstall`: that prefix promises purity, and this
 * function reads and writes the marker file. The name says both halves out loud.
 *
 * @param {object} opts
 * @param {string[]} opts.argv  exactly what git supplies: [%O, %A, %B, %L]. Any further
 *   entry is ignored — see planInstall on why `%P` is deliberately not registered.
 * @param {string|null} opts.gitDir  from resolveGitDir; null means marker-less (degraded)
 * @param {number} opts.now  injected clock — never Date.now() inline, so tests are
 *   deterministic and never assert on elapsed wall-clock
 * @returns {{action: string, reason: string, exitCode: number, notice: boolean,
 *            pendingCount: number}}
 */
function resolveAndRecord({ argv, gitDir, now }) {
  if (!Array.isArray(argv) || argv.length < 3) return decline(REASON.FAIL_BAD_ARGV);

  const oursPath = argv[1];
  if (typeof oursPath !== 'string' || oursPath.trim() === '') {
    return decline(REASON.FAIL_BAD_ARGV);
  }
  // %A is the one input the driver's contract depends on. If it is not there, we do not
  // know what "ours" is, so we hand the conflict back to git rather than inventing one.
  try {
    fs.statSync(oursPath);
  } catch {
    return decline(REASON.FAIL_OURS_UNREADABLE);
  }

  const markerPath = gitDir ? path.join(gitDir, MARKER_NAME) : null;
  const previous = markerPath ? readMarker(markerPath) : null;
  const sameOperation = previous !== null && now - previous.startedAt <= NOTICE_WINDOW_MS;

  const startedAt = sameOperation ? previous.startedAt : now;
  const pendingCount = sameOperation ? previous.count + 1 : 1;

  if (markerPath) {
    // A diagnostic must never fail a merge: a read-only .git degrades to a repeated
    // notice, which is noisy but correct.
    try {
      fs.writeFileSync(markerPath, `${JSON.stringify({ startedAt, count: pendingCount })}\n`);
    } catch {
      /* degraded, not failed */
    }
  }

  return {
    action: ACTION.ACCEPT_OURS,
    reason: REASON.OK_RESOLVED,
    exitCode: 0,
    notice: !sameOperation,
    pendingCount,
  };
}

/**
 * The `.git/config` entries that register this driver.
 *
 * ## Why `%P` is NOT passed — do not "helpfully" add it back
 *
 * Git does **not** invoke a merge driver with an argv array. It substitutes `%O %A %B %L
 * %P` textually into this string and runs the whole thing through a shell. Quoting a
 * placeholder does not make it safe: inside POSIX double quotes `$(…)` and backticks still
 * execute, and a `"` in the value ends the quoting outright.
 *
 * `%O`, `%A` and `%B` are git-generated temp names (`.merge_file_XXXXXX`) and `%L` is an
 * integer, so none of them are attacker-controlled. **`%P` is the file's own path**, which
 * any contributor chooses freely. A branch that renames a covered fixture to
 * `evil$(touch PWNED).json` would execute that command on the machine of every maintainer
 * who merges it — silently, since the merge still reports success. Verified by reproduction
 * against a real `git merge`, not by inspection.
 *
 * So the driver takes no attacker-controlled argument at all, and records a count rather
 * than path names. A filter would have been a guess about shell grammar; passing nothing is
 * a property.
 *
 * Paths are normalized to forward slashes **unconditionally** — a backslash path can reach a
 * config value on any platform, and git shells this command everywhere including Windows.
 *
 * @param {{repoRoot: string}} opts
 * @returns {{entries: Array<{key: string, value: string}>}}
 */
function planInstall({ repoRoot }) {
  const script = path
    .join(repoRoot, 'scripts', 'git-merge-regen-driver.cjs')
    .replace(/\\/g, '/');
  return {
    entries: [
      {
        key: 'merge.gsd-regen.name',
        value: 'gsd-regen — keep ours for generated artifacts; regenerate with npm run regen:derived',
      },
      {
        key: 'merge.gsd-regen.driver',
        value: `node "${script}" "%O" "%A" "%B" "%L"`,
      },
    ],
  };
}

function gitConfig(args, cwd = REPO_ROOT) {
  const r = cp.spawnSync('git', ['config', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    throw new ExitError(1, `git config timed out after ${GIT_TIMEOUT_MS}ms`);
  }
  return r;
}

function runInstall({ repoRoot = REPO_ROOT } = {}) {
  const { entries } = planInstall({ repoRoot });
  for (const { key, value } of entries) {
    const r = gitConfig([key, value], repoRoot);
    if (r.status !== 0) throw new ExitError(1, `git config ${key} failed: ${r.stderr}`);
  }
  process.stdout.write(
    'Registered the gsd-regen merge driver in this clone.\n' +
      'Conflicts on the generated parity manifests and size baselines now resolve to your\n' +
      'branch’s copy; run `npm run regen:derived` afterwards to recompute them.\n' +
      'This is a bridge for #2721 and is retired by #2724.\n',
  );
  return 0;
}

function runUninstall({ repoRoot = REPO_ROOT } = {}) {
  for (const key of ['merge.gsd-regen.driver', 'merge.gsd-regen.name']) {
    // exit 5 == "was not set"; uninstalling something absent is success here
    gitConfig(['--unset-all', key], repoRoot);
  }
  process.stdout.write('Removed the gsd-regen merge driver from this clone.\n');
  return 0;
}

/**
 * @returns {{registered: boolean, pendingCount: number}} the same object it prints, so
 *   callers and tests consume the structure rather than re-parsing the rendered JSON.
 *   A count, not path names: the driver is never handed the conflicted path, by design
 *   (see planInstall).
 */
function statusOf({ repoRoot = REPO_ROOT } = {}) {
  const registered = gitConfig(['--get', 'merge.gsd-regen.driver'], repoRoot).status === 0;
  const { gitDir } = resolveGitDir(repoRoot);
  const marker = gitDir ? readMarker(path.join(gitDir, MARKER_NAME)) : null;
  return { registered, pendingCount: marker ? marker.count : 0 };
}

function runStatus({ repoRoot = REPO_ROOT } = {}) {
  process.stdout.write(JSON.stringify(statusOf({ repoRoot }), null, 2) + '\n');
  return 0;
}

function runDriver(argv) {
  const { gitDir } = resolveGitDir(process.cwd());
  const plan = resolveAndRecord({ argv, gitDir, now: Date.now() });

  if (plan.action === ACTION.DECLINE) {
    process.stderr.write(
      `gsd-regen: declined (${plan.reason}) — leaving this path as a normal conflict.\n`,
    );
    return plan.exitCode;
  }
  if (plan.notice) {
    process.stderr.write(
      'gsd-regen: kept your branch’s copy of the generated parity/size artifacts.\n' +
        'gsd-regen: these files cannot be line-merged — their only correct value is recomputed.\n' +
        'gsd-regen: run `npm run regen:derived` before committing.\n' +
        'gsd-regen: (bridge for #2721; retired by #2724)\n',
    );
  }
  return plan.exitCode;
}

function main() {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));

  if (flags.length > 0) {
    if (flags.length > 1 || argv.length > 1) {
      throw new ExitError(2, 'usage: git-merge-regen-driver.cjs [--install|--uninstall|--status]');
    }
    switch (flags[0]) {
      case '--install':
        return runInstall();
      case '--uninstall':
        return runUninstall();
      case '--status':
        return runStatus();
      default:
        throw new ExitError(
          2,
          `unknown flag ${flags[0]}\nusage: git-merge-regen-driver.cjs [--install|--uninstall|--status]`,
        );
    }
  }

  return runDriver(argv);
}

module.exports = {
  ACTION,
  REASON,
  GITDIR_SOURCE,
  NOTICE_WINDOW_MS,
  MARKER_NAME,
  resolveGitDir,
  resolveAndRecord,
  planInstall,
  runInstall,
  runUninstall,
  runStatus,
  statusOf,
};

if (require.main === module) runMain(main);
