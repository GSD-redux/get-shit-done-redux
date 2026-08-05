'use strict';

/**
 * Worktree Base-Ref Module — unit tests
 *
 * Seam: gsd-core/bin/lib/worktree-base-ref.cjs
 * Interface: shortSha, readBaseRefFromSettings, applyWorktreeBaseRef,
 *            resolveEffectiveBaseRef, evaluateWorktreeBaseDegrade
 *
 * Issue #683: worktree base-mismatch detection and degradation logic.
 * All tests use dependency injection (inline stubs) — no real filesystem
 * or real git is exercised.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { makeFaultyGit } = require('./helpers/faulty-deps.cjs');

const MODULE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs'
);

const {
  shortSha,
  readBaseRefFromSettings,
  applyWorktreeBaseRef,
  resolveEffectiveBaseRef,
  evaluateWorktreeBaseDegrade,
  cmdWorktreeBaseCheck,
  cmdWorktreeSetBaseRef,
} = require(MODULE_PATH);

// ─── shortSha ────────────────────────────────────────────────────────────────

describe('shortSha', () => {
  test('returns first 8 chars of a full sha', () => {
    assert.strictEqual(shortSha('abc123def456789'), 'abc123de');
  });

  test('returns the string itself when shorter than 8 chars', () => {
    assert.strictEqual(shortSha('abc12'), 'abc12');
  });

  test('returns empty string for null', () => {
    assert.strictEqual(shortSha(null), '');
  });

  test('returns empty string for empty string', () => {
    assert.strictEqual(shortSha(''), '');
  });

  test('returns exactly 8 chars when sha is exactly 8 chars', () => {
    assert.strictEqual(shortSha('12345678'), '12345678');
  });
});

// ─── readBaseRefFromSettings ─────────────────────────────────────────────────

describe('readBaseRefFromSettings', () => {
  test('returns baseRef when present as a string', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: 'head' } }), 'head');
  });

  test('returns baseRef value "fresh"', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: 'fresh' } }), 'fresh');
  });

  test('returns null when worktree is missing', () => {
    assert.strictEqual(readBaseRefFromSettings({}), null);
  });

  test('returns null when settings is null', () => {
    assert.strictEqual(readBaseRefFromSettings(null), null);
  });

  test('returns null when settings is undefined', () => {
    assert.strictEqual(readBaseRefFromSettings(undefined), null);
  });

  test('returns null when worktree is not an object (string)', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: 'not-an-object' }), null);
  });

  test('returns null when baseRef is a number (non-string)', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: 42 } }), null);
  });

  test('returns null when baseRef is null', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: null } }), null);
  });

  test('returns null when baseRef is undefined', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: undefined } }), null);
  });
});

// ─── applyWorktreeBaseRef ─────────────────────────────────────────────────────

describe('applyWorktreeBaseRef', () => {
  test('sets baseRef to "head" when absent, returns changed:true', () => {
    const settings = {};
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.skipped, null);
    assert.strictEqual(result.previous, null);
    assert.strictEqual(result.settings.worktree.baseRef, 'head');
  });

  test('sets baseRef to "head" when worktree key is missing entirely', () => {
    const settings = { other: 'value' };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('sets baseRef to "head" when worktree.baseRef is null', () => {
    const settings = { worktree: { baseRef: null, otherKey: 'keep' } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('sets baseRef to "head" when worktree.baseRef is undefined', () => {
    const settings = { worktree: { baseRef: undefined } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('preserves other worktree.* keys when setting baseRef', () => {
    const settings = { worktree: { otherKey: 'preserved', anotherKey: 123 } };
    applyWorktreeBaseRef(settings);
    assert.strictEqual(settings.worktree.otherKey, 'preserved');
    assert.strictEqual(settings.worktree.anotherKey, 123);
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('mutates settings in place and returns the same object reference', () => {
    const settings = {};
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.settings, settings);
  });

  test('returns already-head skip when baseRef is already "head"', () => {
    const settings = { worktree: { baseRef: 'head' } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'already-head');
    assert.strictEqual(result.previous, 'head');
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('returns explicit-other skip when baseRef is "fresh", does NOT overwrite', () => {
    const settings = { worktree: { baseRef: 'fresh' } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'explicit-other');
    assert.strictEqual(result.previous, 'fresh');
    assert.strictEqual(settings.worktree.baseRef, 'fresh');
  });

  test('returns explicit-other skip for any other string value', () => {
    const settings = { worktree: { baseRef: 'some-branch' } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'explicit-other');
    assert.strictEqual(result.previous, 'some-branch');
  });
});

// ─── resolveEffectiveBaseRef ──────────────────────────────────────────────────

describe('resolveEffectiveBaseRef', () => {
  // Helper to build a path-keyed readFile stub
  function makeReadFile(files) {
    return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
  }

  test('returns baseRef from settings.local.json when present', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'head');
  });

  test('falls back to settings.json when settings.local.json has no baseRef', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ other: 'value' }),
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'fresh');
  });

  test('returns null when both files are missing', () => {
    const claudeDir = '/repo/.claude';
    const deps = { readFile: () => null };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), null);
  });

  test('returns null when both files exist but have no baseRef', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ other: 'value' }),
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ other: 'value2' }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), null);
  });

  test('ignores malformed JSON in settings.local.json and falls back', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: 'not valid json {{{',
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'head');
  });

  test('ignores malformed JSON in settings.json', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: null,
        [path.join(claudeDir, 'settings.json')]: 'not valid json',
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), null);
  });

  test('settings.local.json null baseRef falls back to settings.json', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ worktree: { baseRef: null } }),
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'fresh');
  });
});

// ─── evaluateWorktreeBaseDegrade ──────────────────────────────────────────────

describe('evaluateWorktreeBaseDegrade', () => {
  // Stub helper: matches on args.join(' ') and returns canned results
  function makeExecGit(responses) {
    return function stubExecGit(args, _opts) {
      const key = args.join(' ');
      if (Object.prototype.hasOwnProperty.call(responses, key)) {
        return responses[key];
      }
      // Default: fail with a helpful error to surface unexpected calls
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  test('effectiveBaseRef="head" → no degrade, reason baseref-head, execGit never called', () => {
    let called = false;
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { called = true; return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null }; },
      effectiveBaseRef: 'head',
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(result.message, null);
    assert.strictEqual(result.headSha, null);
    assert.strictEqual(result.forkRef, null);
    assert.strictEqual(result.forkSha, null);
    assert.strictEqual(called, false, 'execGit must not be called when effectiveBaseRef is head');
  });

  test('git rev-parse HEAD fails → no degrade, reason no-head', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repo', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headSha, null);
  });

  test('git rev-parse HEAD returns empty stdout → no degrade, reason no-head', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: '', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'no-head');
  });

  // ─── #3050: fail-closed matrix for git rev-parse HEAD outcomes ─────────────
  // DECIDED RULE: degrade UNLESS git completed and gave a definitive answer.
  //   - timeout                       → degrade, reason 'head-unresolvable'
  //   - exitCode === 128              → NO degrade, reason 'no-head' (unchanged)
  //   - exit 0 with non-empty sha     → proceed (unchanged)
  //   - anything else (127, other     → degrade, reason 'head-unresolvable'
  //     non-zero, exit 0 empty stdout
  //     is pinned separately above)

  test('git rev-parse HEAD TIMES OUT → shouldDegrade:true, reason "head-unresolvable" (#3050)', () => {
    const timedOutErr = new Error('spawnSync git ETIMEDOUT');
    timedOutErr.code = 'ETIMEDOUT';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: timedOutErr },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
    assert.ok(result.message, 'a fail-closed degrade must carry a non-null explanatory message');
    assert.strictEqual(result.headSha, null);
  });

  test('cross-platform: timeout WITHOUT signal set (Windows shape) still degrades (#3050)', () => {
    // Node.js guarantees error.code === 'ETIMEDOUT' cross-platform when the
    // spawnSync `timeout` option fires; `signal` reporting is the
    // platform-fragile half and must not be required to detect a timeout.
    const timedOutErr = new Error('spawnSync git ETIMEDOUT');
    timedOutErr.code = 'ETIMEDOUT';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: null, stdout: '', stderr: '', signal: null, error: timedOutErr },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
  });

  test('git missing (exitCode 127) → degrade, reason "head-unresolvable" (#3050)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 127, stdout: '', stderr: 'git: not found', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
  });

  // Boundary coverage: 128 is the ONLY benign non-zero exit (definitive "not a
  // git repository"). 129 (limit+1) must NOT be swept into that carve-out.
  test('exitCode 129 (limit+1 boundary, just past the 128 carve-out) → degrade, reason "head-unresolvable" (#3050)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 129, stdout: '', stderr: 'fatal: something else', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
  });

  test('other non-zero, non-128 exit → degrade, reason "head-unresolvable" (#3050)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 1, stdout: '', stderr: 'fatal: something else', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
  });

  test('exitCode 128 ("not a git repository") still does NOT degrade (#3050 regression guard)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'no-head');
  });

  // ─── #3057 B8: headAbsenceVerified distinguishes the two "no-head" causes ──
  //
  // Both outcomes below keep `shouldDegrade:false, reason:'no-head'` — that
  // product decision is deliberately UNCHANGED (pinned by the regression
  // guards above and flagged in the #3050 review as still an open question).
  // What changes is that a caller can now tell git's DEFINITIVE "not a git
  // repository" answer (exit 128) apart from git completing but returning
  // nothing useful (exit 0, empty stdout) — the module's own #380-383 comment
  // named this gap; these two paired tests prove it is closed.

  test('exit 128 — git\'s definitive "not a git repository" answer → headAbsenceVerified:true', () => {
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, stderr: 'fatal: not a git repository' }],
    });
    const result = evaluateWorktreeBaseDegrade({ execGit: faultyGit });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headAbsenceVerified, true);
  });

  test('exit 0 with empty stdout — git completed but gave no useful answer → headAbsenceVerified:false', () => {
    // makeFaultyGit()'s default passthrough IS exit 0 / empty stdout / no
    // error / not timed out — a real, completed, but non-substantive answer.
    const faultyGit = makeFaultyGit();
    const result = evaluateWorktreeBaseDegrade({ execGit: faultyGit });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headAbsenceVerified, false);
  });

  test('headAbsenceVerified is null (not applicable) for a reason other than no-head', () => {
    const result = evaluateWorktreeBaseDegrade({ effectiveBaseRef: 'head' });
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(result.headAbsenceVerified, null);
  });

  test('HEAD == origin/HEAD → no degrade, reason head-matches-fork', () => {
    const HEAD_SHA = 'aabbccdd11223344aabbccdd11223344aabbccdd';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'head-matches-fork');
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkRef, 'origin/HEAD');
    assert.strictEqual(result.forkSha, HEAD_SHA);
    assert.strictEqual(result.message, null);
  });

  test('HEAD != origin/HEAD → degrade, reason head-diverged-from-fork, MSG_DIVERGED', () => {
    const HEAD_SHA = 'deadbeef11223344deadbeef11223344deadbeef';
    const FORK_SHA = 'cafebabe11223344cafebabe11223344cafebabe';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: FORK_SHA, stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-diverged-from-fork');
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkRef, 'origin/HEAD');
    assert.strictEqual(result.forkSha, FORK_SHA);
    // Verify message contains the short SHAs and the issue reference
    const expectedMsg = `⚠ Worktree base mismatch: HEAD (${HEAD_SHA.slice(0, 8)}) differs from origin/HEAD (${FORK_SHA.slice(0, 8)}). Running this phase sequentially on the main working tree. To keep parallel worktrees, set worktree.baseRef:"head" in .claude/settings.local.json (or run: gsd-tools worktree set-baseref). See #683.`;
    assert.strictEqual(result.message, expectedMsg);
  });

  test('origin/HEAD fails but symbolic-ref resolves to refs/remotes/origin/next', () => {
    const HEAD_SHA = 'aaaa1111bbbb2222aaaa1111bbbb2222aaaa1111';
    const FORK_SHA = 'cccc3333dddd4444cccc3333dddd4444cccc3333';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
        'symbolic-ref --quiet refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/next', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet refs/remotes/origin/next': { exitCode: 0, stdout: FORK_SHA, stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.forkRef, 'origin/next');
    assert.strictEqual(result.forkSha, FORK_SHA);
    // HEAD != FORK_SHA in this fixture → degrade
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-diverged-from-fork');
    assert.ok(result.message !== null);
    assert.ok(result.message.includes('origin/next'));
  });

  test('origin/HEAD fails AND symbolic-ref fails → degrade, reason fork-ref-unknown, MSG_UNKNOWN', () => {
    const HEAD_SHA = 'eeee5555ffff6666eeee5555ffff6666eeee5555';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
        'symbolic-ref --quiet refs/remotes/origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'fork-ref-unknown');
    assert.strictEqual(result.forkRef, null);
    assert.strictEqual(result.forkSha, null);
    const expectedMsg = `⚠ Cannot determine the worktree fork base (origin/HEAD unresolved). Running this phase sequentially on the main working tree to avoid a base mismatch. To keep parallel worktrees, set worktree.baseRef:"head" in .claude/settings.local.json (or run: gsd-tools worktree set-baseref). See #683.`;
    assert.strictEqual(result.message, expectedMsg);
  });

  test('cwd is passed through to execGit calls', () => {
    const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678';
    const capturedOpts = [];
    const result = evaluateWorktreeBaseDegrade({
      cwd: '/some/worktree',
      execGit: (args, opts) => {
        capturedOpts.push(opts);
        const key = args.join(' ');
        if (key === 'rev-parse HEAD') return { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null };
        if (key === 'rev-parse --verify --quiet origin/HEAD') return { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null };
        throw new Error(`Unexpected: ${key}`);
      },
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.ok(capturedOpts.length > 0);
    for (const opts of capturedOpts) {
      assert.strictEqual(opts && opts.cwd, '/some/worktree');
    }
  });

  test('symbolic-ref resolves but subsequent rev-parse fails → falls through to fork-ref-unknown', () => {
    const HEAD_SHA = 'abcd1234abcd1234abcd1234abcd1234abcd1234';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
        'symbolic-ref --quiet refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet refs/remotes/origin/main': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'fork-ref-unknown');
    assert.strictEqual(result.forkRef, null);
    assert.strictEqual(result.forkSha, null);
  });
});

// ─── cmdWorktreeBaseCheck ─────────────────────────────────────────────────────

describe('cmdWorktreeBaseCheck', () => {
  function makeExecGitCheck(responses) {
    return function stubExecGit(args, _opts) {
      const key = args.join(' ');
      if (Object.prototype.hasOwnProperty.call(responses, key)) {
        return responses[key];
      }
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  test('baseRef=head in settings → shouldDegrade false, reason baseref-head; write emits valid JSON', () => {
    const cwd = '/repo';
    const claudeDir = '/repo/.claude';
    let written = '';
    const deps = {
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
      execGit: makeExecGitCheck({}),
      write: (s) => { written += s; },
      // Hermetic: point userClaudeDir at a non-existent path so real ~/.claude is never read
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
    const parsed = JSON.parse(written);
    assert.deepStrictEqual(parsed, result);
  });

  test('diverged shas → shouldDegrade true; captured JSON parses correctly', () => {
    const cwd = '/repo';
    const HEAD_SHA = 'deadbeef11223344deadbeef11223344deadbeef';
    const FORK_SHA = 'cafebabe11223344cafebabe11223344cafebabe';
    let written = '';
    const deps = {
      readFile: () => null,
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: FORK_SHA, stderr: '', signal: null, error: null },
      }),
      write: (s) => { written += s; },
      // Hermetic: point userClaudeDir at a non-existent path so real ~/.claude is never read
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, true);
    const parsed = JSON.parse(written);
    assert.strictEqual(parsed.shouldDegrade, true);
    assert.strictEqual(parsed.reason, 'head-diverged-from-fork');
  });
});

// ─── cmdWorktreeSetBaseRef ────────────────────────────────────────────────────

describe('cmdWorktreeSetBaseRef', () => {
  test('readFile returns {} → changed true, writeFile called with worktree.baseRef "head"', () => {
    const cwd = '/repo';
    const file = path.join(cwd, '.claude', 'settings.local.json');
    let writtenPath = null;
    let writtenContent = null;
    let written = '';
    const deps = {
      readFile: () => '{}',
      existsSync: () => true,
      mkdir: () => {},
      writeFile: (p, content) => { writtenPath = p; writtenContent = content; },
      write: (s) => { written += s; },
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.file, file);
    assert.strictEqual(result.baseRef, 'head');
    assert.strictEqual(writtenPath, file);
    const parsedWritten = JSON.parse(writtenContent);
    assert.strictEqual(parsedWritten.worktree.baseRef, 'head');
    const parsedOutput = JSON.parse(written);
    assert.strictEqual(parsedOutput.changed, true);
  });

  test('readFile returns explicit-other → changed false, skipped explicit-other, writeFile NOT called', () => {
    const cwd = '/repo';
    let writeFileCalled = false;
    let written = '';
    const deps = {
      readFile: () => JSON.stringify({ worktree: { baseRef: 'fresh' } }),
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => { writeFileCalled = true; },
      write: (s) => { written += s; },
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'explicit-other');
    assert.strictEqual(result.previous, 'fresh');
    assert.strictEqual(writeFileCalled, false, 'writeFile must NOT be called for explicit-other');
    const parsedOutput = JSON.parse(written);
    assert.strictEqual(parsedOutput.changed, false);
    assert.strictEqual(parsedOutput.skipped, 'explicit-other');
  });

  test('readFile returns malformed JSON → throws refusing-to-modify error', () => {
    const cwd = '/repo';
    const file = path.join(cwd, '.claude', 'settings.local.json');
    const deps = {
      readFile: () => '{',
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => {},
      write: () => {},
    };
    assert.throws(
      () => cmdWorktreeSetBaseRef(cwd, [], deps),
      (err) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        assert.ok(err.message.includes('Refusing to modify'), `message should contain "Refusing to modify", got: ${err.message}`);
        assert.ok(err.message.includes(file), `message should contain file path, got: ${err.message}`);
        return true;
      }
    );
  });

  test('readFile returns null (missing file) → treated as {} → changed true', () => {
    const cwd = '/repo';
    let writeFileCalled = false;
    const deps = {
      readFile: () => null,
      existsSync: () => false,
      mkdir: () => {},
      writeFile: () => { writeFileCalled = true; },
      write: () => {},
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(writeFileCalled, true);
  });

  // FIX 2: non-object top-level JSON must be rejected with a clear error
  test('readFile returns "[]" (array) → throws /expected a JSON object/', () => {
    const cwd = '/repo';
    const deps = {
      readFile: () => '[]',
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => {},
      write: () => {},
    };
    assert.throws(
      () => cmdWorktreeSetBaseRef(cwd, [], deps),
      /expected a JSON object/
    );
  });

  test('readFile returns "42" (primitive) → throws /expected a JSON object/', () => {
    const cwd = '/repo';
    const deps = {
      readFile: () => '42',
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => {},
      write: () => {},
    };
    assert.throws(
      () => cmdWorktreeSetBaseRef(cwd, [], deps),
      /expected a JSON object/
    );
  });
});

// FIX 2: applyWorktreeBaseRef must reject non-object/array/null inputs

describe('applyWorktreeBaseRef — non-object inputs (FIX 2)', () => {
  test('applyWorktreeBaseRef(null) → throws TypeError', () => {
    assert.throws(
      () => applyWorktreeBaseRef(null),
      TypeError
    );
  });

  test('applyWorktreeBaseRef([]) → throws TypeError', () => {
    assert.throws(
      () => applyWorktreeBaseRef([]),
      TypeError
    );
  });
});

// ─── FIX 2: JSONC support ─────────────────────────────────────────────────────

describe('resolveEffectiveBaseRef — JSONC (FIX 2)', () => {
  function makeReadFile(files) {
    return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
  }

  test('returns baseRef from settings.local.json with // line comments', () => {
    const claudeDir = '/repo/.claude';
    const jsonc = [
      '// this is a comment',
      '{',
      '  // another comment',
      '  "worktree": {',
      '    "baseRef": "head" // inline comment',
      '  }',
      '}',
    ].join('\n');
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: jsonc,
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'head');
  });

  test('returns baseRef from settings.local.json with /* */ block comments', () => {
    const claudeDir = '/repo/.claude';
    const jsonc = [
      '/* block comment */',
      '{',
      '  "worktree": { /* inline block */ "baseRef": "fresh" }',
      '}',
      '/* trailing block */',
    ].join('\n');
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: jsonc,
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'fresh');
  });
});

describe('cmdWorktreeSetBaseRef — JSONC (FIX 2)', () => {
  test('commented-but-valid settings.local.json → updates it (changed true) rather than throwing', () => {
    const cwd = '/repo';
    const jsonc = [
      '// user comment',
      '{',
      '  // another comment',
      '  "other": "value"',
      '}',
    ].join('\n');
    let writtenContent = null;
    const deps = {
      readFile: () => jsonc,
      existsSync: () => true,
      mkdir: () => {},
      writeFile: (_p, content) => { writtenContent = content; },
      write: () => {},
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, true, 'must set baseRef when absent (even in JSONC file)');
    assert.ok(writtenContent !== null, 'must write the updated file');
    const parsed = JSON.parse(writtenContent);
    assert.strictEqual(parsed.worktree.baseRef, 'head');
  });

  test('JSONC with explicit baseRef="fresh" → skipped explicit-other, does not throw', () => {
    const cwd = '/repo';
    const jsonc = [
      '// user comment',
      '{',
      '  "worktree": {',
      '    // keeps the fork base fixed',
      '    "baseRef": "fresh"',
      '  }',
      '}',
    ].join('\n');
    let writeFileCalled = false;
    const deps = {
      readFile: () => jsonc,
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => { writeFileCalled = true; },
      write: () => {},
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'explicit-other');
    assert.strictEqual(writeFileCalled, false);
  });

  test('genuinely malformed JSON (after stripping comments) still throws refusing-to-modify', () => {
    const cwd = '/repo';
    const file = path.join(cwd, '.claude', 'settings.local.json');
    // This is malformed even after comment stripping
    const malformed = '// comment\n{ "key": }';
    const deps = {
      readFile: () => malformed,
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => {},
      write: () => {},
    };
    assert.throws(
      () => cmdWorktreeSetBaseRef(cwd, [], deps),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Refusing to modify'), `got: ${err.message}`);
        assert.ok(err.message.includes(file), `got: ${err.message}`);
        return true;
      }
    );
  });
});

// ─── FIX 3: defensive trim on git SHAs ────────────────────────────────────────

describe('evaluateWorktreeBaseDegrade — defensive trim on SHAs (FIX 3)', () => {
  function makeExecGit(responses) {
    return function stubExecGit(args, _opts) {
      const key = args.join(' ');
      if (Object.prototype.hasOwnProperty.call(responses, key)) {
        return responses[key];
      }
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  test('HEAD with trailing newline still matches origin/HEAD — no degrade', () => {
    const SHA = 'aabbccdd11223344aabbccdd11223344aabbccdd';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: SHA + '\n', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: SHA + '\n', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'head-matches-fork');
  });

  test('HEAD with trailing whitespace still diverges correctly from different origin/HEAD', () => {
    const HEAD_SHA = 'deadbeef11223344deadbeef11223344deadbeef';
    const FORK_SHA = 'cafebabe11223344cafebabe11223344cafebabe';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA + '\n', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: FORK_SHA + '\r\n', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-diverged-from-fork');
    // After trimming, headSha and forkSha should be clean
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkSha, FORK_SHA);
  });

  test('symbolic-ref stdout with trailing newline resolves correctly', () => {
    const HEAD_SHA = 'aaaa1111bbbb2222aaaa1111bbbb2222aaaa1111';
    const FORK_SHA = 'cccc3333dddd4444cccc3333dddd4444cccc3333';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA + '\n', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
        'symbolic-ref --quiet refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/next\n', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet refs/remotes/origin/next': { exitCode: 0, stdout: FORK_SHA + '\n', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.forkRef, 'origin/next');
    assert.strictEqual(result.forkSha, FORK_SHA);
    assert.strictEqual(result.shouldDegrade, true);
  });
});

// ─── resolveEffectiveBaseRef — user/global layer (#1013) ─────────────────────

describe('resolveEffectiveBaseRef — user/global layer (#1013)', () => {
  function makeReadFile(files) {
    return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
  }

  const USER_CLAUDE_DIR = '/home/user/.claude';
  const claudeDir = '/repo/.claude';

  test('(a) user/global settings.json provides baseRef:"head" when both project files absent', () => {
    const deps = {
      readFile: makeReadFile({
        [path.join(USER_CLAUDE_DIR, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), 'head');
  });

  test('(b) project local "fresh" OVERRIDES user/global "head" → returns "fresh"', () => {
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
        [path.join(USER_CLAUDE_DIR, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), 'fresh');
  });

  test('(c) project shared "fresh" (no local) OVERRIDES user/global "head" → returns "fresh"', () => {
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
        [path.join(USER_CLAUDE_DIR, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), 'fresh');
  });

  test('(d) userClaudeDir undefined → behaves as before, returns null when both project files absent', () => {
    const deps = { readFile: () => null };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, undefined), null);
  });

  test('(d) userClaudeDir null → behaves as before, returns null when both project files absent', () => {
    const deps = { readFile: () => null };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, null), null);
  });

  test('user/global settings.json absent → returns null (no fallback beyond user layer)', () => {
    const deps = {
      readFile: makeReadFile({
        // user settings.json present but has no baseRef
        [path.join(USER_CLAUDE_DIR, 'settings.json')]: JSON.stringify({ other: 'value' }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), null);
  });

  test('userClaudeDir === claudeDir → does not double-read (avoids re-reading shared settings.json)', () => {
    // When project dir IS the user dir (cwd is home), the user layer should be skipped
    // to avoid reading settings.json twice. This is enforced by the path.resolve comparison.
    const sameDir = '/home/.claude';
    let readCount = 0;
    const deps = {
      readFile: (p) => {
        readCount++;
        if (p === path.join(sameDir, 'settings.local.json')) return null;
        if (p === path.join(sameDir, 'settings.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
    };
    // resolveEffectiveBaseRef(sameDir, deps, sameDir) — userClaudeDir === claudeDir
    const result = resolveEffectiveBaseRef(sameDir, deps, sameDir);
    assert.strictEqual(result, 'head'); // still reads shared settings.json (the project layer)
    // The shared settings.json should have been read exactly once (project layer), not twice
    assert.strictEqual(readCount, 2, 'only local + shared should be read; user layer skipped when same dir');
  });
});

// ─── cmdWorktreeBaseCheck — user/global cascade (#1013 KEY REGRESSION) ───────

describe('cmdWorktreeBaseCheck — user/global cascade (#1013)', () => {
  // Phase-lane execGit: origin/HEAD probe fails (no symref either) → fork-ref-unknown → degrade
  function makePhaseLaneExecGit(HEAD_SHA) {
    return function stubExecGit(args, _opts) {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null };
      }
      if (key === 'rev-parse --verify --quiet origin/HEAD') {
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      }
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      }
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  const HEAD_SHA = 'phase1lane11223344phase1lane11223344phase';
  const USER_CLAUDE_DIR = '/home/user/.claude';
  const cwd = '/repo';
  const claudeDir = '/repo/.claude';

  test('(e positive) user/global head + phase lane → shouldDegrade:false (KEY REGRESSION)', () => {
    // This is the exact bug: user set worktree.baseRef:"head" in their global settings,
    // but without the fix that setting was invisible and the phase lane triggered degrade.
    const deps = {
      execGit: makePhaseLaneExecGit(HEAD_SHA),
      readFile: (p) => {
        // Project files: no baseRef
        if (p === path.join(claudeDir, 'settings.local.json')) return null;
        if (p === path.join(claudeDir, 'settings.json')) return null;
        // User/global file: baseRef = "head"
        if (p === path.join(USER_CLAUDE_DIR, 'settings.json')) {
          return JSON.stringify({ worktree: { baseRef: 'head' } });
        }
        return null;
      },
      write: () => {},
      userClaudeDir: USER_CLAUDE_DIR,
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, false,
      'user/global worktree.baseRef:"head" must suppress degrade on a phase lane');
    assert.strictEqual(result.reason, 'baseref-head');
  });

  test('(e negative) NO user/global head + same phase lane → shouldDegrade:true (proves lane degrades)', () => {
    // Without a user/global head, the phase lane must still degrade (proves the positive test is real)
    const deps = {
      execGit: makePhaseLaneExecGit(HEAD_SHA),
      readFile: () => null, // no project or user settings
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-dir-no-global',
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, true,
      'without user/global head, a phase lane must degrade');
    assert.strictEqual(result.reason, 'fork-ref-unknown');
  });
});
