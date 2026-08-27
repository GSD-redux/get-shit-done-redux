'use strict';

/**
 * Regression tripwire for issue #3873 (ADR-3473 §8.8, Phase 3 design/test
 * matrix row 28 — `retainedFieldDriftGuardStillCatchesARederivation`).
 *
 * ADR-3473 §8.8 instructs deleting `scripts/lint-state-field-drift.cjs` as a
 * "consequence for the guard" of consolidating STATE.md's field tables into
 * one schema. That instruction rests on a wrong premise: this guard protects
 * the ADR-3180 §7.7 / issue #3187 frontmatter-else-body coercion-ladder
 * re-derivation, not the field/template/docs key-set drift Phase 3's schema
 * addresses — the two are orthogonal, and the guard's own header docstring
 * (`scripts/lint-state-field-drift.cjs:4-6`) says exactly that. The guard is
 * therefore RETAINED, not deleted, and this test exists so a future reader
 * cannot delete it on the ADR's word alone: it fails (module not found) the
 * moment the file is removed, and it fails (assertion) the moment the guard
 * stops detecting the ladder shape it was built for.
 *
 * `scripts/lint-state-field-drift.cjs` exports pure functions
 * (`scanRepo(root)`, `findStateFieldDrift(text, relPath)`) that never touch
 * the filesystem for the fixture half of this test — no fixture file is
 * planted anywhere under the real `src/` tree (that mistake was made once
 * already in this epic and fixed; see CLAUDE.md's Test Cleanup rule and the
 * epic's own retrospective).
 *
 * The guard's CLI (`main()`, `scripts/lint-state-field-drift.cjs:763-782`)
 * hard-codes its scan root to `path.join(__dirname, '..')` and takes no
 * `--root` override (unlike its sibling `scripts/lint-state-write-path-drift.cjs`,
 * which Phase 1 gave a `--root` flag). That only constrains an invocation of
 * the CLI itself; `scanRepo` and `findStateFieldDrift` are exported and
 * accept their scan surface as a parameter directly, which is what this test
 * uses for both assertions below.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const drift = require('../scripts/lint-state-field-drift.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const GUARD_PATH = path.join(REPO_ROOT, 'scripts', 'lint-state-field-drift.cjs');

describe('#3873 regression: scripts/lint-state-field-drift.cjs is retained, not deleted', () => {
  test('retainedFieldDriftGuardStillCatchesARederivation', () => {
    // (a) The guard file still exists and still runs clean against this repo
    // today — the deletion ADR-3473 §8.8 calls for has not happened, and if
    // it ever does this `require` throws MODULE_NOT_FOUND before the
    // assertion below is even reached.
    assert.ok(fs.existsSync(GUARD_PATH), 'scripts/lint-state-field-drift.cjs must still exist (#3873: not deleted by ADR-3473 §8.8)');
    const violationsOnRealRepo = drift.scanRepo(REPO_ROOT);
    assert.deepStrictEqual(violationsOnRealRepo, [], 'the guard must report zero re-derivations on the real, consolidated tree');

    // (b) The guard still REPORTS on a re-derived frontmatter-else-body
    // fallback ladder. Built entirely in memory via the exported pure
    // `findStateFieldDrift(text, relPath)` — no temp directory, no write
    // under `src/`. The fixture text is never persisted to disk.
    const fixtureSource = [
      "function cmdFixtureRead(fm, body) {",
      '  const v = fm.current_plan;',
      "  if (typeof v === 'number' || typeof v === 'boolean') return String(v);",
      "  return stateExtractField(body, 'Current Plan');",
      '}',
    ].join('\n');
    const found = drift.findStateFieldDrift(fixtureSource, path.join('src', 'fixture-not-a-real-file.cts'));
    assert.strictEqual(found.length, 1, `expected exactly one re-derivation to be reported, got: ${JSON.stringify(found)}`);
    assert.strictEqual(found[0].line, 4);
    assert.match(found[0].found, /stateExtractField\(body, 'Current Plan'\)/);
  });
});
