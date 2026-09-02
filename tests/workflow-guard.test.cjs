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
// #3504: test-only fault injection flag for the fail-closed posture tests below.
// Makes the hook throw right after stdin parse — the internal-error vector the
// outer catch must handle without downgrading the force-add block to an allow.
const FAULT_ENV = { ...process.env, GSD_TEST_WORKFLOW_GUARD_FAULT: '1' };
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-workflow-guard.js');

function runHook(payload, timeoutMs = 5000) {
  const input = JSON.stringify(payload);
  const r = runHookSeam(HOOK_PATH, [], { input, timeoutMs });
  if (r.exitCode === 0) {
    return { exitCode: 0, stdout: r.stdout.trim(), stderr: '' };
  }
  return {
    exitCode: r.exitCode ?? 1,
    stdout: r.stdout.trim(),
    stderr: r.stderr.trim(),
  };
}

describe('#2304: Kimi tool vocabulary engages the workflow guard', () => {
  // A repo on a worktree-agent-* branch with the guard enabled: the one
  // state where the Bash branch produces an observable block, so a dormant
  // guard (silent exit 0) is distinguishable from a working one (exit 2).
  let repoDir;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-workflow-guard-'));
    const initResult = runHookSeam(
      '-c',
      ['git init -q -b worktree-agent-test && git config user.email t@t && git config user.name t'],
      { interpreter: 'bash', cwd: repoDir },
    );
    throwIfFailed(initResult, 'bash -c <git init/config for gsd-workflow-guard fixture>');
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
    assert.equal(
      output.hookSpecificOutput?.code,
      'WORKFLOW_ADVISORY',
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

// #3504 (epic #1900 F22b) — the enabled force-add guard must fail CLOSED on
// internal error. The outer catch used to be `catch { process.exit(0) }`, so
// any throw between stdin parse and the block decision silently downgraded a
// should-BLOCK call into an allow. No JSON-expressible input throws today
// (#2547/#2595 hardened every read; tokenize is total), so the fault vector is
// the hook's test-only seam GSD_TEST_WORKFLOW_GUARD_FAULT=1, which throws
// immediately after parse. The payload uses a BENIGN command — proving the
// catch's own context re-derivation blocks, not the happy-path detector.
describe('#3504: internal error fails closed for the enabled force-add guard', () => {
  function makeGuardRepo(branch, workflowGuard) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-workflow-guard-fc-'));
    const initResult = runHookSeam(
      '-c',
      [`git init -q -b ${branch} && git config user.email t@t && git config user.name t`],
      { interpreter: 'bash', cwd: dir },
    );
    throwIfFailed(initResult, `bash -c <git init/config for ${branch} fixture>`);
    fs.mkdirSync(path.join(dir, '.planning'));
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ hooks: { workflow_guard: workflowGuard } })
    );
    return dir;
  }

  function runFaultHook(payload, cwd) {
    const r = runHookSeam(HOOK_PATH, [], {
      input: JSON.stringify({ ...payload, cwd }),
      env: FAULT_ENV,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { exitCode: r.exitCode ?? 1, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  }

    describe('blocking context holds → exit 2', () => {
    let agentRepo;
    before(() => { agentRepo = makeGuardRepo('worktree-agent-test', true); });
    after(() => { cleanup(agentRepo); });

    test('internal error on a benign agent-branch Bash call blocks (exit 2)', () => {
      const r = runFaultHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, agentRepo);
      assert.equal(r.exitCode, 2,
        `fault + guard enabled + worktree-agent branch must fail CLOSED. stderr: ${r.stderr}`);
      const output = JSON.parse(r.stdout);
      assert.equal(output.code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
      assert.equal(output.origin, 'fail-closed',
        'a block emitted by the catch must identify itself structurally, not claim a detected force-add');
      assert.ok(r.stderr.length > 0, 'block reason must reach stderr (Kimi exit-2 protocol)');
    });

    test('fault before force-add detection still blocks the force-add call', () => {
      const r = runFaultHook(
        { tool_name: 'Bash', tool_input: { command: 'git add -f secrets.env' } }, agentRepo);
      assert.equal(r.exitCode, 2);
      assert.equal(JSON.parse(r.stdout).code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
    });

    test('fault on Kimi Shell vocabulary fails closed (normalization applies in the catch)', () => {
      const r = runFaultHook(
        { tool_name: 'kimi_cli.tools.shell:Shell', tool_input: { command: 'git status' } }, agentRepo);
      assert.equal(r.exitCode, 2);
      assert.equal(JSON.parse(r.stdout).code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
    });
  });

  describe('blocking context absent → exit 0 (advisory posture unchanged)', () => {
    let agentRepo;
    before(() => { agentRepo = makeGuardRepo('worktree-agent-test', true); });
    after(() => { cleanup(agentRepo); });

    test('internal error on a Write advisory stays exit 0', () => {
      const r = runFaultHook(
        { tool_name: 'Write', tool_input: { path: path.join(agentRepo, 'src', 'app.js') } },
        agentRepo);
      assert.equal(r.exitCode, 0, `advisory legs fail open by design. stderr: ${r.stderr}`);
    });

    test('unparseable payload stays exit 0', () => {
      const r = runHookSeam(HOOK_PATH, [], { input: 'not-json{', env: FAULT_ENV, timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode ?? 1, 0, 'a payload JSON.parse cannot read establishes no context');
    });
  });

  describe('guard disabled or off an agent branch → exit 0', () => {
    let mainRepo;
    let disabledRepo;
    before(() => {
      mainRepo = makeGuardRepo('main', true);
      disabledRepo = makeGuardRepo('worktree-agent-test', false);
    });
    after(() => { cleanup(mainRepo); cleanup(disabledRepo); });

    test('internal error off an agent branch stays exit 0', () => {
      const r = runFaultHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, mainRepo);
      assert.equal(r.exitCode, 0, `non-agent branch must stay allowed. stderr: ${r.stderr}`);
    });

    test('internal error with the guard disabled stays exit 0', () => {
      const r = runFaultHook(
        { tool_name: 'Bash', tool_input: { command: 'git status' } }, disabledRepo);
      assert.equal(r.exitCode, 0, `disabled guard is inert even on faults. stderr: ${r.stderr}`);
    });

    test('internal error outside a GSD project (no .planning/) stays exit 0', (t) => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-workflow-guard-bare-'));
      t.after(() => cleanup(bare));
      const initResult = runHookSeam(
        '-c',
        ['git init -q -b worktree-agent-test'],
        { interpreter: 'bash', cwd: bare, timeoutMs: PROBE_TIMEOUT_MS },
      );
      throwIfFailed(initResult, 'bash -c <git init for non-GSD fixture>');
      const r = runFaultHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, bare);
      assert.equal(r.exitCode, 0, `non-GSD dir must stay allowed. stderr: ${r.stderr}`);
    });
  });
});

// #3504 isolated-review finding 1: the force-add detector's global-flag walk
// had drifted from git-cmd.js's classifier — six flags known inline, every
// other git global option (`-c <k>=<v>`, `--no-optional-locks`,
// `--literal-pathspecs`, `--namespace=…`) broke the walk BEFORE the `add`
// token was reached, and the whole invocation was silently skipped. A silent
// miss is not a throw, so the fail-closed catch is structurally blind to it —
// these spellings must be classified by the shared walk (skipToSubcommand).
describe('#3504: global-flag spellings of git add -f reach the shared classifier', () => {
  let agentRepo;
  let mainRepo;

  before(() => {
    const mk = (branch) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-workflow-guard-bypass-'));
      // Bash FAN-OUT: three chained git commands under one `bash`
      // interpreter, not a single git plumbing call — the wrong class for
      // `PROBE_TIMEOUT_MS`. Same class as the observed CI failures in
      // tests/quick-branching.test.cjs (PR #3787 run 32668773524) and
      // tests/worktree-safety.test.cjs (`next` run 32608945654). See
      // HOOK_FANOUT_TIMEOUT_MS in ./helpers/timeouts.cjs for the class
      // rationale.
      const initResult = runHookSeam(
        '-c',
        [`git init -q -b ${branch} && git config user.email t@t && git config user.name t`],
        { interpreter: 'bash', cwd: dir, timeoutMs: HOOK_FANOUT_TIMEOUT_MS },
      );
      throwIfFailed(initResult, `bash -c <git init/config for ${branch} bypass fixture>`);
      return dir;
    };
    agentRepo = mk('worktree-agent-test');
    mainRepo = mk('main');
    for (const repo of [agentRepo, mainRepo]) {
      fs.mkdirSync(path.join(repo, '.planning'));
      fs.writeFileSync(
        path.join(repo, '.planning', 'config.json'),
        JSON.stringify({ hooks: { workflow_guard: true } })
      );
    }
  });

  after(() => {
    cleanup(agentRepo);
    cleanup(mainRepo);
  });

  function runGuard(command, cwd) {
    const r = runHookSeam(HOOK_PATH, [], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { exitCode: r.exitCode ?? 1, stdout: r.stdout.trim() };
  }

  // Each of these exited 0 pre-fix (the silent-miss bypass); each must exit 2.
  for (const [label, command] of [
    ['-c config override before the subcommand', 'git -c core.hooksPath=/tmp/x add -f secrets.env'],
    ['-c glued form (-ckey=value)', 'git -cfoo.bar=1 add -f secrets.env'],
    ['--no-optional-locks', 'git --no-optional-locks add -f secrets.env'],
    ['--literal-pathspecs', 'git --literal-pathspecs add -f secrets.env'],
    ['--namespace=… (=form argument-taking flag)', 'git --namespace=foo add -f secrets.env'],
    ['env-prefix + boolean flag combo', 'GIT_PAGER=cat git --no-replace-objects add -f secrets.env'],
    ['compound command after &&', 'cd /tmp && git add --force secrets.env'],
  ]) {
    test(`force-add is blocked behind a global flag (${label})`, () => {
      const r = runGuard(command, agentRepo);
      assert.equal(r.exitCode, 2, `must block. stderr: ${r.stderr}`);
      const output = JSON.parse(r.stdout);
      assert.equal(output.code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
      assert.equal(output.origin, 'force-add-detected');
    });
  }

  test('-C resolves the probed repo: force-add via -C at the agent repo from a main-branch cwd still blocks', () => {
    const r = runGuard(`git -C ${JSON.stringify(agentRepo)} add -f secrets.env`, mainRepo);
    assert.equal(r.exitCode, 2, 'the branch probe must follow -C to the target repo');
    assert.equal(JSON.parse(r.stdout).origin, 'force-add-detected');
  });

  test('the same spellings on a non-agent branch stay allowed (no over-block)', () => {
    const r = runGuard('git -c core.hooksPath=/tmp/x add -f secrets.env', mainRepo);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });
});
