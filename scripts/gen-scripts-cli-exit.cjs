#!/usr/bin/env node
/**
 * gen-scripts-cli-exit.cjs — generates scripts/lib/cli-exit.cjs from a fresh
 * compile of src/cli-exit.cts.
 *
 * ADR-3889 Phase 0 (#3904): scripts/lib/cli-exit.cjs used to be a hand-written
 * fork of gsd-core/bin/lib/cli-exit.cjs (the compiled artifact of
 * src/cli-exit.cts). The two drifted — only the .cts copy routed a
 * non-ExitError throw through getJsonErrorMode() to emit a structured
 * { ok:false, reason, message } envelope. This script makes scripts/lib/cli-exit.cjs
 * a generated artifact of the SAME source, so the two surfaces cannot diverge
 * again.
 *
 * scripts/ runs straight from the repo checkout and must work on an unbuilt
 * clone (scripts/check-env.cjs requires this file before any build runs), so
 * the generated file is compiled to a THROWAWAY outDir rather than read from
 * gsd-core/bin/lib/ — reading the tracked build output would let a stale build
 * produce a false green.
 *
 * Usage:
 *   node scripts/gen-scripts-cli-exit.cjs            # same as --write
 *   node scripts/gen-scripts-cli-exit.cjs --write     # write scripts/lib/cli-exit.cjs
 *   node scripts/gen-scripts-cli-exit.cjs --check     # exit 1 if committed file is stale
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'cli-exit.cjs');
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
  'Usage: node scripts/gen-scripts-cli-exit.cjs [--write|--check]',
  '  (no flag)  same as --write',
  '  --write    write scripts/lib/cli-exit.cjs',
  '  --check    exit 1 if the committed file is stale',
].join('\n');

const BANNER = [
  '// GENERATED FILE — DO NOT EDIT BY HAND.',
  '// Source of truth: src/cli-exit.cts. Regenerate with:',
  '//   node scripts/gen-scripts-cli-exit.cjs --write',
  '// Byte-compared by `npm run lint:generated-sync` (#3904, ADR-3889 Phase 0).',
  '//',
  '// Why this copy exists: scripts/ runs straight from the repo checkout and must',
  '// work on an unbuilt clone — 64+ scripts require this file, including',
  '// check-env.cjs, which runs before any build. gsd-core/bin/lib/cli-exit.cjs is',
  '// gitignored tsc output and doubles as the build sentinel, so it cannot be',
  '// required from here. Hence one source, two emitted locations.',
  '',
  '',
].join('\n');

/** Compile the whole project to a throwaway outDir so the work tree is untouched. */
function compileToTemp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scripts-cli-exit-'));
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
 * generated content (banner + compiled bytes), or a failure descriptor.
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
    return { ok: true, content: BANNER + compiled };
  } finally {
    fs.rmSync(build.dir, { recursive: true, force: true });
  }
}

function doWrite() {
  const result = buildExpectedContent();
  if (!result.ok) {
    console.error(`FAIL gen-scripts-cli-exit: ${result.reason}`);
    if (result.detail) console.error(result.detail);
    return 1;
  }
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, result.content, 'utf8');
  console.log(`ok gen-scripts-cli-exit: wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  return 0;
}

function doCheck() {
  const result = buildExpectedContent();
  if (!result.ok) {
    console.error(`FAIL gen-scripts-cli-exit: ${result.reason}`);
    if (result.detail) console.error(result.detail);
    return 1;
  }

  if (!fs.existsSync(OUTPUT_PATH)) {
    console.error(`FAIL gen-scripts-cli-exit: ${REASON.MISSING_EMIT}`);
    console.error(`  ${path.relative(REPO_ROOT, OUTPUT_PATH)} does not exist. Run:`);
    console.error('  node scripts/gen-scripts-cli-exit.cjs --write');
    return 1;
  }

  const committed = fs.readFileSync(OUTPUT_PATH, 'utf8');
  if (committed !== result.content) {
    console.error(`FAIL gen-scripts-cli-exit: ${REASON.DRIFTED}`);
    console.error(
      `  ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${committed.length} bytes) != ` +
      `compile of src/cli-exit.cts (${result.content.length} bytes)`,
    );
    console.error('');
    console.error('Regenerate with:');
    console.error('  node scripts/gen-scripts-cli-exit.cjs --write');
    return 1;
  }

  console.log(`ok gen-scripts-cli-exit: ${path.relative(REPO_ROOT, OUTPUT_PATH)} matches src/cli-exit.cts`);
  return 0;
}

function main() {
  const flag = process.argv[2];
  const extra = process.argv[3];

  if (flag !== undefined && flag !== '--write' && flag !== '--check') {
    console.error(`FAIL gen-scripts-cli-exit: ${REASON.USAGE}`);
    console.error(`  unrecognized argument: ${flag}`);
    console.error(USAGE_MESSAGE);
    return 1;
  }

  if (extra !== undefined) {
    console.error(`FAIL gen-scripts-cli-exit: ${REASON.USAGE}`);
    console.error(`  unexpected extra argument: ${extra}`);
    console.error(USAGE_MESSAGE);
    return 1;
  }

  if (flag === '--check') return doCheck();
  return doWrite();
}

if (require.main === module) process.exitCode = main();

module.exports = { REASON, buildExpectedContent, OUTPUT_PATH, BANNER };
