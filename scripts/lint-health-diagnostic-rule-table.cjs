#!/usr/bin/env node
'use strict';

/**
 * lint-health-diagnostic-rule-table.cjs — gate: enforces ADR-3180 §8.2's 1:1
 * rule-code invariant and §8.5's fixture-proof invariant for
 * `src/health-diagnostic.cts`'s RULES table (Phase 11, #3309).
 *
 * ## What this enforces
 *
 * 1. (§8.2 rule 1 — 1:1 code invariant) Every `rule.code` in RULES (exported
 *    from the compiled `gsd-core/bin/lib/health-diagnostic.cjs`) is unique,
 *    and every rule's `severity` is one of `SEVERITY`'s values. The severity
 *    check exists only to confirm the compiled artifact was not hand-edited
 *    to bypass the `Rule.severity` required field TypeScript already
 *    enforces at compile time — "severity is a property of the RULE, never
 *    the emit call."
 * 2. (§8.5 — fixture-proof invariant) Every code in RULES has a paired test:
 *    the code string (e.g. `'W001'`) appears as a literal AND within a
 *    `describe(`/`test(` block whose title also names that exact code, in
 *    one of the health-diagnostic test files
 *    (`tests/health-diagnostic-rules/*.test.cjs`,
 *    `tests/health-diagnostic.test.cjs`). A mere comment/string mention
 *    outside a titled block does not count as coverage.
 *
 *    EXCEPTION — `PERMANENTLY_INERT_CODES` (below): a rule whose `check`
 *    always returns `[]` BY DESIGN (the real check lives outside the rule
 *    table entirely, because it needs ambient I/O `Rule.check` cannot
 *    perform — §8.1 rule 1) can never satisfy a real fixture-proof, no
 *    matter how many tests reference its code. Before this exception
 *    existed, W024 "passed" this guard only because an unrelated test title
 *    (the RULES-array shape assertion, "exports exactly 5 rules: W024, ...")
 *    happened to contain the string "W024" — accidental coverage, not proof
 *    the rule can fire. `PERMANENTLY_INERT_CODES` makes that exemption
 *    explicit and auditable instead of relying on a coincidental title
 *    match, and the PASS output now reports exempted codes SEPARATELY from
 *    genuinely fixture-covered ones rather than folding them together.
 * 3. (Phase 12, #3310 — S0NN pass) `cmdStateValidate` (src/state.cts) emits
 *    7 coded diagnostics (S001-S007) built inline via a local
 *    `stateDiagnostic()` helper — NOT `Rule`-table entries, so they are not
 *    read from the compiled module the way RULES/CONSISTENCY_RULES are.
 *    This third pass hardcodes that code list (`STATE_VALIDATE_CODES`,
 *    below) and applies the SAME §8.5 fixture-proof check against
 *    `tests/state.test.cjs`, reported in its own PASS/FAIL section —
 *    mirroring the C0NN pass's structure, just with a hardcoded list
 *    instead of a `Rule[]` array as the code source.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * ("The lint guard (§8.2 1:1 invariant + §8.5 fixture proof)").
 *
 * ## Deviation from the design doc's original plan
 *
 * The design doc assumed fixtures would live as separate files at
 * `tests/fixtures/health-diagnostic/<code>.*`. That did not happen during
 * implementation — all 8 rule-group test files
 * (`tests/health-diagnostic-rules/*.test.cjs`) build fixtures INLINE via
 * real temp directories (`createTempDir()` from `tests/helpers.cjs`) and a
 * real, non-mocked `buildPlanningSnapshot(tmpCwd)` call (see
 * `tests/health-diagnostic-rules/root-existence.test.cjs`). This guard
 * therefore verifies the fixture-proof invariant STATICALLY against the
 * test files' own text — mirroring `scripts/lint-fix-has-regression-tests.cjs`'s
 * house style — rather than dynamically re-running fixture-building code
 * this guard does not own.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const COMPILED_MODULE_REL = 'gsd-core/bin/lib/health-diagnostic.cjs';
const COMPILED_MODULE_PATH = path.join(REPO_ROOT, COMPILED_MODULE_REL);
const TEST_GROUP_DIR = path.join(REPO_ROOT, 'tests', 'health-diagnostic-rules');
const SKELETON_TEST_FILE = path.join(REPO_ROOT, 'tests', 'health-diagnostic.test.cjs');

// Phase 12 (#3310, ADR-3180 §8.4) — the C0NN namespace's own fixture-proof
// test file. §8.5 extends to `CONSISTENCY_RULES`'s NEW codes only (C001-C004
// — W006/W007 are already fixture-proofed above, against the SAME `Rule`
// objects; re-checking them here would be redundant, not additional
// coverage).
const CONSISTENCY_TEST_FILE = path.join(REPO_ROOT, 'tests', 'health-diagnostic-rules', 'consistency.test.cjs');
const CONSISTENCY_CODE_PREFIX_RE = /^C\d{3}$/;

// Phase 12 (#3310, ADR-3180 §8.5 extension) — the S0NN namespace's own
// fixture-proof pass. These codes are NOT collected in any exported `Rule[]`
// array: `cmdStateValidate` (src/state.cts) builds `Diagnostic[]` directly via
// a local `stateDiagnostic()` helper, not via the rule-table evaluator (out of
// scope for the RULES/CONSISTENCY_RULES-keyed passes above).
//
// #3696: the list is DISCOVERED from the source, not hardcoded. It used to be a
// literal `['S001', ..., 'S007']`, which is precisely the shape ADR-3180
// Decision 4(a) forbids — "guards discover call sites by whole-repo scan, never
// by an allowlist of known files" — because such a guard can only ever be as
// complete as the author's recall. Adding S008/S009 to `cmdStateValidate` left
// this pass reporting a confident, green "7 code(s), all fixture-covered" while
// two new codes had no fixture requirement at all: a zero it did not earn. The
// scan below cannot report a code it has not read out of the source.
const STATE_VALIDATE_TEST_FILE = path.join(REPO_ROOT, 'tests', 'state.test.cjs');
const STATE_VALIDATE_SOURCE_FILE = path.join(REPO_ROOT, 'src', 'state.cts');
// `g` is required by String.prototype.matchAll, which (unlike .exec) does not
// carry lastIndex across calls — so this constant is safe to share.
// #3696 review: `\s*` before `(` too. Requiring no space silently dropped a
// `stateDiagnostic ('S010', …)` call site from the discovered set, and since the
// fail-closed check below only fires on a FULLY empty result, a partial miss
// escaped the fixture-proof check entirely — the same "only as complete as the
// author's recall" failure this rewrite exists to prevent.
const STATE_DIAGNOSTIC_CALL_RE = /\bstateDiagnostic\s*\(\s*(['"`])(S\d{3})\1/g;

/**
 * Every S0NN code `cmdStateValidate` can emit, read off its
 * `stateDiagnostic(...)` call sites in `sourceText`.
 *
 * Takes the source TEXT rather than reading the path itself, so the discovery
 * rule is exercisable against controlled fixtures — including the fail-closed
 * path below, which is the branch that matters and which a path-reading
 * function could only be tested on by mutating the real `src/state.cts`.
 *
 * Fails closed. An empty result means the helper was renamed or its call shape
 * changed, and a guard that answers "0 codes, all covered" to that is worse than
 * no guard — so it raises instead. Line/regex-based (not full AST) per this
 * repo's existing lint-guard house style, same as TITLED_BLOCK_RE below.
 */
function discoverStateValidateCodes(sourceText, sourceLabel = formatRepoRelative(STATE_VALIDATE_SOURCE_FILE)) {
  const codes = [...sourceText.matchAll(STATE_DIAGNOSTIC_CALL_RE)].map((m) => m[2]);
  const unique = [...new Set(codes)].sort();
  if (unique.length === 0) {
    throw new ExitError(
      1,
      `lint-health-diagnostic-rule-table: found no stateDiagnostic() call sites in ${sourceLabel}.\n`
        + '  This pass discovers the S0NN code set from those call sites (#3696), so an empty\n'
        + '  result means the helper was renamed or its call shape changed — not that there are\n'
        + '  no codes. Update STATE_DIAGNOSTIC_CALL_RE to match the new shape.\n',
    );
  }
  return unique;
}

function readStateValidateSource() {
  if (!fs.existsSync(STATE_VALIDATE_SOURCE_FILE)) {
    throw new ExitError(
      1,
      `lint-health-diagnostic-rule-table: cannot discover S0NN codes — ${formatRepoRelative(STATE_VALIDATE_SOURCE_FILE)} not found.\n`,
    );
  }
  return fs.readFileSync(STATE_VALIDATE_SOURCE_FILE, 'utf8');
}

const STATE_VALIDATE_CODES = discoverStateValidateCodes(readStateValidateSource());

// Matches `describe(`/`test(`/`it(` calls whose first argument is a string
// literal, capturing that literal as the block's title. Line/regex-based
// (not full AST) per this repo's existing lint-guard house style
// (scripts/lint-planning-snapshot-bypass-drift.cjs's scanCode precedent).
const TITLED_BLOCK_RE = /\b(describe|test|it)\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;

// Rule codes whose `check` is a documented PERMANENT no-op (always returns
// `[]`) because the real check requires ambient I/O forbidden inside a
// `Rule.check(snapshot)` (§8.1 rule 1) — the real check runs elsewhere,
// outside the rule table. These can never be proven via a real
// diagnostic-firing fixture, so they are exempted from the §8.5 fixture-proof
// invariant explicitly here rather than via an accidental test-title match.
// Adding an entry is a deliberate, reviewed decision — see each reason.
const PERMANENTLY_INERT_CODES = new Map([
  [
    'W024',
    'readStateHeadFreshness requires a git-log shell-out, forbidden ambient I/O for Rule.check ' +
      '(§8.1 rule 1) — the real check runs in cmdValidateHealth itself, outside the rule table ' +
      '(src/verify.cts). This rule-table entry is a permanent no-op by design, not a fixture gap.',
  ],
]);

/**
 * Load the compiled health-diagnostic module. Throws a clear ExitError
 * (not a raw MODULE_NOT_FOUND) if `npm run build:lib` has not run.
 */
function loadCompiledModule(compiledPath = COMPILED_MODULE_PATH) {
  if (!fs.existsSync(compiledPath)) {
    throw new ExitError(
      2,
      `lint-health-diagnostic-rule-table: compiled artifact not found at ${COMPILED_MODULE_REL}.\n` +
        'Run `npm run build:lib` first.',
    );
  }
  return require(compiledPath);
}

/**
 * §8.2 rule 1 — 1:1 code invariant: every rule.code is unique, and every
 * rule's severity is a member of SEVERITY's values.
 *
 * @param {Array<{code: string, severity: string}>} rules
 * @param {Record<string, string>} severity  SEVERITY export (code -> value)
 * @returns {{duplicates: Array<{code: string, count: number}>, badSeverities: Array<{code: string, severity: unknown}>}}
 */
function checkOneToOneInvariant(rules, severity) {
  const severityValues = new Set(Object.values(severity));
  const counts = new Map();
  const badSeverities = [];

  for (const rule of rules) {
    counts.set(rule.code, (counts.get(rule.code) || 0) + 1);
    if (!severityValues.has(rule.severity)) {
      badSeverities.push({ code: rule.code, severity: rule.severity });
    }
  }

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([code, count]) => ({ code, count }));

  return { duplicates, badSeverities };
}

/**
 * Extracts every `describe(`/`test(`/`it(` block title found in `text`.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractTitledBlocks(text) {
  const titles = [];
  TITLED_BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = TITLED_BLOCK_RE.exec(text)) !== null) {
    titles.push(match[3]);
  }
  return titles;
}

/**
 * True iff `code` appears verbatim, as a whole token, inside at least one of
 * `titles`. Whole-token match guards against a shorter code accidentally
 * substring-matching inside an unrelated longer token.
 *
 * @param {string} code
 * @param {string[]} titles
 */
function codeAppearsInTitle(code, titles) {
  const codeRe = new RegExp(`(?:^|[^A-Za-z0-9])${code}(?:$|[^A-Za-z0-9])`);
  return titles.some((title) => codeRe.test(`|${title}|`));
}

/**
 * Locates every health-diagnostic test file this guard scans for §8.5
 * fixture-proof coverage.
 *
 * @param {string} repoRoot
 * @returns {string[]} absolute paths, sorted
 */
function findHealthDiagnosticTestFiles(repoRoot = REPO_ROOT) {
  const groupDir = path.join(repoRoot, 'tests', 'health-diagnostic-rules');
  const files = [];
  if (fs.existsSync(groupDir)) {
    for (const entry of fs.readdirSync(groupDir)) {
      if (entry.endsWith('.test.cjs')) {
        files.push(path.join(groupDir, entry));
      }
    }
  }
  const skeletonTestFile = path.join(repoRoot, 'tests', 'health-diagnostic.test.cjs');
  if (fs.existsSync(skeletonTestFile)) {
    files.push(skeletonTestFile);
  }
  return files.sort();
}

/**
 * §8.5 — fixture-proof invariant: for every code in `rules`, confirm at
 * least one test file in `testFiles` has a `describe(`/`test(`/`it(` block
 * whose title names that exact code — UNLESS the code is listed in
 * `PERMANENTLY_INERT_CODES`, in which case it is reported separately as
 * `exempted` (visibly, not folded into "covered") and never fails the guard
 * regardless of test coverage.
 *
 * @param {Array<{code: string}>} rules
 * @param {string[]} testFiles  absolute paths to *.test.cjs files to scan
 * @param {Map<string, string>} inertCodes  PERMANENTLY_INERT_CODES (injectable for tests)
 * @returns {{uncovered: string[], exempted: string[], testFilesScanned: string[]}}
 */
function checkFixtureProofInvariant(rules, testFiles, inertCodes = PERMANENTLY_INERT_CODES) {
  const allTitles = [];
  for (const file of testFiles) {
    const text = fs.readFileSync(file, 'utf8');
    allTitles.push(...extractTitledBlocks(text));
  }

  const uncovered = [];
  const exempted = [];
  for (const rule of rules) {
    if (inertCodes.has(rule.code)) {
      exempted.push(rule.code);
      continue;
    }
    if (!codeAppearsInTitle(rule.code, allTitles)) {
      uncovered.push(rule.code);
    }
  }

  return { uncovered, exempted, testFilesScanned: testFiles };
}

function formatRepoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function main() {
  const { RULES, CONSISTENCY_RULES, SEVERITY } = loadCompiledModule();

  const { duplicates, badSeverities } = checkOneToOneInvariant(RULES, SEVERITY);

  const testFiles = findHealthDiagnosticTestFiles(REPO_ROOT);
  const { uncovered, exempted } = checkFixtureProofInvariant(RULES, testFiles);

  // ─── C0NN check pass (Phase 12, #3310) — separate from the W/E/I pass
  // above, own reporting section, does NOT re-check W006/W007's fixture
  // proof (already covered above against the same `Rule` objects).
  const consistencyNewRules = CONSISTENCY_RULES.filter((r) => CONSISTENCY_CODE_PREFIX_RE.test(r.code));
  const { duplicates: consistencyDuplicates, badSeverities: consistencyBadSeverities } = checkOneToOneInvariant(
    consistencyNewRules,
    SEVERITY,
  );
  const consistencyTestFiles = fs.existsSync(CONSISTENCY_TEST_FILE) ? [CONSISTENCY_TEST_FILE] : [];
  const { uncovered: consistencyUncovered } = checkFixtureProofInvariant(
    consistencyNewRules,
    consistencyTestFiles,
    new Map(),
  );

  // ─── S0NN check pass (Phase 12, #3310) — separate from the W/E/I and C0NN
  // passes above, own reporting section. Hardcoded code list (see the
  // STATE_VALIDATE_CODES comment above) rather than read from a Rule[] array.
  const stateValidateTestFiles = fs.existsSync(STATE_VALIDATE_TEST_FILE) ? [STATE_VALIDATE_TEST_FILE] : [];
  const { uncovered: stateValidateUncovered } = checkFixtureProofInvariant(
    STATE_VALIDATE_CODES.map((code) => ({ code })),
    stateValidateTestFiles,
    new Map(),
  );

  const problems = [];

  if (duplicates.length > 0) {
    const list = duplicates.map((d) => `  ${d.code} (${d.count} occurrences)`).join('\n');
    problems.push(
      `§8.2 rule 1 violated: ${duplicates.length} duplicated rule code(s) in RULES ` +
        `(${COMPILED_MODULE_REL}):\n${list}\n` +
        '  remedy: codes are append-only and 1:1 with a single Rule — rename or remove the duplicate.',
    );
  }

  if (badSeverities.length > 0) {
    const list = badSeverities
      .map((b) => `  ${b.code}: severity=${JSON.stringify(b.severity)}`)
      .join('\n');
    problems.push(
      `§8.2 rule 3 violated: ${badSeverities.length} rule(s) with a severity not in SEVERITY's values:\n${list}\n` +
        '  remedy: severity is a property of the RULE — set it to SEVERITY.ERROR/WARNING/INFO.',
    );
  }

  if (uncovered.length > 0) {
    const scannedList = testFiles.map(formatRepoRelative).join('\n  ');
    problems.push(
      `§8.5 violated: ${uncovered.length} rule code(s) with no describe()/test() block naming them ` +
        `(a comment or bare string mention does not count):\n  ${uncovered.join(', ')}\n\n` +
        `  Searched these test files:\n  ${scannedList}\n\n` +
        '  remedy: add or extend a describe()/test() title in the matching ' +
        'tests/health-diagnostic-rules/<group>.test.cjs file so the block title ' +
        `names the code verbatim (e.g. describe('${uncovered[0]} — ...', () => { ... })), ` +
        'and drive the rule to fire against a real fixture built via createTempDir() + buildPlanningSnapshot() ' +
        '(see tests/health-diagnostic-rules/root-existence.test.cjs).',
    );
  }

  if (consistencyDuplicates.length > 0) {
    const list = consistencyDuplicates.map((d) => `  ${d.code} (${d.count} occurrences)`).join('\n');
    problems.push(
      `§8.2 rule 1 violated (C0NN namespace): ${consistencyDuplicates.length} duplicated rule code(s) in ` +
        `CONSISTENCY_RULES (${COMPILED_MODULE_REL}):\n${list}\n` +
        '  remedy: codes are append-only and 1:1 with a single Rule — rename or remove the duplicate.',
    );
  }

  if (consistencyBadSeverities.length > 0) {
    const list = consistencyBadSeverities
      .map((b) => `  ${b.code}: severity=${JSON.stringify(b.severity)}`)
      .join('\n');
    problems.push(
      `§8.2 rule 3 violated (C0NN namespace): ${consistencyBadSeverities.length} rule(s) with a severity not ` +
        `in SEVERITY's values:\n${list}\n` +
        '  remedy: severity is a property of the RULE — set it to SEVERITY.ERROR/WARNING/INFO.',
    );
  }

  if (consistencyUncovered.length > 0) {
    problems.push(
      `§8.5 violated (C0NN namespace): ${consistencyUncovered.length} rule code(s) with no describe()/test() ` +
        `block naming them (a comment or bare string mention does not count):\n  ${consistencyUncovered.join(', ')}\n\n` +
        `  Searched: ${formatRepoRelative(CONSISTENCY_TEST_FILE)}` +
        (consistencyTestFiles.length === 0 ? ' (file not found)' : '') +
        '\n\n  remedy: add or extend a describe()/test() title in tests/health-diagnostic-rules/consistency.test.cjs ' +
        `so the block title names the code verbatim (e.g. describe('${consistencyUncovered[0]} — ...', () => { ... })), ` +
        'and drive the rule to fire against a real fixture built via createTempDir() + buildPlanningSnapshot().',
    );
  }

  if (stateValidateUncovered.length > 0) {
    problems.push(
      `§8.5 violated (S0NN namespace): ${stateValidateUncovered.length} code(s) with no describe()/test() ` +
        `block naming them (a comment or bare string mention does not count):\n  ${stateValidateUncovered.join(', ')}\n\n` +
        `  Searched: ${formatRepoRelative(STATE_VALIDATE_TEST_FILE)}` +
        (stateValidateTestFiles.length === 0 ? ' (file not found)' : '') +
        '\n\n  remedy: add or extend a describe()/test() title in tests/state.test.cjs ' +
        `so the block title names the code verbatim (e.g. test('${stateValidateUncovered[0]}: ...', () => { ... })), ` +
        'mirroring the existing `#3310 state validate — S0NN coded diagnostics` describe block.',
    );
  }

  if (problems.length > 0) {
    throw new ExitError(1, `${problems.join('\n\n')}\n`);
  }

  const coveredCount = RULES.length - exempted.length;
  const exemptedDetail = exempted
    .map((code) => `${code} (${PERMANENTLY_INERT_CODES.get(code)})`)
    .join('; ');

  console.log(
    `lint-health-diagnostic-rule-table: PASS — ${RULES.length} rule code(s): ${coveredCount} covered by a ` +
      `real fixture, ${exempted.length} exempted across ${testFiles.length} test file(s).` +
      (exempted.length > 0 ? `\n  Exempted: ${exemptedDetail}` : ''),
  );
  console.log(
    `lint-health-diagnostic-rule-table: PASS (C0NN namespace) — ${consistencyNewRules.length} new rule code(s) ` +
      `(${consistencyNewRules.map((r) => r.code).join(', ')}), all fixture-covered in ` +
      `${formatRepoRelative(CONSISTENCY_TEST_FILE)}.`,
  );
  console.log(
    `lint-health-diagnostic-rule-table: PASS (S0NN namespace) — ${STATE_VALIDATE_CODES.length} code(s) ` +
      `(${STATE_VALIDATE_CODES.join(', ')}), all fixture-covered in ` +
      `${formatRepoRelative(STATE_VALIDATE_TEST_FILE)}.`,
  );
}

runMain(main);

module.exports = {
  loadCompiledModule,
  checkOneToOneInvariant,
  extractTitledBlocks,
  codeAppearsInTitle,
  findHealthDiagnosticTestFiles,
  checkFixtureProofInvariant,
  PERMANENTLY_INERT_CODES,
  COMPILED_MODULE_PATH,
  TEST_GROUP_DIR,
  SKELETON_TEST_FILE,
  CONSISTENCY_TEST_FILE,
  STATE_VALIDATE_TEST_FILE,
  STATE_VALIDATE_CODES,
  discoverStateValidateCodes,
};
