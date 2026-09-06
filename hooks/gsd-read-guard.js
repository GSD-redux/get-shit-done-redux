#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Read Guard — PreToolUse hook
// Injects advisory guidance when Write/Edit targets an existing file,
// reminding the model to Read the file first.
//
// Background: Non-Claude models (e.g. MiniMax M2.5 on OpenCode) don't
// natively follow the read-before-edit pattern. When they attempt to
// Write/Edit an existing file without reading it, the runtime rejects
// with "You must read file before overwriting it." The model retries
// without reading, creating an infinite loop that burns through usage.
//
// This hook prevents that loop by injecting clear guidance BEFORE the
// tool call reaches the runtime. The model sees the advisory and can
// issue a Read call on the next turn.
//
// Triggers on: Write and Edit tool calls
// Action: Advisory (does not block) — injects read-first guidance
// Only fires when the target file already exists on disk.

const fs = require('fs');
const path = require('path');
const { HOOK_ON_CRASH, allow, crash } = require('./lib/hook-exit.js');

// This guard is pure advisory UX — a reminder to Read before Write/Edit on
// non-Claude-Code runtimes. A crash here must not block a legitimate Write/
// Edit; the worst outcome of failing open is the model hitting the runtime's
// own read-before-edit rejection it was trying to help avoid (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;

// #2304: Kimi's native hook bus delivers Kimi's tool vocabulary in the payload
// (Write → WriteFile, Edit/MultiEdit → StrReplaceFile) while the [[hooks]]
// matcher is registered pre-translated (runtime-hooks-surface.cts
// buildKimiHooksTomlBlock) — so without normalizing the payload too, the
// matcher fires but the tool_name check below exits 0 and the guard is dormant
// on Kimi. The tool_input field names differ as well (kimi-cli
// src/kimi_cli/tools/file/{write,replace}.py): WriteFile takes `path`/`content`,
// StrReplaceFile takes `path` + `edit: Edit | list[Edit]` with `old`/`new` —
// kimi-cli's hooks/events.py forwards tool_input verbatim, so both layers need
// mapping. Accepts bare and module-qualified ('kimi_cli.tools.file:WriteFile')
// names; unknown names fall through untouched. Inlined per guard (not
// hooks/lib/): hook scripts are staged as standalone files, and a sibling
// require is a staging dependency that can fail silently.
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

// #4332: Antigravity's hook bus is the #2304 defect one runtime over, plus a
// layer. `install --antigravity` registers 13 hooks whose EVENT names are
// translated (BeforeTool/AfterTool — ADR-857/1016, #1077) but whose matchers
// and payload reads were left in Claude Code's vocabulary, so every guard was
// spawned and then exited 0 on `data.tool_name === undefined`. Antigravity
// does not merely rename the tools the way Kimi does — it NESTS the call and
// uses PascalCase argument keys:
//   { toolCall: { name: 'write_to_file', args: { AbsolutePath, TargetFile } },
//     conversationId: '…' }
// so a name map alone (the #2507 shape) is not enough; the envelope needs
// lifting too. `AbsolutePath` is authoritative and wins outright over
// `TargetFile`, for the same reason Kimi's `path` wins over a model-supplied
// `file_path` (#2547/#2752): overwriting can only narrow what a guard inspects
// to the path that will actually be written, so it cannot under-block.
// Runs BEFORE normalizeKimiPayload and is a no-op on every other runtime — a
// payload with no `toolCall` object is returned untouched, so a Claude Code or
// Kimi payload never enters this path. Inlined per guard, not hooks/lib/, for
// the reason stated above the Kimi block.
const ANTIGRAVITY_TOOL_NAMES = new Map([['write_to_file', 'Write'], ['replace_file_content', 'Edit'], ['multi_replace_file_content', 'Edit'], ['view_file', 'Read'], ['run_command', 'Bash'], ['grep_search', 'Grep']]);
function normalizeAntigravityPayload(data) {
  if (data === null || typeof data !== 'object') return data;
  const call = data.toolCall;
  if (call === null || typeof call !== 'object') return data;
  const raw = call.name;
  if (typeof raw !== 'string') return data;
  const mapped = ANTIGRAVITY_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  if (typeof data.session_id !== 'string' && typeof data.conversationId === 'string') {
    data.session_id = data.conversationId;
  }
  const args = call.args;
  if (args !== null && typeof args === 'object') {
    const input = (data.tool_input !== null && typeof data.tool_input === 'object') ? data.tool_input : {};
    // Only documented keys are lifted, and only from a string: a bulk copy of
    // `args` would carry an attacker-chosen `__proto__` key into a plain
    // object, and would invent field names this runtime has not been observed
    // to send. A key that is absent leaves the guard reading `undefined` and
    // failing open exactly as it does today — never worse than dormant.
    if (typeof args.TargetFile === 'string') input.file_path = args.TargetFile;
    if (typeof args.AbsolutePath === 'string') input.file_path = args.AbsolutePath;
    for (const key of ['CommandLine', 'Command']) {
      if (typeof args[key] === 'string') { input.command = args[key]; break; }
    }
    data.tool_input = input;
  }
  return data;
}

let input = '';
const stdinTimeout = setTimeout(() => allow(undefined), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = normalizeKimiPayload(normalizeAntigravityPayload(JSON.parse(input)));
    const toolName = data.tool_name;

    // Only intercept Write and Edit tool calls
    if (toolName !== 'Write' && toolName !== 'Edit') {
      allow(undefined);
    }

    // Claude Code natively enforces read-before-edit — skip the advisory (#1984, #2344, #2520).
    //
    // Detection signals, in priority order:
    //   1. `data.session_id` on the hook's stdin payload — part of Claude
    //      Code's documented PreToolUse hook-input schema, always present.
    //      Reliable across Claude Code versions because it's schema, not env.
    //   2. `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_SSE_PORT` — env vars that
    //      Claude Code does propagate to hook subprocesses (verified on
    //      Claude Code CLI 2.1.116).
    //   3. `CLAUDE_SESSION_ID` / `CLAUDECODE` — kept for back-compat and in
    //      case future Claude Code versions propagate them to hook
    //      subprocesses. On 2.1.116 they reach Bash tool subprocesses but
    //      not hook subprocesses, which is why checking them alone is
    //      insufficient (regression of #2344 fixed here as #2520).
    const isClaudeCode =
      (typeof data.session_id === 'string' && data.session_id.length > 0) ||
      process.env.CLAUDE_CODE_ENTRYPOINT ||
      process.env.CLAUDE_CODE_SSE_PORT ||
      process.env.CLAUDE_SESSION_ID ||
      process.env.CLAUDECODE;
    if (isClaudeCode) {
      allow(undefined);
    }

    // #2595 (review Major 3, sibling sweep): typed read — same class as the
    // worktree guard's, advisory-only here (no exit(2) path in this hook).
    const filePath = typeof data.tool_input?.file_path === 'string'
      ? data.tool_input.file_path
      : '';
    if (!filePath) {
      allow(undefined);
    }

    // Only inject guidance when the file already exists.
    // New files don't need a prior Read — the runtime allows creating them directly.
    let fileExists = false;
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      fileExists = true;
    } catch {
      // File does not exist — no guidance needed
    }

    if (!fileExists) {
      allow(undefined);
    }

    const fileName = path.basename(filePath);

    // Advisory guidance — does not block the operation
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `READ-BEFORE-EDIT REMINDER: You are about to modify "${fileName}" which already exists. ` +
          'If you have not already used the Read tool to read this file in the current session, ' +
          'you MUST Read it first before editing. The runtime will reject edits to files that ' +
          'have not been read. Use the Read tool on this file path, then retry your edit.',
        code: 'READ_BEFORE_EDIT',
        fileName,
      },
    };

    process.stdout.write(JSON.stringify(output));
  } catch {
    // Silent fail — never block tool execution.
    // ON_CRASH is declared ALLOW at module top: this preserves today's
    // exit(0) fail-open behavior exactly (#3911).
    crash(ON_CRASH, undefined);
  }
});
