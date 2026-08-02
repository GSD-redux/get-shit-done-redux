#!/usr/bin/env node
// Cross-platform test runner — resolves test file globs via Node
// instead of relying on shell expansion (which fails on Windows PowerShell/cmd).
// Propagates NODE_V8_COVERAGE so c8 collects coverage from the child process.
//
// Suite filtering (issue #3597):
//   node scripts/run-tests.cjs                 # default — runs ALL tests (backcompat)
//   node scripts/run-tests.cjs --suite all     # explicit "everything"
//   node scripts/run-tests.cjs --suite unit    # only files with no other suite marker
//   node scripts/run-tests.cjs --suite security    # *.security.test.cjs
//   node scripts/run-tests.cjs --suite integration # *.integration.test.cjs
//   node scripts/run-tests.cjs --suite install     # *.install.test.cjs
//   node scripts/run-tests.cjs --suite slow        # *.slow.test.cjs
//   node scripts/run-tests.cjs --suite qa          # *.qa.test.cjs
//   node scripts/run-tests.cjs --files "a.test.cjs b.test.cjs"
//   node scripts/run-tests.cjs --files-from /tmp/selected-tests.txt
//   node scripts/run-tests.cjs --suite unit --shard 1/3   # shard 1 of 3 (#1212)
//
// Sharding (issue #1212, reweighted #2472): --shard <i>/<n> runs a
// deterministic, COST-balanced slice of the SORTED selected file list. Files
// are partitioned by measured duration (tests/test-timings.json) using LPT —
// the same packing the chunker uses one level down — because equal file COUNTS
// are not equal file COST: the index-based split this replaced ran 12.4m /
// 19.2m / 15.2m against a 20-minute job cap. With no timing data every file
// weighs the same and the partition degenerates to the original k % n
// round-robin. i is 1-based (1..n); n >= 1; n=1 is a pure no-op (all files). The
// CI windows full-test lane shards across N parallel runners so per-job
// wall-clock scales as O(total/N) and stops hitting the job time cap. Sharding
// composes with --suite (it slices the post-filter selection) and preserves
// the existing 28K argv chunking WITHIN each shard.
//
// Suite grouping convention: filename suffix marker before `.test.cjs`.
// A file named `foo.security.test.cjs` belongs to the `security` suite.
// A file named `foo.test.cjs` (no marker) belongs to the `unit` suite.
// See docs/TESTING-SUITES.md for full grouping policy.
'use strict';

const { readdirSync, readFileSync } = require('fs');
const { join, basename } = require('path');
const { execFileSync } = require('child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const SUITES = ['all', 'unit', 'integration', 'install', 'security', 'slow', 'qa'];

// ADR-457 build-at-publish: gsd-core/bin/lib/*.cjs is generated from
// src/*.cts and gitignored, so on a clean checkout (fresh CI, before any build)
// the artifact is absent — yet test files require it. This is the universal
// chokepoint every test path funnels through (test:unit, --files-from, direct
// invocation), so build the artifact here.
//
// Strategy (incremental + re-emit-on-missing, closes both #969 failure modes):
//   1. Run tsc incrementally (fast ~380ms no-op when sources unchanged).
//   2. Verify every src/*.cts (non-.d.cts) maps to a non-empty gsd-core/bin/lib/*.cjs.
//   3. If any expected .cjs is missing or zero-bytes (persistent-mirror scenario:
//      tsc no-ops because tsbuildinfo looks current even though the file was deleted),
//      delete the tsbuildinfo and run tsc ONCE MORE (clean re-emit), then re-verify.
//
// Common case: fast incremental no-op. Stale/deleted-output case: detected by
// the cheap existsSync loop and force-rebuilt. Paths resolve from __dirname so
// it works regardless of GSD_TEST_DIR / temp-dir cwd.
function ensureBuiltArtifacts(overrides = {}) {
  const { existsSync, readdirSync, statSync, unlinkSync } = require('fs');
  const root = overrides.root || join(__dirname, '..');
  const srcDir = overrides.srcDir || join(root, 'src');
  const outDir = overrides.outDir || join(root, 'gsd-core', 'bin', 'lib');
  const tsBuildInfoPath = overrides.tsBuildInfoPath || join(root, 'tsconfig.build.tsbuildinfo');
  const tsconfigPath = overrides.tsconfigPath || join(root, 'tsconfig.build.json');
  const tscBin = require.resolve('typescript/bin/tsc');
  const tscArgs = [tscBin, '-p', tsconfigPath];

  // Build the 1:1 map of expected output paths from src/*.cts sources.
  // Excludes *.d.cts (declaration-only files that produce no output).
  // Handles subdirectories (e.g. src/installer-migrations/*.cts → gsd-core/bin/lib/installer-migrations/*.cjs).
  function gatherExpectedOutputs() {
    const expected = [];
    function scan(dir, relBase) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          scan(join(dir, entry.name), relBase ? `${relBase}/${entry.name}` : entry.name);
        } else if (entry.name.endsWith('.cts') && !entry.name.endsWith('.d.cts')) {
          const stem = entry.name.slice(0, -'.cts'.length);
          const rel = relBase ? `${relBase}/${stem}.cjs` : `${stem}.cjs`;
          expected.push(join(outDir, rel));
        }
      }
    }
    scan(srcDir, '');
    return expected;
  }

  function checkMissingOutputs(expectedPaths) {
    return expectedPaths.filter(p => !existsSync(p) || statSync(p).size === 0);
  }

  // #996 placed the tsbuildinfo inside gsd-core/bin/ (a copied/shipped tree), which
  // raced install-test copies. It now lives at the repo root. Best-effort purge any
  // stale bin-local copy so persistent workspaces/mirrors self-heal (no-op on a temp
  // override root or a clean checkout).
  const legacyTsBuildInfo = join(root, 'gsd-core', 'bin', 'tsconfig.build.tsbuildinfo');
  try { if (existsSync(legacyTsBuildInfo)) unlinkSync(legacyTsBuildInfo); } catch { /* best-effort */ }

  // Step 1: incremental build (fast no-op when sources unchanged).
  execFileSync(process.execPath, tscArgs, { cwd: root, stdio: 'inherit' });

  // Step 2: verify expected outputs.
  const expected = gatherExpectedOutputs();
  const missing = checkMissingOutputs(expected);

  // Step 3: if any output is missing/zero-bytes, force a clean re-emit.
  // This handles the persistent-mirror case where tsc's incremental no-op left
  // a deleted .cjs unregenerated (tsbuildinfo recorded it as up-to-date).
  if (missing.length > 0) {
    if (existsSync(tsBuildInfoPath)) {
      unlinkSync(tsBuildInfoPath);
    }
    execFileSync(process.execPath, tscArgs, { cwd: root, stdio: 'inherit' });
    // Re-verify after clean re-emit; surface any remaining gaps loudly.
    const stillMissing = checkMissingOutputs(expected);
    if (stillMissing.length > 0) {
      const names = stillMissing.map(p => require('path').basename(p)).join(', ');
      throw new Error(
        `ensureBuiltArtifacts: tsc clean re-emit still missing outputs: ${names}. ` +
        `Check src/ for compilation errors.`
      );
    }
  }
}

// hooks/dist/ is gitignored (.gitignore) and NOT built by `prepare`
// (npm run build:lib only) — only the full `build`/`prepublishOnly` scripts run
// build:hooks. So on a clean checkout + `npm ci` (fresh CI, incl. the scoped
// test lane) hooks/dist starts absent. Install tests (e.g.
// bug-3683-workflow-colon-namespace-leak) spawn `install.js --<runtime> --local`
// which copies hooks from hooks/dist/ and then verifyInstalled() hard-fails if
// the target hooks dir is empty. build-hooks.js `build()` creates DIST_DIR
// empty and fills it file-by-file, so the FIRST on-demand build (triggered by
// whichever concurrent install test's before() hook runs first) exposes a
// window where hooks/dist exists but is empty/partial. A concurrently-spawned
// install reader observes zero hooks -> "Failed to install hooks: directory is
// empty" -> intermittent scoped-lane failure (full lanes dodge it only by luck
// of a hooks-builder finishing early). Building hooks/dist ONCE here — the same
// upfront chokepoint as ensureBuiltArtifacts, single-process with no concurrent
// readers — fully populates dist before any test runs, closing the first-build
// empty window everywhere (CI scoped/unit shards + local). Subsequent on-demand
// rebuilds only atomically replace individual files (per-file rename in
// build-hooks.js) and never re-empty the dir, so they stay safe.
function ensureBuiltHooks(overrides = {}) {
  const { existsSync, statSync } = require('fs');
  const root = overrides.root || join(__dirname, '..');
  const distDir = overrides.distDir || join(root, 'hooks', 'dist');
  const hookNames = overrides.hookNames || require('./build-hooks.js').HOOKS_TO_COPY;
  const runBuild = overrides.runBuild || (() => {
    execFileSync(process.execPath, [join(root, 'scripts', 'build-hooks.js')], {
      cwd: root,
      stdio: 'inherit',
    });
  });

  // dist is "complete" only if every expected hook exists as a non-empty file.
  // Absent dir, empty dir, or a missing/zero-byte hook all trigger a rebuild.
  const complete = existsSync(distDir) && hookNames.every((hook) => {
    const p = join(distDir, hook);
    try {
      return existsSync(p) && statSync(p).size > 0;
    } catch {
      return false;
    }
  });
  if (!complete) {
    runBuild();
  }
}
const MARKED_SUITES = ['integration', 'install', 'security', 'slow', 'qa'];

// Recursively collect *.test.cjs files under dir, returning paths relative to dir.
// Skips node_modules to avoid accidentally picking up decoy files.
function walkTestFiles(dir, relBase) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...walkTestFiles(join(dir, entry.name), relBase ? `${relBase}/${entry.name}` : entry.name));
    } else if (entry.name.endsWith('.test.cjs')) {
      results.push(relBase ? `${relBase}/${entry.name}` : entry.name);
    }
  }
  return results;
}

// Parse a `--shard i/n` value into { index, total } or { error }.
// i is 1-based and must satisfy 1 <= i <= n; n must be >= 1. Both parts must be
// plain non-negative integers (no decimals, signs, or surrounding whitespace).
// `n=1` is the pure no-op (every file). This is the strict-input boundary
// (Postel's Law: be strict in what a CLI flag accepts so a typo fails loudly
// rather than silently running the wrong slice of the suite).
function parseShardArg(value) {
  if (typeof value !== 'string') {
    return { error: `--shard requires a value of the form i/n` };
  }
  const m = /^(\d+)\/(\d+)$/.exec(value);
  if (!m) {
    return { error: `--shard value "${value}" must be of the form i/n (e.g. 1/3)` };
  }
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(total) || total < 1) {
    return { error: `--shard total n must be an integer >= 1, got "${m[2]}"` };
  }
  if (!Number.isInteger(index) || index < 1 || index > total) {
    return { error: `--shard index i must be an integer in 1..${total}, got "${m[1]}"` };
  }
  return { index, total };
}

// Deterministic partition of an ALREADY-SORTED file list. Without a weigher
// this is the original round-robin (#1212):
// Shard `index` (1-based) receives every file whose position k in the sorted
// list satisfies k % total === index - 1. Round-robin (not contiguous blocks)
// spreads duration variance across shards and guarantees shard sizes differ by
// at most 1. Selection keys off array INDEX, never off the path string, so the
// partition is byte-identical across Windows/macOS/Linux as long as the caller
// sorts the list with the same (locale-independent) comparator. `total=1`
// returns the input unchanged (pure no-op). A shard with no files (total >
// file count) returns [] and is a legitimate result, not an error.
// `weightOf` (optional, #2472) switches the partition from equal COUNTS to
// equal COST. Equal counts were only ever a proxy for equal duration, and on a
// right-skewed suite the proxy fails: the real unit suite partitioned 12.4m /
// 19.2m / 15.2m by index against a 20-minute job cap, and because assignment
// keyed off array POSITION, inserting one test file re-indexed every file after
// it and could tip the heaviest shard over. Weighting by measured cost fixes
// both: LPT bounds the heaviest shard at 4/3 of optimal, and placement follows
// a file's cost rather than its neighbours' names.
//
// This is the same algorithm packChunks uses one level down (#2456/#2463), so
// both layers now share one cost model. Omitting `weightOf` keeps the legacy
// round-robin byte-identical — callers with no timing data lose nothing.
function selectShard(sortedFiles, { index, total }, weightOf) {
  if (total === 1) return sortedFiles;
  if (typeof weightOf !== 'function') {
    return sortedFiles.filter((_, k) => k % total === index - 1);
  }
  // A non-finite or negative weight must not poison bin arithmetic — one NaN
  // would make every subsequent comparison false and pile the rest of the suite
  // into bin 0. Mirrors packChunks' safeWeight for the same reason.
  const safeWeight = (file) => {
    const w = weightOf(file);
    return Number.isFinite(w) && w >= 0 ? w : 0;
  };
  const bins = Array.from({ length: total }, () => ({ weight: 0, picks: [] }));
  // LPT: heaviest first, each into the currently-lightest bin. Ties break on
  // the caller's sort position, and the lightest-bin scan takes the FIRST
  // minimum, so the partition is byte-identical across Windows/macOS/Linux —
  // the same determinism guarantee the round-robin path carries.
  const order = sortedFiles
    .map((file, k) => ({ k, weight: safeWeight(file) }))
    .sort((a, b) => b.weight - a.weight || a.k - b.k);
  for (const entry of order) {
    let lightest = 0;
    for (let i = 1; i < total; i += 1) {
      const bin = bins[i];
      const best = bins[lightest];
      // Weight first, then FILE COUNT. The count tiebreak is load-bearing, not
      // cosmetic: adding a zero-weight file leaves its bin's weight unchanged,
      // so on weight alone bin 0 stays tied-minimum forever and every
      // zero-weight file lands on it — all-zero weights put the whole suite on
      // shard 1 and leave the other runners idle. Zero weights are reachable
      // via safeWeight's clamp (a NaN/negative/Infinity entry in a hand-edited
      // or corrupted timings table) and via any genuinely 0ms measurement, so
      // the clamp above would otherwise reproduce the exact pile-onto-bin-0
      // failure it exists to prevent. Counting picks makes ties rotate.
      if (bin.weight < best.weight
        || (bin.weight === best.weight && bin.picks.length < best.picks.length)) {
        lightest = i;
      }
    }
    bins[lightest].weight += entry.weight;
    bins[lightest].picks.push(entry.k);
  }
  // Restore the caller's order within the shard: downstream chunking and argv
  // batching assume the list arrives sorted as the caller sorted it.
  return bins[index - 1].picks.sort((a, b) => a - b).map((k) => sortedFiles[k]);
}

// Read an operator-supplied numeric env knob, falling back to the default for
// anything that is not a positive finite number.
//
// This is a strict-input boundary (Postel's Law: a typo must fail SAFE, not
// silently poison arithmetic downstream). `Number('abc')` is NaN and
// `Number('')` is 0, and both are load-bearing here: a NaN chunk budget makes
// the chunk-count computation NaN, which spins packChunks' retry loop forever
// (a hung CI job with no output); a zero budget makes it Infinity, which throws
// `RangeError: Invalid array length`. Neither is an acceptable response to a
// mistyped environment variable.
function positiveNumberEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Per-file measured durations, regenerated by scripts/gen-test-timings.cjs from
// gsd-test reporter event streams. Overridable so tests can inject a synthetic
// table instead of depending on the real suite's cost profile.
const DEFAULT_TIMINGS_PATH = join(__dirname, '..', 'tests', 'test-timings.json');
// Must track SCHEMA_VERSION in scripts/gen-test-timings.cjs.
const SUPPORTED_TIMINGS_SCHEMA = 1;

// Load the timing table and reduce it to what the packer needs.
//
// Weights are normalized by the table's MEAN duration, so an average-cost file
// weighs exactly 1 and `MAX_FILES_PER_CHUNK` keeps its original meaning ("about
// N average files per chunk"). When every file costs the same, total weight
// equals file count, so the chunk COUNT matches count-based packing exactly.
// The chunk COMPOSITION still differs — LPT balances where first-fit filled
// greedily, so 7 uniform files at budget 3 pack {3,2,2} rather than {3,3,1}.
//
// `medianWeight` is the fallback for a file absent from the table (a new test,
// or a table that has drifted). The median — not the mean — because the cost
// distribution is heavily right-skewed (median 0.28s vs mean 4.6s across the
// suite), so the median is the honest estimate for an unknown file.
//
// Returns null when the table is missing or unusable; the caller then treats
// every file as weight 1, which reproduces the pre-#2456 count-based balance.
function loadTestTimings(timingsPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(timingsPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // Refuse a table written by a future generator: a v2 schema could change the
  // unit or the key format, and consuming it under v1 semantics would silently
  // mis-weight every file. Returning null falls back to uniform weight, which
  // is the same graceful degradation as a missing table.
  if (parsed.schema_version !== undefined && parsed.schema_version !== SUPPORTED_TIMINGS_SCHEMA) {
    return null;
  }
  const timings = parsed.timings;
  // Array.isArray guard: `typeof [] === 'object'`, so a hand-edit that turned
  // the map into a list would pass a bare typeof check and be accepted as a
  // valid table. It degrades harmlessly (no basename ever matches an array
  // index, so every file takes medianWeight), but silently accepting a
  // malformed table is worse than rejecting it — reject, and fall back to
  // uniform weight the same way a missing file does.
  if (!timings || typeof timings !== 'object' || Array.isArray(timings)) return null;
  const values = Object.values(timings).filter(
    (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  );
  if (values.length === 0) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (!(mean > 0)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { timings, mean, medianWeight: median / mean };
}

// Build the packer's weight function from a loaded timing table.
//
// A file present in the table weighs its measured duration relative to the
// table mean. A file ABSENT from it weighs the table's median — this is the
// "advisory, not gated" contract: a new test or a drifted table costs chunk
// balance, never a red build. A null table (missing or unparseable file) makes
// every file weigh 1, reproducing the pre-#2456 count-based balance exactly.
function makeFileWeigher(timings) {
  if (!timings) return () => 1;
  return (f) => {
    const key = basename(f);
    // Own-property check before the lookup. This is defense-in-depth, NOT a
    // behavior change: the table is JSON-parsed, so a bare `timings[key]` would
    // walk the prototype chain, but the only keys that resolve there are
    // Object.prototype members (`constructor`, `toString`, …) and every real
    // selection is a `*.test.cjs` basename, which can never equal one. Even if
    // it could, the `typeof ms === 'number'` guard below already rejects the
    // function it would return. `Object.hasOwn` makes the intent explicit and
    // keeps the lookup correct for arbitrary input, since this function is
    // exported and does not control its caller's strings.
    const ms = Object.hasOwn(timings.timings, key) ? timings.timings[key] : undefined;
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
      ? ms / timings.mean
      : timings.medianWeight;
  };
}

// Pack `files` into chunks using LPT (longest-processing-time-first): sort by
// weight descending, then place each file into the currently-LIGHTEST chunk.
//
// #2456: the previous packer was a sequential first-fit that appended files in
// selection order and closed a chunk once its weight budget was hit. Because
// sorted-adjacent files land together, the two heaviest files in a shard packed
// into the SAME chunk, leaving the slowest chunk ~3.9x the lightest and sitting
// near the 600s per-chunk timeout while other chunks idled. LPT is the standard
// greedy approximation for exactly this makespan problem and balanced the same
// real shard to ~1.0x.
//
// Chunk COUNT is fixed before placement so LPT has bins to balance across:
//   ceil(totalWeight / maxWeight)  — the weighted budget, and
//   ceil(fileCount  / maxWeight)   — a floor that pins the count at what the
//                                    old count-based packing would produce.
// The floor is what makes a stale or missing timings table safe: unknown files
// fall back to a small median weight, which on its own would collapse many files
// into few fat chunks. With the floor, a degraded table can only ever reproduce
// today's chunking, never something coarser.
//
// `maxChars` still bounds each chunk's argv (Windows CreateProcess caps
// lpCommandLine at 32,767). A chunk that cannot fit the next file is skipped for
// that file; when no chunk has room, the chunk count grows and packing restarts.
// A single file longer than the budget lands alone rather than looping forever.
//
// Ordering is fully deterministic — ties break on the separator-normalized file
// path, and each chunk's files are emitted in their original selection order —
// so the packing is byte-identical across Windows/macOS/Linux.
function packChunks(files, { weightOf, maxWeight, maxChars, fixedOverhead }) {
  if (files.length === 0) return [];
  // packChunks is exported, so it cannot assume its caller normalized these.
  // A non-finite or non-positive budget makes the chunk-count arithmetic
  // non-finite, which spins the retry loop below forever or throws from
  // Array.from; a non-finite weight propagates into the same computation.
  // Degrade to a safe bound instead.
  const weightBudget = Number.isFinite(maxWeight) && maxWeight > 0 ? maxWeight : files.length;
  const charBudget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Number.MAX_SAFE_INTEGER;
  const overhead = Number.isFinite(fixedOverhead) && fixedOverhead >= 0 ? fixedOverhead : 0;
  const safeWeight = (file) => {
    const w = weightOf(file);
    return Number.isFinite(w) && w >= 0 ? w : 0;
  };
  const entries = files.map((file, index) => ({
    file,
    index,
    weight: safeWeight(file),
    chars: file.length + 1, // +1 for the inter-arg separator
  }));
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  // Ties break on a SEPARATOR-NORMALIZED path so a subdir file orders the same
  // on Windows as on POSIX: '/' is 0x2F and '\' is 0x5C, which straddle the
  // uppercase range, so comparing raw paths can order `sub/x.test.cjs` against
  // `subZ.test.cjs` differently per platform and silently produce a different
  // (still valid, but non-reproducible) packing.
  const sortKey = (f) => f.replace(/\\/g, '/');
  const heaviestFirst = [...entries].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const ka = sortKey(a.file);
    const kb = sortKey(b.file);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Termination: the empty-bin rule below guarantees every file is placeable
  // once chunkCount reaches files.length, so the retry loop cannot run forever.
  // The upper clamp matters as much as the lower bound: a legitimate but tiny
  // budget (RUN_TESTS_MAX_FILES_PER_CHUNK=1e-9) would otherwise ask for
  // 637,000,000,000 bins and throw `RangeError: Invalid array length`. More
  // chunks than files is never useful — one file per chunk is the finest
  // possible packing.
  let chunkCount = Math.min(
    files.length,
    Math.max(1, Math.ceil(totalWeight / weightBudget), Math.ceil(files.length / weightBudget)),
  );
  for (;;) {
    const bins = Array.from({ length: chunkCount }, () => ({
      entries: [],
      weight: 0,
      chars: overhead,
    }));
    let overflowed = false;
    for (const entry of heaviestFirst) {
      let target = null;
      for (const bin of bins) {
        // An empty bin always accepts, so an over-long single file lands alone
        // instead of growing the chunk count forever.
        if (bin.entries.length > 0 && bin.chars + entry.chars > charBudget) continue;
        if (target === null || bin.weight < target.weight) target = bin;
      }
      if (target === null) {
        overflowed = true;
        break;
      }
      target.entries.push(entry);
      target.weight += entry.weight;
      target.chars += entry.chars;
    }
    if (!overflowed) {
      return bins
        .filter((bin) => bin.entries.length > 0)
        .map((bin) => bin.entries.sort((a, b) => a.index - b.index).map((e) => e.file));
    }
    chunkCount++;
  }
}

function parseArgs(argv) {
  let suite = null;
  let seen = false;
  let files = null;
  let filesFrom = null;
  let shard = null;
  let shardSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shard' || a.startsWith('--shard=')) {
      if (shardSeen) {
        return { error: 'duplicate --shard flag' };
      }
      shardSeen = true;
      let v;
      if (a === '--shard') {
        v = argv[i + 1];
        if (v === undefined || (typeof v === 'string' && v.startsWith('--'))) {
          return { error: '--shard requires a value of the form i/n' };
        }
        i++;
      } else {
        v = a.slice('--shard='.length);
      }
      const parsed = parseShardArg(v);
      if (parsed.error) {
        return { error: parsed.error };
      }
      shard = parsed;
    } else if (a === '--suite') {
      if (seen) {
        return { error: 'duplicate --suite flag' };
      }
      seen = true;
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        return { error: '--suite requires a value' };
      }
      suite = v;
      i++;
    } else if (a.startsWith('--suite=')) {
      if (seen) {
        return { error: 'duplicate --suite flag' };
      }
      seen = true;
      suite = a.slice('--suite='.length);
      if (!suite) {
        return { error: '--suite requires a value' };
      }
    } else if (a === '--files') {
      if (files !== null) {
        return { error: 'duplicate --files flag' };
      }
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        return { error: '--files requires a value' };
      }
      files = v;
      i++;
    } else if (a.startsWith('--files=')) {
      if (files !== null) {
        return { error: 'duplicate --files flag' };
      }
      files = a.slice('--files='.length);
      if (!files) {
        return { error: '--files requires a value' };
      }
    } else if (a === '--files-from') {
      if (filesFrom !== null) {
        return { error: 'duplicate --files-from flag' };
      }
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        return { error: '--files-from requires a value' };
      }
      filesFrom = v;
      i++;
    } else if (a.startsWith('--files-from=')) {
      if (filesFrom !== null) {
        return { error: 'duplicate --files-from flag' };
      }
      filesFrom = a.slice('--files-from='.length);
      if (!filesFrom) {
        return { error: '--files-from requires a value' };
      }
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  if (files !== null && filesFrom !== null) {
    return { error: '--files and --files-from cannot be combined' };
  }
  return { suite, files, filesFrom, shard };
}

// Return the marked suite name embedded in a filename, or null if it's unmarked.
// foo.security.test.cjs -> "security"
// foo.test.cjs          -> null (unit)
// Accepts either a bare filename or a relative subdir path; classification is
// based on the basename only so subdir paths classify identically to root files.
function suiteOf(filename) {
  const name = basename(filename);
  if (!name.endsWith('.test.cjs')) return null;
  const base = name.slice(0, -'.test.cjs'.length);
  const lastDot = base.lastIndexOf('.');
  if (lastDot === -1) return null;
  const marker = base.slice(lastDot + 1);
  return MARKED_SUITES.includes(marker) ? marker : null;
}

function selectFiles(allFiles, suite) {
  if (suite === null || suite === 'all') {
    return allFiles;
  }
  if (suite === 'unit') {
    return allFiles.filter(f => suiteOf(f) === null);
  }
  return allFiles.filter(f => suiteOf(f) === suite);
}

function splitFileList(value) {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => v.replace(/\\/g, '/'))   // normalize Windows backslashes
    .map(v => v.replace(/^tests\//, ''));
}

function selectExplicitFiles(allFiles, filesValue, filesFrom) {
  const fs = require('fs');
  const requested = filesFrom
    ? splitFileList(fs.readFileSync(filesFrom, 'utf8'))
    : splitFileList(filesValue);
  const available = new Set(allFiles);

  // Build a basename -> [relpath, ...] index for bare-basename resolution.
  // A bare basename (no directory separator) may match exactly one subdir file.
  const basenameIndex = new Map();
  for (const f of allFiles) {
    const b = basename(f);
    if (!basenameIndex.has(b)) basenameIndex.set(b, []);
    basenameIndex.get(b).push(f);
  }

  const selected = [];
  const missing = [];
  const errors = [];
  for (const file of requested) {
    // If the token is a bare suite name (e.g. "unit" written by ci-test-scope
    // as the #408 fallback sentinel), delegate to the existing suite resolver
    // rather than treating it as a filename. This prevents the
    // "requested test file(s) not found: unit" crash (#641).
    if (SUITES.includes(file)) {
      for (const f of selectFiles(allFiles, file)) {
        selected.push(f);
      }
    } else if (available.has(file)) {
      // Exact relpath match (e.g. "installer-migrations/001-legacy-orphan-files.test.cjs").
      selected.push(file);
    } else if (!file.includes('/')) {
      // Bare basename (no directory separator): resolve via index.
      const candidates = basenameIndex.get(file);
      if (!candidates || candidates.length === 0) {
        missing.push(file);
      } else if (candidates.length > 1) {
        errors.push(
          `ambiguous basename "${file}" matches multiple files: ${candidates.join(', ')} — pass the subdir path instead`,
        );
      } else {
        selected.push(candidates[0]);
      }
    } else {
      missing.push(file);
    }
  }
  if (errors.length > 0) {
    return { error: errors.join('; ') };
  }
  if (missing.length > 0) {
    return {
      error: `requested test file(s) not found: ${missing.join(', ')}`,
    };
  }
  return { files: [...new Set(selected)] };
}

function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  if (parsed.error) {
    console.error(`run-tests: ${parsed.error}`);
    console.error(`Valid suites: ${SUITES.join(', ')}`);
    throw new ExitError(2);
  }
  const suite = parsed.suite;
  if (suite !== null && !SUITES.includes(suite)) {
    console.error(`run-tests: unknown suite "${suite}"`);
    console.error(`Valid suites: ${SUITES.join(', ')}`);
    throw new ExitError(2);
  }

  const testDir = process.env.GSD_TEST_DIR
    ? process.env.GSD_TEST_DIR
    : join(__dirname, '..', 'tests');

  const allFiles = walkTestFiles(testDir, '').sort();

  if (allFiles.length === 0) {
    console.error(`No test files found in ${testDir}`);
    throw new ExitError(1);
  }

  const usingExplicitFiles = parsed.files !== null || parsed.filesFrom !== null;
  let selectedNames;
  if (usingExplicitFiles) {
    const explicit = selectExplicitFiles(allFiles, parsed.files, parsed.filesFrom);
    if (explicit.error) {
      console.error(`run-tests: ${explicit.error}`);
      throw new ExitError(2);
    }
    selectedNames = explicit.files;
  } else {
    selectedNames = selectFiles(allFiles, suite);
  }

  // Shard partitioning (#1212): when --shard i/n is given, keep only this
  // shard's deterministic cost-balanced slice of the selected list. Applied
  // AFTER suite/explicit selection so it composes with --suite (each shard
  // runs i/n of the post-filter selection).
  //
  // The partition keys off array index, so the slice is only reproducible if
  // the input is in a stable order. --suite/default selections are already
  // sorted (allFiles came from walkTestFiles(...).sort() and selectFiles
  // preserves that order), but --files/--files-from preserve REQUEST order.
  // Sort here so --shard is deterministic regardless of how the selection was
  // produced — the runner's documented contract is a sorted partition.
  //
  // emptyBeforeShard distinguishes "this shard legitimately got zero files
  // from a non-empty list" (total > file count — a valid no-op) from "the
  // selection was already empty before sharding" (a genuinely empty suite,
  // which must still hit the discovery hard-error below — Codex #1212 review).
  // Loaded before sharding because BOTH layers weigh by it now (#2472): the
  // shard partition below and the chunk packer further down share this one cost
  // model. Advisory in both places — a missing table yields uniform weight 1,
  // which makes the shard partition degenerate to the legacy equal-count split.
  // Lazily memoized: BOTH layers weigh by it now (#2472) — the shard partition
  // just below and the chunk packer further down share this one cost model —
  // but neither should charge a readFileSync + JSON.parse to an invocation that
  // exits before it needs one (an empty selection, or `--files` with nothing
  // matched). Memoized so the two consumers still read the table at most once.
  // Advisory in both places: a missing table yields uniform weight 1, under
  // which the shard partition degenerates to the legacy equal-count split.
  let weigherMemo = null;
  const fileWeightOf = () => {
    if (weigherMemo === null) {
      const timingsPath = process.env.RUN_TESTS_TIMINGS_FILE || DEFAULT_TIMINGS_PATH;
      weigherMemo = makeFileWeigher(loadTestTimings(timingsPath));
    }
    return weigherMemo;
  };

  const usingShard = parsed.shard !== null;
  let emptyBeforeShard = false;
  // The full pre-partition input, kept for the cross-job fingerprint below.
  // It must be the list every shard job sees, not this job's slice.
  let shardInput = null;
  if (usingShard) {
    emptyBeforeShard = selectedNames.length === 0;
    shardInput = [...selectedNames].sort();
    selectedNames = selectShard(shardInput, parsed.shard, fileWeightOf());
  }

  const selected = selectedNames.map(f => join(testDir, f));

  if (selected.length === 0) {
    // A legitimately-empty shard: --shard was given, the pre-shard selection
    // had files, but this shard index drew zero (total > file count). Exit 0.
    const legitimatelyEmptyShard = usingShard && !emptyBeforeShard;
    if (usingExplicitFiles || legitimatelyEmptyShard) {
      // Empty file list from --files/--files-from (e.g. CI passes an empty
      // .ci-selected-tests.txt on docs-only/inert PRs) OR a legitimately-empty
      // shard: both are expected. Exit 0 silently rather than taking the
      // "discovery broken" hard-error path below. An EMPTY suite that was
      // empty BEFORE sharding falls through to the hard error so a broken
      // --suite filter is still caught even with --shard present.
      console.error(`run-tests: no tests in suite "${suite || 'all'}"`);
      return 0;
    }
    // Empty suite/default run: this means discovery or the suite filter is broken.
    // Allow GSD_ALLOW_EMPTY_SUITE=1 as an escape hatch (downgrades to a warning).
    if (process.env.GSD_ALLOW_EMPTY_SUITE === '1') {
      console.error(`run-tests: WARNING: 0 test files selected for suite "${suite || 'all'}" — discovery or suite filter may be broken (GSD_ALLOW_EMPTY_SUITE=1 suppressed the error)`);
      return 0;
    }
    console.error(`run-tests: ERROR: 0 test files selected for suite "${suite || 'all'}" — discovery or suite filter is broken`);
    throw new ExitError(1);
  }

  // Build the gitignored bin/lib artifact if absent, before any test requires it.
  ensureBuiltArtifacts();

  // Build the gitignored hooks/dist artifact once, before any concurrent install
  // test spawns install.js and reads it — closes the first-build empty-dir race
  // that intermittently failed the scoped CI lane (see ensureBuiltHooks above).
  ensureBuiltHooks();

  // Hermeticity: in-process tests resolve `.planning` via planningDir(cwd), which
  // honours GSD_PROJECT/GSD_WORKSTREAM. A developer shell inside a GSD workstream
  // exports GSD_WORKSTREAM, which would redirect fixture STATE.md reads away from
  // each <tmp>/.planning and silently diverge from the clean CI/Docker env. Strip
  // them so the local runner matches CI; tests that need them set them explicitly.
  delete process.env.GSD_PROJECT;
  delete process.env.GSD_WORKSTREAM;
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  // Sandbox the overlay home so the loader's global scan ($GSD_HOME/.gsd/capabilities)
  // cannot read a developer's real installed capabilities during tests (ADR-1244 D2).
  // IDEMPOTENT: a nested run-tests spawn (e.g. tests/run-tests-harness.test.cjs)
  // inherits this sandbox via env — it must REUSE it, never mkdtemp a fresh dir per
  // invocation (that churned ~20+ temp dirs per harness run and amplified Docker load).
  {
    const { mkdtempSync } = require('fs');
    const { join: _join, basename: _basename } = require('path');
    const { tmpdir } = require('os');
    const _gh = process.env.GSD_HOME;
    if (!_gh || !_basename(_gh).startsWith('gsd-test-home-')) {
      process.env.GSD_HOME = mkdtempSync(_join(tmpdir(), 'gsd-test-home-'));
    }
  }

  // Log selected files to stderr for CI / harness-test visibility.
  // node:test default reporter doesn't echo filenames, so this gives
  // operators a single stable line they can grep.
  console.error(
    `run-tests: suite="${suite || 'all'}" files=${selected.length}: ${selected
      .map(f => f.split(/[\\/]/).pop())
      .join(' ')}`,
  );

  // Shard diagnostics (#2472). File COUNT stopped being a balance signal the
  // moment the partition started weighing by cost — two shards can now hold
  // very different counts by design — so the count line above can no longer be
  // eyeballed to spot a bad split. Worse, each shard job computes its partition
  // independently on its own runner: if the inputs differ between jobs (the
  // file list, or this table), two jobs can place the same file in different
  // shards, or in none, and every job still looks internally consistent. That
  // failure is silent — a test simply never runs and CI stays green.
  //
  // `sig` is the defense: a cheap fingerprint of the exact inputs the partition
  // consumed. Every shard job of a given run must print the SAME sig; a
  // mismatch across jobs is proof the runners disagreed about the input and
  // therefore about the partition. `weighed` reports how many of this shard's
  // files matched a real measurement — a table that silently failed to parse
  // shows weighed=0 instead of being indistinguishable from a healthy load.
  if (usingShard) {
    const weigher = fileWeightOf();
    const table = loadTestTimings(process.env.RUN_TESTS_TIMINGS_FILE || DEFAULT_TIMINGS_PATH);
    const mine = selectedNames.map(f => f.split(/[\\/]/).pop());
    const weighed = table
      ? mine.filter(n => Object.hasOwn(table.timings, n)).length
      : 0;
    const myWeight = mine.reduce((sum, n) => sum + weigher(n), 0);
    // Fingerprint the FULL pre-partition input — the file list and the weight
    // each file was assigned — NOT this shard's slice. Every shard job of one
    // run must print an identical sig; a mismatch is proof the runners
    // disagreed about the input, which is the only way the union of shards can
    // silently drop or duplicate a file. Order-independent sum of per-file
    // (name, weight) hashes: stable across platforms, cheap for ~600 files.
    let sig = 0;
    for (const n of shardInput.map(f => f.split(/[\\/]/).pop())) {
      let h = 2166136261;
      for (let i = 0; i < n.length; i += 1) {
        h = Math.imul(h ^ n.charCodeAt(i), 16777619);
      }
      sig = (sig + (h >>> 0) + Math.round(weigher(n) * 1000)) % 0xffffffff;
    }
    console.error(
      `run-tests: shard=${parsed.shard.index}/${parsed.shard.total} `
      + `files=${mine.length}/${shardInput.length} weighed=${weighed} `
      + `weight=${myWeight.toFixed(2)} table=${table ? 'loaded' : 'absent'} `
      + `sig=${sig.toString(16)}`,
    );
  }

  // Default concurrency: 4 on Linux/macOS, 2 on Windows.
  //
  // Windows has significantly higher per-subprocess overhead than Linux/macOS:
  //   - Windows Defender scans each spawned process on first execution, adding
  //     latency proportional to the number of concurrent spawns.
  //   - NTFS has higher file-system latency under concurrent access compared to
  //     ext4/APFS, which amplifies contention when multiple test chunks run in
  //     parallel and all read/write the same fixture directories.
  // Reducing to 2 halves the peak concurrent subprocess count on Windows and
  // keeps per-chunk wall-clock time well within the 20m CI job cap.
  //
  // Operator override via TEST_CONCURRENCY env var for local debugging.
  const defaultConcurrency = process.platform === 'win32' ? 2 : 4;
  const concurrency = process.env.TEST_CONCURRENCY
    ? `--test-concurrency=${process.env.TEST_CONCURRENCY}`
    : `--test-concurrency=${defaultConcurrency}`;

  // Windows `CreateProcess` caps the full command line at 32,767 chars
  // (lpCommandLine). With 500+ test paths the spawn fails instantly with no
  // test output. Linux/macOS allow ~2 MB (ARG_MAX) so unchunked spawns are
  // fine there. Split into chunks sized for the tightest target so behavior
  // is identical across platforms. (#3597)
  // Operator override (also used by tests to force chunking with short paths).
  const MAX_CMDLINE_CHARS = positiveNumberEnv(
    process.env.RUN_TESTS_MAX_CMDLINE_CHARS,
    28000, // headroom below the 32,767 Windows ceiling
  );
  // A full-lane shard (~171 files) fit in ONE chunk at the old cap of 180, so the
  // entire shard's wall-clock ran against a single per-chunk timeout. On the slow
  // Windows runner the install-heavy files in a shard (e.g. install-minimal-hooks
  // .test.cjs alone runs ~250 cases doing dozens of real installs) push that single
  // chunk past the 600s per-chunk backstop — killed mid-run while still making slow
  // progress (verified: no leaked handle / hang; --test-force-exit exits leaks
  // cleanly, so the timeout was pure slowness, NOT the leak the kill message guesses).
  // The per-chunk timeout is sized for a "healthy chunk (~4-5 min)"; keep chunks at
  // roughly a third of a shard so each gets its own fresh 600s budget and a fresh
  // node process (also relieving per-process memory pressure from 170+ files at once).
  // Lowered from 90 to 60 after #1575 — macOS Node 22 shard 2/3 chunk 2 (~80 files
  // including state.test.cjs, perf-*, worktree-cleanup) exceeded 600s with 90.
  const MAX_FILES_PER_CHUNK = positiveNumberEnv(process.env.RUN_TESTS_MAX_FILES_PER_CHUNK, 60);
  // #2088 established that file COUNT is a poor proxy for a chunk's wall-clock:
  // install-heavy files (real installs) cost ~10x a unit file, and when several
  // land in the SAME chunk it blows the 600s backstop while unit-only chunks
  // finish in seconds. #2088 approximated cost from the filename — basename
  // matching /^(?:install|codex-)/ scored 12, everything else 1.
  //
  // #2456: that approximation is miscalibrated in BOTH directions, so chunks were
  // still balanced by file count rather than by cost. Measured durations show
  // installer-migration-authoring.test.cjs scoring 12 while running ~0.1s, and the
  // two heaviest files in the whole suite scoring 1 — run-tests-harness.test.cjs
  // (never matched the prefix) and release-tarball-smoke.install.test.cjs (the
  // regex is anchored to the START of the basename, so a mid-name "install" never
  // matches). Both landed in the same chunk, leaving the slowest chunk ~3.9x the
  // lightest and sitting near the timeout.
  //
  // Weight each file by its MEASURED duration instead. `MAX_FILES_PER_CHUNK`
  // remains the per-chunk weight budget and keeps its scale — weights are
  // normalized so an average-cost file weighs 1 — so an all-uniform suite chunks
  // exactly as it did before. Timings are ADVISORY, never gated: an unknown file
  // falls back to the table's median weight and a missing table falls back to
  // uniform weight 1, so staleness degrades chunk BALANCE gracefully instead of
  // failing CI. Regenerate via `node scripts/gen-test-timings.cjs <events.jsonl>`.
  // The cost table is loaded lazily above and memoized; both the shard
  // partition and this packer consume the same weigher (#2472).

  // node:test does not exit until the event loop drains. A unit test that leaks
  // an open handle (un-terminated Worker, un-killed child_process, ref'd timer)
  // makes a chunk's `node --test` child hang ~150s on Windows AFTER its last test
  // prints; two such stalls push the windows full lane past its 20m cap and the
  // job is CANCELLED with no failed step — a false-negative gate (#1051, recurrence
  // of #869). --test-force-exit (Node >=22; engines requires >=22.0.0) exits the
  // runner once all tests finish regardless of lingering handles. The leaking
  // tests are also fixed at the source; this is the defensive backstop.
  // RUN_TESTS_NO_FORCE_EXIT=1 disables it (used by the harness regression test to
  // observe the pre-fix hang).
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const forceExit = nodeMajor >= 22 && !process.env.RUN_TESTS_NO_FORCE_EXIT;

  const FIXED_OVERHEAD = process.execPath.length + '--test'.length + concurrency.length + (forceExit ? '--test-force-exit'.length + 1 : 0) + 8;
  const chunks = packChunks(selected, {
    weightOf: fileWeightOf(),
    maxWeight: MAX_FILES_PER_CHUNK,
    maxChars: MAX_CMDLINE_CHARS,
    fixedOverhead: FIXED_OVERHEAD,
  });

  // A chunk that still hangs (a leak the backstop somehow misses, or a wedged
  // subprocess) must fail loudly rather than silently burn the job's wall-clock
  // budget until the CI runner cancels the whole job. Default 10 min per chunk:
  // well above a healthy chunk (~4-5 min on the windows lane) but below the 20m
  // job cap. Operator/test override via RUN_TESTS_CHUNK_TIMEOUT_MS.
  const chunkTimeoutMs = positiveNumberEnv(process.env.RUN_TESTS_CHUNK_TIMEOUT_MS, 600000);

  let firstFailureExit = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) {
      console.error(`run-tests: chunk ${i + 1}/${chunks.length} — ${chunks[i].length} files`);
    }
    try {
      execFileSync(
        process.execPath,
        ['--test', ...(forceExit ? ['--test-force-exit'] : []), concurrency, ...chunks[i]],
        {
          stdio: 'inherit',
          env: { ...process.env },
          timeout: chunkTimeoutMs,
        },
      );
    } catch (err) {
      // When the per-chunk timeout fires, execFileSync kills the child and
      // surfaces it as err.code === 'ETIMEDOUT' (POSIX) and/or err.killed === true
      // (platform-dependent). Check both so detection holds on Windows and POSIX.
      const timedOut = err.killed === true || err.code === 'ETIMEDOUT';
      if (timedOut) {
        console.error(
          `run-tests: chunk ${i + 1}/${chunks.length} exceeded the per-chunk timeout ` +
            `of ${chunkTimeoutMs}ms and was killed. Two possible causes: (1) a test leaks ` +
            `an open handle (un-terminated Worker, un-killed child process, or ref'd timer) ` +
            `so node --test never exits — but --test-force-exit already guards that, so if it ` +
            `is enabled suspect (2) the chunk is legitimately too slow for the budget (too ` +
            `many/too-heavy files packed together). Check whether output kept flowing until ` +
            `the kill (slow) vs stopped early (hang) before assuming a leak. Files: ${chunks[i]
              .map(f => f.split(/[\\/]/).pop())
              .join(' ')}`,
        );
      }
      const code = err.status || 1;
      if (firstFailureExit === 0) firstFailureExit = code;
      if (timedOut) {
        // A timeout has already burned a large share of the job's budget
        // (chunkTimeoutMs defaults to 600000ms, i.e. half the 20m CI job
        // cap), so — unlike an ordinary test failure — letting the loop
        // fall through to the remaining chunks risks the CI runner
        // cancelling the whole job before they finish. That cancellation
        // replaces the loud, specific diagnostic printed above with an
        // opaque "The operation was canceled." buried at the very end of
        // the log, thousands of lines past the real cause (observed live on
        // CI run 29749380190: chunk 1/5 timed out, the loop pressed on
        // through chunks 2-4, and the job was cancelled mid-chunk-5 — the
        // timeout message was ~38,000 log lines from the end and
        // `gh run view --log-failed` returned nothing). Abort the remaining
        // chunks instead so the operator actually sees this message.
        const skipped = chunks.length - (i + 1);
        if (skipped > 0) {
          console.error(
            `run-tests: aborting — skipping the remaining ${skipped} chunk${skipped === 1 ? '' : 's'} ` +
              `after the chunk ${i + 1}/${chunks.length} timeout rather than risk the CI runner ` +
              `cancelling the job (and burying this diagnostic) before they finish.`,
          );
        }
        break;
      }
      // A non-timeout failure is cheap in wall-clock terms (the child exits
      // promptly on its own), so — unlike the timeout case above — run every
      // remaining chunk anyway: the operator sees all failures in one pass,
      // and the first non-zero exit is reported at the end.
    }
  }
  if (firstFailureExit !== 0) return firstFailureExit;
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  suiteOf,
  ensureBuiltArtifacts,
  ensureBuiltHooks,
  parseShardArg,
  selectShard,
  positiveNumberEnv,
  loadTestTimings,
  makeFileWeigher,
  packChunks,
  DEFAULT_TIMINGS_PATH,
};
