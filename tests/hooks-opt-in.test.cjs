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
const { runHook } = require('./helpers/process-seam.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const isWindows = process.platform === 'win32';
// This is a bash FAN-OUT: the hook itself runs under `bash`, and it shells
// out to `node` (see hookEnv below, which puts node on PATH for exactly that
// reason). 15000ms was sized for a single-probe class, not this one. Same
// class as the observed CI failures in tests/quick-branching.test.cjs (PR
// #3787 run 32668773524) and tests/worktree-safety.test.cjs (`next` run
// 32608945654) — see HOOK_FANOUT_TIMEOUT_MS in ./helpers/timeouts.cjs for the
// class rationale.
const HOOK_TIMEOUT_MS = HOOK_FANOUT_TIMEOUT_MS;

// Ensure the running node binary is on PATH so bash hooks can call `node`
// (Claude Code shell sessions do not have `node` on PATH).
const hookEnv = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
};

// Wrapper that always injects hookEnv so bash hooks can find `node`.
// Preserves the legacy spawnSync-shaped return (`status`, `stdout`, `stderr`,
// `signal`) that every call site in this file asserts against.
function spawnHook(hookPath, options) {
  const r = runHook(hookPath, [], {
    ...options,
    interpreter: 'bash',
    env: hookEnv,
    timeoutMs: HOOK_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr, signal: r.signal };
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
const { GSD_UNINSTALL_HOOKS } = require(
  path.join(__dirname, '..', 'bin', 'install.js')
);
const { buildHookCommand } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-hooks-surface.cjs')
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

  // #3802 — the heredoc `-m` form. Claude Code's own documented commit idiom is
  //
  //     git commit -m "$(cat <<'EOF'
  //     feat(auth): add login flow
  //     EOF
  //     )"
  //
  // The `-m` capture regex spans it whole, because bash `[^"]` matches newlines,
  // so the first line was the literal `$(cat <<'EOF'` and EVERY heredoc-form
  // commit was blocked regardless of its message.
  const heredoc = (body, open = "<<'EOF'", close = 'EOF') =>
    `git commit -m "$(cat ${open}\n${body}\n${close}\n)"`;
  const runHookCmd = (command) => spawnHook(path.join(HOOKS_DIR, 'gsd-validate-commit.sh'), {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
    cwd: tmpDir,
  });

  test('validate-commit allows a CONFORMING heredoc-form message', () => {
    const result = runHookCmd(heredoc('feat(auth): add login flow'));
    assert.strictEqual(result.status, 0,
      `a conforming heredoc message must pass; got ${result.status}. stdout: ${result.stdout}`);
  });

  test('validate-commit still BLOCKS a non-conforming heredoc-form message', () => {
    const result = runHookCmd(heredoc('wibble wobble no type here'));
    assert.strictEqual(result.status, 2,
      'resolving the heredoc body must not become a blanket exemption for the whole form');
    assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
  });

  test('validate-commit measures subject length against the RESOLVED heredoc subject', () => {
    // RULESET.TESTS.boundary-coverage: N at {limit-1, limit, limit+1}, not merely
    // "very long". The limit is 72, and the gate is `> 72`, so 72 must PASS and
    // 73 must block. A trivially-oversized subject alone would not show which
    // side of the comparison the code sits on.
    const at = (n) => {
      const prefix = 'feat(auth): ';
      return `${prefix}${'x'.repeat(n - prefix.length)}`;
    };
    for (const [n, want] of [[71, 0], [72, 0], [73, 2]]) {
      const subject = at(n);
      assert.strictEqual(subject.length, n, `fixture built wrong: ${subject.length} != ${n}`);
      const result = runHookCmd(heredoc(subject));
      assert.strictEqual(result.status, want,
        `resolved heredoc subject of ${n} chars: expected exit ${want}, got ${result.status}`);
      if (want === 2) {
        assert.strictEqual(JSON.parse(result.stdout).code, 'COMMIT_SUBJECT_TOO_LONG',
          'must fail on LENGTH, not format — a format failure would mean the opener was still '
          + 'being read as the subject');
      }
    }

    // Review of #3816, Major 2: the clean fixtures above cannot see a
    // one-directional cleanup=whitespace implementation. git strips TRAILING
    // whitespace too, so a 72-char subject plus trailing spaces is a conforming
    // commit — measuring the raw 75 chars re-blocks it, the very defect #3802
    // reports. And the guard must strip, not blanket-allow: 73 chars plus a
    // trailing space is still over-long once stripped.
    const dirty72 = runHookCmd(heredoc(`${at(72)}   `));
    assert.strictEqual(dirty72.status, 0,
      `git's actual subject is 72 chars — measuring the raw line as 75 must not block it; `
      + `got ${dirty72.status}: ${dirty72.stdout}`);
    const dirty73 = runHookCmd(heredoc(`${at(73)} `));
    assert.strictEqual(dirty73.status, 2,
      'a 73-char subject stays blocked with trailing whitespace attached — stripping must not '
      + 'become an allowance');
    assert.strictEqual(JSON.parse(dirty73.stdout).code, 'COMMIT_SUBJECT_TOO_LONG');
  });

  test('validate-commit does not resolve a TRUNCATED capture past its own limit', () => {
    // Review of #3802, Major 3. An embedded `"` truncates the `-m` capture, so the
    // resolver would otherwise measure a PREFIX of the real subject and let an
    // over-long message through — an enforcement hole that did not exist before
    // this fix. git's real subject here is 100+ chars; the captured prefix is 10.
    const result = runHookCmd(`git commit -m "$(cat <<'EOF'\nfeat: aaaa" ${'z'.repeat(90)}\nEOF\n)"`);
    assert.strictEqual(result.status, 2,
      'a capture with no terminator cannot be measured, so it must fall back to the pre-fix '
      + 'behaviour (blocked) rather than resolving to a prefix that slips under the length gate');
  });

  test('validate-commit skips leading blank lines in the heredoc body, as git does', () => {
    // Review of #3802, Minor 1. git's default cleanup=whitespace strips leading
    // blank lines, so this commit's real subject is conforming — blocking it is
    // the same false-positive class #3802 reports.
    assert.strictEqual(runHookCmd(heredoc('\nfeat(auth): real subject after a blank line')).status, 0,
      'the subject is the first NON-empty body line');
  });

  test('validate-commit resolves the QUOTED heredoc opener spellings, both directions', () => {
    // Both directions per spelling, deliberately. Asserting only "conforming
    // passes" would also pass if the resolver returned an empty subject for a
    // spelling it failed to recognise — an allow, but for the wrong reason
    // (review of #3802). Pairing it with a non-conforming body that must BLOCK
    // proves the body is genuinely being read.
    //
    // Only the spellings that SUPPRESS expansion belong here: `<<'D'`, `<<"D"`
    // and `<<\D`. The bare spellings moved to the row below, which pins the
    // opposite contract (review of #3816, round 4).
    for (const [label, open, close, indent] of [
      ["<<-'TAG' (tab-stripped)", "<<-'MSG'", '\tMSG', '\t'],
      ["<<'END-MSG' (non-identifier tag)", "<<'END-MSG'", 'END-MSG', ''],
      ['<<\\TAG (backslash-quoted)', '<<\\EOF', 'EOF', ''],
    ]) {
      assert.strictEqual(runHookCmd(heredoc(`${indent}fix(api): correct status code`, open, close)).status, 0,
        `${label}: a conforming message in this spelling must pass`);
      assert.strictEqual(runHookCmd(heredoc(`${indent}wibble wobble`, open, close)).status, 2,
        `${label}: a NON-conforming message in this spelling must still block — if this passes, the `
        + 'resolver is returning an empty subject rather than reading the body');
    }
  });

  test('validate-commit BLOCKS a bare heredoc delimiter — bash expands that body (round-4 BLOCKER)', () => {
    // Review of #3816, round 4. This row previously asserted the OPPOSITE
    // (`['bare <<TAG', '<<EOF', 'EOF', '']` expecting exit 0), so the suite
    // itself defended the bypass and the fix could not land without editing a
    // test that read as intentional. RULESET.TESTS.delete-bad-tests: a test
    // asserting the defective behaviour is corrected in the same change as the
    // behaviour.
    //
    // WHY the contract flips: only `<<'D'`, `<<"D"` and `<<\D` suppress
    // expansion. A bare `<<D` is expanded by bash, so the body captured by the
    // hook is not the text git receives, and resolving it dodges BOTH gates.
    // Verified with an argv-printing stub: `-m "$(cat <<EOF\nfeat: $UNSET\nEOF\n)"`
    // reaches git as `feat: ` — subject `feat:`, non-conforming — while the
    // literal body measured as conforming.
    for (const [label, open] of [
      ['bare <<TAG', '<<EOF'],
      ['<< TAG (spaced, bare)', '<< EOF'],
      ['<<-TAG (bare, tab-stripping)', '<<-EOF'],
    ]) {
      const result = runHookCmd(heredoc('fix(api): correct status code', open, 'EOF'));
      assert.strictEqual(result.status, 2,
        `${label}: must BLOCK even though the literal body looks conforming — bash expands this `
        + 'body, so the validated text is not the text git receives');
      assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION',
        `${label}: falls back to the opener line, which fails the format gate`);
    }
  });

  test('validate-commit BLOCKS an expansion inside a bare-delimiter body (round-4 BLOCKER)', () => {
    // The measured bypass itself, in both its gate-dodging forms. Non-vacuous:
    // each literal body IS conforming and IS within 72 chars, so a resolver
    // that measured the literal returns exit 0 — which is what head did before
    // this fix (base=2 -> head=0, measured against the real hook).
    const expanded = runHookCmd('git commit -m "$(cat <<EOF\nfeat: $UNSET_VAR\nEOF\n)"');
    assert.strictEqual(expanded.status, 2,
      'git receives `feat: ` (subject `feat:`) once bash expands $UNSET_VAR — the format gate must '
      + 'not be judged against the unexpanded literal');
    assert.strictEqual(JSON.parse(expanded.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');

    const lengthDodge = runHookCmd('git commit -m "$(cat <<EOF\nfeat: ${LONG}\nEOF\n)"');
    assert.strictEqual(lengthDodge.status, 2,
      '${LONG} expands to any length at all, so measuring the 12-char literal dodges '
      + 'COMMIT_SUBJECT_TOO_LONG — the same prefix-measurement class the truncation and '
      + 'post-terminator guards exist for, through expansion rather than composition');
  });

  test('validate-commit does not resolve a heredoc in the SINGLE-quoted -m arm (round-4 BLOCKER)', () => {
    // Review of #3816, round 4. Inside `-m '...'` bash performs NO command
    // substitution, so `$(cat <<'EOF'` is literal text and git's real subject
    // is that opener line. Resolving the body there validates a message git
    // never receives. All four spellings measured base=2 -> head=0 before this
    // fix; reachable by the ordinary slip of typing `'` for `"`.
    //
    // Non-vacuous by construction: every body below is conforming, so a hook
    // that resolves the sq arm returns exit 0 on all four.
    //
    // The `heredoc()` helper hard-codes the double quote, which is exactly why
    // this arm went untested for three rounds — these rows build the command
    // directly.
    for (const [label, open] of [
      ['<<"EOF"', '<<"EOF"'],
      ["<<'EOF'", "<<'EOF'"],
      ['<<\\EOF', '<<\\EOF'],
      ['bare <<EOF', '<<EOF'],
      ['<< EOF (spaced)', '<< EOF'],
    ]) {
      const result = runHookCmd(`git commit -m '$(cat ${open}\nfeat(auth): looks conforming\nEOF\n)'`);
      assert.strictEqual(result.status, 2,
        `sq arm, ${label}: must BLOCK — bash does not substitute inside single quotes, so git's `
        + "real subject is the literal opener line, not the body");
      assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
    }
  });

  test('the adjacency guard is scoped to the arm that matched (round-4 Minor 1)', () => {
    // Review of #3816, round 4, Minor 1. The guard tested BOTH quote styles
    // against the whole command irrespective of which arm produced the
    // message, so a double-quoted heredoc whose BODY mentions a glued
    // single-quoted token tripped the sq arm and lost the fix for a message
    // that never had a prefix problem. Measured 2/2 before, 0 after.
    assert.strictEqual(
      runHookCmd(heredoc("feat: stop passing -m 'foo'bar to git")).status, 0,
      'a glued single-quoted token inside a DOUBLE-quoted heredoc body must not trip the '
      + 'single-quote adjacency arm');
  });

  test('validate-commit blocks a substitution composed with more text (round-3 BLOCKER)', () => {
    // Review of #3816, round 3. bash expands this -m argument to a SINGLE
    // 200+ char subject, but the resolver discarded everything after the
    // terminator and measured `feat: ok` (8 chars) — a live length-gate
    // bypass the base did not have. The post-terminator guard now falls back
    // to the opener line, so the form is blocked by the FORMAT gate, the
    // pre-fix behaviour for the whole form.
    const result = runHookCmd(`git commit -m "$(cat <<'EOF'\nfeat: ok\nEOF\n) ${'a'.repeat(200)}"`);
    assert.strictEqual(result.status, 2,
      'a heredoc substitution composed with trailing text is one long real subject — resolving '
      + 'the body alone dodges COMMIT_SUBJECT_TOO_LONG');
    assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION',
      'fail-closed via the format gate on the opener fallback, matching every other unresolvable shape');
  });

  test('validate-commit blocks a suffix glued OUTSIDE the closing quote (adjacency guard)', () => {
    // Codex review of #3816, round 3. bash concatenates `"$(…)"aaaa…` into ONE
    // argument, but the capture holds only the quoted part — so the resolver
    // measured `feat: ok` (8 chars) for a 200+ char real subject: a net-new
    // length-gate bypass the base did not have (base measured the opener and
    // blocked). Glued text after the closing quote now skips the resolver and
    // keeps the pre-fix first-line subject, which for the heredoc form is the
    // opener — blocked, base parity restored.
    const result = runHookCmd(`git commit -m "$(cat <<'EOF'\nfeat: ok\nEOF\n)"${'a'.repeat(200)}`);
    assert.strictEqual(result.status, 2,
      'a quoted substitution with an adjacent unquoted suffix is one long real subject — the '
      + 'captured prefix must not be resolved and measured on its own');
    assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
  });

  test('adjacency on a PLAIN single-line message keeps base behavior (pre-existing, unchanged)', () => {
    // Differential pin: on base, `-m "feat: ok"zzz` captured `feat: ok`,
    // validated it, and ALLOWED the commit even though bash's real argument is
    // `feat: okzzz`. That is a pre-existing capture limit (same family as
    // rows 16-20 of the round-3 review's table), and the adjacency guard
    // deliberately preserves it rather than widening scope: the guard's job is
    // to stop the RESOLVER from measuring a prefix, not to fix the capture.
    const result = runHookCmd('git commit -m "feat: ok"zzz');
    assert.strictEqual(result.status, 0,
      'base allowed this shape; the adjacency guard must not silently change plain-form behavior');
  });

  test('validate-commit blocks a command smuggled before the cat', () => {
    // Codex review of #3816. `$(id;/bin/cat <<'EOF' ...` runs `id` FIRST, so
    // git's real subject is id's output — but the resolver read the heredoc
    // body and the conforming `fix: smuggled` sailed through: an enforcement
    // bypass end to end. Recognition now rejects a path prefix carrying shell
    // metacharacters and the whole form falls back to blocked.
    const result = runHookCmd(`git commit -m "$(id;/bin/cat <<'EOF'\nfix: smuggled\nEOF\n)"`);
    assert.strictEqual(result.status, 2,
      'a command substitution that runs anything besides cat cannot have its heredoc body '
      + 'trusted as the subject');
    assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
  });

  test('KNOWN LIMIT: the <<"TAG" spelling stays blocked — the capture cannot deliver it', () => {
    // This row pins a LIMIT, not desired behaviour (Codex review of #3816).
    // The `-m` capture stops at the first `"`, which in this spelling is the
    // delimiter's own quote, so the resolver only ever sees a truncated opener
    // and even a conforming message is blocked — the pre-fix behaviour for the
    // whole form, fail closed. If this row ever starts passing, the capture
    // changed: re-review every embedded-quote case before celebrating.
    // Counterpart: the UNIT row in tests/worktree-safety.test.cjs proves the
    // pure resolver CAN resolve this spelling — the limit is the capture,
    // not the parser; the two rows are correct together (review of #3816,
    // round 3, N2).
    const result = runHookCmd(heredoc('feat(api): conforming subject', '<<"EOF"', 'EOF'));
    assert.strictEqual(result.status, 2,
      'documented residual false-positive on the double-quoted delimiter spelling');
    assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
  });

  test('validate-commit does not treat a message ENDING in <<WORD as a heredoc', () => {
    // Enforcement bypass found in review of #3802: an earlier revision recognised
    // the opener without anchoring it to a command substitution, so this resolved
    // to line 2 and ALLOWED a commit whose real subject is non-conforming.
    const result = runHookCmd('git commit -m "WIP notes <<EOF\nfix: smuggled subject"');
    assert.strictEqual(result.status, 2,
      'the real subject is the non-conforming first line; resolving past it is an ALLOW that '
      + 'smuggles an unvalidated message through');
    assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
  });

  test('validate-commit leaves every non-heredoc form exactly as it was', () => {
    // Differential pins. Each of these was ALLOWED before this change, and an
    // earlier revision that walked tokens to find `-m` started BLOCKING all of
    // them (review of #3802). They are not incidental: `--` introduces pathspecs,
    // `&&` starts a different command, and the shared scanner drops empty tokens
    // so a following flag can be mistaken for the message.
    for (const [label, cmd] of [
      ['-- introduces pathspecs', 'git commit -- -m WIP'],
      ['a later command\'s flag', 'git commit --amend && echo -m WIP'],
      ['empty -m before a flag', 'git commit -m "" --allow-empty-message'],
      ['empty -m before a real -m', 'git commit -m "" -m "fix: real subject"'],
      ['unquoted -m argument', 'git commit -m WIP'],
    ]) {
      assert.strictEqual(runHookCmd(cmd).status, 0,
        `${label}: this form was allowed before #3802 and must stay allowed — widening WHICH `
        + 'argument counts as the message is out of scope for this fix');
    }
  });

  test('validate-commit resolves only git\'s FIRST message argument (round-4 Codex BLOCKER)', () => {
    // The `-m` capture is a SEARCH over the whole command and the double-quoted
    // arm is tried first, so it could select a `-m` that is not git's subject.
    // git CONCATENATES multiple -m arguments and the SUBJECT is the first one —
    // verified against real commits, not the man page: for
    // `-m 'WIP first' -m "$(cat …)"` git records `WIP first`.
    //
    // Every row below measured base=2 -> head=0 before this guard. Non-vacuous
    // by construction: each heredoc body is conforming, so a hook that resolves
    // the wrong -m returns 0 on all four. The counterpart row above
    // ("leaves every non-heredoc form exactly as it was") covers these same
    // positions with a plain `WIP`, which never activates the resolver — which
    // is exactly why this interaction went unnoticed.
    const body = "$(cat <<'EOF'\nfeat: accepted body\nEOF\n)";
    for (const [label, cmd] of [
      ['an earlier single-quoted -m', `git commit --allow-empty -m 'WIP first' -m "${body}"`],
      ['an earlier unquoted -m', `git commit -m WIP -m "${body}"`],
      ['after -- it is a pathspec, not a message', `git commit -m WIP -- -m "${body}"`],
      ['it belongs to a later command', `git commit -m WIP && echo -m "${body}"`],
    ]) {
      const result = runHookCmd(cmd);
      assert.strictEqual(result.status, 2,
        `${label}: git's real subject is the FIRST message, which is non-conforming — resolving `
        + 'the later heredoc validates text git never uses as the subject');
      assert.strictEqual(JSON.parse(result.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
    }
  });

  test('validate-commit refuses to resolve under a non-default cleanup mode (round-4 Codex BLOCKER)', () => {
    // The resolver strips trailing whitespace and skips leading blank lines
    // because git's DEFAULT cleanup=whitespace does. Under `--cleanup=verbatim`
    // git does neither, so this subject is committed at 75 bytes while the hook
    // measured the stripped 72 — COMMIT_SUBJECT_TOO_LONG dodged (base=2 ->
    // head=0). Confirmed by reading the RAW commit object: `git log --pretty=%s`
    // strips trailing whitespace in its own output and hides the difference.
    const subject72 = `feat: ${'x'.repeat(66)}`;
    assert.strictEqual(subject72.length, 72, 'fixture built wrong');
    const heredocBody = `"$(cat <<'EOF'\n${subject72}   \nEOF\n)"`;

    for (const [label, cmd] of [
      ['--cleanup=verbatim', `git commit --allow-empty --cleanup=verbatim -m ${heredocBody}`],
      ['-c commit.cleanup=verbatim', `git -c commit.cleanup=verbatim commit --allow-empty -m ${heredocBody}`],
    ]) {
      assert.strictEqual(runHookCmd(cmd).status, 2,
        `${label}: git preserves the trailing whitespace, so the real subject is 75 chars — the `
        + 'hook must not measure the stripped form');
    }

    // Non-vacuity: the DEFAULT mode is the case the fix exists for, and it must
    // still resolve and allow. Without these the rows above would pass for a
    // hook that simply stopped resolving everything.
    for (const [label, cmd] of [
      ['--cleanup=whitespace', `git commit --allow-empty --cleanup=whitespace -m ${heredocBody}`],
      ['no cleanup flag', `git commit --allow-empty -m ${heredocBody}`],
    ]) {
      assert.strictEqual(runHookCmd(cmd).status, 0,
        `${label}: git strips the trailing whitespace here, so the real subject is a conforming 72`);
    }

    // SCOPE (review of #3816, round 5 — BLOCKER). The guard scanned the whole
    // command, and the heredoc BODY sits verbatim inside it, so a conforming
    // message that merely MENTIONED the token was refused and fell back to the
    // opener line — blocked with CONVENTIONAL_COMMITS_VIOLATION. These are
    // ordinary English in this repository, whose own hooks and docs discuss
    // cleanup modes constantly. Every row is a valid Conventional Commit that
    // git would accept without complaint.
    for (const [label, subject] of [
      ['commit.cleanup= in the subject', 'fix: document commit.cleanup=strip behavior'],
      ['--cleanup= in the subject', 'docs: explain --cleanup=verbatim in the hook guide'],
      ['the token on a later body line', 'fix: correct the guard scope\n\nIt scanned --cleanup=verbatim in the body.'],
    ]) {
      const result = runHookCmd(`git commit -m "$(cat <<'EOF'\n${subject}\nEOF\n)"`);
      assert.strictEqual(result.status, 0,
        `${label}: the token is message TEXT, not a flag git will act on — refusing to resolve `
        + 'here blocks a commit git would accept');
    }

    // The scope fix must not shrink to $MSG_PREFIX alone. git accepts the flag
    // on EITHER side of -m, so a trailing occurrence is a real mode change and
    // must still refuse — this row reds against a prefix-only scoping and is
    // what keeps the round-4 length-gate bypass closed from both directions.
    assert.strictEqual(
      runHookCmd(`git commit --allow-empty -m ${heredocBody} --cleanup=verbatim`).status, 2,
      'a --cleanup after the message changes the mode just as one before it does');
  });

  test('validate-commit does not trust a relative path ending in cat (round-4 Codex MAJOR)', () => {
    // Recognition accepted any path ending in `/cat`, so a planted `./cat` or
    // `../evil/cat` was trusted to echo its stdin. With such an executable
    // printing `WIP injected`, the resolver validated the heredoc body while
    // git's real subject was `WIP injected` (measured base=2 -> head=0 against
    // a real commit). Only an absolute path or a bare `cat` is recognised now.
    //
    // RESIDUAL, and not fixable from a string: a bare `cat` shadowed earlier on
    // PATH behaves identically and is indistinguishable here. It is also not a
    // meaningful boundary — anyone able to plant an executable on PATH can run
    // `git commit` directly.
    const body = "<<'EOF'\nfeat: accepted body\nEOF\n)";
    for (const [label, prog] of [['./cat', './cat'], ['../evil/cat', '../evil/cat'], ['x/cat', 'x/cat']]) {
      assert.strictEqual(runHookCmd(`git commit -m "$(${prog} ${body}"`).status, 2,
        `${label}: a relative executable merely ENDING in cat is not known to echo its stdin`);
    }
    // Non-vacuity: the legitimate absolute and bare forms still resolve.
    assert.strictEqual(runHookCmd(`git commit -m "$(/bin/cat ${body}"`).status, 0,
      'an absolute /bin/cat is the same canonical form and must still resolve');
    assert.strictEqual(runHookCmd(`git commit -m "$(cat ${body}"`).status, 0,
      'a bare cat is the canonical idiom #3802 is about');
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
