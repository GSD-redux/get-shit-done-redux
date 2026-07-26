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

const MSG_PRESENT =
  'GSD: .planning/STATE.md is present — review the current phase and any blockers before acting.';
const MSG_ABSENT =
  'GSD: no .planning/ workflow found — run /gsd:new-project to start a tracked workflow.';

// Workspace resolution is shared across the Cursor hooks (#2587) — see
// hooks/lib/cursor-workspace.js. Staged next to these scripts by
// writeCursorHooksJson so the require always resolves post-install.
const { resolveStatePath } = require('./lib/cursor-workspace.js');

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
    const statePath = resolveStatePath(raw);
    const statePresent = fs.existsSync(statePath);
    const msg = statePresent ? MSG_PRESENT : MSG_ABSENT;
    process.stdout.write(JSON.stringify({ additional_context: msg }));
  } catch {
    // Fail open — never block a Cursor session because of a GSD hook error.
    process.stdout.write(JSON.stringify({}));
  }
});
