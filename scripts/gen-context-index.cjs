#!/usr/bin/env node
'use strict';

/**
 * gen-context-index.cjs — generates docs/CONTEXT-INDEX.json from the
 * predicate declarations (`` `CLASS.subkey=value` `` lines) in the
 * repo-root CONTEXT.md.
 *
 * Usage:
 *   node scripts/gen-context-index.cjs                        # print to stdout
 *   node scripts/gen-context-index.cjs --write                # write docs/CONTEXT-INDEX.json
 *   node scripts/gen-context-index.cjs --check                # exit 1 if committed file is stale
 *   node scripts/gen-context-index.cjs --check --json          # same, + typed report on stdout
 *   node scripts/gen-context-index.cjs --write --context-path <p> --index-path <p>
 *                                                              # override the two hardcoded
 *                                                              # repo-root paths (tests use
 *                                                              # this to point the real CLI at
 *                                                              # a temp fixture tree with no fs
 *                                                              # monkeypatching required)
 *
 * ADR-1671 ("Dynamic context management platform", #2928) Phase 1 commits 1+3.
 * The generated artifact is plain JSON (docs/CONTEXT-INDEX.json), mirroring
 * docs/INVENTORY-MANIFEST.json's precedent: a committed, generated,
 * `--check`-guarded JSON manifest that is NOT runtime code. It previously
 * lived at gsd-core/bin/lib/context-index.cjs — a shipped runtime module is
 * the wrong place for ~120 KB of arbitrary CONTEXT.md prose: it tripped both
 * tests/cline-install.test.cjs's leaked-`.claude`-path guard and
 * tests/package-name-single-source.test.cjs's hardcoded-package-name guard,
 * both true positives against runtime-code content scanning. Moving the
 * artifact to docs/ (never scanned as runtime code) fixes both without
 * weakening either guard.
 *
 * Depends on the COMPILED gsd-core/bin/lib/context-predicates.cjs
 * (src/context-predicates.cts, built by `npm run build:lib`). This is safe
 * for CI: `.github/workflows/test.yml` runs `build:lib` before `lint:ci`.
 *
 * `--check --json` (CONTRIBUTING.md "Prohibited: Raw Text Matching on Test
 * Outputs"): emits `{ ok, reason, duplicates, count, classes }` — `reason` is
 * always one of the frozen `REASON` values (exported below) so tests assert
 * `report.reason === REASON.FAIL_X` instead of regex-matching the prose the
 * non-JSON mode still prints for human operators. The human-readable output
 * is unchanged.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { normalizeEol } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.resolve(__dirname, '..');
const CONTEXT_PREDICATES_LIB_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'context-predicates.cjs');
const CONTEXT_PATH = path.join(ROOT, 'CONTEXT.md');
const INDEX_PATH = path.join(ROOT, 'docs', 'CONTEXT-INDEX.json');

// ─── Typed reason enum (CONTRIBUTING.md "Prohibited: Raw Text Matching") ───────

/**
 * Stable reason codes for `checkReport`'s `reason` field. Tests assert via
 * `assert.equal(report.reason, REASON.X)` rather than regex-matching the
 * human-readable prose the non-JSON `--check` mode still writes to
 * stdout/stderr, so the diagnostic surface is a typed enum, not free text.
 *
 * Adding a new reason requires updating this map AND the tests' shape
 * assertion that locks the documented set of codes
 * (`Object.keys(REASON).sort()`).
 */
const REASON = Object.freeze({
  OK_UP_TO_DATE: 'ok_up_to_date',
  FAIL_STALE: 'fail_stale',
  FAIL_INDEX_MISSING: 'fail_index_missing',
  FAIL_INDEX_UNPARSEABLE: 'fail_index_unparseable',
  FAIL_DUPLICATE_IDS: 'fail_duplicate_ids',
  FAIL_CONTEXT_MISSING: 'fail_context_missing',
  FAIL_CONTEXT_UNREADABLE: 'fail_context_unreadable',
  FAIL_LIB_NOT_BUILT: 'fail_lib_not_built',
});

// ─── Loaders ──────────────────────────────────────────────────────────────────

/**
 * Load the compiled context-predicates library. The artifact is a gitignored
 * tsc build output of src/context-predicates.cts and only exists after
 * `npm run build:lib`. Throws a clean ExitError (never a bare
 * MODULE_NOT_FOUND stack) naming the remedy when it is missing.
 *
 * @returns {{ parsePredicates: Function, selectPredicates: Function, buildIndex: Function }}
 */
function loadContextPredicatesLib() {
  try {
    delete require.cache[require.resolve(CONTEXT_PREDICATES_LIB_PATH)];
    return require(CONTEXT_PREDICATES_LIB_PATH);
  } catch (err) {
    throw new ExitError(
      1,
      `Cannot load ${path.relative(ROOT, CONTEXT_PREDICATES_LIB_PATH)}: ${err && err.message}\n` +
      'Run:\n  npm run build:lib\n',
    );
  }
}

/**
 * Read a CONTEXT.md-shaped markdown file. Throws a clean ExitError naming the
 * path (never a bare stack trace) when it is missing or unreadable.
 *
 * @param {string} [contextPath] - defaults to the real repo-root CONTEXT.md.
 * @returns {string}
 */
function readContextMarkdown(contextPath = CONTEXT_PATH) {
  try {
    return fs.readFileSync(contextPath, 'utf8');
  } catch (err) {
    throw new ExitError(1, `Cannot read ${path.relative(ROOT, contextPath)}: ${err && err.message}`);
  }
}

/**
 * Build a fresh ContextIndex from the given CONTEXT.md-shaped content.
 *
 * @param {string} [contextPath] - defaults to the real repo-root CONTEXT.md.
 * @returns {object}
 */
function buildFreshIndex(contextPath = CONTEXT_PATH) {
  const { parsePredicates, buildIndex } = loadContextPredicatesLib();
  const markdown = readContextMarkdown(contextPath);
  const { predicates } = parsePredicates(markdown);
  return buildIndex(predicates);
}

// ─── Serialization ────────────────────────────────────────────────────────────

/**
 * Serialize a ContextIndex to the committed plain-JSON artifact text
 * (docs/CONTEXT-INDEX.json). Plain JSON — not a CommonJS module — because
 * this is a generated data manifest (mirroring docs/INVENTORY-MANIFEST.json),
 * not runtime code: it must never be `require()`-able from a shipped
 * gsd-core/bin/lib/*.cjs module, which is exactly the mistake that leaked
 * ~120 KB of CONTEXT.md prose (including `.claude/hooks/...` path literals
 * and hardcoded package-name strings) into runtime-code content scanning.
 *
 * @param {object} index
 * @returns {string}
 */
function serializeIndex(index) {
  return JSON.stringify(index, null, 2) + '\n';
}

/**
 * Extract the sorted list of duplicate predicate ids from a built index.
 *
 * @param {{ duplicates: Array<{ id: string, count: number }> }} index
 * @returns {string[]}
 */
function duplicateIds(index) {
  return index.duplicates.map((d) => d.id);
}

// ─── Typed check report ───────────────────────────────────────────────────────

/**
 * Empty-report shape shared by every early-exit branch below, so callers
 * (JSON mode, tests) always see the same four data fields regardless of
 * which reason fired.
 *
 * @returns {{ duplicates: Array, count: number, classes: object }}
 */
function emptyReportFields() {
  return { duplicates: [], count: 0, classes: {} };
}

/**
 * Compute the full `--check` result as a typed, non-throwing report — the
 * structured intermediate representation CONTRIBUTING.md's "Prohibited: Raw
 * Text Matching on Test Outputs" section requires alongside the human prose
 * `main()` still prints. Never throws; every failure mode is a `reason` code
 * from the frozen `REASON` enum.
 *
 * @param {string} [contextPath] - defaults to the real repo-root CONTEXT.md.
 * @param {string} [indexPath] - defaults to the real committed index.
 * @returns {{ ok: boolean, reason: string, duplicates: Array<{id:string,count:number}>, count: number, classes: object, message: string }}
 */
function checkReport(contextPath = CONTEXT_PATH, indexPath = INDEX_PATH) {
  let markdown;
  try {
    markdown = fs.readFileSync(contextPath, 'utf8');
  } catch (err) {
    const reason = err && err.code === 'ENOENT' ? REASON.FAIL_CONTEXT_MISSING : REASON.FAIL_CONTEXT_UNREADABLE;
    return {
      ok: false,
      reason,
      ...emptyReportFields(),
      message: `Cannot read ${path.relative(ROOT, contextPath)}: ${err && err.message}`,
    };
  }

  let parsePredicates;
  let buildIndex;
  try {
    delete require.cache[require.resolve(CONTEXT_PREDICATES_LIB_PATH)];
    ({ parsePredicates, buildIndex } = require(CONTEXT_PREDICATES_LIB_PATH));
  } catch (err) {
    return {
      ok: false,
      reason: REASON.FAIL_LIB_NOT_BUILT,
      ...emptyReportFields(),
      message: `Cannot load ${path.relative(ROOT, CONTEXT_PREDICATES_LIB_PATH)}: ${err && err.message}\n` +
        'Run:\n  npm run build:lib\n',
    };
  }

  const { predicates } = parsePredicates(markdown);
  const live = buildIndex(predicates);
  const dups = duplicateIds(live);

  if (dups.length > 0) {
    return {
      ok: false,
      reason: REASON.FAIL_DUPLICATE_IDS,
      duplicates: live.duplicates,
      count: live.count,
      classes: live.classes,
      message: 'CONTEXT.md has duplicate predicate id(s): ' + dups.join(', ') + '\n' +
        'Each predicate id must be declared exactly once.\n',
    };
  }

  if (!fs.existsSync(indexPath)) {
    return {
      ok: false,
      reason: REASON.FAIL_INDEX_MISSING,
      duplicates: live.duplicates,
      count: live.count,
      classes: live.classes,
      message: `${path.relative(ROOT, indexPath)} does not exist. Run:\n  node scripts/gen-context-index.cjs --write\n`,
    };
  }

  let committedIndex;
  try {
    const committedText = fs.readFileSync(indexPath, 'utf8');
    committedIndex = JSON.parse(committedText);
    if (!committedIndex || typeof committedIndex !== 'object' || !Array.isArray(committedIndex.predicates)) {
      throw new Error('parsed JSON does not have the expected ContextIndex shape');
    }
  } catch (err) {
    return {
      ok: false,
      reason: REASON.FAIL_INDEX_UNPARSEABLE,
      duplicates: live.duplicates,
      count: live.count,
      classes: live.classes,
      message: `${path.relative(ROOT, indexPath)} is unparseable: ${err && err.message}\n` +
        'Run:\n  node scripts/gen-context-index.cjs --write\n',
    };
  }

  // Comparing parsed JSON (rather than raw file text) is inherently
  // CRLF-agnostic: JSON.parse treats \r\n and \n as equivalent insignificant
  // whitespace between tokens, and predicate values never contain embedded
  // newlines (the parser only extracts single-physical-line declarations).
  if (JSON.stringify(committedIndex) !== JSON.stringify(live)) {
    return {
      ok: false,
      reason: REASON.FAIL_STALE,
      duplicates: live.duplicates,
      count: live.count,
      classes: live.classes,
      message: `${path.relative(ROOT, indexPath)} is stale. Run:\n  node scripts/gen-context-index.cjs --write\n`,
    };
  }

  return {
    ok: true,
    reason: REASON.OK_UP_TO_DATE,
    duplicates: live.duplicates,
    count: live.count,
    classes: live.classes,
    message: `${path.relative(ROOT, indexPath)} is up to date.\n`,
  };
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

/**
 * True when `value` cannot be accepted as a `--context-path`/`--index-path`
 * argument: absent (no more argv), empty string, or flag-shaped (starts with
 * `-`, so a dangling `--context-path` immediately followed by the NEXT flag
 * is rejected rather than silently swallowing that flag as a literal path).
 *
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isMissingPathValue(value) {
  return value === undefined || value === '' || value.startsWith('-');
}

/**
 * Parse CLI arguments into a structured options object.
 *
 * `--context-path` / `--index-path` override the two hardcoded repo-root
 * paths — added so tests can point the real CLI at a temp fixture tree
 * directly, with no fs monkeypatching required.
 *
 * Two usage-error conditions (DEFECT.GEN-CONTEXT-INDEX-PARSEARGS-GATE-BYPASS,
 * MAJOR review finding) collapse into `mode: 'unknown'`, the same clean,
 * no-stack-trace usage-error path `main()` already uses for an unrecognized
 * flag:
 *   (a) `--check` and `--write` given together — previously the LAST one
 *       seen silently won, so `--check --write` exited 0 and REWROTE the
 *       committed index instead of gating. Conflicting mode flags are now a
 *       hard usage error regardless of order.
 *   (b) a missing/empty/flag-shaped value for `--context-path` /
 *       `--index-path` — previously `path.resolve(argv[++i] ?? '')`
 *       resolved to the current working directory, and in `--write` mode
 *       that later threw an uncaught, uncleaned `EISDIR` stack trace from
 *       `fs.writeFileSync` (CONTRIBUTING.md: no stack trace in non-debug
 *       failure output). Rejected up front instead, before any I/O.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ mode: 'check'|'write'|'default'|'unknown', json: boolean, contextPath: string, indexPath: string, unknownArg?: string, usageMessage?: string }}
 */
function parseArgs(argv) {
  const opts = { mode: 'default', json: false, contextPath: CONTEXT_PATH, indexPath: INDEX_PATH };
  let sawCheck = false;
  let sawWrite = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      sawCheck = true;
      opts.mode = 'check';
    } else if (arg === '--write') {
      sawWrite = true;
      opts.mode = 'write';
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--context-path' || arg === '--index-path') {
      const value = argv[i + 1];
      if (isMissingPathValue(value)) {
        return {
          ...opts,
          mode: 'unknown',
          unknownArg: arg,
          usageMessage: `${arg} requires a non-empty path argument (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`,
        };
      }
      i++;
      if (arg === '--context-path') opts.contextPath = path.resolve(value);
      else opts.indexPath = path.resolve(value);
    } else {
      opts.mode = 'unknown';
      opts.unknownArg = arg;
    }
  }

  if (sawCheck && sawWrite) {
    return {
      ...opts,
      mode: 'unknown',
      usageMessage: '--check and --write are mutually exclusive',
    };
  }

  return opts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'unknown') {
    process.stderr.write('Usage: gen-context-index.cjs [--write|--check] [--json] [--context-path <path>] [--index-path <path>]\n');
    if (opts.usageMessage) process.stderr.write(`${opts.usageMessage}\n`);
    throw new ExitError(1);
  }

  if (opts.mode === 'default') {
    process.stdout.write(serializeIndex(buildFreshIndex(opts.contextPath)) + '\n');
    return;
  }

  if (opts.mode === 'check') {
    const report = checkReport(opts.contextPath, opts.indexPath);

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        ok: report.ok,
        reason: report.reason,
        duplicates: report.duplicates,
        count: report.count,
        classes: report.classes,
      }) + '\n');
    } else if (report.ok) {
      process.stdout.write(report.message);
    }

    if (!report.ok) {
      // JSON mode already carries the structured report on stdout — do not
      // duplicate the prose onto stderr, but the exit code must still be 1.
      throw new ExitError(1, opts.json ? undefined : report.message);
    }
    return;
  }

  // opts.mode === 'write'
  const index = buildFreshIndex(opts.contextPath);
  fs.mkdirSync(path.dirname(opts.indexPath), { recursive: true });
  fs.writeFileSync(opts.indexPath, serializeIndex(index), 'utf8');
  const dupCount = index.duplicates.length;
  process.stdout.write(
    `Wrote ${path.relative(ROOT, opts.indexPath)}\n` +
    `  ${index.count} predicates, ${Object.keys(index.classes).length} classes, ` +
    `${dupCount} duplicate id${dupCount !== 1 ? 's' : ''}\n`,
  );
}

// ─── Exports (for tests) ──────────────────────────────────────────────────────

module.exports = {
  loadContextPredicatesLib,
  readContextMarkdown,
  buildFreshIndex,
  serializeIndex,
  normalizeLineEndings: normalizeEol,
  duplicateIds,
  checkReport,
  parseArgs,
  REASON,
  CONTEXT_PREDICATES_LIB_PATH,
  CONTEXT_PATH,
  INDEX_PATH,
};

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runMain(main);
}
