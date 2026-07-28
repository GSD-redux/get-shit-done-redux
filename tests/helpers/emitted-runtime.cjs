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
  RUNTIME_META,
  runMinimalInstall,
  buildParityManifest,
} = require('./install-shared.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ACK_PATH = path.join(REPO_ROOT, 'tests', 'emitted-drift-ack.json');
const FIXTURE_SUBDIR = 'tests/fixtures/golden-install-parity';

/**
 * The emitted manifest families, as (fixtureName -> install spec).
 *
 * NOT simply `Object.keys(RUNTIME_META)`: that has 18 entries while the fixture set has
 * 19. The extra one is `claude-local` — claude is the reference host and the ONLY
 * runtime with a distinct LOCAL "legacy flat-commands" layout (`commands/gsd-*.md` +
 * `agents/gsd-*.md` at project scope), which `golden-install-parity.test.cjs` guards
 * with a hand-coded test outside its RUNTIME_META loop (#2086).
 *
 * Enumerating from RUNTIME_META alone dropped that family from BOTH sides of the
 * differential, so a same-count self-check (18 === 18) passed vacuously and a PR
 * changing Claude's local-scope output would fail the golden while this check reported
 * ok. That disagreement is exactly what the dual-run window is meant to surface as a
 * provenance-table hole — so a wiring omission masquerading as one is the worst
 * possible failure here. Derived explicitly, and asserted against the fixture count.
 */
const MANIFEST_FAMILIES = [
  ...Object.keys(RUNTIME_META).map((runtime) => ({ name: runtime, runtime, scope: 'global' })),
  { name: 'claude-local', runtime: 'claude', scope: 'local' },
];

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
 * Emitted manifest set at `base`, read from the committed fixtures at that ref.
 * Returns null when the fixtures are absent at `base` (i.e. after Phase 4's cutover),
 * which is the signal to fall back to `resolveBaseline`'s cache path.
 */
function baselineManifestsAtRef(base = 'origin/next') {
  const manifests = {};
  let found = 0;
  for (const { name } of MANIFEST_FAMILIES) {
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
  GIT_TIMEOUT_MS,
  git,
  resolveChangedPaths,
  resolveBaseSha,
  baseRefCandidates,
  resolveBase,
  baselineManifestsAtRef,
  baselineSizesAtRef,
  currentManifests,
  currentSizes,
  readAckFile,
};
