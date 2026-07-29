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
//   1. Run the per-module Stryker shard locally.
//   2. Note the reported score.
//   3. Set minScore = floor(score) - 1 (never lower than current value).
//   4. Open a PR — the CI gate will enforce the new floor on every future run.

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
