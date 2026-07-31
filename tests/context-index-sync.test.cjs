'use strict';

/**
 * Regression tests for #2944 — two `fix:` commits shipped with zero
 * behavioral test files:
 *
 *   1. f9bc37e3d "remove the catastrophic-backtracking regex from the
 *      example" (examples/dynamic-context-management/context-predicates.cjs)
 *   2. 85140eac8 "refresh the predicate index staled by a merge race on
 *      next" (docs/CONTEXT-INDEX.json)
 *
 * Defect 1 (index/CONTEXT.md drift): docs/CONTEXT-INDEX.json is a committed
 * generated artifact guarded by `scripts/gen-context-index.cjs --check` in
 * `lint:generated-sync`. A concurrent-merge race landed one PR's CONTEXT.md
 * alongside another PR's index; each PR was green alone (lint only runs on
 * the PR's own diff), the combination was red, and it only surfaced on the
 * NEXT PR to run `lint:ci`. This file puts the same drift check inside the
 * test suite (which `gsd-test` runs on every PR), so a future racing merge
 * fails here directly instead of waiting for a downstream PR to trip over
 * `lint:generated-sync`.
 *
 * Defect 2 (example/production grammar divergence): production's
 * predicate-id validation was made linear-time in #2928 (structural
 * per-segment validation replacing an exponential-backtracking regex whose
 * `(?:\.[A-Za-z0-9_.-]+)*` group made N consecutive dots exponential — see
 * gsd-core/bin/lib/context-predicates.cjs's module doc comment). The example
 * at examples/dynamic-context-management/context-predicates.cjs is an
 * independent copy of the same grammar and was fixed to match (commit
 * f9bc37e3d above), but nothing asserted the two copies actually agree —
 * that lack of an assertion, not the regex itself, is the bug class this
 * file targets.
 *
 * ── Design tension (disclosed per instruction, not resolved unilaterally) ──
 * ADR-1671 ("Dynamic context management platform") places
 * examples/dynamic-context-management/ deliberately OUTSIDE tests/'s normal
 * production-module surface: it is a reference prototype, not compiled,
 * packaged, or installed by any runtime path. This file `require()`s that
 * example module from tests/, which a reviewer could read as reaching back
 * into "prototype" territory that ADR-1671 meant to keep separate from the
 * shipped product. The justification taken here: ADR-1671's intent is that
 * the example is not COMPILED, PACKAGED, or INSTALLED — never that it may
 * silently rot into a second, un-synced copy of production's grammar. A
 * parity guard that only ever READS both modules and asserts they agree
 * does not ship, compile, or package the example; it just stops the two
 * copies from diverging unnoticed the way #2944 proved they can. A reviewer
 * who disagrees with that reading should treat this comment as the place to
 * object, not the fact of the import itself.
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
const EXAMPLE_PREDICATES_PATH = path.join(
  REPO_ROOT,
  'examples',
  'dynamic-context-management',
  'context-predicates.cjs',
);
const CONTEXT_PATH = path.join(REPO_ROOT, 'CONTEXT.md');
const INDEX_PATH = path.join(REPO_ROOT, 'docs', 'CONTEXT-INDEX.json');

const prodPredicates = require(PROD_PREDICATES_PATH);
const examplePredicates = require(EXAMPLE_PREDICATES_PATH);

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

/** Build a `{markdown line}` fixture wrapping one candidate id=value pair. */
function backtickLine(idEqualsValue) {
  return '`' + idEqualsValue + '`';
}

// ─── Defect 1: docs/CONTEXT-INDEX.json vs. a fresh CONTEXT.md parse ──────────

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

  test('divergence detector is not vacuous: catches a mutated index in a throwaway temp copy (never the real artifact)', () => {
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

    helpers.cleanup(tmpDir);
  });
});

// ─── Defect 2: example/production grammar parity ─────────────────────────────

describe('example/production context-predicates grammar parity (#2944 divergence regression)', () => {
  test('example and production report the same predicate count, class set, and duplicate set for real CONTEXT.md', () => {
    const markdown = readContextMarkdown();

    const prodParsed = prodPredicates.parsePredicates(markdown);
    const exampleParsed = examplePredicates.parsePredicates(markdown);

    const prodIndex = prodPredicates.buildIndex(prodParsed.predicates);
    const exampleIndex = examplePredicates.buildIndex(exampleParsed.predicates);

    assert.equal(
      exampleIndex.count,
      prodIndex.count,
      `predicate count diverged: example=${exampleIndex.count} production=${prodIndex.count}`,
    );
    assert.deepEqual(
      Object.keys(exampleIndex.classes).sort(),
      Object.keys(prodIndex.classes).sort(),
      'class set diverged between example and production parsers',
    );
    assert.deepEqual(
      exampleIndex.classes,
      prodIndex.classes,
      'per-class predicate counts diverged between example and production parsers:\n' +
        `example=${JSON.stringify(exampleIndex.classes)}\nproduction=${JSON.stringify(prodIndex.classes)}`,
    );

    // Duplicate SETS (ids), not shapes: production's `Duplicate` carries
    // `count`, the example's carries `lines: number[]` (intentional
    // deviation, documented in gsd-core/bin/lib/context-predicates.cjs's
    // module doc comment, ADR-1671 open question 4) — the ratio of ids
    // flagged as duplicate is what must agree, not the wire shape.
    const exampleDupIds = exampleIndex.duplicates.map((d) => d.id).sort();
    const prodDupIds = prodIndex.duplicates.map((d) => d.id).sort();
    assert.deepEqual(
      exampleDupIds,
      prodDupIds,
      'duplicate-id set diverged between example and production parsers:\n' +
        `example=${JSON.stringify(exampleDupIds)}\nproduction=${JSON.stringify(prodDupIds)}`,
    );

    // Full predicate-by-predicate parity (id/klass/value), for a diff that
    // names the exact id if the two copies ever produce different content
    // for the same real CONTEXT.md.
    const diffs = diffPredicatesById(exampleIndex.predicates, prodIndex.predicates, 'example', 'production');
    assert.deepEqual(diffs, [], 'example and production predicate parses diverged:\n' + diffs.join('\n'));
  });

  test('example and production accept/reject the same representative id shapes', () => {
    const cases = [
      { idEqualsValue: 'A=1', expectAccept: true },
      { idEqualsValue: 'FOO=x', expectAccept: true },
      { idEqualsValue: 'PRED.k320.rule=x', expectAccept: true },
      { idEqualsValue: 'RELEASE-NOTES.x=y', expectAccept: true },
      { idEqualsValue: 'A..b=1', expectAccept: false },
      { idEqualsValue: 'foo.bar=x', expectAccept: false },
      { idEqualsValue: 'FOO BAR=x', expectAccept: false },
      { idEqualsValue: '=v', expectAccept: false },
      { idEqualsValue: 'ID', expectAccept: false },
    ];

    for (const { idEqualsValue, expectAccept } of cases) {
      const markdown = [backtickLine(idEqualsValue), ''].join('\n');

      const exampleCount = examplePredicates.parsePredicates(markdown).predicates.length;
      const prodCount = prodPredicates.parsePredicates(markdown).predicates.length;

      assert.equal(
        exampleCount,
        prodCount,
        `verdict diverged for ${JSON.stringify(idEqualsValue)}: example found ${exampleCount} predicate(s), production found ${prodCount}`,
      );
      const actualAccept = prodCount === 1;
      assert.equal(
        actualAccept,
        expectAccept,
        `expected ${JSON.stringify(idEqualsValue)} to be ${expectAccept ? 'ACCEPTED' : 'REJECTED'}, ` +
          `both modules agreed on ${actualAccept ? 'ACCEPT' : 'REJECT'} instead`,
      );
    }
  });

  test('example validates a 60-dot id-shaped line in linear time (functional result is the binding assertion; wall-clock is a smoke check only)', () => {
    const dots = '.'.repeat(60);
    const idEqualsValue = `A${dots}b=x`;
    const markdown = [backtickLine(idEqualsValue), ''].join('\n');

    // Binding assertion: the doubled-dot-laden id is cleanly REJECTED (zero
    // predicates extracted) — this is what actually would have caught the
    // catastrophic-backtracking regex, which either hung or (if it somehow
    // terminated) accepted/rejected the wrong thing. A clean, fast reject is
    // only meaningful if the reject itself is correct.
    const { predicates } = examplePredicates.parsePredicates(markdown);
    assert.equal(
      predicates.length,
      0,
      `expected the 60-dot id-shaped line to be rejected (0 predicates); got ${predicates.length}`,
    );

    // Smoke check only (this repo forbids elapsed-time assertions as the
    // PRIMARY signal — CLAUDE.md "Clock Seams"): a generous wall-clock bound
    // that the fixed linear-time validator clears trivially, but the old
    // exponential regex (measured ~565ms at 40 dots, doubling roughly every
    // 5 — i.e. tens of seconds by 60 dots) would blow through by orders of
    // magnitude.
    const start = process.hrtime.bigint();
    examplePredicates.parsePredicates(markdown);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(
      elapsedMs < 2000,
      `smoke check: expected the 60-dot parse to finish well under 2000ms (linear-time validator), took ${elapsedMs}ms`,
    );
  });
});
