'use strict';

/**
 * Behavioral tests for the `check ui-plan-gate` subcommand (#1026).
 *
 * Tests the `computeUiPlanGate` pure function exported from check-command-router.cjs.
 * Uses in-memory tmpdir fixtures — no real CLI subprocess needed.
 *
 * Return shape: { frontend: bool, hasUiSpec: bool, block: bool, uiSpecPath: string|null }
 * Invariant: block = frontend && !hasUiSpec
 *
 * Per RULESET.TESTS.boundary-coverage: exercises all three branches:
 *   (a) frontend+no-spec → block:true
 *   (b) frontend+spec    → block:false
 *   (c) non-frontend     → block:false
 *
 * Per RULESET.TESTS.coderabbit-fix-prefer: calls the exported function and asserts typed fields.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { computeUiPlanGate } = require('../gsd-core/bin/lib/check-command-router.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal project dir with:
 *   .planning/ROADMAP.md   — one phase section with `phaseSection` body
 *   .planning/phases/01-test-phase/  — phase directory
 *   (optionally) a *-UI-SPEC.md inside the phase dir
 *   (optionally) static frontend evidence (#3312): 'component-file' writes
 *   src/App.tsx; 'package-json' writes a package.json with a react dependency;
 *   false (default) writes no frontend evidence at all (markdown/bash repo).
 */
function makeProject({ phaseSection = '', hasUiSpec = false, frontendEvidence = 'component-file' } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-plan-gate-test-'));
  const planningDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  const phaseDir = path.join(phasesDir, '01-test-phase');

  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({}), 'utf8');
  if (frontendEvidence === 'component-file') {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App.tsx'), 'export function App() { return null; }\n', 'utf8');
  } else if (frontendEvidence === 'package-json') {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { react: '^18.3.1' } }),
      'utf8',
    );
  }

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

describe('computeUiPlanGate — ui.plan-gate check logic (#1026)', () => {
  let frontendNoSpec, frontendWithSpec, nonFrontend;

  before(() => {
    // Branch (a): frontend + no UI-SPEC → block:true
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
    test('result has required keys: frontend, hasUiSpec, block, uiSpecPath', () => {
      const result = computeUiPlanGate(nonFrontend.tmpDir, '1');
      assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
      assert.ok(typeof result.frontend === 'boolean', 'frontend must be boolean');
      assert.ok(typeof result.hasUiSpec === 'boolean', 'hasUiSpec must be boolean');
      assert.ok(typeof result.block === 'boolean', 'block must be boolean');
      assert.ok('uiSpecPath' in result, 'uiSpecPath key must be present');
    });

    test('block invariant: block === frontend && hasFrontendEvidence && !hasUiSpec for all scenarios', () => {
      // #3312: block additionally requires static frontend evidence — token match
      // alone no longer blocks (hyphenated proper nouns like `dashboard-financeiro`
      // satisfy the sniffer's word boundary).
      for (const [label, { tmpDir }] of [
        ['frontendNoSpec', frontendNoSpec],
        ['frontendWithSpec', frontendWithSpec],
        ['nonFrontend', nonFrontend],
      ]) {
        const r = computeUiPlanGate(tmpDir, '1');
        assert.strictEqual(
          r.block,
          r.frontend && r.hasFrontendEvidence && !r.hasUiSpec,
          `${label}: block invariant violated — frontend=${r.frontend} hasFrontendEvidence=${r.hasFrontendEvidence} hasUiSpec=${r.hasUiSpec} block=${r.block}`,
        );
      }
    });
  });

  describe('branch (a) — frontend + no UI-SPEC → block:true', () => {
    test('detects frontend indicators in phase section', () => {
      const r = computeUiPlanGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.frontend, true, 'should detect frontend indicators');
    });

    test('hasUiSpec is false when no *-UI-SPEC.md exists', () => {
      const r = computeUiPlanGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.hasUiSpec, false, 'hasUiSpec must be false');
    });

    test('block is true when frontend + no UI-SPEC', () => {
      const r = computeUiPlanGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.block, true, 'block must be true');
    });

    test('uiSpecPath is null when no UI-SPEC', () => {
      const r = computeUiPlanGate(frontendNoSpec.tmpDir, '1');
      assert.strictEqual(r.uiSpecPath, null, 'uiSpecPath must be null');
    });
  });

  describe('branch (b) — frontend + UI-SPEC exists → block:false', () => {
    test('detects frontend indicators in phase section', () => {
      const r = computeUiPlanGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.frontend, true, 'should detect frontend indicators');
    });

    test('hasUiSpec is true when *-UI-SPEC.md exists', () => {
      const r = computeUiPlanGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.hasUiSpec, true, 'hasUiSpec must be true');
    });

    test('block is false when UI-SPEC exists', () => {
      const r = computeUiPlanGate(frontendWithSpec.tmpDir, '1');
      assert.strictEqual(r.block, false, 'block must be false when spec exists');
    });

    test('uiSpecPath is a non-empty string ending in -UI-SPEC.md', () => {
      const r = computeUiPlanGate(frontendWithSpec.tmpDir, '1');
      assert.ok(typeof r.uiSpecPath === 'string' && r.uiSpecPath.length > 0,
        'uiSpecPath must be a non-empty string');
      assert.ok(r.uiSpecPath.endsWith('-UI-SPEC.md'), 'uiSpecPath must end with -UI-SPEC.md');
    });
  });

  describe('branch (c) — non-frontend phase → block:false', () => {
    test('frontend is false for non-UI phase section', () => {
      const r = computeUiPlanGate(nonFrontend.tmpDir, '1');
      assert.strictEqual(r.frontend, false, 'should NOT detect frontend indicators');
    });

    test('block is false for non-frontend phases', () => {
      const r = computeUiPlanGate(nonFrontend.tmpDir, '1');
      assert.strictEqual(r.block, false, 'block must be false');
    });
  });

  describe('uses checkUiPresence word-boundary rules — no detection reimplementation', () => {
    test('"microfrontend" (compound word) does NOT trigger frontend:true', () => {
      const proj = makeProject({
        phaseSection: 'Refactor the microfrontend architecture for better code reuse.',
        hasUiSpec: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, false,
          '"microfrontend" compound word must NOT trigger frontend (word-boundary rule from checkUiPresence)');
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('"micro-frontend" (hyphenated) triggers frontend:true', () => {
      const proj = makeProject({
        phaseSection: 'Refactor the micro-frontend architecture for better code reuse.',
        hasUiSpec: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true,
          '"micro-frontend" must trigger frontend detection (word-boundary rule from checkUiPresence)');
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });
  });

  describe('graceful degradation', () => {
    test('non-existent project dir returns frontend:false, block:false (no crash)', () => {
      const r = computeUiPlanGate('/tmp/nonexistent-gsd-test-dir-xyz', '1');
      assert.strictEqual(typeof r.frontend, 'boolean', 'frontend must be boolean');
      assert.strictEqual(r.frontend, false, 'missing roadmap → no frontend indicators');
      assert.strictEqual(r.block, false, 'missing roadmap → block false');
    });

    test('missing ROADMAP.md returns frontend:false gracefully (no phaseLookupFailed)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-gate-nomap-'));
      try {
        fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-phase'), { recursive: true });
        const r = computeUiPlanGate(tmpDir, '1');
        assert.strictEqual(r.frontend, false, 'no ROADMAP → no frontend indicators');
        assert.strictEqual(r.block, false, 'no ROADMAP → no block');
        // phaseLookupFailed must NOT be set when ROADMAP.md is absent (no-roadmap project)
        assert.ok(
          !r.phaseLookupFailed,
          'phaseLookupFailed must NOT be set when ROADMAP.md is absent (no-roadmap project is not a lookup failure)'
        );
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });

    test('ROADMAP.md present but phase not found → phaseLookupFailed:true (not silent false)', () => {
      // This verifies FIX 2: when ROADMAP.md exists but the phase header is absent,
      // we surface phaseLookupFailed rather than silently degrading to frontend:false,
      // so an onError:halt gate cannot be silently bypassed by a typo in the phase number.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-gate-noPhase-'));
      try {
        const planningDir = path.join(tmpDir, '.planning');
        const phasesDir = path.join(planningDir, 'phases');
        fs.mkdirSync(path.join(phasesDir, '01-test-phase'), { recursive: true });
        // ROADMAP.md exists but has no Phase 99 header
        fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
          '# Project Roadmap',
          '',
          '## Phase 1: Test Phase',
          '',
          'Build the frontend dashboard with React components.',
          '',
        ].join('\n'), 'utf8');
        // Phase 99 is not in the roadmap
        const r = computeUiPlanGate(tmpDir, '99');
        assert.strictEqual(r.phaseLookupFailed, true,
          'phaseLookupFailed must be true when ROADMAP.md exists but phase is not found');
        // frontend should be false because section is empty
        assert.strictEqual(r.frontend, false, 'empty section → no frontend indicators');
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });
  });

  describe('full-roadmap fallback (FIX 2 — mirrors roadmap.get-phase two-pass lookup)', () => {
    test('phase in non-current milestone section is found via full-roadmap fallback', () => {
      // Simulates a project where STATE.md declares milestone v1.0, but Phase 1 is
      // in the v0.9 section (an older milestone, NOT in a <details> block).
      // extractCurrentMilestone(content, cwd) returns only the v1.0 section → misses Phase 1.
      // stripShippedMilestones(content) returns the FULL roadmap (strips only <details>) → finds Phase 1.
      // computeUiPlanGate must find it via the stripShippedMilestones fallback, matching
      // what `gsd_run query roadmap.get-phase` does.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-gate-milestone-'));
      try {
        const planningDir = path.join(tmpDir, '.planning');
        const phasesDir = path.join(planningDir, 'phases');
        fs.mkdirSync(path.join(phasesDir, '01-test-phase'), { recursive: true });

        // STATE.md declares current milestone = v1.0
        fs.writeFileSync(path.join(planningDir, 'STATE.md'), [
          '---',
          'milestone: v1.0',
          '---',
          '',
          'State content.',
        ].join('\n'), 'utf8');

        // ROADMAP.md: Phase 1 is in v0.9 (NOT <details>), Phase 2 is in v1.0.
        // With STATE.md pointing to v1.0, extractCurrentMilestone returns the v1.0 section only.
        const roadmap = [
          '# Project Roadmap',
          '',
          '## v0.9 — Previous Milestone',
          '',
          '### Phase 1: Frontend Dashboard',
          '',
          'Build the user interface and dashboard components for the frontend.',
          '',
          '## v1.0 — Current Milestone',
          '',
          '### Phase 2: API Layer',
          '',
          'Add REST API endpoints.',
          '',
        ].join('\n');
        fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap, 'utf8');

        // Phase 1 is a frontend phase in a non-current milestone — must still be detected
        const r = computeUiPlanGate(tmpDir, '1');
        assert.strictEqual(r.frontend, true,
          'frontend:true must be detected for phase in non-current milestone (full-roadmap fallback)');
        assert.ok(
          !r.phaseLookupFailed,
          'phaseLookupFailed must be false when phase is found via full-roadmap fallback'
        );
      } finally {
        try { cleanup(tmpDir); } catch { /* ignore */ }
      }
    });
  });

  // ── #3312: token match alone must NOT block — static structural corroboration ──

  describe('#3312 structural corroboration — hyphenated proper nouns in non-frontend repos', () => {
    test('dashboard-financeiro mention, repo with NO frontend evidence → frontend:true but block:false', () => {
      // The reporter's exact shape: a markdown+bash+config repo (no src/, no
      // package.json, no component files) whose phase names the repo
      // `dashboard-financeiro`. The sniffer legitimately matches `dashboard`
      // (hyphen is a word boundary — same rule that catches `micro-frontend`),
      // but the gate must not BLOCK without structural frontend evidence.
      const proj = makeProject({
        phaseSection: 'Fix broken references in dashboard-financeiro, update .env.tpl and CI workflows.',
        hasUiSpec: false,
        frontendEvidence: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true,
          'the token match itself still registers (sniffer semantics unchanged)');
        assert.strictEqual(r.hasFrontendEvidence, false,
          'a repo with no component files and no UI-framework dep has no frontend evidence');
        assert.strictEqual(r.block, false,
          '#3312: token match without structural evidence must NOT block planning');
        assert.strictEqual(r.uiSpecPath, null);
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('same proper-noun mention WITH component file in tree → block:true (corroboration restores block)', () => {
      const proj = makeProject({
        phaseSection: 'Fix broken references in dashboard-financeiro and adjust the nav layout.',
        hasUiSpec: false,
        frontendEvidence: 'component-file',
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true);
        assert.strictEqual(r.hasFrontendEvidence, true, 'src/App.tsx is frontend evidence');
        assert.strictEqual(r.block, true, 'token match + evidence + no spec → block');
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('package.json with a UI-framework dependency counts as frontend evidence', () => {
      const proj = makeProject({
        phaseSection: 'Rebuild the dashboard for the finance team.',
        hasUiSpec: false,
        frontendEvidence: 'package-json',
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.hasFrontendEvidence, true,
          'package.json with a react dependency is frontend evidence even with no component files yet');
        assert.strictEqual(r.block, true);
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('plain prose UI phase in a repo with NO frontend evidence → block:false (general rule, not a token denylist)', () => {
      const proj = makeProject({
        phaseSection: 'Build the user interface and dashboard components for the frontend.',
        hasUiSpec: false,
        frontendEvidence: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true);
        assert.strictEqual(r.hasFrontendEvidence, false);
        assert.strictEqual(r.block, false,
          'corroboration is required for EVERY token match, not just proper-noun shapes');
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('matchedToken/matchedLine surface what tripped the sniffer (issue: judge in one second)', () => {
      const proj = makeProject({
        phaseSection: 'Deliverables: .env.tpl, CI workflows.\n\nReferences: dashboard-financeiro repo.',
        hasUiSpec: false,
        frontendEvidence: false,
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.matchedToken, 'dashboard', 'first matched token is surfaced');
        assert.ok(
          typeof r.matchedLine === 'string' && r.matchedLine.includes('dashboard-financeiro'),
          'first matching line is surfaced so the operator can see the proper-noun context',
        );
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('matchedToken/matchedLine are null for non-frontend phases', () => {
      const proj = makeProject({
        phaseSection: 'Add a REST API endpoint and database migration for the user table.',
        hasUiSpec: false,
        frontendEvidence: 'component-file',
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, false);
        assert.strictEqual(r.matchedToken, null);
        assert.strictEqual(r.matchedLine, null);
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });

    test('UI-SPEC present + token match + evidence → block:false (spec still satisfies the gate)', () => {
      const proj = makeProject({
        phaseSection: 'Build the frontend dashboard with React components.',
        hasUiSpec: true,
        frontendEvidence: 'component-file',
      });
      try {
        const r = computeUiPlanGate(proj.tmpDir, '1');
        assert.strictEqual(r.frontend, true);
        assert.strictEqual(r.hasUiSpec, true);
        assert.strictEqual(r.block, false);
      } finally {
        try { cleanup(proj.tmpDir); } catch { /* ignore */ }
      }
    });
  });
});
