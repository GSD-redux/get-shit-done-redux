# Upstream GSD Issues

Defects in GSD core (`@opengsd/gsd-core`, installed at `~/.claude/gsd-core/`) found while
dogfooding DevFlow. **Not DevFlow defects** — DevFlow can only work around them. This ledger is
maintained in the personal GSD Core fork; DevFlow's `.planning/UPSTREAM-GSD-ISSUES.md` links here.
Each entry is written to be pasted into a GSD Core issue as-is.

Status legend: `READY` = written up, not yet filed · `FILED` = filed upstream, link recorded ·
`VALIDATED` = current behavior/source supports the report, but it is a compatibility or safety
enhancement rather than a confirmed defect · `CONFIRMED` = reproduced against current upstream ·
`DONE` = covered by an upstream fix or open fix PR, link recorded.

---

## 1. `ship.md` `track_shipping` pushes `[ci skip]`, wedging any PR with required status checks

**Status:** DONE — open upstream PR [#2818](https://github.com/open-gsd/gsd-core/pull/2818)
**Found:** 2026-07-28, DevFlow phase 25 ship (`denniyahh/devflow` PR #47)
**RECURRED:** 2026-07-31, DevFlow phase 28 ship (`denniyahh/devflow` PR #63) — identical
symptom, identical cause, ~3 days later. See "Recurrence record" below.
**Component:** `gsd-core/workflows/ship.md`, step `track_shipping`
**Severity:** high — makes `/gsd-ship` produce an unmergeable PR on any repo with required checks.
**Reproducibility: confirmed 2/2.** This is not an intermittent or environment-specific fault; it
fires every time `/gsd-ship` runs to completion against a repo with required checks.

### What happens

`track_shipping` commits the ship note and pushes it onto the PR branch:

```bash
gsd_run query commit "docs(${padded_phase}): ship phase ${PHASE_NUMBER} — PR #${PR_NUMBER} [ci skip]" --files .planning/STATE.md
git push origin ${CURRENT_BRANCH}
```

The `[ci skip]` trailer is deliberate — the workflow's own comment says it "suppresses the
redundant pipeline the push would otherwise trigger."

The problem is that this push makes the ship note the **PR head commit**. On a repository with
required status checks, the head commit then has zero checks, and none will ever arrive, because
CI was told to skip. GitHub reports:

```
mergeable:         MERGEABLE
mergeStateStatus:  BLOCKED
statusCheckRollup: []
```

The PR cannot merge. `/gsd-ship` reports success and hands back a wedged PR.

### Reproduction

1. A repo whose default branch requires one or more status checks (classic branch protection
   *or* a repository ruleset — see the detection note below).
2. Run `/gsd-ship <phase>` to completion.
3. `gh pr view <n> --json mergeStateStatus` → `BLOCKED`; `gh pr checks <n>` → "no checks reported".

Observed on `denniyahh/devflow` PR #47, ruleset `develop-merge-or-squash`, required contexts
`Test`, `Clippy`, `Format`, `Build + test in devcontainer`.

### Why the obvious recovery does not work

Closing and reopening the PR does **not** re-fire the checks, even though both workflows declare
`on: pull_request: branches: [main, develop]` and `reopened` is in the default event set. Verified:
after close+reopen, `gh run list` still showed every run pinned to the pre-ship-note SHA. The only
reliable recovery is a new head commit that does not carry the skip token.

### Suggested fixes (any one is sufficient)

1. **Order the ship note before PR creation.** Commit and push `STATE.md` in `push_branch`, before
   `create_pr`, so the ship note is never the head commit. Cleanest — no skip token needed at all.
2. **Drop the skip token when required checks exist.** Detect required checks (both mechanisms) and
   omit `[ci skip]` when any are present. The "redundant pipeline" it saves is cheaper than a
   wedged PR.
3. **Warn and self-heal.** Keep the token, then after pushing check
   `gh pr view --json mergeStateStatus`; if `BLOCKED` with an empty `statusCheckRollup`, push an
   empty commit without the token and say so.

### Required-check detection is itself a trap (worth documenting alongside the fix)

`gh api repos/OWNER/REPO/branches/BRANCH/protection` returns **no** `required_status_checks` field
when the requirement comes from a repository **ruleset** rather than classic branch protection.
Both must be queried:

```bash
gh api repos/OWNER/REPO/branches/BRANCH/protection      # classic
gh api repos/OWNER/REPO/rulesets                        # rulesets
gh api repos/OWNER/REPO/rulesets/<id>                   # ...then read rules[].type == "required_status_checks"
```

DevFlow's own `.github/workflows/devcontainer.yml` header documents this same trap after a
deleted workflow silently wedged every merge to `develop`.

### Related footgun found while recovering

`[ci skip]` is matched **anywhere in the commit message**, not only the subject. An empty commit
whose body *explained* the problem — and therefore quoted the token — suppressed CI again. If the
fix keeps any skip-token logic, a guard is worth adding:

```bash
git log -1 --format='%B' | grep -qE '\[(ci skip|skip ci)\]' && echo "refusing: message contains a CI skip token"
```

### Recurrence record — 2026-07-31, phase 28, PR #63

Second confirmed occurrence, three days after the first write-up. Same workflow step, same token,
same outcome. Evidence captured this time:

| Commit | Message | Check runs on that SHA |
|---|---|---|
| `0feb477` | `docs(28): mark phase 28 complete …` | **8** |
| `d62b8de` | `docs(28): ship phase 28 — PR #63 [ci skip]` | **0** |

`gh pr view 63` immediately after `/gsd-ship` reported `mergeable: MERGEABLE`,
`mergeStateStatus: BLOCKED`, `statusCheckRollup: []` — the wedged state described above,
reproduced exactly.

**Recovery used (a fourth option, cheaper than the three suggested above when the ship note is
already pushed):** amend the ship-note commit to drop the token and force-push with lease.

```bash
git commit --amend -m "docs(NN): ship phase N — PR #M"   # same content, token removed
git push --force-with-lease origin <feature-branch>
```

CI then ran on the new head (`3823ee8`) and `mergeStateStatus` went `BLOCKED` → `CLEAN`. Safe here
because the branch had a single author and was not yet reviewed; it would not be safe on a branch
others have pulled.

**What the recurrence tells us that the first occurrence did not:** writing the issue down did not
prevent it. The entry existed, was accurate, and was read by nobody at the moment `/gsd-ship` ran —
because nothing in the workflow consults it. Until this is filed and fixed upstream, the only
durable mitigation is a **local guard**, not a document (see "Preventing recurrence" at the end of
this file).

### Third occurrence — 2026-08-05, phase 33, PR #90

**Reproducibility is now confirmed 3/3.** Same step, same token, same wedge, five days after the
second. Found only because the operator noticed the GitHub PR page "looks inconclusive" — nothing
in the workflow surfaced it, exactly as the recurrence note above predicted.

The upstream fix is **proposed but not shipped**: PR
[#2818](https://github.com/open-gsd/gsd-core/pull/2818) (*"fix(#2783): address wedged PRs in ship
note protocol"*) is still `state: OPEN`, `mergedAt: null` as of this occurrence. The installed
runtime is `@opengsd/gsd-pi@1.12.0`, whose `workflows/ship.md:457` still carries the token
verbatim. So this keeps firing on every `/gsd-ship` until that PR lands **and** a release
containing it is installed — this entry's `Status: DONE` refers to the write-up and upstream
filing, not to the defect being fixed in the operator's runtime. Worth reading that way at a glance.

Evidence, captured as a controlled comparison on one branch — the SHAs differ only in whether the
message carries the token:

| Commit | Message | Check runs on that SHA |
|---|---|---|
| `f02d25c` | `chore: ignore the MemPalace capture staging directory` | **8** |
| `0ffccb8` | `docs(33): ship phase 33 — PR #90 [ci skip]` | **0** |
| `6640b91` | `chore(gsd): enable the TDD capability via workflow.tdd_mode` | **8** |

`gh pr checks 90` reported *"no checks reported on the 'feature/phase-33' branch"* while
`gh run list --branch feature/phase-33` simultaneously showed two `pull_request` runs at
`conclusion: success` — both pinned to `f02d25c`, the pre-ship-note SHA. That pair of outputs is
the signature to recognise: **the runs exist and passed, but not on the head the PR points at.**
Reading `gh run list` alone reads as healthy and is the trap; only a per-SHA
`gh api repos/OWNER/REPO/commits/<sha>/check-runs --jq .total_count` discriminates.

**Recovery used this time (a fifth option):** rather than amending, push an unrelated commit that
was already pending and carries no token — here the TDD-capability enablement. It becomes the new
head and re-fires CI. Cheaper than a force-push when a legitimate commit happens to be queued, and
it avoids rewriting already-pushed history on an open PR. The cost is that it widens the PR's scope
by one commit, so it is only appropriate when that commit genuinely belongs in the same PR or the
operator accepts the widening.

---

## Also observed this session — not yet written up

Same category (GSD core, found while dogfooding), recorded so the evidence is not lost. Each needs
its own write-up before filing.

### 2. `api-coverage.verify-pre` fires on negated prose

**Status:** DONE — open upstream PR [#2817](https://github.com/open-gsd/gsd-core/pull/2817)

`gsd-tools check api-coverage.verify-pre` blocked `/gsd-verify-work 25` reporting "external-API
integration detected without a coverage matrix". The triggering text was `25-01-PLAN.md:105`:

> "This phase integrates no external API, SDK or hosted service."

The compound verb+noun detector (`gsd-core/bin/lib/api-coverage.cjs`, `detectApiIntegration`) has
no negation handling, so a sentence explicitly denying API integration satisfies it. The gate is
`blocking: true, onError: halt`, so a false positive halts verification and the documented remedy
is to author a `COVERAGE.md` enumerating an API surface that does not exist.

### 3. `check predicate` implements no predicate kinds

**Status:** DONE — open upstream PR [#2816](https://github.com/open-gsd/gsd-core/pull/2816)

The capability registry declares the security ship gate as:

```json
{"kind": "artifact-frontmatter-equals", "artifact": "SECURITY.md", "field": "threats_open", "equals": 0}
```

Invoking it directly fails:

```
Error: gate predicate evaluation failed: Unknown predicate kind:
"artifact-frontmatter-equals". Known kinds: command-exit-zero
```

`command-exit-zero` appears to be a bare fallback string with no implementation behind it. The gate
still enforces correctly only because `ship.md` step 6 reads the frontmatter directly in-context
rather than going through `check predicate` — so the declared mechanism and the enforcing mechanism
are different code, and only one works. Fails closed (`onError: halt`), so not exploitable, but the
declaration is decorative.

### 4. `phase.complete` and `state.update` advance into backlog headings

**Status:** DONE — open upstream PR [#2815](https://github.com/open-gsd/gsd-core/pull/2815)

Both wrote `current_phase: 999.1 / BACKLOG` into `STATE.md` after phase 25 completed, treating a
`999.x` backlog heading as the next sequential phase. Corrected twice manually in one session.
DevFlow's own `STATE.md` history log records the identical bug being caught after phase 20, so this
is a recurrence, not a one-off. Backlog items are supposed to require `/gsd-review-backlog`
promotion.

### 5. `broken-windows` capability description overstates enforcement

**Status:** DONE — open upstream PR [#2814](https://github.com/open-gsd/gsd-core/pull/2814)

The capability's top-level `description` says it "Blocks `/gsd-ship` while any window is open",
with no qualifier. `WINDOWS.md`'s generated header says the same. Only the `workflow.windows_enforce`
knob description is accurate: the gate is **opt-in and off by default**; tracking is on, enforcement
is not. Two of three documentation surfaces assert a guarantee the default configuration does not
provide — which misled this session into believing the ledger was gating a ship it never gated.

### 6. `query commit` will commit onto a protected integration branch with no guard

**Status:** APPROVED — filed upstream as [#3158](https://github.com/open-gsd/gsd-core/issues/3158)
`git.branching_strategy: "none"`, `query commit` committed successfully on `develop`. This is a
safety enhancement because the documented `none` contract intentionally commits on the current
branch; the low-risk fix is an early warning on the resolved base branch, not a blanket refusal.

`gsd_run query commit "<msg>" --files <paths>` commits to whatever branch the working tree is
currently on, with no check against the project's own declared branch model. Observed twice in one
session on 2026-07-30: `/gsd-discuss-phase 27`'s `git_commit` and `update_state` steps ran
`query commit` while the main checkout sat on `develop`, landing `docs(27): capture phase context`
and `docs(state): record phase 27 context session` directly onto the integration branch. Caught
before push only because the branch was checked manually; recovered with `git branch` + `git reset
--hard origin/develop`.

`develop` on this repository is protected server-side (`develop-merge-or-squash`,
`enforcement: active`, empty bypass list), so the push would have been rejected — but that is
GitHub catching it, not GSD. On a repo without a ruleset, or for any workflow step that pushes
after committing, this lands silently.

GSD already knows the branch model it should be respecting: `.planning/config.json` carries
`git.main`, `git.develop`, and `git.feature_prefix`, and `gsd-tools` reads that file for other
purposes. The fix is to have `query commit` refuse (or warn loudly) when `HEAD` is on
`config.git.main` or `config.git.develop`, naming the branch and suggesting a feature branch —
matching the fail-loud posture the rest of the toolchain uses.

**Note this is specifically a GSD-side gap, not DevFlow's.** DevFlow's own production commit
sites (`hooks::docs_update`'s `commit_all`, `hooks::changelog_append` and `hooks::version_bump`'s
`commit_path`) commit to `develop` *deliberately*, in the terminal Ship batch after `Merge` has
already put the main checkout there — that is the designed behavior, and a blanket protected-branch
refusal would break it. `devflow start --no-worktree` likewise calls `GitFlow::feature_start` and
checks out `feature/phase-NN` before any agent runs. The unguarded path is GSD's alone.

#### RECURRED 2026-07-31 — phase 28, at far larger scale

Third and fourth occurrences, and the worst so far: **all 55 phase-28 commits landed directly on
`develop`** — every plan commit, every executor worktree merge, every tracking update, across the
entire phase. Caught only at ship time, when a PR *to* `develop` proved impossible because the work
was already on it. Recovered with `git branch feature/phase-28` + `git branch -f develop
origin/develop` (nothing lost — every commit was preserved on the new branch), then shipped as
PR #63.

**Root cause is broader than `query commit`, and this is the important correction to entry 6's
original diagnosis.** `query commit` is only the proximate mechanism. The actual reason nothing ever
left `develop` is that GSD's **`git.branching_strategy` is unset**, which resolves to `none`:

```
$ gsd-tools query config-get git.branching_strategy   →  (unset)
$ gsd-tools query init.execute-phase 28               →  "branching_strategy": "none"
```

(Note the key is `git.branching_strategy`. A top-level `branching_strategy` is rejected as an
unknown key — worth stating explicitly, because the init JSON reports the resolved value under the
bare name `branching_strategy`, which invites setting the wrong key and silently changing nothing.)

`execute-phase.md`'s `handle_branching` step then reads, in full:

> **"none":** Skip, continue on current branch.

So the phase ran to completion on whatever branch happened to be checked out — `develop`. No step
in plan-phase, execute-phase, or verify-phase ever creates a branch under this setting, and none
warns that it is committing to an integration branch. `/gsd-ship`'s preflight *does* warn ("If on
`${BASE_BRANCH}`: warn — should be on a feature branch"), but that fires at the very end, after all
55 commits already exist.

**`.planning/config.json` already declares the intended model and GSD ignores it:**

```json
"git": { "main": "main", "develop": "develop", "feature_prefix": "feature/", "auto_branch": true }
```

`auto_branch: true` and `feature_prefix: "feature/"` are DevFlow's keys, consumed by DevFlow's own
`GitFlow::feature_start` when `devflow start` drives a phase. GSD reads neither — it looks only at
the top-level `branching_strategy`, which is absent. The project therefore *declares* auto-branching
and *gets* none, with no diagnostic anywhere.

**Suggested upstream fixes, in order of preference:**

1. **Change the default.** `branching_strategy` unset should default to `phase`, not `none`.
   Committing a multi-plan phase onto an integration branch is never the safe default.
2. **Warn at the start, not at ship.** `execute-phase.md`'s `handle_branching` should emit a visible
   warning when strategy is `none` *and* `HEAD` is on `config.git.main`/`config.git.develop` — the
   same condition `/gsd-ship` already checks, moved to where it is still cheap to act on.
3. **Honor the declared model.** When `branching_strategy` is unset but `config.git.feature_prefix`
   /`auto_branch` are present, either adopt them or say plainly that they are being ignored.

---

---

## 7. No way to express "`Agent` exists, but my session will not outlive this turn"

**Status:** FILED — filed upstream as [#3159](https://github.com/open-gsd/gsd-core/issues/3159)
`execute-phase.md`; the historical one-shot-host failure was not rerun because it requires that
external host lifecycle
**Type: compatibility gap / feature request**, not a defect report. GSD's behavior here is correct
under the runtime it targets; this asks for a distinction it currently cannot make.
**Found:** 2026-07-31, while running GSD under DevFlow (`denniyahh/devflow` phase 29)
**Component:** `gsd-core/workflows/execute-phase.md` (`:24-26`, secondary `:18`)
**Severity:** medium — costs a wave of executor work per occurrence in affected runtimes, but only
in runtimes GSD does not currently claim to support.

### The ask, in one sentence

`execute-phase` decides whether to spawn subagents by testing **tool availability**; the property
that actually matters is **session survivability**, and there is no way to express the difference.

### Why availability is the wrong predicate

`:24-26` states the rule:

> **Other runtimes:** If `Agent`/`agent` tool is genuinely unavailable (e.g. a backgrounded Claude
> Code agent per #853, or a non-Claude runtime), use sequential inline execution as the fallback for
> executor parallelization only. If `Agent` IS available (top-level Claude Code), you MUST spawn
> gsd-executor agents — inline execution is not authorized. **Check for actual tool availability,
> not runtime name.**

Under a **non-interactive one-shot launch** (`claude -p "<prompt>"`), `Agent` *is* available — so
this rule mandates spawning. But in that launch mode **the agent's turn ending terminates the
process**. For waves with 2+ plans, `:596-599` correctly prescribes `run_in_background: true` (to
serialize `git worktree add` against `.git/config.lock`), and a backgrounded executor's completion
notification is then delivered to a session that no longer exists.

The distinction is already half-present — #853's "backgrounded Claude Code agent" is exactly a
session-lifetime concern — it is just keyed off whether the tool exists rather than whether the
session will still be there to receive a result.

### Repro (contributed as evidence; the failure itself is the host's fault, not GSD's)

DevFlow drives every GSD stage as one-shot `claude -p`. Phase 29: 7 plans across 6 waves, with
wave 1 = 1 plan, **wave 2 = 2 plans**, waves 3–6 = 1 plan each.

| Wave | Plans | Path | Outcome |
|---|---|---|---|
| 1 | 1 | below the 2+ threshold | merged normally |
| 2 | 2 | **2+ → `run_in_background: true`** | orphaned |

The orchestrator's final message was verbatim *"Wave 2 is running — two executors in isolated
worktrees, plus a backup completion watcher. I'll pick up when they return."* — then the process
exited (`stop_reason: end_turn`). The two executors completed **5 commits** on `worktree-agent-*`
branches and neither wrote its `SUMMARY.md`, having been killed before that step. Wave 2 was the
only multi-plan wave in the phase and the only one that failed.

**To be explicit about ownership:** the lost work is the *host's* fault. DevFlow chose a launch
model that kills the session at turn end and then scored the stage successful anyway. GSD is not
responsible for that, and the host-side fix is tracked separately. What GSD could offer is the
means for a host like this to opt into the safe path.

### Why the existing fallback cannot cover it

`:31-34` — *"If a spawned agent completes its work but the orchestrator never receives the completion
signal, treat it as successful based on spot-checks and continue. Never block indefinitely — always
verify via filesystem and git state."*

This is the right instinct and is unreachable here: it presumes the orchestrator is **alive** to
spot-check. Under one-shot launch it is not.

### Suggested shapes (any one would close the gap)

1. **An explicit opt-out** — a config key (e.g. `execution.session_outlives_turn: false`) or a
   documented env var that forces `run_in_background: false` and/or sequential inline execution,
   independent of tool availability.
2. **Serialize what actually races.** The stated rationale for backgrounding is `git worktree add`
   contending on `.git/config.lock` — which argues for serializing *worktree creation*, then
   dispatching synchronously. That would make the background path unnecessary for this case entirely.
3. **Orchestrator-owned `SUMMARY.md`.** Today the requirement is an instruction to an executor that
   may be killed before honoring it; writing it from the orchestrator after collection makes the
   partial-work state recoverable rather than ambiguous.

### Secondary, minor — a stale statement worth correcting either way

`:18` states *"**Claude Code:** Uses `Agent(...)` — blocks until complete, returns result."* Current
Claude Code runs subagents **in background by default** (`run_in_background: false` is the explicit
opt-out), so this is no longer accurate even for single-agent waves. It loses nothing on its own,
but it is the basis on which the workflow concludes Claude Code is safe to spawn into.

### Local workaround

`"parallelization": false` — serializes within a wave so the 2+ branch is never reached. Costs
parallelism, and does not address subagents backgrounding by default.


## 8. `query commit --files <path>` silently drops any absolute path, because it double-joins it onto `cwd`

**Status:** DONE — already fixed upstream by [#2638](https://github.com/open-gsd/gsd-core/pull/2638);
current regression suite passes the absolute-path cases
**Found:** 2026-07-25, DevFlow phase 23 planning (`23-VALIDATION.md`, `23-PATTERNS.md`)
**RECURRED:** 2026-08-02, DevFlow phase 30 planning (`30-VALIDATION.md`) — same call shape,
confirmed and root-caused this time instead of just observed. See "Root cause" below.
**Component:** `gsd-core/bin/lib/commands.cjs`, `cmdCommit` (`:664-693`)
**Severity:** high — the command reports a normal-looking `{"committed": false, "reason":
"nothing_to_commit"}` on exit 0 for a file that plainly exists and plainly has changes; nothing
distinguishes this from the legitimate "nothing changed" case, so a caller that doesn't diff
`git status` afterward believes the commit succeeded.
**Reproducibility: confirmed 2/2**, and the mechanism is unconditional in the source — not a race
or an environment quirk.

### What happens

`plan-phase.md` (and other workflow steps) resolve `PHASE_DIR` from `init.plan-phase`'s JSON,
which returns an **absolute path**:

```json
"phase_dir": "/var/home/denniyahh/Github/devflow/.planning/phases/30-keep-the-session-alive-past-turn-end"
```

Every workflow step that commits a freshly-written phase artifact naturally builds its `--files`
argument from that variable, e.g. step 5.5:

```bash
gsd_run query commit "docs(phase-${PHASE}): add validation strategy" --files "${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md"
```

`cmdCommit` then does, unconditionally:

```js
const fullPath = node_path_1.default.join(cwd, file);   // commands.cjs:668
if (!node_fs_1.default.existsSync(fullPath)) {           // commands.cjs:669
    if (explicitFiles) { continue; }                      // silently skipped, no warning
    ...
}
```

`path.join` does **not** special-case an absolute second argument — it concatenates and
normalizes. When `file` is already absolute and equals (or is under) `cwd`, the result is `cwd`
duplicated onto itself, which never exists on disk:

```
$ node -e "console.log(require('path').join(
    '/var/home/denniyahh/Github/devflow',
    '/var/home/denniyahh/Github/devflow/.planning/phases/30-.../30-VALIDATION.md'))"
/var/home/denniyahh/Github/devflow/var/home/denniyahh/Github/devflow/.planning/phases/30-.../30-VALIDATION.md
```

`existsSync` on that doubled path is `false`, so the file is treated exactly like a caller-declared
file that doesn't exist — `continue`, no `git add`, nothing pushed to `stagedPaths`. Every file in
the `--files` list can fail this way independently; if all of them do, `stagedPaths.length === 0`
and `cmdCommit` returns `{"committed": false, "hash": null, "reason": "nothing_to_commit"}`
(`commands.cjs:692-694`) — indistinguishable in shape from "there were genuinely no changes."

### Root cause is a real path resolution bug, not specifically an "untracked files" issue

An earlier write-up of this symptom (project-local notes, not filed) attributed it to untracked
files specifically — that was a mis-diagnosis by correlation, corrected here. The doubling happens
purely from the absolute-path collision; it does not consult git's index at all, and would equally
silently drop an **already-tracked** file if `--files` were passed its absolute path (unverified
live, since no reproduction case surfaced with a tracked absolute path, but the code path is
unconditional and has no track-status branch before the `existsSync` check).

**The codebase already has the correct idiom elsewhere in the same file**, just not applied here:

```js
// commands.cjs:306, a different function
const fullPath = node_path_1.default.isAbsolute(targetPath) ? targetPath : node_path_1.default.join(cwd, targetPath);
```

### Reproduction

```bash
cd <repo root>          # cwd == repo root, the normal orchestrator launch condition
touch .planning/phases/NN-slug/NN-NEWFILE.md
gsd-tools query commit "docs: test" --files "$(pwd)/.planning/phases/NN-slug/NN-NEWFILE.md"
# → {"committed": false, "hash": null, "reason": "nothing_to_commit"}
git status --porcelain .planning/phases/NN-slug/NN-NEWFILE.md
# → ?? .planning/phases/NN-slug/NN-NEWFILE.md   (still untracked — commit never touched it)
```

### Suggested fixes (any one is sufficient)

1. **Apply the existing idiom.** Change `commands.cjs:668` to
   `node_path_1.default.isAbsolute(file) ? file : node_path_1.default.join(cwd, file)`, matching
   `commands.cjs:306`. Minimal, one-line, no behavior change for the common relative-path case.
2. **Fail loud instead of silent-skip.** If `explicitFiles` and a declared file resolves to a path
   that doesn't exist, emit a warning naming the exact resolved path checked — would have surfaced
   the doubled path immediately instead of reading as "no changes."
3. **Workflow-side normalization.** `plan-phase.md` and other workflow files could relativize
   `PHASE_DIR`-based paths before passing them to `--files`, but this only hides the underlying bug
   for GSD's own call sites — any other host or hand-invocation with an absolute path still breaks.

### Local workaround

After any `query commit` call whose `--files` argument could be absolute, check
`git status --porcelain <path>` — if the file still shows as untracked/modified, fall back to
`git add <path> && git commit -m "<msg>"` directly.

**RECURRED 2026-08-03, DevFlow phase 30 close** — different trigger, same underlying gap.
`--files ".planning/ROADMAP.md .planning/STATE.md"` (two relative paths joined into ONE shell-quoted
string, a caller error on my part) produced `{"committed": false, "hash": null, "reason":
"nothing_to_commit"}` on exit 0, with both files genuinely dirty. `gsd-tools.cjs`'s CLI arg parser
(`routeCommit`) takes every token after `--files` as one file each
(`args.slice(filesIndex + 1).filter(a => !a.startsWith('--'))`), so the single space-containing
string became one bogus "path" with a literal space in it. `commands.cjs`'s current `cmdCommit`
(`:805-810`) confirms suggestion #1 above is now applied (`path.resolve`, not the old `path.join`
double-join) — but **suggestion #2 (fail loud) was never implemented**: the `existsSync` check at
`:805` still just `continue`s silently for any `explicitFiles` entry that doesn't resolve, with no
warning naming the path it checked. That is the same code path this entry's absolute-path case hit;
this recurrence is independent confirmation that the still-open half of the original fix (fail loud
instead of silent-skip) remains the right thing to land — it would have caught both trigger shapes.
Workaround unchanged: diff `git status --porcelain` after every `query commit`, not just the ones
with absolute-looking paths.

---

## 9. `state.planned-phase` silently rewrites unrelated frontmatter via a body→frontmatter resync that has no preserve-guard for `status` or `last_activity_desc`

**Status:** IN PROGRESS — filed upstream as [#3052](https://github.com/open-gsd/gsd-core/issues/3052);
awaiting maintainer triage and `confirmed-bug` before opening the focused fix PR. Current upstream
still replaces an accurate `last_activity_desc` with stale body prose when both sources carry the same
date. The newer-date guard prevents only the unequal-date case. Mapping `Ready to execute` to
frontmatter `executing` is intentional current behavior, not part of the confirmed defect.
**Found:** 2026-07-31, DevFlow phase 29 planning (`/gsd-plan-phase 29`)
**RECURRED:** 2026-08-02, DevFlow phase 30 planning (`/gsd-plan-phase 30`) — identical symptom,
identical stray text (`last_activity_desc` overwritten with the exact same stale string on both
occasions, three days apart, for two different phase numbers). Root-caused this time.
**Component:** `gsd-core/bin/lib/state-transition.cjs` (`plannedPhaseCore`, `:764-826`),
`gsd-core/bin/lib/state.cjs` (`syncStateFrontmatter`, `:1581-1660`; `buildStateFrontmatter`,
`:1353-1365`), `gsd-core/bin/lib/state-document.cjs` (`normalizeStateStatus`, `:112-134`)
**Severity:** high — every `/gsd-plan-phase` run silently destroys the frontmatter completion
record of whatever phase most recently finished, and reports only `{"updated": ["Status"]}`,
massively under-reporting the actual blast radius.
**Reproducibility: confirmed 2/2**, with the exact same corrupted value both times.

### What happens

After planning completes, plan-phase.md step 13b runs:

```bash
gsd_run query state.planned-phase --phase "${PHASE_NUMBER}" --name "${PHASE_NAME}" --plans "${PLAN_COUNT}"
```

This reported `{"updated": ["Status"], "phase": "30", "plan_count": 5}` on 2026-08-02 — implying a
single, narrow body-field change. The actual `git diff` on `.planning/STATE.md` immediately after:

```diff
-status: shipped — PR #63 open to develop
+status: executing
-last_updated: "2026-07-31T08:35:00.000Z"
+last_updated: "2026-08-02T11:50:33.571Z"
-last_activity: 2026-07-30
+last_activity: 2026-07-30
-last_activity_desc: "Phase 28 complete: 6/6 plans, 779 tests green, SECURED (threats_open 0), ..."
+last_activity_desc: "Phase 28 execution started"
-  total_phases: 17
+  total_phases: 21
-  total_plans: 124
+  total_plans: 129
```

Five frontmatter fields changed; one was reported. `status` and `last_activity_desc` are the
damaging ones — both replace an accurate, hand/executor-authored completion record with stale or
wrong text, and nothing in the tool's own output signals that this happened.

**Identical recurrence, three days and one phase-number apart:** planning phase 29 on 2026-07-31
produced `last_activity_desc: "Phase 28 execution started"` in frontmatter. Planning phase 30 on
2026-08-02 produced the **exact same string**, byte for byte, even though the intent object in
both calls carried a different `phaseNumber`/`planCount`. This is the strongest evidence that the
value is not being freshly derived from the current call's intent at all — it's a stale value found
somewhere else in the document and copied forward unchanged, twice.

**RECURRED again 2026-08-03, via a DIFFERENT verb — `phase.complete`, not `state.planned-phase`.**
Same mechanism, wider blast radius. Closing phase 30 (`gsd_run query phase.complete "30"`, correctly
reporting `next_phase: null`, `is_last_phase: true` — the ROADMAP.md side of the call was fine) also
rewrote `STATE.md`'s frontmatter: `status` and `stopped_at` — both hand-authored minutes earlier
with an accurate account of the phase's closing state — were replaced with `status: completed` and
`stopped_at: Phase 28 context gathered`, a stale fragment from an unrelated, much earlier phase.
`## Current Position`'s body also lost its plan count (`Plan: 5 of 5` → `Plan: Not started`, while
all 5 plans had in fact executed). The `progress:` frontmatter block was ALSO silently overwritten —
via the same `state.update-progress` codepath already confirmed broken in entry 11's investigation —
discarding an explanatory comment that had flagged those exact five numbers as untrustworthy two
days earlier. This confirms the guard-list gap generalizes across call sites: whatever
`readModifyWriteStateMd` wraps is exposed to the same missing preserve-guards, not just
`state.planned-phase`. Recovered by `git checkout -- STATE.md` (uncommitted at the time) and
hand-correcting the same fields, same workaround as below.

### Root cause — a two-part mechanism, both parts confirmed against live source and live document state

**Part 1 — `plannedPhaseCore` targets body fields that partially don't exist in this project's
`STATE.md` shape.** It calls `stateReplaceField` (unconditional) targeting a field literally named
`'Last Activity Description'` (`state-transition.cjs:817`). DevFlow's `STATE.md` has no such field
— `grep -n '^Last Activity Description' STATE.md` returns nothing. It only has a combined prose
line:

```
Last activity: 2026-07-30 — Phase 28 execution started      (STATE.md:160)
```

`stateReplaceField` finds no match, returns null, and the replace is a silent no-op — consistent
with `plannedPhaseCore`'s own `updated` array never including `'Last Activity Description'` in
either observed run. Separately, `plannedPhaseCore` calls `stateReplaceFieldIfTemplate` for
`'Last Activity'` (`:809`), which is **template-aware**: it only replaces the field when the
existing value matches a known placeholder default. `"2026-07-30 — Phase 28 execution started"` is
real content, not a placeholder, so this replace also no-ops and the line is left untouched —
which is exactly why it is still reading a stale 2026-07-30 date and description on 2026-08-02.

**Part 2 — the wrapping `readModifyWriteStateMd` re-derives frontmatter from the body on every
write, and two fields have no preserve-guard.** After the body transform, `readModifyWriteStateMd`
(`state.cjs:2002`) always calls `syncStateFrontmatter(modified, cwd)`, which calls
`buildStateFrontmatter(body, cwd)` to compute fresh frontmatter values purely from body content,
then selectively falls back to the pre-existing frontmatter value when the derived one looks wrong
— but only for a specific allowlist:

```js
// state.cjs:1590 — only guard for status, and only the 'unknown' case:
if (derivedFm['status'] === 'unknown' && existingFm['status'] && existingFm['status'] !== 'unknown') {
    derivedFm['status'] = existingFm['status'];
}
// stopped_at, paused_at, current_phase, current_phase_name, current_plan,
// progress (if fully absent), milestone/milestone_name all have their own
// explicit "prefer existing when derived is empty" guards (:1631-1660).
// last_activity_desc has NO such guard anywhere in this file.
```

Since `buildStateFrontmatter` re-derives `lastActivityDesc` straight from the stale body line
(`state.cjs:1365`: `stateExtractField(bodyContent, 'Last Activity Description') ??
proseLastActivity.description` — the second branch fires, extracting `"Phase 28 execution
started"` from the untouched prose line), and there is no guard protecting it, the frontmatter's
detailed, accurate completion description is unconditionally overwritten by that stale fragment —
every single time `readModifyWriteStateMd` runs and the no-op-detection allows the write through
(which it does here, because the *`Status`* body field, a separate line under `## Current
Position`, genuinely did change).

**The `status` corruption has a second, independent contributing bug: a substring conflation in
`normalizeStateStatus`.** `plannedPhaseCore` deliberately sets the body's `## Current Position`
`Status:` line to the literal string `"Ready to execute"` (`:801-804`, meaning "planning just
finished, nothing is running yet"). `buildStateFrontmatter` extracts that string and normalizes it
via `normalizeStateStatus` (`state-document.cjs:112`):

```js
else if (statusLower.includes('executing') || statusLower.includes('in progress')) {
    normalizedStatus = 'executing';
}
...
else if (statusLower.includes('ready to execute')) {
    normalizedStatus = 'executing';        // state-document.cjs:130-132
}
```

`"ready to execute"` and `"executing"` are opposite states — one means *nothing has started*, the
other means *mid-run* — but the substring-based classifier folds them into the same normalized
value, so a phase that just finished planning gets stamped into frontmatter as `status: executing`,
overwriting a correct `status: shipped — PR #63 open to develop` for a *different, already-shipped*
phase.

### Why this is worse than it looks

The intent-level `updated` report (`{"updated": ["Status"]}`) reflects only what `plannedPhaseCore`
itself changed on the **body**. It has no visibility into what `syncStateFrontmatter` changes on
the **frontmatter** afterward as a side effect of the same write — so the report is not merely
incomplete, it is structurally incapable of describing the actual damage, because the two layers
that make the change don't share an accounting mechanism.

### Suggested fixes (any one materially helps; 1+2 together close it)

1. **Add a preserve-guard for `last_activity_desc`**, matching the existing pattern for
   `stopped_at`/`paused_at`/etc. (`state.cjs:1631-1660`): if the derived value looks identical to
   what a stale, unrelated body line would produce (or simply: prefer existing frontmatter when the
   *specific* transition being applied — `plannedPhase` — never actually touched the description
   field), don't overwrite it.
2. **Fix the `normalizeStateStatus` conflation.** `"ready to execute"` should map to a distinct
   normalized status (e.g. `'planned'` or `'ready'`), not collapse into `'executing'`. This is a
   one-line, low-risk change (`state-document.cjs:130-132`) that removes an actively misleading
   state transition.
3. **Make `plannedPhaseCore` and `syncStateFrontmatter` share one accounting.** Either have
   `readModifyWriteStateMd` report every field the *resync* changed (not just the caller's own
   transform), or have `plannedPhaseCore` write directly to frontmatter for the fields it owns
   (`status`, `last_activity_desc`) instead of relying on body→frontmatter re-derivation to infer
   them indirectly.
4. **Give `plannedPhaseCore` a real `'Last Activity Description'` body target**, or update
   `buildStateFrontmatter`'s prose fallback to not silently treat a years-old unrelated line as
   "the latest activity" when a more specific transition (like `plannedPhase`) is what triggered the
   write.

### Local workaround

After `query state.planned-phase` (or any `readModifyWriteStateMd`-wrapped verb), diff
`.planning/STATE.md`'s frontmatter block specifically — not just the reported `updated` array — and
hand-restore `status` / `last_activity_desc` in the same commit as any legitimate changes from that
call. Both recorded occurrences were caught and fixed this way with no data loss (git preserves the
pre-corruption value), but it must be checked every time; the tool's own report cannot be trusted to
surface it.

### Addendum, 2026-08-04: a second, architecturally distinct symptom shares this root — a
### preserve-guard on named fields will NOT fix it

**Found:** 2026-08-03, DevFlow phase 31 (plan, execute, and close stages — three separate verb
calls in one phase, not a recurrence of the same call).
**New component detail:** `buildStateFrontmatter` (`src/state.cts:1577-1815`, current checkout)
does not read or carry forward the *previous* frontmatter block at all. It reconstructs the entire
`Record<string, unknown>` from scratch by extracting a fixed set of named fields out of the Markdown
**body** (`Current Phase`, `Status`, `Progress`, `Last Activity`, …) via `stateExtractField`. Verified
directly against this checkout: no code path in the function references prior frontmatter comments,
unknown keys, or key order — there is nothing there *to* preserve, because the model it builds from
never contained them.

**Consequence for this project's STATE.md:** DevFlow's `progress:` block carries a hand-authored
YAML comment above the five progress fields, explaining that those fields are known-stale and why
(see DevFlow's own `.planning/STATE.md` history / `UPSTREAM-GSD-ISSUES.md` entries 9 and 11 as cited
from that comment). **Every call through `syncStateFrontmatter` deletes that comment**, silently,
because `buildStateFrontmatter`'s rebuilt object has no representation for it. Reproduced 3/3 in one
DevFlow phase across three different call sites that all route through the same function:
`state.planned-phase` (this entry's original subject), `state.begin-phase`
(`execute-phase.md`'s `validate_phase` step), and `phase.complete`. None of the three reported the
deletion in their `updated`/return payload — same under-reporting this entry already documents for
`status`/`last_activity_desc`, now confirmed for arbitrary non-modeled content generally.

**Why this is a different fix from what §"Suggested fix" above proposes, not a duplicate of it.**
Adding `status`/`last_activity_desc` to a preserve-guard list keeps specific *field values* correct.
It does nothing for content that was never a field in the first place — a YAML comment, an unknown
key a human added, non-standard formatting. The rebuild-from-body-prose architecture is the shared
root of both symptoms, but the fix shapes diverge:

1. **Field-level preserve-guard** (this entry's existing proposal) — cheap, but structurally cannot
   cover comments/unknown-keys, because there is no field to guard.
2. **Stop rebuilding; edit the existing frontmatter block in place**, or round-trip through a
   comment-preserving YAML parser or a diff/patch on the raw frontmatter text instead of
   parse-to-model-then-reserialize. Bigger change, but it is the only shape that fixes both symptoms
   at once, because it removes the lossy round-trip itself rather than patching its output.

**Local workaround, in addition to the one above:** if a project's STATE.md carries any
hand-authored comment or non-standard content in frontmatter, expect it to be silently deleted by
*any* verb that writes STATE.md, not only `state.planned-phase`. Diff the full frontmatter block —
not just the fields you expect to have changed — after every state-writing verb, and restore
comments in the same commit as any legitimate change from that call.

---

## 10. `model` and `effort` resolve through different mechanisms at different times, and the docs assert a symmetry that does not exist

**Status:** APPROVED — filed upstream as [#3160](https://github.com/open-gsd/gsd-core/issues/3160)
in the current resolver/sync source contract. This remains an enhancement bundle, not one defect.
**Found:** 2026-08-02, DevFlow — routing subagent models/effort so the session model reaches the executor
**Component:** `gsd-core/bin/lib/model-resolver.cjs`, `install-effort-resolver.cjs`,
`config-loader.cjs` (`loadConfigResolved`, branch D), `commands.cjs` (`cmdEffortSync` `:579-641`),
`references/model-profiles.md`
**Severity:** medium-high — four independent paths that produce a silently wrong value, one of which
reshapes 20+ agents the user never named
**Reproducibility: confirmed**, each item below verified by direct test against live source, not read
off documentation.

This is an enhancement request rather than a single bug: the individual behaviours are each
defensible in isolation, but together they make "which model and effort will this agent actually run
at?" unanswerable without reading the resolver source.

### What the docs claim

`references/model-profiles.md` § Resolution Logic:

> The same precedence applies to `reasoning_effort` resolution on runtimes that support it (Codex),
> so `model` and `reasoning_effort` always derive from the same tier source.

### What actually happens

- **`model`** resolves at **runtime**, per spawn, from `.planning/config.json`.
- **`effort`** (claude runtime) resolves at **install time** and is baked into
  `~/.claude/agents/*.md` frontmatter. A config change has no effect until
  `gsd-tools query effort sync --apply` is run.

Four consequences follow, each verified:

**10a — `resolve-execution` reports an effort the agent will not use.** With `effort:` deleted from
`~/.claude/agents/gsd-executor.md` (so Claude Code inherits the session effort),
`query resolve-execution gsd-executor --pick effort` still reports `high`. The query surface is not
a source of truth for effort; only the frontmatter is.

**10b — `~/.gsd/defaults.json` is authoritative for one setting and inert for the other.** For
`model` it is only consulted when the directory has **no `.planning/`** (branch D of
`loadConfigResolved`). For `effort` it *is* honoured everywhere, because `cmdEffortSync` deliberately
uses the install-time resolver — its own comment says the runtime resolver "would silently ignore
home-level effort changes." Verified with `GSD_HOME` pointed at a fixture setting
`model_overrides.gsd-executor=haiku`: resolved `haiku` in a bare dir, `sonnet` in a dir with
`.planning/config.json`, and `sonnet` in a dir with `.planning/` but no `config.json`. A file named
`defaults.json` in the global config dir therefore does not apply to any real project's models, and
nothing signals this.

**10c — creating an `effort` block disables the built-in tier defaults.**
`resolveInstallTimeEffort` consults `EFFORT_MANIFEST_TIER_DEFAULTS` only when `effortCfg` is
**null**; once the block exists but lacks `routing_tier_defaults`, resolution falls through to
`effort.default` → `'high'`. Verified: adding four `agent_overrides` produced a **23-agent** dry-run
diff that *downgraded* `gsd-assumptions-analyzer` and `gsd-debug-session-manager` xhigh→high and
*upgraded* `gsd-codebase-mapper` low→high. Adding one override silently reshapes every agent the
user did not mention. Re-declaring `{light: low, standard: high, heavy: xhigh}` restored the
intended 7-agent diff.

**10d — `effort` cannot express inheritance; `model` can.** Claude Code documents agent-frontmatter
`effort:` as *"Default: inherits from session"* and provides **no `inherit` literal**, while `model:`
accepts both omission and the literal `inherit`. GSD's `EFFORT_SET` is
`minimal|low|medium|high|xhigh|max` with no way to emit nothing, so GSD cannot express effort
inheritance at all. Compounding it, `cmdEffortSync` reads an absent key as `null`, which never equals
the target value, so it **re-adds** the key on every apply — a hand-strip is silently undone by the
next sync or reinstall.

### Why part of this complexity is justified

Claude Code's `Agent()` tool has **no effort parameter**, so effort genuinely cannot be passed per
spawn — frontmatter is the only available channel. Effort surfaces also differ per runtime (codex
takes `-c model_reasoning_effort=<level>` on argv; claude takes frontmatter), so one mechanism cannot
serve both. The install-time/frontmatter design is a reasonable response to a real platform
constraint. **The four items above are not that constraint** — they are layering, reporting, and
expressiveness choices made on top of it, and each is independently fixable.

### Suggested shapes (any subset closes part of the gap)

1. **Accept `inherit` in `EFFORT_SET` and have the frontmatter writer omit the key for it.** Closes
   10d and makes "follow the session" a first-class, declarable choice rather than a hand-edit that
   the next sync reverts.
2. **Merge `routing_tier_defaults` over the manifest defaults instead of replacing them.** Closes
   10c — a partial config should not discard built-ins.
3. **Have `resolve-execution` read the frontmatter, or report `resolved` and `effective`
   separately.** Closes 10a — the query must not claim a value the agent will not use.
4. **Either honour `~/.gsd/defaults.json` as a base layer beneath project config for all keys, or
   warn when a project config exists and the global file sets keys that will be ignored.** Closes
   10b. The warning alone would be a large improvement over silence.
5. **Correct `model-profiles.md`** — drop or qualify the "same precedence" sentence, which is false
   for claude runtimes, and document the install-time/runtime split plus the need to re-run
   `effort sync` after changing effort config.

### Local workaround

`~/.local/bin/gsd-prefs` (written 2026-08-02): runs `effort sync --apply --runtime claude`, then
re-strips `effort:` from the inherit set (`gsd-executor`, `gsd-code-reviewer`, `gsd-debugger`),
then applies per-project `model_overrides`. Ordering is load-bearing — the strip must follow the
sync. `--check` reports drift; `--agents-only` does the global half. Must be re-run for every new
project and after every GSD update, which is precisely the manual upkeep suggestion 1 would remove.

---

## 11. `query progress` reports `percent: 100` while plans remain unexecuted, because it divides summaries by plans across phases where the two do not correspond

**Status:** FILED — filed upstream as [#3161](https://github.com/open-gsd/gsd-core/issues/3161)
**Found:** 2026-08-02, DevFlow phase 30 wave 2, auditing a suspected plan-count discrepancy
**Component:** `gsd-core/bin/lib/commands.cjs` (`total_plans` / `total_summaries` / `percent`)
**Severity:** medium-high — a progress meter that reads *complete* while work is outstanding, on a
tool whose central promise is never silently reporting success
**Reproducibility: confirmed**, deterministic from the current repository state.

### What happens

`query progress` on DevFlow returns:

```
percent: 100    total_plans: 139    total_summaries: 140
```

while phase 30 is mid-execution with `plans=5, summaries=3, status="In Progress"` — two plans not
yet executed, one of them running at the moment of the query.

### Root cause

`percent` is computed from `total_summaries / total_plans` aggregated across the whole milestone.
That assumes one summary per plan. Four phases in this repository break the assumption in the
*numerator's* favour:

| Phase | plans | summaries |
|---|---|---|
| 02 | 0 | 1 |
| 03 | 0 | 1 |
| 08 | 0 | 1 |
| 14 | 4 | 5 |

These are legacy phases that produced a SUMMARY without a correspondingly-named PLAN (early phases
used a bare `PLAN.md` rather than `NN-PLAN.md`, and some recorded a summary with no plan file at
all). The surplus of **+4** masks phase 30's genuine deficit of **−2**, pushing the ratio to
`140/139` — over 1.0, reported as `100`.

So the meter does not merely round up. It is **structurally capable of reporting 100% while an
arbitrary amount of work is outstanding**, provided enough legacy summary/plan mismatches exist
elsewhere in the milestone to absorb the shortfall.

### Why this is worse than a cosmetic rounding bug

The number is surfaced where it is most likely to be trusted without checking: the GSD statusline
renders it as a progress bar. An operator glancing at `[██████████] 100%` has no signal that a phase
is mid-flight. On this project it read `100%` while an executor was actively running.

It also fails silently in the direction that matters. A meter that under-reports prompts
investigation; one that over-reports to exactly 100% invites the conclusion that nothing remains.

### Not the same as stale STATE.md counts

`.planning/STATE.md` carries a cached `progress:` block that legitimately lags the live query — that
is a snapshot, not a defect. This entry is about the **live** computation being wrong.

### Suggested fixes (1 alone is sufficient; 2 and 3 are hardening)

1. **Clamp and, better, compute completion per phase rather than by aggregate ratio.** A phase is
   complete when every one of its plans has a summary; milestone percent is completed-phases over
   total-phases, or a plan-level count that cannot exceed its denominator.
2. **Never emit `percent > 100`, and treat `total_summaries > total_plans` as a data-integrity
   warning** rather than silently normalising it. The surplus is real information: it means some
   phase's artifacts do not correspond.
3. **Refuse `100` while any phase's `status` is `In Progress`.** A cheap, independent guard: the
   phase status is already computed in the same result object, so the inconsistency is detectable
   without new machinery.

### Local workaround

None applied. The number is read-only and advisory; DevFlow's own gates do not consume it.
Operators should treat the statusline percentage as unreliable near completion and check
`query progress` phase-by-phase instead.

### Recurrence — 2026-08-06, DevFlow phase 34 close, a different call site

Same root cause (a SUMMARY without a corresponding PLAN — phase 34's `34-06b-SUMMARY.md` has no
`34-06b-PLAN.md`), reached through a **different** function this time: `phase.complete`, not
`query progress`. It wrote `"plans_executed": "7/6"` directly into the ROADMAP `## Progress` table's
per-phase row (7 SUMMARYs / 6 PLANs), rather than into the aggregate milestone `percent` this entry
documents. The number is self-evidently nonsensical on sight (a ratio exceeding its own denominator,
printed as a plan count) rather than silently clamped to 100 — a smaller blast radius than the
aggregate case, but the same unguarded assumption: one summary per plan. Hand-corrected to `6/6`
before committing (`gsd_run query phase.complete` does not clamp or warn on `summaries > plans`
either). Confirms the fix should live where both call sites can share it — a summary/plan
correspondence check, not a `query progress`-only patch.

---

## 12. `state.validate` can never report drift, because its entire disk scan is gated on a field the shipped template never emits

**Status:** FILED — filed upstream as [#3162](https://github.com/open-gsd/gsd-core/issues/3162)
**Found:** 2026-08-02, DevFlow phase 30 wave 3, investigating why `STATE.md` is chronically stale
**Component:** `gsd-core/bin/lib/state.cjs` (`cmdStateValidate`), `gsd-core/bin/lib/state-document.cjs`
(`stateExtractField`), `gsd-core/templates/state.md`
**Severity:** high — a validator that is structurally incapable of failing, on the one command whose
job is detecting that `STATE.md` has gone stale
**Reproducibility: confirmed** against gsd-core 1.9.1, and reproducible from the shipped template
alone with no project state required.

### What happens

`query state.validate` returns a clean bill of health unconditionally:

```
$ gsd_run query state.validate
{ "valid": true, "warnings": [], "drift": {} }
```

On DevFlow this was returned while phase 30 had **5 plans and 5 SUMMARYs on disk** and `STATE.md`
still read `status: "executing — wave 1 complete (2/5 plans)"`. That is precisely the condition
`cmdStateValidate` already contains a check for (`state.cjs:2569-2574`, *"All N plans have summaries
but status is still …"*). The check never ran.

### Root cause

Every drift check in `cmdStateValidate` lives inside one conditional (`state.cjs:2538`):

```js
const currentPhase = stateExtractField(content, 'Current Phase');
...
if (currentPhase && fs.existsSync(phasesDir)) {   // <-- all three checks are inside
```

`stateExtractField` (`state-document.cjs:206-224`) matches exactly three renderings:
`**Current Phase:** v`, a line-start `Current Phase: v`, or a `| Current Phase | v |` table row.

**`templates/state.md:32` emits none of them.** The shipped template writes:

```
Phase: [X] of [Y] ([Phase name])
```

So `currentPhase` is `null`, the conditional is false, and the function falls straight through to
`valid = warnings.length === 0` → `true`. The same applies to `Total Plans in Phase`
(`state.cjs:2534`) and `Last Updated`.

Verified against the template itself rather than against one project's drifted file — extracting the
fenced `markdown` block from `templates/state.md` and running the real `stateExtractField` over it:

```
Current Phase          NULL  <-- validate would skip
Total Plans in Phase   NULL  <-- validate would skip
Last Updated           NULL  <-- validate would skip
Phase                  "[X] of [Y] ([Phase name])"     <-- negative control: extractor works
Status                 "planning"
```

`Phase` and `Status` resolving prove the extractor is functioning; `Current Phase` returning `NULL`
on a pristine, never-edited template output is the defect. **This is not project drift — a brand-new
GSD project has an inert validator from its first commit.**

Note `Status` succeeds only incidentally: it is a single word, the plain pattern carries the `i`
flag, and frontmatter precedes the body — so it returns the *frontmatter* `status:` value, never the
body's `Status:` line. Any field name containing a space fails.

### Why this is worse than the check simply being absent

`valid: true` is indistinguishable from "I checked and found nothing." The command reports the
strongest possible result in the exact case where it did no work at all — an absent field reading as
a clean bill of health. Callers that route on it (`references/execute-phase-quota-recovery.md` routes
safe-resume decisions through state verification) cannot tell the two apart.

### Suggested fixes (any one closes it)

1. **Read the field the template writes.** `stateExtractField(content, 'Phase')`, parsing the
   `[X] of [Y]` shape — smallest change, no template migration.
2. **Prefer frontmatter.** `current_phase` already exists in frontmatter as a machine field;
   `stateExtractField` only ever looks at body renderings. Reading frontmatter first would make all
   three lookups robust and is consistent with how the rest of `state.*` mutates state.
3. **Fail loud on an unresolvable anchor.** If `currentPhase` is null, return `valid: false` with an
   explicit `warnings: ["cannot locate current phase in STATE.md"]` rather than `valid: true`. A
   validator that cannot find its subject must not report success.

### Related, independent finding — a documented recovery verb that does not exist

`references/execute-phase-quota-recovery.md:4` routes quota/interrupt recovery to
`state.verify-against-disk`:

> commits exist, route to safe-resume (`state.verify-against-disk`) instead of an immediate …

That subcommand is not implemented. The router rejects it (exit 1):

```
Error: Unknown state subcommand: "verify-against-disk". Available: load, complete-phase, json, get,
update, patch, begin-phase, advance-plan, record-metric, update-progress, add-decision, add-blocker,
resolve-blocker, record-session, signal-waiting, signal-resume, planned-phase, validate, sync, prune,
rebuild, milestone-switch, add-roadmap-evolution
```

So the documented recovery path for the highest-stakes situation — resuming after a quota kill with
production commits already on disk — cannot execute. Worth filing as its own issue; either implement
it, or point the reference at `state.validate` (once entry 12's fix makes that meaningful) or
`state.rebuild --dry-run`.

### Local workaround

DevFlow adds a `post-commit` hook that detects a `*-SUMMARY.md` landing and warns that `STATE.md`'s
authored prose is now stale, writing a marker under the gitignored `.devflow/`. It deliberately does
**not** mutate tracked files: plans in this repository carry scope fences asserting
`git diff --name-only` lists only their own files, and a hook that dirties `STATE.md` mid-phase would
break them. The hook is a local signal, not a fix — the validator remains inert.

### Recurrence — 2026-08-06, DevFlow v2.4.0 milestone close

Reproduced again, independently, with a fresh mechanism confirming the root cause rather than just
its symptom. After `/gsd-complete-milestone v2.4.0` ran, `STATE.md`'s frontmatter still read
`milestone_name: "...ACTIVE — declared 2026-08-04"` and `current_phase: 34`, directly contradicting
the adjacent `status: "Awaiting next milestone"` in the same frontmatter block — `state.validate`
reported `{"valid": true, "warnings": [], "drift": {}}` regardless. As a second, more direct check:
temporarily injected an actually-malformed duplicate `milestone:` frontmatter key (broken YAML, not
just stale content) as a negative control, re-ran `state.validate`, got the identical `valid: true`
result, then reverted. Two different classes of real defect — stale-but-syntactically-valid content,
and a broken key — both invisible to the same validator in the same session, consistent with entry
12's diagnosis that the checks are gated behind an extraction that structurally never fires rather
than behind logic that's merely incomplete.

---

## 13. `phase.add` inserts the new phase at the file's last `---`, which on a long roadmap is nowhere near the phase list

**Status:** CONFIRMED — filed upstream as [#3163](https://github.com/open-gsd/gsd-core/issues/3163)
**Found:** 2026-08-03, DevFlow phase 31 creation (`/gsd:phase`)
**Component:** `gsd-core/src/phase.cts`, `cmdPhaseAdd` (line 882) and `cmdPhaseAddBatch` (line 970)
**Severity:** medium — silently files the new phase inside unrelated (often historical) prose. No
data loss, but the roadmap is wrong until someone notices and moves it by hand.
**Reproducibility: deterministic.** A pure function of where the last `---` sits in the file.

### What happens

`phase.add` computes the new phase number correctly, creates the directory correctly, then
inserts the roadmap entry here:

```js
const lastSeparator = rawContent.lastIndexOf('\n---');
if (lastSeparator > 0) {
  updatedContent = rawContent.slice(0, lastSeparator) + phaseEntry + rawContent.slice(lastSeparator);
} else {
  updatedContent = rawContent + phaseEntry;
}
```

Two things go wrong together:

1. **It scans `rawContent` — the whole file — not the milestone-scoped `content`.** Every other
   part of the same function is milestone-aware (`extractCurrentMilestone` in the batch variant,
   the sentinel-999 filter, the on-disk directory scan). The insertion point alone is not.
2. **`---` is a horizontal rule, not a phase-list terminator.** Any roadmap that keeps history,
   backlog, appendices, or operator-decision blocks after the active phase list has many of
   them, and the *last* one is by definition in the trailing material.

The result is that the new phase is inserted before the last horizontal rule in the document,
which on a roadmap of any age is deep inside archived content.

### Reproduction (observed, DevFlow `.planning/ROADMAP.md`)

- File: 3294 lines. Active phase list ends at line 2858; phase 30's entry is the last live one.
- Last `^---` in the file: **line 3236** — 58 lines from EOF, inside a historical
  `### Phase 29 (original scope): …` section, immediately before a `#### Operator decisions`
  subsection belonging to that archived phase.
- `phase.add "Claude Adapter Launch Path…"` → correct number (31), correct directory, and the
  entry written at line 3236 — 378 lines below the phase list, under a *different* phase's
  heading, in the middle of that phase's prose.

A reader of the roadmap now sees phase 31 documented as part of archived phase 29.

### Why the number being right makes it worse

The number/slug/directory logic is careful and well-commented (it collects from headers, bullets,
AND on-disk dirs specifically to avoid the #1229 collision). That care means the operator has
every reason to trust the output — the JSON result it prints is entirely correct, and says
nothing about placement. Nothing surfaces the misfiling; only reading the diff catches it.

### Suggested fixes (any one is sufficient)

1. **Anchor to the phase list, not to `---`.** Insert after the end of the last `### Phase N:`
   section within the current milestone — the same section-walk `roadmap.analyze` already
   implements (`nextHeader` regex in `cmdRoadmapAnalyze`).
2. **Scope the existing heuristic to the milestone window.** Run `lastIndexOf('\n---')` over
   `extractCurrentMilestone(rawContent, cwd)` and map the offset back, so it can never reach
   trailing archive material.
3. **Minimum viable:** return the byte offset / line number of the insertion in the result JSON,
   so callers and workflows can verify placement instead of assuming it.

Fix `cmdPhaseAddBatch` (line 970) at the same time — it carries the identical expression.

### Secondary, minor — slug truncation cuts mid-word

The same call produced directory slug
`31-claude-adapter-launch-path-pipe-owning-monitor-999-64-arc-cl` — a hard cut at exactly 60
characters, mid-word (`arc-cl` from "arc close"). Harmless (`find-phase 31` resolves it), but
truncating on a word boundary would cost nothing and reads far better in `ls`.

### Local workaround

Move the entry by hand after every `phase.add`, and diff against a pre-call copy of ROADMAP.md
to confirm nothing else shifted. Verify with `grep -c '^### Phase N:'` (expect 1) and a
removed-line count of 0 against the backup.

---

## 15. Route 0's incomplete-phase predicate counts superseded plans, so fixing issue 14 will immediately start misrouting

**Status:** FILED — filed upstream as [#3164](https://github.com/open-gsd/gsd-core/issues/3164)
**Found:** 2026-08-03, DevFlow, running `/gsd:progress --next` twice in one session
**Component:** `gsd-core/workflows/next.md` step `resume_incomplete_phase` (predicate at line 98,
loop at line 121, success criterion at line 341)
**Severity:** medium — currently **latent**, and dormant *only* because issue 14 masks it. Fixing
14 without fixing this converts a silent no-op into a confident wrong answer, which is worse.

### What happens

Route 0 is the hard invariant that catches a phase left mid-execution when `current_phase` has
moved past it. It scans phases lowest-to-highest and stops at the first where
`plans.length > summaries.length` (next.md:98, restated as a success criterion at :341), then
routes to `/gsd-execute-phase <that phase>`.

The predicate has no notion of a plan that is **deliberately** unsummarised. GSD's own plan
frontmatter supports `status: superseded` / `superseded_by:`, and `/gsd-plan-phase` writes it —
but Route 0 does not read it.

### Concrete instance on DevFlow

Phase 25 holds 19 PLAN.md and 18 SUMMARY.md. The gap is `25-10-PLAN.md`, whose frontmatter reads:

```yaml
status: superseded
superseded_by: "25-13"
```

ROADMAP.md marks it `[~] HALTED at Task 1 Step E; SUPERSEDED by 25-13`, and the phase entry
records the disposition in prose: 25-10 was superseded rather than re-run because re-running it
unchanged would have produced evidence about tests that were no longer the risk.

Phase 25 is closed. But it is the *lowest-numbered* phase matching the predicate, so a working
Route 0 scan stops there and routes `/gsd-execute-phase 25` — re-executing a closed phase, and
never reaching Phase 31, the phase that genuinely needed executing.

### Why it has not bitten yet

Issue 14. `roadmap.analyze` returns an empty `phases[]` on this repo, so the `for` loop at
next.md:121 never iterates, `INCOMPLETE_PHASE` stays empty, and the workflow falls through to
`determine_next_action`, which routes on `current_phase` and happens to give the right answer.

Both bugs were observed in the same session: the vacuous scan was caught by enumerating phases
from the filesystem as a second, independent count — a single count can never look wrong, two
disagreeing counts always do. That second count is what surfaced Phase 25.

**This is the dangerous shape:** issue 14 is filed and will be fixed. The moment it is, Route 0
starts iterating for real and immediately misroutes on this repo. The fix for 14 should not ship
without this one.

### Suggested fix

Exclude plans whose frontmatter carries `status: superseded` (or a non-empty `superseded_by:`)
from the `plans` count in the predicate — or, better, have `find-phase` report
`plans_awaiting_summary` alongside `plans`, so every consumer inherits the exclusion rather than
each re-deriving it. `determine_next_action`'s Route 4 uses the same predicate and has the same
hole; the success criterion at next.md:341 explicitly ties the two together, so they should be
fixed as one change.

### Negative control

The claim "Phase 25 is a false positive, not real incomplete work" was checked against a phase
where the same predicate fires legitimately: Phase 31, 5 plans / 0 summaries, no `superseded`
frontmatter on any of them, genuinely unexecuted. The proposed exclusion leaves Phase 31 flagged
and drops Phase 25 — the two cases separate cleanly, which is what makes the exclusion safe
rather than merely quieting.

---

## 14. `roadmap.analyze` reports `phase_count: 0` with no error while phase directories exist on disk, silently disarming `/gsd:progress --next`'s resume gate

**Status:** FILED — filed upstream as [#3165](https://github.com/open-gsd/gsd-core/issues/3165)
**Found:** 2026-08-03, DevFlow (pre-existing; confirmed present before and after an unrelated edit)
**Component:** `gsd-core/src/roadmap.cts` `cmdRoadmapAnalyze` → `roadmap-parser.cts`
`extractCurrentMilestone` (section-end scan, lines 178-193)
**Severity:** medium-high — the failure is silent, and what it disables is a safety gate.
**Note on ownership:** the *trigger* is a consuming repo's document layout (see below), which is
arguably that repo's to fix. The *silence* is the defect being reported here.

### What happens

`extractCurrentMilestone` resolves the active milestone from `STATE.md`'s `milestone:` field,
finds its heading, then walks forward for the section end — stopping at the next heading of
level ≤ the milestone heading that is not a Phase heading and that carries a version/status
marker (`v\d+\.\d+|✅|📋|🚧`).

If the *next* such heading is a **closed** milestone that happens to sit between the active
milestone heading and the `### Phase N:` detail sections, the active milestone's window closes
immediately — over prose only, containing zero phase headings. `cmdRoadmapAnalyze` then returns:

```json
{"milestones":[{"heading":"v2.3.0 milestone","version":"v2.3.0"}],
 "phases":[],"phase_count":0,"current_phase":null,"next_phase":null}
```

A populated `milestones` array beside an empty `phases` array — the milestone was found, so
nothing reads as failure.

### Reproduction and the controlled diagnosis

DevFlow's `.planning/ROADMAP.md`: `## v2.3.0 milestone (ACTIVE…)` at line 5, `## v2.0.0
milestone (CLOSED…)` at line 25, all `### Phase N:` sections from line 113 onward. 30 phase
directories on disk.

- Baseline: `phase_count: 0`.
- **Negative control** (demote only line 25 `## v2.0.0 milestone` → `###`, so it is no longer a
  level-≤2 boundary; nothing else changed): `phase_count: 22`, `next_phase: "31"`.

That isolates the boundary heading as the sole cause. A first, sloppier control — demoting every
non-milestone `##` heading — produced no change and briefly looked like a refutation; it had
excluded the one heading that mattered. Worth stating because the obvious control here is the
wrong one.

### Why the silence is the defect

`workflows/next.md` Route 0 ("resume_incomplete_phase") is a **hard invariant**: it scans every
phase for `plans.length > summaries.length` to catch a session that died mid-execution while
`current_phase` moved past the unfinished work. It is built on `roadmap.analyze`:

```bash
ROADMAP_JSON=$(gsd_run query roadmap.analyze)
for PHASE_NUM in $(echo "$ROADMAP_JSON" | jq -r '.phases[] | (.number // …)'); do
```

With `phases: []` the loop body never executes. `INCOMPLETE_PHASE` stays empty, which is the
same value it holds when the scan ran and found nothing — so the workflow proceeds to routing as
though the invariant had been checked and passed. The workflow's own error branch only fires on
a non-zero exit or empty output; a well-formed JSON document with an empty array passes straight
through.

This is the same shape as entry **12** (`state.validate`'s disk scan gated on a field the
template never emits): a safety check that cannot fail because it cannot run.

### Suggested fixes (any one materially helps; 1+2 close it)

1. **Cross-check against disk.** `cmdRoadmapAnalyze` already reads the phases directory
   (`_phaseDirNames`). If that list is non-empty and `phases` is empty, emit a
   `warning`/`scope_suspect` field naming the resolved milestone window. Cheap, and it converts
   silence into a diagnosable message.
2. **Let Route 0 distinguish "scanned, clean" from "could not scan."** Have the consumer treat
   `phase_count: 0 && phaseDirsOnDisk > 0` as scan-failed and take the existing warn-and-fall-
   through branch rather than the pass branch.
3. **Optional, larger:** when the milestone window contains no phase headings, fall back to
   whole-document scan (as `stripShippedMilestones` does when no version resolves) instead of
   returning an empty set.

### Local workaround

None applied yet. The consuming repo can reorder its roadmap so the active milestone's phase
detail sections are not separated from it by a closed-milestone heading — but that is a
several-hundred-line restructure of a 3300-line document, and it does not address the silence
for anyone else.

---

## 16. `milestone.complete`'s "no phases found → assume unscoped" degrade inherits issue 14's window truncation and converts it into a pass-all filter that archives every phase in the project, not just the milestone's own

**Status:** CONFIRMED — filed upstream as [#3166](https://github.com/open-gsd/gsd-core/issues/3166)
**Found:** 2026-08-04, DevFlow, running `/gsd-complete-milestone` for v2.3.0 (phases 30–31 only)
**Component:** `gsd-core/src/roadmap-parser.cts` `getMilestonePhaseFilter` (pass-all degrade at
line 715); consumed by `gsd-core/src/milestone.cts` `cmdMilestoneComplete` (phase-collection loop
at line 605, and the identical scoped-content re-derivation at line 550 used by the
`noDirectoryPhases` guard)
**Severity:** high — unlike issue 14 (silent no-op on a read path), this fires on a **write path**
that moves files on disk.

### What happens

`getMilestonePhaseFilter` finds the milestone's heading correctly (`versionScoped: true`), then
derives the section's end the same way `extractCurrentMilestone` does for issue 14 — walk forward
to the next heading of level ≤ the milestone heading that isn't a `Phase` heading and matches
`v\d+\.\d+|✅|📋|🚧`. On this repo that is `## v2.0.0 milestone (CLOSED …)` at ROADMAP.md:25, so
the scoped window (lines 5–24) is prose only — zero `### Phase N:` headings, even though the
milestone's own phase details sit at lines 2716 and 3055, past the truncated boundary.

With `milestonePhaseNums.size === 0`, `getMilestonePhaseFilter` returns a **pass-all** filter
(line 715–724) rather than an empty one — documented in its own comment as a deliberate
"safe, non-corrupting (over-inclusive, never under-inclusive) degrade" for the genuine case of a
freshly-declared milestone that has no phases yet. That comment's premise doesn't hold here: the
milestone has phases, the scan just didn't reach them. The degrade can't tell "truly empty
milestone" apart from "window truncated by issue 14," and picks the interpretation that is
maximally wrong for the truncated case — instead of matching *nothing*, it matches *everything on
disk*.

`cmdMilestoneComplete` then runs that pass-all filter against **every directory in
`.planning/phases/`**, not just the milestone's. On this repo: 48 phase directories going back to
v1.0 (2026-06-16), all counted into `{phases: 48, plans: 144, tasks: 290}`, all fed into the
accomplishments list, and — because `options.archivePhases` defaults to `true` (#1871) — all 48
**physically moved** via `archivePhaseDirectories` into `.planning/milestones/v2.3.0-phases/`,
including phases already covered by prior milestones' own archives (v1.0, v2.0).

### Reproduction and negative control

Reproduced via `gsd_run query milestone.complete "2.3.0" --name "…"` (no `--dry-run`): returned
`phases: 48` and, on disk, moved all 571 tracked files under `.planning/phases/**` into
`.planning/milestones/2.3.0-phases/`, wrote `.planning/milestones/2.3.0-ROADMAP.md` as a
byte-for-byte copy of the *entire* 3603-line ROADMAP.md (not a milestone-scoped excerpt), and
wrote `.planning/MILESTONES.md` claiming "48 phases completed" for a milestone that is actually 2
phases. Caught before any commit; reverted with `git checkout -- .planning/phases/
.planning/STATE.md` plus deleting the three newly-created untracked archive paths — nothing was
pushed or lost.

**Negative control — ruling out the version-string form as the cause.** Re-ran with `--dry-run`
passing both `"2.3.0"` (no `v` prefix, what was used the first time) and `"v2.3.0"` (the exact
string in `STATE.md`'s `milestone:` field): both produced the identical `{phases: 48, plans: 144,
tasks: 290}`. The version-section regex at roadmap-parser.cts:640 does a substring match against
heading text, so either form locates `## v2.3.0 milestone (ACTIVE…)` equally — the defect is not
a caller usage error, it is the window-truncation degrade.

### Why it matters more than issue 14

Issue 14 disarms a safety check silently but changes nothing on disk. This is the same root cause
reached from the write side: a milestone-close operation that is supposed to be scoped to 2 phases
instead archives 48, inflates the shipped-milestone record with 46 phases' worth of unrelated
accomplishments, and moves every historical phase directory out of `.planning/phases/` — which
would corrupt the working tree of any repo that doesn't happen to catch it via `git status` before
committing, exactly as issue 14's write-up predicted ("the fix for 14 should not ship without
[accounting for downstream consumers of the same truncation]").

### Suggested fixes

1. **Fix issue 14 at the source** (`extractCurrentMilestone`'s section-end scan) — this defect
   disappears as a side effect, since `getMilestonePhaseFilter` calls the same window-truncated
   logic.
2. **Independently, don't let "zero phases in window" default to pass-all.** Distinguish "the
   milestone heading was found and its window is genuinely phase-free" from "the window was
   truncated before reaching any phase heading" — e.g. by checking whether `hasPhaseHeadings`
   (already computed at line 629) is true for the *whole document* but false for just the scoped
   `roadmap` substring, and treating that mismatch as a scan failure (empty filter, or a thrown
   error) rather than an over-inclusive one. An over-inclusive default is only safe when the
   contents don't get archived/moved; `cmdMilestoneComplete` moves them.
3. **`cmdMilestoneComplete` specifically:** refuse to proceed with `archivePhases !== false` when
   `!isDirInMilestone.versionScoped || isDirInMilestone.phaseCount === 0` matched *more*
   directories than exist in the milestone's own `### Phase N:` list scanned from the *whole*
   document — a disk-vs-document cross-check in the same spirit as issue 14's suggested fix 1.

### Local workaround

None applied — the milestone was archived by hand instead (extract only phases 30/31 into the
archive files, write a correctly-scoped `MILESTONES.md` entry, skip `milestone.complete`
entirely). Reordering the ROADMAP so the active milestone isn't followed by a closed-milestone
heading before its phase details would fix this the same way it would fix issue 14, at the same
several-hundred-line restructure cost.

---

## 17. `query progress` (`cmdProgressRender`) lists every `999.*` backlog directory as a phase of the current milestone — it has neither the sentinel filter nor the milestone-window scoping its sibling `roadmap.analyze` has

**Status:** CONFIRMED — filed upstream as [#3167](https://github.com/open-gsd/gsd-core/issues/3167)
**Found:** 2026-08-04, DevFlow, checking `gsd-tools` health after the v1.0/v2.0.0/v2.3.0
retroactive milestone archival (prompted by an operator question about whether a related fix was
complete)
**Component:** `gsd-core/src/commands.cts` `cmdProgressRender` (lines 1549–1610)
**Severity:** medium — wrong output today, not yet observed to cause a wrong *action*, but the
same shape as issues 14/16 (a phase-enumeration path missing a safety filter its sibling has)

### What happens

`cmdProgressRender` implements `query progress` / `/gsd:progress`'s JSON and rendered-table output.
Unlike `cmdRoadmapAnalyze` (`roadmap.analyze`, `roadmap.cts:303`), it does not call
`extractCurrentMilestone` and does not apply the sentinel-phase filter
(`isSentinelPhase`/`major === 999`, `roadmap.cts:339-342`, applied at `roadmap.cts:355`). Instead
it does an unscoped, unfiltered directory read:

```ts
const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort(...);
for (const dir of dirs) {
  const dm = dir.match(/^(\d+(?:\.\d+)*)-?(.*)/);
  const phaseNum = dm ? dm[1] : dir;
  ...
  phases.push({ number: phaseNum, name: phaseName, plans, summaries, status });
}
```

Every directory under `.planning/phases/` — including every `999.N-*` backlog item — matches the
`phaseNum` regex and is pushed into `phases[]` unconditionally. `getMilestoneInfo(cwd)` is called
only to *label* the output (`milestone_version`, `milestone_name`); its result is never used to
scope which directories count as that milestone's phases.

### Concrete instance on DevFlow

Post-archival, `.planning/phases/` holds only 17 `999.*` backlog directories (every numbered phase
1–31 has been moved to a milestone archive or `superseded/`). `query progress` against this state
returns `milestone_version: "v2.3.0"` (a *closed* milestone) with `phases: [...]` listing all 17
backlog items as `status: "Pending"`, `plans: 0`, `summaries: 0` — none of them are phases of any
milestone, closed or otherwise. `total_plans: 0` / `total_summaries: 0` makes `percent: 0 / 0 →
0`, so this instance is not numerically dangerous (contrast issue 11's "percent: 100 while plans
remain unexecuted" — the two failure directions are both reachable from the same missing-filter
class of defect, just via different phase mixes in `phasesDir`).

### Why this is the same defect class as 14/16, not a new one

Three functions read the same `phasesDir` for overlapping purposes and apply three different
scoping disciplines:

| Function | Milestone-scoped? | `999.*` filtered? |
|---|---|---|
| `cmdRoadmapAnalyze` (`roadmap.analyze`) | yes, via `extractCurrentMilestone` | yes, `isSentinelPhase` |
| `getMilestonePhaseFilter` (issue 16) | yes, same window logic | yes, `!/^999\b/.test(...)` |
| `cmdProgressRender` (`query progress`) | **no** | **no** |

The sentinel convention is documented as engine-wide ("Mirrors the engine-wide sentinel
convention", `roadmap.cts:337`) but is not actually engine-wide — `cmdProgressRender` never
imports or applies it. This is a missing-filter defect independent of issue 14's window-truncation
mechanism (it doesn't call `extractCurrentMilestone` at all), but it's the same *shape*: a
phase-enumeration path that silently drops a safety filter its sibling has.

### Suggested fix

Share one filtering primitive across all three functions (`isSentinelPhase` /
`getMilestonePhaseFilter`'s exclusion) instead of each re-implementing phase-directory enumeration
independently — the drift here is exactly what issue 16's fix suggestion 1 argues for, generalized
to a third call site. Minimally, `cmdProgressRender` should skip any `dir` matching
`isSentinelPhase(phaseNum)` before pushing it into `phases[]`, and ideally should scope to
`milestone`'s own phases the way `getMilestonePhaseFilter` does, rather than listing every
directory in `phasesDir` regardless of which (if any) milestone it belongs to.

### Local workaround

None needed for correctness (DevFlow doesn't act on `query progress`'s `phases[]` list
programmatically), but the output is actively misleading if read by a human or an agent deciding
what to work on next. No workaround applied — filed for the record only.

---

## 18. `buildPhaseCompletionProjection` requires `planCount > 0` to ever check verification, so a phase with zero plans is permanently reported `phase_complete: false` / `verification_status: "not_required"` even when a real, passing `*-VERIFICATION.md` exists

**Status:** CONFIRMED — filed upstream as [#3168](https://github.com/open-gsd/gsd-core/issues/3168)
**Found:** 2026-08-04, DevFlow, closing Phase 32 (`gsd-hygiene` milestone) — a docs-only phase
whose goal was already satisfied by a prior write, so it deliberately went through
`/gsd-discuss-phase` and a standalone verification with no `/gsd-plan-phase` / `/gsd-execute-phase`
step, then `phase.complete` succeeded and `.planning/phases/.../*-VERIFICATION.md` existed with
`status: passed`
**Component:** `gsd-core/bin/lib/init.cjs`, `buildPhaseCompletionProjection` (bundled around
line 122; feeds `init.manager`'s `phases[].phase_complete` / `verification_status`, which
`/gsd-complete-milestone`'s `verify_readiness` step gates on)
**Severity:** medium — a false-negative safety gate, same shape as issues 14/16/17 (a completion
predicate silently wrong for a phase shape gsd-core didn't anticipate), but on a *read* path that
blocks forward motion rather than a *write* path that corrupts state

### What happens

```js
function buildPhaseCompletionProjection(cwd, phaseNumber, phaseDir, planCount, summaryCount, slashRuntime) {
    const implementationComplete = planCount > 0 && summaryCount >= planCount;
    const verificationStatus = implementationComplete
        ? readVerificationStatus(phaseFullDir, { runtime: slashRuntime, phaseNumber })
        : { status: 'not_required', next_action: '', next_command: '' };
    ...
    const phaseComplete = implementationComplete && verificationPassed;
```

`implementationComplete` requires `planCount > 0`. When it's `false`, `readVerificationStatus` is
never called — `verification_status` is hardcoded to the sentinel `"not_required"` regardless of
whether a `*-VERIFICATION.md` file exists on disk and regardless of its actual `status:` value.
`phase_complete` is then `false` unconditionally, because it's `implementationComplete &&
verificationPassed` and the first operand can never be `true`. There is no code path by which a
zero-plan phase can ever report `phase_complete: true`, no matter what its VERIFICATION.md says.

### Concrete instance on DevFlow

Phase 32 had `plan_count: 0` by design — its own `CONTEXT.md` decision (D-01) was "verification
only, no plan needed" because the phase's goal had already been satisfied by an earlier,
unrelated write (`gsd-roadmapper`'s milestone-creation commit). A `gsd-verifier` subagent was
spawned directly (bypassing the normal execute-phase→verify pipeline, using `verify-phase.md`'s
"Option B: Success Criteria from ROADMAP.md" fallback since there was no PLAN frontmatter to read
`must_haves` from) and wrote `32-VERIFICATION.md` with `status: passed`, `score: 4/4`.
`gsd-tools query verification.status <dir>` confirms this directly: `{"status": "passed", ...}`.
But `gsd-tools query init.manager` reported, for the same phase, at the same commit:
`"plan_count": 0, "verification_status": "not_required", "phase_complete": false,
"completion_status": "incomplete"` — flatly contradicting the file that function is supposed to be
reading. `gsd-tools query phase.complete 32` (a separate code path — it gates on
`readVerificationStatus` directly, not through `buildPhaseCompletionProjection`) succeeded and
correctly marked the phase complete in ROADMAP.md/STATE.md/REQUIREMENTS.md — so the *actual*
completion logic disagrees with the *projection* logic `init.manager` exposes for exactly this
kind of phase.

### Why it matters

`/gsd-complete-milestone`'s `verify_readiness` step computes `ALL_PHASES_VERIFIED` from
`init.manager`'s `.phases[] | (.phase_complete == true and .verification_status == "passed")`.
A milestone whose only phase is a legitimately-complete, legitimately-verified, zero-plan phase
would fail this check and force the operator into the "override / re-verify / abort" branch for a
phase that is not actually unverified — the workflow's own safety gate misfires in the direction
of false alarm, on a phase shape (verify-only, no code) that this project's own conventions
already produce deliberately (Phase 22's SUMMARY/VERIFICATION were similarly backfilled after the
fact, per `PROJECT.md`).

### Suggested fixes

1. **Read verification independently of `implementationComplete`.** Call
   `readVerificationStatus(phaseFullDir, ...)` unconditionally, and let `phase_complete` be
   `verificationPassed` alone (or `verificationPassed && (planCount === 0 || summaryCount >=
   planCount)`, if plan/summary parity should still gate phases that *do* have plans). A
   `*-VERIFICATION.md` with `status: passed` on disk is stronger evidence of completion than an
   absence of plan files is evidence of incompleteness.
2. **Recognize a documented zero-plan phase explicitly**, e.g. a `plans: none-required` or similar
   marker the verifier/CONTEXT.md can set, so `implementationComplete` has a legitimate `true`
   path that doesn't require `planCount > 0`.

### Local workaround

Hand-authored a minimal, explicitly-labeled-as-backfilled `{phase}-01-PLAN.md` /
`{phase}-01-SUMMARY.md` pair after the fact, describing the discussion/verification work that had
already happened (not fabricated tasks), purely so `planCount > 0` and
`summaryCount >= planCount` would hold and `readVerificationStatus` would actually run and find
the real, already-passing report. Required re-committing the VERIFICATION.md file *after* the
backfilled SUMMARY so `findStaleVerificationSummary`'s commit-time comparison didn't then flag it
stale (the SUMMARY's mtime/commit-time was, correctly, later than the original VERIFICATION.md
commit). Operator-approved (2026-08-04) rather than silently applied — this workaround manufactures
a PLAN/SUMMARY pair the phase's own CONTEXT.md explicitly decided was unnecessary, solely to
satisfy a tooling assumption, which is exactly the kind of provenance-blurring this project's own
conventions try to avoid; recorded plainly in both documents' bodies for that reason.

---

## 19. `code-review.md`'s `DIFF_BASE` greps commit messages for a bare phase number, so an unrelated substring match reaches back into old history and expands the review scope to the whole project

**Status:** DUPLICATE — do not file. Already open upstream as
[open-gsd/gsd-core#2989](https://github.com/open-gsd/gsd-core/issues/2989), created 2026-08-02 by
`0xdhx`, **two days before this write-up**. Same component, same mechanism (unanchored
`--grep="${PADDED_PHASE}"`, `tail -1` selecting the oldest substring match as the base). Their
reproduction is starker than ours: *"in this repo, 2153 of 5299 commits match phase 7."* Checked
2026-08-05 via `gh search issues --repo open-gsd/gsd-core DIFF_BASE`; #2989 was still `OPEN`.

Keep this entry as the **DevFlow-side evidence record** — it carries a concrete local instance
(#2989 does not), and the recovery below is what an operator here needs. But route any upstream
discussion to #2989 rather than opening a second issue.

Found 2026-08-04 during DevFlow phase 33's post-execution code-review gate; recurred visibly
2026-08-05 when the phase-33 review resolved its base to `ad3b37d docs(12-10): …` — a **phase-12
commit from 2026-07-08**, roughly a month of unrelated history pulled into the review scope. The
orchestrator caught it by cross-checking the SUMMARY-derived file list against `git diff` from the
true `git merge-base develop HEAD`; both returned the same 7 files, which is what exposed the
computed `DIFF_BASE` as wrong rather than merely wide.

### What happens

`compute_file_scope` — and, identically, the fallow pre-pass's `FALLOW_BASE` — derives the review's
diff base like this:

```bash
PHASE_COMMITS=$(git log --oneline --all --grep="${PADDED_PHASE}" --format="%H" 2>/dev/null)
DIFF_BASE=$(echo "$PHASE_COMMITS" | tail -1)^
```

`--grep` takes an unanchored regex and `PADDED_PHASE` is a bare number, so the pattern matches that
digit string **anywhere** in any commit message — including inside longer numbers and inside
identifiers. `tail -1` then selects the *oldest* match in the entire repository as the base.

### Concrete instance on DevFlow

For phase 33 the pattern was `33`. Measured on this repo at HEAD `5d7f622`:

| Pattern | Commits matched |
|---|---|
| `--grep="33"` (as shipped) | 71 |
| `-E --grep="^[a-z]+\(33[-)]"` (anchored to the commit convention) | 32 |

The oldest of the 71 was `ad3b37d docs(12-10): clarify timezone-safe second-restoration`. It
contains no phase-33 reference at all — the match is the `33` inside **`parse_rfc3339ish`**, a
function name in the body text. `DIFF_BASE` became its parent, `b6b2a7d test(12-09): …`, roughly
twenty phases before the phase under review.

The resulting scope, under the workflow's own exclusion list:

| Base | Files in scope |
|---|---|
| `b6b2a7d` (grep-derived) | **201** |
| `7b55fce` (`git merge-base origin/develop HEAD`) | **7** |

Seven is correct, and it matches the SUMMARY `key-files` extraction exactly.

### Why the existing guards do not catch it

- The `#2666` SUMMARY-vs-diff cross-check assumes the diff is authoritative and the SUMMARY may be
  partial. When the base is wrong that polarity is backwards: it treats all 194 extra files as
  files the SUMMARY *missed*, **adds them to the review scope**, and prints a confident
  `Warning: SUMMARY scope was missing N changed file(s)`. A correct 7-file scope is silently
  converted into a 201-file one.
- The `> 50 files` guard does fire, but only downgrades `deep` to `standard`. It never questions
  the base — it reads as "this phase was large", not "this base is wrong".
- Nothing compares the derived base against the phase branch's actual fork point, which is
  available and O(1).

### Suggested fixes

1. **Anchor the grep to the commit-message convention.** GSD's own commits are
   `type(NN-PP): subject` / `type(NN): subject`, so `-E --grep="^[a-z]+\(${PADDED_PHASE}[-)]"` is
   both anchored and specific. On this repo that alone drops 71 matches to 32, all genuine.
2. **Prefer the branch fork point.** `git merge-base <base-branch> HEAD` is exact and needs no
   message convention; fall back to the grep only on a detached or non-branch checkout.
3. **Sanity-gate the derived base.** If the diff exceeds some multiple of the SUMMARY scope, refuse
   the cross-check and warn that the base looks wrong instead of silently widening the review.

Fixes 1 and 2 are independent and either closes it; 2 is the stronger one because it does not
depend on commit hygiene.

### Local workaround

Compute the base by hand and pass the scope to the reviewer explicitly:

```bash
git merge-base origin/develop HEAD    # 7b55fce on phase 33
```

Then diff against it and compare with the SUMMARY-extracted list. On phase 33 the two methods
returned the same 7 files — that agreement is what established the SUMMARY scope was complete and
the grep-derived base was the broken input, rather than the other way round. The orchestrator
passed the merge-base to `gsd-code-reviewer` in the `<config>` block along with an explicit
instruction not to re-derive it with `--grep`.

---

## Preventing recurrence — the meta-finding (2026-07-31)

Two entries in this file (**1** and **6**) recurred in phase 28, three days after being written up
here accurately and in detail. Nothing about the write-ups was wrong. They simply had no effect,
because **a document is not a control**: no workflow step reads this file, and the failure modes
both occur inside automated steps that run without a human in the loop.

The same lesson phase 28 itself produced, in a different register: 776 passing tests did not catch a
broken feature, because every test asserted a prediction rather than an observation. Here, an
accurate issue log did not catch a repeat defect, because logging is not enforcement.

**Concrete local guards worth adding (none require upstream changes):**

| Risk | Guard |
|---|---|
| Phase commits landing on `develop` | Set `git.branching_strategy: "phase"` (**not** top-level `branching_strategy` — that key is rejected) so `execute-phase` creates a branch off `origin/HEAD` before any plan runs. **Applied 2026-07-31**, together with `git.phase_branch_template: "feature/phase-{phase}"` to match this repo's own convention; verified `init.execute-phase` now resolves `branch_name: feature/phase-28`. |
| Same, as a backstop | A `pre-commit` hook that refuses a commit touching `.planning/phases/**` while `HEAD` is on `main`/`develop` |
| `[ci skip]` wedging a PR | After `/gsd-ship`, assert `gh pr view <n> --json mergeStateStatus` is not `BLOCKED` with an empty rollup; if it is, amend the ship note and force-push with lease |

**Filing status:** entries 1–5 are filed and have open fix PRs #2818–#2814; entry 8 was already
fixed upstream by #2638. Entry 9 is filed as [#3052](https://github.com/open-gsd/gsd-core/issues/3052)
and awaits maintainer triage; entries 6, 7, and 10 remain unfiled with the current validation status
recorded above.

## Contribution Status and Next-Slice Assessment (2026-08-04)

### Phase 01 disposition

Phase 01 addressed entry 9 only: the same-date `state.planned-phase` activity-conflict defect. The
focused repair and final-artifact regression are complete in the personal planning archive; the
upstream bug report is [#3052](https://github.com/open-gsd/gsd-core/issues/3052). Do not open the
fix PR until a maintainer confirms the bug with the required `confirmed-bug` label.

### Candidate next slices

1. **Entry 12 — `state.validate` drift detection (recommended):** High-severity, deterministic,
   standalone defect. The validator's disk scan is gated on a field the shipped template does not
   emit, making its primary failure path structurally unreachable.
2. **Entry 11 — progress falsely reports 100%:** Medium-high impact on the central progress signal.
   The aggregate summary/plan ratio can report completion while execution remains outstanding.
3. **Entries 14, 15, and 16 — milestone-scoping safety cluster:** Treat as one dependency-aware
   slice. Entry 14 disables a resume safety gate; entry 15 becomes a wrong-routing bug when 14 is
   fixed; entry 16 turns the same scoping weakness into destructive cross-milestone archival.

Entry 10 remains an enhancement bundle and requires upstream approval before implementation. Entries
13, 17, and 18 are independently reproducible ready bugs, but rank behind the safety and validator
work above.

---

*Created 2026-07-28 during DevFlow phase 25. Updated 2026-07-31 during phase 28 with recurrence
records for entries 1 and 6, and the "Preventing recurrence" section. Updated 2026-08-02 during
phase 30 planning with entries 8 (`query commit` double-joins absolute `--files` paths) and 9
(`state.planned-phase` frontmatter resync has no preserve-guard for `status`/`last_activity_desc`),
both root-caused against live source and both confirmed 2/2 recurring. Updated 2026-08-02 with entry
10 (model/effort resolve through different mechanisms at different times) — an enhancement request
rather than a defect report, covering the `~/.gsd/defaults.json` model/effort asymmetry, the
tier-default loss on partial effort config, the `resolve-execution` effort divergence, and the
missing `inherit` for effort. Updated 2026-08-03 during DevFlow phase 31 creation with entries 13
(`phase.add` inserts at the file's last `---`, filing the new phase inside archived prose) and 14
(`roadmap.analyze` returns `phase_count: 0` with no error while phase directories exist, silently
disarming `/gsd:progress --next`'s resume-incomplete-phase invariant). Entry 14 was isolated with a
negative control after a first, wrongly-constructed control appeared to refute it. Updated
2026-08-04 during DevFlow's v2.3.0 milestone close with entry 16 (`milestone.complete`'s pass-all
degrade inherits entry 14's window truncation and archived all 48 project phases instead of the
milestone's 2 — reproduced live, caught before commit, reverted with no data loss). Updated
2026-08-04 (same day, retroactive v1.0/v2.0.0 archival) with entry 17 (`query progress`
/ `cmdProgressRender` lists every `999.*` backlog directory as a phase, missing both the
milestone-window scoping and the sentinel filter its siblings `roadmap.analyze` and
`getMilestonePhaseFilter` both have — root-caused directly against `commands.cts:1549-1610`).
Updated 2026-08-04 (same day, closing DevFlow's `gsd-hygiene` milestone) with entry 18
(`buildPhaseCompletionProjection` requires `planCount > 0` before it will even read a phase's
`*-VERIFICATION.md`, so a legitimately-complete zero-plan phase is reported `phase_complete:
false` forever — worked around locally with an operator-approved, explicitly-labeled backfilled
PLAN/SUMMARY pair rather than silently overriding the gate). Updated 2026-08-04 after Phase 01:
entry 9 was filed as upstream issue #3052, and the next-slice assessment prioritized entry 12,
followed by entry 11 and the linked 14/15/16 milestone-safety cluster.
Update `Status:` and record the issue link when each entry is filed upstream.*

---

## 20. `parseDecisions`' parse-miss guard fires on a *cross-reference* to another decision, and a single miss zeroes the whole coverage analysis — blocking `/gsd-plan-phase` on a phase whose decisions are in fact 15/15 covered

**Status:** CONFIRMED — filed upstream as [#3169](https://github.com/open-gsd/gsd-core/issues/3169)

Found 2026-08-05 during DevFlow Phase 34 planning. `/gsd-plan-phase 34`'s §13a Decision Coverage
Gate — which is **blocking** (`exit 1`) — returned:

```json
{ "passed": false, "skipped": false, "reason": "could-not-parse",
  "total": 15, "covered": 0, "uncovered": [], "message": "…one or more `- **D-NN …**` bullets appear malformed…" }
```

with two warnings naming the offending bullets. The phase's decisions were **not** malformed and
**not** uncovered: an independent recount across the five PLAN.md files found all 15 of D-01…D-15
cited, with two negative controls holding (a nonexistent `D-99` scored 0; `DOGFOOD-04` did not
false-match `D-04`). After the cosmetic reformat below, the same gate returned
`passed: true, total: 15, covered: 15` — confirming the count two independent ways.

### What happens

`src/decisions.cts:206` guards against a decision bullet that matched none of the three declaration
patterns:

```js
if (/^\s*-\s+\*\*D-/.test(line)) { flush(); parseMisses += 1; console.warn(...); continue; }
```

That test matches **any** bullet whose bold run merely *begins with* `D-`. It does not require a
decision ID, and — the actual problem — it does not distinguish a **declaration** from a
**cross-reference to another decision**. The three declaration patterns
(`bulletColonRe:62`, `bulletEmDashRe:72`, `bulletTitledColonRe:85`) all require a `:` or an
em/en-dash inside the bold run, so a citation bullet naturally misses all three and lands on the
guard.

The two bullets that tripped it were plain prose inside D-15's body, listing that decision's
consequences for its siblings:

```markdown
  - **D-06's fix does not close this.** Gating the `Passed` arm on the derived status passes
    cleanly here. Criterion 3 and criterion 4 are separate deliverables.
  - **D-13 (999.76) must not land without this fix.** Moving Layer 0 discovery to the execution
    root makes `decided_by_layer == Some(0)` common rather than rare…
```

### Why the blast radius is larger than a warning

`parseMisses > 0` forces `reason: "could-not-parse"`, which **short-circuits the coverage analysis
entirely** — the handler returns `covered: 0` and `uncovered: []` without ever comparing decisions
against plans. So the failure is indistinguishable, from the gate output alone, between "the
document has a formatting nit" and "not one decision is covered." An operator reading
`total: 15, covered: 0` would reasonably conclude the plan set dropped every decision. It did not.

The `uncovered: []` beside `covered: 0` is the tell — a genuine total-coverage failure would list
15 uncovered IDs. That inconsistency is what makes the false positive detectable at all, and it is
worth preserving deliberately rather than by accident.

### Recovery (what was done here)

Reformatted the two bullets so the bold run no longer *starts* with `D-`, moving the reference
inside: `- **Criterion 3 (D-06's fix) does not close this.**` and
`- **999.76 (D-13) must not land without this fix.**`. Not one word after the bold run changed and
both `D-NN` references survive; the diff is three lines, formatting only. Operator-approved rather
than applied silently, because `34-CONTEXT.md` is a twice-adversarially-reviewed decision document
whose amendment discipline is explicit.

### Suggested fix

Two independent changes, either of which closes it:

1. **Tighten the guard** to require a decision-ID shape — e.g. `/^\s*-\s+\*\*D-\d/` plus a
   look-ahead for one of the three separators — so a bullet that merely cites `D-NN` in prose is
   treated as body text, not a malformed declaration.
2. **Do not let `parseMisses` zero the analysis.** Run the coverage comparison over the decisions
   that *did* parse and report `parseMisses` alongside it, so the gate can distinguish "1 bullet
   unreadable, 15/15 of the readable ones covered" from "0 covered." As written, one cosmetic miss
   is indistinguishable from total failure — and the gate is blocking.

A cross-reference between decisions is a natural shape in any phase whose decisions interact; this
one is not exotic. DevFlow's Phase 34 produced it from an ordinary "consequences for the other
decisions" list.

---

## 21. `milestone.complete`'s accomplishment extraction grabs the first bolded run after the first heading, not a summary

**Status:** CONFIRMED — filed upstream as [#3170](https://github.com/open-gsd/gsd-core/issues/3170)
**Found:** 2026-08-06, DevFlow v2.4.0 milestone close (`milestone.complete "v2.4.0" --name "..."`).
**Component:** `gsd-core/bin/lib/core-utils.cjs` (`extractOneLinerFromBody`), consumed by
`gsd-core/bin/lib/milestone.cjs:563` and `gsd-core/bin/lib/commands.cjs:1245`.
**Severity:** medium — no data loss and nothing downstream gates on the extracted text, but it
silently replaces a human-meaningful milestone changelog entry with noise, and the failure looks
identical to success (a non-empty, plausible-looking bullet list is returned every time).
**Reproducibility: confirmed**, deterministic given the SUMMARY.md content, not environment-specific.

### What happens

`gsd_run query milestone.complete "v2.4.0" --name "Resume Unattended Dogfooding"` returned an
`accomplishments` array whose entries included:

```
"1. [Rule 1 - Bug] Task 2's three new tests spawned a real agent CLI process on first attempt"
"NeutralPath"
"The production fix is one expression"
"The production change is two arguments."
"This is the most important thing in this summary."
"EXIT=0"
```

None of these describe what the phase actually delivered. They were written verbatim into
`MILESTONES.md`'s `## v2.4.0 ...` entry — the permanent historical record of the release — until
caught and hand-rewritten before commit.

### Root cause

`extractOneLinerFromBody` (`core-utils.cjs:71`) does not look for a summary-specific heading. It
matches the **first** heading anywhere in the body, then takes the first bolded run immediately
after it:

```js
const match = body.match(/^#[^\n]*\n+\*\*([^*\n]+)\*\*([^\n]*)/m);
```

There is no requirement that this heading be a "Summary", "Accomplishments", "Overview", or any
other section whose first bold text is likely to describe the deliverable. On a SUMMARY.md whose
document-order first heading is something incidental — a numbered rule list, a task breakdown, a
deviation note — the function faithfully returns the first thing that happens to be bold under it,
which can be a rule label (`**Rule 1 - Bug**`), a code identifier (`**NeutralPath**`), or a
fragment of a sentence describing something true but not summary-shaped (`**The production fix is
one expression**`).

Frontmatter `one-liner` is checked first and would bypass this entirely (`milestone.cjs:563`:
`(typeof rawOneLiner === 'string' ? rawOneLiner : '') || extractOneLinerFromBody(content)`), but none
of the six SUMMARY.md files in this milestone declared one — the fallback is not a rare path, it is
the only path for any SUMMARY authored without that specific frontmatter field.

### Why this is the same failure shape as entry 12

A heuristic that cannot distinguish "found the real summary" from "found the first bold text that
happened to be nearby" reports success — a non-null, populated string — in both cases. There is no
signal that would tell an operator the extraction missed, short of reading the generated
`MILESTONES.md` entry against the source SUMMARYs by hand, which is the only reason this was caught
here.

### Suggested fixes (1 alone closes it; 2 and 3 are hardening)

1. **Anchor to a specific heading**, e.g. require the heading text to match `/summary|overview|
   accomplish/i` before extracting from beneath it, falling back to `null` (not the wrong text) if
   no such heading exists.
2. **Prefer a dedicated frontmatter field and treat its absence as a gap to report, not paper over.**
   `milestone.complete` could emit `"accomplishments_incomplete": true` (or name which phases
   contributed no usable one-liner) rather than silently filling the slot with whatever the regex
   found.
3. **Sanity-gate the extracted text.** A one-liner beginning with a digit-dot list marker, or under
   ~4 words with no verb, is more likely a stray label than a summary sentence — reject and fall
   through to `null` rather than accept it.

### Local workaround

Read the generated `accomplishments` array (or the `MILESTONES.md` entry it produces) against the
source `*-SUMMARY.md` files before committing, and hand-rewrite any entry that doesn't read as a
real accomplishment. Done for v2.4.0 (`.planning/MILESTONES.md`, commit `ff4ebd0` in DevFlow).

---

## `state.record-session` mangles `milestone_name` when the ROADMAP heading carries a parenthetical

**Status:** CONFIRMED — filed upstream as [#3171](https://github.com/open-gsd/gsd-core/issues/3171)

**Found:** 2026-08-06, DevFlow, during `/gsd-discuss-phase 35`.

**Also reproduces in `state.begin-phase`:** 2026-08-07, DevFlow, during `/gsd-execute-phase 35` —
same heading, byte-identical wrong value. So this is not one verb's bug: at least two verbs
re-derive `milestone_name` from the heading, and fix (1) below has to cover the shared helper
rather than a single call site.

**`state.begin-phase` additionally clobbers `current_phase_name` with the directory slug.** It
writes whatever `--name` it is handed, and `init.execute-phase` returns the phase *slug* in its
`phase_name` field (`loop-termination-and-baseline-correctness-999-77-999-78-999-`), not the display
name. An orchestrator wiring one into the other — the obvious wiring, and what the execute-phase
workflow's own template implies — turns `Loop-Termination and Baseline Correctness` into that slug
on every phase start. Either `init.execute-phase` should return display name and slug as distinct
fields, or `begin-phase` should reject a value that looks like a slug.

**Severity: Low** — cosmetic in STATE.md's frontmatter, but it is silent, it recurs on *every*
session record and *every* phase start, and it degrades a field other tooling reads.

### What happens

`gsd-tools query state.record-session` re-derives `milestone_name` from the active milestone's
`## ` heading in `ROADMAP.md` instead of preserving the existing frontmatter value. Given DevFlow's
heading:

```
## 🚧 v2.5.0 milestone (Loop-Termination and Release Hardening, ACTIVE — declared 2026-08-06)
```

it wrote:

```yaml
milestone_name: milestone (Loop-Termination and Release Hardening, ACTIVE — declared 2026-08-06)
```

overwriting the correct prior value `Loop-Termination and Release Hardening`. The parse appears to
strip the emoji and the version token, then take *the entire remainder* as the name — so the literal
word `milestone`, the status marker, and the declaration date all end up inside the name.

### Why it is not self-correcting

Nothing downstream validates the field, and the write happens on every `state.record-session` call.
The result still looks plausible (it contains the real name as a substring), so it reads as correct
at a glance. Each subsequent session re-derives from the same heading, so it stays wrong rather than
drifting back.

Note the interaction with the milestone-window fragility already recorded for `roadmap.analyze` /
`deriveProgressFromRoadmap`: these parsers all key off the same `## ` heading, and this project's
convention of putting status and dates in that heading is what exposes the weak parse.

### Suggested fixes (1 alone closes it)

1. **Do not re-derive a field that already has a value.** `milestone_name` is set at milestone
   declaration; `record-session` has no reason to touch it.
2. **If it must be derived, anchor the extraction.** Take the text between the version token and the
   first `(` or `,`, rather than "everything after the version token".
3. **Round-trip check.** If the derived value differs from the persisted one, report it rather than
   overwrite silently — an operator can then say which is right.

### Local workaround

After any `state.record-session`, diff `.planning/STATE.md` and restore `milestone_name` by hand.
Done for Phase 35's context session.

---

## 22. `gsd-planner` emits `<automated>` acceptance commands it never executed — an unrunnable check reads as a verified one

**Status:** APPROVED — filed upstream as [#3172](https://github.com/open-gsd/gsd-core/issues/3172)

**Found:** 2026-08-07, DevFlow, during `/gsd-execute-phase 35`.
**Severity: Medium** — not cosmetic. The defect is in the artifact that *defines* what "verified"
means for a plan, and it degrades silently in the direction of false confidence.

### What happens

`/gsd-plan-phase 35` produced six plans containing **21 occurrences** of:

```
cargo test -p devflow --lib <module>::…
```

`devflow` is a binary-only package (`devflow[bin]`, no `src/lib.rs`). Cargo rejects the command
before running anything:

```
error: no library targets found in package 'devflow'
```

These were not incidental mentions. They sat inside `<automated>` blocks — the machine-readable
acceptance criteria a plan is judged against — across four of the six plans (35-01: 5, 35-02: 4,
35-04: 6, 35-05: 6). The sibling form `-p devflow-core --lib` *is* valid, so the error is not a
blanket misunderstanding of cargo; it is a package-shape fact the planner did not check.

### Why it matters more than the wrong flag

A plan's `<automated>` block is the thing that decides whether work is done. A command that cannot
run has no failing direction, so nothing about it is falsifiable. It reads as rigour and delivers
none. Three separate executors each rediscovered the same defect independently, on the clock, and
each had to invent a substitute command — meaning the *actual* acceptance criteria for those plans
were improvised at execution time rather than reviewed at planning time.

It is the same failure shape as entry 20: a check that appears to measure something and doesn't.

### What made it survivable here

Cargo exits non-zero, so this failed loudly rather than passing green. That is luck, not design —
the identical class of error with a command that exits 0 on a no-op (e.g. `cargo test --exact` on a
name matching nothing, already recorded in DevFlow's own CLAUDE.md) would have produced a silent
false pass.

### Suggested fixes

1. **Execute every `<automated>` command once at plan time** and record its exit status in the plan.
   A command that cannot run should block the plan, not ship inside it.
2. **Failing that, validate the shape** — resolve `cargo metadata` for the workspace and reject
   `--lib` against a package with no lib target, `--bin X` against a package with no such bin, etc.
3. **Require a stated failing direction.** For each acceptance command, the plan should say what
   output constitutes failure. A command with no expressible failure mode is not an acceptance test.

### Local workaround

Corrected 35-04 and 35-05 by hand to `-p devflow --bin devflow` before dispatching their waves, and
recorded the trap in DevFlow's CLAUDE.md verification-habits section.
