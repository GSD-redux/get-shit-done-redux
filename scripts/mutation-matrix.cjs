#!/usr/bin/env node
'use strict';

/**
 * scripts/mutation-matrix.cjs
 *
 * Single source of truth for the ADR-457 Stryker mutation gate dynamic matrix.
 *
 * Computes which covered modules changed vs a base ref and emits a GitHub
 * Actions matrix JSON so CI can run one Stryker shard per changed module in
 * parallel rather than a single serial run over all modules.
 *
 * Usage:
 *   node scripts/mutation-matrix.cjs --base origin/next
 *   printf 'src/config-schema.cts\n' | node scripts/mutation-matrix.cjs
 *   node scripts/mutation-matrix.cjs --base origin/next --print
 *
 * Output (stdout, default): JSON object
 *   {
 *     "has_work": "true"|"false",
 *     "matrix": {
 *       "include": [
 *         { "name": "<module>", "mutate": "gsd-core/bin/lib/<module>.cjs", "tests": "<space-joined test files>" },
 *         ...
 *       ]
 *     }
 *   }
 *
 * Exit codes: 0 always (empty matrix is not an error, has_work "false").
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

// ── Resilient stdin reader ────────────────────────────────────────────────────
// On macOS, libuv sets the stdin pipe fd to non-blocking mode.  A synchronous
// readFileSync(process.stdin.fd) can therefore throw EAGAIN ("resource
// temporarily unavailable") when the writer hasn't yet filled the pipe — this
// is intermittent under heavy CI shard load and causes a spurious status 2
// exit.  We work around it by calling fs.readSync in a loop and retrying on
// EAGAIN with a 1 ms synchronous pause (Atomics.wait on a fresh SharedArrayBuffer
// — no hot spin, no real-clock dependency, works under --experimental-vm-modules).
/**
 * Read all of stdin synchronously, retrying on EAGAIN.
 *
 * @returns {string} UTF-8 decoded full stdin content.
 */
function readStdinSync() {
  const BUF_SIZE = 64 * 1024; // 64 KB chunks
  const buf = Buffer.allocUnsafe(BUF_SIZE);
  const chunks = [];

  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(process.stdin.fd, buf, 0, BUF_SIZE, null);
    } catch (err) {
      if (err.code === 'EAGAIN') {
        // Non-blocking pipe not yet ready — yield for ~1 ms then retry.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        continue;
      }
      if (err.code === 'EOF') {
        break;
      }
      throw err;
    }
    if (bytesRead === 0) {
      break; // Clean EOF
    }
    chunks.push(Buffer.from(buf.slice(0, bytesRead)));
  }

  return Buffer.concat(chunks).toString('utf8');
}

// ── Per-module mutation score ratchet ─────────────────────────────────────────
// ADR-456 / issue #1187: every covered module declares a minScore floor.
//
// HOW THE RATCHET WORKS:
//   • minScore locks in the current measured mutation score (minus a 1–2 pt
//     margin for run-to-run timeout variance).
//   • CI fails a shard if the module's live score drops below its minScore.
//   • Raise minScore (never lower) as a module's tests improve.
//   • The goal is every module reaching TARGET_MUTATION_SCORE (80).
//
// GOODHART SAFETY: scores are improved by writing genuine behavioural
// assertions that kill real mutants — never by adding brittle exact-string
// matches on incidental output. A justified `// Stryker disable` on a
// confirmed equivalent mutant is acceptable.
//
// HOW TO UPDATE:
//   1. The per-module Stryker shard CANNOT be run locally: Stryker's tap
//      runner (see stryker.config.mjs) spawns
//      `node --test-reporter=tap -r <hook> <testFile>` once per covering test
//      file per mutant, and .claude/hooks/block-local-node-test.sh's matcher
//      still denies that form — its pattern `node(\s+-\S+)*\s+--test([\s=-]|$)`
//      matches `--test-reporter` because `-` is in the trailing character
//      class. Push the branch instead and let CI run the shard for the
//      changed module.
//   2. Read the measured score from the CI shard's output.
//   3. Set minScore = floor(measured) - 1 (never lower than current value)
//      and update the matching RATCHET_BASELINE entry in the same diff.
//   4. Open/update the PR — the CI gate will enforce the new floor on every
//      future run.

/** Long-run target for all modules (ADR-456). */
const TARGET_MUTATION_SCORE = 80;

// ── Derived test-list engine (#3881 follow-up, "one YAML parser" mutation-matrix
//    piece 2) ─────────────────────────────────────────────────────────────────
//
// PROBLEM THIS REPLACES: `tests: [...]` used to be a hand-maintained array per
// module, and `stryker.config.mjs`'s DEFAULT_TEST_CMD hand-duplicated the union
// of every such array in a second literal. The two drifted independently — PR
// #3888 shipped four new frontmatter test files that were never added to either
// list, so their mutants had zero constraining coverage and the shard's score
// silently fell (see the frontmatter entry's own PR #3888 note below, kept for
// history). A hand list can be forgotten; a derivation cannot forget a file that
// exists on disk.
//
// SIGNAL: a test file that directly `require()`s a covered module's built
// artifact (`gsd-core/bin/lib/<name>.cjs`) is declaring, by that require, that
// it constrains that module. That signal alone is far too broad to feed a
// per-mutant re-run budget: measured directly (no filter) against this tree,
// config-schema alone picks up 22 files most of this repo's spawn-heavy
// integration suites require incidentally for fixture setup — including a file
// literally named `graphify-auto-update.slow.test.cjs`. Stryker's command
// runner re-runs the WHOLE test command once per mutant, so an incidental
// integration require would multiply that module's shard cost by 10-20x for
// zero mutation-killing benefit (those suites do not assert on config-schema's
// internals; they merely load it as a dependency of something else under test).
//
// NARROWING RULE: a file is auto-derived into a module's shard only when BOTH
// hold:
//   1. it directly requires that module's `gsd-core/bin/lib/<name>.cjs`, and
//   2. its own filename starts with the module's name followed by `.` or `-`
//      (i.e. `<name>.test.cjs`, `<name>.unit.test.cjs`, `<name>.property.test.cjs`,
//      `<name>-anything.test.cjs`) — the file DECLARES itself, by its own name,
//      to be that module's dedicated test surface. This is the exact naming
//      shape every entry in this registry already used before this change
//      (`*.property.test.cjs` / `*.unit.test.cjs`, or `<name>.test.cjs`), now
//      made load-bearing instead of merely conventional.
// Measured effect of narrowing config-schema this way: 22 candidates -> 1
// (config-schema.property.test.cjs, the file already in the shard) — the
// naming filter is what keeps the derivation from silently tripling that
// shard's cost, per the piece-2 "watch the cost consequence" requirement.
//
// ESCAPE HATCHES (both REQUIRED to be explicit, reasoned per-module entries —
// never a silent list):
//   - `extraTests`: files that constrain this module (genuinely, by writing
//     assertions against its behaviour) but do not match the naming rule
//     above — either because the module was extracted from another file's
//     tests (context-composer) or because the file's own name follows a
//     different, still-legible convention (feat-3881-yaml-parser-consequences.test.cjs).
//   - `excludeTests`: files that DO match the naming + require signal above
//     (so the derivation would otherwise auto-include them) but are
//     deliberately withheld from the per-mutant shard for a measured,
//     documented reason (almost always: they are integration-shaped and
//     spawn a subprocess per case, so Stryker's per-mutant re-run of the
//     whole file cannot finish inside the shard's timeout — the exact #2790
//     planning-inspect.test.cjs precedent this file already documented before
//     this change; the derivation engine now enforces that precedent by
//     construction instead of leaving it to reviewer memory).
// `computeModuleTests` combines all three into the final `tests` array; the
// guard `scripts/lint-mutation-test-derivation-drift.cjs` independently
// verifies every SIGNAL-matching file (require + naming rule, unfiltered by
// this module's own excludeTests) has an explicit disposition — auto-derived,
// named in extraTests, or named in excludeTests — so a file that newly starts
// matching the naming rule (like #3888's four files would have, had they been
// named `frontmatter*`) cannot silently fall through the cracks again.
const TESTS_DIR = path.join(__dirname, '..', 'tests');
let _testRequireCache = null;

/**
 * Scan every `tests/*.test.cjs` file once and cache, per covered module name,
 * which files directly `require('gsd-core/bin/lib/<name>.cjs')` (or a relative
 * equivalent — `../gsd-core/bin/lib/<name>` etc. — the require path always
 * ends in the literal segment matched below). Pure w.r.t. process lifetime;
 * the tests/ directory does not change while this process runs.
 *
 * @returns {Map<string, Set<string>>} module name -> Set of basenames (e.g. 'frontmatter.test.cjs')
 */
function scanTestRequires() {
  if (_testRequireCache) return _testRequireCache;
  const REQUIRE_RE = /require\(\s*['"](?:[./]*)?gsd-core\/bin\/lib\/([a-zA-Z0-9_-]+)(?:\.cjs)?['"]\s*\)/g;
  const cache = new Map();
  let entries;
  try {
    entries = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.cjs'));
  } catch {
    entries = [];
  }
  for (const file of entries) {
    const text = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(text))) {
      const mod = m[1];
      if (!cache.has(mod)) cache.set(mod, new Set());
      cache.get(mod).add(file);
    }
  }
  _testRequireCache = cache;
  return cache;
}

/**
 * Every test file that directly requires `<moduleName>`'s built artifact —
 * the FULL, unfiltered signal set (used by the derivation-drift guard, which
 * must see every candidate regardless of naming, so it can demand an explicit
 * disposition for each one).
 *
 * @param {string} moduleName
 * @returns {string[]} sorted basenames
 */
function findRequiringTestFiles(moduleName) {
  const set = scanTestRequires().get(moduleName);
  return set ? [...set].sort() : [];
}

/** True when `file`'s own name declares it a dedicated test surface for `moduleName`
 * (`<moduleName>.test.cjs`, or starts with `<moduleName>.` / `<moduleName>-`). */
function matchesModuleNamingRule(moduleName, file) {
  return file === `${moduleName}.test.cjs`
    || file.startsWith(`${moduleName}.`)
    || file.startsWith(`${moduleName}-`);
}

/**
 * Auto-derived candidates for `moduleName`: requires the module's artifact AND
 * matches the naming rule. Does NOT apply that module's own `excludeTests` —
 * callers combine that separately (`computeModuleTests` for the real shard,
 * the guard for candidate enumeration).
 */
function deriveNamedTests(moduleName) {
  return findRequiringTestFiles(moduleName).filter((f) => matchesModuleNamingRule(moduleName, f));
}

/**
 * Final `tests` array for a COVERED entry: auto-derived (require + naming
 * rule) UNION `extraTests` MINUS `excludeTests`, sorted, each prefixed
 * `tests/`. Throws if `excludeTests` names a file that isn't actually a
 * derived candidate (an exclusion of nothing is a stale/typo'd entry, not a
 * real decision) or if `extraTests` names a file already auto-derived (that
 * would silently mask which mechanism is responsible for its presence).
 */
function computeModuleTests(moduleName, entry) {
  const derived = new Set(deriveNamedTests(moduleName));
  const extra = entry.extraTests || [];
  const exclude = entry.excludeTests || [];
  for (const f of extra) {
    if (derived.has(f)) {
      throw new Error(`mutation-matrix: COVERED['${moduleName}'].extraTests names '${f}', which is already auto-derived — remove it from extraTests (it is redundant and hides which mechanism includes it)`);
    }
  }
  for (const f of exclude) {
    if (!derived.has(f)) {
      throw new Error(`mutation-matrix: COVERED['${moduleName}'].excludeTests names '${f}', which is not an auto-derived candidate for this module — remove the stale exclusion`);
    }
  }
  const excludeSet = new Set(exclude);
  const final = new Set();
  for (const f of derived) if (!excludeSet.has(f)) final.add(f);
  for (const f of extra) final.add(f);
  return [...final].sort().map((f) => `tests/${f}`);
}

// ── Single source of truth: covered modules ───────────────────────────────────
// Each entry: { cjs: '<built artifact>', extraTests: [...], excludeTests: [...], minScore: N }
// `tests` is no longer hand-written — computeModuleTests() derives it below
// from direct `require()`s of the module's artifact (see the derivation-engine
// header above). extraTests/excludeTests are the two REQUIRED, reasoned escape
// hatches; leave both `[]` (omit the key) when a module needs neither.
//
// minScore is the CI break threshold for this module's shard.
// Floors are measured scores minus 1–2 pts for run-to-run variance.
// Measured CI scores 2026-06-14 (issue #1187, timeout-free — source of truth):
//   context-utilization     92.31% → floor 80  (target already met)
//   prompt-budget           68.33% → floor 66  (local was 99.6% — TIMEOUT INFLATION; CI is the truth)
//   frontmatter             63.35% → floor 62  (SUPERSEDED — see 2026-08-25 below)
//   adr-parser              69.30% → floor 68
//   config-schema           54.55% → floor 52  (local was 69.7% — TIMEOUT INFLATION; CI is the truth)
//   active-workstream-store 81.91% → floor 80
//   core-utils              77.52% → floor 75
//
// Measured CI score 2026-08-25 (#3706, PR 3867):
//   frontmatter             66.67% → floor 65
//     #3706 added agentScalarNeedsDoubleQuoting to frontmatter.cts and exported
//     escapeDoubleQuoted, but the tests constraining them lived in
//     tests/runtime-converters.test.cjs, which this lane does NOT run — the same trap the
//     #1882 note on the frontmatter entry describes. The shard fell to 60.58 and broke the
//     floor. Direct unit tests for both were added to tests/frontmatter.unit.test.cjs, each
//     clause paired with a near-miss that must answer the opposite way, which took the module
//     above its pre-change score. Floor ratcheted per the HOW TO UPDATE formula above, and
//     RATCHET_BASELINE — which lives in tests/mutation-matrix-ratchet.test.cjs, not here — is
//     updated in the same diff as that procedure requires.
//
// PR #3888 (#3881 follow-up): the frontmatter shard's new tests were never registered here
//   (only the pre-existing frontmatter.property/unit + unusable-input ran), so Stryker's
//   mutants in the new vendored-parser adapter code had nothing constraining them. Score fell
//   to 55.8% against the 65 floor (748 killed / 593 survived / 17 timeout) and the shard also
//   blew the 15-minute cap. Fixed by registering the branch's four new/changed frontmatter
//   test files in the tests array above (see that entry's inline comment for which files and
//   why) and giving the shard a measured 180-minute budget via timeoutMinutes. minScore left
//   at 65 pending a fresh CI measurement with the corrected test list.
//
// LESSON: floors MUST be calibrated from CI mutation runs (CI runs with
// timeout≈0, deterministic). Local runs count timeouts as kills and
// inflate scores significantly (prompt-budget: 99.6% local vs 68.3% CI;
// config-schema: 69.7% local vs 54.55% CI). Never set a floor from a
// local run without CI cross-check.
const COVERED = {
  'context-utilization': {
    cjs: 'gsd-core/bin/lib/context-utilization.cjs',
    // Derived: context-utilization.property.test.cjs (pre-existing) +
    // context-utilization.test.cjs (piece-2 derivation find: it directly requires and
    // matches the naming rule, but was never hand-added to the old literal list —
    // exactly the #3888 drift class this derivation exists to stop. Measured cost:
    // +50ms over the property-only baseline (58ms -> 108ms, in-process, 0 subprocess
    // spawns) — negligible for a shard whose floor is already at TARGET.
    // After mutation-killer assertions added in #1187: measured 92.31% (2026-06-14).
    // 3 survivors are __esModule boilerplate (genuinely equivalent CJS interop mutants).
    // minScore raised to TARGET (80) — module now meets ADR-456 goal. Not yet
    // re-measured against the wider (derived) test list; the added file only adds
    // assertions, never removes any, so the floor cannot have fallen.
    // CI run 33012034388 (2026-08-25, #3881 ratchet): measured 92.31% (unchanged from
    // the #1187 measurement above — same test list, re-confirmed by the mutation
    // ratchet's own audit). Floor = floor(92.31) - 1 = 91.
    minScore: 91,
  },
  // context-composer: extracted from prompt-budget by #2929. Needs its own entry because
  // mutation coverage does not migrate with relocated code — scoring only prompt-budget.cjs
  // would leave the extracted ladder unmeasured. Its own filename never matches the
  // "context-composer*" naming rule for prompt-budget-parity.test.cjs / prompt-budget.unit.test.cjs
  // — both genuinely constrain context-composer.cjs (the ladder was relocated INTO it), so
  // both are declared via extraTests rather than silently missing from the derivation.
  'context-composer': {
    cjs: 'gsd-core/bin/lib/context-composer.cjs',
    extraTests: [
      'prompt-budget-parity.test.cjs',
      'prompt-budget.unit.test.cjs',
    ],
    // CI run 33012034388 (2026-08-25, #3881 ratchet): measured 79.92%. Floor =
    // floor(79.92) - 1 = 78.
    minScore: 78,
  },
  'prompt-budget': {
    cjs: 'gsd-core/bin/lib/prompt-budget.cjs',
    // Derived: property + unit (pre-existing) plus two piece-2 derivation finds that
    // directly require prompt-budget.cjs and match the naming rule but were never in the
    // old hand list — prompt-budget-parity.test.cjs and prompt-budget.test.cjs. Measured
    // cost: 475ms (2-file) -> 527ms (4-file), in-process, 0 subprocess spawns; +52ms is
    // negligible next to this module's own mutant count.
    // CI 68.33% timeout-free (164 killed / 1 timeout / 240 total) 2026-06-14;
    // local was 99.6% — timeout inflation. Floor = 68 - 2 margin. Not yet re-measured
    // against the wider (derived) test list; both added files only add assertions, never
    // remove any, so the floor cannot have fallen.
    // CI run 33012034388 (2026-08-25, #3881 ratchet): re-measured against the wider
    // (derived) test list at 88.95%. Floor = floor(88.95) - 1 = 87.
    minScore: 87,
  },
  frontmatter: {
    cjs: 'gsd-core/bin/lib/frontmatter.cjs',
    // extraTests: files that genuinely constrain frontmatter.cjs but do not match the
    // "frontmatter*" naming rule, so the derivation cannot find them on its own —
    // each earns its slot on evidence, not blanket inclusion (verified no two duplicate
    // the same constraining assertion):
    //   - unusable-input.test.cjs: #1882 added the unterminated-fence detection to
    //     frontmatter.cjs, and the tests that constrain it live here. Without this entry
    //     the mutants in that branch are covered by no test in the shard.
    //   - feat-3881-yaml-parser-consequences.test.cjs: consequence/boundary matrix for the
    //     #3881 parser swap (state-transition interop, unusable-input counters, and — as of
    //     the piece-1 mutation-matrix fix below — the relocated anchor-alias-bomb + B1/B2
    //     block-scalar assertions). Nothing else in the shard drives
    //     extractFrontmatter/reconstructFrontmatter through those seams.
    extraTests: [
      'unusable-input.test.cjs',
      'feat-3881-yaml-parser-consequences.test.cjs',
    ],
    // excludeTests: files the derivation WOULD auto-include (require frontmatter.cjs
    // directly AND match the "frontmatter*" naming rule) but are deliberately withheld:
    //   - frontmatter-cli.test.cjs: 778-line CLI-integration file, 39 subprocess-spawn
    //     references (spawnSync/execFileSync/runGsdTools) — the same #2790
    //     planning-inspect.test.cjs shape (a `node --test <file>` invocation Stryker's
    //     command runner re-runs whole, once per mutant, at whatever its slowest spawn
    //     case costs). Never measured in a shard; excluded up front on the same evidence
    //     class rather than discovered by a timeout.
    //   - frontmatter.test.cjs: mutation-matrix piece 1 (#3881 follow-up). This
    //     2932-line integration file cost 3132ms of the shard's ~4800ms per-run
    //     (measured via node:test's run() API — node --test is hard-blocked locally,
    //     this is the sanctioned substitute), which at ~1850 mutants (source grew 1.8x
    //     for #3881) projected to ~96 of the shard's 140-minute total. Its two
    //     genuinely-unique assertion classes — anchor-alias-bomb refusal (billion-laughs
    //     -style anchor/alias expansion must be rejected, not expanded) and the B1/B2
    //     block-scalar assertions (parsing commands/gsd/add-tests.md must not invent a
    //     phantom "Example" key) — were relocated verbatim into
    //     feat-3881-yaml-parser-consequences.test.cjs (already in this shard via
    //     extraTests above) rather than deleted, so the mutants they kill stay killed.
    //     frontmatter.test.cjs itself is UNCHANGED and keeps running in the normal
    //     (non-mutation) suite — only the mutation shard drops it.
    excludeTests: [
      'frontmatter-cli.test.cjs',
      'frontmatter.test.cjs',
    ],
    minScore: 65,
    // MEASUREMENT, not a projection. Under the tap runner with coverageAnalysis: 'perTest'
    // (#3915), Stryker now re-runs only the test files that cover each mutated line instead
    // of all six files for every one of ~1900 mutants. Measured result: the frontmatter shard
    // completed in 713s (11m53s) — GitHub Actions run 33026833181, job wall time including
    // checkout and `npm ci` — against 1751s (29m11s) on the command runner in run
    // 33021042847. A 59% reduction.
    // 20 minutes is 1.68x the measured 713s. The override is not simply deleted because the
    // shared default is 15 minutes, which 11m53s would fit inside — but only at 79% of
    // budget — and this module's mutant count grew 1.8x in a single change (#3881), so a
    // shard sitting at 79% of the shared default is one growth spurt from a red lane. 20
    // keeps a real margin while still cutting the previous 60-minute budget by 3x.
    // Scoped to this shard only via timeoutMinutes below — every other shard keeps the
    // 15-minute default emitted by buildResult(), well under GitHub Actions' 360-minute job
    // ceiling.
    timeoutMinutes: 20,
    // isolation: no knob left to tune (#3915). Per-file process isolation is now INHERENT
    // to @stryker-mutator/tap-runner — it drives Node's own `--test-reporter=tap` once per
    // covering test FILE, so every file already runs in its own process by construction.
    // The prior audit's 'none' vs 'process' comparison (recorded here before this change)
    // is moot: there is nothing left to opt in or out of.
  },
  // adr-parser / config-schema / active-workstream-store / core-utils: derivation reproduces
  // their prior hand lists exactly (every constraining file's own name already matched the
  // "<module>*" rule) — no extraTests/excludeTests needed. Note config-schema in particular:
  // an UNFILTERED require-scan finds 22 files that require config-schema.cjs, but only
  // config-schema.property.test.cjs matches the naming rule — the naming filter is what
  // keeps this shard from silently ballooning to include spawn-heavy integration suites
  // (e.g. graphify-auto-update.slow.test.cjs) that merely load config-schema as a fixture
  // dependency of something else under test.
  'adr-parser': {
    cjs: 'gsd-core/bin/lib/adr-parser.cjs',
    minScore: 68,
  },
  'config-schema': {
    cjs: 'gsd-core/bin/lib/config-schema.cjs',
    // CI 54.55% timeout-free (18 killed / 0 timeout / 33 total) 2026-06-14;
    // local was 69.7% — timeout inflation. Floor = 54 - 2 margin.
    // CI run 33012034388 (2026-08-25, #3881 ratchet): measured 75.51%. Floor =
    // floor(75.51) - 1 = 74.
    minScore: 74,
  },
  'active-workstream-store': {
    cjs: 'gsd-core/bin/lib/active-workstream-store.cjs',
    // CI run 33012034388 (2026-08-25, #3881 ratchet): measured 87.42%. Floor =
    // floor(87.42) - 1 = 86.
    minScore: 86,
  },
  'core-utils': {
    cjs: 'gsd-core/bin/lib/core-utils.cjs',
    minScore: 75,  // measured 77.52% (2026-06-14, issue #1187); floor = 77 - 2
  },
  // planning-inspect / plan-document / planning-command-router: net-new modules
  // added by #2790. Registered here so the Stryker gate stops SKIPPING them
  // (previously has_work: "false" — ~1000 LOC entirely outside mutation scoring).
  //
  // WHY THESE SHARDS POINT AT tests/planning-inspect.unit.test.cjs, NOT
  // tests/planning-inspect.test.cjs. CI evidence: two shards pointed at the
  // integration file were CANCELLED at the workflow's 15-minute cap —
  // "Mutation testing 4% (elapsed: ~3m, remaining: ~1h 19m) 27/640 tested".
  // tests/planning-inspect.test.cjs is INTEGRATION-shaped (91 cases, most
  // spawning a `gsd-tools` child process via `runGsdTools`); Stryker's command
  // runner treats the whole `node --test <file>` invocation as ONE test costing
  // whatever the slowest case costs (measured ~20s), and re-runs that entire
  // file once per mutant — 640 mutants x 20s cannot finish in 15 minutes.
  // tests/planning-inspect.unit.test.cjs is the dedicated, spawn-free,
  // in-process mutation surface for exactly these three modules (measured
  // locally: the whole file runs in well under a second) — the same shape
  // every other entry in this registry already uses (*.property.test.cjs /
  // *.unit.test.cjs). The integration suite is UNAFFECTED by this change: it
  // keeps running in full in the normal (non-mutation) test job, and remains
  // the source of truth for spawn-boundary/CLI-dispatch/read-only-proof
  // behaviour that an in-process unit file cannot exercise.
  //
  // Measured CI scores (GitHub Actions run 32392791843, all three shards
  // PASSED — not a local run; mutation shards run `node --test`, hard-blocked
  // in this repo's local environment):
  //   planning-command-router 95.65% → floor 94  (already exceeds TARGET_MUTATION_SCORE (80))
  //   plan-document            76.58% → floor 75
  //   planning-inspect         57.03% → floor 56  (well below TARGET (80) — ratchet
  //     candidate; comfortably clears its own floor but has real room to grow.
  //     Raise as its tests improve, never lower it.)
  //
  // All three shards point at tests/planning-inspect.unit.test.cjs (in-process,
  // spawn-free, ~0.3s dry run), not tests/planning-inspect.test.cjs — that is
  // what made measurement possible at all. The integration file spawns a
  // subprocess per case via runGsdTools; Stryker's command runner treats the
  // whole `node --test <file>` invocation as one test costing whatever the
  // slowest case costs (measured ~20s), and re-runs that entire file once per
  // mutant, so 640 mutants x 20s could not finish inside the 15-minute shard
  // cap. The integration suite is unaffected by this change: it keeps running
  // in full in the normal (non-mutation) test job.
  // planning-inspect's own name matches "planning-inspect.unit.test.cjs" via the naming
  // rule, so that file is auto-derived. planning-inspect.test.cjs (the excluded integration
  // file the comment above names) ALSO matches the naming rule and directly requires the
  // module, so it must be an explicit excludeTests entry now — the derivation would
  // otherwise auto-include it and reproduce the exact 15-minute-cap cancellation the
  // comment above documents.
  'planning-inspect': {
    cjs: 'gsd-core/bin/lib/planning-inspect.cjs',
    excludeTests: ['planning-inspect.test.cjs'],
    minScore: 56,
  },
  // plan-document / planning-command-router: their own names never appear in any test
  // filename (the shared dedicated unit file is named after planning-inspect, the module
  // #2790 extracted them alongside), so the naming-rule derivation finds nothing — same
  // cross-cutting shape as context-composer above. Declared via extraTests.
  'plan-document': {
    cjs: 'gsd-core/bin/lib/plan-document.cjs',
    extraTests: ['planning-inspect.unit.test.cjs'],
    minScore: 75,
  },
  'planning-command-router': {
    cjs: 'gsd-core/bin/lib/planning-command-router.cjs',
    extraTests: ['planning-inspect.unit.test.cjs'],
    minScore: 94,
  },
  // model-catalog: net-new registration by #3007. The module was entirely
  // outside mutation scoring (has_work: "false") before this entry, so the
  // #3007 per-model Codex effort rewrite (renderEffortForRuntime's
  // CODEX_MODEL_EFFORT lookup, the 'ultra' policy rejection, the ladder
  // walk-up clamp) had zero mutation coverage.
  //
  // Same #2790 precedent as planning-inspect above: this shard points at a
  // dedicated tests/model-catalog.unit.test.cjs, NOT tests/model-resolver.test.cjs
  // — that integration file uses runGsdTools heavily and would hit the same
  // 15-minute shard-cap cancellation #2790 documented (a `node --test <file>`
  // invocation is ONE test costing whatever its slowest case costs, re-run
  // per mutant). tests/model-catalog.unit.test.cjs is spawn-free, in-process,
  // and runs in well under a second.
  //
  // Prior context (#3007, GitHub Actions run 32605073352, job 97108869486):
  //   model-catalog 59.62% → floor 58  (248 killed, 168 survived, 0 timeouts,
  //     0 errors). SUPERSEDED by the 2026-08-27 measurement below.
  //
  // The shard completed in 57 seconds — concrete evidence the spawn-free
  // unit-file design above worked: the #2790 precedent's 15-minute shard-cap
  // cancellations do not apply here, and for comparison the `frontmatter`
  // shard in the same run took 9m46s.
  // model-catalog: derivation finds two files never in the old hand list —
  // model-catalog-runtime-defaults.test.cjs and model-catalog-valid-tiers.test.cjs — both
  // directly require model-catalog.cjs and match the "model-catalog*" naming rule. Measured
  // cost: 50ms (1-file) -> 196ms (3-file), in-process, 0 subprocess spawns; still far under
  // the 57s the shard already measured for the single-file set.
  //
  // CI run 33029755081 (2026-08-27, #3915): measured 75.26% (295 killed / 49 survived /
  //   48 no-coverage / 24 runtime-error, totalValid 392). Floor = floor(75.26) - 1 = 74,
  //   following this file's documented convention.
  //
  //   Why it moved so far: under #3915's tap-runner swap this shard first came back at
  //   57.91% against the old floor of 58. Diagnosis from the mutation report's own JSON:
  //   all 24 of its RuntimeError mutants are in the module's load-time catalog bootstrap,
  //   so mutating them makes model-catalog.cjs throw at `require`. Under `node --test`
  //   that is a failed test file and the mutant counts as Killed; under the tap runner
  //   the process dies before emitting TAP, which Stryker classifies RuntimeError and
  //   EXCLUDES from the denominator. Adding those 24 back as killed reproduces
  //   248/416 = 59.62 exactly — the pre-swap #3007 number — so detection never
  //   regressed, only its classification changed.
  //
  //   The floor was NOT lowered to absorb that. 11 new behavioural tests in
  //   tests/model-catalog.unit.test.cjs killed 68 previously-surviving mutants (227 ->
  //   295 killed), taking the module from 57.91 to 75.26 — now within striking distance
  //   of TARGET_MUTATION_SCORE (80) instead of the 59.62 it sat at before this change.
  //
  //   The floor MUST come from a CI shard, never a local run — same rule as every other
  //   entry in this file.
  'model-catalog': {
    cjs: 'gsd-core/bin/lib/model-catalog.cjs',
    minScore: 74,
  },
  // state-contract: net-new module from #3227. Without this entry the
  // Stryker gate reports has_work: "false" and SKIPS it entirely — the
  // exact gap #2790 (planning-inspect / plan-document / planning-command-router)
  // and #3007 (model-catalog) each had to fix after the fact.
  //
  // Same #2790 precedent as planning-inspect / model-catalog above: this
  // shard points at tests/state-contract.unit.test.cjs, NOT
  // tests/state-contract.test.cjs — the latter spawns a `gsd-tools` child
  // process per case via runGsdTools, and Stryker's command runner treats
  // the whole `node --test <file>` invocation as ONE test costing whatever
  // its slowest case costs, re-run once per mutant, so it cannot finish
  // inside the 15-minute shard cap. tests/state-contract.unit.test.cjs is
  // spawn-free and in-process.
  //
  // Measured CI score (GitHub Actions run 32769289750, job 97565813640,
  // `Stryker (state-contract)`, PASSED in 2m23s):
  //   state-contract 66.25% → floor 65  (below TARGET_MUTATION_SCORE (80) —
  //     ratchet candidate like planning-inspect (56) and model-catalog (58):
  //     comfortably clears its own floor but has real room to grow. Raise as
  //     its tests improve, never lower it.)
  // Floor follows this file's documented rule, minScore = floor(measured) - 1,
  // matching the sibling precedent exactly (57.03 → 56, 76.58 → 75,
  // 95.65 → 94, 59.62 → 58, 66.25 → 65).
  //
  // The floor MUST come from a CI shard, never a local run: local runs count
  // timeouts as kills and inflate scores badly (this file already records
  // prompt-budget 99.6% local vs 68.33% CI, and config-schema 69.7% local vs
  // 54.55% CI).
  // state-contract.test.cjs matches the naming rule and directly requires state-contract.cjs
  // but is the same spawn-heavy integration shape as planning-inspect.test.cjs (446 lines,
  // 16 subprocess-spawn references) — excluded explicitly rather than left to fall through.
  'state-contract': {
    cjs: 'gsd-core/bin/lib/state-contract.cjs',
    excludeTests: ['state-contract.test.cjs'],
    minScore: 65,
  },
};

// Compute the final, derived `tests` array for every COVERED entry. Done once, after the
// full COVERED literal above is built, so every entry's extraTests/excludeTests declarations
// are visible to computeModuleTests regardless of source order.
for (const [moduleName, entry] of Object.entries(COVERED)) {
  entry.tests = computeModuleTests(moduleName, entry);
}

// ── Files that, when changed, invalidate ALL modules ─────────────────────────
// Changes to the Stryker config, this script itself, or any covered test file
// affect all mutation scores and must force a full re-run.
const GLOBAL_TRIGGERS = new Set([
  'stryker.config.mjs',
  'scripts/mutation-matrix.cjs',
]);

// Also flag all test files that belong to any covered module as global triggers.
for (const mod of Object.values(COVERED)) {
  for (const t of mod.tests) {
    GLOBAL_TRIGGERS.add(t);
  }
}

// ── Argument parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { base: null, print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      out.base = argv[++i];
      if (!out.base || out.base.startsWith('--')) {
        throw new Error('--base requires a value');
      }
    } else if (arg.startsWith('--base=')) {
      out.base = arg.slice('--base='.length);
      if (!out.base) throw new Error('--base requires a value');
    } else if (arg === '--print') {
      out.print = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage:',
        '  node scripts/mutation-matrix.cjs --base <ref> [--print]',
        '  printf "src/foo.cts\\n" | node scripts/mutation-matrix.cjs [--print]',
        '',
        'Options:',
        '  --base <ref>   Git ref to diff against (default: origin/${GITHUB_BASE_REF:-next})',
        '  --print        Human-readable output instead of JSON',
      ].join('\n'));
      throw new ExitError(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

// ── Changed-file resolution ───────────────────────────────────────────────────
function resolveChangedFiles(args) {
  // When --base is provided, always use git diff (regardless of stdin).
  // When --base is absent AND stdin is not a TTY (isTTY is falsy / undefined),
  // read a newline-delimited file list from stdin.
  if (!args.base && process.stdin.isTTY !== true) {
    const raw = readStdinSync();
    return raw.split('\n').map(l => l.trim()).filter(Boolean);
  }

  // Otherwise (--base given, or stdin is a real TTY), diff against the base ref.
  const defaultBase = `origin/${process.env.GITHUB_BASE_REF || 'next'}`;
  const base = args.base || defaultBase;
  const stdout = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

// ── Module classification ─────────────────────────────────────────────────────
function computeMatrix(changedFiles) {
  // Check for global triggers first — if any hit, include every covered module.
  const allModuleNames = Object.keys(COVERED);
  for (const f of changedFiles) {
    if (GLOBAL_TRIGGERS.has(f)) {
      return allModuleNames;
    }
  }

  // Otherwise find which modules have their src/*.cts changed.
  const changed = new Set();
  for (const f of changedFiles) {
    // Match src/<module>.cts (top-level src/, not nested)
    const m = f.match(/^src\/([^/]+)\.cts$/);
    if (m && COVERED[m[1]]) {
      changed.add(m[1]);
    }
  }
  return [...changed];
}

// ── Output formatting ─────────────────────────────────────────────────────────
function buildResult(moduleNames) {
  const include = moduleNames.map(name => ({
    name,
    mutate: COVERED[name].cjs,
    tests: COVERED[name].tests.join(' '),
    minScore: COVERED[name].minScore,
    // Per-shard CI job timeout in minutes. Defaults to 15 (the shared per-shard budget);
    // only a module that documents a measured need for more (see the frontmatter entry
    // above) sets a higher value. Threaded through mutation.yml's job-level
    // `timeout-minutes: ${{ matrix.timeoutMinutes }}`.
    timeoutMinutes: COVERED[name].timeoutMinutes || 15,
  }));

  return {
    has_work: include.length > 0 ? 'true' : 'false',
    matrix: { include },
  };
}

function printHuman(result, changedFiles) {
  console.log(`Changed files (${changedFiles.length}):`);
  for (const f of changedFiles) console.log(`  ${f}`);
  console.log('');
  console.log(`has_work: ${result.has_work}`);
  console.log(`Shards (${result.matrix.include.length}):`);
  for (const shard of result.matrix.include) {
    console.log(`  [${shard.name}]`);
    console.log(`    mutate:   ${shard.mutate}`);
    console.log(`    tests:    ${shard.tests}`);
    console.log(`    minScore: ${shard.minScore}`);
    console.log(`    timeoutMinutes:${shard.timeoutMinutes}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const changedFiles = resolveChangedFiles(args);
    const moduleNames = computeMatrix(changedFiles);
    const result = buildResult(moduleNames);

    if (args.print) {
      printHuman(result, changedFiles);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    if (err instanceof ExitError) throw err;
    console.error(`mutation-matrix: ${err.message}`);
    throw new ExitError(2);
  }
}

// ── MUTATION_BREAK resolver ───────────────────────────────────────────────────
/**
 * Resolves the per-shard mutation break threshold from the MUTATION_BREAK env var.
 *
 * Fail-closed contract:
 *   - undefined  → 60  (local run: no env set, documented backstop)
 *   - set but empty (e.g. CI matrix.minScore missing) → throws (wiring error)
 *   - non-numeric or out-of-range [1, 100] → throws (invalid config)
 *   - valid integer string → returns that number
 *
 * This function is the single call site for reading MUTATION_BREAK.
 * stryker.config.mjs imports and calls it so CI shards with a bad
 * MUTATION_BREAK fail immediately rather than silently falling back to 60
 * and bypassing a per-module floor above 60 (e.g. prompt-budget: 90).
 *
 * @param {string|undefined} raw - value of process.env.MUTATION_BREAK
 * @returns {number}
 */
function resolveMutationBreak(raw) {
  if (raw === undefined) {
    // Local run with no MUTATION_BREAK set — use documented backstop.
    return 60;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      'MUTATION_BREAK is set but empty — CI shard wiring is broken (matrix.minScore missing?)'
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    throw new Error(
      `MUTATION_BREAK invalid: "${raw}" (expected a per-module minScore 1-100)`
    );
  }
  return n;
}

/**
 * Sorted, de-duplicated union of every COVERED module's `tests` array. This
 * is the tap-runner's local/full-run default (see resolveMutationTestFiles
 * below) — the same union stryker.config.mjs's since-removed DEFAULT_TEST_CMD
 * string used to build for the command runner.
 *
 * @returns {string[]}
 */
function allCoveredTests() {
  return [...new Set(Object.values(COVERED).flatMap((mod) => mod.tests))].sort();
}

// ── MUTATION_TEST_FILES resolver ──────────────────────────────────────────────
/**
 * Resolves the per-shard tap-runner test-file list from the MUTATION_TEST_FILES
 * env var. Fail-closed twin of resolveMutationBreak above, for #3915's swap from
 * Stryker's `command` runner to `@stryker-mutator/tap-runner`: the tap runner
 * takes an explicit `tap.testFiles` array rather than a shell command, so there
 * is no single string to inject a per-shard test list into — this function is
 * that injection point instead.
 *
 * Fail-closed contract:
 *   - undefined → allCoveredTests() (local run: no env set, documented backstop)
 *   - non-string → throws (the realistic caller mistake: COVERED[*].tests is an
 *     array, but the env var this reads is the SPACE-JOINED STRING form of it —
 *     passing the array itself, or any other non-string, is a wiring bug)
 *   - set but empty/whitespace-only → throws (CI shard wiring is broken:
 *     matrix.tests missing)
 *   - otherwise → trim, split on whitespace, de-duplicate, sort, and, per
 *     entry: (1) resolve it against the repo root and reject any entry whose
 *     resolved path escapes the repo root (e.g. via `../` segments); (2)
 *     reject any entry that does not exist on disk, or that exists but is
 *     not a regular file (e.g. names a directory) — each failure throws
 *     naming the offending entry(ies)
 *
 * This function is the single call site for reading MUTATION_TEST_FILES.
 * stryker.config.mjs imports and calls it, so a bad value must fail
 * immediately rather than silently degrade: the tap runner's own
 * `findTestyLookingFiles` resolves `tap.testFiles` via `glob()`, and a
 * non-matching glob pattern yields an EMPTY list SILENTLY — which would
 * produce a fast, confident, meaningless mutation run (every mutant reported
 * killed or survived against zero tests) instead of a loud error.
 *
 * The `undefined` branch also runs the same on-disk existence check as every
 * other branch, so a stale `extraTests`/`excludeTests` entry in COVERED fails
 * loudly here rather than silently producing a shard pointed at a phantom file.
 *
 * @param {string|undefined} raw - value of process.env.MUTATION_TEST_FILES
 * @returns {string[]} sorted, de-duplicated, existence-checked test file paths
 */
function resolveMutationTestFiles(raw) {
  let entries;
  if (raw === undefined) {
    // Local run with no MUTATION_TEST_FILES set — use the derived full-run default.
    entries = allCoveredTests();
  } else if (typeof raw !== 'string') {
    throw new Error(
      `MUTATION_TEST_FILES must be a string (space-joined test file paths), got ${typeof raw} — ` +
      "COVERED[*].tests is an array internally, but the env var this reads is always the " +
      'SPACE-JOINED STRING form of it; passing the array (or any other non-string) directly is a wiring bug'
    );
  } else if (raw.trim() === '') {
    throw new Error(
      'MUTATION_TEST_FILES is set but empty — CI shard wiring is broken (matrix.tests missing?)'
    );
  } else {
    entries = [...new Set(raw.trim().split(/\s+/))].sort();
  }

  const repoRoot = path.join(__dirname, '..');

  const escaped = [];
  const missing = [];
  const notFile = [];
  for (const entry of entries) {
    const resolved = path.resolve(repoRoot, entry);
    const rel = path.relative(repoRoot, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      escaped.push(entry);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      missing.push(entry);
      continue;
    }
    if (!fs.statSync(resolved).isFile()) {
      notFile.push(entry);
    }
  }

  if (escaped.length > 0) {
    throw new Error(
      `MUTATION_TEST_FILES names ${escaped.length} entry(ies) that escape the repo root: ${escaped.join(', ')}`
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `MUTATION_TEST_FILES names ${missing.length} file(s) that do not exist on disk: ${missing.join(', ')}`
    );
  }
  if (notFile.length > 0) {
    throw new Error(
      `MUTATION_TEST_FILES names ${notFile.length} entry(ies) that are not a regular file: ${notFile.join(', ')}`
    );
  }

  return entries;
}

// Export internals for programmatic use (tests/mutation-matrix-ratchet.test.cjs).
// The require.main guard prevents main() from running when this file is require()d.
module.exports = {
  COVERED,
  TARGET_MUTATION_SCORE,
  resolveMutationBreak,
  allCoveredTests,
  resolveMutationTestFiles,
  readStdinSync,
  // Derivation-engine internals — exported for tests/mutation-test-derivation-drift.test.cjs
  // and scripts/lint-mutation-test-derivation-drift.cjs.
  findRequiringTestFiles,
  matchesModuleNamingRule,
  deriveNamedTests,
  computeModuleTests,
};

if (require.main === module) runMain(main);
