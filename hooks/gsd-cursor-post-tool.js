#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-cursor-post-tool.js — Cursor postToolUse hook (issue #777)
//
// Cursor invokes this script after each tool call completes.
// Protocol: JSON from Cursor on stdin; JSON response on stdout.
//
// Input schema (cursor postToolUse):
//   { tool_name, tool_input, tool_output, duration,
//     conversation_id, generation_id, model, hook_event_name,
//     cursor_version, workspace_roots, user_email, transcript_path }
//
// Output schema (cursor postToolUse):
//   { additional_context?: string }   ← injected as context after the tool use
//
// Behaviour:
//   - After a write-class tool that targets .planning/, reminds the agent
//     to keep STATE.md current.
//   - Fails open: any error silently exits 0.
//
// Cursor docs: https://cursor.com/docs/hooks

'use strict';

const { allow } = require('./lib/hook-exit.js');

const WRITE_TOOL_RE = /write|edit|replace|create|delete|remove|append|apply|patch|insert|mkdir/i;
const PATH_KEY_RE = /^(path|file|file_?path|filepath|target_?path|target|dir|directory|uri|filename)$/i;
const PLANNING_PATH_RE = /(^|[\\/])\.planning([\\/]|$)/;

let raw = '';
const stdinTimeout = setTimeout(() => {
  // Timeout guard: exit silently rather than hanging.
  allow(undefined);
}, 10000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    let input;
    try { input = JSON.parse(raw || '{}'); } catch { process.stdout.write(JSON.stringify({})); return; }

    const toolName = String(
      input.tool_name || input.toolName || ''
    ).toLowerCase();

    const isWrite = WRITE_TOOL_RE.test(toolName);
    if (!isWrite) { process.stdout.write(JSON.stringify({})); return; }

    // Collect only PATH-bearing field values (not free-form content).
    const paths = [];
    const walk = (v, depth) => {
      if (depth > 5 || paths.length > 64) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          const val = v[k];
          if (typeof val === 'string' && PATH_KEY_RE.test(k)) paths.push(val);
          else walk(val, depth + 1);
        }
      }
    };
    walk(input.tool_input || input.toolInput || {}, 0);

    if (paths.some((p) => PLANNING_PATH_RE.test(p))) {
      process.stdout.write(JSON.stringify({
        additional_context:
          'GSD: .planning/ artifact updated — ensure STATE.md reflects the latest phase and progress.',
      }));
      return;
    }
  } catch { /* fall through to empty response */ }

  process.stdout.write(JSON.stringify({}));
});
