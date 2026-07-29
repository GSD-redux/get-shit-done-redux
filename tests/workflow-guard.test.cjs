/**
 * Tests for gsd-workflow-guard.js PreToolUse hook.
 *
 * #2304 — Kimi tool vocabulary engages the guard: Kimi CLI registers this
 * guard with matcher 'Shell|WriteFile|StrReplaceFile' and forwards its own
 * tool vocabulary (tool_name 'Shell', possibly module-qualified). kimi-cli's
 * Shell.Params names its field `command` (src/kimi_cli/tools/shell/
 * __init__.py), same as Claude's Bash, so only the tool name needs
 * normalization. Pre-fix the guard's Bash branch never matched on Kimi and
 * the force-add block was silently dormant.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-workflow-guard.js');

function runHook(payload, timeoutMs = 5000) {
  const input = JSON.stringify(payload);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
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

describe('#2304: Kimi tool vocabulary engages the workflow guard', () => {
  // A repo on a worktree-agent-* branch with the guard enabled: the one
  // state where the Bash branch produces an observable block, so a dormant
  // guard (silent exit 0) is distinguishable from a working one (exit 2).
  let repoDir;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-workflow-guard-'));
    execSync(
      'git init -q -b worktree-agent-test && git config user.email t@t && git config user.name t',
      { cwd: repoDir, stdio: 'ignore' }
    );
    fs.mkdirSync(path.join(repoDir, '.planning'));
    fs.writeFileSync(
      path.join(repoDir, '.planning', 'config.json'),
      JSON.stringify({ hooks: { workflow_guard: true } })
    );
  });

  after(() => {
    cleanup(repoDir);
  });

  test('Shell force-add on a worktree-agent branch is blocked like Bash', () => {
    const r = runHook({
      tool_name: 'Shell',
      tool_input: { command: 'git add -f secrets.env' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 2, 'Kimi Shell should reach the Bash branch and block');
    const output = JSON.parse(r.stdout);
    assert.equal(
      output.code,
      'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN',
      'block payload should carry the force-add code'
    );
    assert.ok(
      r.stderr.includes('must not run git add -f'),
      'reason must reach stderr — that is what Kimi feeds back to the model on exit 2'
    );
  });

  test('module-qualified kimi_cli.tools.shell:Shell is recognized', () => {
    const r = runHook({
      tool_name: 'kimi_cli.tools.shell:Shell',
      tool_input: { command: 'git add --force secrets.env' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 2);
    assert.equal(JSON.parse(r.stdout).code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
  });

  test('benign Shell command passes through', () => {
    const r = runHook({
      tool_name: 'Shell',
      tool_input: { command: 'git status' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  test('Bash (Claude vocabulary) still blocks — normalization is additive', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add -f secrets.env' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 2);
    assert.equal(JSON.parse(r.stdout).code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
  });

  test('WriteFile outside .planning/ gets the workflow advisory like Write', () => {
    const r = runHook({
      tool_name: 'WriteFile',
      tool_input: { path: path.join(repoDir, 'src', 'app.js'), content: 'x' },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 0);
    const output = JSON.parse(r.stdout);
    assert.ok(
      output.hookSpecificOutput?.additionalContext?.includes('WORKFLOW ADVISORY'),
      'Kimi WriteFile should reach the write branch and emit the advisory'
    );
  });

  test('StrReplaceFile editing .planning/ passes silently', () => {
    const r = runHook({
      tool_name: 'StrReplaceFile',
      tool_input: { path: path.join(repoDir, '.planning', 'notes.md'), edit: { old: 'a', new: 'b' } },
      cwd: repoDir,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  // #2547 — normalizeKimiPayload rebuilt old_string/new_string with
  // `String(e.old ?? '')`. `??` guards the value, not the dereference, so a
  // NULLISH entry threw a TypeError at the top of the handler, before the Bash
  // branch ran. The outer `catch { process.exit(0) }` swallowed it, so a Shell
  // payload carrying a spurious malformed `edit` field walked straight past the
  // force-add hard block. The `edit` field is never read on the Bash path — it
  // only has to be present to trigger the crash, which is what makes this
  // reachable from a command that has nothing to do with editing.
  //
  // The boundary is nullish specifically: `('x').old` is a legal property read
  // yielding undefined, so a string entry never threw. The `null entry` case is
  // the regression (exits 0 against pre-fix code); the rest are controls.
  describe('#2547: a spurious malformed edit field does not disarm the force-add block', () => {
    for (const [label, edit] of [
      ['null entry (the #2547 bypass)', [null]],
      // `{"toString": null}` is valid JSON whose coercion throws "Cannot
      // convert object to primitive value" — the same crash-to-allow reached
      // through String() rather than through the property read.
      ['non-coercible old (the #2547 String() bypass)', [{ old: { toString: null }, new: 'x' }]],
      ['non-coercible new (the #2547 String() bypass)', [{ old: 'x', new: { toString: null } }]],
      ['string entry (control — never threw)', ['nope']],
      ['bare null, not a list (control — normalizes to no edits)', null],
    ]) {
      test(`force-add still blocks with a spurious edit field (${label})`, () => {
        const r = runHook({
          tool_name: 'Shell',
          tool_input: { command: 'git add -f secrets.env', edit },
          cwd: repoDir,
        });
        assert.equal(r.exitCode, 2,
          `a spurious malformed edit field (${label}) must not downgrade the force-add ` +
          `block to a silent allow. Got exit ${r.exitCode}. stderr: ${r.stderr}`);
        assert.equal(JSON.parse(r.stdout).code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
      });
    }

    test('benign command with a malformed edit field still passes (no over-block)', () => {
      const r = runHook({
        tool_name: 'Shell',
        tool_input: { command: 'git status', edit: [null] },
        cwd: repoDir,
      });
      assert.equal(r.exitCode, 0, `benign command must stay allowed. stderr: ${r.stderr}`);
      assert.equal(r.stdout, '');
    });
  });
});
