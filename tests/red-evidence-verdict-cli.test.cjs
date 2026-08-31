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

describe('task red-evidence-verdict — --changed-files membership', () => {
  // A contract that authorizes on its own content, so the ONLY variable under
  // test below is which changed-file list is passed. Go-shaped on purpose:
  // no `tests/` directory and no `.test.` infix, so nothing here can be
  // satisfied by a filename convention (LANG-01).
  const TRAILER = `red-evidence: ${JSON.stringify({
    command: 'go test ./... -run TestDiscountReducesTotal',
    exit_status: 1,
    target_test: 'TestDiscountReducesTotal',
    expected: { phase: 'test', class_or_mode: 'undefined: ApplyDiscount', subject: 'TestDiscountReducesTotal' },
    actual: { phase: 'test', class_or_mode: 'undefined: ApplyDiscount', subject: 'TestDiscountReducesTotal' },
    location: {
      declared: { file: 'pkg/pricing/pricing_test.go', line: 6 },
      observed: { file: 'pkg/pricing/pricing_test.go', line: 6 },
    },
  })}`;

  const withTaskFile = (t) => {
    const rel = `.red-ev-task-${process.pid}.md`;
    fs.writeFileSync(path.join(REPO_ROOT, rel), `<task tdd="true">
  <behavior>Applies a percentage discount and reduces the order total.</behavior>
  <files>pkg/pricing/pricing.go</files>
  <red_contract>
    <target_test>TestDiscountReducesTotal</target_test>
    <implementation_target>pricing.ApplyDiscount</implementation_target>
    <expected_failure>
      <phase>test</phase>
      <class_or_mode>undefined: ApplyDiscount</class_or_mode>
      <subject>TestDiscountReducesTotal</subject>
    </expected_failure>
  </red_contract>
</task>
`);
    t.after(() => fs.unlinkSync(path.join(REPO_ROOT, rel)));
    return rel;
  };

  test('the declared file itself satisfies membership', (t) => {
    const out = runVerdict(['--task-file', withTaskFile(t), '--trailer', TRAILER,
      '--changed-files', 'pkg/pricing/pricing_test.go']);
    assert.match(out, /"verdict": "authorize"/,
      'the positive control: a commit that touched exactly the declared file must authorize. '
      + 'Without this, the decoy assertion below could pass simply by refusing everything.');
  });

  test('a same-basename file in a DIFFERENT directory does not satisfy membership (WR-01)', (t) => {
    const out = runVerdict(['--task-file', withTaskFile(t), '--trailer', TRAILER,
      '--changed-files', 'vendor/other/pricing_test.go']);
    assert.match(out, /"verdict": "red_commit_not_failing"/,
      'WR-01: the membership check exists to prove the RED commit touched the file its own '
      + 'evidence names. Comparing basenames lets any same-named file anywhere in the tree '
      + 'stand in for it, which defeats exactly the anti-decoy property the check provides. '
      + 'Both sides here are repo-relative paths from git, so there is no prefix skew to '
      + 'normalize away — unlike locationsAgree, whose declared/observed inputs come from '
      + 'different tools and DO legitimately differ by prefix. Do not close this by changing '
      + 'locationsAgree: an endsWith narrowing there blocks outside-in and '
      + 'fixture-is-the-behavior (REGR-04). See gsd-core-vlh.');
  });
});
