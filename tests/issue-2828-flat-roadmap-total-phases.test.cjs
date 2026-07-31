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
    // Parse the `progress:` YAML block line-by-line (ReDoS-safe: avoids a nested-quantifier
    // regex over the whole block). Find total_phases among the block's indented children.
    const lines = stateMd.split(/\r?\n/);
    let inProgress = false;
    let totalPhases = null;
    for (const line of lines) {
      if (/^progress:\s*$/.test(line)) { inProgress = true; continue; }
      if (inProgress) {
        // A new top-level (column-0) key ends the progress block.
        if (/^\S/.test(line)) { inProgress = false; continue; }
        const tp = line.match(/^\s+total_phases:\s*(\d+)/);
        if (tp) { totalPhases = Number(tp[1]); break; }
      }
    }
    assert.ok(
      totalPhases !== null,
      `progress.total_phases must be written by state sync. STATE.md:\n${stateMd}`,
    );
    assert.strictEqual(
      totalPhases,
      6,
      `progress.total_phases must be the roadmap count (6) for a flat unmilestoned roadmap, not the on-disk phase-dir count (1). Got: ${totalPhases}`,
    );
  });
});
