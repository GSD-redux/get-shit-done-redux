/**
 * GSD Tools Test Helpers
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFixture } = require('./fixtures/index.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const TEST_ENV_BASE = {
  GSD_SESSION_KEY: '',
  CODEX_THREAD_ID: '',
  CLAUDE_SESSION_ID: '',
  CLAUDE_CODE_SSE_PORT: '',
  OPENCODE_SESSION_ID: '',
  GEMINI_SESSION_ID: '',
  CURSOR_SESSION_ID: '',
  WINDSURF_SESSION_ID: '',
  TERM_SESSION_ID: '',
  WT_SESSION: '',
  TMUX_PANE: '',
  ZELLIJ_SESSION_NAME: '',
  TTY: '',
  SSH_TTY: '',
};

/**
 * Run gsd-tools command.
 *
 * @param {string|string[]} args - Command string (shell-interpreted) or array
 *   of arguments (shell-bypassed via execFileSync, safe for JSON and dollar signs).
 * @param {string} cwd - Working directory.
 * @param {object} [env] - Optional env overrides merged on top of process.env.
 *   Pass { HOME: cwd } to sandbox ~/.gsd/ lookups in tests that assert concrete
 *   config values that could be overridden by a developer's defaults.json.
 */
function runGsdTools(args, cwd = process.cwd(), env = {}) {
  // Resolve argv once so both the first attempt and the retry use the same vector.
  const childEnv = { ...process.env, ...TEST_ENV_BASE, ...env };
  const argv = Array.isArray(args)
    ? args
    : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
        .map(t => t.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1'));

  function attempt() {
    // Split shell-style string into argv, stripping surrounding quotes, so we
    // can invoke execFileSync with process.execPath instead of relying on
    // `node` being on PATH (it isn't in Claude Code shell sessions).
    // Apply shell-style quote removal: strip surrounding quotes from quoted
    // sequences anywhere in a token (handles both "foo bar" and --"foo bar").
    return execFileSync(process.execPath, [TOOLS_PATH, ...argv], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      timeout: 60000,
    });
  }

  // isKilled: true when the subprocess was terminated by a signal or timed out.
  // This indicates host resource starvation (OOM, scheduler contention), NOT a
  // product assertion failure.
  function isKilled(err) {
    return err.killed || err.signal != null || err.code === 'ETIMEDOUT';
  }

  function throwResourceStarvation(err) {
    throw new Error(
      `[runGsdTools: resource-starvation / subprocess-kill after retry] ` +
      `gsd-tools was killed before completion ` +
      `(signal=${err.signal}, code=${err.code}, killed=${err.killed}). ` +
      `This indicates host OOM or scheduler contention, not a product bug. ` +
      `stdout=${err.stdout?.toString().trim() || ''} ` +
      `stderr=${err.stderr?.toString().trim() || ''}`
    );
  }

  try {
    const result = attempt();
    return { success: true, output: result.trim(), exitCode: 0 };
  } catch (firstErr) {
    // Kill-signal discrimination (#969): transient OOM/contention usually
    // succeeds on retry; retry ONCE before surfacing the labeled error.
    if (isKilled(firstErr)) {
      try {
        const result = attempt();
        return { success: true, output: result.trim(), exitCode: 0 };
      } catch (retryErr) {
        // Still killed after retry — persistent resource starvation, throw.
        throwResourceStarvation(retryErr);
      }
    }
    // Clean non-zero exit (real command error, no kill signal): return normally.
    // No retry, no throw — preserves existing test behavior that asserts on
    // error shape.
    const stderrRaw = firstErr.stderr?.toString().trim() || '';
    // Prefer actual stderr content; fall back to err.message (which contains
    // the command invocation). If stderr is empty, append a note so CI logs
    // show "stderr: (empty)" rather than silently losing the fact that the
    // child process produced no error output — empty stderr with a non-zero
    // exit code is a signal of OS-level crash (OOM kill, worker thread fatal
    // error) rather than a gsd-tools application error.
    const error = stderrRaw || `${firstErr.message} [stderr: (empty) exit:${firstErr.status ?? 1}]`;
    return {
      success: false,
      output: firstErr.stdout?.toString().trim() || '',
      error,
      exitCode: firstErr.status ?? 1,
    };
  }
}

// Create a bare temp directory (no .planning/ structure)
function createTempDir(prefix = 'gsd-test-') {
  return fs.mkdtempSync(path.join(require('os').tmpdir(), prefix));
}

// Create temp directory structure
function createTempProject(prefix = 'gsd-test-') {
  return createFixture({ prefix, planning: true, git: false });
}

// Create temp directory with initialized git repo and at least one commit
function createTempGitProject(prefix = 'gsd-test-') {
  return createFixture({ prefix, planning: true, git: true, projectDoc: true });
}

function cleanup(tmpDir) {
  if (typeof tmpDir !== 'string' || tmpDir.length === 0) return;
  const target = path.resolve(tmpDir);
  const cwd = path.resolve(process.cwd());
  const tmpRoot = path.resolve(os.tmpdir());
  if (cwd === target || cwd.startsWith(`${target}${path.sep}`)) {
    // Windows cannot remove a directory that is the current working directory.
    process.chdir(path.dirname(target));
  }
  // maxRetries/retryDelay absorbs transient Windows EBUSY where AV scanners,
  // file-indexers, or just-exited child processes still hold handles when
  // teardown runs. On POSIX the retry loop is a no-op (rmSync succeeds first try).
  // Budget: 20 × 250ms = 5s total — Windows Defender's deferred scan can hold
  // newly-written files for several seconds on cold runners.
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    // After retries, Windows can still briefly hold temp dirs open after a timed-out
    // child exits. Ignore that teardown-only flake for temp roots, but rethrow everything else.
    const isTmpPath = target === tmpRoot || target.startsWith(`${tmpRoot}${path.sep}`);
    const isTransientWinErr = process.platform === 'win32'
      && isTmpPath
      && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error && error.code);
    if (!isTransientWinErr) throw error;
  }
}

/**
 * Read a text file with CRLF normalized to LF.
 *
 * DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE (CONTEXT.md; recurring since #1700):
 * a test that reads a workflow/agent/reference `.md` file, slices or
 * regex-matches a fenced code block out of it, and hands that block to
 * `spawnSync('bash', ...)` breaks on a Windows checkout — `.gitattributes`
 * `eol=lf` is not always honored by `actions/checkout` on `windows-latest`,
 * so `readFileSync` can return `\r\n` line endings. Bash then treats the
 * trailing `\r` on every line as part of the token; an opening quote never
 * finds its match and the parser dies mid-script with "unexpected EOF while
 * looking for matching `"'" or a bare syntax error at the next `{`/`)`.
 *
 * `.split(/\r?\n/)` on the FENCE DELIMITER alone does not fix this — it only
 * protects the boundary match, not the captured body between the fences,
 * which still carries embedded `\r` characters (the exact bug #2650's
 * verification round found in tests/fix-2650-plan-phase-stall-detection.test.cjs,
 * despite that file's fence regex already using `\r?\n`).
 *
 * Normalizing ONCE at the read boundary, before any slicing/regex/fence
 * parsing runs, is cheaper and safer than normalizing at each extraction
 * call site: every downstream `indexOf`/`slice`/regex/`spawnSync` then
 * operates on LF-only content by construction, and a new `.md`-extraction
 * test is correct by default just by reading through this helper.
 *
 * @param {string} filePath - Absolute or relative path to a text file.
 * @returns {string} File content with every `\r\n` replaced by `\n`.
 */
function readFileNormalized(filePath) {
  return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * Read a workflow .md file plus every .md file under its sibling
 * `<workflow-basename>/steps/` directory, concatenated in document order
 * (host file first, then step files sorted by filename).
 *
 * ADR-1671's workflow fragmentization (#2930/#2932/#2993 et al.) moves whole
 * sections out of a host workflow (e.g. `plan-phase.md`) into lazily-loaded
 * step files under `gsd-core/workflows/<name>/steps/*.md`. A structural or
 * drift guard that reads the host file alone goes blind the moment a
 * section it cares about moves out — this is exactly the shape #2650's own
 * regression tests hit when #2993 relocated plan-phase.md's chunked-planning
 * spawn sites into `plan-phase/steps/chunked-planning-mode.md`. Any test
 * that needs to see the FULL picture (counting markers, asserting a marker
 * exists somewhere in the workflow) should read through this helper instead
 * of `fs.readFileSync(workflowPath)` alone, so the next relocation doesn't
 * silently blind it again. Originally local to
 * tests/plan-phase-drift-guard.test.cjs (readPlanPhaseCombined) — promoted
 * here so a second, divergent copy is never written (Generative Fix
 * Divergence class).
 *
 * @param {string} workflowPath - absolute path to the host workflow .md file.
 * @returns {string} host content, then '\n' + each step file's content in
 *   sorted-filename order. An absent steps directory degrades to the host
 *   content alone (not an error — most workflows have no steps/ dir).
 */
function readWorkflowCombined(workflowPath) {
  let combined = readFileNormalized(workflowPath);
  const stepsDir = path.join(path.dirname(workflowPath), path.basename(workflowPath, '.md'), 'steps');
  if (fs.existsSync(stepsDir)) {
    for (const entry of fs.readdirSync(stepsDir).sort()) {
      if (entry.endsWith('.md')) {
        combined += '\n' + readFileNormalized(path.join(stepsDir, entry));
      }
    }
  }
  return combined;
}

/**
 * Parse a Markdown frontmatter block into a flat key→value map.
 *
 * Handles the YAML scalar forms emitted by the install converters:
 *   key: "json-encoded value"   → JSON.parse
 *   key: 'value with ''escape'' → strip quotes, unescape ''
 *   key: bare value             → trimmed string
 *
 * Multi-line and block scalars are out of scope — every converter in
 * `bin/install.js` emits single-line scalars only. Throws if the content
 * has no closed `---` block so a regression in the emitter shape fails
 * loudly rather than silently returning {}.
 *
 * Tests use this helper instead of `result.includes('key: value')` to
 * follow the project's "tests parse, never grep" convention.
 *
 * @param {string} content - Full file content beginning with `---`.
 * @returns {Record<string, string>} Map of frontmatter keys to decoded values.
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---')) {
    throw new Error(`parseFrontmatter: content must start with '---', got: ${content.slice(0, 40)}`);
  }
  // CRLF tolerance: a Windows-authored file split on `\n` would leave a
  // trailing `\r` on every line, making `lines[i] === '---'` fail to
  // recognize delimiters. Same goes for whitespace-padded delimiter lines.
  // Normalize via a CRLF-aware split + trimmed comparison.
  const lines = content.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      if (openIdx === -1) openIdx = i;
      else { closeIdx = i; break; }
    }
  }
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error('parseFrontmatter: no closed --- block');
  }
  const fields = {};
  for (const line of lines.slice(openIdx + 1, closeIdx)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue; // skip block-list items, blank lines, comments
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      fields[key] = JSON.parse(value);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      fields[key] = value.slice(1, -1).replace(/''/g, "'");
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

// #3026 CR: shared `--help` output check used by bug-1818 + bug-3019 tests.
// Render-on-help shape is `Usage: gsd-tools …\nCommands: …` — both lines
// must be present; structural test, not prose substring matching.
function isUsageOutput(text) {
  return /Usage:\s*gsd-tools/.test(text) && /Commands:/.test(text);
}

/**
 * Isolated HOME directory used by runNpm() for the lifetime of this process.
 *
 * npm reads $HOME/.npmrc (user config) and writes to $HOME/.npm (default cache)
 * when these paths are not overridden. On Docker hosts the running user's HOME
 * may be uninitialized, unwritable, or contain stale state from a prior run —
 * any of which causes `npm pack` / `npm install -g` to fail. Fix: create a
 * fresh temp directory once per process, redirect HOME + cache + userconfig into
 * it, and clean up on process exit. This makes runNpm() independent of the
 * caller's environment. (#131)
 */
const _npmIsolatedHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'npm-home-'));
process.on('exit', () => {
  try { fs.rmSync(_npmIsolatedHome, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

/**
 * Run `fn` with console.log/warn/error captured, returning {stdout, stderr}
 * with ANSI colors stripped. Re-throws any exception fn threw AFTER restoring
 * the real console so the caller's assertion path sees the failure (without
 * this, a fn that crashes before printing would falsely pass !hasReady-style
 * assertions). #2775 CR follow-up established this exact contract.
 *
 * Previously duplicated in bug-2775, bug-2829, bug-3033, bug-3211, bug-3231,
 * bug-3359, and installer-migration-install-integration.
 */
function captureConsole(fn) {
  const stdout = [];
  const stderr = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => stdout.push(a.join(' '));
  console.warn = (...a) => stderr.push(a.join(' '));
  console.error = (...a) => stderr.push(a.join(' '));
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  if (threw) throw threw;
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  return {
    stdout: stdout.map(strip).join('\n'),
    stderr: stderr.map(strip).join('\n'),
  };
}

/**
 * Normalize platform path separators to POSIX forward slashes. Use for
 * cross-platform path comparisons in test assertions where the runtime
 * emits the platform-native separator (\ on Windows) but the test
 * fixture or expected literal is POSIX. Returns the input unchanged if
 * null/undefined so it composes safely with optional chaining.
 */
function toPosixPath(p) {
  return p == null ? p : p.split(path.sep).join('/');
}

/**
 * Build the expected absolute, POSIX-normalized `.planning/...` path for a
 * given fixture root — the shape #2376's init/state path-field output now
 * emits (anchored on process.cwd() / --cwd) instead of the historical
 * relative literal.
 *
 * Centralizes the identical inline `absPlanningPath` helper previously
 * duplicated across tests/quick-research.test.cjs, tests/init.test.cjs,
 * tests/onboard-command.test.cjs, and tests/roadmap-parser.test.cjs.
 *
 * Callers MUST pass a realpath'd fixture root (e.g.
 * `fs.realpathSync(createTempProject())`) so the expected value matches
 * what a spawned child process actually resolves via `process.cwd()` — on
 * macOS `os.tmpdir()` is a symlink (`/var/...` -> `/private/var/...`) that
 * the child's cwd resolves through but a bare `mkdtempSync()` does not.
 *
 * @param {string} base - fixture root (should be realpath'd by the caller).
 * @param {...string} segments - path segments under `.planning/`.
 * @returns {string} POSIX-normalized absolute path.
 */
function absPlanningPath(base, ...segments) {
  return toPosixPath(path.join(base, '.planning', ...segments));
}

/**
 * Run an npm command via execFileSync with cross-platform portability.
 *
 * Handles the Windows `npm.cmd` vs POSIX `npm` distinction and the
 * `shell: true` requirement on Windows so tests do not need to
 * re-implement platform detection inline.
 *
 * @param {string[]} args - npm subcommand and flags (e.g. ['pack', '--pack-destination', dir]).
 * @param {object} [options] - execFileSync options merged with platform defaults.
 *   `cwd`, `encoding`, `timeout`, and `env` are the commonly overridden keys.
 * @returns {string} trimmed stdout string (encoding: 'utf-8').
 * @throws {Error} re-throws the execFileSync error on non-zero exit so callers
 *   get the full stderr in the error message.
 */
function runNpm(args, options = {}) {
  const isWindows = process.platform === 'win32';
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';
  // Inject an isolated HOME so npm never reads from or writes to the caller's
  // $HOME. This prevents failures on Docker hosts where HOME is unwritable or
  // uninitialized. The caller may still pass { env: {...} } in options to
  // further override specific variables — those overrides win because they are
  // applied after the isolated env below (via the spread in the merge). (#131)
  const isolatedEnv = {
    ...process.env,
    HOME: _npmIsolatedHome,
    npm_config_cache: path.join(_npmIsolatedHome, '.npm'),
    npm_config_userconfig: path.join(_npmIsolatedHome, '.npmrc'),
    npm_config_loglevel: 'error',
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
  const defaults = {
    encoding: 'utf-8',
    shell: isWindows,
    timeout: 180000,
    env: isolatedEnv,
  };
  // Merge options; if caller passes their own env, merge it on top of isolatedEnv
  // so the isolation is preserved unless the caller explicitly overrides HOME.
  const { env: callerEnv, ...otherOptions } = options;
  const mergedEnv = callerEnv ? { ...isolatedEnv, ...callerEnv } : isolatedEnv;
  return execFileSync(npmCmd, args, { ...defaults, ...otherOptions, env: mergedEnv }).trim();
}

/**
 * Returns the isolated npm environment dict used by runNpm().
 *
 * Callers (e.g. runSmoke()) can spread this into a spawnSync env so that npm
 * never reads from or writes to the caller's $HOME — the same guarantee
 * runNpm() already provides. (#131)
 *
 * @returns {object} env dict with HOME, npm_config_cache, npm_config_userconfig
 *   pointing into a process-scoped temp directory.
 */
function isolatedNpmEnv() {
  return {
    ...process.env,
    HOME: _npmIsolatedHome,
    npm_config_cache: path.join(_npmIsolatedHome, '.npm'),
    npm_config_userconfig: path.join(_npmIsolatedHome, '.npmrc'),
    npm_config_loglevel: 'error',
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
}

/**
 * Run a callback with process-level state isolation.
 * Restores cwd, exitCode, and process.env after callback returns or throws.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withIsolatedProcessState(fn) {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const originalEnv = { ...process.env };

  try {
    return fn();
  } finally {
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
    process.exitCode = originalExitCode;

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }
}

/**
 * Async delay — yields the event loop for `ms` ms without a synchronous block.
 * Replaces raw setTimeout / Atomics.wait sleeps in tests. `ms` is an identifier
 * and the Promise is not awaited inline, so it does not trip the no-magic-sleep
 * / no-restricted-syntax test rules (which only scan *.test.cjs anyway).
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` until it returns truthy or the deadline elapses — the approved
 * poll-for-condition pattern for cross-process test synchronization. Returns the
 * predicate's truthy value; throws Error(message) on timeout.
 *
 * `predicate` must return a boolean or truthy value when ready; any falsy result
 * (including `0` or `''`) is treated as "not ready yet". Do not use predicates
 * whose meaningful result can be falsy.
 *
 * `predicate` should not throw — exceptions propagate out of `waitFor` uncaught
 * and are NOT retried. If the readiness check can throw on a transient state
 * (e.g. parsing a partially-written file), guard inside the predicate and return
 * `false` instead.
 */
async function waitFor(predicate, { timeoutMs = 10000, stepMs = 25, message = 'waitFor timed out' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await delay(stepMs);
  }
}

/**
 * Reset all runtime-warning caches in config-loader.cjs and model-resolver.cjs.
 *
 * Use this in beforeEach/afterEach hooks in tests that exercise warning-emission
 * paths so that each test starts with a clean slate. Replaces the duplicated local
 * `_resetRuntimeWarningCacheForTests` wrappers in individual test files.
 */
function resetRuntimeWarningCaches() {
  const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');
  const modelResolver = require('../gsd-core/bin/lib/model-resolver.cjs');
  configLoader._resetRuntimeWarningCacheForTests();
  modelResolver._resetModelPolicyWarningCacheForTests();
  modelResolver._resetModelOverrideWarningCacheForTests();
}

/**
 * Env vars that influence workstream-session identity (getWorkstreamSessionKey
 * in active-workstream-store.cjs) or workstream/project resolution (planningDir).
 * Single source of truth for tests that need a deterministic, session-key-free
 * and workstream/project-free process.env — save/clear before, restore after.
 * Union of the sets previously hand-duplicated in
 * tests/active-workstream-store.unit.test.cjs and tests/gsd-statusline.test.cjs
 * (#2850 code review finding: the two copies had already silently diverged).
 */
const SESSION_ENV_KEYS = [
  'GSD_SESSION_KEY', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT',
  'OPENCODE_SESSION_ID', 'GEMINI_SESSION_ID', 'CURSOR_SESSION_ID', 'WINDSURF_SESSION_ID',
  'TERM_SESSION_ID', 'WT_SESSION', 'TMUX_PANE', 'ZELLIJ_SESSION_NAME',
  'TTY', 'SSH_TTY', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'GSD_WORKSTREAM', 'GSD_PROJECT',
];

function saveSessionEnv() {
  const saved = {};
  for (const k of SESSION_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreSessionEnv(saved) {
  for (const k of SESSION_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function clearSessionEnv() {
  for (const k of SESSION_ENV_KEYS) delete process.env[k];
}

module.exports = { runGsdTools, createTempDir, createTempProject, createTempGitProject, cleanup, readFileNormalized, readWorkflowCombined, parseFrontmatter, isUsageOutput, captureConsole, toPosixPath, absPlanningPath, runNpm, isolatedNpmEnv, withIsolatedProcessState, delay, waitFor, resetRuntimeWarningCaches, SESSION_ENV_KEYS, saveSessionEnv, restoreSessionEnv, clearSessionEnv, TOOLS_PATH };
