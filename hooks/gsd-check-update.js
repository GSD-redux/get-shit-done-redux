#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Check for GSD updates in background, write result to cache
// Called by SessionStart hook - runs once per session

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// #3582: gsd-core/bin/lib/package-identity.cjs is a tsc build artifact
// (ADR-457), gitignored and absent on a raw plugin-marketplace / git-clone
// install that never ran `npm run build:lib`. This SessionStart hook must
// DEGRADE (fall back to a generic cache filename) rather than crash session
// start. gsd-check-update-worker.js — the process this hook spawns — degrades
// identically and independently, so the shared fallback literal keeps the
// cache path consistent between writer and reader even in the (rare)
// doubly-degraded case. This try/require/ensureRuntimeBuild/require/catch
// shape is deliberately duplicated (not extracted to hooks/lib/) — see
// gsd-check-update-worker.js's identical #3582 comment for why.
let updateCacheFileName = 'gsd-update-check.json';
try {
  const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');
  ensureRuntimeBuild();
  ({ updateCacheFileName } = require('../gsd-core/bin/lib/package-identity.cjs'));
} catch (e) {
  // Runtime library missing/broken and could not self-build — degrade to the
  // fallback filename above rather than crash the SessionStart hook.
}

const homeDir = os.homedir();
const cwd = process.cwd();

// Detect runtime config directory (supports Claude, OpenCode, Kilo, Gemini)
// Respects CLAUDE_CONFIG_DIR for custom config directory setups
function detectConfigDir(baseDir) {
  // Check env override first (supports multi-account setups)
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'gsd-core', 'VERSION'))) {
    return envDir;
  }
  for (const dir of ['.claude', '.gemini', '.config/kilo', '.kilo', '.config/opencode', '.opencode']) {
    if (fs.existsSync(path.join(baseDir, dir, 'gsd-core', 'VERSION'))) {
      return path.join(baseDir, dir);
    }
  }
  return envDir || path.join(baseDir, '.claude');
}

const globalConfigDir = detectConfigDir(homeDir);
const projectConfigDir = detectConfigDir(cwd);
// Use a shared, tool-agnostic cache directory to avoid multi-runtime
// resolution mismatches where check-update writes to one runtime's cache
// but statusline reads from another (#1421).
const cacheDir = path.join(homeDir, '.cache', 'gsd');
const cacheFile = path.join(cacheDir, updateCacheFileName);

// VERSION file locations (check project first, then global)
const projectVersionFile = path.join(projectConfigDir, 'gsd-core', 'VERSION');
const globalVersionFile = path.join(globalConfigDir, 'gsd-core', 'VERSION');

// Ensure cache directory exists
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// Run check in background via a dedicated worker script.
// Spawning a file (rather than node -e '<inline code>') keeps the worker logic
// in plain JS with no template-literal regex-escaping concerns, and makes the
// worker independently testable.
const workerPath = path.join(__dirname, 'gsd-check-update-worker.js');
const child = spawn(process.execPath, [workerPath], {
  stdio: 'ignore',
  windowsHide: true,
  detached: true,  // Required on Windows for proper process detachment
  env: {
    ...process.env,
    GSD_CACHE_FILE: cacheFile,
    GSD_PROJECT_VERSION_FILE: projectVersionFile,
    GSD_GLOBAL_VERSION_FILE: globalVersionFile,
  },
});

child.unref();
