#!/usr/bin/env node
'use strict';

/**
 * lint-default-flip-documentation.cjs — DEFECT.DEFAULT-FLIP-DOCUMENTATION
 * (CONTEXT.md).
 *
 * ## Why
 *
 * A PR flips a config default but doesn't call out the migration semantics
 * (when the new default takes effect; existing configs vs new configs; what
 * the opt-back-in looks like — #3309, the v2 default flip from mid-flight to
 * end-of-phase).
 *
 * ## Scope (deliberately narrower than the full DEFECT.detect clause)
 *
 * The DEFECT text names two surfaces: `CONFIG_DEFAULTS` and
 * `buildNewProjectConfig`. This check covers ONLY the single-source-of-truth
 * defaults manifest, `gsd-core/bin/shared/config-defaults.manifest.json`
 * (what `CONFIG_DEFAULTS` in `src/configuration.cts` / `src/config.cts`
 * actually loads at runtime) — because it is pure JSON, a resolved
 * key→value-map diff between base and head is trivially reliable: no line
 * movement, reordering, or refactor can ever produce a false "value changed"
 * verdict, only an actual value change can.
 *
 * `buildNewProjectConfig`'s `hardcoded` object literal in `src/config.cts`
 * is DELIBERATELY OUT OF SCOPE here. It mixes literal values with
 * environment-derived branches (`hasBraveSearch`, etc.) and spreads of
 * `CONFIG_DEFAULTS.*` — there is no reliable way to compute its *resolved*
 * value map from source text alone without executing the compiled module at
 * both refs, and a line/AST-level diff of that literal would inherit exactly
 * the false-positive risk (a harmless refactor that moves or restructures
 * the literal reads as a "flip") this check exists to avoid. Per the audit's
 * own risk callout, a noisy check here is worse than no check — the
 * `buildNewProjectConfig` half of the DEFECT stays prose-only.
 *
 * ## What this checks
 *
 * If any *value* differs between the base and head resolved manifest
 * key→value maps (additions/removals alone don't count as a "flip" — the
 * symptom is specifically about an EXISTING default changing), fail unless
 * the PR body contains a `## Breaking Changes` (or `# Breaking Changes`)
 * heading.
 *
 * Needs a PR event payload (`GITHUB_EVENT_PATH`) to read the PR body — this
 * is a dedicated-workflow check (like `lint-canary-version-leak.cjs`), not a
 * `lint:ci` member, since a local/push run has no PR body to check against.
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join('gsd-core', 'bin', 'shared', 'config-defaults.manifest.json');
const BREAKING_CHANGES_RE = /^#{1,6}\s*Breaking Changes\b/im;

/**
 * Pure: flatten a nested plain-object JSON value into dot-path
 * `{ "a.b.c": value }` leaves. Arrays and primitives are leaves (compared by
 * JSON.stringify equality, never recursed into) so array reordering reads as
 * one value change, not N.
 * @param {unknown} value
 * @param {string} prefix
 * @param {Record<string, unknown>} out
 * @returns {Record<string, unknown>}
 */
function flatten(value, prefix = '', out = {}) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value)) {
      flatten(v, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out[prefix] = value;
  }
  return out;
}

/**
 * Pure: given two resolved (already-flattened) key→value maps, return the
 * keys present in BOTH whose value differs. Additions/removals are NOT
 * "flips" — a brand-new default has no prior behavior to contradict.
 * @param {Record<string, unknown>} baseMap
 * @param {Record<string, unknown>} headMap
 * @returns {{ key: string, from: unknown, to: unknown }[]}
 */
function findDefaultValueChanges(baseMap, headMap) {
  const changes = [];
  for (const key of Object.keys(baseMap)) {
    if (!Object.prototype.hasOwnProperty.call(headMap, key)) continue;
    if (JSON.stringify(baseMap[key]) !== JSON.stringify(headMap[key])) {
      changes.push({ key, from: baseMap[key], to: headMap[key] });
    }
  }
  return changes;
}

/**
 * Pure verdict: given the detected default-value changes and the PR body,
 * decide pass/fail.
 * @param {{ key: string, from: unknown, to: unknown }[]} changes
 * @param {string} prBody
 * @returns {{ ok: boolean, changes: object[] }}
 */
function evaluateDefaultFlipDoc(changes, prBody) {
  if (changes.length === 0) return { ok: true, changes: [] };
  if (BREAKING_CHANGES_RE.test(prBody || '')) return { ok: true, changes };
  return { ok: false, changes };
}

/**
 * Read and JSON.parse the manifest at a given git ref. Returns `{}` when the
 * file doesn't exist at that ref (new file, or ref predates it) — that is
 * not a "flip", it's an addition, and is silently excluded by
 * findDefaultValueChanges's both-sides-present requirement anyway.
 * @param {string} root
 * @param {string} ref
 * @returns {Record<string, unknown>}
 */
function readManifestAtRef(root, ref) {
  let raw;
  try {
    raw = cp.execFileSync('git', ['show', `${ref}:${MANIFEST_PATH.split(path.sep).join('/')}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
    });
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ExitError(2, `lint-default-flip-documentation: ${ref}:${MANIFEST_PATH} is not valid JSON: ${e.message}`);
  }
}

function readPrBody() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    return typeof event.pull_request?.body === 'string' ? event.pull_request.body : '';
  } catch {
    return null;
  }
}

function main() {
  const prBody = readPrBody();
  if (prBody === null) {
    console.log('lint-default-flip-documentation: no PR event payload (not a pull_request run), skipping');
    return;
  }

  const baseRef = `origin/${process.env.GITHUB_BASE_REF || 'next'}`; // #2988
  const baseMap = flatten(readManifestAtRef(ROOT, baseRef));
  const headMap = flatten(readManifestAtRef(ROOT, 'HEAD'));
  const changes = findDefaultValueChanges(baseMap, headMap);
  const verdict = evaluateDefaultFlipDoc(changes, prBody);

  if (!verdict.ok) {
    const detail = verdict.changes
      .map((c) => `  ${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
      .join('\n');
    throw new ExitError(
      1,
      'lint-default-flip-documentation: this PR changes an existing default value in\n'
        + 'config-defaults.manifest.json (DEFECT.DEFAULT-FLIP-DOCUMENTATION) but the PR body has no\n'
        + '`## Breaking Changes` section. Add one covering: (a) when the new default takes effect\n'
        + '(config-set, fresh project, regenerated config), (b) the opt-back-in command\n'
        + '(`gsd config-set <key> <old-value>`), (c) effect on in-flight artifacts. Changed default(s):\n'
        + detail,
    );
  }
  console.log(
    changes.length === 0
      ? 'ok lint-default-flip-documentation: no default value changed'
      : `ok lint-default-flip-documentation: ${changes.length} default value change(s), PR body documents Breaking Changes`,
  );
}

module.exports = {
  flatten,
  findDefaultValueChanges,
  evaluateDefaultFlipDoc,
  readManifestAtRef,
  MANIFEST_PATH,
  BREAKING_CHANGES_RE,
};

if (require.main === module) runMain(main);
