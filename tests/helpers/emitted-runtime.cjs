'use strict';

/**
 * Real-world I/O shell for the differential attribution check (#2723, ADR-2719).
 *
 * `emitted-diff.cjs` holds the pure conservation law; this module is the only place
 * that touches git, the filesystem, or the installer. Keeping them apart is what makes
 * the law's acceptance criteria testable in milliseconds — but the shell still has to
 * exist and actually run, or the phase ships as interface-only, which an isolated
 * reviewer correctly called out on the first cut of this work.
 *
 * ── Baseline source during the dual-run window ───────────────────────────────
 * The baseline is the emitted manifest set at `next` HEAD. During Phase 3 that is
 * available for FREE and for REAL via `git show origin/next:<fixture>` — the committed
 * golden fixtures ARE next's recorded emitted state, and CI keeps them current there.
 * No worktree, no rebuild, no 19 installer spawns for the baseline side.
 *
 * Critically this is NOT the same as reading the fixtures from the WORKING TREE: those
 * are whatever the PR author regenerated, so comparing against them would be vacuous
 * (current vs. the author's own regeneration). Reading them at `origin/next` is what
 * makes the comparison a real differential against upstream state.
 *
 * Phase 4 (#2724) deletes the fixtures, at which point `resolveBaseline`'s cache path
 * (already implemented and tested in emitted-baseline.cjs) becomes the source. That
 * swap is the only change Phase 4 needs here.
 *
 * The CURRENT side is built for real — 19 installer spawns via the same
 * `runMinimalInstall` + `buildParityManifest` the golden harness uses. It is the
 * expensive half on purpose: if a PR forgot to regenerate, current-real differs from
 * next's recorded state and the attribution actually runs, which is the whole point.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { cleanup, runNpm } = require('../helpers.cjs');
const {
  MANIFEST_FAMILIES,
  MINIMUM_MANIFEST_FAMILIES,
  runMinimalInstall,
  buildParityManifest,
  extraEmitRootsFor,
  PKG_VERSION,
} = require('./install-shared.cjs');
const { mergeAckSources, MAX_ACK_FRAGMENTS } = require('./emitted-diff.cjs');

/**
 * Fail loudly when a fragment listing exceeds `MAX_ACK_FRAGMENTS`, naming the
 * directory, the cap, and the actual count. Never truncate: a silently-truncated
 * listing would silently drop acknowledgments, which is exactly the class of silent
 * failure the ack seam exists to prevent (see `MAX_ACK_FRAGMENTS`'s doc comment in
 * `emitted-diff.cjs`).
 */
function assertFragmentCountWithinCap(dirLabel, names) {
  if (names.length > MAX_ACK_FRAGMENTS) {
    throw new Error(
      `emitted-attribution: ${dirLabel} contains ${names.length} ack fragments, `
      + `exceeding the cap of ${MAX_ACK_FRAGMENTS}. Refusing to read only some of them — a `
      + 'truncated read would silently drop acknowledgments. Prune spent fragments from '
      + 'this directory.',
    );
  }
  return names;
}

const REPO_ROOT = path.join(__dirname, '..', '..');
/**
 * Repo-relative and POSIX-separated on every platform: this form is what `git show
 * <ref>:<path>` requires, and git speaks only forward slashes regardless of host OS.
 * `ACK_PATH` derives from it so the two can never name different files.
 *
 * LEGACY single-file path (#2778), still honored and unioned with `ACK_DIR_REPO_PATH`
 * below (#2914) — open PRs authored before the fragment split still carry this file.
 */
const ACK_REPO_PATH = 'tests/emitted-drift-ack.json';
const ACK_PATH = path.join(REPO_ROOT, ...ACK_REPO_PATH.split('/'));
/**
 * Per-PR fragment directory (#2914). Every fragment is independently named, so two PRs
 * that each need an ack can never collide on this path the way they always did on the
 * single legacy file above.
 */
const ACK_DIR_REPO_PATH = 'tests/emitted-drift-acks';
const ACK_DIR = path.join(REPO_ROOT, ...ACK_DIR_REPO_PATH.split('/'));
const FIXTURE_SUBDIR = 'tests/fixtures/golden-install-parity';

/**
 * Repo paths whose presence in a PR diff attributes a CHANGE TO THE FAMILY SET —
 * a runtime being added or removed — as opposed to a change in emitted content.
 *
 * Deliberately NARROW: only the two surfaces that actually define the family set —
 * `RUNTIME_META`'s home, and a runtime's capability descriptor. Every extra path here
 * widens what silently excuses an unattributed family delta, so adjacent surfaces that
 * merely *accompany* a runtime addition (name-policy, capability registry) are left out
 * on purpose. A PR that adds a runtime necessarily touches one of these two.
 *
 * Deliberately path-based rather than diff-hunk-parsing: asserting that a diff adds a
 * specific `RUNTIME_META` key would be a source-grep test, which this repo prohibits.
 * The residual — a PR touching one of these for an unrelated reason may permit an
 * otherwise-unexplained family delta — is recorded in the ADR-2719 risk register and is
 * one class weaker than the false-attribution risk already accepted there.
 */
const REGISTRY_SIGNAL_PATHS = [
  'tests/helpers/install-shared.cjs',
];

/**
 * A capability descriptor: `capabilities/<runtime>/capability.json`, exactly one segment deep.
 *
 * Anchored, with `[^/]+` for the runtime segment. A prefix+suffix pair is NOT equivalent and
 * was wrong: `capabilities/capability.json` satisfies both `startsWith('capabilities/')` and
 * `endsWith('/capability.json')` with no runtime segment at all, and
 * `capabilities/a/b/capability.json` satisfies them at the wrong depth. Both would have
 * excused an unattributed family delta.
 */
const REGISTRY_SIGNAL_PATTERN = /^capabilities\/[^/]+\/capability\.json$/;

/**
 * Reason codes for family reconciliation.
 *
 * Frozen and asserted as a set, so adding a code is a coordinated three-part change
 * (enum, emitter, the test that locks the key list). Tests assert on these codes, never
 * on rendered prose — the repo prohibits raw text matching on produced output.
 */
const FAMILY_REASON = Object.freeze({
  BELOW_FLOOR: 'below_floor',
  FIXTURE_WITHOUT_RUNTIME: 'fixture_without_runtime',
  RUNTIME_WITHOUT_FIXTURE: 'runtime_without_fixture',
  ADDED_UNATTRIBUTED: 'added_unattributed',
  DROPPED_UNATTRIBUTED: 'dropped_unattributed',
  MISSING_CLAUDE_LOCAL: 'missing_claude_local',
  BASELINE_UNUSABLE: 'baseline_unusable',
  CURRENT_UNUSABLE: 'current_unusable',
  DERIVED_UNUSABLE: 'derived_unusable',
  FIXTURES_UNUSABLE: 'fixtures_unusable',
  BAD_CHANGED_PATHS: 'bad_changed_paths',
});

/** Path separators normalize UNCONDITIONALLY — backslash paths arrive on Linux too. */
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** True when `changedPaths` plausibly alters the runtime registry. */
function touchesRuntimeRegistry(changedPaths) {
  return changedPaths.some((raw) => {
    const p = toPosix(raw);
    return REGISTRY_SIGNAL_PATHS.includes(p) || REGISTRY_SIGNAL_PATTERN.test(p);
  });
}

/**
 * Reconcile the emitted manifest FAMILY SET across the three independent signals.
 *
 * ── Why this is not a count ──────────────────────────────────────────────────
 * #2723 shipped a single literal (`EXPECTED_MANIFEST_COUNT = 19`) asserted against both
 * the baseline (built at the base ref) and the current tree (built at PR HEAD). Those
 * two legitimately differ by one family whenever a PR adds or removes a runtime, so no
 * value of that literal could satisfy both: 19 rejected the current side, 20 rejected
 * the baseline side. Every PR adding a runtime was hard-blocked.
 *
 * Equally important, a count cannot see a MEMBERSHIP SWAP — add one family and remove
 * another and the totals still match while both changes go unexamined. The contract is
 * therefore set-based in both directions.
 *
 * ── The three signals ────────────────────────────────────────────────────────
 *   derived   what the runtime registry says this tree emits   (MANIFEST_FAMILIES)
 *   fixtures  what this tree has recorded                      (the committed glob)
 *   baseline  what existed before this PR                      (families at the base ref)
 *
 * derived-vs-fixtures catches drift on a single tree; baseline-vs-current catches an
 * unexplained change to the set; and the floor catches the case neither can — a universe
 * that shrank uniformly, which a same-count self-check passes vacuously.
 *
 * Pure and IO-free by construction: the real-tree caller skips wherever no base ref
 * exists (the gsd-test runner shallow-clones, so `origin/*` is absent), which would make
 * a regression written at that altitude silently skip instead of proving anything.
 *
 * @param {object} o
 * @param {Array<{name:string}>} o.derived     families the registry implies
 * @param {string[]}             o.fixtures    family names recorded on this tree
 * @param {object|null}          o.baseline    manifests at the base ref (keyed by family)
 * @param {object|null}          o.current     manifests at PR HEAD (keyed by family)
 * @param {string[]}             o.changedPaths repo-relative paths this PR changed
 * @param {number}               [o.minimum]   absolute floor
 * @returns {{ok: boolean, errors: Array<{code: string, family?: string}>}}
 */
function reconcileFamilies({
  derived,
  fixtures,
  baseline,
  current,
  changedPaths,
  minimum = MINIMUM_MANIFEST_FAMILIES,
} = {}) {
  const errors = [];
  const add = (code, family) => errors.push(family ? { code, family } : { code });

  // Hostile-input gates first, and EVERY input gets one. Each returns an explicit code —
  // never a quiet ok (indistinguishable from "the tree is clean" for a gate) and never an
  // unhandled TypeError, which would read as an infrastructure fault rather than a verdict.
  if (!Array.isArray(changedPaths)) {
    add(FAMILY_REASON.BAD_CHANGED_PATHS);
    return { ok: false, errors };
  }
  if (!Array.isArray(derived) || derived.some((f) => !f || typeof f.name !== 'string')) {
    add(FAMILY_REASON.DERIVED_UNUSABLE);
    return { ok: false, errors };
  }
  if (!Array.isArray(fixtures) || fixtures.some((n) => typeof n !== 'string')) {
    add(FAMILY_REASON.FIXTURES_UNUSABLE);
    return { ok: false, errors };
  }
  if (baseline === null || baseline === undefined || typeof baseline !== 'object' || Array.isArray(baseline)) {
    add(FAMILY_REASON.BASELINE_UNUSABLE);
    return { ok: false, errors };
  }
  if (current === null || current === undefined || typeof current !== 'object' || Array.isArray(current)) {
    add(FAMILY_REASON.CURRENT_UNUSABLE);
    return { ok: false, errors };
  }

  const derivedNames = new Set(derived.map((f) => f.name));
  const fixtureNames = new Set(fixtures);
  const baselineNames = new Set(Object.keys(baseline));
  const currentNames = new Set(Object.keys(current));

  // The floor. Independent of every derivation, so a uniformly shrunken universe cannot
  // satisfy it by moving both sides together.
  if (derivedNames.size < minimum) add(FAMILY_REASON.BELOW_FLOOR);

  // Single-tree drift: the registry and the recorded fixtures must describe one world.
  for (const name of fixtureNames) {
    if (!derivedNames.has(name)) add(FAMILY_REASON.FIXTURE_WITHOUT_RUNTIME, name);
  }
  for (const name of derivedNames) {
    if (!fixtureNames.has(name)) add(FAMILY_REASON.RUNTIME_WITHOUT_FIXTURE, name);
  }

  // #2086: claude's local-scope layout is a family in its own right and was once dropped
  // from both sides at once. Pinned by name on both, never inferred from a total.
  if (!currentNames.has('claude-local')) add(FAMILY_REASON.MISSING_CLAUDE_LOCAL, 'claude-local');
  if (!baselineNames.has('claude-local')) add(FAMILY_REASON.MISSING_CLAUDE_LOCAL, 'claude-local');

  // Cross-tree set difference, both directions, with ONE permission path: the PR
  // plausibly touched the runtime registry. Symmetric on purpose — an ack-style bypass on
  // only one side would make removals easier to wave through than additions, and the
  // drift-ack file exists for unattributable emitted-PATH deltas, not for family churn.
  const attributed = touchesRuntimeRegistry(changedPaths);

  if (!attributed) {
    for (const name of currentNames) {
      if (!baselineNames.has(name)) add(FAMILY_REASON.ADDED_UNATTRIBUTED, name);
    }
    for (const name of baselineNames) {
      if (!currentNames.has(name)) add(FAMILY_REASON.DROPPED_UNATTRIBUTED, name);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Bounded git invocation. CLAUDE.md → KNOWN DEFECTS: every git subprocess needs a
 *  timeout (5-30s); an unbounded execFileSync is an indefinite hang, and it is how
 *  macOS CI silently stops reporting. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Prepend `-c safe.directory=<dir>` to a git argv.
 *
 * The remote test-runner container mounts the repository at a path owned by a
 * different uid than the process running the suite; git's dubious-ownership
 * protection then refuses EVERY operation there with "detected dubious ownership"
 * (#2767 — surfaced when a previously-always-skipping regression test started
 * actually executing in that container and its very first `git rev-parse HEAD`
 * failed closed). GitHub Actions never hits this because `actions/checkout`
 * registers the workspace as a safe directory automatically; this runner's
 * container does not. `buildBaselineAtRef` is the PRODUCTION build-fallback path
 * the sole remaining emitted gate depends on (`resolveBaseline`'s in-job-build leg,
 * ADR-2719 §5) — not just a test helper — so the fix belongs here, not papered
 * over by skipping the test that found it.
 *
 * Declares the SPECIFIC resolved directory each call site already operates on —
 * never the `*` wildcard, which would mark every repository on the machine safe —
 * so this cannot broaden trust beyond the one path the caller already intends to
 * touch. Every git call in this module (and its production/test callers) passes
 * through here so the fix cannot silently drift per call site.
 */
function safeDirArgs(dir) {
  return ['-c', `safe.directory=${path.resolve(dir)}`];
}

function git(args, { cwd = REPO_ROOT } = {}) {
  return execFileSync('git', [...safeDirArgs(cwd), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Repo paths the PR changed, via the three-dot form so the comparison is against the
 * merge base rather than the tip of `base`.
 *
 * A git failure THROWS. It must never degrade to an empty array: reading "git broke" as
 * "nothing changed" would make every moved hash unattributable and produce a failure
 * storm that reads exactly like a real finding.
 */
function resolveChangedPaths(base = 'origin/next') {
  let out;
  try {
    out = git(['diff', '--name-only', `${base}...HEAD`]);
  } catch (err) {
    throw new Error(
      `emitted-attribution: could not resolve changed paths from "${base}...HEAD": ${err.message}. ` +
      'This is a hard error on purpose — treating it as "no changes" would mark every ' +
      'moved emitted path unattributable.',
    );
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Resolve `base` to a 40-hex sha, for the baseline cache-key discipline (ADR §5). */
function resolveBaseSha(base = 'origin/next') {
  return git(['rev-parse', base]).trim();
}

/**
 * The acknowledgment document AS IT EXISTS AT `base` — the base side of the ack
 * lifecycle (#2789). An entry already present there is SPENT: its ripple is absorbed
 * into the base, so it may no longer clear a delta and is never reported stale.
 *
 * ── Why "inherit nothing" is NOT a safe default ──────────────────────────────
 * Absent at that ref is the healthy steady state and returns `null`. Every OTHER failure
 * THROWS, and the distinction is load-bearing in the direction that is easy to get
 * backwards. Returning `null` on a read error looks armed — nothing is inherited, so
 * every entry stays live — but a LIVE entry's defining power is that it CONSUMES a
 * delta. So `null` is armed on the staleness axis and DISARMED on the consumption axis,
 * which is the axis a gate over shipped artifacts actually cares about: a genuinely new,
 * unexplained ripple on a path carrying an already-merged ack would come back `acked`
 * instead of `unattributable`. That is silently the whole pre-#2789 behavior, including
 * the pre-clearing hazard this change exists to close.
 *
 * So this follows the same law as `resolveChangedPaths` above — a failed git read is an
 * ERROR, not an empty set — and matches the head-side `readAckFile`, which already
 * throws on a document that exists but will not parse. Being more forgiving about the
 * base copy of the same file would be strictly worse: it is the copy we cannot see in
 * the diff.
 *
 * `git show` alone cannot make the distinction — a bogus ref and an absent path produce
 * the same "does not exist in" message — so absence is established with `ls-tree`, which
 * exits 0 with empty output when the path is simply not there and non-zero on a real
 * fault.
 *
 * `repoPath` defaults to the legacy single file, but is generalized (#2914) so the same
 * read-at-ref logic serves any one fragment under `ACK_DIR_REPO_PATH` too — there is
 * exactly one implementation of "read this ack path at that ref", reused per source
 * rather than re-typed per fragment.
 */
function readAckFileAtRef(base, { cwd = REPO_ROOT, run = git, repoPath = ACK_REPO_PATH } = {}) {
  // `execFileSync`'s array form stops SHELL metacharacters but not git's own option
  // parsing: a ref beginning with `-` is read as an option token, and `git show` honors
  // diff options including `--output=<file>`, which writes. Today every caller passes a
  // resolved 40-hex sha, but this function is exported and validated nothing itself —
  // the guard belonged with the argument, not with the one caller that happens to be safe.
  if (typeof base !== 'string' || base === '' || base.startsWith('-')) {
    throw new Error(
      `emitted-attribution: refusing to read the ack at ${JSON.stringify(base)} — a base ref `
      + 'must be a non-empty string that does not begin with "-", which git would parse as an option.',
    );
  }

  let listing;
  try {
    listing = run(['ls-tree', '--name-only', base, '--', repoPath], { cwd });
  } catch (err) {
    throw new Error(
      `emitted-attribution: could not list the ack at "${base}": ${err.message}. This is a `
      + 'hard error on purpose — treating an unreadable base as "nothing inherited" would '
      + 'leave every ack able to consume a delta, which is the pre-#2789 gate.',
    );
  }
  if (listing.trim() === '') return null; // genuinely absent at that ref — the steady state

  let raw;
  try {
    raw = run(['show', `${base}:${repoPath}`], { cwd });
  } catch (err) {
    throw new Error(
      `emitted-attribution: ${repoPath} exists at "${base}" but could not be read: ${err.message}`,
    );
  }
  if (raw.trim() === '') {
    throw new Error(`emitted-attribution: ${repoPath} is present at "${base}" but empty`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `emitted-attribution: ${repoPath} at "${base}" is not valid JSON: ${err.message}`,
    );
  }
}

/**
 * Fragment filenames present under `ACK_DIR_REPO_PATH` AT `base`, sorted.
 *
 * Mirrors `readAckFileAtRef`'s absence handling: `ls-tree` on a directory that does not
 * exist at that ref exits 0 with empty output, which this reads as "no fragments there"
 * — the healthy steady state, not a fault. A genuine git failure (bad ref, corrupt
 * object) still throws, for the same reason `readAckFileAtRef` throws on one: silently
 * reading "could not list" as "nothing there" would leave every fragment ack able to
 * consume a delta it should not.
 */
function listAckFragmentFilesAtRef(base, { cwd = REPO_ROOT, run = git } = {}) {
  let out;
  try {
    out = run(['ls-tree', '--name-only', base, '--', `${ACK_DIR_REPO_PATH}/`], { cwd });
  } catch (err) {
    throw new Error(
      `emitted-attribution: could not list ${ACK_DIR_REPO_PATH}/ at "${base}": ${err.message}.`,
    );
  }
  const names = out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((p) => p.endsWith('.json'))
    .map((p) => p.slice(p.lastIndexOf('/') + 1))
    .sort();
  return assertFragmentCountWithinCap(`${ACK_DIR_REPO_PATH}/ at "${base}"`, names);
}

/**
 * Fragment filenames present under `ACK_DIR` on THIS tree (the working copy), sorted.
 * Absent directory == zero fragments, the healthy steady state — not a fault.
 */
function listAckFragmentFiles(dir = ACK_DIR) {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return assertFragmentCountWithinCap(dir, names);
}

/**
 * Read + union every ack source on THIS tree (#2914): the legacy single file (if
 * present) plus every fragment under `ACK_DIR`. Reuses `readAckFile` per physical file
 * (same absent/empty/unparseable rules for a fragment as for the legacy file — one
 * definition, not a second one per source) and `mergeAckSources` (tests/helpers/
 * emitted-diff.cjs) for the union + duplicate-key detection.
 *
 * Returns `{ doc: null, errors: [] }` only when NEITHER the legacy file nor any
 * fragment exists — the healthy steady state matching `readAckFile`'s own `null`
 * contract, so callers can keep testing `ack === null` to decide whether the base side
 * needs consulting at all (avoiding the deadlock `readAckFileAtRef`'s doc comment
 * describes for a corrupt base).
 *
 * @returns {{ doc: {version: number, paths: object} | null, errors: string[] }}
 */
function readAckSources({ legacyPath = ACK_PATH, fragmentsDir = ACK_DIR } = {}) {
  const docs = [];
  if (fs.existsSync(legacyPath)) {
    docs.push({ source: ACK_REPO_PATH, doc: readAckFile(legacyPath) });
  }
  for (const name of listAckFragmentFiles(fragmentsDir)) {
    docs.push({
      source: `${ACK_DIR_REPO_PATH}/${name}`,
      doc: readAckFile(path.join(fragmentsDir, name)),
    });
  }
  if (docs.length === 0) return { doc: null, errors: [] };
  const { merged, errors } = mergeAckSources(docs);
  return { doc: merged, errors };
}

/**
 * Read + union every ack source AT `base` (#2914): the legacy single file plus every
 * fragment, as they existed at that ref. Mirrors `readAckSources` above, one ref-read
 * per physical source via `readAckFileAtRef`'s now-generalized `repoPath` option.
 *
 * Base-side merge/schema errors are DELIBERATELY DISCARDED, matching this module's
 * existing precedent for the base side (see `diffEmitted`'s caller below: "Base-side
 * SCHEMA errors are deliberately discarded... a document we cannot read simply inherits
 * nothing — which is the ARMED reading"). A cross-fragment collision found only at the
 * base is `next`'s own health, not this diff's to answer for; `mergeAckSources`'s
 * first-source-wins fallback for a duplicate key is still the STRICT reading here (an
 * entry can only be "spent" against the ONE reason kept, never either of two), so
 * discarding the error text costs no protection while avoiding a lint-clean PR being
 * blocked by a historical duplicate it did not introduce and cannot fix by itself.
 *
 * A genuine READ failure (corrupt JSON, unreadable object) on any single source still
 * throws, exactly as `readAckFileAtRef` already does — only the schema/collision
 * bookkeeping is discarded, never a fault.
 *
 * @returns {{ doc: {version: number, paths: object} | null }}
 */
function readAckSourcesAtRef(base, { cwd = REPO_ROOT, run = git } = {}) {
  const docs = [];
  const legacyDoc = readAckFileAtRef(base, { cwd, run });
  if (legacyDoc !== null) docs.push({ source: ACK_REPO_PATH, doc: legacyDoc });
  for (const name of listAckFragmentFilesAtRef(base, { cwd, run })) {
    const relPath = `${ACK_DIR_REPO_PATH}/${name}`;
    const doc = readAckFileAtRef(base, { cwd, run, repoPath: relPath });
    if (doc !== null) docs.push({ source: relPath, doc });
  }
  if (docs.length === 0) return { doc: null };
  const { merged } = mergeAckSources(docs);
  return { doc: merged };
}

/**
 * Base-ref candidates, most-specific first.
 *
 * The differential needs a ref for `next`, and that ref is NOT universally present:
 *   - the gsd-test runner shallow-clones and merges base+head, so no `origin/*`
 *     remote-tracking refs exist in the container (verified: `git rev-parse
 *     origin/next` fails there, which is what turned this test red on its first run);
 *   - GitHub Actions' checkout does not create remote-tracking branches for OTHER
 *     branches by default, which is exactly why `changeset-required.yml` carries an
 *     explicit `git fetch origin "${BASE_REF}:refs/remotes/origin/${BASE_REF}"` step.
 *
 * `GSD_EMITTED_BASE` lets a lane name the ref (or sha) directly. `GITHUB_BASE_REF` is
 * set by Actions on pull_request events.
 */
function baseRefCandidates(env = process.env) {
  const candidates = [];
  if (env.GSD_EMITTED_BASE) candidates.push(env.GSD_EMITTED_BASE);
  if (env.GITHUB_BASE_REF) {
    candidates.push(`origin/${env.GITHUB_BASE_REF}`, env.GITHUB_BASE_REF);
  }
  candidates.push('origin/next', 'next');
  return [...new Set(candidates)];
}

/**
 * First candidate base ref that actually resolves, or null when none do.
 *
 * Returning null is NOT a pass — the caller turns it into an explicit `t.skip()` with
 * the full candidate list in the message, so an environment where the gate did not run
 * says so out loud. A bare `return` there would be a PASS (ADR-2719 §6), and a hard
 * failure would make the suite permanently red in the gsd-test container, where no
 * base ref can exist by construction.
 */
function resolveBase(env = process.env) {
  for (const candidate of baseRefCandidates(env)) {
    try {
      const sha = git(['rev-parse', '--verify', `${candidate}^{commit}`]).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return { ref: candidate, sha };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Family names present in the fixture directory AT `base`.
 *
 * Enumerated from the ref itself, NOT from `MANIFEST_FAMILIES` — that constant is
 * imported at module load and therefore describes PR HEAD's registry. Deriving the
 * baseline from it makes a REMOVED runtime invisible: the name is already gone from the
 * current registry, so the loop never asks the base ref for it, `baseline` silently omits
 * a family that genuinely existed, and the dropped-family check can never fire. Asking
 * the ref what it actually contains is the only way the "before" side is really "before".
 *
 * NOT called by the real-tree test's production path as of #2724 (ADR-2719 Phase 4) —
 * `buildBaselineAtRef` + `resolveBaseline()` replaced it, since the fixture directory
 * this reads no longer exists at any ref from the cutover commit forward. Kept
 * (alongside `baselineManifestsAtRef`/`baselineSizesAtRef` below) because it still
 * answers a real question for a REF THAT PREDATES THE CUTOVER — bisecting into the
 * dual-run window (#2723) or earlier — and its own regression test below pins a real
 * property (the baseline must reflect the ref, not the current registry) that would
 * otherwise go untested.
 */
function baselineFamilyNamesAtRef(base, { cwd = REPO_ROOT } = {}) {
  let out;
  try {
    out = git(['ls-tree', '--name-only', base, `${FIXTURE_SUBDIR}/`], { cwd });
  } catch {
    return []; // fixtures absent at that ref (e.g. after Phase 4's cutover)
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.json'))
    .map((line) => line.slice(line.lastIndexOf('/') + 1).replace(/\.json$/, ''))
    // These names become object keys below. They now come from git output rather than a
    // trusted constant, so a fixture committed as `__proto__.json` would turn
    // `manifests[name] = parsed` into a prototype write. Compared inline (not via a Set)
    // because that is the form the prototype-pollution analysis recognizes.
    .filter((name) => name !== '__proto__' && name !== 'constructor' && name !== 'prototype');
}

/**
 * Emitted manifest set at `base`, read from the committed fixtures at that ref.
 * Returns null when the fixtures are absent at `base` (i.e. after Phase 4's cutover),
 * which is the signal to fall back to `resolveBaseline`'s cache path.
 */
function baselineManifestsAtRef(base = 'origin/next') {
  const manifests = {};
  let found = 0;
  for (const name of baselineFamilyNamesAtRef(base)) {
    let raw;
    try {
      raw = git(['show', `${base}:${FIXTURE_SUBDIR}/${name}.json`]);
    } catch {
      continue; // absent at that ref
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`emitted-attribution: ${base}:${FIXTURE_SUBDIR}/${name}.json is not valid JSON: ${err.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`emitted-attribution: ${base}:${FIXTURE_SUBDIR}/${name}.json must be an object of path->hash`);
    }
    manifests[name] = parsed;
    found++;
  }
  return found === 0 ? null : manifests;
}

/**
 * Build the baseline artifact at `ref` FOR REAL — a throwaway `git worktree` checked
 * out at `ref`, MEASURED by `cwd`'s (the calling checkout's) OWN
 * `scripts/gen-emitted-baseline.cjs` (#2724/#2767, ADR-2719 §5's "in-job build at
 * origin/next" fallback).
 *
 * ── Why the generator runs from `cwd`, not from the worktree ─────────────────────
 * `scripts/gen-emitted-baseline.cjs` was ADDED by the same PR that deleted the golden
 * fixtures this fallback used to read instead (#2724). A base ref that predates that PR
 * — which is every `next` this fallback is ever asked to measure, since the fallback
 * only runs on a cache miss for a ref that has not been through the publish job yet —
 * therefore never has the script at `<worktreeDir>/scripts/gen-emitted-baseline.cjs`,
 * and invoking it there fails closed with `Cannot find module` on every single call: the
 * fallback could never bootstrap. Running `cwd`'s copy instead, with `--dir worktreeDir`
 * telling it WHICH tree's installer to measure, isn't merely the workaround for that —
 * it is the more correct differential semantics regardless: a diff needs ONE measurement
 * schema applied to BOTH sides, or the sides stop being comparable the moment that
 * schema evolves (a new exclusion rule, a new manifest family) between the two commits.
 * Letting each side measure itself with its own, potentially different, version of the
 * script would silently reintroduce exactly that incomparability.
 *
 * This is the slow path, used only on a `resolveBaseline()` cache miss. The worktree
 * needs no `npm ci`: `bin/install.js` and the `tests/helpers/*.cjs` real-tree shells are
 * all Node-builtins-only (CONTRIBUTING.md's "No external dependencies in core"). It DOES
 * need `npm run build:lib` run there first, though — `tests/helpers/install-shared.cjs`
 * requires the TSC-COMPILED `gsd-core/bin/lib/runtime-artifact-layout.cjs`, which is
 * gitignored, not committed, and therefore absent from a bare worktree checkout, and
 * `<worktreeDir>/bin/install.js` (spawned BY `cwd`'s generator via `currentManifests`'s
 * `repoRoot` override) needs its own compiled copy alongside it, not `cwd`'s. `node_modules`
 * is symlinked in from the calling checkout (never copied — `npm ci` inside every
 * fallback build would make an already-slow path far slower) so `tsc` is available
 * without a second install; the worktree's OWN `src/*.cts` and `tsconfig.build.json`
 * are what gets compiled, so the MEASURED installer reflects `ref`, not `cwd`'s tree —
 * only the measurement CODE (the generator, install-shared.cjs, emitted-runtime.cjs)
 * comes from `cwd`.
 *
 * Every subprocess is bounded. The worktree is always removed, success or failure —
 * a leaked worktree would poison `git worktree list` for every subsequent run in the
 * same checkout (CI runners reuse the same clone across jobs in some configurations).
 *
 * @param {string} ref     the ref/sha to build at (e.g. `origin/next`, a 40-hex sha)
 * @param {object} [o]
 * @param {string} [o.cwd] repo to run `git worktree` from AND whose generator measures it
 * @returns {object} the parsed baseline artifact ({version, sha, manifests, sizes})
 */
const WORKTREE_TIMEOUT_MS = 60_000;
const BUILD_LIB_TIMEOUT_MS = 180_000;
// 360s for the generator step. NOT the 600000ms `local/no-unbounded-spawn`
// ceiling: `scripts/run-tests.cjs:973` bounds the WHOLE chunk at 600000ms, so a
// step bound equal to it loses the race — the chunk is killed first and the
// failure arrives as an opaque "no failed step" kill instead of the per-step
// message below. The bounds must escalate inward-out, and
// `emitted-runtime-bounds` in tests/emitted-attribution.test.cjs locks that.
//
// Measured for this step: ~22s idle in a container, ~142s with 8 CPU burners on
// 8 cores, 91.6s and 115.8s in the run that passed, and 300.1s in the run that
// timed out (censored — its real need is unknown). 360s is ~3x the passing
// observation and 20% above the censored one, while leaving 240s of chunk
// headroom for every other file sharing the chunk.
//
// The old 300s sat INSIDE that variance band. Under gsd-test this slow path runs
// on every verification, because the on-disk baseline cache is restored by
// actions/cache keyed on github.event.pull_request.base.sha — a key that exists
// only inside GitHub Actions. The real remedy is making that cache reachable from
// the remote runner so the in-job build returns to being the rare fallback
// ADR-2719 §5 describes; that is a gsd-test-runner change, not one this repo can
// make.
const BUILD_TIMEOUT_MS = 360_000;
// Mirrors `scripts/run-tests.cjs:973`'s default. Duplicated deliberately and
// narrowly: the bounds here must be checkable against it, and the alternative is
// reading that script's source, which `local/no-source-grep` bans. The lock test
// names this as the drift risk.
const CHUNK_TIMEOUT_CEILING_MS = 600_000;

function buildBaselineAtRef(ref, { cwd = REPO_ROOT } = {}) {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-emitted-baseline-wt-'));
  // mkdtempSync already created the directory; `git worktree add` requires the
  // target to not exist (or be empty) — remove it and let git recreate it.
  fs.rmdirSync(worktreeDir);
  const outFile = path.join(os.tmpdir(), `gsd-emitted-baseline-out-${crypto.randomBytes(8).toString('hex')}.json`);

  // Per-step timings, carried into the thrown error. A bare "spawnSync ETIMEDOUT"
  // names neither the step nor its elapsed time, which is exactly the information
  // needed to tell a slow machine from a hung step — and the failure message is
  // the only channel that survives into the remote runner's failures.json.
  const timings = [];
  const timed = (step, fn) => {
    const started = Date.now();
    try {
      const value = fn();
      timings.push(`${step}=${((Date.now() - started) / 1000).toFixed(1)}s`);
      return value;
    } catch (err) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      timings.push(`${step}=FAILED@${elapsed}s`);
      const partial = [
        err && err.stdout ? `stdout tail: ${String(err.stdout).trim().slice(-400)}` : '',
        err && err.stderr ? `stderr tail: ${String(err.stderr).trim().slice(-400)}` : '',
      ].filter(Boolean).join('\n  ');
      err.message =
        `${step} failed after ${elapsed}s (bounds: worktree ${WORKTREE_TIMEOUT_MS}ms, ` +
        `build:lib ${BUILD_LIB_TIMEOUT_MS}ms, generator ${BUILD_TIMEOUT_MS}ms). ` +
        `Step timings: ${timings.join(' ')}. ${err.message}` +
        (partial ? `\n  ${partial}` : '');
      throw err;
    }
  };

  try {
    timed('git-worktree-add', () =>
      execFileSync('git', [...safeDirArgs(cwd), 'worktree', 'add', '--detach', worktreeDir, ref], {
        cwd, encoding: 'utf8', timeout: WORKTREE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
      }));

    const sharedNodeModules = path.join(cwd, 'node_modules');
    if (fs.existsSync(sharedNodeModules)) {
      fs.symlinkSync(sharedNodeModules, path.join(worktreeDir, 'node_modules'), 'dir');
    }

    timed('npm-run-build-lib', () =>
      runNpm(['run', 'build:lib'], {
        cwd: worktreeDir, timeout: BUILD_LIB_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
      }));

    // Run `cwd`'s OWN generator (not the worktree's — see the function doc for why),
    // pointed at the worktree as the tree to measure.
    timed('gen-emitted-baseline', () =>
      execFileSync(
        process.execPath,
        [path.join(cwd, 'scripts', 'gen-emitted-baseline.cjs'), '--dir', worktreeDir, '--out', outFile],
        { cwd, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
      ));

    return timed('read-artifact', () => JSON.parse(fs.readFileSync(outFile, 'utf8')));
  } finally {
    try {
      execFileSync('git', [...safeDirArgs(cwd), 'worktree', 'remove', '--force', worktreeDir], {
        cwd, encoding: 'utf8', timeout: WORKTREE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Best-effort: the checkout may already be gone (e.g. the build step failed
      // before writing anything). Prune stale admin data rather than leaving it.
      try {
        execFileSync('git', [...safeDirArgs(cwd), 'worktree', 'prune'], {
          cwd, encoding: 'utf8', timeout: WORKTREE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { /* best-effort cleanup; never mask the primary result/error */ }
    }
    // Same guarantee as the git cleanup above: an EBUSY/EPERM here must not replace
    // whatever the `try` block was about to return or throw.
    try {
      fs.rmSync(outFile, { force: true });
    } catch { /* best-effort cleanup; never mask the primary result/error */ }
    try {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup; never mask the primary result/error */ }
  }
}

/** Size maps at `base`, for the ratchet half. Null when absent at that ref. */
function baselineSizesAtRef(base = 'origin/next') {
  const sizes = {};
  let found = 0;
  for (const rel of ['tests/workflow-size-baseline.json', 'tests/agent-size-baseline.json']) {
    try {
      const parsed = JSON.parse(git(['show', `${base}:${rel}`]));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(sizes, parsed);
        found++;
      }
    } catch { /* absent at that ref */ }
  }
  return found === 0 ? null : sizes;
}

/**
 * The package version of the tree whose emitted output is about to be measured.
 *
 * `bin/install.js` bakes `{{GSD_VERSION}}` -> `pkg.version` into every emitted hook,
 * and `buildParityManifest`'s `pkgVersion` normalization exists to collapse that stamp
 * back to '<VERSION>' so a version bump alone never moves a hash. That normalization is
 * only correct when `pkgVersion` matches the version of the tree that PRODUCED the
 * content being hashed — for `repoRoot`-driven cross-tree measurement (#2767, #2891)
 * that is NOT necessarily this checkout's own `PKG_VERSION`. This helper resolves the
 * right version for whichever tree is actually being measured.
 *
 * Fails closed: a missing, unreadable, unparseable, or version-less `package.json` at
 * `repoRoot` throws rather than silently falling back to this checkout's own version —
 * a silent fallback here is exactly the cross-tree mis-attribution bug #2891 fixes
 * (every emitted hook path would spuriously differ, and the differential attribution
 * gate would blame nothing for it).
 *
 * @param {string} [repoRoot] - absolute path to the tree being measured. Only an
 *   OMITTED (or explicit `undefined`) repoRoot means "this checkout" and returns this
 *   module's own PKG_VERSION with no I/O. Any OTHER falsy value (`''`, `0`, `false`) is
 *   NOT treated as "this checkout" — it is a caller-side bug (e.g. an unresolved path
 *   variable) and must fail closed rather than silently measuring the wrong tree,
 *   consistent with `currentManifests`' `installScript` gate below and with how
 *   `buildParityManifest`'s `pkgVersion` treats an explicit-but-empty value as a caller
 *   error rather than a fallback trigger (#2891 review FINDING 7).
 * @returns {string} non-empty package version string.
 */
function measuredPackageVersion(repoRoot) {
  if (repoRoot === undefined) return PKG_VERSION;
  if (!repoRoot) {
    throw new Error(
      `measuredPackageVersion: repoRoot must be a non-empty path or omitted entirely, got ${JSON.stringify(repoRoot)}. ` +
      'An omitted/undefined repoRoot means "this checkout"; any other falsy value is treated as a caller error.'
    );
  }

  const pkgPath = path.join(repoRoot, 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch (err) {
    throw new Error(
      `measuredPackageVersion: cannot read ${pkgPath} (${err.message}); cannot normalize ` +
      'emitted version for the measured tree; a wrong version silently mis-attributes every hook.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `measuredPackageVersion: ${pkgPath} is not valid JSON (${err.message}); cannot normalize ` +
      'emitted version for the measured tree; a wrong version silently mis-attributes every hook.'
    );
  }

  const version = parsed && parsed.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
      `measuredPackageVersion: ${pkgPath} has no non-empty string "version" field; cannot ` +
      'normalize emitted version for the measured tree; a wrong version silently mis-attributes every hook.'
    );
  }
  return version;
}

/**
 * Build the CURRENT emitted manifest set for real — one installer spawn per runtime.
 * This is the expensive, honest half: it reflects what the tree actually emits now,
 * not what the author regenerated into a fixture.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Measure a DIFFERENT checkout's installer instead of
 *   this one's (#2767). When set, `<repoRoot>/bin/install.js` is spawned rather than
 *   THIS checkout's `bin/install.js` — the measurement schema (this function, the
 *   exclusion rules in install-shared.cjs) stays fixed at the caller's version while the
 *   installer code being measured varies. This is what lets `gen-emitted-baseline.cjs`
 *   apply ONE definition of "the emitted manifest" to two different trees (PR HEAD and a
 *   base-ref worktree) so the two sides stay comparable even if the definition itself
 *   evolves — running the OTHER tree's own (older, or absent) copy of this function would
 *   defeat that.
 *
 *   The version normalized into '<VERSION>' inside each manifest entry is resolved via
 *   `measuredPackageVersion(repoRoot)` — i.e. `<repoRoot>/package.json`'s own version,
 *   NOT this checkout's — since `<repoRoot>/bin/install.js` is what stamped the emitted
 *   content in the first place (#2891).
 */
function currentManifests({ repoRoot } = {}) {
  // Gated the same way `measuredPackageVersion` gates its own repoRoot below: only an
  // omitted/`undefined` repoRoot means "this checkout" (installScript stays the
  // default). Any other falsy value falls through to `measuredPackageVersion`, which
  // throws — this line never gets a chance to diverge from that same rule (#2891
  // review FINDING 7).
  const installScript = repoRoot !== undefined ? path.join(repoRoot, 'bin', 'install.js') : undefined;
  const pkgVersion = measuredPackageVersion(repoRoot);
  const manifests = {};
  for (const { name, runtime, scope } of MANIFEST_FAMILIES) {
    const { configDir, root } = runMinimalInstall({ runtime, scope, installScript });
    try {
      manifests[name] = buildParityManifest(configDir, root, {
        pkgVersion,
        // #3738: cover home-override emit roots outside configDir (antigravity
        // → <HOME>/.gemini/config) so the differential keeps seeing them.
        extraEmitRoots: extraEmitRootsFor(runtime, scope, root),
      });
    } finally {
      cleanup(root);
    }
  }
  return manifests;
}

/**
 * Current on-disk sizes for the workflow + agent families the ratchet covers.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Read `<repoRoot>/gsd-core/workflows` and
 *   `<repoRoot>/agents` instead of this checkout's own (#2767) — same rationale as
 *   `currentManifests`'s `repoRoot`.
 */
function currentSizes({ repoRoot = REPO_ROOT } = {}) {
  const sizes = {};
  for (const [dir, filter] of [
    [path.join(repoRoot, 'gsd-core', 'workflows'), (f) => f.endsWith('.md')],
    [path.join(repoRoot, 'agents'), (f) => f.endsWith('.md')],
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !filter(entry.name)) continue;
      sizes[entry.name] = fs.statSync(path.join(dir, entry.name)).size;
    }
  }
  return sizes;
}

/**
 * Read `tests/emitted-drift-ack.json`.
 * Absent is legal and means "no acks" — its PRESENCE is the alarm (ADR §3).
 * A present-but-unreadable or unparseable file THROWS: silently treating it as absent
 * would disarm the gate in the one case where someone is actively using it.
 */
function readAckFile(ackPath = ACK_PATH) {
  if (!fs.existsSync(ackPath)) return null;
  const raw = fs.readFileSync(ackPath, 'utf8');
  if (raw.trim() === '') {
    throw new Error(`emitted-attribution: ${path.basename(ackPath)} is present but empty`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`emitted-attribution: ${path.basename(ackPath)} is not valid JSON: ${err.message}`);
  }
}

module.exports = {
  REPO_ROOT,
  ACK_PATH,
  ACK_REPO_PATH,
  ACK_DIR,
  ACK_DIR_REPO_PATH,
  readAckFileAtRef,
  listAckFragmentFiles,
  listAckFragmentFilesAtRef,
  readAckSources,
  readAckSourcesAtRef,
  FIXTURE_SUBDIR,
  MANIFEST_FAMILIES,
  MINIMUM_MANIFEST_FAMILIES,
  REGISTRY_SIGNAL_PATHS,
  FAMILY_REASON,
  touchesRuntimeRegistry,
  reconcileFamilies,
  GIT_TIMEOUT_MS,
  safeDirArgs,
  git,
  resolveChangedPaths,
  resolveBaseSha,
  baseRefCandidates,
  resolveBase,
  baselineFamilyNamesAtRef,
  baselineManifestsAtRef,
  baselineSizesAtRef,
  buildBaselineAtRef,
  measuredPackageVersion,
  currentManifests,
  currentSizes,
  readAckFile,
  WORKTREE_TIMEOUT_MS,
  BUILD_LIB_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  CHUNK_TIMEOUT_CEILING_MS,
};
