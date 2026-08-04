#!/usr/bin/env node
'use strict';

/**
 * Generates docs/INVENTORY-MANIFEST.json — a structural skeleton of every
 * shipped surface derived entirely from the filesystem. Commit this file;
 * CI re-runs the script and diffs. A non-empty diff means a surface shipped
 * without an INVENTORY.md row.
 *
 * Usage:
 *   node scripts/gen-inventory-manifest.cjs              # print to stdout
 *   node scripts/gen-inventory-manifest.cjs --write      # write docs/INVENTORY-MANIFEST.json
 *   node scripts/gen-inventory-manifest.cjs --check      # exit 1 if committed manifest is stale
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'INVENTORY-MANIFEST.json');

const FAMILIES = [
  {
    name: 'agents',
    dir: path.join(ROOT, 'agents'),
    filter: (f) => /^gsd-.*\.md$/.test(f),
    toName: (f) => f.replace(/\.md$/, ''),
  },
  {
    name: 'commands',
    dir: path.join(ROOT, 'commands', 'gsd'),
    filter: (f) => f.endsWith('.md'),
    toName: (f) => '/gsd-' + f.replace(/\.md$/, ''),
  },
  {
    name: 'workflows',
    dir: path.join(ROOT, 'gsd-core', 'workflows'),
    filter: (f) => f.endsWith('.md'),
    toName: (f) => f,
  },
  {
    name: 'references',
    dir: path.join(ROOT, 'gsd-core', 'references'),
    filter: (f) => f.endsWith('.md'),
    toName: (f) => f,
  },
  {
    name: 'cli_modules',
    dir: path.join(ROOT, 'gsd-core', 'bin', 'lib'),
    filter: (f) => f.endsWith('.cjs'),
    toName: (f) => f,
  },
  {
    name: 'hooks',
    dir: path.join(ROOT, 'hooks'),
    filter: (f) => /\.(js|sh)$/.test(f),
    toName: (f) => f,
  },
];

/**
 * One-level-nested families (#2996, epic #1671 Phase 6.5).
 *
 * `buildManifest`'s flat `readdirSync` + `isFile()` walk cannot see a workflow's
 * own sub-files, so `gsd-core/workflows/<wf>/steps/*.md` (the fragment tree
 * extracted by Phases 6.1-6.3) and `gsd-core/workflows/<wf>/modes/*.md` (the
 * #717 progressive-disclosure pattern) shipped invisible to both the manifest
 * and `docs/INVENTORY.md` — exactly the `DEFECT.INVENTORY-DRIFT` class.
 *
 * Keyed by `<parent>/<subdir>/<file>` rather than a bare basename ON PURPOSE:
 * two workflows may each own a `regression-gate.md`, and a step file may share a
 * name with a top-level workflow. A basename key would let one silently
 * overwrite the other, and because the manifest is compared by JSON equality a
 * collision would read as "up to date".
 *
 * Recursion is bounded at exactly one level, by named subdirectory. It is not a
 * general recursive walk.
 */
const NESTED_FAMILIES = [
  {
    name: 'workflow_modes',
    root: path.join(ROOT, 'gsd-core', 'workflows'),
    subdir: 'modes',
    filter: (f) => f.endsWith('.md'),
  },
  {
    name: 'workflow_steps',
    root: path.join(ROOT, 'gsd-core', 'workflows'),
    subdir: 'steps',
    filter: (f) => f.endsWith('.md'),
  },
];

/**
 * Collect `<root>/<parent>/<subdir>/<file>` entries as POSIX-relative keys.
 *
 * A parent that has no such subdirectory contributes nothing, and an EMPTY
 * subdirectory contributes nothing — never an empty-array key, which would be a
 * committed diff that signals nothing. `statSync().isDirectory()` is checked
 * before every `readdirSync` so a plain FILE named `steps` cannot throw.
 */
/**
 * `fs.statSync` throws on a dangling symlink and on an EACCES-denied path. An
 * entry we cannot stat is, for inventory purposes, not a countable file — the
 * same disposition as "not a directory" below. Swallowing the throw here keeps
 * one unreadable entry from taking down `--check` for the entire repo, which is
 * a manifest generator's worst failure mode: it turns a local filesystem oddity
 * into a red gate on every PR.
 */
function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function collectNested({ root, subdir, filter }) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  let parents;
  try {
    parents = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const parent of parents) {
    const parentStat = statOrNull(path.join(root, parent));
    if (!parentStat || !parentStat.isDirectory()) continue;
    const nestedDir = path.join(root, parent, subdir);
    const nestedStat = statOrNull(nestedDir);
    if (!nestedStat || !nestedStat.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(nestedDir);
    } catch {
      continue;
    }
    for (const file of files) {
      const fileStat = statOrNull(path.join(nestedDir, file));
      if (!fileStat || !fileStat.isFile() || !filter(file)) continue;
      out.push([parent, subdir, file].join('/'));
    }
  }
  return out.sort();
}

function buildManifest() {
  const manifest = { families: {} };
  for (const { name, dir, filter, toName } of FAMILIES) {
    manifest.families[name] = fs
      .readdirSync(dir)
      .filter((f) => fs.statSync(path.join(dir, f)).isFile() && filter(f))
      .map(toName)
      .sort();
  }
  for (const family of NESTED_FAMILIES) {
    manifest.families[family.name] = collectNested(family);
  }
  return manifest;
}

function main() {
  const [, , flag] = process.argv;

  if (flag === '--check') {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const live = buildManifest();
    const committedStr = JSON.stringify(committed, null, 2);
    const liveStr = JSON.stringify(live, null, 2);
    if (committedStr !== liveStr) {
      process.stderr.write(
        'docs/INVENTORY-MANIFEST.json is stale. Run:\n' +
        '  node scripts/gen-inventory-manifest.cjs --write\n' +
        'then add a matching row in docs/INVENTORY.md for each new entry.\n\n',
      );
      // Show diff-friendly output
      for (const family of Object.keys(live.families)) {
        const liveSet = new Set(live.families[family]);
        const committedSet = new Set((committed.families || {})[family] || []);
        for (const name of liveSet) {
          if (!committedSet.has(name)) process.stderr.write('  + ' + family + '/' + name + '\n');
        }
        for (const name of committedSet) {
          if (!liveSet.has(name)) process.stderr.write('  - ' + family + '/' + name + '\n');
        }
      }
      throw new ExitError(1);
    }
    process.stdout.write('docs/INVENTORY-MANIFEST.json is up to date.\n');
  } else if (flag === '--write') {
    const manifest = buildManifest();
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write('Wrote ' + MANIFEST_PATH + '\n');
  } else {
    process.stdout.write(JSON.stringify(buildManifest(), null, 2) + '\n');
  }
}

/* c8 ignore next 3 -- CLI entry guard; this repo measures coverage with c8, which does not honor istanbul pragmas */
if (require.main === module) {
  runMain(main);
}

// Single source of truth for the family tables (#2996). `tests/inventory-manifest-sync.test.cjs`
// previously carried its own duplicate copy of FAMILIES, which is the
// `DEFECT.GENERATIVE-FIX` divergence class: adding a family here while the test kept
// its own list meant the test silently verified fewer families than shipped, and still
// passed. The test now imports these, so the two surfaces cannot drift.
module.exports = { FAMILIES, NESTED_FAMILIES, collectNested, buildManifest };
