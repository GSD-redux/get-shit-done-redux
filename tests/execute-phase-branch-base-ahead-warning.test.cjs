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
