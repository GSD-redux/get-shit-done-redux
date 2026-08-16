# How to resolve an unreachable-workflow finding

**Goal:** Turn a shipped workflow that no loader references into either a wired workflow or a fully swept deletion — so the instruction layer stays a single source of truth, instead of accumulating files that install to every runtime and are never read.

**Prerequisites:** A failing `npm run lint:ci` (or a direct `node scripts/lint-command-contract.cjs`) reporting one or more unreachable workflows. The check runs automatically as part of `lint:ci` — you do not invoke it separately.

For what counts as a reference and why the check is shaped this way, see [ADR-0002](../adr/0002-command-contract-validation-module.md). This guide covers only how to *act* on a finding.

---

## Read a finding

```
ERROR lint-command-contract: 1 unreachable workflow file(s)

  gsd-core/workflows/scan.md
    ships to every runtime install tree, but no command, agent, or skill references it
```

The check walks the transitive closure from every `commands/**`, `agents/**`, and `skills/**` file, following three reference shapes:

| Shape | Example | When it is used |
|---|---|---|
| Eager include | `@~/.claude/gsd-core/workflows/x.md` | Inlined on every invocation. Reserve for workflows the command always needs. |
| Lazy path | `` `~/.claude/gsd-core/workflows/x.md` `` | Read on demand at the point of use. The default for flag-gated or conditional workflows. |
| Parent-relative | `execute-phase/steps/x.md` | A sub-file under an existing workflow directory. |

A finding means **none** of those reaches the file. There are exactly two correct resolutions.

---

## Wire it — the workflow is live and the reference is missing

**Choose this when a command, flag, or agent is documented as using the workflow.** The file is not dead; the reference is.

Add a reference in the loader that dispatches to it. Prefer a **lazy path** unless the workflow is needed on every invocation of that command:

```markdown
- If it is `--fast`: strip the flag, then read and execute
  `~/.claude/gsd-core/workflows/scan.md` (passing remaining args).
```

An eager `@`-include is inlined into context on *every* invocation of that command, including the paths that never use the workflow. The progressive-disclosure split ([#717](https://github.com/open-gsd/gsd-core/issues/717)) exists specifically to keep that cost off the common path, so reach for the lazy form first.

If the loader is a `commands/gsd/*.md` file, regenerate the skill surface afterward:

```bash
npm run gen:plugin-skills
```

**This was the right answer for `scan.md`** — `/gsd-map-codebase --fast` was a shipped, documented flag whose routing line named no resolvable path. Deleting the file would have removed the only implementation of a live feature ([#3561](https://github.com/open-gsd/gsd-core/issues/3561)).

---

## Delete it — the workflow is genuinely dead

**Choose this when nothing is supposed to reach it** — typically because its command was removed and the workflow was left behind.

Before deleting, confirm the fence is not load-bearing: check the file's own header for a claimed caller and verify that caller exists. The `discovery-phase` workflow's header claimed it was "called from plan-phase.md's mandatory_discovery step"; that step did not exist. `docs/INVENTORY.md` claimed it was an alternate `/gsd-new-project` entry; `new-project.md` never referenced it. **A claimed caller is not a caller.** (The `discovery-phase` workflow was deleted in #3560.)

Deletion is a five-step sweep, and skipping any step leaves the tree inconsistent:

```bash
git rm gsd-core/workflows/<name>.md
```

1. **Remove its `docs/INVENTORY.md` row — in all five locales.** `docs/INVENTORY.md` plus `docs/ja-JP/`, `docs/ko-KR/`, `docs/zh-CN/`, `docs/pt-BR/`. Check the explanatory note near the bottom of each file too; a workflow is sometimes named there as well as in the table.
2. **Regenerate the inventory manifest.** Build first — regenerating before `build:lib` silently drops modules:
   ```bash
   npm run build:lib && node scripts/gen-inventory-manifest.cjs --write
   ```
3. **Regenerate the golden install-tree fixtures.** All 19 runtimes list every shipped workflow:
   ```bash
   npm run gen:install-tree
   ```
4. **Sweep tests that name the file — allowlists *and* content assertions.** Two distinct traps live here, and #3560 hit both:
   - An **allowlist keyed on the bare basename** will not match a full-path search. `tests/planner-language-regression.test.cjs` carried a stale entry for the `discovery-phase` workflow that a path-based sweep missed.
   - A test that **asserts the file's existence or content** pins it. `tests/phase.test.cjs` required the `plan-milestone-gaps` workflow to exist and checked its `mkdir` patterns; deleting the file turned that into four red tests on the remote runner. Cut the coupling in the same change — but keep any sibling assertions that guard *other* files, since these blocks are often shared across several workflows.

   Note that `scripts/lint-removed-but-needed.cjs` will **not** catch either: it scans `.github/workflows/`, `gsd-core/`, `docs/`, and `package.json` — not `tests/`. Search `tests/` yourself.
5. **Add a `Removed` changeset fragment**, and remember that a `Removed` type requires a `docs/` change — which step 1 already satisfies.

Then confirm the tree is consistent:

```bash
npm run lint:ci
```

---

## What does *not* count as a reference

The check deliberately scans only `commands/`, `agents/`, `skills/`, and `gsd-core/**`. A mention anywhere else confers no reachability:

| Location | Counts? | Why |
|---|---|---|
| `docs/**` | **No** | Documentation is a claim about the system, not a loader. `scan.md` was documented in `docs/INVENTORY.md` while being entirely unreached. |
| `tests/fixtures/install-tree/*.json` | **No** | A shipping manifest proves the file *ships*, which is the problem being reported, not a refutation of it. |
| A changeset fragment | **No** | Historical record, not a load path. |

If you are tempted to satisfy the check by adding a mention somewhere convenient, that is the failure mode this scoping exists to prevent — the file stays dead and the gate goes green.

---

## When the check passes but something still feels wrong

The rule proves **structural** reachability: some loader names the file. It cannot prove the file is read on any executed path.

| You see | It means |
|---|---|
| `151 workflow files, 151 reachable, 0 unreachable` | Every shipped workflow is named by at least one loader. Not that every one is used. |
| A workflow reachable only from another unreachable workflow | Reported correctly — reachability is seeded only from loaders, so an unreachable file cannot confer reachability on anything else. |
| A pair of workflows that reference only each other | Both reported. A mutual-reference island satisfies nothing. |
| A workflow that references itself | Reported. A self-reference is not a loader. |
| A path named only inside a fenced code block | Counted as a reference. This is a deliberate over-count: the check fails builds, and a false positive on a correct tree is worse than a missed orphan, so ambiguous references resolve toward "reachable". |

A workflow that is named by a loader but never actually executed is **not** caught here. That is a semantic question this structural check does not answer.
