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
