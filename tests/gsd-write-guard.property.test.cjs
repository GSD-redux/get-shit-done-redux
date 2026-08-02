'use strict';

/**
 * Property-based test for the gsd-write-guard SHRINK_RATIO/FLOOR_LINES budget
 * contract (#2255 review, Major 5 — CLAUDE.md requires a fast-check property
 * test for every budget-limit contract).
 *
 * Property: for any on-disk file with oldLines > FLOOR_LINES-1 (i.e. at or
 * above the exclusive floor), a pending Write of newLines is
 *   blocked ⟺ newLines < oldLines * SHRINK_RATIO
 * and for any oldLines < FLOOR_LINES the Write always passes, regardless of
 * how far it shrinks.
 *
 * The hook is a standalone stdin-driven script, so each sample spawns it at
 * the real seam (same as the unit suite). Sample counts are bounded below the
 * global numRuns to keep the spawn cost sane; the boundary cases the property
 * must not miss (floor-1/floor/floor+1, ratio-1/ratio/ratio+1) are pinned as
 * explicit examples.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-write-guard.js');

// Mirror the hook's published contract (hooks/gsd-write-guard.js).
const SHRINK_RATIO = 0.4;
const FLOOR_LINES = 40;

function lines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
}

let projectDir;
let roadmapPath;

before(() => {
  projectDir = createTempDir('gsd-write-guard-prop-');
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  roadmapPath = path.join(projectDir, '.planning', 'ROADMAP.md');
});

after(() => {
  cleanup(projectDir);
});

function guardVerdict(oldLines, newLines) {
  fs.writeFileSync(roadmapPath, lines(oldLines));
  const env = { ...process.env };
  delete env.GSD_ALLOW_PLANNING_SHRINK;
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: roadmapPath, content: lines(newLines) },
    }),
    encoding: 'utf8',
    env,
  });
  return r.status === 2 ? 'blocked' : 'passed';
}

describe('gsd-write-guard.js: SHRINK_RATIO/FLOOR_LINES budget contract (property)', () => {

  test('for any oldLines ≥ FLOOR_LINES: blocked ⟺ newLines < oldLines * SHRINK_RATIO', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: FLOOR_LINES, max: 400 }),
        fc.integer({ min: 1, max: 400 }),
        (oldLines, newLines) => {
          const expected = newLines < oldLines * SHRINK_RATIO ? 'blocked' : 'passed';
          assert.equal(
            guardVerdict(oldLines, newLines), expected,
            `oldLines=${oldLines} newLines=${newLines} ratio=${newLines / oldLines}`
          );
        }
      ),
      {
        numRuns: 40, // each sample spawns the hook process — bound the cost
        examples: [
          [FLOOR_LINES, Math.ceil(FLOOR_LINES * SHRINK_RATIO) - 1], // floor × just-under-ratio
          [FLOOR_LINES, Math.ceil(FLOOR_LINES * SHRINK_RATIO)],     // floor × at-ratio
          [FLOOR_LINES + 1, 1],                                     // floor+1 × deep shrink
          [100, 39], [100, 40], [100, 41],                          // ratio-1 / ratio / ratio+1
        ],
      }
    );
  });

  test('for any oldLines < FLOOR_LINES: never blocked, however deep the shrink', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: FLOOR_LINES - 1 }),
        fc.integer({ min: 1, max: 400 }),
        (oldLines, newLines) => {
          assert.equal(
            guardVerdict(oldLines, newLines), 'passed',
            `sub-floor oldLines=${oldLines} newLines=${newLines} must be exempt`
          );
        }
      ),
      {
        numRuns: 20,
        examples: [[FLOOR_LINES - 1, 1]], // floor-1 × deepest shrink
      }
    );
  });
});
