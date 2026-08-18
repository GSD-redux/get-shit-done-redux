// allow-test-rule: source-text-is-the-product (see #2639)
// gsd-core/workflows/execute-phase.md is the deployed CI contract; asserting
// that handle_branching warns when local is ahead of origin is only expressible
// against the workflow text.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

describe('#2639 — handle_branching warns when local is ahead of origin', () => {
  const text = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, 'utf8') : '';

  test('the fork block checks for local-ahead-of-origin before branching', () => {
    assert.ok(text.length > 0, 'execute-phase.md must exist');
    // The fix adds a `git rev-list --count origin/$DEFAULT_BRANCH..$DEFAULT_BRANCH`
    // check before the `git checkout -b` fork, with a WARNING to stderr.
    assert.ok(
      /rev-list.*--count.*DEFAULT_BRANCH/i.test(text),
      'handle_branching must check if local $DEFAULT_BRANCH is ahead of origin before forking (git rev-list --count) — without this, unpushed local commits are silently missing from the phase branch (#2639)',
    );
  });

  test('the warning names the divergence and advises the user', () => {
    assert.ok(text.length > 0, 'execute-phase.md must exist');
    // The warning must mention "ahead" and "unpushed" so the user understands
    // their commits won't be on the phase branch.
    assert.ok(
      /ahead.*origin.*DEFAULT_BRANCH/i.test(text) || /unpushed/i.test(text),
      'handle_branching must warn that local commits are ahead/unpushed when forking from origin (#2639)',
    );
  });
});

describe('#3158 — handle_branching warns before committing on the base branch', () => {
  const text = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, 'utf8') : '';

  test('the none strategy compares the current branch to the resolved base branch', () => {
    assert.ok(text.length > 0, 'execute-phase.md must exist');
    const noneBranch = text.match(/\*\*"none":\*\*([\s\S]*?)(?=\*\*"phase" or "milestone":\*\*)/);
    assert.ok(noneBranch, 'handle_branching must retain a dedicated none-strategy branch');
    assert.match(noneBranch[1], /git branch --show-current/, 'none strategy must read the current branch');
    assert.match(noneBranch[1], /query git\.base-branch/, 'none strategy must resolve the configured base branch');
    assert.match(noneBranch[1], /\$C.*\$B|\$B.*\$C/, 'none strategy must compare the current branch with the base branch');
  });

  test('the base-branch warning is explicit and does not refuse the documented none strategy', () => {
    assert.ok(text.length > 0, 'execute-phase.md must exist');
    const noneBranch = text.match(/\*\*"none":\*\*([\s\S]*?)(?=\*\*"phase" or "milestone":\*\*)/);
    assert.ok(noneBranch, 'handle_branching must retain a dedicated none-strategy branch');
    assert.match(noneBranch[1], /WARNING:.*base branch/i, 'none strategy must warn before commits land on the base branch');
    assert.doesNotMatch(noneBranch[1], /exit\s+1|refus/i, 'none strategy must warn rather than reject the documented current-branch behavior');
  });

  test('the base-branch comparison exits 0 on both paths (warn-only, never gates the step)', () => {
    // Regression for a real bug: `[ "$C" = "$B" ] && echo … >&2` as the LAST
    // command in the block makes the block's own exit status track the test's
    // result — exit 1 when safe (no match), exit 0 when unsafe (on the base
    // branch). A regex assertion on the text can't catch this; only running
    // the extracted shell actually exercises the exit code.
    assert.ok(text.length > 0, 'execute-phase.md must exist');
    const noneBranch = text.match(/\*\*"none":\*\*([\s\S]*?)(?=\*\*"phase" or "milestone":\*\*)/);
    assert.ok(noneBranch, 'handle_branching must retain a dedicated none-strategy branch');
    const bashBlock = noneBranch[1].match(/```bash\r?\n([\s\S]*?)```/);
    assert.ok(bashBlock, 'none strategy must contain a fenced bash block');
    const script = bashBlock[1];

    const { spawnSync } = require('node:child_process');
    for (const [branch, expectWarning] of [['feature-x', false], ['main', true]]) {
      const wrapped = `gsd_run() { echo main; }\ngit() { echo "${branch}"; }\n${script}`;
      const result = spawnSync('bash', ['-c', wrapped], { encoding: 'utf8', timeout: 5000 });
      assert.equal(
        result.status, 0,
        `block must exit 0 when current branch is "${branch}" — a nonzero exit here would ` +
        `abort any caller running under \`set -e\`, and it must not do so on either path`,
      );
      if (expectWarning) {
        assert.match(result.stderr, /WARNING/, 'must warn when the current branch is the base branch');
      } else {
        assert.doesNotMatch(result.stderr, /WARNING/, 'must not warn when the current branch is not the base branch');
      }
    }
  });
});
