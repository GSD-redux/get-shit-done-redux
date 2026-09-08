'use strict';

/**
 * Refactor-trigger integration + e2e tests (issue #1953).
 *
 * Covers test matrix rows 54b and 55-92 — the git adapter, the CLI contract
 * (`gsd-tools refactor <subcommand>`), disposition + ledger interplay, strict
 * mode's broken-windows integration, and the loop/registry wiring. Rows 1-54
 * (analyzer, evaluator, baseline persistence) live in
 * tests/complexity-trigger.test.cjs — out of scope here.
 *
 * Spec sources (authoritative):
 *   - .gsd/phase/feat-1953-complexity-triggered-refactor/42-router-contract.md
 *   - .gsd/phase/feat-1953-complexity-triggered-refactor/50-test-matrix.md
 *   - .gsd/phase/feat-1953-complexity-triggered-refactor/40-design.md
 *
 * Automation split (per 50-test-matrix.md Step 1): rows 55-56/61-62/74-90 use
 * the router's `_git`/`_windows`/`_core` injection seams in-process (no real
 * git/broken-windows I/O, no temp-dir races); rows 57-60/63-73 exercise the
 * real `gsd-tools` CLI subprocess via tests/helpers/process-seam.cjs, because
 * they are the actual CLI-contract/subprocess-degrade surface.
 *
 * Hermetic: every fixture dir via createTempGitProject/createTempDir +
 * t.after(cleanup); every fs/require mock via mock.method(...), restored via
 * t.after(...mock.restore()). No shared module-level fixture state (row 91).
 * Every gsd-tools subprocess invocation clears GSD_WORKSTREAM/GSD_PROJECT/
 * GSD_SESSION_KEY so a developer's shell cannot redirect the fixture (row 92).
 */

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');

const {
  VERDICT,
  REASON,
  PROPOSAL_SUFFIX,
  DEFAULTS,
  analyzeSource,
} = require('../gsd-core/bin/lib/complexity-trigger.cjs');
const gitBaseBranch = require('../gsd-core/bin/lib/git-base-branch.cjs');
const windowsModule = require('../gsd-core/bin/lib/broken-windows.cjs');
const { routeRefactorTriggerCommand } = require('../gsd-core/bin/lib/refactor-trigger-command-router.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { validateCapability, VALID_LOOP_POINTS } = require('../gsd-core/bin/lib/capability-validator.cjs');
const { resolveLoopHooks } = require('../gsd-core/bin/lib/loop-resolver.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
const refactorTriggerCapability = require('../capabilities/refactor-trigger/capability.json');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const ROUTER_MODULE_PATH = require.resolve('../gsd-core/bin/lib/refactor-trigger-command-router.cjs');

// A `gsd-tools refactor` subprocess in this suite does module require plus one
// or two bounded (<=15s) git calls against a tiny mkdtemp repo — well over any
// observed duration for that class of call (mirrors the reasoning in
// tests/helpers/timeouts.cjs's own per-class constants; this call class is not
// one of the four shared there, so it keeps its own local constant per that
// module's documented convention).
const CLI_TIMEOUT_MS = 30000;

const FLAT_JS = ['function f() {', '  return 1;', '}', ''].join('\n');
const TRIGGERING_JS = [
  'function f(x) {',
  '  if (x) {',
  '    return 1;',
  '  }',
  '  return 2;',
  '}',
  '',
].join('\n');

function noThrowError(label) {
  return (message, reason) => {
    throw new Error(`${label}: unexpected error() call — message=${message} reason=${reason}`);
  };
}

function writeConfig(dir, cfg) {
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(cfg), 'utf8');
}

/** Creates `.planning/phases/01-feat/01-PLAN.md` and commits it — this commit
 * becomes the phase-start anchor per the router contract's "Touched-file
 * anchor" rule (the commit that ADDED the phase's PLAN.md). */
function seedPhaseAndAnchor(dir) {
  const phaseDir = path.join(dir, '.planning', 'phases', '01-feat');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), ['# Plan', ''].join('\n'), 'utf8');
  gitOrThrow(['add', '-A'], { cwd: dir });
  gitOrThrow(['commit', '-m', 'plan'], { cwd: dir });
  return phaseDir;
}

function commitFile(dir, relPath, content, message) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  gitOrThrow(['add', '-A'], { cwd: dir });
  gitOrThrow(['commit', '-m', message], { cwd: dir });
}

function runCliOnce(args, cwd, envOverrides = {}) {
  return runNode([GSD_TOOLS, ...args], {
    cwd,
    timeoutMs: CLI_TIMEOUT_MS,
    env: {
      ...process.env,
      // Row 92: clear ambient GSD_* env so a developer's shell cannot
      // redirect the fixture.
      GSD_WORKSTREAM: '',
      GSD_PROJECT: '',
      GSD_SESSION_KEY: '',
      ...envOverrides,
    },
  });
}

function assertExited(result, label) {
  assert.strictEqual(result.outcome, OUTCOME.EXITED, `${label}: expected EXITED, got outcome=${result.outcome} stderr=${result.stderr}`);
}

function parseStdout(result) {
  return JSON.parse(result.stdout.trim());
}

function parseStderr(result) {
  return JSON.parse(result.stderr.trim());
}

/** Sets up a triggering fixture: strict per `strict`, threshold=1 (any single
 * decision point triggers), jumpDelta=100 (never independently triggers). */
function setupTriggeringProject(prefix, strict) {
  const dir = createTempGitProject(prefix);
  writeConfig(dir, {
    refactor: {
      trigger_enabled: true,
      trigger_strict: strict,
      complexity_threshold: 1,
      complexity_jump_delta: 100,
    },
  });
  seedPhaseAndAnchor(dir);
  commitFile(dir, 'hot.js', TRIGGERING_JS, 'hot file');
  return dir;
}

// ─── Row 54b — router orchestration continues past an unreadable file ───────

describe('refactor-trigger router: continues analyzing after one unreadable touched file (row 54b)', () => {
  test('continuesAnalyzingAfterUnreadableFile', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-54b-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { refactor: { trigger_enabled: true, complexity_threshold: 1, complexity_jump_delta: 100 } });
    seedPhaseAndAnchor(dir);
    const goodAbs = path.join(dir, 'good.js');
    const badAbs = path.join(dir, 'bad.js');
    fs.writeFileSync(goodAbs, TRIGGERING_JS, 'utf8');
    fs.writeFileSync(badAbs, FLAT_JS, 'utf8');
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'good and bad'], { cwd: dir });

    const origReadFileSync = fs.readFileSync;
    const readMock = mock.method(fs, 'readFileSync', (target, ...rest) => {
      if (target === badAbs) {
        const err = new Error('simulated denied read');
        err.code = 'EACCES';
        throw err;
      }
      return origReadFileSync.call(fs, target, ...rest);
    });
    t.after(() => readMock.mock.restore());

    const outputs = [];
    routeRefactorTriggerCommand({
      args: ['refactor', 'evaluate', '--phase', '1', '--raw'],
      cwd: dir,
      raw: true,
      error: noThrowError('row54b'),
      _core: { output: (v) => outputs.push(v) },
    });

    assert.strictEqual(outputs.length, 1);
    const result = outputs[0];
    assert.strictEqual(result.verdict, VERDICT.TRIGGERED);
    assert.strictEqual(result.target.file, 'good.js');
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].file, 'bad.js');
    assert.strictEqual(result.skipped[0].reason, REASON.REFACTOR_FILE_UNREADABLE);
  });
});

// ─── Rows 55-62 — touched-file discovery (git adapter) ──────────────────────

describe('refactor-trigger: touched-file discovery (git adapter)', () => {
  test('returnsTouchedPathsFromDiff', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-55-');
    t.after(() => cleanup(dir));
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    commitFile(dir, 'a.js', FLAT_JS, 'add a');
    commitFile(dir, 'sub/b.js', FLAT_JS, 'add b');
    commitFile(dir, 'c.cjs', FLAT_JS, 'add c');

    const touched = gitBaseBranch.changedFilesSince(dir, before);
    assert.ok(Array.isArray(touched));
    assert.deepEqual([...touched].sort(), ['a.js', 'c.cjs', 'sub/b.js'].sort());
  });

  test('handlesEmptyTouchedSet', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-56-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { refactor: { trigger_enabled: true } });
    seedPhaseAndAnchor(dir);

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assertExited(result, 'row56');
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.verdict, VERDICT.BELOW_THRESHOLD);
    assert.strictEqual(parsed.reason, REASON.REFACTOR_NO_TOUCHED_FILES);
    assert.strictEqual(fs.existsSync(path.join(dir, '.planning', 'phases', '01-feat', `01${PROPOSAL_SUFFIX}`)), false);
  });

  test('degradesWhenNotAGitRepository', (t) => {
    const dir = createTempDir('gsd-refactor-cli-57-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { refactor: { trigger_enabled: true } });
    const phaseDir = path.join(dir, '.planning', 'phases', '01-feat');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), ['# Plan', ''].join('\n'), 'utf8');

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assertExited(result, 'row57');
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.verdict, VERDICT.SKIPPED);
    assert.strictEqual(parsed.reason, REASON.REFACTOR_GIT_UNAVAILABLE);
    assert.strictEqual(fs.existsSync(path.join(phaseDir, `01${PROPOSAL_SUFFIX}`)), false);
  });

  test('degradesWhenGitBinaryMissing', () => {
    const enoentExecGit = () => ({
      exitCode: 127,
      stdout: '',
      stderr: 'git: not found',
      signal: null,
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
      timedOut: false,
    });
    assert.strictEqual(gitBaseBranch.changedFilesSince('/does-not-matter', 'HEAD~1', enoentExecGit), null);
    assert.strictEqual(gitBaseBranch.phaseStartCommit('/does-not-matter', '.planning/phases/01-feat', enoentExecGit), null);
  });

  test('degradesWhenGitTimesOut', () => {
    const timeoutExecGit = () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      signal: null,
      error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      timedOut: true,
    });
    assert.strictEqual(gitBaseBranch.changedFilesSince('/does-not-matter', 'HEAD~1', timeoutExecGit), null);
    assert.strictEqual(gitBaseBranch.phaseStartCommit('/does-not-matter', '.planning/phases/01-feat', timeoutExecGit), null);
  });

  test('roundTripsHostilePathsViaNulSeparatedDiff', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-60-');
    t.after(() => cleanup(dir));
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    const spaceName = 'a file with spaces.js';
    const unicodeName = 'café-日本.js';
    const dashLeadingName = '--leading-dash.js';
    commitFile(dir, spaceName, FLAT_JS, 'space name');
    commitFile(dir, unicodeName, FLAT_JS, 'unicode name');
    commitFile(dir, dashLeadingName, FLAT_JS, 'dash-leading name');

    const touched = gitBaseBranch.changedFilesSince(dir, before);
    assert.ok(Array.isArray(touched));
    assert.deepEqual([...touched].sort(), [spaceName, unicodeName, dashLeadingName].sort());
  });

  test('doesNotInterpretFlagLikePathAsGitOption', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-61-');
    t.after(() => cleanup(dir));
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    const flagLikeName = '--upload-pack=evil.js';
    commitFile(dir, flagLikeName, FLAT_JS, 'flag-like name');

    const touched = gitBaseBranch.changedFilesSince(dir, before);
    assert.ok(Array.isArray(touched));
    assert.deepEqual(touched, [flagLikeName]);
  });

  test('refusesPathEscapingRepoRoot', (t) => {
    const dir = createTempDir('gsd-refactor-cli-62-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { refactor: { trigger_enabled: true } });
    const phaseDir = path.join(dir, '.planning', 'phases', '01-feat');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), ['# Plan', ''].join('\n'), 'utf8');

    // A real, readable file OUTSIDE the project root that a traversal path
    // could reach if the router failed to confine it.
    const secretParent = createTempDir('gsd-refactor-cli-62-secret-');
    t.after(() => cleanup(secretParent));
    const secretFile = path.join(secretParent, 'escaped.js');
    fs.writeFileSync(secretFile, TRIGGERING_JS, 'utf8');
    const traversal = path.relative(dir, secretFile);

    const readCalls = [];
    const origReadFileSync = fs.readFileSync;
    const readMock = mock.method(fs, 'readFileSync', (target, ...rest) => {
      readCalls.push(target);
      return origReadFileSync.call(fs, target, ...rest);
    });
    t.after(() => readMock.mock.restore());

    const outputs = [];
    routeRefactorTriggerCommand({
      args: ['refactor', 'evaluate', '--phase', '1', '--raw'],
      cwd: dir,
      raw: true,
      error: noThrowError('row62'),
      _git: {
        phaseStartCommit: () => 'HEAD~1',
        changedFilesSince: () => [traversal],
      },
      _core: { output: (v) => outputs.push(v) },
    });

    assert.strictEqual(outputs.length, 1);
    const result = outputs[0];
    assert.strictEqual(result.verdict, VERDICT.BELOW_THRESHOLD);
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].reason, REASON.REFACTOR_FILE_UNREADABLE);
    assert.strictEqual(readCalls.includes(secretFile), false, 'the escaping path must never reach fs.readFileSync');
  });
});

// ─── Rows 63-73 — CLI contract: `gsd-tools refactor` ─────────────────────────

describe('refactor-trigger: CLI contract — gsd-tools refactor', () => {
  test('writesProposalArtifactForTriggeringPhase', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-63-', false);
    t.after(() => cleanup(dir));

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assertExited(result, 'row63');
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.verdict, VERDICT.TRIGGERED);
    assert.strictEqual(parsed.artifact_written, true);
    assert.strictEqual(typeof parsed.artifact_path, 'string');
    assert.strictEqual(fs.statSync(parsed.artifact_path).isFile(), true);
  });

  test('writesNoArtifactBelowThreshold', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-64-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { refactor: { trigger_enabled: true, complexity_threshold: 1000, complexity_jump_delta: 1000 } });
    seedPhaseAndAnchor(dir);
    commitFile(dir, 'flat.js', FLAT_JS, 'flat file');

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assertExited(result, 'row64');
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.verdict, VERDICT.BELOW_THRESHOLD);
    assert.strictEqual(parsed.artifact_written, false);
    assert.strictEqual(parsed.artifact_path, null);
    assert.strictEqual(fs.existsSync(path.join(dir, '.planning', 'phases', '01-feat', `01${PROPOSAL_SUFFIX}`)), false);
  });

  test('returnsDisabledResponseWhenCapabilityOff', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-65-');
    t.after(() => cleanup(dir));
    seedPhaseAndAnchor(dir);

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assertExited(result, 'row65');
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.disabled, true);
  });

  test('rejectsMissingPhaseArgument', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-66-', false);
    t.after(() => cleanup(dir));

    const result = runCliOnce(['refactor', 'evaluate', '--raw'], dir, { GSD_JSON_ERRORS: '1' });
    assertExited(result, 'row66');
    assert.notStrictEqual(result.exitCode, 0);
    const parsed = parseStderr(result);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.reason, REASON.REFACTOR_USAGE);
  });

  test('rejectsEmptyAndWhitespacePhase', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-67-', false);
    t.after(() => cleanup(dir));

    for (const phaseValue of ['', '   ']) {
      const result = runCliOnce(['refactor', 'evaluate', '--phase', phaseValue, '--raw'], dir, { GSD_JSON_ERRORS: '1' });
      assertExited(result, `row67(${JSON.stringify(phaseValue)})`);
      assert.notStrictEqual(result.exitCode, 0);
      const parsed = parseStderr(result);
      assert.strictEqual(parsed.reason, REASON.REFACTOR_INVALID_PHASE);
    }
  });

  // Matrix row 68 names REFACTOR_USAGE as the expected reason; the router
  // contract (42-router-contract.md "evaluate" step 2) and the shipped
  // implementation both treat `--phase=`/`--phase==N` as PRESENT-BUT-INVALID
  // (REFACTOR_INVALID_PHASE), reserving REFACTOR_USAGE for the flag being
  // absent entirely. Asserted against the router contract + implementation,
  // which agree with each other; the matrix wording is the stale one here —
  // see the final report for this discrepancy.
  test('rejectsMalformedPhaseAssignment', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-68-', false);
    t.after(() => cleanup(dir));

    for (const arg of ['--phase=', '--phase==3']) {
      const result = runCliOnce(['refactor', 'evaluate', arg, '--raw'], dir, { GSD_JSON_ERRORS: '1' });
      assertExited(result, `row68(${arg})`);
      assert.notStrictEqual(result.exitCode, 0);
      const parsed = parseStderr(result);
      assert.strictEqual(parsed.reason, REASON.REFACTOR_INVALID_PHASE);
    }
  });

  test('rejectsDuplicatePhaseFlag', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-69-', false);
    t.after(() => cleanup(dir));

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--phase', '2', '--raw'], dir, { GSD_JSON_ERRORS: '1' });
    assertExited(result, 'row69');
    assert.notStrictEqual(result.exitCode, 0);
    const parsed = parseStderr(result);
    assert.strictEqual(parsed.reason, REASON.REFACTOR_INVALID_PHASE);
  });

  test('rejectsFlagLikePhaseValue', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-70-', false);
    t.after(() => cleanup(dir));

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '--raw'], dir, { GSD_JSON_ERRORS: '1' });
    assertExited(result, 'row70');
    assert.notStrictEqual(result.exitCode, 0);
    const parsed = parseStderr(result);
    assert.strictEqual(parsed.reason, REASON.REFACTOR_INVALID_PHASE);
  });

  test('reportsUnknownSubcommandWithAvailableList', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-71-', false);
    t.after(() => cleanup(dir));

    const result = runCliOnce(['refactor', 'frobnicate', '--raw'], dir, { GSD_JSON_ERRORS: '1' });
    assertExited(result, 'row71');
    assert.notStrictEqual(result.exitCode, 0);
    const parsed = parseStderr(result);
    assert.strictEqual(parsed.reason, ERROR_REASON.SDK_UNKNOWN_COMMAND);
  });

  test('rejectsOverlongAndUnicodePhaseValues', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-72-', false);
    t.after(() => cleanup(dir));

    // Overlong: matches the positive-integer regex (all digits), so it clears
    // arg validation but fails to resolve as a real phase directory ->
    // REFACTOR_INVALID_PHASE via the resolve-phase-dir path (exit 0, typed
    // verdict on stdout) rather than the arg-validation path.
    const overlong = '9'.repeat(5000);
    const overlongResult = runCliOnce(['refactor', 'evaluate', '--phase', overlong, '--raw'], dir);
    assertExited(overlongResult, 'row72(overlong)');
    assert.strictEqual(overlongResult.exitCode, 0);
    const overlongParsed = parseStdout(overlongResult);
    assert.strictEqual(overlongParsed.verdict, VERDICT.SKIPPED);
    assert.strictEqual(overlongParsed.reason, REASON.REFACTOR_INVALID_PHASE);

    // Unicode: fails the arg-validation regex outright.
    const unicodeResult = runCliOnce(['refactor', 'evaluate', '--phase', '一二三', '--raw'], dir, { GSD_JSON_ERRORS: '1' });
    assertExited(unicodeResult, 'row72(unicode)');
    assert.notStrictEqual(unicodeResult.exitCode, 0);
    const unicodeParsed = parseStderr(unicodeResult);
    assert.strictEqual(unicodeParsed.reason, REASON.REFACTOR_INVALID_PHASE);
  });

  test('provesNoShellInterpolationOfPhaseValue', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-73-', false);
    t.after(() => cleanup(dir));
    const sentinel = path.join(dir, 'SENTINEL');

    const payloads = [
      `1;touch ${sentinel};`,
      `$(touch ${sentinel})`,
      '`touch ' + sentinel + '`',
    ];
    for (const payload of payloads) {
      const result = runCliOnce(['refactor', 'evaluate', '--phase', payload, '--raw'], dir, { GSD_JSON_ERRORS: '1' });
      assertExited(result, `row73(${JSON.stringify(payload)})`);
      assert.notStrictEqual(result.exitCode, 0);
      assert.strictEqual(fs.existsSync(sentinel), false, `sentinel must not exist after payload ${JSON.stringify(payload)}`);
      const parsed = parseStderr(result);
      assert.strictEqual(parsed.reason, REASON.REFACTOR_INVALID_PHASE);
    }
  });
});

// ─── Rows 74-79 — disposition + ledger ───────────────────────────────────────

describe('refactor-trigger: disposition + ledger', () => {
  test('recordsDeclinedRefactorAsDeviationWindow', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-74-', true);
    t.after(() => cleanup(dir));
    const evalResult = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(evalResult.exitCode, 0);
    assert.strictEqual(parseStdout(evalResult).ledger_recorded, true);

    const declineResult = runCliOnce(['refactor', 'decline', '--phase', '1', '--reason', 'not worth it', '--raw'], dir);
    assertExited(declineResult, 'row74');
    assert.strictEqual(declineResult.exitCode, 0);
    const declineParsed = parseStdout(declineResult);
    assert.strictEqual(declineParsed.status, 'declined');

    const ledgerPath = path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME);
    const ledger = windowsModule.parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(ledger.entries.length, 1);
    assert.strictEqual(ledger.entries[0].kind, 'deviation');
    assert.strictEqual(ledger.entries[0].status, 'waived');
  });

  test('declinesGracefullyWithoutBrokenWindows', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-75-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { refactor: { trigger_enabled: true, trigger_strict: false, complexity_threshold: 1, complexity_jump_delta: 100 } });
    seedPhaseAndAnchor(dir);
    commitFile(dir, 'hot.js', TRIGGERING_JS, 'hot file');

    const evalOutputs = [];
    routeRefactorTriggerCommand({
      args: ['refactor', 'evaluate', '--phase', '1', '--raw'],
      cwd: dir,
      raw: true,
      error: noThrowError('row75(evaluate)'),
      _core: { output: (v) => evalOutputs.push(v) },
    });
    assert.strictEqual(evalOutputs[0].verdict, VERDICT.TRIGGERED);

    // Simulate broken-windows genuinely absent: make the router's own
    // `require('./broken-windows.cjs')` throw, exactly as the router contract
    // documents ("absent or a throwing require is the documented degrade
    // path"). Scoped to this module's own require calls only.
    const origRequire = Module.prototype.require;
    const requireMock = mock.method(Module.prototype, 'require', function mockedRequire(id) {
      if (id === './broken-windows.cjs' && this.filename === ROUTER_MODULE_PATH) {
        throw new Error('simulated: broken-windows capability not installed');
      }
      return origRequire.call(this, id);
    });
    t.after(() => requireMock.mock.restore());

    const declineOutputs = [];
    routeRefactorTriggerCommand({
      args: ['refactor', 'decline', '--phase', '1', '--reason', 'not now', '--raw'],
      cwd: dir,
      raw: true,
      error: noThrowError('row75(decline)'),
      _core: { output: (v) => declineOutputs.push(v) },
    });

    assert.strictEqual(declineOutputs.length, 1);
    const declineResult = declineOutputs[0];
    assert.strictEqual(declineResult.status, 'declined');
    assert.strictEqual(declineResult.ledger_resolved, false);
    assert.strictEqual(typeof declineResult.ledger_note, 'string');
    assert.notStrictEqual(declineResult.ledger_note, '');
    assert.strictEqual(fs.existsSync(path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME)), false);
  });

  test('rejectsEmptyDeclineReason', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-76-', false);
    t.after(() => cleanup(dir));
    const evalResult = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(evalResult.exitCode, 0);
    const artifactPath = parseStdout(evalResult).artifact_path;

    for (const reason of ['', '   ']) {
      const result = runCliOnce(['refactor', 'decline', '--phase', '1', '--reason', reason, '--raw'], dir, { GSD_JSON_ERRORS: '1' });
      assertExited(result, `row76(${JSON.stringify(reason)})`);
      assert.notStrictEqual(result.exitCode, 0);
      const parsed = parseStderr(result);
      assert.strictEqual(parsed.reason, REASON.REFACTOR_DECLINE_REASON_EMPTY);
    }

    const { parseProposal } = require('../gsd-core/bin/lib/complexity-trigger.cjs');
    const proposal = parseProposal(fs.readFileSync(artifactPath, 'utf8'));
    assert.strictEqual(proposal.status, 'proposed', 'a rejected decline must not change the proposal status');
  });

  test('doesNotAppendDuplicateWindowOnRepeatedDecline', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-77-', true);
    t.after(() => cleanup(dir));
    const evalResult = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(evalResult.exitCode, 0);

    const first = runCliOnce(['refactor', 'decline', '--phase', '1', '--reason', 'first', '--raw'], dir);
    assert.strictEqual(first.exitCode, 0);

    const second = runCliOnce(['refactor', 'decline', '--phase', '1', '--reason', 'second', '--raw'], dir, { GSD_JSON_ERRORS: '1' });
    assertExited(second, 'row77(second)');
    assert.notStrictEqual(second.exitCode, 0);
    assert.strictEqual(parseStderr(second).reason, REASON.REFACTOR_ALREADY_DISPOSITIONED);

    const ledgerPath = path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME);
    const ledger = windowsModule.parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(ledger.entries.length, 1);
  });

  test('rejectsDeclineWithNoProposal', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-78-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { refactor: { trigger_enabled: true } });
    seedPhaseAndAnchor(dir);

    const result = runCliOnce(['refactor', 'decline', '--phase', '1', '--reason', 'x', '--raw'], dir, { GSD_JSON_ERRORS: '1' });
    assertExited(result, 'row78');
    assert.notStrictEqual(result.exitCode, 0);
    assert.strictEqual(parseStderr(result).reason, REASON.REFACTOR_ARTIFACT_NOT_FOUND);
  });

  test('treatsAcceptAndDeclineAsMutuallyExclusive', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-79-', false);
    t.after(() => cleanup(dir));
    const evalResult = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(evalResult.exitCode, 0);

    const acceptResult = runCliOnce(['refactor', 'accept', '--phase', '1', '--raw'], dir);
    assert.strictEqual(acceptResult.exitCode, 0);
    assert.strictEqual(parseStdout(acceptResult).status, 'accepted');

    const declineResult = runCliOnce(['refactor', 'decline', '--phase', '1', '--reason', 'x', '--raw'], dir, { GSD_JSON_ERRORS: '1' });
    assertExited(declineResult, 'row79');
    assert.notStrictEqual(declineResult.exitCode, 0);
    assert.strictEqual(parseStderr(declineResult).reason, REASON.REFACTOR_ALREADY_DISPOSITIONED);
  });
});

// ─── Rows 80-86 — strict mode -> broken-windows ledger ───────────────────────

describe('refactor-trigger: strict mode -> broken-windows ledger', () => {
  test('appendsNoWindowInAdvisoryMode', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-80-', false);
    t.after(() => cleanup(dir));

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.verdict, VERDICT.TRIGGERED);
    assert.strictEqual(parsed.artifact_written, true);
    assert.strictEqual(parsed.ledger_recorded, undefined);
    assert.strictEqual(fs.existsSync(path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME)), false);
  });

  test('appendsNoWindowWhenNothingTriggered', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-81-');
    t.after(() => cleanup(dir));
    writeConfig(dir, {
      refactor: { trigger_enabled: true, trigger_strict: true, complexity_threshold: 1000, complexity_jump_delta: 1000 },
    });
    seedPhaseAndAnchor(dir);
    commitFile(dir, 'flat.js', FLAT_JS, 'flat file');

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.verdict, VERDICT.BELOW_THRESHOLD);
    assert.strictEqual(parsed.artifact_written, false);
    assert.strictEqual(parsed.ledger_recorded, undefined, 'F1 regression guard: nothing triggered => zero windows, ever');
    assert.strictEqual(fs.existsSync(path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME)), false);
  });

  test('appendsDeviationWindowForUntriagedProposal', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-82-', true);
    t.after(() => cleanup(dir));

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(parseStdout(result).ledger_recorded, true);

    const ledgerPath = path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME);
    const ledger = windowsModule.parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(ledger.open_count, 1);
    assert.strictEqual(ledger.entries.length, 1);
    const entry = ledger.entries[0];
    assert.strictEqual(entry.kind, 'deviation');
    assert.strictEqual(entry.status, 'open');
    assert.strictEqual(entry.file, 'hot.js', 'dedup identity is the structured file field, not prose');
    assert.strictEqual(entry.line, 1, 'dedup identity is the structured line field (target function start line)');
  });

  test('resolvesWindowOnAcceptRegardlessOfScore', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-83-', true);
    t.after(() => cleanup(dir));

    const evalResult = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(evalResult.exitCode, 0);
    const evalParsed = parseStdout(evalResult);
    assert.strictEqual(evalParsed.verdict, VERDICT.TRIGGERED);
    const triggeringScore = evalParsed.target.score;

    // Accept WITHOUT touching hot.js at all — its live score cannot have
    // improved, and per config it is still strictly above the threshold.
    const acceptResult = runCliOnce(['refactor', 'accept', '--phase', '1', '--raw'], dir);
    assert.strictEqual(acceptResult.exitCode, 0);
    const acceptParsed = parseStdout(acceptResult);
    assert.strictEqual(acceptParsed.reanchored_to, triggeringScore, 'the Goodhart guarantee: the score did not improve');
    assert.ok(acceptParsed.reanchored_to > 1, 'score must still be above the configured threshold (1)');
    assert.strictEqual(acceptParsed.ledger_resolved, true);

    const ledgerPath = path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME);
    const ledger = windowsModule.parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(ledger.open_count, 0);
    assert.strictEqual(ledger.fixed_count, 1);
  });

  test('waivesWindowWithReasonOnDecline', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-84-', true);
    t.after(() => cleanup(dir));
    const evalResult = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(evalResult.exitCode, 0);

    const reasonText = 'deferred to next phase';
    const declineResult = runCliOnce(['refactor', 'decline', '--phase', '1', '--reason', reasonText, '--raw'], dir);
    assert.strictEqual(declineResult.exitCode, 0);
    assert.strictEqual(parseStdout(declineResult).ledger_resolved, true);

    const ledgerPath = path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME);
    const ledger = windowsModule.parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(ledger.entries.length, 1);
    assert.strictEqual(ledger.entries[0].status, 'waived');
    assert.strictEqual(ledger.entries[0].reason, reasonText);
  });

  test('doesNotDuplicateWindowOnReEvaluate', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-85-', true);
    t.after(() => cleanup(dir));

    const first = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(first.exitCode, 0);
    const second = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(second.exitCode, 0);
    assert.strictEqual(parseStdout(second).ledger_recorded, true);

    const ledgerPath = path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME);
    const ledger = windowsModule.parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
    assert.strictEqual(ledger.entries.length, 1);
    assert.strictEqual(ledger.open_count, 1);
  });

  test('notesLedgerUnavailableWithoutBrokenWindows', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-86-');
    t.after(() => cleanup(dir));
    writeConfig(dir, {
      refactor: { trigger_enabled: true, trigger_strict: true, complexity_threshold: 1, complexity_jump_delta: 100 },
    });
    seedPhaseAndAnchor(dir);
    commitFile(dir, 'hot.js', TRIGGERING_JS, 'hot file');

    const origRequire = Module.prototype.require;
    const requireMock = mock.method(Module.prototype, 'require', function mockedRequire(id) {
      if (id === './broken-windows.cjs' && this.filename === ROUTER_MODULE_PATH) {
        throw new Error('simulated: broken-windows capability not installed');
      }
      return origRequire.call(this, id);
    });
    t.after(() => requireMock.mock.restore());

    const outputs = [];
    routeRefactorTriggerCommand({
      args: ['refactor', 'evaluate', '--phase', '1', '--raw'],
      cwd: dir,
      raw: true,
      error: noThrowError('row86'),
      _core: { output: (v) => outputs.push(v) },
    });

    assert.strictEqual(outputs.length, 1);
    const result = outputs[0];
    assert.strictEqual(result.verdict, VERDICT.TRIGGERED);
    assert.strictEqual(result.artifact_written, true);
    assert.strictEqual(result.ledger_recorded, false);
    assert.strictEqual(result.ledger_note, 'broken-windows capability unavailable — proposal recorded locally only');
    assert.strictEqual(fs.existsSync(path.join(dir, '.planning', windowsModule.LEDGER_FILE_NAME)), false);
  });
});

// ─── Strict-mode enforcement-gap warning (#1953) ─────────────────────────────
//
// `refactor.trigger_strict` only ever appends a deviation window to the
// broken-windows ledger; a ship only actually stops when the SEPARATE
// `workflow.windows_enforce` toggle is also on. These cases lock the typed
// `REFACTOR_STRICT_NOT_ENFORCING` warning that closes that expectation gap.

describe('refactor-trigger: strict-mode enforcement-gap warning', () => {
  test('warnsWhenStrictOnAndWindowsEnforceOff', (t) => {
    const dir = setupTriggeringProject('gsd-refactor-cli-swe-1-', true);
    t.after(() => cleanup(dir));

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.ledger_recorded, true, 'broken-windows must be present and recording for this case');
    assert.ok(Array.isArray(parsed.warnings));
    assert.strictEqual(parsed.warnings.length, 1);
    assert.strictEqual(parsed.warnings[0].reason, REASON.REFACTOR_STRICT_NOT_ENFORCING);
    assert.strictEqual(typeof parsed.warnings[0].message, 'string');
    assert.notStrictEqual(parsed.warnings[0].message, '');
  });

  test('omitsWarningWhenStrictOnAndWindowsEnforceOn', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-swe-2-');
    t.after(() => cleanup(dir));
    writeConfig(dir, {
      refactor: { trigger_enabled: true, trigger_strict: true, complexity_threshold: 1, complexity_jump_delta: 100 },
      workflow: { windows_enforce: true },
    });
    seedPhaseAndAnchor(dir);
    commitFile(dir, 'hot.js', TRIGGERING_JS, 'hot file');

    const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
    assert.strictEqual(result.exitCode, 0);
    const parsed = parseStdout(result);
    assert.strictEqual(parsed.ledger_recorded, true, 'broken-windows must be present and recording for this case');
    assert.strictEqual(parsed.warnings, undefined);
  });

  test('warnsWhenStrictOnAndBrokenWindowsAbsent', (t) => {
    const dir = createTempGitProject('gsd-refactor-cli-swe-3-');
    t.after(() => cleanup(dir));
    writeConfig(dir, {
      refactor: { trigger_enabled: true, trigger_strict: true, complexity_threshold: 1, complexity_jump_delta: 100 },
    });
    seedPhaseAndAnchor(dir);
    commitFile(dir, 'hot.js', TRIGGERING_JS, 'hot file');

    // Simulate broken-windows genuinely absent, exactly as
    // `notesLedgerUnavailableWithoutBrokenWindows` (row 86) does.
    const origRequire = Module.prototype.require;
    const requireMock = mock.method(Module.prototype, 'require', function mockedRequire(id) {
      if (id === './broken-windows.cjs' && this.filename === ROUTER_MODULE_PATH) {
        throw new Error('simulated: broken-windows capability not installed');
      }
      return origRequire.call(this, id);
    });
    t.after(() => requireMock.mock.restore());

    const outputs = [];
    routeRefactorTriggerCommand({
      args: ['refactor', 'evaluate', '--phase', '1', '--raw'],
      cwd: dir,
      raw: true,
      error: noThrowError('swe-3'),
      _core: { output: (v) => outputs.push(v) },
    });

    assert.strictEqual(outputs.length, 1);
    const result = outputs[0];
    assert.strictEqual(result.ledger_recorded, false);
    assert.ok(Array.isArray(result.warnings));
    assert.strictEqual(result.warnings.length, 1);
    assert.strictEqual(result.warnings[0].reason, REASON.REFACTOR_STRICT_NOT_ENFORCING);
    assert.strictEqual(typeof result.warnings[0].message, 'string');
    assert.notStrictEqual(result.warnings[0].message, '');
  });

  test('neverWarnsWhenStrictOffRegardlessOfWindowsEnforce', (t) => {
    for (const windowsEnforce of [true, false]) {
      const dir = createTempGitProject('gsd-refactor-cli-swe-4-');
      t.after(() => cleanup(dir));
      writeConfig(dir, {
        refactor: { trigger_enabled: true, trigger_strict: false, complexity_threshold: 1, complexity_jump_delta: 100 },
        workflow: { windows_enforce: windowsEnforce },
      });
      seedPhaseAndAnchor(dir);
      commitFile(dir, 'hot.js', TRIGGERING_JS, 'hot file');

      const result = runCliOnce(['refactor', 'evaluate', '--phase', '1', '--raw'], dir);
      assert.strictEqual(result.exitCode, 0);
      const parsed = parseStdout(result);
      assert.strictEqual(parsed.verdict, VERDICT.TRIGGERED, `windowsEnforce=${windowsEnforce}: fixture must still trigger`);
      assert.strictEqual(parsed.ledger_recorded, undefined, `windowsEnforce=${windowsEnforce}: strict is off`);
      assert.strictEqual(parsed.warnings, undefined, `windowsEnforce=${windowsEnforce}: strict off must never warn`);
    }
  });
});

// ─── Row 87 (independence) — registry declares zero ship:pre gates ──────────

describe('refactor-trigger: registry independence', () => {
  test('declaresNoShipPreGate', () => {
    const cap = registry.capabilities['refactor-trigger'];
    assert.ok(cap, 'refactor-trigger must be present in the registry');
    assert.deepEqual(cap.gates, []);

    const shipPre = registry.byLoopPoint['ship:pre'];
    assert.strictEqual(shipPre.gates.length, 2);
    assert.deepEqual(shipPre.gates.map((g) => g.capId).sort(), ['broken-windows', 'security']);
  });
});

// ─── Rows 87-90 — loop wiring + manifest validation ──────────────────────────

describe('refactor-trigger: loop wiring', () => {
  test('rendersRefactorStepAtExecutePost', () => {
    const resolved = resolveLoopHooks({
      point: 'execute:post',
      registry,
      config: { refactor: { trigger_enabled: true } },
    });
    const step = resolved.activeHooks.find((h) => h.capId === 'refactor-trigger');
    assert.ok(step, 'refactor-trigger step must be present when enabled');
    assert.strictEqual(step.kind, 'step');
    assert.deepEqual(step.ref, { command: 'refactor evaluate' });
    assert.strictEqual(step.when, 'refactor.trigger_enabled');
    assert.strictEqual(step.onError, 'skip');
  });

  test('omitsRefactorStepWhenDisabled', () => {
    const resolved = resolveLoopHooks({
      point: 'execute:post',
      registry,
      config: { refactor: { trigger_enabled: false } },
    });
    const step = resolved.activeHooks.find((h) => h.capId === 'refactor-trigger');
    assert.strictEqual(step, undefined, 'refactor-trigger step must be absent when disabled');
  });

  test('preservesCodeReviewHookShapeAlongsideRefactorHook', () => {
    const resolved = resolveLoopHooks({
      point: 'execute:post',
      registry,
      config: { refactor: { trigger_enabled: true } },
    });
    assert.strictEqual(resolved.activeHooks.length, 2, 'both refactor-trigger and code-review must be present');
    const codeReview = resolved.activeHooks.find((h) => h.capId === 'code-review');
    assert.ok(codeReview, 'code-review step must still be present alongside refactor-trigger');
    assert.deepEqual(codeReview, {
      capId: 'code-review',
      kind: 'step',
      ref: { skill: 'code-review' },
      when: 'workflow.code_review',
      produces: ['REVIEW.md'],
      consumes: ['SUMMARY.md'],
      onError: 'skip',
      supportsReviewerLanes: true,
    });
  });

  test('validatesRefactorTriggerManifest', () => {
    const errors = validateCapability(refactorTriggerCapability, 'refactor-trigger');
    assert.deepEqual(errors, []);

    const ownConfigKeys = [
      'refactor.trigger_enabled',
      'refactor.complexity_threshold',
      'refactor.complexity_jump_delta',
      'refactor.trigger_strict',
    ];
    for (const key of ownConfigKeys) {
      assert.strictEqual(registry.configKeys[key], 'refactor-trigger', `config key ${key} must be owned solely by refactor-trigger, no other capability`);
    }

    for (const step of refactorTriggerCapability.steps) {
      assert.strictEqual(VALID_LOOP_POINTS.has(step.point), true, `step.point ${step.point} must be one of the closed 12 loop points`);
    }
  });
});

// ─── Regression: handleEvaluate self-complexity (#3267) ────────────────────

describe('refactor-trigger-command-router: self-complexity', () => {
  test('handleEvaluateStaysAtOrBelowThreshold', () => {
    const routerPath = path.join(__dirname, '..', 'src', 'refactor-trigger-command-router.cts');
    const source = fs.readFileSync(routerPath, 'utf8');
    const result = analyzeSource(source);
    assert.strictEqual(result.ok, true, 'router source must analyze cleanly');
    const handleEvaluateFn = result.functions.find((f) => f.name === 'handleEvaluate');
    assert.ok(handleEvaluateFn, 'handleEvaluate must still be found by the analyzer');
    assert.ok(
      handleEvaluateFn.score <= DEFAULTS.threshold,
      `handleEvaluate scores ${handleEvaluateFn.score}, must be <= ${DEFAULTS.threshold} (refactor.complexity_threshold)`,
    );
  });
});
