#!/usr/bin/env node
'use strict';

/**
 * lint-example-parser-parity.cjs — asserts examples/dynamic-context-management/
 * context-predicates.cjs (reference prototype, ADR-1671) and production's
 * src/context-predicates.cts (compiled to gsd-core/bin/lib/context-predicates.cjs)
 * agree on parsing behavior, and that the example's own committed
 * CONTEXT-INDEX.json has not silently drifted from a fresh parse.
 *
 * Lives OUTSIDE tests/ deliberately. ADR-1671
 * (docs/adr/1671-dynamic-context-management-platform.md:102) places
 * examples/dynamic-context-management/ outside FOUR surfaces: the build
 * (src/ -> bin/lib/), the npm package files[], the installer, and the CI test
 * suite (tests/). A lint script wired into `npm run lint:ci` is none of
 * those four — it does not compile, package, install, or test-suite-import
 * the example; it only READS both modules from a repo-root script and
 * asserts they agree, the same shape as every other scripts/lint-*.cjs in
 * this repo that reads source it does not own (see e.g.
 * lint-compiled-artifact-sync.cjs).
 *
 * Two parity surfaces:
 *   1. production vs. example, parsed against the real repo-root CONTEXT.md:
 *      predicate count, class map, duplicate-id set, the full set of
 *      (id, value) pairs, and a representative accept/reject id-shape table
 *      (including the embedded-CR-in-value case production already rejected
 *      and the example silently accepted before this fix).
 *   2. the example's OWN committed CONTEXT-INDEX.json vs. a fresh parse by
 *      the example's own parser of the real CONTEXT.md — LINE-NUMBER-
 *      INDEPENDENT (see below). This guards the same #2944 merge-race
 *      staleness class this PR fixed for docs/CONTEXT-INDEX.json, but for the
 *      example's own copy, which nothing previously guarded at all.
 *
 * Why `line` is excluded from surface 2 (ADR-1671 open question 4): the
 * example's CONTEXT-INDEX.json bakes source line numbers into every
 * predicate entry. Any unrelated CONTEXT.md line-shift (e.g. inserting a
 * sentence above the predicates) re-drifts that artifact even though every
 * predicate id/value/class is byte-identical. Wiring the example's own
 * `gen-context-index.cjs --check` into lint:ci — which DOES compare line
 * numbers — would make CI routinely red for reasons unrelated to predicate
 * integrity. This lint instead derives the LINE-INDEPENDENT facts from the
 * committed index (count, class map, duplicate-id set, (id,value) pairs) and
 * compares those to a fresh parse: genuine content drift (the #2944
 * merge-race defect class) is still caught; a pure line-shift is not.
 *
 * `--context-path` / `--example-index-path` override the two hardcoded paths
 * (mirrors scripts/gen-context-index.cjs) so this script's non-vacuousness
 * can be proven against a throwaway temp fixture without ever touching the
 * real committed artifacts.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const PROD_PREDICATES_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'context-predicates.cjs');
const EXAMPLE_DIR = path.join(ROOT, 'examples', 'dynamic-context-management');
const EXAMPLE_PREDICATES_PATH = path.join(EXAMPLE_DIR, 'context-predicates.cjs');
const DEFAULT_EXAMPLE_INDEX_PATH = path.join(EXAMPLE_DIR, 'CONTEXT-INDEX.json');
const DEFAULT_CONTEXT_PATH = path.join(ROOT, 'CONTEXT.md');

// ─── Loaders ──────────────────────────────────────────────────────────────────

/**
 * Load the compiled production predicates library. Throws a clean ExitError
 * (never a bare MODULE_NOT_FOUND stack) naming the remedy when it is missing.
 */
function loadProdPredicates() {
  try {
    delete require.cache[require.resolve(PROD_PREDICATES_PATH)];
    return require(PROD_PREDICATES_PATH);
  } catch (err) {
    throw new ExitError(
      1,
      `Cannot load ${path.relative(ROOT, PROD_PREDICATES_PATH)}: ${err && err.message}\n` +
        'Run:\n  npm run build:lib\n',
    );
  }
}

/** Load the example's self-contained predicates module (no build step). */
function loadExamplePredicates() {
  delete require.cache[require.resolve(EXAMPLE_PREDICATES_PATH)];
  return require(EXAMPLE_PREDICATES_PATH);
}

/**
 * Read a CONTEXT.md-shaped markdown file. Throws a clean ExitError naming the
 * path when it is missing or unreadable.
 *
 * @param {string} contextPath
 * @returns {string}
 */
function readContextMarkdown(contextPath) {
  try {
    return fs.readFileSync(contextPath, 'utf8');
  } catch (err) {
    throw new ExitError(1, `Cannot read ${path.relative(ROOT, contextPath)}: ${err && err.message}`);
  }
}

// ─── Diffing helpers ────────────────────────────────────────────────────────

/**
 * Diff two predicate-shaped arrays by id, comparing ONLY `klass`/`value`
 * (never `line`/`section` — see the module doc comment's "Why `line` is
 * excluded"). Returns human-readable divergence strings naming the exact
 * predicate id(s), so a failure reads as an actionable list, never "objects
 * differ".
 *
 * @param {Array<{id:string,klass:string,value:string}>} leftPredicates
 * @param {Array<{id:string,klass:string,value:string}>} rightPredicates
 * @param {string} leftLabel
 * @param {string} rightLabel
 * @returns {string[]}
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

/** Sorted, deduplicated id list from a `duplicates` array (either `{id,count}` or `{id,lines}` shape). */
function duplicateIds(duplicates) {
  return duplicates.map((d) => d.id).sort();
}

/** Build a single-line `` `id=value` `` markdown fixture wrapping one candidate id=value pair. */
function backtickLine(idEqualsValue) {
  return '`' + idEqualsValue + '`';
}

// Representative accept/reject id-shape table both parsers must agree on —
// this is what PROVES the parity claim rather than merely asserting it.
// FINDING 4 (ADR-1671 PR review): the embedded-CR-in-value case below was the
// one real divergence the earlier parity claim missed — production rejected
// it, the example silently accepted it. Both now reject it (ported fix).
const ID_SHAPE_CASES = [
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

/**
 * The embedded-CR case needs its own fixture, not the plain
 * `` `ID=value` `` shape backtickLine() builds: a lone CR with no following
 * LF never reaches a closing backtick at all (a separate, documented parser
 * limit — see src/context-predicates.cts's module doc comment), so the CR
 * must sit INSIDE an otherwise well-formed, LF-terminated backtick line.
 */
const CR_VALUE_MARKDOWN = '`ID=ab\rcd`\n';

// ─── Parity checks (surface 1: production vs. example) ────────────────────────

/**
 * @param {object} prodPredicates
 * @param {object} examplePredicates
 * @param {string} markdown
 * @returns {string[]} diagnostics; empty when the two parsers fully agree
 */
function checkProdExampleParity(prodPredicates, examplePredicates, markdown) {
  const diagnostics = [];

  const prodParsed = prodPredicates.parsePredicates(markdown);
  const exampleParsed = examplePredicates.parsePredicates(markdown);
  const prodIndex = prodPredicates.buildIndex(prodParsed.predicates);
  const exampleIndex = examplePredicates.buildIndex(exampleParsed.predicates);

  if (exampleIndex.count !== prodIndex.count) {
    diagnostics.push(`predicate count diverged: example=${exampleIndex.count} production=${prodIndex.count}`);
  }

  const prodClassKeys = Object.keys(prodIndex.classes).sort();
  const exampleClassKeys = Object.keys(exampleIndex.classes).sort();
  if (JSON.stringify(exampleClassKeys) !== JSON.stringify(prodClassKeys)) {
    diagnostics.push(
      `class set diverged: example=${JSON.stringify(exampleClassKeys)} production=${JSON.stringify(prodClassKeys)}`,
    );
  } else if (JSON.stringify(exampleIndex.classes) !== JSON.stringify(prodIndex.classes)) {
    diagnostics.push(
      `per-class predicate counts diverged: example=${JSON.stringify(exampleIndex.classes)} ` +
        `production=${JSON.stringify(prodIndex.classes)}`,
    );
  }

  const prodDupIds = duplicateIds(prodIndex.duplicates);
  const exampleDupIds = duplicateIds(exampleIndex.duplicates);
  if (JSON.stringify(exampleDupIds) !== JSON.stringify(prodDupIds)) {
    diagnostics.push(
      `duplicate-id set diverged: example=${JSON.stringify(exampleDupIds)} production=${JSON.stringify(prodDupIds)}`,
    );
  }

  diagnostics.push(...diffPredicatesById(exampleIndex.predicates, prodIndex.predicates, 'example', 'production'));

  for (const { idEqualsValue, expectAccept } of ID_SHAPE_CASES) {
    const line = backtickLine(idEqualsValue);
    const exampleCount = examplePredicates.parsePredicates(line).predicates.length;
    const prodCount = prodPredicates.parsePredicates(line).predicates.length;
    if (exampleCount !== prodCount) {
      diagnostics.push(
        `id-shape verdict diverged for ${JSON.stringify(idEqualsValue)}: ` +
          `example found ${exampleCount} predicate(s), production found ${prodCount}`,
      );
      continue;
    }
    const actualAccept = prodCount === 1;
    if (actualAccept !== expectAccept) {
      diagnostics.push(
        `id-shape verdict wrong for ${JSON.stringify(idEqualsValue)}: expected ` +
          `${expectAccept ? 'ACCEPT' : 'REJECT'}, both modules agreed on ${actualAccept ? 'ACCEPT' : 'REJECT'} instead`,
      );
    }
  }

  const exampleCrCount = examplePredicates.parsePredicates(CR_VALUE_MARKDOWN).predicates.length;
  const prodCrCount = prodPredicates.parsePredicates(CR_VALUE_MARKDOWN).predicates.length;
  if (exampleCrCount !== prodCrCount) {
    diagnostics.push(
      `id-shape verdict diverged for embedded-CR-in-value: example found ${exampleCrCount} predicate(s), ` +
        `production found ${prodCrCount}`,
    );
  } else if (prodCrCount !== 0) {
    diagnostics.push(
      `embedded-CR-in-value must be REJECTED by both parsers; both instead ACCEPTED it (${prodCrCount} predicate(s))`,
    );
  }

  return diagnostics;
}

// ─── Parity check (surface 2: example's committed index vs. fresh parse) ──────

/** Strip a predicate down to the line-number-independent fields used for comparison. */
function toLineIndependent(p) {
  return { id: p.id, klass: p.klass, value: p.value };
}

/**
 * @param {object} examplePredicates
 * @param {string} markdown
 * @param {string} exampleIndexPath
 * @returns {string[]} diagnostics; empty when the committed index and a fresh
 *   parse agree on every LINE-NUMBER-INDEPENDENT fact
 */
function checkExampleIndexParity(examplePredicates, markdown, exampleIndexPath) {
  const diagnostics = [];

  let committed;
  try {
    committed = JSON.parse(fs.readFileSync(exampleIndexPath, 'utf8'));
  } catch (err) {
    diagnostics.push(`cannot read/parse ${exampleIndexPath}: ${err && err.message}`);
    return diagnostics;
  }
  if (!committed || !Array.isArray(committed.predicates)) {
    diagnostics.push(`${exampleIndexPath} does not have the expected ContextIndex shape`);
    return diagnostics;
  }

  const { predicates } = examplePredicates.parsePredicates(markdown);
  const fresh = examplePredicates.buildIndex(predicates);

  if (committed.count !== fresh.count) {
    diagnostics.push(`example index predicate count diverged: committed=${committed.count} fresh=${fresh.count}`);
  }
  if (JSON.stringify(committed.classes) !== JSON.stringify(fresh.classes)) {
    diagnostics.push(
      `example index class-count map diverged: committed=${JSON.stringify(committed.classes)} ` +
        `fresh=${JSON.stringify(fresh.classes)}`,
    );
  }

  const committedDupIds = duplicateIds(committed.duplicates || []);
  const freshDupIds = duplicateIds(fresh.duplicates);
  if (JSON.stringify(committedDupIds) !== JSON.stringify(freshDupIds)) {
    diagnostics.push(
      `example index duplicate-id set diverged: committed=${JSON.stringify(committedDupIds)} ` +
        `fresh=${JSON.stringify(freshDupIds)}`,
    );
  }

  const committedIndependent = committed.predicates.map(toLineIndependent);
  const freshIndependent = fresh.predicates.map(toLineIndependent);
  const diffs = diffPredicatesById(committedIndependent, freshIndependent, 'committed example index', 'fresh parse');
  diagnostics.push(...diffs.map((d) => `example index: ${d}`));

  return diagnostics;
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ contextPath: string, exampleIndexPath: string }}
 */
function parseArgs(argv) {
  const opts = { contextPath: DEFAULT_CONTEXT_PATH, exampleIndexPath: DEFAULT_EXAMPLE_INDEX_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--context-path') {
      opts.contextPath = path.resolve(argv[++i] ?? '');
    } else if (arg === '--example-index-path') {
      opts.exampleIndexPath = path.resolve(argv[++i] ?? '');
    } else {
      throw new ExitError(
        1,
        `Unknown argument: ${arg}\n` +
          'Usage: lint-example-parser-parity.cjs [--context-path <path>] [--example-index-path <path>]\n',
      );
    }
  }
  return opts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const prodPredicates = loadProdPredicates();
  const examplePredicates = loadExamplePredicates();
  const markdown = readContextMarkdown(opts.contextPath);

  const diagnostics = [
    ...checkProdExampleParity(prodPredicates, examplePredicates, markdown),
    ...checkExampleIndexParity(examplePredicates, markdown, opts.exampleIndexPath),
  ];

  if (diagnostics.length > 0) {
    process.stderr.write(
      `\nERROR lint-example-parser-parity: ${diagnostics.length} divergence(s) found\n\n`,
    );
    for (const d of diagnostics) process.stderr.write(`  - ${d}\n`);
    process.stderr.write(
      '\nexamples/dynamic-context-management/context-predicates.cjs and ' +
        'src/context-predicates.cts (gsd-core/bin/lib/context-predicates.cjs) must agree; ' +
        'the committed examples/dynamic-context-management/CONTEXT-INDEX.json must match a ' +
        'fresh parse of CONTEXT.md on every line-number-independent fact (run:\n' +
        '  node examples/dynamic-context-management/gen-context-index.cjs --write\n' +
        ').\n',
    );
    throw new ExitError(1);
  }

  process.stdout.write(
    'ok lint-example-parser-parity: production and example parsers agree on the real CONTEXT.md ' +
      `(count/classes/duplicates/(id,value) pairs), on ${ID_SHAPE_CASES.length + 1} representative ` +
      'accept/reject id-shape cases, and the committed example index matches a fresh parse ' +
      '(line-number-independent)\n',
  );
}

module.exports = {
  loadProdPredicates,
  loadExamplePredicates,
  readContextMarkdown,
  diffPredicatesById,
  checkProdExampleParity,
  checkExampleIndexParity,
  parseArgs,
  ID_SHAPE_CASES,
  CR_VALUE_MARKDOWN,
};

if (require.main === module) {
  runMain(main);
}
