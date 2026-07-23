'use strict';
/**
 * phase-resolution-parity.test.cjs — #2528 resolution-path parity gate
 *
 * The phase-directory matching logic historically existed in three independent
 * copies that had already diverged (different scan idioms, different ambiguity
 * handling): the shared locator (`phase-locator.cjs :: searchPhaseInDir`, used
 * by `findPhaseInternal` and the `init.*` queries), the `find-phase` command
 * scan, and the `phase-plan-index` command scan. #2043/#2232 fixed the shared
 * tokenizer, but any fix needing resolution-level context had to be applied
 * per copy — which is how this bug class kept resurfacing (#2528 is the third
 * instance).
 *
 * The selection now delegates to one owner (`phase-id.cjs :: matchPhaseDirs`).
 * This gate is the durable guard the #2528 triage asked for: for every corpus
 * scenario, the three resolution paths MUST agree on the same directory for
 * the same bare input — found, not-found, and ambiguous alike. It fails the
 * moment any path re-implements selection and drifts.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const { findPhaseInternal } = require('../gsd-core/bin/lib/phase-locator.cjs');

// Each scenario: phase dirs on disk, the user's bare input, and the expected
// resolution ('10-24-7-autonomy' → that dir; null → not found; 'AMBIGUOUS' →
// every path must surface the ambiguity instead of silently picking one).
const SCENARIOS = [
  {
    name: '#2528 tokenizer fix: 2-digit slug word + 1-digit word ("24/7 Autonomy")',
    dirs: ['10-24-7-autonomy', '11-other'],
    query: '10',
    expect: '10-24-7-autonomy',
  },
  {
    name: '#2528 bare-integer fallback: 2-digit slug run with non-digit tail ("80/20 Cleanup")',
    dirs: ['05-80-20-cleanup', '11-other'],
    query: '5',
    expect: '05-80-20-cleanup',
  },
  {
    name: '#2528 bare-integer fallback: "12-Factor Refactor"',
    dirs: ['30-12-factor-refactor'],
    query: '30',
    expect: '30-12-factor-refactor',
  },
  {
    name: '#2232 regression stays green: year-leading slug',
    dirs: ['14-2026-photos-performance'],
    query: '14',
    expect: '14-2026-photos-performance',
  },
  {
    name: '#2043 regression stays green: 1-digit slug word',
    dirs: ['46-6-rs-pipeline-orchestrator'],
    query: '46',
    expect: '46-6-rs-pipeline-orchestrator',
  },
  {
    name: 'genuine sub-phase is still resolvable by its full id',
    dirs: ['10-24-setup'],
    query: '10-24',
    expect: '10-24-setup',
  },
  {
    name: '#2237 ambiguity: two dirs claim the same bare number — every path fails loud',
    dirs: ['10-24-7-autonomy', '10-second'],
    query: '10',
    expect: 'AMBIGUOUS',
  },
  {
    name: 'fallback collisions are ambiguous, never a silent first match',
    dirs: ['05-80-20-a', '05-90-till-late'],
    query: '5',
    expect: 'AMBIGUOUS',
  },
  {
    name: 'a missing phase stays not-found on every path',
    dirs: ['10-24-7-autonomy'],
    query: '99',
    expect: null,
  },
];

describe('#2528 resolution-path parity — locator / find-phase / phase-plan-index', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
    tmpDir = null;
  });

  for (const { name, dirs, query, expect } of SCENARIOS) {
    test(name, () => {
      const phasesDir = path.join(tmpDir, '.planning', 'phases');
      for (const d of dirs) {
        const dir = path.join(phasesDir, d);
        fs.mkdirSync(dir, { recursive: true });
        // One canonical plan per dir so a resolved phase-plan-index proves it
        // actually read the directory (plans: [] was the reported symptom).
        const padded = d.match(/^\d+/) ? d.match(/^\d+/)[0] : '01';
        fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '---\nwave: 1\n---\n');
      }

      // ── Path 1: the shared locator (findPhaseInternal → searchPhaseInDir) ─
      const located = findPhaseInternal(tmpDir, query);
      const locatorDir =
        located && located.found ? path.basename(located.directory) : null;
      const locatorAmbiguous = Boolean(located && located.ambiguous_matches);

      // ── Path 2: find-phase ────────────────────────────────────────────────
      const findRes = runGsdTools(`find-phase ${query}`, tmpDir);
      assert.ok(findRes.success, `find-phase failed: ${findRes.error}`);
      const findOut = JSON.parse(findRes.output);
      const findDir = findOut.found ? path.basename(findOut.directory) : null;
      const findAmbiguous = Boolean(findOut.ambiguous_matches);

      // ── Path 3: phase-plan-index ──────────────────────────────────────────
      const idxRes = runGsdTools(`phase-plan-index ${query}`, tmpDir);
      assert.ok(idxRes.success, `phase-plan-index failed: ${idxRes.error}`);
      const idxOut = JSON.parse(idxRes.output);
      const idxAmbiguous = Boolean(idxOut.ambiguous_matches);
      const idxResolved = !idxOut.error && idxOut.plans.length > 0;

      if (expect === 'AMBIGUOUS') {
        assert.ok(locatorAmbiguous, 'locator must surface ambiguity');
        assert.ok(findAmbiguous, 'find-phase must surface ambiguity');
        assert.ok(idxAmbiguous, 'phase-plan-index must surface ambiguity');
        assert.deepStrictEqual(
          [...(located.ambiguous_matches || [])].sort(),
          [...(findOut.ambiguous_matches || [])].sort(),
          'locator and find-phase must list the same candidates',
        );
        assert.deepStrictEqual(
          [...(findOut.ambiguous_matches || [])].sort(),
          [...(idxOut.ambiguous_matches || [])].sort(),
          'find-phase and phase-plan-index must list the same candidates',
        );
      } else if (expect === null) {
        assert.strictEqual(locatorDir, null, 'locator must report not-found');
        assert.strictEqual(findDir, null, 'find-phase must report not-found');
        assert.strictEqual(idxOut.error, 'Phase not found', 'phase-plan-index must report not-found');
      } else {
        assert.strictEqual(locatorDir, expect, 'locator resolved the wrong dir');
        assert.strictEqual(findDir, expect, 'find-phase resolved the wrong dir');
        assert.ok(
          idxResolved,
          `phase-plan-index must resolve and index plans, got: ${idxRes.output}`,
        );
      }
    });
  }
});
