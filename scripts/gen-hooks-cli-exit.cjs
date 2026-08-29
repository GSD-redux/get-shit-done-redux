#!/usr/bin/env node
/**
 * gen-hooks-cli-exit.cjs — generates hooks/lib/cli-exit.js from a fresh
 * compile of src/cli-exit.cts.
 *
 * ADR-3889 Phase 7 (#3911): shipped hooks must be able to terminate through
 * `terminateNow` WITHOUT depending on any build artifact. hooks/ runs
 * straight from a raw, unbuilt clone (a hook is required by name via
 * `require('./lib/cli-exit.js')` relative to the hook's own __dirname), so
 * the generated file is compiled to a THROWAWAY outDir rather than read from
 * gsd-core/bin/lib/ — reading the tracked build output would let a stale
 * build produce a false green. This mirrors scripts/gen-scripts-cli-exit.cjs
 * exactly (same compile-to-temp strategy, same banner/check/write shape);
 * kept as a SIBLING script rather than folded into that one because
 * gen-scripts-cli-exit.cjs is hard-coded to a single output path/extension
 * (`scripts/lib/cli-exit.cjs`) throughout its BANNER prose and REASON
 * messaging — parameterizing it for a second, differently-extensioned
 * target (`.js`, not `.cjs`, to match the hooks/lib/*.js convention) would
 * tangle a script that is otherwise simple and single-purpose.
 *
 * Usage:
 *   node scripts/gen-hooks-cli-exit.cjs            # same as --write
 *   node scripts/gen-hooks-cli-exit.cjs --write     # write hooks/lib/cli-exit.js
 *   node scripts/gen-hooks-cli-exit.cjs --check     # exit 1 if committed file is stale
 *   node scripts/gen-hooks-cli-exit.cjs --out <path>   # override the output path (default: hooks/lib/cli-exit.js) — honoured by BOTH --write and --check
 *
 * `--out` restores parity with the sibling scripts/gen-exit-code-registry.cjs,
 * which already supports `--out`/`--scripts-out`/`--hooks-out`/`--dts-out`/
 * `--sh-out` overrides honoured by its own `--check`. This script hardcoding
 * `OUTPUT_PATH` with no override was an inconsistency between two sibling
 * generators, not an intentionally narrower surface — tests need to redirect
 * `--check` at a disposable tmpdir copy instead of corrupting the real
 * committed artifact in place.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'hooks', 'lib', 'cli-exit.js');
const COMPILE_TIMEOUT_MS = 60_000;

/** Frozen reason codes so tests assert on structure, not prose. */
const REASON = Object.freeze({
  OK: 'ok_generated_sync',
  DRIFTED: 'fail_generated_drifted',
  BUILD_FAILED: 'fail_build_failed',
  MISSING_EMIT: 'fail_missing_emit',
  USAGE: 'fail_usage',
});

const USAGE_MESSAGE = [
  'Usage: node scripts/gen-hooks-cli-exit.cjs [--write|--check] [--out <path>]',
  '  (no flag)  same as --write',
  '  --write    write hooks/lib/cli-exit.js',
  '  --check    exit 1 if the committed file is stale',
  '  --out      override the output artifact path (default: hooks/lib/cli-exit.js)',
].join('\n');

const BANNER = [
  '// GENERATED FILE — DO NOT EDIT BY HAND.',
  '// Source of truth: src/cli-exit.cts. Regenerate with:',
  '//   node scripts/gen-hooks-cli-exit.cjs --write',
  '// Byte-compared by `npm run lint:generated-sync` (#3911, ADR-3889 Phase 7).',
  '//',
  '// Why this copy exists: hooks/ runs straight from a raw, unbuilt clone — a',
  '// shipped hook must be able to `require(\'./lib/cli-exit.js\')` relative to',
  '// its own __dirname and terminate through `terminateNow` without depending',
  '// on any build artifact. gsd-core/bin/lib/cli-exit.cjs is gitignored tsc',
  '// output and doubles as the build sentinel, so it cannot be required from',
  '// here. `.js`, not `.cjs`, to match the hooks/lib/*.js convention. Hence one',
  '// source, three emitted locations (gsd-core/bin/lib, scripts/lib, hooks/lib).',
  '',
  '',
].join('\n');

/** Compile the whole project to a throwaway outDir so the work tree is untouched. */
function compileToTemp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hooks-cli-exit-'));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p', path.join(REPO_ROOT, 'tsconfig.build.json'),
        '--outDir', tmp,
        // A throwaway outDir must not reuse the in-tree incremental state, or
        // tsc skips emit for files it believes are already current.
        '--incremental', 'false',
        '--tsBuildInfoFile', 'null',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe', timeout: COMPILE_TIMEOUT_MS },
    );
    return { ok: true, dir: tmp };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return { ok: false, detail };
  }
}

/**
 * Compile src/cli-exit.cts to a throwaway outDir and return the expected
 * generated content (banner + compiled bytes, with the sibling registry
 * require rewritten to the `.js` extension hooks/lib/ uses), or a failure
 * descriptor.
 *
 * @returns {{ ok: true, content: string } | { ok: false, reason: string, detail?: string }}
 */
function buildExpectedContent() {
  const build = compileToTemp();
  if (!build.ok) {
    return { ok: false, reason: REASON.BUILD_FAILED, detail: build.detail };
  }
  try {
    const emitted = path.join(build.dir, 'cli-exit.cjs');
    if (!fs.existsSync(emitted)) {
      return { ok: false, reason: REASON.MISSING_EMIT, detail: `no emit produced at ${emitted} from src/cli-exit.cts` };
    }
    const compiled = fs.readFileSync(emitted, 'utf8');
    // hooks/lib/ ships `.js`, not `.cjs` (matching the hooks/lib/*.js
    // convention — see the module header), so the sibling registry require
    // tsc emits for src/cli-exit.cts's `require('./exit-code-registry.cjs')`
    // must be rewritten to resolve the `.js` copy scripts/gen-exit-code-
    // registry.cjs emits alongside this file, not the `.cjs` one. A literal,
    // anchored replace (never a regex) so this can only ever touch the exact
    // string tsc is known to emit for that one import.
    const REGISTRY_REQUIRE_CJS = 'require("./exit-code-registry.cjs")';
    const REGISTRY_REQUIRE_JS = 'require("./exit-code-registry.js")';
    if (!compiled.includes(REGISTRY_REQUIRE_CJS)) {
      return {
        ok: false,
        reason: REASON.MISSING_EMIT,
        detail: `expected compiled output to contain ${REGISTRY_REQUIRE_CJS} (the sibling registry require) — tsc's emit shape may have changed`,
      };
    }
    const rewritten = compiled.split(REGISTRY_REQUIRE_CJS).join(REGISTRY_REQUIRE_JS);
    return { ok: true, content: BANNER + rewritten };
  } finally {
    fs.rmSync(build.dir, { recursive: true, force: true });
  }
}

function doWrite(outPath) {
  const result = buildExpectedContent();
  if (!result.ok) {
    console.error(`FAIL gen-hooks-cli-exit: ${result.reason}`);
    if (result.detail) console.error(result.detail);
    return 1;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result.content, 'utf8');
  console.log(`ok gen-hooks-cli-exit: wrote ${path.relative(REPO_ROOT, outPath)}`);
  return 0;
}

function doCheck(outPath) {
  const result = buildExpectedContent();
  if (!result.ok) {
    console.error(`FAIL gen-hooks-cli-exit: ${result.reason}`);
    if (result.detail) console.error(result.detail);
    return 1;
  }

  if (!fs.existsSync(outPath)) {
    console.error(`FAIL gen-hooks-cli-exit: ${REASON.MISSING_EMIT}`);
    console.error(`  ${path.relative(REPO_ROOT, outPath)} does not exist. Run:`);
    console.error('  node scripts/gen-hooks-cli-exit.cjs --write');
    return 1;
  }

  const committed = fs.readFileSync(outPath, 'utf8');
  if (committed !== result.content) {
    console.error(`FAIL gen-hooks-cli-exit: ${REASON.DRIFTED}`);
    console.error(
      `  ${path.relative(REPO_ROOT, outPath)} (${committed.length} bytes) != ` +
      `compile of src/cli-exit.cts (${result.content.length} bytes)`,
    );
    console.error('');
    console.error('Regenerate with:');
    console.error('  node scripts/gen-hooks-cli-exit.cjs --write');
    return 1;
  }

  console.log(`ok gen-hooks-cli-exit: ${path.relative(REPO_ROOT, outPath)} matches src/cli-exit.cts`);
  return 0;
}

/**
 * @returns {{mode:'write'|'check', outPath:?string}}
 */
function parseArgs(argv) {
  let mode = null;
  let outPath = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write' || arg === '--check') {
      if (mode !== null) {
        throw new Error(`conflicting mode flags: --${mode} and ${arg}`);
      }
      mode = arg === '--write' ? 'write' : 'check';
    } else if (arg === '--out') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--out requires a value');
      outPath = value;
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }

  return { mode: mode || 'write', outPath };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`FAIL gen-hooks-cli-exit: ${REASON.USAGE}`);
    console.error(`  ${err.message}`);
    console.error(USAGE_MESSAGE);
    return 1;
  }

  const outPath = args.outPath || OUTPUT_PATH;

  return args.mode === 'check' ? doCheck(outPath) : doWrite(outPath);
}

if (require.main === module) process.exitCode = main();

module.exports = { REASON, buildExpectedContent, OUTPUT_PATH, BANNER };
