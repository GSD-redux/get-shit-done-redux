// cursor-workspace.js — shared workspace resolution for Cursor lifecycle hooks (#2587).
//
// No `gsd-hook-version:` marker, deliberately — matching hooks/lib/git-cmd.js.
// Neither copy path that stages hooks/lib/*.js substitutes the version
// placeholder (copyLibDir stamps .sh files only), and the managed-hooks
// staleness scan covers top-level hooks/ names, not hooks/lib/. A marker here
// would ship to users as an unsubstituted literal.
//
// Cursor invokes hooks with cwd set to the Cursor config dir (~/.cursor) under
// the cursor-agent CLI, NOT the workspace. Every hook that resolves a project
// path from process.cwd() therefore missed: sessionStart could only emit its
// "no .planning/ workflow found" nudge, stop's verify-work reminder never fired,
// and subagentStart left every subagent without phase context.
//
// The hook payload carries the real path in `workspace_roots`. This module is
// the single place that turns that payload into a project root, so the three
// hooks cannot drift apart (they previously carried three copies of it).
//
// Consumers: gsd-cursor-session-start.js, gsd-cursor-stop.js,
// gsd-cursor-subagent-start.js. Staged into <config>/hooks/lib/ by
// writeCursorHooksJson (src/runtime-hooks-surface.cts) alongside the scripts
// that require it, and registered in the installer's GSD_HOOK_LIB_FILES so
// uninstall and the manifest manage it.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve the workspace root a Cursor hook should report on.
 *
 * Search order:
 *   1. Each entry of `workspace_roots` that actually carries .planning/STATE.md
 *      — so a multi-root workspace whose GSD project is not the first root
 *      still resolves.
 *   2. process.cwd(), if IT carries .planning/STATE.md. cwd is a CANDIDATE, not
 *      merely the empty-roots fallback: an IDE invocation can supply
 *      workspace_roots AND run from the project, and searching roots alone
 *      would report "absent" for a project sitting right at cwd — narrower than
 *      the pre-fix always-cwd behavior this replaces.
 *   3. The first declared root, else cwd — so the "absent" message still names
 *      a sensible directory when there is genuinely no project.
 *
 * Never throws: a malformed payload degrades to cwd rather than wedging the
 * session. (fs.existsSync itself does not throw — it returns false for NUL
 * bytes, over-long components, and non-directory ancestors.)
 *
 * @param {string} rawInput Raw stdin payload as received by the hook.
 * @returns {string} Absolute-or-relative directory to resolve .planning/ against.
 */
function resolveWorkspaceRoot(rawInput) {
  let input = {};
  try { input = JSON.parse(rawInput || '{}'); } catch { /* fall back to cwd */ }
  const roots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots.filter((r) => typeof r === 'string' && r.length > 0)
    : [];
  for (const root of [...roots, process.cwd()]) {
    if (fs.existsSync(path.join(root, '.planning', 'STATE.md'))) return root;
  }
  return roots[0] || process.cwd();
}

/**
 * Convenience: the .planning/STATE.md path for the resolved workspace.
 *
 * @param {string} rawInput Raw stdin payload as received by the hook.
 * @returns {string}
 */
function resolveStatePath(rawInput) {
  return path.join(resolveWorkspaceRoot(rawInput), '.planning', 'STATE.md');
}

module.exports = { resolveWorkspaceRoot, resolveStatePath };
