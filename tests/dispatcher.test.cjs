/**
 * GSD Tools Tests - Dispatcher
 *
 * Tests for gsd-tools.cjs dispatch routing and error paths.
 * Covers: no-command, unknown command, unknown subcommands for every command group,
 * --cwd parsing, and previously untouched routing branches.
 *
 * Requirements: DISP-01, DISP-02
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Dispatcher Error Paths ──────────────────────────────────────────────────

describe('dispatcher error paths', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // No command
  test('no-command invocation prints usage and exits non-zero', () => {
    const result = runGsdTools('', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Usage:'), `Expected "Usage:" in stderr, got: ${result.error}`);
  });

  // Unknown command
  test('unknown command produces clear error and exits non-zero', () => {
    const result = runGsdTools('nonexistent-cmd', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown command'), `Expected "Unknown command" in stderr, got: ${result.error}`);
  });

  // --cwd= form with valid directory
  test('--cwd= form overrides working directory', () => {
    // Create STATE.md in tmpDir so state load can find it
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\n'
    );
    const result = runGsdTools(['--cwd=' + tmpDir, 'state', 'load'], process.cwd());
    assert.strictEqual(result.success, true, `Should succeed with --cwd=, got: ${result.error}`);
  });

  // --cwd= with empty value
  test('--cwd= with empty value produces error', () => {
    const result = runGsdTools('--cwd= state load', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Missing value for --cwd'), `Expected "Missing value for --cwd" in stderr, got: ${result.error}`);
  });

  // --cwd with nonexistent path
  test('--cwd with invalid path produces error', () => {
    const result = runGsdTools('--cwd /nonexistent/path/xyz state load', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Invalid --cwd'), `Expected "Invalid --cwd" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: state
  test('state unknown subcommand errors', () => {
    const result = runGsdTools('state bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown state subcommand'), `Expected "Unknown state subcommand" in stderr, got: ${result.error}`);
    // Pin the enumerated subcommand list. If a future refactor reformats the
    // error string and silently drops 'complete-phase' from the available list,
    // this test fails loudly rather than passing on the substring above.
    // CodeRabbit nitpick on PR #2761.
    assert.ok(
      result.error.includes('complete-phase'),
      `Expected enumerated subcommands to include "complete-phase", got: ${result.error}`,
    );
  });

  // Unknown subcommand: template
  test('template unknown subcommand errors', () => {
    const result = runGsdTools('template bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown template subcommand'), `Expected "Unknown template subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: frontmatter
  test('frontmatter unknown subcommand errors', () => {
    const result = runGsdTools('frontmatter bogus file.md', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown frontmatter subcommand'), `Expected "Unknown frontmatter subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: verify
  test('verify unknown subcommand errors', () => {
    const result = runGsdTools('verify bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown verify subcommand'), `Expected "Unknown verify subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: phases
  test('phases unknown subcommand errors', () => {
    const result = runGsdTools('phases bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown phases subcommand'), `Expected "Unknown phases subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: roadmap
  test('roadmap unknown subcommand errors', () => {
    const result = runGsdTools('roadmap bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown roadmap subcommand'), `Expected "Unknown roadmap subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: requirements
  test('requirements unknown subcommand errors', () => {
    const result = runGsdTools('requirements bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown requirements subcommand'), `Expected "Unknown requirements subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: phase
  test('phase unknown subcommand errors', () => {
    const result = runGsdTools('phase bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown phase subcommand'), `Expected "Unknown phase subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: milestone
  test('milestone unknown subcommand errors', () => {
    const result = runGsdTools('milestone bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown milestone subcommand'), `Expected "Unknown milestone subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: validate
  test('validate unknown subcommand errors', () => {
    const result = runGsdTools('validate bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown validate subcommand'), `Expected "Unknown validate subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: todo
  test('todo unknown subcommand errors', () => {
    const result = runGsdTools('todo bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown todo subcommand'), `Expected "Unknown todo subcommand" in stderr, got: ${result.error}`);
  });

  test('uat unknown subcommand errors', () => {
    const result = runGsdTools('uat bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown uat subcommand'), `Expected "Unknown uat subcommand" in stderr, got: ${result.error}`);
  });

  // Unknown subcommand: init
  test('init unknown workflow errors', () => {
    const result = runGsdTools('init bogus', tmpDir);
    assert.strictEqual(result.success, false, 'Should exit non-zero');
    assert.ok(result.error.includes('Unknown init workflow'), `Expected "Unknown init workflow" in stderr, got: ${result.error}`);
  });
});

// ─── --project-dir (#3881) ────────────────────────────────────────────────────
//
// docs/CONFIGURATION.md's "Project-Root Resolution in Multi-Repo Workspaces"
// section documents an explicit `--project-dir /path/to/workspace` flag that
// is "idempotent under this resolution" — i.e. it names the project root
// directly and skips findProjectRoot's ancestor walk-up entirely. Before this
// fix the flag was documented but wired nowhere: `state json --project-dir
// <abs>` run from an unrelated cwd silently resolved from cwd instead and
// returned `{"error":"STATE.md not found"}`.

const MARKER_3881 = 'PROJECT-B-MARKER-3881';

function writeMarkedState3881(projectDir, marker) {
  fs.writeFileSync(
    path.join(projectDir, '.planning', 'STATE.md'),
    `---
gsd_state_version: 1.0
current_phase: 01
status: paused
stopped_at: ${marker}
---

# Project State

**Current Phase:** 01
**Status:** Paused
`
  );
}

describe('#3881: --project-dir honors the documented explicit override', () => {
  test('absolute --project-dir from an unrelated cwd operates on the named project', () => {
    const projectA = createTempProject('fix-3881-a-'); // unrelated cwd; no STATE.md
    const projectB = createTempProject('fix-3881-b-');
    writeMarkedState3881(projectB, MARKER_3881);

    try {
      const result = runGsdTools(['state', 'json', '--project-dir', projectB], projectA);
      assert.ok(result.success, `expected success, got: ${result.error || result.output}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(
        output.stopped_at,
        MARKER_3881,
        "must read STATE.md from --project-dir's project, not from cwd (projectA has no STATE.md at all)"
      );
    } finally {
      cleanup(projectA);
      cleanup(projectB);
    }
  });

  test('relative --project-dir resolves against cwd', () => {
    const projectA = createTempProject('fix-3881-a-');
    // createTempProject mkdtemps under os.tmpdir(), so projectA and projectB
    // are siblings — a relative path from A to B is well-formed.
    const projectB = createTempProject('fix-3881-b-');
    writeMarkedState3881(projectB, MARKER_3881);

    try {
      const relative = path.relative(projectA, projectB);
      const result = runGsdTools(['state', 'json', '--project-dir', relative], projectA);
      assert.ok(result.success, `expected success, got: ${result.error || result.output}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.stopped_at, MARKER_3881, 'relative --project-dir must resolve against cwd (projectA)');
    } finally {
      cleanup(projectA);
      cleanup(projectB);
    }
  });

  test('nonexistent --project-dir path errors with non-zero exit', () => {
    const projectA = createTempProject('fix-3881-a-');
    try {
      const nonexistent = path.join(projectA, 'does-not-exist-3881');
      const result = runGsdTools(['state', 'json', '--project-dir', nonexistent], projectA);
      assert.strictEqual(result.success, false, 'a nonexistent --project-dir must be a non-zero exit, not a silent fallback');
      assert.match(result.error || '', /Invalid --project-dir/, 'error must name the invalid flag/path');
    } finally {
      cleanup(projectA);
    }
  });

  test('--project-dir path with no .planning/ errors with non-zero exit', () => {
    const projectA = createTempProject('fix-3881-a-');
    const bareDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fix-3881-bare-'));
    try {
      const result = runGsdTools(['state', 'json', '--project-dir', bareDir], projectA);
      assert.strictEqual(result.success, false, 'a --project-dir with no .planning/ must be a non-zero exit, not a silent wrong-project resolve');
      assert.match(result.error || '', /Invalid --project-dir/, 'error must name the invalid flag/path');
    } finally {
      cleanup(projectA);
      cleanup(bareDir);
    }
  });

  test('without --project-dir, behavior is unchanged (cwd-relative resolution still applies)', () => {
    const projectB = createTempProject('fix-3881-b-');
    writeMarkedState3881(projectB, MARKER_3881);
    try {
      const result = runGsdTools(['state', 'json'], projectB);
      assert.ok(result.success, `expected success, got: ${result.error || result.output}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.stopped_at, MARKER_3881, 'no-flag invocation must still resolve from cwd exactly as before');
    } finally {
      cleanup(projectB);
    }
  });
});

// ─── Dispatcher Routing Branches ─────────────────────────────────────────────

describe('dispatcher routing branches', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // find-phase
  test('find-phase locates phase directory by number', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('find-phase 01', tmpDir);
    assert.strictEqual(result.success, true, `find-phase failed: ${result.error}`);
    assert.ok(result.output.includes('01-test-phase'), `Expected output to contain "01-test-phase", got: ${result.output}`);
  });

  // init resume
  test('init resume returns valid JSON', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\nPlan: 01-01 complete\nStatus: Ready\nLast activity: 2026-01-01\n\nProgress: [##########] 100%\n\n## Session Continuity\n\nLast session: 2026-01-01\nStopped at: Test\nResume file: None\n'
    );

    const result = runGsdTools('init resume', tmpDir);
    assert.strictEqual(result.success, true, `init resume failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(typeof parsed === 'object', 'Output should be valid JSON object');
  });

  // init verify-work
  test('init verify-work returns valid JSON', () => {
    // Create STATE.md
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\nPlan: 01-01 complete\nStatus: Ready\nLast activity: 2026-01-01\n\nProgress: [##########] 100%\n\n## Session Continuity\n\nLast session: 2026-01-01\nStopped at: Test\nResume file: None\n'
    );

    // Create ROADMAP.md with phase section
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone: v1.0 Test\n\n### Phase 1: Test Phase\n**Goal**: Test goal\n**Depends on**: None\n**Requirements**: TEST-01\n**Success Criteria**:\n  1. Tests pass\n**Plans**: 1 plan\nPlans:\n- [x] 01-01-PLAN.md\n\n## Progress\n\n| Phase | Plans | Status | Date |\n|-------|-------|--------|------|\n| 1 | 1/1 | Complete | 2026-01-01 |\n'
    );

    // Create phase dir
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('init verify-work 01', tmpDir);
    assert.strictEqual(result.success, true, `init verify-work failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(typeof parsed === 'object', 'Output should be valid JSON object');
  });

  // roadmap update-plan-progress
  test('roadmap update-plan-progress updates phase progress', () => {
    // Create ROADMAP.md with progress table
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone: v1.0 Test\n\n### Phase 1: Test Phase\n**Goal**: Test goal\n**Depends on**: None\n**Requirements**: TEST-01\n**Success Criteria**:\n  1. Tests pass\n**Plans**: 1 plan\nPlans:\n- [ ] 01-01-PLAN.md\n\n## Progress\n\n| Phase | Plans | Status | Date |\n|-------|-------|--------|------|\n| 1 | 0/1 | Not Started | - |\n'
    );

    // Create phase dir with PLAN and SUMMARY
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-test-phase\nplan: "01"\n---\n\n# Plan\n'
    );
    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      '---\nphase: 01-test-phase\nplan: "01"\n---\n\n# Summary\n'
    );

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.strictEqual(result.success, true, `roadmap update-plan-progress failed: ${result.error}`);
  });

  // state (no subcommand) — default load
  test('state with no subcommand calls cmdStateLoad', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\nPlan: 01-01 complete\nStatus: Ready\nLast activity: 2026-01-01\n\nProgress: [##########] 100%\n\n## Session Continuity\n\nLast session: 2026-01-01\nStopped at: Test\nResume file: None\n'
    );

    const result = runGsdTools('state', tmpDir);
    assert.strictEqual(result.success, true, `state load failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(typeof parsed === 'object', 'Output should be valid JSON object');
  });

  // summary-extract
  test('summary-extract parses SUMMARY.md frontmatter', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    const summaryContent = `---
phase: 01-test
plan: "01"
subsystem: testing
tags: [node, test]
duration: 5min
completed: "2026-01-01"
key-decisions:
  - "Used node:test"
requirements-completed: [TEST-01]
---

# Phase 1 Plan 01: Test Summary

**Tests added for core module**
`;

    const summaryPath = path.join(phaseDir, '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, summaryContent);

    // Use relative path from tmpDir
    const result = runGsdTools(`summary-extract .planning/phases/01-test/01-01-SUMMARY.md`, tmpDir);
    assert.strictEqual(result.success, true, `summary-extract failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.ok(typeof parsed === 'object', 'Output should be valid JSON object');
    assert.strictEqual(parsed.path, '.planning/phases/01-test/01-01-SUMMARY.md', 'Path should match input');
    assert.deepStrictEqual(parsed.requirements_completed, ['TEST-01'], 'requirements_completed should contain TEST-01');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3019-help-passthrough.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3019-help-passthrough (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression test for bug #3019.
 *
 * `gsd-sdk query <subcommand> --help` returned the top-level SDK USAGE
 * instead of contextual help for the subcommand. The query argv parser
 * harvested --help as a global flag and main() short-circuited dispatch
 * before the registry handler / gsd-tools.cjs fallback could render
 * useful help.
 *
 * Two-layer fix:
 *   1. sdk/src/cli.ts  — leave --help in queryArgv so it travels to the
 *      handler/fallback. Only honor the global help flag when there is
 *      no subcommand to dispatch to.
 *   2. gsd-core/bin/gsd-tools.cjs — render the top-level usage on
 *      --help instead of erroring. Anti-hallucination invariant from
 *      #1818 is preserved (the destructive command never executes).
 *
 * Tests the integration: invoke gsd-tools.cjs the same way the SDK
 * dispatcher does and assert structured-IR (success flag + usage shape)
 * rather than raw substring matches.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { runGsdTools, isUsageOutput } = require('./helpers.cjs');

// #3026 CR (Major outside-diff): the SDK fallback wraps gsd-tools.cjs.
// When gsd-tools emits plain-text help (exit 0), the SDK previously
// JSON.parsed stdout and threw "Unexpected token 'U'". Verify the fix
// by invoking the built SDK end-to-end and asserting:
//   - exit 0
//   - stdout contains the gsd-tools usage
//   - stderr does NOT contain a JSON parse error
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SDK_CLI = path.join(__dirname, '..', 'sdk', 'dist', 'cli.js');
const fs = require('node:fs');

describe('bug #3026 (CR Major outside-diff): SDK forwards plain-text help from gsd-tools fallback', () => {
  test('gsd-sdk query phase --help (fallback path) returns usage, not a JSON parse error', (t) => {
    if (!fs.existsSync(SDK_CLI)) {
      // CR feedback (#3026): a bare `return` here silent-passes the test
      // when sdk/dist/cli.js is absent (CI checkouts that haven't run
      // `npm run build`), giving no signal that the integration check
      // was skipped. Use t.skip() so the omission is visible in the
      // test report. The unit-level fix is covered by vitest on
      // sdk/src/cli.ts; this integration test only runs when the
      // built SDK is on disk.
      t.skip('sdk/dist/cli.js not built — run `npm run build` in sdk/ to enable this integration test');
      return;
    }
    // `query phase --help` (no further subcommand) is NOT in the native
    // registry, so it routes through the gsd-tools.cjs fallback. That is
    // the path that JSON.parsed the help text and threw before this fix.
    const result = spawnSync(process.execPath, [SDK_CLI, 'query', 'phase', '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    // The fallback gsd-tools.cjs emits exit 0 with usage on stdout.
    assert.strictEqual(result.status, 0,
      `must exit 0 — got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    // Negative: must NOT see the JSON parse error that was the regression.
    assert.ok(!/Unexpected token|not valid JSON/i.test(result.stderr),
      `must NOT JSON.parse the help text (stderr): ${result.stderr}`);
    // Positive: the usage should reach the user via stdout.
    assert.ok(/Usage:\s*gsd-tools/.test(result.stdout) && /Commands:/.test(result.stdout),
      `usage must reach stdout: ${result.stdout}`);
  });
});

describe('bug #3019: gsd-tools renders usage on --help instead of erroring', () => {
  test('bare gsd-tools (no args) renders usage', () => {
    const result = runGsdTools([]);
    // No args path: error() helper emits to stderr and exits non-zero,
    // but the message body is the usage.
    assert.strictEqual(result.success, false);
    assert.ok(/Usage:\s*gsd-tools/.test(result.error));
    assert.ok(/Commands:/.test(result.error));
  });

  test('gsd-tools --help renders usage on stdout, exits 0', () => {
    const result = runGsdTools(['--help']);
    assert.strictEqual(result.success, true, '--help should not be an error');
    assert.ok(isUsageOutput(result.output), `expected usage on stdout, got: ${result.output}`);
  });

  test('gsd-tools -h renders usage on stdout, exits 0', () => {
    const result = runGsdTools(['-h']);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
  });

  test('gsd-tools <subcommand> --help renders usage (does not run subcommand)', () => {
    // The classic #3019 surface: the user types a subcommand expecting
    // contextual help. We render the top-level usage — strictly better
    // than the previous unhelpful "Unknown flag --help" error.
    const result = runGsdTools(['phase', 'add', '--help']);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
  });

  test('usage hint mentions how to discover argument requirements', () => {
    // The usage now points users at the discovery method that actually works
    // (run without args → error message names required arguments). Asserting
    // on the parsed shape of the usage rather than substring-matching prose:
    const result = runGsdTools(['--help']);
    assert.strictEqual(result.success, true);
    // Structural check: split into sections.
    const lines = result.output.split('\n');
    const hasUsageLine = lines.some((l) => l.startsWith('Usage:'));
    const hasCommandsLine = lines.some((l) => l.startsWith('Commands:'));
    const hasDiscoveryHint = lines.some((l) => /argument requirements|without args|invoke the command/i.test(l));
    assert.ok(hasUsageLine, 'first section: Usage');
    assert.ok(hasCommandsLine, 'second section: Commands');
    assert.ok(hasDiscoveryHint, 'third section: how to discover per-command args');
  });
});
  });
}
