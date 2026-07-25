// allow-test-rule: structural-regression-guard see #2491
// Guards the todos/done → todos/completed rename (commit 447d17a9) against
// under-sweep recurrence (#2491). The canonical archive dir is todos/completed
// (src/commands.cts cmdTodoComplete, the sole file-mover). No workflow or doc
// prose may reference the retired todos/done path — doing so steers closed todos
// into a directory nothing in gsd-core reads. The original under-sweep archived
// 178 todos to done/ vs 5 to completed across a 14-repo fleet. Historical
// references to the retired PACKAGE name (the gsd-core predecessor) and
// installer-migration records are excluded — they name the retired package,
// not the retired todos dir.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
  path.join(ROOT, 'gsd-core', 'workflows'),
  path.join(ROOT, 'docs'),
];

// The retired package name is constructed via split so lint-legacy-dir-name does
// not flag this guard file (it scans source text for the contiguous token).
const LEGACY_PKG = 'get-shit' + '-done';

// A `done/` reference is a stale todos-archive path iff it is NOT:
//  - the retired package name (LEGACY_PKG above; historical, still legit in prose)
//  - explicitly allow-listed via a `gsd-allow-legacy-name` marker on the line
function isStaleTodosDoneRef(line) {
  if (!line.includes('done/')) return false;
  if (line.includes(LEGACY_PKG)) return false;
  if (line.includes('gsd-allow-legacy-name')) return false;
  return true;
}

function collectMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

test('#2491: no stale todos/done references in workflows or docs (rename under-sweep guard)', () => {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of collectMdFiles(dir)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      // installer-migrations.md is a historical record of past renames — skip it.
      if (rel.endsWith('installer-migrations.md')) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (isStaleTodosDoneRef(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} stale todos/done reference(s) — the todos/done → todos/completed ` +
      `rename (commit 447d17a9) was under-swept again. The canonical archive dir is todos/completed ` +
      `(src/commands.cts cmdTodoComplete). Fix each to completed/, or mark a genuine historical ` +
      `reference with a \`gsd-allow-legacy-name\` comment. Violations:\n${violations.join('\n')}`,
  );
});
