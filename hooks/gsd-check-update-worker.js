#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Background worker spawned by gsd-check-update.js (SessionStart hook).
// Checks for GSD updates and stale hooks, writes result to cache file.
// Receives paths via environment variables set by the parent hook.
//
// Using a separate file (rather than node -e '<inline code>') avoids the
// template-literal regex-escaping problem: regex source is plain JS here.

'use strict';

const fs = require('fs');
const path = require('path');
const { isSemverNewer } = require('../gsd-core/bin/lib/semver-compare.cjs');
// Latest-version lookup is delegated to the single deterministic adapter
// (#498). checkLatestVersion() owns the npm-view call, the timeout/semver
// policy, and the package name — sourced from the baked Package Identity seam.
// The previous `require('../package.json').name` (#378) never yielded a name in
// the installed tree — at the time it resolved to the synthetic
// {"type":"commonjs"} marker GSD wrote at the config root, which has no `.name`,
// so the background check never reported updates. Since #2544 GSD writes no
// marker there at all, so that require would now fail to resolve outright.
// Either way the name must come from the baked seam, never a walk-up.
const { checkLatestVersion } = require('../gsd-core/bin/check-latest-version.cjs');
const { PACKAGE_NAME } = require('../gsd-core/bin/lib/package-identity.cjs');
// Authoritative list of managed hooks — shared with tests to retire source-grep
// assertions (pending-migration-to-typed-ir [#455]).
// NOTE: managed-hooks-registry.cjs must be in HOOKS_TO_COPY (scripts/build-hooks.js)
// so it is present in hooks/dist/ and ships to the installed runtime hooks/ dir.
// If it is missing (e.g., installed from an older dist), catch and degrade gracefully
// so the worker always proceeds to compute and write the result cache record.
let MANAGED_HOOKS = [];
try {
  ({ MANAGED_HOOKS } = require('./managed-hooks-registry.cjs'));
} catch (e) {
  // Module not found in installed runtime — stale-hook detection degrades to
  // no-op (empty list means no hooks are checked for staleness). The worker
  // still runs and writes package_name / installed / latest / update_available.
}

const cacheFile = process.env.GSD_CACHE_FILE;
const projectVersionFile = process.env.GSD_PROJECT_VERSION_FILE;
const globalVersionFile = process.env.GSD_GLOBAL_VERSION_FILE;

// Check project directory first (local install), then global
let installed = '0.0.0';
let configDir = '';
try {
  if (fs.existsSync(projectVersionFile)) {
    installed = fs.readFileSync(projectVersionFile, 'utf8').trim();
    configDir = path.dirname(path.dirname(projectVersionFile));
  } else if (fs.existsSync(globalVersionFile)) {
    installed = fs.readFileSync(globalVersionFile, 'utf8').trim();
    configDir = path.dirname(path.dirname(globalVersionFile));
  }
} catch (e) {}

// Check for stale hooks — compare hook version headers against installed VERSION
// Since #3023 the bundle directory name is resolved from __dirname (this
// worker is staged INSIDE the bundle), not assumed to be configDir/hooks —
// the directory name is runtime-descriptor-driven (e.g. `gsd-hooks/` for pi).
// Only check hooks that GSD currently ships — orphaned files from removed features
// (e.g., gsd-intel-*.js) must be ignored to avoid permanent stale warnings (#1750)
// MANAGED_HOOKS is imported from ./managed-hooks-registry.cjs above.

let staleHooks = [];
if (configDir) {
  // #3023: the bundle's directory name is runtime-descriptor-driven (pi stages
  // it as `gsd-hooks/`), so deriving it as `<configDir>/hooks` silently scanned
  // nothing there. This worker is staged INSIDE the bundle, so __dirname is the
  // bundle directory by construction — name-agnostic and one fewer assumption.
  const hooksDir = __dirname;
  try {
    if (fs.existsSync(hooksDir)) {
      const hookFiles = fs.readdirSync(hooksDir).filter(f => MANAGED_HOOKS.includes(f));
      for (const hookFile of hookFiles) {
        try {
          const content = fs.readFileSync(path.join(hooksDir, hookFile), 'utf8');
          // Match both JS (//) and bash (#) comment styles
          const versionMatch = content.match(/(?:\/\/|#) gsd-hook-version:\s*(.+)/);
          if (versionMatch) {
            const hookVersion = versionMatch[1].trim();
            if (isSemverNewer(installed, hookVersion) && !hookVersion.includes('{{')) {
              staleHooks.push({ file: hookFile, hookVersion, installedVersion: installed });
            }
          } else {
            // No version header at all — definitely stale (pre-version-tracking)
            staleHooks.push({ file: hookFile, hookVersion: 'unknown', installedVersion: installed });
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}

// Single adapter for the registry lookup (#498). checkLatestVersion() routes
// through the shell-projection seam, which already owns the Windows shell-flag
// policy, the timeout, and semver validation. A non-ok result leaves latest
// null, exactly as the previous inline try/catch did.
let latest = null;
try {
  const lv = checkLatestVersion();
  if (lv && lv.ok) latest = lv.version;
} catch (e) {}

const result = {
  update_available: latest && isSemverNewer(latest, installed),
  installed,
  latest: latest || 'unknown',
  checked: Math.floor(Date.now() / 1000),
  stale_hooks: staleHooks.length > 0 ? staleHooks : undefined,
  package_name: PACKAGE_NAME,
};

if (cacheFile) {
  try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch (e) {}
}
