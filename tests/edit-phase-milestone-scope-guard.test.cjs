'use strict';

/**
 * #3262 — milestone-scope guard regression tests.
 *
 * The in-place phase editor (edit-phase workflow) and the phase-creation
 * entry templates (phase add / add-batch / insert) can splice free text into
 * ROADMAP.md that carries a level 1-3 heading with a milestone marker. Such a
 * heading terminates the current milestone window (computeMilestoneSectionEnd)
 * and silently drops phases from the derived milestone phase set. These tests
 * pin the two mechanical guards this fix adds:
 *
 *  1. `roadmap milestone-scope` — read-only probe emitting the current
 *     milestone window identity (scope + declared phase ids) so the edit-phase
 *     workflow can capture/compare around its write.
 *  2. phase add / add-batch / insert reject a description containing a
 *     milestone-scoping heading line before any write or directory creation.
 *
 * Behavioral only — every case drives the gsd-tools CLI seam.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const VERSIONED_ROADMAP = [
  '# Roadmap',
  '',
  '## v1.0 — Foundation',
  '',
  '### Phase 1: Setup',
  '',
  '**Goal:** bootstrap',
  '',
  '### Phase 2: API',
  '',
  '**Goal:** api',
  '',
  '### Phase 3: UI',
  '',
  '**Goal:** ui',
  '',
  '## v2.0 — Next',
  '',
  '### Phase 4: Extras',
  '',
  '**Goal:** extras',
  '',
].join('\n');

// The insidious shape: a stray milestone-bearing heading INSIDE the current
// milestone terminates the window early. The window still contains phase
// entries, so scope reads "complete" — the drop is silent, which is exactly
// why the guard must compare the phase SET, not just the scope value.
const NARROWED_ROADMAP = [
  '# Roadmap',
  '',
  '## v1.0 — Foundation',
  '',
  '### Phase 1: Setup',
  '',
  '**Goal:** bootstrap',
  '',
  '### Phase 2: API',
  '',
  '**Goal:** api',
  '',
  '## v2.1 Stretch — 🚧',
  '',
  '### Phase 3: UI',
  '',
  '**Goal:** ui',
  '',
  '## v2.0 — Next',
  '',
  '### Phase 4: Extras',
  '',
  '**Goal:** extras',
  '',
].join('\n');

const FREEFORM_ROADMAP = [
  '# Roadmap',
  '',
  '### Phase 1: Foundation',
  '',
  '**Goal:** bootstrap',
  '',
  '### Phase 2: Polish',
  '',
  '**Goal:** polish',
  '',
].join('\n');

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

function writeStateMilestone(tmpDir, version) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), `# State\n\nmilestone: ${version}\n`);
}

function readRoadmap(tmpDir) {
  return fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
}

function listPhaseDirs(tmpDir) {
  return fs.readdirSync(path.join(tmpDir, '.planning', 'phases'));
}

function runMilestoneScope(tmpDir) {
  const res = runGsdTools(['roadmap', 'milestone-scope'], tmpDir);
  assert.equal(res.success, true, `roadmap milestone-scope should exit 0, got: ${res.error || res.output}`);
  return JSON.parse(res.output);
}

// ─── roadmap milestone-scope probe ────────────────────────────────────────────

describe('#3262 roadmap milestone-scope probe', () => {
  test('reports the current milestone window phase set (later milestones excluded)', () => {
    const tmp = createTempProject('gsd-3262-scope-');
    try {
      writeStateMilestone(tmp, 'v1.0');
      writeRoadmap(tmp, VERSIONED_ROADMAP);
      const result = runMilestoneScope(tmp);
      assert.equal(result.scope, 'complete');
      assert.deepEqual(result.phases, ['1', '2', '3']);
      assert.equal(result.phase_count, 3);
    } finally {
      cleanup(tmp);
    }
  });

  test('a stray milestone heading inside the window silently narrows the phase set — the signal this probe exists to expose', () => {
    const tmp = createTempProject('gsd-3262-scope-');
    try {
      writeStateMilestone(tmp, 'v1.0');
      writeRoadmap(tmp, NARROWED_ROADMAP);
      const result = runMilestoneScope(tmp);
      // Phase 3 sits after the stray `## v2.1 Stretch — 🚧` terminator: it is
      // out of the window. Scope stays "complete" (the window still reaches
      // phase entries), so ONLY the phase set reveals the drop.
      assert.deepEqual(result.phases, ['1', '2']);
    } finally {
      cleanup(tmp);
    }
  });

  test('free-form roadmap (no versioned milestones) reports the whole-document phase set', () => {
    const tmp = createTempProject('gsd-3262-scope-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const result = runMilestoneScope(tmp);
      assert.equal(result.scope, 'complete');
      assert.deepEqual(result.phases, ['1', '2']);
    } finally {
      cleanup(tmp);
    }
  });

  test('missing ROADMAP.md is a decodable unreadable result, not a crash', () => {
    const tmp = createTempProject('gsd-3262-scope-');
    try {
      const res = runGsdTools(['roadmap', 'milestone-scope'], tmp);
      assert.equal(res.success, true);
      const parsed = JSON.parse(res.output);
      assert.equal(parsed.scope, 'unreadable');
      assert.deepEqual(parsed.phases, []);
      assert.ok(parsed.error, 'should carry an error field naming the missing roadmap');
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── phase add / add-batch / insert description guard ────────────────────────

describe('#3262 phase add milestone-scope heading guard', () => {
  test('rejects a description embedding a versioned milestone heading; ROADMAP and phase dirs untouched', () => {
    const tmp = createTempProject('gsd-3262-add-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const before = readRoadmap(tmp);
      const dirsBefore = listPhaseDirs(tmp);
      const res = runGsdTools(['phase', 'add', 'Extra work\n## v2.1 Evil — 🚧\nmore text'], tmp);
      assert.equal(res.success, false, 'phase add must reject an embedded milestone heading');
      assert.match(res.error || res.output, /v2\.1 Evil/, 'error must name the offending line');
      assert.equal(readRoadmap(tmp), before, 'ROADMAP.md must be byte-unchanged');
      assert.deepEqual(listPhaseDirs(tmp), dirsBefore, 'no phase directory may be created');
    } finally {
      cleanup(tmp);
    }
  });

  test('rejects a description embedding a "Milestone" word heading', () => {
    const tmp = createTempProject('gsd-3262-add-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const before = readRoadmap(tmp);
      const res = runGsdTools(['phase', 'add', 'Retro\n# Milestone Two\nnotes'], tmp);
      assert.equal(res.success, false);
      assert.equal(readRoadmap(tmp), before);
    } finally {
      cleanup(tmp);
    }
  });

  test('ordinary single-line description still succeeds (no false rejection)', () => {
    const tmp = createTempProject('gsd-3262-add-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const res = runGsdTools(['phase', 'add', 'Authentication and sessions'], tmp);
      assert.equal(res.success, true, `ordinary add must keep working: ${res.error || ''}`);
      assert.match(readRoadmap(tmp), /### Phase 3: Authentication and sessions/);
    } finally {
      cleanup(tmp);
    }
  });

  test('a milestone heading inside a fenced code block in the description is not a violation (parser is fence-aware)', () => {
    const tmp = createTempProject('gsd-3262-add-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const desc = 'Document auth\n\n```\n## v2.0 example heading\n```\n';
      const res = runGsdTools(['phase', 'add', desc], tmp);
      assert.equal(res.success, true, `fenced example must not trip the guard: ${res.error || ''}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('level-4+ headings and Phase-prefixed headings in a description are not violations', () => {
    const tmp = createTempProject('gsd-3262-add-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const desc = 'Notes\n#### Sub-notes heading\n### Phase 9: decoy reference';
      const res = runGsdTools(['phase', 'add', desc], tmp);
      assert.equal(res.success, true, `level-4/Phase-prefixed headings must not trip the guard: ${res.error || ''}`);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('#3262 phase insert milestone-scope heading guard', () => {
  test('rejects a description embedding a closed-marker milestone heading; ROADMAP untouched', () => {
    const tmp = createTempProject('gsd-3262-insert-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const before = readRoadmap(tmp);
      const res = runGsdTools(['phase', 'insert', '1', 'Sneaky\n## ✅ v3.0 Done\nnotes'], tmp);
      assert.equal(res.success, false, 'phase insert must reject an embedded milestone heading');
      assert.equal(readRoadmap(tmp), before, 'ROADMAP.md must be byte-unchanged');
    } finally {
      cleanup(tmp);
    }
  });

  test('ordinary insert description still succeeds (no false rejection)', () => {
    const tmp = createTempProject('gsd-3262-insert-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const res = runGsdTools(['phase', 'insert', '1', 'Decimal sub-phase'], tmp);
      assert.equal(res.success, true, `ordinary insert must keep working: ${res.error || ''}`);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('#3262 phase add-batch milestone-scope heading guard', () => {
  test('rejects the batch when any description embeds a milestone heading; ROADMAP untouched', () => {
    const tmp = createTempProject('gsd-3262-batch-');
    try {
      writeRoadmap(tmp, FREEFORM_ROADMAP);
      const before = readRoadmap(tmp);
      const descriptions = JSON.stringify(['Good phase', 'Bad\n## v2.1 Evil — 🚧']);
      const res = runGsdTools(['phase', 'add-batch', '--descriptions', descriptions], tmp);
      assert.equal(res.success, false, 'add-batch must reject an embedded milestone heading');
      assert.equal(readRoadmap(tmp), before, 'ROADMAP.md must be byte-unchanged (all-or-nothing)');
    } finally {
      cleanup(tmp);
    }
  });
});
