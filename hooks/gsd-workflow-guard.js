#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Workflow Guard — PreToolUse hook
// Detects when Claude attempts file edits outside a GSD workflow context
// (no active /gsd- skill or Task subagent) and injects an advisory warning.
//
// This is a SOFT guard — it advises, not blocks. The edit still proceeds.
// The warning nudges Claude to use /gsd:quick or /gsd:fast instead of
// making direct edits that bypass state tracking.
//
// Enable via config: hooks.workflow_guard: true (default: false)
// Only triggers on Write/Edit tool calls to non-.planning/ files.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tokenize } = require('./lib/git-cmd.js');

function forceGitAddCwds(command, defaultCwd) {
  const tokens = tokenize(command || '');
  const separators = new Set(['&&', '||', ';', '|']);
  const cwdList = [];
  for (let i = 0; i < tokens.length; i++) {
    if (path.basename(tokens[i]) !== 'git') continue;

    let j = i + 1;
    let gitCwd = defaultCwd;
    while (j < tokens.length) {
      const token = tokens[j];
      const flagName = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (token === '-C' && tokens[j + 1]) {
        gitCwd = path.resolve(gitCwd, tokens[j + 1]);
        j += 2;
        continue;
      }
      if (['-C', '--git-dir', '--work-tree'].includes(flagName) && !token.includes('=')) {
        j += 2;
        continue;
      }
      if (['--git-dir', '--work-tree', '--no-pager', '-p', '-P'].includes(flagName)) {
        j++;
        continue;
      }
      break;
    }

    if (tokens[j] !== 'add') continue;
    for (let k = j + 1; k < tokens.length && !separators.has(tokens[k]); k++) {
      if (tokens[k] === '--') break;
      if (tokens[k] === '--force' || tokens[k] === '-f' || /^-[A-Za-z]*f[A-Za-z]*$/.test(tokens[k])) {
        cwdList.push(gitCwd);
        break;
      }
    }
  }
  return cwdList;
}

function currentBranch(cwd) {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function workflowGuardEnabled(cwd) {
  const configPath = path.join(cwd, '.planning', 'config.json');
  if (!fs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Boolean(config.hooks?.workflow_guard);
  } catch (e) {
    return false;
  }
}

// Kimi CLI delivers the tool vocabulary the matcher was registered with —
// this guard's Kimi matcher is 'Shell|WriteFile|StrReplaceFile'
// (runtime-hooks-surface.cts), so tool_name arrives in Kimi vocabulary
// (possibly module-qualified) and neither the Bash branch nor the
// Write/Edit/MultiEdit allowlist below ever matched on Kimi (#2304).
// kimi-cli's Shell.Params names its field `command`
// (src/kimi_cli/tools/shell/__init__.py), same as Claude's Bash, so the
// Shell leg needs only the name mapping. This block is kept byte-identical
// with the copies in gsd-prompt-guard.js, gsd-read-guard.js,
// gsd-worktree-path-guard.js, and gsd-read-injection-scanner.js — a parity
// test binds them (tests/kimi-guard-normalization-parity.test.cjs). Inlined
// per guard (not hooks/lib/): hook scripts are staged as standalone files,
// and a sibling require is a staging dependency that can fail silently.
// A Map, not an object literal: bare bracket lookup resolves prototype keys
// ('constructor', '__proto__', 'toString') to truthy functions/objects, so the
// !mapped fall-through never fires for them; Map.get returns undefined (same
// shape as canonicalizeRuntimeName in src/runtime-name-policy.cts).
const KIMI_TOOL_NAMES = new Map([['WriteFile', 'Write'], ['StrReplaceFile', 'Edit'], ['ReadFile', 'Read'], ['Shell', 'Bash']]);
function normalizeKimiPayload(data) {
  // #2595 (review nit): `JSON.parse('null')` is null, and null/primitive
  // payloads reached the `data.tool_name` read below and threw — falsifying
  // this function's own "total over the inputs JSON can express" claim, which
  // property (e) now tests directly. Harmless in practice (a null payload has
  // nothing to guard, and the throw landed in the same fail-open catch as the
  // exit-0 it now takes deliberately) but the claim should be true as stated.
  if (data === null || typeof data !== 'object') return data;
  const raw = data.tool_name;
  if (typeof raw !== 'string') return data;
  const mapped = KIMI_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  if (data.tool_response === undefined && data.tool_output !== undefined) {
    data.tool_response = data.tool_output;
  }
  const input = data.tool_input;
  if (input && typeof input === 'object') {
    // #2547 (review): Kimi's `path` is AUTHORITATIVE — it must win outright,
    // not merely fill in when `file_path` happens to be absent. kimi-cli's file
    // tools carry no `file_path` field at all (src/kimi_cli/tools/file/write.py,
    // replace.py, @ 4a550ef — the SHA #2547 pins), and soul/toolset.py hands the
    // model's raw json-parsed
    // arguments to PreToolUse verbatim, doing typed validation only later inside
    // tool.call() — after the hook has already decided. So a `file_path` in a
    // Kimi payload is ALWAYS model-supplied, and under the old `=== undefined`
    // condition it SHADOWED the field kimi-cli actually executes on. A payload
    // pairing a cross-root `path` with a spurious `file_path: ""` left every
    // guard reading an empty string and exiting 0, while the identical write
    // without the extra key blocked — a bypass needing no crash at all. The same
    // shadowing also preserved a NON-STRING `file_path` (`[]`), which threw
    // inside gsd-worktree-path-guard's path.isAbsolute() and reached its outer
    // `catch { process.exit(0) }`: the same crash-to-allow this fix closes
    // elsewhere, reached through the guard's own read rather than through
    // normalization. Overwriting can only ever narrow what a guard inspects to
    // the path that will actually be written, so it cannot under-block.
    if (typeof input.path === 'string') {
      input.file_path = input.path;
    }
    const edits = Array.isArray(input.edit) ? input.edit
      : (input.edit && typeof input.edit === 'object') ? [input.edit] : [];
    if (edits.length) {
      // #2547: `e?.old`, not `e.old` — `??` guards the value, not the
      // dereference, so a NULLISH entry (`edit: [null]`) threw a TypeError
      // here. normalizeKimiPayload runs before any tool dispatch, so that throw
      // reached each guard's outer `catch { process.exit(0) }` and silently
      // downgraded a should-BLOCK call into an allow. (A string/number entry
      // never threw — `('x').old` is a legal read yielding undefined.)
      //
      // The String() coercion is guarded for the same reason: `{"toString":
      // null}` is valid JSON that throws "Cannot convert object to primitive
      // value", which is the identical crash-to-allow with a different
      // trigger. Degrading only the non-coercible entry to '' keeps
      // stringification intact for every value that CAN coerce (numbers,
      // arrays, plain objects), so nothing downstream — including
      // gsd-prompt-guard's scan of new_string — loses content it saw before.
      const editText = (v) => { try { return String(v ?? ''); } catch { return ''; } };
      // #2595 (review Major 2): reconstruct UNCONDITIONALLY, mirroring the
      // `path` decision above rather than merely filling in when the field
      // happens to be absent. kimi-cli's StrReplaceFile schema is `path` +
      // `edit` only (src/kimi_cli/tools/file/replace.py @ 4a550ef) — it carries
      // no `old_string`/`new_string` at all, so either field appearing in a
      // Kimi payload is ALWAYS model-supplied, exactly like `file_path`. Under
      // the old `=== undefined` condition a model-supplied `new_string: ""`
      // SHADOWED the reconstruction, leaving gsd-prompt-guard's injection scan
      // reading '' and exiting at its `if (!content)` before it ever saw the
      // real `edit[].new` — a one-key bypass of the very scan this fix's
      // guarded coercion exists to keep fed. A `typeof` test would NOT close
      // it: a benign non-empty string shadows just as effectively as ''.
      input.old_string = edits.map((e) => editText(e?.old)).join('\n');
      input.new_string = edits.map((e) => editText(e?.new)).join('\n');
    }
  }
  return data;
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = normalizeKimiPayload(JSON.parse(input));
    const toolName = data.tool_name;
    const cwd = data.cwd || process.cwd();
    const isWorkflowGuardEnabled = workflowGuardEnabled(cwd);

    if (toolName === 'Bash') {
      if (!isWorkflowGuardEnabled) {
        process.exit(0);
      }
      const command = data.tool_input?.command || '';
      for (const gitCwd of forceGitAddCwds(command, cwd)) {
        const branch = currentBranch(gitCwd);
        if (/^(worktree-)?agent-/.test(branch)) {
          const output = {
            decision: 'block',
            code: 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN',
            reason: 'agent/worktree-agent branches must not run git add -f or git add --force. Respect the SDK skipped_gitignored/skipped_commit_docs_false contract and leave gitignored files untracked.',
          };
          process.stdout.write(JSON.stringify(output));
          // Kimi CLI's exit-2 protocol feeds stderr back to the model (#2304)
          process.stderr.write(output.reason);
          process.exit(2);
        }
      }
      process.exit(0);
    }

    // Only guard Write, Edit, and MultiEdit tool calls
    if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      process.exit(0);
    }

    // Check if we're inside a GSD workflow (Task subagent or /gsd- skill)
    // Subagents have a session_id that differs from the parent
    // and typically have a description field set by the orchestrator
    if (data.tool_input?.is_subagent || data.session_type === 'task') {
      process.exit(0);
    }

    // Check the file being edited
    // #2595 (review Major 3, sibling sweep): typed read on BOTH fields. The
    // `&& value` keeps the original truthiness fallback intact — an empty
    // file_path must still fall through to `path`, which a bare typeof test
    // would have broken.
    const filePath =
      (typeof data.tool_input?.file_path === 'string' && data.tool_input.file_path) ||
      (typeof data.tool_input?.path === 'string' && data.tool_input.path) ||
      '';

    // Allow edits to .planning/ files (GSD state management)
    if (filePath.includes('.planning/') || filePath.includes('.planning\\')) {
      process.exit(0);
    }

    // Allow edits to common config/docs files that don't need GSD tracking
    const allowedPatterns = [
      /\.gitignore$/,
      /\.env/,
      /CLAUDE\.md$/,
      /AGENTS\.md$/,
      /GEMINI\.md$/,
      /settings\.json$/,
    ];
    if (allowedPatterns.some(p => p.test(filePath))) {
      process.exit(0);
    }

    if (!isWorkflowGuardEnabled) {
      process.exit(0); // Guard disabled (default) or no GSD project
    }

    // If we get here: GSD project, guard enabled, file edit outside .planning/,
    // not in a subagent context. Inject advisory warning.
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `⚠️ WORKFLOW ADVISORY: You're editing ${path.basename(filePath)} directly without a GSD command. ` +
          'This edit will not be tracked in STATE.md or produce a SUMMARY.md. ' +
          'Consider using /gsd:fast for trivial fixes or /gsd:quick for larger changes ' +
          'to maintain project state tracking. ' +
          'If this is intentional (e.g., user explicitly asked for a direct edit), proceed normally.'
      }
    };

    process.stdout.write(JSON.stringify(output));
  } catch (e) {
    // Silent fail — never block tool execution
    process.exit(0);
  }
});
