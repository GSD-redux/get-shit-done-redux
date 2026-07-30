'use strict';

/**
 * Worktree Safety Policy Module — typed IR tests
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: resolveWorktreeContext, parseWorktreePorcelain, planWorktreePrune,
 *            executeWorktreePrunePlan, listLinkedWorktreePaths, inspectWorktreeHealth,
 *            snapshotWorktreeInventory, planWorktreeWaveCleanup,
 *            executeWorktreeWaveCleanupPlan
 *
 * Consolidated from:
 *   - tests/worktree-safety-policy.test.cjs (policy module unit tests)
 *   - tests/bug-3281-worktree-git-timeout.test.cjs (AC1–AC4: timeout/degraded-git)
 *   - tests/bug-3384-worktree-cleanup-manifest.test.cjs (manifest-scoped cleanup module)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');
const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');

const WORKTREE_SAFETY_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'
);
const CORE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'
);

const {
  resolveWorktreeContext,
  parseWorktreePorcelain,
  planWorktreePrune,
  executeWorktreePrunePlan,
  listLinkedWorktreePaths,
  inspectWorktreeHealth,
  snapshotWorktreeInventory,
  planWorktreeWaveCleanup,
  executeWorktreeWaveCleanupPlan,
  planWorktreeRecordAgent,
  cmdWorktreeRecordAgent,
  planWorktreeCreate,
  executeWorktreeCreatePlan,
  cmdWorktreeCreate,
} = require(WORKTREE_SAFETY_PATH);

const isWindows = process.platform === 'win32';

// ─── Shared stubs ─────────────────────────────────────────────────────────────

/**
 * Returns an execGit stub that simulates what spawnSync returns when the
 * subprocess is killed by SIGTERM after exceeding its timeout.
 * Per Node.js docs: result.status === null, result.signal === 'SIGTERM',
 * result.error?.code === 'ETIMEDOUT'.
 *
 * The production execGit implementation must detect this shape and:
 *   - return { ..., timedOut: true } so callers can distinguish timeout from auth failure
 *   - not throw
 */
function makeTimeoutStub() {
  return function stubTimedOutExecGit(_args, _opts) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    };
  };
}

// ─── resolveWorktreeContext ───────────────────────────────────────────────────

describe('resolveWorktreeContext', () => {
  test('prefers current directory when .planning exists', () => {
    const context = resolveWorktreeContext('/repo/wt', {
      existsSync: () => true,
      execGit: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    assert.strictEqual(context.effectiveRoot, '/repo/wt');
    assert.strictEqual(context.reason, 'has_local_planning');
    assert.strictEqual(context.mode, 'current_directory');
  });

  test('maps linked worktree to common-dir parent',
    { skip: isWindows ? 'POSIX-rooted fixture paths cannot be expressed on Windows path.resolve' : false },
    () => {
    const context = resolveWorktreeContext('/repo/wt', {
      existsSync: () => false,
      execGit: (args) => {
        if (args[1] === '--git-dir') return { exitCode: 0, stdout: '.git/worktrees/wt', stderr: '' };
        if (args[1] === '--git-common-dir') return { exitCode: 0, stdout: '../.git', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    });
    assert.strictEqual(context.effectiveRoot, '/repo');
    assert.strictEqual(context.reason, 'linked_worktree');
    assert.strictEqual(context.mode, 'linked_worktree_root');
  });

  test('falls back when git metadata is unavailable', () => {
    const context = resolveWorktreeContext('/repo/wt', {
      existsSync: () => false,
      execGit: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    assert.strictEqual(context.effectiveRoot, '/repo/wt');
    assert.strictEqual(context.reason, 'not_git_repo');
  });

  test('keeps cwd for main worktree checkout', () => {
    const context = resolveWorktreeContext('/repo/main', {
      existsSync: () => false,
      execGit: (args) => {
        if (args[1] === '--git-dir') return { exitCode: 0, stdout: '.git', stderr: '' };
        if (args[1] === '--git-common-dir') return { exitCode: 0, stdout: '.git', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    });
    assert.strictEqual(context.effectiveRoot, '/repo/main');
    assert.strictEqual(context.reason, 'main_worktree');
    assert.strictEqual(context.mode, 'current_directory');
  });

  // Counter-test: timeout returns object with effectiveRoot (Contract 6)
  test('returns valid result on timeout, not throw', () => {
    let threw = false;
    let result;
    try {
      result = resolveWorktreeContext('/tmp', { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(typeof result, 'object');
    assert.ok(
      typeof result.effectiveRoot === 'string',
      'must return effectiveRoot string even on timeout'
    );
  });
});

// ─── parseWorktreePorcelain ───────────────────────────────────────────────────

describe('parseWorktreePorcelain', () => {
  test('skips detached HEAD entries', () => {
    const porcelain = [
      'worktree /repo/main',
      'HEAD deadbeef',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-detached',
      'HEAD cafe1234',
      'detached',
      '',
      'worktree /repo/wt-feature',
      'HEAD f00dbabe',
      'branch refs/heads/feature-x',
      '',
    ].join('\n');
    const parsed = parseWorktreePorcelain(porcelain);
    assert.deepStrictEqual(parsed, [
      { path: '/repo/main', branch: 'main' },
      { path: '/repo/wt-feature', branch: 'feature-x' },
    ]);
  });
});

// ─── planWorktreePrune ────────────────────────────────────────────────────────

describe('planWorktreePrune', () => {
  test('is non-destructive by default', () => {
    const plan = planWorktreePrune('/repo/main', {}, {
      execGit: () => ({ exitCode: 0, stdout: 'worktree /repo/main\nbranch refs/heads/main\n', stderr: '' }),
      parseWorktreePorcelain: () => [{ path: '/repo/main', branch: 'main' }],
    });
    assert.strictEqual(plan.action, 'metadata_prune_only');
    assert.strictEqual(plan.reason, 'worktrees_present');
    assert.strictEqual(plan.destructiveModeRequested, false);
  });

  test('keeps metadata-prune action when destructive mode is requested (scaffold)', () => {
    const plan = planWorktreePrune('/repo/main', { allowDestructive: true }, {
      execGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
      parseWorktreePorcelain: () => [],
    });
    assert.strictEqual(plan.action, 'metadata_prune_only');
    assert.strictEqual(plan.reason, 'no_worktrees');
    assert.strictEqual(plan.destructiveModeRequested, true);
  });

  test('skips when git worktree list fails', () => {
    const plan = planWorktreePrune('/repo/main', {}, {
      execGit: () => ({ exitCode: 2, stdout: '', stderr: 'fatal' }),
    });
    assert.strictEqual(plan.action, 'skip');
    assert.strictEqual(plan.reason, 'git_list_failed');
  });

  test('still metadata-prunes when porcelain parser throws', () => {
    const plan = planWorktreePrune('/repo/main', {}, {
      execGit: () => ({ exitCode: 0, stdout: 'not-porcelain', stderr: '' }),
      parseWorktreePorcelain: () => {
        throw new Error('parse failed');
      },
    });
    assert.strictEqual(plan.action, 'metadata_prune_only');
    assert.strictEqual(plan.reason, 'no_worktrees');
  });

  // Counter-test: timeout path (Contract 6)
  test('returns action=skip when execGit times out', () => {
    let threw = false;
    let result;
    try {
      result = planWorktreePrune('/tmp', {}, { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.action, 'skip');
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'must return a non-empty reason when git times out'
    );
  });

  // AC4 strict: must use specific reason string 'git_timed_out'
  test('reason is git_timed_out (not generic git_list_failed) on timeout', () => {
    const result = planWorktreePrune('/tmp', {}, { execGit: makeTimeoutStub() });
    assert.strictEqual(
      result.reason,
      'git_timed_out',
      'must use reason=git_timed_out when execGit returns timedOut:true — not the generic git_list_failed'
    );
  });
});

// ─── executeWorktreePrunePlan ─────────────────────────────────────────────────

describe('executeWorktreePrunePlan', () => {
  test('runs git worktree prune for metadata plan', () => {
    const calls = [];
    const result = executeWorktreePrunePlan(
      { repoRoot: '/repo/main', action: 'metadata_prune_only', reason: 'worktrees_present' },
      {
        execGit: (args, opts) => {
          calls.push({ cwd: opts.cwd, args });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }
    );
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls, [{ cwd: '/repo/main', args: ['worktree', 'prune'] }]);
  });

  test('returns skip for missing plan', () => {
    const result = executeWorktreePrunePlan(null, {
      execGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'missing_plan');
  });

  test('returns skip plan unchanged without git call', () => {
    let called = false;
    const result = executeWorktreePrunePlan(
      { repoRoot: '/repo/main', action: 'skip', reason: 'git_list_failed' },
      {
        execGit: () => {
          called = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'git_list_failed');
    assert.strictEqual(called, false);
  });

  test('rejects unsupported actions', () => {
    const result = executeWorktreePrunePlan(
      { repoRoot: '/repo/main', action: 'remove_missing_paths', reason: 'explicit' },
      {
        execGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.action, 'remove_missing_paths');
    assert.strictEqual(result.reason, 'unsupported_action');
  });

  // Counter-test: timeout path (Contract 6)
  test('returns ok:false when plan is skip (timeout path)', () => {
    const plan = planWorktreePrune('/tmp', {}, { execGit: makeTimeoutStub() });
    const result = executeWorktreePrunePlan(plan, { execGit: makeTimeoutStub() });
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.ok, false, 'must return ok:false on timeout');
  });

  // AC4 strict: timedOut must be surfaced as a first-class field
  test('result.timedOut is true when prune git call times out', () => {
    const plan = {
      repoRoot: '/tmp',
      action: 'metadata_prune_only',
      reason: 'no_worktrees',
      destructiveModeRequested: false,
    };
    const result = executeWorktreePrunePlan(plan, { execGit: makeTimeoutStub() });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(
      result.timedOut,
      true,
      'must include timedOut:true in result when the execGit call returns timedOut:true'
    );
  });
});

// ─── listLinkedWorktreePaths ──────────────────────────────────────────────────

describe('listLinkedWorktreePaths', () => {
  test('parses porcelain and skips first/main path', () => {
    const listed = listLinkedWorktreePaths('/repo/main', {
      execGit: () => ({
        exitCode: 0,
        stdout: [
          'worktree /repo/main',
          'HEAD aaa',
          'branch refs/heads/main',
          '',
          'worktree /repo/wt-a',
          'HEAD bbb',
          'branch refs/heads/feat-a',
          '',
          'worktree /repo/wt-b',
          'HEAD ccc',
          'detached',
          '',
        ].join('\n'),
        stderr: '',
      }),
    });
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(listed.paths, ['/repo/wt-a', '/repo/wt-b']);
  });

  // Counter-test: failure path (Contract 6)
  test('returns ok:false on timeout, not throw', () => {
    let threw = false;
    let result;
    try {
      result = listLinkedWorktreePaths('/tmp', { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(result.ok, false);
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'must return non-empty reason on timeout'
    );
  });

  test('reason is git_timed_out on timeout', () => {
    const result = listLinkedWorktreePaths('/tmp', { execGit: makeTimeoutStub() });
    assert.strictEqual(
      result.reason,
      'git_timed_out',
      'must use reason=git_timed_out when execGit returns timedOut:true'
    );
  });
});

// ─── inspectWorktreeHealth ────────────────────────────────────────────────────

describe('inspectWorktreeHealth', () => {
  test('reports orphan and stale findings', () => {
    const health = inspectWorktreeHealth(
      '/repo/main',
      { staleAfterMs: 60 * 60 * 1000, nowMs: 2 * 60 * 60 * 1000 },
      {
        execGit: () => ({
          exitCode: 0,
          stdout: [
            'worktree /repo/main',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /repo/wt-orphan',
            'HEAD bbb',
            'branch refs/heads/feat-a',
            '',
            'worktree /repo/wt-stale',
            'HEAD ccc',
            'branch refs/heads/feat-b',
            '',
          ].join('\n'),
          stderr: '',
        }),
        existsSync: p => p !== '/repo/wt-orphan',
        statSync: () => ({ mtimeMs: 0 }),
      }
    );
    assert.strictEqual(health.ok, true);
    assert.deepStrictEqual(health.findings, [
      { kind: 'orphan', path: '/repo/wt-orphan' },
      { kind: 'stale', path: '/repo/wt-stale', ageMinutes: 120 },
    ]);
  });

  // Counter-test: timeout path (Contract 6)
  test('returns ok:false when git times out', () => {
    let threw = false;
    let result;
    try {
      result = inspectWorktreeHealth('/tmp', {}, { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.ok, false);
  });

  test('findings is empty array (not undefined) on timeout', () => {
    const result = inspectWorktreeHealth('/tmp', {}, { execGit: makeTimeoutStub() });
    assert.strictEqual(Array.isArray(result.findings), true, 'findings must be an array even when ok:false');
  });
});

// ─── snapshotWorktreeInventory ────────────────────────────────────────────────

describe('snapshotWorktreeInventory', () => {
  test('returns typed linked-worktree entries', () => {
    const inventory = snapshotWorktreeInventory(
      '/repo/main',
      { staleAfterMs: 60 * 60 * 1000, nowMs: 2 * 60 * 60 * 1000 },
      {
        execGit: () => ({
          exitCode: 0,
          stdout: [
            'worktree /repo/main',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /repo/wt-a',
            'HEAD bbb',
            'branch refs/heads/feat-a',
            '',
            'worktree /repo/wt-b',
            'HEAD ccc',
            'branch refs/heads/feat-b',
            '',
          ].join('\n'),
          stderr: '',
        }),
        existsSync: p => p !== '/repo/wt-b',
        statSync: () => ({ mtimeMs: 0 }),
      }
    );
    assert.strictEqual(inventory.ok, true);
    assert.deepStrictEqual(inventory.entries, [
      { path: '/repo/wt-a', exists: true, isStale: true, ageMinutes: 120 },
      { path: '/repo/wt-b', exists: false, isStale: false, ageMinutes: null },
    ]);
  });

  // Counter-test: timeout path (Contract 6)
  test('returns ok:false with reason on timeout, not throw', () => {
    let threw = false;
    let result;
    try {
      result = snapshotWorktreeInventory('/tmp', {}, { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.ok, false);
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'must return non-empty reason on timeout'
    );
  });

  test('reason is git_timed_out on timeout', () => {
    const result = snapshotWorktreeInventory('/tmp', {}, { execGit: makeTimeoutStub() });
    assert.strictEqual(
      result.reason,
      'git_timed_out',
      'must use reason=git_timed_out when execGit returns timedOut:true'
    );
  });
});

// ─── Degraded-git prune flow (AC3) ───────────────────────────────────────────

describe('prune flow under degraded git', () => {
  test('full prune flow (plan -> execute) completes without throwing on timeout', () => {
    let threw = false;
    try {
      const plan = planWorktreePrune('/tmp', {}, { execGit: makeTimeoutStub() });
      executeWorktreePrunePlan(plan, { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'full prune flow must not throw on timeout — must degrade gracefully');
  });
});

// ─── planWorktreeWaveCleanup ──────────────────────────────────────────────────

describe('planWorktreeWaveCleanup', () => {
  test('includes only manifest entries and never discovers global agent worktrees', () => {
    const plan = planWorktreeWaveCleanup('/repo/main', {
      worktrees: [
        {
          agent_id: 'a1',
          worktree_path: '/repo/.claude/worktrees/agent-a1',
          branch: 'worktree-agent-a1',
          expected_base: 'abc123',
          allowed_bases: ['abc123', 'def456'],
        },
      ],
    });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.entries.map((entry) => ({
      agent_id: entry.agent_id,
      worktree_path: entry.worktree_path,
      branch: entry.branch,
      expected_base: entry.expected_base,
      allowed_bases: entry.allowed_bases,
    })), [{
      agent_id: 'a1',
      worktree_path: '/repo/.claude/worktrees/agent-a1',
      branch: 'worktree-agent-a1',
      expected_base: 'abc123',
      allowed_bases: ['abc123', 'def456'],
    }]);
    assert.equal(plan.discovery, 'manifest');
  });

  // Counter-test: invalid entries rejected (Contract 6)
  test('rejects entries without expected base or disposable branch namespace', () => {
    const plan = planWorktreeWaveCleanup('/repo/main', {
      worktrees: [
        {
          agent_id: 'missing-base',
          worktree_path: '/repo/.claude/worktrees/agent-missing-base',
          branch: 'worktree-agent-missing-base',
        },
        {
          agent_id: 'feature-branch',
          worktree_path: '/repo/.claude/worktrees/agent-feature',
          branch: 'feature/user-work',
          expected_base: 'abc123',
        },
      ],
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'empty_manifest');
    assert.deepEqual(plan.entries, []);
  });
});

// ─── planWorktreeRecordAgent (#1298 writer verb) ──────────────────────────────
// These tests pin the verb's reason for existing: a per-agent entry that
// record-agent ACCEPTS must survive the cleanup-wave reader, and one it REJECTS
// is exactly what the reader would have dropped silently. If write- and
// read-side validation ever diverge, the round-trip tests below fail.

describe('planWorktreeRecordAgent', () => {
  const VALID = {
    agentId: 'a1',
    worktreePath: '/repo/.claude/worktrees/agent-a1',
    branch: 'worktree-agent-a1',
    base: 'abc123',
  };

  test('appends a validated entry that the cleanup-wave reader accepts (write/read parity)', () => {
    const plan = planWorktreeRecordAgent('{"orchestrator_root":"/repo/main","worktrees":[]}', VALID);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.entry, {
      agent_id: 'a1',
      worktree_path: '/repo/.claude/worktrees/agent-a1',
      branch: 'worktree-agent-a1',
      expected_base: 'abc123',
    });
    // The serialized manifest must round-trip through the reader the cleanup
    // path uses — proving write and read validate identically.
    const written = JSON.parse(plan.manifest);
    assert.equal(written.orchestrator_root, '/repo/main'); // preserved, no schema change
    const readBack = planWorktreeWaveCleanup('/repo/main', written);
    assert.equal(readBack.ok, true);
    assert.equal(readBack.entries.length, 1);
    assert.equal(readBack.entries[0].agent_id, 'a1');
  });

  test('preserves existing entries and other top-level keys when appending', () => {
    const existing = JSON.stringify({
      orchestrator_root: '/repo/main',
      worktrees: [{
        agent_id: 'a0',
        worktree_path: '/repo/.claude/worktrees/agent-a0',
        branch: 'worktree-agent-a0',
        expected_base: 'aaa000',
      }],
    });
    const plan = planWorktreeRecordAgent(existing, VALID);
    assert.equal(plan.ok, true);
    const written = JSON.parse(plan.manifest);
    assert.equal(written.orchestrator_root, '/repo/main');
    assert.equal(written.worktrees.length, 2);
    assert.deepEqual(written.worktrees.map((w) => w.agent_id), ['a0', 'a1']);
  });

  test('accepts a bare top-level array manifest', () => {
    const plan = planWorktreeRecordAgent('[]', VALID);
    assert.equal(plan.ok, true);
    const written = JSON.parse(plan.manifest);
    assert.ok(Array.isArray(written));
    assert.equal(written.length, 1);
    assert.equal(written[0].branch, 'worktree-agent-a1');
  });

  // Write-strict agent_id: the reader treats agent_id as nullable, but the
  // writer requires it — an entry whose author cannot be identified defeats the
  // verb's purpose. This is the deliberate write-strict-vs-read-lenient decision.
  test('fails loudly when --agent-id is empty (write-strict, unlike the lenient reader)', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, agentId: '' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'missing_field');
    assert.match(plan.hint, /--agent-id/);
    assert.equal(plan.manifest, null);
  });

  test('reports every missing field, not just the first', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', {
      agentId: '', worktreePath: '', branch: '', base: '',
    });
    assert.equal(plan.reason, 'missing_field');
    for (const flag of ['--agent-id', '--path', '--branch', '--base']) {
      assert.match(plan.hint, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  // Branch-regex consistency caveat: a branch outside the disposable namespace
  // is what the reader drops silently — record-agent must reject it at write time.
  test('rejects a branch outside the worktree-agent-* namespace (the entry the reader would drop)', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, branch: 'feature/user-work' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'invalid_entry');
    assert.match(plan.hint, /worktree-agent-/);
    assert.equal(plan.manifest, null);
    // Confirm the rejected entry is genuinely one the reader drops.
    const readBack = planWorktreeWaveCleanup('/repo/main', {
      worktrees: [{ agent_id: 'a1', worktree_path: VALID.worktreePath, branch: 'feature/user-work', expected_base: 'abc123' }],
    });
    assert.equal(readBack.ok, false);
    assert.equal(readBack.reason, 'empty_manifest');
  });

  test('accepts the current agent-<id> namespace (#1995)', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, branch: 'agent-a1' });
    assert.equal(plan.ok, true);
    assert.equal(plan.entry.branch, 'agent-a1');
    const readBack = planWorktreeWaveCleanup('/repo/main', JSON.parse(plan.manifest));
    assert.equal(readBack.ok, true);
    assert.equal(readBack.entries.length, 1);
    assert.equal(readBack.entries[0].branch, 'agent-a1');
  });

  test('fails loudly on malformed manifest JSON instead of clobbering it', () => {
    const plan = planWorktreeRecordAgent('{not valid json', VALID);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'invalid_manifest_json');
    assert.equal(plan.manifest, null);
  });

  test('rejects a manifest whose worktrees field is not an array', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":{}}', VALID);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'manifest_shape_invalid');
    assert.equal(plan.manifest, null);
  });

  // The reader dedups on (worktree_path, branch); a re-record would be silently
  // dropped at cleanup — exactly the failure mode the verb exists to eliminate —
  // so the writer must reject it loudly rather than swallow it.
  test('rejects a duplicate (worktree_path, branch) loudly instead of writing a droppable entry', () => {
    const existing = JSON.stringify({
      worktrees: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    });
    // Same path+branch, different agent_id/base — still a duplicate by the reader's key.
    const plan = planWorktreeRecordAgent(existing, { ...VALID, agentId: 'a1-retry', base: 'deadbee' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'duplicate_entry');
    assert.match(plan.hint, /worktree-agent-a1/);
    assert.equal(plan.manifest, null);
  });

  test('detects a duplicate stored under the legacy `path` field too', () => {
    const existing = JSON.stringify({
      worktrees: [{ path: '/repo/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1', expected_base: 'abc123' }],
    });
    const plan = planWorktreeRecordAgent(existing, VALID);
    assert.equal(plan.reason, 'duplicate_entry');
  });

  // Reader-alignment: the cleanup reader dedups only over entries that normalize
  // successfully, so a malformed same-key entry it would DROP must not block a
  // valid recording — otherwise the writer is stricter than the reader and
  // blocks legitimate recovery.
  test('a malformed same-key existing entry does not block recording a valid one', () => {
    const existing = JSON.stringify({
      // Same path+branch as VALID but no expected_base — the reader drops this.
      worktrees: [{ worktree_path: '/repo/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1' }],
    });
    const plan = planWorktreeRecordAgent(existing, VALID);
    assert.equal(plan.ok, true);
    const readBack = planWorktreeWaveCleanup('/repo/main', JSON.parse(plan.manifest));
    assert.equal(readBack.ok, true);
    assert.equal(readBack.entries.length, 1); // reader keeps only the valid one
    assert.equal(readBack.entries[0].expected_base, 'abc123');
  });

  test('rejects whitespace-only --path/--base (values are trimmed)', () => {
    const wsPath = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, worktreePath: '   ' });
    assert.equal(wsPath.reason, 'missing_field');
    assert.match(wsPath.hint, /--path/);
    const wsBase = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, base: '  \t ' });
    assert.equal(wsBase.reason, 'missing_field');
    assert.match(wsBase.hint, /--base/);
  });

  test('trims incidental surrounding whitespace on accepted values', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', {
      agentId: ' a1 ', worktreePath: ' /repo/wt-a1 ', branch: ' worktree-agent-a1 ', base: ' abc123 ',
    });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.entry, {
      agent_id: 'a1', worktree_path: '/repo/wt-a1', branch: 'worktree-agent-a1', expected_base: 'abc123',
    });
  });
});

// ─── planWorktreeRecordAgent — property-based write/read parity (#1298) ────────
// The verb's reason for existing is the write→read parity invariant, so it must
// carry a fast-check property test (RULESET.TESTS.property-based-testing): an
// entry the writer ACCEPTS must survive the cleanup reader unchanged, and an
// entry with an invalid branch must be REJECTED symmetrically.

describe('planWorktreeRecordAgent — fast-check parity invariant (#1298)', () => {
  const seg = fc.stringMatching(/^[A-Za-z0-9._/-]+$/); // include '/' — the namespace allows it
  const legacyAgentBranch = seg.map((s) => `worktree-agent-${s}`);
  const currentAgentBranch = seg.map((s) => `agent-${s}`);
  const agentBranch = fc.oneof(legacyAgentBranch, currentAgentBranch);
  const nonEmpty = fc.stringMatching(/^\S[\S ]*$/); // no leading whitespace, not blank

  test('any writer-accepted entry round-trips through the cleanup reader unchanged', () => {
    fc.assert(fc.property(
      fc.record({ agentId: nonEmpty, worktreePath: nonEmpty, branch: agentBranch, base: nonEmpty }),
      (fields) => {
        const plan = planWorktreeRecordAgent('{"worktrees":[]}', fields);
        if (!plan.ok) return; // rejection is fine; this property is about accepted entries
        const readBack = planWorktreeWaveCleanup('/repo/main', JSON.parse(plan.manifest));
        assert.equal(readBack.ok, true);
        assert.equal(readBack.entries.length, 1);
        const e = readBack.entries[0];
        assert.equal(e.worktree_path, fields.worktreePath.trim());
        assert.equal(e.branch, fields.branch.trim());
        assert.equal(e.expected_base, fields.base.trim());
        assert.equal(e.agent_id, fields.agentId.trim());
      },
    ));
  });

  test('an entry with a branch outside the worktree-agent-* namespace is always rejected', () => {
    fc.assert(fc.property(
      fc.record({
        agentId: nonEmpty,
        worktreePath: nonEmpty,
        // Any branch that does NOT match the disposable namespace.
        branch: fc.string({ minLength: 1 }).filter((b) => !/^(worktree-)?agent-[A-Za-z0-9._/-]+$/.test(b.trim())),
        base: nonEmpty,
      }),
      (fields) => {
        const plan = planWorktreeRecordAgent('{"worktrees":[]}', fields);
        assert.equal(plan.ok, false);
        assert.equal(plan.manifest, null);
      },
    ));
  });
});

// ─── branch namespace boundary tests (#1995) ─────────────────────────────────
// Claude Code's isolation="worktree" branch naming changed from worktree-agent-<id>
// to agent-<id>. Both namespaces must be accepted; non-agent branches rejected.

describe('worktree branch namespace boundaries (#1995)', () => {
  const ACCEPTED_BRANCHES = [
    'agent-a1',
    'agent-abc123',
    'agent-session.42',
    'worktree-agent-a1',
    'worktree-agent-abc123',
    'worktree-agent-session.42',
  ];
  const REJECTED_BRANCHES = [
    'feature-x',
    'main',
    'agent',
    'worktree-agent',
    'xagent-y',
    'worktree-foo',
    'worktree-agent-',
    'agent-',
    '',
  ];

  for (const branch of ACCEPTED_BRANCHES) {
    test(`planWorktreeRecordAgent accepts branch "${branch}"`, () => {
      const plan = planWorktreeRecordAgent('{"worktrees":[]}', {
        agentId: 'a1', worktreePath: '/repo/wt', branch, base: 'abc123',
      });
      assert.equal(plan.ok, true, `expected branch "${branch}" to be accepted`);
      assert.equal(plan.entry.branch, branch);
    });
  }

  for (const branch of REJECTED_BRANCHES) {
    test(`planWorktreeRecordAgent rejects branch "${branch}"`, () => {
      const plan = planWorktreeRecordAgent('{"worktrees":[]}', {
        agentId: 'a1', worktreePath: '/repo/wt', branch, base: 'abc123',
      });
      if (branch === '') {
        assert.equal(plan.reason, 'missing_field');
      } else {
        assert.equal(plan.ok, false, `expected branch "${branch}" to be rejected`);
        assert.equal(plan.reason, 'invalid_entry');
        assert.match(plan.hint, /\(worktree-\)\?agent-/);
      }
    });
  }

  test('cleanup-wave retains agent-<id> entries alongside worktree-agent-<id> entries', () => {
    const manifest = {
      orchestrator_root: '/repo/main',
      worktrees: [
        { agent_id: 'a1', worktree_path: '/repo/wt-a1', branch: 'agent-a1', expected_base: 'abc' },
        { agent_id: 'a2', worktree_path: '/repo/wt-a2', branch: 'worktree-agent-a2', expected_base: 'def' },
      ],
    };
    const result = planWorktreeWaveCleanup('/repo/main', manifest);
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 2);
    assert.deepEqual(result.entries.map((e) => e.branch), ['agent-a1', 'worktree-agent-a2']);
  });

  test('hint string names the widened accepted pattern', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', {
      agentId: 'a1', worktreePath: '/repo/wt', branch: 'feature-x', base: 'abc123',
    });
    assert.equal(plan.ok, false);
    assert.match(plan.hint, /\(worktree-\)\?agent-\[A-Za-z0-9\._\/-\]\+/);
  });
});

// ─── cmdWorktreeRecordAgent (#1298 CLI wrapper) ───────────────────────────────

describe('cmdWorktreeRecordAgent', () => {
  // process.exitCode is global; each failure-path test resets it so a failing
  // exit code does not leak into the test runner's own exit status.
  function withExitCode(fn) {
    const saved = process.exitCode;
    try { return fn(); } finally { process.exitCode = saved; }
  }

  const okArgs = [
    '--manifest', 'manifest.json',
    '--agent-id', 'a1',
    '--path', '/repo/.claude/worktrees/agent-a1',
    '--branch', 'worktree-agent-a1',
    '--base', 'abc123',
  ];

  test('writes the manifest and reports ok on the happy path', () => {
    let writtenPath = null;
    let writtenContent = null;
    const out = [];
    const result = cmdWorktreeRecordAgent('/repo/main', okArgs, {
      readFile: () => '{"orchestrator_root":"/repo/main","worktrees":[]}',
      writeFile: (p, c) => { writtenPath = p; writtenContent = c; },
      write: (s) => out.push(s),
      writeErr: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(writtenPath, path.resolve('/repo/main', 'manifest.json'));
    const written = JSON.parse(writtenContent);
    assert.equal(written.worktrees.length, 1);
    assert.equal(written.worktrees[0].agent_id, 'a1');
    assert.match(out.join(''), /"ok": true/);
  });

  test('accepts the current agent-<id> namespace via CLI (#1995)', () => {
    let writtenContent = null;
    const agentArgs = [
      '--manifest', 'manifest.json',
      '--agent-id', 'a1',
      '--path', '/repo/.claude/worktrees/agent-a1',
      '--branch', 'agent-a1',
      '--base', 'abc123',
    ];
    const result = cmdWorktreeRecordAgent('/repo/main', agentArgs, {
      readFile: () => '{"orchestrator_root":"/repo/main","worktrees":[]}',
      writeFile: (_p, c) => { writtenContent = c; },
      write: () => {},
      writeErr: () => {},
    });
    assert.equal(result.ok, true);
    const written = JSON.parse(writtenContent);
    assert.equal(written.worktrees[0].branch, 'agent-a1');
  });

  test('exits 2 with usage when --manifest is missing', () => {
    withExitCode(() => {
      const errs = [];
      const result = cmdWorktreeRecordAgent('/repo/main', ['--agent-id', 'a1'], {
        writeErr: (s) => errs.push(s),
        write: () => {},
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'usage');
      assert.equal(process.exitCode, 2);
      assert.match(errs.join(''), /Usage: worktree record-agent/);
    });
  });

  test('exits 1 loudly when the manifest cannot be read', () => {
    withExitCode(() => {
      const errs = [];
      const result = cmdWorktreeRecordAgent('/repo/main', okArgs, {
        readFile: () => { throw new Error('ENOENT'); },
        writeErr: (s) => errs.push(s),
        write: () => {},
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'manifest_read_failed');
      assert.equal(process.exitCode, 1);
      assert.match(errs.join(''), /manifest_read_failed/);
    });
  });

  test('does not write the manifest when the entry is invalid', () => {
    withExitCode(() => {
      let wrote = false;
      const errs = [];
      const result = cmdWorktreeRecordAgent('/repo/main',
        ['--manifest', 'm.json', '--agent-id', 'a1', '--path', '/p', '--branch', 'feature/x', '--base', 'abc123'], {
          readFile: () => '{"worktrees":[]}',
          writeFile: () => { wrote = true; },
          writeErr: (s) => errs.push(s),
          write: () => {},
        });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid_entry');
      assert.equal(wrote, false); // must NOT append an under-populated entry
      assert.equal(process.exitCode, 1);
      assert.match(errs.join(''), /worktree-agent-/);
    });
  });
});

// ─── record-agent: real CLI dispatch + workflow wiring (#1298 integration) ────
// The unit tests above inject IO; these pin the live `gsd-tools.cjs query
// worktree.record-agent` dispatch and the execute-phase.md call site, so a
// future typo in the dotted command or the workflow wiring fails loudly.

describe('worktree record-agent — real CLI dispatch (#1298)', () => {
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  test('the dotted `query worktree.record-agent` path writes an entry the cleanup reader accepts', () => {
    const dir = createTempDir();
    try {
      const manifest = path.join(dir, 'wave-manifest.json');
      fs.writeFileSync(manifest, `${JSON.stringify({ orchestrator_root: dir, worktrees: [] })}\n`);
      const out = execFileSync(process.execPath, [
        GSD_TOOLS, 'query', 'worktree.record-agent',
        '--manifest', manifest,
        '--agent-id', 'a1',
        '--path', path.join(dir, 'wt-a1'),
        '--branch', 'worktree-agent-a1',
        '--base', 'abc123',
      ], { encoding: 'utf8' });
      assert.match(out, /"ok": true/);
      const written = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      assert.equal(written.worktrees.length, 1);
      assert.equal(written.worktrees[0].agent_id, 'a1');
      // What the live CLI wrote must read back through the cleanup reader.
      const readBack = planWorktreeWaveCleanup(dir, written);
      assert.equal(readBack.ok, true);
      assert.equal(readBack.entries[0].branch, 'worktree-agent-a1');
    } finally {
      cleanup(dir);
    }
  });

  test('a missing field fails loudly via the real CLI (non-zero exit, manifest untouched)', () => {
    const dir = createTempDir();
    try {
      const manifest = path.join(dir, 'wave-manifest.json');
      fs.writeFileSync(manifest, `${JSON.stringify({ worktrees: [] })}\n`);
      let threw = false;
      try {
        execFileSync(process.execPath, [
          GSD_TOOLS, 'query', 'worktree.record-agent',
          '--manifest', manifest,
          '--path', path.join(dir, 'wt'), '--branch', 'worktree-agent-x', '--base', 'abc123',
        ], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /record-agent: missing_field/);
      }
      assert.ok(threw, 'CLI must exit non-zero when --agent-id is missing');
      assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).worktrees, []);
    } finally {
      cleanup(dir);
    }
  });

  test('the execute-phase.md per-agent append calls the record-agent verb', () => {
    const wf = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8',
    );
    assert.match(wf, /worktree\.record-agent/, 'execute-phase.md must wire the record-agent verb');
  });
});

// ─── worktree create (#2584 ADR-1239 Codex-binding amendment — Phase 2) ───────
// UNCONSUMED in Phase 2: no scheduler calls this yet (Phase 3 wires it). These
// tests pin the git-worktree-creation primitive itself.

describe('planWorktreeCreate', () => {
  const okFields = {
    agentId: 'a1',
    worktreePath: '/repo/.claude/worktrees/agent-a1',
    branch: 'worktree-agent-a1',
    base: 'abc123',
  };

  test('happy path returns ok:true with the normalized entry', () => {
    const plan = planWorktreeCreate(okFields);
    assert.equal(plan.ok, true);
    assert.equal(plan.reason, 'ok');
    assert.equal(plan.entry.agent_id, 'a1');
    assert.equal(plan.entry.worktree_path, okFields.worktreePath);
    assert.equal(plan.entry.branch, 'worktree-agent-a1');
    assert.equal(plan.entry.expected_base, 'abc123');
  });

  test('missing --agent-id reports the missing flag', () => {
    const plan = planWorktreeCreate({ ...okFields, agentId: '' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'missing_field');
    assert.match(plan.hint, /--agent-id/);
    assert.equal(plan.entry, null);
  });

  test('whitespace-only field is treated as missing', () => {
    const plan = planWorktreeCreate({ ...okFields, base: '   ' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'missing_field');
    assert.match(plan.hint, /--base/);
  });

  test('branch-regex fail-closed: a branch outside the worktree-agent-* namespace is rejected', () => {
    const plan = planWorktreeCreate({ ...okFields, branch: 'not-worktree-agent-x' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'invalid_entry');
    assert.equal(plan.entry, null);
  });

  test('accepts the current agent-<id> namespace (#1995)', () => {
    const plan = planWorktreeCreate({ ...okFields, branch: 'agent-a1' });
    assert.equal(plan.ok, true);
    assert.equal(plan.entry.branch, 'agent-a1');
  });

  // ─── #2584 FIX 4: git argument-injection + path-traversal guards ──────────

  test('FIX4: a leading-dash branch is rejected (fail-closed via the pre-existing branch-namespace regex)', () => {
    // The leading-dash guard runs AFTER normalizeCleanupManifestEntry (per the
    // fix ordering), and WORKTREE_AGENT_BRANCH_RE anchors on `^(worktree-)?agent-`
    // — no string starting with '-' can ever match it. So a dash-prefixed branch
    // is already fully fail-closed by the EARLIER regex gate (reason
    // 'invalid_entry') and never reaches the leading-dash check at all; the
    // net security property (a branch value can never reach git as a bare
    // flag) holds either way.
    const plan = planWorktreeCreate({ ...okFields, branch: '-x' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'invalid_entry');
    assert.equal(plan.entry, null);
  });

  test('FIX4: a leading-dash base is rejected', () => {
    const plan = planWorktreeCreate({ ...okFields, base: '-f' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'unsafe_leading_dash');
  });

  test('FIX4: a leading-dash path is rejected', () => {
    const plan = planWorktreeCreate({ ...okFields, worktreePath: '-f' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'unsafe_leading_dash');
  });

  test('FIX4: a ".." path-traversal segment is rejected (POSIX separator)', () => {
    const plan = planWorktreeCreate({ ...okFields, worktreePath: 'a/../../etc/x' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'unsafe_path_traversal');
  });

  test('FIX4: a ".." path-traversal segment is rejected (Windows separator)', () => {
    const plan = planWorktreeCreate({ ...okFields, worktreePath: 'a\\..\\..\\etc\\x' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'unsafe_path_traversal');
  });

  test('FIX4: a normal path with a hyphen in a segment name still passes', () => {
    const plan = planWorktreeCreate({ ...okFields, worktreePath: '/tmp/wt-1' });
    assert.equal(plan.ok, true);
  });

  test('FIX4: an absolute path is NOT rejected (the orchestrator legitimately uses absolute paths)', () => {
    const plan = planWorktreeCreate({ ...okFields, worktreePath: '/repo/.claude/worktrees/agent-a1' });
    assert.equal(plan.ok, true);
    assert.equal(plan.entry.worktree_path, '/repo/.claude/worktrees/agent-a1');
  });
});

describe('executeWorktreeCreatePlan', () => {
  const okFields = {
    agentId: 'a1',
    worktreePath: '/repo/.claude/worktrees/agent-a1',
    branch: 'worktree-agent-a1',
    base: 'abc123',
  };

  test('base_unresolved: a non-zero rev-parse --verify blocks BEFORE any worktree add is attempted', () => {
    const plan = planWorktreeCreate(okFields);
    const calls = [];
    const execGit = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: 'fatal: bad revision', timedOut: false };
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const result = executeWorktreeCreatePlan(plan, '/repo/main', { execGit });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'base_unresolved');
    assert.ok(!calls.some((c) => c[0] === 'worktree'), 'must NOT attempt `git worktree add` when the base is unresolved');
  });

  test('successful create: ok:true, cwd is the posix-normalized worktree path', () => {
    const plan = planWorktreeCreate(okFields);
    const calls = [];
    const execGit = (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const result = executeWorktreeCreatePlan(plan, '/repo/main', { execGit });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'created');
    assert.equal(result.cwd, okFields.worktreePath);
    assert.equal(result.worktree_path, okFields.worktreePath);
    assert.equal(result.branch, 'worktree-agent-a1');
    assert.equal(result.base, 'abc123');
    assert.ok(calls.some((c) => c[0] === 'worktree' && c[1] === 'add'), 'must call `git worktree add`');
  });

  test('timeout on the base check degrades to git_timeout — does not throw, and no rollback is attempted (nothing was created)', () => {
    const plan = planWorktreeCreate(okFields);
    const calls = [];
    const timeoutStub = makeTimeoutStub();
    const execGit = (args, opts) => { calls.push(args); return timeoutStub(args, opts); };
    const result = executeWorktreeCreatePlan(plan, '/repo/main', { execGit });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'git_timeout');
    assert.ok(!calls.some((c) => c[0] === 'worktree'), 'must NOT attempt any `git worktree` call (nothing was ever created)');
  });

  test('FIX3: timeout on `git worktree add` degrades to git_timeout AND best-effort rolls back the partial worktree', () => {
    const plan = planWorktreeCreate(okFields);
    const timeoutStub = makeTimeoutStub();
    const calls = [];
    const execGit = (args, opts) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      return timeoutStub(args, opts);
    };
    const result = executeWorktreeCreatePlan(plan, '/repo/main', { execGit });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'git_timeout');
    const rollbackCall = calls.find((c) => c[0] === 'worktree' && c[1] === 'remove');
    assert.ok(rollbackCall, 'a best-effort `git worktree remove --force` rollback must be attempted');
    assert.ok(rollbackCall.includes('--force'));
    assert.equal(rollbackCall[rollbackCall.length - 1], okFields.worktreePath);
  });

  test('FIX5 [data-loss guard]: worktree_add_failed (clean collision exit) does NOT roll back — leaves a pre-existing peer worktree untouched', () => {
    // The most common non-zero `add` exit is a COLLISION: the target
    // path/branch is already a registered worktree. git fails FAST there and
    // creates nothing. The branch namespace this verb writes into
    // (worktree-agent-*/agent-*) IS the concurrent-executor namespace, so a
    // colliding path is very plausibly a LIVE PEER executor — rolling it back
    // would destroy real, uncommitted work. This must NEVER call
    // `git worktree remove`.
    const plan = planWorktreeCreate(okFields);
    const calls = [];
    const execGit = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      return { exitCode: 128, stdout: '', stderr: `fatal: '${okFields.worktreePath}' already exists`, timedOut: false };
    };
    const result = executeWorktreeCreatePlan(plan, '/repo/main', { execGit });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'worktree_add_failed');
    assert.match(result.stderr, /already exists/);
    assert.ok(
      !calls.some((c) => c[0] === 'worktree' && c[1] === 'remove'),
      'a clean non-zero `add` exit must NEVER trigger a rollback — the colliding path may be a live peer executor',
    );
  });

  test('the timeout-path rollback never masks the original failure even if the rollback execGit itself throws', () => {
    // The throwing-rollback contract is only exercised on the SURVIVING
    // rollback call site (the timeout path) after FIX 5 removed the
    // clean-exit rollback.
    const plan = planWorktreeCreate(okFields);
    const execGit = (args) => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { exitCode: null, stdout: '', stderr: '', timedOut: true, signal: 'SIGTERM' };
      }
      throw new Error('rollback execGit exploded');
    };
    const result = executeWorktreeCreatePlan(plan, '/repo/main', { execGit });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'git_timeout');
  });

  test('a skip plan (invalid_entry) is echoed back without any git call', () => {
    const plan = planWorktreeCreate({ ...okFields, branch: 'not-worktree-agent-x' });
    const calls = [];
    const result = executeWorktreeCreatePlan(plan, '/repo/main', { execGit: (args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_entry');
    assert.equal(calls.length, 0);
  });

  test('Windows path: a worktreePath with backslashes is posix-normalized in the result (worktree_path and cwd)',
    () => {
      const winFields = { ...okFields, worktreePath: 'C:\\repo\\.claude\\worktrees\\agent-a1' };
      const plan = planWorktreeCreate(winFields);
      const execGit = () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
      const result = executeWorktreeCreatePlan(plan, 'C:\\repo\\main', { execGit });
      assert.equal(result.ok, true);
      assert.equal(result.cwd, 'C:/repo/.claude/worktrees/agent-a1');
      assert.equal(result.worktree_path, 'C:/repo/.claude/worktrees/agent-a1');
      assert.ok(!result.cwd.includes('\\'), 'cwd must contain no backslashes');
    });
});

describe('cmdWorktreeCreate', () => {
  function withExitCode(fn) {
    const saved = process.exitCode;
    try { return fn(); } finally { process.exitCode = saved; }
  }

  const okArgs = [
    '--manifest', 'manifest.json',
    '--agent-id', 'a1',
    '--path', '/repo/.claude/worktrees/agent-a1',
    '--branch', 'worktree-agent-a1',
    '--base', 'abc123',
  ];

  function okExecGit() {
    return () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  }

  test('creates the worktree and appends the entry to an empty manifest', () => {
    let writtenPath = null;
    let writtenContent = null;
    const out = [];
    const result = cmdWorktreeCreate('/repo/main', okArgs, {
      readFile: () => '{"orchestrator_root":"/repo/main","worktrees":[]}',
      writeFile: (p, c) => { writtenPath = p; writtenContent = c; },
      write: (s) => out.push(s),
      writeErr: () => {},
      execGit: okExecGit(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'created');
    assert.equal(result.cwd, '/repo/.claude/worktrees/agent-a1');
    assert.equal(writtenPath, path.resolve('/repo/main', 'manifest.json'));
    const written = JSON.parse(writtenContent);
    assert.equal(written.worktrees.length, 1);
    assert.equal(written.worktrees[0].agent_id, 'a1');
    assert.equal(written.worktrees[0].worktree_path, '/repo/.claude/worktrees/agent-a1');
    assert.equal(written.worktrees[0].branch, 'worktree-agent-a1');
    assert.equal(written.worktrees[0].expected_base, 'abc123');
    assert.deepEqual(
      Object.keys(written.worktrees[0]).sort(),
      ['agent_id', 'branch', 'expected_base', 'worktree_path'],
      'FIX2: the on-disk entry must be the minimal 4-field shape — no derived allowed_bases',
    );
    assert.match(out.join(''), /"ok": true/);
  });

  // #2627 Phase 3: --root confines the created worktree. Absent the flag the
  // behavior is exactly Phase 2's (every test above passes unchanged); the
  // orchestrator-worktree scheduler path always passes it, because Phase 3 is
  // what starts SPAWNING processes into these directories.
  describe('--root confinement', () => {
    const rootedArgs = (wtPath, root) => [
      '--manifest', 'manifest.json',
      '--agent-id', 'a1',
      '--path', wtPath,
      '--branch', 'worktree-agent-a1',
      '--base', 'abc123',
      '--root', root,
    ];

    function run(args) {
      const out = [];
      let gitCalled = false;
      const result = withExitCode(() => cmdWorktreeCreate('/repo/main', args, {
        readFile: () => '{"orchestrator_root":"/repo/main","worktrees":[]}',
        writeFile: () => {},
        write: (s) => out.push(s),
        writeErr: () => {},
        execGit: () => { gitCalled = true; return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
      }));
      return { result, out: out.join(''), gitCalled };
    }

    test('a path inside --root is accepted', () => {
      const { result } = run(rootedArgs('/repo/main/.claude/worktrees/agent-a1', '/repo/main'));
      assert.equal(result.ok, true);
      assert.equal(result.reason, 'created');
    });

    test('a sibling path OUTSIDE --root is rejected before any git runs', () => {
      const { result, gitCalled } = run(rootedArgs('/repo/.claude/worktrees/agent-a1', '/repo/main'));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'path_outside_root');
      assert.equal(gitCalled, false, 'confinement must reject BEFORE the git side effect');
    });

    test('an arbitrary absolute path is rejected (the hole a ".."-segment check cannot see)', () => {
      const { result } = run(rootedArgs('/etc/gsd-evil', '/repo/main'));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'path_outside_root');
    });

    test('a path EQUAL to --root is rejected (would clobber the checkout)', () => {
      const { result } = run(rootedArgs('/repo/main', '/repo/main'));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'path_outside_root');
    });

    test('a sibling whose name merely PREFIXES the root is rejected (not a substring check)', () => {
      // '/repo/main-evil' starts with '/repo/main' textually but is not inside it.
      const { result } = run(rootedArgs('/repo/main-evil/wt', '/repo/main'));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'path_outside_root');
    });

    test('omitting --root preserves Phase-2 behavior (no confinement)', () => {
      const { result } = run([
        '--manifest', 'manifest.json',
        '--agent-id', 'a1',
        '--path', '/repo/.claude/worktrees/agent-a1',
        '--branch', 'worktree-agent-a1',
        '--base', 'abc123',
      ]);
      assert.equal(result.ok, true, 'no --root → unchanged Phase-2 acceptance');
    });
  });

  test('boundary: appending to a manifest with 1 existing entry yields 2', () => {
    let writtenContent = null;
    const result = cmdWorktreeCreate('/repo/main', okArgs, {
      readFile: () => JSON.stringify({
        orchestrator_root: '/repo/main',
        worktrees: [{ agent_id: 'other', worktree_path: '/repo/.claude/worktrees/agent-other', branch: 'worktree-agent-other', expected_base: 'def456' }],
      }),
      writeFile: (_p, c) => { writtenContent = c; },
      write: () => {},
      writeErr: () => {},
      execGit: okExecGit(),
    });
    assert.equal(result.ok, true);
    const written = JSON.parse(writtenContent);
    assert.equal(written.worktrees.length, 2);
  });

  test('boundary: appending to a manifest with 2 existing entries yields 3', () => {
    let writtenContent = null;
    const result = cmdWorktreeCreate('/repo/main', okArgs, {
      readFile: () => JSON.stringify({
        orchestrator_root: '/repo/main',
        worktrees: [
          { agent_id: 'x1', worktree_path: '/repo/.claude/worktrees/agent-x1', branch: 'worktree-agent-x1', expected_base: 'def456' },
          { agent_id: 'x2', worktree_path: '/repo/.claude/worktrees/agent-x2', branch: 'worktree-agent-x2', expected_base: 'def456' },
        ],
      }),
      writeFile: (_p, c) => { writtenContent = c; },
      write: () => {},
      writeErr: () => {},
      execGit: okExecGit(),
    });
    assert.equal(result.ok, true);
    const written = JSON.parse(writtenContent);
    assert.equal(written.worktrees.length, 3);
  });

  test('dedupe: re-recording an identical (worktree_path, branch) entry does NOT grow the manifest', () => {
    let writtenContent = null;
    const result = cmdWorktreeCreate('/repo/main', okArgs, {
      readFile: () => JSON.stringify({
        orchestrator_root: '/repo/main',
        worktrees: [
          { agent_id: 'a1', worktree_path: '/repo/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1', expected_base: 'abc123' },
        ],
      }),
      writeFile: (_p, c) => { writtenContent = c; },
      write: () => {},
      writeErr: () => {},
      execGit: okExecGit(),
    });
    assert.equal(result.ok, true);
    const written = JSON.parse(writtenContent);
    assert.equal(written.worktrees.length, 1, 'dedupe must not append a second identical entry');
  });

  test('exits 2 with usage when --manifest is missing', () => {
    withExitCode(() => {
      const errs = [];
      const result = cmdWorktreeCreate('/repo/main', ['--agent-id', 'a1'], {
        writeErr: (s) => errs.push(s),
        write: () => {},
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'usage');
      assert.equal(process.exitCode, 2);
      assert.match(errs.join(''), /Usage: worktree create/);
    });
  });

  test('exits 1 loudly when the manifest cannot be read', () => {
    withExitCode(() => {
      const errs = [];
      const result = cmdWorktreeCreate('/repo/main', okArgs, {
        readFile: () => { throw new Error('ENOENT'); },
        writeErr: (s) => errs.push(s),
        write: () => {},
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'manifest_read_failed');
      assert.equal(process.exitCode, 1);
      assert.match(errs.join(''), /manifest_read_failed/);
    });
  });

  test('does not write the manifest and does not call git when the entry is invalid', () => {
    withExitCode(() => {
      let wrote = false;
      let gitCalled = false;
      const result = cmdWorktreeCreate('/repo/main',
        ['--manifest', 'm.json', '--agent-id', 'a1', '--path', '/p', '--branch', 'feature/x', '--base', 'abc123'], {
          readFile: () => '{"worktrees":[]}',
          writeFile: () => { wrote = true; },
          write: () => {},
          writeErr: () => {},
          execGit: () => { gitCalled = true; return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
        });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid_entry');
      assert.equal(wrote, false);
      assert.equal(gitCalled, false, 'must not call git before the entry validates');
      assert.equal(process.exitCode, 1);
    });
  });

  test('does not write the manifest when the base is unresolved', () => {
    withExitCode(() => {
      let wrote = false;
      const result = cmdWorktreeCreate('/repo/main', okArgs, {
        readFile: () => '{"worktrees":[]}',
        writeFile: () => { wrote = true; },
        write: () => {},
        writeErr: () => {},
        execGit: (args) => (args[0] === 'rev-parse'
          ? { exitCode: 1, stdout: '', stderr: 'fatal: bad revision', timedOut: false }
          : { exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'base_unresolved');
      assert.equal(wrote, false, 'must not write the manifest when the worktree was never created');
      assert.equal(process.exitCode, 1);
    });
  });

  // ─── #2584 FIX 1: manifest work must ALL run before the git side effect ───

  test('FIX1: a malformed (truncated JSON) manifest fails with the parse reason BEFORE any git command runs', () => {
    withExitCode(() => {
      let addCalled = false;
      let wrote = false;
      const result = cmdWorktreeCreate('/repo/main', okArgs, {
        readFile: () => '{"worktrees": [', // truncated JSON — a git stub here WOULD succeed if ever called
        writeFile: () => { wrote = true; },
        write: () => {},
        writeErr: () => {},
        execGit: (args) => {
          if (args[0] === 'worktree' && args[1] === 'add') addCalled = true;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid_manifest_json');
      assert.equal(addCalled, false, 'git worktree add must never be invoked when the manifest fails to parse (no orphan possible)');
      assert.equal(wrote, false);
      assert.equal(process.exitCode, 1);
    });
  });

  test('FIX1: a manifest whose "worktrees" is not an array fails with manifest_shape_invalid BEFORE any git command runs', () => {
    withExitCode(() => {
      let addCalled = false;
      const result = cmdWorktreeCreate('/repo/main', okArgs, {
        readFile: () => JSON.stringify({ orchestrator_root: '/repo/main', worktrees: 'not-an-array' }),
        writeFile: () => {},
        write: () => {},
        writeErr: () => {},
        execGit: (args) => {
          if (args[0] === 'worktree' && args[1] === 'add') addCalled = true;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'manifest_shape_invalid');
      assert.equal(addCalled, false, 'git worktree add must never be invoked when the manifest shape is invalid');
      assert.equal(process.exitCode, 1);
    });
  });

  test('FIX1: a writeFile failure AFTER a successful git create rolls back the worktree and reports manifest_write_failed', () => {
    withExitCode(() => {
      const gitCalls = [];
      const result = cmdWorktreeCreate('/repo/main', okArgs, {
        readFile: () => '{"orchestrator_root":"/repo/main","worktrees":[]}',
        writeFile: () => { throw new Error('EACCES: permission denied'); },
        write: () => {},
        writeErr: () => {},
        execGit: (args) => { gitCalls.push(args); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'manifest_write_failed');
      assert.equal(process.exitCode, 1);
      assert.ok(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'add'), 'the worktree must actually have been created before the write failed');
      const rollbackCall = gitCalls.find((c) => c[0] === 'worktree' && c[1] === 'remove');
      assert.ok(rollbackCall, 'a git worktree remove --force rollback call must be made after a manifest write failure');
      assert.ok(rollbackCall.includes('--force'));
      assert.equal(rollbackCall[rollbackCall.length - 1], '/repo/.claude/worktrees/agent-a1');
    });
  });

  test('FIX1: a writeFile failure does not throw past cmdWorktreeCreate even when the rollback execGit itself throws', () => {
    withExitCode(() => {
      const result = cmdWorktreeCreate('/repo/main', okArgs, {
        readFile: () => '{"orchestrator_root":"/repo/main","worktrees":[]}',
        writeFile: () => { throw new Error('ENOSPC: no space left on device'); },
        write: () => {},
        writeErr: () => {},
        execGit: (args) => {
          if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('rollback execGit exploded');
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'manifest_write_failed');
      assert.equal(process.exitCode, 1);
    });
  });
});

// ─── #2584 FIX 2: on-disk entry-shape parity between create and record-agent ──
// Generative-fix-divergence guard: both verbs write into the SAME manifest, so
// they must persist the identical field-set for equivalent inputs.

describe('cmdWorktreeCreate / cmdWorktreeRecordAgent — on-disk entry parity (#2584 FIX 2)', () => {
  test('both verbs persist the identical 4-field entry for equivalent inputs', () => {
    const argsFor = (manifestFlag) => [
      manifestFlag, 'manifest.json',
      '--agent-id', 'a1',
      '--path', '/repo/.claude/worktrees/agent-a1',
      '--branch', 'worktree-agent-a1',
      '--base', 'abc123',
    ];

    let createdContent = null;
    cmdWorktreeCreate('/repo/main', argsFor('--manifest'), {
      readFile: () => '{"worktrees":[]}',
      writeFile: (_p, c) => { createdContent = c; },
      write: () => {},
      writeErr: () => {},
      execGit: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    });

    let recordedContent = null;
    cmdWorktreeRecordAgent('/repo/main', argsFor('--manifest'), {
      readFile: () => '{"worktrees":[]}',
      writeFile: (_p, c) => { recordedContent = c; },
      write: () => {},
      writeErr: () => {},
    });

    assert.ok(createdContent, 'cmdWorktreeCreate must have written a manifest');
    assert.ok(recordedContent, 'cmdWorktreeRecordAgent must have written a manifest');
    const createdEntry = JSON.parse(createdContent).worktrees[0];
    const recordedEntry = JSON.parse(recordedContent).worktrees[0];
    assert.deepEqual(
      Object.keys(createdEntry).sort(),
      Object.keys(recordedEntry).sort(),
      'both verbs must persist the SAME field-set (no derived allowed_bases from create)',
    );
    assert.deepEqual(createdEntry, recordedEntry, 'identical inputs must produce byte-identical on-disk entries');
  });
});

// ─── executeWorktreeWaveCleanupPlan ───────────────────────────────────────────

describe('executeWorktreeWaveCleanupPlan', () => {
  test('#1265 accepts a merge-base listed in allowed_bases even when expected_base is the plan commit', () => {
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'plancommit',
        allowed_bases: ['plancommit', 'parentcommit'],
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'parentcommit', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('#1265 still blocks a merge-base outside expected_base and allowed_bases', () => {
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'plancommit',
        allowed_bases: ['plancommit', 'parentcommit'],
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'unrelatedbase', stderr: '' };
        }
        throw new Error(`unexpected git call after rejected base: ${key}`);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.entries[0].status, 'blocked');
    assert.equal(result.entries[0].reason, 'base_mismatch');
  });

  test('does not delete a branch when worktree removal fails', () => {
    const calls = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args, opts) => {
        calls.push({ cwd: opts && opts.cwd, args });
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 1, stdout: '', stderr: 'locked' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          throw new Error('branch deletion must not run after remove failure');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].status, 'blocked');
    assert.equal(result.entries[0].reason, 'worktree_remove_failed');
    assert.equal(calls.some((call) => call.args.join(' ') === 'branch -D worktree-agent-a1'), false);
  });

  test('stops on merge conflict and records remaining manifest entries', () => {
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [
        {
          agent_id: 'a1',
          worktree_path: '/repo/.claude/worktrees/agent-a1',
          branch: 'worktree-agent-a1',
          expected_base: 'abc123',
        },
        {
          agent_id: 'a2',
          worktree_path: '/repo/.claude/worktrees/agent-a2',
          branch: 'worktree-agent-a2',
          expected_base: 'abc123',
        },
      ],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 1, stdout: '', stderr: 'CONFLICT' };
        }
        throw new Error(`unexpected git call after conflict: ${key}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].status, 'blocked');
    assert.equal(result.entries[0].reason, 'merge_failed');
    assert.deepEqual(result.pending.map((entry) => entry.branch), ['worktree-agent-a2']);
  });

  test('#3804: rescues uncommitted SUMMARY.md from worktree .planning/ before dirty check', () => {
    // Fixture: the only dirty file is .planning/q1-SUMMARY.md (executor left it uncommitted
    // per documented contract — orchestrator commits it).  cleanup-wave MUST rescue it
    // (copy to main tree) and succeed, not return worktree_dirty.
    const calls = [];
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is NOT committed on the branch. `git cat-file -e HEAD:<path>` returns
        // exit 128 (NOT 1) for an absent path (#2556): "fatal: path '...' does not exist
        // in 'HEAD'". Rescue must fire on this real exit code.
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 128, stdout: '', stderr: "fatal: path '.planning/q1-SUMMARY.md' does not exist in 'HEAD'" };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Only the SUMMARY is dirty — no other modified files
          return { exitCode: 0, stdout: '?? .planning/q1-SUMMARY.md', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      // Inject FS deps so tests don't touch the real filesystem
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: (p) => {
        if (p === '/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md') return 'summary content';
        return '';
      },
      existsSync: (_p) => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // SUMMARY was rescued into the main tree
    assert.equal(rescued.length, 1, 'SUMMARY.md must be rescued (copied) to main tree');
    assert.equal(rescued[0].src, '/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md');
    // Normalize to forward slashes for cross-platform assertion (path.join uses \ on Windows)
    assert.equal(rescued[0].dest.replace(/\\/g, '/'), '/repo/main/.planning/q1-SUMMARY.md');

    // Cleanup succeeded — SUMMARY-only dirty state must not block
    assert.equal(result.ok, true, 'cleanup must succeed when only SUMMARY.md is dirty');
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.equal(result.entries[0].reason, 'ok');
  });

  test('#3804: still blocks when worktree has non-SUMMARY dirty files alongside SUMMARY', () => {
    // If there are OTHER dirty files (not SUMMARY), cleanup must still block.
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is NOT committed on the branch (uncommitted, per quick.md contract).
        // cat-file -e returns 128 for an absent path (#2556).
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 128, stdout: '', stderr: "fatal: path '.planning/q1-SUMMARY.md' does not exist in 'HEAD'" };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // SUMMARY plus another dirty file
          return { exitCode: 0, stdout: '?? .planning/q1-SUMMARY.md\nM  src/foo.js', stderr: '' };
        }
        throw new Error(`unexpected git call after dirty check: ${key}`);
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].reason, 'worktree_dirty');
  });

  test('#245: blocks with summary_rescue_failed when copyFileSync throws during rescue', () => {
    // Fixture: the only dirty file is .planning/q1-SUMMARY.md, but copyFileSync throws
    // (simulating ENOSPC / permission error).  The path must NOT be added to rescuedRelPaths,
    // so the entry must be blocked with status='blocked', reason='summary_rescue_failed',
    // and the worktree must NOT be merged or removed.
    const calls = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is NOT committed — cat-file -e returns exit 128 for an absent path (#2556);
        // rescue proceeds and copyFileSync throws (ENOSPC).
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 128, stdout: '', stderr: "fatal: path '.planning/q1-SUMMARY.md' does not exist in 'HEAD'" };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Only the SUMMARY is dirty
          return { exitCode: 0, stdout: '?? .planning/q1-SUMMARY.md', stderr: '' };
        }
        // Any merge or worktree-remove call proves we failed to block — throw to surface it
        if (key.startsWith('merge worktree-agent-a1') || key.startsWith('worktree remove')) {
          throw new Error(`worktree was not blocked before merge/remove: ${key}`);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: (p) => {
        if (p === '/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md') return 'summary content';
        return '';
      },
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: () => { throw new Error('ENOSPC: no space left on device'); },
    });

    assert.equal(result.ok, false, 'result.ok must be false when rescue copy fails');
    assert.equal(result.entries[0].status, 'blocked', 'entry status must be blocked');
    assert.equal(result.entries[0].reason, 'summary_rescue_failed', 'entry reason must be summary_rescue_failed');
    // Verify no merge or worktree-remove call was made (the execGit throw above would have surfaced it)
    const mergeCalls = calls.filter((c) => c.startsWith('merge worktree-agent-a1') || c.startsWith('worktree remove'));
    assert.equal(mergeCalls.length, 0, 'no merge or worktree-remove git call must have been made');
  });

  test('#706: does NOT rescue SUMMARY when it is already committed on the branch (execute-phase contract)', () => {
    // Regression for issue #706: when execute-phase commits SUMMARY.md on the
    // worktree branch, the cleanup-wave helper must NOT copy it as an untracked
    // file into the main tree.  Doing so creates a collision that causes
    // `git merge --no-ff` to abort with "untracked working tree files would be
    // overwritten by merge".
    //
    // Fixture: SUMMARY.md is committed on the branch (git cat-file -e HEAD:<path>
    // returns exit 0).  The worktree status shows the file as committed (not dirty).
    // The rescue step must skip this file entirely.  The merge must succeed.
    const calls = [];
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is committed on the branch — cat-file -e HEAD:<path> succeeds (exit 0)
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 0, stdout: '.planning/q1-SUMMARY.md', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Worktree is clean — SUMMARY is committed, not dirty
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: (_p) => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // The committed SUMMARY must NOT have been copied into the main tree as an untracked file
    assert.equal(rescued.length, 0,
      'rescueSummaryArtifacts must NOT copy an already-committed SUMMARY into the main tree — ' +
      'doing so creates an untracked file that collides with the --no-ff merge');

    // Cleanup must succeed
    assert.equal(result.ok, true, 'cleanup must succeed when SUMMARY is committed on the branch');
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.equal(result.entries[0].reason, 'ok');
  });

  test('#706: SUMMARY committed on branch + untracked non-SUMMARY dirty file still blocks', () => {
    // Even when SUMMARY is committed (no rescue needed), a non-SUMMARY dirty file must block.
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is committed on the branch
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 0, stdout: '.planning/q1-SUMMARY.md', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Another untracked file exists alongside the committed SUMMARY
          return { exitCode: 0, stdout: '?? scratch.txt', stderr: '' };
        }
        throw new Error(`unexpected git call after dirty check: ${key}`);
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].reason, 'worktree_dirty');
  });

  test('#706: SUMMARY staged-but-not-committed is rescued (cat-file -e HEAD only matches committed)', () => {
    // Codex adversarial finding: git ls-files --error-unmatch would match staged
    // files (added to index but not committed), causing rescue to be skipped for
    // a file the merge would NOT carry.  cat-file -e HEAD:<path> only matches
    // committed objects, so staged-but-not-committed SUMMARY is rescued correctly.
    //
    // Fixture: cat-file -e HEAD:<path> returns exit 1 (not in committed tree),
    // but git status shows 'A  .planning/q1-SUMMARY.md' (staged).  Rescue must
    // copy it into the main tree and the cleanup must proceed.
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is staged but NOT committed — absent from HEAD, cat-file returns 128 (#2556)
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 128, stdout: '', stderr: "fatal: path '.planning/q1-SUMMARY.md' does not exist in 'HEAD'" };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // File is staged ('A  .planning/q1-SUMMARY.md')
          return { exitCode: 0, stdout: 'A  .planning/q1-SUMMARY.md', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // The staged-but-not-committed SUMMARY must be rescued into the main tree
    assert.equal(rescued.length, 1,
      'staged-but-not-committed SUMMARY must be rescued — cat-file -e HEAD only skips truly committed files');
    // Cleanup succeeded: staged-file shows as 'A  ..' which is in rescuedRelPaths filter
    assert.equal(result.ok, true, 'cleanup must succeed when only staged SUMMARY is present');
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('#2556: cat-file exit 128 RESCUES the SUMMARY (fail-open — 128 is the normal absent code)', () => {
    // #2556 reversal of the prior #706 "fail-closed on 128" policy. That policy
    // assumed exit 128 = fatal git error. It does not — `git cat-file -e` returns
    // 128 for an ABSENT path, which is the NORMAL uncommitted-SUMMARY state; a
    // genuine fatal (corrupt store, unborn HEAD) is rare. Fail-closed on 128
    // therefore skipped rescue in the common case and the untracked SUMMARY was
    // silently discarded by `worktree remove --force`. Data safety wins: rescue on
    // 128. The rare genuinely-fatal-128-with-actually-committed-file case may now
    // produce a recoverable merge collision (caught by the merge) — far less
    // severe than the silent, unrecoverable data loss fail-closed caused.
    //
    // Fixture: cat-file returns exitCode:128.  Rescue MUST fire (copy into main tree).
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // cat-file returns 128 — the SUMMARY is absent from HEAD (#2556: the normal
        // uncommitted state, NOT a fatal error)
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 128, stdout: '', stderr: "fatal: path '.planning/q1-SUMMARY.md' does not exist in 'HEAD'", timedOut: false };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Worktree appears clean (SUMMARY is committed on branch)
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // #2556: on exit 128 rescue MUST fire — 128 is the normal absent-path code and
    // skipping loses the uncommitted SUMMARY (silent data loss via worktree remove --force).
    assert.equal(rescued.length, 1,
      'cat-file exit 128 must RESCUE the SUMMARY — 128 is the normal absent-path code, not a fatal error (#2556)');
    // The rest of cleanup proceeds normally (merge/remove/delete succeed in this fixture)
    assert.equal(result.ok, true, 'cleanup can still succeed after rescuing on cat-file exit 128');
  });

  test('#2556: cat-file timeout RESCUES the SUMMARY (fail-open — data safety over uncertain status)', () => {
    // #2556 reversal: on cat-file timeout we cannot determine committed status, but
    // data safety wins — rescue anyway. Skipping rescue on timeout (the prior
    // fail-closed policy) risks losing an uncommitted SUMMARY to `worktree remove
    // --force`. If the file turns out to be committed, the rescue copy is a no-op
    // when the main tree already holds identical content (the destination check),
    // and any real collision is caught by the merge as a recoverable merge_failed.
    //
    // Fixture: cat-file returns timedOut:true.  Rescue MUST fire (copy into main tree).
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // cat-file times out — cannot determine if SUMMARY is committed
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return {
            exitCode: null,
            stdout: '',
            stderr: '',
            timedOut: true,
            signal: 'SIGTERM',
            error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
          };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Worktree appears clean (SUMMARY is committed on branch)
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // #2556: on timeout rescue MUST fire — skipping risks silent data loss; a copy
    // of an actually-committed file is a no-op (destination check) or a recoverable
    // merge collision, neither of which is as bad as losing the uncommitted SUMMARY.
    assert.equal(rescued.length, 1,
      'cat-file timeout must RESCUE the SUMMARY — data safety wins over uncertain status (#2556)');
    // The rest of cleanup proceeds normally (merge/remove/delete succeed in this fixture)
    assert.equal(result.ok, true, 'cleanup can still succeed after rescuing on cat-file timeout');
  });

  test('blocks dirty worktrees before merge/remove/delete', () => {
    const calls = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          return { exitCode: 0, stdout: '?? scratch.txt', stderr: '' };
        }
        throw new Error(`unexpected git call after dirty check: ${key}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].reason, 'worktree_dirty');
    assert.equal(calls.some((call) => call.startsWith('merge worktree-agent-a1')), false);
    assert.equal(calls.some((call) => call === 'worktree remove /repo/.claude/worktrees/agent-a1 --force'), false);
    assert.equal(calls.some((call) => call === 'branch -D worktree-agent-a1'), false);
  });
});

// ─── MOVE 2: resolveWorktreeRoot and pruneOrphanedWorktrees (#1268 T0) ────────

describe('worktree-safety: resolveWorktreeRoot and pruneOrphanedWorktrees relocation identity', () => {
  const worktreeSafety = require(WORKTREE_SAFETY_PATH);
  const core = require(CORE_PATH);

  test('core.resolveWorktreeRoot === worktreeSafety.resolveWorktreeRoot (by reference)', () => {
    assert.strictEqual(
      core.resolveWorktreeRoot,
      worktreeSafety.resolveWorktreeRoot,
      'core.resolveWorktreeRoot must be the same function reference as worktreeSafety.resolveWorktreeRoot'
    );
  });

  test('core.pruneOrphanedWorktrees === worktreeSafety.pruneOrphanedWorktrees (by reference)', () => {
    assert.strictEqual(
      core.pruneOrphanedWorktrees,
      worktreeSafety.pruneOrphanedWorktrees,
      'core.pruneOrphanedWorktrees must be the same function reference as worktreeSafety.pruneOrphanedWorktrees'
    );
  });
});

describe('worktree-safety: resolveWorktreeRoot behaviour', () => {
  const worktreeSafety = require(WORKTREE_SAFETY_PATH);

  test('resolveWorktreeRoot(createTempGitProject()) returns a non-empty string', (t) => {
    const dir = createTempGitProject('gsd-wt-root-');
    t.after(() => cleanup(dir));
    const result = worktreeSafety.resolveWorktreeRoot(dir);
    assert.ok(typeof result === 'string' && result.length > 0,
      `Expected non-empty string, got: ${JSON.stringify(result)}`);
  });
});

describe('worktree-safety: pruneOrphanedWorktrees behaviour', () => {
  const worktreeSafety = require(WORKTREE_SAFETY_PATH);

  test('pruneOrphanedWorktrees(temp dir) returns [] and does not throw', (t) => {
    const dir = createTempDir('gsd-prune-');
    t.after(() => cleanup(dir));
    let result;
    assert.doesNotThrow(() => {
      result = worktreeSafety.pruneOrphanedWorktrees(dir);
    });
    assert.deepStrictEqual(result, []);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3707-locked-worktree-cleanup.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3707-locked-worktree-cleanup (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3707)
// Real-filesystem tests for the two failure modes pinned in #3707:
//   1. executeWorktreeWaveCleanupPlan must unlock-then-retry when a worktree is locked.
//   2. reapOrphanWorktrees must reap dead-pid+merged entries and skip live / unmerged / fresh-mtime entries.
//   3. quick.md and execute-phase.md must wire gsd-sdk query worktree.reap-orphans at startup.

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const {
  executeWorktreeWaveCleanupPlan,
  reapOrphanWorktrees,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

// ─── Fixed timestamps for deterministic stale-lock boundary ──────────────────
//
// ADR-456 clock-seam mandate: tests must not read the live clock to compute
// fixture mtimes.  The SUT compares `Date.now() - lockMtime.getTime()` against
// REAP_MTIME_GUARD_MS (5 minutes).  Because `reapOrphanWorktrees` accepts a
// `deps.mtimeSafe` injection, we can supply fixed Date objects that sit
// unconditionally on the "stale" or "fresh" side of the boundary regardless of
// when the test runs, without touching the real filesystem mtime at all.
//
//   STALE_MTIME  → Unix epoch (1970-01-01T00:00:00Z).  At any point in time
//                   after that epoch `Date.now() - 0` is orders of magnitude
//                   larger than any staleness threshold.
//
//   FRESH_MTIME  → Far-future sentinel (year 9999 + large offset).
//                   `Date.now() - FRESH_MTIME.getTime()` is always negative,
//                   which is always < REAP_MTIME_GUARD_MS.
//
// Tests that need stale behaviour pass `{ mtimeSafe: () => STALE_MTIME }` in
// deps.  Tests that need fresh behaviour pass `{ mtimeSafe: () => FRESH_MTIME }`.
// No `fs.utimesSync` calls are needed and no live `Date.now()` reads appear in
// fixture setup.

/** Always older than any staleness threshold. */
const STALE_MTIME = new Date(0); // 1970-01-01T00:00:00.000Z

/** Always newer than the current time, so always treated as "fresh". */
const FRESH_MTIME = new Date(8640000000000000); // max safe JS Date (year ~275760)

// ─── PID helpers ──────────────────────────────────────────────────────────────

/**
 * Return a PID that is guaranteed to be dead.
 * Spawns a short-lived child, captures its PID, waits for it to exit, then
 * returns that PID.  This is cross-platform and not subject to pid_max races
 * (unlike a hardcoded high number such as 999999).
 */
function deadPid() {
  // Use the shortest possible no-op: `node -e ""` on all platforms.
  const nodeExe = process.execPath;
  const result = spawnSync(nodeExe, ['-e', ''], { stdio: 'ignore' });
  if (result.pid == null || result.status === null) {
    // Fallback: use a PID above the system max — 2^31-1 always exceeds any
    // real OS limit (Linux max: 4194304, macOS max: 99998, Windows: variable).
    return 2147483647;
  }
  return result.pid;
}

// ─── Git repo helpers ─────────────────────────────────────────────────────────

function canonicalPath(p) {
  try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); }
}

/**
 * Return a canonical (long-form) path for os.tmpdir().
 * On Windows CI, os.tmpdir() often contains 8.3 short-name components
 * (e.g. RUNNER~1 instead of runneradmin).  When 8.3 names are disabled
 * (common in modern CI environments), those short paths are not resolvable
 * and fs.realpathSync.native fails with ENOENT.  Pre-resolving the base
 * ensures every path created under it uses the same long-form representation
 * that git stores when given absolute paths.
 */
function resolvedTmpDir() {
  try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial commit'], dir);
  try { git(['branch', '-m', 'master', 'main'], dir); } catch { /* already main */ }
}

function addWorktree(repoDir, wtDir, branchName) {
  git(['worktree', 'add', wtDir, '-b', branchName], repoDir);
}

function commitInWorktree(wtDir, filename) {
  const fname = filename || 'work.txt';
  fs.writeFileSync(path.join(wtDir, fname), 'content\n');
  git(['add', '-A'], wtDir);
  git(['commit', '-m', `work in ${path.basename(wtDir)}`], wtDir);
}

function mergeIntoMain(repoDir, branchName) {
  git(['merge', branchName, '--no-ff', '-m', `merge ${branchName}`], repoDir);
}

function worktreeMeta(repoDir, wtDir) {
  // Return the .git/worktrees/<name>/ directory for a given linked worktree
  const worktrees = git(['worktree', 'list', '--porcelain'], repoDir);
  const canonical = canonicalPath(wtDir);
  // Normalize CRLF → LF before splitting (git on Windows may emit CRLF).
  const normalized = worktrees.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const wtLine = lines.find((l) => l.startsWith('worktree '));
    if (!wtLine) continue;
    const wtPath = wtLine.slice('worktree '.length).trim();
    if (canonicalPath(wtPath) !== canonical) continue;
    const gitCommonDir = git(['rev-parse', '--git-common-dir'], repoDir).trim();
    const worktreesDir = path.join(path.resolve(repoDir, gitCommonDir), 'worktrees');
    if (!fs.existsSync(worktreesDir)) continue;
    for (const entry of fs.readdirSync(worktreesDir)) {
      const gitdirFile = path.join(worktreesDir, entry, 'gitdir');
      if (!fs.existsSync(gitdirFile)) continue;
      const gitdirContent = fs.readFileSync(gitdirFile, 'utf8').trim();
      const resolvedWtRoot = path.resolve(worktreesDir, entry, gitdirContent).replace(/[/\\]\.git$/, '');
      if (canonicalPath(resolvedWtRoot) === canonical) {
        return path.join(worktreesDir, entry);
      }
    }
  }
  throw new Error(`Cannot find .git/worktrees/<name> for worktree at ${wtDir}`);
}

function listedWorktreePaths(repoDir) {
  const out = git(['worktree', 'list', '--porcelain'], repoDir);
  return new Set(
    out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => canonicalPath(l.slice('worktree '.length).trim()))
  );
}

// ─── Suite 1: executeWorktreeWaveCleanupPlan — unlock-and-retry ───────────────

describe('bug-3707: executeWorktreeWaveCleanupPlan unlocks and retries on locked worktree', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3707-cleanup-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('removes a locked worktree after unlock-retry (real-fs)', () => {
    const repoDir = path.join(tmpBase, 'repo');
    const wtDir = path.join(tmpBase, 'wt-locked');
    const branchName = 'worktree-agent-test1';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir);
    mergeIntoMain(repoDir, branchName);

    // Simulate Claude Code's lock: write a .git/worktrees/<name>/locked file
    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, 'Locked by claude-code agent-test1');

    assert.ok(fs.existsSync(lockedFile), 'lock file should exist before test');

    const baseCommit = git(['merge-base', 'HEAD', branchName], repoDir).trim();

    const plan = {
      ok: true,
      repoRoot: repoDir,
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'test1',
        worktree_path: wtDir,
        branch: branchName,
        expected_base: baseCommit,
      }],
    };

    const result = executeWorktreeWaveCleanupPlan(plan);

    assert.equal(result.ok, true, `cleanup should succeed, got: ${JSON.stringify(result)}`);
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.ok(!fs.existsSync(wtDir), 'worktree directory should be gone after cleanup');
    assert.ok(!listedWorktreePaths(repoDir).has(canonicalPath(wtDir)), 'git worktree list should not include removed worktree');
  });

  test('cleanup succeeds without a lock file present (no regression)', () => {
    const repoDir = path.join(tmpBase, 'repo2');
    const wtDir = path.join(tmpBase, 'wt-unlocked');
    const branchName = 'worktree-agent-test2';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'unlocked.txt');
    mergeIntoMain(repoDir, branchName);

    const baseCommit = git(['merge-base', 'HEAD', branchName], repoDir).trim();

    const plan = {
      ok: true,
      repoRoot: repoDir,
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'test2',
        worktree_path: wtDir,
        branch: branchName,
        expected_base: baseCommit,
      }],
    };

    const result = executeWorktreeWaveCleanupPlan(plan);

    assert.equal(result.ok, true, `unlocked cleanup should succeed: ${JSON.stringify(result)}`);
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.ok(!fs.existsSync(wtDir), 'worktree directory should be gone');
  });
});

// ─── Suite 2: reapOrphanWorktrees ─────────────────────────────────────────────

describe('bug-3707: reapOrphanWorktrees', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3707-reap-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  // ── Dead PID + merged branch → reap ────────────────────────────────────────
  test('reaps a worktree whose pid is dead and branch is merged into main', () => {
    const repoDir = path.join(tmpBase, 'repo');
    const wtDir = path.join(tmpBase, 'wt-dead-merged');
    const branchName = 'worktree-agent-dead-merged';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir);
    mergeIntoMain(repoDir, branchName);

    // Write a lock file with a definitely-dead PID.  Use the deadPid() helper
    // which spawns and reaps a real child process — avoids pid_max flakiness
    // on Linux systems where 999999 could be a live PID.
    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, String(deadPid()));

    // Inject a fixed stale mtime (STALE_MTIME = Unix epoch) so the staleness
    // check is deterministic and does not depend on the real clock or utimesSync.
    // STALE_MTIME is always older than REAP_MTIME_GUARD_MS (5 min) regardless
    // of when this test runs.  No fs.utimesSync call is needed.

    // Pre-compute canonical path BEFORE reaping — the directory will be gone
    // afterward, so fs.realpathSync.native will fail and canonicalPath falls
    // back to path.resolve (non-symlink-resolved).  On macOS CI, git internally
    // resolves /var/folders → /private/var/folders when writing the gitdir file,
    // so r.path uses the real path while wtDir uses the symlink form.  Computing
    // canonical before removal ensures we compare the resolved forms.
    const wtDirCanonical = canonicalPath(wtDir);

    const result = reapOrphanWorktrees(repoDir, { mtimeSafe: () => STALE_MTIME });

    assert.ok(Array.isArray(result), 'reapOrphanWorktrees should return an array');
    const reaped = result.find((r) => canonicalPath(r.path) === wtDirCanonical);
    assert.ok(reaped, `worktree ${wtDir} should appear in reaped list`);
    assert.equal(reaped.status, 'reaped');
    assert.ok(!fs.existsSync(wtDir), 'worktree directory should be removed');
    assert.ok(!listedWorktreePaths(repoDir).has(wtDirCanonical), 'git worktree list should not show reaped worktree');
  });

  // ── Live PID → skip ────────────────────────────────────────────────────────
  test('skips a worktree whose pid is alive', () => {
    const repoDir = path.join(tmpBase, 'repo2');
    const wtDir = path.join(tmpBase, 'wt-live-pid');
    const branchName = 'worktree-agent-live-pid';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir);
    mergeIntoMain(repoDir, branchName);

    // Write current process PID as the lock owner
    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, String(process.pid));

    // Inject STALE_MTIME so the staleness guard passes deterministically,
    // ensuring the live-PID check is the only reason the entry is skipped.
    const result = reapOrphanWorktrees(repoDir, { mtimeSafe: () => STALE_MTIME });

    const skipped = result.find((r) => canonicalPath(r.path) === canonicalPath(wtDir));
    if (skipped) {
      assert.notEqual(skipped.status, 'reaped', 'live-pid worktree must not be reaped');
    }
    assert.ok(fs.existsSync(wtDir), 'worktree directory must still exist for live-pid worktree');
  });

  // ── Dead PID + unmerged branch → skip (data loss guard) ────────────────────
  test('skips a worktree whose branch has unmerged commits even with dead pid', () => {
    const repoDir = path.join(tmpBase, 'repo3');
    const wtDir = path.join(tmpBase, 'wt-unmerged');
    const branchName = 'worktree-agent-unmerged';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'unmerged.txt');
    // NOTE: intentionally NOT merging the branch into main

    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, String(deadPid()));

    // Inject STALE_MTIME so the staleness guard passes deterministically,
    // ensuring the unmerged-branch check is the only reason the entry is skipped.
    const result = reapOrphanWorktrees(repoDir, { mtimeSafe: () => STALE_MTIME });

    const entry = result.find((r) => canonicalPath(r.path) === canonicalPath(wtDir));
    if (entry) {
      assert.notEqual(entry.status, 'reaped', 'unmerged worktree must not be reaped (data loss guard)');
    }
    assert.ok(fs.existsSync(wtDir), 'unmerged worktree directory must still exist');
  });

  // ── Dead PID + merged + fresh mtime → skip (race guard) ───────────────────
  test('skips a locked worktree with fresh mtime even when pid is dead and branch is merged', () => {
    const repoDir = path.join(tmpBase, 'repo4');
    const wtDir = path.join(tmpBase, 'wt-fresh-lock');
    const branchName = 'worktree-agent-fresh-lock';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'fresh.txt');
    mergeIntoMain(repoDir, branchName);

    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, String(deadPid()));

    // Inject FRESH_MTIME (far future) so the staleness boundary is crossed
    // deterministically: Date.now() - FRESH_MTIME.getTime() is always negative,
    // which is always less than REAP_MTIME_GUARD_MS.  No utimesSync needed.
    // Previously, this test relied on the file being just-created (real clock
    // within 5 minutes) which is fragile on heavily-loaded CI hosts.
    const result = reapOrphanWorktrees(repoDir, { mtimeSafe: () => FRESH_MTIME });

    const entry = result.find((r) => canonicalPath(r.path) === canonicalPath(wtDir));
    if (entry) {
      assert.notEqual(entry.status, 'reaped', 'fresh-mtime worktree must not be reaped (race guard)');
    }
    assert.ok(fs.existsSync(wtDir), 'fresh-lock worktree directory must still exist');
  });

  // ── Double invocation → idempotent ─────────────────────────────────────────
  test('is idempotent: second invocation is a no-op', () => {
    const repoDir = path.join(tmpBase, 'repo5');
    const wtDir = path.join(tmpBase, 'wt-idempotent');
    const branchName = 'worktree-agent-idempotent';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'idempotent.txt');
    mergeIntoMain(repoDir, branchName);

    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, String(deadPid()));

    // Inject STALE_MTIME so the staleness guard is deterministically satisfied.
    const staleDeps = { mtimeSafe: () => STALE_MTIME };

    const result1 = reapOrphanWorktrees(repoDir, staleDeps);
    const reaped1 = result1.filter((r) => r.status === 'reaped');
    assert.equal(reaped1.length, 1, 'first invocation should reap exactly one entry');

    // Second invocation: nothing left to reap
    const result2 = reapOrphanWorktrees(repoDir, staleDeps);
    const reaped2 = result2.filter((r) => r.status === 'reaped');
    assert.equal(reaped2.length, 0, 'second invocation should reap nothing (idempotent)');
  });
});

// ─── Suite 3: Structural — startup sweep wiring ───────────────────────────────

describe('bug-3707: startup orphan sweep is wired into workflow entry points', () => {
  const QUICK_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');
  const EXECUTE_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

  test('quick.md calls worktree.reap-orphans at startup when USE_WORKTREES is not false', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf8');
    assert.ok(
      content.includes('worktree.reap-orphans'),
      'quick.md must call gsd-sdk query worktree.reap-orphans at startup'
    );
    // Must be guarded by USE_WORKTREES check
    assert.ok(
      /USE_WORKTREES.*!=.*false[\s\S]{0,200}worktree\.reap-orphans/m.test(content) ||
      /worktree\.reap-orphans[\s\S]{0,200}USE_WORKTREES.*!=.*false/m.test(content),
      'quick.md startup sweep must be guarded by USE_WORKTREES != false'
    );
  });

  test('execute-phase.md calls worktree.reap-orphans at startup, guarded by the isolation decision', () => {
    // #2584 Phase 3 (#2627): the startup sweep moved into the isolation-dispatch
    // fragment alongside the ISOLATION resolution it is guarded by (the host
    // workflow keeps only a pointer, per the ADR-857 byte budget). The guard is
    // now `ISOLATION != none`, which USE_WORKTREES=false forces — so the #3707
    // protection is unchanged, just keyed one level up.
    const ISOLATION_FRAGMENT_PATH = path.join(
      __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
    );
    const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf8')
      + fs.readFileSync(ISOLATION_FRAGMENT_PATH, 'utf8');
    assert.ok(
      content.includes('worktree.reap-orphans'),
      'execute-phase must call gsd-sdk query worktree.reap-orphans at startup'
    );
    assert.ok(
      /USE_WORKTREES.*!=.*false[\s\S]{0,200}worktree\.reap-orphans/m.test(content) ||
      /worktree\.reap-orphans[\s\S]{0,200}USE_WORKTREES.*!=.*false/m.test(content) ||
      /ISOLATION.*!=.*none[\s\S]{0,200}worktree\.reap-orphans/m.test(content) ||
      /worktree\.reap-orphans[\s\S]{0,200}ISOLATION.*!=.*none/m.test(content),
      'execute-phase startup sweep must be guarded by USE_WORKTREES != false or ISOLATION != none'
    );
  });

  test('worktree-safety module exports reapOrphanWorktrees', () => {
    const mod = require('../gsd-core/bin/lib/worktree-safety.cjs');
    assert.strictEqual(typeof mod.reapOrphanWorktrees, 'function');
  });

  test('worktree-safety module exports cmdWorktreeReapOrphans', () => {
    const mod = require('../gsd-core/bin/lib/worktree-safety.cjs');
    assert.strictEqual(typeof mod.cmdWorktreeReapOrphans, 'function');
  });
});

// ─── Suite 3b: nowMs clock-injection BOUNDARY tests (#1191) ──────────────────
//
// These tests inject both `nowMs` and `mtimeSafe` so no real clock is read.
// The staleness guard is: nowMs - lockMtime.getTime() < reapMtimeGuardMs.
//
// REAP_MTIME_GUARD_MS = 5 * 60 * 1000 = 300000 ms.
//
// We use a fixed lockMtime of 1000 ms (epoch+1s) and compute nowMs values that
// are exactly 1 ms inside (age = 299999 ms < 300000) vs exactly 1 ms outside
// (age = 300000 ms, NOT < 300000) the guard boundary.

const KNOWN_REAP_MTIME_GUARD_MS = 5 * 60 * 1000; // 300000 ms — mirrors SUT constant
const FIXED_LOCK_MTIME_MS = 1000; // 1970-01-01T00:00:01.000Z
const FIXED_LOCK_DATE = new Date(FIXED_LOCK_MTIME_MS);

describe('bug-3707: reapOrphanWorktrees — nowMs clock-injection BOUNDARY tests (#1191)', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3707-nowms-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  // ── Just-inside boundary: age = guard - 1 → skip (lock_too_fresh) ───────────
  test('skips when injected nowMs places lock age just inside guard (age < guard)', () => {
    // age = nowMs - FIXED_LOCK_MTIME_MS = (FIXED_LOCK_MTIME_MS + KNOWN_REAP_MTIME_GUARD_MS - 1) - FIXED_LOCK_MTIME_MS
    //     = KNOWN_REAP_MTIME_GUARD_MS - 1 = 299999 ms  →  299999 < 300000 → SKIP
    const nowMs = FIXED_LOCK_MTIME_MS + KNOWN_REAP_MTIME_GUARD_MS - 1;

    const repoDir = path.join(tmpBase, 'repo-inside');
    const wtDir = path.join(tmpBase, 'wt-inside-guard');
    const branchName = 'worktree-boundary-inside';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'inside.txt');
    mergeIntoMain(repoDir, branchName);

    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, String(deadPid()));

    // Inject both nowMs and mtimeSafe — no real clock is read
    const result = reapOrphanWorktrees(repoDir, {
      nowMs,
      mtimeSafe: () => FIXED_LOCK_DATE,
    });

    assert.ok(Array.isArray(result), 'must return an array');
    const entry = result.find((r) => canonicalPath(r.path) === canonicalPath(wtDir));
    assert.ok(entry, 'worktree must appear in results');
    assert.equal(entry.status, 'skipped', `status must be skipped when age=${nowMs - FIXED_LOCK_MTIME_MS}ms < guard=${KNOWN_REAP_MTIME_GUARD_MS}ms`);
    assert.equal(entry.reason, 'lock_too_fresh', 'reason must be lock_too_fresh');
    assert.ok(fs.existsSync(wtDir), 'worktree directory must still exist (not reaped)');
  });

  // ── Just-outside boundary: age = guard → reap (age NOT < guard) ─────────────
  test('reaps when injected nowMs places lock age exactly at guard boundary (age === guard)', () => {
    // age = nowMs - FIXED_LOCK_MTIME_MS = (FIXED_LOCK_MTIME_MS + KNOWN_REAP_MTIME_GUARD_MS) - FIXED_LOCK_MTIME_MS
    //     = KNOWN_REAP_MTIME_GUARD_MS = 300000 ms  →  300000 NOT < 300000 → PROCEED TO REAP
    const nowMs = FIXED_LOCK_MTIME_MS + KNOWN_REAP_MTIME_GUARD_MS;

    const repoDir = path.join(tmpBase, 'repo-outside');
    const wtDir = path.join(tmpBase, 'wt-outside-guard');
    const branchName = 'worktree-boundary-outside';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'outside.txt');
    mergeIntoMain(repoDir, branchName);

    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    // Use deadPid() — a truly dead process — so PID check passes and reap proceeds
    fs.writeFileSync(lockedFile, String(deadPid()));

    const wtDirCanonical = canonicalPath(wtDir);

    // Inject both nowMs and mtimeSafe — no real clock is read
    const result = reapOrphanWorktrees(repoDir, {
      nowMs,
      mtimeSafe: () => FIXED_LOCK_DATE,
    });

    assert.ok(Array.isArray(result), 'must return an array');
    const entry = result.find((r) => canonicalPath(r.path) === wtDirCanonical);
    assert.ok(entry, 'worktree must appear in results');
    assert.equal(entry.status, 'reaped', `status must be reaped when age=${nowMs - FIXED_LOCK_MTIME_MS}ms >= guard=${KNOWN_REAP_MTIME_GUARD_MS}ms`);
    assert.ok(!fs.existsSync(wtDir), 'worktree directory must be removed after reaping');
  });
});

// ─── Suite 4: Adversarial gap tests ──────────────────────────────────────────

describe('bug-3707: reapOrphanWorktrees — adversarial edge cases', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3707-adv-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  // ── Gap 1: Non-numeric lock content (real Claude Code format) → ALIVE (fail-closed) ──
  test('does NOT reap a worktree whose lock contains non-numeric Claude Code content', () => {
    // Claude Code writes "Locked by claude-code agent-<id>" as the lock content.
    // This is non-numeric and MUST be treated as ALIVE (fail-closed) — we cannot
    // confirm the owner is dead, so reaping would risk data loss.
    const repoDir = path.join(tmpBase, 'repo');
    const wtDir = path.join(tmpBase, 'wt-claude-lock');
    const branchName = 'worktree-agent-claude-lock';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'claude-work.txt');
    mergeIntoMain(repoDir, branchName);

    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    // Write the real Claude Code lock format (non-numeric)
    fs.writeFileSync(lockedFile, 'Locked by claude-code agent-a1b2c3d4e5f6');

    // Inject STALE_MTIME so the staleness guard passes deterministically,
    // ensuring the non-numeric content check is the only reason the entry is skipped.
    const result = reapOrphanWorktrees(repoDir, { mtimeSafe: () => STALE_MTIME });

    const entry = result.find((r) => canonicalPath(r.path) === canonicalPath(wtDir));
    if (entry) {
      assert.notEqual(
        entry.status,
        'reaped',
        'non-numeric Claude Code lock must NOT be reaped (fail-closed: owner unknown)'
      );
      assert.equal(entry.status, 'skipped', 'non-numeric lock entry should have status=skipped');
      assert.equal(entry.reason, 'lock_owner_unknown', 'reason must be lock_owner_unknown');
    }
    assert.ok(fs.existsSync(wtDir), 'worktree with Claude Code lock must NOT be removed');
  });

  // ── Gap 2: EPERM in defaultIsPidAlive → ALIVE (fail-closed) ─────────────────
  test('treats EPERM from isPidAlive as ALIVE (fail-closed)', () => {
    // On Windows, signalling cross-user processes throws EPERM, not ESRCH.
    // The reaper must treat EPERM as ALIVE to avoid false reaping.
    const repoDir = path.join(tmpBase, 'repo2');
    const wtDir = path.join(tmpBase, 'wt-eperm');
    const branchName = 'worktree-agent-eperm';

    initRepo(repoDir);
    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'eperm-work.txt');
    mergeIntoMain(repoDir, branchName);

    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, String(deadPid()));

    // Inject an isPidAlive that always throws EPERM — simulates Windows cross-user scenario.
    // Also inject STALE_MTIME so the staleness guard is deterministically satisfied.
    const epermIsPidAlive = (_pid) => {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    };

    const result = reapOrphanWorktrees(repoDir, {
      isPidAlive: epermIsPidAlive,
      mtimeSafe: () => STALE_MTIME,
    });

    const entry = result.find((r) => canonicalPath(r.path) === canonicalPath(wtDir));
    if (entry) {
      assert.notEqual(entry.status, 'reaped', 'EPERM from isPidAlive must be treated as ALIVE — must not reap');
    }
    assert.ok(fs.existsSync(wtDir), 'worktree must still exist when isPidAlive throws EPERM');
  });

  // ── Gap 3: Non-main/master default branch via init.defaultBranch ─────────────
  test('uses init.defaultBranch config when default branch is not main or master', () => {
    // Repos configured with init.defaultBranch=trunk (or dev, etc.) were
    // previously unreachable by the main/master fallback, causing the reaper
    // to bail out and silently skip all orphan detection.
    const repoDir = path.join(tmpBase, 'repo3');
    const wtDir = path.join(tmpBase, 'wt-trunk-default');
    const branchName = 'worktree-agent-trunk-merged';

    // Create a repo whose default branch is 'trunk'
    fs.mkdirSync(repoDir, { recursive: true });
    git(['init'], repoDir);
    git(['config', 'user.email', 'test@test.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    git(['config', 'commit.gpgsign', 'false'], repoDir);
    // Set init.defaultBranch to 'trunk' so the reaper discovers it
    git(['config', 'init.defaultBranch', 'trunk'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Trunk Test\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'initial commit'], repoDir);
    // Rename to trunk (may fail if already trunk)
    try { git(['branch', '-m', 'master', 'trunk'], repoDir); } catch { /* already trunk or main */ }
    try { git(['branch', '-m', 'main', 'trunk'], repoDir); } catch { /* already trunk */ }

    addWorktree(repoDir, wtDir, branchName);
    commitInWorktree(wtDir, 'trunk-work.txt');
    // Merge branch into trunk
    git(['merge', branchName, '--no-ff', '-m', 'merge into trunk'], repoDir);

    const metaDir = worktreeMeta(repoDir, wtDir);
    const lockedFile = path.join(metaDir, 'locked');
    fs.writeFileSync(lockedFile, String(deadPid()));

    // Inject STALE_MTIME so the staleness guard is deterministically satisfied.
    // Pre-compute canonical before reaping (symlink resolution may fail post-removal).
    const wtDirCanonical = canonicalPath(wtDir);

    const result = reapOrphanWorktrees(repoDir, { mtimeSafe: () => STALE_MTIME });

    // The reaper must either reap the worktree (using trunk as the default branch)
    // OR skip it for a safe reason — it must NOT return an empty result (which
    // would mean it bailed out entirely, silently skipping all orphan detection).
    assert.ok(Array.isArray(result), 'reapOrphanWorktrees must return an array');
    assert.ok(result.length > 0, 'reaper must not bail out entirely for trunk-default repos — must inspect the worktree');
    const entry = result.find((r) => canonicalPath(r.path) === wtDirCanonical);
    assert.ok(entry, 'worktree must appear in results (reaped or skipped with reason)');
    // The branch IS merged into trunk, and the PID is dead, so it should be reaped.
    assert.equal(entry.status, 'reaped', 'worktree with dead pid merged into trunk must be reaped');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3129-validate-commit-git-bypass.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3129-validate-commit-git-bypass (consolidation epic #1969 B5 #1974)", () => {
'use strict';
// allow-test-rule: reads hook shell script to verify delegation pattern — structural contract test, not source-grep (see #3129)

// Regression tests for bug #3129.
//
// gsd-validate-commit.sh used `[[ "$CMD" =~ ^git[[:space:]]+commit ]]` to
// detect git commit invocations. This regex silently bypasses Conventional
// Commits enforcement for three real git commit forms:
//   1. git -C /some/path commit -m "..."   (working-directory prefix)
//   2. GIT_AUTHOR_NAME=x git commit "..."  (env-var prefix)
//   3. /usr/bin/git commit -m "..."        (full path)
//
// Fix: the hook delegates detection to hooks/lib/git-cmd.js isGitSubcommand(),
// a token-walk classifier that correctly handles all four forms. The module
// is the canonical single source of truth for all hooks that gate on git commits.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { isGitSubcommand, tokenize } = require(path.join(ROOT, 'hooks', 'lib', 'git-cmd.js'));

// ── tokenize ─────────────────────────────────────────────────────────────────

describe('git-cmd.js tokenize', () => {
  test('splits bare command', () => {
    assert.deepEqual(tokenize('git commit -m "msg"'), ['git', 'commit', '-m', 'msg']);
  });
  test('handles single-quoted args', () => {
    assert.deepEqual(tokenize("git commit -m 'my message'"), ['git', 'commit', '-m', 'my message']);
  });
  test('handles env-prefix assignment', () => {
    assert.deepEqual(
      tokenize('GIT_AUTHOR_NAME=Alice git commit -m "fix"'),
      ['GIT_AUTHOR_NAME=Alice', 'git', 'commit', '-m', 'fix'],
    );
  });
  test('handles -C path', () => {
    assert.deepEqual(
      tokenize('git -C /some/path commit -m "x"'),
      ['git', '-C', '/some/path', 'commit', '-m', 'x'],
    );
  });
});

// ── isGitSubcommand: must-match cases ────────────────────────────────────────

describe('git-cmd.js isGitSubcommand: should match commit', () => {
  const cases = [
    ['bare form',                    'git commit -m "feat: add thing"'],
    ['single-quoted message',        "git commit -m 'fix: typo'"],
    ['with --no-verify',             'git commit --no-verify -m "wip"'],
    ['-C path form (bug #3129)',     'git -C /some/path commit -m "fix: x"'],
    ['env-prefix form (bug #3129)',  'GIT_AUTHOR_NAME=Alice git commit -m "fix"'],
    ['full-path form (bug #3129)',   '/usr/bin/git commit -m "feat: y"'],
    ['multiple env vars',            'GIT_AUTHOR_NAME=A GIT_AUTHOR_EMAIL=b@c git commit -m "x"'],
    ['--git-dir= flag',              'git --git-dir=.git commit -m "x"'],
    ['--git-dir two-token',          'git --git-dir .git commit -m "x"'],
    ['--no-pager before subcommand', 'git --no-pager commit -m "x"'],
    ['-C + full path',               '/usr/bin/git -C /proj commit -m "x"'],
    ['-p paginate flag',             'git -p commit -m "x"'],
  ];
  for (const [desc, cmd] of cases) {
    test(desc, () => {
      assert.ok(isGitSubcommand(cmd, 'commit'), `Expected match for: ${cmd}`);
    });
  }
});

// ── isGitSubcommand: must-not-match cases ────────────────────────────────────

describe('git-cmd.js isGitSubcommand: should NOT match commit', () => {
  const cases = [
    ['git push',              'git push origin main'],
    ['git status',            'git status'],
    ['git add',               'git add .'],
    ['git log',               'git log --oneline'],
    ['not git at all',        'npm install'],
    ['empty string',          ''],
    ['git checkout (not commit)', 'git checkout main'],
    ['git -C path push',      'git -C /path push'],
  ];
  for (const [desc, cmd] of cases) {
    test(desc, () => {
      assert.ok(!isGitSubcommand(cmd, 'commit'), `Expected NO match for: ${cmd}`);
    });
  }
});

// ── gsd-validate-commit.sh source check ──────────────────────────────────────

describe('gsd-validate-commit.sh delegates to git-cmd.js', () => {
  const hookSrc = fs.readFileSync(
    path.join(ROOT, 'hooks', 'gsd-validate-commit.sh'), 'utf8',
  );

  test('hook no longer uses the stale ^git\\s+commit bash regex', () => {
    assert.ok(
      !hookSrc.includes('^git[[:space:]]+commit'),
      'gsd-validate-commit.sh still uses the bypassed regex — fix not applied',
    );
  });

  test('hook delegates to git-cmd.js isGitSubcommand', () => {
    assert.ok(
      hookSrc.includes('git-cmd.js') && hookSrc.includes('isGitSubcommand'),
      'gsd-validate-commit.sh does not reference git-cmd.js or isGitSubcommand',
    );
  });

  test('hooks/lib/git-cmd.js exists at the expected install path', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'hooks', 'lib', 'git-cmd.js')),
      'hooks/lib/git-cmd.js does not exist — library file missing',
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3384-secondary-defects.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3384-secondary-defects (consolidation epic #1969 B8 #1977)", () => {
// allow-test-rule: source-text-is-the-product (see #3384)
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const WORKTREE_BRANCH_CHECK_FRAGMENT = path.join(repoRoot, 'gsd-core', 'references', 'worktree-branch-check.md');

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

describe('bug #3384: adjacent worktree data-loss guards', () => {
  test('worktree cleanup CLI preserves caller cwd instead of resolving project root', () => {
    const source = read('gsd-core/bin/gsd-tools.cjs');
    const skipSet = source.slice(
      source.indexOf('const SKIP_ROOT_RESOLUTION = new Set(['),
      source.indexOf('if (!SKIP_ROOT_RESOLUTION.has(command))'),
    );

    assert.match(skipSet, /'worktree'/);
  });

  test('diagnose-issues references canonical fragment; fragment is verify-only and fails closed (#48)', () => {
    // diagnose-issues.md now references the canonical fragment rather than
    // inlining the block. Verify (a) it references the fragment and (b) the
    // fragment itself has the correct ordering: symbolic-ref/HEAD assertion and
    // ^worktree-agent- allow-list appear before any work, and (c) the fragment
    // is verify-only — no destructive self-recovery.
    const diagnoseSource = read('gsd-core/workflows/diagnose-issues.md');
    assert.ok(
      diagnoseSource.includes('worktree-branch-check.md'),
      'diagnose-issues.md must reference the canonical worktree-branch-check.md fragment'
    );

    const fragmentSource = fs.readFileSync(WORKTREE_BRANCH_CHECK_FRAGMENT, 'utf8');
    const branchCheck = fragmentSource.indexOf('HEAD_REF=$(git symbolic-ref --quiet HEAD || echo');
    const namespaceCheck = fragmentSource.indexOf('(worktree-)?agent-');

    assert.ok(branchCheck > 0, 'canonical fragment must assert HEAD before any work');
    assert.ok(namespaceCheck > branchCheck, 'canonical fragment must require disposable agent/worktree-agent branch');
    // #48: verify-only — the destructive self-recovery is gone; the fragment fails closed instead.
    assert.ok(!fragmentSource.includes('git reset --hard {EXPECTED_BASE}'), 'canonical fragment must not self-recover via reset --hard — orchestrator owns recovery (#48)');
    assert.ok(fragmentSource.includes('exit 42'), 'canonical fragment must fail closed with exit 42 on base mismatch (#48)');
  });

  test('remove-workspace fails closed when git worktree remove fails', () => {
    const source = read('gsd-core/workflows/remove-workspace.md');
    const init = source.indexOf('REMOVE_FAILED=false');
    const loop = source.indexOf('For each repo in the workspace');
    const remove = source.indexOf('git worktree remove "$WORKSPACE_PATH/$REPO_NAME"');

    assert.doesNotMatch(
      source,
      /git worktree remove "\$WORKSPACE_PATH\/\$REPO_NAME" 2>&1 \|\| true/,
      'worktree removal failures must not be swallowed',
    );
    assert.ok(init > 0 && init < loop, 'REMOVE_FAILED must initialize once before the per-repo loop');
    assert.ok(remove > loop, 'worktree removal should remain inside the per-repo loop');
    assert.match(source, /Refusing to delete "\$WORKSPACE_PATH"/);
  });

  test('validate health warns when worktree inventory cannot be listed', () => {
    const source = read('gsd-core/bin/lib/verify.cjs');
    // Accept both hand-written dot access and the tsc-compiled bracket form
    // (ADR-457: verify.cjs is now emitted from src/verify.cts):
    //   hand-written: worktreeHealth.reason === 'git_list_failed'
    //   tsc-compiled:  worktreeHealth['reason'] === 'git_list_failed'
    const failureBranch = source.search(/worktreeHealth(?:\.reason|\['reason'\]) === 'git_list_failed'/);
    const warning = source.indexOf("addIssue('warning', 'W020'", failureBranch);

    assert.ok(failureBranch > 0, 'verify health should branch on git_list_failed');
    assert.ok(warning > failureBranch, 'git_list_failed should emit W020 degraded-health warning');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-260-worktree-path-guard.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-260-worktree-path-guard (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression tests for bug #260 — gsd-worktree-path-guard.js
 *
 * Executor agents spawned with isolation="worktree" sometimes issue Edit/Write
 * calls with absolute paths rooted at the MAIN repository instead of the
 * worktree. The prose guard in gsd-executor.md step 0b is skipped under load,
 * so we enforce the constraint at the tooling layer with a PreToolUse hook.
 *
 * This file verifies all guard behaviours:
 *   1. No-op in the main repo (.git is a directory)
 *   2. Relative path always passes
 *   3. Non-Edit/Write tools always pass
 *   4. Absolute path inside worktree root passes
 *   5. Absolute path outside worktree root is BLOCKED (exit 2)
 *   6. Sibling path that merely shares a prefix is BLOCKED (/ boundary check)
 *   7. install.js has an fs.existsSync guard for gsd-worktree-path-guard.js
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-worktree-path-guard.js');
const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
// ADR-857 phase 5f-1b: settings-json hook registration moved to runtime-hooks-surface.cts.
const HOOKS_SURFACE_SRC = path.join(__dirname, '..', 'src', 'runtime-hooks-surface.cts');

/**
 * Resolve symlinks in a path so that we compare the same canonical form
 * that `git rev-parse --show-toplevel` returns. On macOS /tmp is a symlink
 * to /private/tmp, which causes path prefix checks to fail without this.
 */
function realp(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Create a plain git repo (main repo — .git is a directory).
 */
function makeMainRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-260-main-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  return dir;
}

/**
 * Create a worktree off mainRepo and return its path.
 * In the worktree, .git is a FILE (the gitdir pointer).
 * @param {string} mainRepo - path to the main repo
 * @param {string} [branchName] - branch name to use (default: 'worktree-agent-test')
 */
function makeWorktree(mainRepo, branchName) {
  const branch = branchName || 'worktree-agent-test';
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-260-wt-'));
  fs.rmdirSync(wtDir); // git worktree add creates the dir itself
  git(mainRepo, ['worktree', 'add', '-q', '-b', branch, wtDir]);
  return wtDir;
}

/**
 * Run the hook with a given payload, returning the spawnSync result.
 */
function runHook(cwd, payload) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let mainRepo;
let worktreeDir;

before(() => {
  mainRepo = realp(makeMainRepo());
  worktreeDir = realp(makeWorktree(mainRepo));
});

after(() => {
  // Remove worktree registration before deleting the directory
  try { git(mainRepo, ['worktree', 'remove', '--force', worktreeDir]); } catch { /* ignore */ }
  cleanup(mainRepo);
  cleanup(worktreeDir);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bug #260: gsd-worktree-path-guard.js', () => {

  // 1. No-op in main repo
  describe('no-op in main repo', () => {
    test('Edit call in main repo (.git is a directory) exits 0', () => {
      const payload = {
        cwd: mainRepo,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'foo.ts') },
      };
      const result = runHook(mainRepo, payload);
      assert.strictEqual(result.status, 0, `Expected exit 0 in main repo, got ${result.status}. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '', 'Expected no stdout in main repo no-op');
    });

    test('Write call in main repo exits 0', () => {
      const payload = {
        cwd: mainRepo,
        tool_name: 'Write',
        tool_input: { file_path: path.join(mainRepo, 'out.txt') },
      };
      const result = runHook(mainRepo, payload);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    });
  });

  // 2. Relative path always passes
  describe('relative path', () => {
    test('Edit with relative file_path exits 0 even in worktree', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: 'src/foo.ts' },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0, `Relative path should always pass. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '');
    });

    test('Write with relative file_path exits 0 in worktree', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Write',
        tool_input: { file_path: 'dist/bundle.js' },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    });
  });

  // 3. Non-Edit/Write tools always pass
  describe('non-Edit/Write tools', () => {
    test('Bash tool exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
    });

    test('Read tool exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Read',
        tool_input: { file_path: path.join(mainRepo, 'README.md') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
    });

    test('Grep tool exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Grep',
        tool_input: { pattern: 'foo', path: mainRepo },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
    });
  });

  // 4. Absolute path inside worktree passes
  describe('path inside worktree', () => {
    test('Edit with absolute path inside worktree root exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(worktreeDir, 'src', 'foo.ts') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0, `Path inside worktree should pass. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '');
    });

    test('Edit targeting exactly the worktree root exits 0', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: worktreeDir },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0);
    });
  });

  // 5. Absolute path outside worktree is BLOCKED
  describe('path outside worktree is blocked', () => {
    test('Edit targeting main repo root exits 2 with block decision', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'index.ts') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2, `Expected exit 2 (block), got ${result.status}. stderr: ${result.stderr}`);
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout must be valid JSON');
      assert.strictEqual(parsed.decision, 'block', 'Expected decision:"block" in output');
    });

    test('Write targeting main repo root exits 2 with block decision', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(mainRepo, 'out.txt') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.decision, 'block');
    });

    test('block output includes the offending path in reason', () => {
      const offendingPath = path.join(mainRepo, 'src', 'leak.ts');
      const payload = {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: offendingPath },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2);
      const parsed = JSON.parse(result.stdout);
      assert.ok(
        parsed.reason && parsed.reason.includes(offendingPath),
        `block reason should include the offending path. Got: ${parsed.reason}`
      );
    });
  });

  // 5b. #2547 — a malformed Kimi edit list must not downgrade the block to an allow
  describe('#2547: malformed Kimi edit list does not bypass the cross-root block', () => {
    // normalizeKimiPayload rebuilt old_string/new_string with `String(e.old ?? '')`.
    // `??` guards the value, not the dereference, so a NULLISH entry threw a
    // TypeError before any tool dispatch — and the guard's outer
    // `catch { process.exit(0) }` turned that crash into a silent ALLOW on the one
    // path this guard exists to BLOCK (#260).
    //
    // The boundary is nullish specifically, not "non-object": `('x').old` and
    // `(7).old` are legal property reads that yield undefined, so string/number
    // entries never threw. They are kept below as controls proving `e?.old` did
    // not change their behaviour; the nullish cases are the actual regression and
    // are the ones that exit 0 (bypass) against pre-fix code.
    const crossRootTarget = () => path.join(mainRepo, 'src', 'index.ts');

    test('well-formed Kimi edit list blocks the cross-root write (positive control)', () => {
      const result = runHook(worktreeDir, {
        cwd: worktreeDir,
        tool_name: 'StrReplaceFile',
        tool_input: { path: crossRootTarget(), edit: [{ old: 'orig', new: 'pwned' }] },
      });
      assert.strictEqual(result.status, 2,
        `expected exit 2 (block), got ${result.status}. stderr: ${result.stderr}`);
      assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
    });

    for (const [label, edit] of [
      ['null entry (the #2547 bypass)', [null]],
      ['null alongside a well-formed entry (the #2547 bypass)', [{ old: 'a', new: 'b' }, null]],
      // `{"toString": null}` is valid JSON whose coercion throws "Cannot
      // convert object to primitive value" — the same crash-to-allow reached
      // through String() rather than through the property read.
      ['non-coercible old (the #2547 String() bypass)', [{ old: { toString: null }, new: 'x' }]],
      ['non-coercible new (the #2547 String() bypass)', [{ old: 'x', new: { toString: null } }]],
      ['string entry (control — never threw)', ['nope']],
      ['number entry (control — never threw)', [7]],
    ]) {
      test(`${label} in the edit list still blocks the cross-root write`, () => {
        const result = runHook(worktreeDir, {
          cwd: worktreeDir,
          tool_name: 'StrReplaceFile',
          tool_input: { path: crossRootTarget(), edit },
        });
        assert.strictEqual(result.status, 2,
          `a malformed edit list (${label}) must not downgrade the #260 block to a silent ` +
          `allow. Got exit ${result.status}. stderr: ${result.stderr}`);
        assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
      });
    }

    test('malformed edit list inside the worktree still exits 0 (no over-block)', () => {
      const result = runHook(worktreeDir, {
        cwd: worktreeDir,
        tool_name: 'StrReplaceFile',
        tool_input: { path: path.join(worktreeDir, 'src', 'index.ts'), edit: [null] },
      });
      assert.strictEqual(result.status, 0,
        `an in-worktree write must stay allowed. Got exit ${result.status}. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '');
    });
  });

  // 5c. #2547 (review BLOCKER) — a model-supplied `file_path` must not shadow
  // Kimi's authoritative `path`. This vector needs NO crash: normalizeKimiPayload
  // copied `path` into `file_path` only when `file_path === undefined`, so any
  // `file_path` the model chose to include won, and this guard's block logic
  // reads `file_path` alone. kimi-cli executes on `path`, so the guard inspected
  // one file while the write landed on another.
  //
  // Reachability is not speculative: soul/toolset.py json-parses the model's raw
  // tool arguments and passes that dict verbatim as tool_input to PreToolUse,
  // performing typed validation only later inside tool.call() — so the model
  // controls extra keys in tool_input at the moment the hook decides.
  describe('#2547: a spurious file_path does not shadow Kimi\'s authoritative path', () => {
    const crossRootTarget = () => path.join(mainRepo, 'src', 'index.ts');
    const inWorktreeTarget = () => path.join(worktreeDir, 'src', 'index.ts');

    // Each case pairs a cross-root `path` with a `file_path` the model supplied.
    // All three exited 0 (bypass) before the fix.
    for (const [label, filePath] of [
      ['empty-string file_path (the #2547 review BLOCKER)', ''],
      ['in-worktree decoy file_path', null], // resolved below — needs worktreeDir
      // A NON-STRING file_path additionally threw inside path.isAbsolute() and
      // reached the outer `catch { process.exit(0) }` — crash-to-allow through
      // the guard's own read rather than through normalization.
      ['non-string file_path (array)', []],
      ['non-string file_path (object)', {}],
    ]) {
      test(`${label} still blocks the cross-root write`, () => {
        const result = runHook(worktreeDir, {
          cwd: worktreeDir,
          tool_name: 'StrReplaceFile',
          tool_input: {
            path: crossRootTarget(),
            file_path: filePath === null ? inWorktreeTarget() : filePath,
            edit: [{ old: 'orig', new: 'pwned' }],
          },
        });
        assert.strictEqual(result.status, 2,
          `a model-supplied file_path (${label}) must not shadow Kimi's authoritative ` +
          `path and downgrade the #260 block to a silent allow. Got exit ${result.status}. ` +
          `stderr: ${result.stderr}`);
        assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
      });
    }

    // Negative control: the same shadowing shape pointed INSIDE the worktree must
    // still be allowed, so the fix narrows what the guard inspects without
    // over-blocking.
    test('a spurious file_path on an in-worktree write still exits 0 (no over-block)', () => {
      const result = runHook(worktreeDir, {
        cwd: worktreeDir,
        tool_name: 'StrReplaceFile',
        tool_input: {
          path: inWorktreeTarget(),
          file_path: crossRootTarget(),
          edit: [{ old: 'orig', new: 'ok' }],
        },
      });
      assert.strictEqual(result.status, 0,
        `an in-worktree write must stay allowed even when a decoy file_path points ` +
        `cross-root — the guard follows the path kimi-cli executes on. ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout, '');
    });

    // Control: a NATIVE Claude payload has no `path` field, so the overwrite must
    // not fire and file_path must keep governing. Guards against a fix that
    // silently changed the non-Kimi contract.
    test('native Claude payload (no path field) still blocks on file_path alone', () => {
      const result = runHook(worktreeDir, {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: crossRootTarget() },
      });
      assert.strictEqual(result.status, 2,
        `a native Claude Edit must still block on file_path. Got exit ${result.status}. ` +
        `stderr: ${result.stderr}`);
      assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
    });
  });

  // 5d. #2595 (review Major 3) — the non-string `file_path` crash-to-allow, read
  // WITHOUT a string `path` to mask it.
  //
  // The 5c cases above pair a non-string file_path with a valid cross-root
  // `path`, so they pass because the authoritative-path overwrite replaces the
  // bad value before the read. That is real coverage of the SHADOWING fix, but
  // the review was right that it is not coverage of the crash: drop the `path`
  // key and the identical payload took `data.tool_input?.file_path || ''` ->
  // `[]` (truthy, survives the `!rawFilePath` early-out) -> `path.isAbsolute([])`
  // -> TypeError -> outer `catch { process.exit(0) }`.
  //
  // READ THE ASSERTION HONESTLY: these expect exit 0, and pre-fix code ALSO
  // exits 0 — via the catch instead of via the early-out. There is no black-box
  // signature that separates them, so these cases document the fail-open and
  // guard against a future change that makes a malformed payload BLOCK; they do
  // not detect a revert. The gate that fails on a revert is the source-level
  // invariant in tests/kimi-guard-typed-payload-reads.test.cjs. Asserting exit 0
  // here and calling it regression coverage would repeat, one level up, exactly
  // the false-green the review flagged in 5c.
  describe('#2595: a non-string file_path with no path key fails open explicitly', () => {
    for (const [label, filePath] of [
      ['array', []],
      ['object', {}],
      ['number', 42],
      ['boolean', true],
    ]) {
      test(`native Claude Edit with a ${label} file_path exits 0 without crashing`, () => {
        const result = runHook(worktreeDir, {
          cwd: worktreeDir,
          tool_name: 'Edit',
          tool_input: { file_path: filePath },
        });
        assert.strictEqual(result.status, 0,
          `a malformed file_path has no path to check and must fail open quietly, ` +
          `not block. Got exit ${result.status}. stderr: ${result.stderr}`);
        assert.strictEqual(result.stdout, '');
      });

      test(`Kimi payload with a ${label} file_path and no path key exits 0`, () => {
        const result = runHook(worktreeDir, {
          cwd: worktreeDir,
          tool_name: 'StrReplaceFile',
          tool_input: { file_path: filePath, edit: [{ old: 'orig', new: 'pwned' }] },
        });
        assert.strictEqual(result.status, 0,
          `with no string path to normalize from, there is nothing to check. ` +
          `Got exit ${result.status}. stderr: ${result.stderr}`);
        assert.strictEqual(result.stdout, '');
      });
    }

    // Control: the SAME payload shape with a string cross-root file_path must
    // still block, proving the typed read did not narrow the guard's reach.
    test('control: a string cross-root file_path with no path key still blocks', () => {
      const result = runHook(worktreeDir, {
        cwd: worktreeDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'index.ts') },
      });
      assert.strictEqual(result.status, 2,
        `typing the read must not stop the guard seeing legitimate string paths. ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`);
      assert.strictEqual(JSON.parse(result.stdout).decision, 'block');
    });
  });

  // 6. Sibling directory path is BLOCKED (validates the '/' boundary check AND prefix-overlap)
  describe('sibling path is blocked', () => {
    test('path that shares prefix with worktree root but is a sibling exits 2', () => {
      // This test exercises BOTH the prefix-overlap boundary check AND the different-git-root block:
      //   worktree  = <base>/wt
      //   sibling   = <base>/wt-sibling   ← shares "wt" prefix with the worktree root
      //   target    = <base>/wt-sibling/file.ts
      //
      // A naive startsWith(wtRoot) check would wrongly classify "<base>/wt-sibling/..." as inside
      // the worktree (it doesn't include the '/' boundary). The hook resolves the sibling's git
      // toplevel (a different repo) so the different-git-root block fires regardless.
      // (#1342: paths outside all git repos now fail open; only different-git-root blocks.)
      const base = realp(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-260-sib-base-')));
      const wtDir = path.join(base, 'wt');
      const siblingRepoDir = path.join(base, 'wt-sibling');
      // We need a genuine linked worktree at <base>/wt and a separate git repo at <base>/wt-sibling.
      // Create a fresh main repo to host this worktree (the fixture worktree is already allocated).
      const sibMainRepo = realp(makeMainRepo());
      try {
        fs.mkdirSync(base, { recursive: true });
        // Create linked worktree at <base>/wt (using sibMainRepo as its host).
        git(sibMainRepo, ['worktree', 'add', '-q', '-b', 'worktree-agent-sib-test', wtDir]);
        // Create a separate git repo at <base>/wt-sibling (shares "wt" prefix).
        fs.mkdirSync(siblingRepoDir, { recursive: true });
        git(siblingRepoDir, ['init', '-q']);
        git(siblingRepoDir, ['config', 'user.email', 'test@example.com']);
        git(siblingRepoDir, ['config', 'user.name', 'Test User']);
        git(siblingRepoDir, ['config', 'commit.gpgsign', 'false']);
        fs.writeFileSync(path.join(siblingRepoDir, 'README.md'), '# sibling\n');
        git(siblingRepoDir, ['add', 'README.md']);
        git(siblingRepoDir, ['commit', '-q', '-m', 'chore: sibling init']);

        // Confirm prefix-overlap: siblingRepoDir starts with wtDir (without trailing sep).
        assert.ok(
          siblingRepoDir.startsWith(wtDir),
          `Sibling "${siblingRepoDir}" must share a string prefix with worktree "${wtDir}" for this test to be meaningful`
        );
        // Confirm they are genuinely distinct (different toplevel).
        assert.notStrictEqual(
          realp(siblingRepoDir), realp(wtDir),
          'sibling and worktree must be different directories'
        );

        const siblingPath = path.join(realp(siblingRepoDir), 'file.ts');
        const payload = {
          cwd: realp(wtDir),
          tool_name: 'Edit',
          tool_input: { file_path: siblingPath },
        };
        const result = runHook(realp(wtDir), payload);
        assert.strictEqual(result.status, 2,
          `Path inside a prefix-sibling git repo "${siblingPath}" must be blocked (exit 2), got ${result.status}. ` +
          `This validates both the prefix-overlap boundary and the different-git-root block. stderr: ${result.stderr}`
        );
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.decision, 'block');
      } finally {
        try { git(sibMainRepo, ['worktree', 'remove', '--force', wtDir]); } catch { /* ignore */ }
        cleanup(sibMainRepo);
        cleanup(base);
      }
    });
  });

  // 7. Adversarial: subdirectory cwd still guards correctly (Codex finding #2)
  describe('subdirectory cwd', () => {
    test('hook fires when cwd is a subdirectory of the worktree, not just its root', () => {
      // The orchestrator may set cwd to a subdirectory. The hook must still
      // detect the worktree context via git rev-parse --git-dir and block.
      const subDir = path.join(worktreeDir, 'src');
      fs.mkdirSync(subDir, { recursive: true });
      const payload = {
        cwd: subDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'index.ts') },
      };
      const result = runHook(subDir, payload);
      assert.strictEqual(result.status, 2,
        `Hook must block even when cwd is a subdirectory of the worktree. ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`
      );
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.decision, 'block');
    });

    test('path inside worktree passes even when cwd is a subdirectory', () => {
      const subDir = path.join(worktreeDir, 'src');
      fs.mkdirSync(subDir, { recursive: true });
      const payload = {
        cwd: subDir,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(worktreeDir, 'src', 'foo.ts') },
      };
      const result = runHook(subDir, payload);
      assert.strictEqual(result.status, 0,
        `Absolute path inside worktree should pass regardless of cwd. ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`
      );
    });
  });

  // 8. Adversarial: `..` traversal is normalised before the containment check (Codex finding #1)
  describe('dot-dot traversal is blocked', () => {
    test('path with .. that escapes the worktree is blocked', () => {
      // Construct the traversal target inside a SEPARATE git repo that is
      // guaranteed to be outside the worktree on every platform (no symlink
      // ambiguity).  The hook finds the external dir's git toplevel (a different
      // repo → different-git-root block).
      // (#1342: paths outside all git repos now fail open; only different-git-root blocks,
      // so externalDir must be inside a real different git repo to exercise the block.)
      const externalDir = realp(makeMainRepo());
      try {
        // Sanity: the external directory must not be inside the worktree.
        assert.ok(
          !externalDir.startsWith(worktreeDir + path.sep) && externalDir !== worktreeDir,
          `externalDir "${externalDir}" must be outside worktreeDir "${worktreeDir}"`
        );

        // Build a traversal path that uses ../ segments to climb out of the
        // worktree and into externalDir.  path.resolve() will normalise it to
        // externalDir/file.ts, which is outside the worktree by construction.
        // We compute the number of segments needed to reach the filesystem root
        // from worktreeDir so the traversal always lands at the right level
        // regardless of how deep the worktree path is.
        // Build a file_path containing literal `..` segments that climb out of the
        // worktree into externalDir. path.relative() yields a ..-laden relative path
        // between two same-drive absolute paths (both live under os.tmpdir()); we
        // re-anchor it at worktreeDir via STRING CONCAT (NOT path.join, which would
        // normalise the `..` away) so the hook's path.resolve() must collapse it.
        // Windows-safe: avoids the drive-letter doubling that
        // path.join(worktreeDir, '..', absolutePath) produces on win32 (#1342).
        const externalTarget = path.join(externalDir, 'file.ts');
        const traversalPath = worktreeDir + path.sep + path.relative(worktreeDir, externalTarget);

        // Confirm the resolved path is truly outside the worktree (test integrity guard).
        const resolved = path.resolve(traversalPath);
        assert.ok(
          !resolved.startsWith(worktreeDir + path.sep) && resolved !== worktreeDir,
          `Traversal resolved to "${resolved}" which is still inside worktreeDir "${worktreeDir}". ` +
          `This means the test itself is broken, not a production bug.`
        );

        const payload = {
          cwd: worktreeDir,
          tool_name: 'Edit',
          tool_input: { file_path: traversalPath },
        };
        const result = runHook(worktreeDir, payload);
        assert.strictEqual(result.status, 2,
          `Traversal path "${traversalPath}" resolves to "${resolved}" which is outside the worktree. ` +
          `Must be blocked (exit 2). Got exit ${result.status}. stderr: ${result.stderr}`
        );
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.decision, 'block',
          `Expected decision:"block", got: ${JSON.stringify(parsed)}`
        );
      } finally {
        cleanup(externalDir);
      }
    });
  });

  // 9. MultiEdit is also guarded (Codex finding #5)
  describe('MultiEdit tool is guarded', () => {
    test('MultiEdit with outside absolute path is blocked', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'MultiEdit',
        tool_input: { file_path: path.join(mainRepo, 'src', 'index.ts') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 2,
        `MultiEdit targeting outside path must be blocked. Got ${result.status}. stderr: ${result.stderr}`
      );
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.decision, 'block');
    });

    test('MultiEdit with inside absolute path passes', () => {
      const payload = {
        cwd: worktreeDir,
        tool_name: 'MultiEdit',
        tool_input: { file_path: path.join(worktreeDir, 'src', 'foo.ts') },
      };
      const result = runHook(worktreeDir, payload);
      assert.strictEqual(result.status, 0,
        `MultiEdit inside worktree should pass. Got ${result.status}. stderr: ${result.stderr}`
      );
    });
  });

});

// ---------------------------------------------------------------------------
// #2304 — Kimi tool vocabulary engages the guard
// ---------------------------------------------------------------------------

describe('#2304 — Kimi tool vocabulary engages the guard', () => {
  // Payload shapes mirror kimi-cli's actual tool schemas
  // (src/kimi_cli/tools/file/{write,replace}.py): WriteFile takes
  // `path`/`content`, StrReplaceFile takes `path` + `edit: Edit | list[Edit]`
  // — NOT Claude's `file_path`/`old_string`/`new_string`.

  test('WriteFile targeting the main repo from a worktree is blocked like Write', () => {
    const offendingPath = path.join(mainRepo, 'out.txt');
    const payload = {
      cwd: worktreeDir,
      tool_name: 'WriteFile',
      tool_input: { path: offendingPath, content: 'leak' },
    };
    const result = runHook(worktreeDir, payload);
    assert.strictEqual(result.status, 2,
      `Kimi WriteFile targeting an outside path must be blocked. Got ${result.status}. stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.decision, 'block');
    // Kimi feeds stderr (not stdout) back to the model on exit 2, so the
    // reason must also reach stderr or the model gets a bare denial.
    assert.ok(result.stderr.includes(offendingPath),
      `block reason must reach stderr for Kimi's exit-2 protocol. Got stderr: ${result.stderr}`);
  });

  test('StrReplaceFile targeting the main repo from a worktree is blocked like Edit', () => {
    const payload = {
      cwd: worktreeDir,
      tool_name: 'StrReplaceFile',
      tool_input: { path: path.join(mainRepo, 'src', 'index.ts'), edit: { old: 'a', new: 'b' } },
    };
    const result = runHook(worktreeDir, payload);
    assert.strictEqual(result.status, 2,
      `Kimi StrReplaceFile targeting an outside path must be blocked. Got ${result.status}. stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.decision, 'block');
  });

  test('module-qualified kimi_cli.tools.file:WriteFile is also recognized', () => {
    const payload = {
      cwd: worktreeDir,
      tool_name: 'kimi_cli.tools.file:WriteFile',
      tool_input: { path: path.join(mainRepo, 'out.txt'), content: 'leak' },
    };
    const result = runHook(worktreeDir, payload);
    assert.strictEqual(result.status, 2,
      `Module-qualified Kimi WriteFile must be blocked. Got ${result.status}. stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.decision, 'block');
  });

  test('StrReplaceFile with a path inside the worktree still passes', () => {
    const payload = {
      cwd: worktreeDir,
      tool_name: 'StrReplaceFile',
      tool_input: { path: path.join(worktreeDir, 'src', 'foo.ts'), edit: { old: 'a', new: 'b' } },
    };
    const result = runHook(worktreeDir, payload);
    assert.strictEqual(result.status, 0,
      `Kimi StrReplaceFile inside the worktree should pass. Got ${result.status}. stderr: ${result.stderr}`);
  });

  test('non-file Kimi tools still pass through silently', () => {
    const payload = {
      cwd: worktreeDir,
      tool_name: 'kimi_cli.tools.file:Grep',
      tool_input: { path: path.join(mainRepo, 'src', 'index.ts') },
    };
    const result = runHook(worktreeDir, payload);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '');
  });
});

// ---------------------------------------------------------------------------
// #1342 — GSD-activity gate + fail-open for no-repo targets
// ---------------------------------------------------------------------------

describe('#1342 — GSD-activity gate + fail-open for no-repo targets', () => {
  // Fixtures: one non-agent linked worktree (plain user branch) + one agent worktree
  let mainRepo1342;
  let nonAgentWorktree;   // on branch 'feature-x' — non-GSD
  let agentWorktree;       // on branch 'worktree-agent-foo' — GSD-managed

  before(() => {
    mainRepo1342 = realp(makeMainRepo());
    nonAgentWorktree = realp(makeWorktree(mainRepo1342, 'feature-x'));
    agentWorktree    = realp(makeWorktree(mainRepo1342, 'worktree-agent-foo'));
  });

  after(() => {
    try { git(mainRepo1342, ['worktree', 'remove', '--force', nonAgentWorktree]); } catch { /* ignore */ }
    try { git(mainRepo1342, ['worktree', 'remove', '--force', agentWorktree]); } catch { /* ignore */ }
    cleanup(mainRepo1342);
    cleanup(nonAgentWorktree);
    cleanup(agentWorktree);
  });

  // Test 1 — reporter repro: non-agent worktree writing outside all git repos → exit 0
  test('(1) non-agent linked worktree: Write to a path outside all git repos exits 0 (no block)', () => {
    // Simulates Claude Code plan-mode writing ~/.claude/plans/<slug>.md from a
    // manually-created linked worktree that is NOT on a worktree-agent-* branch.
    const plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1342-plans-'));
    try {
      const targetPath = path.join(plansDir, 'my-plan.md');
      const payload = {
        cwd: nonAgentWorktree,
        tool_name: 'Write',
        tool_input: { file_path: targetPath },
      };
      const result = runHook(nonAgentWorktree, payload);
      assert.strictEqual(result.status, 0,
        `Non-agent linked worktree writing outside git repos must exit 0 (reporter repro). ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`
      );
      assert.strictEqual(result.stdout, '', 'Expected no block output');
    } finally {
      cleanup(plansDir);
    }
  });

  // Test 2 — non-agent linked worktree: Edit targeting MAIN repo root → exit 0 (gate no-op)
  test('(2) non-agent linked worktree: Edit targeting main repo root exits 0 (gate no-op, not #260 block)', () => {
    const payload = {
      cwd: nonAgentWorktree,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(mainRepo1342, 'src', 'index.ts') },
    };
    const result = runHook(nonAgentWorktree, payload);
    assert.strictEqual(result.status, 0,
      `Non-agent linked worktree must exit 0 (GSD-activity gate fires before #260 check). ` +
      `Got exit ${result.status}. stderr: ${result.stderr}`
    );
    assert.strictEqual(result.stdout, '', 'Expected no block output');
  });

  // Test 3 — GSD-managed worktree (worktree-agent-foo): Edit targeting main repo root → exit 2 (block)
  test('(3) GSD-managed worktree: Edit targeting main repo root exits 2 with block decision', () => {
    const payload = {
      cwd: agentWorktree,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(mainRepo1342, 'src', 'index.ts') },
    };
    const result = runHook(agentWorktree, payload);
    assert.strictEqual(result.status, 2,
      `GSD-managed worktree targeting main repo root must be blocked (exit 2). ` +
      `Got exit ${result.status}. stderr: ${result.stderr}`
    );
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout must be valid JSON');
    assert.strictEqual(parsed.decision, 'block', 'Expected decision:"block" in output');
  });

  // Test 4 — GSD-managed worktree: absolute target INSIDE the active worktree → exit 0
  test('(4) GSD-managed worktree: absolute target inside the active worktree exits 0', () => {
    const payload = {
      cwd: agentWorktree,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(agentWorktree, 'src', 'foo.ts') },
    };
    const result = runHook(agentWorktree, payload);
    assert.strictEqual(result.status, 0,
      `GSD-managed worktree targeting its own subtree must pass. ` +
      `Got exit ${result.status}. stderr: ${result.stderr}`
    );
    assert.strictEqual(result.stdout, '', 'Expected no block output');
  });

  // Test 5 — GSD-managed worktree: target OUTSIDE all git repos (tmpdir) → exit 0 (fail open)
  test('(5) GSD-managed worktree: target outside all git repos exits 0 (fail open, not #260 vector)', () => {
    // Create a temp dir that is NOT a git repository (no .git).
    // This is the ~/.claude/plans/ scenario — a path that has a real ancestor
    // directory but is outside every git repo.
    // IMPORTANT: this dir must NOT be inside any .git directory — it must be a plain tempdir
    // so the fail-open path (truly outside all repos) is exercised, not the .git-internals block.
    const externalDir = realp(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1342-ext-')));
    try {
      const targetPath = path.join(externalDir, 'notes.md');
      const payload = {
        cwd: agentWorktree,
        tool_name: 'Write',
        tool_input: { file_path: targetPath },
      };
      const result = runHook(agentWorktree, payload);
      assert.strictEqual(result.status, 0,
        `GSD-managed worktree writing to a path outside all git repos must fail open (exit 0). ` +
        `Only the different-git-root vector (#260) blocks; no-repo targets are not that vector. ` +
        `Got exit ${result.status}. stderr: ${result.stderr}`
      );
      assert.strictEqual(result.stdout, '', 'Expected no block output');
    } finally {
      cleanup(externalDir);
    }
  });

  // Test 6 — GSD-managed worktree: Write to .git/config of the MAIN repo → exit 2 (block)
  test('(6) blocks absolute writes into the main repo .git internals from a GSD worktree (#1342)', () => {
    // A target like /main-repo/.git/config or /main-repo/.git/hooks/pre-commit causes
    // `git rev-parse --show-toplevel` to FAIL (a .git dir is not a work tree), so the
    // "file not in any git repo" branch fires. Previously that branch failed open — but
    // writing into repository internals via an absolute path is still a #260-class escape
    // (and dangerous, e.g. injecting a git hook). The fix checks --is-inside-git-dir and
    // blocks when true.
    const gitConfigPath = path.join(mainRepo1342, '.git', 'config');
    const payload = {
      cwd: agentWorktree,
      tool_name: 'Write',
      tool_input: { file_path: gitConfigPath },
    };
    const result = runHook(agentWorktree, payload);
    assert.strictEqual(result.status, 2,
      `GSD-managed worktree targeting .git/config of another repo must be blocked (exit 2). ` +
      `Got exit ${result.status}. stderr: ${result.stderr}`
    );
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout must be valid JSON');
    assert.strictEqual(parsed.decision, 'block', 'Expected decision:"block" in output');
    assert.ok(
      parsed.reason && parsed.reason.includes('.git'),
      `Block reason should mention .git internals. Got: ${parsed.reason}`
    );
  });
});

// ---------------------------------------------------------------------------
// Static analysis: install.js guard
// ---------------------------------------------------------------------------

describe('install.js guard for gsd-worktree-path-guard.js', () => {
  let src;

  before(() => {
    // ADR-857 phase 5f-1b: hook registration moved to runtime-hooks-surface.cts.
    // Concatenate both sources so structural assertions find patterns in either file.
    const installSrc = fs.readFileSync(INSTALL_SRC, 'utf-8');
    let hooksSurfaceSrc = '';
    try { hooksSurfaceSrc = fs.readFileSync(HOOKS_SURFACE_SRC, 'utf-8'); } catch { /* ok */ }
    src = installSrc + '\n' + hooksSurfaceSrc;
  });

  test('install.js has hasWorktreePathGuardHook variable', () => {
    assert.ok(
      src.includes('hasWorktreePathGuardHook'),
      'hasWorktreePathGuardHook variable not found in install.js'
    );
  });

  test('install.js checks fs.existsSync before registering gsd-worktree-path-guard.js', () => {
    const anchorIdx = src.indexOf('hasWorktreePathGuardHook');
    assert.ok(anchorIdx !== -1, 'hasWorktreePathGuardHook not found in install.js');

    const blockStart = anchorIdx;
    const blockEnd = Math.min(src.length, anchorIdx + 1200);
    const block = src.slice(blockStart, blockEnd);

    assert.ok(
      block.includes('fs.existsSync') || block.includes('existsSync'),
      'install.js must call fs.existsSync on the target path before registering ' +
      'gsd-worktree-path-guard.js in settings.json. Without this guard, the hook ' +
      'is registered even when the .js file was never copied (root cause of #1754).'
    );
  });

  test('install.js emits a skip warning when gsd-worktree-path-guard.js is missing', () => {
    const anchorIdx = src.indexOf('hasWorktreePathGuardHook');
    assert.ok(anchorIdx !== -1, 'hasWorktreePathGuardHook not found in install.js');

    const block = src.slice(anchorIdx, Math.min(src.length, anchorIdx + 1200));

    assert.ok(
      block.includes('Skipped') && block.includes('gsd-worktree-path-guard'),
      'install.js must emit a skip warning mentioning gsd-worktree-path-guard when the file is not found'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-261-worktree-force-add-guard.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-261-worktree-force-add-guard (consolidation epic #1969 B6 #1975)", () => {
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-workflow-guard.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug-261-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  git(dir, ['checkout', '-q', '-b', branch]);
  return dir;
}

function setWorkflowGuard(dir, enabled) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ hooks: { workflow_guard: enabled } }, null, 2)
  );
}

function runHookInput(cwd, input) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ cwd, ...input }),
  });
}

function runBashHook(cwd, command) {
  return runHookInput(cwd, {
    tool_name: 'Bash',
    tool_input: { command },
  });
}

describe('bug #261: workflow guard blocks forced git add on worktree-agent branches', () => {
  test('blocks git add -f on worktree-agent branch when workflow guard is enabled', () => {
    const dir = makeRepo('worktree-agent-a1');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, 'git add -f .planning/phases/01/01-01-SUMMARY.md');
      assert.strictEqual(result.status, 2);
      const envelope = JSON.parse(result.stdout);
      assert.strictEqual(envelope.decision, 'block');
      assert.strictEqual(envelope.code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
    } finally {
      cleanup(dir);
    }
  });

  test('blocks git add --force with git global options on worktree-agent branch', () => {
    const dir = makeRepo('worktree-agent-b2');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, `git -C "${dir}" add --force .planning/SUMMARY.md`);
      assert.strictEqual(result.status, 2);
      assert.strictEqual(JSON.parse(result.stdout).code, 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN');
    } finally {
      cleanup(dir);
    }
  });

  test('allows ordinary git add on worktree-agent branch', () => {
    const dir = makeRepo('worktree-agent-c3');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, 'git add .planning/SUMMARY.md');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('allows pathspecs named like force flags after git add -- terminator', () => {
    const dir = makeRepo('worktree-agent-d4');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, 'git add -- -f');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('allows git add -f outside worktree-agent branches', () => {
    const dir = makeRepo('feature-docs');
    try {
      setWorkflowGuard(dir, true);
      const result = runBashHook(dir, 'git add -f .planning/SUMMARY.md');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('allows git add -f on worktree-agent branch when workflow guard is disabled', () => {
    const dir = makeRepo('worktree-agent-e5');
    try {
      setWorkflowGuard(dir, false);
      const result = runBashHook(dir, 'git add -f .planning/SUMMARY.md');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('allows git add -f on worktree-agent branch when no GSD config exists', () => {
    const dir = makeRepo('worktree-agent-f6');
    try {
      const result = runBashHook(dir, 'git add -f .planning/SUMMARY.md');
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(dir);
    }
  });

  test('applies the advisory path to MultiEdit when workflow guard is enabled', () => {
    const dir = makeRepo('feature-multiedit');
    try {
      setWorkflowGuard(dir, true);
      const result = runHookInput(dir, {
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: path.join(dir, 'src.js'),
          edits: [],
        },
      });
      assert.strictEqual(result.status, 0);
      const envelope = JSON.parse(result.stdout);
      assert.match(
        envelope.hookSpecificOutput.additionalContext,
        /WORKFLOW ADVISORY/
      );
    } finally {
      cleanup(dir);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2772-gitmodules-path-intersection.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2772-gitmodules-path-intersection (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #2772)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for #2772: worktree isolation is unconditionally disabled
 * when `.gitmodules` exists in the repo, even when the plan does not touch
 * any submodule path.
 *
 * Behavioral test: the bash decision pipeline from
 * gsd-core/workflows/execute-phase.md is extracted verbatim into an
 * executable snippet here, then run via execFileSync('bash', ...) against
 * real fixture projects built with `createTempGitProject()`. We assert
 * the resulting USE_WORKTREES_FOR_PLAN value (printed on the final line
 * of stdout) and the presence/absence of the [worktree] log line for each
 * scenario.
 *
 * If execute-phase.md's bash gate is ever rewritten so the extracted
 * snippet stops matching real behavior, this test must be updated to
 * track the new pipeline — never replaced with a source grep.
 *
 * In addition to the per-plan gate behavior, this file also asserts:
 *   - The workflow markdown actually wires USE_WORKTREES_FOR_PLAN into
 *     each of the four dispatch sites (worktree-mode gate, sequential-mode
 *     gate, "worktrees disabled" prose, post-wave cleanup gate). Without
 *     this, the per-plan computation would be dead code (the original
 *     #2772 fix shipped in this state — CodeRabbit caught it).
 *   - The quick.md executor prompt injects SUBMODULE_PATHS and a fail-loud
 *     pre-commit guard, and the guard actually aborts when staged paths
 *     fall inside a submodule.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createTempGitProject, cleanup } = require('./helpers.cjs');

// Bash snippet extracted from execute-phase.md (the SUBMODULE_PATHS parse +
// per-plan intersection logic with normalization + bidirectional matching).
// Inputs come from env vars: PLAN_FILES (whitespace-separated) and plan_id.
// Output: log lines on stdout, then a final line
// `USE_WORKTREES_FOR_PLAN=<true|false>` for the test to parse.
const GATE_SNIPPET = [
  'set -e',
  'USE_WORKTREES="${USE_WORKTREES:-true}"',
  'if [ -f .gitmodules ]; then',
  "  SUBMODULE_PATHS=$(git config --file .gitmodules --get-regexp '^submodule\\..*\\.path$' 2>/dev/null | awk '{print $2}')",
  'else',
  '  SUBMODULE_PATHS=""',
  'fi',
  'USE_WORKTREES_FOR_PLAN="$USE_WORKTREES"',
  'if [ -n "$SUBMODULE_PATHS" ] && [ "$USE_WORKTREES_FOR_PLAN" != "false" ]; then',
  '  if [ -z "$PLAN_FILES" ]; then',
  '    echo "[worktree] Plan ${plan_id}: files_modified missing/unparseable — disabling worktree isolation as a safety fallback (submodule project)"',
  '    USE_WORKTREES_FOR_PLAN=false',
  '  else',
  '    INTERSECT=""',
  '    set -f',
  '    for sm_raw in $SUBMODULE_PATHS; do',
  '      sm="${sm_raw#./}"',
  '      sm="${sm%/}"',
  '      [ -z "$sm" ] && continue',
  '      for pf_raw in $PLAN_FILES; do',
  '        pf="${pf_raw#./}"',
  '        pf="${pf%/}"',
  '        [ -z "$pf" ] && continue',
  '        matched=0',
  '        case "$pf" in',
  '          "$sm"|"$sm"/*) matched=1 ;;',
  '        esac',
  '        if [ "$matched" -eq 0 ]; then',
  '          case "$sm" in',
  '            "$pf"|"$pf"/*) matched=1 ;;',
  '          esac',
  '        fi',
  '        if [ "$matched" -eq 0 ]; then',
  '          case "$pf" in',
  "            *'*'*|*'?'*|*'['*)",
  '              prefix="${pf%%[*?[]*}"',
  '              prefix="${prefix%/}"',
  '              if [ -n "$prefix" ]; then',
  '                case "$sm" in',
  '                  "$prefix"|"$prefix"/*) matched=1 ;;',
  '                esac',
  '                if [ "$matched" -eq 0 ]; then',
  '                  case "$prefix" in',
  '                    "$sm"|"$sm"/*) matched=1 ;;',
  '                  esac',
  '                fi',
  '              fi',
  '              ;;',
  '        esac',
  '        fi',
  '        if [ "$matched" -eq 1 ]; then',
  '          INTERSECT="$INTERSECT $pf_raw"',
  '        fi',
  '      done',
  '    done',
  '    set +f',
  '    if [ -n "$INTERSECT" ]; then',
  '      echo "[worktree] Plan ${plan_id}: planned paths intersect submodule paths (${INTERSECT# }) — disabling worktree isolation for this plan"',
  '      USE_WORKTREES_FOR_PLAN=false',
  '    fi',
  '  fi',
  'fi',
  'echo "USE_WORKTREES_FOR_PLAN=$USE_WORKTREES_FOR_PLAN"',
].join('\n');

function runGate(cwd, env) {
  const out = execFileSync('bash', ['-c', GATE_SNIPPET], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  const lines = out.trim().split('\n');
  const last = lines[lines.length - 1];
  const m = last.match(/^USE_WORKTREES_FOR_PLAN=(true|false)$/);
  assert.ok(
    m,
    `expected final line to be USE_WORKTREES_FOR_PLAN=<bool>, got: ${last}\nfull stdout:\n${out}`
  );
  return { decision: m[1], stdout: out, logLines: lines.slice(0, -1) };
}

function writeGitmodulesWithSubmodule(repo, submodulePath) {
  const content = [
    `[submodule "${submodulePath}"]`,
    `\tpath = ${submodulePath}`,
    `\turl = https://example.invalid/${submodulePath}.git`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(repo, '.gitmodules'), content);
}

describe('Submodule worktree-isolation gate intersects planned paths (#2772)', () => {
  let repo;

  beforeEach(() => {
    repo = createTempGitProject('gsd-test-2772-');
  });

  afterEach(() => {
    cleanup(repo);
  });

  test('plan touching only src/ in a submodule project keeps worktree isolation ENABLED', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision, logLines } = runGate(repo, {
      PLAN_FILES: 'src/index.ts src/lib/util.ts',
      plan_id: 'plan-001',
    });

    assert.equal(decision, 'true');
    assert.equal(logLines.filter((l) => l.startsWith('[worktree]')).length, 0);
  });

  test('plan touching vendor/foo/bar.ts in a submodule project DISABLES worktree isolation', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision, stdout } = runGate(repo, {
      PLAN_FILES: 'src/index.ts vendor/foo/bar.ts',
      plan_id: 'plan-002',
    });

    assert.equal(decision, 'false');
    assert.match(stdout, /\[worktree\] Plan plan-002: planned paths intersect submodule paths/);
    assert.match(stdout, /vendor\/foo\/bar\.ts/);
  });

  test('plan whose path equals the submodule root (vendor/foo) DISABLES worktree isolation', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision, stdout } = runGate(repo, {
      PLAN_FILES: 'vendor/foo',
      plan_id: 'plan-003',
    });

    assert.equal(decision, 'false');
    assert.match(stdout, /\[worktree\] Plan plan-003: planned paths intersect submodule paths/);
  });

  test('missing files_modified in a submodule project falls back to DISABLE with a logged reason', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision, stdout } = runGate(repo, {
      PLAN_FILES: '',
      plan_id: 'plan-004',
    });

    assert.equal(decision, 'false');
    assert.match(stdout, /\[worktree\] Plan plan-004: files_modified missing\/unparseable/);
    assert.match(stdout, /safety fallback/);
  });

  test('repo with no .gitmodules at all keeps worktree isolation ENABLED regardless of plan paths', () => {
    const { decision, logLines } = runGate(repo, {
      PLAN_FILES: 'vendor/foo/bar.ts src/index.ts',
      plan_id: 'plan-005',
    });

    assert.equal(decision, 'true');
    assert.equal(logLines.filter((l) => l.startsWith('[worktree]')).length, 0);
  });

  test('multiple submodules, plan touches only one of them — DISABLE with that path in the log', () => {
    const gitmodules = [
      '[submodule "vendor/foo"]',
      '\tpath = vendor/foo',
      '\turl = https://example.invalid/foo.git',
      '[submodule "third_party/bar"]',
      '\tpath = third_party/bar',
      '\turl = https://example.invalid/bar.git',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(repo, '.gitmodules'), gitmodules);

    const { decision, stdout } = runGate(repo, {
      PLAN_FILES: 'src/a.ts third_party/bar/b.ts',
      plan_id: 'plan-006',
    });

    assert.equal(decision, 'false');
    assert.match(stdout, /third_party\/bar\/b\.ts/);
  });

  test('planned path that merely shares a prefix with a submodule (vendor/foobar) does NOT count as intersection', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision, logLines } = runGate(repo, {
      PLAN_FILES: 'vendor/foobar/x.ts',
      plan_id: 'plan-007',
    });

    assert.equal(decision, 'true');
    assert.equal(logLines.filter((l) => l.startsWith('[worktree]')).length, 0);
  });

  // ---- Path-normalization & glob coverage (CodeRabbit MAJOR finding) ----

  test('planned path with leading "./" normalizes and DISABLES isolation when inside a submodule', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision, stdout } = runGate(repo, {
      PLAN_FILES: './vendor/foo/bar.c',
      plan_id: 'plan-norm-1',
    });

    assert.equal(decision, 'false', './vendor/foo/bar.c must normalize and intersect vendor/foo');
    assert.match(stdout, /vendor\/foo\/bar\.c/);
  });

  test('planned path with trailing slash equal to submodule DISABLES isolation', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision } = runGate(repo, {
      PLAN_FILES: 'vendor/foo/',
      plan_id: 'plan-norm-2',
    });

    assert.equal(decision, 'false', 'trailing slash must not defeat the submodule-root match');
  });

  test('globby planned path "vendor/**/*.c" DISABLES isolation when submodule sits inside vendor/', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision, stdout } = runGate(repo, {
      PLAN_FILES: 'vendor/**/*.c',
      plan_id: 'plan-norm-3',
    });

    assert.equal(
      decision,
      'false',
      'glob whose literal prefix "vendor" contains submodule vendor/foo must intersect'
    );
    assert.match(stdout, /vendor\/\*\*\/\*\.c/);
  });

  test('plan declares a parent directory of the submodule (e.g. "vendor") — DISABLES isolation', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision } = runGate(repo, {
      PLAN_FILES: 'vendor',
      plan_id: 'plan-norm-4',
    });

    assert.equal(
      decision,
      'false',
      'planned path that contains the submodule must intersect (bidirectional matching)'
    );
  });

  test('submodule path declared with leading "./" in .gitmodules still matches a plain planned path', () => {
    const gitmodules = [
      '[submodule "vendor/foo"]',
      '\tpath = ./vendor/foo',
      '\turl = https://example.invalid/foo.git',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(repo, '.gitmodules'), gitmodules);

    const { decision } = runGate(repo, {
      PLAN_FILES: 'vendor/foo/bar.ts',
      plan_id: 'plan-norm-5',
    });

    assert.equal(
      decision,
      'false',
      'submodule "./vendor/foo" must normalize and match plain planned path vendor/foo/bar.ts'
    );
  });

  test('globby planned path that does NOT overlap the submodule keeps isolation ENABLED', () => {
    writeGitmodulesWithSubmodule(repo, 'vendor/foo');

    const { decision, logLines } = runGate(repo, {
      PLAN_FILES: 'src/**/*.ts',
      plan_id: 'plan-norm-6',
    });

    assert.equal(decision, 'true');
    assert.equal(logLines.filter((l) => l.startsWith('[worktree]')).length, 0);
  });
});

// ---- Workflow-markdown wiring assertions (CodeRabbit CRITICAL finding) ----
//
// The original PR computed USE_WORKTREES_FOR_PLAN but never read it at the
// dispatch sites — the dispatch still branched on the project-level
// USE_WORKTREES, so the per-plan decision was dead code. Assert the markdown
// actually wires the variable into the four dispatch sites.

describe('execute-phase.md dispatch wires USE_WORKTREES_FOR_PLAN (#2772)', () => {
  const workflowPath = path.join(
    __dirname,
    '..',
    'gsd-core',
    'workflows',
    'execute-phase.md'
  );
  const gatePath = path.join(
    __dirname,
    '..',
    'gsd-core',
    'workflows',
    'execute-phase',
    'steps',
    'per-plan-worktree-gate.md'
  );

  test('workflow file exists and is readable', () => {
    assert.ok(fs.existsSync(workflowPath), `expected ${workflowPath} to exist`);
  });

  test('per-plan worktree gate steps file exists and is readable', () => {
    assert.ok(fs.existsSync(gatePath), `expected ${gatePath} to exist`);
  });

  test('Worktree-mode dispatch gate reads both USE_WORKTREES and USE_WORKTREES_FOR_PLAN (#2474)', () => {
    const md = fs.readFileSync(workflowPath, 'utf-8');
    assert.match(
      md,
      /\*\*Worktree mode\*\*.*`USE_WORKTREES`.*`USE_WORKTREES_FOR_PLAN`/,
      'Worktree-mode header must gate on both USE_WORKTREES and USE_WORKTREES_FOR_PLAN (#2474)'
    );
  });

  test('Sequential-mode dispatch gate reads USE_WORKTREES_FOR_PLAN', () => {
    const md = fs.readFileSync(workflowPath, 'utf-8');
    assert.match(
      md,
      /\*\*Sequential mode\*\*\s*\(`USE_WORKTREES_FOR_PLAN`/,
      'Sequential-mode header must gate on USE_WORKTREES_FOR_PLAN per-plan'
    );
  });

  test('"Worktrees disabled" sequential rule is documented per-plan, not project-level', () => {
    const md = fs.readFileSync(workflowPath, 'utf-8');
    assert.match(
      md,
      /worktrees are disabled for a plan/i,
      'sequential-execution rule must be expressed per-plan'
    );
  });

  test('execute-phase.md hooks the per-plan gate steps file at sub-step 2.5', () => {
    const md = fs.readFileSync(workflowPath, 'utf-8');
    assert.match(md, /Per-plan worktree decision/, 'sub-step header must exist in execute_waves');
    assert.match(
      md,
      /execute-phase\/steps\/per-plan-worktree-gate\.md/,
      'execute-phase.md must reference the extracted gate file'
    );
  });

  test('per-plan gate file documents PLAN_FILES extraction from plan_json', () => {
    const md = fs.readFileSync(gatePath, 'utf-8');
    assert.match(
      md,
      /jq -r '\.files_modified \/\/ \[\] \| join\(" "\)' <<<"\$plan_json"/,
      'PLAN_FILES extraction from plan_json must be documented in the gate file'
    );
  });

  test('per-plan gate file uses bidirectional case + glob-prefix handling + set -f discipline', () => {
    const md = fs.readFileSync(gatePath, 'utf-8');
    assert.match(md, /set -f/, 'matcher must disable globbing while iterating');
    assert.match(md, /set \+f/, 'matcher must re-enable globbing after iteration');
    const pfFirst = md.match(/case "\$pf" in\s+"\$sm"\|"\$sm"\/\*\)/);
    const smFirst = md.match(/case "\$sm" in\s+"\$pf"\|"\$pf"\/\*\)/);
    assert.ok(pfFirst, 'matcher must check pf inside sm');
    assert.ok(smFirst, 'matcher must check sm inside pf (bidirectional)');
    assert.match(md, /sm="\$\{sm_raw#\.\/\}"/, 'submodule path must strip leading ./');
    assert.match(md, /pf="\$\{pf_raw#\.\/\}"/, 'planned path must strip leading ./');
    assert.match(md, /sm="\$\{sm%\/\}"/, 'submodule path must strip trailing /');
    assert.match(md, /pf="\$\{pf%\/\}"/, 'planned path must strip trailing /');
  });

  test('Post-wave worktree-cleanup gate is per-plan, not blanket project-level', () => {
    const md = fs.readFileSync(workflowPath, 'utf-8');
    assert.match(
      md,
      /WAVE_WORKTREE_PLANS/,
      'post-wave cleanup must track which plans actually used worktrees'
    );
  });
});

// ---- quick.md SUBMODULE_PATHS executor guard (CodeRabbit CRITICAL #3) ----
//
// Quick mode does NOT have a pre-declared files_modified list. The fail-loud
// guard must (a) be present in the markdown of the executor prompt, and
// (b) actually abort when run against a fixture that stages a submodule path.

describe('quick.md executor pre-commit submodule guard (#2772)', () => {
  const quickPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

  test('quick.md executor prompt injects SUBMODULE_PATHS', () => {
    const md = fs.readFileSync(quickPath, 'utf-8');
    assert.match(
      md,
      /SUBMODULE_PATHS for this project: \$\{SUBMODULE_PATHS\}/,
      'executor prompt must inline SUBMODULE_PATHS so the agent can run the guard'
    );
  });

  test('quick.md executor prompt contains a fail-loud pre-commit guard with ABORT message', () => {
    const md = fs.readFileSync(quickPath, 'utf-8');
    assert.match(md, /<submodule_commit_guard>/, 'guard block must exist');
    assert.match(
      md,
      /git diff --cached --name-only/,
      'guard must inspect staged paths before commit'
    );
    assert.match(
      md,
      /ABORT: staged path/,
      'guard must surface a fail-loud ABORT message on intersection'
    );
    assert.match(
      md,
      /workflow\.use_worktrees=false/,
      'guard must tell the user how to recover (re-run without worktrees)'
    );
  });

  // Behavioral: extract the guard logic and run it against a fixture repo.
  // We simulate the executor's commit-time guard and assert it aborts when a
  // staged path falls inside a SUBMODULE_PATHS entry, and passes otherwise.
  const QUICK_GUARD_SNIPPET = [
    'set +e',
    'STAGED=$(git diff --cached --name-only)',
    'if [ -n "$SUBMODULE_PATHS" ]; then',
    '  for sm_raw in $SUBMODULE_PATHS; do',
    '    sm="${sm_raw#./}"',
    '    sm="${sm%/}"',
    '    [ -z "$sm" ] && continue',
    '    for f_raw in $STAGED; do',
    '      f="${f_raw#./}"',
    '      f="${f%/}"',
    '      case "$f" in',
    '        "$sm"|"$sm"/*)',
    '          echo "ABORT: staged path $f_raw falls inside submodule $sm — re-run with workflow.use_worktrees=false" >&2',
    '          exit 1 ;;',
    '      esac',
    '    done',
    '  done',
    'fi',
    'echo "OK"',
  ].join('\n');

  test('guard ABORTs when a staged path falls inside a submodule', () => {
    const repo = createTempGitProject('gsd-test-2772-quick-abort-');
    try {
      // Create a file inside the submodule path and stage it.
      fs.mkdirSync(path.join(repo, 'vendor', 'foo'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'vendor', 'foo', 'bar.ts'), 'export {};\n');
      execFileSync('git', ['add', 'vendor/foo/bar.ts'], { cwd: repo });

      let err;
      try {
        execFileSync('bash', ['-c', QUICK_GUARD_SNIPPET], {
          cwd: repo,
          encoding: 'utf-8',
          env: { ...process.env, SUBMODULE_PATHS: 'vendor/foo' },
        });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'guard must exit non-zero when staged path is inside submodule');
      assert.equal(err.status, 1, 'guard must exit with status 1');
      const stderr = err.stderr ? err.stderr.toString() : '';
      assert.match(stderr, /ABORT: staged path vendor\/foo\/bar\.ts/);
      assert.match(stderr, /vendor\/foo/);
    } finally {
      cleanup(repo);
    }
  });

  test('guard passes when no staged path falls inside a submodule', () => {
    const repo = createTempGitProject('gsd-test-2772-quick-pass-');
    try {
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
      execFileSync('git', ['add', 'src/index.ts'], { cwd: repo });

      const out = execFileSync('bash', ['-c', QUICK_GUARD_SNIPPET], {
        cwd: repo,
        encoding: 'utf-8',
        env: { ...process.env, SUBMODULE_PATHS: 'vendor/foo' },
      });
      assert.match(out, /OK/);
    } finally {
      cleanup(repo);
    }
  });

  test('guard normalizes leading "./" on staged paths and still ABORTs', () => {
    const repo = createTempGitProject('gsd-test-2772-quick-norm-');
    try {
      fs.mkdirSync(path.join(repo, 'vendor', 'foo'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'vendor', 'foo', 'bar.ts'), 'export {};\n');
      execFileSync('git', ['add', 'vendor/foo/bar.ts'], { cwd: repo });

      let err;
      try {
        // Submodule path declared with ./ prefix — must still match.
        execFileSync('bash', ['-c', QUICK_GUARD_SNIPPET], {
          cwd: repo,
          encoding: 'utf-8',
          env: { ...process.env, SUBMODULE_PATHS: './vendor/foo' },
        });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'guard must abort even when SUBMODULE_PATHS uses ./ prefix');
      assert.equal(err.status, 1);
    } finally {
      cleanup(repo);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3542-executor-git-stash-prohibition.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3542-executor-git-stash-prohibition (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #3542)
// Bug #3542 — Worktree stash storage is shared across agent worktrees;
// `git stash pop` from an executor agent contaminates its isolation.
//
// Git stores stashes at `refs/stash` (plus the stash reflog) inside the
// PARENT `.git/` directory. Every linked worktree shares that ref, so a
// `git stash push` in any worktree (or in the main checkout) is visible —
// and poppable — from every other worktree. From inside a worktree,
// `git stash list` shows the shared list with no indication that an entry
// originated elsewhere.
//
// Incident: an executor agent ran `git stash` (printed "No local changes
// to save" — nothing pushed), then `git stash pop`, which yanked a stash
// from a prior worktree-agent session. Result: 21 files in UU/UD state,
// 16 phantom untracked files, ~12 minutes of recovery work. This breaks
// the `isolation="worktree"` invariant documented in the executor agent.
//
// Two test cases:
//
//   A. The agent prompt content asserts the `git stash` family is
//      prohibited and documents an alternative. The prompt content IS
//      the runtime contract for the agent — source-text-is-the-product
//      (per CONTEXT.md `RULESET.TESTS.no-source-grep.exemption`).
//
//   B. A behavioural test that pins the git invariant the prohibition
//      defends against: a stash pushed in the main checkout is visible in
//      a linked worktree's `git stash list`, proving stash storage is
//      shared and cannot be relied on for worktree-scoped isolation.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const EXECUTOR_PATH = path.join(__dirname, '..', 'agents', 'gsd-executor.md');

// ─── Test A — prompt content asserts the prohibition ───────────────────────

test('bug-3542: gsd-executor.md prohibits `git stash` family inside worktrees', () => {
  const content = fs.readFileSync(EXECUTOR_PATH, 'utf-8');

  // The prohibition must call out `git stash` explicitly. Just listing
  // "stash" isn't enough — the existing post-wave-hook helper script
  // legitimately mentions stash, so we look for the specific forbidden
  // commands the agent must never run on its own.
  assert.match(
    content,
    /`git stash`/,
    'gsd-executor.md must explicitly forbid `git stash` (bare push) — see #3542',
  );
  assert.match(
    content,
    /`git stash pop`/,
    'gsd-executor.md must explicitly forbid `git stash pop` — the load-bearing footgun (#3542)',
  );
  assert.match(
    content,
    /`git stash apply`/,
    'gsd-executor.md must explicitly forbid `git stash apply` — same shared-stack hazard as pop (#3542)',
  );
  assert.match(
    content,
    /`git stash drop`/,
    'gsd-executor.md must explicitly forbid `git stash drop` — mutates the shared stack (#3542)',
  );

  // The prohibition must explain WHY (shared storage across worktrees) so
  // the agent understands the failure mode rather than treating it as an
  // arbitrary rule.
  assert.match(
    content,
    /shared|share[d]?\s+(across|between)/i,
    'gsd-executor.md must document that stash storage is shared across worktrees (#3542)',
  );

  // The prohibition must document at least one alternative the agent CAN
  // use to inspect or move work between refs without touching `refs/stash`.
  // The triage brief proposes commit-to-throwaway-branch OR read-only
  // `git show <ref>:<path>` / `git diff <ref> -- <path>`.
  const hasThrowawayBranch = /throwaway[- ]branch|temp(?:orary)?[- ]?branch|scratch[- ]branch/i.test(
    content,
  );
  const hasGitShow = /`git show /i.test(content);
  const hasGitDiffRef = /`git diff [^`]*\$?\{?ref\}?|`git diff [A-Z]+:/i.test(content);
  assert.ok(
    hasThrowawayBranch || hasGitShow || hasGitDiffRef,
    'gsd-executor.md must document an alternative to `git stash` ' +
      '(commit-to-throwaway-branch, or read-only `git show <ref>:<path>` / ' +
      '`git diff <ref> -- <path>`) so the agent has a sanctioned escape path (#3542)',
  );

  // The issue number must appear so future readers can trace the rule to
  // its incident.
  assert.match(
    content,
    /#3542/,
    'gsd-executor.md must reference issue #3542 next to the stash prohibition for traceability',
  );
});

// ─── Test B — behavioural pin of the git invariant ─────────────────────────

test('bug-3542: stash pushed in main checkout is visible inside a linked worktree', () => {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bug-3542-stash-')));
  const mainRepo = path.join(tmpRoot, 'main');
  const linkedWorktree = path.join(tmpRoot, 'wt');

  try {
    // Set up a normal repo with one commit.
    fs.mkdirSync(mainRepo);
    const gitOpts = { cwd: mainRepo, stdio: 'pipe' };
    execSync('git init -q', gitOpts);
    execSync('git config user.email "test@test.com"', gitOpts);
    execSync('git config user.name "Test"', gitOpts);
    execSync('git config commit.gpgsign false', gitOpts);
    fs.writeFileSync(path.join(mainRepo, 'a.txt'), 'initial\n');
    execSync('git add a.txt', gitOpts);
    execSync('git commit -q -m initial', gitOpts);

    // Create a linked worktree on a separate branch — this is what the
    // executor agent runs inside.
    execSync(`git worktree add -q "${linkedWorktree}" -b wt-branch`, gitOpts);

    // Push a stash from the MAIN checkout (simulating a prior session).
    fs.writeFileSync(path.join(mainRepo, 'a.txt'), 'wip in main\n');
    execSync('git stash push -q -u -m "from-main-checkout"', gitOpts);

    // Sanity check: the stash exists in the main checkout's view.
    const mainList = execSync('git stash list', { cwd: mainRepo }).toString();
    assert.match(
      mainList,
      /from-main-checkout/,
      'pre-condition: main checkout must see its own stash entry',
    );

    // The load-bearing assertion: the linked worktree sees the same
    // stash entry, even though it was pushed from a different working
    // tree. This is the invariant that makes `git stash pop` inside an
    // executor agent's worktree an isolation violation.
    const worktreeList = execSync('git stash list', {
      cwd: linkedWorktree,
    }).toString();
    assert.match(
      worktreeList,
      /from-main-checkout/,
      'bug #3542 invariant: stash entries pushed from any worktree (or the ' +
        'main checkout) are visible in every linked worktree, because ' +
        '`refs/stash` lives in the shared parent .git directory. If this ' +
        'assertion ever stops holding (e.g. git introduces per-worktree ' +
        'stash storage in a future release), the executor agent prohibition ' +
        'in agents/gsd-executor.md can be relaxed.',
    );

    // Stronger pin: a `git stash pop` inside the worktree must actually
    // pop the stash pushed from main — proving cross-worktree mutation,
    // not just visibility. We pop into a clean working tree on a
    // different branch, so any applied content is the contamination.
    execSync('git stash pop -q', { cwd: linkedWorktree, stdio: 'pipe' });
    // On Windows autocrlf=true, git rewrites stashed content with CRLF on
    // checkout. Strip \r before content compare — the test pins git's
    // shared-stash behavior, not line endings.
    const popped = fs.readFileSync(path.join(linkedWorktree, 'a.txt'), 'utf-8').replace(/\r\n/g, '\n');
    assert.strictEqual(
      popped,
      'wip in main\n',
      'bug #3542 invariant: `git stash pop` inside a linked worktree applies ' +
        'a stash pushed in the main checkout — proving the shared-stack ' +
        'contamination the executor prohibition exists to prevent.',
    );
  } finally {
    cleanup(tmpRoot);
  }
});
  });
}
