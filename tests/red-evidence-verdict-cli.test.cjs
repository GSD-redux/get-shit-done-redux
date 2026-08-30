'use strict';

/**
 * Behavioural tests for the `task red-evidence-verdict` CLI arm (#3770).
 *
 * The arm had no behavioural coverage: the only existing assertions check that
 * the string `task.red-evidence-verdict` appears in workflow prose. These pin
 * the two guards the arm actually makes claims about — that a task file
 * outside the project is refused, and that a non-file path is refused cleanly
 * rather than by throwing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

/** Run the arm and return its combined output; the seam never throws on exit code. */
function runVerdict(args) {
  const r = runNode([GSD_TOOLS, 'query', 'task', 'red-evidence-verdict', ...args], { cwd: REPO_ROOT });
  return `${r.stdout}${r.stderr}`;
}

describe('task red-evidence-verdict — path guards', () => {
  test('a symlink pointing outside the project is refused, not followed', (t) => {
    const outside = createTempDir('red-ev-outside-');
    const target = path.join(outside, 'outside.md');
    fs.writeFileSync(target, '<red_contract><target_test>x</target_test></red_contract>\n');
    const link = path.join(REPO_ROOT, `.red-ev-escape-${process.pid}.md`);
    fs.symlinkSync(target, link);
    t.after(() => {
      fs.unlinkSync(link);
      cleanup(outside);
    });

    assert.match(runVerdict(['--task-file', path.basename(link), '--trailer', '{}']),
      /outside project scope/,
      'the containment guard must resolve symlinks before comparing against the project root — '
      + '`path.resolve` does not, so a symlink planted in the repo reads an arbitrary file '
      + 'while the guard reports success. A guard that announces "outside project scope" and '
      + 'does not enforce it is worse than none.');
  });

  test('a directory path is refused cleanly, without throwing', () => {
    const out = runVerdict(['--task-file', '.', '--trailer', '{}']);

    assert.doesNotMatch(out, /EISDIR|at routeTask|at dispatchHostCommand/,
      'the module documents that it never throws; the CLI arm around it must not either. '
      + '`fs.readFileSync` on a directory raises EISDIR with a stack trace instead of the '
      + 'arm\'s own USAGE error.');
    assert.match(out, /not found|outside project scope/,
      'a non-file path must produce the arm\'s own usage error');
  });
});
