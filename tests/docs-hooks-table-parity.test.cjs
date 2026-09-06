// allow-test-rule: source-text-is-the-product (#3839)
// Reads the docs hook tables and the hook-surface source whose registrations
// ARE the deployed contract — asserting the docs rows match the surface.

/**
 * Docs hook-table parity — docs-hooks-table-parity.test.cjs
 *
 * #3839: the shipped hook tables documented `gsd-validate-commit.sh` as
 * PostToolUse when it is registered PreToolUse (a PreToolUse hook BLOCKS a
 * commit via exit 2; a PostToolUse hook cannot — the documented event
 * misdescribes the hook's entire contract). The same scan found
 * `gsd-session-state.sh` documented PostToolUse while registered
 * SessionStart. Nine files carried the wrong rows (ARCHITECTURE.md +
 * INVENTORY.md × en, ja-JP, zh-CN, ko-KR, pt-BR).
 *
 * Truth source: the literal hook-spec array in `buildKimiHooksTomlBlock`
 * (src/runtime-hooks-surface.cts) — its own comment pins the invariant
 * "mirrors applySettingsJsonHooks' settings.json wiring 1:1" — unioned with
 * literal-event probe lines (`settings.hooks.<Event>.some(…
 * referencesHook(…, 'gsd-…'))`). Registrations written through the
 * runtime-resolved variables (`preToolEvent`/`postToolEvent`) are NOT
 * statically parseable and are covered only via the mirror invariant; hooks
 * registered on other surfaces (statusline, plugin-surface) are out of
 * scope. Docs rows are exempt when their Event cell is not exactly one
 * registered event (multi-event `A` / `B` cells, `statusLine`, `(helper)`,
 * host-native names) — note docs/how-to/install-on-your-runtime.md also
 * documents these mappings in transposed event-first tables, which this
 * hook-first row parser intentionally does not read.
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
  'docs/ja-JP/ARCHITECTURE.md',
  'docs/ja-JP/INVENTORY.md',
  'docs/zh-CN/ARCHITECTURE.md',
  'docs/zh-CN/INVENTORY.md',
  'docs/ko-KR/ARCHITECTURE.md',
  'docs/ko-KR/INVENTORY.md',
  'docs/pt-BR/ARCHITECTURE.md',
  'docs/pt-BR/INVENTORY.md',
];

// The exact basename set the surface parser must resolve. If a registration
// disappears or the parser drifts, this pin fails instead of the parity
// checks silently narrowing to a subset.
const EXPECTED_SURFACE_HOOKS = [
  'gsd-agent-isolation-guard.js',
  'gsd-check-update.js',
  'gsd-config-reload.js',
  'gsd-context-monitor.js',
  'gsd-graphify-update.sh',
  'gsd-phase-boundary.sh',
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-secret-read-guard.js',
  'gsd-session-state.sh',
  'gsd-validate-commit.sh',
  'gsd-workflow-guard.js',
  'gsd-worktree-path-guard.js',
  'gsd-write-guard.js',
];

/** hook basename → Set of events it is registered under on this surface. */
function registeredHookEvents() {
  const src = fs.readFileSync(SURFACE_PATH, 'utf8');
  const map = new Map();
  // Probe lines name hooks WITHOUT file extensions (`'gsd-session-state'`).
  // Resolve a bare name against the actual hooks/ directory (the file's
  // extension is ground truth) so both spellings resolve to one entry.
  const resolveBase = (name) => {
    if (/\.(sh|js|cmd)$/.test(name)) return name;
    for (const ext of ['.js', '.sh', '.cmd']) {
      if (fs.existsSync(path.join(ROOT, 'hooks', `${name}${ext}`))) return `${name}${ext}`;
    }
    return name; // no file twin (e.g. a name never documented in docs tables)
  };
  const add = (base, event) => {
    const key = resolveBase(base);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(event);
  };
  let m;
  // Literal hook-spec array (the Kimi mirror of the settings.json wiring).
  const specRe = /event:\s*'([A-Za-z]+)',\s*command:\s*cmd\('([^']+)'\)/g;
  // allow-test-rule: source-text-is-the-product (#3839)
  while ((m = specRe.exec(src)) !== null) add(path.basename(m[2]), m[1]);
  // Probe lines paired with a literal event:
  // settings.hooks.<Event>.some(… referencesHook(…, '<name>'))
  const probeRe = /settings\.hooks\.([A-Za-z]+)\.some\(\(entry: HookGroup\) =>\s*\n\s*entry\.hooks && entry\.hooks\.some\(\(h: HookEntry\) => referencesHook\(h as Record<string, unknown>, '([^']+)'\)/g;
  // allow-test-rule: source-text-is-the-product (#3839)
  while ((m = probeRe.exec(src)) !== null) add(m[2], m[1]);
  // Probe lines paired with the runtime-resolved variables — statically
  // resolved to their non-Gemini canonical events (docs document the
  // canonical Claude/GS wiring; BeforeTool/AfterTool are the Gemini twins):
  // const preToolEvent = hookEvents === 'gemini' ? 'BeforeTool' : 'PreToolUse'
  const dynRe = /settings\.hooks\[(preToolEvent|postToolEvent)\]\.some\(\(entry: HookGroup\) =>\s*\n\s*entry\.hooks && entry\.hooks\.some\(\(h: HookEntry\) => referencesHook\(h as Record<string, unknown>, '([^']+)'\)/g;
  // allow-test-rule: source-text-is-the-product (#3839)
  while ((m = dynRe.exec(src)) !== null) add(m[2], m[1] === 'preToolEvent' ? 'PreToolUse' : 'PostToolUse');
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

  test('surface parser resolves the exact expected hook set (no silent drift)', () => {
    const withExt = [...surface.keys()].filter((k) => /\.(sh|js|cmd)$/.test(k)).sort();
    assert.deepEqual(
      withExt,
      [...EXPECTED_SURFACE_HOOKS].sort(),
      'parser must resolve exactly the expected surface registrations'
    );
  });

  for (const doc of DOC_TABLES) {
    test(`${doc}: every single-event hook row matches the surface`, () => {
      const rows = docHookRows(doc);
      assert.ok(rows.length >= 3, `${doc}: hook-table parser found rows (guard against silent table drift)`);
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
    // ja-JP/ARCHITECTURE.md's hook table is a shorter translation that never
    // listed these two hooks — it stays in the parity loop above but not here.
    const PINNED = DOC_TABLES.filter((d) => d !== 'docs/ja-JP/ARCHITECTURE.md');
    for (const doc of PINNED) {
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
