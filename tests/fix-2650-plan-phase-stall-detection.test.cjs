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
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PLAN_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const STALL_HELPERS_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'stall-detection-helpers.md');
const CONFIG_SCHEMA_MANIFEST_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json');
const CONFIGURATION_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'CONFIGURATION.md');

function readPlanPhase() {
  return fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
}

function readStallHelpersDoc() {
  return fs.readFileSync(STALL_HELPERS_PATH, 'utf-8');
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
  });

  test('chunked outline spawn (8.5.1) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('### 8.5.1 Outline Phase');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('### 8.5.2 Per-Plan Tasks', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'chunked outline spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'chunked outline spawn must invoke the bounded stall watcher');
  });

  test('chunked per-plan spawn (8.5.2) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('### 8.5.2 Per-Plan Tasks');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 9. Handle Planner Return', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'chunked per-plan spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'chunked per-plan spawn must invoke the bounded stall watcher');
  });

  test('plan-checker spawn (step 10) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('## 10. Spawn gsd-plan-checker Agent');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 11. Handle Checker Return', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'plan-checker spawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'plan-checker spawn must invoke the bounded stall watcher');
  });

  test('revision-loop planner respawn (step 12) dispatches with run_in_background=true and calls gsd_stall_watch', () => {
    const idx = workflow.indexOf('## 12. Revision Loop');
    assert.notEqual(idx, -1);
    const nextSectionIdx = workflow.indexOf('## 12.5. Plan Bounce', idx);
    const section = workflow.slice(idx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
    assert.match(section, /run_in_background\s*=\s*true/, 'revision-loop planner respawn must set run_in_background=true');
    assert.match(section, /gsd_stall_watch/, 'revision-loop planner respawn must invoke the bounded stall watcher');
  });

  test('stall surveillance is not gated behind the teams-status guard (AC2)', () => {
    // The only `query teams-status` call in plan-phase.md must stay scoped to
    // the researcher spawn banner (its pre-existing, unrelated purpose) — the
    // new stall blocks (and the helpers they call) must not reference or
    // depend on it.
    const teamsStatusOccurrences = workflow.split('query teams-status').length - 1;
    assert.equal(teamsStatusOccurrences, 1, 'teams-status guard must remain scoped to its single pre-existing call site');
    assert.doesNotMatch(readStallHelpersDoc(), /teams-status/, 'stall-detection helpers must not reference the teams-status guard');
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
