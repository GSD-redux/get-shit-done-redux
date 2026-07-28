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
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('../helpers.cjs');
const {
  MANIFEST_FAMILIES,
  MINIMUM_MANIFEST_FAMILIES,
  runMinimalInstall,
  buildParityManifest,
} = require('./install-shared.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ACK_PATH = path.join(REPO_ROOT, 'tests', 'emitted-drift-ack.json');
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

function git(args, { cwd = REPO_ROOT } = {}) {
  return execFileSync('git', args, {
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
 * Build the CURRENT emitted manifest set for real — one installer spawn per runtime.
 * This is the expensive, honest half: it reflects what the tree actually emits now,
 * not what the author regenerated into a fixture.
 */
function currentManifests() {
  const manifests = {};
  for (const { name, runtime, scope } of MANIFEST_FAMILIES) {
    const { configDir, root } = runMinimalInstall({ runtime, scope });
    try {
      manifests[name] = buildParityManifest(configDir, root);
    } finally {
      cleanup(root);
    }
  }
  return manifests;
}

/** Current on-disk sizes for the workflow + agent families the ratchet covers. */
function currentSizes() {
  const sizes = {};
  for (const [dir, filter] of [
    [path.join(REPO_ROOT, 'gsd-core', 'workflows'), (f) => f.endsWith('.md')],
    [path.join(REPO_ROOT, 'agents'), (f) => f.endsWith('.md')],
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
  FIXTURE_SUBDIR,
  MANIFEST_FAMILIES,
  MINIMUM_MANIFEST_FAMILIES,
  REGISTRY_SIGNAL_PATHS,
  FAMILY_REASON,
  touchesRuntimeRegistry,
  reconcileFamilies,
  GIT_TIMEOUT_MS,
  git,
  resolveChangedPaths,
  resolveBaseSha,
  baseRefCandidates,
  resolveBase,
  baselineFamilyNamesAtRef,
  baselineManifestsAtRef,
  baselineSizesAtRef,
  currentManifests,
  currentSizes,
  readAckFile,
};
