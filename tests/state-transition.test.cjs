'use strict';

// Phase 1 tests for the STATE.md Transition Module (ADR-1769).
// These are characterization tests: they pin the behavior the new
// `transitionCore` / `beginPhase` API must preserve as the old
// `cmdStateBeginPhase` callback in state.cts is migrated onto it.
//
// Discipline: TDD vertical slices. One behavior → one test → minimal code → repeat.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  transitionCore,
  applyStatePreservation,
  FIELD_CLASSIFICATION,
  getFieldClassification,
  STATE_MD_SECTIONS,
  sliceCurrentPositionSection,
} = require('../gsd-core/bin/lib/state-transition.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');

const fixedClock = Object.freeze({
  today: () => '2026-06-27',
  localToday: () => '2026-06-27',
  nowIso: () => '2026-06-27T12:00:00.000Z',
});

describe('ADR-1769 substrate: field-classification table', () => {
  const allowedSources = new Set(['body', 'disk', 'external', 'curated', 'free']);
  const allowedPreservation = new Set([
    'derive',
    'preserve-when-unchanged',
    'preserve-always',
    'preserve-if-placeholder',
    'clear',
  ]);

  test('every classified field has a { source, preservation } row with known enum values', () => {
    for (const [field, cls] of Object.entries(FIELD_CLASSIFICATION)) {
      assert.ok(
        allowedSources.has(cls.source),
        `field ${JSON.stringify(field)} has unknown source ${JSON.stringify(cls.source)}`,
      );
      assert.ok(
        allowedPreservation.has(cls.preservation),
        `field ${JSON.stringify(field)} has unknown preservation ${JSON.stringify(cls.preservation)}`,
      );
    }
  });

  test('current_phase_name is curated / preserve-always (ADR-1769 §4 — kills #1743/#1695 by construction)', () => {
    const cls = getFieldClassification('current_phase_name');
    assert.strictEqual(cls && cls.source, 'curated');
    assert.strictEqual(cls && cls.preservation, 'preserve-always');
  });

  test('progress is curated / preserve-always (ADR-1769 §4 — curated-progress ratchet)', () => {
    const cls = getFieldClassification('progress');
    assert.strictEqual(cls && cls.source, 'curated');
    assert.strictEqual(cls && cls.preservation, 'preserve-always');
  });

  test('state_head is free / derive (ADR-1769 §4 — ambient git read, refreshed every write; #2573)', () => {
    // `state_head` records the commit STATE.md was written against. It is not
    // body-derived, disk-derived, or curated — it is an ambient external read
    // recomputed on every write, exactly like `last_updated` (realClock.nowIso()).
    // ADR-1769 §4: "Each STATE.md field has a row." The per-transition guard in
    // transitionCore only checks the keys a transition declares, so an
    // unregistered field would slip through silently — this test is the check.
    const cls = getFieldClassification('state_head');
    assert.strictEqual(cls && cls.source, 'free');
    assert.strictEqual(cls && cls.preservation, 'derive');
  });

  test('table covers every frontmatter key emitted by buildStateFrontmatter (codex Phase 1 review)', () => {
    // Verified against src/state.cts:1633-1653 (buildStateFrontmatter emit block).
    const requiredFields = [
      'gsd_state_version',
      'milestone',
      'milestone_name',
      'current_phase',
      'current_phase_name',
      'current_plan',
      'status',
      'stopped_at',
      'paused_at',
      'last_updated',
      'last_activity',
      'last_activity_desc',
      'state_head',
      'progress',
      'progress.total_phases',
      'progress.completed_phases',
      'progress.total_plans',
      'progress.completed_plans',
      'progress.percent',
    ];
    for (const f of requiredFields) {
      assert.ok(getFieldClassification(f) !== null,
        `frontmatter key ${JSON.stringify(f)} must have a classification row`);
    }
  });

  test('getFieldClassification returns null for unknown fields AND inherited prototype methods', () => {
    // Classic prototype-pollution guard: queries for 'toString' / 'valueOf' / '__proto__'
    // must return null, not inherited Object.prototype functions.
    assert.strictEqual(getFieldClassification('toString'), null);
    assert.strictEqual(getFieldClassification('valueOf'), null);
    assert.strictEqual(getFieldClassification('hasOwnProperty'), null);
    assert.strictEqual(getFieldClassification('__proto__'), null);
    assert.strictEqual(getFieldClassification('not-a-real-field'), null);
  });
});

describe('ADR-1769 substrate: STATE_MD_SECTIONS constants (aligned to gsd-core/templates/state.md)', () => {
  test('every section heading starts with "## "', () => {
    for (const [name, heading] of Object.entries(STATE_MD_SECTIONS)) {
      assert.ok(
        heading.startsWith('## '),
        `section ${name} heading ${JSON.stringify(heading)} must start with "## "`,
      );
    }
  });

  test('matches the six canonical top-level sections of the STATE.md template', () => {
    assert.strictEqual(STATE_MD_SECTIONS.projectReference, '## Project Reference');
    assert.strictEqual(STATE_MD_SECTIONS.currentPosition, '## Current Position');
    assert.strictEqual(STATE_MD_SECTIONS.performanceMetrics, '## Performance Metrics');
    assert.strictEqual(STATE_MD_SECTIONS.accumulatedContext, '## Accumulated Context');
    assert.strictEqual(STATE_MD_SECTIONS.deferredItems, '## Deferred Items');
    assert.strictEqual(STATE_MD_SECTIONS.sessionContinuity, '## Session Continuity');
  });
});

describe('ADR-1769 Phase 1: beginPhase transition — tracer bullet', () => {
  test('updates body Status field to "Executing Phase N" on first-time begin', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Planning',
      '',
      '## Current Position',
      '',
      'Phase: 2 — DONE',
      'Plan: —',
      'Status: Planning',
      '',
    ].join('\n');

    const result = transitionCore(
      input,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 },
      { clock: fixedClock },
    );

    assert.ok(result.updated.includes('Status'), `updated should include Status; got ${JSON.stringify(result.updated)}`);
    // The transition must produce a body Status field carrying "Executing Phase 3".
    // Use the same primitive the production code uses, not a source-grep.
    const bodyStatus = stateExtractField(result.content, 'Status');
    assert.ok(
      /Executing Phase\s+3\b/.test(bodyStatus || ''),
      `body Status should match /Executing Phase 3/; got ${JSON.stringify(bodyStatus)}`,
    );
  });
});

// Shared fixture for first-time begin: a clean STATE.md body where no
// "Executing Phase N" status is present yet.
function firstTimeBody() {
  return [
    '# Project State',
    '',
    '**Status:** Planning',
    '**Current Phase:** 02',
    '**Current Phase Name:** Previous Phase',
    '**Current Plan:** 02',
    '**Total Plans in Phase:** 3',
    '**Last Activity:** 2026-06-20',
    '**Last Activity Description:** previous work',
    '**Current focus:** Phase 2 — Previous Phase',
    '',
    '## Current Position',
    '',
    'Phase: 2 (Previous Phase)',
    'Plan: 2 of 3',
    'Status: Planning',
    'Last activity: 2026-06-20 — context gathered',
    '',
  ].join('\n');
}

describe('ADR-1769 Phase 1: beginPhase first-time body field updates', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock };

  test('updates Current Phase to N', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase'), '3');
    assert.ok(result.updated.includes('Current Phase'));
  });

  test('updates Current Phase Name when phaseName is provided', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase Name'), 'Test Phase');
    assert.ok(result.updated.includes('Current Phase Name'));
  });

  test('sets Current Plan to 1 on first-time begin', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '1');
    assert.ok(result.updated.includes('Current Plan'));
  });

  test('updates Total Plans in Phase to planCount when provided', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.ok(result.updated.includes('Total Plans in Phase'));
  });

  test('updates Last Activity to clock.today()', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
    assert.ok(result.updated.includes('Last Activity'));
  });

  test('updates Last Activity Description to "Phase N execution started"', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'Phase 3 execution started',
    );
    assert.ok(result.updated.includes('Last Activity Description'));
  });

  test('updates **Current focus:** body text line (#1104)', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    // The **Current focus:** line should now carry the new phase label.
    const focusMatch = result.content.match(/\*\*Current focus:\*\*\s*(.*)/i);
    assert.ok(focusMatch, '**Current focus:** line must still be present');
    assert.strictEqual(focusMatch[1].trim(), 'Phase 3 — Test Phase');
    assert.ok(result.updated.includes('Current focus'),
      `updated should include 'Current focus'; got ${JSON.stringify(result.updated)}`);
  });
});

// Fixture for resume: a STATE.md body where Status already contains
// "Executing Phase 3" — the #3127 idempotency guard must detect this and
// skip the first-time-only field writes.
function resumeBody() {
  return [
    '# Project State',
    '',
    '**Status:** Executing Phase 3',
    '**Current Phase:** 03',
    '**Current Phase Name:** Test Phase',
    '**Current Plan:** 02',
    '**Total Plans in Phase:** 5',
    '**Last Activity:** 2026-06-26',
    '**Last Activity Description:** mid-flight context from plan 3-02',
    '',
    '## Current Position',
    '',
    'Phase: 3 (Test Phase) — EXECUTING',
    'Plan: 2 of 5',
    'Status: Executing Phase 3',
    'Last activity: 2026-06-26 — mid-flight context',
    '',
  ].join('\n');
}

describe('ADR-1769 Phase 1: #3127 idempotency guard — resume path', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock };

  test('Status is still refreshed on resume (Last Activity Date tracks execute-phase runs)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
    assert.ok(result.updated.includes('Last Activity'));
  });

  test('Current Plan is NOT overwritten on resume (#3127 — preserves mid-flight plan number)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '02');
    assert.ok(!result.updated.includes('Current Plan'),
      `Current Plan must not be in updated on resume; got ${JSON.stringify(result.updated)}`);
  });

  test('Total Plans in Phase is NOT overwritten on resume', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.ok(!result.updated.includes('Total Plans in Phase'));
  });

  test('Last Activity Description is NOT overwritten on resume (#3127 — preserves mid-flight context)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'mid-flight context from plan 3-02',
    );
    assert.ok(!result.updated.includes('Last Activity Description'));
  });

  test('Current Phase Name is NOT overwritten on resume', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase Name'), 'Test Phase');
    assert.ok(!result.updated.includes('Current Phase Name'));
  });
});

describe('ADR-1769 Phase 1: Current Position section mutation (first-time begin)', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock };

  test('Current Position Phase line reflects the new phase (EXECUTING)', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.ok(result.updated.includes('Current Position'),
      `updated should include Current Position; got ${JSON.stringify(result.updated)}`);
    // Verify by extracting Phase from the result content (covers both inline and pipe-table).
    // The transition writes "Phase: 3 (Test Phase) — EXECUTING" into ## Current Position.
    // stateExtractField returns the first match across the whole content, but the
    // **Current Phase:** frontmatter-style line is a different field, so 'Phase'
    // extraction finds the Current Position line.
    const posPhase = stateExtractField(result.content, 'Phase');
    assert.ok(
      /3.*Test Phase.*EXECUTING/.test(posPhase || ''),
      `Current Position Phase line should match /3.*Test Phase.*EXECUTING/; got ${JSON.stringify(posPhase)}`,
    );
  });

  test('Current Position Plan line shows "1 of N"', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    const posPlan = stateExtractField(result.content, 'Plan');
    assert.ok(
      /1 of 5/.test(posPlan || ''),
      `Current Position Plan line should match /1 of 5/; got ${JSON.stringify(posPlan)}`,
    );
  });

  test('Current Position Status line reflects Executing Phase N', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    // 'Status' extraction returns the first match — which is the top-level
    // **Status:** line. The Current Position Status line is a different field
    // occurrence. Extract from the section to disambiguate.
    const { tokenizeHeadings } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
    const body = result.content;
    const hs = tokenizeHeadings(body);
    const posIdx = hs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
    assert.notStrictEqual(posIdx, -1, 'Current Position section must exist');
    // Slice the section body and look for the Status line within it.
    const h = hs[posIdx];
    const lines = body.split('\n');
    const hl = lines[h.line - 1];
    const bodyStart = h.offset + hl.length + 1;
    let bodyEnd = body.length;
    for (let j = posIdx + 1; j < hs.length; j++) {
      if (hs[j].level >= 2) { bodyEnd = hs[j].offset - 1; break; }
    }
    const sectionBody = body.slice(bodyStart, bodyEnd);
    const sectionStatus = stateExtractField(sectionBody, 'Status');
    assert.ok(
      /Executing Phase\s+3/.test(sectionStatus || ''),
      `Current Position Status line should match /Executing Phase 3/; got ${JSON.stringify(sectionStatus)}`,
    );
  });
});

describe('ADR-1769 Phase 1: Current Position section mutation (resume path)', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock };

  test('Resume updates only the Last activity line in Current Position (preserves Plan, Phase, Status)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.ok(result.updated.includes('Last activity (resume)') || result.updated.includes('Last Activity'),
      `resume should update Last activity; got ${JSON.stringify(result.updated)}`);
    // Plan line in Current Position should still say "2 of 5" (NOT reset to "1 of 5").
    const posPlan = stateExtractField(result.content, 'Plan');
    assert.ok(
      /2 of 5/.test(posPlan || ''),
      `resume should preserve Plan "2 of 5"; got ${JSON.stringify(posPlan)}`,
    );
  });
});

describe('ADR-1769 Phase 1: property tests (RULESET.TESTS.property-based-testing)', () => {
  const deps = { clock: fixedClock };

  test('for any non-negative integer phaseNumber and any STATE.md body with a non-whitespace Status value, beginPhase produces content whose body Status carries "Executing Phase N"', () => {
    // Note: filters out whitespace-only statusSuffix because state-document.cjs's
    // bold stateReplaceField pattern uses greedy \s* that consumes the trailing
    // newline when the value is whitespace-only — a pre-existing bug surfaced
    // by this property test, not introduced by ADR-1769. Filed as a follow-up.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.string({ minLength: 1 }).filter(s => s.trim().length > 0 && !s.includes('\u0000')),
        (phaseNum, statusSuffix) => {
          const input = `# Project State\n\n**Status:** ${statusSuffix}\n`;
          const result = transitionCore(
            input,
            { kind: 'beginPhase', phaseNumber: phaseNum, phaseName: null, planCount: null },
            deps,
          );
          const bodyStatus = stateExtractField(result.content, 'Status') || '';
          return new RegExp(`Executing Phase\\s+${phaseNum}\\b`).test(bodyStatus);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('getFieldClassification own-property lookup always returns null or a valid {source, preservation} row', () => {
    const allowedSources = new Set(['body', 'disk', 'external', 'curated', 'free']);
    const allowedPreservation = new Set([
      'derive',
      'preserve-when-unchanged',
      'preserve-always',
      'preserve-if-placeholder',
      'clear',
    ]);
    fc.assert(
      fc.property(fc.string(), (s) => {
        const cls = getFieldClassification(s);
        if (cls === null) return true;
        return allowedSources.has(cls.source) && allowedPreservation.has(cls.preservation);
      }),
      { numRuns: 200 },
    );
  });
});

describe('ADR-1769 Phase 2: advancePlan transition', () => {
  const deps = { clock: fixedClock };

  test('advances Current Plan from N to N+1 (legacy format)', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 02',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.current_plan, 3);
    assert.strictEqual(result.data && result.data.total_plans, 5);
  });

  test('phase-complete branch when currentPlan >= totalPlans', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 05',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, false);
    assert.strictEqual(result.data && result.data.reason, 'last_plan');
    assert.strictEqual(result.data && result.data.status, 'ready_for_verification');
  });

  test('error when plan fields are unparseable', () => {
    const input = '# Project State\n\nNo plan fields here.\n';
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.error, true);
    assert.deepStrictEqual(result.updated, []);
  });

  test('compound format: "Plan: 2 of 6" preserves compound shape', () => {
    const input = [
      '# Project State',
      '',
      '**Plan:** 2 of 6',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    const plan = stateExtractField(result.content, 'Plan');
    assert.ok(/3 of 6/.test(plan || ''), `Plan should be "3 of 6"; got ${JSON.stringify(plan)}`);
    assert.strictEqual(result.data && result.data.advanced, true);
  });
});

describe('ADR-1769 Phase 2: advancePlan with frontmatter (#1255 pattern — codex review)', () => {
  const deps = { clock: fixedClock };

  test('advances plan correctly when STATE.md has YAML frontmatter (body Status not YAML status)', () => {
    const input = [
      '---',
      'status: Executing Phase 3',
      'current_phase: "03"',
      '---',
      '',
      '# Project State',
      '',
      '**Current Plan:** 02',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    // Body Current Plan must advance to 3.
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    // Body Status must be updated (not the YAML status key).
    const bodyStatus = stateExtractField(result.content, 'Status');
    assert.ok(
      /Ready to execute/.test(bodyStatus || ''),
      `body Status should be "Ready to execute"; got ${JSON.stringify(bodyStatus)}`,
    );
    assert.strictEqual(result.data && result.data.advanced, true);
  });
});

// Shared fixture for completePhase: a STATE.md body mid-execution with the
// progress fields the cmdPhaseComplete transform touches. Mirrors the shape
// state.cts:buildStateFrontmatter emits.
function completePhaseBody() {
  return [
    '# Project State',
    '',
    '**Current Phase:** 3 of 5 (Old Name)',
    '**Current Phase Name:** Old Name',
    '**Current Plan:** 2',
    '**Status:** Executing Phase 3',
    '**Last Activity:** 2026-06-20',
    '**Last Activity Description:** mid-flight',
    '**Completed Phases:** 2',
    '**Total Phases:** 5',
    '**Progress:** 40%',
    'percent: 40',
    '',
  ].join('\n');
}

// A roadmap with a progress table: 3 of 5 phases Complete → deriveProgressFromRoadmap
// returns { completedPhases: 3, totalPhases: 5 }.
// ADR-2143 (epic #2143): deriveProgressFromRoadmap now resolves this table via the
// markdown-table schema registry (TABLE_SCHEMAS.RoadmapProgress), which requires the
// exact canonical header (gsd-core/templates/roadmap.md); the 2nd column is named
// "Plans Complete" to match (its cell values here are unused free text, not M/N
// counts — no test in this file asserts totalPlans).
const ROADMAP_3_OF_5 = [
  '## Roadmap',
  '',
  '| Phase | Plans Complete | Status | Completed |',
  '| --- | --- | --- | --- |',
  '| 1 | A | Complete | 2026-01-01 |',
  '| 2 | B | Complete | 2026-02-01 |',
  '| 3 | C | Complete | 2026-03-01 |',
  '| 4 | D | In Progress | - |',
  '| 5 | E | Pending | - |',
  '',
].join('\n');

describe('ADR-1769 Phase 3: completePhase transition — body field updates', () => {
  const deps = { clock: fixedClock, roadmapProvider: () => ROADMAP_3_OF_5 };

  test('Current Phase advances to nextPhaseNum, preserving "of total" and appending the next name', () => {
    const intent = {
      kind: 'completePhase',
      phaseNum: '3',
      nextPhaseNum: '4',
      nextPhaseName: 'Design Phase',
      isLastPhase: false,
      planCount: 3,
      summaryCount: 3,
    };
    const result = transitionCore(completePhaseBody(), intent, deps);
    const cp = stateExtractField(result.content, 'Current Phase');
    assert.ok(
      /^4 of 5 \(Design Phase\)$/.test(cp || ''),
      `Current Phase should be "4 of 5 (Design Phase)"; got ${JSON.stringify(cp)}`,
    );
    assert.ok(result.updated.includes('Current Phase'));
  });

  test('Current Phase Name is set to nextPhaseName when provided', () => {
    const intent = {
      kind: 'completePhase',
      phaseNum: '3',
      nextPhaseNum: '4',
      nextPhaseName: 'Design Phase',
      isLastPhase: false,
      planCount: 3,
      summaryCount: 3,
    };
    const result = transitionCore(completePhaseBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase Name'), 'Design Phase');
  });

  test('Status becomes "Ready to plan" when not the last phase', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: 'Design Phase', isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Ready to plan');
  });

  test('Status becomes "All phases complete" when isLastPhase is true', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '5', nextPhaseNum: null, nextPhaseName: null, isLastPhase: true, planCount: 2, summaryCount: 2 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'All phases complete');
  });

  test('Current Plan resets to "Not started"', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), 'Not started');
  });

  test('Last Activity Description carries transition narrative', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'Phase 3 complete, transitioned to Phase 4',
    );
  });

  test('Last Activity Description has no transition clause when there is no next phase', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '5', nextPhaseNum: null, nextPhaseName: null, isLastPhase: true, planCount: 2, summaryCount: 2 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Last Activity Description'), 'Phase 5 complete');
  });
});

describe('ADR-1769 Phase 3: completePhase progress derivation (roadmap)', () => {
  const deps = { clock: fixedClock, roadmapProvider: () => ROADMAP_3_OF_5 };

  test('Completed Phases is re-derived from the roadmap progress table', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Completed Phases'), '3');
  });

  test('Progress percent is recomputed and the inline percent: token is updated', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Progress'), '60%');
    assert.ok(/percent:\s*60/.test(result.content), `inline percent: token should be 60; content was:\n${result.content}`);
  });

  test('when roadmapProvider yields null, existing Completed Phases / Progress are preserved (no crash)', () => {
    const nullDeps = { clock: fixedClock, roadmapProvider: () => null };
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      nullDeps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Completed Phases'), '2');
    assert.strictEqual(stateExtractField(result.content, 'Progress'), '40%');
  });

  // #3057 B9: `result.updated` must let a caller tell "recomputed from the
  // roadmap" apart from "roadmap unavailable, left as-is". Before the fix,
  // `stateReplaceField`'s return was truthy whenever the field pattern
  // matched — regardless of whether the substituted text actually differed
  // from `body` — so 'Completed Phases' (and 'Progress') were marked
  // 'updated' even when nothing changed.

  test('FAILURE path (roadmap unavailable): Completed Phases / Progress are NOT marked updated — left-as-is is distinguishable from recomputed', () => {
    const nullDeps = { clock: fixedClock, roadmapProvider: () => null };
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      nullDeps,
    );
    assert.ok(!result.updated.includes('Completed Phases'),
      `left-as-is 'Completed Phases' must NOT appear in updated; got ${JSON.stringify(result.updated)}`);
    assert.ok(!result.updated.includes('Progress'),
      `left-as-is 'Progress' must NOT appear in updated; got ${JSON.stringify(result.updated)}`);
    // Values are unchanged (the benign-preservation contract from the test above).
    assert.strictEqual(stateExtractField(result.content, 'Completed Phases'), '2');
    assert.strictEqual(stateExtractField(result.content, 'Progress'), '40%');
  });

  test('BENIGN path (roadmap recomputes a different value): Completed Phases / Progress ARE marked updated — recomputed is distinguishable from left-as-is', () => {
    const result = transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps, // roadmapProvider => ROADMAP_3_OF_5, which recomputes Completed Phases 2 → 3
    );
    assert.ok(result.updated.includes('Completed Phases'),
      `recomputed 'Completed Phases' must appear in updated; got ${JSON.stringify(result.updated)}`);
    assert.ok(result.updated.includes('Progress'),
      `recomputed 'Progress' must appear in updated; got ${JSON.stringify(result.updated)}`);
    assert.strictEqual(stateExtractField(result.content, 'Completed Phases'), '3');
    assert.strictEqual(stateExtractField(result.content, 'Progress'), '60%');
  });
});

describe('ADR-1769 Phase 3: completePhase edge cases', () => {
  const deps = { clock: fixedClock, roadmapProvider: () => ROADMAP_3_OF_5 };

  test('falls back to the "Phase:" field when "Current Phase:" is absent (stateReplaceFieldWithFallback)', () => {
    const input = [
      '# Project State',
      '',
      'Phase: 3 of 5',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-20',
      '**Completed Phases:** 2',
      '**Total Phases:** 5',
      '**Progress:** 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    const phase = stateExtractField(result.content, 'Phase');
    assert.ok(/^4 of 5/.test(phase || ''), `Phase should advance to "4 of 5"; got ${JSON.stringify(phase)}`);
  });

  test('updates body Status, not the YAML status key, when frontmatter is present (#1255)', () => {
    const input = [
      '---',
      'status: executing',
      'current_phase: "3"',
      '---',
      '',
      '# Project State',
      '',
      '**Current Phase:** 3 of 5',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-20',
      '**Completed Phases:** 2',
      '**Total Phases:** 5',
      '**Progress:** 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    // Body Status line must read "Ready to plan".
    const bodyStatus = stateExtractField(result.content, 'Status');
    assert.strictEqual(bodyStatus, 'Ready to plan');
    // Frontmatter must remain a block and keep its YAML keys (not be mangled).
    assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(result.content), 'frontmatter block must be preserved');
    const fmLine = result.content.split('\n').find((l) => /^status:/.test(l));
    assert.ok(fmLine && /executing/.test(fmLine), `YAML status key must be untouched; got ${JSON.stringify(fmLine)}`);
  });

  test('when nextPhaseName is absent and Current Phase had no "of total", value is the bare phase number', () => {
    const input = [
      '# Project State',
      '',
      '**Current Phase:** 3',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-20',
      '**Completed Phases:** 2',
      '**Total Phases:** 5',
      '**Progress:** 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: null, isLastPhase: false, planCount: 3, summaryCount: 3 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Current Phase'), '4');
  });
});

// ADR-1769 Phase 4: plannedPhase + milestoneSwitch

function plannedPhaseBody() {
  return [
    '# Project State',
    '',
    '**Status:** Planning',
    '**Total Plans in Phase:** 0',
    '**Last Activity:** 2026-06-20',
    '**Last Activity Description:** previous planning',
    '',
    '## Current Position',
    '',
    'Phase: 3 (Test Phase) — EXECUTING',
    'Plan: —',
    'Status: Executing Phase 3',
    'Last activity: 2026-06-20 — mid-flight',
    '',
  ].join('\n');
}

describe('ADR-1769 Phase 4: plannedPhase transition — body field updates', () => {
  const deps = { clock: fixedClock };

  test('Status advances to "Ready to execute" when the existing value is a template default (Planning)', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Ready to execute');
    assert.ok(result.updated.includes('Status'));
  });

  test('Total Plans in Phase is set to planCount', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '4');
    assert.ok(result.updated.includes('Total Plans in Phase'));
  });

  test('Last Activity is refreshed to clock.today() when the existing value is a date (template default)', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
  });

  test('Last Activity Description carries the planning-complete narrative', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'Phase 3 planning complete — 4 plans ready',
    );
  });

  test('Current Position Status + Last activity are updated', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.ok(result.updated.includes('Current Position'),
      `updated should include Current Position; got ${JSON.stringify(result.updated)}`);
    // The Current Position section should now carry the planning-complete narrative.
    assert.ok(/Phase 3 planning complete/.test(result.content));
  });

  test('executor-authored Status is preserved (Knuth invariant — non-template value not overwritten)', () => {
    const custom = plannedPhaseBody().replace('**Status:** Planning', '**Status:** Awaiting human design review');
    const result = transitionCore(custom, { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Awaiting human design review');
    assert.ok(!result.updated.includes('Status'),
      `Status must not be in updated for an executor-authored value; got ${JSON.stringify(result.updated)}`);
  });

  test('planCount=null leaves Total Plans in Phase untouched', () => {
    const result = transitionCore(plannedPhaseBody(), { kind: 'plannedPhase', phaseNumber: 3, planCount: null }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '0');
    assert.ok(!result.updated.includes('Total Plans in Phase'));
  });

  test('frontmatter is preserved and body Status (not YAML status) is updated (#1255)', () => {
    const input = [
      '---',
      'status: planning',
      '---',
      '',
      '# Project State',
      '',
      '**Status:** Planning',
      '**Total Plans in Phase:** 0',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** prev',
      '',
      '## Current Position',
      '',
      'Status: Executing Phase 3',
      'Last activity: 2026-06-20 — mid',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'plannedPhase', phaseNumber: 3, planCount: 2 }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Ready to execute');
    assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(result.content), 'frontmatter block preserved');
  });
});

describe('ADR-1769 Phase 4: milestoneSwitch transition — milestone reset', () => {
  const deps = { clock: fixedClock };

  function milestoneBody() {
    return [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Old Milestone',
      'status: executing',
      'current_phase: "3"',
      'progress:',
      '  total_phases: 5',
      '  completed_phases: 2',
      '  percent: 40',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 — EXECUTING',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      'Last activity: 2026-06-20 — mid-flight',
      '',
    ].join('\n');
  }

  test('frontmatter milestone + milestone_name are reset to the new version', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    const fmLine = (key) => result.content.split('\n').find((l) => new RegExp(`^${key}:`).test(l));
    assert.strictEqual(fmLine('milestone'), 'milestone: v2.0');
    assert.strictEqual(fmLine('milestone_name'), 'milestone_name: New Milestone');
  });

  test('frontmatter status resets to planning and progress resets to zero', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    assert.strictEqual(result.content.split('\n').find((l) => /^status:/.test(l)), 'status: planning');
    assert.ok(/total_phases:\s*0/.test(result.content), 'total_phases should reset to 0');
    assert.ok(/completed_phases:\s*0/.test(result.content), 'completed_phases should reset to 0');
    assert.ok(/percent:\s*0/.test(result.content), 'percent should reset to 0');
  });

  test('gsd_state_version is preserved across the reset', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    assert.ok(/gsd_state_version:\s*1\.0/.test(result.content), 'gsd_state_version must be preserved');
  });

  test('Current Position section is reset to "Not started (defining requirements)"', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    assert.ok(/Phase: Not started \(defining requirements\)/.test(result.content));
    assert.ok(/Status: Defining requirements/.test(result.content));
    assert.ok(new RegExp(`Last activity: 2026-06-27 — Milestone v2.0 started`).test(result.content));
  });

  test('Accumulated Context / body content outside Current Position is preserved', () => {
    const input = milestoneBody() +
      '\n## Accumulated Context\n\n- An important decision we must keep.\n';
    const result = transitionCore(input, { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' }, deps);
    assert.ok(/An important decision we must keep/.test(result.content),
      'Accumulated Context must survive the milestone reset');
  });

  test('blank name falls back to the "milestone" placeholder', () => {
    const result = transitionCore(milestoneBody(), { kind: 'milestoneSwitch', version: 'v2.0', name: '' }, deps);
    assert.strictEqual(
      result.content.split('\n').find((l) => /^milestone_name:/.test(l)),
      'milestone_name: milestone',
    );
  });
});

// ADR-1769 Phase 5: milestoneComplete

describe('ADR-1769 Phase 5: milestoneComplete transition — closure write', () => {
  const deps = { clock: fixedClock };
  const intent = { kind: 'milestoneComplete', version: 'v1.0', nextMilestoneCommand: '/gsd:new-milestone' };

  function preCloseBody() {
    return [
      '# Project State',
      '',
      '**Status:** Executing Phase 5',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** mid-flight',
      '',
      '## Current Position',
      '',
      'Phase: 5 — EXECUTING',
      'Plan: 2 of 3',
      'Status: Executing Phase 5',
      'Last activity: 2026-06-20 — running',
      '',
      '## Operator Next Steps',
      '',
      '- Re-run /gsd:complete-milestone v1.0',
      '',
    ].join('\n');
  }

  test('Status becomes "<version> milestone complete"', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'v1.0 milestone complete');
    assert.ok(result.updated.includes('Status'));
  });

  test('Last Activity is refreshed to clock.today()', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
  });

  test('Last Activity Description carries the archived narrative', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'v1.0 milestone completed and archived',
    );
  });

  test('Current Position resets to "Awaiting next milestone" with archived narrative', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.ok(/Phase: Milestone v1\.0 complete/.test(result.content));
    assert.ok(/Status: Awaiting next milestone/.test(result.content));
    assert.ok(/Last activity: 2026-06-27 — Milestone v1\.0 completed and archived/.test(result.content));
    assert.ok(result.updated.includes('Current Position'));
  });

  test('Operator Next Steps is rewritten to point at the next-milestone command', () => {
    const result = transitionCore(preCloseBody(), intent, deps);
    assert.ok(/## Operator Next Steps/.test(result.content));
    assert.ok(/- Start the next milestone with \/gsd:new-milestone/.test(result.content));
    // The stale prior instruction must be gone.
    assert.ok(!/Re-run \/gsd:complete-milestone/.test(result.content),
      'stale Operator Next Steps tail must be replaced');
  });

  test('#2245 F7: CRLF blank line after a reset heading is preserved (byte-parity with LF)', () => {
    // resetSectionVerbatim's post-heading blank-swallow loop recognised only
    // a bare `\n` — on a CRLF document, a `\r\n` blank line right after the
    // heading fell into the DISCARDED span instead of the kept prefix,
    // silently dropping one blank line relative to the LF-equivalent output.
    const lfResult = transitionCore(preCloseBody(), intent, deps);
    const crlfResult = transitionCore(preCloseBody().replace(/\n/g, '\r\n'), intent, deps);

    assert.strictEqual(
      crlfResult.content.replace(/\r\n/g, '\n'),
      lfResult.content,
      'CRLF output, normalized back to LF, must match the LF output byte-for-byte',
    );
  });

  test('Operator Next Steps section is inserted when absent', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Executing Phase 5',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** mid',
      '',
      '## Current Position',
      '',
      'Phase: 5 — EXECUTING',
      'Status: Executing Phase 5',
      '',
    ].join('\n');
    const result = transitionCore(input, intent, deps);
    assert.ok(/## Operator Next Steps/.test(result.content));
    assert.ok(/- Start the next milestone with \/gsd:new-milestone/.test(result.content));
  });

  test('Current Position section is inserted when absent', () => {
    const input = '# Project State\n\n**Status:** Executing\n**Last Activity:** 2026-06-20\n';
    const result = transitionCore(input, intent, deps);
    assert.ok(/## Current Position/.test(result.content));
    assert.ok(/Status: Awaiting next milestone/.test(result.content));
  });

  test('frontmatter is preserved across the closure write (#1255)', () => {
    const input = [
      '---',
      'status: executing',
      'milestone: v1.0',
      '---',
      '',
      '# Project State',
      '',
      '**Status:** Executing Phase 5',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** mid',
      '',
      '## Current Position',
      '',
      'Phase: 5 — EXECUTING',
      'Status: Executing Phase 5',
      '',
    ].join('\n');
    const result = transitionCore(input, intent, deps);
    // Body Status must be the closure value, not the YAML status key.
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'v1.0 milestone complete');
    assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(result.content), 'frontmatter block preserved');
    assert.ok(/^milestone: v1\.0/m.test(result.content), 'frontmatter milestone preserved');
  });
});

// ADR-1769 Phase 6: patch

describe('ADR-1769 Phase 6: patch transition — field updates', () => {
  const deps = { clock: fixedClock };

  test('applies each patched field and reports the updated set', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Planning',
      '**Current Plan:** 2',
      '**Total Plans in Phase:** 5',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'patch', patches: { Status: 'Paused', 'Current Plan': '3' } },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Paused');
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    assert.deepStrictEqual(result.data && result.data.updated, ['Status', 'Current Plan']);
  });

  test('reports failed fields (no matching field in content)', () => {
    const input = '# Project State\n\n**Status:** Planning\n';
    const result = transitionCore(
      input,
      { kind: 'patch', patches: { Status: 'Paused', Nonexistent: 'x' } },
      deps,
    );
    assert.deepStrictEqual(result.data && result.data.updated, ['Status']);
    assert.deepStrictEqual(result.data && result.data.failed, ['Nonexistent']);
  });

  test('leaves content unchanged when no patch matches (no-op)', () => {
    const input = '# Project State\n\n**Status:** Planning\n';
    const result = transitionCore(input, { kind: 'patch', patches: { Nonexistent: 'x' } }, deps);
    assert.strictEqual(result.content, input);
    assert.deepStrictEqual(result.data && result.data.updated, []);
    assert.deepStrictEqual(result.data && result.data.failed, ['Nonexistent']);
  });

  test('patching a frontmatter YAML key directly updates the YAML line', () => {
    // patch operates on the full content (body + frontmatter), so a lowercase
    // frontmatter key like `stopped_at` is matched and replaced.
    const input = ['---', 'status: executing', 'stopped_at: 2026-01-01', '---', '', '# State', ''].join('\n');
    const result = transitionCore(input, { kind: 'patch', patches: { stopped_at: '2026-06-27' } }, deps);
    assert.ok(/^stopped_at: 2026-06-27$/m.test(result.content), 'YAML stopped_at must be patched');
    assert.deepStrictEqual(result.data && result.data.updated, ['stopped_at']);
  });
});

// ADR-1769 Phase 7: update, prune, sync

describe('ADR-1769 Phase 7: update transition — single body field', () => {
  const deps = { clock: fixedClock };

  test('replaces a body field and reports updated:true', () => {
    const input = '# Project State\n\n**Status:** Planning\n**Current Plan:** 2\n';
    const result = transitionCore(input, { kind: 'update', field: 'Current Plan', value: '3' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    assert.strictEqual(result.data && result.data.updated, true);
  });

  test('reports updated:false when the field is absent', () => {
    const input = '# Project State\n\n**Status:** Planning\n';
    const result = transitionCore(input, { kind: 'update', field: 'Nonexistent', value: 'x' }, deps);
    assert.strictEqual(result.content, input);
    assert.strictEqual(result.data && result.data.updated, false);
  });

  test('preserves frontmatter across the body update', () => {
    const input = ['---', 'status: planning', '---', '', '# State', '', '**Status:** Planning', ''].join('\n');
    const result = transitionCore(input, { kind: 'update', field: 'Status', value: 'Paused' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Status'), 'Paused');
    assert.ok(/^---\r?\n[\s\S]*?\r?\n---/.test(result.content));
  });
});

describe('ADR-1769 Phase 7: prune transition — section pruning', () => {
  const deps = { clock: fixedClock };

  test('archives Decisions entries at or below the cutoff phase', () => {
    const input = [
      '# Session State',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old',
      '- [Phase 3]: Older',
      '- [Phase 9]: Recent',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'prune', cutoff: 7 }, deps);
    const archived = (result.data && result.data.archivedSections) || [];
    assert.strictEqual(result.content.includes('[Phase 1]: Old'), false);
    assert.strictEqual(result.content.includes('[Phase 3]: Older'), false);
    assert.ok(result.content.includes('[Phase 9]: Recent'));
    const decisions = archived.find((s) => s.section === 'Decisions');
    assert.ok(decisions, 'Decisions archive entry must exist');
    assert.strictEqual(decisions.count, 2);
  });

  test('archives Performance Metrics table rows at or below the cutoff', () => {
    const input = [
      '# State',
      '',
      '## Performance Metrics',
      '',
      '| Phase | Plans | Total | Avg/Plan |',
      '| --- | --- | --- | --- |',
      '| 1 | 4 | 8 | 2 |',
      '| 9 | 2 | 4 | 2 |',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'prune', cutoff: 7 }, deps);
    assert.ok(result.content.includes('| 9 | 2 | 4 | 2 |'), 'phase-9 row must remain');
    assert.strictEqual(result.content.includes('| 1 | 4 | 8 | 2 |'), false, 'phase-1 row must be archived');
    assert.ok(result.content.includes('| Phase | Plans |'), 'header row preserved');
  });

  test('no-op when nothing is old enough (totalPruned === 0)', () => {
    const input = '# State\n\n## Decisions\n\n- [Phase 9]: Recent\n';
    const result = transitionCore(input, { kind: 'prune', cutoff: 7 }, deps);
    assert.strictEqual(result.content, input);
    assert.strictEqual((result.data && result.data.totalPruned) || 0, 0);
  });
});

describe('ADR-1769 Phase 7: sync transition — body writes + #1761', () => {
  const deps = { clock: fixedClock };

  test('updates Total Plans in Phase + Progress bar + Last Activity when bounded', () => {
    const input = [
      '# Project State',
      '',
      '**Total Plans in Phase:** 2',
      '**Last Activity:** 2026-06-20',
      '**Progress:** [████░░░░░░] 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'sync', totalPlansInPhase: 5, percent: 60 },
      deps,
    );
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
    assert.ok(/\[██████░░░░\] 60%/.test(result.content), 'Progress bar must be 60%');
  });

  test('#1761: leaves Progress untouched when percent is null (milestone unbounded)', () => {
    const input = [
      '# Project State',
      '',
      '**Total Plans in Phase:** 2',
      '**Last Activity:** 2026-06-20',
      '**Progress:** [█████░░░░░] 50%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'sync', totalPlansInPhase: 5, percent: null },
      deps,
    );
    // Total Plans + Last Activity still advance; Progress bar is left untouched.
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.ok(/\[█████░░░░░\] 50%/.test(result.content), 'Progress bar must be unchanged when percent is null');
  });

  test('skips Total Plans write when totalPlansInPhase is null', () => {
    const input = '# Project State\n\n**Total Plans in Phase:** 2\n**Progress:** 40%\n';
    const result = transitionCore(input, { kind: 'sync', totalPlansInPhase: null, percent: null }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-1769 #1796: applyStatePreservation — table-driven post-sync consolidation
//
// Path A ("finish the consolidation"): the post-sync preservation block that
// lived inline in readModifyWriteStateMd (state.cts) is absorbed into the
// Transition Module as a pure, field-classification-table-driven function.
// Every preserved field (progress, status, stopped_at, current_phase_name) is
// governed by its FIELD_CLASSIFICATION row — one policy source, not three
// drifting encodings. Behavior is identical to the pre-consolidation block;
// these tests pin the table-driven contract. See issue #1796.
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-1769 #1796: applyStatePreservation — table-driven post-sync consolidation', () => {
  // Shared no-op deltas for tests that only exercise one field.
  const untouched = {
    preBodyStatus: null, postBodyStatus: null,
    preBodyStoppedAt: null, postBodyStoppedAt: null,
    preBodyPhaseSource: null, postBodyPhaseSource: null,
  };

  test('progress: restores curated block when table=preserve-always and transition is not re-deriving (!resync)', () => {
    // Default behavior: wholesale curated restore. #3242 Bug A protection.
    const curated = { progress: { total_phases: 4, completed_phases: 3, percent: 75 } };
    const r = applyStatePreservation({
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_phases: 5, completed_phases: 0, percent: 0 } }, // disk-derived clobber
      resync: false,
      ...untouched,
    });
    assert.deepEqual(r.postFm.progress, { total_phases: 4, completed_phases: 3, percent: 75 });
    assert.equal(r.mutated, true);
  });

  test('#2440: deriveProgressKeys=true — total_plans takes derived value under !resync', () => {
    // The cmdStatePlannedPhase caller opts in via deriveProgressKeys. total_plans
    // and total_phases take the derived (post-sync) value; completed_plans and
    // completed_phases keep curated protection.
    const curated = { progress: { total_plans: 50, completed_plans: 50, total_phases: 2, completed_phases: 1, percent: 100 } };
    const r = applyStatePreservation({
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 64, completed_plans: 49, total_phases: 2, completed_phases: 1, percent: 77 } },
      resync: false,
      deriveProgressKeys: true,
      ...untouched,
    });
    assert.equal(r.postFm.progress.total_plans, 64,
      'total_plans must take derived value (64) when deriveProgressKeys=true (#2440)');
    assert.equal(r.postFm.progress.completed_plans, 50,
      'completed_plans must keep curated value (50 > 49 triggers ratchet)');
    assert.equal(r.postFm.progress.total_phases, 2,
      'total_phases takes derived value (same as curated here — identity)');
    assert.equal(r.mutated, true);
  });

  test('#2440 boundary: deriveProgressKeys=true, total_plans derived == curated → identity', () => {
    const curated = { progress: { total_plans: 64, completed_plans: 49 } };
    const r = applyStatePreservation({
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 64, completed_plans: 49, percent: 77 } },
      resync: false,
      deriveProgressKeys: true,
      ...untouched,
    });
    assert.equal(r.postFm.progress.total_plans, 64,
      'total_plans equality → derived value (identity)');
  });

  test('#2969: deriveProgressKeys=true — completed_plans ratchets UP when disk count exceeds curated (gap-closure plans completed)', () => {
    // Gap-closure scenario: a phase had 50 plans all summarized (completed_plans: 50),
    // then 4 gap-closure plans were added (total_plans -> 54) and all 4 got SUMMARYs.
    // Disk scan now counts 54 summaries. The curated completed_plans (50) must
    // ratchet UP to the derived value (54), not stay pinned at 50 — otherwise
    // completed_plans < total_plans forever even though every plan is summarized.
    const curated = { progress: { total_plans: 54, completed_plans: 50, total_phases: 2, completed_phases: 1, percent: 93 } };
    const r = applyStatePreservation({
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 54, completed_plans: 54, total_phases: 2, completed_phases: 1, percent: 100 } },
      resync: false,
      deriveProgressKeys: true,
      ...untouched,
    });
    assert.equal(r.postFm.progress.total_plans, 54, 'total_plans takes derived value');
    assert.equal(r.postFm.progress.completed_plans, 54,
      'completed_plans must ratchet UP to derived (54 > curated 50 — gap-closure plans completed) (#2969)');
    assert.equal(r.postFm.progress.percent, 100,
      'percent must reflect the true completion fraction (54/54) (#2969)');
  });

  test('#2969 ratchet-down protection: deriveProgressKeys=true keeps curated when disk count < curated', () => {
    // The ratchet must only go UP. If the disk count is somehow LOWER than
    // curated (e.g. a SUMMARY was deleted), keep the curated value — do not
    // derive downward. (#3242 curated-progress protection, scoped to deriveProgressKeys.)
    const curated = { progress: { total_plans: 54, completed_plans: 50, percent: 93 } };
    const r = applyStatePreservation({
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 54, completed_plans: 47, percent: 87 } },
      resync: false,
      deriveProgressKeys: true,
      ...untouched,
    });
    assert.equal(r.postFm.progress.completed_plans, 50,
      'completed_plans must NOT derive downward (47 < curated 50) — ratchet-up only (#2969/#3242)');
  });

  test('#2969 body-only write protection: deriveProgressKeys absent keeps wholesale restore', () => {
    // state.update/patch (no deriveProgressKeys flag) must keep the full #3242
    // wholesale curated restore — completed_plans never moves for a body-only edit.
    const curated = { progress: { total_plans: 54, completed_plans: 50, percent: 93 } };
    const r = applyStatePreservation({
      preFm: curated,
      preFmSnapshot: curated,
      postFm: { progress: { total_plans: 54, completed_plans: 54, percent: 100 } },
      resync: false,
      // deriveProgressKeys NOT set — body-only write path
      ...untouched,
    });
    assert.equal(r.postFm.progress.completed_plans, 50,
      'body-only write must keep curated completed_plans (no deriveProgressKeys) (#2969/#3242)');
  });

  test('progress: NOT restored when transition re-derives from disk (resync=true) — sync/advancePlan/completePhase path', () => {
    const recomputed = { progress: { total_phases: 5, completed_phases: 1, percent: 20 } };
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: {},
      postFm: { ...recomputed },
      resync: true,
      ...untouched,
    });
    assert.deepEqual(r.postFm.progress, { total_phases: 5, completed_phases: 1, percent: 20 });
    assert.equal(r.mutated, false);
  });

  test('status: preserves when body Status source is unchanged (preserve-when-unchanged) and snapshot holds a real status', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { status: 'completed' },
      postFm: { status: 'verifying' },
      resync: true,
      preBodyStatus: 'Executing Phase 3', postBodyStatus: 'Executing Phase 3',
      preBodyStoppedAt: null, postBodyStoppedAt: null,
      preBodyPhaseSource: null, postBodyPhaseSource: null,
    });
    assert.equal(r.postFm.status, 'completed');
    assert.equal(r.mutated, true);
  });

  test('status: does NOT preserve when the body Status source line changed this write', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { status: 'completed' },
      postFm: { status: 'verifying' },
      resync: true,
      preBodyStatus: 'Executing Phase 3', postBodyStatus: 'Completed Phase 3', // changed
      preBodyStoppedAt: null, postBodyStoppedAt: null,
      preBodyPhaseSource: null, postBodyPhaseSource: null,
    });
    assert.equal(r.postFm.status, 'verifying');
    assert.equal(r.mutated, false);
  });

  test('current_phase_name: preserves curated value when body Phase source unchanged (preserve-always)', () => {
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: { current_phase_name: 'curated-name' },
      postFm: { current_phase_name: 'wrong-parenthetical-harvest' },
      resync: true,
      preBodyStatus: null, postBodyStatus: null,
      preBodyStoppedAt: null, postBodyStoppedAt: null,
      preBodyPhaseSource: '3', postBodyPhaseSource: '3',
    });
    assert.equal(r.postFm.current_phase_name, 'curated-name');
    assert.equal(r.mutated, true);
  });

  test('returns mutated=false and untouched postFm when no preservation rule applies', () => {
    const postFm = { status: 'executing', progress: { percent: 10 } };
    const r = applyStatePreservation({
      preFm: null,
      preFmSnapshot: {},
      postFm,
      resync: true,
      ...untouched,
    });
    assert.equal(r.mutated, false);
    assert.deepEqual(r.postFm, { status: 'executing', progress: { percent: 10 } });
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-21-state-md-template-frontmatter.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-21-state-md-template-frontmatter (consolidation epic #1969 B8 #1977)", () => {
/**
 * Regression guard — Bug #21
 *
 * Both STATE.md template files must include a YAML frontmatter block in their
 * "File Template" section so that an AI agent creating .planning/STATE.md from
 * the template produces a file that frontmatter consumers can read immediately
 * (before the first `state.*` mutation calls syncStateFrontmatter).
 *
 * Prior to the fix, the template's File Template section began with
 * `# Project State` (no frontmatter), leaving the init→first-write window
 * without `gsd_state_version`, `status`, or `progress` keys.
 *
 * Acceptance criteria:
 * 1. The template body extracted from each state.md file's File Template code
 *    block must begin with `---`.
 * 2. The frontmatter must contain at minimum: `gsd_state_version` and `status`.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

const TEMPLATE_PATHS = [
  path.join(REPO_ROOT, 'gsd-core', 'templates', 'state.md'),
];

/**
 * Extract the content of the first ```markdown ... ``` code block from a
 * template file. Returns the raw string (including any leading/trailing
 * whitespace within the block).
 *
 * @param {string} fileContent - Full text of the template file.
 * @returns {string} The extracted code block body.
 */
function extractFileTemplate(fileContent) {
  const match = fileContent.match(/```markdown\r?\n([\s\S]*?)```/);
  assert.ok(match, 'No ```markdown code block found in template file');
  return match[1];
}

/**
 * Minimal YAML frontmatter parser: returns the set of top-level keys present
 * in the first --- ... --- block at the start of `text`. Does not parse nested
 * keys — list-valued fields (e.g. `tags: [a, b]`) are recorded only by their
 * key name, not their value. Returns an empty Set when the text has no frontmatter.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function parseFrontmatterKeys(text) {
  const keys = new Set();
  if (!text.trimStart().startsWith('---')) return keys;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === '---') { inBlock = true; continue; }
      break; // frontmatter must be at the very start
    }
    if (trimmed === '---') break; // end of block
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      keys.add(trimmed.slice(0, colonIdx).trim());
    }
  }
  return keys;
}

/**
 * Minimal YAML frontmatter parser: returns a plain object of top-level keys
 * and their scalar or nested-object values from the first --- ... --- block.
 * Handles one level of indented nesting (e.g. progress.total_plans).
 * Does not handle YAML lists or multi-line values.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseFrontmatter(text) {
  const result = {};
  if (!text.trimStart().startsWith('---')) return result;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let currentKey = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === '---') { inBlock = true; continue; }
      break;
    }
    if (trimmed === '---') break;
    // Detect indented (nested) line: starts with whitespace
    if (line.match(/^\s+\S/) && currentKey !== null) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const subKey = trimmed.slice(0, colonIdx).trim();
        const rawVal = trimmed.slice(colonIdx + 1).trim();
        const numVal = Number(rawVal);
        if (typeof result[currentKey] !== 'object') result[currentKey] = {};
        result[currentKey][subKey] = rawVal === '' ? null : (isNaN(numVal) ? rawVal : numVal);
      }
    } else {
      currentKey = null;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const rawVal = trimmed.slice(colonIdx + 1).trim();
        if (rawVal === '') {
          result[key] = {};
          currentKey = key;
        } else {
          const numVal = Number(rawVal);
          result[key] = isNaN(numVal) ? rawVal.replace(/^'|'$/g, '') : numVal;
          currentKey = null;
        }
      }
    }
  }
  return result;
}

describe('bug #21 — STATE.md template must carry YAML frontmatter', () => {
  for (const templatePath of TEMPLATE_PATHS) {
    const label = path.relative(REPO_ROOT, templatePath);

    test(`${label} — File Template block starts with frontmatter`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);

      // The template body must open with a YAML frontmatter delimiter.
      assert.ok(
        body.trimStart().startsWith('---'),
        `${label}: File Template must start with '---' (YAML frontmatter), ` +
        `but starts with: ${JSON.stringify(body.slice(0, 60))}`,
      );
    });

    test(`${label} — frontmatter contains gsd_state_version`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);
      const keys = parseFrontmatterKeys(body.trimStart());

      assert.ok(
        keys.has('gsd_state_version'),
        `${label}: frontmatter must include 'gsd_state_version', found keys: ${[...keys].join(', ')}`,
      );
    });

    test(`${label} — frontmatter contains status`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);
      const keys = parseFrontmatterKeys(body.trimStart());

      assert.ok(
        keys.has('status'),
        `${label}: frontmatter must include 'status', found keys: ${[...keys].join(', ')}`,
      );
    });

    test(`${label} — progress sub-schema has zeroed total_plans and completed_plans`, () => {
      const content = fs.readFileSync(templatePath, 'utf-8');
      const body = extractFileTemplate(content);
      const fm = parseFrontmatter(body.trimStart());

      assert.ok(
        fm.progress && typeof fm.progress === 'object',
        `${label}: frontmatter must include a 'progress' sub-object`,
      );
      assert.strictEqual(
        fm.progress.total_plans,
        0,
        `${label}: progress.total_plans must be 0 in the template`,
      );
      assert.strictEqual(
        fm.progress.completed_plans,
        0,
        `${label}: progress.completed_plans must be 0 in the template`,
      );
    });
  }

});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #3118: sliceCurrentPositionSection — locator characterization tests.
// ────────────────────────────────────────────────────────────────────────

describe('sliceCurrentPositionSection (#3118)', () => {
  test('slices the section up to the following heading', () => {
    const body = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 (Test Phase) — EXECUTING',
      '',
      '## Accumulated Context',
      '',
      '- A decision worth keeping.',
      '',
    ].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.ok(result.includes('Phase: 3 (Test Phase) — EXECUTING'));
    assert.ok(!result.includes('A decision worth keeping'));
  });

  test('slices to end of document for a trailing section', () => {
    const body = [
      '# Project State',
      '',
      '## Accumulated Context',
      '',
      '- Earlier decision.',
      '',
      '## Current Position',
      '',
      'Phase: 5 (Final Phase) — EXECUTING',
      '',
    ].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.ok(result.includes('Phase: 5 (Final Phase) — EXECUTING'));
  });

  test('returns null when the section is absent', () => {
    const body = [
      '# Project State',
      '',
      '## Accumulated Context',
      '',
      '- Some decision.',
      '',
      '## Deferred Items',
      '',
      '- Something deferred.',
      '',
    ].join('\n');
    assert.strictEqual(sliceCurrentPositionSection(body), null);
  });

  test('matches the heading case- and space-insensitively', () => {
    const body = [
      '# Project State',
      '',
      '##  CURRENT   POSITION',
      '',
      'Phase: 2 — EXECUTING',
      '',
    ].join('\n');
    assert.notStrictEqual(sliceCurrentPositionSection(body), null);
  });

  test('ignores a Current Position heading inside a code fence', () => {
    // The locator is fence-aware via `tokenizeHeadings` — a `##` line inside
    // a ``` fence is not a real heading, so this document has zero *real*
    // Current Position headings.
    const body = [
      '# Project State',
      '',
      '## Accumulated Context',
      '',
      '```markdown',
      '## Current Position',
      '',
      'Phase: 9 — should not be seen',
      '```',
      '',
    ].join('\n');
    assert.strictEqual(sliceCurrentPositionSection(body), null);
  });

  test('distinguishes an empty section from an absent one', () => {
    // An empty section and an absent one are different answers, and a caller
    // that folds them together reintroduces the collapse this epic removes.
    const body = [
      '# Project State',
      '',
      '## Current Position',
      '## Accumulated Context',
      '',
      '- A decision.',
      '',
    ].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.strictEqual(typeof result, 'string');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.trim(), '');
  });

  test('does not match an H3 Current Position', () => {
    const body = [
      '# Project State',
      '',
      '### Current Position',
      '',
      'Phase: 2 — EXECUTING',
      '',
    ].join('\n');
    assert.strictEqual(sliceCurrentPositionSection(body), null);
  });

  test('slices the first Current Position when the document has two', () => {
    // `findIndex` picks the first heading match and nothing pinned that
    // behavior down before this test.
    const body = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 — FIRST OCCURRENCE',
      '',
      '## Accumulated Context',
      '',
      '- unrelated',
      '',
      '## Current Position',
      '',
      'Phase: 9 — SECOND OCCURRENCE',
      '',
    ].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.ok(result.includes('FIRST OCCURRENCE'));
    assert.ok(!result.includes('SECOND OCCURRENCE'));
  });

  test('returns null for an empty document', () => {
    assert.strictEqual(sliceCurrentPositionSection(''), null);
  });

  test('slices a CRLF document identically', () => {
    // Only `\n` in a regex/split is the recurring CRLF defect class in this
    // repo (#1658 and successors) — verify the CRLF fixture, normalized back
    // to LF, matches the LF fixture's result byte-for-byte.
    const lines = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 (Test Phase) — EXECUTING',
      '',
      '## Accumulated Context',
      '',
      '- A decision worth keeping.',
      '',
    ];
    const lfResult = sliceCurrentPositionSection(lines.join('\n'));
    const crlfResult = sliceCurrentPositionSection(lines.join('\r\n'));
    // Strict form (#3118): normalize CRLF->LF and require exact equality with
    // the LF result. The looser `.replace(/\r/g, '')` form (previously used
    // here) strips ALL `\r` bytes including a stray unpaired trailing `\r`
    // left by the pre-fix `end = hs[j].offset - 1` slice — that loose
    // assertion is what let the CRLF-slice-defect ship undetected.
    assert.strictEqual(crlfResult.replace(/\r\n/g, '\n'), lfResult);
  });

  test('returns an empty string when the section is empty and the next heading follows immediately', () => {
    const body = ['# STATE', '', '## Current Position', '## Next Section', 'content'].join('\n');
    const result = sliceCurrentPositionSection(body);
    assert.strictEqual(result, '');
  });

  test('does not duplicate bytes when a transition mutates an empty adjacent section', () => {
    // Regression for #3118 review MAJOR: `locateCurrentPosition`'s newline
    // walk-back could land `end` before `start` when the section is empty
    // and the next heading follows with no blank line between. Every
    // mutator's `body.slice(0, start) + sectionBody + body.slice(end)`
    // reassembly then duplicated the bytes in the inverted `[end, start)`
    // range — a spurious blank line (LF) or `\r\n` (CRLF) inserted into
    // STATE.md on every transition.
    const lfBody = ['# STATE', '', '## Current Position', '## Next Section', 'content'].join('\n');
    const lfResult = transitionCore(
      lfBody,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: null, planCount: null },
      { clock: fixedClock },
    );
    assert.ok(
      !lfResult.content.includes('## Current Position\n\n## Next Section'),
      `expected no inserted blank line; got ${JSON.stringify(lfResult.content)}`,
    );
    assert.strictEqual(
      lfResult.content,
      '# STATE\n\n## Current Position\n## Next Section\ncontent',
    );
    assert.strictEqual(lfResult.content.length, lfBody.length);

    const crlfBody = ['# STATE', '', '## Current Position', '## Next Section', 'content'].join('\r\n');
    const crlfResult = transitionCore(
      crlfBody,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: null, planCount: null },
      { clock: fixedClock },
    );
    assert.ok(
      !crlfResult.content.includes('## Current Position\r\n\r\n## Next Section'),
      `expected no inserted CRLF; got ${JSON.stringify(crlfResult.content)}`,
    );
    assert.strictEqual(
      crlfResult.content,
      '# STATE\r\n\r\n## Current Position\r\n## Next Section\r\ncontent',
    );
    assert.strictEqual(crlfResult.content.length, crlfBody.length);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3118: deps.progressProvider is a required StateTransitionDeps field with
// 33 supply sites and zero call sites, and is being removed. Prove it
// behaviorally: no transition ever invokes it.
// ────────────────────────────────────────────────────────────────────────

describe('state transitions do not consult a progress provider (#3118)', () => {
  test('no transition invokes deps.progressProvider', () => {
    // An exploding stub is the behavioral form of "this field is inert";
    // asserting the declaration is absent would be source-grep theater.
    const exploding = () => { throw new Error('progressProvider must never be called'); };
    const clock = fixedClock;

    assert.doesNotThrow(() => transitionCore(
      firstTimeBody(),
      { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      [
        '# Project State',
        '',
        '**Current Plan:** 02',
        '**Total Plans in Phase:** 05',
        '**Status:** Executing Phase 3',
        '**Last Activity:** 2026-06-26',
        '',
        '## Current Position',
        '',
        'Plan: 2 of 5',
        'Status: Executing Phase 3',
        '',
      ].join('\n'),
      { kind: 'advancePlan' },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      completePhaseBody(),
      { kind: 'completePhase', phaseNum: '3', nextPhaseNum: '4', nextPhaseName: 'Design Phase', isLastPhase: false, planCount: 3, summaryCount: 3 },
      { clock, progressProvider: exploding, roadmapProvider: () => ROADMAP_3_OF_5 },
    ));

    assert.doesNotThrow(() => transitionCore(
      plannedPhaseBody(),
      { kind: 'plannedPhase', phaseNumber: 3, planCount: 4 },
      { clock, progressProvider: exploding },
    ));

    const milestoneBody = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Old Milestone',
      'status: executing',
      'current_phase: "3"',
      'progress:',
      '  total_phases: 5',
      '  completed_phases: 2',
      '  percent: 40',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 3 — EXECUTING',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      'Last activity: 2026-06-20 — mid-flight',
      '',
    ].join('\n');
    assert.doesNotThrow(() => transitionCore(
      milestoneBody,
      { kind: 'milestoneSwitch', version: 'v2.0', name: 'New Milestone' },
      { clock, progressProvider: exploding },
    ));

    const preCloseBody = [
      '# Project State',
      '',
      '**Status:** Executing Phase 5',
      '**Last Activity:** 2026-06-20',
      '**Last Activity Description:** mid-flight',
      '',
      '## Current Position',
      '',
      'Phase: 5 — EXECUTING',
      'Plan: 2 of 3',
      'Status: Executing Phase 5',
      'Last activity: 2026-06-20 — running',
      '',
      '## Operator Next Steps',
      '',
      '- Re-run /gsd:complete-milestone v1.0',
      '',
    ].join('\n');
    assert.doesNotThrow(() => transitionCore(
      preCloseBody,
      { kind: 'milestoneComplete', version: 'v1.0', nextMilestoneCommand: '/gsd:new-milestone' },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      [
        '# Project State',
        '',
        '**Status:** Planning',
        '**Current Plan:** 2',
        '**Total Plans in Phase:** 5',
        '',
      ].join('\n'),
      { kind: 'patch', patches: { Status: 'Paused', 'Current Plan': '3' } },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      '# Project State\n\n**Status:** Planning\n**Current Plan:** 2\n',
      { kind: 'update', field: 'Current Plan', value: '3' },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      [
        '# Session State',
        '',
        '## Decisions',
        '',
        '- [Phase 1]: Old',
        '- [Phase 3]: Older',
        '- [Phase 9]: Recent',
        '',
      ].join('\n'),
      { kind: 'prune', cutoff: 7 },
      { clock, progressProvider: exploding },
    ));

    assert.doesNotThrow(() => transitionCore(
      [
        '# Project State',
        '',
        '**Total Plans in Phase:** 2',
        '**Last Activity:** 2026-06-20',
        '**Progress:** [████░░░░░░] 40%',
        '',
      ].join('\n'),
      { kind: 'sync', totalPlansInPhase: 5, percent: 60 },
      { clock, progressProvider: exploding },
    ));
  });
});
