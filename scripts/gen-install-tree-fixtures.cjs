#!/usr/bin/env node
'use strict';
/**
 * Standalone golden-fixture generator for tests/golden-install-tree (#2267 Phase 2).
 *
 * This is a BUILD-TIME generation script — NOT a test run. It imports the
 * canonical buildInstallTree builder from tests/helpers/install-shared.cjs,
 * which in turn reuses buildParityManifest's exact exclusion set (issue
 * #2266) so the file-set fixtures here and the golden-install-parity content
 * fixtures never diverge on which files they cover. The authoritative test
 * gate remains `gsd-test run`, never a local `node --test`.
 *
 * Usage: node scripts/gen-install-tree-fixtures.cjs [runtime ...]
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// buildInstallTree (and the exclusion constants it reuses from
// buildParityManifest) is the canonical single source of truth in
// tests/helpers/install-shared.cjs (issue #2266/#2267) — this generator does
// not keep its own inline copy of the walk/exclusion logic.
const { runMinimalInstall, RUNTIME_META, buildInstallTree, extraEmitRootsFor, BUILD_SCRIPT } = require(path.join(ROOT, 'tests', 'helpers', 'install-shared.cjs'));
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'install-tree');

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Regenerate the fixture for every runtime in RUNTIME_META. Needed when a
// SHARED gsd-core payload file (e.g. model-catalog.json, capability-registry)
// changes content — its path appears in every runtime's manifest, so all
// fixtures must be recaptured together. Usage:
//   node scripts/gen-install-tree-fixtures.cjs [runtime ...]
// With no args, regenerates ALL runtimes. With args, only the named runtimes.
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(RUNTIME_META);
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

// Build hooks/dist before capturing so fixtures are complete even in a clean
// checkout (hooks/dist is gitignored + built; DEFECT.HOOKS-DIST-SCOPED-CI). The
// test harness's before() hook does the same; without it a fresh checkout omits
// every hooks/* path and this generator silently writes short fixtures.
execFileSync(process.execPath, [BUILD_SCRIPT], { stdio: 'pipe' });

for (const runtime of targets) {
  if (!Object.prototype.hasOwnProperty.call(RUNTIME_META, runtime)) {
    process.stderr.write(`[gen] unknown runtime '${runtime}' (not in RUNTIME_META) — skipping\n`);
    continue;
  }
  const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
  let actual;
  try {
    actual = buildInstallTree(configDir, root, extraEmitRootsFor(runtime, 'global', root));
  } finally {
    cleanup(root);
  }
  const fixturePath = path.join(FIXTURE_DIR, `${runtime}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
  process.stdout.write(`[gen] ${runtime}: wrote ${actual.length} paths -> ${fixturePath}\n`);
}

// Also regenerate the claude LOCAL legacy-layout fixture (claude-local.json).
// This layout is distinct from the global install (commands/gsd-*.md +
// agents/gsd-*.md) and has its own snapshot assertion in the test harness.
const { configDir: localConfigDir, root: localRoot } = runMinimalInstall({ runtime: 'claude', scope: 'local' });
let localActual;
try {
  localActual = buildInstallTree(localConfigDir, localRoot);
} finally {
  cleanup(localRoot);
}
const localFixturePath = path.join(FIXTURE_DIR, 'claude-local.json');
fs.writeFileSync(localFixturePath, JSON.stringify(localActual, null, 2) + '\n', 'utf8');
process.stdout.write(`[gen] claude-local: wrote ${localActual.length} paths -> ${localFixturePath}\n`);
