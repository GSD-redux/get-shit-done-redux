// allow-test-rule: structural-regression-guard see #3415
// Row 15 of .gsd/phase/chore-3415-prohibition-with-teeth/50-test-matrix.md
// (design doc §4, docs/adr/3212-lexical-seam-consolidation.md:149/167): Phase 4
// burns down and deletes the grandfather allowlists that Phases 1-3 used to
// grandfather pre-existing #2128-class regex sites, so no file in the tracked
// tree may still carry a `pending #3212` marker after this phase ships. This
// is a structural source-text property (the marker's mere presence, not its
// runtime behavior), so a tracked-tree scan is the only faithful check.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MARKER = 'pending #3212';

// Files that legitimately contain the literal marker string in prose/self-
// reference rather than as an actual (now-forbidden) suppression marker:
//   - this file itself (the string appears in this comment/the assertion
//     message, describing what it guards against)
//   - docs/adr/3212-lexical-seam-consolidation.md — the ADR prose that
//     DEFINES the "pending #3212" marker convention and Phase 4's mandate to
//     burn it down (lines 149, 167); verified via `git grep -n "pending
//     #3212"` to be the only doc referencing the phrase.
const EXCLUDED_RELATIVE_PATHS = new Set([
  'tests/no-pending-3212-markers.test.cjs',
  'docs/adr/3212-lexical-seam-consolidation.md',
]);

/**
 * Returns the repo's tracked files (repo-relative, forward-slash-normalized),
 * so untracked/gitignored files (e.g. .gsd/) are naturally excluded.
 * @returns {string[]}
 */
function listTrackedFiles() {
  const stdout = execFileSync('git', ['-c', 'safe.directory=*', 'ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\\/g, '/'))
    .filter((line) => line.length > 0);
}

test('#3212 epic: no tracked file contains a "pending #3212" marker (design doc §4)', () => {
  const fs = require('node:fs');
  const violations = [];

  for (const relPath of listTrackedFiles()) {
    if (EXCLUDED_RELATIVE_PATHS.has(relPath)) continue;

    const fullPath = path.join(ROOT, relPath);
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (_) {
      // Not a regular readable text file (e.g. a submodule gitlink, a binary
      // asset, or a symlink target that moved) — skip; this guard is about
      // source-text markers, not filesystem integrity.
      continue;
    }

    if (content.includes(MARKER)) {
      violations.push(relPath);
    }
  }

  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} tracked file(s) still carrying a "pending #3212" ` +
      `grandfather marker (ADR-3212 Phase 4 requires them all burned down and ` +
      `deleted): ${violations.join(', ')}`,
  );
});
