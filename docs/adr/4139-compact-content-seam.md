# ADR-4139: The compact-content seam — shrink the eager window, never the guarantee

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-09-06 |
| **Issue** | [#4139](https://github.com/open-gsd/gsd-core/issues/4139) |
| **Phase-0 sub-issue** | [#4400](https://github.com/open-gsd/gsd-core/issues/4400) |
| **Implementation phases** | [#4401](https://github.com/open-gsd/gsd-core/issues/4401) · [#4402](https://github.com/open-gsd/gsd-core/issues/4402) · [#4403](https://github.com/open-gsd/gsd-core/issues/4403) · [#4404](https://github.com/open-gsd/gsd-core/issues/4404) · [#4405](https://github.com/open-gsd/gsd-core/issues/4405) · [#4406](https://github.com/open-gsd/gsd-core/issues/4406) · [#4407](https://github.com/open-gsd/gsd-core/issues/4407) · [#4408](https://github.com/open-gsd/gsd-core/issues/4408) |
| **Constrained by** | [ADR-1610](1610-workflow-agent-size-budget-ratchet.md) Decision 4 · [ADR-3646](3646-per-task-content-resolution-seam.md) §Context · [ADR-3889](3889-process-exit-contract.md) · [ADR-3942](3942-emitted-drift-ack-commit-trailer.md) |
| **Corrects** | [ADR-3646](3646-per-task-content-resolution-seam.md) §Context — its citation of [#3647](https://github.com/open-gsd/gsd-core/issues/3647) as "still open" is stale; #3647 closed 2026-09-01 |

> **Evidence note.** Every count in this ADR was measured against the tree at `origin/next`
> (`708d9a0b82`), not inferred from the issue text. Where this ADR contradicts #4139's own
> description of a mechanism, the contradiction is stated as such and the measurement is given.
> The issue is the requirement; it is not a source of truth about the tree.

## Context

### What #4139 asks for

A per-project boolean that makes GSD load token-minimized variants of its own shipped prompt
content, across four token streams: (1) workflow instruction files, (2) agent-skill payloads,
(3) subagent spawn prompts, (4) planning-artifact templates. Approved 2026-09-01 with three
conditions: rename off the sports metaphor, pilot before proliferation, and an end-to-end accuracy
spot-check in the pilot.

### The mechanism as filed does not reach the stream it exists for

#4139 states its load mechanism as: *"one shared gate reference file checks the config key and
directs the orchestrator to Read the golfed variant. `@`-includes are untouched (they resolve
statically)."*

The last clause is where it fails. **The top-level workflow files themselves are the
`@`-includes.** `commands/gsd/plan-phase.md` reaches its workflow this way:

```
<execution_context>
@~/.claude/gsd-core/workflows/plan-phase.md
@~/.claude/gsd-core/references/ui-brand.md
</execution_context>
```

**58 of 72** shipped `commands/gsd/*.md` carry an `@~/.claude/gsd-core/workflows/<name>.md` line in
`<execution_context>`, and 58 of 72 `skills/*/SKILL.md` twins carry the same. Of the 14 that do
not, exactly one — `discuss-phase` — reaches a workflow file another way: its `<execution_context>`
says *"Workflow files are loaded on-demand in the `<process>` section below — not upfront"*, and its
`<process>` block picks between three workflow files by a `config-get workflow.discuss_mode` call.
The other 13 (`graphify`, `mempalace-capture`, `mempalace-recall`, the six `ns-*` commands,
`plan-review-convergence`, `review-backlog`, `surface`, `workstreams`) carry no top-level workflow
file at all.

`manager` and `pause-work` are **inside** the 58, not outside it — both carry a plain eager
`@`-include (`commands/gsd/manager.md:29`, `commands/gsd/pause-work.md:24`). Earlier research on
this epic grouped them with `discuss-phase` as runtime-`Read` commands; that grouping is wrong, and
it matters, because it would have made the deferred-load precedent look three times broader than it
is. **`discuss-phase` is the only precedent, and it is a single file.**

`@` is expanded by the host as static text substitution at load, before any project config exists
in context. That is not this ADR's inference; it is stated by ADR-1610 Decision 4 (*"because
`@~/.claude/gsd-core/references/...` imports are loaded **eagerly**, moving prose into an eagerly
@-imported reference shrinks the measured file while leaving (or growing) total loaded context —
that is gaming the proxy"*), by #4139's own rejected-alternative 4, and by the triage addendum's
claim-verification pass against the host's memory documentation.

So by the time a gate line *inside* `plan-phase.md` could be evaluated, all 98,290 bytes of
`plan-phase.md` are already in context. Reading a smaller variant afterwards adds tokens. No gate
reference file, however written, changes this — the constraint is upstream of every instruction the
file contains.

| Content | Bytes | Reachable by an in-content gate? |
|---|--:|---|
| The 75 distinct top-level `gsd-core/workflows/*.md` files named by an eager `@` | **1,517,683** | **no** |
| `workflows/<name>/{modes,steps,templates}/*.md` (runtime `Read`) | 358,482 | yes |
| `gsd-core/templates/**` (referenced by path) | 273,589 | yes |
| `agents/*.md` via the `gsd_run query agent-skills` CLI seam | 704,846 | yes (code seam) |

Measured at `origin/next` (`708d9a0b82`). The 58 command files name 75 distinct workflow files
between them, because several `@`-include more than one.

The unreachable slice is the largest one — larger than the other three combined — and it is the
headline of the feature.

### The obvious fix, and why it is not the one taken

The obvious response is to convert those 58 `<execution_context>` blocks from an eager `@`-include
to a config-gated runtime `Read`. That delivers the coverage. It also inverts the fail-safe
direction: today a miss is impossible because the host substitutes the text; afterwards a `Read`
that does not fire leaves the orchestrator holding a command name, an objective paragraph, and no
procedure.

That shape has already been examined in this repo and rejected. [ADR-3646](3646-per-task-content-resolution-seam.md)
§Context rejected a prose-dispatched content-resolution step precisely because a missed dispatch
and a legitimate fall-back are indistinguishable at the point of failure, so the executor proceeds
on the wrong content while believing it authoritative. Its Decision 2 chose a real subprocess with
a real exit code instead — *"a real process exit code the calling loop cannot fail to observe the
way it can fail to execute a prose instruction."*

**The state of ADR-3646's cited evidence has moved, and this ADR records the correction.** ADR-3646
§Context cites #3647 as *"filed the same day as #3646, still open"* — accurate on 2026-08-27, stale
now. #3647 was **closed 2026-09-01** as a duplicate of #3606, on the strength of PR #3687, which
fixed both call sites the report named: `execute:wave:pre` now does generic contribution dispatch,
and `execute:wave:post` now dispatches every `kind == "step"` hook generically instead of filtering
to `kind == "gate"`. ADR-3646's own reasoning anticipated this and does not depend on it — it
rejected sequencing behind #3647 explicitly, *"because sequencing behind an open reliability issue
with no committed fix date blocks #3646 indefinitely on someone else's timeline for no
architectural gain"* — so its Decision stands unchanged. Only its Context needs the footnote.

But #3647's closure does **not** retire the concern that matters here, and reading the closure as a
clean bill of health would be a mistake. The triage diagnosis on that issue attributes the observed
1-of-4 rate to **two co-present mechanisms**, and only one of them was fixed:

> *"`contribution`-kind hooks … are folded as natural-language text into the executor agent's own
> prompt at spawn time, never iterated by the wave:post loop at all, and whether an LLM executor
> acts on an embedded prose instruction is exactly the kind of variance that produces a 1-of-3 hit
> rate. Both the deterministic code-level exclusion (matches #3606) and prose-instruction variance
> (a separate, architectural property) can be present in the same evidence at once."*

PR #3687 removed the deterministic filter. The prose-instruction variance was named as *a separate,
architectural property* and nothing has been shipped against it. It was never independently
measured either — it is an explanation offered for the residual, not a rate. So the honest position
is: **prose dispatch is not guaranteed, the magnitude is unknown, and no evidence exists that would
let this ADR treat it as negligible.**

### The premise that does not survive checking

The natural argument for accepting that risk is that the feature is opt-in: a user who never sets
the key keeps today's static, host-guaranteed behavior, so the exposure is confined to people who
chose the trade. **That argument is false, and it is worth stating why, because it is the argument
this ADR was expected to make.**

A global install shares one `~/.claude/gsd-core/` tree and one set of skill files across every
project on the machine — #4139's own rejected-alternative 3 says so, and its acceptance criteria
forbid install-time file selection outright. The shipped `SKILL.md` is therefore a single artifact
serving all projects, and an `@`-include in it is expanded unconditionally. There is no way to
write one file that eagerly includes the workflow for opted-out projects and does not for opted-in
ones. Removing the `@`-include removes the guarantee **for everyone**, opted in or not; keeping it
means opted-in projects save nothing on the stream this feature exists for.

That is a hard constraint, not a design preference. Any design that saves tokens on stream 1 must
ensure no user receives the canonical body eagerly.

## Decision

### 1. The name

`workflow.compact_content`, surfaced as **compact content mode**. Satisfies approval condition 1.

"Content" is this repo's own word for this corpus — `CONTRIBUTING.md` §"Editing shipped content",
and the guard family is named the shipped-content guards. "Prompts" would be too narrow for a set
that includes planning-artifact templates. Chosen over `workflow.terse_content` (describes the
prose style rather than the mechanism) and `workflow.lean_prompts` (same narrowness problem, plus
"lean" already carries an unrelated meaning in this repo's vocabulary).

### 2. What this feature is actually for

#4139 is pitched on per-invocation token cost. ADR-1610 has already discounted that argument in
this repo's own record: *"with prompt caching the per-invocation cost premise is weak (cache reads
are ~10% of input), so the caching-independent quality argument is the load-bearing one."*

This ADR adopts ADR-1610's load-bearing argument instead. **The justification for compact content
is finite attention, not price.** A 98 KB instruction file occupying the context window before the
first step runs is 98 KB of attention not spent on the developer's code, and that cost is paid
whether or not the tokens were cheap to transport. Cost reduction is a real secondary effect and
the benchmark in Phase 4 (#4404) will report it, labeled as what it is.

This matters beyond framing: it decides what a good split looks like. Optimizing for price rewards
deleting words anywhere. Optimizing for attention rewards moving words **out of the always-loaded
window** — which is what this ADR's mechanism does, and what ADR-1610 and the `discuss-phase`
progressive-disclosure split (#717) already established as the sanctioned direction. The
workflow-size budget test says so in its own comments: the correct response to a file at its cap is
*"lazy extraction, never a raise."*

### 3. The load mechanism — the eager `@`-include stays exactly where it is

**Decision: do not convert the 58 `<execution_context>` blocks. Change what sits behind them.**

For every covered top-level workflow:

- **`gsd-core/workflows/<name>.md` becomes the spine.** Same path, same eager `@`-include, same
  host guarantee. It is complete enough to run the workflow correctly on its own.
- **The elaborations move to `gsd-core/workflows/<name>/detail/*.md`** — one or more parts, read at
  runtime. Decision 6 explains why "one or more" rather than one.
- **`gsd-core/references/compact-content-gate.md`** is the single shared gate. It states the config
  check and the resolution rule once; workflows reference it and never restate it.

Behavior:

| `workflow.compact_content` | Eagerly loaded | Then reads | Instruction set held |
|---|---|---|---|
| `false` (default) | spine | its `detail/` parts | complete — same content as today |
| `true` | spine | — | the spine |

No command file changes. No skill file changes. No `@`-include is removed, converted, or made
conditional. #4139's claim that *"`@`-includes are untouched"* — untrue of the design it proposed —
becomes literally true of this one.

The savings are real because the eagerly-included file got smaller. For `plan-phase.md`, today's
98,290 bytes become a spine plus detail parts whose sum is the same; an opted-in project loads
only the spine. The reduction available here is larger than #4139's projected aggregate, because it
comes from removing content from the eager window rather than from rewording it.

### 4. The fail-safe — the degradation direction is the whole point

**A missed `Read` under this design leaves the orchestrator running on the spine: correct, terser,
and identical to the state an opted-in project runs in deliberately. It never leaves it running on
nothing.**

This is the property that decides the design, and it is worth being precise about why it holds
rather than asserting it:

- The baseline instruction set arrives by host substitution, which cannot be missed. That is
  unchanged from today, for every user, opted in or not.
- The runtime `Read` is only ever **additive** — it supplies elaboration on top of a complete
  baseline. It is never the delivery mechanism for the baseline itself.
- Therefore the worst outcome of prose-dispatch variance is the *opt-in behavior*, arriving for a
  user who did not opt in. That is a quality regression bounded by a state the project already
  considers acceptable — the same state Phase 2's accuracy spot-check (#4402) exists to validate
  before any of this proliferates.

This is why this ADR does not need to resolve the open question about prose-dispatch reliability
that ADR-3646 §Context raised and #3647's closure left standing. It **routes around** it: the
unreliable mechanism is never load-bearing. Where a stream *can* be served by a code seam with a
real exit code instead — token stream 2, the `buildAgentSkillsBlock` path (#4407) — it is, for
exactly ADR-3646 Decision 2's reason, and this ADR adopts that precedent rather than restating it.

Two consequences to name honestly rather than bury:

**(a) Opted-out projects do acquire one new failure mode.** Their elaborations now arrive by a
`Read` that could be missed, where today they arrive by substitution. #4139's user story 3 asks
that opting out "cost me nothing", and this is a deviation from that. It is the *minimum possible*
deviation: no design that delivers stream-1 savings can leave the canonical body eagerly loaded
(see §Context), so the achievable maximum is exactly this — degradation bounded to the compact
baseline. The alternative shape (convert the `@`-include) has the same new failure mode with an
unbounded consequence. Recorded as a reconciled criterion in Decision 7 rather than silently
accepted.

**(b) The spine's correctness is now load-bearing for everyone, not just opt-ins.** A compact
variant is no longer "a cheaper alternative a few users choose" — it is the floor every user lands
on if a `Read` is missed. This raises the authoring bar, and Decision 5's protected-content list and
boundary-move declaration are what enforce it.

**(c) "The spine still runs the workflow" is not a machine-decidable property, and this ADR does not
pretend otherwise.** Decision 5's checks verify completeness once at split time, then disjointness,
registration and protected-content presence forever. None of them re-derives *sufficiency*. A later
PR could move genuinely load-bearing procedural text — text that carries no protected-content
sentinel because it is a step, not a guardrail — out of a spine and into a part, and every
mechanical check would stay green while the floor quietly dropped. That is the honest residual, and
it is the same class of problem the Feature Review priced in, relocated from "stale duplicate text"
to "boundary placement" rather than eliminated.

What Decision 5 does about it is make the move **declared instead of silent**: a PR in which a spine
loses non-trivial lines that reappear in its detail parts fails the guard unless it carries a
boundary-move declaration naming the spine — the same enforcement philosophy ADR-3942 applies to
emitted-drift, where the mechanism cannot judge intent so it demands the intent be stated. A
declaration is not proof of sufficiency; it is the point at which a reviewer is guaranteed to be
looking. Combined with the end-to-end spot-check obligation that rides on any spine-shrinking PR
(#4402 establishes it, #4405 and #4406 inherit it), that is the strongest available answer, and it
is authoring discipline with a forced checkpoint rather than a structural invariant. Claiming
otherwise would be the more comfortable sentence and the false one.

**Alternatives considered for the fail-safe, and why they lost:**

- *A preflight that fails loud when the content was not loaded.* Needs a signal the workflow's own
  dispatch can check, and the only honest one is a load receipt the orchestrator supplies — which
  the orchestrator can only supply if it ran the instruction whose omission is being detected. It
  detects some misses, not the ones that matter, and it adds machinery to every workflow. Rejected:
  strictly weaker than making the miss harmless.
- *Content delivered by a real subprocess (ADR-3646 Decision 2's shape), with a content digest
  verified on the next `gsd_run` call.* Genuinely converts a silent miss into a hard halt, and is
  the right answer for stream 2 where the payload is already served by a CLI seam. Rejected for
  stream 1 on two grounds: a 60 KB instruction body through a subprocess stdout is subject to
  harness output truncation in a way a `Read` is not, and the design still leaves a window in which
  the orchestrator holds no instructions. Halting loudly is better than proceeding wrongly; not
  needing to halt is better than both.
- *Keeping the `@`-include and adding a separate additive compact overlay* (the `text_mode` overlay
  shape — the `<progressive_disclosure>` dispatch table at
  `gsd-core/workflows/discuss-phase.md:20-40`, whose `workflow.text_mode` row at `:30` is the
  config-gated case). Preserves every guarantee. Rejected: it
  saves nothing on stream 1 — it can only add to an eager window that is already fully paid — so it
  is Option A wearing Option B's clothes.
- *Converting the 58 `<execution_context>` blocks* (the shape the epic brief anticipated). Rejected
  on the reasoning above: it is the only option whose failure mode is unbounded, and it is not
  needed to reach the coverage it was proposed to buy.

**On the scope decision this replaces.** The maintainer was asked to choose between reducing scope
to the reachable streams and expanding it to convert the `@`-includes, and chose to expand. That
decision is honored: **stream 1 is covered in full**, which is what expanding scope was chosen to
buy. It is covered by a route that does not require the conversion, and therefore does not require
accepting the risk the conversion carries. This ADR is not re-litigating the coverage question; it
is delivering the chosen coverage at the safer option's risk level.

### 5. Partition, not duplication

**A split moves text. It does not restate it.** The spine and its detail parts are pieces of one
document, not two documents.

This is the decision that answers the Feature Review's actual disqualifier. That review returned
**No-go as filed**, and the reason was not the mechanism — *"the gating mechanism is sound; the
disqualifier is scope"* — it was *"permanent dual-maintenance burden (290+ files)"* where *"a
missed re-golf silently serves stale instructions."* #4139's approval overrode that verdict but did
not dissolve the cost; it accepted it, and proposed a drift-parity CI check to contain it.

A partition dissolves it instead. **There is exactly one copy of each sentence, so there is no
stale twin that can exist.** A canonical edit lands in whichever half owns that text, and no paired
edit is owed. The forever-cost the review priced in — every future content PR carrying a paired
re-compaction — does not accrue.

What replaces the drift-parity check (Phase 3, #4403):

- **Completeness, once, at split time** — the union of the two halves, whitespace-normalized,
  contains every non-trivial line the canonical file carried at the parent commit. This is what
  makes a split reviewable; it runs on the PR that performs the split and never again.
- **Disjointness, ongoing** — no non-trivial line appears in both halves. This is the invariant that
  keeps duplication from creeping back in later.
- **Registration, ongoing** — a detail part with no spine, or a spine referencing a detail part that
  does not exist, fails and names the pair.
- **Protected content, ongoing** — a spine that has shed a protected-content marker fails and names
  the marker.
- **Boundary moves are declared, ongoing** — a PR in which a spine loses non-trivial lines that
  reappear in its detail parts fails unless it carries a boundary-move declaration naming the spine.
  This is the check that answers Decision 4(c): sufficiency cannot be computed, so the guard makes
  the moment it could be lost impossible to pass through unnoticed.

The protected-content list is #4139's own denylist, promoted from "content the compact variant must
not weaken" to "content that may not leave the spine": negative instructions and guardrails,
output-format contracts, few-shot examples the workflow's own steps depend on, security and
prompt-injection language, and machine-parsed structural headings.

**The marker is a literal sentinel, not a category judgment.** A guard cannot decide whether a
sentence is "security language" — prose category membership is exactly the kind of judgment that
degrades silently under time pressure, and a check that depends on it is a check that does not
exist. So protection is declared at authoring time by a greppable HTML comment in the repo's
existing `gsd:` comment namespace (the same namespace as the `<!-- gsd:loop-host -->` header
`plan-phase.md` already carries):

```markdown
<!-- gsd:protected -->
… one protected block …

<!-- gsd:protected:start -->
… a protected region spanning several blocks …
<!-- gsd:protected:end -->
```

The guard's rule is mechanical and has no discretion in it: **a sentinel present in the canonical
file at the parent commit must be present in the spine afterwards, and every line it covers must be
in the spine.** A split that moves a protected block into a detail part fails and names the
sentinel and the line. The categories above are authoring guidance for *where to place sentinels*;
they are never what the guard evaluates.

Marking is a one-time cost paid during each split, on the file being split. Phase 3 (#4403) owns the
sentinel syntax, the guard, and the failing-first fixture that proves the guard can actually fail —
per this repo's rule that a guard nobody has seen go red is not yet a guard. This is the security
review's finding on this ADR, resolved here rather than carried: the original text specified a
"protected-content marker" without saying what a marker was, which left the strongest check in the
set resting on reviewer judgment.

Rewriting for terseness is permitted **within** a half and is never a way to move a sentence into
both. Where a split cannot be made by moving text alone without breaking the spine's ability to run
the workflow, the correct answer is a different split point, not a duplicated paragraph.

### 6. Where the content lives, and what it collides with

`gsd-core/workflows/<name>/detail/*.md` — a sibling of the existing `modes/`, `steps/` and
`templates/` subdirectories, under the workflow it belongs to.

Chosen over a parallel `gsd-core/workflows/compact/**` tree because a detail part has no meaning
apart from its spine, and a parallel tree is the shape that invites the duplication Decision 5
exists to prevent. Chosen over a home outside `gsd-core/workflows/` because the guards that sweep
that directory *should* see this content.

**`<name>` is never user- or project-supplied.** It is the workflow stem the spine already occupies,
which comes from the static set of shipped command files — the same set `listWorkflowStems` walks —
and each spine names its own detail parts literally rather than composing a path from an argument.
Nothing in `$ARGUMENTS`, `.planning/config.json`, or any tracker payload reaches this path. The
config key selects *whether* the read happens; it never selects *what* is read. A project-local file
does not shadow a shipped detail part either: the read resolves against the installed
`~/.claude/gsd-core/` tree the same way the spine's own `@`-include does, so an untrusted repo
cannot substitute instruction content by planting a path. This is stated rather than left to
inference because the seam is new and a future phase reaching for a computed path would be a
traversal vector where today there is none.

Mapped against the guards that scan this tree, resolved in the phase that first creates a file
there (#4403):

| Guard | Scope | Effect |
|---|---|---|
| `scripts/workflow-size.cjs` `listWorkflowStems` (`:53`) | top-level `.md`, non-recursive | Detail files are outside it. Spines stay inside and get **smaller** — the direction the budget wants. |
| `tests/workflow-size-budget.test.cjs` `listWorkflowFilesRecursive` (`:617`) | recursive (#3324 sub-guard) | Detail files are scanned for bare `@`-include-in-prompt patterns. An `@` line inside a runtime-read file is inert text, so it must not appear there — the guard already enforces this and is correct to. |
| `tests/helpers/planning-add-guard.cjs` `SCAN_ROOTS` | fully recursive over `gsd-core/workflows` | Detail files are swept by `commit-docs-bypass`. Expected; no exemption sought. |
| `tests/emitted-attribution.test.cjs` | diffs installer output across 19 real installer spawns | New installable content enters scope automatically. Byte deltas are deliberate and carry ADR-3942 acknowledgement trailers. |
| `tests/commit-files-pathspec.test.cjs` | every `.md` under `gsd-core/workflows/` (and five other roots), for `commit`-seam invocations without a `--files` scope (`CONTRIBUTING.md:1164-1170`) | Detail parts are in scope. A `commit` invocation that moves out of a spine into a part must keep its `--files` scope. Earlier research on this epic recorded this guard as "not a content-tree scanner; irrelevant here" — that is wrong, and an unscoped `commit` reaching the runtime is #2269, a CRITICAL-blast-radius defect. |
| `scripts/lint-response-language-coverage.cjs` | top-level, with `<workflow>/<modes\|steps\|templates>/<name>.md` inheriting parent coverage | `detail/` is a fourth subdirectory kind the recognizer does not know. #4403 extends the recognizer; it does not carve an exemption. |
| `NEW_FILE_CAP` (`tests/helpers/emitted-diff.cjs:96`, checked at `:403`) | 32,768 B, applied to every file absent from the baseline and present now | **Hard. Not ack-able, and not exemptible by XL/LARGE tiering.** Detail content is therefore split into parts, each under the cap. |
| tier hard caps (`tests/workflow-size-budget.test.cjs:102-104`) | `XL_CAP` 98,304 · `LARGE_CAP` 61,440 · `DEFAULT_CAP` 40,960 | Apply to spines, which are existing files keeping their tier. Spines only get smaller. |

**That `NEW_FILE_CAP` row forces a layout decision, and the correct reading of it is not the obvious
one.** Prior research on this epic recorded the cap as living in `workflow-size-budget.test.cjs` and
as waivable by "explicit tiering in the same PR". Both are stale: they describe the pre-#2724 test-
file version. #2724 (ADR-2719 Phase 4) deleted the committed per-file baseline that version keyed
off, and the cap was revived in `tests/helpers/emitted-diff.cjs`, where its own doc comment states
the narrowing plainly — it is *"a HARD cap, not ack-able … Not exempted by explicit XL/LARGE
tiering the way the original test-file version was — this module is intentionally pure and has no
access to that classification … so a legitimately large NEW file must be split via the same
lazy-extraction pattern the tier caps already require."*

So a single `detail.md` holding the ~63 KB that comes out of `plan-phase.md` is not merely
friction — it is **blocked outright, with no exemption path**. The layout is therefore:

```text
gsd-core/workflows/<name>.md            ← spine, existing path, existing tier, eagerly @-included
gsd-core/workflows/<name>/detail/*.md   ← one or more parts, each < 32,768 B, read at runtime
```

The spine names the parts it defers to, in the same dispatch-table shape `discuss-phase.md`'s
`<progressive_disclosure>` block already uses for its mode overlays. This is a better outcome than
one large detail file, not a workaround for the cap: parts are individually skippable, so a
workflow can defer only the sections a given invocation will not reach, and the cap is doing exactly
the job ADR-1610 designed it to do.

The `@`-include inertness in row 2 has a design consequence worth stating plainly: a canonical
workflow's own `<required_reading>` `@` lines (e.g. `plan-phase.md`'s five reference imports) are
expanded today because the file is `@`-included. They **stay in the spine** and keep working. Moving
one into a detail part would silently turn a working import into dead text, which is exactly the
class of failure the #3324 sub-guard catches.

### 7. Acceptance criteria — satisfied, and reconciled

`CI.GATE.acceptance-criteria-required` treats an unmet must-have as a failed deployment, so the
criteria are reconciled here explicitly rather than reinterpreted quietly at ship time.

**Satisfied as written**, by the phase named: config key registration and validation (#4401);
`/gsd-new-project` question and `/gsd-settings` + `/gsd-config` toggles (#4408); gate logic in
exactly one file (#4402); corpus coverage with no unpaired canonical file (#4405, #4406, #4407);
`agent-skills` serving the compact payload (#4407); golfed spawn patterns (#4405, carried inside
the workflow splits); identical behavior under global and local installs (structural — the key is
per-project and no file is selected at install time); the compression-rules document and its
denylist (#4403); the drift check naming a stale pair (#4403, in its partition form — see below);
the offline reporting-only benchmark with a committed baseline (#4404); the full suite green with
the key on and off (#4408); all shipped-content guards passing (every phase).

**Reconciled, with the reasoning:**

1. *"With golf off they load canonical content"* — they do. The reconciliation is mechanical, not
   semantic: the canonical content arrives as spine plus detail rather than as one eager blob. The
   instruction set an orchestrator holds with the key off is the same instruction set it holds
   today.
2. *"Editing a canonical file without updating its golfed variant fails the drift-parity check"* —
   under Decision 5 there is no variant to go stale, so this criterion's *purpose* (a canonical edit
   cannot silently leave a paired file behind) is met structurally rather than by a check. The check
   that remains enforces the invariant that makes it structural: disjointness plus registration.
   This is a stronger outcome than the criterion asked for, and #4403 must demonstrate it by proving
   each check can actually fail before it is trusted.
3. *"With golf off, GSD behaves exactly as it does today"* (user story 3) — **not fully achievable,
   by any design that delivers stream-1 savings.** Decision 4(a) states the residual: an opted-out
   project's elaborations arrive by a runtime `Read` that could be missed, and a miss yields the
   compact behavior. The deviation is bounded to a state the project deliberately supports and
   validates in #4402. This is recorded as a knowing, argued deviation. It is the item on this list
   a maintainer may reasonably want to overturn, and if it is overturned the consequence is
   automatic: stream 1 becomes uncoverable and the epic reduces to streams 2 and 4.

## Consequences

- Every covered workflow becomes two files. The corpus grows in file count while shrinking in
  eagerly-loaded bytes, and `docs/INVENTORY.md` plus the manifest regenerate on every split phase.
- The maintenance economics the Feature Review priced as disqualifying do not materialize *in the
  form the review priced them*: a partition has no twin, so no future content PR owes a paired edit.
  What replaces that cost is smaller but real, and Decision 4(c) names it — the split point itself
  can drift, and only a declaration plus a reviewer stands between a spine and a slow erosion of
  what it can run on its own. This ADR should be re-read if a future phase finds itself duplicating
  rather than moving text, or routinely waving through boundary-move declarations; either is the
  signal that the review's cost model has come back in a new shape.
- Spines get smaller, which moves several files down a size tier. Tier membership in
  `tests/workflow-size-budget.test.cjs` is adjusted downward as splits land, never held at the old
  tier for headroom.
- ADR-3646's Context acquires a stale citation. It is corrected here rather than by editing that
  ADR: #3647 is closed, its Decision is unaffected, and its reasoning explicitly disclaimed any
  dependence on #3647's state.
- The residual prose-dispatch reliability question raised by #3647's closure thread stays open in
  this repo. This ADR does not close it and does not need it closed. Any future design that makes a
  runtime `Read` load-bearing for a baseline instruction set will need it answered; this one does
  not, and that is the reason it was chosen.
- `gpt-tokenizer` enters `devDependencies` at 27.2 MB unpacked. Nothing ships to users; every
  `npm ci`, CI included, pays the install. It is a single-maintainer package, so #4404 pins an exact
  version rather than a range and relies on the lockfile's integrity hash — a benchmark is not worth
  a floating dependency, and a reporting-only script has no upgrade urgency that would justify one.

## Rejected alternatives

- **Convert the 58 `<execution_context>` `@`-includes to config-gated runtime `Read`s.** Delivers
  the same coverage this ADR delivers. Rejected: it removes the host guarantee for every user
  including those who never opt in (§Context), and its failure mode is "runs with no instructions"
  where this ADR's is "runs with fewer". ADR-3646 §Context rejected the same shape for a
  structurally identical reason.
- **Reduce scope to the lazily-reachable streams.** Buildable immediately, no new risk. Rejected:
  it drops the majority of the value and contradicts an approved acceptance criterion, and it is
  unnecessary — the coverage is reachable without the risk.
- **Install-time selection of compact files.** Rejected by #4139 (alternative 3) and by its
  acceptance criteria: a global install shares one tree across every project on the machine.
- **Runtime LLM-based compression, and character-count optimization.** Rejected by #4139
  (alternatives 1 and 2); nothing found here changes either rejection.
- **Compacting canonical content in place for everyone.** Rejected by #4139 (alternative 5). Worth
  distinguishing from this ADR's decision, because they can look similar: a split preserves every
  word for opted-out projects and changes only *when* it loads. In-place compaction deletes words
  for everyone and forfeits the side-by-side comparison that makes the trade evaluable.

## Phase plan

| Phase | Issue | Delivers | Depends on |
|---|---|---|---|
| 0 | [#4400](https://github.com/open-gsd/gsd-core/issues/4400) | this ADR | — |
| 1 | [#4401](https://github.com/open-gsd/gsd-core/issues/4401) | `workflow.compact_content` end to end | 0 |
| 2 | [#4402](https://github.com/open-gsd/gsd-core/issues/4402) | shared gate + pilot split + accuracy spot-check | 1 |
| 3 | [#4403](https://github.com/open-gsd/gsd-core/issues/4403) | partition rules + the five checks | 2 |
| 4 | [#4404](https://github.com/open-gsd/gsd-core/issues/4404) | offline benchmark + committed baseline | 3 |
| 5 | [#4405](https://github.com/open-gsd/gsd-core/issues/4405) | stream 1 corpus coverage (carries stream 3) | 3, 4 |
| 6 | [#4406](https://github.com/open-gsd/gsd-core/issues/4406) | stream 1b subdirectories + stream 4 templates | 5 |
| 7 | [#4407](https://github.com/open-gsd/gsd-core/issues/4407) | stream 2 agent-skill payloads via the CLI seam | 6 |
| 8 | [#4408](https://github.com/open-gsd/gsd-core/issues/4408) | user surfaces, docs, guard ledger — closes #4139 | 7 |

Guards land before content proliferates (Phases 3 and 4 precede Phase 5), satisfying approval
condition 2. The pilot's end-to-end accuracy spot-check is Phase 2's, satisfying condition 3.

## Open questions for the implementation phases

- Whether `discuss-phase` — the one command that already reaches its workflow by runtime `Read` —
  should be brought onto the spine shape too. It is the sole existing instance of the substitutive
  load this ADR declines to generalize, which means it already carries the failure mode this ADR
  avoids, mitigated only by prose: `commands/gsd/discuss-phase.md:64` reads *"**MANDATORY:** Read
  the appropriate workflow file BEFORE taking any action … Do not improvise from the summary."*
  Giving it a spine would remove that residual entirely, and it is the one place in the tree where
  this ADR's mechanism would be a strict safety improvement rather than a token trade. Scoped to
  Phase 5 (#4405) to decide with the rest of stream 1 in view.
- Whether the disjointness check should compare normalized sentences rather than normalized lines.
  Lines are cheaper and catch copy-paste; sentences catch reflowing. Decided in #4403 against real
  splits rather than in the abstract here.
