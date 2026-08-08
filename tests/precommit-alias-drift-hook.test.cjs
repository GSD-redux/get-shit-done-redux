'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, '.githooks', 'pre-commit');

/**
 * Write a mock bash script to a .sh file in tmpDir and return its absolute path.
 * The hook invokes it via GIT_OVERRIDE / NPM_OVERRIDE — bash executes the path
 * directly, so no PATH manipulation or NTFS execute-ACL fight is needed.
 */
function writeMock(tmpDir, name, content) {
  const filePath = path.join(tmpDir, `${name}.sh`);
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  return filePath;
}

describe('.githooks/pre-commit alias drift guard', () => {
  test('runs npm check when staged files include command-manifest/alias artifacts', (t) => {
    const tmpDir = createTempDir('gsd-precommit-hook-');
    t.after(() => cleanup(tmpDir));

    const mockGit = writeMock(tmpDir, 'git', `#!/usr/bin/env bash\nprintf "%s\\n" "${'sdk/src/query/command-manifest.phase.ts'}"\n`);
    const mockNpm = writeMock(tmpDir, 'npm', `#!/usr/bin/env bash\nprintf "called" > "$GSD_TEST_NPM_MARKER"\n`);

    const marker = path.join(tmpDir, 'npm-called.txt');

    throwIfFailed(
      runHook(HOOK_PATH, [], {
        interpreter: 'bash',
        cwd: ROOT,
        env: {
          ...process.env,
          GIT_OVERRIDE: mockGit,
          NPM_OVERRIDE: mockNpm,
          GSD_TEST_NPM_MARKER: marker,
        },
        timeoutMs: 15000,
      }),
      `bash ${HOOK_PATH}`,
    );

    assert.ok(fs.existsSync(marker), 'expected npm run check:alias-drift to be invoked');
  });

  test('does not run npm check when staged files are unrelated', (t) => {
    const tmpDir = createTempDir('gsd-precommit-hook-');
    t.after(() => cleanup(tmpDir));

    const mockGit = writeMock(tmpDir, 'git', `#!/usr/bin/env bash\nprintf "%s\\n" "README.md"\n`);
    const mockNpm = writeMock(tmpDir, 'npm', `#!/usr/bin/env bash\nprintf "called" > "$GSD_TEST_NPM_MARKER"\n`);

    const marker = path.join(tmpDir, 'npm-called.txt');

    throwIfFailed(
      runHook(HOOK_PATH, [], {
        interpreter: 'bash',
        cwd: ROOT,
        env: {
          ...process.env,
          GIT_OVERRIDE: mockGit,
          NPM_OVERRIDE: mockNpm,
          GSD_TEST_NPM_MARKER: marker,
        },
        timeoutMs: 15000,
      }),
      `bash ${HOOK_PATH}`,
    );

    assert.ok(!fs.existsSync(marker), 'expected npm check to be skipped for unrelated staged files');
  });
});
