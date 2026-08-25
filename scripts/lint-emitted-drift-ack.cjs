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
const { execFileSync } = require('node:child_process');

const ACK_VERSION = 1;
const ACK_REPO_PATH = 'tests/emitted-drift-ack.json';
const ACK_DIR_REPO_PATH = 'tests/emitted-drift-acks';
const REPO_ROOT = path.join(__dirname, '..');

/**
 * Upper bound on any one git call made by the `--guard-next` lane (#3078).
 *
 * Every subprocess this repo spawns is bounded (CLAUDE.md -> KNOWN DEFECTS, "Unbounded
 * Subprocesses": 5-30s for git). The guard reads one directory listing plus one blob per
 * surviving fragment, all against local objects, so 15s is generous — but an unbounded
 * `execFileSync` on a wedged git is an indefinite hang in a job whose whole timeout
 * budget is one minute.
 */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Characters that render as nothing: soft hyphen, the zero-width family, word joiner,
 * BOM. Stripped before ack reasons are compared, so an invisible edit cannot make a spent
 * acknowledgment look re-armed.
 *
 * DUPLICATED from `INVISIBLE` in `tests/helpers/emitted-diff.cjs`, for the same reason
 * every other constant here is duplicated rather than required: `scripts/` ships in the
 * npm package and `tests/` does not, so the require would be MODULE_NOT_FOUND once
 * published (see this file's top-of-file comment). The two are held together by the
 * prose-parity test in `tests/emitted-attribution.test.cjs`, which enumerates the gate's
 * own codepoints and fails if this list stops covering them.
 *
 * Spelled as codepoints on purpose — a literal character class here would itself be
 * invisible in review, which is the exact failure being defended against.
 */
const ACK_INVISIBLE = new RegExp(
  `[${[0x00AD, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF]
    .map((c) => `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`)
    .join('')}]`,
  'g',
);

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
 * Normalize an ack reason to the prose a reviewer actually reads.
 *
 * Mirrors the gate's own `prose()` inside `diffEmitted` (`tests/helpers/emitted-diff.cjs`)
 * exactly: strip invisibles, collapse internal whitespace, trim. Re-arming a spent ack is
 * legitimate — it is how a contributor says "this is a NEW ripple, and here is why" — but
 * it must cost an ACTUAL explanation, so a doubled space, a CRLF, or a U+200B may never
 * make a spent entry look live. Bounded by the parity test named on ACK_INVISIBLE.
 */
function ackProse(reason) {
  return reason.replace(ACK_INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/**
 * The declared entries of one ack document as `path key -> normalized prose`, or `null`
 * when the document cannot be trusted to answer the question.
 *
 * `null` is NOT "no entries" — it is "do not draw a conclusion from this file". A document
 * that will not parse, is not an object, has a non-object `paths`, carries a reasonless or
 * non-string entry, or names a RESERVED_ACK_KEY cannot be shown to be spent, and the
 * conservative direction here is to leave it alone: `validateAckText` (run by `lint:ci`,
 * pre-merge) owns SHAPE and already blocks such a document from reaching the base, while
 * this guard owns LIFECYCLE. Sweeping a file we could not read would delete an
 * acknowledgment on the strength of a parse failure.
 *
 * An ABSENT document (`raw === null`) is a genuine empty entry set — the fragment simply
 * did not exist at that ref, so nothing it declares now has a counterpart there.
 */
function ackEntries(raw) {
  if (raw === null) return new Map();
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(doc)) return null;
  const paths = doc.paths;
  if (paths === undefined) return new Map();
  if (!isPlainObject(paths)) return null;

  const entries = new Map();
  for (const [rel, value] of Object.entries(paths)) {
    if (RESERVED_ACK_KEYS.has(rel)) return null;
    const reason = isPlainObject(value) ? value.reason : value;
    if (typeof reason !== 'string') return null;
    entries.set(rel, ackProse(reason));
  }
  return entries;
}

/**
 * assertNoAllSpentFragments — the fragment half of the `next`-lane guard (#3078).
 *
 * #2914 split the single shared ack file into per-PR fragments and deliberately exempted
 * the fragment directory from `assertAbsentOnNext`, on the premise that a persistent
 * fragment "cannot conflict with any other PR". That premise does not hold. Fragments do
 * not share a FILE, but they do share a PATH KEY SPACE, and `main()` below treats a path
 * claimed by two sources as a hard failure. So a merged fragment is not harmless: every
 * entry it leaves on `next` is spent by definition — its prose is already at the base, so
 * it gates nothing — while still owning its key, and the next PR that grows the same
 * workflow can declare it neither in the owning fragment (spent) nor in its own
 * (duplicate). That is the exact failure #2914 fixed for the legacy file, reintroduced one
 * level down. Measured on `next` when this landed: 45 fragments owning 403 paths.
 *
 * Unlike the legacy file, PRESENCE alone is not the failure — a fragment landed by the
 * very push being guarded is the healthy case for every ack-carrying PR. The failure is
 * INERTNESS: every surviving entry's prose already matches the copy at the base ref, so
 * the fragment can no longer clear a delta for anyone. A PARTIALLY spent fragment is left
 * alone; only an entirely inert one is cruft. That distinction is why the base side is
 * required, and it is what keeps the re-arm-by-appending route working (#2639, #2993).
 *
 * An ENTRYLESS document is vacuously all-spent and swept for the same reason
 * `validateAckText` refuses to let one be committed: it acknowledges nothing.
 *
 * Pure — no fs, no git, no clock. `main()` does the reading.
 *
 * #3842: an all-spent fragment is not automatically safe to sweep. #3078's sweep deletes
 * the fragment outright, and when an OPEN PR still modifies that same file, git reports a
 * `modify/delete` conflict on the very next merge attempt — exactly the shared-file
 * conflict fragments were adopted (#2914) to end, reintroduced by the sweep itself. Three
 * outside-contributor PRs (#3330, #3774, #3648) hit this simultaneously the first time the
 * sweep ran, each with the swept fragment as its ONLY conflicting path. `openPrTouchedPaths`
 * lets a caller defer sweeping any fragment an open PR still touches, without changing the
 * inertness rule itself: a held fragment is still reported (informationally, never as a
 * failure) so it is not silently forgotten once the touching PR merges or closes.
 *
 * @param {Array<{name: string, currentRaw: string|null, baseRaw: string|null}>} fragments
 * @param {object} [opts]
 * @param {Set<string>|'unknown'} [opts.openPrTouchedPaths] repo-relative fragment paths
 *   (`${ACK_DIR_REPO_PATH}/<name>`) that at least one OPEN pull request currently modifies.
 *   Omit entirely to skip the open-PR distinction altogether (every all-spent fragment is
 *   reported as sweepable, unchanged pre-#3842 behavior — the shape every existing caller
 *   and test relies on). Pass the literal string `'unknown'` when the open-PR set could not
 *   be determined (e.g. the `gh` lookup failed): every otherwise-sweepable fragment is held
 *   rather than swept, since "we could not check" must never collapse to "assume it is safe".
 * @returns {{ ok: boolean, message: string, sweepable: string[] }}
 */
function assertNoAllSpentFragments(fragments, { openPrTouchedPaths } = {}) {
  const allSpentFragments = [];

  for (const { name, currentRaw, baseRaw } of fragments) {
    const current = ackEntries(currentRaw);
    if (current === null) continue; // unreadable — `validateAckText` owns that verdict
    const base = ackEntries(baseRaw);
    if (base === null) continue;

    const allSpent = [...current].every(([rel, prose]) => base.get(rel) === prose);
    if (allSpent) allSpentFragments.push({ name, entries: current.size });
  }

  const holdAll = openPrTouchedPaths === 'unknown';
  const touched = openPrTouchedPaths instanceof Set ? openPrTouchedPaths : new Set();
  const toSweep = [];
  const held = [];
  for (const frag of allSpentFragments) {
    (holdAll || touched.has(`${ACK_DIR_REPO_PATH}/${frag.name}`) ? held : toSweep).push(frag);
  }

  const heldLines = held.length === 0 ? [] : [
    '',
    holdAll
      ? 'deferred (open-PR check unavailable): whether an open PR still touches the following '
        + 'all-spent fragment(s) could not be determined this run, so none of them were swept '
        + '(#3842) — assuming "safe to sweep" on a failed check would risk the exact conflict '
        + 'this deferral exists to avoid. They will be reconsidered on a later run.'
      : `deferred: ${held.length} all-spent fragment(s) are held back because an open pull `
        + 'request still touches them (#3842). Sweeping one now would hand that PR a '
        + 'modify/delete conflict it did not cause — the same failure #2914 adopted fragments '
        + 'to end. They will be swept once the touching PR merges or closes.',
      ...held.map(
        ({ name, entries }) => `  - ${ACK_DIR_REPO_PATH}/${name} (${entries} entr${entries === 1 ? 'y' : 'ies'}, all spent, held)`,
      ),
    ];

  if (toSweep.length === 0) {
    return {
      ok: true,
      message: [
        `ok guard-no-ack-on-next: no all-spent fragment survives in ${ACK_DIR_REPO_PATH}/`,
        ...heldLines,
      ].join('\n'),
      sweepable: [],
    };
  }

  const lines = toSweep.map(
    ({ name, entries }) => `  - ${ACK_DIR_REPO_PATH}/${name} (${entries} entr${entries === 1 ? 'y' : 'ies'}, all spent)`
      + `\n    remedy: git rm ${ACK_DIR_REPO_PATH}/${name}`,
  );

  return {
    ok: false,
    sweepable: toSweep.map(({ name }) => name),
    message: [
      `guard-no-ack-on-next: ${toSweep.length} fully-spent ack fragment(s) survive on next.`,
      '',
      ...lines,
      '',
      'Every entry in these fragments is already at the base, so each is spent and gates '
      + 'nothing (#2789) — but it still OWNS its path keys. The next PR that grows one of '
      + 'those paths can declare it neither here (spent) nor in its own fragment (a '
      + 'duplicate ack is a hard failure), so a spent fragment left behind is a wall, not '
      + 'harmless cruft (#3078).',
      '',
      'A partially spent fragment is deliberately NOT reported: only an entirely inert one '
      + 'is swept, so appending prose to a live entry to re-arm it keeps working.',
      ...heldLines,
    ].join('\n'),
  };
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
 * Scoped to the LEGACY FILE ONLY — the fragment directory is guarded by
 * `assertNoAllSpentFragments` above, on a stricter-to-state but weaker-to-apply rule
 * (inertness, not presence). #3078 corrected the original premise that a persisting
 * fragment "cannot conflict with any other PR": fragments share a path key space even
 * though they do not share a file.
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
      + 'PR, never this single shared file. A fragment cannot MERGE-CONFLICT with another '
      + "PR's fragment, but it does own its path keys, so a fully-spent one left on next "
      + 'still blocks the next PR that grows the same path (#3078) -- fragments are guarded '
      + 'separately, on inertness rather than on presence.',
      '',
      'CONTRIBUTING.md: "When you remove the last entry from tests/emitted-drift-ack.json, '
      + 'delete the file too -- its presence is the alarm."',
      '',
      `Remedy: git rm ${ACK_REPO_PATH}`,
    ].join('\n'),
  };
}

/**
 * Every git call declares the SPECIFIC directory it operates on as safe, mirroring
 * `safeDirArgs` in `tests/helpers/emitted-runtime.cjs` (#2767): a checkout mounted at a
 * path owned by a different uid makes git refuse EVERY operation there with "detected
 * dubious ownership", and this guard's whole value is that it fails LOUDLY on a real
 * fault rather than degrading to "no base, nothing spent". Never the `*` wildcard, which
 * would mark every repository on the machine safe. Duplicated rather than imported for
 * the reason stated at the top of this file: `scripts/` ships in the npm package and
 * `tests/` does not.
 */
function git(args, { cwd = REPO_ROOT } = {}) {
  return execFileSync('git', ['-c', `safe.directory=${path.resolve(cwd)}`, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The LOCAL/MANUAL fallback for "the commit `next` was at BEFORE this push" — `HEAD^`,
 * or `null` on a root commit. Correct only when the push it is standing in for carries
 * exactly one commit.
 *
 * CI never relies on this: it passes the authoritative pre-push tip explicitly via
 * `--base-ref` (`github.event.before`, wired in `.github/workflows/test.yml`), because
 * the default branch's ruleset allows REBASE merges
 * (`.github/rulesets/main-protection.json`, `allowed_merge_methods`), so a single push
 * event can land N commits at once. `HEAD^` steps back exactly one commit — for a
 * 2-commit rebase-merge whose first commit adds a fragment and whose second is
 * unrelated, `HEAD^` would land on the first commit, read the fragment as already
 * present there, and demand `git rm` on the very push that introduced it (#3078). This
 * function exists purely as the manual-run / single-commit-push fallback.
 *
 * Two steps on purpose. `HEAD` is resolved first, which proves git runs and the working
 * directory is a readable repository; only then is a failure to resolve `HEAD^` read as
 * "this commit has no parent". A single blanket try/catch would collapse "git is broken"
 * into "there is no base", and a guard with no base sweeps nothing — it would pass
 * vacuously, which is precisely how the legacy-file job spent months guarding a file that
 * had not existed since #2914 (#3078).
 */
function resolveBaseRef({ cwd = REPO_ROOT, run = git } = {}) {
  run(['rev-parse', '--verify', 'HEAD'], { cwd });
  try {
    return run(['rev-parse', '--verify', 'HEAD^'], { cwd }).trim();
  } catch {
    return null; // root commit — nothing can be spent against it
  }
}

/**
 * Raw text of one ack fragment AT `base`, or `null` when it is simply not there.
 *
 * Mirrors `readAckFileAtRef` in `tests/helpers/emitted-runtime.cjs` (duplicated across the
 * ships/does-not-ship line, as everything else here is): `git show` alone cannot tell a
 * bogus ref from an absent path — both say "does not exist in" — so absence is established
 * with `ls-tree`, which exits 0 with empty output when the path is not there and non-zero
 * on a real fault. A genuine git failure THROWS rather than degrading to `null`, because
 * "could not read the base" read as "absent at the base" would make every fragment look
 * brand-new and silently disarm the sweep.
 */
function readFragmentAtRef(base, name, { cwd = REPO_ROOT, run = git } = {}) {
  const repoPath = `${ACK_DIR_REPO_PATH}/${name}`;
  const listing = run(['ls-tree', '--name-only', base, '--', repoPath], { cwd });
  if (listing.trim() === '') return null;
  return run(['show', `${base}:${repoPath}`], { cwd });
}

/**
 * A base ref must not begin with `-`: `execFileSync`'s array form stops shell
 * metacharacters but not git's own option parsing, and `git show` honors diff options
 * including `--output=<file>`, which WRITES. Same guard, same reason, as
 * `readAckFileAtRef`'s.
 */
function assertUsableBaseRef(ref) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) {
    throw new Error(
      `lint-emitted-drift-ack: refusing to read fragments at ${JSON.stringify(ref)} — a base `
      + 'ref must be a non-empty string that does not begin with "-", which git would parse '
      + 'as an option.',
    );
  }
  return ref;
}

/**
 * Upper bound on how many OPEN pull requests `fetchOpenPrTouchedAckPaths` may reason
 * about in one run. Mirrors the shape of `MAX_ACK_FRAGMENTS` above: exceeding it throws
 * rather than silently reasoning about a truncated list — a truncated open-PR set would
 * make an actually-touched fragment look untouched and sweep it anyway, which is the
 * exact failure #3842 exists to prevent. 200 is comfortably above this repo's open-PR
 * count at any point observed to date.
 */
const MAX_OPEN_PRS = 200;

/** Bound on the `gh pr list` call `fetchOpenPrTouchedAckPaths` makes (#3842). */
const GH_TIMEOUT_MS = 20_000;

/**
 * Default `execGh` for `fetchOpenPrTouchedAckPaths` — a real `gh` invocation. Kept as a
 * separate, swappable function (rather than inlined) so tests can inject a stub instead
 * of shelling out to a real, authenticated `gh` — which is unavailable, and would be
 * flaky and network-dependent, in the test sandbox.
 */
function execGhDefault(args, { cwd = REPO_ROOT } = {}) {
  return execFileSync('gh', args, {
    cwd,
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The set of `tests/emitted-drift-acks/*.json` repo-relative paths touched by at least
 * one currently-OPEN pull request (#3842).
 *
 * One `gh` call — `gh pr list --json number,files` returns every open PR's changed-file
 * list in a single round trip, never one call per PR — intersected against the fragment
 * directory prefix. This is the "one `gh` API call" the issue itself proposes: cheap
 * enough to run on every push to `next` without meaningfully growing the guard job's
 * budget.
 *
 * Throws (never degrades to an empty set) when: `gh` itself fails (auth, network, rate
 * limit), the output is not parseable JSON, is not an array, or reaches the `MAX_OPEN_PRS`
 * cap — a truncated or unreadable answer must never be silently read as "no open PR
 * touches anything", which would defeat the entire deferral this function exists to
 * support. The caller (`main()`) decides what "we could not check" means for the sweep;
 * this function's only job is to never fabricate an empty answer.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {(args: string[], opts: {cwd: string}) => string} [opts.execGh] injectable `gh`
 *   runner, defaulting to a real bounded `execFileSync` call. Tests inject a stub here
 *   rather than exec'ing a real, authenticated `gh` binary.
 * @param {number} [opts.limit]
 * @returns {Set<string>}
 */
function fetchOpenPrTouchedAckPaths({ cwd = REPO_ROOT, execGh = execGhDefault, limit = MAX_OPEN_PRS } = {}) {
  const stdout = execGh(['pr', 'list', '--state', 'open', '--json', 'number,files', '--limit', String(limit)], { cwd });

  let prs;
  try {
    prs = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`fetchOpenPrTouchedAckPaths: "gh pr list" did not return valid JSON: ${err.message}`);
  }
  if (!Array.isArray(prs)) {
    throw new Error(`fetchOpenPrTouchedAckPaths: expected a JSON array from "gh pr list", got ${typeof prs}`);
  }
  if (prs.length >= limit) {
    throw new Error(
      `fetchOpenPrTouchedAckPaths: "gh pr list" returned ${prs.length} open PRs, at or above `
      + `the cap of ${limit}. Refusing to reason about a possibly-truncated list — a fragment `
      + 'touched only by a PR past the cap would look untouched and be swept anyway. Raise '
      + '`limit` or investigate the open-PR count.',
    );
  }

  const touched = new Set();
  for (const pr of prs) {
    const files = Array.isArray(pr?.files) ? pr.files : [];
    for (const file of files) {
      const filePath = isPlainObject(file) ? file.path : file;
      if (typeof filePath === 'string' && filePath.startsWith(`${ACK_DIR_REPO_PATH}/`)) {
        touched.add(filePath);
      }
    }
  }
  return touched;
}

/**
 * The full `--guard-next` behavior, factored out of `main()` so it is callable directly
 * from a test with injected deps — never through a real, network-dependent `gh` (or a
 * real filesystem/git checkout) the way `main()` itself is only exercisable via
 * subprocess. Returns data rather than performing I/O; `main()` does the printing and
 * exit-code setting.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] defaults to `process.argv`
 * @param {string} [opts.cwd] defaults to `REPO_ROOT`
 * @param {() => Set<string>} [opts.fetchOpenPrPaths] defaults to `fetchOpenPrTouchedAckPaths`.
 *   Injectable so a test can supply canned open-PR data (or a throwing stub, to exercise
 *   the fail-closed "hold everything" path) without shelling out to a real `gh`.
 * @returns {{ ok: boolean, lines: string[] }}
 */
function runGuardNext({ argv = process.argv, cwd = REPO_ROOT, fetchOpenPrPaths = fetchOpenPrTouchedAckPaths } = {}) {
  const legacyFile = path.join(cwd, ...ACK_REPO_PATH.split('/'));
  const legacy = assertAbsentOnNext(fs.existsSync(legacyFile));
  const lines = [legacy.message];

  // The fragment half (#3078). CI always passes `--base-ref` (the pre-push tip of `next`,
  // `github.event.before`), because the default branch allows REBASE merges and one push
  // can carry N commits — `HEAD^` alone is not "the state of next before this push" in
  // that case. `resolveBaseRef()`'s `HEAD^` is only the fallback for a manual run or a
  // single-commit push, where the two agree. NOTE the job's checkout must fetch at least
  // depth 2 for the `HEAD^` fallback to resolve at all, and must separately fetch the
  // `--base-ref` commit itself, or every fragment reads as brand-new.
  const baseFlag = argv.indexOf('--base-ref');
  const baseRef = baseFlag === -1
    ? resolveBaseRef({ cwd })
    : assertUsableBaseRef(argv[baseFlag + 1]);

  const dir = path.join(cwd, ...ACK_DIR_REPO_PATH.split('/'));
  const fragments = listFragmentFiles(dir).map((name) => ({
    name,
    currentRaw: readIfPresent(path.join(dir, name)),
    baseRaw: baseRef === null ? null : readFragmentAtRef(baseRef, name, { cwd }),
  }));

  // #3842: opt-in (never on by default — a caller that omits this flag gets the exact
  // pre-#3842 behavior, which is what every existing test and any manual/local run relies
  // on). CI passes it so the sweep never hands an open PR a modify/delete conflict it did
  // not cause. A failed lookup holds EVERYTHING back rather than sweeping blind (see
  // fetchOpenPrTouchedAckPaths's own doc comment).
  let openPrTouchedPaths;
  if (argv.includes('--defer-to-open-prs')) {
    try {
      openPrTouchedPaths = fetchOpenPrPaths();
    } catch (err) {
      lines.push(`lint-emitted-drift-ack: open-PR check unavailable — ${err.message}`);
      openPrTouchedPaths = 'unknown';
    }
  }

  const sweep = assertNoAllSpentFragments(fragments, { openPrTouchedPaths });
  lines.push(sweep.message);

  return { ok: legacy.ok && sweep.ok, lines };
}

function main() {
  if (process.argv.includes('--guard-next')) {
    const result = runGuardNext();
    for (const line of result.lines) console.log(line);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const legacyFile = path.join(REPO_ROOT, ...ACK_REPO_PATH.split('/'));

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
            + 'name the same path. Resolve it one of two ways, depending on the owner: if '
            + `${owner.get(key)} is already merged, its entry is SPENT and gates nothing — `
            + `delete it (git rm ${owner.get(key)}) and keep your own. If it is still live `
            + 'on this branch, APPEND your explanation to its existing entry instead, which '
            + 're-arms it — re-arming deliberately costs actual new prose. Do not rename '
            + 'the path to dodge this.',
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
  assertNoAllSpentFragments,
  ackProse,
  ackEntries,
  declaredKeys,
  listFragmentFiles,
  ACK_VERSION,
  ACK_REPO_PATH,
  ACK_DIR_REPO_PATH,
  ACK_INVISIBLE,
  MAX_ACK_FRAGMENTS,
  git,
  resolveBaseRef,
  readFragmentAtRef,
  assertUsableBaseRef,
  GIT_TIMEOUT_MS,
  fetchOpenPrTouchedAckPaths,
  MAX_OPEN_PRS,
  GH_TIMEOUT_MS,
  runGuardNext,
};
