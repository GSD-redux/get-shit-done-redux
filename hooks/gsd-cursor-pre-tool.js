#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-cursor-pre-tool.js — Cursor preToolUse hook (ADR-1239 / #2089)
//
// Cursor invokes this script before each tool call executes.
// Protocol: JSON from Cursor on stdin; JSON response on stdout.
//
// Input schema (cursor preToolUse):
//   { tool_name, tool_input, conversation_id, generation_id, model,
//     hook_event_name, cursor_version, workspace_roots, user_email,
//     transcript_path }
//
// Output schema (cursor preToolUse):
//   { additional_context?: string, block?: boolean, reason?: string }
//
// Behaviour:
//   - If a write-class tool targets .planning/, reminds the agent to keep
//     STATE.md current before the write proceeds.
//   - Fails open: any error silently exits 0 so a hook bug never wedges Cursor.
//
// Cursor docs: https://cursor.com/docs/hooks

'use strict';

const WRITE_TOOL_RE = /write|edit|replace|create|delete|remove|append|apply|patch|insert|mkdir/i;
const PATH_KEY_RE = /^(path|file|file_?path|filepath|target_?path|target|dir|directory|uri|filename)$/i;
const PLANNING_PATH_RE = /(^|[\\/])\.planning([\\/]|$)/;

let raw = '';
const stdinTimeout = setTimeout(() => {
  process.exit(0);
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
          'GSD: .planning/ write detected — ensure STATE.md reflects the latest phase and progress after this change.',
      }));
      return;
    }
  } catch { /* fall through to empty response */ }

  process.stdout.write(JSON.stringify({}));
});
