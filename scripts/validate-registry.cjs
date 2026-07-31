#!/usr/bin/env node
'use strict';

/**
 * scripts/validate-registry.cjs — CLI validator for the third-party
 * discoverability catalogs (issue #2182, plus #2904):
 *
 *   - docs/registries/capabilities.json  ("GSD Community Capability Registry")
 *   - docs/registries/eos.json           ("GSD EoS Registry", PR2 — optional
 *     until that JSON file ships)
 *   - docs/registries/reviewers.json     ("GSD Reviewer Lane Registry",
 *     issue #2904 — optional until that JSON file ships)
 *
 * Validates each source's JSON array against the closed schema in
 * scripts/registry-schema.cjs (validateEntries). Human-readable errors go to
 * stderr; `--json` additionally prints a structured verdict to stdout.
 *
 * Usage:
 *   node scripts/validate-registry.cjs           # human-readable report
 *   node scripts/validate-registry.cjs --json    # structured JSON verdict
 *
 * Exit codes:
 *   0  every present source's entries are all valid
 *   1  one or more entries failed validation (or a source's JSON is malformed)
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { validateEntries } = require('./registry-schema.cjs');

// Resolved relative to process.cwd() (not __dirname) so the CLI validates
// whichever project it is invoked from — this is what lets tests drive it as
// a subprocess against isolated temp-fixture directories via `cwd`.
const SOURCES = [
  { file: 'capabilities.json', type: 'capability' },
  { file: 'eos.json', type: 'eos', optional: true },
  { file: 'reviewers.json', type: 'reviewer', optional: true },
];

/**
 * Load + validate a single registry JSON file.
 *
 * @param {string} jsonPath  absolute path to the registry JSON file
 * @param {'capability'|'eos'|'reviewer'} type
 * @returns {{ok: boolean, errors: Array<{index: number, id?: string, field: string, reason: string}>}}
 */
function validateFile(jsonPath, type) {
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      errors: [{ index: -1, field: '<file>', reason: `could not read ${jsonPath}: ${err.message}` }],
    };
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [{ index: -1, field: '<file>', reason: `JSON parse error in ${jsonPath}: ${err.message}` }],
    };
  }

  if (!Array.isArray(entries)) {
    return {
      ok: false,
      errors: [{ index: -1, field: '<file>', reason: `${jsonPath} must be a JSON array of entries` }],
    };
  }

  return validateEntries(entries, { type });
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const registriesDir = path.join(process.cwd(), 'docs', 'registries');

  const results = [];
  let anyFailed = false;

  for (const { file, type, optional } of SOURCES) {
    const jsonPath = path.join(registriesDir, file);
    // eos.json (pre-PR2) and reviewers.json (issue #2904) are optional until
    // their source JSON ships — skip silently when absent.
    if (optional && !fs.existsSync(jsonPath)) continue;

    const verdict = validateFile(jsonPath, type);
    results.push({ file, type, ok: verdict.ok, errors: verdict.errors });
    if (!verdict.ok) anyFailed = true;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: !anyFailed, results }, null, 2) + '\n');
  } else if (anyFailed) {
    process.stderr.write('\nERROR validate-registry: one or more entries failed validation\n');
    for (const result of results) {
      if (result.ok) continue;
      process.stderr.write(`\n${result.file}:\n`);
      for (const e of result.errors) {
        const idPart = e.id ? ` (id: ${e.id})` : '';
        process.stderr.write(`  entry[${e.index}]${idPart} field "${e.field}": ${e.reason}\n`);
      }
    }
    process.stderr.write('\n');
  } else {
    process.stdout.write('ok validate-registry: all entries valid\n');
  }

  if (anyFailed) throw new ExitError(1, 'registry validation failed');
  return 0;
}

if (require.main === module) runMain(main);

module.exports = { main, validateFile, SOURCES };
