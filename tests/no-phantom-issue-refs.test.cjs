// allow-test-rule: runtime-contract-is-the-product (see #1073) — this guard asserts the
// ABSENCE of phantom pre-migration issue references in repo text (docs, tests,
// workflows). The file *content* is the product surface here (#1073): dangling
// refs that don't exist in open-gsd/gsd-core mislead triage and manufacture
// phantom blockers. This test fails CI if such a ref is reintroduced.
//
// MAINTENANCE — this list ROTS and must be pruned (#2653).
// GitHub numbers issues and pull requests from one shared counter, so every
// entry below is phantom only until this repo's counter reaches it. Two of the
// original three have already gone real:
//   2551 -> merged PR "fix(#2366): scope parseCoverageMatrix to recognized coverage tables"
//   2361 -> merged PR "docs(#2357): fix Registry Discussions category name and state its format"
// While they remained listed this guard rejected legitimate citations of those
// PRs — it fired on a build-artifact-drift fix that named PR 2551 as the
// provenance of the drift, which is exactly the sort of accurate reference the
// repo wants. Before adding a number, confirm it sits above the current
// counter; once the counter passes an entry, delete it.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

// Phantom pre-migration (get-shit-done-redux) issue numbers with NO equivalent
// in open-gsd/gsd-core. Matched only with a leading '#' or in an issues/ URL so
// digit-bearing strings like an `id_ed25519` SSH key fingerprint are NOT
// false-positives.
//
// Re-verified against the live repo on 2026-07-25, when the shared issue/PR
// counter stood at 2654: 3182 is still a 404; 2551 and 2361 now resolve to
// merged PRs and were removed (#2653).
const PHANTOM = ['3182'];
const REF_RE = new RegExp(
  '(?:#(?:' + PHANTOM.join('|') + ')\\b)|(?:issues/(?:' + PHANTOM.join('|') + ')\\b)',
);

const SCAN_EXT = new Set(['.md', '.cjs', '.js', '.cts', '.ts']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.changeset']);
// This guard file itself names the phantom numbers (by necessity); exclude it.
const SELF = path.relative(ROOT, __filename);

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), acc);
    // entry.isFile() excludes symlinks (and other non-regular dirents) so a broken symlink like
    // a gitignored CLAUDE.md worktree symlink is skipped deterministically on every platform —
    // it can't be read and isn't shipped repo text (#1545).
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

test('no phantom pre-migration issue references remain in repo text (#1073)', () => {
  const offenders = [];
  for (const file of walk(ROOT, [])) {
    const rel = path.relative(ROOT, file);
    if (rel === SELF) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (REF_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.strictEqual(
    offenders.length,
    0,
    `Phantom issue refs (${PHANTOM.map((n) => '#' + n).join('/')}) found — repoint to a real ` +
      `successor (#717/#720) or rewrite as prose (see #1073):\n` + offenders.join('\n'),
  );
});

test('walk() skips broken symlinks and does not throw ENOENT (#1545)', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nophantom-symlink-'));
  let symlinkCreated = false;
  try {
    fs.writeFileSync(path.join(fixture, 'real.md'), '# real, no phantom refs\n');
    try {
      fs.symlinkSync(
        path.join(fixture, 'does-not-exist-target'),
        path.join(fixture, 'broken.md'),
      );
      // Verify the symlink actually exists (lstat succeeds even for dangling symlinks)
      fs.lstatSync(path.join(fixture, 'broken.md'));
      symlinkCreated = true;
    } catch (e) {
      // Windows without symlink privilege — genuine skip
    }

    if (!symlinkCreated) {
      t.skip('platform cannot create symlinks unprivileged');
      return;
    }

    const found = walk(fixture, []).map((f) => path.basename(f));

    assert.ok(found.includes('real.md'), 'walk() must include real.md');
    assert.ok(!found.includes('broken.md'), 'walk() must NOT include broken.md (broken symlink)');

    // Mirror the production read loop — must not throw ENOENT
    assert.doesNotThrow(
      () => found.length && walk(fixture, []).forEach((fp) => fs.readFileSync(fp, 'utf8')),
      'readFileSync on every walk() result must not throw (no broken symlinks returned)',
    );
  } finally {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup in standalone guard test; no helpers import available (would introduce a test-dep cycle)
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
