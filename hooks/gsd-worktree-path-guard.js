#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Worktree Path Guard — PreToolUse hook
// Blocks Edit/Write/MultiEdit tool calls that target absolute paths outside the worktree root.
//
// Problem: gsd-executor agents spawned with isolation="worktree" sometimes issue
// Edit/Write calls with absolute paths rooted at the MAIN repository instead of
// the worktree (issue #260). The prose guard in agents/gsd-executor.md step 0b
// is never enforced because the model under load skips it.
//
// This hook enforces the constraint at the tooling layer, making it HARD-BLOCKING.
//
// Triggers on: Edit, Write, and MultiEdit tool calls
// Action: BLOCK (exit 2) if file_path is absolute and outside the worktree root
// No-op: relative paths, non-worktree CWDs, hook errors (silent fail)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');
const { reportIfUndetermined } = require('./lib/git-probe.js');

// This guard's outer catch has always exited 0 (fail open): a path guard that
// cannot resolve the worktree must not block the user's edit — its whole job
// is a targeted containment check, not a general-purpose file-write blocker,
// and an unresolved worktree root gives it nothing to check against. Declared
// ONCE here so the outer catch's crash() call states its policy explicitly
// rather than inheriting a default (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;

const SPAWNOPT = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true };

function git(args, cwd) {
  return spawnSync('git', args, { ...SPAWNOPT, cwd });
}

// Walk up from `start` to find the nearest existing directory.
// Returns null if we reach the filesystem root without finding one.
function nearestExistingDir(start) {
  let dir = start;
  let prev;
  do {
    prev = dir;
    try { fs.accessSync(dir, fs.constants.F_OK); return dir; } catch { /* keep walking */ }
    dir = path.dirname(dir);
  } while (dir !== prev);
  return null;
}

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

    // Only guard Edit, Write, and MultiEdit tool calls
    if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
      allow(undefined);
    }

    const cwd = data.cwd || process.cwd();

    // Detect whether CWD is inside a linked git worktree by inspecting
    // the git-dir path. In a linked worktree, git rev-parse --git-dir
    // returns a path containing .git/worktrees/ as a component.
    // In the main repo or a submodule it returns .git (or a path without /worktrees/).
    // This approach works even when cwd is a subdirectory of the worktree.
    const gitDirResult = git(['rev-parse', '--git-dir'], cwd);
    // #3911: a timeout/spawn-failure result is indistinguishable from a clean
    // "not a git repo" answer by status/stdout alone — reportIfUndetermined
    // is a no-op on a genuine negative and only fires the diagnostic when the
    // probe itself could not run. The allow() below is UNCHANGED either way.
    reportIfUndetermined('gsd-worktree-path-guard', 'git rev-parse --git-dir', gitDirResult);
    if (gitDirResult.status !== 0 || !gitDirResult.stdout) {
      allow(undefined); // not a git repo — pass through
    }

    const gitDir = gitDirResult.stdout.trim();
    // A linked worktree's --git-dir contains .git/worktrees/ as a path component
    const isLinkedWorktree = /[/\\]\.git[/\\]worktrees[/\\]/.test(gitDir);
    if (!isLinkedWorktree) {
      allow(undefined); // main repo, submodule, or separate-git-dir — no-op
    }

    // #1342: Only enforce inside a GSD-managed isolated executor worktree. Those
    // are always on an `agent-*` or legacy `worktree-agent-*` branch (the positive
    // allow-list enforced by worktree-branch-check.md, #2924, #1995). A manually-
    // created linked worktree (plain non-GSD work, e.g. Claude Code plan-mode) is
    // on the user's own branch, so the guard must be a no-op there. Detached HEAD
    // / error → not GSD-managed → no-op.
    const branchResult = git(['symbolic-ref', '--short', 'HEAD'], cwd);
    reportIfUndetermined('gsd-worktree-path-guard', 'git symbolic-ref --short HEAD', branchResult);
    const branch = branchResult.status === 0 && branchResult.stdout ? branchResult.stdout.trim() : '';
    // #3021: accept worktree-wf_<runid>-<n> branches (Workflow backend's naming).
    if (!/^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$/.test(branch)) {
      allow(undefined); // not a GSD-managed executor worktree — no-op
    }

    // Get the raw --show-toplevel output for the worktree (cwd).
    // We keep it raw (not path.resolve'd) to compare directly with the
    // file's toplevel — same git binary, same format, no normalization needed.
    const wtTopResult = git(['rev-parse', '--show-toplevel'], cwd);
    reportIfUndetermined('gsd-worktree-path-guard', 'git rev-parse --show-toplevel (worktree cwd)', wtTopResult);
    if (wtTopResult.status !== 0 || !wtTopResult.stdout) {
      allow(undefined); // can't determine root — fail open
    }
    const wtTopRaw = wtTopResult.stdout.trim();

    // #2595 (review Major 3): read the field TYPED. `?.file_path || ''` let a
    // non-string through — `[]` and `{}` are truthy, so they survived the
    // `!rawFilePath` check and threw inside path.isAbsolute() below, landing in
    // this script's outer `catch { process.exit(0) }`. That is the same
    // crash-to-allow #2547 closes elsewhere, reached through the guard's own
    // read rather than through normalization, and it is NOT closed by making
    // `path` authoritative: normalization returns early for native Claude Code
    // payloads (KIMI_TOOL_NAMES has no 'Edit' entry), so `{"tool_name":"Edit",
    // "tool_input":{"file_path":[]}}` reached it untouched — this guard's
    // original #260 surface. Same shape as hooks/gsd-windsurf-pre-write.js:75.
    const rawFilePath = typeof data.tool_input?.file_path === 'string'
      ? data.tool_input.file_path
      : '';
    if (!rawFilePath) {
      allow(undefined);
    }

    // Relative paths resolve against the tool's CWD, which is inside the worktree
    // — so under the runtime this guard was written for they cannot leave it.
    //
    // #2595 (review Minor 5) — state the premise rather than leave it implicit,
    // because THIS PR is what widened the guard's reach to Kimi. "Always safe"
    // holds only while every runtime reaching here either rejects relative paths
    // or resolves them against the worktree CWD. Claude Code's Edit/Write require
    // an absolute file_path, so the original #260 surface satisfies it by
    // construction. kimi-cli's StrReplaceFile takes `path` with no documented
    // absoluteness guarantee, and its resolution behaviour is NOT verified here
    // (no source available to this repo at 4a550ef beyond the schema). If it
    // resolves relative paths against anything other than the tool CWD, a
    // `../`-laden path exits 0 at this line and escapes the worktree. Stating a
    // mechanism and an unverified premise — not asserting a live bypass.
    if (!path.isAbsolute(rawFilePath)) {
      allow(undefined);
    }

    // Normalise .. traversal so /worktree/src/../../../main/file
    // resolves to its true location before we check containment.
    const filePath = path.resolve(rawFilePath);

    // Find the nearest existing ancestor of filePath so we can ask git
    // for its toplevel. The file itself may not exist yet (Write creates
    // new files), but at least one ancestor directory must exist.
    // We check the file itself first in case it already exists.
    const checkDir = nearestExistingDir(
      (() => {
        try {
          return fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
        } catch {
          return path.dirname(filePath);
        }
      })()
    );

    if (!checkDir) {
      // Walked to root without finding any directory — path is synthetic.
      // A path with no existing ancestor is not the #260 main-repo vector;
      // #260 is caught by the different-git-root branch below. Fail open. (#1342)
      allow(undefined);
    }

    // Ask git for the toplevel of the file's location.
    // Comparing two raw git --show-toplevel outputs avoids every
    // platform-specific path normalisation pitfall (Windows 8.3 short names,
    // case differences between realpathSync and path.resolve, forward- vs
    // back-slash inconsistencies) — both values come from the same git binary
    // in the same format by definition.
    const fileTopResult = git(['rev-parse', '--show-toplevel'], checkDir);
    reportIfUndetermined('gsd-worktree-path-guard', 'git rev-parse --show-toplevel (file location)', fileTopResult);

    if (fileTopResult.status !== 0 || !fileTopResult.stdout) {
      // The target's location is not a git work tree. Two sub-cases:
      //  - Inside a .git directory (e.g. /main-repo/.git/config or .git/hooks/*)
      //    → an absolute write into a repository's internals; still a #260-class
      //    escape (and dangerous) → BLOCK.
      //  - Truly outside all git repositories (e.g. ~/.claude/plans/) → not the
      //    main-repo vector → fail open. (#1342)
      const insideGitDir = git(['rev-parse', '--is-inside-git-dir'], checkDir);
      reportIfUndetermined('gsd-worktree-path-guard', 'git rev-parse --is-inside-git-dir', insideGitDir);
      if (insideGitDir.status === 0 && insideGitDir.stdout && insideGitDir.stdout.trim() === 'true') {
        const output = {
          decision: 'block',
          reason:
            `Worktree path guard: '${filePath}' is inside a git internal (.git) directory, ` +
            `not the active worktree at '${wtTopRaw}'. Writing to repository internals via an ` +
            `absolute path is not permitted from an isolated executor worktree. Use a relative path.`,
        };
        deny(output, output.reason);
      }
      // Outside all git repositories — fail open (#1342).
      allow(undefined);
    }

    const fileTopRaw = fileTopResult.stdout.trim();

    // Same git toplevel → file is inside the worktree → allow
    if (fileTopRaw === wtTopRaw) {
      allow(undefined);
    }

    // BLOCK: file resolves to a different git root than the active worktree
    const output = {
      decision: 'block',
      reason:
        `Worktree path guard: '${filePath}' resolves to git root '${fileTopRaw}' which ` +
        `differs from the active worktree root '${wtTopRaw}'. This likely means an ` +
        `absolute path was derived from the orchestrator's main repository instead of ` +
        `the active worktree. To fix: use a relative path, or re-derive the base ` +
        `directory with \`git rev-parse --show-toplevel\` from within the worktree ` +
        `(hook cwd: '${cwd}').`,
    };

    deny(output, output.reason);
  } catch {
    // Silent fail — never block valid tool calls due to hook errors.
    // ON_CRASH is declared ALLOW at module top: this preserves today's
    // exit(0) fail-open behavior exactly (#3911).
    crash(ON_CRASH, undefined);
  }
});
