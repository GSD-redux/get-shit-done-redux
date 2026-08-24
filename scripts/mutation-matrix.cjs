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
//   1. The per-module Stryker shard CANNOT be run locally: Stryker's command
//      runner invokes `node --test` once per mutant (see stryker.config.mjs),
//      and this repo hard-blocks local `node --test` via
//      .claude/hooks/block-local-node-test.sh. Push the branch instead and
//      let CI run the shard for the changed module.
//   2. Read the measured score from the CI shard's output.
//   3. Set minScore = floor(measured) - 1 (never lower than current value)
//      and update the matching RATCHET_BASELINE entry in the same diff.
//   4. Open/update the PR — the CI gate will enforce the new floor on every
//      future run.

/** Long-run target for all modules (ADR-456). */
const TARGET_MUTATION_SCORE = 80;

// ── Single source of truth: covered modules ───────────────────────────────────
// Each entry: { cjs: '<built artifact>', tests: ['tests/...', ...], minScore: N }
//
// minScore is the CI break threshold for this module's shard.
// Floors are measured scores minus 1–2 pts for run-to-run variance.
// Measured CI scores 2026-06-14 (issue #1187, timeout-free — source of truth):
//   context-utilization     92.31% → floor 80  (target already met)
//   prompt-budget           68.33% → floor 66  (local was 99.6% — TIMEOUT INFLATION; CI is the truth)
//   frontmatter             63.35% → floor 62
//   adr-parser              69.30% → floor 68
//   config-schema           54.55% → floor 52  (local was 69.7% — TIMEOUT INFLATION; CI is the truth)
//   active-workstream-store 81.91% → floor 80
//   core-utils              77.52% → floor 75
//
// LESSON: floors MUST be calibrated from CI mutation runs (CI runs with
// timeout≈0, deterministic). Local runs count timeouts as kills and
// inflate scores significantly (prompt-budget: 99.6% local vs 68.3% CI;
// config-schema: 69.7% local vs 54.55% CI). Never set a floor from a
// local run without CI cross-check.
const COVERED = {
  'context-utilization': {
    cjs: 'gsd-core/bin/lib/context-utilization.cjs',
    tests: [
      'tests/context-utilization.property.test.cjs',
    ],
    // After mutation-killer assertions added in #1187: measured 92.31% (2026-06-14).
    // 3 survivors are __esModule boilerplate (genuinely equivalent CJS interop mutants).
    // minScore raised to TARGET (80) — module now meets ADR-456 goal.
    minScore: 80,
  },
  // context-composer: extracted from prompt-budget by #2929. Needs its own entry because
  // mutation coverage does not migrate with relocated code — scoring only prompt-budget.cjs
  // would leave the extracted ladder unmeasured.
  'context-composer': {
    cjs: 'gsd-core/bin/lib/context-composer.cjs',
    tests: [
      'tests/prompt-budget-parity.test.cjs',
      'tests/prompt-budget.unit.test.cjs',
      'tests/context-composer.test.cjs',
      'tests/context-composer.property.test.cjs',
    ],
    minScore: 66,
  },
  'prompt-budget': {
    cjs: 'gsd-core/bin/lib/prompt-budget.cjs',
    tests: [
      'tests/prompt-budget.property.test.cjs',
      'tests/prompt-budget.unit.test.cjs',
    ],
    // CI 68.33% timeout-free (164 killed / 1 timeout / 240 total) 2026-06-14;
    // local was 99.6% — timeout inflation. Floor = 68 - 2 margin.
    minScore: 66,
  },
  frontmatter: {
    cjs: 'gsd-core/bin/lib/frontmatter.cjs',
    tests: [
      'tests/frontmatter.property.test.cjs',
      'tests/frontmatter.unit.test.cjs',
      // #1882 added the unterminated-fence detection to frontmatter.cjs, and the tests that
      // constrain it live here. Without this entry the mutants in that branch are covered by
      // no test in the shard, so the module's score drops even though the behaviour is tested.
      'tests/unusable-input.test.cjs',
    ],
    minScore: 62,
  },
  'adr-parser': {
    cjs: 'gsd-core/bin/lib/adr-parser.cjs',
    tests: [
      'tests/adr-parser.property.test.cjs',
      'tests/adr-parser.test.cjs',
      'tests/adr-parser.unit.test.cjs',
    ],
    minScore: 68,
  },
  'config-schema': {
    cjs: 'gsd-core/bin/lib/config-schema.cjs',
    tests: [
      'tests/config-schema.property.test.cjs',
    ],
    // CI 54.55% timeout-free (18 killed / 0 timeout / 33 total) 2026-06-14;
    // local was 69.7% — timeout inflation. Floor = 54 - 2 margin.
    minScore: 52,
  },
  'active-workstream-store': {
    cjs: 'gsd-core/bin/lib/active-workstream-store.cjs',
    tests: [
      'tests/active-workstream-store.test.cjs',
      'tests/active-workstream-store.unit.test.cjs',
    ],
    minScore: 80,
  },
  'core-utils': {
    cjs: 'gsd-core/bin/lib/core-utils.cjs',
    tests: [
      'tests/core-utils.test.cjs',
    ],
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
  'planning-inspect': {
    cjs: 'gsd-core/bin/lib/planning-inspect.cjs',
    tests: [
      'tests/planning-inspect.unit.test.cjs',
    ],
    minScore: 56,
  },
  'plan-document': {
    cjs: 'gsd-core/bin/lib/plan-document.cjs',
    tests: [
      'tests/planning-inspect.unit.test.cjs',
    ],
    minScore: 75,
  },
  'planning-command-router': {
    cjs: 'gsd-core/bin/lib/planning-command-router.cjs',
    tests: [
      'tests/planning-inspect.unit.test.cjs',
    ],
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
  // Measured CI score (GitHub Actions run 32605073352, job 97108869486):
  //   model-catalog 59.62% → floor 58  (248 killed, 168 survived, 0 timeouts,
  //     0 errors; below TARGET_MUTATION_SCORE (80) — ratchet candidate like
  //     planning-inspect (56): comfortably clears its own floor but has real
  //     room to grow. Raise as its tests improve, never lower it.)
  // Floor follows this file's documented rule, minScore = floor(measured) - 1,
  // matching the sibling precedent exactly (57.03 → 56, 76.58 → 75, 95.65 → 94).
  //
  // The shard completed in 57 seconds — concrete evidence the spawn-free
  // unit-file design above worked: the #2790 precedent's 15-minute shard-cap
  // cancellations do not apply here, and for comparison the `frontmatter`
  // shard in the same run took 9m46s.
  'model-catalog': {
    cjs: 'gsd-core/bin/lib/model-catalog.cjs',
    tests: ['tests/model-catalog.unit.test.cjs'],
    minScore: 58,
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
  // minScore of 50 is the ratchet's minimum permitted floor — the bound
  // enforced by tests/mutation-matrix-ratchet.test.cjs's minScore range check
  // (50-100 inclusive) — and is the initial floor for a newly-registered
  // module whose score has not yet been measured on CI. Registering at the
  // floor is deliberate: it makes the shard RUN and REPORT, where leaving the
  // module out of COVERED makes the gate skip it silently (has_work: "false"),
  // the exact failure mode #2790 and #3007 above were added to fix. This PR's
  // shard run measures the real score before merge, and the floor is then
  // ratcheted up to floor(measured) - 1, the same post-hoc calibration path
  // the model-catalog entry above documents. A measured score below 50 reds
  // the shard and blocks the merge — the gate working as designed. The floor
  // MUST come from a CI shard, never a local run: local runs count timeouts
  // as kills and inflate scores badly (this file already records
  // prompt-budget 99.6% local vs 68.33% CI, and config-schema 69.7% local vs
  // 54.55% CI).
  'state-contract': {
    cjs: 'gsd-core/bin/lib/state-contract.cjs',
    tests: ['tests/state-contract.unit.test.cjs'],
    minScore: 50,
  },
};

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

// Export internals for programmatic use (tests/mutation-matrix-ratchet.test.cjs).
// The require.main guard prevents main() from running when this file is require()d.
module.exports = { COVERED, TARGET_MUTATION_SCORE, resolveMutationBreak, readStdinSync };

if (require.main === module) runMain(main);
