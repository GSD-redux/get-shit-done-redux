// allow-test-rule: source-text-is-the-product — see #2650
// Workflow markdown is the installed orchestration contract.

'use strict';

/**
 * #2650 — plan-phase hangs after gsd-planner writes all plans; completion never
 * reaches orchestrator.
 *
 * plan-phase.md's five planner/plan-checker Agent() spawns (standard planner,
 * chunked outline planner, chunked per-plan planner, plan-checker, and the
 * revision-loop planner respawn) previously waited for a subagent's return
 * with no time bound, no periodic check, and no config-driven threshold — the
 * only recovery path (9a/11a "Filesystem Fallback") required Agent() to have
 * already returned, so it could never fire when the call never returned
 * control at all. This mirrors the already-shipped `executor.stall_*` fix for
 * execute-phase.md (bug #3212, commit e7942c21b).
 *
 * The fix extracts the decision logic into a pure, unit-testable bash
 * function (`gsd_stall_should_recover`) embedded in the lazily-loaded
 * `gsd-core/workflows/plan-phase/steps/stall-detection-helpers.md` (kept out
 * of plan-phase.md's own measured bytes — plan-phase.md is frozen under the
 * ADR-857 Phase 6 `PRE_PHASE6` gate, `tests/phase6-capstone-conformance.test.cjs`,
 * with ~36 bytes of headroom at baseline) and exercised here via the SAME
 * extraction pattern already used by tests/worktree-cleanup.test.cjs
 * (extractCwdGuardBash) and tests/quick-branching.test.cjs
 * (extractStep25Bash) — the test runs the exact shipped bash, not a
 * hand-copied duplicate (avoids the "Generative Fix Divergence" defect
 * class).
 *
 * Seam: gsd-core/workflows/plan-phase.md,
 *       gsd-core/workflows/plan-phase/steps/stall-detection-helpers.md,
 *       src/config.cts (SCHEMA_DEFAULTS),
 *       gsd-core/bin/shared/config-schema.manifest.json, docs/CONFIGURATION.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const { cleanup, readFileNormalized, readWorkflowCombined } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PLAN_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const STALL_HELPERS_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'stall-detection-helpers.md');
const CHUNKED_PLANNING_MODE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'chunked-planning-mode.md');
const CONFIG_SCHEMA_MANIFEST_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json');
const CONFIGURATION_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'CONFIGURATION.md');

function readPlanPhase() {
  return readFileNormalized(PLAN_PHASE_PATH);
}

// #2993 relocated plan-phase.md's chunked-planning-mode spawn sites into this
// lazily-loaded step file. Read directly rather than via the generic
// readWorkflowCombined() blob when a test needs to slice a SPECIFIC section by
// heading-to-heading boundaries: chunked-planning-mode.md is small and
// self-contained (8.5.1 immediately followed by 8.5.2, nothing else), so its
// own heading boundaries stay precise, whereas the combined multi-file blob's
// ordering (host file, then every steps/*.md sorted by filename) would put an
// unrelated step file's content between "### 8.5.2 Per-Plan Tasks" and any
// downstream anchor a slice tried to search for.
function readChunkedPlanningMode() {
  return readFileNormalized(CHUNKED_PLANNING_MODE_PATH);
}

function readStallHelpersDoc() {
  return readFileNormalized(STALL_HELPERS_PATH);
}

/**
 * Extract the ```bash fence that defines gsd_stall_should_recover (and its
 * sibling gsd_stall_watch) from the lazily-loaded stall-detection-helpers.md
 * step file. Throws with a clear message if the anchor or fence cannot be
 * found — this is what makes row 1 of the test matrix a genuine failing-first
 * regression test (pre-fix, the function does not exist anywhere in the repo).
 */
function extractStallHelpersBash() {
  const content = readStallHelpersDoc();

  const anchor = 'gsd_stall_should_recover';
  const anchorIdx = content.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`extractStallHelpersBash: could not find "${anchor}" anywhere in ${STALL_HELPERS_PATH}`);
  }

  // Walk backward to the start of the fenced ```bash block containing the anchor.
  const before = content.slice(0, anchorIdx);
  const fenceOpenRe = /```bash\r?\n/g;
  let lastOpen = -1;
  let m;
  while ((m = fenceOpenRe.exec(before)) !== null) {
    lastOpen = m.index + m[0].length;
  }
  if (lastOpen === -1) {
    throw new Error(`extractStallHelpersBash: "${anchor}" is not inside a \`\`\`bash fence in ${STALL_HELPERS_PATH}`);
  }

  const after = content.slice(lastOpen);
  const closeIdx = after.indexOf('```');
  if (closeIdx === -1) {
    throw new Error('extractStallHelpersBash: unterminated ```bash fence');
  }

  const body = after.slice(0, closeIdx);
  if (!body.includes('gsd_stall_watch')) {
    throw new Error('extractStallHelpersBash: sanity check failed — extracted block does not also define gsd_stall_watch');
  }
  // readStallHelpersDoc() reads through helpers.cjs's readFileNormalized(),
  // which strips \r\n -> \n at the read boundary before any slicing above
  // runs. That guards against the repo's general CRLF-in-extracted-source
  // defect class (#1700) and is worth keeping on its own merits (a bare \n
  // regex against readFileSync content is fragile either way), but it is
  // NOT what caused the #2650 Windows CI failure: .gitattributes forces
  // `eol=lf` on this file, so a Windows checkout never receives CRLF here
  // in the first place. The real cause, confirmed by evidence rather than
  // argument: passing this file's ~73-line, quote-dense script body as a
  // single `bash -c <script>` argv element does not survive Windows argv
  // serialization (Node has no execve there; CreateProcess flattens the
  // whole argv into one command-line string, and Git Bash's MSYS layer
  // re-splits and unescapes it with its own rules — the script itself gets
  // mangled in transit, not just the boundary around it). Proven by an
  // A/B on real CI: converting only runShouldRecover() to the temp-file
  // form below took Windows from 11 failures to 4, and flipped
  // `full test (windows-latest, 22, shard 1/3)` and `shard 2/3` from fail
  // to pass — while runWatch() (no extra positional args at all, values
  // embedded directly in the script text) still failed identically to
  // before, so the trailing-args theory is ruled out: it is script size
  // and quote density, not argv-element count. `runBashScript()` below
  // (used by every call site in this file) removes the script from `-c`
  // transport entirely by writing it to a file and running it by path.
  // tests/worktree-cleanup.test.cjs's extractCwdGuardBash/runGuard stays on
  // `bash -c` and is green on Windows only because its script is small
  // enough to round-trip that transport intact.
  return body;
}

/**
 * Write `script` to a fresh temp file and run it as `bash <file> <args...>`
 * rather than `bash -c <script> <args...>` (#2650 Windows CI — see
 * extractStallHelpersBash()'s doc comment for the full evidence trail: a
 * quote-dense multi-line script does not survive Windows argv
 * serialization when passed as a `-c` argv element, regardless of how many
 * trailing positional args accompany it). Every bash-invoking call site in
 * this file routes through this one seam so a future call site cannot
 * silently reintroduce the transport bug in isolation. Cleans up the temp
 * dir in `finally` regardless of outcome.
 *
 * @param {string} script  the full bash script body (helpers + a final call)
 * @param {string[]} [args]  positional args passed to the script (become
 *   $1, $2, ... inside it) — empty when the caller embeds values directly
 *   into the script text instead (e.g. via JSON.stringify).
 * @param {object} [opts]  extra spawnSync options (e.g. `{ timeout }`),
 *   merged over the `{ encoding: 'utf-8' }` default.
 */
function runBashScript(script, args = [], opts = {}) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-sh-'));
  try {
    const scriptPath = path.join(scriptDir, 'script.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${script}`, { mode: 0o755 });
    return spawnSync('bash', [scriptPath, ...args], { encoding: 'utf-8', timeout: 10000, ...opts });
  } finally {
    cleanup(scriptDir);
  }
}

/**
 * Run gsd_stall_should_recover with the given args inside the extracted
 * script and return its stdout (trimmed). No real sleeping happens — the
 * function is pure and synchronous.
 */
function runShouldRecover(helpersBash, elapsedSeconds, thresholdMinutes, markerFound, artifactFresh) {
  const script = `${helpersBash}\ngsd_stall_should_recover "$1" "$2" "$3" "$4"\n`;
  const result = runBashScript(script,
    [String(elapsedSeconds), String(thresholdMinutes), String(markerFound), String(artifactFresh)]);
  assert.equal(result.status, 0, `gsd_stall_should_recover exited non-zero: ${result.stderr}`);
  return result.stdout.trim();
}

describe('bug #2650 plan-phase stall detection — gsd_stall_should_recover (pure decision function)', () => {
  let helpersBash;

  test('stall-detection-helpers.md defines gsd_stall_should_recover inside a ```bash fence', () => {
    helpersBash = extractStallHelpersBash();
    assert.ok(helpersBash.length > 0);
  });

  test('boundary — one second under threshold keeps waiting (limit-1)', () => {
    const result = runShouldRecover(helpersBash, 599, 10, 'false', 'false'); // 10min = 600s
    assert.equal(result, 'waiting');
  });

  test('boundary — exactly at threshold stalls (limit)', () => {
    const result = runShouldRecover(helpersBash, 600, 10, 'false', 'false');
    assert.equal(result, 'stalled');
  });

  test('boundary — one second past threshold stalls (limit+1)', () => {
    const result = runShouldRecover(helpersBash, 601, 10, 'false', 'false');
    assert.equal(result, 'stalled');
  });

  test('marker found short-circuits regardless of elapsed time', () => {
    assert.equal(runShouldRecover(helpersBash, 0, 10, 'true', 'false'), 'marker_received');
    assert.equal(runShouldRecover(helpersBash, 99999, 10, 'true', 'false'), 'marker_received');
  });

  test('fresh artifact activity keeps waiting even past threshold (no false-fire while planner is actively writing)', () => {
    assert.equal(runShouldRecover(helpersBash, 99999, 10, 'false', 'true'), 'active');
  });

  test('default threshold (10 min) does not false-fire on a normal 1-5 minute planner run (AC3)', () => {
    // A normal run returns (marker_found=true) well before 300s (5 min).
    assert.equal(runShouldRecover(helpersBash, 300, 10, 'true', 'false'), 'marker_received');
    // And absent a marker, 5 minutes of pure silence is still "waiting", not "stalled".
    assert.equal(runShouldRecover(helpersBash, 300, 10, 'false', 'false'), 'waiting');
  });

  test('property — stalled iff elapsed seconds >= threshold minutes*60 (when no marker, no fresh activity)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 * 60 * 6 }),
        fc.integer({ min: 1, max: 120 }),
        (elapsedSeconds, thresholdMinutes) => {
          const result = runShouldRecover(helpersBash, elapsedSeconds, thresholdMinutes, 'false', 'false');
          const shouldStall = elapsedSeconds >= thresholdMinutes * 60;
          return shouldStall ? result === 'stalled' : result === 'waiting';
        },
      ),
      { numRuns: 25 },
    );
  });

  test('a malformed threshold_minutes value degrades to the safe default instead of crashing the watcher', (t) => {
    // A security review initially flagged this as a command-injection path
    // (bash arithmetic recursively re-evaluating a `$(cmd)`-shaped string).
    // Empirically disproven: bash's arithmetic evaluator hard-errors on such
    // an operand ("syntax error: operand expected") rather than invoking it —
    // verified directly against both macOS bash 3.2.57 and Docker bash:5; the
    // payload command never runs on either. The REAL risk this guard closes
    // is reliability, not RCE: without validation, a malformed
    // `planner.stall_threshold_minutes` config value would abort the
    // stall-watcher itself with that bash syntax error, silently defeating
    // the exact hang-recovery this issue exists to ship. Prove the function
    // degrades to a safe default instead of erroring.
    const marker = `gsd-2650-untouched-${process.pid}-${Date.now()}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-malformed-'));
    t.after(() => cleanup(tmp));
    const payload = `$(touch ${path.join(tmp, marker)})`;
    const result = runShouldRecover(helpersBash, 0, payload, 'false', 'false');
    // Must not error (proves the guard prevents the bash-abort), must not
    // have run the embedded command either way, and must fall back to the
    // safe default classification (threshold_minutes -> 10 -> elapsed 0 < 600 -> waiting).
    assert.equal(result, 'waiting');
    assert.equal(fs.existsSync(path.join(tmp, marker)), false, 'payload must not execute (also true without the guard — bash hard-errors on it instead)');
  });
});

describe('bug #2650 plan-phase stall detection — gsd_stall_watch (real execution, not just the pure classifier)', () => {
  // Sourcing the extracted script without `gsd_run` defined naturally exercises
  // the `|| echo "<default>"` fallback already in the config-get lines (command
  // lookup fails -> non-zero exit -> the `||` branch fires), so
  // PLANNER_STALL_INTERVAL_MINUTES/PLANNER_STALL_THRESHOLD_MINUTES start at their
  // real defaults (5/10) here; each test overrides them afterward for speed.
  let helpersBash;
  let tmp;

  test('loads helpers', () => {
    helpersBash = extractStallHelpersBash();
    assert.ok(helpersBash.includes('gsd_stall_watch()'));
  });

  // Routed through the shared runBashScript() helper (#2650 Windows CI —
  // see extractStallHelpersBash()'s doc comment for the full evidence
  // trail). The call line is still built with JSON.stringify exactly as
  // before — that part was never the problem and correctly keeps Windows
  // paths and the injection-guard payload intact; only the transport of
  // the script itself changes.
  function runWatch(intervalMinutes, thresholdMinutes, dispatchTs, outputFile, artifactGlob, markers) {
    const overrides = `PLANNER_STALL_INTERVAL_MINUTES=${intervalMinutes}\nPLANNER_STALL_THRESHOLD_MINUTES=${thresholdMinutes}\n`;
    const call = `gsd_stall_watch ${JSON.stringify(String(dispatchTs))} ${JSON.stringify(outputFile)} ${JSON.stringify(artifactGlob)}` +
      markers.map((m) => ` ${JSON.stringify(m)}`).join('');
    const script = `${helpersBash}\n${overrides}${call}\n`;
    return runBashScript(script, [], { timeout: 10000 });
  }

  test('marker present in the real output file (via real grep, interval=0 so sleep is instant) -> marker_received', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const outputFile = path.join(tmp, 'agent-output.txt');
    fs.writeFileSync(outputFile, 'some agent output\n## PLANNING COMPLETE\nmore text\n');
    const glob = `${tmp.replace(/\\/g, '/')}/*-PLAN.md`;
    const now = Math.floor(Date.now() / 1000);
    const result = runWatch(0, 10, now, outputFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'marker_received');
  });

  test('no marker, no output file, dispatch far in the past, threshold=0 (via real find/date, interval=0) -> stalled', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const missingOutputFile = path.join(tmp, 'never-written.txt');
    const glob = `${tmp.replace(/\\/g, '/')}/*-PLAN.md`; // the tmp dir contains no *-PLAN.md files -> no fresh activity
    const longAgo = Math.floor(Date.now() / 1000) - 999999;
    const result = runWatch(0, 0, longAgo, missingOutputFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'stalled');
  });

  test('marker absent, dispatch just now, non-zero threshold (via real find/date, interval=0) -> waiting', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const missingOutputFile = path.join(tmp, 'never-written.txt');
    const glob = `${tmp.replace(/\\/g, '/')}/*-PLAN.md`;
    const now = Math.floor(Date.now() / 1000);
    const result = runWatch(0, 10, now, missingOutputFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'waiting');
  });

  test('real `find ... -mmin` correctly detects a fresh artifact -> active (CR: BSD find -newermt "@epoch" is unparseable on macOS)', (t) => {
    // Regression for a production (not test-only) defect a review surfaced:
    // the shipped freshness check used to be `find $glob -newermt "@$(( ...
    // ))" ` — GNU find's "@<epoch>" shorthand for -newermt, which the
    // BSD find(1) actually shipped on macOS does NOT understand ("Can't
    // parse date/time: @<epoch>", verified live against /usr/bin/find). With
    // the `2>/dev/null` beside it, that failed silently and permanently
    // degraded artifact_fresh to "false" on every macOS run — a real
    // plan-checker or planner actively writing plan files could still be
    // reported "stalled". Fixed to `find $glob -mmin -N` ("modified less
    // than N minutes ago"), which needs no date-string parsing and is
    // supported identically by GNU find and BSD find.
    //
    // This runs the REAL shipped gsd_stall_watch (not a hand-copied
    // find invocation — see this file's header on Generative Fix
    // Divergence), with `sleep` shadowed to a no-op bash function so the
    // test does not actually wait a real PLANNER_STALL_INTERVAL_MINUTES;
    // the `find ... -mmin` line itself still executes for real. threshold
    // is set absurdly high so "stalled" cannot fire independently — the
    // ONLY path to "active" is a correctly-working freshness check.
    // Routed through runBashScript() (#2650 Windows CI) rather than a raw
    // `bash -c` call — this test builds its own script inline (the `sleep`
    // stub isn't something runWatch() supports), so it needs the same
    // transport seam explicitly rather than inheriting it for free.
    // Windows CR: production's own glob (plan-phase.md:895 et al.,
    // `"${PHASE_DIR}"'/*-PLAN.md'`) is always forward-slash — PHASE_DIR is a
    // POSIX-style `.planning/phases/NN-slug` value, never a native Windows
    // path, and this all runs under Git Bash regardless of host OS. This
    // test previously built the glob with `path.join(tmp, '*-PLAN.md')`,
    // which on Windows yields a backslash path
    // (`C:\Users\RUNNER~1\...\*-PLAN.md`). In bash pathname expansion a
    // backslash escapes the next character, so that pattern can never
    // match anything — `find` silently returned empty and the test failed
    // with 'waiting' instead of 'active'. Confirmed as a TEST artifact, not
    // a production defect: production never constructs the glob this way.
    // Fixed by forward-slashing the tmp dir before building the glob — the
    // same `.replace(/\\/g, '/')` idiom this repo already uses elsewhere —
    // so the test matches what production actually passes, while still
    // exercising the real shipped `find` line. Do not "simplify" this back
    // to a bare `path.join`; that silently reintroduces the failure.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-fresh-'));
    t.after(() => cleanup(tmp));
    fs.writeFileSync(path.join(tmp, 'x-PLAN.md'), 'freshly written\n');
    const glob = `${tmp.replace(/\\/g, '/')}/*-PLAN.md`;
    const missingOutputFile = path.join(tmp, 'never-written.txt');
    const now = Math.floor(Date.now() / 1000);
    const overrides = 'sleep() { :; }\nPLANNER_STALL_INTERVAL_MINUTES=1\nPLANNER_STALL_THRESHOLD_MINUTES=99999\n';
    const call = `gsd_stall_watch ${JSON.stringify(String(now))} ${JSON.stringify(missingOutputFile)} ${JSON.stringify(glob)}` +
      ` ${JSON.stringify('## PLANNING COMPLETE')}`;
    const script = `${helpersBash}\n${overrides}${call}\n`;
    const result = runBashScript(script, [], { timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'active');
  });
  // Note: this platform's real find(1) is exercised by the test above via a
  // stubbed `sleep`, not a real ~60s wait. The mtime-based transition is
  // ALSO covered deterministically at the pure-function level above
  // ("fresh artifact activity keeps waiting...") for the classification
  // logic downstream of a given artifact_fresh value.
});

describe('bug #2650 config schema — planner.stall_* keys mirror executor.stall_*', () => {
  test('config schemas register planner stall detector keys', () => {
    const { VALID_CONFIG_KEYS: cjsKeys } = require('../gsd-core/bin/lib/config-schema.cjs');
    const manifest = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_MANIFEST_PATH, 'utf-8'));
    const manifestKeys = new Set(manifest.validKeys);

    for (const key of ['planner.stall_detect_interval_minutes', 'planner.stall_threshold_minutes']) {
      assert.ok(cjsKeys.has(key), `CJS VALID_CONFIG_KEYS must include ${key}`);
      assert.ok(manifestKeys.has(key), `Manifest validKeys must include ${key} (SDK sources from manifest)`);
    }
  });

  test('configuration docs describe planner stall detector defaults', () => {
    const docs = fs.readFileSync(CONFIGURATION_DOCS_PATH, 'utf-8');
    assert.match(docs, /`planner\.stall_detect_interval_minutes`\s*\|\s*number\s*\|\s*`5`/);
    assert.match(docs, /`planner\.stall_threshold_minutes`\s*\|\s*number\s*\|\s*`10`/);
  });

  test('config-get returns schema defaults for planner stall detector keys', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-'));
    t.after(() => cleanup(tmp));
    fs.mkdirSync(path.join(tmp, '.planning'));
    fs.writeFileSync(path.join(tmp, '.planning/config.json'), '{}\n');

    const toolsPath = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
    const interval = toLegacyResult(runNode([toolsPath, 'config-get', 'planner.stall_detect_interval_minutes', '--raw'], { cwd: tmp, timeoutMs: PROBE_TIMEOUT_MS }));
    const threshold = toLegacyResult(runNode([toolsPath, 'config-get', 'planner.stall_threshold_minutes', '--raw'], { cwd: tmp, timeoutMs: PROBE_TIMEOUT_MS }));

    assert.equal(interval.status, 0, interval.stderr);
    assert.equal(interval.stdout.trim(), '5');
    assert.equal(threshold.status, 0, threshold.stderr);
    assert.equal(threshold.stdout.trim(), '10');
  });
});

describe('bug #2650 plan-phase — all five planner/plan-checker spawns dispatch in the background with bounded stall surveillance', () => {
  let workflow;

  test('loads', () => {
    workflow = readPlanPhase();
    assert.ok(workflow.length > 0);
  });

  test('plan-phase.md points at the lazily-loaded stall-detection-helpers.md step file (step 7.99)', () => {
    assert.match(workflow, /gsd-core\/workflows\/plan-phase\/steps\/stall-detection-helpers\.md/);
  });

  test('stall-detection-helpers.md resolves PLANNER_STALL_INTERVAL_MINUTES / PLANNER_STALL_THRESHOLD_MINUTES from config', () => {
    const helpersDoc = readStallHelpersDoc();
    assert.match(helpersDoc, /PLANNER_STALL_INTERVAL_MINUTES=.*planner\.stall_detect_interval_minutes/);
    assert.match(helpersDoc, /PLANNER_STALL_THRESHOLD_MINUTES=.*planner\.stall_threshold_minutes/);
  });

  test('standard planner spawn (step 8) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('## 8. Spawn gsd-planner Agent');
    assert.notEqual(idx, -1);
    // #2993 moved "## 8.5. Chunked Planning Mode" itself out of plan-phase.md
    // (now a <!-- gsd:section --> pointer to steps/chunked-planning-mode.md,
    // asserted separately below) — bound this slice at the next heading that
    // still actually exists in plan-phase.md instead.
    const nextSectionIdx = workflow.indexOf('## 9. Handle Planner Return', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'standard planner spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'standard planner spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/, 'standard planner spawn must bind {outputFile} into the stall watcher call, not a dead bash variable');
  });

  test('plan-phase.md points at the lazily-loaded chunked-planning-mode.md step file (8.5, #2993)', () => {
    // #2993 (epic #1671 Phase 6.2, unrelated to #2650) extracted the whole
    // "Chunked Planning Mode" section into gsd-core/workflows/plan-phase/steps/
    // chunked-planning-mode.md, leaving a <!-- gsd:section --> pointer behind.
    // The two stall-watch spawn sites that used to live inline (8.5.1 outline,
    // 8.5.2 per-plan) moved with it — asserted directly against that file below.
    assert.match(workflow, /gsd-core\/workflows\/plan-phase\/steps\/chunked-planning-mode\.md/);
  });

  test('chunked outline spawn (8.5.1) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    // Lives in the extracted steps/chunked-planning-mode.md since #2993, not
    // in plan-phase.md itself — read that file directly (see
    // readChunkedPlanningMode()'s doc comment for why not the generic
    // combined-blob reader).
    const chunkedDoc = readChunkedPlanningMode();
    const idx = chunkedDoc.indexOf('### 8.5.1 Outline Phase');
    assert.notEqual(idx, -1);
    const nextSectionIdx = chunkedDoc.indexOf('### 8.5.2 Per-Plan Tasks', idx);
    const section = chunkedDoc.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'chunked outline spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'chunked outline spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/, 'chunked outline spawn must bind {outputFile} into the stall watcher call, not a dead bash variable');
  });

  test('chunked per-plan spawn (8.5.2) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    // Same relocation as the outline spawn above (#2993) — read
    // steps/chunked-planning-mode.md directly. 8.5.2 is the LAST section in
    // that file, so an unbounded slice to EOF is precise here (unlike slicing
    // the generic multi-file combined blob, which would run on into whatever
    // step file sorts next after this one).
    const chunkedDoc = readChunkedPlanningMode();
    const idx = chunkedDoc.indexOf('### 8.5.2 Per-Plan Tasks');
    assert.notEqual(idx, -1);
    const section = chunkedDoc.slice(idx);
    assert.match(section, /run_in_background\s*=\s*true/, 'chunked per-plan spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'chunked per-plan spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/, 'chunked per-plan spawn must bind {outputFile} into the stall watcher call, not a dead bash variable');
  });

  test('plan-checker spawn (step 10) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('## 10. Spawn gsd-plan-checker Agent');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 11. Handle Checker Return', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'plan-checker spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'plan-checker spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/, 'plan-checker spawn must bind {outputFile} into the stall watcher call — this is the ONLY completion signal on a clean PASS, since a passing checker touches no *-PLAN.md files');
  });

  test('revision-loop planner respawn (step 12) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('## 12. Revision Loop');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 12.5. Plan Bounce', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'revision-loop planner respawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'revision-loop planner respawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/, 'revision-loop planner respawn must bind {outputFile} into the stall watcher call, not a dead bash variable');
  });

  test('no spawn site references an unbound $PLANNER_OUTPUT_FILE / $CHECKER_OUTPUT_FILE bash variable', () => {
    // Regression for the blocker an independent review found: the original
    // design named PLANNER_OUTPUT_FILE/CHECKER_OUTPUT_FILE as bash variables
    // in the gsd_stall_watch calls, but nothing in plan-phase.md ever ASSIGNED
    // them — with the variable permanently empty, `[ -f "$output_file" ]` is
    // always false, marker_found can never become true, and marker_received is
    // unreachable. Worse for the plan-checker spawn specifically: a checker
    // that PASSES touches no *-PLAN.md files, so it has NO working completion
    // signal at all without the marker path — a healthy, already-succeeded
    // checker would be reported as stalled. The fix replaces the dead bash
    // variable with the `{outputFile}` orchestrator-substitution token (the
    // same convention docs-update.md:471 already uses for a real
    // run_in_background=true Agent() return). This test proves the dead
    // variable name is gone from every spawn site, not just that
    // gsd_stall_watch behaves correctly when handed a valid argument
    // (tests/fix-2650-plan-phase-stall-detection.test.cjs's gsd_stall_watch
    // describe block below already covers that half — this covers the
    // production wiring the previous tests never exercised).
    assert.doesNotMatch(workflow, /\$PLANNER_OUTPUT_FILE\b/, 'plan-phase.md must not reference an unassigned $PLANNER_OUTPUT_FILE bash variable');
    assert.doesNotMatch(workflow, /\$CHECKER_OUTPUT_FILE\b/, 'plan-phase.md must not reference an unassigned $CHECKER_OUTPUT_FILE bash variable');
    // #2993 moved two of the five spawn sites into steps/chunked-planning-mode.md
    // — check there too, not just plan-phase.md, now that it's a separate file.
    const chunkedDoc = readChunkedPlanningMode();
    assert.doesNotMatch(chunkedDoc, /\$PLANNER_OUTPUT_FILE\b/, 'chunked-planning-mode.md must not reference an unassigned $PLANNER_OUTPUT_FILE bash variable');
    assert.doesNotMatch(chunkedDoc, /\$CHECKER_OUTPUT_FILE\b/, 'chunked-planning-mode.md must not reference an unassigned $CHECKER_OUTPUT_FILE bash variable');
  });

  test('exactly five gsd_stall_watch spawn-site invocations exist across plan-phase.md and its steps/*.md files', () => {
    // The whole point of #2650 is that EVERY planner/plan-checker spawn is
    // bounded — not "at least one". #2993 relocated two of the five call
    // sites (chunked outline, chunked per-plan) into
    // steps/chunked-planning-mode.md; this counts across the combined
    // surface so a future relocation can't silently drop a site without a
    // test noticing (mirrors tests/plan-phase-drift-guard.test.cjs's #913
    // ORCHESTRATOR RULE label count, which already does this).
    const combined = readWorkflowCombined(PLAN_PHASE_PATH);
    const callCount = (combined.match(/gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/g) || []).length;
    assert.equal(callCount, 5,
      `expected exactly 5 gsd_stall_watch "$TS" "{outputFile}" spawn-site invocations across plan-phase.md + steps/*.md, found ${callCount}`);
  });

  test('step 7.99 documents that {outputFile} must be bound from the real Agent() return (not passed literally)', () => {
    const idx = workflow.indexOf('## 7.99. Bounded Stall-Detection Helpers');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 8. Spawn gsd-planner Agent', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /\{outputFile\}/, 'step 7.99 must mention {outputFile} so a reader knows it is a binding token, not literal text');
    // The full binding contract (docs-update.md precedent, why a bash variable
    // does not work, and the plan-checker completion-signal implication) lives
    // in the lazily-loaded reference file to stay under the PRE_PHASE6 cap —
    // verify it is actually there, not just gestured at.
    const helpersDoc = readStallHelpersDoc();
    assert.match(helpersDoc, /\{outputFile\}/, 'stall-detection-helpers.md must explain the {outputFile} binding contract');
    assert.match(helpersDoc, /docs-update\.md/i, 'stall-detection-helpers.md must cite the docs-update.md precedent for {outputFile} substitution');
    assert.match(helpersDoc, /plan-checker/i, 'stall-detection-helpers.md must explain why binding {outputFile} is load-bearing for the plan-checker spawn specifically');
  });

  test('stall surveillance is not gated behind the teams-status guard (AC2)', () => {
    // The only actual `query teams-status` CALL in plan-phase.md must stay
    // scoped to the researcher spawn banner (its pre-existing, unrelated
    // purpose) — the new stall blocks must not add a second call site or make
    // their own behavior conditional on it. The helpers doc is allowed (and
    // expected) to name "teams-status" in prose explaining that independence
    // (AC2 self-documentation) — what must never appear is a SECOND `query
    // teams-status` invocation, or any conditional gating on its result.
    const teamsStatusCallOccurrences = workflow.split('query teams-status').length - 1;
    assert.equal(teamsStatusCallOccurrences, 1, 'teams-status guard must remain scoped to its single pre-existing call site');
    assert.doesNotMatch(readStallHelpersDoc(), /query teams-status/, 'stall-detection helpers must not add their own teams-status call site');
  });

  test('completion-marker contract is unchanged (AC4)', () => {
    for (const marker of ['## PLANNING COMPLETE', '## CHECKPOINT REACHED', '## VERIFICATION PASSED', '## ISSUES FOUND', '## PLANNING INCONCLUSIVE']) {
      assert.ok(workflow.includes(marker), `completion-marker contract must still include ${marker}`);
    }
  });

  test('researcher (line ~404) and pattern-mapper (line ~681) spawns are untouched (out of scope)', () => {
    const researcherIdx = workflow.indexOf('### Spawn gsd-phase-researcher');
    const patternMapperIdx = workflow.indexOf('## 7.8. Spawn gsd-pattern-mapper Agent');
    assert.notEqual(researcherIdx, -1);
    assert.notEqual(patternMapperIdx, -1);
    const researcherSection = workflow.slice(researcherIdx, workflow.indexOf('### Handle Researcher Return'));
    const patternMapperSection = workflow.slice(patternMapperIdx, workflow.indexOf('## 7.9. Regenerate API-SURFACE.md'));
    assert.doesNotMatch(researcherSection, /gsd_stall_watch/, 'researcher spawn must remain a plain blocking call (out of scope per Agent Brief)');
    assert.doesNotMatch(patternMapperSection, /gsd_stall_watch/, 'pattern-mapper spawn must remain a plain blocking call (out of scope per Agent Brief)');
  });
});
