#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-config-reload.js — FileChanged hook: hot-reload GSD config context
// Fires when .planning/config.json is modified, created, or deleted.
//
// When the user edits .planning/config.json mid-session, this hook reads the
// updated config and injects a summary as additionalContext so the agent knows
// the new configuration without requiring a session restart.
//
// Input (from Claude Code):
//   { session_id, cwd, hook_event_name: "FileChanged",
//     file_path: "/abs/path/.planning/config.json", event: "change"|"add"|"unlink" }
//
// Output:
//   { hookSpecificOutput: { hookEventName: "FileChanged", additionalContext: "..." } }
//   or exits 0 silently (if config absent, unreadable, or event is "unlink").
//
// Enabled for all Claude Code installs. This hook is always-on — it is a
// no-op when .planning/config.json is absent (ENOENT → exit 0).

const fs = require('fs');
const path = require('path');
const { HOOK_ON_CRASH, allow, crash } = require('./lib/hook-exit.js');

// This hook only injects an advisory config-reload summary; a crash mid-parse
// must not block the session or the FileChanged event that triggered it — the
// agent simply keeps using the config context it already had (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;

let input = '';
// Timeout guard: if stdin does not close within 8s exit silently rather than
// hanging until Claude Code kills the process and reports "hook error".
const stdinTimeout = setTimeout(() => allow(undefined), 8000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const event = data.event; // "change" | "add" | "unlink"
    const filePath = data.file_path || '';
    const cwd = data.cwd || process.cwd();

    // Only handle the GSD planning config — verify both basename and that the
    // resolved path is .planning/config.json relative to cwd.  The hook
    // matcher ('config.json') fires on any watched config.json; this guard
    // ensures an unrelated config.json in node_modules/ or elsewhere does not
    // inject spurious additionalContext.
    const basename = path.basename(filePath);
    if (basename !== 'config.json') {
      allow(undefined);
    }
    const expectedPath = path.resolve(cwd, '.planning', 'config.json');
    if (path.resolve(filePath) !== expectedPath) {
      allow(undefined);
    }

    // On unlink (deletion) emit a brief notice and exit
    if (event === 'unlink') {
      allow({
        hookSpecificOutput: {
          hookEventName: 'FileChanged',
          additionalContext:
            'GSD config (.planning/config.json) was deleted. ' +
            'Falling back to built-in defaults for this session.',
        },
      });
    }

    // Read the updated config file
    let config;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      config = JSON.parse(raw);
    } catch (e) {
      if (e && e.code === 'ENOENT') allow(undefined);
      // Malformed JSON — inform the agent without crashing
      allow({
        hookSpecificOutput: {
          hookEventName: 'FileChanged',
          additionalContext:
            'GSD config (.planning/config.json) was modified but could not be parsed. ' +
            'Check the file for JSON syntax errors.',
        },
      });
    }

    // Build a concise summary of key config fields the agent cares about
    const lines = ['GSD config reloaded (.planning/config.json updated):'];

    if (config.runtime) lines.push(`  runtime: ${config.runtime}`);
    if (config.mode) lines.push(`  mode: ${config.mode}`);

    // hooks section (opt-in toggles agents act on)
    if (config.hooks && typeof config.hooks === 'object') {
      const hookKeys = Object.entries(config.hooks)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (hookKeys) lines.push(`  hooks: { ${hookKeys} }`);
    }

    // workflow section (key toggles)
    if (config.workflow && typeof config.workflow === 'object') {
      const wfKeys = Object.entries(config.workflow)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (wfKeys) lines.push(`  workflow: { ${wfKeys} }`);
    }

    // model overrides (agents use these)
    if (config.models && typeof config.models === 'object') {
      const modelKeys = Object.entries(config.models)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (modelKeys) lines.push(`  models: { ${modelKeys} }`);
    }

    if (lines.length === 1) {
      // No notable fields — still confirm the reload happened
      lines.push('  (no notable keys changed)');
    }

    const additionalContext = lines.join('\n');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'FileChanged',
        additionalContext,
      },
    }));
  } catch (e) {
    // Silent fail — never block the session on a config reload error.
    // ON_CRASH is declared ALLOW at module top: this preserves today's
    // exit(0) fail-open behavior exactly (#3911).
    crash(ON_CRASH, undefined);
  }
});
