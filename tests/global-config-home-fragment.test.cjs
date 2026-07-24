'use strict';
/**
 * Drift-guard + collapse: getGlobalConfigHomeFragment must be the SINGLE source
 * of truth for the runtime → global config-home path-fragment mapping used by
 * `getConfigDirFromHome` in bin/install.js for hook path.join() codegen.
 *
 * Collapses the prior branch `if (runtime === 'x') return "'...'"` chain
 * (install.js ~514-543) into one table — ADR-1239 Phase B / #1679, AC2 slice 2.
 *
 * Invariants pinned here:
 *   1. Each of the 13 table runtimes returns its exact verbatim source fragment
 *      (byte-identical to the prior chain — golden install parity asserts the
 *      generated hook output is unchanged).
 *   2. claude + unknown + empty fall back to the default "'.claude'" fragment.
 *   3. antigravity is intentionally NOT in the table (handled dynamically by the
 *      caller via resolveAntigravityGlobalDir).
 *   4. Drift guard: every registry runtime EXCEPT {claude, antigravity} has a
 *      table entry — so adding a runtime forces a deliberate fragment decision
 *      here (the add-a-host tax this collapse removes).
 *
 * ADR-1239 Phase B (#1679). Behavioral tests only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const { getGlobalConfigHomeFragment } = runtimeNamePolicy;

// Golden oracle: the exact source-string fragments the prior install.js chain
// emitted, preserved verbatim. These are path.join() arg-source snippets (the
// embedded quotes/commas are intentional — they get spliced into generated hook
// scripts). Pinned here as the test oracle.
const GOLDEN_FRAGMENT_MAP = {
  copilot:   "'.copilot'",
  opencode:  "'.config', 'opencode'",
  kilo:      "'.config', 'kilo'",
  codex:     "'.codex'",
  cursor:    "'.cursor'",
  windsurf:  "'.windsurf'",
  augment:   "'.augment'",
  trae:      "'.trae'",
  qwen:      "'.qwen'",
  qoder:     "'.qoder'",
  hermes:    "'.hermes'",
  codebuddy: "'.codebuddy'",
  cline:     "'.cline'",
  kimi:      "'.config', 'agents'",
  'kimi-code': "'.kimi-code'",
  zcode:     "'.zcode'",
  pi:        "'.pi', 'agent'",
};

// Runtimes intentionally NOT in the table: claude is the default; antigravity is
// resolved dynamically by the caller (resolveAntigravityGlobalDir + path.relative);
// vscode (#2103) is extension-distributed with no file-projected config home at
// all — getGlobalConfigHomeFragment is never invoked for it (no install surface).
const SPECIAL_CASED = new Set(['claude', 'antigravity', 'vscode']);

test('getGlobalConfigHomeFragment: golden map matches for all 14 table runtimes', () => {
  for (const [id, expected] of Object.entries(GOLDEN_FRAGMENT_MAP)) {
    const actual = getGlobalConfigHomeFragment(id);
    assert.strictEqual(
      actual,
      expected,
      `getGlobalConfigHomeFragment('${id}') diverged from golden.\n` +
      `  actual:   ${JSON.stringify(actual)}\n` +
      `  expected: ${JSON.stringify(expected)}`,
    );
  }
});

test('getGlobalConfigHomeFragment fallback: claude/unknown/empty return the default fragment', () => {
  assert.strictEqual(getGlobalConfigHomeFragment('claude'), "'.claude'",
    'claude must return the default fragment (it is special-cased as the default)');
  assert.strictEqual(getGlobalConfigHomeFragment('unknown'), "'.claude'",
    'unknown runtime must return the default fragment');
  assert.strictEqual(getGlobalConfigHomeFragment(''), "'.claude'",
    'empty input must return the default fragment');
});

test('drift guard: every registry runtime except {claude, antigravity} has a table entry (add-a-host tax removed)', () => {
  // A newly-added registry runtime that is NOT claude/antigravity MUST get a
  // deliberate fragment entry here — otherwise it silently falls through to the
  // '.claude' default. claude (default) and antigravity (caller-dynamic) are the
  // only legitimate absences.
  const tableIds = new Set(Object.keys(GOLDEN_FRAGMENT_MAP));
  const missing = Object.keys(registry.runtimes)
    .filter((id) => !SPECIAL_CASED.has(id) && !tableIds.has(id));
  assert.deepEqual(missing, [],
    `registry runtimes missing a fragment table entry (add one to GOLDEN_FRAGMENT_MAP + the module table, or add to SPECIAL_CASED if caller-dynamic): ${missing.join(', ')}`);
});

test('drift guard: table keys are a subset of the registry (no stale entries)', () => {
  const registryIds = new Set(Object.keys(registry.runtimes));
  const stale = Object.keys(GOLDEN_FRAGMENT_MAP).filter((id) => !registryIds.has(id));
  assert.deepEqual(stale, [],
    `fragment table references runtimes not in the registry (stale entries): ${stale.join(', ')}`);
});
