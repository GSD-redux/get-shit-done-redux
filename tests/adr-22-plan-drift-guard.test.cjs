// allow-test-rule: source-text-is-the-product #1190

/**
 * ADR-22 Drift-Guard Tests — issue #1190
 *
 * Covers:
 *  1. Pure unit tests for `classifyDriftSeverity` (every ADR-22 table cell).
 *  2. Pure unit tests for `getEffectiveAuthority` (auto-upgrade + pass-through).
 *  3. e2e CLI tests via `gsd-tools drift-guard severity/authority`.
 *  4. Structural test that plan-review-convergence.md invokes `gsd_run drift-guard`.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup, runGsdTools } = require('./helpers.cjs');

// ── Pure-module imports ──────────────────────────────────────────────────────

const {
  AUTHORITY_RUNGS,
  getEffectiveAuthority,
  classifyDriftSeverity,
  comparePhaseStatus,
} = require('../gsd-core/bin/lib/plan-drift-guard.cjs');

// ── 1. AUTHORITY_RUNGS sanity ────────────────────────────────────────────────

describe('AUTHORITY_RUNGS', () => {
  test('has all five adapters with correct rung order', () => {
    assert.equal(AUTHORITY_RUNGS.grep,       0);
    assert.equal(AUTHORITY_RUNGS.intel,      1);
    assert.equal(AUTHORITY_RUNGS.treesitter, 2);
    assert.equal(AUTHORITY_RUNGS.lsp,        3);
    assert.equal(AUTHORITY_RUNGS.scip,       4);
  });

  test('is frozen (no mutation)', () => {
    assert.ok(Object.isFrozen(AUTHORITY_RUNGS));
  });
});

// ── 2. getEffectiveAuthority unit tests ──────────────────────────────────────

describe('getEffectiveAuthority', () => {
  test('grep + intel enabled → intel', () => {
    assert.equal(getEffectiveAuthority('grep', true), 'intel');
  });

  test('grep + intel disabled → grep', () => {
    assert.equal(getEffectiveAuthority('grep', false), 'grep');
  });

  test('undefined + intel enabled → intel (grep is the default)', () => {
    assert.equal(getEffectiveAuthority(undefined, true), 'intel');
  });

  test('null + intel disabled → grep', () => {
    assert.equal(getEffectiveAuthority(null, false), 'grep');
  });

  test('empty string + intel enabled → intel', () => {
    assert.equal(getEffectiveAuthority('', true), 'intel');
  });

  test('intel + intel enabled → intel (no double upgrade)', () => {
    // intel is already intel; auto-upgrade rule only applies to grep
    assert.equal(getEffectiveAuthority('intel', true), 'intel');
  });

  test('intel + intel disabled → intel (pass-through)', () => {
    assert.equal(getEffectiveAuthority('intel', false), 'intel');
  });

  test('treesitter + intel enabled → treesitter (auto-upgrade only for grep)', () => {
    assert.equal(getEffectiveAuthority('treesitter', true), 'treesitter');
  });

  test('lsp + intel enabled → lsp (auto-upgrade only for grep)', () => {
    assert.equal(getEffectiveAuthority('lsp', true), 'lsp');
  });

  test('scip + intel disabled → scip', () => {
    assert.equal(getEffectiveAuthority('scip', false), 'scip');
  });

  test('unknown authority → TypeError', () => {
    assert.throws(
      () => getEffectiveAuthority('grok', false),
      (err) => err instanceof TypeError && /Unknown authority/i.test(err.message),
    );
  });
});

// ── 3. classifyDriftSeverity unit tests (every ADR-22 table cell) ──────────

describe('classifyDriftSeverity — VERIFIED', () => {
  for (const authority of ['grep', 'intel', 'treesitter', 'lsp', 'scip']) {
    test(`VERIFIED @ ${authority} → severity none, no hardBlock`, () => {
      const result = classifyDriftSeverity({ status: 'VERIFIED', authority });
      assert.equal(result.severity, 'none');
      assert.equal(result.hardBlock, false);
    });
  }
});

describe('classifyDriftSeverity — MISSING', () => {
  test('MISSING @ grep → needs-acknowledgement, no hardBlock', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'grep' });
    assert.equal(result.severity, 'needs-acknowledgement');
    assert.equal(result.hardBlock, false);
  });

  test('MISSING @ intel → needs-acknowledgement, no hardBlock', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'intel' });
    assert.equal(result.severity, 'needs-acknowledgement');
    assert.equal(result.hardBlock, false);
  });

  test('MISSING @ treesitter → needs-acknowledgement, no hardBlock', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'treesitter' });
    assert.equal(result.severity, 'needs-acknowledgement');
    assert.equal(result.hardBlock, false);
  });

  test('MISSING @ lsp → HIGH, hardBlock TRUE', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'lsp' });
    assert.equal(result.severity, 'HIGH');
    assert.equal(result.hardBlock, true);
  });

  test('MISSING @ scip → HIGH, hardBlock TRUE', () => {
    const result = classifyDriftSeverity({ status: 'MISSING', authority: 'scip' });
    assert.equal(result.severity, 'HIGH');
    assert.equal(result.hardBlock, true);
  });
});

describe('classifyDriftSeverity — AMBIGUOUS', () => {
  for (const authority of ['grep', 'intel', 'treesitter', 'lsp', 'scip']) {
    test(`AMBIGUOUS @ ${authority} → MEDIUM, no hardBlock`, () => {
      const result = classifyDriftSeverity({ status: 'AMBIGUOUS', authority });
      assert.equal(result.severity, 'MEDIUM');
      assert.equal(result.hardBlock, false);
    });
  }
});

describe('classifyDriftSeverity — UNCHECKABLE', () => {
  for (const authority of ['grep', 'intel', 'treesitter', 'lsp', 'scip']) {
    test(`UNCHECKABLE @ ${authority} → INFO, no hardBlock`, () => {
      const result = classifyDriftSeverity({ status: 'UNCHECKABLE', authority });
      assert.equal(result.severity, 'INFO');
      assert.equal(result.hardBlock, false);
    });
  }
});

describe('classifyDriftSeverity — validation', () => {
  test('unknown status → TypeError', () => {
    assert.throws(
      () => classifyDriftSeverity({ status: 'WRONG', authority: 'grep' }),
      (err) => err instanceof TypeError && /Unknown status/i.test(err.message),
    );
  });

  test('unknown authority → TypeError', () => {
    assert.throws(
      () => classifyDriftSeverity({ status: 'MISSING', authority: 'magic' }),
      (err) => err instanceof TypeError && /Unknown authority/i.test(err.message),
    );
  });
});

// ── 4. e2e CLI tests ─────────────────────────────────────────────────────────

describe('gsd-tools drift-guard — CLI e2e', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-drift-guard-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: write config.json into the fixture
  function writeConfig(cfg) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify(cfg),
    );
  }

  test('severity --status MISSING --authority lsp → {severity:HIGH, hardBlock:true}', () => {
    writeConfig({ plan_review: { source_grounding_authority: 'lsp' } });
    const res = runGsdTools(
      ['drift-guard', 'severity', '--status', 'MISSING', '--authority', 'lsp', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.severity, 'HIGH');
    assert.equal(result.hardBlock, true);
  });

  test('severity --status MISSING --authority grep → {severity:needs-acknowledgement, hardBlock:false}', () => {
    writeConfig({});
    const res = runGsdTools(
      ['drift-guard', 'severity', '--status', 'MISSING', '--authority', 'grep', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.severity, 'needs-acknowledgement');
    assert.equal(result.hardBlock, false);
  });

  test('severity --status VERIFIED --authority scip → {severity:none, hardBlock:false}', () => {
    writeConfig({});
    const res = runGsdTools(
      ['drift-guard', 'severity', '--status', 'VERIFIED', '--authority', 'scip', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.severity, 'none');
    assert.equal(result.hardBlock, false);
  });

  test('authority with source_grounding_authority=grep + intel.enabled=true → intel', () => {
    writeConfig({
      plan_review: { source_grounding_authority: 'grep' },
      intel: { enabled: true },
    });
    const res = runGsdTools(
      ['drift-guard', 'authority', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    assert.equal(res.output, 'intel');
  });

  test('authority with source_grounding_authority=lsp + intel.enabled=true → lsp (no upgrade)', () => {
    writeConfig({
      plan_review: { source_grounding_authority: 'lsp' },
      intel: { enabled: true },
    });
    const res = runGsdTools(
      ['drift-guard', 'authority', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    assert.equal(res.output, 'lsp');
  });

  test('authority with no config → grep (default)', () => {
    writeConfig({});
    const res = runGsdTools(
      ['drift-guard', 'authority', '--raw'],
      tmpDir,
    );
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    assert.equal(res.output, 'grep');
  });

  test('severity without --status flag → exits non-zero', () => {
    writeConfig({});
    const res = runGsdTools(['drift-guard', 'severity', '--raw'], tmpDir);
    assert.equal(res.success, false, 'Expected non-zero exit for missing --status');
    assert.ok(res.exitCode !== 0, `exitCode should be non-zero, got ${res.exitCode}`);
  });

  test('unknown subcommand → exits non-zero', () => {
    writeConfig({});
    const res = runGsdTools(['drift-guard', 'badcmd', '--raw'], tmpDir);
    assert.equal(res.success, false, 'Expected non-zero exit for unknown subcommand');
    assert.ok(res.exitCode !== 0, `exitCode should be non-zero, got ${res.exitCode}`);
  });
});

// ── 5. Structural test: plan-review-convergence.md invokes gsd_run drift-guard

describe('plan-review-convergence.md uses gsd_run drift-guard seam', () => {
  const WORKFLOW_PATH = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'plan-review-convergence.md',
  );

  test('workflow contains gsd_run drift-guard authority call', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('gsd_run drift-guard authority'),
      'plan-review-convergence.md must contain: gsd_run drift-guard authority',
    );
  });

  test('workflow drift-guard authority call includes --raw (prevents JSON-quoted capture)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.match(
      content,
      /gsd_run drift-guard authority --raw/,
      'plan-review-convergence.md authority capture must use --raw; without it the value is JSON-quoted ("intel") and --authority rejects it as unknown',
    );
  });

  test('workflow contains gsd_run drift-guard severity call', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('gsd_run drift-guard severity'),
      'plan-review-convergence.md must contain: gsd_run drift-guard severity',
    );
  });

  test('workflow drift-guard severity call passes --authority flag', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.match(
      content,
      /gsd_run drift-guard severity[^\n]*--authority/,
      'plan-review-convergence.md severity invocation must pass --authority so the resolved authority is forwarded to classifyDriftSeverity',
    );
  });
});

// ── 6. comparePhaseStatus unit tests (#1956) ────────────────────────────────

describe('comparePhaseStatus', () => {
  test('equal ranks (STATE vocabulary vs ROADMAP vocabulary) → consistent', () => {
    const result = comparePhaseStatus({ stateStatus: 'In progress', roadmapStatus: 'In Progress' });
    assert.equal(result.verdict, 'consistent');
    assert.equal(result.stateRank, result.roadmapRank);
  });

  test('Phase complete vs In Progress → drifted, NOT lag (the issue\'s canonical case)', () => {
    const result = comparePhaseStatus({ stateStatus: 'Phase complete', roadmapStatus: 'In Progress' });
    assert.equal(result.verdict, 'drifted');
    assert.notEqual(result.verdict, 'lag', 'a completion disagreement must never be classified as lag, even though the ranks are only 1 apart');
  });

  test('Phase complete vs Not started → drifted', () => {
    const result = comparePhaseStatus({ stateStatus: 'Phase complete', roadmapStatus: 'Not started' });
    assert.equal(result.verdict, 'drifted');
  });

  test('Ready to plan vs In Progress → lag', () => {
    const result = comparePhaseStatus({ stateStatus: 'Ready to plan', roadmapStatus: 'In Progress' });
    assert.equal(result.verdict, 'lag');
  });

  test('unknown status on either side → uncheckable, and the other side\'s rank still resolves', () => {
    const stateUnknown = comparePhaseStatus({ stateStatus: 'Frobnicating', roadmapStatus: 'In Progress' });
    assert.equal(stateUnknown.verdict, 'uncheckable');
    assert.equal(stateUnknown.stateRank, null);
    assert.equal(stateUnknown.roadmapRank, 1, 'the resolvable side must still be diagnosable even when the other is unknown');

    const roadmapUnknown = comparePhaseStatus({ stateStatus: 'Phase complete', roadmapStatus: 'Frobnicating' });
    assert.equal(roadmapUnknown.verdict, 'uncheckable');
    assert.equal(roadmapUnknown.roadmapRank, null);
    assert.equal(roadmapUnknown.stateRank, 2, 'the resolvable side must still be diagnosable even when the other is unknown');
  });

  test('null / undefined / empty-string on either side → uncheckable', () => {
    assert.equal(comparePhaseStatus({ stateStatus: null, roadmapStatus: 'In Progress' }).verdict, 'uncheckable');
    assert.equal(comparePhaseStatus({ stateStatus: undefined, roadmapStatus: 'In Progress' }).verdict, 'uncheckable');
    assert.equal(comparePhaseStatus({ stateStatus: '', roadmapStatus: 'In Progress' }).verdict, 'uncheckable');
    assert.equal(comparePhaseStatus({ stateStatus: 'In Progress', roadmapStatus: null }).verdict, 'uncheckable');
    assert.equal(comparePhaseStatus({ stateStatus: 'In Progress', roadmapStatus: undefined }).verdict, 'uncheckable');
    assert.equal(comparePhaseStatus({ stateStatus: 'In Progress', roadmapStatus: '' }).verdict, 'uncheckable');
  });

  test('case and surrounding whitespace are ignored', () => {
    const result = comparePhaseStatus({ stateStatus: '  PHASE COMPLETE  ', roadmapStatus: 'Phase complete' });
    assert.equal(result.verdict, 'consistent');
    assert.equal(result.stateRank, 2);
    assert.equal(result.roadmapRank, 2);
  });

  test('does not throw for unrecognized input (unlike classifyDriftSeverity)', () => {
    assert.doesNotThrow(() => comparePhaseStatus({ stateStatus: 'garbage', roadmapStatus: 'nonsense' }));
    assert.doesNotThrow(() => comparePhaseStatus({ stateStatus: undefined, roadmapStatus: undefined }));
  });

  // #1956 review fix: 'Deferred' was missing from PHASE_STATUS_RANKS despite
  // gsd-core/templates/roadmap.md:133 declaring it as part of the full
  // ROADMAP Status vocabulary (`Not started | In progress | Complete |
  // Deferred`) — it silently always resolved 'uncheckable', losing real drift.
  test('Deferred vs Not started → consistent (both agree no work has happened)', () => {
    const result = comparePhaseStatus({ stateStatus: 'Not started', roadmapStatus: 'Deferred' });
    assert.equal(result.verdict, 'consistent');
  });

  test('Deferred vs In progress → drifted (declared stopped vs declared happening)', () => {
    const result = comparePhaseStatus({ stateStatus: 'In progress', roadmapStatus: 'Deferred' });
    assert.equal(result.verdict, 'drifted');
  });

  test('Deferred vs Phase complete → drifted (declared stopped vs declared done)', () => {
    const result = comparePhaseStatus({ stateStatus: 'Phase complete', roadmapStatus: 'Deferred' });
    assert.equal(result.verdict, 'drifted');
  });

  test('deferred resolves a real (non-null) rank on either side', () => {
    const result = comparePhaseStatus({ stateStatus: 'Not started', roadmapStatus: 'Deferred' });
    assert.notEqual(result.roadmapRank, null, "'deferred' must not be uncheckable — it is a declared vocabulary value");
    assert.equal(result.roadmapRank, 0);
  });
});

// Shared ROADMAP.md "Progress" table fixture builder (#1956/#2012). Used by
// BOTH the CLI acceptance tests below (via writeRoadmap, which writes it to
// disk) and the findRoadmapProgressTable/deriveProgressFromRoadmap parity
// test (section 8), so the CLI-level decoy fixture and the parity fixture
// can never independently drift into slightly different shapes.
//
// `opts.decoy`, when true, prepends an earlier `## Archive Notes` section
// carrying a table with the EXACT SAME four column headers
// (`Phase | Plans Complete | Status | Completed`) as the real `## Progress`
// table, with the same phase row reporting a DIFFERENT status ('Not
// started') — the #2012 decoy shape a column-name-only lookup would pick up
// first.
function buildRoadmapProgressContent(phase, phaseName, roadmapStatus, opts = {}) {
  const decoySection = opts.decoy
    ? `## Archive Notes

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| ${phase}. ${phaseName} | 0/1 | Not started | - |

`
    : '';
  return `# Roadmap: Test Project

${decoySection}## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| ${phase}. ${phaseName} | 0/1 | ${roadmapStatus} | - |
`;
}

// ── 7. #1956 acceptance — drifted phase status across STATE/ROADMAP, via the real CLI ──

describe('#1956 acceptance — a drifted phase status across STATE/ROADMAP yields a finding', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1956-acceptance-'));
    planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const PHASE = 3;
  const PHASE_NAME = 'Convergence';

  // Writes .planning/STATE.md carrying frontmatter + a `## Current Position`
  // section, matching gsd-core/templates/state.md.
  function writeState(stateStatus) {
    const content = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Current Position

Phase: ${PHASE} of 8 (${PHASE_NAME})
Plan: 1 of 1 in current phase
Status: ${stateStatus}
Last activity: 2026-08-09 — test fixture

Progress: [░░░░░░░░░░] 0%
`;
    fs.writeFileSync(path.join(planningDir, 'STATE.md'), content);
  }

  // Writes .planning/ROADMAP.md carrying a `## Progress` section with the
  // table shape gsd-core/templates/roadmap.md declares. `opts.decoy` prepends
  // a same-headers decoy table under a different heading — see
  // buildRoadmapProgressContent above.
  function writeRoadmap(roadmapStatus, opts = {}) {
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      buildRoadmapProgressContent(PHASE, PHASE_NAME, roadmapStatus, opts),
    );
  }

  test('an intentionally-drifted phase status yields a finding', () => {
    writeState('Phase complete');
    writeRoadmap('In Progress');
    const res = runGsdTools(['drift-guard', 'phase-status', '--phase', String(PHASE)], tmpDir);
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.verdict, 'drifted');
    assert.equal(result.authority, 'STATE.md', 'the finding must name STATE.md as authority so the reviewer knows which side to keep');
  });

  test('consistent artifacts do not', () => {
    writeState('Phase complete');
    writeRoadmap('Complete');
    const res = runGsdTools(['drift-guard', 'phase-status', '--phase', String(PHASE)], tmpDir);
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.verdict, 'consistent');
  });

  test('a missing ROADMAP.md is uncheckable, not consistent', () => {
    writeState('Phase complete');
    const res = runGsdTools(['drift-guard', 'phase-status', '--phase', String(PHASE)], tmpDir);
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.verdict, 'uncheckable');
    assert.ok(result.reason && result.reason.length > 0, 'a skipped axis must be observable via a non-empty reason');
  });

  // #1956 review Fix 1: the Progress-table lookup used to scan the WHOLE
  // ROADMAP for the first table matching the column headers, so an earlier
  // decoy table sharing those headers (e.g. an "Archive Notes" table) was
  // picked up instead of the real `## Progress` table (#2012 decoy
  // avoidance). The decoy's phase-3 row says 'Not started'; the real
  // `## Progress` table's phase-3 row says 'Complete', agreeing with STATE.md's
  // 'Phase complete' — the CLI must read the real table.
  test('a decoy table with the same headers is not mistaken for ## Progress', () => {
    writeState('Phase complete');
    writeRoadmap('Complete', { decoy: true });
    const res = runGsdTools(['drift-guard', 'phase-status', '--phase', String(PHASE)], tmpDir);
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.verdict, 'consistent');
    assert.equal(result.roadmapStatus, 'Complete', 'must read the real ## Progress table\'s status, not the decoy\'s "Not started"');
  });

  // #1956 review Fix 2: `stateCurrentPositionSlice(stateBody) ?? stateBody`
  // fell back to the whole STATE.md body when no `## Current Position`
  // heading was found, reintroducing the #2956 archive-shadowing bug — a
  // stray historical `Status:` line elsewhere in the body would be read as
  // if it were the real current status, fabricating a drift finding. A
  // STATE.md with NO Current Position heading, plus an earlier stray
  // `Status: Ready to plan` line, must abstain instead of guessing.
  test('a STATE.md with no ## Current Position heading is uncheckable, never a fabricated finding', () => {
    const stateContent = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

Status: Ready to plan

## Session

Some unrelated notes with no Current Position section.
`;
    fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent);
    writeRoadmap('Complete');
    const res = runGsdTools(['drift-guard', 'phase-status', '--phase', String(PHASE)], tmpDir);
    assert.ok(res.success, `Expected success, got: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.equal(result.verdict, 'uncheckable');
    assert.equal(result.reason, 'no_current_position');
    assert.notEqual(result.verdict, 'drifted', 'a shadowed/absent Current Position must never fabricate a drift finding');
  });
});

// ── 8. #1956/#2012 parity — findRoadmapProgressTable vs deriveProgressFromRoadmap ──
//
// Two SEPARATE implementations locate "the" ROADMAP Progress table:
// roadmap-parser.cts's findRoadmapProgressTable (collectSection-based, used
// by the drift-guard CLI) and phase-lifecycle.cts's deriveProgressFromRoadmap
// (its own regex-based `## Progress` scope, used by the phase-lifecycle SDK
// handler — deliberately NOT refactored onto the shared owner; its blast
// radius is large). The repo requires a parity assertion whenever a parser is
// expressed twice, so this test feeds both the SAME decoy-bearing ROADMAP
// fixture from section 7 and asserts they agree about which table is real.

describe('#1956/#2012 parity — findRoadmapProgressTable vs deriveProgressFromRoadmap agree', () => {
  const { findRoadmapProgressTable } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
  const { deriveProgressFromRoadmap } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');

  test('both locators pick the real ## Progress table, not the decoy', () => {
    const content = buildRoadmapProgressContent(3, 'Convergence', 'Complete', { decoy: true });

    const table = findRoadmapProgressTable(content);
    assert.ok(table, 'findRoadmapProgressTable must find the real Progress table');
    const row = table.rows.find((r) => r.Phase.startsWith('3.'));
    assert.ok(row, 'expected a phase 3 row in the located table');
    assert.equal(row.Status, 'Complete', 'must read the real ## Progress table\'s phase-3 status, not the decoy\'s "Not started"');

    const progress = deriveProgressFromRoadmap(content);
    assert.equal(progress.completedPhases, 1, 'deriveProgressFromRoadmap must count the real ## Progress table\'s Complete row, not be fooled by the decoy');
  });
});
