#!/usr/bin/env node
'use strict';

/**
 * lint-resolution-provenance.cjs — CI guard for Resolution Provenance contracts.
 *
 * ## Purpose (ADR-1411 P4 / #1417)
 *
 * This is a REGRESSION-LOCK and REGISTRATION RATCHET, NOT a universal static
 * detector (which is intractable given false positives from config-reading
 * helpers that don't consume a `reason`).
 *
 * The guard maintains a REGISTRY of config-interpreting read verbs that MUST
 * carry provenance — each entry names the verb, its source file, and its test
 * file. For every registered verb, the guard asserts that its test file
 * contains BOTH a `configured_empty` assertion AND a `not_configured`
 * assertion, proving that the configured-empty-vs-not-configured contract is
 * explicitly tested (not silently open-to-defaults).
 *
 * ## Registration protocol
 *
 * When adding a NEW config-interpreting read verb:
 *   1. Add an entry to REGISTRY below: { verb, sourceFile, testFile }.
 *   2. Add a `configured_empty` test and a `not_configured` test to testFile.
 *   3. If the test coverage cannot land in the same PR, add the verb to
 *      scripts/lint-resolution-provenance.allowlist.json to grandfather it —
 *      but the allowlist MUST shrink over time (stale entries fail).
 *
 * See docs/adr/1411-resolution-provenance.md and #1417.
 */

const fs = require('fs');
const path = require('path');
const { assertWithinAllowlist } = require('./lib/allowlist-ratchet.cjs');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');
const ALLOWLIST_PATH = path.join(__dirname, 'lint-resolution-provenance.allowlist.json');

/**
 * Registry of config-interpreting read verbs that must carry provenance.
 * Each entry: { verb, sourceFile, testFile }
 *
 * - verb:       Short stable name for this verb (used in error messages and the
 *               allowlist).
 * - sourceFile: Path (relative to ROOT) to the source implementation.
 * - testFile:   Path (relative to ROOT) to the test file that MUST contain
 *               both a `configured_empty` assertion and a `not_configured`
 *               assertion.
 *
 * Seed: agent-skills (P2/P3 fix, #1415/#1416) is the founding member.
 */
const REGISTRY = [
  {
    verb: 'agent-skills',
    sourceFile: 'src/init.cts',
    testFile: 'tests/agent-skills.test.cjs',
  },
  {
    // Registered by #1880 (ADR-1411 amendment "corrupt is not absent"). Until
    // this entry existed the config-loader seam carried the provenance contract
    // with nothing guarding it, so a regression that collapsed configured_empty
    // back into not_configured would have shipped silently.
    verb: 'config-loader',
    sourceFile: 'src/config-loader.cts',
    testFile: 'tests/config-loader.test.cjs',
  },
];

// Markers that MUST appear in every registered verb's test file.
const MARKER_CONFIGURED_EMPTY = 'configured_empty';
const MARKER_NOT_CONFIGURED = 'not_configured';

/**
 * Pure check logic — factored out for unit testing without I/O.
 *
 * @param {object} opts
 * @param {Array<{verb: string, sourceFile: string, testFile: string}>} opts.registry
 *   The REGISTRY to check (or an injected subset for tests).
 * @param {string[]} opts.allowlist
 *   Array of verb names to grandfather (stale entries fail).
 * @param {function(string): string} opts.readFile
 *   Reads a file path and returns its content.  Injected for testability;
 *   callers pass `(p) => fs.readFileSync(p, 'utf8')`.
 * @param {function(string): void} opts.fail
 *   Callback invoked with a descriptive failure message.
 * @returns {{ ok: boolean }}
 */
function checkRegistry({ registry, allowlist, readFile, fail }) {
  const allowlistSet = new Set(allowlist);
  const offenders = []; // verbs that ARE failing (for ratchet: stale check)
  let anyFail = false;

  for (const entry of registry) {
    const { verb, testFile } = entry;
    const resolvedTestFile = path.isAbsolute(testFile) ? testFile : path.join(ROOT, testFile);

    // Grandfathered? Check markers anyway to detect when it's been fixed.
    let content;
    try {
      content = readFile(resolvedTestFile);
    } catch (err) {
      fail(
        `[resolution-provenance] Cannot read test file for verb "${verb}" (${testFile}): ${err.message}\n` +
          `  Register the verb's test file correctly, or remove the registry entry.`
      );
      anyFail = true;
      offenders.push(verb);
      continue;
    }

    const hasConfiguredEmpty = content.includes(MARKER_CONFIGURED_EMPTY);
    const hasNotConfigured = content.includes(MARKER_NOT_CONFIGURED);

    if (!hasConfiguredEmpty || !hasNotConfigured) {
      offenders.push(verb);

      if (allowlistSet.has(verb)) {
        // Grandfathered — tolerate but don't report.
        continue;
      }

      const missing = [];
      if (!hasConfiguredEmpty) missing.push(`\`configured_empty\``);
      if (!hasNotConfigured) missing.push(`\`not_configured\``);

      fail(
        `[resolution-provenance] verb "${verb}" (${testFile}) is missing contract test marker(s):\n` +
          `  Missing: ${missing.join(', ')}\n` +
          `  Each registered config-interpreting read verb must have both a\n` +
          `  \`configured_empty\` assertion and a \`not_configured\` assertion in its\n` +
          `  test file to prove the configured-empty-vs-not-configured contract is\n` +
          `  tested (ADR-1411 P4 / #1417).\n` +
          `  Add the missing test(s) or grandfather the verb in\n` +
          `  scripts/lint-resolution-provenance.allowlist.json.`
      );
      anyFail = true;
    }
  }

  // Ratchet: stale allowlist entries (verb is compliant but still grandfathered)
  // must be pruned so the allowlist only ever shrinks.
  const offenderSet = new Set(offenders);
  const staleEntries = [];
  for (const v of allowlistSet) {
    if (!offenderSet.has(v)) {
      staleEntries.push(v);
    }
  }

  // Also verify stale entries via assertWithinAllowlist for consistent messaging.
  const ratchetFailures = [];
  assertWithinAllowlist({
    label: 'resolution-provenance',
    current: offenders,
    known: allowlist,
    fail: (msg) => ratchetFailures.push(msg),
    pruneHint: 'edit scripts/lint-resolution-provenance.allowlist.json',
  });

  // Only report stale entries from the ratchet (novel offenders are already
  // reported above with more actionable messages).
  if (staleEntries.length > 0) {
    for (const msg of ratchetFailures) {
      // Only surface the stale-entry message (it contains "stale" or "no longer").
      if (msg.includes('stale') || msg.includes('no longer')) {
        fail(msg);
        anyFail = true;
      }
    }
  }

  return { ok: !anyFail };
}

function main() {
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));

  const failures = [];
  const { ok } = checkRegistry({
    registry: REGISTRY,
    allowlist,
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
    fail: (msg) => failures.push(msg),
  });

  if (!ok) {
    for (const msg of failures) process.stderr.write(`${msg}\n`);
    throw new ExitError(1);
  }

  console.log(
    `ok lint-resolution-provenance: ${REGISTRY.length} registered verb(s), all carry configured_empty + not_configured contract tests`
  );
}

module.exports = { checkRegistry, REGISTRY };

// Only run the CLI check when executed directly, not when imported by tests
// (keeps the unit tests hermetic — importing checkRegistry must not run main).
if (require.main === module) runMain(main);
