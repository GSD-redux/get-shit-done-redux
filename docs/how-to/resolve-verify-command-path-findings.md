# Resolve verify-command path findings

`/gsd-plan-phase` runs a deterministic probe over every `<automated>` verify command in a
phase's plans before the plan-check pass. When a command's target directory does not resolve,
the plan checker reports it and planning does not pass. This page is what to do with that
report.

The probe answers one narrow question — *can this command's target directory be grounded from
the executor's cwd?* — and it answers it without ever running the command.

## When you will see this

`/gsd-plan-phase N` returns `## ISSUES FOUND` with a blocker like:

```
Verify Command Path Resolvability — BLOCKER
  Plan 02-PLAN.md, task "lint and build the frontend"
  Command: cd ../../frontend && npm run lint && npm run build
  rawTarget: ../../frontend
  target:    /Users/you/code/frontend
  reason:    missing_dir
```

## Fix it in three steps

### 1. Read the prior phase's proven command first

The planner is handed `prior_verify_commands` — the `<automated>` commands from the nearest
prior phase that had any — at **every** context window. If a previous phase already lints or
builds the same tree, that command resolved in a real run. Reuse it verbatim.

```bash
gsd-tools query init.plan-phase N --pick prior_verify_commands
```

If that returns commands, the fix is usually a copy-paste, not a new path.

### 2. Ground the path yourself if there is nothing to inherit

Check the target the probe reported:

```bash
ls -d <target>
ls <target>/package.json
```

Two forms are recognized. Prefer the second:

| Form | When it breaks |
|---|---|
| `cd <dir> && npm run <script>` | Depends on the executor's cwd; a relative climb resolves differently inside a worktree |
| `npm --prefix <dir> run <script>` | Independent of cwd — **prefer this** |

Rewrite the plan's `<automated>` block, then re-run `/gsd-plan-phase N`.

### 3. Re-run the probe by hand to confirm

```bash
gsd-tools check verify-command-paths N --raw
```

Every row should be `severity: none`, or carry a warning you have consciously accepted.

## Reading the report

Act on `severity`, not on `status` — a row can be `status: ok` and still carry an advisory.

| `reason` | `severity` | What to do |
|---|---|---|
| `missing_dir` | blocker | The directory is not there. Fix the path, or have an earlier task create it. |
| `no_manifest` | blocker | The directory exists but has no `package.json` / `Makefile`. You are almost certainly one level off — this is the #2401 case. |
| `script_missing` | warning | The manifest has no such script. Fine if this phase adds it; otherwise a typo. |
| `dynamic_path` | warning | The path uses a variable, glob, substitution, or `~`. The probe refuses to guess. Replace it with a literal if you can. |
| `outside_root` | warning | A bare ancestor climb (`cd ../..`). Under parallel worktree execution the base differs, so this cannot be checked. Anchor it instead. |
| `manifest_unreadable` | warning | `package.json` is unparseable, not a JSON object, or over 512 KB. Fix the manifest. |

## When the report says nothing

**An empty report is not automatically a clean bill of health.** Tell the two apart:

| What you see | What it means |
|---|---|
| `commands: []`, `readError: null` | The phase's plans contain no `<automated>` blocks to probe. |
| `commands: [...]`, every `severity: none` | Every command's target resolved. This is the clean case. |
| `readError` is a non-empty string | The probe **could not look** — the phase directory or a plan file was unreadable. Not a pass. |
| `status: not_applicable` rows | Those commands have no `cd` or `--prefix` to resolve; they run at the project root. |
| `status: pending_creation` rows | An earlier task in this phase creates that directory. Correct and expected on a greenfield phase. |

## What the probe deliberately will not do

- **It will not run your command.** PLAN.md is model-authored text; executing it from the
  checker would be arbitrary code execution, and would trigger the real lint/build as a side
  effect.
- **It will not suggest a replacement path.** Prescribing one is exactly the failure that
  motivated this check — the checker previously guessed twice and was wrong both times, the
  second time citing a `package.json` that did not exist.
- **It does not recognize every launcher.** `pushd`, `make -C`, `yarn --cwd`, `pnpm -C`, and
  `cargo --manifest-path` report `unresolvable` rather than being half-parsed. Refusing to
  guess is the design.

## Related

- [Verify Command Path Resolvability](../COMMANDS.md#gsd-tools-check-verify-command-paths) — the command reference
- [Resolve edge-coverage findings](resolve-edge-coverage-findings.md)
- [Resolve prohibition findings](resolve-prohibition-findings.md)
