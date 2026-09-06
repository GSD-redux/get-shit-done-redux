#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Workflow Guard — PreToolUse hook
// Detects when Claude attempts file edits outside a GSD workflow context
// (no active /gsd- skill or Task subagent) and injects an advisory warning.
//
// This is a SOFT guard for edits — it advises, not blocks. The edit still
// proceeds. The warning nudges Claude to use /gsd:quick or /gsd:fast instead
// of making direct edits that bypass state tracking.
//
// ONE hard block lives here: `git add -f` on an agent/worktree-agent branch
// (WORKTREE_AGENT_FORCE_ADD_FORBIDDEN) — and that block leg fails CLOSED on
// internal error (#3504): when the guard is enabled and the blocking context
// holds, a thrown error exits 2 (block), not 0. The advisory legs keep the
// fail-open posture — a broken advisory must never wedge every tool call.
//
// Enable via config: hooks.workflow_guard: true (default: false)
// Only triggers on Write/Edit tool calls to non-.planning/ files.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tokenize, skipToSubcommand } = require('./lib/git-cmd.js');
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');
const { reportIfUndetermined } = require('./lib/git-probe.js');

// This guard is almost entirely advisory (fail open — a broken advisory must
// never wedge every tool call), with ONE hard block (#3504 force-add-on-
// agent-branch) that fails CLOSED on internal error instead. That split is
// re-derived dynamically inside the outer catch (failClosedBlockContext), not
// a fixed per-hook policy, so ON_CRASH names only the FINAL, unconditional
// fallback reached when the fail-closed context does not apply — i.e. the
// historical exit(0). Declared ONCE here so that fallback states its policy
// explicitly rather than inheriting a default (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;

function forceGitAddCwds(command, defaultCwd) {
  const tokens = tokenize(command || '');
  const separators = new Set(['&&', '||', ';', '|']);
  const cwdList = [];
  // #3504: per-segment walk driven by git-cmd.js's canonical skipToSubcommand.
  // The previous inline walk knew six global flags and silently missed the
  // rest — `git -c core.hooksPath=/tmp/x add -f x`, `git --no-optional-locks
  // add -f x`, `--literal-pathspecs`, `--namespace=…` and friends all fell
  // through to a silent exit 0, a no-crash bypass the fail-closed catch is
  // structurally blind to (it only fires on throws). Sharing the classifier
  // makes the block's flag knowledge exactly the classifier's.
  const segments = [];
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i === tokens.length || separators.has(tokens[i])) {
      if (i > start) segments.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  for (const seg of segments) {
    const subIdx = skipToSubcommand(seg);
    if (subIdx === -1 || subIdx >= seg.length || seg[subIdx] !== 'add') continue;

    // Resolve a `-C <dir>` (separate-arg form) preceding the subcommand so
    // the branch is probed at the repository the add targets.
    let gitCwd = defaultCwd;
    for (let k = 0; k < subIdx; ) {
      if (seg[k] === '-C' && k + 1 < subIdx) {
        gitCwd = path.resolve(gitCwd, seg[k + 1]);
        k += 2;
        continue;
      }
      k++;
    }

    for (let k = subIdx + 1; k < seg.length; k++) {
      if (seg[k] === '--') break;
      if (seg[k] === '--force' || seg[k] === '-f' || /^-[A-Za-z]*f[A-Za-z]*$/.test(seg[k])) {
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
    // #3504: bounded — this ran unbounded before, an indefinite hang under a
    // wedged git would hang every PreToolUse call. Host wiring allows a 5s
    // budget for the whole hook, so the probe gets 2s of it; a timeout
    // returns '' (branch unknown), which both the block decision and the
    // fail-closed re-check treat as "cannot establish agent branch".
    timeout: 2000,
    killSignal: 'SIGTERM',
  });
  // #3911: a timeout/spawn-failure here previously degraded to '' exactly
  // like a clean "not on a branch" answer — indistinguishable from the
  // caller's point of view. reportIfUndetermined is a no-op on a genuine
  // negative and only emits a diagnostic when the probe itself could not
  // run; the '' fallback (and therefore this hook's exit code) is unchanged.
  reportIfUndetermined('gsd-workflow-guard', 'git branch --show-current', result);
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

// Agent-branch predicate, shared by the happy-path detector and the fail-closed
// re-check so the block's scope cannot drift between the two paths (#3504).
function isAgentBranch(branch) {
  return /^(worktree-)?agent-/.test(branch);
}

// Typed cwd read, shared by both paths for the same reason: a non-string cwd
// degrades to process.cwd() instead of throwing inside path.join().
function payloadCwd(data) {
  return typeof data?.cwd === 'string' && data.cwd ? data.cwd : process.cwd();
}

// The force-add block payload, emitted by the happy-path detector and the
// fail-closed catch — one source so the two exits cannot drift. `origin`
// distinguishes them structurally ('force-add-detected' vs 'fail-closed') so a
// consumer — or the model reading Kimi's stderr feedback — is never told a
// force-add was detected when the call was in fact blocked unanalyzed.
function emitForceAddBlock(origin) {
  const failClosed = origin === 'fail-closed';
  const reason = failClosed
    ? 'workflow guard internal error on an agent branch - failing closed. The command was NOT analyzed and was NOT confirmed to be a force-add. Retry the call or inspect the guard.'
    : 'agent/worktree-agent branches must not run git add -f or git add --force. Respect the SDK skipped_gitignored/skipped_commit_docs_false contract and leave gitignored files untracked.';
  const output = {
    decision: 'block',
    code: 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN',
    origin: failClosed ? 'fail-closed' : 'force-add-detected',
    reason,
  };
  // Kimi CLI's exit-2 protocol feeds stderr back to the model (#2304) — deny's
  // stderrPayload keeps fd 2 to the plain reason string, matching the
  // pre-migration two-write byte-for-byte.
  deny(output, output.reason);
}

// #3504 fail-closed context re-derivation. Runs INSIDE the outer catch, after
// an internal error, and answers exactly one question: does the blocking
// context of the force-add guard hold for this payload? Each stage is guarded —
// a re-derivation that itself throws must degrade to "cannot establish" (false),
// never take down the catch. Deliberately does NOT re-detect the force-add: the
// error may live in the detector itself, and on an agent branch with the guard
// enabled, a Bash call under an internal error is conservative-correct to block.
// Anything it cannot establish (unparseable payload, non-Bash tool, guard
// disabled, branch not determinably agent-*) fails open, preserving the
// advisory legs' fail-open posture.
function failClosedBlockContext(rawInput) {
  let data;
  try {
    data = normalizeKimiPayload(normalizeAntigravityPayload(JSON.parse(rawInput)));
  } catch {
    return false;
  }
  if (data === null || typeof data !== 'object' || data.tool_name !== 'Bash') return false;
  const cwd = payloadCwd(data);
  let enabled;
  try {
    enabled = workflowGuardEnabled(cwd);
  } catch {
    return false;
  }
  if (!enabled) return false;
  let branch;
  try {
    branch = currentBranch(cwd);
  } catch {
    return false;
  }
  return isAgentBranch(branch);
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
    // #3504 test-only fault seam: throws right after parse so the fail-closed
    // posture of the outer catch is exercisable — no JSON-expressible input
    // throws in this handler today (#2547/#2595 hardened every read). Gated on
    // GSD_TEST_MODE as well so a leaked GSD_TEST_WORKFLOW_GUARD_FAULT in a real
    // shell cannot wedge a production session. The fault's failure direction
    // is CLOSED: the catch below may block, never bypass a block.
    if (process.env.GSD_TEST_MODE === '1' && process.env.GSD_TEST_WORKFLOW_GUARD_FAULT === '1') {
      throw new Error('GSD_TEST_WORKFLOW_GUARD_FAULT: injected fault');
    }
    const toolName = data.tool_name;
    const cwd = data.cwd || process.cwd();
    const isWorkflowGuardEnabled = workflowGuardEnabled(cwd);

    if (toolName === 'Bash') {
      if (!isWorkflowGuardEnabled) {
        allow(undefined);
      }
      const command = data.tool_input?.command || '';
      for (const gitCwd of forceGitAddCwds(command, cwd)) {
        const branch = currentBranch(gitCwd);
        if (/^(worktree-)?agent-/.test(branch)) {
          emitForceAddBlock();
        }
      }
      allow(undefined);
    }

    // Only guard Write, Edit, and MultiEdit tool calls
    if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      allow(undefined);
    }

    // Check if we're inside a GSD workflow (Task subagent or /gsd- skill)
    // Subagents have a session_id that differs from the parent
    // and typically have a description field set by the orchestrator
    if (data.tool_input?.is_subagent || data.session_type === 'task') {
      allow(undefined);
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
      allow(undefined);
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
      allow(undefined);
    }

    if (!isWorkflowGuardEnabled) {
      allow(undefined); // Guard disabled (default) or no GSD project
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
          'If this is intentional (e.g., user explicitly asked for a direct edit), proceed normally.',
        code: 'WORKFLOW_ADVISORY'
      }
    };

    process.stdout.write(JSON.stringify(output));
  } catch {
    // #3504: split posture on internal error. The ONE hard block in this hook
    // (force-add on agent branches) fails CLOSED — if the blocking context can
    // be re-derived from the payload (Bash tool + guard enabled + determinably
    // an agent branch), deny rather than silently allowing. Everything else
    // keeps the historical fail-open posture: a broken advisory guard must
    // never wedge the session's tool calls. ON_CRASH is declared ALLOW at
    // module top for exactly that unconditional fallback (#3911).
    if (failClosedBlockContext(input)) {
      emitForceAddBlock('fail-closed');
    }
    crash(ON_CRASH, undefined);
  }
});
