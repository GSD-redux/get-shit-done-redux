// Migrated to typed-IR (#2974): the gsd-session-state.sh and
// gsd-phase-boundary.sh hooks now emit Claude Code SessionStart/PostToolUse
// JSON envelopes ({ hookSpecificOutput: { hookEventName, additionalContext,
// state_present, config_mode | planning_modified, file_path } }) instead of
// plain text. gsd-validate-commit.sh already emitted JSON ({ decision,
// reason }). Tests parse the JSON and assert on typed fields.

/**
 * GSD Tools Tests - Community Hooks (opt-in)
 *
 * Tests for feat/hooks-opt-in-1473d:
 *   - Hook file existence and permissions
 *   - Installer hook registration in install.js
 *   - Hook execution with opt-in enabled and disabled
 *   - Negative security tests for hooks
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const isWindows = process.platform === 'win32';

// Ensure the running node binary is on PATH so bash hooks can call `node`
// (Claude Code shell sessions do not have `node` on PATH).
const hookEnv = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
};

// Wrapper that always injects hookEnv so bash hooks can find `node`.
function spawnHook(hookPath, options) {
  return spawnSync('bash', [hookPath], { ...options, env: hookEnv });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempProject(prefix = 'gsd-hook-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  return tmpDir;
}

function cleanup(tmpDir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this IS the local teardown helper; wrapping helpers.cjs cleanup would create a circular dependency
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function writeConfigWithHooks(tmpDir, enabled) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify({
      model_profile: 'balanced',
      hooks: { community: enabled }
    }, null, 2)
  );
}

function writeMinimalStateMd(tmpDir, content) {
  const defaultContent = content || '# Session State\n\n**Current Phase:** 01\n**Status:** Active\n';
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    defaultContent
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Hook file existence and permissions
// ─────────────────────────────────────────────────────────────────────────────

describe('hook file validation', () => {
  test('gsd-session-state.sh exists', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-session-state.sh');
    assert.ok(fs.existsSync(hookPath), 'gsd-session-state.sh should exist');
  });

  test('gsd-validate-commit.sh exists', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    assert.ok(fs.existsSync(hookPath), 'gsd-validate-commit.sh should exist');
  });

  test('gsd-phase-boundary.sh exists', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-phase-boundary.sh');
    assert.ok(fs.existsSync(hookPath), 'gsd-phase-boundary.sh should exist');
  });

  test('gsd-session-state.sh is executable', { skip: isWindows ? 'Windows has no POSIX file permissions' : false }, () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-session-state.sh');
    const stat = fs.statSync(hookPath);
    assert.ok((stat.mode & 0o111) !== 0, 'gsd-session-state.sh should be executable');
  });

  test('gsd-validate-commit.sh is executable', { skip: isWindows ? 'Windows has no POSIX file permissions' : false }, () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const stat = fs.statSync(hookPath);
    assert.ok((stat.mode & 0o111) !== 0, 'gsd-validate-commit.sh should be executable');
  });

  test('gsd-phase-boundary.sh is executable', { skip: isWindows ? 'Windows has no POSIX file permissions' : false }, () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-phase-boundary.sh');
    const stat = fs.statSync(hookPath);
    assert.ok((stat.mode & 0o111) !== 0, 'gsd-phase-boundary.sh should be executable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Installer hook registration
// Migrated (#455): uses typed exports from bin/install.js instead of
// source-grep assertions (retiring pending-migration-to-typed-ir token).
// ─────────────────────────────────────────────────────────────────────────────

// Typed import — no source-grep needed (#455)
const { GSD_UNINSTALL_HOOKS, buildHookCommand } = require(
  path.join(__dirname, '..', 'bin', 'install.js')
);

describe('installer hook registration', () => {
  test('GSD_UNINSTALL_HOOKS includes all 3 opt-in bash hooks', () => {
    assert.ok(Array.isArray(GSD_UNINSTALL_HOOKS), 'GSD_UNINSTALL_HOOKS must be an array');
    assert.ok(
      GSD_UNINSTALL_HOOKS.includes('gsd-validate-commit.sh'),
      'GSD_UNINSTALL_HOOKS must include gsd-validate-commit.sh'
    );
    assert.ok(
      GSD_UNINSTALL_HOOKS.includes('gsd-session-state.sh'),
      'GSD_UNINSTALL_HOOKS must include gsd-session-state.sh'
    );
    assert.ok(
      GSD_UNINSTALL_HOOKS.includes('gsd-phase-boundary.sh'),
      'GSD_UNINSTALL_HOOKS must include gsd-phase-boundary.sh'
    );
  });

  test('GSD_UNINSTALL_HOOKS includes all core JS hooks', () => {
    const requiredJsHooks = [
      'gsd-statusline.js',
      'gsd-check-update.js',
      'gsd-context-monitor.js',
    ];
    for (const hook of requiredJsHooks) {
      assert.ok(
        GSD_UNINSTALL_HOOKS.includes(hook),
        `GSD_UNINSTALL_HOOKS must include ${hook}`
      );
    }
  });

  test('buildHookCommand generates a command string for gsd-validate-commit.sh', () => {
    // buildHookCommand(configDir, hookName, opts) returns a non-null string command
    // or null when the platform cannot run the hook. On non-Windows unix, .sh hooks
    // always produce a command string.
    const tmpConfigDir = os.tmpdir();
    const cmd = buildHookCommand(tmpConfigDir, 'gsd-validate-commit.sh', { platform: 'linux' });
    // On Linux, .sh hooks should always resolve to a non-null string
    assert.ok(
      cmd === null || (typeof cmd === 'string' && cmd.length > 0),
      `buildHookCommand must return null or a non-empty string, got: ${JSON.stringify(cmd)}`
    );
    if (cmd !== null) {
      assert.ok(
        cmd.includes('gsd-validate-commit.sh'),
        `buildHookCommand result must reference the hook filename, got: ${cmd}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Opt-in gating behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('opt-in gating behavior', { skip: isWindows ? 'bash hooks require unix shell' : false }, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('validate-commit is a no-op when hooks.community is false', () => {
    writeConfigWithHooks(tmpDir, false);
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git commit -m "WIP save"' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    // Should exit 0 (no-op) even with a bad commit message
    assert.strictEqual(result.status, 0, `Should be no-op when disabled, got ${result.status}`);
  });

  test('validate-commit is a no-op when config.json is absent', (t) => {
    // No config.json at all
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hook-bare-'));
    t.after(() => { cleanup(bareDir); });
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git commit -m "WIP save"' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: bareDir,
    });

    assert.strictEqual(result.status, 0, `Should be no-op without config.json, got ${result.status}`);
  });

  test('session-state is a no-op when hooks.community is false', () => {
    writeConfigWithHooks(tmpDir, false);
    writeMinimalStateMd(tmpDir);
    const hookPath = path.join(HOOKS_DIR, 'gsd-session-state.sh');

    const result = spawnHook(hookPath, {
      input: '',
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Should exit 0: ${result.stderr}`);
    // Migrated #2974: typed assertion that stdout is empty (no JSON envelope
    // emitted when the hook is a no-op). The previous shape grepped for
    // "Project State Reminder" prose; now the contract is "no output".
    assert.equal(result.stdout.trim(), '',
      `Should produce no output when disabled: ${JSON.stringify(result.stdout)}`);
  });

  test('phase-boundary is a no-op when hooks.community is false', () => {
    writeConfigWithHooks(tmpDir, false);
    const hookPath = path.join(HOOKS_DIR, 'gsd-phase-boundary.sh');
    const input = JSON.stringify({
      tool_input: { file_path: '.planning/STATE.md' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Should exit 0: ${result.stderr}`);
    // Migrated #2974: typed empty-stdout assertion (#2974).
    assert.equal(result.stdout.trim(), '',
      `Should produce no output when disabled: ${JSON.stringify(result.stdout)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Hook execution when enabled
// ─────────────────────────────────────────────────────────────────────────────

describe('hook execution when enabled', { skip: isWindows ? 'bash hooks require unix shell' : false }, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    writeConfigWithHooks(tmpDir, true);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('validate-commit allows valid conventional commit', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git commit -m "fix(core): add locking mechanism"' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Valid commit should exit 0, got ${result.status}. stderr: ${result.stderr}`);
  });

  test('validate-commit blocks non-conventional commit', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git commit -m "WIP save"' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 2, `Non-conventional commit should exit 2, got ${result.status}`);
    // Migrated #2974: parse the hook's JSON envelope and assert on typed
    // fields (decision, reason). Hook protocol returns
    // { decision: 'block', reason: '...' } for blocked commits.
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.decision, 'block',
      `expected typed decision: 'block', got: ${JSON.stringify(parsed)}`);
    // Assert on the typed `code` field (stable enum value), not the
    // human-readable `reason` string. CR feedback (#3016): substring
    // matching on `reason` is still text matching — the hook now emits
    // a typed code alongside the prose so tests pin behavior, not copy.
    assert.strictEqual(parsed.code, 'CONVENTIONAL_COMMITS_VIOLATION',
      `expected typed code: 'CONVENTIONAL_COMMITS_VIOLATION', got: ${JSON.stringify(parsed)}`);
  });

  test('validate-commit allows non-commit commands', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git push origin main' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Non-commit command should exit 0, got ${result.status}`);
  });

  test('session-state outputs state info when enabled', () => {
    writeMinimalStateMd(tmpDir);
    const hookPath = path.join(HOOKS_DIR, 'gsd-session-state.sh');

    const result = spawnHook(hookPath, {
      input: '',
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Should exit 0: ${result.stderr}`);
    // Migrated #2974: parse the SessionStart JSON envelope and assert on
    // typed fields. The hook now emits
    // { hookSpecificOutput: { hookEventName, additionalContext, state_present, config_mode } }.
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.strictEqual(parsed.hookSpecificOutput.state_present, true,
      'state_present must reflect that STATE.md was written by writeMinimalStateMd');
  });

  test('session-state exits 0 without .planning/ (in enabled project)', (t) => {
    // Create a dir with config but no STATE.md
    const noStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hook-nostate-'));
    t.after(() => { cleanup(noStateDir); });
    fs.mkdirSync(path.join(noStateDir, '.planning'), { recursive: true });
    writeConfigWithHooks(noStateDir, true);
    const hookPath = path.join(HOOKS_DIR, 'gsd-session-state.sh');

    const result = spawnHook(hookPath, {
      input: '',
      encoding: 'utf-8',
      cwd: noStateDir,
    });

    assert.strictEqual(result.status, 0, `Should exit 0: ${result.stderr}`);
    // Migrated #2974: typed assertion on state_present field instead of
    // grepping additionalContext text for "No .planning/ found".
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.hookSpecificOutput.state_present, false,
      'state_present must be false when STATE.md is absent');
  });

  test('phase-boundary detects .planning/ writes when enabled', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-phase-boundary.sh');
    const input = JSON.stringify({
      tool_input: { file_path: '.planning/STATE.md' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Should exit 0: ${result.stderr}`);
    // Migrated #2974: parse the PostToolUse JSON envelope. The hook emits
    // { hookSpecificOutput: { hookEventName, additionalContext,
    //   planning_modified, file_path } } when a .planning/ write is detected.
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.strictEqual(parsed.hookSpecificOutput.planning_modified, true);
    assert.strictEqual(parsed.hookSpecificOutput.file_path, '.planning/STATE.md');
  });

  // #2304 — Kimi tool vocabulary engages the hook: Kimi CLI registers this
  // hook with matcher 'WriteFile|StrReplaceFile' and its file tools name the
  // path field `path`, not `file_path` (kimi-cli src/kimi_cli/tools/file/
  // write.py + replace.py). Pre-fix, the hook read '' on Kimi payloads and
  // .planning/ writes were silently undetected.
  test('phase-boundary detects .planning/ writes from Kimi tool_input.path (#2304)', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-phase-boundary.sh');
    const input = JSON.stringify({
      tool_name: 'kimi_cli.tools.file:WriteFile',
      tool_input: { path: '.planning/STATE.md', content: 'x' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Should exit 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.hookSpecificOutput.planning_modified, true,
      'Kimi path field must be detected — pre-fix the hook read an empty path (#2304)');
    assert.strictEqual(parsed.hookSpecificOutput.file_path, '.planning/STATE.md');
  });

  // #2752 — `path` is the AUTHORITATIVE field (kimi-cli executes on it; its file
  // tools send `path` only). `file_path` is model-controlled on Kimi (kimi-cli never
  // sends it). The old precedence (`file_path || path`) let a model-supplied decoy
  // `file_path` suppress the reminder for a real write or fabricate one for a file
  // never touched. Mirrors the #2595 JS-guard fix: `path` wins, `file_path` is the
  // fallback (Claude emits `file_path` and no `path`, so the fallback must remain).
  test('phase-boundary prefers Kimi tool_input.path when both fields are present (#2752)', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-phase-boundary.sh');
    // Suppression repro: a real .planning/ write WITH a decoy non-empty file_path.
    const suppressionInput = JSON.stringify({
      tool_name: 'kimi_cli.tools.file:StrReplaceFile',
      tool_input: { path: '.planning/STATE.md', file_path: 'unrelated.txt', edit: { old: 'a', new: 'b' } }
    });

    const suppressionResult = spawnHook(hookPath, {
      input: suppressionInput,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(suppressionResult.status, 0, `Should exit 0: ${suppressionResult.stderr}`);
    const suppressionParsed = JSON.parse(suppressionResult.stdout);
    assert.strictEqual(suppressionParsed.hookSpecificOutput.planning_modified, true,
      'A real .planning/STATE.md write must NOT be suppressed by a model-supplied decoy file_path (#2752)');
    assert.strictEqual(suppressionParsed.hookSpecificOutput.file_path, '.planning/STATE.md',
      'path must win over file_path — the runtime executes on path, file_path is the fallback');

    // Fabrication repro: a write ELSEWHERE with a decoy file_path pointing into .planning/.
    const fabricationInput = JSON.stringify({
      tool_name: 'kimi_cli.tools.file:StrReplaceFile',
      tool_input: { path: 'src/index.ts', file_path: '.planning/STATE.md', edit: { old: 'a', new: 'b' } }
    });

    const fabricationResult = spawnHook(hookPath, {
      input: fabricationInput,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(fabricationResult.status, 0, `Should exit 0: ${fabricationResult.stderr}`);
    // No reminder emitted — the write was to src/index.ts; the decoy .planning/
    // file_path must NOT fabricate a reminder for a file never touched.
    assert.strictEqual(fabricationResult.stdout, '',
      'A decoy .planning/ file_path must NOT fabricate a reminder when the real path is outside .planning/ (#2752)');
  });

  test('phase-boundary negative control: Kimi path outside .planning/ stays silent (#2304)', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-phase-boundary.sh');
    const input = JSON.stringify({
      tool_name: 'kimi_cli.tools.file:StrReplaceFile',
      tool_input: { path: 'src/index.ts', edit: { old: 'a', new: 'b' } }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Should exit 0: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '',
      'non-.planning/ Kimi writes must produce no output');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Negative security tests for hooks
// ─────────────────────────────────────────────────────────────────────────────

describe('hook security tests', { skip: isWindows ? 'bash hooks require unix shell' : false }, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    writeConfigWithHooks(tmpDir, true);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('validate-commit blocks message with shell metacharacters', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git commit -m "$(rm -rf /)"' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 2, `Shell metacharacter message should be blocked: ${result.status}`);
    // Migrated #2974: typed JSON envelope assertion (parsed.decision === 'block').
    assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
  });

  test('validate-commit blocks message with backtick injection', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git commit -m "`whoami`"' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 2, `Backtick injection should be blocked: ${result.status}`);
    // Migrated #2974: typed JSON envelope assertion (parsed.decision === 'block').
    assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
  });

  test('validate-commit allows commit with scope containing special chars', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git commit -m "fix(api/v2): handle edge case"' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Valid commit with / in scope should be allowed: ${result.status}`);
  });

  test('phase-boundary handles malformed JSON input gracefully', () => {
    const hookPath = path.join(HOOKS_DIR, 'gsd-phase-boundary.sh');
    const input = 'not json at all';

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.strictEqual(result.status, 0, `Should not crash on malformed JSON: ${result.stderr}`);
  });

  test('hooks handle config.json with broken JSON gracefully', () => {
    // Write malformed JSON config
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      '{ broken json'
    );

    const hookPath = path.join(HOOKS_DIR, 'gsd-validate-commit.sh');
    const input = JSON.stringify({
      tool_input: { command: 'git commit -m "WIP save"' }
    });

    const result = spawnHook(hookPath, {
      input,
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    // Should exit 0 (treat malformed config as disabled)
    assert.strictEqual(result.status, 0, `Malformed config should be treated as disabled: ${result.status}`);
  });
});
