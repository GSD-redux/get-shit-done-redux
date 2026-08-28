/**
 * #1874 F5 hardening — atomicWriteFileSync (src/runtime-hooks-surface.cts)
 * rename-failure fault injection.
 *
 * The temp-file + rename primitive documents a specific contract for a
 * failure mid-swap (see the catch block wrapping shellCmdProjection.
 * retryRenameSync in atomicWriteFileSync): the temp file is force-removed
 * and the original error is rethrown, un-transformed. This exercises that
 * contract directly rather than through an install() integration path, and
 * asserts the pre-existing target is left byte-identical.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { atomicWriteFileSync } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

describe('#1874 F5: atomicWriteFileSync rename-failure fault injection', () => {
  test('a renameSync failure mid-swap removes the temp file, leaves an existing target untouched, and rethrows', (t) => {
    const dir = createTempDir('gsd-1874-f5-rename-fail-');
    t.after(() => cleanup(dir));

    const target = path.join(dir, 'hooks.json');
    const prior = '{"version":1,"hooks":{}}\n';
    fs.writeFileSync(target, prior);

    const origRenameSync = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (dst === target) {
        // A non-retryable code (see RENAME_RETRY_ERRNOS in
        // shell-command-projection.cts) so the failure is immediate, not
        // masked behind retryRenameSync's bounded Windows-lock retry loop.
        throw Object.assign(new Error('simulated rename failure mid-swap'), { code: 'ENOSPC' });
      }
      return origRenameSync(src, dst);
    };
    t.after(() => { fs.renameSync = origRenameSync; });

    assert.throws(
      () => atomicWriteFileSync(target, '{"version":1,"hooks":{"new":true}}\n', 'utf8'),
      (e) => e.code === 'ENOSPC' && /simulated rename failure mid-swap/.test(e.message),
      'the rename error must propagate un-transformed'
    );

    assert.strictEqual(
      fs.readFileSync(target, 'utf8'),
      prior,
      'the pre-existing target must be left byte-identical when rename fails'
    );

    const residue = fs.readdirSync(dir).filter((n) => n !== 'hooks.json');
    assert.deepStrictEqual(residue, [], 'no atomic temp file may survive a failed rename');
  });

  test('a renameSync failure when no target pre-exists leaves no target and no temp residue', (t) => {
    const dir = createTempDir('gsd-1874-f5-rename-fail-new-');
    t.after(() => cleanup(dir));

    const target = path.join(dir, 'hooks.json');

    const origRenameSync = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (dst === target) {
        throw Object.assign(new Error('simulated rename failure, no prior target'), { code: 'ENOSPC' });
      }
      return origRenameSync(src, dst);
    };
    t.after(() => { fs.renameSync = origRenameSync; });

    assert.throws(
      () => atomicWriteFileSync(target, '{"version":1,"hooks":{}}\n', 'utf8'),
      (e) => e.code === 'ENOSPC',
      'the rename error must propagate un-transformed'
    );

    assert.strictEqual(fs.existsSync(target), false, 'no target file may be created when rename fails');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no atomic temp file may survive a failed rename');
  });
});
