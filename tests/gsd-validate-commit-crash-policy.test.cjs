'use strict';

/**
 * gsd-validate-commit-crash-policy.test.cjs — regression coverage for #3838
 * (subsumed-but-still-present under #3911): hooks/gsd-validate-commit.sh has
 * three "swallow-and-pass" sites — the opt-in config read, the JSON command
 * extraction, and the isGitSubcommand classifier — each of which used a
 * failing subprocess call directly as an `if`/`$(...)` condition. `set -e`
 * never fires on a command used as an `if` condition, so a failure there was
 * indistinguishable from "genuinely not applicable" and silently disabled
 * the whole validator: a non-conforming commit exited 0 with no output,
 * identical to "your commit is fine".
 *
 * This is a sibling file to tests/hooks-crash-policy.test.cjs rather than an
 * addition to its table: that file's TABLE and drift guard are scoped
 * exclusively to hooks/*.js (the hook-exit.js allow/deny/crash migration,
 * #3911 phase 7); gsd-validate-commit.sh is a bash script with its own
 * ad hoc exit-code contract that predates and is orthogonal to that
 * migration, so it does not belong in that table or its drift guard.
 *
 * Every case here spawns the real hook via bash (tests/helpers/process-seam.cjs
 * `runHook` with `interpreter: 'bash'`) against a real fixture project —
 * no source-file grep, no mocked node internals.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-validate-commit.sh');

const CONFORMING_COMMIT_PAYLOAD = JSON.stringify({
  tool_input: { command: 'git commit -m "feat: add thing"' },
});
const NONCONFORMING_COMMIT_PAYLOAD = JSON.stringify({
  tool_input: { command: 'git commit -m "wibble wobble"' },
});

const cleanupPaths = [];
function tempDir(prefix) {
  const dir = createTempDir(prefix);
  cleanupPaths.push(dir);
  return dir;
}

let enabledProject;
// A PATH directory whose `node` shim fails ONLY the classifier's `node -e`
// invocation (detected by the presence of `isGitSubcommand` in argv, which
// only that one of the hook's three node calls ever passes), and otherwise
// execs the real node binary the test runner itself is running under. This
// reproduces the exact defect-triggering shape from #3838's repro ("node
// cannot run [for this call]") without touching the other two call sites.
let classifierBrokenPathDir;

before(() => {
  enabledProject = tempDir('gsd-validate-commit-ok-');
  fs.mkdirSync(path.join(enabledProject, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(enabledProject, '.planning', 'config.json'),
    JSON.stringify({ hooks: { community: true } }),
  );

  classifierBrokenPathDir = tempDir('gsd-validate-commit-node-shim-');
  const shimPath = path.join(classifierBrokenPathDir, 'node');
  fs.writeFileSync(
    shimPath,
    [
      '#!/usr/bin/env bash',
      `REAL_NODE=${JSON.stringify(process.execPath)}`,
      'for a in "$@"; do',
      '  if [[ "$a" == *isGitSubcommand* ]]; then',
      '    echo "test-shim: classifier node call intentionally broken (simulated node crash)" >&2',
      '    exit 127',
      '  fi',
      'done',
      'exec "$REAL_NODE" "$@"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(shimPath, 0o755);
});

after(() => {
  for (const p of cleanupPaths) cleanup(p);
});

function runValidateCommit({ payload, cwd, env } = {}) {
  return runHook(HOOK_PATH, [], {
    interpreter: 'bash',
    cwd,
    env: { ...process.env, ...TEST_ENV_BASE, ...env },
    input: payload,
    timeoutMs: 15000,
  });
}

// ---------------------------------------------------------------------------
// Controls — pin that the fix does not weaken or break the working paths.
// ---------------------------------------------------------------------------

describe('gsd-validate-commit.sh: controls (unchanged behavior)', () => {
  test('CONTROL A: node available, conforming commit -> exit 0, no block payload', () => {
    const r = runValidateCommit({ payload: CONFORMING_COMMIT_PAYLOAD, cwd: enabledProject });
    assert.equal(r.outcome, OUTCOME.EXITED, `stderr=${r.stderr}`);
    assert.equal(r.exitCode, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), '');
  });

  test('CONTROL B: node available, non-conforming commit -> exit 2 with block payload', () => {
    const r = runValidateCommit({ payload: NONCONFORMING_COMMIT_PAYLOAD, cwd: enabledProject });
    assert.equal(r.outcome, OUTCOME.EXITED, `stderr=${r.stderr}`);
    assert.equal(r.exitCode, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.code, 'CONVENTIONAL_COMMITS_VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// Defect arms — each of the three swallow-and-pass sites, exercised with a
// non-conforming commit so a silent pass is unambiguous: the validator MUST
// NOT report success by omission when it could not actually run.
// ---------------------------------------------------------------------------

describe('gsd-validate-commit.sh: #3838 could-not-run sites are surfaced, not swallowed', () => {
  test('DEFECT (classifier): node cannot run isGitSubcommand -> not a silent pass', () => {
    const r = runValidateCommit({
      payload: NONCONFORMING_COMMIT_PAYLOAD,
      cwd: enabledProject,
      env: { PATH: `${classifierBrokenPathDir}:${process.env.PATH}` },
    });
    assert.equal(r.outcome, OUTCOME.EXITED, `stderr=${r.stderr}`);
    // The hook must still exit 0 (PreToolUse "fail open"), but it must not
    // be the pre-#3838-fix silent exit 0 with empty stdout AND empty stderr
    // — that shape is indistinguishable from "your commit is fine".
    assert.equal(r.exitCode, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.notEqual(r.stderr.trim(), '', 'expected a non-empty stderr diagnostic; got silence (the #3838 defect shape)');
    assert.match(r.stderr, /classif/i, 'diagnostic should name the classifier check');
    assert.equal(r.stdout.trim(), '', 'no block payload is expected when validation could not run');
  });

  test('DEFECT (config read): malformed .planning/config.json -> not a silent pass', () => {
    const brokenConfigProject = tempDir('gsd-validate-commit-badconfig-');
    fs.mkdirSync(path.join(brokenConfigProject, '.planning'), { recursive: true });
    // Syntactically invalid JSON -> require() throws a SyntaxError distinct
    // from "file legitimately says community:false/absent".
    fs.writeFileSync(path.join(brokenConfigProject, '.planning', 'config.json'), '{ this is not json');

    const r = runValidateCommit({ payload: NONCONFORMING_COMMIT_PAYLOAD, cwd: brokenConfigProject });
    assert.equal(r.outcome, OUTCOME.EXITED, `stderr=${r.stderr}`);
    assert.equal(r.exitCode, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.notEqual(r.stderr.trim(), '', 'expected a non-empty stderr diagnostic; got silence');
    assert.match(r.stderr, /config/i, 'diagnostic should name the config-read check');
  });

  test('DEFECT (command extraction): malformed JSON on stdin -> not a silent pass', () => {
    // Malformed top-level JSON on stdin makes JSON.parse(d) throw inside the
    // command-extraction node call — distinct from "tool_input.command is
    // genuinely absent from a well-formed payload" (which legitimately
    // yields CMD='' and is not a git commit).
    const r = runValidateCommit({ payload: '{not valid json at all', cwd: enabledProject });
    assert.equal(r.outcome, OUTCOME.EXITED, `stderr=${r.stderr}`);
    assert.equal(r.exitCode, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.notEqual(r.stderr.trim(), '', 'expected a non-empty stderr diagnostic; got silence');
    assert.match(r.stderr, /command/i, 'diagnostic should name the command-extraction check');
  });
});
