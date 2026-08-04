'use strict';

/**
 * inventory-nested-families.test.cjs — 50-test-matrix.md rows 4, 5, 8, 9, 10, 11, 12, 13
 * (issue #2996, epic #1671 Phase 6.5).
 *
 * `collectNested` is what makes `gsd-core/workflows/<wf>/steps/*.md` and
 * `<wf>/modes/*.md` visible to docs/INVENTORY-MANIFEST.json. The real tree
 * currently has no same-named step files in two workflows, so the collision
 * safety that motivated PATH keying is unobservable against the live repo —
 * these rows build fixture trees that DO collide, so the property is proven
 * rather than assumed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectNested } = require('../scripts/gen-inventory-manifest.cjs');
const { cleanup } = require('./helpers.cjs');

const MD_ONLY = (f) => f.endsWith('.md');

/** Build a fixture tree: {parentName: {subdirName: [fileNames]}}. */
function buildTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2996-nested-'));
  for (const [parent, subdirs] of Object.entries(spec)) {
    for (const [subdir, files] of Object.entries(subdirs)) {
      const dir = path.join(root, parent, subdir);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, f), '# fixture\n');
    }
  }
  return root;
}

// ─── Row 4/5: PATH keying, not basename — collisions must not drop entries ────

test('row 4 — two workflows owning a same-named step file both appear', (t) => {
  const root = buildTree({
    alpha: { steps: ['regression-gate.md'] },
    beta: { steps: ['regression-gate.md'] },
  });
  t.after(() => cleanup(root));

  assert.deepStrictEqual(
    collectNested({ root, subdir: 'steps', filter: MD_ONLY }),
    ['alpha/steps/regression-gate.md', 'beta/steps/regression-gate.md'],
    'a basename key would collapse these to one entry and the JSON-equality check would read it as up to date',
  );
});

test('row 5 — a step file named after a top-level workflow keeps its own key', (t) => {
  const root = buildTree({ alpha: { steps: ['quick.md'] } });
  t.after(() => cleanup(root));

  assert.deepStrictEqual(
    collectNested({ root, subdir: 'steps', filter: MD_ONLY }),
    ['alpha/steps/quick.md'],
    'the nested key is a path, so it cannot be confused with the top-level workflows entry "quick.md"',
  );
});

// ─── Rows 8/9/10: emptiness boundaries — limit-1 / limit ─────────────────────

test('row 8 — a parent with no such subdirectory contributes nothing', (t) => {
  const root = buildTree({ alpha: { modes: ['default.md'] } });
  t.after(() => cleanup(root));

  assert.deepStrictEqual(
    collectNested({ root, subdir: 'steps', filter: MD_ONLY }),
    [],
    'a workflow without a steps/ dir must contribute no key at all',
  );
});

test('row 9 — an empty subdirectory contributes no entries (limit-1)', (t) => {
  const root = buildTree({ alpha: { steps: [] } });
  t.after(() => cleanup(root));

  assert.deepStrictEqual(
    collectNested({ root, subdir: 'steps', filter: MD_ONLY }),
    [],
    'an empty steps/ dir must not materialize an empty-array key — that is a committed diff signalling nothing',
  );
});

test('row 10 — exactly one file is listed (limit)', (t) => {
  const root = buildTree({ alpha: { steps: ['only.md'] } });
  t.after(() => cleanup(root));

  assert.deepStrictEqual(collectNested({ root, subdir: 'steps', filter: MD_ONLY }), ['alpha/steps/only.md']);
});

// ─── Row 11: recursion is bounded at ONE level (limit+1) ─────────────────────

test('row 11 — nesting deeper than one level is not swept', (t) => {
  const root = buildTree({ alpha: { steps: ['top.md'] } });
  const deep = path.join(root, 'alpha', 'steps', 'sub');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'deeper.md'), '# fixture\n');
  t.after(() => cleanup(root));

  assert.deepStrictEqual(
    collectNested({ root, subdir: 'steps', filter: MD_ONLY }),
    ['alpha/steps/top.md'],
    'recursion is deliberately bounded at one named subdirectory; this row is what stops that bound from silently becoming a general walk',
  );
});

// ─── Rows 12/13: filtering and hostile shapes ────────────────────────────────

test('row 12 — non-markdown files in the subdirectory are ignored', (t) => {
  const root = buildTree({ alpha: { steps: ['keep.md'] } });
  fs.writeFileSync(path.join(root, 'alpha', 'steps', 'notes.txt'), 'x\n');
  fs.writeFileSync(path.join(root, 'alpha', 'steps', 'data.json'), '{}\n');
  t.after(() => cleanup(root));

  assert.deepStrictEqual(collectNested({ root, subdir: 'steps', filter: MD_ONLY }), ['alpha/steps/keep.md']);
});

test('row 13 — a plain FILE named like the subdirectory does not crash the walk', (t) => {
  const root = buildTree({ alpha: { steps: ['real.md'] } });
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'beta', 'steps'), 'i am a file, not a directory\n');
  t.after(() => cleanup(root));

  assert.deepStrictEqual(
    collectNested({ root, subdir: 'steps', filter: MD_ONLY }),
    ['alpha/steps/real.md'],
    'isDirectory() must be checked before readdirSync, or a file named steps throws ENOTDIR',
  );
});

test('row 13b — a missing root contributes nothing rather than throwing', () => {
  assert.deepStrictEqual(
    collectNested({ root: path.join(os.tmpdir(), 'gsd-2996-does-not-exist'), subdir: 'steps', filter: MD_ONLY }),
    [],
  );
});

// ─── Row 13c: an unstattable entry is skipped, not fatal ─────────────────────

test('row 13c — a dangling symlink under the subdirectory does not crash the walk', (t) => {
  // fs.symlinkSync throws EPERM on Windows without elevation or Developer Mode.
  // A genuine t.skip(), never a bare `return` — a bare return is a PASS in
  // node:test and would hide the gap rather than report it.
  if (process.platform === 'win32') {
    t.skip('symlink creation requires elevation on Windows; the unstattable-entry path is asserted on macOS + Linux');
    return;
  }

  const root = buildTree({ alpha: { steps: ['real.md'] } });
  t.after(() => cleanup(root));
  fs.symlinkSync(path.join(root, 'alpha', 'steps', 'nope.md'), path.join(root, 'alpha', 'steps', 'dangling.md'));

  assert.deepStrictEqual(
    collectNested({ root, subdir: 'steps', filter: MD_ONLY }),
    ['alpha/steps/real.md'],
    'one unreadable entry must not take down manifest generation for the whole repo',
  );
});

// ─── Determinism ─────────────────────────────────────────────────────────────

test('collectNested is deterministic and sorted', (t) => {
  const root = buildTree({ zeta: { steps: ['b.md', 'a.md'] }, alpha: { steps: ['c.md'] } });
  t.after(() => cleanup(root));

  const first = collectNested({ root, subdir: 'steps', filter: MD_ONLY });
  const second = collectNested({ root, subdir: 'steps', filter: MD_ONLY });
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first, ['alpha/steps/c.md', 'zeta/steps/a.md', 'zeta/steps/b.md']);
});
