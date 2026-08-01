#!/usr/bin/env node
'use strict';

/**
 * scripts/gen-registry.cjs — generates docs/registries/capability-registry.md,
 * docs/registries/eos-registry.md, and docs/registries/reviewer-registry.md
 * from their corresponding source JSON, via registry-schema.cjs#renderMarkdown.
 * Issue #2182 (capability/eos); issue #2904 (reviewer).
 *
 * eos.json and reviewers.json are both OPTIONAL sources (`SOURCES[].optional`)
 * — an absent one is skipped silently. capabilities.json is the primary
 * source and is never optional.
 *
 * NOT to be confused with `scripts/gen-capability-registry.cjs`: that script
 * generates the RUNTIME capability manifest consumed by the host at runtime
 * (`gsd-core/bin/lib/capability-registry.cjs`, built from every
 * `capabilities/<id>/capability.json` declaration). THIS script instead
 * generates the human-facing DOCUMENTATION catalog pages
 * (`docs/registries/*.md`) from the third-party discoverability registry
 * source JSON (`docs/registries/{capabilities,eos}.json`). The two pipelines
 * are independent — do not conflate them.
 *
 * Usage:
 *   node scripts/gen-registry.cjs              # print rendered markdown(s) to stdout
 *   node scripts/gen-registry.cjs --write      # write the *-registry.md file(s)
 *   node scripts/gen-registry.cjs --check      # exit 1 if a committed *-registry.md is stale
 *
 * Root is resolved from process.cwd() (not __dirname) — mirrors
 * scripts/validate-registry.cjs so both are drivable as subprocesses against
 * isolated temp-fixture directories via `cwd`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { renderMarkdown } = require('./registry-schema.cjs');

const SOURCES = [
  { type: 'capability', jsonFile: 'capabilities.json', mdFile: 'capability-registry.md' },
  { type: 'eos', jsonFile: 'eos.json', mdFile: 'eos-registry.md', optional: true },
  { type: 'reviewer', jsonFile: 'reviewers.json', mdFile: 'reviewer-registry.md', optional: true },
];

/**
 * The generator always writes LF; a Windows checkout (autocrlf) may present
 * committed files with CRLF. Normalize before comparing so `--check` only
 * fails on real content drift, not checkout-introduced line-ending noise.
 *
 * @param {string} content
 * @returns {string}
 */
function normalizeLineEndings(content) {
  return content.replace(/\r/g, '');
}

function getRegistriesDir() {
  return path.join(process.cwd(), 'docs', 'registries');
}

/**
 * Render the markdown for a single registry type from its committed source
 * JSON.
 *
 * Optionality is a per-source data flag (`SOURCES[].optional`), not a
 * hardcoded type literal: `eos.json` (pre-PR2) and `reviewers.json` (issue
 * #2904) are both optional — an absent source JSON returns null and callers
 * treat that as "nothing to do". `capabilities.json` is still the primary
 * registry source and is never optional: a missing `capabilities.json` is
 * ALWAYS an error (never a silent "up to date" pass), mirroring the same
 * `optional` flag in `scripts/validate-registry.cjs`
 * (`optional && !exists → continue`).
 *
 * @param {'capability'|'eos'|'reviewer'} type
 * @returns {string|null}
 */
function renderFor(type) {
  const source = SOURCES.find((s) => s.type === type);
  if (!source) throw new Error(`gen-registry: unknown registry type "${type}"`);

  const jsonPath = path.join(getRegistriesDir(), source.jsonFile);
  if (!fs.existsSync(jsonPath)) {
    if (source.optional) return null;
    throw new ExitError(
      1,
      `${source.jsonFile} does not exist at ${jsonPath}. Run:\n  node scripts/gen-registry.cjs --write\n(after adding docs/registries/${source.jsonFile})`,
    );
  }

  // A malformed source JSON must surface as an actionable CLI error, not an
  // unhandled SyntaxError with a raw Node stack trace — mirrors
  // scripts/validate-registry.cjs#validateFile's try/catch around JSON.parse.
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    throw new ExitError(1, `${source.jsonFile} is not valid JSON at ${jsonPath}: ${err.message}`);
  }

  // Mirrors validate-registry.cjs's explicit non-array rejection: a source
  // JSON that parses to a non-array (object, string, etc.) would otherwise
  // throw an opaque TypeError from `[...entries].sort()` in renderMarkdown,
  // or silently mis-render for an iterable-but-wrong-shape value like a string.
  if (!Array.isArray(entries)) {
    throw new ExitError(1, `${source.jsonFile} must be a JSON array of entries`);
  }

  return renderMarkdown(entries, { type, sourceFile: source.jsonFile });
}

function main() {
  const [, , flag] = process.argv;
  const registriesDir = getRegistriesDir();
  let anyDrift = false;

  for (const { type, mdFile } of SOURCES) {
    const rendered = renderFor(type);
    if (rendered === null) continue; // source JSON absent and optional (eos.json before PR2 / reviewers.json)

    const mdPath = path.join(registriesDir, mdFile);

    if (flag === '--check') {
      if (!fs.existsSync(mdPath)) {
        process.stderr.write(`${mdFile} does not exist. Run:\n  node scripts/gen-registry.cjs --write\n`);
        anyDrift = true;
        continue;
      }
      const committed = fs.readFileSync(mdPath, 'utf8');
      if (normalizeLineEndings(committed) !== normalizeLineEndings(rendered)) {
        process.stderr.write(`${mdFile} is stale. Run:\n  node scripts/gen-registry.cjs --write\n`);
        anyDrift = true;
      }
    } else if (flag === '--write') {
      fs.mkdirSync(registriesDir, { recursive: true });
      fs.writeFileSync(mdPath, rendered);
      process.stdout.write(`Wrote ${mdPath}\n`);
    } else {
      process.stdout.write(rendered + '\n');
    }
  }

  if (flag === '--check') {
    if (anyDrift) throw new ExitError(1, 'registry markdown is stale');
    process.stdout.write('docs/registries/*.md are up to date.\n');
  }

  return 0;
}

if (require.main === module) runMain(main);

module.exports = { main, renderFor, SOURCES, normalizeLineEndings };
