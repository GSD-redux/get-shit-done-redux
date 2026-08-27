#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-cursor-subagent-stop.js — Cursor subagentStop hook (ADR-1239 / #2089)
//
// Cursor invokes this script when a subagent session completes.
// Protocol: JSON from Cursor on stdin; JSON response on stdout.
//
// Input schema (cursor subagentStop):
//   { session_id, conversation_id, generation_id, model, hook_event_name,
//     cursor_version, workspace_roots, user_email, transcript_path }
//
// Output schema (cursor subagentStop):
//   { additional_context?: string }
//
// Behaviour:
//   - Reminds the orchestrating agent to check the subagent's output.
//   - Fails open: any error silently exits 0.
//
// Cursor docs: https://cursor.com/docs/hooks

'use strict';

const { allow } = require('./lib/hook-exit.js');

const stdinTimeout = setTimeout(() => {
  allow(undefined);
}, 10000);

process.stdin.setEncoding('utf8');
// Drain stdin (puts the stream into flowing mode so 'end' fires); the
// payload itself is unused — this hook responds unconditionally.
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    process.stdout.write(JSON.stringify({
      additional_context:
        'GSD: Subagent completed — review its output and update .planning/STATE.md if the phase progressed.',
    }));
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
});
