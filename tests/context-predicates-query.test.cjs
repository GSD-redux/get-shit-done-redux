'use strict';

/**
 * Integration tests for `gsd_run query context-predicates` — the selector
 * surface for the CONTEXT.md predicate fact-store (ADR-1671 S9, #2928 Phase
 * 1, rows G1-G17).
 *
 * NET-NEW COMMAND, EXPECTED RED: `context-predicates` is not yet registered
 * in gsd-core/bin/gsd-tools.cjs's HOST_COMMAND_ROUTERS / TOP_LEVEL_USAGE /
 * SKIP_ROOT_RESOLUTION (S9's three hand-maintained sites). Every test in this
 * file targets the REQUIRED behavior from 40-design.md rows 38-43 and
 * currently fails because the command does not exist — that is expected and
 * correct for this commit (a failing-first regression matrix), not a
 * defect in the test.
 *
 * Invocation shape: `gsd_run query <command> [args]` maps to
 * `node gsd-tools.cjs query <command> [args]` — `query` is a meta-prefix the
 * dispatcher strips (gsd-core/bin/gsd-tools.cjs, "Accept `query` as a
 * meta-prefix"). This is the same shape every existing query consumer in
 * gsd-core/workflows/*.md uses (e.g. `gsd_run query stats.json`,
 * `gsd_run query prompt-budget ...`) — mirrored here since no real caller of
 * `context-predicates` is wired yet (net-new capability).
 *
 * Structured assertions: success/failure is asserted via exit code, and via
 * `--json-errors` (a real, already-shipped global gsd-tools flag) parsed as
 * `{ok, reason, message}` — `reason` is compared against the frozen
 * ERROR_REASON enum (gsd-core/bin/lib/io.cjs), never a substring match on
 * `message` prose. On success, output is asserted via JSON.parse of stdout
 * (gsd-tools' shared `output()` helper always serializes JSON to stdout
 * unless --raw is passed) — never a stdout regex.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
const { parsePredicates, selectPredicates } = require('../gsd-core/bin/lib/context-predicates.cjs');

const ROOT = path.resolve(__dirname, '..');
const STACK_FRAME_RE = /\n\s+at\s+\S+\s+\(.*:\d+:\d+\)/;

function queryContextPredicates(args, cwd = ROOT, env = {}) {
  return runGsdTools(['query', 'context-predicates', ...args], cwd, env);
}

function queryContextPredicatesJsonErrors(args, cwd = ROOT) {
  const r = queryContextPredicates([...args, '--json-errors'], cwd);
  let parsedError = null;
  try {
    parsedError = JSON.parse(r.error);
  } catch {
    // r.error was not JSON (e.g. a resource-starvation message) — leave null.
  }
  return { ...r, parsedError };
}

// Independently computed expectation set, from the real CONTEXT.md, via the
// exported pure parser/selector — NOT by parsing the CLI's own rendered text.
const REAL_PREDICATES = parsePredicates(fs.readFileSync(path.join(ROOT, 'CONTEXT.md'), 'utf8')).predicates;

describe('gsd_run query context-predicates (G)', () => {
  test('queryReturnsPredicatesForClass', () => {
    const expected = selectPredicates(REAL_PREDICATES, { klass: 'META' });
    assert.ok(expected.length > 0, 'fixture sanity: META class must exist in the real CONTEXT.md');

    const r = queryContextPredicates(['--class', 'META']);
    assert.equal(r.success, true, 'query --class META must succeed once the command is wired');
    const parsed = JSON.parse(r.output);
    const ids = (Array.isArray(parsed) ? parsed : parsed.predicates).map((p) => p.id).sort();
    assert.deepEqual(ids, expected.map((p) => p.id).sort());
  });

  test('queryReturnsPredicatesForDottedPrefix', () => {
    const expected = selectPredicates(REAL_PREDICATES, { prefix: 'RULESET.TESTS' });
    assert.ok(expected.length > 0, 'fixture sanity: RULESET.TESTS.* must exist in the real CONTEXT.md');

    const r = queryContextPredicates(['--prefix', 'RULESET.TESTS']);
    assert.equal(r.success, true);
    const parsed = JSON.parse(r.output);
    const ids = (Array.isArray(parsed) ? parsed : parsed.predicates).map((p) => p.id).sort();
    assert.deepEqual(ids, expected.map((p) => p.id).sort());
  });

  test('queryReturnsPredicatesForFreeTextContains', () => {
    const expected = selectPredicates(REAL_PREDICATES, { contains: 'changeset' });
    assert.ok(expected.length > 0, 'fixture sanity: "changeset" must appear in some real predicate id/value');

    const r = queryContextPredicates(['--contains', 'changeset']);
    assert.equal(r.success, true);
    const parsed = JSON.parse(r.output);
    const ids = (Array.isArray(parsed) ? parsed : parsed.predicates).map((p) => p.id).sort();
    assert.deepEqual(ids, expected.map((p) => p.id).sort());
  });

  test('queryReportsZeroMatchesStructurally', () => {
    const r = queryContextPredicates(['--class', 'ZZZ-NO-SUCH-CLASS-EXISTS']);
    assert.equal(r.success, true, 'a no-match query is not itself a failure');
    const parsed = JSON.parse(r.output);
    assert.equal(parsed.matched, 0, 'a no-match result must be structurally distinguishable ({matched: 0}), not silent success or failure');
  });

  test('queryWithoutSelectorExitsWithUsage', () => {
    const r = queryContextPredicatesJsonErrors([]);
    assert.equal(r.success, false);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.parsedError, 'failure must be structured JSON under --json-errors');
    assert.equal(r.parsedError.reason, ERROR_REASON.USAGE, 'missing selector must be a usage error, not an internal/unknown-command error');
  });

  test('queryWithEmptyClassExitsNonZero', () => {
    const r = queryContextPredicatesJsonErrors(['--class', '']);
    assert.equal(r.success, false);
    assert.equal(r.parsedError && r.parsedError.reason, ERROR_REASON.USAGE);
  });

  test('queryWithWhitespaceOnlyClassExitsNonZero', () => {
    const r = queryContextPredicatesJsonErrors(['--class', '   ']);
    assert.equal(r.success, false);
    assert.equal(r.parsedError && r.parsedError.reason, ERROR_REASON.USAGE);
  });

  test('queryWithDuplicateClassFlagsResolvesDeterministically', () => {
    const first = queryContextPredicates(['--class', 'META', '--class', 'RULESET']);
    const second = queryContextPredicates(['--class', 'META', '--class', 'RULESET']);
    assert.equal(first.exitCode, second.exitCode, 'duplicate flags must resolve the same way on every invocation');
    assert.equal(first.output, second.output, 'duplicate-flag resolution must be deterministic, not order-of-parse-dependent');
  });

  test('queryWithConflictingSelectorsAppliesDocumentedPrecedence', () => {
    const r = queryContextPredicates(['--class', 'META', '--prefix', 'RULESET.TESTS']);
    assert.doesNotMatch(r.error || '', STACK_FRAME_RE, 'conflicting selectors must resolve via documented precedence, never crash');
    const repeat = queryContextPredicates(['--class', 'META', '--prefix', 'RULESET.TESTS']);
    assert.equal(r.exitCode, repeat.exitCode, 'precedence resolution must be deterministic');
  });

  test('queryWithMalformedAssignmentExitsNonZero', () => {
    const eq = queryContextPredicatesJsonErrors(['--class=']);
    assert.equal(eq.success, false);
    assert.equal(eq.parsedError && eq.parsedError.reason, ERROR_REASON.USAGE);

    const doubleEq = queryContextPredicatesJsonErrors(['--class==A']);
    assert.equal(doubleEq.success, false);
    assert.equal(doubleEq.parsedError && doubleEq.parsedError.reason, ERROR_REASON.USAGE);
  });

  test('queryTreatsFlagLikeValueAsMissingValue', () => {
    const r = queryContextPredicatesJsonErrors(['--class', '--weird']);
    assert.equal(r.success, false, '--weird must not be silently consumed as the --class value');
    assert.equal(r.parsedError && r.parsedError.reason, ERROR_REASON.USAGE);
  });

  // #2928 review finding C: a flag-shaped selector value (e.g. searching CONTEXT.md
  // for the literal text "--since") was previously unmatchable — the space-separated
  // form always reads a following `--...` token as a missing value, with no escape hatch.
  describe('inline-assignment escape hatch for flag-shaped values (#2928 finding C)', () => {
    test('contains=value form matches a flag-shaped selector value', () => {
      const expected = selectPredicates(REAL_PREDICATES, { contains: '--since' });
      assert.ok(expected.length > 0, 'fixture sanity: "--since" must appear in a real CONTEXT.md predicate value');

      const r = queryContextPredicates(['--contains=--since']);
      assert.equal(r.success, true, '--contains=--since must be accepted, not read as an unknown flag');
      const parsed = JSON.parse(r.output);
      const ids = parsed.predicates.map((p) => p.id).sort();
      assert.deepEqual(ids, expected.map((p) => p.id).sort());
    });

    test('space-separated form still treats a flag-shaped value as missing (no escape without =)', () => {
      const r = queryContextPredicatesJsonErrors(['--contains', '--since']);
      assert.equal(r.success, false, '--contains --since (space-separated) must remain a usage error');
      assert.equal(r.parsedError && r.parsedError.reason, ERROR_REASON.USAGE);
    });

    test('contains= with an empty value is still rejected', () => {
      const r = queryContextPredicatesJsonErrors(['--contains=']);
      assert.equal(r.success, false);
      assert.equal(r.parsedError && r.parsedError.reason, ERROR_REASON.USAGE);
    });

    test('contains== (double-equals) is still rejected, not accepted as literal "=x"', () => {
      const r = queryContextPredicatesJsonErrors(['--contains==x']);
      assert.equal(r.success, false);
      assert.equal(r.parsedError && r.parsedError.reason, ERROR_REASON.USAGE);
    });

    test('class=/prefix= inline-assignment form also works (not contains-only)', () => {
      const expected = selectPredicates(REAL_PREDICATES, { klass: 'META' });
      const r = queryContextPredicates(['--class=META']);
      assert.equal(r.success, true);
      const parsed = JSON.parse(r.output);
      assert.deepEqual(
        parsed.predicates.map((p) => p.id).sort(),
        expected.map((p) => p.id).sort(),
      );
    });
  });

  test('queryRejectsPrototypePollutingSelectorKeys', () => {
    for (const hostile of ['__proto__', 'constructor', 'prototype']) {
      const r = queryContextPredicates(['--class', hostile]);
      assert.equal(r.success, true, `${hostile} must be treated as an ordinary (non-matching) class name, not crash`);
      const parsed = JSON.parse(r.output);
      assert.equal(parsed.matched, 0);
      assert.equal(Object.prototype.toString.call({}), '[object Object]', 'sanity: global Object.prototype must be untouched');
    }
  });

  test('queryDoesNotInterpolateShellMetacharacters', () => {
    const markerPath = path.join(ROOT, '.gsd-test-shell-injection-marker-2928');
    assert.equal(fs.existsSync(markerPath), false, 'fixture sanity: marker must not pre-exist');
    const hostileValue = `; touch ${markerPath} #`;
    const r = queryContextPredicates(['--contains', hostileValue]);
    assert.equal(fs.existsSync(markerPath), false, 'a shell metacharacter payload must never be interpolated into a shell');
    assert.doesNotMatch(r.error || '', STACK_FRAME_RE);
  });

  test('queryHandlesVeryLongSelectorValue', () => {
    const longValue = 'x'.repeat(32 * 1024);
    const r = queryContextPredicates(['--contains', longValue]);
    assert.equal(typeof r.exitCode, 'number', 'a 32K selector value must not hang or crash the process');
    assert.doesNotMatch(r.error || '', STACK_FRAME_RE);
  });

  test('queryHandlesUnicodeSelectorValue', () => {
    const unicodeValue = String.fromCodePoint(0x9884, 0x6d4b, 0x5909, 0x6570, 0x1f525);
    const r = queryContextPredicates(['--contains', unicodeValue]);
    assert.equal(typeof r.exitCode, 'number', 'a Unicode selector value must not crash the process');
    assert.doesNotMatch(r.error || '', STACK_FRAME_RE);
  });

  test('queryWorksFromSubdirectoryWithoutPlanningDir', (t) => {
    const tmp = createTempDir('gci-query-subdir-');
    t.after(() => cleanup(tmp));
    const r = queryContextPredicates(['--class', 'META'], tmp);
    assert.equal(r.success, true, 'the read-only selector must not require a .planning/ directory');
  });

  test('queryFailureOutputContainsNoStackTrace', () => {
    const r = queryContextPredicates([]);
    assert.equal(r.success, false);
    assert.doesNotMatch(r.error || '', STACK_FRAME_RE, 'no bare stack trace in non-debug failure output');
  });
});

// allow-test-rule: source-text-is-the-product #2928
// Wiring check for #2928's acceptance criterion — "an agent/orchestrator can invoke the
// selector through a wired `gsd_run query` surface to assemble a brief". Before this, nothing
// in the repo called `context-predicates`; it was a stranded CLI. docs/contributor-standards.md
// §"Pre-work requirements" is the real, tested brief-assembly site governing how an AI-agent
// prompt must cite CONTEXT.md's META.RULE predicates — this asserts it routes through the
// selector instead of a grep-by-eye read, and that the selector actually returns the predicate
// set that site names.
describe('context-predicates wired into a real brief-assembly site (#2928)', () => {
  const STANDARDS_DOC = path.join(ROOT, 'docs', 'contributor-standards.md');
  const standardsText = fs.readFileSync(STANDARDS_DOC, 'utf8');

  test('contributorStandardsRoutesPredicateCitationThroughTheQuerySelector', () => {
    assert.ok(
      standardsText.includes('node gsd-tools.cjs query context-predicates --class'),
      'docs/contributor-standards.md must invoke the context-predicates selector rather than instructing a grep-by-eye read'
    );
    assert.ok(
      standardsText.includes('META.RULE.brief-must-cite-doc') && standardsText.includes('META.RULE.brief-no-paraphrase'),
      'the wiring site must name the predicates it expects the selector to surface'
    );
  });

  test('theSelectorActuallyReturnsThePredicatesTheWiringSiteNames', () => {
    const r = queryContextPredicates(['--class', 'META']);
    assert.equal(r.success, true);
    const parsed = JSON.parse(r.output);
    const ids = parsed.predicates.map((p) => p.id);
    assert.ok(ids.includes('META.RULE.brief-must-cite-doc'));
    assert.ok(ids.includes('META.RULE.brief-no-paraphrase'));
  });
});
