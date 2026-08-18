# How to resolve unreachable-guard findings

`npm run lint:ci` failed with `unreachable-guard-drift`. That guard finds shell
in shipped prompt files where a fallback arm **cannot run** — the command it
guards succeeds even in the case the fallback was written for, so the guard is
output-identical to the success path and silently does nothing.

This page covers reading the finding, fixing each shape, and the one case where
acknowledging is the right answer. For *why* the invariant exists, see
[ADR-3409](../adr/3409-unreachable-shell-guard-arms.md).

## Read a finding

```
unreachable-guard-drift: NEW unreachable shell-guard shape(s) found in the prompt layer.
  gsd-core/workflows/ship.md:312  --pick  STATUS=$(gsd_run query verification.status "$D" --pick status 2>/dev/null || echo "")
```

Each line is `file:line`, the token that matched, and the offending source line.
For a machine-readable form — useful in CI or when scripting a migration — run
the guard with `--json`:

```bash
node scripts/lint-unreachable-guard-drift.cjs --json
```

That emits one object carrying `reason`, `violations`, `malformed`, `stale`,
`baselineErrors`, and `knownCount`. The `reason` is a frozen enum code, so
assert on it rather than on the human text.

### Reason codes

Tell "nothing to report" apart from "could not look" — they are different
outcomes and only one of them is good news.

| `reason` | Exit | Meaning |
|---|---|---|
| `ok_no_violations` | 0 | Clean. Every scanned file passed. |
| `ok_baseline_updated` | 0 | You ran `--update`; the baseline was rewritten. |
| `fail_fresh_violation` | 1 | A new instance of one of the two shapes. **Fix it** — see below. |
| `fail_stale_entry` | 1 | A baseline entry matched fewer occurrences than it acknowledges. Either a site was migrated (good — re-record) or only *some* copies were (finish the job). |
| `fail_malformed_marker` | 1 | A `# gsd-scan-ignore:` whose reason names no issue or URL. Not a violation — a broken exemption. |
| `fail_baseline_load` | 1 | The baseline file is missing, empty, not JSON, or structurally wrong. The guard **could not look**; this is not a clean run. |

## Shape A — `--pick` with an `|| echo` fallback

```bash
# BROKEN — the fallback can never fire
AUTO_MODE=$(gsd_run query check auto-mode --pick active 2>/dev/null || echo "false")
```

`--pick` renders a missing or absent field as the **empty string and exits 0**.
`gsd_run` passes that exit code straight through, so `||` only ever fires on a
typo in the verb name — never on the field absence you wrote it for.

Test it yourself before assuming a field exists:

```bash
node gsd-core/bin/gsd-tools.cjs query phases.list --pick a_field_that_does_not_exist; echo "exit=$?"
```

That prints nothing and exits `0`.

**Fix — test the value, not the exit code:**

```bash
AUTO_MODE=$(gsd_run query check auto-mode --pick active 2>/dev/null)
AUTO_MODE="${AUTO_MODE:-false}"
```

`${VAR:-default}` is exactly the empty-or-unset test, and unlike
`[ -z "$VAR" ] && VAR=default` it cannot abort a `set -e` shell when the value
is non-empty.

**When the safe direction is "do nothing", compare against the literal instead**
and add no default at all:

```bash
PRIOR_SUMMARIES=$(gsd_run query phases.list --type summaries --pick count 2>/dev/null)
if [ "$PRIOR_SUMMARIES" = "0" ]; then WALKING_SKELETON=true; fi
```

Here a `:-0` default would be a bug: it turns "the query could not answer" into
"there are zero summaries" and fires the gate unconditionally. Only a literal
`0` should act; anything else correctly does nothing.

**If the field does not exist at all, repoint the query — do not paper over it.**
The Walking Skeleton gate read `--pick summaries_total`, a field `phases.list`
has never produced under any flag combination, so the gate had never fired on
any project. The fix was to ask the owner that *does* answer it
(`--type summaries --pick count`), not to default the empty away.

## Shape B — a glob whose command succeeds on zero matches

Under `shopt -s nullglob` an unmatched glob expands to **zero operands**, so the
command still succeeds:

```bash
cat .planning/phases/*-*/*-SUMMARY.md          # zero operands -> cat reads STDIN and BLOCKS
ls -d .planning/phases/999* || echo "none"     # zero operands -> ls lists the CWD, exits 0, message never prints
```

The `cat` form is the worse one: it hangs rather than failing.

**Fix — collect into an array and test for existence:**

```bash
_SUMMARIES=( .planning/phases/*-*/*-SUMMARY.md )
if [ -e "${_SUMMARIES[0]}" ]; then cat "${_SUMMARIES[@]}"; fi
```

### Use `-e`, not a count — the lint cannot catch this for you

This is the one thing on this page you must get right unaided, because **both
forms pass the lint** (each removes the glob from the command):

```bash
if [ ${#_SUMMARIES[@]} -gt 0 ]; then   # correct ONLY if nullglob is set
if [ -e "${_SUMMARIES[0]}" ]; then     # correct either way
```

Without `nullglob`, an unmatched glob leaves the **literal pattern** as a single
element, so the count is `1` and the count guard passes wrongly. Measured:

| | `${#_A[@]} -gt 0` | `-e "${_A[0]}"` |
|---|---|---|
| no `nullglob`, no match | **passes (wrong)** | skips |
| `nullglob` set, no match | skips | skips |

`nullglob` is frequently set in a *different fenced block* of the same file, so
you cannot tell from the line you are editing. Use `-e` and stop having to know.

`gsd-core/workflows/review.md` keeps count guards because that block sets
`nullglob` two lines above them — correct in context, not a template to copy.

### What does not fire

Deliberately, so the guard stays worth reading:

- `ls foo/*.md 2>/dev/null | head -1` and `X=$(ls -d …)` — **stdout** is
  consumed, not the exit code. Not a guard.
- `ls foo/*.md 2>/dev/null || true` — suppressing a failure; there is no
  fallback value to defeat.
- `gsd_run query config-get <key> … || echo "default"` — `config-get` genuinely
  exits `1` on a missing key, so its `||` works. Verify with
  `node gsd-core/bin/gsd-tools.cjs query config-get no.such.key; echo $?`.
- `for f in dir/*.md; do` — the construct `nullglob` exists to make correct.

## Acknowledge a finding you cannot fix yet

Only when the fix belongs to another tracked issue. Run:

```bash
node scripts/lint-unreachable-guard-drift.cjs --update
```

This rewrites `scripts/baselines/unreachable-guard-drift-baseline.json`, keyed
on `(file, trimmed text)` with a per-pair `count` — never line numbers, so
unrelated edits do not disturb it. The baseline is **shrink-only**: a stale
entry fails as loudly as a new one, so it cannot quietly become a parking lot.

The guard ships with a **zero-entry** baseline. Growing it is a real decision,
not a way to make the build green — if you find yourself running `--update`
because the finding is inconvenient, you are turning a gate back into a
suggestion. Fix the site instead.

## Exempt a deliberate counter-example

Documentation that *shows* the anti-pattern is byte-identical to a regression,
so it must declare itself, on the offending line:

```bash
cat .planning/phases/*/*-SUMMARY.md   # gsd-scan-ignore: #3409 counter-example for the docs
```

The reason must name an issue (`#123`) or an `http(s)://` URL. A free-text,
empty, or whitespace-only reason reports `fail_malformed_marker` — a distinct
error, so you are told which of the two problems you have. `#0` and a bare
`http://` are rejected: an exemption with no real ledger never gets revisited.

There is no file allowlist and there will not be one — an allowlist points at
the file most likely to grow the next copy.

## Related

- [ADR-3409](../adr/3409-unreachable-shell-guard-arms.md) — the invariant, the measurements behind both detectors, and the alternatives rejected
- [ADR-3180](../adr/3180-planning-semantic-model-single-owner.md) — the ratchet and whole-repo-discovery mechanism this guard reuses
- [Resolve edge-coverage findings](resolve-edge-coverage-findings.md) · [Resolve prohibition findings](resolve-prohibition-findings.md) — sibling "the loop surfaced something, here is what to do with it" pages
