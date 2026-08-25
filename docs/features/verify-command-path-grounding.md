---
id: 161
title: Verify-Command Path Grounding
group: v1.7.0 Features
---

**Command:** `/gsd-plan-phase` (automatic), `gsd-tools check verify-command-paths <N>` (#2401)

**Behavior:** A planner authoring a per-task `<automated>` verify command has no line of sight to whether the path it just wrote actually resolves, and `gsd-plan-checker` had no deterministic way to check — so it hand-reasoned the filesystem and, in the motivating case, prescribed two successively-wrong replacement paths (the second citing a `package.json` that did not exist). Two changes close that:

1. **Prior-command inheritance.** The nearest prior phase's `<automated>` commands are surfaced to the planner as `prior_verify_commands`, **at every context window**. Cross-phase enrichment was previously gated on `context_window >= 500000`; at 200k the planner re-invented the command and got it wrong. This payload is a handful of one-liners, so it is never gated.
2. **A deterministic probe.** `gsd-tools check verify-command-paths <N>` resolves each `<automated>` command's target directory and reports whether it exists and holds the manifest the command needs. `/gsd-plan-phase` runs it before the plan-check pass and hands the JSON to the checker, which acts on `severity` instead of guessing.

**It never executes command text.** PLAN.md is model-authored, so running it from the checker would be arbitrary code execution — and would trigger the real lint/build as a side effect. The probe only resolves paths and stats directories; a `package.json` it finds is read for script names only.

**Why a recognizer, not a shell parser.** Interpreting shell would mean maintaining a bad shell. Exactly two forms are grounded — a leading `cd <literal>` chain and `npm --prefix <literal>` — and any path carrying a variable, glob, substitution, or `~` returns `unresolvable`, which is a warning and never a blocker. The parser's incompleteness is the specification: it degrades to "cannot prove" rather than growing features. Refusing to guess is the fix, not a limitation of it.

**It reports, it never prescribes.** The payload carries the target that failed and what was missing; there is deliberately no `suggestion` field. Choosing the replacement is the planner's job — and the planner now has the prior phase's proven command to reach for.

**Not findings:** a target an earlier task in this phase creates (`pending_creation`), a command with no `cd`/`--prefix` at all, and the Nyquist `MISSING — Wave 0 …` sentinel, which Dimension 8 owns.

**Known limits:**
- Only `cd <literal>` and `npm --prefix <literal>` are recognized. `pushd`, `make -C`, `yarn --cwd`, `pnpm -C`, and `cargo --manifest-path` report `unresolvable`.
- Verdicts are relative to the *checker's* project root. Under parallel worktree execution the executor's root differs, so a bare ancestor climb (`cd ../..`) is reported `outside_root` as a warning rather than asserted about.
- `script_missing` is advisory only — this phase may be adding the script — so a genuinely mistyped npm script still reaches the executor.

See [Resolve verify-command path findings](how-to/resolve-verify-command-path-findings.md) and [`gsd-tools check verify-command-paths`](COMMANDS.md#gsd-tools-check-verify-command-paths).
