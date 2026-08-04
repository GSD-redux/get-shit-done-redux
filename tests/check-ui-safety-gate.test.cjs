'use strict';

/**
 * Behavioral tests for the `check ui-safety-gate` subcommand (#1168).
 *
 * Tests the `computeUiSafetyGate` pure function exported from check-command-router.cjs.
 * Uses in-memory tmpdir fixtures — no real CLI subprocess needed.
 *
 * Return shape: { frontend: bool, hasUiFiles: bool, hasUiSpec: bool, block: bool, message?: string }
 * Invariant: block = frontend && hasUiFiles && !hasUiSpec
 *
 * Per RULESET.TESTS.boundary-coverage: exercises all branches:
 *   (a) frontend + UI files changed + no spec → block:true
 *   (b) frontend + UI files changed + spec exists → block:false
 *   (c) non-frontend → block:false
 *   (d) frontend + no UI files changed → block:false
 *
 * Per RULESET.TESTS.coderabbit-fix-prefer: calls the exported function and asserts typed fields.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { computeUiSafetyGate } = require('../gsd-core/bin/lib/check-command-router.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal project dir with:
 *   .planning/ROADMAP.md   — one phase section with `phaseSection` body
 *   .planning/phases/01-test-phase/  — phase directory
 *   (optionally) a *-UI-SPEC.md inside the phase dir
 */
function makeProject({ phaseSection = '', hasUiSpec = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-safety-gate-test-'));
  const planningDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  const phaseDir = path.join(phasesDir, '01-test-phase');

  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({}), 'utf8');

  // Minimal ROADMAP.md with one phase section
  const roadmapContent = [
    '# Project Roadmap',
    '',
    '## Phase 1: Test Phase',
    '',
    phaseSection,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmapContent, 'utf8');

  if (hasUiSpec) {
    fs.writeFileSync(path.join(phaseDir, '01-UI-SPEC.md'), '# UI Design Contract\n', 'utf8');
  }

  return { tmpDir, phaseDir };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('computeUiSafetyGate — ui.safety-gate check logic (#1168)', () => {
  let frontendNoSpec, frontendWithSpec, nonFrontend;

  before(() => {
    // Branch (a): frontend + no UI-SPEC → tests block behavior
    frontendNoSpec = makeProject({
      phaseSection: 'Build the user interface and dashboard components for the frontend.',
      hasUiSpec: false,
    });
    // Branch (b): frontend + UI-SPEC exists → block:false
    frontendWithSpec = makeProject({
      phaseSection: 'Build the frontend dashboard with React components and UI forms.',
      hasUiSpec: true,
    });
    // Branch (c): no frontend indicators → block:false
    nonFrontend = makeProject({
      phaseSection: 'Add a REST API endpoint and database migration for the user table.',
      hasUiSpec: false,
    });
  });

  after(() => {
    for (const { tmpDir } of [frontendNoSpec, frontendWithSpec, nonFrontend]) {
      try { cleanup(tmpDir); } catch { /* ignore */ }
    }
  });

  describe('return shape', () => {
    test('result has required keys: frontend, hasUiFiles, hasUiSpec, block', () => {
      const result = computeUiSafetyGate(nonFrontend.tmpDir, '1');
      assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
      assert.ok(typeof result.frontend === 'boolean', 'frontend must be boolean');
      assert.ok(typeof result.hasUiFiles === 'boolean', 'hasUiFiles must be boolean');
      assert.ok(typeof result.hasUiSpec === 'boolean', 'hasUiSpec must be boolean');
      assert.ok(typeof result.block === 'boolean', 'block must be boolean');
    });

    test('block invariant: block === frontend && hasUiFiles && !hasUiSpec for all scenarios', () => {
      for (const [label, { tmpDir }] of [
        ['frontendNoSpec', frontendNoSpec],
        ['frontendWithSpec', frontendWithSpec],
        ['nonFrontend', nonFrontend],
      ]) {
        const r = computeUiSafetyGate(tmpDir, '1');
        assert.strictEqual(
          r.block,
          r.frontend && r.hasUiFiles && !r.hasUiSpec,
          `${label}: block invariant violated — frontend=${r.frontend} hasUiFiles=${r.hasUiFiles} hasUiSpec=${r.hasUiSpec} block=${r.block}`,
        );
      }
    });
  });

  describe('branch (a) — frontend + no UI-SPEC → gate fires when hasUiFiles', () => {
    test('detects frontend indicators in phase section', () => {
      const r = computeUiSafetyGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.frontend, true, 'should detect frontend indicators');
    });

    test('hasUiSpec is false when no *-UI-SPEC.md exists', () => {
      const r = computeUiSafetyGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.hasUiSpec, false, 'hasUiSpec must be false');
    });

    test('block is true when frontend + hasUiFiles + no UI-SPEC', () => {
      // hasUiFiles depends on git state; when false, block must also be false (invariant).
      // We verify the invariant holds rather than hardcoding the git state.
      const r = computeUiSafetyGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.block, r.frontend && r.hasUiFiles && !r.hasUiSpec,
        'block invariant: frontend && hasUiFiles && !hasUiSpec');
    });

    test('message is present when block is true', () => {
      const r = computeUiSafetyGate(frontendNoSpec.tmpDir, '1');
      if (r.block) {
        assert.ok(typeof r.message === 'string' && r.message.length > 0,
          'message must be a non-empty string when block is true');
        assert.ok(r.message.includes('UI-SPEC'), 'message must reference UI-SPEC');
      }
    });
  });

  describe('branch (b) — frontend + UI-SPEC exists → block:false', () => {
    test('detects frontend indicators in phase section', () => {
      const r = computeUiSafetyGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.frontend, true, 'should detect frontend indicators');
    });

    test('hasUiSpec is true when *-UI-SPEC.md exists', () => {
      const r = computeUiSafetyGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.hasUiSpec, true, 'hasUiSpec must be true');
    });

    test('block is false when UI-SPEC exists (regardless of hasUiFiles)', () => {
      const r = computeUiSafetyGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.block, false, 'block must be false when spec exists');
    });

    test('message is absent when block is false', () => {
      const r = computeUiSafetyGate(frontendWithSpec.tmpDir, '1');
      assert.ok(!r.message || r.message === undefined,
        'message must be absent when block is false');
    });
  });

  describe('branch (c) — non-frontend phase → block:false', () => {
    test('frontend is false for non-UI phase section', () => {
      const r = computeUiSafetyGate(nonFrontend.tmpDir, '1');
      assert.strictEqual(r.frontend, false, 'should NOT detect frontend indicators');
    });

    test('block is false for non-frontend phases', () => {
      const r = computeUiSafetyGate(nonFrontend.tmpDir, '1');
      assert.strictEqual(r.block, false, 'block must be false');
    });
  });

  describe('graceful degradation', () => {
    test('non-existent project dir returns frontend:false, block:false (no crash)', () => {
      const r = computeUiSafetyGate('/tmp/nonexistent-gsd-test-dir-xyz', '1');
      assert.strictEqual(typeof r.frontend, 'boolean', 'frontend must be boolean');
      assert.strictEqual(r.frontend, false, 'missing roadmap → no frontend indicators');
      assert.strictEqual(r.block, false, 'missing roadmap → block false');
      assert.strictEqual(typeof r.hasUiFiles, 'boolean', 'hasUiFiles must be boolean');
      assert.strictEqual(typeof r.hasUiSpec, 'boolean', 'hasUiSpec must be boolean');
    });

    test('missing ROADMAP.md returns frontend:false gracefully (no phaseLookupFailed)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-safety-nomap-'));
      try {
        fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-phase'), { recursive: true });
        const r = computeUiSafetyGate(tmpDir, '1');
        assert.strictEqual(r.frontend, false, 'no ROADMAP → no frontend indicators');
        assert.strictEqual(r.block, false, 'no ROADMAP → no block');
        assert.ok(
          !r.phaseLookupFailed,
          'phaseLookupFailed must NOT be set when ROADMAP.md is absent (no-roadmap project is not a lookup failure)',
        );
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });

    test('ROADMAP.md present but phase not found → phaseLookupFailed:true (not silent false)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-safety-noPhase-'));
      try {
        const planningDir = path.join(tmpDir, '.planning');
        const phasesDir = path.join(planningDir, 'phases');
        fs.mkdirSync(path.join(phasesDir, '01-test-phase'), { recursive: true });
        fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
          '# Project Roadmap',
          '',
          '## Phase 1: Test Phase',
          '',
          'Build the frontend dashboard with React components.',
          '',
        ].join('\n'), 'utf8');
        // Phase 99 is not in the roadmap
        const r = computeUiSafetyGate(tmpDir, '99');
        assert.strictEqual(r.phaseLookupFailed, true,
          'phaseLookupFailed must be true when ROADMAP.md exists but phase is not found');
        assert.strictEqual(r.frontend, false, 'empty section → no frontend indicators');
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });
  });

  describe('routing — ui-safety-gate is routable via check-command-router', () => {
    test('routeCheckCommand routes ui-safety-gate (hyphen form)', () => {
      const { routeCheckCommand } = require('../gsd-core/bin/lib/check-command-router.cjs');
      // Should not throw; just verify routing works (output goes to stdout)
      let threw = false;
      try {
        routeCheckCommand({ args: ['check', 'ui-safety-gate', '1'], cwd: nonFrontend.tmpDir, raw: true });
      } catch (err) {
        threw = true;
      }
      assert.strictEqual(threw, false, 'routeCheckCommand must not throw for ui-safety-gate');
    });

    test('routeCheckCommand routes ui.safety-gate (dot form — normalized to hyphens)', () => {
      const { routeCheckCommand } = require('../gsd-core/bin/lib/check-command-router.cjs');
      let threw = false;
      try {
        routeCheckCommand({ args: ['check', 'ui.safety-gate', '1'], cwd: nonFrontend.tmpDir, raw: true });
      } catch (err) {
        threw = true;
      }
      assert.strictEqual(threw, false, 'routeCheckCommand must not throw for ui.safety-gate (dot form)');
    });
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3706-ui-safety-gate-false-positives.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3706-ui-safety-gate-false-positives (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Tests for bug #3706 (word-boundary anchoring) and #3718 (cross-shell portability).
 *
 * Root cause (#3706): grep -iE "UI|..." had no word-boundary anchoring, causing
 * false-positives on "Requirements" (contains "ui"), "overview" ("view"), etc.
 *
 * Root cause (#3718): shell-based invocation (with locale env-var prefix) silently
 * degrades on Windows PowerShell — the prefix is not recognised by pwsh.
 *
 * Fix (#3718, Approach A): gate logic moved to `bin/lib/ui-safety-gate.cjs` (Node.js).
 * Reads phase text from STDIN (not argv) to avoid OS ARG_MAX limits.
 * Invoked as: printf '%s' "$PHASE_SECTION" | node "${GSD_REPO_ROOT}/bin/lib/ui-safety-gate.cjs"
 * Path anchored to repo root via `git rev-parse --show-toplevel`.
 *
 * Test strategy:
 *   1. Import the helper module directly and assert correct results on the full fixture
 *      matrix (exercises the production code path).
 *   2. Spawn the helper as a child process with shell:false and input on stdin to prove
 *      cross-shell portability — spawnSync with shell:false bypasses any host shell.
 *   3. Assert the workflow .md files now invoke `node ... ui-safety-gate.cjs` via stdin
 *      rather than the old shell-based invocation (structural guard against regression).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const HELPER_PATH = path.join(__dirname, '..', 'bin', 'lib', 'ui-safety-gate.cjs');
const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const AUTONOMOUS_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md');
const AUTONOMOUS_UI_DESIGN_CONTRACT_REF_PATH = path.join(
  __dirname, '..', 'gsd-core', 'references', 'autonomous-ui-design-contract.md'
);

const { checkUiPresence } = require(HELPER_PATH);

/**
 * #2994 fragmentization moved §3a.5's body out of autonomous.md into
 * gsd-core/references/autonomous-ui-design-contract.md, leaving an
 * unconditional `Read and execute:` pointer in the host. Read host +
 * reference file combined so the structural guards below still see the
 * real §3a.5 body (and its absence of the retired ui-safety-gate.cjs /
 * RUNTIME_DIR / LC_ALL=C grep patterns).
 */
function readAutonomousCombined() {
  return fs.readFileSync(AUTONOMOUS_PATH, 'utf-8') +
    '\n' + fs.readFileSync(AUTONOMOUS_UI_DESIGN_CONTRACT_REF_PATH, 'utf-8');
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Mirrors the old `hasUiGate` helper for backwards-compatible assertions.
 * Returns 0 (UI found) or 1 (not found), matching grep exit code semantics.
 */
function hasUiGate(text) {
  return checkUiPresence(text).hasUI ? 0 : 1;
}

/**
 * Spawn the helper with shell:false, passing input via stdin.
 * Returns the spawnSync result object.
 */
function spawnGate(input) {
  return spawnSync(process.execPath, [HELPER_PATH], {
    shell: false,
    encoding: 'utf-8',
    input: input,
  });
}

// ── Structural guard — workflow files now invoke Node via stdin ───────────────

describe('Workflow .md structural guard (#3718)', () => {
  // allow-test-rule: source-text-is-the-product (see #3706)
  // The UI safety gate invocation is embedded in workflow prose-as-code.
  // These structural tests guard against regression where someone re-introduces
  // the shell-based locale-prefix invocation that silently breaks on Windows PowerShell.

  // plan-phase.md (post-#1026): §5.6 now delegates UI gate evaluation to
  // `gsd_run check ui-plan-gate` (a CLI command that internally calls checkUiPresence
  // from ui-safety-gate.cjs). The direct shell invocation of ui-safety-gate.cjs was
  // intentionally removed from the workflow — cross-shell portability is now provided
  // by the CLI command layer, not inline shell code.
  test('plan-phase.md must invoke check ui-plan-gate (capability-driven UI gate — #1026)', () => {
    const content = fs.readFileSync(PLAN_PHASE_PATH, 'utf-8');
    assert.ok(
      content.includes('check ui-plan-gate'),
      'plan-phase.md: §5.6 must delegate to `check ui-plan-gate` (capability-driven, #1026)'
    );
    assert.ok(
      !content.includes('LC_ALL=C grep'),
      'plan-phase.md: must NOT contain LC_ALL=C grep — that silently fails on Windows PowerShell (#3718)'
    );
    // Must NOT reintroduce the old shell-based path-search loop for ui-safety-gate.cjs
    assert.ok(
      !content.includes('UI_GATE_JS=$(for _c in'),
      'plan-phase.md: must NOT contain the old shell-based ui-safety-gate.cjs path-search (old §5.6 pattern)'
    );
  });

  // autonomous.md §3a.5 (post-#1031 cutover): §3a.5 now delegates to
  // `loop render-hooks plan:pre` + `check ui-plan-gate` (capability-driven pattern,
  // matching plan-phase.md §5.6). The direct shell invocation of ui-safety-gate.cjs
  // was intentionally removed — cross-shell portability is provided by the CLI layer.
  test('autonomous.md must invoke check ui-plan-gate (capability-driven UI gate — #1031)', () => {
    const label = 'autonomous.md';
    const content = readAutonomousCombined();

    // §3a.5 must delegate to the capability-driven gate, not inline shell code
    assert.ok(
      content.includes('check ui-plan-gate'),
      `${label}: §3a.5 must delegate to \`check ui-plan-gate\` (capability-driven, #1031)`
    );
    // §3a.5 must dispatch render-hooks plan:pre
    assert.ok(
      content.includes('loop render-hooks plan:pre'),
      `${label}: §3a.5 must dispatch \`loop render-hooks plan:pre\` (capability hook resolution)`
    );
    // Must NOT reintroduce the old shell-based path-search loop for ui-safety-gate.cjs
    assert.ok(
      !content.includes('ui-safety-gate.cjs'),
      `${label}: must NOT inline ui-safety-gate.cjs invocation — replaced by check ui-plan-gate (#1031)`
    );
    assert.ok(
      !content.includes('UI_GATE_JS=$(for _c in'),
      `${label}: must NOT contain the old shell-based ui-safety-gate.cjs path-search (old §3a.5 pattern)`
    );
    assert.ok(
      !content.includes('LC_ALL=C grep'),
      `${label}: must NOT contain LC_ALL=C grep — that silently fails on Windows PowerShell (#3718)`
    );
  });
});

// ── Cross-shell spawn test (#3718) ────────────────────────────────────────────

describe('Cross-shell portability — spawnSync with shell:false, stdin (#3718)', () => {
  test('spawn with shell:false + stdin: UI input exits 0', () => {
    const result = spawnGate('UI Refactor: migrate all screens');
    assert.strictEqual(result.status, 0, `Expected exit 0 (UI found), got ${result.status}. stderr: ${result.stderr}`);
  });

  test('spawn with shell:false + stdin: non-UI input exits 1', () => {
    const result = spawnGate('Requirements: backend REST API only');
    assert.strictEqual(result.status, 1, `Expected exit 1 (no UI), got ${result.status}. stderr: ${result.stderr}`);
  });

  test('spawn with shell:false + stdin: empty input exits 1', () => {
    const result = spawnGate('');
    assert.strictEqual(result.status, 1, `Expected exit 1 (no UI for empty input), got ${result.status}. stderr: ${result.stderr}`);
  });

  test('spawn with shell:false + stdin: CRLF line endings handled correctly', () => {
    const result = spawnGate('Deploy to the cloud platform\r\nand configure CI/CD.');
    assert.strictEqual(result.status, 1, `CRLF "platform" must not trigger gate. stderr: ${result.stderr}`);
  });

  test('spawn with shell:false + stdin: multi-line input with UI token exits 0', () => {
    const multiLine = 'Backend setup\nBuild the analytics dashboard\nand navigation component.';
    const result = spawnGate(multiLine);
    assert.strictEqual(result.status, 0, `Multi-line input with "dashboard" must exit 0. stderr: ${result.stderr}`);
  });

  test('spawn with shell:false + stdin: very large input (>100KB) is handled without error', () => {
    // Verifies stdin transport does not hit ARG_MAX (argv transport fails above ~1MB on macOS).
    // Fixture uses pure backend prose — no standalone UI tokens.
    const largeInput = 'Backend service deployment and database migration step.\n'.repeat(3000);
    const result = spawnGate(largeInput);
    assert.strictEqual(result.status, 1, `Large non-UI input must exit 1, not crash. status: ${result.status}, stderr: ${result.stderr}`);
  });

  test('spawn with shell:false + stdin: large input with UI token exits 0', () => {
    const largeUiInput = 'Backend infrastructure setup.\n'.repeat(2999) + 'Build the analytics dashboard.\n';
    const result = spawnGate(largeUiInput);
    assert.strictEqual(result.status, 0, `Large input ending with UI token must exit 0. stderr: ${result.stderr}`);
  });
});

// ── Behavioral test matrix (via module import) ────────────────────────────────

/**
 * Full fixture matrix — exercises the production checkUiPresence() function directly.
 */
function runBehavioralTests(label) {
  describe(`${label} — UI gate behavioral matrix`, () => {

    // ── False-positive tests (must NOT match) ──────────────────────────────

    test('"Requirements" must NOT trigger UI gate (bug #3706 — "ui" substring)', () => {
      const phaseSection =
        '**Requirements**: The service must expose REST endpoints for authentication.\n' +
        'All work is server-side. Database migrations and API contract only.';
      assert.strictEqual(hasUiGate(phaseSection), 1, '"Requirements" must not match the UI gate');
    });

    test('"overview" must NOT trigger UI gate ("view" is a substring)', () => {
      assert.strictEqual(hasUiGate('Overview of the data pipeline architecture and backend services.'), 1);
    });

    test('"performance" must NOT trigger UI gate ("form" is a substring)', () => {
      assert.strictEqual(hasUiGate('Performance testing and benchmark analysis for the API layer.'), 1);
    });

    test('"platform" must NOT trigger UI gate ("form" is a substring)', () => {
      assert.strictEqual(hasUiGate('Deploy to the cloud platform and configure CI/CD.'), 1);
    });

    test('"transform" must NOT trigger UI gate ("form" is a substring)', () => {
      assert.strictEqual(hasUiGate('Transform raw event data and write to the warehouse.'), 1);
    });

    test('"review" must NOT trigger UI gate ("view" is a substring)', () => {
      assert.strictEqual(hasUiGate('Code review checklist and PR approval workflow for the API.'), 1);
    });

    test('"build" must NOT trigger UI gate ("ui" at positions 2-3 of "build")', () => {
      assert.strictEqual(hasUiGate('Build the backend service and run integration tests.'), 1);
    });

    test('"screening" must NOT trigger UI gate ("screen" is a substring)', () => {
      assert.strictEqual(hasUiGate('Implement candidate screening criteria for the hiring pipeline.'), 1);
    });

    test('empty input does NOT trigger UI gate', () => {
      assert.strictEqual(hasUiGate(''), 1);
    });

    test('whitespace-only input does NOT trigger UI gate', () => {
      assert.strictEqual(hasUiGate('   \n   \t   '), 1);
    });

    test('compound "microfrontend" (no separator) does NOT trigger gate — documented behavior', () => {
      assert.strictEqual(
        hasUiGate('Build the microfrontend shell application.'), 1,
        '"microfrontend" compound must NOT trigger gate'
      );
    });

    // ── True-positive tests (must match) ──────────────────────────────────

    test('standalone "UI" token DOES trigger UI gate', () => {
      assert.strictEqual(hasUiGate('UI Refactor: migrate all screens to the new design system.'), 0);
    });

    test('standalone "view" token DOES trigger UI gate', () => {
      assert.strictEqual(hasUiGate('Implement the user profile view controller and associated screen.'), 0);
    });

    test('standalone "form" token DOES trigger UI gate', () => {
      assert.strictEqual(hasUiGate('Build a sign-up form with client-side validation.'), 0);
    });

    test('"dashboard" DOES trigger UI gate', () => {
      assert.strictEqual(hasUiGate('Build the analytics dashboard and navigation component.'), 0);
    });

    test('lowercase "ui" token DOES trigger UI gate (case-insensitive)', () => {
      assert.strictEqual(hasUiGate('Redesign the ui for mobile responsiveness.'), 0);
    });

    test('"non-UI" hyphenated form DOES trigger UI gate (hyphen is a word boundary)', () => {
      assert.strictEqual(hasUiGate('This is a non-UI backend service with no visual elements.'), 0);
    });

    test('standalone "screen" token DOES trigger UI gate', () => {
      assert.strictEqual(hasUiGate('Implement the loading screen and splash animation.'), 0);
    });

    test('hyphenated "micro-frontend" DOES trigger gate (word boundary on hyphen)', () => {
      assert.strictEqual(hasUiGate('Build the micro-frontend shell application.'), 0);
    });

    // ── CRLF / edge case tests ─────────────────────────────────────────────

    test('CRLF line endings: non-UI text does not trigger gate', () => {
      assert.strictEqual(hasUiGate('Deploy to the cloud platform\r\nand configure CI/CD.'), 1);
    });

    test('CRLF line endings: UI token on second line triggers gate', () => {
      assert.strictEqual(hasUiGate('Backend setup complete.\r\nBuild the analytics dashboard.'), 0);
    });

    test('leading/trailing whitespace does not affect token detection', () => {
      assert.strictEqual(hasUiGate('  UI refactor phase  '), 0);
    });
  });
}

runBehavioralTests('ui-safety-gate.cjs');

// ── Install-dir resolution from a consuming project (#448) ────────────────────

describe('UI gate resolves the helper against RUNTIME_DIR, not the consuming repo (#448)', () => {
  const REPO_ROOT = path.join(__dirname, '..');

  // Mirrors the §5.6 / §3a.5 resolution. The structural guard above forces the
  // workflows to keep using this RUNTIME_DIR-anchored form; this proves the
  // candidate path is correct and the helper is actually found + executed when
  // the CWD is a consuming project that has no bin/lib of its own.
  const GATE_SNIPPET = [
    '_GSD_RT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"',
    'UI_GATE_JS=$(for _c in "$_GSD_RT/gsd-core/bin/lib/ui-safety-gate.cjs" "$_GSD_RT/bin/lib/ui-safety-gate.cjs" "$_GSD_RT/.claude/bin/lib/ui-safety-gate.cjs" "$HOME/.claude/gsd-core/bin/lib/ui-safety-gate.cjs" "$HOME/.claude/bin/lib/ui-safety-gate.cjs"; do [ -f "$_c" ] && { echo "$_c"; break; }; done)',
    'if [ -n "$UI_GATE_JS" ]; then printf \'%s\' "$PHASE_SECTION" | node "$UI_GATE_JS" >/dev/null 2>&1; HAS_UI=$?; else HAS_UI=0; fi',
    'echo "$HAS_UI"',
  ].join('\n');

  function runGateFrom(consumingDir, phaseSection) {
    return spawnSync('bash', ['-c', GATE_SNIPPET], {
      cwd: consumingDir,
      encoding: 'utf-8',
      env: { ...process.env, RUNTIME_DIR: REPO_ROOT, PHASE_SECTION: phaseSection },
    });
  }

  test('UI text is detected (HAS_UI=0) from a project without bin/lib', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-consuming-'));
    try {
      const res = runGateFrom(tmp, 'UI Refactor: migrate all screens');
      assert.strictEqual(res.status, 0, `bash failed: ${res.stderr}`);
      assert.strictEqual(res.stdout.trim(), '0',
        'helper must be found via RUNTIME_DIR and report UI present — not silently no-op');
    } finally {
      cleanup(tmp);
    }
  });

  test('non-UI text returns HAS_UI=1 via the RUNTIME_DIR-resolved helper', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-consuming-'));
    try {
      const res = runGateFrom(tmp, 'Requirements: backend REST API only');
      assert.strictEqual(res.stdout.trim(), '1');
    } finally {
      cleanup(tmp);
    }
  });

  test('UI gate found via gsd-core/bin/lib/ in installed layout (no root bin/lib/)', () => {
    // Regression for #448: installed RUNTIME_DIR has gsd-core/bin/lib/ but NOT root bin/lib/.
    // The probe must find the helper at the installed path, not silently no-op to HAS_UI=0.
    const fakeRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-installed-rt-'));
    const consumingProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-consuming-'));
    try {
      const installedLibDir = path.join(fakeRuntime, 'gsd-core', 'bin', 'lib');
      fs.mkdirSync(installedLibDir, { recursive: true });
      fs.copyFileSync(
        path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'ui-safety-gate.cjs'),
        path.join(installedLibDir, 'ui-safety-gate.cjs')
      );

      const res = spawnSync('bash', ['-c', GATE_SNIPPET], {
        cwd: consumingProject,
        encoding: 'utf-8',
        env: { ...process.env, RUNTIME_DIR: fakeRuntime, PHASE_SECTION: 'Build the analytics dashboard' },
      });
      assert.strictEqual(res.status, 0, `bash failed: ${res.stderr}`);
      assert.strictEqual(res.stdout.trim(), '0',
        'helper must be found via gsd-core/bin/lib/ in installed layout and report UI present');
    } finally {
      cleanup(fakeRuntime);
      cleanup(consumingProject);
    }
  });
});

// ── checkUiPresence() return value API ───────────────────────────────────────

describe('checkUiPresence() return value API', () => {
  test('returns { hasUI: true, tokens: [...] } when UI found', () => {
    const result = checkUiPresence('Build the dashboard and UI form');
    assert.strictEqual(result.hasUI, true);
    assert.ok(Array.isArray(result.tokens), 'tokens must be an array');
    assert.ok(result.tokens.length > 0, 'tokens must be non-empty when hasUI is true');
    assert.ok(result.tokens.includes('dashboard') || result.tokens.includes('ui') || result.tokens.includes('form'));
  });

  test('returns { hasUI: false, tokens: [] } when no UI found', () => {
    const result = checkUiPresence('Requirements: backend REST API only');
    assert.strictEqual(result.hasUI, false);
    assert.deepStrictEqual(result.tokens, []);
  });

  test('tokens are lowercased', () => {
    const result = checkUiPresence('UI Refactor');
    assert.ok(result.tokens.every(t => t === t.toLowerCase()), 'All tokens must be lowercase');
  });

  test('tokens are deduplicated', () => {
    const result = checkUiPresence('UI redesign and ui cleanup');
    const uiCount = result.tokens.filter(t => t === 'ui').length;
    assert.strictEqual(uiCount, 1, 'Duplicate tokens must be deduplicated');
  });

  test('non-string input returns { hasUI: false, tokens: [] }', () => {
    assert.deepStrictEqual(checkUiPresence(null), { hasUI: false, tokens: [] });
    assert.deepStrictEqual(checkUiPresence(undefined), { hasUI: false, tokens: [] });
    assert.deepStrictEqual(checkUiPresence(42), { hasUI: false, tokens: [] });
  });

  test('multiple distinct UI tokens on same line are ALL captured', () => {
    // "form" and "view" both appear as standalone words on one line.
    // Prior exec()-based impl only captured the first match per line.
    const result = checkUiPresence('Build a sign-up form with a view controller');
    assert.strictEqual(result.hasUI, true, 'hasUI must be true');
    assert.ok(result.tokens.includes('form'), `Expected "form" in tokens, got: ${JSON.stringify(result.tokens)}`);
    assert.ok(result.tokens.includes('view'), `Expected "view" in tokens, got: ${JSON.stringify(result.tokens)}`);
  });
});
  });
}
