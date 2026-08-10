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
radius that drove it. It applies to **60 call sites across nine modules** — `state`, `verify`,
`workstream`, `frontmatter`, `commands`, `template`, `phase`, `roadmap`, and `gsd2-import`.
(Issues #2966 and #2980 record this as "42 sites"; that figure counts only the sites where `error`
happens to be the object's first key. See ADR-2980 for why the real number is 60.)

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
   returns `{"error":"Cannot parse Current Plan or Total Plans in Phase from STATE.md"}`, also exit
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
