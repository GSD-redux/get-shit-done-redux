#!/usr/bin/env node
'use strict';

/**
 * lint-emitted-drift-ack — refuse to merge a broken emitted-drift acknowledgment (#2789).
 *
 * The ack document is read from TWO sides: the working tree (`readAckFile`) and the BASE
 * REF (`readAckFileAtRef`), because an entry already present at the base is spent and may
 * no longer clear a delta. The base-side read fails LOUDLY on a document it cannot parse
 * — it has to, since silently inheriting nothing would leave every entry able to consume
 * a delta, which is the pre-#2789 gate.
 *
 * That makes a corrupt document ON THE BASE BRANCH unusually expensive: it reds every PR
 * that carries an ack until someone repairs it. The real-tree test avoids an outright
 * deadlock (a tree with no ack never consults the base, so the repair PR still lands),
 * but the cheaper answer is to never let a broken document reach the base at all. This
 * runs in `lint:ci`, so a PR carrying one cannot go green and cannot merge.
 *
 * This validator is DELIBERATELY STANDALONE. `scripts/` ships in the npm package and
 * `tests/` does not (package.json `files`), so requiring the gate's own `parseAck` from
 * here would be a MODULE_NOT_FOUND in the published package. The duplication is bounded
 * by a parity test — `tests/emitted-attribution.test.cjs` runs both surfaces over one
 * corpus and fails if they ever disagree about what is schema-valid.
 */

const fs = require('node:fs');
const path = require('node:path');

const ACK_VERSION = 1;
const ACK_REPO_PATH = 'tests/emitted-drift-ack.json';
const REPO_ROOT = path.join(__dirname, '..');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate an ack document's raw text.
 *
 * `schemaErrors` are the ones that must agree with the gate's `parseAck` — the shape
 * contract. `policyErrors` are lint-only rules that `parseAck` deliberately does NOT
 * enforce, because they are about what may be COMMITTED rather than what may be parsed:
 * a present-but-entryless document parses fine and signals nothing, so it must be deleted
 * rather than left behind.
 *
 * @param {string|null} raw  file contents, or null when the file is absent
 * @returns {{ schemaErrors: string[], policyErrors: string[], ok: boolean }}
 */
function validateAckText(raw) {
  const schemaErrors = [];
  const policyErrors = [];
  const done = () => ({ schemaErrors, policyErrors, ok: schemaErrors.length === 0 && policyErrors.length === 0 });

  if (raw === null) return done(); // absent is the healthy steady state

  if (raw.trim() === '') {
    schemaErrors.push(`${ACK_REPO_PATH} is present but empty`);
    return done();
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    schemaErrors.push(`${ACK_REPO_PATH} is not valid JSON: ${err.message}`);
    return done();
  }

  // A document that is literally `null` is POLICY, not schema. The gate's `parseAck` uses
  // `null` as its "absent == no acks" sentinel, so it reads such a file as legal and
  // harmless — and the parity test holds us to that. It is still not something to commit:
  // it declares nothing, so the remedy is the same as an entryless document.
  if (doc === null) {
    policyErrors.push(
      `${ACK_REPO_PATH} contains "null" and declares no acknowledgments. Delete the file — `
      + 'the healthy steady state is no file at all.',
    );
    return done();
  }

  if (!isPlainObject(doc)) {
    schemaErrors.push(
      `${ACK_REPO_PATH}: must be a JSON object, got ${Array.isArray(doc) ? 'array' : typeof doc}`,
    );
    return done();
  }

  if (doc.version !== undefined && doc.version !== ACK_VERSION) {
    schemaErrors.push(
      `${ACK_REPO_PATH}: unsupported version ${JSON.stringify(doc.version)} (expected ${ACK_VERSION})`,
    );
  }

  const paths = doc.paths;
  if (paths !== undefined && !isPlainObject(paths)) {
    schemaErrors.push(`${ACK_REPO_PATH}: "paths" must be an object of <emitted path> -> { reason }`);
    return done();
  }

  const entries = paths === undefined ? [] : Object.entries(paths);
  for (const [rel, value] of entries) {
    const reason = isPlainObject(value) ? value.reason : value;
    if (typeof reason !== 'string' || reason.trim() === '') {
      schemaErrors.push(`${ACK_REPO_PATH}: ack for "${rel}" has no non-empty "reason"`);
    }
  }

  // Lint-only. An entryless document parses cleanly and acknowledges nothing, so it is
  // pure confusion on the base branch — and it is exactly what a contributor leaves
  // behind after removing the last entry by hand.
  if (entries.length === 0) {
    policyErrors.push(
      `${ACK_REPO_PATH} is present but declares no acknowledgments. Delete the file — an `
      + 'empty one signals nothing, and the healthy steady state is no file at all.',
    );
  }

  return done();
}

function readIfPresent(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function main() {
  const file = path.join(REPO_ROOT, ...ACK_REPO_PATH.split('/'));
  const result = validateAckText(readIfPresent(file));
  const all = [...result.schemaErrors, ...result.policyErrors];

  if (all.length) {
    console.error(`lint-emitted-drift-ack: ${all.length} problem(s) in ${ACK_REPO_PATH}\n`);
    for (const e of all) console.error(`  - ${e}`);
    console.error(
      '\nThis blocks the merge on purpose. The base-side reader fails loudly on a document '
      + 'it cannot parse, so a broken one on the base branch reds every PR that carries an '
      + 'acknowledgment. Fix or delete the file here, where it is cheap.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    fs.existsSync(file)
      ? `ok lint-emitted-drift-ack: ${ACK_REPO_PATH} is well-formed`
      : `ok lint-emitted-drift-ack: ${ACK_REPO_PATH} absent (the healthy steady state)`,
  );
}

if (require.main === module) main();

module.exports = { validateAckText, ACK_VERSION, ACK_REPO_PATH };
