# Declare a hook's crash policy

A GSD enforcement hook (`hooks/*.js`, `hooks/*.sh`) ends every run by terminating
the process — but "terminate" is not one decision, it is at least three: pass
the tool call, block it, or explain what happens when the hook's *own* code
breaks. Before ADR-3889 Phase 7 (#3911), each hook answered the third question
with a bare `process.exit(0)` or `process.exit(2)` buried in an outer `catch`,
so a reviewer had to read every hook's catch block to know its fail-open/
fail-closed stance. `hooks/lib/hook-exit.js` names all three outcomes and makes
the third one a declaration you write once, near the top of the file.

This page covers terminating a hook correctly, declaring and justifying
`ON_CRASH`, the one case that needs a distinct stderr payload, the two hooks
that must NOT use this vocabulary at all, and what to do when a check inside
your hook cannot run rather than merely returning a negative.

## The three outcomes

```js
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');
```

- **`allow(payload)`** — exit 0. The tool call proceeds. `payload` is optional;
  most no-op paths call `allow(undefined)`.
- **`deny(payload, stderrPayload?)`** — exit 2, the Claude Code hook-protocol
  block code. `payload` is written to stdout; by default the same bytes go to
  stderr too. See "A deny needing a distinct stderr payload" below for when
  you pass `stderrPayload`.
- **`crash(onCrash, payload)`** — dispatches to `allow`/`deny` per a policy
  YOU supply. There is no default: call `crash(ON_CRASH, payload)` from your
  outer catch, never a bare `crash(payload)`.

A real guard shape:

```js
const ON_CRASH = HOOK_ON_CRASH.ALLOW; // declared once, near the top — see below

try {
  const data = JSON.parse(input);
  if (looksFine(data)) allow(undefined);
  emitBlock({ decision: 'block', reason: 'why this call is refused' });
} catch {
  // Hook errors must never block a legitimate tool call.
  crash(ON_CRASH, undefined);
}

function emitBlock(output) {
  deny(output, output.reason);
}
```

## Choosing and declaring `ON_CRASH`

`HOOK_ON_CRASH` has exactly two values, `ALLOW` and `DENY`. Ask: **if this
hook's own code throws, is it safer for the tool call to proceed, or safer to
block it?**

- **`ALLOW`** — the hook is advisory, or its enforcement is not the last line
  of defense. A crash here should not stop legitimate work. This is every
  migrated hook's policy today (19 of 19) — including the two hard-blocking
  guards (`gsd-write-guard.js`, `gsd-worktree-path-guard.js`): their threat
  model is a confused agent overwriting a file it can already reach by other
  means, not a determined adversary, so a hook bug is not treated as worse
  than the thing it protects against.
- **`DENY`** — a crash inside a security-critical check is itself suspicious
  enough that refusing is the safer failure. Nothing in this repo declares
  `DENY` yet; if you are the first, that is a real decision, not a default —
  write the reason down (see below) and expect it to be scrutinized in
  review.

Declare it once, near your hook's imports, not inline at the call site:

```js
// This guard's outer catch has always exited 0 (fail open — a hook error
// must never block a legitimate tool call). Declared ONCE here so the outer
// catch's crash() call states its policy explicitly rather than inheriting
// a default (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;
```

**A useful reason names the failure mode, not the mechanism.** "Fails open"
restates what `ALLOW` already means. What the code cannot say is *why this
hook, specifically*: what breaks if it fires wrongly (a legitimate call
blocked) versus what breaks if it stays silent (a narrow threat model, a
check that runs again downstream, an advisory that was never load-bearing).
Write the trade-off, not the translation.

## A deny needing a distinct stderr payload

Most callers never pass `stderrPayload` — fd 2 gets the same bytes as fd 1,
unchanged from before this migration. One shape needs it: `gsd-write-guard.js`
guards a curated `.planning/` artifact, but Kimi's native hook bus reads
**stderr verbatim back to the model** on exit 2. A full JSON object on stderr
would show the model a data structure instead of a sentence, so this call
site sends the complete decision to stdout and only the plain-text reason to
stderr:

```js
function emitBlock(output) {
  deny(output, output.reason);
}
```

`stderrPayload` is forwarded to `terminateNow` verbatim: a **string** is
written raw (no `JSON.stringify`), anything else is JSON-stringified like the
stdout payload. Reach for this only when a specific downstream reader needs
plain text on stderr — most hooks have no such reader and should leave
`stderrPayload` unset.

## The exception: two hooks that must NOT call `deny()`

`allow()`/`deny()`/`crash()` assume the host reads the **exit code** as the
decision. Two shipped hooks have a different contract, where the decision
lives in the **JSON response body** and the process still exits 0:

- **`gsd-read-injection-scanner.js`** (PostToolUse) — Claude Code's
  PostToolUse protocol reads `{ decision: "block", ... }` from stdout, not
  from the exit code; the tool call already completed by the time this hook
  runs, so there is no exit-code channel to block it through. It calls
  `process.stdout.write(JSON.stringify(output))` directly for its verdict,
  and uses `allow()`/`crash()` only for its true no-op and crash paths.
- **`gsd-cursor-subagent-start.js`** (Cursor `subagentStart`) — Cursor's own
  hook protocol reads `{ permission: "deny", user_message, ... }` from the
  JSON body at exit 0; `"ask"` is not even a supported value, and there is no
  exit-2 convention here at all. Same split: `process.stdout.write(...)` for
  the decision, `allow()` only for its stdin-timeout no-op.

If you are writing a hook against a harness that reads its verdict from the
response body, follow one of these two, not `deny()` — calling `deny()` there
would exit 2 into a harness that is not listening on the exit code, turning a
block into an unexplained crash.

## When a check cannot run at all

`crash()` covers your hook's own bugs. It does not cover the more common
defect: a check inside a *working* hook that silently reads "could not run"
as if it were "ran, found nothing" — passing every case it should have
inspected. #3838 is the worked example: `gsd-validate-commit.sh` had three
swallow-and-pass sites (the opt-in config read, JSON command extraction, and
its `isGitSubcommand` classifier) where a failure and a genuine negative both
fell through to the same `exit 0`, silently disabling commit validation on
any of them. The fix distinguishes the two outcomes and says so on stderr
before falling through:

```sh
ENABLED=$(node -e "..." 2>"$ENABLED_ERR") || CONFIG_STATUS=$?
CONFIG_STATUS=${CONFIG_STATUS:-0}
if [ "$CONFIG_STATUS" != "0" ]; then
  # Could not determine the opt-in flag at all — distinct from
  # ".planning/config.json exists and legitimately disables the hook".
  echo "gsd-validate-commit.sh: could not read .planning/config.json (opt-in check) — validator disabled for this call. $(cat "$ENABLED_ERR")" >&2
  rm -f "$ENABLED_ERR"
  exit 0
fi
```

The exit code is unchanged (still 0, still a pass) — what changed is that the
"could not run" case is no longer indistinguishable from a real negative: it
is diagnosable on stderr instead of vanishing. Apply the same discipline
inside your own hook: a `try { ... } catch { /* silently pass */ }` around a
check is the shape to be suspicious of, whether or not it happens to route
through `hook-exit.js` at all.

## Related

- [ADR-3889](../adr/3889-process-exit-contract.md) — the exit-code registry
  `hook-exit.js` is layered over, and the rationale for banding codes 0/1/2
  the way it does
- [Hooks declare their crash policy](../features/hooks-declare-their-crash-policy.md) —
  the feature summary for this migration
- [Resolve unreachable-guard findings](resolve-unreachable-guard-findings.md) —
  a sibling "the loop surfaced something, here is what to do with it" page,
  for the shell-guard-drift class rather than the exit-code class
