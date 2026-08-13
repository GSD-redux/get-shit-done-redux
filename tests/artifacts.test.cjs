'use strict';

/**
 * Characterization tests for the canonical GSD artifact registry.
 * Locks the exact membership of CANONICAL_EXACT, the CANONICAL_PATTERNS
 * shape, and the isCanonicalPlanningFile predicate.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_EXACT,
  CANONICAL_PATTERNS,
  isCanonicalPlanningFile,
} = require('../gsd-core/bin/lib/artifacts.cjs');

describe('CANONICAL_EXACT', () => {
  test('is a Set', () => {
    assert.ok(CANONICAL_EXACT instanceof Set);
  });

  test('contains all expected canonical files', () => {
    const expected = [
      'PROJECT.md', 'ROADMAP.md', 'STATE.md', 'REQUIREMENTS.md',
      'MILESTONES.md', 'BACKLOG.md', 'LEARNINGS.md', 'THREADS.md',
      'config.json', 'CLAUDE.md', 'RETROSPECTIVE.md', 'WINDOWS.md',
    ];
    for (const name of expected) {
      assert.ok(CANONICAL_EXACT.has(name), `expected ${name} in CANONICAL_EXACT`);
    }
  });
});

describe('CANONICAL_PATTERNS', () => {
  test('is an Array of RegExp', () => {
    assert.ok(Array.isArray(CANONICAL_PATTERNS));
    for (const p of CANONICAL_PATTERNS) {
      assert.ok(p instanceof RegExp);
    }
  });

  test('matches milestone audit doc pattern', () => {
    assert.ok(CANONICAL_PATTERNS.some((p) => p.test('v1.2.3-MILESTONE-AUDIT.md')));
    assert.ok(CANONICAL_PATTERNS.some((p) => p.test('v1.2-MILESTONE-AUDIT.md')));
  });

  test('matches version-stamped planning docs', () => {
    assert.ok(CANONICAL_PATTERNS.some((p) => p.test('v2.0.0-release-plan.md')));
  });
});

describe('isCanonicalPlanningFile', () => {
  test('returns true for exact match STATE.md', () => {
    assert.strictEqual(isCanonicalPlanningFile('STATE.md'), true);
  });

  test('returns true for exact match config.json', () => {
    assert.strictEqual(isCanonicalPlanningFile('config.json'), true);
  });

  test('#3224: WINDOWS.md (broken-windows ledger) is a canonical .planning/ artifact', () => {
    // gsd-core itself writes .planning/WINDOWS.md (src/broken-windows.cts,
    // LEDGER_FILE_NAME = 'WINDOWS.md'). Before #3224 it was absent from the
    // registry, so validate health flagged it W019 "Unrecognized" with advice to
    // delete a ledger that can gate /gsd-ship under workflow.windows_enforce.
    assert.ok(CANONICAL_EXACT.has('WINDOWS.md'), 'WINDOWS.md must be in CANONICAL_EXACT');
    assert.strictEqual(isCanonicalPlanningFile('WINDOWS.md'), true);
  });

  test('returns false for unrecognized file', () => {
    assert.strictEqual(isCanonicalPlanningFile('random-file.md'), false);
  });

  test('returns false for empty string', () => {
    assert.strictEqual(isCanonicalPlanningFile(''), false);
  });

  test('returns true for version-stamped milestone audit doc', () => {
    assert.strictEqual(isCanonicalPlanningFile('v1.50.0-MILESTONE-AUDIT.md'), true);
  });

  test('returns true for other version-stamped planning docs', () => {
    assert.strictEqual(isCanonicalPlanningFile('v2.0.0-plan.md'), true);
  });

  test('returns false for partial match (wrong case)', () => {
    assert.strictEqual(isCanonicalPlanningFile('state.md'), false);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2448-artifact-registry.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2448-artifact-registry (consolidation epic #1969 B3 #1972)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2448)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for canonical artifact registry and gsd-health W019 lint (#2448).
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const helpers = require('./helpers.cjs');

const { isCanonicalPlanningFile, CANONICAL_EXACT } = require('../gsd-core/bin/lib/artifacts.cjs');
const { cmdValidateHealth } = require('../gsd-core/bin/lib/verify.cjs');

const _dirsToClean = [];
after(() => { for (const d of _dirsToClean) helpers.cleanup(d); });

function makeTempProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2448-'));
  _dirsToClean.push(dir);
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

const BASE_FILES = {
  '.planning/PROJECT.md': '# P\n\n## What This Is\n\nX\n\n## Core Value\n\nY\n\n## Requirements\n\nZ\n',
  '.planning/ROADMAP.md': '# Roadmap\n',
  '.planning/STATE.md': '# State\n',
  '.planning/config.json': '{}',
};

describe('artifacts.cjs — isCanonicalPlanningFile', () => {
  test('returns true for all exact canonical names', () => {
    for (const name of CANONICAL_EXACT) {
      assert.ok(isCanonicalPlanningFile(name), `Expected ${name} to be canonical`);
    }
  });

  test('returns true for version-stamped milestone audit file', () => {
    assert.ok(isCanonicalPlanningFile('v1.0-MILESTONE-AUDIT.md'));
    assert.ok(isCanonicalPlanningFile('v2.3.1-MILESTONE-AUDIT.md'));
  });

  test('returns true for RETROSPECTIVE.md (produced by /gsd-complete-milestone)', () => {
    assert.strictEqual(isCanonicalPlanningFile('RETROSPECTIVE.md'), true);
  });

  test('returns false for clearly non-canonical names', () => {
    assert.strictEqual(isCanonicalPlanningFile('MY-NOTES.md'), false);
    assert.strictEqual(isCanonicalPlanningFile('scratch.md'), false);
    assert.strictEqual(isCanonicalPlanningFile('random-output.md'), false);
  });

  test('returns false for phase-level artifacts at the root (they belong in phases/)', () => {
    assert.strictEqual(isCanonicalPlanningFile('01-CONTEXT.md'), false);
    assert.strictEqual(isCanonicalPlanningFile('01-01-PLAN.md'), false);
  });
});

describe('gsd-health W019 — unrecognized .planning/ root files', () => {
  test('W019 fires for a non-canonical .md file at .planning/ root', () => {
    const dir = makeTempProject({
      ...BASE_FILES,
      '.planning/MY-NOTES.md': '# notes\n',
    });

    const result = cmdValidateHealth(dir, { repair: false }, false);

    const w019 = result.warnings.find(w => w.code === 'W019');
    assert.ok(w019, 'W019 should be emitted for unrecognized file');
    assert.ok(w019.message.includes('MY-NOTES.md'), 'warning should name the file');
    assert.strictEqual(w019.repairable, false, 'W019 is not auto-repairable');
  });

  test('no W019 for canonical files', () => {
    const dir = makeTempProject({ ...BASE_FILES });

    const result = cmdValidateHealth(dir, { repair: false }, false);

    const w019 = result.warnings.find(w => w.code === 'W019');
    assert.strictEqual(w019, undefined, 'no W019 for canonical files');
  });

  test('no W019 for phase subdirectory files (only root is checked)', () => {
    const dir = makeTempProject({
      ...BASE_FILES,
      '.planning/phases/01-foundation/01-01-PLAN.md': '---\nphase: "1"\n---\n',
    });

    const result = cmdValidateHealth(dir, { repair: false }, false);

    const w019 = result.warnings.find(w => w.code === 'W019');
    assert.strictEqual(w019, undefined, 'phase subdir files not flagged by W019');
  });

  test('no W019 for version-stamped files like vX.Y-MILESTONE-AUDIT.md', () => {
    const dir = makeTempProject({
      ...BASE_FILES,
      '.planning/v1.0-MILESTONE-AUDIT.md': '# Audit\n',
    });

    const result = cmdValidateHealth(dir, { repair: false }, false);

    const w019 = result.warnings.find(w => w.code === 'W019');
    assert.strictEqual(w019, undefined, 'version-stamped audit file is canonical');
  });

  test('multiple unrecognized files produce multiple W019 warnings', () => {
    const dir = makeTempProject({
      ...BASE_FILES,
      '.planning/scratch.md': '# scratch\n',
      '.planning/temp-notes.md': '# temp\n',
    });

    const result = cmdValidateHealth(dir, { repair: false }, false);

    const w019s = result.warnings.filter(w => w.code === 'W019');
    assert.strictEqual(w019s.length, 2, 'one W019 per unrecognized file');
  });

  test('templates/README.md exists and documents W019', () => {
    const readme = fs.readFileSync(
      path.join(__dirname, '../gsd-core/templates/README.md'), 'utf-8'
    );
    assert.ok(readme.includes('W019'), 'README.md documents W019');
    assert.ok(readme.includes('artifacts.cjs'), 'README.md references artifacts.cjs for adding new artifacts');
    assert.ok(readme.includes('PROJECT.md'), 'README.md lists PROJECT.md as canonical');
  });
});
  });
}
