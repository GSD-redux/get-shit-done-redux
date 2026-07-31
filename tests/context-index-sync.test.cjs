'use strict';

/**
 * Regression test for #2944 — 85140eac8 "refresh the predicate index staled
 * by a merge race on next" (docs/CONTEXT-INDEX.json) shipped with zero
 * behavioral test coverage.
 *
 * docs/CONTEXT-INDEX.json is a committed generated artifact guarded by
 * `scripts/gen-context-index.cjs --check` in `lint:generated-sync`. A
 * concurrent-merge race landed one PR's CONTEXT.md alongside another PR's
 * index; each PR was green alone (lint only runs on the PR's own diff), the
 * combination was red, and it only surfaced on the NEXT PR to run `lint:ci`.
 * This file puts the same drift check inside the test suite (which
 * `gsd-test` runs on every PR), so a future racing merge fails here directly
 * instead of waiting for a downstream PR to trip over `lint:generated-sync`.
 *
 * The example/production parser parity guard (the OTHER defect #2944
 * introduced regression coverage for) lives in
 * scripts/lint-example-parser-parity.cjs, wired into `npm run lint:ci` — NOT
 * here. ADR-1671 ("Dynamic context management platform",
 * docs/adr/1671-dynamic-context-management-platform.md:102) places
 * examples/dynamic-context-management/ deliberately outside four surfaces:
 * the build (src/ -> bin/lib/), the npm package files[], the installer, and
 * the CI test suite (tests/) — this file. A `require()` of the example from
 * inside tests/ would violate that fourth exclusion directly; a lint script
 * that only reads both modules from a repo-root script does not.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helpers = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib');
const PROD_PREDICATES_PATH = path.join(LIB_DIR, 'context-predicates.cjs');
const CONTEXT_PATH = path.join(REPO_ROOT, 'CONTEXT.md');
const INDEX_PATH = path.join(REPO_ROOT, 'docs', 'CONTEXT-INDEX.json');

const prodPredicates = require(PROD_PREDICATES_PATH);

function readContextMarkdown() {
  return fs.readFileSync(CONTEXT_PATH, 'utf8');
}

function readCommittedIndex() {
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
}

/**
 * Diff two ContextIndex-shaped `{predicates:[{id,klass,value}]}` objects by
 * id, returning human-readable divergence strings naming the exact
 * predicate id(s) involved — so a failure reads as an actionable list, never
 * "objects differ".
 */
function diffPredicatesById(leftPredicates, rightPredicates, leftLabel, rightLabel) {
  const leftMap = new Map(leftPredicates.map((p) => [p.id, p]));
  const rightMap = new Map(rightPredicates.map((p) => [p.id, p]));
  const allIds = new Set([...leftMap.keys(), ...rightMap.keys()]);
  const diffs = [];
  for (const id of Array.from(allIds).sort()) {
    const l = leftMap.get(id);
    const r = rightMap.get(id);
    if (l && !r) {
      diffs.push(`${id}: present in ${leftLabel} but absent from ${rightLabel}`);
    } else if (!l && r) {
      diffs.push(`${id}: present in ${rightLabel} but absent from ${leftLabel}`);
    } else if (l.value !== r.value) {
      diffs.push(
        `${id}: value diverged (${leftLabel}=${JSON.stringify(l.value)}, ${rightLabel}=${JSON.stringify(r.value)})`,
      );
    } else if (l.klass !== r.klass) {
      diffs.push(
        `${id}: klass diverged (${leftLabel}=${JSON.stringify(l.klass)}, ${rightLabel}=${JSON.stringify(r.klass)})`,
      );
    }
  }
  return diffs;
}

// ─── docs/CONTEXT-INDEX.json vs. a fresh CONTEXT.md parse ────────────────────

describe('docs/CONTEXT-INDEX.json sync with CONTEXT.md (#2944 concurrent-merge regression)', () => {
  test('committed index matches a fresh parse of the real CONTEXT.md, predicate-by-predicate', () => {
    const { parsePredicates, buildIndex } = prodPredicates;
    const markdown = readContextMarkdown();
    const { predicates } = parsePredicates(markdown);
    const fresh = buildIndex(predicates);
    const committed = readCommittedIndex();

    const diffs = diffPredicatesById(
      committed.predicates,
      fresh.predicates,
      'committed docs/CONTEXT-INDEX.json',
      'fresh CONTEXT.md parse',
    );
    assert.deepEqual(
      diffs,
      [],
      'docs/CONTEXT-INDEX.json has drifted from CONTEXT.md for predicate id(s) ' +
        '(run `node scripts/gen-context-index.cjs --write` to refresh):\n' +
        diffs.join('\n'),
    );
    assert.equal(
      committed.count,
      fresh.count,
      `predicate count diverged: committed=${committed.count} fresh=${fresh.count}`,
    );
    assert.deepEqual(
      committed.classes,
      fresh.classes,
      'class-count map diverged between committed index and fresh CONTEXT.md parse:\n' +
        `committed=${JSON.stringify(committed.classes)}\nfresh=${JSON.stringify(fresh.classes)}`,
    );
  });

  test('divergence detector is not vacuous: catches a mutated index in a throwaway temp copy (never the real artifact)', (t) => {
    const { parsePredicates, buildIndex } = prodPredicates;
    const markdown = readContextMarkdown();
    const { predicates } = parsePredicates(markdown);
    const fresh = buildIndex(predicates);

    // Mutate a COPY of the fresh index in a fresh temp dir. docs/CONTEXT-
    // INDEX.json itself is never opened for write anywhere in this file.
    const mutated = JSON.parse(JSON.stringify(fresh));
    const target =
      mutated.predicates.find((p) => p.id === 'RULESET.WORKFLOW_SIZE_BUDGET') || mutated.predicates[0];
    target.value = target.value + ' MUTATED-FOR-TEST';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-index-sync-'));
    t.after(() => helpers.cleanup(tmpDir));
    const tmpIndexPath = path.join(tmpDir, 'CONTEXT-INDEX.json');
    fs.writeFileSync(tmpIndexPath, JSON.stringify(mutated, null, 2) + '\n', 'utf8');
    const mutatedCommitted = JSON.parse(fs.readFileSync(tmpIndexPath, 'utf8'));

    const diffs = diffPredicatesById(
      mutatedCommitted.predicates,
      fresh.predicates,
      'mutated temp-copy index',
      'fresh CONTEXT.md parse',
    );

    assert.ok(diffs.length > 0, 'expected the mutated temp copy to diverge from the fresh parse');
    assert.ok(
      diffs.some((d) => d.startsWith(`${target.id}:`)),
      `expected the diff to name ${target.id}; got:\n${diffs.join('\n')}`,
    );
  });
});
