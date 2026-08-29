#!/usr/bin/env node
'use strict';

/**
 * sync-manifest-versions.cjs
 *
 * Stamps the package.json version into every runtime-integration manifest whose
 * top-level `version` field MUST track the package version.  Called automatically
 * by the `version` npm lifecycle script so that `npm version X.Y.Z` keeps all
 * registered manifests in sync.
 *
 * Usage:
 *   node scripts/sync-manifest-versions.cjs           # stamp + report
 *   node scripts/sync-manifest-versions.cjs --stage   # stamp + git-stage manifests
 *   node scripts/sync-manifest-versions.cjs --check   # report drift, exit 1 if any
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Single source of truth: runtime-integration manifests whose `version` field
// MUST track package.json. Each entry names the manifest path plus the dotted
// path to the version field inside that JSON document. Top-level `version` is
// the default (plugin.json); the Claude plugin
// marketplace manifest carries its canonical version at plugins[0].version
// (the schema-canonical location runtimes read — issue #1855).
//
// Add a new manifest here so `npm version` keeps it in sync — the regression
// guard test (issue 844) fails if you forget.
// #1928: gemini-extension.json was removed with the gemini runtime (Google
// sunset Gemini CLI 2026-06-18); it is no longer a registered manifest.
const VERSIONED_MANIFESTS = [
  { path: '.claude-plugin/plugin.json', versionKey: 'version' },
  { path: '.codex-plugin/plugin.json', versionKey: 'version' },
  { path: '.claude-plugin/marketplace.json', versionKey: 'plugins.0.version' },
  { path: 'vscode/package.json', versionKey: 'version' },
];

// Convenience: just the registered paths, for consumers that only need to
// iterate files (e.g. the issue-844 regression-guard ALLOWED set).
const VERSIONED_MANIFEST_PATHS = VERSIONED_MANIFESTS.map((e) => e.path);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Property names that must never be traversed/assigned through a dotted path —
// the prototype-pollution triple. Mirrors the _isSafePropKey CodeQL barrier used
// elsewhere in the repo. Versions are hand-authored descriptors, but the helpers
// are exported, so guard them before reuse across a trust boundary.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function assertSafePath(dotPath) {
  for (const seg of String(dotPath).split('.')) {
    if (UNSAFE_KEYS.has(seg)) {
      throw new Error(`refusing to traverse reserved property "${seg}" in version path "${dotPath}"`);
    }
  }
}

// Read a dotted path ('plugins.0.version') from a parsed JSON document.
// Returns undefined if any intermediate is missing. Array indices are plain
// numeric keys, so 'plugins.0.version' resolves obj.plugins[0].version.
// Reserved properties (__proto__/constructor/prototype) are rejected.
function getByPath(obj, dotPath) {
  assertSafePath(dotPath);
  return String(dotPath).split('.').reduce((cur, key) => (cur == null ? cur : cur[key]), obj);
}

// Write a value at a dotted path. Intermediate nodes must already exist (every
// registered manifest is hand-authored with its version slot present, so this
// never needs to materialize a path). Reserved properties are rejected. Kept
// trivial — no eval, no creation.
function setByPath(obj, dotPath, value) {
  assertSafePath(dotPath);
  const parts = String(dotPath).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getPackageVersion(root) {
  const r = root || ROOT;
  return readJson(path.join(r, 'package.json')).version;
}

// Stamp `version` into each registered manifest, preserving field order and
// 2-space + trailing-newline formatting. Returns the list of changed rel paths.
function syncManifestVersions(opts) {
  const root = (opts && opts.root) || ROOT;
  const v = (opts && opts.version) != null ? opts.version : getPackageVersion(root);
  const changed = [];
  for (const entry of VERSIONED_MANIFESTS) {
    const abs = path.join(root, entry.path);
    const manifest = readJson(abs);
    if (getByPath(manifest, entry.versionKey) !== v) {
      setByPath(manifest, entry.versionKey, v);
      fs.writeFileSync(abs, JSON.stringify(manifest, null, 2) + '\n');
      changed.push(entry.path);
    }
  }
  return changed;
}

// Registered manifests whose version != package version.
function findDrift(opts) {
  const root = (opts && opts.root) || ROOT;
  const v = (opts && opts.version) != null ? opts.version : getPackageVersion(root);
  const drift = [];
  for (const entry of VERSIONED_MANIFESTS) {
    const manifest = readJson(path.join(root, entry.path));
    const found = getByPath(manifest, entry.versionKey);
    if (found !== v) drift.push({ manifest: entry.path, found, expected: v });
  }
  return drift;
}

// ─── ADR-1244 D6: native capability manifests ────────────────────────────────
//
// Native capabilities (capabilities/<id>/capability.json) carry a `version`
// stamped in lockstep with the package version at release. Unlike
// VERSIONED_MANIFESTS (fixed paths), capabilities are discovered by glob so a
// new capability is auto-covered without editing this file. The version-sync
// regression guard (issue #844) treats every swept capability manifest as
// registered.

// Discover capabilities/<id>/capability.json under `root`, sorted for stable
// staging order. Returns [] when there is no capabilities/ directory.
function listCapabilityManifests(opts) {
  const root = (opts && opts.root) || ROOT;
  const dir = path.join(root, 'capabilities');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    // Forward-slash rel paths (NOT path.join) so they match `git ls-files`
    // output, git pathspecs, and the forward-slash VERSIONED_MANIFESTS on every
    // platform — path.join would emit backslashes on Windows and break the
    // issue-844 regression guard's ALLOWED-set comparison.
    .map((e) => 'capabilities/' + e.name + '/capability.json')
    .filter((rel) => fs.existsSync(path.join(root, rel)))
    .sort();
}

// Stamp `version` into each native capability manifest. Returns changed rel paths.
function syncCapabilityVersions(opts) {
  const root = (opts && opts.root) || ROOT;
  const v = (opts && opts.version) != null ? opts.version : getPackageVersion(root);
  const changed = [];
  for (const rel of listCapabilityManifests({ root })) {
    const abs = path.join(root, rel);
    const manifest = readJson(abs);
    if (manifest.version !== v) {
      manifest.version = v;
      fs.writeFileSync(abs, JSON.stringify(manifest, null, 2) + '\n');
      changed.push(rel);
    }
  }
  return changed;
}

// Native capability manifests whose version != package version.
function findCapabilityDrift(opts) {
  const root = (opts && opts.root) || ROOT;
  const v = (opts && opts.version) != null ? opts.version : getPackageVersion(root);
  const drift = [];
  for (const rel of listCapabilityManifests({ root })) {
    const found = readJson(path.join(root, rel)).version;
    if (found !== v) drift.push({ manifest: rel, found, expected: v });
  }
  return drift;
}

// Best-effort outside git; fail-closed inside a work tree so a release never
// ships a stale manifest that the working-tree test already accepted.
function stageManifests(opts) {
  const root = (opts && opts.root) || ROOT;
  let insideWorkTree = false;
  try {
    insideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() === 'true';
  } catch {}
  if (!insideWorkTree) {
    console.warn('sync-manifest-versions: not a git work tree; skipping staging.');
    return;
  }
  const toStage = [...VERSIONED_MANIFEST_PATHS, ...listCapabilityManifests({ root })];
  try {
    execFileSync('git', ['add', '--', ...toStage], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = err && err.stderr ? err.stderr.toString().trim() : (err && err.message) || 'unknown error';
    throw new Error(`sync-manifest-versions: failed to git-add manifests inside a work tree: ${detail}`);
  }
}

module.exports = {
  VERSIONED_MANIFESTS,
  VERSIONED_MANIFEST_PATHS,
  getByPath,
  setByPath,
  syncManifestVersions,
  findDrift,
  getPackageVersion,
  stageManifests,
  // ADR-1244 D6: native capability version sweep
  listCapabilityManifests,
  syncCapabilityVersions,
  findCapabilityDrift,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const version = getPackageVersion();
  if (args.includes('--check')) {
    const drift = [...findDrift({ version }), ...findCapabilityDrift({ version })];
    if (drift.length) {
      for (const d of drift) {
        console.error('Manifest ' + d.manifest + ' version ' + d.found + ' != package.json ' + d.expected);
      }
      console.error('Run `node scripts/sync-manifest-versions.cjs` to fix.');
      process.exitCode = 1;
    } else {
      const total = VERSIONED_MANIFESTS.length + listCapabilityManifests().length;
      console.log('All ' + total + ' versioned manifests in sync at ' + version + '.');
    }
  } else {
    const changed = [...syncManifestVersions({ version }), ...syncCapabilityVersions({ version })];
    if (changed.length) {
      console.log('Stamped ' + version + ' into: ' + changed.join(', '));
    } else {
      console.log('Versioned manifests already at ' + version + '.');
    }
    if (args.includes('--stage')) stageManifests();
  }
}
