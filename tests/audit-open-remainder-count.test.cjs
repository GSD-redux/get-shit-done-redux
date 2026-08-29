'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3817 — audit-open's counts must include the truncation remainder.
//
// The todo scan truncates its detail list at 5 and pushes a synthetic
// {_remainder_count: N} marker; the counting pass filtered that marker out
// alongside scan_error, so counts.todos and counts.total read systematically
// low by exactly N — the remainder existed only in the "… and N more" prose
// (reporter: 19 pending, reported 5). Truncation limits display, never
// counting.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

function runAuditOpen(cwd) {
  const r = runGsdTools(['audit-open', '--json'], cwd);
  assert.ok(r.success, r.error);
  return JSON.parse(r.output);
}

describe('#3817: audit-open counts include the truncation remainder', () => {
  test('#3817: more than 5 todo files → counts.todos counts every pending file', (t) => {
    const tmpDir = createTempProject('gsd-3817-many-');
    t.after(() => cleanup(tmpDir));
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const TOTAL = 8; // 5 shown + remainder 3
    for (let i = 1; i <= TOTAL; i++) {
      fs.writeFileSync(path.join(pendingDir, `todo-${String(i).padStart(2, '0')}.md`), [
        '---',
        'title: Fix thing ' + i,
        'area: general',
        'created: 2026-08-01',
        '---',
        '',
        'Body ' + i,
        '',
      ].join('\n'));
    }

    const out = runAuditOpen(tmpDir);
    assert.equal(
      out.counts.todos,
      TOTAL,
      `#3817: counts.todos must count every pending todo file (${TOTAL}); got ${out.counts.todos}`,
    );
    assert.equal(
      out.counts.total,
      TOTAL,
      `#3817: counts.total must include the remainder; got ${out.counts.total}`,
    );
    // The display contract is unchanged: at most 5 detail objects, and the
    // prose still announces the remainder.
    assert.ok(
      Array.isArray(out.items && out.items.todos),
      'todos detail list present',
    );
    const detailFiles = out.items.todos.filter((i) => i && i.filename);
    assert.ok(detailFiles.length <= 5, `display stays truncated; got ${detailFiles.length}`);
  });

  test('#3817 boundary: exactly 5 files → no marker, counts exact; 6 files → remainder 1', (t) => {
    const tmpDir = createTempProject('gsd-3817-boundary-');
    t.after(() => cleanup(tmpDir));
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const seed = (n) => fs.writeFileSync(path.join(pendingDir, `todo-${n}.md`), [
      '---',
      'title: T ' + n,
      'area: general',
      'created: 2026-08-01',
      '---',
      '',
      'Body',
      '',
    ].join('\n'));

    for (let i = 1; i <= 5; i++) seed(i);
    let out = runAuditOpen(tmpDir);
    assert.equal(out.counts.todos, 5, 'exactly at the cap: no marker, count exact');
    const markers5 = (out.items.todos || []).filter((i) => i && typeof i._remainder_count === 'number');
    assert.equal(markers5.length, 0, 'no marker emitted at exactly 5');

    seed(6);
    out = runAuditOpen(tmpDir);
    assert.equal(out.counts.todos, 6, 'one past the cap: remainder 1 counted');
    const marker = (out.items.todos || []).find((i) => i && typeof i._remainder_count === 'number');
    assert.ok(marker, 'marker present at 6');
    assert.equal(marker._remainder_count, 1, 'marker records exactly the dropped count');
  });

  test('#3817 control: 5 or fewer todo files → counts unchanged', (t) => {
    const tmpDir = createTempProject('gsd-3817-few-');
    t.after(() => cleanup(tmpDir));
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(pendingDir, `todo-${i}.md`), [
        '---',
        'title: T ' + i,
        'area: general',
        'created: 2026-08-01',
        '---',
        '',
        'Body',
        '',
      ].join('\n'));
    }

    const out = runAuditOpen(tmpDir);
    assert.equal(out.counts.todos, 3, 'no truncation → counts exact');
    assert.equal(out.counts.total, 3);
  });
});
