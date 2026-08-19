/**
 * Tests for Cursor hooks.json lifecycle hook registration (issue #777).
 *
 * Cursor v2.4+ supports a hooks.json system with events including sessionStart
 * and postToolUse. GSD registers two managed command hooks so Cursor users get
 * baseline parity with Claude Code and Gemini.
 *
 * Test plan:
 *   T1  reconcileCursorHooksJson — creates new hooks.json with both events
 *   T2  reconcileCursorHooksJson — idempotent (re-run writes same content)
 *   T3  reconcileCursorHooksJson — preserves user-owned entries in sessionStart
 *   T4  reconcileCursorHooksJson — preserves user-owned entries in postToolUse
 *   T5  reconcileCursorHooksJson — remove-only (managedEntries=null) strips managed, keeps user
 *   T6  reconcileCursorHooksJson — handles nested { version, hooks: {...} } shape
 *   T7  reconcileCursorHooksJson — handles flat (no version) shape
 *   T8  reconcileCursorHooksJson — corrupted JSON throws descriptive error
 *   T9  isManagedCursorHookEntry — returns true for GSD-marked entries
 *   T10 isManagedCursorHookEntry — returns false for user entries
 *   T11 buildCursorHookEntry     — emits correct shape with marker
 *   T12 removeCursorHooksJson    — removes hooks.json when it becomes empty
 *   T13 removeCursorHooksJson    — preserves file when user entries remain
 *   T14 runtime-config-adapter   — cursor now has 'cursor-hooks-json' surface
 *   T15 INSTALL_SURFACES         — 'cursor-hooks-json' in the valid surfaces list
 *   T16 Hook scripts exist in hooks/
 *   T17 Hook script content — sessionStart script emits JSON with additional_context
 *   T18 Hook script content — postToolUse script emits JSON {} for non-write tools
 *   T19 GSD_CURSOR_HOOK_MARKER constant is exported
 *   T20 GSD_CURSOR_SESSION_HOOK_SCRIPT / GSD_CURSOR_POST_TOOL_HOOK_SCRIPT constants
 */

// allow-test-rule: source-text-is-the-product
// Hook script text IS what Cursor loads. Testing script content tests the deployed contract.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  GSD_CURSOR_HOOK_MARKER,
  GSD_CURSOR_SESSION_HOOK_SCRIPT,
  GSD_CURSOR_POST_TOOL_HOOK_SCRIPT,
} = require('../bin/install.js');

const {
  reconcileCursorHooksJson,
  isManagedCursorHookEntry,
  buildCursorHookEntry,
  removeCursorHooksJson,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

const {
  resolveRuntimeConfigIntent,
  INSTALL_SURFACES,
} = require('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHooksJson(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function readHooksJson(dir) {
  const p = path.join(dir, 'hooks.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function managedEntry(command) {
  return { type: 'command', command, [GSD_CURSOR_HOOK_MARKER]: true };
}

function userEntry(command) {
  return { type: 'command', command };
}

// ---------------------------------------------------------------------------
// T1: Creates new hooks.json with both events
// ---------------------------------------------------------------------------
describe('reconcileCursorHooksJson', () => {
  test('T1: creates new hooks.json with sessionStart and postToolUse', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    const result = reconcileCursorHooksJson(hooksJsonPath, {
      sessionStart: managedEntry('/node /path/gsd-cursor-session-start.js'),
      postToolUse:  managedEntry('/node /path/gsd-cursor-post-tool.js'),
    });

    assert.equal(result.wrote, true);
    assert.equal(result.changed, true);

    const parsed = readHooksJson(dir);
    assert.ok(parsed, 'hooks.json must exist');

    // Cursor requires the canonical nested { "version": 1, "hooks": { ... } } shape.
    assert.equal(parsed.version, 1, 'hooks.json must have version: 1');
    assert.ok(parsed.hooks && typeof parsed.hooks === 'object', 'hooks.json must have top-level hooks object');
    const hookTable = parsed.hooks;
    assert.ok(Array.isArray(hookTable.sessionStart), 'sessionStart must be an array');
    assert.ok(Array.isArray(hookTable.postToolUse), 'postToolUse must be an array');
    assert.equal(hookTable.sessionStart.length, 1);
    assert.equal(hookTable.postToolUse.length, 1);
    assert.equal(hookTable.sessionStart[0][GSD_CURSOR_HOOK_MARKER], true);
    assert.equal(hookTable.postToolUse[0][GSD_CURSOR_HOOK_MARKER], true);
  });

  // ---------------------------------------------------------------------------
  // T2: Idempotent
  // ---------------------------------------------------------------------------
  test('T2: idempotent — second run produces same content (no write)', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    const entries = {
      sessionStart: managedEntry('/node /gsd-cursor-session-start.js'),
      postToolUse:  managedEntry('/node /gsd-cursor-post-tool.js'),
    };

    reconcileCursorHooksJson(hooksJsonPath, entries);
    const result2 = reconcileCursorHooksJson(hooksJsonPath, entries);

    assert.equal(result2.wrote, false, 'second run must not write (idempotent)');
    assert.equal(result2.changed, false, 'content must not change on second run');
  });

  // ---------------------------------------------------------------------------
  // T3: Preserves user-owned entries in sessionStart
  // ---------------------------------------------------------------------------
  test('T3: preserves user-owned entries in sessionStart', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    // Pre-populate with user-owned entry.
    fs.writeFileSync(hooksJsonPath, makeHooksJson({
      version: 1,
      hooks: {
        sessionStart: [userEntry('/my-team/hook.sh')],
      },
    }));

    reconcileCursorHooksJson(hooksJsonPath, {
      sessionStart: managedEntry('/node /gsd-cursor-session-start.js'),
      postToolUse:  managedEntry('/node /gsd-cursor-post-tool.js'),
    });

    const parsed = readHooksJson(dir);
    const hookTable = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : parsed;
    assert.ok(Array.isArray(hookTable.sessionStart));
    // Both user and GSD entries must survive.
    assert.equal(hookTable.sessionStart.length, 2, 'user + GSD entry must coexist');
    const userStays = hookTable.sessionStart.some((e) => e.command === '/my-team/hook.sh');
    const gsdAdded  = hookTable.sessionStart.some((e) => e[GSD_CURSOR_HOOK_MARKER]);
    assert.ok(userStays, 'user-owned entry must be preserved');
    assert.ok(gsdAdded,  'GSD managed entry must be present');
  });

  // ---------------------------------------------------------------------------
  // T4: Preserves user-owned entries in postToolUse
  // ---------------------------------------------------------------------------
  test('T4: preserves user-owned entries in postToolUse', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, makeHooksJson({
      hooks: {
        postToolUse: [userEntry('/user/post-tool.sh')],
      },
    }));

    reconcileCursorHooksJson(hooksJsonPath, {
      sessionStart: managedEntry('/node /gsd-cursor-session-start.js'),
      postToolUse:  managedEntry('/node /gsd-cursor-post-tool.js'),
    });

    const parsed = readHooksJson(dir);
    const hookTable = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : parsed;
    assert.ok(Array.isArray(hookTable.postToolUse));
    assert.equal(hookTable.postToolUse.length, 2);
    assert.ok(hookTable.postToolUse.some((e) => e.command === '/user/post-tool.sh'));
  });

  // ---------------------------------------------------------------------------
  // T5: Remove-only (managedEntries=null) strips managed, keeps user entries
  // ---------------------------------------------------------------------------
  test('T5: remove-only (null managedEntries) strips GSD entries, preserves user', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, makeHooksJson({
      version: 1,
      hooks: {
        sessionStart: [
          userEntry('/user/session.sh'),
          managedEntry('/node /gsd-cursor-session-start.js'),
        ],
        postToolUse: [
          managedEntry('/node /gsd-cursor-post-tool.js'),
        ],
      },
    }));

    reconcileCursorHooksJson(hooksJsonPath, null);

    const parsed = readHooksJson(dir);
    const hookTable = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : parsed;
    // sessionStart user entry survives; postToolUse key should be absent.
    assert.ok(Array.isArray(hookTable.sessionStart), 'sessionStart must remain (user entry)');
    assert.equal(hookTable.sessionStart.length, 1, 'only user entry remains');
    assert.equal(hookTable.sessionStart[0].command, '/user/session.sh');
    assert.equal(hookTable.postToolUse, undefined, 'postToolUse key must be removed (was GSD-only)');
  });

  // ---------------------------------------------------------------------------
  // T6: Handles nested { version, hooks: {...} } shape
  // ---------------------------------------------------------------------------
  test('T6: handles nested { version, hooks } shape', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, makeHooksJson({ version: 1, hooks: {} }));

    reconcileCursorHooksJson(hooksJsonPath, {
      sessionStart: managedEntry('/node /gsd-cursor-session-start.js'),
    });

    const parsed = readHooksJson(dir);
    assert.ok(parsed.hooks, 'top-level hooks key must be preserved');
    assert.equal(parsed.version, 1, 'version must be preserved');
    assert.ok(Array.isArray(parsed.hooks.sessionStart));
  });

  // ---------------------------------------------------------------------------
  // T7: Handles flat (no version) shape
  // ---------------------------------------------------------------------------
  test('T7: handles flat shape (no wrapper object)', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, makeHooksJson({ sessionStart: [] }));

    reconcileCursorHooksJson(hooksJsonPath, {
      sessionStart: managedEntry('/node /gsd-cursor-session-start.js'),
    });

    const parsed = readHooksJson(dir);
    // Flat input is migrated to nested canonical shape: { version: 1, hooks: { ... } }.
    assert.equal(parsed.version, 1, 'migrated flat shape must get version: 1');
    assert.ok(parsed.hooks && typeof parsed.hooks === 'object', 'migrated shape must have hooks object');
    assert.ok(Array.isArray(parsed.hooks.sessionStart), 'sessionStart must be in hooks object after migration');
  });

  // ---------------------------------------------------------------------------
  // T8: Corrupted JSON throws descriptive error
  // ---------------------------------------------------------------------------
  test('T8: throws descriptive error for corrupted hooks.json', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, '{ not valid json }');

    assert.throws(
      () => reconcileCursorHooksJson(hooksJsonPath, { sessionStart: managedEntry('/cmd') }),
      (err) => {
        assert.match(err.message, /Cursor hooks\.json parse failed/i);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// T9-T11: Entry helpers
// ---------------------------------------------------------------------------
describe('isManagedCursorHookEntry / buildCursorHookEntry', () => {
  test('T9: isManagedCursorHookEntry returns true for GSD-marked entry', () => {
    const entry = { type: 'command', command: '/x', [GSD_CURSOR_HOOK_MARKER]: true };
    assert.equal(isManagedCursorHookEntry(entry), true);
  });

  test('T10: isManagedCursorHookEntry returns false for user-owned entry', () => {
    const entry = { type: 'command', command: '/user/hook.sh' };
    assert.equal(isManagedCursorHookEntry(entry), false);
    assert.equal(isManagedCursorHookEntry(null), false);
    assert.equal(isManagedCursorHookEntry({}), false);
  });

  test('T11: buildCursorHookEntry emits correct shape', () => {
    const entry = buildCursorHookEntry('/usr/local/bin/node /path/to/hook.js');
    assert.equal(entry.type, 'command');
    assert.equal(entry[GSD_CURSOR_HOOK_MARKER], true);
    assert.ok(typeof entry.command === 'string');
    // Forward slashes only.
    assert.ok(!entry.command.includes('\\'), 'command must use forward slashes');
  });
});

// ---------------------------------------------------------------------------
// T12-T13: removeCursorHooksJson
// ---------------------------------------------------------------------------
describe('removeCursorHooksJson', () => {
  test('T12: removes hooks.json when it becomes empty after GSD removal', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    // GSD-only file.
    fs.writeFileSync(hooksJsonPath, makeHooksJson({
      version: 1,
      hooks: {
        sessionStart: [managedEntry('/node /gsd-cursor-session-start.js')],
        postToolUse:  [managedEntry('/node /gsd-cursor-post-tool.js')],
      },
    }));

    const result = removeCursorHooksJson(dir);
    assert.equal(result.changed, true);
    // File should be removed (was GSD-only).
    assert.equal(fs.existsSync(hooksJsonPath), false, 'empty hooks.json must be removed');
  });

  test('T13: preserves hooks.json when user entries remain', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));

    const hooksJsonPath = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, makeHooksJson({
      version: 1,
      hooks: {
        sessionStart: [
          managedEntry('/node /gsd-cursor-session-start.js'),
          userEntry('/user/session.sh'),
        ],
      },
    }));

    removeCursorHooksJson(dir);

    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json must remain (user entries present)');
    const parsed = readHooksJson(dir);
    const hookTable = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : parsed;
    assert.equal(hookTable.sessionStart.length, 1);
    assert.equal(hookTable.sessionStart[0].command, '/user/session.sh');
  });
});

// ---------------------------------------------------------------------------
// T14: runtime-config-adapter — cursor now has 'cursor-hooks-json' surface
// ---------------------------------------------------------------------------
test('T14: cursor runtime has installSurface cursor-hooks-json', () => {
  const intent = resolveRuntimeConfigIntent('cursor');
  assert.equal(intent.installSurface, 'cursor-hooks-json');
  assert.equal(intent.writesSharedSettings, false);
  assert.equal(intent.finishPermissionWriter, null);
});

// ---------------------------------------------------------------------------
// T15: INSTALL_SURFACES includes 'cursor-hooks-json'
// ---------------------------------------------------------------------------
test('T15: INSTALL_SURFACES includes cursor-hooks-json', () => {
  assert.ok(
    INSTALL_SURFACES.includes('cursor-hooks-json'),
    "'cursor-hooks-json' must be in INSTALL_SURFACES"
  );
});

// ---------------------------------------------------------------------------
// T16: Hook script files exist in hooks/
// ---------------------------------------------------------------------------
test('T16: Cursor hook script files exist in hooks/', () => {
  const hooksDir = path.join(__dirname, '..', 'hooks');
  const sessionStart = path.join(hooksDir, GSD_CURSOR_SESSION_HOOK_SCRIPT);
  const postTool     = path.join(hooksDir, GSD_CURSOR_POST_TOOL_HOOK_SCRIPT);
  assert.ok(fs.existsSync(sessionStart), `${GSD_CURSOR_SESSION_HOOK_SCRIPT} must exist in hooks/`);
  assert.ok(fs.existsSync(postTool),     `${GSD_CURSOR_POST_TOOL_HOOK_SCRIPT} must exist in hooks/`);
});

// ---------------------------------------------------------------------------
// T17: sessionStart script emits JSON with additional_context on stdin close
// ---------------------------------------------------------------------------
test('T17: gsd-cursor-session-start.js emits JSON with additional_context', (t, done) => {
  const hooksDir = path.join(__dirname, '..', 'hooks');
  const scriptPath = path.join(hooksDir, GSD_CURSOR_SESSION_HOOK_SCRIPT);
  const { execFile } = require('child_process');

  const input = JSON.stringify({ session_id: 'test-123', composer_mode: 'agent' });
  const child = execFile(process.execPath, [scriptPath], {
    timeout: 10000,
    cwd: os.tmpdir(), // no .planning/ dir here — should get MSG_ABSENT
  }, (err, stdout) => {
    if (err && !stdout) { done(err); return; }
    let parsed;
    try { parsed = JSON.parse(stdout); } catch (e) { done(new Error(`stdout not valid JSON: ${stdout}`)); return; }
    assert.ok('additional_context' in parsed, 'output must have additional_context field');
    assert.ok(typeof parsed.additional_context === 'string', 'additional_context must be a string');
    assert.ok(parsed.additional_context.length > 0, 'additional_context must not be empty');
    done();
  });
  child.stdin.write(input);
  child.stdin.end();
});

// ---------------------------------------------------------------------------
// T18: postToolUse script emits {} for non-write tools
// ---------------------------------------------------------------------------
test('T18: gsd-cursor-post-tool.js emits {} for non-write tool names', (t, done) => {
  const hooksDir = path.join(__dirname, '..', 'hooks');
  const scriptPath = path.join(hooksDir, GSD_CURSOR_POST_TOOL_HOOK_SCRIPT);
  const { execFile } = require('child_process');

  const input = JSON.stringify({
    tool_name: 'Read',
    tool_input: { path: '/some/file.js' },
    tool_output: 'contents',
    duration: 42,
  });

  const child = execFile(process.execPath, [scriptPath], {
    timeout: 10000,
    cwd: os.tmpdir(),
  }, (err, stdout) => {
    if (err && !stdout) { done(err); return; }
    let parsed;
    try { parsed = JSON.parse(stdout); } catch (e) { done(new Error(`stdout not valid JSON: ${stdout}`)); return; }
    // Non-write tool → empty response (no additional_context).
    assert.ok(typeof parsed === 'object', 'output must be an object');
    // additional_context should be absent for non-write, non-planning tool.
    assert.equal(parsed.additional_context, undefined, 'no additional_context for non-write tool');
    done();
  });
  child.stdin.write(input);
  child.stdin.end();
});

// ---------------------------------------------------------------------------
// T19: GSD_CURSOR_HOOK_MARKER is exported and is a non-empty string
// ---------------------------------------------------------------------------
test('T19: GSD_CURSOR_HOOK_MARKER is exported and is a non-empty string', () => {
  assert.equal(typeof GSD_CURSOR_HOOK_MARKER, 'string');
  assert.ok(GSD_CURSOR_HOOK_MARKER.length > 0);
});

// ---------------------------------------------------------------------------
// T20: Script name constants are exported and correct
// ---------------------------------------------------------------------------
test('T20: GSD_CURSOR_SESSION_HOOK_SCRIPT and GSD_CURSOR_POST_TOOL_HOOK_SCRIPT are exported', () => {
  assert.equal(GSD_CURSOR_SESSION_HOOK_SCRIPT, 'gsd-cursor-session-start.js');
  assert.equal(GSD_CURSOR_POST_TOOL_HOOK_SCRIPT, 'gsd-cursor-post-tool.js');
});
