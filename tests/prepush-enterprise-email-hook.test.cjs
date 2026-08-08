'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, '.githooks', 'pre-push');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/**
 * Write a mock bash script to a .sh file in tmpDir and return its absolute path.
 * The hook invokes it via GIT_OVERRIDE — bash executes the path directly via the
 * env-var seam, bypassing PATH entirely. No NTFS execute-ACL fight, no MSYS2
 * PATH-type inheritance dance needed.
 */
function writeMock(tmpDir, name, content) {
  const filePath = path.join(tmpDir, `${name}.sh`);
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  return filePath;
}

describe('.githooks/pre-push enterprise email guard', () => {
  test('blocks push when any to-be-pushed commit matches local blocked regex', (t) => {
    const tmpDir = createTempDir('gsd-prepush-hook-');
    t.after(() => cleanup(tmpDir));

    const mockGit = writeMock(tmpDir, 'git', `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "rev-list" ]]; then
  echo "c1"
  echo "c2"
  exit 0
fi
if [[ "$1" == "show" ]]; then
  commit="$(printf '%s\n' "$@" | tail -n 1)"
  if [[ "$commit" == "c1" ]]; then
    echo "trekkie@nomorestars.com"
  else
    echo "person@example-corp.com"
  fi
  exit 0
fi
exit 1
`);

    assert.throws(() => {
      const r = runHook(HOOK_PATH, [], {
        interpreter: 'bash',
        cwd: ROOT,
        env: {
          ...process.env,
          GIT_OVERRIDE: mockGit,
          GSD_BLOCKED_AUTHOR_REGEX: '@example-corp\\.com$',
        },
        input: 'refs/heads/pr refs-local-sha refs/heads/pr refs-remote-sha\n',
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      throwIfFailed(r, `bash ${HOOK_PATH}`);
    }, /Push blocked: commit author email matched local blocked regex/);
  });

  test('allows push when to-be-pushed commits are non-enterprise emails', (t) => {
    const tmpDir = createTempDir('gsd-prepush-hook-');
    t.after(() => cleanup(tmpDir));

    const mockGit = writeMock(tmpDir, 'git', `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "rev-list" ]]; then
  echo "c1"
  echo "c2"
  exit 0
fi
if [[ "$1" == "show" ]]; then
  echo "trekkie@nomorestars.com"
  exit 0
fi
exit 1
`);

    const r = runHook(HOOK_PATH, [], {
      interpreter: 'bash',
      cwd: ROOT,
      env: {
        ...process.env,
        GIT_OVERRIDE: mockGit,
        GSD_BLOCKED_AUTHOR_REGEX: '@example-corp\\.com$',
      },
      input: 'refs/heads/pr refs-local-sha refs/heads/pr refs-remote-sha\n',
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    throwIfFailed(r, `bash ${HOOK_PATH}`);
  });
});
