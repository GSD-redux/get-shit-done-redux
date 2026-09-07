'use strict';

/**
 * hooks-crash-policy.test.cjs — table-driven coverage of ADR-3889 Phase 7
 * (#3911): every enforcement hook under hooks/*.js now terminates through
 * hooks/lib/hook-exit.js (allow/deny/crash) instead of a raw process.exit().
 *
 * Rather than ~76 hand-written tests (19 hooks x 4 cases), this file drives
 * ONE table — one row per hook, each row derived by reading that hook's own
 * source (never guessed) — through four generic cases:
 *
 *   C1 allow                — normal input -> exit 0.
 *   C2 deny                 — normal input that trips the hook's block path
 *                             (only the 7 hooks that HAVE one) -> exit 2,
 *                             asserting the actual stream(s) that hook uses.
 *   C3 crash honors policy  — an input that makes the hook's own outer catch
 *                             fire, asserting the exit code matches its
 *                             DECLARED HOOK_ON_CRASH policy. Hooks that never
 *                             call crash(ON_CRASH, ...) at all (no declared
 *                             policy) are t.skip()'d with an explicit reason
 *                             — never silently passed via a bare return.
 *   C4 stdin never closes   — spawn with no stdin input and never end it;
 *                             assert the process still terminates (via its
 *                             own bounded stdin-timeout -> allow()) instead
 *                             of hanging on the parent's outer spawn timeout.
 *
 * The table is the single source of truth: a guard test at the bottom
 * enumerates hooks/*.js and fails if a new terminating hook is added without
 * a row here.
 *
 * Crash trigger: malformed JSON on stdin ('{not json'). Every one of the 9
 * hooks that declares an ON_CRASH policy parses its stdin payload as the
 * FIRST statement inside its outer try — `JSON.parse(input)` (or the Kimi-
 * normalized `normalizeKimiPayload(JSON.parse(input))`) — so a syntax error
 * there throws before any applicability logic runs and is a real, hook-
 * authored crash, not a synthetic fault injected by this suite.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createTempDir, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { runHook: runHookSeam, runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const { ensureBuiltHooks } = require('../scripts/run-tests.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

// Hook scripts that ship under hooks/ but never terminate through
// hooks/lib/hook-exit.js at all — they are long-running/update-check helpers,
// not PreToolUse/PostToolUse/SessionStart enforcement hooks, so #3911's
// migration (and this table) does not apply to them.
const NON_TERMINATING_HOOKS = new Set([
  'gsd-check-update.js',
  'gsd-check-update-worker.js',
  'gsd-update-banner.js',
]);

function hookPath(name) {
  return path.join(HOOKS_DIR, name);
}

function baseEnv(extra = {}) {
  return { ...TEST_ENV_BASE, ...extra };
}

/**
 * Run a hook with a payload on stdin (or, for C4, no `input` key at all —
 * see below). Thin wrapper over the process-seam so every case in this file
 * shares one spawn path and one required timeout.
 */
function runHook(name, { payload, cwd, env, timeoutMs = 15000 } = {}) {
  const opts = { env: baseEnv(env), timeoutMs };
  if (cwd !== undefined) opts.cwd = cwd;
  if (payload !== undefined) {
    opts.input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
  return runHookSeam(hookPath(name), [], opts);
}

const MALFORMED_JSON = '{not json';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let fixtures = {};
const cleanupPaths = [];

function tempDir(prefix) {
  const dir = createTempDir(prefix);
  cleanupPaths.push(dir);
  return dir;
}

before(() => {
  // --- worktree fixture: a linked git worktree on an agent-* branch, used by
  // gsd-worktree-path-guard.js's deny case (absolute path escaping the active
  // worktree's git root) and gsd-windsurf-pre-write.js's deny case (same
  // escape shape, different protocol). ---------------------------------------
  const mainRepo = tempDir('hooks-crash-main-');
  gitOrThrow(['init', '-q', mainRepo], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['-C', mainRepo, 'config', 'user.email', 'hooks-crash@test.local'], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['-C', mainRepo, 'config', 'user.name', 'hooks-crash'], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  fs.writeFileSync(path.join(mainRepo, 'README.md'), 'hello\n');
  gitOrThrow(['-C', mainRepo, 'add', '-A'], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['-C', mainRepo, 'commit', '-m', 'seed'], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  const worktreePath = path.join(os.tmpdir(), `hooks-crash-wt-${process.pid}-${Date.now()}`);
  gitOrThrow(['-C', mainRepo, 'worktree', 'add', '-b', 'agent-test', worktreePath], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  cleanupPaths.push(worktreePath);

  // --- gsd-write-guard.js: a curated ROADMAP.md big enough to trip the 40%
  // shrink-ratio guard (well above the FLOOR_LINES=40 exemption). -------------
  const wgProject = tempDir('hooks-crash-wg-');
  fs.mkdirSync(path.join(wgProject, '.planning'), { recursive: true });
  const roadmapPath = path.join(wgProject, '.planning', 'ROADMAP.md');
  fs.writeFileSync(roadmapPath, Array.from({ length: 292 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');

  // --- gsd-workflow-guard.js: a repo on an agent-* branch with
  // hooks.workflow_guard enabled, so `git add -f` trips the ONE hard-block. --
  const wfRepo = tempDir('hooks-crash-wf-');
  gitOrThrow(['init', '-q', '-b', 'agent-test', wfRepo], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['-C', wfRepo, 'config', 'user.email', 'hooks-crash@test.local'], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['-C', wfRepo, 'config', 'user.name', 'hooks-crash'], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  fs.mkdirSync(path.join(wfRepo, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(wfRepo, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
  fs.writeFileSync(path.join(wfRepo, 'seed.txt'), 'seed\n');
  gitOrThrow(['-C', wfRepo, 'add', '-A'], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  gitOrThrow(['-C', wfRepo, 'commit', '-m', 'seed'], { timeoutMs: GIT_FIXTURE_TIMEOUT_MS });

  // --- gsd-agent-isolation-guard.js: `.planning/config.json` as a DIRECTORY
  // (EISDIR) — the guard's documented "cannot verify -> DENY" fail-closed
  // path (mirrors tests/gsd-agent-isolation-guard.test.cjs's own fixture). ---
  const aigProject = tempDir('hooks-crash-aig-');
  fs.mkdirSync(path.join(aigProject, '.planning', 'config.json'), { recursive: true });

  fixtures = { mainRepo, worktreePath, wgProject, roadmapPath, wfRepo, aigProject };
});

after(() => {
  for (const p of cleanupPaths) cleanup(p);
});

// ---------------------------------------------------------------------------
// The table — one row per enforcement hook, derived from reading its source.
// ---------------------------------------------------------------------------

const TABLE = [
  {
    file: 'gsd-worktree-path-guard.js',
    stdinTimeoutMs: 3000,
    declaredOnCrash: 'allow',
    // #3911: this hook's deny path depends on several bounded (2000ms)
    // spawnSync(git, ...) probes. Under load, a probe can time out before it
    // answers — the hook still allows (exit 0, unchanged), but now with a
    // stderr diagnostic instead of the pre-#3911 silent allow. See the C2
    // loop below and the dedicated stub-git regression suite.
    gitProbeMayRace: true,
    allow: () => ({ payload: { tool_name: 'Read' } }),
    deny: () => ({
      payload: { tool_name: 'Write', tool_input: { file_path: path.join(fixtures.mainRepo, 'README.md') } },
      cwd: fixtures.worktreePath,
    }),
    assertDeny: (r) => {
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block');
      assert.match(r.stderr, /differs from the active worktree root/);
      assert.equal(r.stderr, out.reason, 'stderr must carry the plain reason string (deny stderrPayload)');
    },
  },
  {
    file: 'gsd-write-guard.js',
    stdinTimeoutMs: 3000,
    declaredOnCrash: 'allow',
    allow: () => ({ payload: { tool_name: 'Read' } }),
    deny: () => ({
      payload: { tool_name: 'Write', tool_input: { file_path: fixtures.roadmapPath, content: 'short\n' } },
      env: { GSD_ALLOW_PLANNING_SHRINK: undefined },
    }),
    assertDeny: (r) => {
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block');
      assert.equal(out.oldLines, 292);
      assert.match(r.stderr, /shrink/);
      assert.equal(r.stderr, out.reason);
    },
  },
  {
    file: 'gsd-secret-read-guard.js',
    stdinTimeoutMs: 3000,
    declaredOnCrash: 'allow',
    allow: () => ({ payload: { tool_name: 'Bash', tool_input: { command: 'cd /proj && grep -n foo src/a.js' } } }),
    // #4221: a plain secret-file read through Bash — the exact compound shape
    // the retired Read() deny rules made prompt on Claude Code >= 2.1.259.
    deny: () => ({ payload: { tool_name: 'Bash', tool_input: { command: 'cd /proj && cat .env' } } }),
    assertDeny: (r) => {
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block');
      assert.equal(out.code, 'secret-read');
      assert.equal(out.path, '.env');
      assert.equal(r.stderr, out.reason, 'stderr must carry the plain reason string (deny stderrPayload)');
    },
  },
  {
    file: 'gsd-workflow-guard.js',
    stdinTimeoutMs: 3000,
    declaredOnCrash: 'allow',
    // #3911: the force-add block depends on a bounded (2000ms) spawnSync(git
    // branch --show-current) probe — see gitProbeMayRace note on the
    // gsd-worktree-path-guard.js row above.
    gitProbeMayRace: true,
    allow: () => ({ payload: { tool_name: 'Read' } }),
    deny: () => ({
      payload: { tool_name: 'Bash', cwd: fixtures.wfRepo, tool_input: { command: 'git add -f secret.txt' } },
    }),
    assertDeny: (r) => {
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block');
      assert.equal(out.code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
      assert.match(r.stderr, /force-add|force/i);
      assert.equal(r.stderr, out.reason);
    },
  },
  {
    file: 'gsd-context-monitor.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: 'allow',
    allow: () => ({ payload: {} }), // no session_id -> allow(undefined)
  },
  {
    file: 'gsd-config-reload.js',
    stdinTimeoutMs: 8000,
    declaredOnCrash: 'allow',
    allow: () => ({ payload: { file_path: '/tmp/not-a-gsd-config.json' } }), // basename mismatch -> allow
  },
  {
    file: 'gsd-read-injection-scanner.js',
    stdinTimeoutMs: 5000,
    declaredOnCrash: 'allow',
    allow: () => ({ payload: { tool_name: 'Bash' } }), // not in SCANNED_TOOLS -> allow
  },
  {
    file: 'gsd-prompt-guard.js',
    stdinTimeoutMs: 3000,
    declaredOnCrash: 'allow',
    allow: () => ({ payload: { tool_name: 'Read' } }),
  },
  {
    file: 'gsd-read-guard.js',
    stdinTimeoutMs: 3000,
    declaredOnCrash: 'allow',
    allow: () => ({ payload: { tool_name: 'Read' } }),
  },
  {
    file: 'gsd-agent-isolation-guard.js',
    stdinTimeoutMs: 3000,
    declaredOnCrash: 'allow',
    allow: () => ({ payload: { tool_name: 'Read' } }),
    deny: () => ({
      payload: { tool_name: 'Task', tool_input: { subagent_type: 'gsd-executor' } },
      cwd: fixtures.aigProject,
      env: { GSD_RUNTIME: undefined },
    }),
    assertDeny: (r) => {
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block');
      // REASON_CODE.CONFIG_UNREADABLE (hooks/lib/isolation-deny-reason.js) has
      // always been the lowercase string 'config_unreadable' — untouched by
      // the #3911 crash-policy migration. The uppercase literal here was
      // simply wrong.
      assert.equal(out.reason_code, 'config_unreadable');
      assert.match(r.stderr, /could not read or resolve/);
      assert.equal(r.stderr, out.reason);
    },
  },
  {
    file: 'gsd-windsurf-pre-command.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: null, // catch calls allow(undefined) directly — no HOOK_ON_CRASH declared
    allow: () => ({ payload: { tool_info: { command_line: 'ls -la' } } }),
    deny: () => ({ payload: { tool_info: { command_line: 'rm -rf /' } } }),
    assertDeny: (r) => {
      assert.equal(r.stdout, '', 'deny(undefined, reason) must skip the fd 1 write entirely');
      assert.match(r.stderr, /rm -rf targeting the filesystem root/);
    },
  },
  {
    file: 'gsd-windsurf-pre-write.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: null, // catch calls allow(undefined) directly — no HOOK_ON_CRASH declared
    // #3911: this hook's deny path depends on bounded (2000ms) spawnSync(git,
    // ...) probes, same shape as gsd-worktree-path-guard.js above.
    gitProbeMayRace: true,
    allow: () => ({ payload: { tool_info: { file_path: 'nonexistent.txt' } }, cwd: os.tmpdir() }),
    deny: () => ({
      payload: { tool_info: { file_path: path.join(fixtures.mainRepo, 'README.md') } },
      cwd: fixtures.worktreePath,
    }),
    assertDeny: (r) => {
      assert.equal(r.stdout, '', 'deny(undefined, reason) must skip the fd 1 write entirely');
      assert.match(r.stderr, /resolves to git root/);
    },
  },
  {
    file: 'gsd-statusline.js',
    stdinTimeoutMs: 3000,
    declaredOnCrash: 'allow',
    crashSkipReason:
      'the crash() call this hook declares ON_CRASH for guards only the require.main ' +
      "self-heal block (ensureRuntimeBuild() failing on an unbuilt gsd-core/bin/lib tree) — " +
      "the per-request stdin handler's own catch is a silent fail with no crash() call at all. " +
      'Forcing the self-heal path to fail would require corrupting the built lib tree or actually ' +
      'invoking a build, both out of scope for a behavioral spawn test.',
    allow: () => ({ payload: {} }),
  },
  {
    file: 'gsd-ensure-canonical-path.js',
    stdinTimeoutMs: null, // never reads stdin at all — see the C4 note below
    declaredOnCrash: null, // no HOOK_ON_CRASH import/usage; allow(undefined) is unconditional
    allow: () => ({ payload: undefined }),
  },
  {
    file: 'gsd-cursor-post-tool.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: null,
    allow: () => ({ payload: { tool_name: 'Read' } }),
  },
  {
    file: 'gsd-cursor-pre-tool.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: null,
    allow: () => ({ payload: { tool_name: 'Read' } }),
  },
  {
    file: 'gsd-cursor-session-start.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: null,
    allow: () => ({ payload: {} }),
  },
  {
    file: 'gsd-cursor-stop.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: null,
    allow: () => ({ payload: {} }),
  },
  {
    file: 'gsd-cursor-subagent-start.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: null,
    allow: () => ({ payload: {} }),
  },
  {
    file: 'gsd-cursor-subagent-stop.js',
    stdinTimeoutMs: 10000,
    declaredOnCrash: null,
    allow: () => ({ payload: {} }),
  },
];

// ---------------------------------------------------------------------------
// C1 — allow
// ---------------------------------------------------------------------------

describe('hooks-crash-policy: C1 normal allow -> exit 0', () => {
  for (const row of TABLE) {
    test(`${row.file}: allow input -> exit 0`, () => {
      const { payload, cwd, env } = row.allow();
      const r = runHook(row.file, { payload, cwd, env });
      assert.equal(r.outcome, OUTCOME.EXITED, `expected a clean exit; got ${r.outcome} stderr=${r.stderr}`);
      assert.equal(r.exitCode, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    });
  }
});

// ---------------------------------------------------------------------------
// C2 — deny (only the 7 hooks with a real block path)
// ---------------------------------------------------------------------------

describe('hooks-crash-policy: C2 normal deny -> exit 2, correct stream(s)', () => {
  const denyRows = TABLE.filter((row) => typeof row.deny === 'function');

  test('exactly 7 hooks in this table declare a deny case', () => {
    assert.equal(denyRows.length, 7, denyRows.map((r) => r.file).join(', '));
  });

  for (const row of denyRows) {
    test(`${row.file}: deny input -> exit 2` + (row.gitProbeMayRace ? ' (or an undetermined-probe allow with a diagnostic, #3911)' : ''), () => {
      const { payload, cwd, env } = row.deny();
      const r = runHook(row.file, { payload, cwd, env });
      assert.equal(r.outcome, OUTCOME.EXITED, `expected a clean exit; got ${r.outcome} stderr=${r.stderr}`);

      if (!row.gitProbeMayRace) {
        assert.equal(r.exitCode, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
        row.assertDeny(r);
        return;
      }

      // #3911: this row's deny path depends on a bounded spawnSync(git, ...)
      // probe that can, under load, time out before it answers — the ORIGINAL
      // real-race defect this test used to have (asserting exit 2 unconditionally
      // even though a slow git legitimately yields exit 0). A clean deny is
      // still the expected common case and is asserted identically to every
      // other row. The ONLY other acceptable outcome is an allow that carries a
      // non-empty stderr diagnostic naming the probe that could not run — a
      // SILENT allow (exit 0 with EMPTY stdout AND EMPTY stderr) is the actual
      // #3911 defect and MUST still fail this test.
      if (r.exitCode === 2) {
        row.assertDeny(r);
        return;
      }
      assert.equal(
        r.exitCode, 0,
        `expected either a clean deny (exit 2) or an undetermined-probe allow (exit 0); ` +
        `got exitCode=${r.exitCode}. stdout=${r.stdout} stderr=${r.stderr}`
      );
      assert.notEqual(
        r.stderr, '',
        `a git-probe timeout must emit a stderr diagnostic naming the probe (#3911) — got a ` +
        `SILENT allow (empty stdout AND empty stderr), which is the exact defect this test exists ` +
        `to catch. stdout=${r.stdout}`
      );
      assert.match(
        r.stderr, /git probe/,
        `stderr diagnostic must name the git probe that could not run; got: ${r.stderr}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// C3 — crash honors the DECLARED policy (malformed JSON forces the outer
// catch). Hooks with no declared policy are t.skip()'d, never bare-returned.
// ---------------------------------------------------------------------------

describe('hooks-crash-policy: C3 crash -> declared ON_CRASH policy', () => {
  const EXPECTED_EXIT = { allow: 0, deny: 2 };

  for (const row of TABLE) {
    test(`${row.file}: malformed-JSON crash honors declared policy`, (t) => {
      if (!row.declaredOnCrash) {
        t.skip(
          `${row.file} never calls crash(ON_CRASH, ...) — its outer catch calls allow()/nothing ` +
          'directly, so it declares no HOOK_ON_CRASH policy for this case to verify.'
        );
        return;
      }
      if (row.crashSkipReason) {
        t.skip(row.crashSkipReason);
        return;
      }
      const r = runHook(row.file, { payload: MALFORMED_JSON });
      assert.equal(r.outcome, OUTCOME.EXITED, `expected a clean exit; got ${r.outcome} stderr=${r.stderr}`);
      assert.equal(
        r.exitCode,
        EXPECTED_EXIT[row.declaredOnCrash],
        `declared ON_CRASH=${row.declaredOnCrash} -> expected exit ${EXPECTED_EXIT[row.declaredOnCrash]}; ` +
        `stdout=${r.stdout} stderr=${r.stderr}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// C4 — stdin never closes: no `input` is supplied to the seam at all, so the
// child's stdin pipe is left open. Only the hook's OWN bounded stdin-timeout
// (-> allow() -> terminateNow -> a real process.exit) can end it; a bare
// `process.exitCode = N` inside that timer would never actually terminate a
// process still blocked reading stdin. Never assert on elapsed time — only
// that it terminated, and with what code.
// ---------------------------------------------------------------------------

describe('hooks-crash-policy: C4 stdin never closes -> bounded termination, not a hang', () => {
  for (const row of TABLE) {
    test(`${row.file}: unclosed stdin still terminates`, () => {
      const outerTimeoutMs = (row.stdinTimeoutMs ?? 3000) + 10000;
      // No `payload` key at all -> the seam omits `options.input` -> the
      // child's stdin is never written to or closed by the parent.
      const r = runHook(row.file, { timeoutMs: outerTimeoutMs });
      assert.equal(
        r.outcome, OUTCOME.EXITED,
        `expected the hook's own stdin-timeout to terminate it before the outer ` +
        `${outerTimeoutMs}ms spawn bound; got ${r.outcome} (a TIMED_OUT/KILLED outcome here means ` +
        `the hook hung on stdin instead of self-terminating). stderr=${r.stderr}`
      );
      assert.equal(r.exitCode, 0, `expected the stdin-timeout's allow() fallback (exit 0); stdout=${r.stdout} stderr=${r.stderr}`);
    });
  }
});

// ---------------------------------------------------------------------------
// #3911 regression — deterministic git-probe timeout (no load required).
//
// The C2 loop above tolerates a raced timeout but cannot FORCE one: on a
// quiet machine the git probes in gsd-worktree-path-guard.js,
// gsd-workflow-guard.js, and gsd-windsurf-pre-write.js always answer well
// inside their 2000ms budget, so C2 alone would never actually exercise the
// undetermined-probe branch. This suite forces the timeout deterministically
// by putting a stub `git` on PATH that sleeps past every affected hook's own
// spawnSync timeout (2000ms) before exiting — the hook's own bounded budget,
// not real system load, is what triggers ETIMEDOUT, so this is reproducible
// on any machine. Never asserts on elapsed time — only on exit code and the
// stderr diagnostic's presence/content.
// ---------------------------------------------------------------------------

describe('hooks-crash-policy: #3911 git-probe timeout forced via a stub git -> allow WITH a diagnostic', () => {
  // Exceeds every affected hook's own spawnSync(git, ...) timeout (2000ms) —
  // the hook's timeout fires and kills the stub first, so this value only
  // needs to outlast 2000ms; it is never itself asserted on.
  const GIT_STUB_SLEEP_MS = 3000;

  let stubDir;

  before(() => {
    stubDir = tempDir('hooks-crash-git-stub-');
    // Not built on win32: the affected hooks spawn `git` via spawnSync with
    // no `shell: true` (see hooks/gsd-worktree-path-guard.js's SPAWNOPT-based
    // `spawnSync('git', args, { ...SPAWNOPT, cwd })` call), so Windows'
    // CreateProcess resolves `git.exe` only and never a PATH `.cmd`/`.bat`
    // shim — a stub written here could never be exercised. See the
    // win32-only t.skip() on each case below.
    if (process.platform !== 'win32') {
      const shPath = path.join(stubDir, 'git');
      fs.writeFileSync(shPath, `#!/bin/sh\nsleep ${(GIT_STUB_SLEEP_MS / 1000).toFixed(3)}\nexit 0\n`);
      fs.chmodSync(shPath, 0o755);
    }
  });

  // Every affected hook resolves 'git' with NO explicit `env` override on its
  // own spawnSync call (see hooks/*.js's `SPAWNOPT`/`currentBranch`), so it
  // inherits the HOOK PROCESS's own `process.env.PATH` — which is exactly the
  // `env` this test hands the hook via runHook()/baseEnv(). Setting PATH to
  // ONLY the stub dir guarantees the hook's internal git spawn resolves to
  // the stub, not a real git binary that might legitimately be fast.
  const CASES = [
    {
      file: 'gsd-worktree-path-guard.js',
      build: () => ({
        payload: { tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'gsd-3911-stub-target.txt') } },
      }),
    },
    {
      file: 'gsd-workflow-guard.js',
      build: () => {
        const wfProject = tempDir('hooks-crash-wf-stub-');
        fs.mkdirSync(path.join(wfProject, '.planning'), { recursive: true });
        fs.writeFileSync(
          path.join(wfProject, '.planning', 'config.json'),
          JSON.stringify({ hooks: { workflow_guard: true } })
        );
        return {
          payload: { tool_name: 'Bash', cwd: wfProject, tool_input: { command: 'git add -f secret.txt' } },
        };
      },
    },
    {
      file: 'gsd-windsurf-pre-write.js',
      build: () => ({
        payload: { tool_info: { file_path: 'gsd-3911-stub-target.txt' } },
        cwd: os.tmpdir(),
      }),
    },
  ];

  for (const c of CASES) {
    test(`${c.file}: git timing out still allows, WITH a stderr diagnostic naming the probe (not silent)`, (t) => {
      if (process.platform === 'win32') {
        // See hooks/gsd-worktree-path-guard.js's spawnSync('git', args, { ...SPAWNOPT, cwd })
        // call (no `shell: true`): CreateProcess resolves git.exe only.
        t.skip(
          'win32: the hooks spawn git via spawnSync without shell:true, so CreateProcess ' +
          'resolves git.exe only and never a PATH .cmd shim — the probe cannot be intercepted ' +
          'here. Covered on linux and darwin.'
        );
        return;
      }
      const { payload, cwd } = c.build();
      const r = runHook(c.file, {
        payload,
        cwd,
        // The stub dir must resolve FIRST (git() calls carry no explicit `env`
        // override, so they inherit this exact PATH) — but the stub script
        // itself still needs a working `sh`/`sleep`, so the real PATH is
        // appended after it, never before (a real `git` earlier in PATH would
        // defeat the stub entirely).
        env: { PATH: [stubDir, process.env.PATH].filter(Boolean).join(path.delimiter) },
        timeoutMs: GIT_STUB_SLEEP_MS + 15000,
      });
      assert.equal(r.outcome, OUTCOME.EXITED, `expected a clean exit; got ${r.outcome} stderr=${r.stderr}`);
      assert.equal(
        r.exitCode, 0,
        `a git-probe timeout must still ALLOW (exit code unchanged — #3911 requires no hook's ` +
        `effective default changes); stdout=${r.stdout} stderr=${r.stderr}`
      );
      assert.notEqual(
        r.stderr, '',
        `a git-probe timeout must emit a stderr diagnostic instead of the pre-#3911 SILENT allow ` +
        `(empty stdout AND empty stderr). stdout=${r.stdout}`
      );
      assert.match(
        r.stderr, /git probe/,
        `stderr diagnostic must name the git probe that could not run; got: ${r.stderr}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// hooks/dist parity (#3911 review finding) — lint:hooks-runtime-build-seam
// only checks that a hook requiring a compiled gsd-core/bin/lib/*.cjs module
// also calls ensureRuntimeBuild(); it never compares hooks/dist/** against
// hooks/**. Nothing else in the suite proves the three files P7 adds under
// hooks/lib/ (cli-exit.js, exit-code-registry.js, hook-exit.js) actually
// reach hooks/dist/lib/ — the exact shape of #770 (a new hook file silently
// missing from a copy list). This is behavioral, not a source-grep: it
// builds the real hooks/dist via the same ensureBuiltHooks() chokepoint
// scripts/run-tests.cjs uses, byte-compares the shipped copies, and spawns a
// child that actually requires and calls the SHIPPED copy from its dist
// location (proving it can resolve its sibling registry there, not just
// that the bytes exist).
// ---------------------------------------------------------------------------

describe('hooks-crash-policy: hooks/dist/lib parity (#3911 review finding)', () => {
  const HOOKS_LIB_DIR = path.join(HOOKS_DIR, 'lib');
  const DIST_LIB_DIR = path.join(HOOKS_DIR, 'dist', 'lib');
  const SEAM_FILES = ['cli-exit.js', 'exit-code-registry.js', 'hook-exit.js'];

  let buildFailure = null;

  before(() => {
    try {
      // No overrides: this deliberately builds/verifies the REAL hooks/dist,
      // the same gitignored-but-real artifact the installer ships from — a
      // temp destination would not prove anything about what users get.
      ensureBuiltHooks();
    } catch (e) {
      buildFailure = e;
    }
  });

  for (const name of SEAM_FILES) {
    test(`hooks/dist/lib/${name} exists and is byte-identical to hooks/lib/${name}`, (t) => {
      if (buildFailure) {
        t.skip(`ensureBuiltHooks() failed to populate hooks/dist: ${buildFailure.message}`);
        return;
      }
      const srcPath = path.join(HOOKS_LIB_DIR, name);
      const distPath = path.join(DIST_LIB_DIR, name);
      if (!fs.existsSync(distPath)) {
        t.skip(`${distPath} does not exist after ensureBuiltHooks() — build seam did not ship it`);
        return;
      }
      const srcBytes = fs.readFileSync(srcPath);
      const distBytes = fs.readFileSync(distPath);
      assert.ok(
        srcBytes.equals(distBytes),
        `hooks/dist/lib/${name} is not byte-identical to hooks/lib/${name} — the build seam shipped a stale or divergent copy`
      );
    });
  }

  test('the shipped hooks/dist/lib/cli-exit.js is functional from its dist location (resolves its sibling registry)', (t) => {
    if (buildFailure) {
      t.skip(`ensureBuiltHooks() failed to populate hooks/dist: ${buildFailure.message}`);
      return;
    }
    const distCliExitPath = path.join(DIST_LIB_DIR, 'cli-exit.js');
    if (!fs.existsSync(distCliExitPath)) {
      t.skip(`${distCliExitPath} does not exist after ensureBuiltHooks() — build seam did not ship it`);
      return;
    }
    // Spawn a child that requires the SHIPPED copy from ITS OWN dist
    // location and drives the one sanctioned process.exit() call site
    // (terminateNow) with a HOOK_DENY outcome. A dist copy that exists but
    // whose sibling require('./exit-code-registry.js') cannot resolve from
    // hooks/dist/lib/ (e.g. only cli-exit.js shipped, not the whole
    // directory) would throw here instead of exiting 2 — this is the case a
    // byte-comparison alone cannot catch.
    const script = [
      `const { terminateNow } = require(${JSON.stringify(distCliExitPath)});`,
      `terminateNow('HOOK_DENY', { x: 1 });`,
    ].join('\n');
    const r = runNode(['-e', script], { timeoutMs: 15000 });
    assert.equal(r.outcome, OUTCOME.EXITED, `expected a clean exit; got ${r.outcome} stderr=${r.stderr}`);
    assert.equal(r.exitCode, 2, `expected HOOK_DENY's registered exit code 2; stdout=${r.stdout} stderr=${r.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// Drift guard — the table must not silently fall behind hooks/*.js.
// ---------------------------------------------------------------------------

describe('hooks-crash-policy: table drift guard', () => {
  test('every terminating hook file under hooks/ has a table row, and vice versa', () => {
    const onDisk = fs.readdirSync(HOOKS_DIR)
      .filter((name) => name.endsWith('.js') && !NON_TERMINATING_HOOKS.has(name))
      .sort();
    const inTable = TABLE.map((row) => row.file).sort();
    assert.deepEqual(
      inTable, onDisk,
      'hooks/*.js and this table have drifted — add/remove a row so every ' +
      'enforcement hook (excluding the declared NON_TERMINATING_HOOKS) is covered.'
    );
  });

  test('NON_TERMINATING_HOOKS names actually exist on disk (no stale exclusion)', () => {
    for (const name of NON_TERMINATING_HOOKS) {
      assert.ok(fs.existsSync(hookPath(name)), `${name} is excluded but no longer exists under hooks/`);
    }
  });
});
