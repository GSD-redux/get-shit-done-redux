#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-cursor-session-start.js — Cursor sessionStart hook (issue #777)
//
// Cursor invokes this script at the start of each agent session.
// Protocol: JSON from Cursor on stdin; JSON response on stdout.
//
// Input schema (cursor sessionStart):
//   { session_id, is_background_agent, composer_mode, conversation_id,
//     generation_id, model, hook_event_name, cursor_version,
//     workspace_roots, user_email, transcript_path }
//
// Output schema (cursor sessionStart):
//   { additional_context?: string }   ← injected into the session as context
//
// Behaviour:
//   - If .planning/STATE.md is present, injects a brief state reminder.
//   - If absent, nudges the user toward /gsd:new-project.
//   - Fails open: any error silently exits 0 so a hook bug never wedges Cursor.
//
// Cursor docs: https://cursor.com/docs/hooks

'use strict';

const fs = require('fs');
const path = require('path');

const MSG_PRESENT =
  'GSD: .planning/STATE.md is present — review the current phase and any blockers before acting.';
const MSG_ABSENT =
  'GSD: no .planning/ workflow found — run /gsd:new-project to start a tracked workflow.';

// Resolve the workspace this hook is reporting on (#2587).
//
// Under the cursor-agent CLI, hooks are invoked with cwd set to the Cursor
// config dir (~/.cursor), NOT the workspace — so resolving .planning/ from
// process.cwd() always missed and this hook could only ever emit MSG_ABSENT.
// The stdin payload carries the real path in `workspace_roots`.
//
// Multi-root: prefer the first root that actually carries .planning/STATE.md, so
// a workspace whose GSD project is not the first root still resolves. Fall back
// to the first root (the single-root CLI case), then to cwd (keeps IDE behavior
// if the IDE ever invokes hooks from the workspace itself).
//
// DUPLICATED VERBATIM in gsd-cursor-stop.js — these hooks ship as standalone
// scripts and hooks/lib/ additions must be registered in the generated
// installer's GSD_HOOK_LIB_FILES allowlist. tests/fix-2587-cursor-hook-workspace-roots.test.cjs
// asserts the two copies stay in parity (CLAUDE.md: Generative Fix Divergence).
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
  // Timeout guard: exit silently rather than hanging.
  process.exit(0);
}, 10000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const statePath = path.join(resolveWorkspaceRoot(raw), '.planning', 'STATE.md');
    const statePresent = fs.existsSync(statePath);
    const msg = statePresent ? MSG_PRESENT : MSG_ABSENT;
    process.stdout.write(JSON.stringify({ additional_context: msg }));
  } catch {
    // Fail open — never block a Cursor session because of a GSD hook error.
    process.stdout.write(JSON.stringify({}));
  }
});
