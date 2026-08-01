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
 *
 * #2914: the single shared `tests/emitted-drift-ack.json` is replaced by per-PR
 * fragments under `tests/emitted-drift-acks/` (kept alongside the legacy file, which is
 * still honored). This validator now checks BOTH: every physical source is run through
 * the same schema/policy rules below, and — because two sources are never allowed to
 * name the same path (silent last-wins would resurrect exactly the silent-drift class
 * the ack seam exists to end) — a cross-source duplicate key is ALSO a hard failure.
 */

const fs = require('node:fs');
const path = require('node:path');

const ACK_VERSION = 1;
const ACK_REPO_PATH = 'tests/emitted-drift-ack.json';
const ACK_DIR_REPO_PATH = 'tests/emitted-drift-acks';
const REPO_ROOT = path.join(__dirname, '..');

/**
 * Upper bound on how many fragment files `listFragmentFiles` may return in one
 * `readdirSync` pass. Mirrors `MAX_ACK_FRAGMENTS` in `tests/helpers/emitted-diff.cjs` —
 * DUPLICATED rather than imported, because `scripts/` ships in the npm package and
 * `tests/` does not (requiring across that line would be MODULE_NOT_FOUND once
 * published; see this file's top-of-file comment). The two are held to the same value
 * by the schema-parity test in `tests/emitted-attribution.test.cjs`.
 *
 * Exceeding it throws rather than truncating: a truncated listing would silently drop
 * acknowledgments from consideration, which is exactly the class of silent failure this
 * whole ack seam exists to prevent.
 */
const MAX_ACK_FRAGMENTS = 500;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Key names that can never be a legitimate emitted path or bare workflow/agent filename
 * (`__proto__`, `constructor`, `prototype`). Duplicated (not imported) in
 * `tests/helpers/emitted-diff.cjs`'s `parseAck` for the same reason every other constant
 * here is duplicated rather than required — `scripts/` ships, `tests/` does not. Held to
 * the same set by the schema-parity test in `tests/emitted-attribution.test.cjs`, which
 * must see BOTH surfaces reject a document naming one of these, never one silently
 * accepting what the other errors on (#2914 review).
 */
const RESERVED_ACK_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
 * @param {object} [opts]
 * @param {string} [opts.source] the path used in error messages (default: the legacy
 *   file). Generalized (#2914) so the same rules apply verbatim to a fragment under
 *   `ACK_DIR_REPO_PATH` — one definition of "valid", named per the file it is checking.
 * @returns {{ schemaErrors: string[], policyErrors: string[], ok: boolean }}
 */
function validateAckText(raw, { source = ACK_REPO_PATH } = {}) {
  const schemaErrors = [];
  const policyErrors = [];
  const done = () => ({ schemaErrors, policyErrors, ok: schemaErrors.length === 0 && policyErrors.length === 0 });

  if (raw === null) return done(); // absent is the healthy steady state

  if (raw.trim() === '') {
    schemaErrors.push(`${source} is present but empty`);
    return done();
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    schemaErrors.push(`${source} is not valid JSON: ${err.message}`);
    return done();
  }

  // A document that is literally `null` is POLICY, not schema. The gate's `parseAck` uses
  // `null` as its "absent == no acks" sentinel, so it reads such a file as legal and
  // harmless — and the parity test holds us to that. It is still not something to commit:
  // it declares nothing, so the remedy is the same as an entryless document.
  if (doc === null) {
    policyErrors.push(
      `${source} contains "null" and declares no acknowledgments. Delete the file — `
      + 'the healthy steady state is no file at all.',
    );
    return done();
  }

  if (!isPlainObject(doc)) {
    schemaErrors.push(
      `${source}: must be a JSON object, got ${Array.isArray(doc) ? 'array' : typeof doc}`,
    );
    return done();
  }

  if (doc.version !== undefined && doc.version !== ACK_VERSION) {
    schemaErrors.push(
      `${source}: unsupported version ${JSON.stringify(doc.version)} (expected ${ACK_VERSION})`,
    );
  }

  const paths = doc.paths;
  if (paths !== undefined && !isPlainObject(paths)) {
    schemaErrors.push(`${source}: "paths" must be an object of <emitted path> -> { reason }`);
    return done();
  }

  const entries = paths === undefined ? [] : Object.entries(paths);
  for (const [rel, value] of entries) {
    if (RESERVED_ACK_KEYS.has(rel)) {
      // Reject loudly rather than silently filter. Previously this key was excluded
      // only from `declaredKeys`'s duplicate-detection view, so a document naming it
      // passed validation here while the gate's `parseAck` (fed the JSON.parse'd
      // document, where such a key is a genuine own property) either mishandled it or
      // disagreed silently — two surfaces reaching different verdicts on the same
      // document (#2914 review). Recognizably the same finding as `parseAck`'s.
      schemaErrors.push(
        `${source}: ack key "${rel}" is reserved and can never be a valid emitted path `
        + 'or workflow/agent filename — remove it',
      );
      continue;
    }
    const reason = isPlainObject(value) ? value.reason : value;
    if (typeof reason !== 'string' || reason.trim() === '') {
      schemaErrors.push(`${source}: ack for "${rel}" has no non-empty "reason"`);
    }
  }

  // Lint-only. An entryless document parses cleanly and acknowledges nothing, so it is
  // pure confusion on the base branch — and it is exactly what a contributor leaves
  // behind after removing the last entry by hand.
  if (entries.length === 0) {
    policyErrors.push(
      `${source} is present but declares no acknowledgments. Delete the file — an `
      + 'empty one signals nothing, and the healthy steady state is no file at all.',
    );
  }

  return done();
}

function readIfPresent(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * Fragment filenames under `dir`, sorted. Absent directory == zero fragments.
 *
 * Fails loudly, naming `dir`, the cap, and the actual count, when the directory holds
 * more than `MAX_ACK_FRAGMENTS` entries — never silently truncates the listing.
 */
function listFragmentFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  if (names.length > MAX_ACK_FRAGMENTS) {
    throw new Error(
      `lint-emitted-drift-ack: ${dir} contains ${names.length} ack fragments, exceeding `
      + `the cap of ${MAX_ACK_FRAGMENTS}. Refusing to read only some of them — a truncated `
      + 'read would silently drop acknowledgments. Prune spent fragments from this directory.',
    );
  }
  return names;
}

/**
 * The path keys a document declares, for cross-source collision detection — but ONLY
 * when the document is itself trustworthy. A document that failed its own schema check
 * must not also seed a bogus "collision" derived from garbage; its own error already
 * blocks the merge, and reporting a fabricated collision on top would confuse rather
 * than clarify. `RESERVED_ACK_KEYS` are also excluded here — they can never be a
 * legitimate duplicate, since they can never be a legitimate key at all — but this is
 * belt-and-suspenders, not the enforcement point: `validateAckText` above now rejects any
 * document naming one outright, so `main()` only ever calls this on a document whose
 * schema already checked out, making the exclusion below unreachable in practice.
 */
function declaredKeys(raw) {
  if (raw === null) return [];
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(doc)) return [];
  const paths = doc.paths;
  if (paths === undefined) return [];
  if (!isPlainObject(paths)) return [];
  return Object.keys(paths).filter((k) => !RESERVED_ACK_KEYS.has(k));
}

/**
 * assertAbsentOnNext — the `next`-lane guard (#2914), invoked only by the
 * `guard-no-ack-on-next` workflow job on push to `next`, never in `lint:ci`.
 *
 * `validateAckText` lints SHAPE, because a PR's own working tree may legitimately carry
 * a live, well-formed ack — that is the normal case a PR-lane check must allow. This
 * function instead rejects PRESENCE outright, valid or not: per the ack-lifecycle law
 * (#2789, `RULESET.EMITTED_ATTRIBUTION`), an entry already at the base is spent the
 * moment it merges, so a document surviving on `next` is inert cruft by definition, not
 * a thing to schema-check.
 *
 * This MUST NOT run as a PR-lane check comparing a PR against `next` — that is the #2768
 * shape #2789 exists to prevent (a spent-but-present base ack would red every open PR the
 * instant one landed). It is safe only because it runs on `next` itself, asserting a fact
 * about `next`'s own tree, never about any PR's diff against it.
 *
 * @param {boolean} present  whether ACK_REPO_PATH exists in the tree being checked
 * @returns {{ ok: boolean, message: string }}
 */
function assertAbsentOnNext(present) {
  if (!present) {
    return { ok: true, message: `ok guard-no-ack-on-next: ${ACK_REPO_PATH} is absent (the healthy steady state)` };
  }
  return {
    ok: false,
    message: [
      `guard-no-ack-on-next: ${ACK_REPO_PATH} exists on next.`,
      '',
      'Every entry in this file is scoped to the diff that introduced it (#2789). Once merged '
      + 'to next it is, by definition, already at the base -- spent and inert, regardless of '
      + 'whether it is otherwise well-formed.',
      '',
      '#2914: acks now go in per-PR fragments under tests/emitted-drift-acks/, one file per '
      + 'PR, never this single shared file -- a persistent fragment there is harmless (every '
      + 'fragment is independently named, so it cannot conflict with any other PR), which is '
      + 'why only THIS legacy file is guarded here, never the fragment directory.',
      '',
      'CONTRIBUTING.md: "When you remove the last entry from tests/emitted-drift-ack.json, '
      + 'delete the file too -- its presence is the alarm."',
      '',
      `Remedy: git rm ${ACK_REPO_PATH}`,
    ].join('\n'),
  };
}

function main() {
  const legacyFile = path.join(REPO_ROOT, ...ACK_REPO_PATH.split('/'));

  if (process.argv.includes('--guard-next')) {
    const result = assertAbsentOnNext(fs.existsSync(legacyFile));
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const fragmentsDir = path.join(REPO_ROOT, ...ACK_DIR_REPO_PATH.split('/'));
  const sources = [
    { label: ACK_REPO_PATH, raw: readIfPresent(legacyFile) },
    ...listFragmentFiles(fragmentsDir).map((name) => ({
      label: `${ACK_DIR_REPO_PATH}/${name}`,
      raw: readIfPresent(path.join(fragmentsDir, name)),
    })),
  ];

  const problems = [];
  const owner = new Map(); // path key -> the source label that already claimed it
  let anyPresent = false;

  for (const { label, raw } of sources) {
    if (raw !== null) anyPresent = true;

    // `validateAckText` already prefixes every message with `source` (== `label`), so
    // these are pushed verbatim rather than re-prefixed — a second prefix would read as
    // "tests/emitted-drift-acks/x.json: tests/emitted-drift-acks/x.json is not valid
    // JSON", naming the same file twice for no reason.
    const result = validateAckText(raw, { source: label });
    problems.push(...result.schemaErrors, ...result.policyErrors);

    // Only chase collisions across documents whose OWN schema already checked out —
    // a document we could not trust must not also seed a fabricated collision.
    if (result.schemaErrors.length === 0) {
      for (const key of declaredKeys(raw)) {
        if (owner.has(key)) {
          problems.push(
            `duplicate ack for "${key}": declared in both ${owner.get(key)} and ${label}. `
            + 'Two ack sources (fragments, or a fragment and the legacy file) may never '
            + 'name the same path — rename or merge them.',
          );
          continue;
        }
        owner.set(key, label);
      }
    }
  }

  if (problems.length) {
    console.error(`lint-emitted-drift-ack: ${problems.length} problem(s)\n`);
    for (const e of problems) console.error(`  - ${e}`);
    console.error(
      '\nThis blocks the merge on purpose. The base-side reader fails loudly on a document '
      + 'it cannot parse, so a broken one on the base branch reds every PR that carries an '
      + 'acknowledgment, and a duplicate across two sources is exactly the silent-drift class '
      + 'the ack seam exists to end. Fix or delete the offending source(s) here, where it is cheap.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    anyPresent
      ? 'ok lint-emitted-drift-ack: all acknowledgment sources are well-formed'
      : 'ok lint-emitted-drift-ack: no acknowledgment sources present (the healthy steady state)',
  );
}

if (require.main === module) main();

module.exports = {
  validateAckText,
  assertAbsentOnNext,
  declaredKeys,
  listFragmentFiles,
  ACK_VERSION,
  ACK_REPO_PATH,
  ACK_DIR_REPO_PATH,
  MAX_ACK_FRAGMENTS,
};
