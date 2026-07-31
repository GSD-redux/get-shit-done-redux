// allow-test-rule: source-text-is-the-product #2304 — this test's whole job is
// scanning hooks/*.js source text for the inlined KIMI_TOOL_NAMES copies; the
// text IS the artifact under test (the copies have no runtime binding).
/**
 * Kimi guard-normalization parity test (#2304 / PR #2326 review Major 1).
 *
 * The KIMI_TOOL_NAMES map + normalizeKimiPayload helper is deliberately
 * inlined per hook script (a sibling require is a staging dependency that
 * can fail silently — see the rationale comment in each guard), which
 * leaves five hand-maintained copies plus their inverse in bin/install.js
 * (claudeToKimiTools / convertKimiToolName). Nothing at runtime binds them.
 *
 * This test is that binding, with zero runtime coupling:
 *   1. the five inlined copies are byte-identical;
 *   2. every entry in the guard map is the value-inverse of what the
 *      installer's matcher vocabulary emits for that Claude tool;
 *   3. every guard-relevant Claude tool the installer translates has a
 *      reverse entry — so a vocabulary extension or rename that updates
 *      convertKimiToolName without updating the guards fails HERE instead
 *      of leaving a guard silently dormant (the #2304 failure mode).
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { convertKimiToolName } = require('../bin/install.js');

// Enumerated by scanning, never hardcoded: a sixth guard added later with its
// own copy of the block must be swept in automatically, or the copies diverge
// exactly the way this test exists to prevent (PR #2326 review M2). The
// dynamic scan is also what makes the no-shared-module decision safe.
const KIMI_MARKER = 'const KIMI_TOOL_NAMES';
const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const HOOK_FILES = fs
  .readdirSync(HOOKS_DIR)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8').includes(KIMI_MARKER))
  .map((f) => `hooks/${f}`)
  .sort();

// The five guards normalized for #2304. A scan that misses one of these is a
// broken scan, not a passing test — without this floor, an over-narrow filter
// would "pass" by finding nothing to check.
const KNOWN_NORMALIZED_GUARDS = [
  'hooks/gsd-prompt-guard.js',
  'hooks/gsd-read-guard.js',
  'hooks/gsd-read-injection-scanner.js',
  'hooks/gsd-workflow-guard.js',
  'hooks/gsd-worktree-path-guard.js',
];

// Claude tool names whose PreToolUse/PostToolUse guards are registered with a
// translated matcher on Kimi (runtime-hooks-surface.cts buildKimiHooksTomlBlock):
// the write guards match WriteFile|StrReplaceFile, the injection scanner
// matches ReadFile, and gsd-workflow-guard.js matches Shell|WriteFile|StrReplaceFile.
const GUARD_RELEVANT_CLAUDE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'Read', 'Bash'];

function extractBlock(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = src.indexOf('const KIMI_TOOL_NAMES');
  assert.notEqual(start, -1, `${file}: KIMI_TOOL_NAMES block not found`);
  const endMarker = '  return data;\n}';
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${file}: normalizeKimiPayload end not found`);
  return src.slice(start, end + endMarker.length);
}

function parseMap(block) {
  // The guards declare `new Map([['KimiName', 'ClaudeName'], …])` (a Map so
  // prototype keys resolve to undefined — review M1); parse the pair list.
  const m = block.match(/const KIMI_TOOL_NAMES = new Map\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'KIMI_TOOL_NAMES Map literal not parseable');
  const entries = {};
  for (const kv of m[1].matchAll(/\['(\w+)', '(\w+)'\]/g)) {
    entries[kv[1]] = kv[2];
  }
  assert.ok(Object.keys(entries).length > 0, 'KIMI_TOOL_NAMES parsed empty');
  return entries;
}

describe('Kimi guard normalization parity', () => {
  test('the scan finds every known normalized guard (floor — a scan that finds nothing must fail)', () => {
    for (const known of KNOWN_NORMALIZED_GUARDS) {
      assert.ok(
        HOOK_FILES.includes(known),
        `${known} carries no '${KIMI_MARKER}' block — either its normalization ` +
          'was removed or the scan filter broke; both mean lost coverage'
      );
    }
  });

  test('all inlined copies of the normalization block are byte-identical', () => {
    const blocks = HOOK_FILES.map(extractBlock);
    for (let i = 1; i < blocks.length; i++) {
      assert.equal(
        blocks[i],
        blocks[0],
        `${HOOK_FILES[i]} normalization block diverges from ${HOOK_FILES[0]}`
      );
    }
  });

  test('guard map is the value-inverse of the installer matcher vocabulary', () => {
    const map = parseMap(extractBlock(HOOK_FILES[0]));
    for (const [kimiName, claudeName] of Object.entries(map)) {
      const modulePath = convertKimiToolName(claudeName);
      assert.ok(
        typeof modulePath === 'string' && modulePath.endsWith(`:${kimiName}`),
        `KIMI_TOOL_NAMES.${kimiName} -> '${claudeName}' is not the inverse of ` +
          `convertKimiToolName('${claudeName}') = ${modulePath}`
      );
    }
  });

  test('every guard-relevant Claude tool has a reverse entry (dormancy alarm)', () => {
    const map = parseMap(extractBlock(HOOK_FILES[0]));
    for (const claudeName of GUARD_RELEVANT_CLAUDE_TOOLS) {
      const modulePath = convertKimiToolName(claudeName);
      assert.ok(modulePath, `installer no longer maps ${claudeName} — update this test`);
      const kimiName = modulePath.slice(modulePath.lastIndexOf(':') + 1);
      assert.ok(
        map[kimiName] !== undefined,
        `Kimi name '${kimiName}' (from ${claudeName}) has no KIMI_TOOL_NAMES ` +
          `reverse entry — the matching guard would be silently dormant on Kimi (#2304)`
      );
    }
  });
});

// The two shell guards (gsd-graphify-update.sh, gsd-phase-boundary.sh) carry
// the same #2304 normalization reimplemented in shell — a byte-identity
// assertion cannot span the JS↔shell boundary, so instead of faking one this
// block pins the two vocabulary facts each script depends on to the
// installer's live mapping. Behavior is covered by negative-controlled tests
// beside each hook's existing suite (graphify-auto-update.slow.test.cjs,
// hooks-opt-in.test.cjs); this block is only the vocabulary-drift alarm
// (a convertKimiToolName rename fails HERE).
describe('Kimi shell-guard vocabulary parity (#2304)', () => {
  const readHook = (file) =>
    fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  test('gsd-graphify-update.sh maps the installer\'s Bash vocabulary back to Bash', () => {
    const modulePath = convertKimiToolName('Bash');
    assert.ok(modulePath, 'installer no longer maps Bash — update this test');
    const kimiName = modulePath.slice(modulePath.lastIndexOf(':') + 1);
    const src = readHook('hooks/gsd-graphify-update.sh');
    assert.ok(
      src.includes('TOOL_NAME="${TOOL_NAME##*:}"'),
      'gsd-graphify-update.sh no longer strips the Kimi module-path prefix'
    );
    assert.ok(
      src.includes(`[ "$TOOL_NAME" = "${kimiName}" ]`) && src.includes('TOOL_NAME="Bash"'),
      `gsd-graphify-update.sh no longer maps Kimi '${kimiName}' to Bash — ` +
        'the hook is silently dormant on Kimi (#2304)'
    );
  });

  test('gsd-phase-boundary.sh prefers Kimi\'s authoritative tool_input.path, falls back to file_path (#2752)', () => {
    const src = readHook('hooks/gsd-phase-boundary.sh');
    assert.ok(
      src.includes('(typeof i.path===\'string\'&&i.path)||(typeof i.file_path===\'string\'&&i.file_path)||\'\''),
      'gsd-phase-boundary.sh no longer prefers tool_input.path over file_path — ' +
        'path is the authoritative field (kimi-cli executes on it); a model-supplied ' +
        'decoy file_path must not suppress or fabricate a reminder (#2752, mirrors #2595)'
    );
  });
});
