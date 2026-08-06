/**
 * Regression (#498, adversarial-review finding): the custom-file backup step in
 * update.md must derive RUNTIME_DIR from GSD_DIR.
 *
 * The get_installed_version step was rewritten to call `gsd-tools update-context`
 * and now emits GSD_DIR (the resolved config dir) instead of the old probe-loop
 * variables LOCAL_DIR / GLOBAL_DIR. The backup_custom_files step still read
 * LOCAL_DIR / GLOBAL_DIR, which are no longer assigned anywhere — so RUNTIME_DIR
 * went empty for every LOCAL/GLOBAL install and detect-custom-files was skipped.
 * Because the update then runs a clean install that wipes managed dirs
 * (commands/gsd, gsd-core), user-added files inside those dirs could be
 * deleted without the intended backup.
 *
 * This locks the fix: RUNTIME_DIR comes from GSD_DIR, and the dead LOCAL_DIR /
 * GLOBAL_DIR references are gone.
 *
 * Source-text-is-the-product: update.md's bash blocks ARE the deployed /gsd:update
 * program; asserting their shape is asserting on the deployed contract.
 */

// allow-test-rule: source-text-is-the-product
// update.md's bash blocks ARE the deployed /gsd:update program; asserting
// their shape is asserting on the deployed contract. The data-loss behavior
// only manifests against a real install during a clean reinstall, which CI
// does not perform.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UPDATE_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md');

function codeOnly(file) {
  // Strip fenced-block prose is unnecessary here; we assert on the whole doc
  // but ignore markdown comment prose by only matching shell-assignment forms.
  return fs.readFileSync(file, 'utf8');
}

describe('#498 regression: update.md backup uses GSD_DIR, not the removed LOCAL_DIR/GLOBAL_DIR', () => {
  const src = codeOnly(UPDATE_MD);

  test('RUNTIME_DIR is assigned from GSD_DIR', () => {
    assert.match(
      src,
      /RUNTIME_DIR="\$GSD_DIR"/,
      'backup_custom_files must set RUNTIME_DIR="$GSD_DIR" (the resolved config dir from update-context)',
    );
  });

  test('no shell assignment reads the removed LOCAL_DIR/GLOBAL_DIR probe variables', () => {
    // The get_installed_version rewrite no longer assigns LOCAL_DIR/GLOBAL_DIR.
    // Any RUNTIME_DIR="$LOCAL_DIR" / "$GLOBAL_DIR" would silently resolve to empty.
    assert.doesNotMatch(
      src,
      /="\$(LOCAL_DIR|GLOBAL_DIR)"/,
      'update.md still reads LOCAL_DIR/GLOBAL_DIR, which get_installed_version no longer sets — backup will be skipped',
    );
  });

  test('detect-custom-files stays gated on a non-empty RUNTIME_DIR', () => {
    assert.match(
      src,
      /\[ -n "\$RUNTIME_DIR" \][\s\S]*?detect-custom-files --config-dir "\$RUNTIME_DIR"/,
      'backup must still skip when RUNTIME_DIR is empty (UNKNOWN scope)',
    );
  });
});
