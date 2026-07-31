// allow-test-rule: behavioral-fs-fixture (#2828)
'use strict';

// Regression guard for #2828: on a flat unmilestoned roadmap (no versioned milestone
// heading), `state-snapshot`/`state record-session` reported progress.total_phases as
// the on-disk phase-dir count (1) instead of the authoritative roadmap count (6). The
// read-path disk-scan cache fell back to phaseDirs.length when milestoneBounded was
// false, even though roadmapPhaseCount (6) was correct for a flat roadmap (no sibling
// milestones to conflate). Fix: use roadmapPhaseCount as the floor when > 0.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('#2828 — total_phases uses the roadmap count on a flat unmilestoned roadmap', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-2828-');
    const planningDir = path.join(tmpDir, '.planning');
    // Flat unmilestoned roadmap with 6 phases (no versioned milestone heading).
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 1: Foundation',
        '### Phase 2: Core API',
        '### Phase 3: UI Layer',
        '### Phase 4: Integration',
        '### Phase 5: Polish',
        '### Phase 6: Release',
        '',
      ].join('\n'),
    );
    // Only phase 1 has been discussed → 1 phase dir on disk.
    const phaseDir = path.join(planningDir, 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Phase 1 Context\n');
    // Minimal STATE.md with a milestone set (so milestoneBounded is computed) but no
    // versioned heading to bound it to → the flat-roadmap unbounded case.
    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '---',
        'status: executing',
        'milestone: v1.0',
        'milestone_name: milestone',
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 01',
        '**Status:** In progress',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => cleanup(tmpDir));

  test('state sync writes progress.total_phases === 6 (roadmap count), not 1 (phase-dir count) (#2828)', () => {
    // `state sync` derives progress.total_phases from the disk-scan cache (the read path
    // #2828 fixes) and writes it to STATE.md frontmatter. Pre-fix this wrote 1.
    const result = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const stateMd = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
    const m = stateMd.match(/^progress:\s*\r?\n(?:[ \t]+\w+:.+\r?\n?)*?[ \t]+total_phases:\s*(\d+)/m);
    assert.ok(m, `progress.total_phases must be written by state sync. STATE.md:\n${stateMd}`);
    assert.strictEqual(
      Number(m[1]),
      6,
      `progress.total_phases must be the roadmap count (6) for a flat unmilestoned roadmap, not the on-disk phase-dir count (1). Got: ${m[1]}`,
    );
  });

  test('#2828 negative space: more phase dirs than roadmap declares → Math.max floor (not roadmap count alone)', () => {
    // The Math.max(phaseDirs.length, roadmapPhaseCount) floor is load-bearing when the
    // disk has MORE realized phase dirs than the roadmap declares. A mutant dropping
    // Math.max (totalPhases: roadmapPhaseCount) would survive the 6-phase test above
    // (1 < 6); this case (3 dirs > 2 roadmap) kills it.
    const planningDir = path.join(tmpDir, '.planning');
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      ['# Roadmap', '', '### Phase 1: A', '### Phase 2: B', ''].join('\n'),
    );
    for (const d of ['01-a', '02-b', '03-stale']) {
      const p = path.join(planningDir, 'phases', d);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'CONTEXT.md'), '# x\n');
    }
    const result = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);
    const stateMd = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf8');
    const m = stateMd.match(/^progress:\s*\r?\n(?:[ \t]+\w+:.+\r?\n?)*?[ \t]+total_phases:\s*(\d+)/m);
    assert.ok(m, `progress.total_phases must be written. STATE.md:\n${stateMd}`);
    assert.strictEqual(Number(m[1]), 3,
      `total_phases must be Math.max(phaseDirs.length=3, roadmapPhaseCount=2)=3, not the roadmap count alone (2). Got: ${m[1]}`);
  });

  test('#2828 negative space: no ROADMAP.md → falls back to phaseDirs.length', () => {
    const planningDir = path.join(tmpDir, '.planning');
    fs.unlinkSync(path.join(planningDir, 'ROADMAP.md'));
    // 2 phase dirs on disk, no roadmap.
    for (const d of ['01-a', '02-b']) {
      const p = path.join(planningDir, 'phases', d);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'CONTEXT.md'), '# x\n');
    }
    const result = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);
    const stateMd = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf8');
    const m = stateMd.match(/^progress:\s*\r?\n(?:[ \t]+\w+:.+\r?\n?)*?[ \t]+total_phases:\s*(\d+)/m);
    assert.ok(m, `progress.total_phases must be written. STATE.md:\n${stateMd}`);
    assert.strictEqual(Number(m[1]), 2,
      `with no ROADMAP, total_phases must fall back to phaseDirs.length (2). Got: ${m[1]}`);
  });
});
