#!/usr/bin/env node
'use strict';

/**
 * #2665 — post-suite hermeticity guard.
 *
 * The test suite must never write into a runtime's LIVE config directory. Two
 * mechanisms defend that, and neither one can see this failure:
 *
 *   - `TEST_ENV_BASE` (tests/helpers.cjs) blanks every config-location env var,
 *     but only for CHILD processes. A test that calls the installer IN-PROCESS
 *     is untouched by it.
 *   - CI is blind to the ambient-env half of the class outright, because CI
 *     never has `CLAUDE_CONFIG_DIR` and friends set.
 *
 * So the class is silent by construction: it damages the developer's machine and
 * reports nothing. #2665 records two prior authors each diagnosing it and fixing
 * only the instance in front of them. This module converts it from silent to
 * loud by snapshotting GSD's own install footprint before the suite and
 * re-checking it after.
 *
 * LOCATION — `scripts/`, deliberately NOT `scripts/lib/`. The installer copies
 * `scripts/lib/` into every user's config dir wholesale (readdirSync), while
 * uninstall removes only an explicit allowlist, so a test-only module placed
 * there would ship to users AND survive uninstall. This file is also excluded
 * from the npm tarball (`package.json` `files[]` `!scripts/live-config-guard.cjs`,
 * alongside its whole require chain: run-tests.cjs, affected-tests-lib.cjs,
 * run-affected-tests.cjs — excluding one link alone would trip the #2858
 * shipped-requires-only-shipped gate on the links that still shipped).
 *
 * SCOPE — ownership-based, not whole-root. It watches entries GSD unambiguously
 * owns: the top-level install footprint (`GSD_OWNED_ENTRIES`) plus `gsd-`-prefixed
 * children of the dirs GSD shares with the host agent (`GSD_PREFIXED_PARENTS`).
 * It does NOT watch whole config roots. A root such as `~/.claude` is shared with
 * the host agent, which may legitimately write `history.jsonl`, `todos/`, or
 * `settings.json` while the suite runs; watching the root would turn that into a
 * false failure, and a guard that cries wolf gets disabled — after which it
 * catches nothing at all.
 *
 * The ownership test is the prefix, not the location. That distinction is load
 * bearing: the first version of this guard watched only the three top-level
 * entries and MISSED a real leak into `<live>/skills/gsd-dev-preferences/`.
 *
 * KNOWN GAP — a leak into a file GSD does not own (e.g. mutating the host's own
 * `.claude.json`, `settings.json`, `hooks.json`, `kilo.json`, `opencode.json`) is
 * outside this guard by construction. Closing it would require watching shared
 * files, which is the false-positive trap above.
 *
 * NAMED RESIDUALS — stated rather than implied, because two successive rounds
 * asserted this list was complete and both were refuted. Still NOT watched:
 *   - `agents/subagents/**` (kimi stages `subagents/gsd-executor.yaml` under an
 *     UNPREFIXED intermediate dir, so no prefix scan of `agents/` reaches it);
 *   - the loose capability generators copied to `<root>/scripts/*.cjs`
 *     (`fix-slash-commands.cjs` is watched by name; the generators are not);
 *   - `extensions/package.json` and `plugins/package.json` — CommonJS markers in
 *     dirs GSD fills but does not own, so they fall under the shared-ground rule
 *     below rather than being watched;
 *   - the shared-hooks bundle in a NON-registry root's `<root>/hooks/` (kimi) —
 *     see resolveExtraWatchTargets; closing it is a layout decision.
 * DELIBERATELY not watched, which is a different thing from missed: `hooks/lib`,
 * `hooks/package.json`, `scripts/lib` and `scripts/changeset`. The installer
 * preserves foreign files in each, so watching them wholesale produces false
 * positives — and a guard that cries wolf gets switched off.
 * Every item above under-watches, which fails quiet: a missed leak, never a
 * false alarm.
 *
 * SEVERITY — reports by default, fails only under GSD_STRICT_LIVE_CONFIG_GUARD=1.
 * Not timidity: on its first CI run this guard found PRE-EXISTING leaks on the
 * Windows lane (`C:\Users\runneradmin\.claude\gsd-core` and
 * `skills\gsd-dev-preferences`), because os.homedir() reads USERPROFILE there and
 * ~190 test sites sandbox HOME alone. Those are real and worth fixing, but they
 * are a different defect class from the one #2665 closes, and a brand-new gate
 * that immediately reds an unrelated lane gets bypassed or reverted rather than
 * obeyed. This repo already has the pattern: the local/no-source-grep ESLint rule
 * shipped at `warn` and was promoted to `error` after its cleanup sweep (ADR 452).
 * Promote this the same way once the USERPROFILE sweep lands.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Top-level entries only a GSD install creates. See SCOPE above before widening.
 *
 * `.gsd-source` and `.gsd-profile` were added by the round-5 census (see below):
 * bin/install.js writes both at the config ROOT for a global install, and an
 * exact-name list does not match a dot-prefixed name by the `gsd-` prefix rule.
 */
const GSD_OWNED_ENTRIES = [
  'gsd-core',
  'gsd-file-manifest.json',
  'gsd-pristine',
  '.gsd-source',
  '.gsd-profile',
];

/**
 * Directories GSD SHARES with the host agent. Watching them wholesale would
 * false-positive on the host's own writes, so only `gsd-`-prefixed children are
 * watched — those are unambiguously ours.
 *
 * Added after the first version of this guard MISSED a real leak: a raw
 * `spawnSync` that sandboxed HOME but inherited an ambient CLAUDE_CONFIG_DIR
 * wrote `<live>/skills/gsd-dev-preferences/SKILL.md`, which sits under none of
 * the three top-level entries above.
 *
 * `hooks` joined them in round 5, found by re-deriving the census rather than by
 * a review finding — the SAME shape one parent over. bin/install.js writes
 * `hooks/gsd-check-update.js`, `hooks/gsd-context-monitor.js` and
 * `hooks/gsd-update-banner.js` into the config root, and with `hooks` absent from
 * this list a leak of any of them passed the guard silently. The lesson the first
 * miss taught is that this list is the weak point, so it is re-derived from the
 * installer's own write sites each round rather than trusted.
 */
const GSD_PREFIXED_PARENTS = ['agents', 'commands', 'skills', 'hooks'];
const GSD_ARTIFACT_PREFIX = 'gsd-';

/**
 * Artifact parents that are NOT registry-declared — the installer writes these
 * directly rather than through a capability's artifactLayout.
 */
const NON_REGISTRY_ARTIFACT_PARENTS = ['hooks', 'plugins', 'scripts', 'extensions'];

/**
 * Prefixes used for a parent with no registry-declared one. BOTH forms are the
 * point: GSD writes `gsd-`-hyphen artifacts (`hooks/gsd-check-update.js`) AND
 * bare `gsd.`-dotted ones (pi's `extensions/gsd.js`), and a lone `gsd-` sees
 * only the first.
 */
const DEFAULT_ARTIFACT_PREFIXES = ['gsd-', 'gsd.'];

/**
 * Files GSD owns by EXACT NAME inside a directory it shares — deliberately NOT
 * the directories themselves.
 *
 * `hooks/lib`, `hooks/package.json`, `scripts/lib` and `scripts/changeset` were
 * watched wholesale for exactly one commit, and that was wrong: the installer's
 * own uninstall path preserves foreign files in every one of them (it removes the
 * CommonJS marker only on an exact content match — "a user-authored package.json
 * is never deleted"). Watching them wholesale turns a user editing their own
 * helper into a violation, which is the false-positive trap the SCOPE note above
 * exists to refuse. Under-watching fails quiet; over-watching disarms the guard.
 */
const GSD_OWNED_NESTED = [
  'scripts/fix-slash-commands.cjs',
  'hooks/managed-hooks-registry.cjs',
];

/**
 * DERIVE the artifact parents from the capability registry rather than naming
 * them, for the same reason TEST_ENV_BASE derives its keys: a hand-list is only
 * ever as complete as its author's recall, and this one was measurably not.
 *
 * Round 5's adversarial review found the hand-list missing Kilo's SINGULAR
 * `command/`, `workflows/`, and Hermes' `skills/gsd` -- the last being a whole
 * directory whose name carries no `gsd-` prefix, so no prefix rule reaches it.
 * A capability that declares a new destSubpath now extends this set in the same
 * commit that declares it.
 *
 * @returns {{parents: string[], owned: string[]}} parents = watch gsd-prefixed
 *   children only; owned = watch the path wholesale (its own name is GSD's).
 */
function deriveArtifactTargets(runtimes) {
  const parents = new Map();
  const addParent = (dest, prefixes) => {
    if (!parents.has(dest)) parents.set(dest, new Set());
    for (const pre of prefixes) parents.get(dest).add(pre);
  };
  for (const dest of [...GSD_PREFIXED_PARENTS, ...NON_REGISTRY_ARTIFACT_PARENTS]) {
    addParent(dest, DEFAULT_ARTIFACT_PREFIXES);
  }
  const owned = new Set(GSD_OWNED_NESTED);
  for (const entry of Object.values(runtimes || {})) {
    for (const layout of entry?.runtime?.artifactLayout?.global ?? []) {
      const dest = layout?.destSubpath;
      if (typeof dest !== 'string' || !dest) continue;
      const last = dest.split('/').pop() || '';
      // A destination whose own final segment is GSD's (hermes' `skills/gsd`) is
      // owned wholesale — that directory is ours, not shared.
      if (last.startsWith('gsd')) { owned.add(dest); continue; }
      // The layout declares its OWN prefix, and it varies: kimi's `kimi-agents`
      // layout declares `gsd` (no hyphen) and writes `agents/gsd.yaml` +
      // `agents/gsd.md`, invisible to a fixed `gsd-` scan. The same destSubpath
      // also carries different prefixes across runtimes, so a parent maps to a SET.
      const declared = typeof layout?.prefix === 'string' && layout.prefix
        ? [layout.prefix]
        : DEFAULT_ARTIFACT_PREFIXES;
      addParent(dest, declared);
    }
  }
  const out = {};
  for (const [dest, set] of [...parents.entries()].sort()) out[dest] = [...set].sort();
  return { parents: out, owned: [...owned].sort() };
}

/** Memoized registry-derived targets; falls back to the static lists unbuilt. */
let _artifactTargets = null;
function artifactTargets(deps = {}) {
  if (_artifactTargets && !deps.libDir) return _artifactTargets;
  const libDir = deps.libDir || path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
  let runtimes;
  try {
    ({ runtimes } = require(path.join(libDir, 'capability-registry.cjs')));
  } catch {
    // Unbuilt tree: the static lists are a strict subset, never a wrong answer.
    return deriveArtifactTargets(null);
  }
  const derived = deriveArtifactTargets(runtimes);
  if (!deps.libDir) _artifactTargets = derived;
  return derived;
}

/**
 * The file GSD writes into a NON-REGISTRY config home.
 *
 * Both current descriptors are Kimi's — Kimi CLI's `~/.kimi` (KIMI_SHARE_DIR) and
 * Kimi Code's `~/.kimi-code` (KIMI_CODE_HOME) — and GSD writes its native
 * `[[hooks]]` block into `config.toml` in each, so the single filename below holds
 * for both. NAMED RESIDUAL: this assumes every non-registry descriptor is written
 * the same way. That assumption is now load-bearing rather than vacuous — it is
 * carrying two descriptors, not one — and a future descriptor whose owned file
 * differs needs a per-descriptor mapping here. The consequence of getting it wrong
 * is under-watching (a missed leak), not a false positive, so it fails in the quiet
 * direction and is called out rather than left to be discovered.
 */
const NON_REGISTRY_OWNED_FILE = 'config.toml';

/**
 * Bounds on the recursive walk, so a pathological tree cannot stall the suite.
 *
 * MAX_ENTRIES is PER WATCH TARGET, not per snapshot. It was a single running
 * budget threaded across every target, which made the guard's verdict depend on
 * directory ORDER and on unrelated local state: one large early target exhausted
 * it, and every target scanned afterwards reported `truncated` -> `unverified`,
 * which under GSD_STRICT_LIVE_CONFIG_GUARD=1 is a failed run. Per-target means a
 * pathological tree truncates ITSELF and nothing else.
 *
 * MAX_TOTAL_ENTRIES keeps the aggregate bounded, which is what the single budget
 * was really for. It engages only when the per-target bounds together exceed it;
 * when it does, the targets it curtails are reported `unverified` -- never
 * silently clean.
 *
 * NAMED RESIDUAL, because the obvious stronger claim is FALSE: order-independence
 * holds BELOW the global ceiling, not above it. Once MAX_TOTAL_ENTRIES is
 * exhausted, which targets get curtailed still depends on iteration order -- that
 * is inherent to any shared aggregate bound, and the fix here removes the ordinary
 * case (one large target cascading over everything after it) rather than the
 * pathological one. The curtailed targets are reported `unverified`, so the
 * residual costs legibility, never a false clean.
 */
const MAX_ENTRIES = 20000;
const MAX_TOTAL_ENTRIES = 200000;
const MAX_DEPTH = 12;

/**
 * Resolve every runtime config root the product could write to, using the REAL
 * resolver rather than a reimplementation — the guard must watch wherever the
 * product actually points, including through an ambient env var.
 *
 * TWO resolutions, unioned, because the parent and its children do not resolve
 * the same way: the AMBIENT one (what this process sees, env-first) and the
 * FALLBACK one (what a child that BLANKED the config-location vars resolves to,
 * i.e. HOME-derived). Watching only the first leaves the second unwatched, which
 * is where a child that scrubs the var but not HOME actually writes.
 *
 * @returns {string[]} deduped, sorted roots; empty if the built lib is absent.
 */
function resolveLiveConfigRoots(deps = {}) {
  const libDir = deps.libDir || path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
  const homedir = (deps.os || os).homedir;
  let getGlobalConfigDir;
  let resolveConfigHomeFromDescriptor;
  let runtimes;
  try {
    ({ getGlobalConfigDir, resolveConfigHomeFromDescriptor } =
      require(path.join(libDir, 'runtime-homes.cjs')));
    ({ runtimes } = require(path.join(libDir, 'capability-registry.cjs')));
  } catch {
    // Unbuilt tree: the guard is advisory infrastructure and must never be the
    // reason a test run cannot start. Callers treat [] as "guard unavailable".
    return [];
  }

  const roots = new Set();

  // ── The FALLBACK roots, which the ambient resolution above cannot reach ────
  //
  // #2665 round 5: getGlobalConfigDir is env-first, so the loop below resolves
  // whatever THIS process sees. A spawned child does not see that — TEST_ENV_BASE
  // blanks the config-location vars precisely so the child cannot follow them —
  // and a blanked var is falsy, so the child falls back to its HOME-derived root
  // instead. A child that blanks the var and does NOT also sandbox HOME therefore
  // writes into the developer's real ~/.claude while the guard is watching the
  // ambient path, one process shallower. That is the exact escape route this PR
  // exists to close, taken one layer down.
  //
  // Derived, never re-listed: passing an EMPTY env to the real descriptor resolver
  // IS "what a child with no config-location vars resolves to". Deriving it this
  // way keeps the guard from carrying a second copy of the scrub set to drift
  // against -- the defect this PR spent three rounds closing one layer up.
  for (const entry of Object.values(runtimes || {})) {
    const descriptor = entry?.runtime?.configHome;
    if (!descriptor) continue;
    try {
      const dir = resolveConfigHomeFromDescriptor(descriptor, { env: {}, home: homedir() });
      if (typeof dir === 'string' && dir.length > 0) roots.add(path.resolve(dir));
    } catch {
      // Same posture as the ambient loop below.
    }
  }
  // grok resolves through a hardcoded branch rather than a descriptor, so its
  // fallback is stated here for the same reason it is named in the loop below.
  roots.add(path.resolve(path.join(homedir(), '.agents')));
  // 'grok' is a hardcoded branch of getGlobalConfigDir with no registry entry.
  //
  // DELIBERATE NON-ROOT: getGlobalSkillsBase(runtime) is NOT added here. The
  // skills base (e.g. codex's ~/.agents/skills) is not a config ROOT, and the
  // snapshot applies the config-root layout (GSD_OWNED_ENTRIES x
  // GSD_PREFIXED_PARENTS) beneath every root it is given — measured on a
  // sandboxed HOME, adding it both false-positives on `<skillsBase>/gsd-core`
  // and misses a real `<skillsBase>/gsd-help` write. Watching skills bases
  // needs its own layout, like resolveExtraWatchTargets — a separate change.
  for (const runtime of [...Object.keys(runtimes || {}), 'grok']) {
    try {
      const dir = getGlobalConfigDir(runtime);
      if (typeof dir === 'string' && dir.length > 0) roots.add(path.resolve(dir));
    } catch {
      // A descriptor the resolver cannot satisfy is not this module's problem.
    }
  }
  return [...roots].sort();
}

/**
 * Watch targets that are NOT runtime config roots, and so cannot be expressed as
 * `root x GSD_OWNED_ENTRIES`.
 *
 * #2665 round 3: resolveLiveConfigRoots enumerates getGlobalConfigDir per registry
 * runtime plus grok. A live write surface that is not a config ROOT is invisible to
 * that shape, so a leak on one passed through this guard — the PR's own safety net —
 * silently. There are THREE today ($GSD_HOME/.gsd, plus one config.toml per entry in
 * NON_REGISTRY_CONFIG_HOME_DESCRIPTORS, which #2755 took from one entry to two):
 *
 *   $GSD_HOME/.gsd  — GSD's user-owned store (consent.json, defaults.json, capability
 *                     overlays). Watched WHOLESALE: unlike ~/.claude this root is
 *                     exclusively ours, so the shared-root false-positive trap in
 *                     SCOPE above does not apply and an ownership filter would only
 *                     narrow the guard for nothing.
 *   <non-registry home>/config.toml — the file GSD writes its native [[hooks]] block
 *                     into, one per NON_REGISTRY_CONFIG_HOME_DESCRIPTORS entry: Kimi
 *                     CLI's ~/.kimi (KIMI_SHARE_DIR) and, since #2755, Kimi Code's
 *                     ~/.kimi-code (KIMI_CODE_HOME). The INVERSE case: those roots
 *                     belong to their products, so the root is never watched
 *                     wholesale. This is the KNOWN GAP above accepted deliberately
 *                     in one direction — GSD demonstrably writes these files
 *                     (bin/install.js resolves the hooks-toml dir at two sites), so
 *                     a concurrent write by those products is the only false
 *                     positive, and neither runs during the suite. NOT watched, and
 *                     it is a real residual rather than a bound: <root>/hooks/, the
 *                     bundle installSharedHooksBundle writes into the same roots —
 *                     see resolveExtraWatchTargets for why closing it is a layout
 *                     decision.
 *
 * @returns {string[]} absolute paths; empty if the built lib is absent.
 */
function resolveExtraWatchTargets(deps = {}) {
  const libDir = deps.libDir || path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
  const env = deps.env || process.env;
  const homedir = (deps.os || os).homedir;

  // BOTH resolutions, exactly as resolveLiveConfigRoots does — the ambient one and
  // the one a child that BLANKED the var falls back to. Watching only the ambient
  // path leaves the fallback unwatched, which is the same defect B3 closed for the
  // registry roots; it lived here too until round 5's adversarial review found it.
  const targets = [
    path.resolve(path.join(env.GSD_HOME || homedir(), '.gsd')),
    path.resolve(path.join(homedir(), '.gsd')),
  ];

  try {
    const {
      NON_REGISTRY_CONFIG_HOME_DESCRIPTORS,
      resolveConfigHomeFromDescriptor,
    } = require(path.join(libDir, 'runtime-homes.cjs'));

    // ITERATE the descriptor array rather than naming one resolver. Calling
    // resolveKimiHooksTomlDir directly would cover one of today's two entries and
    // silently miss tomorrow's — the same partial-enumeration defect that put
    // KIMI_SHARE_DIR outside the scrub set in the first place, reintroduced one
    // layer over. TEST_ENV_BASE derives its keys from this array; deriving the
    // guard's paths from it keeps the two halves from drifting apart.
    //
    // Thread the SAME injected env/home used above: resolving bare would read
    // process.env and os.homedir() regardless of `deps`, leaving the seam
    // untestable and the targets resolved against different worlds.
    for (const descriptor of NON_REGISTRY_CONFIG_HOME_DESCRIPTORS) {
      // The fallback leg, per the note above: a child that blanks KIMI_SHARE_DIR /
      // KIMI_CODE_HOME writes to the HOME-derived root instead of the ambient one.
      const fallbackDir = resolveConfigHomeFromDescriptor(descriptor, { env: {}, home: homedir() });
      if (typeof fallbackDir === 'string' && fallbackDir.length > 0) {
        targets.push(path.resolve(path.join(fallbackDir, NON_REGISTRY_OWNED_FILE)));
      }
      const dir = resolveConfigHomeFromDescriptor(descriptor, { env, home: homedir() });
      // The root belongs to the runtime, so it is never watched wholesale — only
      // the named file below.
      //
      // NAMED RESIDUAL (#2665, found pre-push while rebasing): config.toml is NOT
      // the only thing GSD writes here. bin/install.js also calls
      // installSharedHooksBundle(kimiHooksRoot), which populates <root>/hooks/
      // with GSD's hook scripts and a CommonJS marker. That subtree is UNWATCHED,
      // so a suite-produced leak of a hook bundle into a developer's real ~/.kimi
      // or ~/.kimi-code passes this guard silently. Closing it needs a layout
      // decision, not one more path: the same reason getGlobalSkillsBase is a
      // deliberate non-target above. Under-watching fails quiet, like the
      // NON_REGISTRY_OWNED_FILE residual it sits beside.
      targets.push(path.resolve(path.join(dir, NON_REGISTRY_OWNED_FILE)));
    }
  } catch {
    // Unbuilt tree — same posture as resolveLiveConfigRoots: advisory, never fatal.
  }
  // Both legs can coincide when no override is set; the snapshot keys on path,
  // but dedupe anyway so the RV-facing target count means what it says.
  return [...new Set(targets)];
}

/**
 * Newest mtime within a tree, bounded. Returns `truncated: true` when a bound
 * was hit — the caller must NOT report such a result as clean, on the same
 * principle that an existence probe passing vacuously is worse than no probe.
 */
function newestMtime(target, budget) {
  let newest = 0;
  let truncated = false;

  const walk = (current, depth) => {
    if (budget.remaining <= 0) { truncated = true; return; }
    if (depth > MAX_DEPTH) { truncated = true; return; }
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      return;
    }
    budget.remaining -= 1;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (!st.isDirectory()) return;
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      // RETURN, not continue: without this the loop keeps invoking walk() for
      // every remaining sibling after the budget is gone, so the ceiling bounds
      // what is RECORDED but not the work done getting there.
      if (budget.remaining <= 0) { truncated = true; return; }
      walk(path.join(current, entry), depth + 1);
    }
  };

  walk(target, 0);
  return { newest, truncated };
}

/**
 * Snapshot GSD-owned entries under each root.
 *
 * @returns {Record<string, {exists: boolean, newest: number, truncated: boolean}>}
 *   keyed by absolute entry path.
 */
function snapshotLiveConfig(roots, extraTargets = [], limits = {}) {
  // Clamp at 0: a negative injected limit would start the ceiling below empty and
  // make every target report truncated for a reason that is not a scan bound.
  // Number.isFinite, NOT Math.max: `Math.max(0, NaN)` is NaN, and every budget
  // comparison against NaN is false — the bound then fails OPEN and the walk is
  // unbounded, which is the single thing these constants exist to prevent.
  const finite = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback);
  const perTarget = finite(limits.perTarget, MAX_ENTRIES);
  const total = { remaining: finite(limits.total, MAX_TOTAL_ENTRIES) };
  const snap = {};

  const record = (target) => {
    if (!fs.existsSync(target)) {
      snap[target] = { exists: false, newest: 0, truncated: false };
      return;
    }
    // A FRESH budget per target, drawn against the global ceiling. See the
    // MAX_ENTRIES docblock: a shared running budget let one large early target
    // cascade `unverified` over every target scanned after it, so the verdict
    // depended on iteration order rather than on what the run actually touched.
    const budget = { remaining: Math.min(perTarget, total.remaining) };
    const allotted = budget.remaining;
    const { newest, truncated } = newestMtime(target, budget);
    total.remaining -= allotted - budget.remaining;
    snap[target] = { exists: true, newest, truncated };
  };

  // Non-root targets (resolveExtraWatchTargets) are recorded verbatim — they are
  // already the exact path to watch, whole-dir or single-file. Passed explicitly
  // rather than resolved here so a caller testing a fixture root does not silently
  // pull the developer's real ~/.gsd into its snapshot.
  for (const target of extraTargets) record(path.resolve(target));

  const { parents: watchParents, owned: watchOwned } = artifactTargets();

  for (const root of roots) {
    for (const entry of GSD_OWNED_ENTRIES) record(path.join(root, entry));
    // Paths whose own name is GSD's, nested inside a shared root (hermes'
    // `skills/gsd`, `hooks/lib`, `scripts/lib`, …) — no prefix rule sees these.
    for (const entry of watchOwned) record(path.join(root, ...entry.split('/')));

    // Shared dirs: enumerate only gsd-prefixed children. A child that appears
    // between the two snapshots is absent from `before` entirely — diffLiveConfig
    // treats after-only paths as created, which is exactly the leak signal.
    for (const [parent, prefixes] of Object.entries(watchParents)) {
      const parentDir = path.join(root, ...parent.split('/'));
      let children;
      try {
        children = fs.readdirSync(parentDir);
      } catch {
        continue; // parent absent — nothing of ours can be in it yet
      }
      for (const child of children) {
        if (prefixes.some((pre) => child.startsWith(pre))) record(path.join(parentDir, child));
      }
    }
  }
  return snap;
}

/**
 * Compare two snapshots. A path is a violation when it was created during the
 * run, when its newest mtime advanced, or when it was DELETED by the run.
 *
 * Iterate the UNION of both key sets, never `after` alone. Deletion reaches this
 * function in two shapes and an after-only walk sees neither:
 *
 *   - A FIXED owned entry (GSD_OWNED_ENTRIES x roots, and every extra target) is
 *     recorded at both ends whether or not it exists, so a deletion reads
 *     {exists:true} -> {exists:false} and falls through every branch — silently.
 *   - A gsd-prefixed child is DISCOVERED by readdir, so a deleted one is absent
 *     from `after` entirely and never enters an after-keyed loop at all.
 *
 * The second shape is why adding a `pre.exists && !post.exists` branch is not on
 * its own sufficient: that branch is unreachable for exactly the discovered
 * children the prefix scan exists to catch.
 *
 * @returns {{path: string, kind: 'created'|'modified'|'deleted'|'unverified'}[]}
 */
function diffLiveConfig(before, after) {
  const violations = [];
  const targets = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const target of targets) {
    const pre = before[target];
    const post = after[target];
    // Absent from `before` entirely: a gsd-prefixed child that did not exist
    // when the run started. Both snapshots cover the same roots, so an
    // after-only path was created BY the run — never skip it.
    if (!pre) {
      if (post && post.exists) violations.push({ path: target, kind: 'created' });
      continue;
    }
    // Absent from `after` entirely: a discovered child that existed when the run
    // started and does not now. Deletion is the least recoverable outcome in this
    // threat model, so it is never inferred as clean.
    if (!post) {
      if (pre.exists) violations.push({ path: target, kind: 'deleted' });
      continue;
    }
    if (!pre.exists && post.exists) {
      violations.push({ path: target, kind: 'created' });
    } else if (pre.exists && !post.exists) {
      violations.push({ path: target, kind: 'deleted' });
    } else if (pre.exists && post.exists && post.newest > pre.newest) {
      violations.push({ path: target, kind: 'modified' });
    } else if (pre.truncated || post.truncated) {
      // Bound hit: we cannot attest this path either way, and saying nothing
      // would let a truncated scan read as a clean one.
      violations.push({ path: target, kind: 'unverified' });
    }
  }
  return violations;
}

/** Human-facing report for a non-empty violation set. */
function formatViolations(violations) {
  const lines = [
    '',
    'run-tests: HERMETICITY WARNING — the suite wrote into a LIVE config directory.',
    '',
    'A test resolved a runtime config dir from the ambient environment instead of a',
    'sandbox. The usual cause is an IN-PROCESS install() call: tests/helpers.cjs',
    'TEST_ENV_BASE only scrubs CHILD process env, so an in-process caller must also',
    'use scrubConfigLocationEnv() (see tests/install.test.cjs) alongside its HOME',
    'sandbox. CI cannot catch this class — it never has these env vars set.',
    '',
  ];
  for (const v of violations) {
    const label = v.kind === 'unverified'
      ? 'UNVERIFIED (scan bound hit — not attested clean)'
      : v.kind.toUpperCase();
    lines.push(`  ${label}: ${v.path}`);
  }
  lines.push('');
  // The footer must state the mode the run is ACTUALLY in — a strict-mode
  // failure captioned "Reporting only" sends the reader away from the very
  // violation that just reddened their run.
  lines.push(
    process.env.GSD_STRICT_LIVE_CONFIG_GUARD === '1'
      ? 'STRICT MODE (GSD_STRICT_LIVE_CONFIG_GUARD=1): these violations fail the run. ' +
        'GSD_SKIP_LIVE_CONFIG_GUARD=1 skips the check entirely.'
      : 'Reporting only. Set GSD_STRICT_LIVE_CONFIG_GUARD=1 to make this fail the run, ' +
        'or GSD_SKIP_LIVE_CONFIG_GUARD=1 to skip the check entirely.',
  );
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  GSD_OWNED_ENTRIES,
  GSD_PREFIXED_PARENTS,
  GSD_OWNED_NESTED,
  NON_REGISTRY_ARTIFACT_PARENTS,
  DEFAULT_ARTIFACT_PREFIXES,
  deriveArtifactTargets,
  artifactTargets,
  GSD_ARTIFACT_PREFIX,
  MAX_ENTRIES,
  MAX_TOTAL_ENTRIES,
  MAX_DEPTH,
  resolveLiveConfigRoots,
  resolveExtraWatchTargets,
  snapshotLiveConfig,
  diffLiveConfig,
  formatViolations,
  newestMtime,
  os, // exported for test seams only
};
