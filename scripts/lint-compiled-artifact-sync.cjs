#!/usr/bin/env node
/**
 * lint-compiled-artifact-sync — fail when a *tracked* compiled artifact under
 * gsd-core/bin/lib/ has drifted from its src/*.cts source.
 *
 * ADR-457 compiles src/*.cts to gsd-core/bin/lib/*.cjs at build time and expects
 * those artifacts to be gitignored. Most are (see .gitignore). A handful are
 * still tracked because the migration that moved the module into src/ did not
 * also add the emitted .cjs to .gitignore. While a compiled artifact remains
 * tracked, the committed bytes are what ships to anyone who reads the repo
 * without building — so they must match the source.
 *
 * #2653: gsd-core/bin/lib/api-coverage.cjs sat four days behind its .cts after
 * PR #2551 changed the source without regenerating the artifact, shipping a
 * module that silently lacked the entire #2366 fix while CI stayed green.
 *
 * This check is deliberately regime-agnostic: it asserts a property of whatever
 * is tracked right now. If the remaining artifacts are later untracked and
 * gitignored (the ADR-457 end state), the tracked set becomes empty and this
 * script passes trivially — no edit required.
 *
 * Usage: node scripts/lint-compiled-artifact-sync.cjs [--check]
 * Exit 0 when every tracked artifact matches a fresh compile; 1 otherwise.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join('gsd-core', 'bin', 'lib');
const SRC_DIR = 'src';

/** Frozen reason codes so tests assert on structure, not prose. */
const REASON = Object.freeze({
  OK: 'ok_artifacts_in_sync',
  DRIFTED: 'fail_artifact_drifted',
  BUILD_FAILED: 'fail_build_failed',
  MISSING_EMIT: 'fail_missing_emit',
});

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/**
 * Tracked .cjs files under gsd-core/bin/lib/ that have a matching src/*.cts.
 * Uses `git ls-files` so the set is derived from what git actually tracks
 * rather than a hand-maintained list that could itself drift.
 */
function trackedCompiledArtifacts() {
  const tracked = git(['ls-files', LIB_DIR]).split('\n').filter((l) => l.endsWith('.cjs'));
  const out = [];
  for (const rel of tracked) {
    const stem = path.basename(rel, '.cjs');
    const subdir = path.dirname(path.relative(LIB_DIR, rel));
    const srcRel = path.join(SRC_DIR, subdir === '.' ? '' : subdir, `${stem}.cts`);
    if (fs.existsSync(path.join(REPO_ROOT, srcRel))) out.push({ artifact: rel, source: srcRel });
  }
  return out.sort((a, b) => (a.artifact < b.artifact ? -1 : a.artifact > b.artifact ? 1 : 0));
}

/** Compile the whole project to a throwaway outDir so the work tree is untouched. */
function compileToTemp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-artifact-sync-'));
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
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
    return { ok: true, dir: tmp };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return { ok: false, detail };
  }
}

function main() {
  const pairs = trackedCompiledArtifacts();
  if (pairs.length === 0) {
    console.log('ok compiled-artifact-sync: no tracked compiled artifacts (ADR-457 end state)');
    return 0;
  }

  const build = compileToTemp();
  if (!build.ok) {
    console.error(`FAIL compiled-artifact-sync: ${REASON.BUILD_FAILED}`);
    console.error(build.detail);
    return 1;
  }

  const drifted = [];
  const missing = [];
  try {
    for (const { artifact, source } of pairs) {
      const fresh = path.join(build.dir, path.relative(LIB_DIR, artifact));
      if (!fs.existsSync(fresh)) { missing.push({ artifact, source }); continue; }
      const a = fs.readFileSync(path.join(REPO_ROOT, artifact));
      const b = fs.readFileSync(fresh);
      if (!a.equals(b)) drifted.push({ artifact, source, committed: a.length, expected: b.length });
    }
  } finally {
    fs.rmSync(build.dir, { recursive: true, force: true });
  }

  if (missing.length > 0) {
    console.error(`FAIL compiled-artifact-sync: ${REASON.MISSING_EMIT}`);
    for (const m of missing) console.error(`  ${m.artifact} — no emit produced from ${m.source}`);
    return 1;
  }

  if (drifted.length > 0) {
    console.error(`FAIL compiled-artifact-sync: ${REASON.DRIFTED}`);
    for (const d of drifted) {
      console.error(`  ${d.artifact} (${d.committed} bytes) != compile of ${d.source} (${d.expected} bytes)`);
    }
    console.error('');
    console.error('The committed artifact is what ships to anyone reading the repo without');
    console.error('building, so it must match its source. Fix with:');
    console.error('  npm run build:lib && git add ' + drifted.map((d) => d.artifact).join(' '));
    console.error('');
    console.error('Alternatively, per ADR-457 these artifacts are meant to be gitignored —');
    console.error('untracking them (git rm --cached + .gitignore) also resolves this.');
    return 1;
  }

  console.log(`ok compiled-artifact-sync: ${pairs.length} tracked artifact(s) match their source`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { REASON, trackedCompiledArtifacts };
