'use strict';

/**
 * fixtures/index.cjs — resolves `@dir/name` scenario refs to fixture file
 * contents.
 *
 * WHY THIS EXISTS
 * ────────────────
 * Scenario JSON (`tests/qa/scenario.cjs`) writes agent-authored artifacts by
 * reference (`"@project/minimal"`) rather than inlining markdown bodies, so
 * scenario files stay short and fixtures stay reviewable in one place. A ref
 * that fails to resolve MUST be loud: a scenario step that silently wrote an
 * empty artifact would make the rest of the walk vacuously green (the engine
 * would be reacting to an empty PROJECT.md and nobody would know). This
 * module therefore throws — naming both the bad ref and the full list of
 * refs that DO resolve — rather than returning `''` or `undefined` on a miss.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Directory this module lives in — every fixture path is resolved relative to it. */
const FIXTURES_ROOT = __dirname;

/**
 * Map of ref (`"dir/name"`, no leading `@`) -> absolute file path.
 * Built once at module load by scanning the fixture subdirectories.
 *
 * @returns {Map<string, string>}
 */
function buildRefMap() {
  /** @type {Map<string, string>} */
  const map = new Map();
  const entries = fs.readdirSync(FIXTURES_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const dirPath = path.join(FIXTURES_ROOT, dirName);
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      const baseName = file.name.slice(0, -'.md'.length);
      map.set(`${dirName}/${baseName}`, path.join(dirPath, file.name));
    }
  }
  return map;
}

const REF_MAP = buildRefMap();

/**
 * Resolve a `@dir/name` ref to its fixture file's UTF-8 contents.
 *
 * @param {string} ref e.g. `"@project/minimal"` (leading `@` optional).
 * @returns {string} file contents.
 * @throws {Error} when `ref` does not resolve — names the ref AND lists every
 *   available ref, so a missing/renamed fixture fails loudly instead of a
 *   scenario step silently writing an empty artifact.
 */
function resolveRef(ref) {
  if (typeof ref !== 'string' || ref === '') {
    throw new Error(`resolveRef: ref must be a non-empty string, got ${JSON.stringify(ref)}`);
  }
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  const filePath = REF_MAP.get(key);
  if (!filePath) {
    const available = [...REF_MAP.keys()].sort().join(', ');
    throw new Error(`resolveRef: unknown fixture ref "${ref}" (available refs: ${available})`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * @returns {string[]} every resolvable ref, in `@dir/name` form, sorted.
 */
function listRefs() {
  return [...REF_MAP.keys()].map((key) => `@${key}`).sort();
}

module.exports = { resolveRef, listRefs };
