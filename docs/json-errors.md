# JSON Error Mode — `gsd-tools` Structured Errors

## Overview

`gsd-tools` supports a **JSON error mode** that emits most errors as structured
JSON objects on stderr instead of free-form text.  This is the recommended
surface for tests and tooling that need to assert on error types without
grepping raw text (see `CONTRIBUTING.md` — "Prohibited: Raw Text Matching on
Test Outputs"). Usage errors are an intentional exception — see the
`ExitError` carve-out below.

> **This page describes one of two failure channels.** A second, equally
> intentional one reports conditions in the **result payload on stdout with
> exit 0**. A caller that branches on exit status alone will not see it. Read
> [Degraded results vs faults](#degraded-results-vs-faults--read-this-before-writing-a-caller)
> before writing anything that consumes `gsd-tools` output.

## Activating

Either flag or env var activates the mode:

```bash
# Flag (preferred in test code):
node gsd-tools.cjs --json-errors <command> [args]

# Env var (preferred for shell wrappers and CI):
GSD_JSON_ERRORS=1 node gsd-tools.cjs <command> [args]
```

## Wire format

On any error, exactly one JSON line is written to **stderr** and the process
exits with code 1:

```json
{ "ok": false, "reason": "<error_code>", "message": "<human text>" }
```

Fields:

| Field     | Type    | Description |
|-----------|---------|-------------|
| `ok`      | `false` | Always `false` for error objects. |
| `reason`  | string  | Typed reason code from the taxonomy below. |
| `message` | string  | Human-readable description (may change; do not assert on it). |

### `ExitError` carve-out (plain text, not JSON)

Usage errors and explicit exit-code signals take a **different path**: they
throw `ExitError` (`src/cli-exit.cts`), which `runMain` catches *before* the
JSON-envelope branch. An `ExitError` writes its `message` as **plain text**
to stderr (not a JSON object) and exits with the error's own `code` (which
may differ from 1). This is intentional — usage messages are operator-facing
prose, not structured failures.

If you are testing a usage/flag error, do **not** parse stderr as JSON;
assert on the exit code and (if needed) the plain-text message. The
"parse stderr as JSON" guidance below applies only to the structured-envelope
branch (non-`ExitError` failures).

> **Which tools honor this.** Both surfaces that run `runMain` do: the compiled
> `gsd-core/bin/lib/cli-exit.cjs` and the `scripts/lib/cli-exit.cjs` that the
> repo's own `scripts/**` tooling requires. Before [#3904](https://github.com/open-gsd/gsd-core/issues/3904)
> the latter was a separate hand-written copy that never gained the
> structured-envelope branch, so a `scripts/`-side tool failing unexpectedly
> printed a raw stack trace even under `--json-errors`. It is now generated from
> the same source and byte-compared by `npm run lint:generated-sync`, so the two
> cannot answer differently again.

## Degraded results vs faults — read this before writing a caller

`gsd-tools` has **two** ways of telling you something went wrong, and they use **different exit
codes**. The wire format above describes only one of them. If you write a caller that branches on
exit status alone, you will silently miss the other.

| | **Fault** | **Degraded result** |
|---|---|---|
| Produced by | `error(message, reason)` | `output({ error: … })` |
| Stream | **stderr** | **stdout** |
| Exit code | **1** | **0** |
| Shape | `{ "ok": false, "reason": …, "message": … }` | the command's ordinary result object, with an added `error` key |
| Honors `--json-errors` | **yes** | **no** — it is a payload, not an error envelope |
| How a caller detects it | exit code | **inspect the payload** |

A **degraded result** means: *the command ran to completion and is reporting a condition through its
result.* It is not a process failure. The command succeeded at the job of determining that, for
example, the artifact you asked about is absent.

```console
$ gsd-tools state-snapshot          # in a project with no STATE.md
{
  "error": "STATE.md not found"
}
$ echo $?
0
```

Some verbs return a companion result alongside the key, which is the shape that makes the intent
clearest:

```console
$ gsd-tools roadmap get-phase --phase 1      # no ROADMAP.md
{
  "found": false,
  "error": "ROADMAP.md not found"
}
$ echo $?
0
```

This is a **ratified contract**, not an accident — see
[ADR-2980](adr/2980-payload-carried-error-is-a-degraded-result.md) for the decision and the blast
radius that drove it. It applies to **64 call sites across nine modules** — `state`, `verify`,
`workstream`, `frontmatter`, `commands`, `template`, `phase`, `roadmap`, and `gsd2-import`.
(Issues #2966 and #2980 record this as "42 sites"; that figure counts only the sites where `error`
happens to be the object's first key. ADR-2980 itself re-derived the population as "60" by
brace-matching; a further AST re-measure for [#3912](https://github.com/open-gsd/gsd-core/issues/3912)
found the true current count is 64 — the same nine modules, with `frontmatter`, `phase`, and
`roadmap` each having grown since. See ADR-2980's amendment for the breakdown.)

### Writing a correct caller

The obvious shell form is **wrong** for a degraded result:

```sh
# WRONG — the process exits 0, so this branch never runs
if ! gsd-tools state-snapshot > snap.json; then
  echo "failed"
fi
```

Check both channels — the exit code for faults, the payload for degraded results:

```sh
if ! out=$(gsd-tools state-snapshot); then
  echo "fault (exit non-zero)" >&2      # error() path
  exit 1
fi
if err=$(printf '%s' "$out" | jq -er '.error // empty'); then
  echo "degraded: $err" >&2             # output({error}) path
fi
```

### Four things that will surprise you

1. **`--json-errors` does nothing here.** It governs `error()` only. A degraded result is
   byte-identical with and without the flag, and still exits 0.
2. **`--raw` is not uniform on this path.** Most sites pass no raw value, so `--raw` still yields
   the JSON object rather than bare text — but eleven sites do pass one and behave differently.
   Do not infer either behavior from `--raw` alone; check the verb.
3. **Not every degraded result is an absent artifact.** A missing required argument is reported the
   same way — `gsd-tools state add-blocker` with no `--text` returns `{"error":"text required"}` and
   exits 0. So is unusable input: `gsd-tools state advance-plan` against a STATE.md it cannot parse
   returns `{"error":"Cannot read the plan position from STATE.md. Expected one of: ..."}`, also exit
   0. **The exit code does not distinguish absent from malformed from misinvoked** — see ADR-2980's
   Consequences, where this is recorded as a known cost.
4. **`message`/`error` text is not stable.** Assert on structure and on typed `reason` codes, never
   on prose. The rule in "Writing tests" below applies to both paths.

### Which one should new code use?

Prefer the **fault** path, or a result with a named field. ADR-2980 ratifies an existing population;
it is not a license to add a 61st `output({ error: … })` site. Where a verb needs to report a
non-fatal condition in its payload, prefer the shape `state update-progress` already uses — a named
field plus a reason, with no overloaded `error` key:

```console
$ gsd-tools state update-progress            # STATE.md present, no Progress field
{
  "updated": false,
  "reason": "Progress field not found in STATE.md"
}
```

## Outcome declaration and the versioned exit contract (ADR-3889 §4, #3912)

Both failure channels above now **declare an outcome** on every terminating path, per
[ADR-3889](adr/3889-process-exit-contract.md). Declaration is unconditional; whether it changes the
observed exit code depends on which **exit-contract version** the process is running under.

Turn on `v2` with either `--exit-contract=v2` or `GSD_EXIT_CONTRACT=v2` (a flag beats the env var if
both are given). Absent either, the process runs `v1` — today's default and, for every existing
caller, byte-identical to pre-#3912 behavior. See
[Adopt the v2 exit contract](how-to/adopt-the-v2-exit-contract.md) for a worked migration.

### `error(message, reason)`

`error()`'s `reason` argument now maps onto a declared outcome name (`USAGE`, `NO_INPUT`,
`UNAVAILABLE`, `INTERNAL`, or `FAIL`) via a fixed table over all 25 `ERROR_REASON` members.

- **Under `v1`, the mapping is recorded but never projected.** `error()` still throws
  `ExitError(1)` unconditionally, exactly as before — stderr and the exit code are byte-identical to
  every prior release.
- **Under `v2`, the mapping is projected through the exit-code registry.** `error()` throws
  `ExitError(exitCodeFor(<mapped outcome>))` instead of a hardcoded `1` — so, for example, a call
  with `ERROR_REASON.SDK_MISSING_ARG` or `ERROR_REASON.SDK_UNKNOWN_COMMAND` exits `64` (`USAGE`)
  under `v2`, and one with `ERROR_REASON.CONFIG_KEY_NOT_FOUND` exits `66` (`NO_INPUT`).
- **Most call sites are unaffected either way.** 226 of the 278 `error()` call sites in the repo
  pass no `reason` at all, defaulting to `ERROR_REASON.UNKNOWN`, which maps to the generic `FAIL`
  outcome (exit `1`) under both versions.

### `output({ error: … })` — a degraded result is also a declared outcome

The degraded-result idiom above now declares the outcome `DEGRADED` whenever `output()`'s payload
carries a **serializable** `error` value — any key order, and regardless of that value's own
truthiness (`0`/`null`/`''` all count). The one exclusion: `{ error: undefined }` does **not**
declare `DEGRADED`, because `JSON.stringify` (the exact serializer `output()` uses) drops an
object property whose value is `undefined` before it ever reaches the wire — a payload built that
way reaches the caller as `{}`, with nothing to be degraded about.

- **Under `v1`, `DEGRADED` projects to `0`** — deliberately: this is ADR-2980's compatibility
  boundary, pinned so all 64 ratified sites keep exiting `0` byte-for-byte.
- **Under `v2`, `DEGRADED` projects to `80`** — looked up from the exit-code registry, never
  hardcoded, so a future re-allocation of `DEGRADED`'s number cannot silently desync this doc from
  the shipped table.

### Precedence — what code a void-returning command actually exits with

A command's `main()` can end up producing a code from more than one source. The order, highest
precedence first, is:

1. **An explicit `main()` return** (a number or a registered outcome-name string) — always wins.
2. **A non-zero `process.exitCode` `main()` already set directly** before returning — wins over
   anything declared through `output()`. This is what keeps `state validate --strict` correct: it
   sets `process.exitCode = 1` itself on a missing `STATE.md`, and a `DEGRADED` declared earlier in
   the same call must not clobber that `1` back down to `DEGRADED`'s `v1` projection of `0`.
3. **The declared outcome pending from `output()`** — consulted only when neither of the above set
   anything.
4. Otherwise the process exits `0`.

**Projection may only ever set a code, never lower one.** A prior review pass concluded the pending
declaration was fail-closed by construction; it was not — without rule 2 above, `state validate
--strict` briefly exited `0` on a case that must exit `1`. If you add a new call path that sets
`process.exitCode` directly, check it still wins over a later `output({error})` in the same
invocation.

**The declaration does not accumulate across calls.** `output()`'s declaration follows
last-write-wins: a clean payload clears a prior `DEGRADED` declaration in the same invocation, and
`runMain` clears the cell on every exit regardless of which branch produced the final code, so a
later `runMain` call in the same process never inherits a stale declaration.

## Error code taxonomy

Codes are frozen constants in `gsd-core/bin/lib/core.cjs` under
`ERROR_REASON`.  Tests must assert on `reason` values (stable), not `message`
text (unstable).

### Dispatch errors (gsd-tools routing layer)

| Code | When emitted |
|------|-------------|
| `sdk_unknown_command` | Unknown top-level command (`gsd-tools bogus-cmd`) |
| `sdk_unknown_command` | Unknown dotted command (`gsd-tools foo.bar` where `foo` is not a known command) |
| `sdk_unknown_command` | Unknown subcommand within a domain (e.g. `gsd-tools intel bogus-sub`) |
| `sdk_missing_arg` | Required argument omitted by an SDK-level guard |
| `sdk_fail_fast` | SDK fail-fast policy triggered |

### Usage / flag errors

| Code | When emitted |
|------|-------------|
| `usage` | `--pick` flag used without a following value |
| `usage` | Version flag (`--version`, `-v`) which gsd-tools never accepts |
| `usage` | Top-level no-args invocation (usage text) |

### `--pick <field>` errors (ADR-3473 §8.4, #3884)

| Code | When emitted |
|------|-------------|
| `pick_field_absent` | `--pick <field>` names a field that does not exist in the command's JSON output (missing key, out-of-range index, a partially-missing dotted path, or a non-object JSON root) — see [CLI-TOOLS.md's `--pick` contract](CLI-TOOLS.md#--pick-field-contract) |
| `pick_output_not_json` | `--pick <field>` is combined with a command whose output is not JSON (including `--raw` output) |

### Config errors (`config-get`, `config-set`, `config-ensure-section`)

| Code | When emitted |
|------|-------------|
| `config_key_not_found` | `config-get` for a key that is absent from the config file |
| `config_no_file` | Config operation when `.planning/config.json` does not exist |
| `config_parse_failed` | Config file exists but is not valid JSON |
| `config_invalid_key` | `config-set` for a key outside the allowed whitelist |

### Phase / workflow errors

| Code | When emitted |
|------|-------------|
| `phase_not_found` | Phase directory lookup returns no match |
| `summary_no_planning` | Summary operation when no `.planning/` directory exists |

### Estimate errors

| Code | When emitted |
|------|-------------|
| `estimate_phases_unreadable` | `estimate-calibrate` when `.planning/phases/` exists but could not be read (EACCES/EIO) — refused rather than silently rebuilding calibration from a phantom empty sample set (#3882, ADR-3473 §8.5) |

### Graphify errors

| Code | When emitted |
|------|-------------|
| `graphify_no_graph` | Graphify query or diff when no graph has been built |
| `graphify_invalid_query` | Graphify query with a malformed query string |

### Hook / security errors

| Code | When emitted |
|------|-------------|
| `hooks_opt_out` | Hooks are disabled via opt-out config |
| `security_scan_failed` | Security scan produced a finding that blocks the operation |

### Fallback

| Code | When emitted |
|------|-------------|
| `unknown` | All other errors without a specific reason code assigned |

## Writing tests

For **non-usage** errors (the structured-envelope branch), parse stderr with
`JSON.parse` and assert on typed fields.  Never use `.includes()`, `.match()`,
or regex on the raw error string.

```js
// CORRECT: parse then assert on typed field
const result = runGsdTools(['--json-errors', 'bogus-command'], tmpDir);
assert.strictEqual(result.success, false);
const err = JSON.parse(result.error);
assert.strictEqual(err.ok, false);
assert.strictEqual(err.reason, 'sdk_unknown_command');

// WRONG: text matching (banned by lint-no-source-grep policy)
// assert.ok(result.error.includes('Unknown command'));
```

## Adding a new error code

1. Add the constant to `ERROR_REASON` in
   `gsd-core/bin/lib/core.cjs` (snake\_case, prefixed by subsystem).
2. Pass it as the second argument to `error()` at the call site.
3. Add a row to this document.
4. Add a test asserting the new `reason` code via `JSON.parse`.
