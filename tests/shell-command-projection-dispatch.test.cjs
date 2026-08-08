'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');

const {
  execGit,
  execNpm,
  execTool,
  probeTty,
  normalizeContent,
  platformWriteSync,
  platformReadSync,
  platformEnsureDir,
  dispatchGsdCommand,
  resolveGsdToolsPath,
  projectPathActionProjection,
  projectPathExportLine,
  posixNormalize,
  PATH_ACTION_REASON,
  renderShellActionLines,
  formatManagedHookScriptToken,
  escapeTomlDoubleQuotedString,
  escapePowerShellSingleQuoted,
  escapePosixDoubleQuoted,
  escapeSingleQuotedShellLiteral,
  retryRenameSync,
} = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));

const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');

// ─── execGit ─────────────────────────────────────────────────────────────────

describe('execGit', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempGitProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns { exitCode, stdout, stderr } shape', () => {
    const result = execGit(['--version']);
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'exitCode'), 'missing exitCode');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'stdout'), 'missing stdout');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'stderr'), 'missing stderr');
  });

  test('exitCode 0 for successful command', () => {
    const result = execGit(['--version']);
    assert.strictEqual(result.exitCode, 0);
  });

  test('stdout contains version string for --version', () => {
    const result = execGit(['--version']);
    assert.strictEqual(typeof result.stdout, 'string');
    assert.ok(result.stdout.length > 0, 'stdout should not be empty for git --version');
  });

  test('exitCode non-zero for failing command — does not throw', () => {
    const result = execGit(['status', '--porcelain'], { cwd: '/tmp/definitely-not-a-git-repo-8675309' });
    assert.notStrictEqual(result.exitCode, 0);
  });

  test('respects cwd option', () => {
    const result = execGit(['status', '--porcelain'], { cwd: tmpDir });
    assert.strictEqual(result.exitCode, 0);
  });
});

// ─── execNpm ─────────────────────────────────────────────────────────────────

describe('execNpm', () => {
  test('returns { exitCode, stdout, stderr } shape', () => {
    const result = execNpm(['--version']);
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'exitCode'), 'missing exitCode');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'stdout'), 'missing stdout');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'stderr'), 'missing stderr');
  });

  test('exitCode 0 for npm --version', () => {
    const result = execNpm(['--version']);
    assert.strictEqual(result.exitCode, 0);
  });

  test('stdout is non-empty for npm --version', () => {
    const result = execNpm(['--version']);
    assert.ok(result.stdout.trim().length > 0);
  });
});

// ─── execTool ────────────────────────────────────────────────────────────────

describe('execTool', () => {
  test('returns { exitCode, stdout, stderr } shape for known program', () => {
    const result = execTool('node', ['--version']);
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'exitCode'), 'missing exitCode');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'stdout'), 'missing stdout');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'stderr'), 'missing stderr');
  });

  test('exitCode 0 for node --version', () => {
    const result = execTool('node', ['--version']);
    assert.strictEqual(result.exitCode, 0);
  });

  test('exitCode 127 and no throw when program does not exist', () => {
    const result = execTool('definitely-not-a-real-program-8675309', []);
    assert.strictEqual(result.exitCode, 127);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(typeof result.stderr, 'string');
  });
});

// ─── dispatchGsdCommand (#2102 Stage 2 — subprocess-shim dispatch to gsd-tools.cjs) ──
//
// The command-routing hub (`createHub()`) has no fully-populated factory
// anywhere in the tree — every caller builds a single-family hub — so the
// only dispatch path covering the FULL family/subcommand surface is the
// gsd-tools.cjs CLI itself. This is the shared helper pi/gsd.cjs and the
// companion MCP server both dispatch through.

describe('dispatchGsdCommand', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); mock.restoreAll(); });

  test('resolveGsdToolsPath resolves to the real gsd-tools.cjs on disk', () => {
    const toolsPath = resolveGsdToolsPath();
    assert.ok(fs.existsSync(toolsPath), `expected gsd-tools.cjs to exist at ${toolsPath}`);
    assert.equal(path.basename(toolsPath), 'gsd-tools.cjs');
  });

  test('a valid read-only family/subcommand dispatches for real and returns ok:true + non-empty stdout', () => {
    const result = dispatchGsdCommand({ family: 'progress', subcommand: 'json', cwd: tmpDir });
    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(typeof result.stdout, 'string');
    assert.ok(result.stdout.length > 0, 'stdout must be non-empty');
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.percent, 'number', 'the real progress command ran (proves the engine was reached)');
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
  });

  test('an unknown family returns ok:false without throwing', () => {
    assert.doesNotThrow(() => {
      const result = dispatchGsdCommand({ family: 'no-such-family-8675309', cwd: tmpDir });
      assert.equal(result.ok, false);
      assert.notEqual(result.code, 0);
      assert.equal(typeof result.stderr, 'string');
      assert.ok(result.stderr.length > 0);
      // --json-errors gives a structured, parseable error envelope.
      const parsedErr = JSON.parse(result.stderr);
      assert.equal(parsedErr.ok, false);
    });
  });

  test('a missing/bogus gsd-tools.cjs path degrades to ok:false without throwing', () => {
    assert.doesNotThrow(() => {
      const result = dispatchGsdCommand({
        family: 'progress',
        cwd: tmpDir,
        gsdToolsPath: path.join(tmpDir, 'definitely-not-a-real-gsd-tools-8675309.cjs'),
      });
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, false);
    });
  });

  test('a missing/empty "family" is rejected locally without spawning a subprocess', () => {
    const result = dispatchGsdCommand({ cwd: tmpDir });
    assert.equal(result.ok, false);
    assert.equal(result.code, null);
    assert.match(result.stderr, /requires a non-empty string "family"/);
  });

  test('a wall-clock timeout is reported via timedOut:true, ok:false — never throws', () => {
    assert.doesNotThrow(() => {
      const result = dispatchGsdCommand({ family: 'progress', subcommand: 'json', cwd: tmpDir, timeout: 1 });
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
    });
  });

  // #3050 item 4: this site (dispatchGsdCommand's `timedOut` derivation) now
  // routes through the shared isSpawnTimeout predicate, which drops the
  // `signal === 'SIGTERM'` requirement — a Windows-shaped timeout (no signal,
  // only error.code === 'ETIMEDOUT') must still be detected. The real-timeout
  // test above only exercises whatever shape THIS OS's spawnSync happens to
  // produce (SIGTERM on POSIX); mocking spawnSync proves the Windows shape too.
  test('Windows-shaped timeout (no signal, error.code ETIMEDOUT) is still reported as timedOut:true (#3050)', () => {
    mock.method(childProcess, 'spawnSync', () => ({
      status: null,
      stdout: '',
      stderr: '',
      signal: null,
      error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    }));

    const result = dispatchGsdCommand({ family: 'progress', subcommand: 'json', cwd: tmpDir });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
  });
});

// ─── probeTty ────────────────────────────────────────────────────────────────

describe('probeTty', () => {
  test('returns string or null — never throws', () => {
    const result = probeTty();
    assert.ok(result === null || typeof result === 'string', `expected string|null, got ${typeof result}`);
  });

  test('returns null when platform is win32', () => {
    const result = probeTty({ platform: 'win32' });
    assert.strictEqual(result, null);
  });
});

// ─── normalizeContent ────────────────────────────────────────────────────────

describe('normalizeContent', () => {
  test('returns { content, encoding } shape', () => {
    const result = normalizeContent('file.md', 'hello\n');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'content'), 'missing content');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'encoding'), 'missing encoding');
  });

  test('normalizes CRLF to LF for .md files', () => {
    const result = normalizeContent('file.md', 'line1\r\nline2\r\n');
    assert.ok(!result.content.includes('\r\n'), 'CRLF should be normalized to LF');
  });

  test('normalizes CRLF to LF for non-.md files', () => {
    const result = normalizeContent('file.json', '{"a":1}\r\n');
    assert.ok(!result.content.includes('\r\n'), 'CRLF should be normalized to LF');
  });

  test('enforces single trailing newline for .md files', () => {
    const result = normalizeContent('file.md', 'hello');
    assert.ok(result.content.endsWith('\n'), 'should end with newline');
    assert.ok(!result.content.endsWith('\n\n'), 'should not end with double newline');
  });

  test('enforces single trailing newline for non-.md files', () => {
    const result = normalizeContent('file.txt', 'hello');
    assert.ok(result.content.endsWith('\n'));
    assert.ok(!result.content.endsWith('\n\n'));
  });

  test('applies full markdownlint normalization for .md files — blank line before heading', () => {
    const input = [
      '# Title',
      'paragraph',
      '## Section',
    ].join('\n');
    const result = normalizeContent('file.md', input);
    assert.ok(result.content.includes('\n\n## Section'), 'MD022: blank line before heading');
  });

  test('does NOT apply markdown structural rules to non-.md files', () => {
    const input = 'paragraph\n## Not a heading in json\n';
    const result = normalizeContent('file.json', input);
    assert.strictEqual(result.content, input);
  });

  test('encoding defaults to utf-8', () => {
    const result = normalizeContent('file.md', 'hello\n');
    assert.strictEqual(result.encoding, 'utf-8');
  });
});

// ─── platformWriteSync ───────────────────────────────────────────────────────

describe('platformWriteSync', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  test('written file exists and is a regular file', () => {
    const filePath = path.join(tmpDir, 'output.md');
    platformWriteSync(filePath, '# Hello\n');
    assert.ok(fs.statSync(filePath).isFile());
  });

  test('written file has non-zero size', () => {
    const filePath = path.join(tmpDir, 'output.md');
    platformWriteSync(filePath, '# Hello\n');
    assert.ok(fs.statSync(filePath).size > 0);
  });

  test('creates parent directory if absent', () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'output.md');
    platformWriteSync(filePath, '# Hello\n');
    assert.ok(fs.statSync(filePath).isFile());
  });

  test('mtime advances on re-write', (_t) => {
    const filePath = path.join(tmpDir, 'output.md');
    platformWriteSync(filePath, '# First\n');
    const mtimeBefore = fs.statSync(filePath).mtimeMs;
    // Small delay to ensure mtime differs
    const start = Date.now();
    while (Date.now() - start < 10) { /* busy wait */ }
    platformWriteSync(filePath, '# Second\n');
    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    assert.ok(mtimeAfter >= mtimeBefore, 'mtime should advance or stay same on re-write');
  });

  test('no temp file left on disk after successful write', () => {
    const filePath = path.join(tmpDir, 'output.md');
    platformWriteSync(filePath, '# Hello\n');
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp.'));
    assert.strictEqual(tmpFiles.length, 0, 'no temp files should remain');
  });
});

// ─── platformReadSync ────────────────────────────────────────────────────────

describe('platformReadSync', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns null for missing file when required is false (default)', () => {
    const result = platformReadSync(path.join(tmpDir, 'nonexistent.md'));
    assert.strictEqual(result, null);
  });

  test('throws for missing file when required is true', () => {
    assert.throws(
      () => platformReadSync(path.join(tmpDir, 'nonexistent.md'), { required: true }),
      /ENOENT/,
    );
  });

  test('returns string content for existing file', () => {
    const filePath = path.join(tmpDir, 'existing.md');
    fs.writeFileSync(filePath, '# Hello\n', 'utf-8');
    const result = platformReadSync(filePath);
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});

// ─── platformEnsureDir ───────────────────────────────────────────────────────

describe('platformEnsureDir', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  test('creates directory if absent', () => {
    const dirPath = path.join(tmpDir, 'new', 'nested', 'dir');
    platformEnsureDir(dirPath);
    assert.ok(fs.statSync(dirPath).isDirectory());
  });

  test('no error when directory already exists — idempotent', () => {
    const dirPath = path.join(tmpDir, 'existing');
    fs.mkdirSync(dirPath);
    assert.doesNotThrow(() => platformEnsureDir(dirPath));
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1906-hook-relative-paths.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1906-hook-relative-paths (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression tests for bug #1906
 *
 * Local installs must anchor hook command paths to $CLAUDE_PROJECT_DIR so
 * hooks resolve correctly regardless of the shell's current working directory.
 *
 * The original bug: local install hook commands used bare relative paths like
 * `node .claude/hooks/gsd-context-monitor.js`. Claude Code persists the bash
 * tool's cwd between calls, so a single `cd subdir && …` early in a session
 * permanently broke every hook for the rest of that session.
 *
 * The fix prefixes all local hook commands with "$CLAUDE_PROJECT_DIR"/ so
 * path resolution is always anchored to the project root.
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const projection = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const { projectLocalHookPrefix, projectShellCommandText } = projection;

describe('bug #1906: local hook commands use $CLAUDE_PROJECT_DIR', () => {
  before(() => {
    assert.equal(typeof projectLocalHookPrefix, 'function');
    assert.equal(typeof projectShellCommandText, 'function');
  });

  test('non-Gemini runtimes get $CLAUDE_PROJECT_DIR anchored local prefix', () => {
    const prefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    assert.equal(prefix, '"$CLAUDE_PROJECT_DIR"/.claude');
  });

  test('local command projection for non-Gemini keeps $CLAUDE_PROJECT_DIR anchor', () => {
    const prefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const command = projectShellCommandText({
      runnerToken: '"/usr/local/bin/node"',
      argTokens: [`${prefix}/hooks/gsd-context-monitor.js`],
      runtime: 'claude',
      platform: 'linux',
    });
    assert.equal(
      command,
      '"/usr/local/bin/node" "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2557-gemini-local-hook-paths.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2557-gemini-local-hook-paths (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Bug #2557: Gemini CLI local hook commands must NOT use $CLAUDE_PROJECT_DIR.
 *
 * $CLAUDE_PROJECT_DIR is a Claude Code-specific env variable. Gemini CLI did
 * not set it. On Windows, Gemini's own variable-substitution + path-join logic
 * produced a doubled path like `D:\Projects\GSD\'D:\Projects\GSD'`, causing
 * every local project hook to fail at SessionStart.
 *
 * Fix: localPrefix was made runtime-conditional. Gemini/Antigravity used bare
 * dirName (relative path) since they always run project hooks with the project
 * dir as cwd. Claude Code and others still use "$CLAUDE_PROJECT_DIR"/ (#1906).
 *
 * #1928: Google sunset Gemini CLI (2026-06-18) and the `gemini` runtime was
 * removed from GSD entirely.
 *
 * #2096: `projectLocalHookPrefix` no longer special-cases `antigravity` by
 * name — it branches on the caller-supplied `hookPathStyle` (sourced from
 * the runtime's `hostBehaviors.hookPathStyle` descriptor field). An
 * unrecognized runtime string like the former `'gemini'`, or any runtime
 * that doesn't declare `hookPathStyle: 'raw'`, falls through to the default
 * $CLAUDE_PROJECT_DIR-anchored prefix.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projection = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const { projectLocalHookPrefix, projectShellCommandText } = projection;

describe('bug #2557: Antigravity local hooks use relative paths (not $CLAUDE_PROJECT_DIR); gemini runtime removed (#1928)', () => {
  test('Antigravity local prefix is bare dirName', () => {
    // #2096: hookPathStyle is now the caller-supplied descriptor value
    // (bin/install.js resolves it from hostBehaviors.hookPathStyle); the
    // function itself no longer knows the runtime name 'antigravity'.
    assert.equal(
      projectLocalHookPrefix({ runtime: 'antigravity', dirName: '.agents', hookPathStyle: 'raw' }),
      '.agents',
    );
  });

  test('non-Antigravity local prefix remains $CLAUDE_PROJECT_DIR anchored', () => {
    assert.equal(
      projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' }),
      '"$CLAUDE_PROJECT_DIR"/.claude',
    );
  });

  test('an unrecognized runtime string (e.g. the former "gemini") falls through to $CLAUDE_PROJECT_DIR anchoring (#1928)', () => {
    const prefix = projectLocalHookPrefix({ runtime: 'gemini', dirName: '.gemini' });
    assert.equal(prefix, '"$CLAUDE_PROJECT_DIR"/.gemini');
    const command = projectShellCommandText({
      runnerToken: '"/usr/local/bin/node"',
      argTokens: [`${prefix}/hooks/gsd-check-update.js`],
      runtime: 'gemini',
      platform: 'linux',
    });
    assert.ok(
      command.includes('$CLAUDE_PROJECT_DIR'),
      'an unrecognized runtime must use the default anchored prefix, not the retired Gemini-only bare-path carve-out',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3413-shell-command-projection.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3413-shell-command-projection (consolidation epic #1969 B3 #1972)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projection = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const install = require(path.join(__dirname, '..', 'bin', 'install.js'));

const {
  hookCommandNeedsPowerShellCallOperator,
  formatHookCommandForRuntime,
  isManagedHookBasename,
  isManagedHookCommand,
  projectLocalHookPrefix,
  projectLegacySettingsHookCommand,
  projectPortableHookBaseDir,
} = projection;
const { buildHookCommand, rewriteLegacyManagedNodeHookCommands } = install;

describe('bug #3413: Shell Command Projection Module uses runtime-aware hook policy', () => {
  test('#1928: no current runtime needs the PowerShell call operator (seam inert after gemini removal)', () => {
    // Gemini CLI was the only runtime that needed `& ` on Windows; it was
    // removed (#1928, Google sunset 2026-06-18). Antigravity — the Gemini-backend
    // successor — never matched the old check, so it stays prefix-free. Lock the
    // now-inert contract so a future re-enable is a deliberate change.
    assert.equal(
      hookCommandNeedsPowerShellCallOperator({ platform: 'win32', runtime: 'antigravity' }),
      false,
    );
    assert.equal(
      formatHookCommandForRuntime('"C:/node.exe" "C:/hook.js"', { platform: 'win32', runtime: 'antigravity' }),
      '"C:/node.exe" "C:/hook.js"',
    );
  });

  test('Claude on Windows stays shell-neutral', () => {
    assert.equal(
      hookCommandNeedsPowerShellCallOperator({ platform: 'win32', runtime: 'claude' }),
      false,
    );
    assert.equal(
      formatHookCommandForRuntime('"C:/node.exe" "C:/hook.js"', { platform: 'win32', runtime: 'claude' }),
      '"C:/node.exe" "C:/hook.js"',
    );
  });

  test('runtime omitted stays conservative (no PowerShell prefix)', () => {
    assert.equal(
      formatHookCommandForRuntime('"C:/node.exe" "C:/hook.js"', { platform: 'win32' }),
      '"C:/node.exe" "C:/hook.js"',
    );
  });
});

describe('bug #2236: hookShell parameter routes PowerShell call operator', () => {
  test('hookShell=powershell on Windows returns true for any runtime', () => {
    assert.equal(
      hookCommandNeedsPowerShellCallOperator({ platform: 'win32', runtime: 'claude', hookShell: 'powershell' }),
      true,
      'PowerShell hook shell must trigger the call operator regardless of runtime',
    );
    assert.equal(
      hookCommandNeedsPowerShellCallOperator({ platform: 'win32', runtime: 'antigravity', hookShell: 'powershell' }),
      true,
    );
  });

  test('hookShell=bash (default) stays false — Git-Bash form preserved', () => {
    assert.equal(
      hookCommandNeedsPowerShellCallOperator({ platform: 'win32', runtime: 'claude', hookShell: 'bash' }),
      false,
    );
    assert.equal(
      hookCommandNeedsPowerShellCallOperator({ platform: 'win32', runtime: 'claude' }),
      false,
    );
  });

  test('formatHookCommandForRuntime prepends & when hookShell=powershell', () => {
    const cmd = '"C:/Program Files/nodejs/node.exe" "C:/Users/me/.claude/hooks/gsd-context-monitor.js"';
    assert.equal(
      formatHookCommandForRuntime(cmd, { platform: 'win32', runtime: 'claude', hookShell: 'powershell' }),
      `& ${cmd}`,
    );
  });

  test('formatHookCommandForRuntime omits & when hookShell unset (backward compat)', () => {
    const cmd = '"C:/Program Files/nodejs/node.exe" "C:/Users/me/.claude/hooks/gsd-context-monitor.js"';
    assert.equal(
      formatHookCommandForRuntime(cmd, { platform: 'win32', runtime: 'claude' }),
      cmd,
    );
  });

  test('buildHookCommand emits & prefix when hookShell=powershell', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-check-update.js', {
      platform: 'win32',
      runtime: 'claude',
      hookShell: 'powershell',
    });
    assert.ok(cmd, 'buildHookCommand should return a command');
    assert.ok(cmd.startsWith('& '), `PowerShell hook command must start with '& ': ${cmd}`);
  });

  test('buildHookCommand omits & prefix when hookShell=bash (regression lock)', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-check-update.js', {
      platform: 'win32',
      runtime: 'claude',
      hookShell: 'bash',
    });
    assert.ok(cmd, 'buildHookCommand should return a command');
    assert.equal(cmd.startsWith('& '), false, `Git-Bash hook command must NOT start with '& ': ${cmd}`);
  });
});

describe('bug #3413: installer hook surfaces consume runtime-aware projection', () => {
  test('buildHookCommand emits shell-neutral Claude hook command on Windows', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-check-update.js', {
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(cmd.startsWith('& '), false, `Claude hook command must not use PowerShell prefix: ${cmd}`);
  });

  test('rewriteLegacyManagedNodeHookCommands removes stale PowerShell prefix for Claude on Windows', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '& "/usr/local/bin/node" "C:/Users/me/.claude/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const changed = rewriteLegacyManagedNodeHookCommands(settings, '"/usr/local/bin/node"', {
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "C:/Users/me/.claude/hooks/gsd-check-update.js"',
    );
  });
});

describe('bug #3439: shell projection module owns managed-hook policy and legacy rewrite projection', () => {
  test('isManagedHookBasename is surface-aware', () => {
    assert.equal(isManagedHookBasename('/x/hooks/gsd-check-update.js', { surface: 'settings-json' }), true);
    assert.equal(isManagedHookBasename('/x/hooks/gsd-statusline.js', { surface: 'settings-json' }), true);
    assert.equal(isManagedHookBasename('/x/hooks/gsd-statusline.js', { surface: 'codex-toml' }), false);
    assert.equal(isManagedHookBasename('/x/hooks/custom-hook.js', { surface: 'settings-json' }), false);
  });

  test('projectLegacySettingsHookCommand preserves non-Windows script token shape', () => {
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: '"/usr/local/bin/node"',
      scriptPath: '/x/hooks/gsd-statusline.js',
      scriptToken: "'/x/hooks/gsd-statusline.js'",
      platform: 'linux',
      runtime: 'claude',
    });
    assert.equal(command, `"/usr/local/bin/node" '/x/hooks/gsd-statusline.js'`);
  });

  test('projectLegacySettingsHookCommand normalizes Windows managed paths and runtime wrapper policy', () => {
    // #1928: gemini runtime removed — the PowerShell call-operator seam is now
    // inert for every runtime (including the former 'gemini' string and its
    // Gemini-backend successor 'antigravity'). No `& ` prefix is ever added.
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: '"C:/nvm4w/nodejs/node.exe"',
      scriptPath: 'C:\\Users\\me\\.gemini\\hooks\\gsd-prompt-guard.js',
      scriptToken: "'C:\\Users\\me\\.gemini\\hooks\\gsd-prompt-guard.js'",
      platform: 'win32',
      runtime: 'antigravity',
    });
    assert.equal(command, '"C:/nvm4w/nodejs/node.exe" "C:/Users/me/.gemini/hooks/gsd-prompt-guard.js"');
  });

  test('projectLocalHookPrefix centralizes runtime-specific project-dir interpolation policy', () => {
    // #2096: 'raw' hookPathStyle (descriptor-driven) is what produces the
    // bare-dirName behavior now — the function no longer branches on the
    // 'antigravity' runtime name itself.
    assert.equal(
      projectLocalHookPrefix({ runtime: 'antigravity', dirName: '.agents', hookPathStyle: 'raw' }),
      '.agents',
    );
    assert.equal(
      projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' }),
      '"$CLAUDE_PROJECT_DIR"/.claude',
    );
    // #1928: gemini runtime removed — an unrecognized runtime string falls
    // through to the default $CLAUDE_PROJECT_DIR-anchored prefix.
    assert.equal(
      projectLocalHookPrefix({ runtime: 'gemini', dirName: '.gemini' }),
      '"$CLAUDE_PROJECT_DIR"/.gemini',
    );
  });

  test('projectPortableHookBaseDir centralizes $HOME interpolation policy', () => {
    assert.equal(
      projectPortableHookBaseDir({
        configDir: '/Users/me/.claude',
        homeDir: '/Users/me',
      }),
      '$HOME/.claude',
    );
    assert.equal(
      projectPortableHookBaseDir({
        configDir: 'C:\\Users\\me\\.claude',
        homeDir: 'C:\\Users\\me',
      }),
      '$HOME/.claude',
    );
    assert.equal(
      projectPortableHookBaseDir({
        configDir: '/opt/custom/.claude',
        homeDir: '/Users/me',
      }),
      '/opt/custom/.claude',
    );
  });

  test('isManagedHookCommand classifies managed settings hooks and leaves user commands untouched', () => {
    assert.equal(
      isManagedHookCommand('"/usr/local/bin/node" "/Users/me/.claude/hooks/gsd-statusline.js"', {
        surface: 'settings-json',
      }),
      true,
    );
    assert.equal(
      isManagedHookCommand('"C:/Program Files/Git/bin/bash.exe" "C:/Users/me/.claude/hooks/gsd-session-state.sh"', {
        surface: 'settings-json',
      }),
      true,
    );
    assert.equal(
      isManagedHookCommand('bash /Users/me/.claude/hooks/custom-lint.sh', {
        surface: 'settings-json',
      }),
      false,
    );
  });

  test('isManagedHookCommand supports codex surfaces and optional legacy alias matching', () => {
    const command = '"/usr/local/bin/node" "/Users/me/.codex/hooks/gsd-check-update.js"';
    assert.equal(
      isManagedHookCommand(command, {
        surface: 'codex-toml',
      }),
      true,
    );
    assert.equal(
      isManagedHookCommand('"/usr/local/bin/node" "/Users/me/.codex/hooks/gsd-update-check.js"', {
        surface: 'codex-toml',
      }),
      false,
    );
    assert.equal(
      isManagedHookCommand('"/usr/local/bin/node" "/Users/me/.codex/hooks/gsd-update-check.js"', {
        surface: 'codex-toml',
        includeLegacyAliases: true,
      }),
      true,
    );
  });
});

describe('#1693 regression: Windows legacy-node rewrite must not double-quote a "$CLAUDE_PROJECT_DIR"-anchored local hook path', () => {
  const winRunner = '"C:/Program Files/nodejs/node.exe"';

  // WHY: a local-install hook path already carries a `"$CLAUDE_PROJECT_DIR"`
  // anchored prefix (only the variable quoted, rest bare). On Windows the legacy
  // rewrite previously JSON.stringify'd the whole token, yielding
  // `"\"$CLAUDE_PROJECT_DIR\"/..."`. node then received an argument starting with
  // a literal `"`, treated it as relative, and died with MODULE_NOT_FOUND —
  // breaking every node managed hook at once (self-locking deadlock).
  test('projectLegacySettingsHookCommand emits the anchored path verbatim, not re-quoted', () => {
    const anchored = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js';
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: winRunner,
      scriptPath: anchored,
      scriptToken: anchored,
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(
      command,
      '"C:/Program Files/nodejs/node.exe" "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js',
    );
    assert.ok(!command.includes('\\"'), 'must not contain escaped double-quotes');
  });

  // WHY: the fix must be surgical — a BARE absolute Windows path (no anchored
  // prefix) can contain spaces ("Program Files") and still REQUIRES quoting.
  test('projectLegacySettingsHookCommand still quotes a bare absolute Windows path', () => {
    const abs = 'C:/Program Files App/.claude/hooks/gsd-context-monitor.js';
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: winRunner,
      scriptPath: abs,
      scriptToken: JSON.stringify(abs),
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(
      command,
      '"C:/Program Files/nodejs/node.exe" "C:/Program Files App/.claude/hooks/gsd-context-monitor.js"',
    );
  });

  // WHY: the anchored short-circuit is scoped to win32. On POSIX the rewrite
  // already preserved the caller's original `scriptToken` and never had the
  // double-quote bug, so that behavior must be left byte-identical. scriptPath
  // is anchored but scriptToken is a DISTINCT single-quoted value: if the
  // win32 gate were removed, the anchored short-circuit would emit scriptPath
  // and this assertion would fail — that is what pins the gate.
  test('projectLegacySettingsHookCommand preserves the original scriptToken for anchored paths on POSIX', () => {
    const command = projectLegacySettingsHookCommand({
      absoluteRunner: '"/usr/local/bin/node"',
      scriptPath: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-statusline.js',
      scriptToken: "'/x/hooks/gsd-statusline.js'",
      platform: 'linux',
      runtime: 'claude',
    });
    assert.equal(command, `"/usr/local/bin/node" '/x/hooks/gsd-statusline.js'`);
  });

  // WHY: end-to-end through the installer rewrite — the actual #2979 path that
  // ran during the user's 1.5.0 -> 1.6.0 local update. Managed node hooks get
  // the absolute runner + clean anchored path; a non-node-prefixed managed .sh
  // hook (already correct) is left untouched.
  test('rewriteLegacyManagedNodeHookCommands produces clean anchored node commands on Windows', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              { command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js' },
            ],
          },
        ],
      },
    };
    const changed = rewriteLegacyManagedNodeHookCommands(settings, winRunner, {
      platform: 'win32',
      runtime: 'claude',
    });
    assert.equal(changed, true);
    const rewritten = settings.hooks.PostToolUse[0].hooks[0].command;
    assert.equal(
      rewritten,
      '"C:/Program Files/nodejs/node.exe" "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-context-monitor.js',
    );
    assert.ok(!rewritten.includes('\\"'), 'rewritten command must not contain escaped double-quotes');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3441-path-action-projection.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3441-path-action-projection (consolidation epic #1969 B3 #1972)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const projection = require(path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'lib',
  'shell-command-projection.cjs',
));
const install = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { withIsolatedProcessState, cleanup } = require('./helpers.cjs');

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-home-3441-'));
}


describe('bug #3441: PATH guidance is projected from typed shell action IR', () => {
  test('projection module exports PATH action projection helper', () => {
    assert.equal(typeof projection.projectPathActionProjection, 'function');
  });

  // (formatSdkPathDiagnostic removed with the gsd-sdk shim, #191 — the PATH
  // action projection it wrapped is still covered by the tests below.)

  test('persistent PATH export guidance is projected via the same seam', () => {
    const posix = projection.projectPathActionProjection({
      mode: 'persist',
      targetDir: '/tmp/with quote',
      platform: 'linux',
    });
    assert.ok(Array.isArray(posix.shellActions));
    assert.equal(posix.shellActions.length, 3);
    assert.equal(posix.shellActions[0].label, 'zsh');
    assert.equal(posix.shellActions[1].label, 'bash');
    assert.equal(posix.shellActions[2].label, 'fish');
    assert.ok(posix.shellActions[0].command.includes('~/.zshrc'));
    assert.ok(posix.shellActions[1].command.includes('~/.bashrc'));
    // #323: fish gets a fish-native fish_add_path suggestion, not `export`.
    assert.ok(posix.shellActions[2].command.startsWith('fish_add_path '));
    assert.ok(!posix.shellActions[2].command.includes('export'));
  });

  // #323 (ported from the closed #721): the fish suggestion is POSIX-only.
  // On win32 the persist branch projects PowerShell / cmd.exe / Git Bash —
  // no fish action — locking the POSIX-only contract.
  test('no fish action is projected on win32', () => {
    const win = projection.projectPathActionProjection({
      mode: 'persist',
      targetDir: 'C:\\Users\\me\\AppData\\npm',
      platform: 'win32',
    });
    assert.ok(Array.isArray(win.shellActions));
    assert.equal(
      win.shellActions.some((a) => a.shell === 'fish' || a.label === 'fish'),
      false,
      'win32 persist projection must not include a fish action',
    );
    assert.deepEqual(
      win.shellActions.map((a) => a.label),
      ['PowerShell', 'cmd.exe', 'Git Bash'],
    );
  });

  test('POSIX repair mode escapes double-quoted shell metacharacters', () => {
    const projected = projection.projectPathActionProjection({
      mode: 'repair',
      targetDir: '/tmp/qa\\"$HOME`tick',
      platform: 'linux',
    });
    assert.equal(projected.shellActions.length, 1);
    assert.equal(
      projected.shellActions[0].command,
      'export PATH="/tmp/qa\\\\\\"\\$HOME\\`tick:$PATH"',
    );
  });

  test('POSIX persist mode escapes single quotes for rc-file echo commands', () => {
    const projected = projection.projectPathActionProjection({
      mode: 'persist',
      targetDir: "/tmp/O'Neil/bin",
      platform: 'linux',
    });
    assert.equal(projected.shellActions[0].command.includes("/tmp/O'\\''Neil/bin"), true);
    assert.equal(projected.shellActions[1].command.includes("/tmp/O'\\''Neil/bin"), true);
    // #323: fish entry single-quotes the dir with the same POSIX literal
    // escaping (`'\''` is also a valid escaped quote in fish unquoted context).
    // #3118: `--` is fish's end-of-options separator, added so a leading-dash
    // directory name is not misparsed as a flag; every fish_add_path lane carries it now.
    assert.equal(projected.shellActions[2].command, "fish_add_path -- '/tmp/O'\\''Neil/bin'");
  });

  test('maybeSuggestPathExport renders commands projected by path-action seam', () => {
    const home = createTempHome();
    try {
      withIsolatedProcessState(() => {
        const globalBin = path.join(home, '.npm-global', 'bin');
        fs.mkdirSync(globalBin, { recursive: true });
        fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH="$HOME/.cargo/bin:$PATH"\n');
        process.env.PATH = '';

        const expected = projection.projectPathActionProjection({
          mode: 'persist',
          targetDir: globalBin,
          platform: process.platform,
        });

        const logs = [];
        const originalLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        try {
          install.maybeSuggestPathExport(globalBin, home);
        } finally {
          console.log = originalLog;
        }

        const joined = logs.join('\n');
        for (const action of expected.shellActions) {
          assert.ok(
            joined.includes(action.command),
            `expected installer output to include projected command: ${action.command}\nOutput:\n${joined}`,
          );
        }
      });
    } finally {
      cleanup(home);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-580-local-sh-hook-bash-wrapper.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-580-local-sh-hook-bash-wrapper (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Regression test for bug #580.
 *
 * LOCAL install under Claude Code on Windows: managed `.sh` hooks were emitted
 * wrapped with an absolute `bash.exe` path via the `localShellCmd` arrow.
 * Since Claude Code runs hook command strings INSIDE Git Bash, bash tries to
 * exec bash → "cannot execute binary file".
 *
 * The GLOBAL path (`buildHookCommand`) already guarded win32+claude+.sh (#166).
 * The LOCAL path (`localShellCmd`) did not. Fix: add `buildLocalShellHookCommand`
 * and `shellHookOmitsBashRunner` to shell-command-projection.cjs, and use
 * `buildLocalShellHookCommand` from install.js local-install path.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projection = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const { buildLocalShellHookCommand, shellHookOmitsBashRunner, projectLocalHookPrefix } = projection;

describe('bug #580: local .sh hooks on Claude/Windows must NOT wrap with bash.exe', () => {
  test('local .sh hook on Claude/Windows omits the bash.exe wrapper (#580)', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const result = buildLocalShellHookCommand({
      localPrefix,
      hookFile: 'gsd-session-state.sh',
      bashRunner: '"C:/Program Files/Git/bin/bash.exe"',
      runtime: 'claude',
      platform: 'win32',
    });
    assert.equal(result, '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-session-state.sh');
    assert.ok(!result.includes('bash.exe'), `result must not contain bash.exe, got: ${result}`);
  });

  test('local .sh hook on Claude/Windows still emits script path when bash.exe is unresolved', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const result = buildLocalShellHookCommand({
      localPrefix,
      hookFile: 'gsd-session-state.sh',
      bashRunner: null,
      runtime: 'claude',
      platform: 'win32',
    });
    assert.equal(result, '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-session-state.sh');
  });

  test('local .sh hook on POSIX keeps the bash runner', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const result = buildLocalShellHookCommand({
      localPrefix,
      hookFile: 'gsd-session-state.sh',
      bashRunner: 'bash',
      runtime: 'claude',
      platform: 'linux',
    });
    assert.equal(result, 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-session-state.sh');
  });

  test('local .sh hook on Windows non-Claude runtime keeps the bash runner', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'codex', dirName: '.claude' });
    const result = buildLocalShellHookCommand({
      localPrefix,
      hookFile: 'gsd-session-state.sh',
      bashRunner: '"C:/Program Files/Git/bin/bash.exe"',
      runtime: 'codex',
      platform: 'win32',
    });
    assert.ok(result.includes('bash.exe'), `result must contain bash.exe, got: ${result}`);
    assert.ok(result.startsWith('"C:/Program Files/Git/bin/bash.exe"'), `result must start with bash.exe token, got: ${result}`);
  });

  test('all four managed local .sh hooks drop the wrapper on Claude/Windows', () => {
    const localPrefix = projectLocalHookPrefix({ runtime: 'claude', dirName: '.claude' });
    const hooks = [
      'gsd-session-state.sh',
      'gsd-validate-commit.sh',
      'gsd-graphify-update.sh',
      'gsd-phase-boundary.sh',
    ];
    for (const f of hooks) {
      const result = buildLocalShellHookCommand({
        localPrefix,
        hookFile: f,
        bashRunner: '"C:/Program Files/Git/bin/bash.exe"',
        runtime: 'claude',
        platform: 'win32',
      });
      assert.equal(
        result,
        `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${f}`,
        `expected script-only path for ${f}, got: ${result}`,
      );
      assert.ok(!result.includes('bash.exe'), `result for ${f} must not contain bash.exe, got: ${result}`);
    }
  });

  test('shellHookOmitsBashRunner truth table', () => {
    // true only for win32 + claude + isShellHook:true
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'claude', isShellHook: true }), true);

    // false for win32 + claude + isShellHook:false
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'claude', isShellHook: false }), false);

    // false for win32 + codex + isShellHook:true
    assert.equal(shellHookOmitsBashRunner({ platform: 'win32', runtime: 'codex', isShellHook: true }), false);

    // false for linux + claude + isShellHook:true
    assert.equal(shellHookOmitsBashRunner({ platform: 'linux', runtime: 'claude', isShellHook: true }), false);

    // false for default args (no win32, no claude)
    assert.equal(shellHookOmitsBashRunner(), false);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3595-fs-fault-injection-atomic-write.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3595-fs-fault-injection-atomic-write (consolidation epic #1969 B3 #1972)", () => {
/**
 * Filesystem fault-injection coverage for the canonical atomic-write
 * seam (#3595).
 *
 * `platformWriteSync` in `gsd-core/bin/lib/shell-command-projection.cjs`
 * is the shared seam every config/state/generated-artifact writer in
 * the CJS layer routes through. Its contract:
 *
 *   1. mkdirSync(dirname, { recursive: true }) — ensure parent exists.
 *   2. writeFileSync(<tmpPath>, content) — write to a sibling tmpfile
 *      named `<filePath>.tmp.<pid>`.
 *   3. renameSync(<tmpPath>, filePath) — atomic publish.
 *   4. On any error in steps 2-3: unlinkSync(<tmpPath>) (best-effort)
 *      then writeFileSync(filePath, content) directly as a fallback.
 *
 * Per CONTRIBUTING.md §"QA Matrix Requirements / Filesystem writes and
 * installers" the tests below use `mock.method()` against the real `fs`
 * seam to drive each fault mode, restore mocks with `t.after()`, and
 * assert on observable post-conditions (file existence, content,
 * presence/absence of orphan tmp files, propagated error code) — not
 * on prose.
 *
 * Pre-existing behavior gaps surfaced and PINNED (not fixed in this
 * PR — #3595 is test coverage, fixes belong in separate issues):
 *
 *   - The "fall back to direct write" branch silently swallows the
 *     ORIGINAL error from the tmp+rename path. If the fallback ALSO
 *     fails, the operator only sees the fallback's error — not the
 *     original cause. Tests document this.
 *   - On EACCES against the parent directory mkdir, the error
 *     escapes (no try/catch around mkdirSync). Pinned.
 */

'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  platformWriteSync,
  platformEnsureDir,
} = require('../gsd-core/bin/lib/shell-command-projection.cjs');

/**
 * Create a fresh real-fs scratch dir per test so no two faults share
 * state. Returns the directory; caller must clean up.
 */
const { createTempDir, cleanup } = require('./helpers.cjs');
const mkScratch = (name) => createTempDir(`fs-fault-${name}-`);

/**
 * Enumerate orphan tmp files left behind by platformWriteSync. The
 * tmp shape is `<filename>.tmp.<pid>`; we match that pattern strictly
 * so a test that happens to write a real `*.tmp.123` doesn't get a
 * false positive.
 */
function orphanTmpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /\.tmp\.\d+$/.test(n));
}

// ─── Happy path baseline ────────────────────────────────────────────────────

test('platformWriteSync happy path writes content atomically (baseline for fault tests)', (t) => {
  const dir = mkScratch('happy');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'config.json');
  platformWriteSync(file, '{"k":"v"}\n');
  assert.equal(fs.readFileSync(file, 'utf-8'), '{"k":"v"}\n');
  assert.deepEqual(orphanTmpFiles(dir), [], 'happy path must leave no orphan tmp file');
});

// ─── Rename failure → falls back to direct write ────────────────────────────

test('platformWriteSync recovers when renameSync fails (EXDEV cross-device fallback)', (t) => {
  const dir = mkScratch('exdev');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'config.json');

  // Simulate rename failing once (e.g. cross-device move on a CI runner
  // with overlayfs). The fallback path must write the content directly.
  let renameCalls = 0;
  const renameMock = mock.method(fs, 'renameSync', (_src, _dest) => {
    renameCalls++;
    const err = new Error('EXDEV: cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  });
  t.after(() => renameMock.mock.restore());

  platformWriteSync(file, 'fallback content\n');

  // File exists and has the new content — fallback wrote it directly.
  assert.equal(fs.readFileSync(file, 'utf-8'), 'fallback content\n');
  assert.equal(renameCalls, 1, 'renameSync was called exactly once before falling back');
  // The tmp file was unlinked by the fallback path's best-effort cleanup.
  assert.deepEqual(orphanTmpFiles(dir), [], 'tmp file must be cleaned up after rename failure');
});

// ─── #1540: transient Windows lock (EPERM/EBUSY/EACCES) is RETRIED, never
//            fallen back to a non-atomic truncating write ───────────────────

test('platformWriteSync retries a transient EPERM rename and publishes atomically (#1540)', (t) => {
  const dir = mkScratch('eperm-transient');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'STATE.md');

  // A reader briefly holds the target open → rename throws EPERM once, then clears.
  let renameCalls = 0;
  const originalRename = fs.renameSync;
  const renameMock = mock.method(fs, 'renameSync', (src, dest) => {
    renameCalls++;
    if (renameCalls === 1) {
      const err = new Error('EPERM: a reader holds the target open');
      err.code = 'EPERM';
      throw err;
    }
    return originalRename.call(fs, src, dest);
  });
  t.after(() => renameMock.mock.restore());

  platformWriteSync(file, 'published\n');

  assert.equal(renameCalls, 2, 'rename retried after a transient EPERM (not a single-shot non-atomic fallback)');
  assert.equal(fs.statSync(file).isFile(), true);
  assert.ok(fs.statSync(file).size > 0, 'target published, not truncated');
  assert.deepEqual(orphanTmpFiles(dir), [], 'atomic publish leaves no tmp orphan');
});

test('platformWriteSync surfaces a PERSISTENT EPERM instead of truncating a concurrent reader (#1540)', (t) => {
  const dir = mkScratch('eperm-persistent');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'STATE.md');
  // A reader is mid-read on `file` with known content. The old blanket fallback
  // would non-atomically writeFileSync over it — truncating the reader. The fix
  // must surface the error and leave the existing file byte-for-byte intact.
  fs.writeFileSync(file, 'OLD CONTENT A READER IS MID-READ ON\n');
  const sizeBefore = fs.statSync(file).size;

  let renameCalls = 0;
  const renameMock = mock.method(fs, 'renameSync', () => {
    renameCalls++;
    const err = new Error('EPERM: reader holds the target open');
    err.code = 'EPERM';
    throw err;
  });
  t.after(() => renameMock.mock.restore());

  let caught;
  try {
    platformWriteSync(file, 'NEW CONTENT\n');
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'a persistent rename lock must surface as an error, not a silent truncating write');
  assert.equal(caught.code, 'EPERM');
  assert.equal(renameCalls, 3, 'rename retried up to the bounded limit before surfacing');
  // Negative proof: the concurrent reader's file was NOT truncated/overwritten.
  assert.equal(fs.statSync(file).size, sizeBefore, 'target left intact — no non-atomic write happened');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'OLD CONTENT A READER IS MID-READ ON\n');
  assert.deepEqual(orphanTmpFiles(dir), [], 'tmp cleaned up after surfacing the error');
});

// ─── Tmp write failure → falls back to direct write ─────────────────────────

test('platformWriteSync falls back when initial tmp writeFileSync fails (ENOSPC)', (t) => {
  const dir = mkScratch('enospc');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'config.json');

  // Make the FIRST writeFileSync (to .tmp.<pid>) fail with ENOSPC. The
  // SECOND writeFileSync (the fallback, direct to filePath) succeeds.
  let writeCalls = 0;
  const realWrite = fs.writeFileSync;
  const writeMock = mock.method(fs, 'writeFileSync', function (target, data, opts) {
    writeCalls++;
    if (writeCalls === 1) {
      // First call is to the tmp path.
      assert.match(String(target), /\.tmp\.\d+$/, 'first write must be to the tmp path');
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    }
    // Second call is the fallback to the real target.
    assert.equal(target, file, 'fallback write must target the original file path');
    return realWrite.call(fs, target, data, opts);
  });
  t.after(() => writeMock.mock.restore());

  platformWriteSync(file, 'recovered\n');

  assert.equal(writeCalls, 2, 'expected exactly 2 writeFileSync calls (tmp fail + fallback)');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'recovered\n');
  // The fallback path tries unlinkSync on the tmp; the tmp never
  // existed (its write failed), so unlink throws ENOENT and is
  // swallowed by the inner catch. Either way: no orphan.
  assert.deepEqual(orphanTmpFiles(dir), []);
});

// ─── Both attempts fail → error propagates (pinned current behavior) ────────

test('platformWriteSync propagates the FALLBACK error when both tmp and fallback writes fail', (t) => {
  const dir = mkScratch('double-fail');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'config.json');

  let writeCalls = 0;
  const writeMock = mock.method(fs, 'writeFileSync', function () {
    writeCalls++;
    const err = new Error(
      writeCalls === 1
        ? 'ENOSPC: original failure on tmp write'
        : 'EACCES: permission denied on fallback write',
    );
    err.code = writeCalls === 1 ? 'ENOSPC' : 'EACCES';
    throw err;
  });
  t.after(() => writeMock.mock.restore());

  // The current implementation does NOT chain the original cause; the
  // fallback's error is what surfaces. This test pins that behavior so a
  // future "preserve original error in .cause" fix is a visible change
  // (open follow-up).
  let caught;
  try {
    platformWriteSync(file, 'wont-write\n');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'double-failure must throw');
  assert.equal(caught.code, 'EACCES', 'currently the fallback error wins (open: should chain via .cause)');
  // The original file was never created.
  assert.equal(fs.existsSync(file), false);
  // No orphan tmp left because the tmp write failed before any file was created.
  assert.deepEqual(orphanTmpFiles(dir), []);
});

// ─── mkdirSync failure → escapes immediately (no try/catch upstream) ────────

test('platformWriteSync propagates mkdirSync failure unchanged (no swallowed parent-dir errors)', (t) => {
  const dir = mkScratch('mkdir-fail');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'deep', 'nested', 'config.json');

  const mkdirMock = mock.method(fs, 'mkdirSync', () => {
    const err = new Error('EACCES: permission denied creating directory');
    err.code = 'EACCES';
    throw err;
  });
  t.after(() => mkdirMock.mock.restore());

  let caught;
  try {
    platformWriteSync(file, 'never-reached\n');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'mkdir failure must propagate');
  assert.equal(caught.code, 'EACCES', 'mkdir error code must be preserved');
  // No partial write happened.
  assert.equal(fs.existsSync(file), false);
});

// ─── Target path is a directory (writing OVER a dir is undefined) ──────────

test('platformWriteSync against a target path that is an existing directory fails cleanly', (t) => {
  const dir = mkScratch('target-is-dir');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'collides');
  // Pre-create the target AS a directory so the rename step would
  // collide with a directory at the destination.
  fs.mkdirSync(file);

  let caught;
  try {
    platformWriteSync(file, 'shouldnt-overwrite-dir\n');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'writing over an existing directory must fail');
  // We don't pin the exact code (Node varies: EISDIR on rename, EPERM on
  // some platforms). We pin: a real error code (string starting with E)
  // surfaces, AND the directory was not replaced by a file.
  assert.equal(typeof caught.code, 'string');
  assert.match(caught.code, /^E[A-Z]+$/, `expected an errno-style code, got ${caught.code}`);
  assert.equal(fs.statSync(file).isDirectory(), true, 'pre-existing directory must remain a directory');
});

// ─── Path with spaces, unicode, newline characters ─────────────────────────

test('platformWriteSync handles paths with spaces, unicode, and newline characters', (t) => {
  const dir = mkScratch('weird-path');
  t.after(() => cleanup(dir));
  const cases = [
    'has spaces in name.json',
    'unicode-日本語-name.json',
  ];
  if (process.platform !== 'win32') {
    // Tab (0x09) and newline (0x0A) in filenames are POSIX-valid but
    // Windows-illegal (NTFS forbids control characters 0x00–0x1F). Append
    // both only on POSIX so cross-platform CI stays green.
    cases.push('with\ttab.json');
    cases.push('with\nnewline.json');
  }

  for (const name of cases) {
    const file = path.join(dir, name);
    platformWriteSync(file, `payload for ${name}\n`);
    assert.equal(
      fs.readFileSync(file, 'utf-8'),
      `payload for ${name}\n`,
      `roundtrip failed for path "${JSON.stringify(name)}"`,
    );
  }
  assert.deepEqual(orphanTmpFiles(dir), [], 'no tmp orphans across the corpus');
});

// ─── Orphan-tmp cleanup invariant ──────────────────────────────────────────

test('platformWriteSync never leaks a tmp file after a successful happy-path write', (t) => {
  const dir = mkScratch('no-orphan-happy');
  t.after(() => cleanup(dir));
  for (let i = 0; i < 25; i++) {
    platformWriteSync(path.join(dir, `f-${i}.json`), `{"i":${i}}\n`);
  }
  // 25 real files, 0 tmp orphans.
  const entries = fs.readdirSync(dir);
  const tmpCount = entries.filter((n) => /\.tmp\.\d+$/.test(n)).length;
  const realCount = entries.length - tmpCount;
  assert.equal(realCount, 25);
  assert.equal(tmpCount, 0);
});

// ─── platformEnsureDir is idempotent and chains errors ─────────────────────

test('platformEnsureDir is idempotent on an existing directory', (t) => {
  const dir = mkScratch('ensure-idem');
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'a', 'b', 'c');
  // First call creates; subsequent calls must not throw EEXIST.
  platformEnsureDir(target);
  assert.equal(fs.statSync(target).isDirectory(), true);
  // Repeat.
  platformEnsureDir(target);
  platformEnsureDir(target);
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test('platformEnsureDir propagates EACCES when parent dir is unwritable', (t) => {
  const dir = mkScratch('ensure-fail');
  t.after(() => cleanup(dir));

  const mkdirMock = mock.method(fs, 'mkdirSync', () => {
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    throw err;
  });
  t.after(() => mkdirMock.mock.restore());

  let caught;
  try {
    platformEnsureDir(path.join(dir, 'cannot-create'));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'EACCES');
});

// ─── Symlink-following / escape behavior ────────────────────────────────────

test('platformWriteSync REPLACES a symlink with a regular file rather than following it (safe behavior)', (t) => {
  // Security-relevant invariant: if the destination path is a symlink
  // pointing somewhere the user did not intend the writer to touch
  // (e.g. an attacker-planted symlink in `.planning/` pointing at
  // `~/.ssh/authorized_keys`), the writer must NOT follow it and
  // clobber the target. The rename-based atomic-write pattern delivers
  // this property: `renameSync(tmp, symlinkPath)` replaces the symlink
  // entry in the parent directory with the regular file at `tmp`.
  // After the call:
  //   - `linkPath` is a regular file with the new content.
  //   - The original `realTarget` is UNTOUCHED.
  // This test pins that property so a future refactor (e.g. switching
  // to `fs.writeFileSync(linkPath, ...)` which follows symlinks) is a
  // visible regression.
  if (process.platform === 'win32') {
    t.skip('symlinks on Win32 need admin');
    return;
  }

  const dir = mkScratch('symlink-replace');
  t.after(() => cleanup(dir));

  const realTarget = path.join(dir, 'real-target.json');
  fs.writeFileSync(realTarget, 'original — must not be touched\n');
  const linkPath = path.join(dir, 'link.json');
  fs.symlinkSync(realTarget, linkPath);

  platformWriteSync(linkPath, 'new content\n');

  // The real target is UNTOUCHED — the safety property.
  assert.equal(
    fs.readFileSync(realTarget, 'utf-8'),
    'original — must not be touched\n',
    'symlink target must be preserved when writer writes "through" the link',
  );
  // The link entry is now a regular file with the new content.
  const stat = fs.lstatSync(linkPath);
  assert.equal(stat.isSymbolicLink(), false, 'symlink entry replaced by a regular file (atomic rename semantics)');
  assert.equal(stat.isFile(), true);
  assert.equal(fs.readFileSync(linkPath, 'utf-8'), 'new content\n');
});

test('platformWriteSync against a broken symlink replaces it with the intended file', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlinks on Win32 need admin');
    return;
  }
  const dir = mkScratch('symlink-broken');
  t.after(() => cleanup(dir));
  const link = path.join(dir, 'dangling.json');
  fs.symlinkSync(path.join(dir, 'does-not-exist'), link);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'pre-check: link is dangling');

  platformWriteSync(link, 'real content\n');

  assert.equal(fs.readFileSync(link, 'utf-8'), 'real content\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false, 'broken link replaced with regular file');
});

// ─── Concurrent-write collision ────────────────────────────────────────────

test('platformWriteSync survives a concurrent collision on the same target path', (t) => {
  // Two consecutive writes to the same path with DIFFERENT contents,
  // separated by a setImmediate boundary so the second can interleave
  // a mock-injected error mid-flight. The contract pinned here: after
  // both writes complete, the file is parseable and contains ONE of the
  // two contents — never a half-written corrupt blob.
  //
  // (True parallel writes from separate processes are out of scope —
  // the writer is sync. This exercises mid-flight error recovery, which
  // is the same concurrency hazard at a lower granularity.)
  const dir = mkScratch('concurrent');
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'race.json');

  // First write completes normally.
  platformWriteSync(file, '{"writer":"first"}\n');
  // Second write: inject a transient EBUSY on the first rename attempt,
  // then succeed on the bounded retry (#1540). Capture the real renameSync
  // BEFORE installing the mock so the retry attempt delegates to the real
  // implementation. The previous form referenced a non-existent
  // `fs.renameSync.wrapped` property — that branch would silently no-op
  // instead of delegating.
  let renameCalls = 0;
  const originalRename = fs.renameSync;
  const renameMock = mock.method(fs, 'renameSync', (src, dest) => {
    renameCalls++;
    if (renameCalls === 1) {
      const err = new Error('EBUSY: file is locked');
      err.code = 'EBUSY';
      throw err;
    }
    return originalRename.call(fs, src, dest);
  });
  t.after(() => renameMock.mock.restore());

  platformWriteSync(file, '{"writer":"second"}\n');

  // The bounded retry re-published the 'second' content atomically.
  const final = fs.readFileSync(file, 'utf-8');
  // Must be valid JSON — never a half-merged corruption.
  assert.doesNotThrow(() => JSON.parse(final), 'file must remain parseable after the contested write');
  // Must be the SECOND writer's content (it called platformWriteSync
  // after the first, and the fallback completed).
  assert.equal(final, '{"writer":"second"}\n');
  assert.deepEqual(orphanTmpFiles(dir), [], 'no tmp orphans after the contested write');
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #3118 — failing-first coverage for a path-export projection API that does
// not exist yet in this module (projectPathExportLine, escapeCmdDoubleQuotedArgument).
// These tests are EXPECTED TO FAIL until that API lands.
// ────────────────────────────────────────────────────────────────────────

describe('path export projection — escaping (#3118)', () => {
  const laneCommand = (mode, targetDir, platform, shell) => {
    const { shellActions } = projectPathActionProjection({ mode, targetDir, platform });
    const a = shellActions.find((x) => x.shell === shell);
    return a ? a.command : null;
  };

  // The fish lane is the ONE deliberate output change for ordinary paths: fish_add_path
  // misparses a leading-dash directory name without the `--` end-of-options separator
  // (#3118 review finding), so every path — hostile or ordinary — now gets `--` on the
  // fish lane. Every other lane (posix export, zsh/bash echo, PowerShell, cmd) remains
  // byte-identical for an ordinary path.
  test('leaves an ordinary path unchanged on every lane except fish', () => {
    const repairLinux = projectPathActionProjection({ mode: 'repair', targetDir: '/usr/local/bin', platform: 'linux' });
    assert.deepEqual(repairLinux.shellActions, [
      { label: null, shell: 'posix', command: 'export PATH="/usr/local/bin:$PATH"' },
    ]);
    assert.deepEqual(repairLinux.actionLines, [
      'export PATH="/usr/local/bin:$PATH"',
    ]);

    const persistLinux = projectPathActionProjection({ mode: 'persist', targetDir: '/usr/local/bin', platform: 'linux' });
    assert.deepEqual(persistLinux.shellActions, [
      { label: 'zsh', shell: 'zsh', command: `echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.zshrc` },
      { label: 'bash', shell: 'bash', command: `echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.bashrc` },
      { label: 'fish', shell: 'fish', command: `fish_add_path -- '/usr/local/bin'` },
    ]);
    assert.deepEqual(persistLinux.actionLines, [
      `zsh: echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.zshrc`,
      `bash: echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.bashrc`,
      `fish: fish_add_path -- '/usr/local/bin'`,
    ]);

    const repairWin32 = projectPathActionProjection({ mode: 'repair', targetDir: 'C:/Users/dev/bin', platform: 'win32' });
    assert.deepEqual(repairWin32.shellActions, [
      {
        label: 'PowerShell',
        shell: 'powershell',
        command: `[Environment]::SetEnvironmentVariable('PATH', 'C:/Users/dev/bin;' + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')`,
      },
      {
        label: 'cmd.exe',
        shell: 'cmd',
        command: `powershell -Command "[Environment]::SetEnvironmentVariable('PATH', 'C:/Users/dev/bin;' + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')"`,
      },
      {
        label: 'Git Bash',
        shell: 'bash',
        command: `echo 'export PATH="C:/Users/dev/bin:$PATH"' >> ~/.bashrc`,
      },
    ]);
  });

  test('the fish lane gains the end-of-options separator for every path', () => {
    const command = laneCommand('persist', '/usr/local/bin', 'linux', 'fish');
    assert.equal(command, `fish_add_path -- '/usr/local/bin'`);
  });

  test('does not write a command substitution into the rc file', () => {
    const { escapedDir } = projectPathExportLine('/tmp/a$(id)b');
    assert.equal(escapedDir, '/tmp/a\\$(id)b');
  });

  test('does not write a backtick substitution into the rc file', () => {
    const { escapedDir } = projectPathExportLine('/tmp/a`whoami`b');
    assert.equal(escapedDir, '/tmp/a\\`whoami\\`b');
  });

  test('keeps the persisted rc line quote-balanced', () => {
    const { escapedDir } = projectPathExportLine('/tmp/a"b');
    assert.equal(escapedDir, '/tmp/a\\"b');
  });

  test('escapes a backslash in the persisted line', () => {
    const { escapedDir } = projectPathExportLine('/tmp/a\\b');
    assert.equal(escapedDir, '/tmp/a\\\\b');
  });

  // #3118 review finding (now fixed): the other four escapers' target contexts
  // (PowerShell single-quoted, POSIX double-quoted, POSIX single-quoted, and the win32
  // JSON.stringify-based hook token) all treat a raw newline/CR/NUL as literal data that
  // stays inside the quoting/escaping without breaking out, so those four DO survive
  // intact and are pinned exactly below. escapeTomlDoubleQuotedString is exercised
  // separately below — it now escapes TOML's required control-character ranges rather
  // than passing them through raw.
  test('the escapers survive newlines and null bytes', () => {
    const cases = [
      ['\n', '\n', 'a\\nb'],
      ['\r\n', '\r\n', 'a\\r\\nb'],
      ['\0', '\0', 'a\\u0000b'],
    ];
    for (const [raw, , tomlExpected] of cases) {
      const value = `a${raw}b`;
      assert.equal(escapePowerShellSingleQuoted(value), `a${raw}b`);
      assert.equal(escapePosixDoubleQuoted(value), `a${raw}b`);
      assert.equal(escapeSingleQuotedShellLiteral(value), `a${raw}b`);
      assert.equal(formatManagedHookScriptToken(value, { platform: 'win32' }), JSON.stringify(`a${raw}b`));
      assert.equal(escapeTomlDoubleQuotedString(value), tomlExpected);
    }
  });

  // TOML v1.0.0 basic-string grammar (https://toml.io/en/v1.0.0#string): a basic string
  // must escape the quotation mark, backslash, and control characters other than tab
  // (U+0000-U+0008, U+000A-U+001F, U+007F). Compact escapes (\b \t \n \f \r \" \\) are
  // used where TOML defines them; every other required character falls back to \uXXXX.
  // Tab (U+0009) is explicitly excluded from the "must escape" set, so it passes through
  // unescaped. Exact expected outputs below were derived by running the built function
  // (see dispatch report table).
  test('escapes control characters to a parseable TOML basic string', () => {
    assert.equal(escapeTomlDoubleQuotedString('\n'), '\\n');
    assert.equal(escapeTomlDoubleQuotedString('\r'), '\\r');
    assert.equal(escapeTomlDoubleQuotedString('\r\n'), '\\r\\n');
    assert.equal(escapeTomlDoubleQuotedString('\0'), '\\u0000');
    assert.equal(escapeTomlDoubleQuotedString('\t'), '\t');
    assert.equal(escapeTomlDoubleQuotedString('\b'), '\\b');
    assert.equal(escapeTomlDoubleQuotedString('\f'), '\\f');
    assert.equal(escapeTomlDoubleQuotedString('\x1F'), '\\u001f');
    assert.equal(escapeTomlDoubleQuotedString('\x7F'), '\\u007f');
    // Ordering pin: backslash escaped FIRST (doubled), then quote, then control chars —
    // so a backslash introduced by an earlier escape step is never re-escaped.
    assert.equal(escapeTomlDoubleQuotedString('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
  });

  test('leaves an ordinary value byte-identical', () => {
    const value = 'C:/Users/dev/gsd.js';
    assert.equal(escapeTomlDoubleQuotedString(value), value);
  });

  test('produces a TOML basic string that parses back to the original', () => {
    // No built-in or dependency TOML parser is available in this environment (Node has
    // no built-in TOML support, and neither `toml` nor `@iarna/toml` nor `smol-toml` is a
    // project dependency), so this round-trips through a minimal inline unescape that
    // implements only the escape forms escapeTomlDoubleQuotedString can produce
    // (\\ \" \b \t \n \f \r \uXXXX) — sufficient to invert this encoder, not a general
    // TOML parser.
    const unescapeTomlBasicString = (escaped) => {
      let out = '';
      for (let i = 0; i < escaped.length; i += 1) {
        const ch = escaped[i];
        if (ch !== '\\') {
          out += ch;
          continue;
        }
        const next = escaped[i + 1];
        if (next === 'u') {
          out += String.fromCodePoint(parseInt(escaped.slice(i + 2, i + 6), 16));
          i += 5;
          continue;
        }
        const compact = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[next];
        if (compact === undefined) throw new Error(`unsupported escape: \\${next}`);
        out += compact;
        i += 1;
      }
      return out;
    };

    const hostileInputs = ['\n', '\r', '\r\n', '\0', '\t', '\b', '\f', '\x1F', '\x7F', 'a\\b"c\nd'];
    for (const input of hostileInputs) {
      const escaped = escapeTomlDoubleQuotedString(input);
      const tomlLine = `k = "${escaped}"`;
      const quoted = tomlLine.slice(tomlLine.indexOf('"') + 1, tomlLine.lastIndexOf('"'));
      assert.equal(unescapeTomlBasicString(quoted), input, `round-trip failed for ${JSON.stringify(input)}`);
    }
  });

  // A newline in the target directory lands inside a single-quoted `echo '...'` argument
  // in the persisted bash/zsh rc lines. POSIX single quotes preserve a literal newline as
  // data — they do NOT terminate on a bare newline — so the whole `echo '...' >> ~/.bashrc`
  // stays ONE shell command; the newline just makes the persisted PATH assignment a broken,
  // two-line value inside .bashrc, not a second executable command. (Contrast: had the
  // value been embedded unquoted or inside double quotes followed by an unescaped command
  // separator, a newline COULD start a new command — that is not the case here.)
  test('a newline in the target directory cannot start a new rc-file command', () => {
    const command = laneCommand('persist', '/tmp/a\nmalicious', 'linux', 'bash');
    assert.equal(command, `echo 'export PATH="/tmp/a\nmalicious:$PATH"' >> ~/.bashrc`);
    // The newline sits between the opening and closing `'` of the echo argument — it is
    // literal data inside one quoted token, not a shell command terminator.
    const singleQuoteSpan = command.slice(command.indexOf(`'`) + 1, command.lastIndexOf(`'`));
    assert.ok(singleQuoteSpan.includes('\n'), 'the newline must be inside the single-quoted region');
  });

  test('keeps the existing apostrophe escaping', () => {
    const command = laneCommand('persist', "/tmp/o'brien", 'linux', 'bash');
    assert.ok(command.includes(`'\\''`), 'bash lane must retain the POSIX single-quote escape sequence');
  });

  test('escapes an apostrophe and a dollar in one path', () => {
    const command = laneCommand('persist', "/tmp/o'b$(id)", 'linux', 'bash');
    assert.ok(command.includes(`'\\''`), 'must still contain the POSIX single-quote escape');
    assert.ok(command.includes('\\$('), 'must also contain the escaped dollar-paren');
  });

  test('all three lanes escape the export line identically', () => {
    const { escapedDir: token } = projectPathExportLine('/tmp/a$(id)b');
    const repairCommand = laneCommand('repair', '/tmp/a$(id)b', 'linux', 'posix');
    const persistCommand = laneCommand('persist', '/tmp/a$(id)b', 'linux', 'bash');
    const win32TargetDir = 'C:/a$(id)b';
    const win32Command = laneCommand('repair', win32TargetDir, 'win32', 'bash');
    // #3118: the win32 bash lane posix-normalizes targetDir before escaping it, so its token
    // must be compared against the SAME (posix-normalized) input, not against the '/tmp/...'
    // token above — those are two different inputs and legitimately escape differently.
    const { escapedDir: win32Token } = projectPathExportLine(posixNormalize(win32TargetDir));
    assert.ok(repairCommand.includes(token), 'repair posix lane must use the same escaped token');
    assert.ok(persistCommand.includes(token), 'persist bash lane must use the same escaped token');
    assert.ok(win32Command.includes(win32Token), 'win32 bash lane must use the same escaped token');
  });

  test('does not let a quote break out of the cmd lane', () => {
    const { shellActions, actionLines } = projectPathActionProjection({
      mode: 'repair',
      targetDir: 'C:/a"&calc&"b',
      platform: 'win32',
    });
    // `"` is a reserved character that cannot appear in any Windows path, so
    // there is no valid command to suggest; the projection fails closed
    // rather than emitting a cmd line whose quoting can be broken.
    assert.deepEqual(shellActions, []);
    assert.deepEqual(actionLines, []);
  });

  test('still projects win32 lanes for a legal path', () => {
    const { shellActions } = projectPathActionProjection({
      mode: 'repair',
      targetDir: 'C:/Users/dev/bin',
      platform: 'win32',
    });
    assert.equal(shellActions.length, 3);
    assert.deepEqual(shellActions.map((a) => a.shell), ['powershell', 'cmd', 'bash']);
  });

  test('keeps the PowerShell doubling', () => {
    assert.equal(escapePowerShellSingleQuoted("o'brien"), "o''brien");
  });

  test('an absent target directory produces no actions', () => {
    for (const targetDir of [null, undefined, '']) {
      assert.deepEqual(
        projectPathActionProjection({ mode: 'repair', targetDir, platform: 'linux' }),
        { shellActions: [], actionLines: [], reason: PATH_ACTION_REASON.NO_TARGET_DIR },
      );
    }
  });

  test('reports why a win32 quote produced no actions', () => {
    const result = projectPathActionProjection({ mode: 'repair', targetDir: 'C:/a"b', platform: 'win32' });
    assert.deepEqual(result.shellActions, []);
    assert.equal(result.reason, PATH_ACTION_REASON.WIN32_RESERVED_QUOTE);
  });

  // Two empty results with different causes must stay distinguishable — that
  // is the whole subject of epic #3051.
  test('reports a missing target directory as a different cause', () => {
    const result = projectPathActionProjection({ mode: 'repair', targetDir: null, platform: 'win32' });
    assert.equal(result.reason, PATH_ACTION_REASON.NO_TARGET_DIR);
  });

  test('a successful projection carries no reason', () => {
    const result = projectPathActionProjection({ mode: 'repair', targetDir: '/usr/local/bin', platform: 'linux' });
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'reason'), false);
  });

  test('the reason vocabulary is closed', () => {
    assert.deepEqual(Object.keys(PATH_ACTION_REASON).sort(), ['NO_TARGET_DIR', 'WIN32_RESERVED_QUOTE']);
    assert.ok(Object.isFrozen(PATH_ACTION_REASON));
  });

  test('leaves the fish lane escaping unchanged', () => {
    const command = laneCommand('persist', '/tmp/a$(id)b', 'linux', 'fish');
    assert.equal(command, `fish_add_path -- '/tmp/a$(id)b'`);
  });

  test('emits the fish end-of-options separator for an ordinary path', () => {
    // #3118 review MINOR: a leading-dash `targetDir` (e.g. `-v`) is a legal
    // directory name, but fish's argparse-based option scanning misparses an
    // unseparated leading-dash token as a flag regardless of quoting —
    // verified empirically against a real fish 4.8.1 install that
    // `fish_add_path '-v'` fails ("No paths to add, not setting anything.")
    // while `fish_add_path -- '-v'` succeeds. `--` is fish's standard
    // end-of-options separator and is a no-op for ordinary paths.
    const command = laneCommand('persist', '/tmp/x', 'linux', 'fish');
    assert.equal(command, `fish_add_path -- '/tmp/x'`);
  });

  test('an empty platform string falls back to the host', () => {
    assert.equal(
      formatManagedHookScriptToken('/x/y.js', { platform: '' }),
      formatManagedHookScriptToken('/x/y.js'),
    );
  });

  test('projects no token off win32', () => {
    assert.equal(formatManagedHookScriptToken('/x/y.js', { platform: 'linux' }), null);
  });

  test('projects a JSON-quoted posix-normalized token on win32', () => {
    assert.equal(
      formatManagedHookScriptToken('C:\\x\\y.js', { platform: 'win32' }),
      JSON.stringify('C:/x/y.js'),
    );
  });

  test('returns no lines when called with no arguments', () => {
    assert.deepEqual(renderShellActionLines(), []);
  });

  test('drops entries without a command', () => {
    assert.deepEqual(
      renderShellActionLines([null, { label: 'a' }, { label: 'b', command: 'c' }]),
      ['b: c'],
    );
  });

  test('renders an unlabeled action as the bare command', () => {
    assert.deepEqual(renderShellActionLines([{ label: null, command: 'x' }]), ['x']);
  });

  test('escapes a backslash-quote pair in the right order', () => {
    // Input: a \ " b  (a literal backslash immediately followed by a quote).
    const input = ['a', '\\', '"', 'b'].join('');
    // Expected: backslash first doubles to two backslashes, THEN the quote
    // gets its own backslash — so the quote ends up preceded by 3 backslashes.
    const expected = ['a', '\\', '\\', '\\', '"', 'b'].join('');
    assert.equal(escapeTomlDoubleQuotedString(input), expected);
  });

  test('coerces non-string values', () => {
    const escapers = [
      escapeTomlDoubleQuotedString,
      escapePowerShellSingleQuoted,
      escapePosixDoubleQuoted,
      escapeSingleQuotedShellLiteral,
    ];
    for (const escaper of escapers) {
      for (const value of [null, undefined, 0, [], {}]) {
        assert.doesNotThrow(() => escaper(value));
        assert.equal(typeof escaper(value), 'string');
      }
    }
  });

  test('returns empty for an empty value', () => {
    const escapers = [
      escapeTomlDoubleQuotedString,
      escapePowerShellSingleQuoted,
      escapePosixDoubleQuoted,
      escapeSingleQuotedShellLiteral,
    ];
    for (const escaper of escapers) {
      assert.equal(escaper(''), '');
    }
  });

  describe('retryRenameSync (#3118)', () => {
    afterEach(() => {
      mock.restoreAll();
    });

    test('rethrows when the rename cannot be retried to success', () => {
      mock.method(fs, 'renameSync', () => {
        const e = new Error('EPERM');
        e.code = 'EPERM';
        throw e;
      });
      assert.throws(() => retryRenameSync('/a', '/b'));
    });

    test('returns silently on a successful rename', (t) => {
      const dir = createTempDir('gsd-3118-rename-');
      t.after(() => cleanup(dir));
      const from = path.join(dir, 'source.txt');
      const to = path.join(dir, 'dest.txt');
      fs.writeFileSync(from, 'content');

      retryRenameSync(from, to);

      assert.ok(fs.statSync(to).isFile());
      assert.equal(fs.existsSync(from), false);
    });
  });
});
