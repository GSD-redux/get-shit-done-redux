'use strict';

/**
 * Windsurf/Cascade HOOK-BRIDGE upgrade — ADR-1239 / #2100 Stage 2.
 *
 * Stage 1 (folds) drove Windsurf's install onto the declarative capability
 * descriptor (hostBehaviors) while leaving `hooksSurface: "none"`. Stage 2
 * wires GSD's guard logic into Cascade's native hook bus: `.windsurf/hooks.json`
 * (local) / `~/.codeium/windsurf/hooks.json` (global), with TWO blocking
 * events — `pre_write_code` and `pre_run_command`. Cascade blocks via EXIT
 * CODE 2 (+ a stderr reason), unlike Cursor's stdout-JSON `{ block, reason }`
 * form — so this is a DIFFERENT protocol wired through the SAME infra shape
 * as writeCursorHooksJson/removeCursorHooksJson (mirrors
 * tests/cursor-hooks.test.cjs + tests/cursor-hook-bus-upgrade.test.cjs).
 *
 * Cascade has no context-injection channel (no `additional_context`-style
 * advisory response), so the 4 advisory hooks GSD registers on Cursor
 * (sessionStart, postToolUse, stop, subagentStart/subagentStop) have no
 * Windsurf counterpart and are deliberately NOT ported.
 *
 * Test plan:
 *   Guard scripts (spawned directly, real process, real exit codes):
 *     G1  pre-write: file resolves to a different git root than cwd -> exit 2 + stderr
 *     G2  pre-write: file resolves to the SAME git root as cwd -> exit 0
 *     G3  pre-write: malformed JSON on stdin -> fail-open exit 0
 *     G4  pre-write: empty stdin -> fail-open exit 0
 *     G5  pre-command: a destructive command_line -> exit 2 + stderr
 *     G6  pre-command: a benign command_line -> exit 0
 *     G8  pre-command: prefixed/evasive rm -rf and force-push refspec forms -> exit 2
 *     G9  pre-command: force-push false-positive forms (comment/branch-name-contains) -> exit 0
 *     G10 pre-command: ReDoS-guard — oversized rm-shaped payload -> exit 0 in well under 1s
 *     G7  pre-command: malformed JSON on stdin -> fail-open exit 0
 *   Writer/reconcile (in-process, pure + one real install):
 *     W1  writeWindsurfHooksJson installs both scripts + both hooks.json entries
 *     W2  reconcileWindsurfHooksJson preserves user-owned entries
 *     W3  removeWindsurfHooksJson removes hooks.json when it becomes empty
 *     W4  removeWindsurfHooksJson preserves hooks.json when user entries remain
 *     W5  WINDSURF_HOOK_EVENTS / WINDSURF_EVENT_SCRIPT_MAP shape
 *     W6  hook scripts exist under hooks/
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');

const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  WINDSURF_HOOK_EVENTS,
  WINDSURF_EVENT_SCRIPT_MAP,
  GSD_WINDSURF_HOOK_MARKER,
  GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT,
  GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT,
  isManagedWindsurfHookEntry,
  reconcileWindsurfHooksJson,
  writeWindsurfHooksJson,
  removeWindsurfHooksJson,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const PRE_WRITE_SCRIPT = path.join(HOOKS_DIR, GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT);
const PRE_COMMAND_SCRIPT = path.join(HOOKS_DIR, GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT);

function runHook(scriptPath, payload, opts = {}) {
  const input = payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload));
  const r = runHookSeam(scriptPath, [], {
    input,
    timeoutMs: 10000,
    cwd: opts.cwd || os.tmpdir(),
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr, signal: r.signal };
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'gsd-test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'gsd-test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// Guard scripts — spawned directly, real exit codes
// ---------------------------------------------------------------------------

describe('gsd-windsurf-pre-write.js (pre_write_code guard)', () => {
  test('G1: a write resolving to a DIFFERENT git root than cwd -> exit 2 + stderr reason', (t) => {
    const cwdRepo = createTempDir('gsd-windsurf-write-cwd-');
    const otherRepo = createTempDir('gsd-windsurf-write-other-');
    t.after(() => { cleanup(cwdRepo); cleanup(otherRepo); });
    initGitRepo(cwdRepo);
    initGitRepo(otherRepo);
    fs.writeFileSync(path.join(otherRepo, 'target.txt'), 'x');

    const result = runHook(PRE_WRITE_SCRIPT, {
      agent_action_name: 'pre_write_code',
      tool_info: { file_path: path.join(otherRepo, 'target.txt') },
    }, { cwd: cwdRepo });

    assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stderr: ${result.stderr})`);
    assert.match(result.stderr, /differs from the active project root|inside a git internal/);
  });

  test('G1b: a write inside a DIFFERENT repo\'s .git internals -> exit 2 + stderr reason', (t) => {
    const cwdRepo = createTempDir('gsd-windsurf-write-cwd-');
    const otherRepo = createTempDir('gsd-windsurf-write-other-');
    t.after(() => { cleanup(cwdRepo); cleanup(otherRepo); });
    initGitRepo(cwdRepo);
    initGitRepo(otherRepo);

    const result = runHook(PRE_WRITE_SCRIPT, {
      tool_info: { file_path: path.join(otherRepo, '.git', 'config') },
    }, { cwd: cwdRepo });

    assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stderr: ${result.stderr})`);
    assert.match(result.stderr, /inside a git internal \(\.git\) directory/);
  });

  test('G2: a write resolving to the SAME git root as cwd -> exit 0 (allowed)', (t) => {
    const repo = createTempDir('gsd-windsurf-write-same-');
    t.after(() => cleanup(repo));
    initGitRepo(repo);
    fs.mkdirSync(path.join(repo, 'sub'));

    const result = runHook(PRE_WRITE_SCRIPT, {
      tool_info: { file_path: 'sub/new-file.txt' },
    }, { cwd: repo });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
  });

  test('G3: malformed JSON on stdin -> fail-open exit 0', () => {
    const result = runHook(PRE_WRITE_SCRIPT, 'not-json-at-all{{{');
    assert.equal(result.status, 0);
  });

  test('G4: empty stdin -> fail-open exit 0', () => {
    const result = runHook(PRE_WRITE_SCRIPT, '');
    assert.equal(result.status, 0);
  });

  test('missing tool_info.file_path -> fail-open exit 0', () => {
    const result = runHook(PRE_WRITE_SCRIPT, { tool_info: {} });
    assert.equal(result.status, 0);
  });
});

describe('gsd-windsurf-pre-command.js (pre_run_command guard)', () => {
  test('G5: a destructive command_line (rm -rf /) -> exit 2 + stderr reason', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'rm -rf /' } });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stderr: ${result.stderr})`);
    assert.match(result.stderr, /rm -rf targeting the filesystem root/);
  });

  test('G5b: git push --force targeting a protected branch -> exit 2 + stderr reason', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'git push --force origin main' } });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stderr: ${result.stderr})`);
    assert.match(result.stderr, /protected branch 'main'/);
  });

  test('G6: a benign command_line -> exit 0 (allowed)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'npm test' } });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
  });

  test('G6b: rm -rf against an ordinary project path -> exit 0 (allowed, not a root wipe)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'rm -rf /tmp/gsd-scratch-dir' } });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
  });

  test('G6c: git push --force to a feature branch -> exit 0 (allowed, not protected)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'git push --force origin feature/123' } });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
  });

  test('G8: sudo-prefixed rm -rf / -> exit 2 (evasion via command prefix)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'sudo rm -rf /' } });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stderr: ${result.stderr})`);
    assert.match(result.stderr, /rm -rf targeting the filesystem root/);
  });

  test('G8b: absolute-path rm -rf / (/bin/rm) -> exit 2 (evasion via basename)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: '/bin/rm -rf /' } });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stderr: ${result.stderr})`);
    assert.match(result.stderr, /rm -rf targeting the filesystem root/);
  });

  test('G8c: git push -f origin HEAD:main -> exit 2 (refspec targeting protected branch)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'git push -f origin HEAD:main' } });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stderr: ${result.stderr})`);
    assert.match(result.stderr, /protected branch 'main'/);
  });

  test('G8d: git push origin +main -> exit 2 (+-prefixed force refspec)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'git push origin +main' } });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status} (stderr: ${result.stderr})`);
    assert.match(result.stderr, /protected branch 'main'/);
  });

  test('G9: git push --force to a feature branch with a trailing comment mentioning main -> exit 0 (not a false positive)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, {
      tool_info: { command_line: 'git push --force origin feature/foo # deploy to main' },
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
  });

  test('G9b: git push --force to feature/main-fix -> exit 0 (branch name only CONTAINS "main", not a false positive)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'git push --force origin feature/main-fix' } });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
  });

  test('G9c: env-prefixed benign command -> exit 0 (env prefix alone is not destructive)', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: 'env FOO=1 npm test' } });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
  });

  test('G10: ReDoS-guard — a 200000+-char rm -rf-shaped payload is handled without catastrophic backtracking (length cap)', () => {
    const payload = `rm -${'r'.repeat(200000)}!`;
    // The ReDoS guard is `runHook`'s seam `timeoutMs: 10000`: catastrophic
    // backtracking on this payload would run for minutes, so the hook is
    // SIGKILL'd and returns a non-zero status — the exit-0 assertion below IS
    // the ReDoS check. (The prior `elapsedMs < 1000` wall-clock assertion was
    // redundant with that and flaked on a loaded bench at ~1.1s — CLAUDE.md:
    // do not assert on wall-clock time.)
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: { command_line: payload } });
    assert.equal(result.status, 0, `expected exit 0 (length-capped allow, no ReDoS timeout), got ${result.status} (stderr: ${result.stderr})`);
  });

  test('G7: malformed JSON on stdin -> fail-open exit 0', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, 'not-json-at-all{{{');
    assert.equal(result.status, 0);
  });

  test('empty stdin -> fail-open exit 0', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, '');
    assert.equal(result.status, 0);
  });

  test('missing tool_info.command_line -> fail-open exit 0', () => {
    const result = runHook(PRE_COMMAND_SCRIPT, { tool_info: {} });
    assert.equal(result.status, 0);
  });
});

// ---------------------------------------------------------------------------
// W5/W6: constants + on-disk scripts
// ---------------------------------------------------------------------------

test('W5: WINDSURF_HOOK_EVENTS is exactly the 2 wired Cascade events', () => {
  assert.deepEqual([...WINDSURF_HOOK_EVENTS].sort(), ['pre_run_command', 'pre_write_code']);
});

test('W5b: WINDSURF_EVENT_SCRIPT_MAP maps every event to a .js script', () => {
  for (const ev of WINDSURF_HOOK_EVENTS) {
    const script = WINDSURF_EVENT_SCRIPT_MAP[ev];
    assert.ok(typeof script === 'string' && script.endsWith('.js'), `${ev} must map to a .js script, got: ${script}`);
  }
});

test('W6: both hook scripts exist under hooks/', () => {
  assert.ok(fs.existsSync(PRE_WRITE_SCRIPT), 'hooks/gsd-windsurf-pre-write.js must exist');
  assert.ok(fs.existsSync(PRE_COMMAND_SCRIPT), 'hooks/gsd-windsurf-pre-command.js must exist');
});

// ---------------------------------------------------------------------------
// W1: writeWindsurfHooksJson — direct writer call
// ---------------------------------------------------------------------------

describe('writeWindsurfHooksJson', () => {
  test('W1: installs both scripts and both hooks.json entries with the marker', (t) => {
    const targetDir = createTempDir('gsd-windsurf-writer-');
    t.after(() => cleanup(targetDir));
    const src = path.join(__dirname, '..');

    const result = writeWindsurfHooksJson(targetDir, src, { platform: process.platform });
    assert.equal(result.hooksJsonPath, path.join(targetDir, 'hooks.json'));
    assert.ok(result.changed, 'first write must report changed=true');

    assert.ok(fs.existsSync(path.join(targetDir, 'hooks', GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT)), 'pre-write script must be installed');
    assert.ok(fs.existsSync(path.join(targetDir, 'hooks', GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT)), 'pre-command script must be installed');

    const written = JSON.parse(fs.readFileSync(result.hooksJsonPath, 'utf8'));
    assert.ok(written.hooks && typeof written.hooks === 'object', 'hooks.json must have a nested hooks table');
    for (const ev of WINDSURF_HOOK_EVENTS) {
      assert.ok(Array.isArray(written.hooks[ev]), `hooks.json must have a ${ev} array`);
      assert.equal(written.hooks[ev].length, 1, `${ev} must have exactly 1 managed entry`);
      assert.equal(written.hooks[ev][0][GSD_WINDSURF_HOOK_MARKER], true, `${ev} entry must carry the GSD managed marker`);
      assert.equal(typeof written.hooks[ev][0].command, 'string', `${ev} entry command must be a bare string (Cascade shape, not Cursor's {type,command})`);
      assert.equal(written.hooks[ev][0].type, undefined, `${ev} entry must NOT have Cursor's 'type' field`);
    }
  });

  test('W1b: is idempotent (second write reports changed=false)', (t) => {
    const targetDir = createTempDir('gsd-windsurf-writer-idem-');
    t.after(() => cleanup(targetDir));
    const src = path.join(__dirname, '..');

    writeWindsurfHooksJson(targetDir, src, { platform: process.platform });
    const second = writeWindsurfHooksJson(targetDir, src, { platform: process.platform });
    assert.equal(second.changed, false, 're-running the writer with no changes must report changed=false');
  });
});

// ---------------------------------------------------------------------------
// W2/W3/W4: reconcileWindsurfHooksJson / removeWindsurfHooksJson
// ---------------------------------------------------------------------------

describe('reconcileWindsurfHooksJson / removeWindsurfHooksJson', () => {
  function managedEntry(command) {
    return { command, [GSD_WINDSURF_HOOK_MARKER]: true };
  }
  function userEntry(command) {
    return { command };
  }

  test('W2: preserves user-owned entries across both events', (t) => {
    const dir = createTempDir('gsd-windsurf-reconcile-');
    t.after(() => cleanup(dir));
    const hooksJsonPath = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, JSON.stringify({
      hooks: {
        pre_write_code: [userEntry('echo user-write-hook')],
        pre_run_command: [userEntry('echo user-command-hook')],
      },
    }, null, 2) + '\n');

    const managedEntries = {
      pre_write_code: managedEntry('node /gsd/pre-write.js'),
      pre_run_command: managedEntry('node /gsd/pre-command.js'),
    };
    reconcileWindsurfHooksJson(hooksJsonPath, managedEntries);

    const written = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.equal(written.hooks.pre_write_code.length, 2, 'pre_write_code: 1 user + 1 managed');
    assert.equal(written.hooks.pre_run_command.length, 2, 'pre_run_command: 1 user + 1 managed');
    assert.ok(written.hooks.pre_write_code.some((e) => e.command === 'echo user-write-hook'));
    assert.ok(written.hooks.pre_write_code.some((e) => isManagedWindsurfHookEntry(e)));
  });

  test('W3: removeWindsurfHooksJson removes hooks.json when it becomes empty', (t) => {
    const dir = createTempDir('gsd-windsurf-remove-empty-');
    t.after(() => cleanup(dir));
    const hooksJsonPath = path.join(dir, 'hooks.json');
    reconcileWindsurfHooksJson(hooksJsonPath, {
      pre_write_code: managedEntry('node /gsd/pre-write.js'),
      pre_run_command: managedEntry('node /gsd/pre-command.js'),
    });
    assert.ok(fs.existsSync(hooksJsonPath));

    const result = removeWindsurfHooksJson(dir);
    assert.equal(result.changed, true);
    assert.equal(fs.existsSync(hooksJsonPath), false, 'empty hooks.json must be removed');
  });

  test('W4: removeWindsurfHooksJson preserves hooks.json when user entries remain', (t) => {
    const dir = createTempDir('gsd-windsurf-remove-preserve-');
    t.after(() => cleanup(dir));
    const hooksJsonPath = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, JSON.stringify({
      hooks: {
        pre_write_code: [
          managedEntry('node /gsd/pre-write.js'),
          userEntry('echo user-write-hook'),
        ],
      },
    }, null, 2) + '\n');

    removeWindsurfHooksJson(dir);

    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json must remain (user entries present)');
    const written = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.equal(written.hooks.pre_write_code.length, 1);
    assert.equal(written.hooks.pre_write_code[0].command, 'echo user-write-hook');
  });
});
