// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Tests for gsd-read-guard.js PreToolUse hook.
 *
 * The read guard intercepts Write/Edit tool calls on existing files and injects
 * advisory guidance telling the model to Read the file first. This prevents
 * infinite retry loops when non-Claude models (e.g. MiniMax M2.5 on OpenCode)
 * attempt to edit files without reading them, hitting the runtime's
 * "You must read file before overwriting it" error repeatedly.
 *
 * The hook is advisory-only (does not block) so Claude Code behavior is unaffected.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-read-guard.js');

/**
 * Run the read guard hook with a given tool input payload.
 * Returns { exitCode, stdout, stderr }.
 */
function runHook(payload, envOverrides = {}) {
  const input = JSON.stringify(payload);
  // Sanitize all Claude Code detection signals so positive-path tests work
  // when the test runner itself is running inside Claude Code (#2344, #2520).
  const env = {
    ...process.env,
    CLAUDE_SESSION_ID: '',
    CLAUDECODE: '',
    CLAUDE_CODE_ENTRYPOINT: '',
    CLAUDE_CODE_SSE_PORT: '',
    CLAUDE_PROJECT_DIR: '',
    ...envOverrides,
  };
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
    };
  }
}

describe('gsd-read-guard hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-read-guard-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ─── Core: advisory on Write to existing file ───────────────────────────

  test('injects read-first guidance when Write targets an existing file', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'console.log("hello");\n');

    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: 'console.log("world");\n' },
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0, 'should produce output');

    const output = JSON.parse(result.stdout);
    assert.ok(output.hookSpecificOutput, 'should have hookSpecificOutput');
    assert.ok(output.hookSpecificOutput.additionalContext, 'should have additionalContext');
    assert.ok(
      output.hookSpecificOutput.additionalContext.includes('Read'),
      'guidance should mention Read tool'
    );
  });

  test('injects read-first guidance when Edit targets an existing file', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' },
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0, 'should produce output');

    const output = JSON.parse(result.stdout);
    assert.ok(output.hookSpecificOutput.additionalContext.includes('Read'));
  });

  // ─── No-op cases: should NOT inject guidance ────────────────────────────

  test('does nothing for Write to a new file (file does not exist)', () => {
    const filePath = path.join(tmpDir, 'brand-new.js');
    // File does NOT exist

    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: 'new content' },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '', 'should produce no output for new files');
  });

  test('does nothing for non-Write/Edit tools', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  test('does nothing for Read tool', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'content');

    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  // ─── Error resilience ──────────────────────────────────────────────────

  test('exits cleanly on invalid JSON input', () => {
    try {
      const stdout = execFileSync(process.execPath, [HOOK_PATH], {
        input: 'not json',
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Should exit 0 silently
      assert.equal(stdout.trim(), '');
    } catch (err) {
      assert.equal(err.status, 0, 'should exit 0 on parse error');
    }
  });

  test('exits cleanly when tool_input is missing', () => {
    const result = runHook({ tool_name: 'Write' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  // ─── Guidance content quality ──────────────────────────────────────────

  test('guidance message includes the filename', () => {
    const filePath = path.join(tmpDir, 'myfile.ts');
    fs.writeFileSync(filePath, 'export const foo = 1;\n');

    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: 'export const foo = 2;\n' },
    });

    const output = JSON.parse(result.stdout);
    assert.ok(
      output.hookSpecificOutput.additionalContext.includes('myfile.ts'),
      'guidance should include the filename being edited'
    );
  });

  test('guidance message instructs to use Read tool before editing', () => {
    const filePath = path.join(tmpDir, 'target.py');
    fs.writeFileSync(filePath, 'x = 1\n');

    const result = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: 'x = 1', new_string: 'x = 2' },
    });

    const output = JSON.parse(result.stdout);
    const ctx = output.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('Read'), 'must mention Read tool');
    assert.ok(
      ctx.includes('before') || ctx.includes('first'),
      'must indicate Read should come before the edit'
    );
  });

  // ─── Build / install integration ───────────────────────────────────────

  test('hook is registered in build-hooks.js HOOKS_TO_COPY', () => {
    const buildHooksPath = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
    const content = fs.readFileSync(buildHooksPath, 'utf8');
    assert.ok(
      content.includes('gsd-read-guard.js'),
      'gsd-read-guard.js must be in HOOKS_TO_COPY so it ships in hooks/dist/'
    );
  });

  test('hook is registered in install.js uninstall hook list', () => {
    const installPath = path.join(__dirname, '..', 'bin', 'install.js');
    const content = fs.readFileSync(installPath, 'utf8');
    assert.ok(
      content.includes("'gsd-read-guard.js'"),
      'gsd-read-guard.js must be in the uninstall gsdHooks list'
    );
  });

  test('exits cleanly when tool_input.file_path is non-string', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: 12345, content: 'data' },
    });
    // file_path is a number — || '' yields '' — hook exits silently
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  });

  // ─── Claude Code runtime skip (#1984) ─────────────────────────────────

  test('skips advisory on Claude Code runtime (CLAUDE_SESSION_ID set)', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = runHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' } },
      { CLAUDE_SESSION_ID: 'test-session-123' }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '', 'should produce no output on Claude Code');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2344-read-guard-claudecode-env.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2344-read-guard-claudecode-env (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression test for bug #2344
 *
 * gsd-read-guard.js checked process.env.CLAUDE_SESSION_ID to detect the
 * Claude Code runtime and skip its advisory. However, Claude Code CLI exports
 * CLAUDECODE=1, not CLAUDE_SESSION_ID. The skip never fired, so the
 * READ-BEFORE-EDIT advisory injected on every Edit/Write call inside Claude
 * Code — producing noise in long-running sessions.
 *
 * Fix: check CLAUDECODE (and CLAUDE_SESSION_ID for back-compat) before
 * emitting the advisory.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-read-guard.js');

function runHook(payload, envOverrides = {}) {
  const input = JSON.stringify(payload);
  const env = {
    ...process.env,
    CLAUDE_SESSION_ID: '',
    CLAUDECODE: '',
    CLAUDE_CODE_ENTRYPOINT: '',
    CLAUDE_CODE_SSE_PORT: '',
    CLAUDE_PROJECT_DIR: '',
    ...envOverrides,
  };
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
    };
  }
}

describe('bug #2344: read guard skips on CLAUDECODE env var', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-read-guard-2344-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('skips advisory when CLAUDECODE=1 is set (Claude Code CLI env)', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = runHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' } },
      { CLAUDECODE: '1' }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '', 'advisory must not fire when CLAUDECODE=1');
  });

  test('skips advisory when CLAUDE_SESSION_ID is set (back-compat)', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = runHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' } },
      { CLAUDE_SESSION_ID: 'test-session-123' }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '', 'advisory must not fire when CLAUDE_SESSION_ID is set');
  });

  test('still injects advisory when neither CLAUDECODE nor CLAUDE_SESSION_ID is set', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = runHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' } },
      { CLAUDECODE: '', CLAUDE_SESSION_ID: '' }
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0, 'advisory should fire on non-Claude-Code runtimes');
    const output = JSON.parse(result.stdout);
    assert.ok(output.hookSpecificOutput?.additionalContext?.includes('Read'));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2520-read-guard-hook-subprocess-env.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2520-read-guard-hook-subprocess-env (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression test for bug #2520
 *
 * The fix for #2344 added `|| process.env.CLAUDECODE` to the Claude Code
 * skip check. That works in principle — CLAUDECODE=1 is propagated to Bash
 * tool subprocesses — but it does NOT reach hook subprocesses on Claude Code
 * v2.1.116. Claude Code applies a separate env filter when spawning
 * PreToolUse hook commands; that filter drops bare CLAUDECODE and
 * CLAUDE_SESSION_ID and keeps only CLAUDE_CODE_*-prefixed vars plus
 * CLAUDE_PROJECT_DIR. `data.session_id` is, however, reliably delivered via
 * the hook's stdin JSON payload (documented part of Claude Code's hook
 * input schema).
 *
 * Fix: use `data.session_id` as the primary Claude Code signal, with
 * CLAUDE_CODE_ENTRYPOINT / CLAUDE_CODE_SSE_PORT as env-var fallbacks, and
 * keep legacy CLAUDECODE / CLAUDE_SESSION_ID for back-compat and
 * future-proofing.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-read-guard.js');

/**
 * Spawn the hook with an env that mirrors the actual Claude Code hook
 * subprocess env: CLAUDECODE and CLAUDE_SESSION_ID are stripped, only
 * CLAUDE_CODE_*-prefixed vars (plus CLAUDE_PROJECT_DIR) remain. Extra env
 * overrides can be supplied via `envOverrides`.
 */
function runHookInClaudeCodeSubprocess(payload, envOverrides = {}) {
  const input = JSON.stringify(payload);
  const baseEnv = { ...process.env };
  // Strip env vars Claude Code does NOT propagate to hook subprocesses.
  delete baseEnv.CLAUDECODE;
  delete baseEnv.CLAUDE_SESSION_ID;
  const env = {
    ...baseEnv,
    // Env vars Claude Code DOES propagate to hook subprocesses (observed on
    // Claude Code CLI 2.1.116).
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '51291',
    CLAUDE_PROJECT_DIR: process.cwd(),
    ...envOverrides,
  };
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
    };
  }
}

describe('bug #2520: read guard detects Claude Code without relying on CLAUDECODE env', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-read-guard-2520-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('skips advisory when stdin payload includes session_id (Claude Code hook-subprocess env)', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    // Isolate the stdin `session_id` signal by clearing the CLAUDE_CODE_*
    // env fallbacks the helper normally provides. Without this the env
    // fallback would rescue the skip even if session_id detection broke,
    // hiding a regression of the primary signal.
    const result = runHookInClaudeCodeSubprocess(
      {
        session_id: 'e7123e54-0977-45dd-848a-b9c8a45a5cd3',
        tool_name: 'Edit',
        tool_input: { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' },
      },
      { CLAUDE_CODE_ENTRYPOINT: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_PROJECT_DIR: '' },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(
      result.stdout,
      '',
      'advisory must not fire when session_id is present on stdin (real Claude Code hook env)',
    );
  });

  test('skips advisory when CLAUDE_CODE_ENTRYPOINT is set (env-var fallback, no session_id on stdin)', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = runHookInClaudeCodeSubprocess(
      { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' } },
      { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '' },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '', 'advisory must not fire when CLAUDE_CODE_ENTRYPOINT is set');
  });

  test('still injects advisory when no Claude Code signal is present (non-Claude host)', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = runHookInClaudeCodeSubprocess(
      { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' } },
      { CLAUDE_CODE_ENTRYPOINT: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_PROJECT_DIR: '' },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0, 'advisory should fire on non-Claude-Code hosts');
    const output = JSON.parse(result.stdout);
    assert.ok(output.hookSpecificOutput?.additionalContext?.includes('Read'));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// #2304 — Kimi tool vocabulary engages the read guard
// ────────────────────────────────────────────────────────────────────────

describe('#2304: Kimi tool vocabulary is normalized by the read guard', () => {
  // Payload shapes mirror kimi-cli's actual tool schemas
  // (src/kimi_cli/tools/file/{write,replace}.py): WriteFile takes
  // `path`/`content`, StrReplaceFile takes `path` + `edit: Edit | list[Edit]`.
  //
  // SCOPE (#2547 finding 3): these cases omit `session_id`, so what they prove
  // is that normalizeKimiPayload maps the Kimi tool VOCABULARY through to the
  // Write/Edit branch — not that the advisory fires on a live Kimi turn. Every
  // real kimi-cli payload carries a non-empty `session_id` (hooks/events.py
  // `_base()` sets it unconditionally; kimisoul.py calls `set_session_id()` at
  // the top of every turn), and the guard treats any non-empty `session_id` as
  // "this is Claude Code, skip". Do NOT read a green here as evidence of
  // production behaviour — the '#2547' describe below pins what actually
  // happens against the production shape.
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-read-guard-2304-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('WriteFile on an existing file injects read-first guidance like Write', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'console.log("hello");\n');

    const result = runHook({
      tool_name: 'WriteFile',
      tool_input: { path: filePath, content: 'console.log("world");\n' },
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0, 'Kimi WriteFile should produce the advisory');
    const output = JSON.parse(result.stdout);
    assert.ok(output.hookSpecificOutput?.additionalContext?.includes('Read'));
  });

  test('StrReplaceFile on an existing file injects guidance like Edit', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = runHook({
      tool_name: 'StrReplaceFile',
      tool_input: { path: filePath, edit: { old: 'const x = 1;', new: 'const x = 2;' } },
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0, 'Kimi StrReplaceFile should produce the advisory');
    const output = JSON.parse(result.stdout);
    assert.ok(output.hookSpecificOutput?.additionalContext?.includes('Read'));
  });

  test('module-qualified kimi_cli.tools.file:WriteFile is recognized', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'content\n');

    const result = runHook({
      tool_name: 'kimi_cli.tools.file:WriteFile',
      tool_input: { path: filePath, content: 'replacement\n' },
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0, 'module-qualified Kimi WriteFile should produce the advisory');
  });

  test('Kimi ReadFile stays out of scope (silent exit)', () => {
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'content\n');

    const result = runHook({
      tool_name: 'kimi_cli.tools.file:ReadFile',
      tool_input: { path: filePath },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '', 'ReadFile is not a write tool — guard must stay silent');
  });
});

// ────────────────────────────────────────────────────────────────────────
// #2547 finding 3 — the production Kimi payload shape (session_id present)
// ────────────────────────────────────────────────────────────────────────

describe('#2547: read guard against the production Kimi payload shape', () => {
  // The #2304 cases above omit `session_id`. A live Kimi turn never does:
  //   - src/kimi_cli/hooks/events.py `_base()` returns
  //     {"hook_event_name", "session_id", "cwd"} — the field is unconditional;
  //   - src/kimi_cli/soul/kimisoul.py calls `set_session_id(session.id)` at the
  //     top of every turn, before tool dispatch, so the ContextVar holds a real
  //     UUID (its `default=""` only applies outside a turn).
  //
  // The guard's Claude Code check treats ANY non-empty `data.session_id` as
  // "Claude Code already enforces read-before-edit, skip" (#2520), so on Kimi
  // the advisory is DORMANT. These tests pin that real behaviour, which is what
  // makes the #2304 cases above trustworthy as vocabulary-only coverage.
  //
  // This is a CHARACTERIZATION of a known gap, not an endorsement of it.
  // Redesigning the runtime discrimination is explicitly OUT OF SCOPE for
  // #2547. If a later change makes the advisory fire on Kimi, these tests are
  // SUPPOSED to fail — update them then, rather than deleting the coverage.
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-read-guard-2547-'); });
  afterEach(() => { cleanup(tmpDir); });

  const LIVE_SESSION_ID = 'e7123e54-0977-45dd-848a-b9c8a45a5cd3';

  for (const [label, toolInput, toolName] of [
    ['StrReplaceFile', (p) => ({ path: p, edit: { old: 'const x = 1;', new: 'const x = 2;' } }), 'StrReplaceFile'],
    ['WriteFile', (p) => ({ path: p, content: 'replacement\n' }), 'WriteFile'],
    ['module-qualified WriteFile', (p) => ({ path: p, content: 'replacement\n' }), 'kimi_cli.tools.file:WriteFile'],
  ]) {
    test(`${label} with a populated session_id is dormant (known gap, #2547)`, () => {
      const filePath = path.join(tmpDir, 'existing.js');
      fs.writeFileSync(filePath, 'const x = 1;\n');

      const result = runHook({
        session_id: LIVE_SESSION_ID,
        tool_name: toolName,
        tool_input: toolInput(filePath),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '',
        'The advisory is currently skipped on Kimi because the guard reads any ' +
        'non-empty session_id as Claude Code. If this now emits, the runtime ' +
        'discrimination changed — update this test and the #2304 block above.');
    });
  }

  test('the ONLY difference is session_id — dropping it makes the same payload fire', () => {
    // The false-green proof, asserted rather than described: one field flips the
    // #2304 cases from firing to silent, and the live shape is the silent one.
    const filePath = path.join(tmpDir, 'existing.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');
    const toolInput = { path: filePath, edit: { old: 'const x = 1;', new: 'const x = 2;' } };

    const withoutSession = runHook({ tool_name: 'StrReplaceFile', tool_input: toolInput });
    const withSession = runHook({
      session_id: LIVE_SESSION_ID,
      tool_name: 'StrReplaceFile',
      tool_input: toolInput,
    });

    assert.ok(withoutSession.stdout.length > 0,
      'test-shape payload (no session_id) fires — this is what #2304 asserts');
    assert.equal(withSession.stdout, '',
      'production-shape payload (session_id present) is silent — so a green in ' +
      'the #2304 block is evidence about vocabulary, not about production');
  });
});
