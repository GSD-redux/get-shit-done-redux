'use strict';

/**
 * cursor hook-bus UPGRADE — ADR-1239 / #2089 AC4a.
 *
 * Proves the expanded hook-bus coverage: GSD registers for subagentStart,
 * subagentStop, preToolUse, and stop IN ADDITION to the baseline sessionStart
 * and postToolUse. Cite: https://cursor.com/docs/hooks
 *
 * Tests the descriptor-driven adapter module (pure) + the reconcile behavior
 * (all 6 managed events in the generated hooks.json).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  CURSOR_HOOK_EVENTS,
  CURSOR_EVENT_SCRIPT_MAP,
  resolveManagedHookEvents,
  resolveHookScripts,
} = require('../gsd-core/bin/lib/host-integration-adapters/imperative-hook-bus.cjs');

const {
  GSD_CURSOR_HOOK_MARKER,
} = require('../bin/install.js');

const {
  reconcileCursorHooksJson,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

const { cleanup } = require('./helpers.cjs');

const CUR_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'cursor', 'capability.json'), 'utf8'),
);

const EXPECTED_EVENTS = [
  'sessionStart',
  'postToolUse',
  'preToolUse',
  'stop',
  'subagentStart',
  'subagentStop',
];

// -- AC4a: the adapter declares all 6 managed events -------------------------

test('CURSOR_HOOK_EVENTS contains all 6 managed events', () => {
  for (const ev of EXPECTED_EVENTS) {
    assert.ok(CURSOR_HOOK_EVENTS.includes(ev),
      `CURSOR_HOOK_EVENTS must include ${ev}`);
  }
  assert.equal(CURSOR_HOOK_EVENTS.length, 6,
    'exactly 6 managed events (no extras)');
});

test('CURSOR_EVENT_SCRIPT_MAP maps every event to a script', () => {
  for (const ev of EXPECTED_EVENTS) {
    const script = CURSOR_EVENT_SCRIPT_MAP[ev];
    assert.ok(typeof script === 'string' && script.endsWith('.js'),
      `${ev} must map to a .js script, got: ${script}`);
  }
});

test('descriptor managedHookEvents matches the adapter event list', () => {
  const declared = CUR_CAP.runtime.hostBehaviors.managedHookEvents;
  assert.deepEqual(declared.sort(), [...EXPECTED_EVENTS].sort(),
    'descriptor managedHookEvents must match the 6-event managed set');
});

// -- AC4a: resolveManagedHookEvents + resolveHookScripts ---------------------

test('resolveManagedHookEvents returns all 6 from the descriptor list', () => {
  const resolved = resolveManagedHookEvents(CUR_CAP.runtime.hostBehaviors.managedHookEvents);
  assert.equal(resolved.length, 6);
  for (const ev of EXPECTED_EVENTS) {
    assert.ok(resolved.includes(ev), `resolveManagedHookEvents must include ${ev}`);
  }
});

test('resolveManagedHookEvents filters unknown events (fail-closed)', () => {
  const resolved = resolveManagedHookEvents(['sessionStart', 'bogusEvent', 'stop']);
  assert.deepEqual([...resolved].sort(), ['sessionStart', 'stop']);
});

test('resolveManagedHookEvents falls back to full set when descriptor is empty', () => {
  const resolved = resolveManagedHookEvents(null);
  assert.equal(resolved.length, 6);
});

test('resolveHookScripts returns a script for every managed event', () => {
  const scripts = resolveHookScripts(EXPECTED_EVENTS);
  assert.equal(scripts.length, 6);
  for (const s of scripts) {
    assert.ok(s.startsWith('gsd-cursor-') && s.endsWith('.js'),
      `script must follow gsd-cursor-*.js convention: ${s}`);
  }
});

// -- AC4a: hook scripts exist on disk ---------------------------------------

test('all 6 hook scripts exist under hooks/', () => {
  for (const ev of EXPECTED_EVENTS) {
    const script = CURSOR_EVENT_SCRIPT_MAP[ev];
    const scriptPath = path.join(__dirname, '..', 'hooks', script);
    assert.ok(fs.existsSync(scriptPath),
      `hook script must exist: hooks/${script} (event: ${ev})`);
  }
});

// -- AC4a: reconcile generates hooks.json with all 6 events ------------------

test('reconcileCursorHooksJson writes all 6 managed events into hooks.json', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cursor-hook-bus-'));
  t.after(() => cleanup(tmpDir));
  const hooksJsonPath = path.join(tmpDir, 'hooks.json');
  const managedEntries = {};
  for (const ev of EXPECTED_EVENTS) {
    managedEntries[ev] = {
      type: 'command',
      command: `node /fake/${ev}.js`,
      [GSD_CURSOR_HOOK_MARKER]: true,
    };
  }
  const result = reconcileCursorHooksJson(hooksJsonPath, managedEntries);
  assert.ok(result.changed, 'first write must report changed=true');

  const written = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const hookTable = written.hooks;
  assert.ok(hookTable && typeof hookTable === 'object');
  for (const ev of EXPECTED_EVENTS) {
    assert.ok(Array.isArray(hookTable[ev]),
      `hooks.json must have a ${ev} array`);
    assert.equal(hookTable[ev].length, 1,
      `${ev} must have exactly 1 managed entry`);
    assert.equal(hookTable[ev][0][GSD_CURSOR_HOOK_MARKER], true,
      `${ev} entry must carry the GSD managed marker`);
  }
});

test('reconcileCursorHooksJson preserves user entries across all 6 events', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cursor-hook-bus-'));
  t.after(() => cleanup(tmpDir));
  const hooksJsonPath = path.join(tmpDir, 'hooks.json');
  // Seed with user-owned entries in two events.
  const seed = {
    version: 1,
    hooks: {
      sessionStart: [{ type: 'command', command: 'user-start.sh' }],
      preToolUse: [{ type: 'command', command: 'user-pre.sh' }],
    },
  };
  fs.writeFileSync(hooksJsonPath, JSON.stringify(seed, null, 2) + '\n');

  const managedEntries = {};
  for (const ev of EXPECTED_EVENTS) {
    managedEntries[ev] = {
      type: 'command',
      command: `node /gsd/${ev}.js`,
      [GSD_CURSOR_HOOK_MARKER]: true,
    };
  }
  reconcileCursorHooksJson(hooksJsonPath, managedEntries);

  const written = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  // sessionStart: 1 user + 1 managed
  assert.equal(written.hooks.sessionStart.length, 2);
  // preToolUse: 1 user + 1 managed
  assert.equal(written.hooks.preToolUse.length, 2);
  // postToolUse: 1 managed only
  assert.equal(written.hooks.postToolUse.length, 1);
});
