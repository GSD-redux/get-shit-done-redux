'use strict';

/**
 * Authoritative list of GSD-managed hook files.
 *
 * Extracted from the worker script into a shared CJS module so that:
 *  1. gsd-check-update-worker.js can require() it directly (no source-level
 *     duplication).
 *  2. Tests can assert against the exported array instead of regex-parsing
 *     the worker source (retiring the pending-migration-to-typed-ir token
 *     on managed-hooks.test.cjs and orphaned-hooks.test.cjs, per #455).
 *
 * These are the files GSD ships into ~/.claude/hooks/ (or equivalent) and
 * checks for staleness after an update. Orphaned files from removed features
 * (e.g., gsd-intel-*.js) must NOT be listed here — that would cause permanent
 * stale warnings for users who haven't cleaned up manually (#1750).
 */
const MANAGED_HOOKS = [
  'gsd-check-update-worker.js',
  'gsd-check-update.js',
  'gsd-config-reload.js',
  'gsd-context-monitor.js',
  'gsd-cursor-post-tool.js',
  'gsd-cursor-pre-tool.js',
  'gsd-cursor-session-start.js',
  'gsd-cursor-stop.js',
  'gsd-cursor-subagent-start.js',
  'gsd-cursor-subagent-stop.js',
  'gsd-ensure-canonical-path.js',
  'gsd-graphify-update.sh',
  'gsd-phase-boundary.sh',
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-session-state.sh',
  'gsd-statusline.js',
  'gsd-update-banner.js',
  'gsd-validate-commit.sh',
  'gsd-windsurf-pre-command.js',
  'gsd-windsurf-pre-write.js',
  'gsd-workflow-guard.js',
  'gsd-worktree-path-guard.js',
  'gsd-write-guard.js',
];

module.exports = { MANAGED_HOOKS };
