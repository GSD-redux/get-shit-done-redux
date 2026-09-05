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


  // ─── #3816 round 8 (Major): bracket classes must not smuggle a literal `\` ───
  //
  // `;`, `&` and `|` are shell metacharacters inside `[[ ]]`, so an inline
  // bracket class has to escape each one: `[\;\&\|]`. POSIX bracket expressions
  // have no escape mechanism of their own, and on bash 3.2 — the system
  // /bin/bash on macOS, already a supported target here (see the `declare -A`
  // ban in tests/install.test.cjs) — those backslashes reach the regex engine
  // instead of being consumed by the shell, so the class silently gains a
  // literal `\` as a member. bash 4+ consumes them, which is why this is
  // invisible on a modern bash. The escape is only a hazard INSIDE a bracket
  // expression: `\(` outside one is made literal correctly on every version.
  //
  // One root cause, consequences in BOTH directions:
  //   the SEPARATOR scan (positive class) OVER-BLOCKED — a conforming commit
  //     whose pre-`-m` text held a `\` was refused outright;
  //   the GLUE scan (NEGATED class) UNDER-REFUSED — a `\` glued to the message
  //     span fell inside the exclusion, so the hook resolved a heredoc it
  //     should have declined. That is the accept direction, and it is the row
  //     that matters most below.
  //
  // The fix holds each class in a variable expanded unquoted on the right of
  // `=~`, which is a plain regex on 3.2 and 5.x alike. Writing the class inline
  // without the backslashes is NOT the fix: `[[ x =~ [;&|] ]]` is a bash syntax
  // error on both versions.
  //
  // Every row runs under each bash on the machine, because a row run only under
  // bash 4+ passes with or without the fix — vacuous, and silently so. Where
  // 3.2 is absent the row simply does not appear; that is disclosed here rather
  // than papered over.
  const BASHES = (() => {
    const seen = new Set();
    const found = [];
    for (const candidate of ['/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
      if (!fs.existsSync(candidate)) continue;
      const probe = runHook('-c', ['printf %s "$BASH_VERSION"'], {
        interpreter: candidate, env: hookEnv, timeoutMs: HOOK_TIMEOUT_MS,
      });
      const version = (probe.stdout || '').trim();
      if (probe.exitCode !== 0 || !version || seen.has(version)) continue;
      seen.add(version);
      found.push({ path: candidate, version });
    }
    return found;
  })();

  const underBash = (bashPath, command) => runHook(
    path.join(HOOKS_DIR, 'gsd-validate-commit.sh'), [],
    {
      interpreter: bashPath,
      env: hookEnv,
      timeoutMs: HOOK_TIMEOUT_MS,
      input: JSON.stringify({ tool_input: { command } }),
      cwd: tmpDir,
    },
  );

  for (const bash of BASHES) {
    // ACCEPT DIRECTION — the one that cannot be recovered from. Before the fix,
    // bash 3.2 measured exit 0 here: the backslash sat inside the negated glue
    // class, so the guard never fired and the heredoc was resolved anyway.
    test(`a backslash-glued suffix is still refused (bash ${bash.version})`, () => {
      const glued = `${heredoc('fix: a perfectly ordinary conforming subject')}\\zzz`;
      const result = underBash(bash.path, glued);
      assert.strictEqual(result.exitCode, 2,
        `bash ${bash.version}: a suffix glued to the message span with a backslash must be `
        + 'refused exactly like any other glued suffix — resolving it is the accept direction. '
        + `stdout: ${result.stdout}`);
    });

    test(`a letter-glued suffix is still refused (bash ${bash.version})`, () => {
      // Non-vacuity control for the row above: proves the glue guard is
      // reachable at all under this interpreter, so a refusal there is the
      // guard firing rather than the hook refusing everything.
      const glued = `${heredoc('fix: a perfectly ordinary conforming subject')}zzz`;
      assert.strictEqual(underBash(bash.path, glued).exitCode, 2,
        `bash ${bash.version}: the established glued-suffix refusal must be unchanged`);
    });

    // OVER-BLOCK DIRECTION — the reported half. The backslash sits in the text
    // BEFORE `-m`, and deliberately with no newline anywhere before it: a
    // newline is refused by the separator guard on every bash, which would make
    // this row pass for the wrong reason and prove nothing about the class.
    test(`a backslash before -m does not block a conforming commit (bash ${bash.version})`, () => {
      const command = `git commit --allow-empty --author=a\\,b -m "$(cat <<'EOF'\n`
        + `fix: a perfectly ordinary conforming subject\nEOF\n)"`;
      const result = underBash(bash.path, command);
      assert.strictEqual(result.exitCode, 0,
        `bash ${bash.version}: a conforming commit must not be refused merely because its `
        + `pre-message text contains a backslash. stdout: ${result.stdout}`);
    });

    test(`a non-conforming subject is still blocked (bash ${bash.version})`, () => {
      // Second non-vacuity control: proves this interpreter reaches the
      // validator rather than passing everything — the failure mode that makes
      // an allow-row look green for the wrong reason.
      const result = underBash(bash.path, 'git commit -m "nope not conventional"');
      assert.strictEqual(result.exitCode, 2,
        `bash ${bash.version}: the validator must still be reached and still refuse`);
    });
  }
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

  test('the adjacency guard is scoped to the span it matched (round-6 MAJOR)', () => {
    // Glue is a property of the ONE character following the MATCHED span, so
    // that character is the whole window. Scanning $CMD for the shape anywhere
    // refused any conforming commit whose command merely CONTAINED a glued -m
    // elsewhere. Base blocks these too, because base blocks EVERY heredoc form
    // (that is #3802), so this is the fix not reaching the shape rather than a
    // regression: measured base=2 -> pre=2 -> post=0.
    const conforming = "\"$(cat <<'EOF'\nfix: a perfectly ordinary conforming subject\nEOF\n)\"";

    assert.strictEqual(
      runHookCmd(`git commit -m ${conforming} && echo -m "test"z`).status, 0,
      'a glued -m in a chained-after command is in another argv and cannot truncate this capture');

    // Bash does not concatenate across a command separator or a redirection: in
    // `-m "msg"&& echo hi` the argument ends at the quote, so there is no
    // truncated capture and nothing to defend against. This row reds against a
    // bare `^[^[:space:]]` test, which is why the class excludes `;&|()<>`.
    assert.strictEqual(
      runHookCmd(`git commit -m ${conforming}&& echo hi`).status, 0,
      'a separator abutting the closing quote ends the argument; it does not glue onto it');

    // A suffix that really is glued still refuses.
    assert.strictEqual(
      runHookCmd(`git commit -m ${conforming}zzzz`).status, 2,
      'text glued to the closing quote means the capture holds only a prefix of the real message');
  });

  test('the cleanup guard scans wide on purpose — narrowing it reopened a length hole', () => {
    // The window is the whole command minus the message. That is deliberately
    // wider than git's own command, and the cost is a known false positive:
    // a --cleanup= belonging to a DIFFERENT command refuses a commit git would
    // accept. Narrowing it to git's own segment was tried and reverted, because
    // deciding where git's command ends needs a shell parse and a substring
    // scan is not one.
    const long72 = `feat: ${'x'.repeat(66)}`;
    const longHd = `"$(cat <<'EOF'\n${long72}   \nEOF\n)"`;

    // These rows are the ACCEPT direction and are the reason the guard stays
    // wide. Trimming the window at the first `;&|` cut it short whenever a
    // separator sat inside an ordinary argument, hiding the real trailing
    // --cleanup=verbatim: git then commits the trailing whitespace verbatim and
    // the real subject is 75 bytes while the gate measured 72. Both the quoted
    // and the backslash-escaped spelling must stay blocked; each reds against
    // one of the two narrowings that were attempted.
    for (const [label, author] of [
      ['quoted separator', '"a&b"'],
      ['quoted pipe', '"a|b"'],
      ['quoted semicolon', '"a;b"'],
      ['escaped separator', 'a\\&b'],
      ['escaped pipe', 'a\\|b'],
      ['escaped semicolon', 'a\\;b'],
    ]) {
      assert.strictEqual(
        runHookCmd(`git commit --allow-empty -m ${longHd} --author ${author} --cleanup=verbatim`).status,
        2,
        `${label}: a separator inside an argument must not hide the --cleanup that follows it`);
    }

    // The documented false positive, pinned so the trade-off is visible rather
    // than accidental. If this ever needs to pass, it needs a real shell parse.
    assert.strictEqual(
      runHookCmd(`git commit -m "$(cat <<'EOF'\nfix: a perfectly ordinary conforming subject\nEOF\n)" && echo --cleanup=verbatim`).status,
      2,
      'known limit: a --cleanup in a later command also refuses — fail-closed, and preferred '
      + 'over the accept-direction hole that narrowing the window reopened');
  });

  test('option scans read the command the way bash hands it to git (round-6 accept direction)', () => {
    // Three ways the same option can be spelled without matching a literal.
    // Every row below was measured ACCEPTING a commit whose real subject git
    // records as 75 bytes, or whose real subject is a different -m argument
    // entirely — verified against real commits by reading the raw commit
    // object, since `git log --pretty=%s` strips the trailing whitespace that
    // makes the length wrong and hides it. All are base=2 -> pre=0, so each is
    // an accept-direction regression this PR introduced before this round.
    const long72 = `feat: ${'x'.repeat(66)}`;
    const longHd = `"$(cat <<'EOF'\n${long72}   \nEOF\n)"`;
    const conforming = "\"$(cat <<'EOF'\nfix: a perfectly ordinary conforming subject\nEOF\n)\"";

    // git accepts any unambiguous prefix of a long option, so the mode is set
    // by a token that is not the literal `--cleanup`. Reds against `--cleanup`.
    for (const spelling of ['--cle', '--clea', '--clean', '--cleanu', '--cleanup']) {
      assert.strictEqual(
        runHookCmd(`git commit --allow-empty -m ${longHd} ${spelling}=verbatim`).status, 2,
        `${spelling}=verbatim sets the mode as surely as the unabbreviated spelling does`);
    }

    // git splits `-am` into `-a -m`, making the FIRST message the subject and
    // the heredoc merely the second. Reds against a standalone `-m` scan.
    for (const cluster of ['-am', '-sm', '-anm']) {
      assert.strictEqual(
        runHookCmd(`git commit --allow-empty ${cluster} 'WIP first' -m ${conforming}`).status, 2,
        `${cluster} carries git's first message, so the matched heredoc is not the subject`);
    }

    // Bash removes quotes before git sees the argument, so a spliced spelling
    // is the same option. Reds unless the option-name scans are dequoted.
    assert.strictEqual(
      runHookCmd(`git commit --allow-empty -m ${longHd} --clean""up=verbatim`).status, 2,
      'a quote spliced into the option name does not change the option git receives');
    assert.strictEqual(
      runHookCmd(`git commit --allow-empty -""m 'WIP first' -m ${conforming}`).status, 2,
      'a quote spliced into -m does not stop it claiming the first message');

    // Dequoting must not spill into the adjacency test, which asks about a
    // literal character position rather than an option name. This is the
    // round-6 MAJOR and must stay fixed.
    assert.strictEqual(
      runHookCmd(`git commit -m ${conforming} && echo -m "test"z`).status, 0,
      'quotes in a chained-after command must not refuse the matched heredoc');
  });

  test('the two reported chained-before shapes are never reached by any guard (round-7 pin)', () => {
    // Round 7 reported that the FIRST-MESSAGE GUARD's `[;&|]` prefix scan
    // blocks `git add -A && git commit -m <heredoc>` and
    // `cd dir && git commit -m <heredoc>`. It does not, and cannot: the
    // CLASSIFIER GATE runs first and neither shape reaches the guards at all.
    // `isGitSubcommand` token-walks from the START of the command — `git`→`add`
    // stops on a non-commit subcommand, and a leading `cd` is not git — so the
    // hook exits 0 before a single guard is evaluated.
    //
    // Both rounds 6 and 7 produced this finding by extracting the guard logic
    // into a standalone script and feeding it command strings directly, which
    // bypasses the gate. These rows exist so the same measurement cannot
    // produce a third phantom: they run the REAL hook, end to end.
    //
    // The NON-CONFORMING rows are what make the pin load-bearing. A row
    // asserting only that a conforming chained message exits 0 is satisfied
    // both by "resolved correctly" and by "never validated" — the two
    // hypotheses under dispute. A message that the bare form blocks, passing
    // in the chained form, can only mean the hook never validated it.
    const conforming = `"$(cat <<'EOF'
fix: a perfectly ordinary conforming subject
EOF
)"`;
    const NONCONFORMING = 'nope not conventional';

    // Control FIRST: the hook demonstrably blocks this message when it does
    // classify the command. Without this row the two below prove nothing,
    // because a hook that blocks nothing at all also "allows" them.
    const bare = runHookCmd(`git commit -m "${NONCONFORMING}"`);
    assert.strictEqual(bare.status, 2,
      'control: the bare form must BLOCK a non-conforming subject — otherwise the chained rows '
      + 'below cannot distinguish "not validated" from "validated and allowed"');
    assert.strictEqual(JSON.parse(bare.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');

    for (const [label, prefix] of [
      ['stage-then-commit', 'git add -A && '],
      ['cd-then-commit', 'cd /repo && '],
    ]) {
      // The heredoc shape round 7 says is blocked. It is not.
      assert.strictEqual(runHookCmd(`${prefix}git commit -m ${conforming}`).status, 0,
        `${label}: a conforming chained heredoc commit is not blocked`);
      // ...and the same shape carrying a message the control just proved is
      // blockable ALSO exits 0, which is only possible if no validation ran.
      assert.strictEqual(runHookCmd(`${prefix}git commit -m "${NONCONFORMING}"`).status, 0,
        `${label}: a subject the bare form BLOCKS exits 0 here — proof the classifier gate `
        + 'returns before the guards, so the guards cannot be over-blocking this shape');
    }

    // COUNTEREXAMPLE, so this row is not misread as a blanket claim about every
    // chained-before command (independent review of #3816, round 7). Assignment
    // detection is prefix-anchored and the tokenizer does not split operators,
    // so `FOO=bar;` is read as an assignment prefix and the classifier DOES
    // reach `git commit` — which the separator scan then refuses. That makes it
    // a genuine false positive of exactly the class round 7 describes, reachable
    // where the two reported shapes are not. Left unfixed deliberately:
    // narrowing it means changing `isGitSubcommand`, the shared git-commit
    // detector every gating hook uses, and it fails CLOSED (a conforming commit
    // is blocked, which is recoverable). Disclosed in the changeset instead.
    assert.strictEqual(runHookCmd(`FOO=bar; git commit -m ${conforming}`).status, 2,
      'a leading assignment carrying a separator IS classified and then refused — pinned as a '
      + 'known fail-closed false positive, not as desired behaviour. If this ever starts passing, '
      + 'the classifier or tokenizer changed: re-read the chained-before disclosure before '
      + 'celebrating.');
  });

  // ─── round 7: six accept-direction bypasses found by independent review ───
  //
  // Every row below was measured base-vs-head against the REAL hook, and the
  // three that turn on which subject git actually records were confirmed
  // against the RAW COMMIT OBJECT rather than `git log --pretty=%s`, which
  // strips trailing whitespace and would have hidden two of them:
  //
  //   git commit -mWIP -m <conforming heredoc>              -> subject `WIP`
  //   --cleanup=whitespace -m <72+spaces> --cleanup=verbatim -> 75 bytes, WS kept
  //   git commit --squash=<c> -m <conforming heredoc>        -> `squash! …`
  //
  // In every case the hook resolved and validated the heredoc and ALLOWED the
  // commit, while git recorded something the rules would have refused. All six
  // fixes widen refusal, never narrow it — the direction this file already
  // documents as the recoverable one.

  const HD_OK = `"$(cat <<'EOF'\nfix: a perfectly ordinary conforming subject\nEOF\n)"`;
  const S72 = `feat: ${'x'.repeat(66)}`;
  const HD_LONG_DIRTY = `"$(cat <<'EOF'\n${S72}   \nEOF\n)"`;

  test('the first-message guard recognises attached values and --message abbreviations (round 7)', () => {
    // The scan required a space or `=` after the option name, so `-mWIP` (git
    // reads it as `-m WIP`) and `--mes=WIP` (git accepts any unambiguous long
    // prefix — behaviour this file already models for --cleanup) matched
    // nothing. git took `WIP` as the subject; the hook validated the later
    // heredoc and allowed it.
    assert.strictEqual(S72.length, 72, 'fixture built wrong');
    for (const [label, cmd] of [
      ['attached short-option value', `git commit -mWIP -m ${HD_OK}`],
      ['--message abbreviation', `git commit --mes=WIP -m ${HD_OK}`],
    ]) {
      const r = runHookCmd(cmd);
      assert.strictEqual(r.status, 2,
        `${label}: git takes the FIRST message as the subject, so the heredoc is not the subject `
        + 'and must not be resolved and measured as though it were');
      assert.strictEqual(JSON.parse(r.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
    }
    // Non-vacuity: the canonical form still resolves. Without this, the rows
    // above would also pass if resolution had simply been disabled outright.
    assert.strictEqual(runHookCmd(`git commit -m ${HD_OK}`).status, 0,
      'the canonical single -m heredoc must still pass — that is the fix this PR exists for');
  });

  test('option-name scans remove backslashes, as bash does (round 7)', () => {
    // Round 6 dequoted the option-name windows and the changeset claimed they
    // are matched "as bash hands it to git". That was not true: bash also
    // removes syntactic backslashes, so `-\\m` IS `-m` and `--clean\\up=` IS
    // `--cleanup=`, and both matched no literal.
    const r1 = runHookCmd(`git commit -\\m WIP -m ${HD_OK}`);
    assert.strictEqual(r1.status, 2,
      'a backslash spliced into -m does not stop it claiming the first message');
    const r2 = runHookCmd(`git commit --allow-empty -m ${HD_LONG_DIRTY} --clean\\up=verbatim`);
    assert.strictEqual(r2.status, 2,
      'a backslash spliced into --cleanup does not change the mode git applies, and under verbatim '
      + 'the trailing spaces count toward the 72-character limit');
    assert.strictEqual(runHookCmd(`git commit -m ${HD_OK}`).status, 0, 'non-vacuity: canonical form still resolves');
  });

  test('option-name scans remove the $ of a dollar-quote, as bash does (round 8)', () => {
    // Round 7 removed quotes and backslashes and the changeset again claimed the
    // windows are matched "as bash hands it to git". Still not true: bash has two
    // more quoting forms, $'…' and $"…", whose introducer is a `$`. Removing the
    // quote characters alone left that `$` stranded INSIDE the option name, so
    // `-$"m"` dequoted to `-$m` and matched no literal while bash passed a real
    // `-m` to git. Measured on bash 3.2.57 and 5.3.15 against a real repository:
    // the hook allowed the command (exit 0) and `git cat-file -p` recorded the
    // subject `WIP`, while the same command spelled `-m WIP` was refused.
    for (const [label, cmd] of [
      ['locale-quoted short option', `git commit -$"m" WIP -m ${HD_OK}`],
      ['ANSI-quoted short option', `git commit -$'m' WIP -m ${HD_OK}`],
      ['locale-spliced --message', `git commit --mes$"sage"=WIP -m ${HD_OK}`],
      ['ANSI-spliced --cleanup', `git commit --allow-empty -m ${HD_LONG_DIRTY} --clean$'up'=verbatim`],
    ]) {
      const r = runHookCmd(cmd);
      assert.strictEqual(r.status, 2,
        `${label}: a dollar-quote is removed by bash before git sees the argument, so it does not `
        + 'stop the option claiming the message');
    }
    assert.strictEqual(runHookCmd(`git commit -m ${HD_OK}`).status, 0, 'non-vacuity: canonical form still resolves');
  });

  test('an option NAME carrying a shell expansion is unresolvable (round 9)', () => {
    // Rounds 6-8 each tried to EMULATE what bash does to an argument before git
    // sees it -- remove quotes, then backslashes, then the `$` of a dollar-quote
    // -- and review found another missed transform every time. Round 9 found
    // four more, all measured accepting `WIP` as the real subject on bash 3.2.57
    // and 5.3.15 while the plain spelling of the same command is refused.
    //
    // The last two settle the strategy: an option name finished by a PARAMETER
    // expansion depends on a variable's runtime value, and one finished by a
    // PATHNAME expansion depends on the contents of the working directory.
    // Neither is derivable from the command string at all, so the rule is no
    // longer "normalise and match the literal" but "an option NAME carrying a
    // shell expansion or quoting construct is unresolvable, and unresolvable
    // refuses" -- which covers the spellings nobody has thought of yet.
    for (const [label, cmd] of [
      ['$() substitution', `git commit --allow-empty -m ${HD_LONG_DIRTY} --clean$(printf up)=verbatim`],
      ['backtick substitution', 'git commit --allow-empty -m ' + HD_LONG_DIRTY + ' --clean`printf up`=verbatim'],
      ['ANSI-C octal escape', `git commit --allow-empty -$'\\155' WIP -m ${HD_OK}`],
      ['ANSI-C hex escape', `git commit --allow-empty -$'\\x6d' WIP -m ${HD_OK}`],
      ['parameter expansion', `x= git commit --allow-empty -\${x}m WIP -m ${HD_OK}`],
      ['pathname expansion', `git commit --allow-empty -? WIP -m ${HD_OK}`],
      ['short-option substitution', `git commit -$(printf m) WIP -m ${HD_OK}`],
    ]) {
      assert.strictEqual(runHookCmd(cmd).status, 2,
        `${label}: an option name the shell finishes cannot be read off the command line, so the `
        + 'later heredoc must not be resolved and measured as though it were the subject');
    }

    // SCOPE, in both directions. The class is a `-`-leading token whose
    // characters up to the construct contain no `=` -- an option NAME being
    // assembled. A construct in the VALUE is something this file never models
    // and must stay allowed, or the guard refuses the ordinary
    // `--author="$(git config user.name)"` idiom. Without these rows the
    // assertions above would also pass for a guard that refuses every `$`.
    for (const [label, cmd] of [
      ['spaced value', `git commit --author "$(git config user.name)" -m ${HD_OK}`],
      ['glued value', `git commit --author="$(git config user.name)" -m ${HD_OK}`],
      ['backtick value', 'git commit --author="`git config user.name`" -m ' + HD_OK],
      ['parameter expansion value', `git commit --date="\${NOW}" -m ${HD_OK}`],
      ['glob character in a value', `git commit --author="a*b <x@y.z>" -m ${HD_OK}`],
      ['value in the suffix window', `git commit -m ${HD_OK} --author="$(id -un)"`],
      ['pathspec after --', `git commit -m ${HD_OK} -- src/*.js`],
    ]) {
      assert.strictEqual(runHookCmd(cmd).status, 0,
        `${label}: a construct in an option VALUE, or outside an option name entirely, is not an `
        + 'option name being assembled and must still resolve');
    }
  });

  test('the round-9 class over-blocks two spellings, and both have working forms', () => {
    // Disclosed rather than narrowed. The class refuses a `-`-leading token that
    // carries an expansion before any `=`, and two legitimate-looking spellings
    // fall inside it. Narrowing to exclude them was considered and rejected:
    // dropping the bare-`$` member reopens `-$xm` (with `xm=m` bash hands git a
    // real `-m`), and skipping tokens after `--` means deciding where git's
    // options end from a substring scan, which is the class this file has
    // already reverted twice for opening accept-direction holes. Refusing a
    // commit git would take is the recoverable direction; accepting a
    // non-conforming subject is not.
    for (const [label, cmd] of [
      ['attached short-option value from an expansion', `git commit -S$SIGNING_KEY -m ${HD_OK}`],
      ['attached short-option value, quoted', `git commit -S"$SIGNING_KEY" -m ${HD_OK}`],
      ['unquoted dash-leading glob after --', `git commit -m ${HD_OK} -- -*.txt`],
    ]) {
      assert.strictEqual(runHookCmd(cmd).status, 2, `${label}: known fail-closed limit of the round-9 class`);
    }

    // The working spellings, which is what makes the limit acceptable. Note the
    // pathspec ones in particular: a glob only reaches git as a PATHSPEC when it
    // is quoted, because an unquoted one is expanded by the shell before git
    // sees it. So the spelling that actually passes a glob to git is the one
    // that resolves here.
    for (const [label, cmd] of [
      ['detached signing key', `git commit -S "$SIGNING_KEY" -m ${HD_OK}`],
      ['long signing option', `git commit --gpg-sign="$SIGNING_KEY" -m ${HD_OK}`],
      ['single-quoted glob pathspec', `git commit -m ${HD_OK} -- '-*.txt'`],
      ['double-quoted glob pathspec', `git commit -m ${HD_OK} -- "-*.txt"`],
      ['magic pathspec', `git commit -m ${HD_OK} -- ':(exclude)-*.txt'`],
    ]) {
      assert.strictEqual(runHookCmd(cmd).status, 0,
        `${label}: the spelling a developer reaches for must still resolve`);
    }
  });

  test('a backslash-newline continuation before -m is joined, not treated as a separator (round 9)', () => {
    // `git commit \` newline `  -m <heredoc>` was refused because every guard
    // read the newline as a separator — disclosed in round 8 as a fail-closed
    // limit, re-raised in round 9 as a Major. bash's rule is local: a newline
    // preceded by an ODD run of backslashes is a continuation (both removed);
    // an EVEN run is a literal backslash plus a REAL newline. Both windows are
    // joined the same way before any guard runs. Not bash-version dependent —
    // the join is plain parameter expansion — but run under each bash on the
    // machine anyway, since the round-8 classes were.
    const bashes = ['/bin/bash', '/opt/homebrew/bin/bash'].filter((b) => fs.existsSync(b));
    assert.ok(bashes.length >= 1, 'at least one bash must exist');
    const run = (bash, command) => spawnHook(path.join(HOOKS_DIR, 'gsd-validate-commit.sh'), {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf-8', cwd: tmpDir, interpreter: bash,
    });
    for (const bash of bashes) {
      // The idiom itself, on both sides of the message.
      assert.strictEqual(run(bash, `git commit \\\n  -m ${HD_OK}`).status, 0,
        `${bash}: a continuation before -m is joined by bash, so it must be joined here and resolve`);
      assert.strictEqual(run(bash, `git commit --allow-empty \\\n  --no-verify \\\n  -m ${HD_OK}`).status, 0,
        `${bash}: several continuations resolve`);
      assert.strictEqual(run(bash, `git commit -m ${HD_OK} \\\n  --allow-empty`).status, 0,
        `${bash}: a continuation in the suffix window resolves`);

      // ACCEPT-DIRECTION CONTROLS. An even run is a literal backslash followed
      // by a REAL newline, which is a separator and must still refuse.
      const evenRun = run(bash, `git commit \\\\\n  -m ${HD_OK}`);
      assert.strictEqual(evenRun.status, 2,
        `${bash}: backslash-backslash-newline is a literal \\ then a real separator; joining it would let a later command's -m be taken for this commit's`);
      // A plain newline is unchanged.
      assert.strictEqual(run(bash, `git commit\n  -m ${HD_OK}`).status, 2, `${bash}: a bare newline is still a separator`);
      // Continuation GLUE: bash joins `"$(…)"\` newline `suffix` into one argument,
      // so the glue guard must see it glued and refuse, same as without the newline.
      assert.strictEqual(run(bash, `git commit -m ${HD_OK}\\\nsuffix`).status, 2,
        `${bash}: a continuation glued to the closing quote is glue, and the joined text must show it`);
      // A later command's heredoc-shaped -m after a continuation is STILL a later
      // command once the real separator is reached.
      assert.strictEqual(run(bash, `git commit --amend --no-edit \\\n  --allow-empty\necho -m ${HD_OK}`).status, 2,
        `${bash}: joining continuations must not hide the real newline separator that follows`);
    }
  });

  test('a newline is a command separator for the first-message guard (round 7)', () => {
    // The separator scan covered `;`, `&` and `|` but not a literal newline, so
    // a LATER command's heredoc-shaped -m was taken for this commit's message.
    // The classifier recognises the leading `git commit`, and the capture reads
    // across the newline into echo's argument — a conforming string with no
    // relationship to the commit was validated and the commit allowed.
    const r = runHookCmd(`git commit --amend --no-edit\necho -m ${HD_OK}`);
    assert.strictEqual(r.status, 2,
      "a later command's -m is not this commit's message; a newline separates commands exactly as "
      + '`;` does');
    assert.strictEqual(JSON.parse(r.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
  });

  test('more than one cleanup directive is unresolvable — git applies the LAST (round 7)', () => {
    // A bash regex yields ONE BASH_REMATCH, so only the FIRST directive was
    // inspected while git applies the last. Measured: mode read as whitespace,
    // resolution stayed on, and a 72-character subject plus trailing spaces was
    // accepted while git recorded 75 bytes with the whitespace preserved.
    // Which directive is last needs an argv order a substring scan does not
    // have, so multiplicity itself refuses.
    const r = runHookCmd(`git commit --allow-empty --cleanup=whitespace -m ${HD_LONG_DIRTY} --cleanup=verbatim`);
    assert.strictEqual(r.status, 2,
      'a leading whitespace directive must not vouch for a trailing verbatim one');

    // Non-vacuity in BOTH directions: a single whitespace directive still
    // resolves, and a single non-whitespace one still refuses. Without these,
    // the row above passes for a guard that simply refuses every cleanup.
    assert.strictEqual(runHookCmd(`git commit --cleanup=whitespace -m ${HD_OK}`).status, 0,
      'one explicit whitespace directive is the documented default and must still resolve');
    assert.strictEqual(runHookCmd(`git commit --allow-empty --cleanup=verbatim -m ${HD_LONG_DIRTY}`).status, 2,
      'one verbatim directive must still refuse — unchanged behaviour');
  });

  test('a git-GENERATED subject is never measured against the supplied message (round 7)', () => {
    // With --squash/--fixup git composes the subject itself, so the supplied
    // message is not the subject at all. Measured recording
    // `squash! base: something` while a conforming heredoc sailed through.
    for (const [label, opt] of [['--squash', '--squash=HEAD'], ['--fixup', '--fixup=HEAD']]) {
      const r = runHookCmd(`git commit ${opt} -m ${HD_OK}`);
      assert.strictEqual(r.status, 2,
        `${label}: git composes the subject, so there is nothing in the -m text worth measuring`);
      assert.strictEqual(JSON.parse(r.stdout).code, 'CONVENTIONAL_COMMITS_VIOLATION');
    }
    assert.strictEqual(runHookCmd(`git commit -m ${HD_OK}`).status, 0, 'non-vacuity: canonical form still resolves');
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

  test('an ABSOLUTE path is not an identity either (round-8 independent review)', () => {
    // Round 4 stopped at "must be absolute", so any absolute path ENDING in
    // `/cat` was still trusted to echo its stdin — the very thing the round-4
    // reasoning rejected one spelling earlier. With an executable at
    // `/some/scratch/dir/cat` printing `WIP injected`, the resolver validated the
    // conforming heredoc body while git's real subject was `WIP injected`
    // (measured on bash 3.2.57 and 5.3.15 against a real commit: hook exit 0,
    // `git cat-file -p` subject `WIP injected`). Recognition is now the canonical
    // system locations, the only claim a string can support.
    const body = "<<'EOF'\nfeat: accepted body\nEOF\n)";
    for (const [label, prog] of [
      ['a scratch directory', '/tmp/evil/cat'],
      ['a home directory', '/Users/someone/bin/cat'],
      ['user-writable /usr/local/bin', '/usr/local/bin/cat'],
    ]) {
      assert.strictEqual(runHookCmd(`git commit -m "$(${prog} ${body}"`).status, 2,
        `${label}: an absolute path merely ENDING in cat is not known to echo its stdin`);
    }
    // Non-vacuity: the canonical spellings must all still resolve, or this guard
    // has simply disabled the feature #3802 exists for.
    for (const prog of ['cat', '/bin/cat', '/usr/bin/cat']) {
      assert.strictEqual(runHookCmd(`git commit -m "$(${prog} ${body}"`).status, 0,
        `${prog} is a canonical cat and must still resolve`);
    }
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
