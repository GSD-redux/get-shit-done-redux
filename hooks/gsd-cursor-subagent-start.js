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

const MSG_PRESENT =
  'GSD: Subagent session started — review .planning/STATE.md for the current phase and any blockers before acting.';
const MSG_ABSENT =
  'GSD: Subagent session started — no .planning/ workflow found.';

// Workspace resolution is shared across the Cursor hooks (#2587) — see
// hooks/lib/cursor-workspace.js. Staged next to these scripts by
// writeCursorHooksJson so the require always resolves post-install.
const { resolveStatePath } = require('./lib/cursor-workspace.js');

let raw = '';
const stdinTimeout = setTimeout(() => {
  process.exit(0);
}, 10000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const statePath = resolveStatePath(raw);
    const statePresent = fs.existsSync(statePath);
    const msg = statePresent ? MSG_PRESENT : MSG_ABSENT;
    process.stdout.write(JSON.stringify({ additional_context: msg }));
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
});
