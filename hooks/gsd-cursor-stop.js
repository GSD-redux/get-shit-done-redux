#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-cursor-stop.js — Cursor stop hook (ADR-1239 / #2089)
//
// Cursor invokes this script when the agent stops responding.
// Protocol: JSON from Cursor on stdin; JSON response on stdout.
//
// Input schema (cursor stop):
//   { conversation_id, generation_id, model, hook_event_name,
//     cursor_version, workspace_roots, user_email, transcript_path }
//
// Output schema (cursor stop):
//   { additional_context?: string }
//
// Behaviour:
//   - Reminds the user to verify work if .planning/ is present.
//   - Fails open: any error silently exits 0.
//
// Cursor docs: https://cursor.com/docs/hooks

'use strict';

const fs = require('fs');
const path = require('path');

// Resolve the workspace this hook is reporting on (#2587).
//
// Under the cursor-agent CLI, hooks are invoked with cwd set to the Cursor
// config dir (~/.cursor), NOT the workspace — so resolving .planning/ from
// process.cwd() always missed and this hook's verify-work reminder could never
// fire. The stdin payload carries the real path in `workspace_roots`.
//
// Multi-root: prefer the first root that actually carries .planning/STATE.md, so
// a workspace whose GSD project is not the first root still resolves. Fall back
// to the first root (the single-root CLI case), then to cwd (keeps IDE behavior
// if the IDE ever invokes hooks from the workspace itself).
//
// DUPLICATED VERBATIM in gsd-cursor-session-start.js — these hooks ship as
// standalone scripts and hooks/lib/ additions must be registered in the
// generated installer's GSD_HOOK_LIB_FILES allowlist.
// tests/fix-2587-cursor-hook-workspace-roots.test.cjs asserts the two copies
// stay in parity (CLAUDE.md: Generative Fix Divergence).
function resolveWorkspaceRoot(rawInput) {
  let input = {};
  try { input = JSON.parse(rawInput || '{}'); } catch { /* fall back to cwd */ }
  const roots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots.filter((r) => typeof r === 'string' && r.length > 0)
    : [];
  for (const root of roots) {
    if (fs.existsSync(path.join(root, '.planning', 'STATE.md'))) return root;
  }
  return roots[0] || process.cwd();
}

let raw = '';
const stdinTimeout = setTimeout(() => {
  process.exit(0);
}, 10000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const statePath = path.join(resolveWorkspaceRoot(raw), '.planning', 'STATE.md');
    if (fs.existsSync(statePath)) {
      process.stdout.write(JSON.stringify({
        additional_context:
          'GSD: Agent stopping — run /gsd:verify-work or /gsd:progress to confirm the phase goal is met before ending the session.',
      }));
    } else {
      process.stdout.write(JSON.stringify({}));
    }
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
});
