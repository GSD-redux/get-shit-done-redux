// allow-test-rule: source-text-is-the-product
// Reads the docs hook tables and the hook-surface source whose registrations
// ARE the deployed contract — asserting the docs rows match the surface.

/**
 * Docs hook-table parity — docs-hooks-table-parity.test.cjs
 *
 * #3839: docs/ARCHITECTURE.md and the three INVENTORY.md locales listed
 * `gsd-validate-commit.sh` as PostToolUse when it is registered PreToolUse
 * (a PreToolUse hook BLOCKS a commit via exit 2; a PostToolUse hook cannot —
 * the documented event misdescribes the hook's entire contract). The same
 * scan found `gsd-session-state.sh` documented PostToolUse while registered
 * SessionStart.
 *
 * This suite parses the authoritative registrations out of
 * src/runtime-hooks-surface.cts and requires every docs hook-table row whose
 * Event cell names exactly one registered event to match the surface. Rows
 * with multi-event cells (`PostToolUse` / `AfterTool`), non-event cells
 * (`statusLine`, `(helper)`, host-native names like Cursor `subagentStop`),
 * and hooks not registered on this surface are out of scope.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SURFACE_PATH = path.join(ROOT, 'src', 'runtime-hooks-surface.cts');

const DOC_TABLES = [
  'docs/ARCHITECTURE.md',
  'docs/INVENTORY.md',
  'docs/ja-JP/INVENTORY.md',
  'docs/zh-CN/INVENTORY.md',
];

/** hook basename → Set of events it is registered under on this surface. */
function registeredHookEvents() {
  const src = fs.readFileSync(SURFACE_PATH, 'utf8');
  const map = new Map();
  const re = /event:\s*'([A-Za-z]+)',\s*command:\s*cmd\('([^']+)'\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const base = path.basename(m[2]);
    if (!map.has(base)) map.set(base, new Set());
    map.get(base).add(m[1]);
  }
  return map;
}

/** Hook-table rows: [basename, eventCell] for `gsd-*` hooks. */
function docHookRows(docPath) {
  const lines = fs.readFileSync(path.join(ROOT, docPath), 'utf8').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^\|\s*`?(gsd-[a-z0-9-]+\.(?:sh|js|cmd))`?\s*\|\s*`([^`]+)`\s*\|/);
    if (m) rows.push([m[1], m[2]]);
  }
  return rows;
}

// Cells that are not a single surface event: multi-event (`A` / `B`),
// non-event identifiers (statusLine, host-native names), or placeholders.
const SINGLE_EVENT_CELL = /^[A-Z][A-Za-z]+$/;

describe('docs hook tables match runtime-hooks-surface registrations', () => {
  const surface = registeredHookEvents();
  assert.ok(surface.size >= 10, 'surface parser found the registrations (guard against silent regex drift)');

  for (const doc of DOC_TABLES) {
    test(`${doc}: every single-event hook row matches the surface`, () => {
      const rows = docHookRows(doc);
      assert.ok(rows.length >= 5, `${doc}: hook-table parser found rows (guard against silent table drift)`);
      const mismatches = [];
      for (const [base, cell] of rows) {
        const events = surface.get(base);
        if (!events) continue; // not registered on this surface (statusline, plugin-surface hooks…)
        if (!SINGLE_EVENT_CELL.test(cell)) continue; // multi-event or non-event cell
        if (!events.has(cell)) {
          mismatches.push(`${base}: docs say \`${cell}\`, surface registers ${[...events].join(', ')}`);
        }
      }
      assert.deepEqual(mismatches, [], `docs rows must match src/runtime-hooks-surface.cts (#3839)`);
    });
  }

  test('#3839 regression pin: the two misdocumented hooks are asserted directly', () => {
    assert.ok(surface.get('gsd-validate-commit.sh').has('PreToolUse'),
      'gsd-validate-commit.sh blocks commits — must stay PreToolUse on the surface');
    assert.ok(surface.get('gsd-session-state.sh').has('SessionStart'),
      'gsd-session-state.sh orients the session — must stay SessionStart on the surface');
    for (const doc of DOC_TABLES) {
      const rows = docHookRows(doc);
      const vc = rows.find(([b]) => b === 'gsd-validate-commit.sh');
      assert.ok(vc, `${doc}: validate-commit row present`);
      assert.equal(vc[1], 'PreToolUse', `${doc}: validate-commit documented as PreToolUse`);
      const ss = rows.find(([b]) => b === 'gsd-session-state.sh');
      assert.ok(ss, `${doc}: session-state row present`);
      assert.equal(ss[1], 'SessionStart', `${doc}: session-state documented as SessionStart`);
    }
  });
});
