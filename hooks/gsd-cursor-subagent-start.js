#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-cursor-subagent-start.js — Cursor subagentStart hook (ADR-1239 / #2089)
//
// Cursor invokes this script when a subagent session starts.
// Protocol: JSON from Cursor on stdin; JSON response on stdout.
//
// Input schema (cursor subagentStart):
//   { session_id, is_background_agent, conversation_id, generation_id,
//     model, hook_event_name, cursor_version, workspace_roots,
//     user_email, transcript_path }
//
// Output schema (cursor subagentStart):
//   { additional_context?: string }
//
// Behaviour:
//   - Injects a brief GSD state reminder so subagents (planner, executor,
//     verifier) have the current phase context.
//   - Fails open: any error silently exits 0.
//
// Cursor docs: https://cursor.com/docs/hooks

'use strict';

const fs = require('fs');
const path = require('path');

const MSG_PRESENT =
  'GSD: Subagent session started — review .planning/STATE.md for the current phase and any blockers before acting.';
const MSG_ABSENT =
  'GSD: Subagent session started — no .planning/ workflow found.';

// Resolve the workspace this hook is reporting on (#2587).
//
// Under the cursor-agent CLI, hooks are invoked with cwd set to the Cursor
// config dir (~/.cursor), NOT the workspace — so resolving .planning/ from
// process.cwd() always missed and this hook could only ever emit MSG_ABSENT,
// leaving every subagent (planner, executor, verifier) without phase context.
// The stdin payload carries the real path in `workspace_roots`.
//
// Multi-root: prefer the first root that actually carries .planning/STATE.md, so
// a workspace whose GSD project is not the first root still resolves. Fall back
// to the first root (the single-root CLI case), then to cwd.
//
// DUPLICATED VERBATIM in gsd-cursor-session-start.js and gsd-cursor-stop.js —
// these hooks ship as standalone scripts and hooks/lib/ additions must be
// registered in the generated installer's GSD_HOOK_LIB_FILES allowlist.
// tests/fix-2587-cursor-hook-workspace-roots.test.cjs asserts all three copies
// stay in parity (CLAUDE.md: Generative Fix Divergence).
function resolveWorkspaceRoot(rawInput) {
  let input = {};
  try { input = JSON.parse(rawInput || '{}'); } catch { /* fall back to cwd */ }
  const roots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots.filter((r) => typeof r === 'string' && r.length > 0)
    : [];
  // cwd is a CANDIDATE, not merely the empty-roots fallback: an IDE invocation
  // can supply workspace_roots AND run from the project, and searching roots
  // alone would report "absent" for a project sitting right at cwd — narrower
  // than the pre-fix behavior it replaces.
  for (const root of [...roots, process.cwd()]) {
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
    const statePresent = fs.existsSync(statePath);
    const msg = statePresent ? MSG_PRESENT : MSG_ABSENT;
    process.stdout.write(JSON.stringify({ additional_context: msg }));
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
});
