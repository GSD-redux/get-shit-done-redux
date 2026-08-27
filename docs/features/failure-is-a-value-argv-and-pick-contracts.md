---
id: 3884
title: "Failure Is a Value" — Strict Argv Rejection and the `--pick` Absence Contract
group: v1.7.0 Features
---

**Purpose:** ADR-3473 §8.4 states the rule directly: absence, emptiness, and
failure are three different things, and a routine that cannot tell them
apart eventually reports the wrong one. Before this change, `gsd-tools` had
two silent instances of exactly that collapse.

**Half one — a stray positional corrupted state, silently (#3358).**
`parseNamedArgs` read only the flags it recognized and dropped everything
else — an unrecognized `--flag` or an extra positional argument (for
example, a stray phase number appended after `state.planned-phase`) was
silently discarded rather than rejected. The caller's own positional read
(`args[2]`, etc.) still worked, so the command ran anyway, on the wrong
phase, and overwrote the previously-current phase block with no error at
all. The fix makes `parseNamedArgs(args, spec)` return the command-routing
hub's own `Result` shape (`{ok:true,data} | {ok:false,kind:'InvalidArgs',...}`)
and requires every call site to declare `positionals: number | 'rest'` — the
count of leading argv slots the caller itself reads directly. An unknown
flag or an unexpected positional past that boundary is now a loud,
non-zero-exit `InvalidArgs` failure instead of a token quietly falling on
the floor. A duplicate flag, a negative-number value (`--plans -1`), and a
documented free-text tail (`init quick <description>`) are deliberately
left alone — none of them are the defect this closes, and forbidding them
would just break working call sites for no gain.

**Half two — `--pick` on an absent field answered `''` at exit 0, exactly
like a present-but-empty one (#3365).** `--pick <field>` extracted one field
from a command's JSON output, but a missing key, an out-of-range array
index, a partially-missing dotted path, or non-JSON output (including a
`--raw` command's output) all rendered the same way: empty stdout, exit
`0`. That is indistinguishable from a field that genuinely holds `null` or
`''` — a real answer. The shell idiom `X=$(… --pick F) || X=default` could
therefore never observe the failure it was written to react to; only a typo
in the verb name would ever make it exit non-zero. `--pick` now exits `1`
with a diagnostic on stderr (`pick_field_absent` naming the field and the
available top-level keys, or `pick_output_not_json` when the output could
not be parsed as JSON at all) whenever the field cannot be resolved. A
present field's value — including `0`, `false`, `null`, and `''` — is
unchanged: those are answers, not failures, and remain exit `0`. See
[CLI-TOOLS.md's `--pick <field>` contract](CLI-TOOLS.md#--pick-field-contract)
for the full outcome table and [json-errors.md](json-errors.md) for the two
new reason codes.

**Why not just default to zero for an absent count.** The sub-issue's own
Done-when checkbox suggested treating an absent field the same as a
zero-valued one. That is rejected on the merits: it demotes *"I could not
answer"* to *"the answer is zero"*, which would make a count-gated shell
guard fire unconditionally on the very projects that could never resolve
the count in the first place — the opposite of what a gate is for.

**Consequence for `scripts/lint-unreachable-guard-drift.cjs`.** That guard's
Detector A existed specifically because the old `--pick` behavior made a
`--pick … || echo <default>` line's fallback arm permanently unreachable.
Once `--pick` exits non-zero on absence, that premise is false and the
shape the detector forbade becomes the *correct* idiom — so Detector A was
retired rather than kept. Detector B (the unrelated `cat`/`ls`-over-a-glob
nullglob hazard) is untouched. See
[Resolve unreachable-guard findings, Shape A](how-to/resolve-unreachable-guard-findings.md#shape-a---pick-with-an--echo-fallback-resolved-upstream-3884).

**Known limits:**
- A value token beginning with `--` still cannot be passed to a declared
  value flag (`--summary "--force is now default"` now fails loudly instead
  of silently dropping the value) — strictly better, but no `--flag=value`
  escape was added.
- `--pick` still cannot distinguish an absent field from a `null` one *on
  stdout alone* — the distinction is carried entirely by exit code.
- The ~10 `gsd-tools.cjs` call sites of `parseNamedArgs` get no
  compile-time check (that file is hand-written JavaScript, not `.cts`);
  enforcement there is the runtime throw on a stale legacy call shape plus
  behavioral tests.
- This phase does not sweep every routine in `gsd-core` for `Result`
  conformance — it applies the rule to the argument-projection seam and the
  `--pick` extractor it names, not the whole codebase.
