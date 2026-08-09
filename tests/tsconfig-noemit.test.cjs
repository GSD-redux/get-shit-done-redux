'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

// 180000: this is a real `tsc --noEmit` compile of the whole project, not a
// short probe or the hooks-only bundle `BUILD_TIMEOUT_MS` (30000) norm
// covers — matches the documented real-compile precedent at
// tests/ensure-runtime-build.test.cjs:35.
const TSC_NOEMIT_TIMEOUT_MS = 180000;

test('root tsconfig supports the default no-emit typecheck command', () => {
  const root = path.join(__dirname, '..');
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

  const result = runNode([tscBin, '--noEmit'], {
    cwd: root,
    timeoutMs: TSC_NOEMIT_TIMEOUT_MS,
  });

  assert.equal(
    result.exitCode,
    0,
    [
      'Expected the default root TypeScript typecheck to pass.',
      'stdout:',
      result.stdout,
      'stderr:',
      result.stderr,
    ].join('\n'),
  );
});
