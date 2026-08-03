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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const { cleanup, readFileNormalized } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PLAN_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const STALL_HELPERS_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'stall-detection-helpers.md');
const CONFIG_SCHEMA_MANIFEST_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json');
const CONFIGURATION_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'CONFIGURATION.md');

function readPlanPhase() {
  return readFileNormalized(PLAN_PHASE_PATH);
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
  // No CRLF normalization needed here: readStallHelpersDoc() reads through
  // helpers.cjs's readFileNormalized(), which strips \r\n -> \n at the read
  // boundary, before any slicing above runs. On a Windows checkout, an
  // un-normalized read would leave every extracted line carrying a trailing
  // \r; bash then treats that \r as part of the token, an opening quote never
  // finds its match, and the parser dies with "unexpected EOF while looking
  // for matching `"'" partway through the script (#2650 Windows CI — this is
  // the repo's recurring CRLF-in-extracted-source defect class, see #1700).
  return body;
}

/**
 * Run gsd_stall_should_recover with the given args inside the extracted
 * script and return its stdout (trimmed). No real sleeping happens — the
 * function is pure and synchronous.
 */
function runShouldRecover(helpersBash, elapsedSeconds, thresholdMinutes, markerFound, artifactFresh) {
  const script = `${helpersBash}\ngsd_stall_should_recover "$1" "$2" "$3" "$4"\n`;
  const result = spawnSync('bash', ['-c', script, 'gsd_stall_should_recover_test',
    String(elapsedSeconds), String(thresholdMinutes), String(markerFound), String(artifactFresh)], {
    encoding: 'utf-8',
  });
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

  function runWatch(intervalMinutes, thresholdMinutes, dispatchTs, outputFile, artifactGlob, markers) {
    const overrides = `PLANNER_STALL_INTERVAL_MINUTES=${intervalMinutes}\nPLANNER_STALL_THRESHOLD_MINUTES=${thresholdMinutes}\n`;
    const call = `gsd_stall_watch ${JSON.stringify(String(dispatchTs))} ${JSON.stringify(outputFile)} ${JSON.stringify(artifactGlob)}` +
      markers.map((m) => ` ${JSON.stringify(m)}`).join('');
    const script = `${helpersBash}\n${overrides}${call}\n`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 10000 });
  }

  test('marker present in the real output file (via real grep, interval=0 so sleep is instant) -> marker_received', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const outputFile = path.join(tmp, 'agent-output.txt');
    fs.writeFileSync(outputFile, 'some agent output\n## PLANNING COMPLETE\nmore text\n');
    const glob = path.join(tmp, '*-PLAN.md');
    const now = Math.floor(Date.now() / 1000);
    const result = runWatch(0, 10, now, outputFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'marker_received');
  });

  test('no marker, no output file, dispatch far in the past, threshold=0 (via real find/date, interval=0) -> stalled', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const missingOutputFile = path.join(tmp, 'never-written.txt');
    const glob = path.join(tmp, '*-PLAN.md'); // matches nothing -> no fresh activity
    const longAgo = Math.floor(Date.now() / 1000) - 999999;
    const result = runWatch(0, 0, longAgo, missingOutputFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'stalled');
  });

  test('marker absent, dispatch just now, non-zero threshold (via real find/date, interval=0) -> waiting', (t) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2650-watch-'));
    t.after(() => cleanup(tmp));
    const missingOutputFile = path.join(tmp, 'never-written.txt');
    const glob = path.join(tmp, '*-PLAN.md');
    const now = Math.floor(Date.now() / 1000);
    const result = runWatch(0, 10, now, missingOutputFile, glob, ['## PLANNING COMPLETE']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'waiting');
  });
  // Note: the mtime-based "fresh artifact activity -> active" transition is
  // deliberately NOT integration-tested against a real clock here (it would
  // require either a real ~60s sleep to get a reliable -newermt window, which
  // is too slow for this suite, or a sub-minute window at the mercy of
  // whole-second `date +%s` truncation, which is flaky by construction — see
  // "No flaky races" policy). That transition IS covered deterministically at
  // the pure-function level above ("fresh artifact activity keeps waiting...").
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
    const interval = spawnSync(process.execPath, [toolsPath, 'config-get', 'planner.stall_detect_interval_minutes', '--raw'], { cwd: tmp, encoding: 'utf-8' });
    const threshold = spawnSync(process.execPath, [toolsPath, 'config-get', 'planner.stall_threshold_minutes', '--raw'], { cwd: tmp, encoding: 'utf-8' });

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
    const nextSectionIdx = workflow.indexOf('## 8.5. Chunked Planning Mode', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'standard planner spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'standard planner spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/, 'standard planner spawn must bind {outputFile} into the stall watcher call, not a dead bash variable');
  });

  test('chunked outline spawn (8.5.1) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('### 8.5.1 Outline Phase');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('### 8.5.2 Per-Plan Tasks', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'chunked outline spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'chunked outline spawn must invoke the bounded stall watcher');
    assert.match(section, /gsd_stall_watch\s+"\$TS"\s+"\{outputFile\}"/, 'chunked outline spawn must bind {outputFile} into the stall watcher call, not a dead bash variable');
  });

  test('chunked per-plan spawn (8.5.2) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('### 8.5.2 Per-Plan Tasks');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 9. Handle Planner Return', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
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
