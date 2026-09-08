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
const fs = require('node:fs');
const path = require('node:path');

const { makeFaultyGit } = require('./helpers/faulty-deps.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const MODULE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs'
);

const {
  shortSha,
  readBaseRefFromSettings,
  applyWorktreeBaseRef,
  resolveEffectiveBaseRef,
  resolveEffectiveBaseRefWithLayer,
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

  // #3659 rows share the diverged-HEAD stub shape — one builder keeps the
  // four fixtures from drifting apart.
  function makeDivergedExecGit(headSha, forkSha) {
    const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null });
    return makeExecGit({
      'rev-parse HEAD': ok(headSha),
      'rev-parse --verify --quiet origin/HEAD': ok(forkSha),
    });
  }

  test('effectiveBaseRef="head" + orchestrator mode → no degrade, reason baseref-head, execGit never called (#3659)', () => {
    let called = false;
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { called = true; return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null }; },
      effectiveBaseRef: 'head',
      isolationMode: 'orchestrator-worktree',
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(result.message, null);
    assert.strictEqual(result.headSha, null);
    assert.strictEqual(result.forkRef, null);
    assert.strictEqual(result.forkSha, null);
    assert.strictEqual(called, false, 'orchestrator mode: GSD controls the fork start-point, head is honored by construction');
  });

  test('effectiveBaseRef="head" + harness mode (default) + diverged HEAD → degrade, reason baseref-head-ignored-by-harness (#3659)', () => {
    // #48 verified 5/5 that the harness dispatch path never routes through
    // project-settings baseRef — with head set on a diverged branch the check
    // must compare and degrade, not trust the setting.
    const HEAD_SHA = '11111111223344aa11111111223344aa11111111';
    const FORK_SHA = '99999999223344bb99999999223344bb99999999';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeDivergedExecGit(HEAD_SHA, FORK_SHA),
      effectiveBaseRef: 'head',
    });
    assert.strictEqual(result.shouldDegrade, true,
      'head must not suppress the comparison in harness mode (#3659)');
    assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkRef, 'origin/HEAD');
    assert.strictEqual(result.forkSha, FORK_SHA);
  });

  test('effectiveBaseRef="head" + explicit harness-worktree mode + diverged → degrade (#3659)', () => {
    const HEAD_SHA = 'aaaa1111223344ccaaaa1111223344ccaaaa1111';
    const FORK_SHA = 'bbbb1111223344ddbbbb1111223344ddbbbb1111';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeDivergedExecGit(HEAD_SHA, FORK_SHA),
      effectiveBaseRef: 'head',
      isolationMode: 'harness-worktree',
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
  });

  test('effectiveBaseRef="head" + harness + HEAD == origin/HEAD → no degrade, reason head-matches-fork (#3659)', () => {
    const SAME_SHA = 'cccc1111223344eecccc1111223344eecccc1111';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: SAME_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: SAME_SHA, stderr: '', signal: null, error: null },
      }),
      effectiveBaseRef: 'head',
      isolationMode: 'harness-worktree',
    });
    assert.strictEqual(result.shouldDegrade, false,
      'when the harness fork base happens to equal HEAD there is no mismatch to degrade for');
    assert.strictEqual(result.reason, 'head-matches-fork');
  });

  test('harness head-diverge message cites the verified harness limitation (#3659)', () => {
    const HEAD_SHA = 'dddd1111223344ffdddd1111223344ffdddd1111';
    const FORK_SHA = 'eeee1111223344abeeceeee1111223344abeeceee';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeDivergedExecGit(HEAD_SHA, FORK_SHA),
      effectiveBaseRef: 'head',
    });
    assert.ok(result.message !== null, 'divergence under head must carry the explanatory message');
    assert.ok(result.message.includes('#48'), 'message must cite the verified harness limitation');
    assert.ok(result.message.includes('sequentially'), 'message must state the sequential fallback');
    // #4090: the limitation is scoped to project settings, and the message
    // must say so — an unqualified "does not honor it" sent operators to push
    // hundreds of commits to restore a parallelism a user/global head had not
    // lost.
    assert.ok(result.message.includes('project settings'), 'message must scope the limitation to project settings (#4090)');
    assert.ok(result.message.includes('user/global'), 'message must name the user/global layer as the remedy (#4090)');
  });

  // ─── #4090: the layer that supplied 'head' decides the harness-mode verdict ─

  test('effectiveBaseRef="head" + layer "user" + harness mode (default) + diverged HEAD → no degrade, reason baseref-head, execGit never called (#4090)', () => {
    // #48 verified the harness ignores PROJECT-settings baseRef; the user/global
    // layer is the one #1013/#1038 added because the harness reads it. A head
    // from that layer keeps the suppress in harness mode.
    let called = false;
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { called = true; return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null }; },
      effectiveBaseRef: 'head',
      effectiveBaseRefLayer: 'user',
    });
    assert.strictEqual(result.shouldDegrade, false,
      'a user/global-layer head must not be classified as harness-ignored (#4090)');
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(result.message, null);
    assert.strictEqual(called, false, 'honored head: nothing to compare');
  });

  test('effectiveBaseRef="head" + layer "user" + explicit harness-worktree mode → no degrade (#4090)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeDivergedExecGit('1234abcd1234abcd1234abcd1234abcd1234abcd', '5678efab5678efab5678efab5678efab5678efab'),
      effectiveBaseRef: 'head',
      effectiveBaseRefLayer: 'user',
      isolationMode: 'harness-worktree',
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
  });

  for (const layer of ['project-local', 'project-shared']) {
    test(`effectiveBaseRef="head" + layer "${layer}" + harness mode + diverged → degrade, reason baseref-head-ignored-by-harness — the #48-verified case, unchanged (#4090)`, () => {
      const HEAD_SHA = 'a1a1a1a1223344a1a1a1a1a1223344a1a1a1a1a1';
      const FORK_SHA = 'b2b2b2b2223344b2b2b2b2b2223344b2b2b2b2b2';
      const result = evaluateWorktreeBaseDegrade({
        execGit: makeDivergedExecGit(HEAD_SHA, FORK_SHA),
        effectiveBaseRef: 'head',
        effectiveBaseRefLayer: layer,
      });
      assert.strictEqual(result.shouldDegrade, true,
        `a ${layer} head must still fall through to the comparison in harness mode (#48/#3659)`);
      assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
      assert.strictEqual(result.headSha, HEAD_SHA);
      assert.strictEqual(result.forkSha, FORK_SHA);
    });
  }

  test('effectiveBaseRef="head" + layer null (provenance unknown) + harness mode + diverged → degrade: unknown provenance reads as project (#4090)', () => {
    // The conservative default: a caller that resolved the value without its
    // layer gets the pre-#4090 verdict, so no existing caller changes behavior.
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeDivergedExecGit('c3c3c3c3223344c3c3c3c3c3223344c3c3c3c3c3', 'd4d4d4d4223344d4d4d4d4d4223344d4d4d4d4d4'),
      effectiveBaseRef: 'head',
      effectiveBaseRefLayer: null,
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
  });

  test('effectiveBaseRef="fresh" + layer "user" + harness mode + diverged → degrade, reason head-diverged-from-fork: the layer is consulted only for "head" (#4090)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeDivergedExecGit('e5e5e5e5223344e5e5e5e5e5223344e5e5e5e5e5', 'f6f6f6f6223344f6f6f6f6f6223344f6f6f6f6f6'),
      effectiveBaseRef: 'fresh',
      effectiveBaseRefLayer: 'user',
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-diverged-from-fork');
  });

  test('effectiveBaseRef="head" + layer "project-local" + orchestrator mode → no degrade: orchestrator honors head from any layer (#3659, #4090)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { throw new Error('must not be called'); },
      effectiveBaseRef: 'head',
      effectiveBaseRefLayer: 'project-local',
      isolationMode: 'orchestrator-worktree',
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
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
    const result = evaluateWorktreeBaseDegrade({ effectiveBaseRef: 'head', isolationMode: 'orchestrator-worktree' });
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
    // Verify message contains the short SHAs and the corrected remediation
    // (#3659: the old text advised setting baseRef:"head" unconditionally;
    // #4090: the harness does not read it from PROJECT settings — the
    // user/global layer is the one it does read, so the parenthetical names
    // both places the setting applies).
    const expectedMsg = `⚠ Worktree base mismatch: HEAD (${HEAD_SHA.slice(0, 8)}) differs from origin/HEAD (${FORK_SHA.slice(0, 8)}). Running this phase sequentially on the main working tree. Parallel worktrees return once HEAD is merged/pushed so origin/HEAD matches it. (worktree.baseRef:"head" applies where GSD itself creates the worktree, or when set in the user/global settings layer — the runtime harness does not read it from project settings; #48, #3659, #4090.)`;
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
    const expectedMsg = `⚠ Cannot determine the worktree fork base (origin/HEAD unresolved). Running this phase sequentially on the main working tree to avoid a base mismatch. Parallel worktrees return once origin/HEAD resolves and matches HEAD. See #683, #3659.`;
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

  test('baseRef=head in settings + --mode orchestrator-worktree → shouldDegrade false, reason baseref-head; write emits valid JSON (#3659)', () => {
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
    const result = cmdWorktreeBaseCheck(cwd, ['--mode', 'orchestrator-worktree'], deps);
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
    const parsed = JSON.parse(written);
    assert.deepStrictEqual(parsed, result);
  });

  test('baseRef=head in settings + default (harness) mode + diverged HEAD → shouldDegrade true (#3659)', () => {
    const cwd = '/repo';
    const claudeDir = '/repo/.claude';
    const HEAD_SHA = 'fade1111223344cafade1111223344cafade1111';
    const FORK_SHA = 'bead1111223344dbbead1111223344dbbead1111';
    const deps = {
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: FORK_SHA, stderr: '', signal: null, error: null },
      }),
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, true,
      'settings head must not suppress the harness-mode comparison (#3659)');
    assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
  });

  test('--mode rejects invalid values — no silent default that would re-open the #3659 hole', () => {
    const cwd = '/repo';
    const deps = {
      readFile: () => null,
      execGit: makeExecGitCheck({}),
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    assert.throws(
      () => cmdWorktreeBaseCheck(cwd, ['--mode', 'bogus-mode'], deps),
      /--mode must be harness-worktree or orchestrator-worktree/
    );
    assert.throws(
      () => cmdWorktreeBaseCheck(cwd, ['--mode'], deps),
      /--mode must be harness-worktree or orchestrator-worktree/
    );
  });

  test('default emit goes through fs.writeSync(1, …) — the seam --pick intercepts (#3659)', (t) => {
    // The CLI's --pick capture patches fs.writeSync, not process.stdout.write;
    // under $(…) command substitution the stdout.write default made --pick
    // emit the full JSON, so the workflow auto-degrade guards never matched.
    const fds = [];
    const chunks = [];
    const original = fs.writeSync;
    fs.writeSync = (fd, buf, offset, length) => {
      const n = original.call(fs, fd, buf, offset, length);
      fds.push(fd);
      // Chunk is derived from the REAL return count `n`, not the requested
      // extent — a genuine short write must be reflected accurately (#4306).
      const start = offset ?? 0;
      chunks.push(typeof buf === 'string' ? buf.slice(start, start + n) : buf.toString('utf8', start, start + n));
      return n;
    };
    t.after(() => { fs.writeSync = original; });
    const result = cmdWorktreeBaseCheck('/repo', [], {
      readFile: () => null,
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', signal: null, error: null },
      }),
      userClaudeDir: '/nonexistent-hermetic-user-dir',
      // no deps.write — the default seam under test
    });
    assert.ok(fds.length > 0, 'default emit must call fs.writeSync');
    assert.ok(fds.every((fd) => fd === 1), 'every write must target fd 1 (stdout)');
    const emitted = chunks.join('');
    assert.ok(emitted.includes('"reason"'), 'emitted payload is the JSON result');
    assert.strictEqual(result.reason, 'no-head');
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

// ─── resolveEffectiveBaseRefWithLayer — layer provenance (#4090) ─────────────

describe('resolveEffectiveBaseRefWithLayer — layer provenance (#4090)', () => {
  function makeReadFile(files) {
    return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
  }

  const USER_CLAUDE_DIR = '/home/user/.claude';
  const claudeDir = '/repo/.claude';
  const HEAD = JSON.stringify({ worktree: { baseRef: 'head' } });
  const FRESH = JSON.stringify({ worktree: { baseRef: 'fresh' } });

  test('project local supplies the value → layer "project-local"', () => {
    const deps = { readFile: makeReadFile({
      [path.join(claudeDir, 'settings.local.json')]: FRESH,
      [path.join(claudeDir, 'settings.json')]: HEAD,
      [path.join(USER_CLAUDE_DIR, 'settings.json')]: HEAD,
    }) };
    assert.deepStrictEqual(resolveEffectiveBaseRefWithLayer(claudeDir, deps, USER_CLAUDE_DIR), { value: 'fresh', layer: 'project-local' });
  });

  test('project shared supplies the value (no local) → layer "project-shared"', () => {
    const deps = { readFile: makeReadFile({
      [path.join(claudeDir, 'settings.json')]: HEAD,
      [path.join(USER_CLAUDE_DIR, 'settings.json')]: FRESH,
    }) };
    assert.deepStrictEqual(resolveEffectiveBaseRefWithLayer(claudeDir, deps, USER_CLAUDE_DIR), { value: 'head', layer: 'project-shared' });
  });

  test('user/global supplies the value (both project files absent) → layer "user"', () => {
    const deps = { readFile: makeReadFile({
      [path.join(USER_CLAUDE_DIR, 'settings.json')]: HEAD,
    }) };
    assert.deepStrictEqual(resolveEffectiveBaseRefWithLayer(claudeDir, deps, USER_CLAUDE_DIR), { value: 'head', layer: 'user' });
  });

  test('no layer supplies a value → null', () => {
    assert.strictEqual(resolveEffectiveBaseRefWithLayer(claudeDir, { readFile: () => null }, USER_CLAUDE_DIR), null);
  });

  test('userClaudeDir === claudeDir → the shared file is the PROJECT layer, never "user"', () => {
    const sameDir = '/home/.claude';
    const deps = { readFile: makeReadFile({ [path.join(sameDir, 'settings.json')]: HEAD }) };
    assert.deepStrictEqual(resolveEffectiveBaseRefWithLayer(sameDir, deps, sameDir), { value: 'head', layer: 'project-shared' });
  });

  test('resolveEffectiveBaseRef is the value-only view of the same cascade', () => {
    const deps = { readFile: makeReadFile({ [path.join(USER_CLAUDE_DIR, 'settings.json')]: HEAD }) };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), 'head');
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, { readFile: () => null }, USER_CLAUDE_DIR), null);
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

  test('(e positive) user/global head + phase lane + orchestrator mode → shouldDegrade:false (KEY REGRESSION #1013)', () => {
    // This is the exact bug #1013 fixed: user set worktree.baseRef:"head" in their global
    // settings, but the setting was invisible and the phase lane triggered degrade. The
    // suppress now applies only where GSD manages the fork (--mode orchestrator-worktree),
    // which is also what keeps this cascade proof meaningful post-#3659.
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
    const result = cmdWorktreeBaseCheck(cwd, ['--mode', 'orchestrator-worktree'], deps);
    assert.strictEqual(result.shouldDegrade, false,
      'user/global worktree.baseRef:"head" must suppress degrade on a phase lane where GSD manages the fork');
    assert.strictEqual(result.reason, 'baseref-head');
  });

  test('user/global head + phase lane + default (harness) mode → shouldDegrade:false, reason baseref-head (#4090)', () => {
    // Until #4090 this row pinned the OPPOSITE verdict (shouldDegrade:true,
    // fork-ref-unknown) on the strength of #48 — but #48's finding is scoped
    // to PROJECT-settings baseRef, and the user/global layer is the one #1013
    // named as where the harness's own worktree creation reads the setting.
    // #3659 keyed the harness-mode gate on the bare value and discarded the
    // layer, which made #1038's Layer-3 fix inert for its own motivating
    // case: the KEY REGRESSION row above passed only because it pinned
    // --mode orchestrator-worktree. This is that case in the DEFAULT mode.
    let gitCalled = false;
    const deps = {
      execGit: (...a) => { gitCalled = true; return makePhaseLaneExecGit(HEAD_SHA)(...a); },
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return null;
        if (p === path.join(claudeDir, 'settings.json')) return null;
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
      'harness mode: a user/global-layer head is the layer the harness reads (#1013) and must keep the suppress (#4090)');
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(gitCalled, false, 'a honored head never reaches the git comparison');
  });

  test('user/global head + project-shared head + default (harness) mode → still degrades: project layer wins the cascade and is the #48-verified case (#4090)', () => {
    // Precedence guard: the fix keys on the layer that SUPPLIED the value, and
    // a project layer shadows the user/global one — so the mere presence of a
    // user/global head must not launder a project-layer head into a suppress.
    const deps = {
      execGit: makePhaseLaneExecGit(HEAD_SHA),
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return null;
        if (p === path.join(claudeDir, 'settings.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        if (p === path.join(USER_CLAUDE_DIR, 'settings.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
      write: () => {},
      userClaudeDir: USER_CLAUDE_DIR,
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, true,
      'a project-layer head in harness mode must still fall through to the comparison (#48/#3659)');
    assert.strictEqual(result.reason, 'fork-ref-unknown');
  });

  test('user/global "fresh" + default (harness) mode → still compares: the layer only matters for "head" (#4090)', () => {
    const deps = {
      execGit: makePhaseLaneExecGit(HEAD_SHA),
      readFile: (p) => {
        if (p === path.join(USER_CLAUDE_DIR, 'settings.json')) return JSON.stringify({ worktree: { baseRef: 'fresh' } });
        return null;
      },
      write: () => {},
      userClaudeDir: USER_CLAUDE_DIR,
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'fork-ref-unknown');
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

// ─── workflow dispatch-site coverage: worktree.base-check gates (folded from
// fix-1941-quick-worktree-stale-base.test.cjs and
// fix-2649-diagnose-issues-worktree-stale-base.test.cjs, #3335) ──────────────
//
// allow-test-rule: source-text-is-the-product #1941 #2649
// Workflow .md files are the installed AI instructions — their text IS what the
// runtime loads. Testing text content tests the deployed contract. Per
// CONTRIBUTING.md exception matrix.
//
// Root cause shared by #1941 and #2649: Claude Code's isolation="worktree"
// forks new worktrees from origin/HEAD, not the live local HEAD. When prior
// local commits advance local HEAD without an intervening `git push`,
// origin/HEAD stays pinned to a stale ancestor and the executor's
// worktree_branch_check guard halts with a base-mismatch fatal. The fix ports
// the worktree.base-check auto-degrade pattern (originally execute-phase
// #683/#1369) into each not-yet-covered dispatch site: quick.md's
// single-dispatch path (#1941), and diagnose-issues.md's spawn_agents step
// plus execute-plan.md's Pattern A single-plan dispatch (#2649, fixed
// together per that bug's acceptance criterion 5 — same bug class, same
// one-line gate).

{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:fix-1941-quick-worktree-stale-base', () => {

const QUICK_WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

describe('quick: pre-dispatch worktree base re-check (#1941)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(QUICK_WORKFLOW_PATH), 'workflows/quick.md should exist');
  });

  test('Step 6 runs worktree.base-check before capturing EXPECTED_BASE', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    const step6Idx = content.indexOf('**Step 6: Spawn executor**');
    const baseCheckIdx = content.indexOf('worktree.base-check', step6Idx);
    const expectedBaseIdx = content.indexOf('EXPECTED_BASE=$(git rev-parse HEAD)', step6Idx);
    assert.ok(step6Idx !== -1, '"Step 6: Spawn executor" must exist in quick.md');
    assert.ok(baseCheckIdx !== -1, 'worktree.base-check must be invoked within Step 6');
    assert.ok(expectedBaseIdx !== -1, 'EXPECTED_BASE capture must exist within Step 6');
    assert.ok(
      baseCheckIdx < expectedBaseIdx,
      'worktree.base-check must run BEFORE EXPECTED_BASE is captured so the degrade decision reflects the most current local HEAD'
    );
  });

  test('degrade check references #1941 for traceability', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    assert.ok(content.includes('#1941'), 'quick.md must reference #1941');
  });

  test('degrade check clears BOTH USE_WORKTREES and ISOLATION when shouldDegrade is true', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(baseCheckIdx, baseCheckIdx + 900);
    assert.ok(block.includes('shouldDegrade'), 'degrade check must branch on shouldDegrade');
    // Both must move together (#2652). Dispatch keys on ISOLATION while the prompt
    // guard and worktree manifest key on USE_WORKTREES; clearing only one dispatches
    // an isolated executor with no base guard and no manifest, then blocks in cleanup
    // looking for a manifest that was never initialized.
    assert.ok(block.includes('USE_WORKTREES=false'), 'degrade must set USE_WORKTREES=false');
    assert.ok(
      block.includes('ISOLATION=none'),
      'degrade must ALSO set ISOLATION=none — dispatch reads ISOLATION, so clearing only ' +
        'USE_WORKTREES still passes the harness isolation flag (#2652)'
    );
  });

  // #2652: this assertion previously required `RUNTIME = "claude"`, encoding the
  // pre-#2584 premise that worktree isolation is Claude-specific. #2584 replaced
  // that with the negotiated dispatch.isolation capability, so the guard now keys
  // on the capability — Cursor also declares harness-worktree.
  test('degrade check guards on the negotiated capability, not a runtime id', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(Math.max(0, baseCheckIdx - 300), baseCheckIdx + 200);
    assert.ok(
      block.includes('ISOLATION') && block.includes('harness-worktree'),
      'degrade check must guard on ISOLATION = harness-worktree'
    );
    assert.ok(
      !/\[\s*"\$RUNTIME"\s*=/.test(block),
      'degrade check must NOT branch on a RUNTIME literal (#2584/#2652)'
    );
  });

  test('degrade check names origin/HEAD as the stale fork base', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    const step6Idx = content.indexOf('**Step 6: Spawn executor**');
    const nextSection = content.indexOf('\n---', step6Idx);
    const section = content.slice(step6Idx, nextSection === -1 ? undefined : nextSection);
    assert.ok(section.includes('origin/HEAD'), 'Step 6 must name origin/HEAD as the stale fork base');
  });
});

  });
}

{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:fix-2649-diagnose-issues-worktree-stale-base', () => {

const DIAGNOSE_ISSUES_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'diagnose-issues.md');
const EXECUTE_PLAN_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');

describe('diagnose-issues: pre-dispatch worktree base-check (#2649)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(DIAGNOSE_ISSUES_PATH), 'workflows/diagnose-issues.md should exist');
  });

  test('spawn_agents step runs worktree.base-check before the Agent() dispatch', () => {
    const content = fs.readFileSync(DIAGNOSE_ISSUES_PATH, 'utf-8');
    const spawnIdx = content.indexOf('<step name="spawn_agents">');
    assert.ok(spawnIdx !== -1, '"spawn_agents" step must exist in diagnose-issues.md');
    const baseCheckIdx = content.indexOf('worktree.base-check', spawnIdx);
    assert.ok(baseCheckIdx !== -1, 'worktree.base-check must be invoked within the spawn_agents step');
    // The load-bearing invariant is "base-check BEFORE the Agent() dispatch" so the
    // degrade decision can drop isolation from the spawn. (Where EXPECTED_BASE is
    // captured relative to the check is cosmetic — the check only reads HEAD, never
    // mutates it — so assert the real invariant, not a loose disjunction.)
    const agentIdx = content.indexOf('Agent(', spawnIdx);
    assert.ok(agentIdx !== -1, 'spawn_agents must contain an Agent() dispatch');
    assert.ok(
      baseCheckIdx < agentIdx,
      'worktree.base-check must run before the Agent() dispatch so the degrade decision can drop isolation from the spawn',
    );
  });

  test('verify-only worktree_branch_check backstop remains embedded in the Agent() prompt', () => {
    // Acceptance criterion #4: the base-check is a PRE-DISPATCH degrade; the
    // <worktree_branch_check> guard is a POST-FORK fail-closed backstop. Both
    // layers must survive — a future edit that dropped the backstop embedding
    // would re-open the silent-stale-base class. Guard its continued presence.
    const content = fs.readFileSync(DIAGNOSE_ISSUES_PATH, 'utf-8');
    const spawnIdx = content.indexOf('<step name="spawn_agents">');
    assert.ok(spawnIdx !== -1, '"spawn_agents" step must exist');
    assert.ok(
      content.indexOf('worktree-branch-check.md', spawnIdx) !== -1,
      'spawn_agents must still materialize the <worktree_branch_check> backstop after the base-check gate (#2649 acceptance criterion 4)',
    );
  });

  test('degrade check sets USE_WORKTREES=false when shouldDegrade is true', () => {
    const content = fs.readFileSync(DIAGNOSE_ISSUES_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(baseCheckIdx, baseCheckIdx + 600);
    assert.ok(
      block.includes('shouldDegrade') && block.includes('USE_WORKTREES=false'),
      'degrade check must override USE_WORKTREES=false when shouldDegrade is true',
    );
  });

  test('degrade check references #2649 for traceability', () => {
    const content = fs.readFileSync(DIAGNOSE_ISSUES_PATH, 'utf-8');
    assert.ok(content.includes('#2649'), 'diagnose-issues.md must reference #2649');
  });
});

describe('execute-plan Pattern A: pre-dispatch worktree base-check (#2649)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(EXECUTE_PLAN_PATH), 'workflows/execute-plan.md should exist');
  });

  test('Pattern A runs the worktree base-check before spawning the executor', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    const patternAIdx = content.indexOf('**Pattern A:**');
    assert.ok(patternAIdx !== -1, '"Pattern A:" must exist in execute-plan.md');
    // The base-check instruction must appear within the Pattern A description,
    // before the isolation="worktree" embedding instruction.
    const patternAEnd = content.indexOf('**Pattern B:**', patternAIdx);
    const patternA = content.slice(patternAIdx, patternAEnd === -1 ? undefined : patternAEnd);
    assert.ok(
      patternA.includes('#2649') && /worktree\.base-check|base-check/.test(patternA),
      'Pattern A must run the #2649 worktree base-check before dispatching the executor',
    );
    assert.ok(
      patternA.includes('shouldDegrade'),
      'Pattern A base-check must consult shouldDegrade',
    );
  });

  test('Pattern A documents the auto-degrade (drop isolation on shouldDegrade)', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    const patternAIdx = content.indexOf('**Pattern A:**');
    const patternAEnd = content.indexOf('**Pattern B:**', patternAIdx);
    const patternA = content.slice(patternAIdx, patternAEnd === -1 ? undefined : patternAEnd);
    assert.ok(
      /degrad|sequential/i.test(patternA),
      'Pattern A must document auto-degrading to sequential mode when shouldDegrade is true',
    );
  });
});

  });
}

// ─── #4090: the docs reason table must name BOTH baseref-head paths ─────────
//
// Round-1 review finding on PR #4233: the `baseref-head` row of the
// `reason`-value reference table in docs/CLI-TOOLS.md described only the
// `--mode orchestrator-worktree` path, while evaluateWorktreeBaseDegrade also
// suppresses on a user/global-layer `"head"` in the default harness-worktree
// mode. The prose above the table and the sibling
// `baseref-head-ignored-by-harness` row were both re-scoped for #4090; this
// row was missed, so a reader consulting only the table — its purpose — would
// conclude `baseref-head` cannot occur outside orchestrator mode.
//
// Asserts the two DISJUNCTS the mechanism actually has, by token rather than
// by wording, so the guard survives a rewrite of the row but not a dropped
// path.
describe('docs/CLI-TOOLS.md reason table — baseref-head names both suppress paths (#4090)', () => {
  const CLI_TOOLS_DOC = path.join(__dirname, '..', 'docs', 'CLI-TOOLS.md');

  function reasonRow(reason) {
    const doc = fs.readFileSync(CLI_TOOLS_DOC, 'utf8');
    const rows = splitLines(doc).filter((line) => line.startsWith(`| \`${reason}\` |`));
    assert.strictEqual(rows.length, 1, `expected exactly one \`${reason}\` row in the reason table`);
    return rows[0];
  }

  test('the baseref-head row names the orchestrator-worktree path (#3659)', () => {
    assert.match(reasonRow('baseref-head'), /orchestrator-worktree/);
  });

  test('the baseref-head row names the user/global layer honored in harness mode (#4090)', () => {
    const row = reasonRow('baseref-head');
    assert.match(row, /user\/global/, 'the row must state that a user/global-layer "head" also yields baseref-head');
    assert.match(row, /harness-worktree/, 'the row must state that this path applies in harness-worktree (default) mode');
  });
});
