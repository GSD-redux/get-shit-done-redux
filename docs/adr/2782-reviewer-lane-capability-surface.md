# ADR-2782: Reviewer Lane — the cross-AI reviewer handoff becomes a declared capability surface

- **Status:** Accepted
- **Date:** 2026-07-28
- **Amended:** 2026-07-29 by Phase 1 ([#2794](https://github.com/open-gsd/gsd-core/issues/2794)) — D1's `flag` becomes `flags[]`; D2's `promptChannel` gains `none`, `outputChannel` gains `file-arg` with a companion `outputArg`; D8's uniqueness invariant restated over the flattened flag set. All four are additive widenings of closed enums, each forced by a shipped lane the original survey did not cover. See **Amendments** at the end.
- **Issue:** [#2782](https://github.com/open-gsd/gsd-core/issues/2782) (epic); Phase 0 tracked by [#2793](https://github.com/open-gsd/gsd-core/issues/2793)
- **Amends:** [ADR-857](857-capability-system.md) (extension points as data — extends D7/D8 in the same "amend, not reverse" sense ADR-1244 D8 established) · [ADR-894](894-capability-declaration-format.md) (adds a role-typed body and a third role) · [ADR-1016](1016-runtime-capability-descriptor.md) (the runtime body is no longer the *only* body a `role: "runtime"` capability may carry; its closed-vocabulary principle is upheld, not relaxed — see D6) · [ADR-1244](1244-capability-ecosystem.md) (D5 gains a fourth executable-surface disclosure class; D9's matrix gains a lane column)
- **Unchanged and explicitly out of scope:** [ADR-0011](0011-review-default-reviewers.md) (reviewer selection precedence) · [ADR-1517](1517-reviewer-instances-config-surface.md) (the `REVIEWS.md` contract and reviewer instances)
- **Subsumes:** [#2690](https://github.com/open-gsd/gsd-core/issues/2690) (core single-sourcing — lands as Phase 1 under this ADR rather than as its own design)

## Context

A cross-AI reviewer lane — one external CLI or model endpoint that `/gsd:review` hands a plan to
for independent review — is declared today in **three** unrelated places, none of which is the
capability system, and **none** of which a third party can extend.

**1. The roster is half registry-derived, half hardcoded.** `src/review-reviewer-selection.cts`
derives slugs from `runtime.hostBehaviors.reviewerCli === true` (`:40-49`), then concatenates a
hardcoded `NON_RUNTIME_REVIEWER_SLUGS` tail (`:32-38`) for five reviewers that have no
`capabilities/<id>/` directory at all. The module's own comment says exactly this. Six capabilities
carry the flag; five reviewers have no descriptor of any kind.

**2. The invocation contract is prose.** `gsd-core/workflows/review.md` is 1070 lines;
`invoke_reviewers` spans roughly 60% of it as hand-authored per-CLI bash. Each leg re-implements
probe, argv shape, model lookup, effort channel, timeout, stderr capture, and empty-output policy.

**3. The output contract is prose.** `write_reviews` hardcodes per-reviewer section headings,
including two literal instance names.

Three structural consequences follow, and they are why this is a capability question rather than
only a refactor question.

**(a) `reviewerCli` is a bare boolean in an undocumented, unvalidated bag.** `hostBehaviors`
appears **zero times** in `docs/reference/capability-manifest.md` — not in the envelope table, not
in the runtime-body axis table — and `scripts/gen-capability-registry.cjs` does not validate its
keys. The one field that decides reviewer membership is unspecified, unvalidated, and carries no
invocation data. A capability author can discover it only by reading
`src/review-reviewer-selection.cts:47`.

**(b) Reviewer-ness is welded to runtime-ness, and the runtime body structurally cannot hold a lane
contract.** `capability-manifest.md:141` states the runtime body is "a closed 8-axis (plus 4
install-surface) vocabulary; no feature-only fields (`skills`, `agents`, `steps`, `contributions`,
`gates`, `hooks`) are permitted," and `gen-capability-registry.cjs:505` enforces the consequence — a
`role: "runtime"` capability is stored whole into `runtimes[]` and its `config`/`steps`/
`contributions`/`gates` are never harvested. A reviewer lane therefore cannot own its own federated
config keys. That is why `review.models.*`, `review.ollama_host`, `review.lm_studio_host`,
`review.llama_cpp_host`, and `review.max_prompt_tokens_per_reviewer.*` all live in the central
schema instead of with the lane that uses them — the exact half-migrated shape the config-key
exclusivity invariant exists to prevent.

**(c) A reviewer that is not a GSD install target has nowhere to live.** `gemini`, `coderabbit`,
`ollama`, `lm_studio`, and `llama_cpp` are review or model CLIs GSD never installs into. There is no
`capabilities/<id>/` for them, so they are a hardcoded tail by necessity, not by choice.

**Net: adding a reviewer lane is a core patch.** It means editing the roster module or a runtime
descriptor, hand-authoring a bash leg, hand-adding a `write_reviews` heading, adding central config
keys, and updating five prose surfaces. #2718 was that patch in flight (PR #2776, closed in favor
of this design); #2781 is the documentation drift it produced. Cross-cutting fixes land per-leg:
#2494 and #2605 were the same empty-output defect filed twice; #2475 (effort channel), #2589 (model
lookup), #2295 (resolved-model recording), and #2272 (flag parity) are the same shape.

### What a survey of the twelve lanes actually shows

The design was drafted assuming one lane shape. Reading all twelve legs disproved that, and the
correction is the most consequential decision in this ADR (D2).

| Family | Lanes | Shape |
|---|---|---|
| **Spawned CLI** | `gemini`, `claude`, `codex`, `coderabbit`, `opencode`, `qwen`, `cursor`, `antigravity`, `kimi-code` | Binary + argv; prompt via stdin or argv; stdout captured, stderr to a `.err` sidecar |
| **OpenAI-compatible HTTP** | `ollama`, `lm_studio`, `llama_cpp` | **No binary.** `curl` to `/v1/chat/completions` on a user-configured host; model discovered via `GET /v1/models` piped through `jq` |

Three of twelve lanes are not spawned binaries at all. Timeout floors genuinely diverge — a measured
~570 s for Codex at `xhigh` effort and ~525 s for headless Claude drive a 900 000 ms floor with
1 200 000 ms for those two, while the Antigravity leg runs a 600 s external cap over a 540 s native
`--print-timeout`, and the HTTP lanes use 120 s. Five lanes require `jq` on `PATH`. The Antigravity
leg carries a deliberate three-layer fallback for an upstream stdout bug.

**Divergence between lanes is real and frequently correct.** The value of a descriptor is therefore
*one place where divergence is declared*, not one behavior imposed on every lane.

## Decisions

### D1 — A `reviewer` body on the capability manifest, admissible on two roles

A reviewer lane is declared as data in a `reviewer` body:

```json
{
  "id": "acme-reviewer",
  "role": "reviewer",
  "version": "1.0.0",
  "title": "Acme Review CLI",
  "description": "Cross-AI plan review lane backed by the Acme CLI.",
  "tier": "full",
  "requires": [],
  "engines": { "gsd": ">=1.9.0" },

  "reviewer": {
    "slug": "acme",
    "flags": ["--acme"],
    "transport": "spawn",
    "probe": { "kind": "command-exists", "binary": "acme" },
    "invoke": {
      "binary": "acme",
      "args": ["review", "--format", "text"],
      "promptChannel": "stdin",
      "outputChannel": "stdout",
      "modelArg": "--model",
      "effortChannel": "argv"
    },
    "timeoutFloorMs": 900000,
    "emptyOutput": "stub-with-stderr",
    "reviewsSection": "Acme Review",
    "evidenceClass": "source-grounded",
    "requiresBinaries": [],
    "promptBudgetKey": null,
    "handler": null
  },

  "config": {
    "review.models.acme": {
      "type": "string",
      "default": "",
      "description": "Model passed to the Acme reviewer lane."
    }
  }
}
```

The body is admissible on **`role: "runtime"`** — so the six capabilities that are both install
targets and reviewers (`claude`, `codex`, `cursor`, `opencode`, `qwen`, `antigravity`) keep exactly
one manifest — and on a **new `role: "reviewer"`** (D3) for lanes that are not install targets.

This is the amendment to ADR-1016: a `role: "runtime"` capability may now carry a `reviewer` body
alongside its runtime body. The runtime body itself remains closed and unchanged; no feature-only
field becomes permissible on it. A lane body is a third thing, not a relaxation of the second.

Because a lane may own a federated `config` slice, `gen-capability-registry.cjs` must harvest
`config` from a lane-bearing capability of **either** role — the specific limitation at `:505` that
context (b) describes.

### D2 — `transport` is a closed discriminator, and it selects the invoke sub-shape

`reviewer.transport` is a closed enum: **`spawn` | `openai-http`**.

| | `spawn` | `openai-http` |
|---|---|---|
| `invoke.binary` | required | **forbidden** |
| `invoke.args` | required (array) | forbidden |
| `invoke.promptChannel` | `stdin` \| `argv` \| `argv-file-ref` \| `none` | forbidden |
| `invoke.outputChannel` | `stdout` \| `file-arg` | forbidden |
| `invoke.outputArg` | required iff `outputChannel: "file-arg"`, else forbidden | forbidden |
| `invoke.hostConfigKey` | forbidden | required (dotted config key holding the base URL) |
| `invoke.path` | forbidden | required (e.g. `/v1/chat/completions`) |
| `invoke.modelDiscovery` | forbidden | closed enum: `none` \| `first-from-models-endpoint` |
| `invoke.modelArg` | optional | forbidden (model travels in the JSON body) |
| `invoke.effortChannel` | closed enum: `none` \| `argv` \| `env` | `none` |

A manifest declaring fields from both sub-shapes, or neither, **fails validation**. The
discriminator is explicit rather than inferred from field presence: inference leaves a manifest with
both — or with neither — carrying undefined meaning, which is precisely what a closed vocabulary
exists to prevent.

`promptChannel: "argv-file-ref"` exists because two lanes (`cursor`, `kimi-code`) take the prompt as
an argv argument, and passing a full plan set inline would approach the 32 767-character Windows
`execFileSync` ceiling. The file-reference form passes a short instruction naming a prompt file in
the run directory. That instruction must also carry the **absolute repository root**, because an
argv-fed CLI does not reliably inherit the review's working directory — the existing `cursor` and
`kimi-code` legs already do this by hand (`review.md:447-448`, `:550-552`).

`outputChannel` is a required, named, closed-enum field rather than an implicit assumption, because
the alternative — a lane that writes its review to a file and prints nothing — is a shape a real CLI
can take, and an unnamed assumption is the thing a later contributor silently violates.

**Amended 2026-07-29 (#2794):** this ADR originally recorded `outputChannel` as having "exactly one
member (`stdout`) today" and described the file-writing lane as a shape a real CLI *could* take. It
already does. `codex` captures its review through its own `-o/--output-last-message <FILE>` and
discards stdout, because on Windows it writes process-teardown output to stdout *after* the final
message, and a stdout redirect would append that noise to a non-empty file — slipping past the
empty-output guard as a silently polluted review (#1698). The enum therefore ships with two members,
and `file-arg` carries a companion `outputArg` naming the argument that takes the path: knowing the
review lands in a file is useless without it.

`promptChannel` likewise gains `none`. `coderabbit` is fed no prompt at all — it reviews the
working-tree diff and accepts neither a prompt nor a model flag (`review.md:367`). The original
three-member enum had no way to say "this lane receives nothing", which would have forced Phase 2 to
either invent a sentinel or mis-declare the lane.

Both were found by building Phase 1's descriptor table against all eleven shipped legs. That is the
same evidence path that produced `openai-http` in the first place, and it is the process working:
the vocabulary widens on a lane that exists, never on speculation.

Three further declared fields carry per-lane divergence that would otherwise live only in prose:

| Field | Values | Why it exists |
|---|---|---|
| `evidenceClass` | `source-grounded` \| `diff-only` | CodeRabbit reviews a diff, not the source tree, and its findings are deliberately down-weighted in synthesis (`review.md:367`). Today that caveat is a prose annotation a reader may miss; declaring it lets `write_reviews` render the caveat from data |
| `requiresBinaries` | string[] | External tools the lane needs on `PATH` — `jq` for five lanes. A missing prerequisite reports the lane unavailable with an install hint rather than running it into an empty review |
| `promptBudgetKey` | dotted config key \| `null` | Per-lane prompt trimming (`prepare_trimmed_prompt_for_reviewer`, `review.md:646-704`) is keyed per slug today; the key becomes the lane's own federated config (D9) |

**Naming note:** the field is `requiresBinaries`, **not** `requires`. The envelope already carries a
`requires` (capability-id dependencies, ADR-1244). Two fields named `requires` at different nesting
depths with unrelated semantics is a defect waiting to happen; the collision was caught in review of
this ADR and renamed here rather than left for a downstream phase to trip over.

### D3 — A third role, `role: "reviewer"`, for lanes that are not install targets

`gemini`, `coderabbit`, `ollama`, `lm_studio`, and `llama_cpp` become first-party capabilities with
a `reviewer` body, **no runtime body, and no install surface** — which is the honest description of
what they are. `runtimeCompat` is not required for this role (it declares which host runtimes a
*feature* surfaces through; a lane surfaces through none).

`tier` remains required, because it is the source of truth for install-profile membership. A
`role: "reviewer"` capability therefore receives profile membership from `deriveProfileMembership`
(`gen-capability-registry.cjs:201-213`) like any other. **That membership is inert**: the capability
contributes no artifacts, so there is nothing to install. This is stated explicitly because a reader
encountering a lane in an install profile would otherwise reasonably assume it installs something.

Rejected: one role for every lane, splitting `codex` into `codex` + `codex-reviewer`. It is the
cleaner discriminator and was rejected for churn — six manifests would each fragment into two
capabilities and two ids, complicating roster derivation for no gain.

### D4 — The `reviewer` body is optional and absent-safe at every layer

**This is a normative MUST, and it governs every downstream phase.**

1. A capability with **no** `reviewer` body is simply not a lane. This is **never** a validation
   error. Most runtime capabilities are install targets only; a validator that errors on an absent
   body would break the majority of the registry.
2. An overlay declaring a `role` or a field this GSD version does not know is **skipped with a
   warning** via the existing `engines.gsd` hard gate (ADR-1244 D6) — never a crash. This is the
   forward half: a capability built for a newer GSD degrades to discovered-but-inactive.
3. An unknown field *inside* a `reviewer` body is ignored with a warning rather than failing
   validation.
4. A lane naming an unknown `handler` **fails closed** — the lane is unavailable; the registry does
   not crash.
5. A capability with no `reviewer` body must not perturb its **disclosure signature** (D5). An
   absent body that changed the signature would force spurious re-consent across every installed
   capability.

The asymmetry is deliberate and is Postel's Law applied with a boundary: liberal in what a manifest
may **omit**, strict in what it **asserts**. Permissiveness about absence is forward compatibility;
permissiveness about assertions would be an untyped escape hatch.

#### Absent-safe governs discovery, never explicit selection

Rules 1–5 describe what happens when the system is *looking for* lanes. They do **not** apply once a
user has named one. If a user runs `/gsd:review --acme` and the `acme` lane is unavailable — because
its capability was skipped under rule 2, because its `handler` failed closed under rule 4, because a
prerequisite binary is missing, or because its egress destination changed (D5) — that is an
**error**, surfaced and non-silent. It is not an informational note, and the run does not quietly
proceed with a thinner reviewer set.

This is called out because the current implementation does the opposite: an unavailable
explicitly-requested reviewer is recorded as an `info` (`review-reviewer-selection.cts:246-248`).
The workflow's own guidance already names why that is wrong — "a cross-AI review that silently drops
a lane is blind in one eye" (`review.md:304`) — and a design whose whole premise is *more* lanes from
*less* trusted sources must not inherit a silently-degrading selector. **Correcting this is Phase 1's
responsibility**, because Phase 1 is where the selector is single-sourced.

In one line: *not finding* a lane nobody asked for is normal; *failing to run* a lane somebody asked
for is an error.

#### Where warnings surface

"Skipped with a warning" means nothing unless a human sees it. Warnings arising at **build time**
(registry generation over first-party capabilities) are emitted by `gen-capability-registry.cjs` on
stderr, and fail the build only where D8's uniqueness invariants are breached. Warnings arising at
**load time** — an overlay skipped by `engines.gsd`, an unknown field, a `handler` that failed
closed — surface on the `/gsd:review` run that would have used the lane, and in
`gsd capability list`, which is where a user goes to ask why a capability is inactive. A warning
written only to a build log nobody reads is not a warning.

### D5 — A fourth executable-surface disclosure class: the reviewer lane

ADR-1244 D5 rule 2 requires that executable surfaces be disclosed and consented at install, and
names three classes: `hooks`, command modules, and `mcpServers`. A reviewer lane is a fourth, and it
is materially different from the other three: **it receives data**. A lane is piped the plan text,
the requirements, the research findings, and the `CONTEXT.md` decisions, and its output is read back
into `REVIEWS.md`. That is an egress channel for the most sensitive artifacts GSD produces.

Making lanes pluggable **without** a disclosure class would open a data-exfiltration path behind a
manifest field. The trust work is therefore the gating requirement of this design, not polish.

`discloseExecutableSurfaces` gains a reviewer-lane surface that discloses, by transport:

- **`spawn`** — the **binary and its full declared `args`**, in both rendered and raw form, exactly
  as MCP servers already disclose `argv`/`rawArgs` (`capability-trust.cts:688-690`).
- **`openai-http`** — the **destination host URL** resolved from `hostConfigKey`, plus the
  `hostConfigKey` itself. Disclosing `curl` would be technically true and practically meaningless;
  the destination is the disclosure that matters. A `localhost` destination is still disclosed, and
  is distinguished from a remote one.

Both forms additionally disclose the **egress payload classes** — plan text, requirements, research
findings, `CONTEXT.md` decisions — rather than an unhelpful "sends data to the tool".

**Disclosing the binary without its `args` is insufficient, and this is not hypothetical.** A lane
declaring `binary: "python3"` with innocuous `args` could, in a later version, change `args` to
`["-c", "<arbitrary program>"]` without the binary changing at all. That is precisely the bug class
#1459 already fixed for MCP servers, and a binary-only disclosure would reopen it. `args` is
therefore disclosed **and** signature-bound.

The lane folds into `disclosureSignature` / `signatureForManifest` as stable sorted JSON, exactly as
`env`/`cwd` do for MCP servers (#1459). `executableSetChanged` treats **any** of the following as an
executable-set change for the auto-update re-consent trigger (ADR-1244 D5 rule 4): adding or
removing a lane, or changing its `binary`, `args`, `hostConfigKey`, `promptChannel`, or `handler`.

#### The egress destination is re-verified at invocation, not only at install

`hostConfigKey` is the one consent-bound value that does **not** live in the SHA-pinned bundle. It
names a key in `.planning/config.json`, which is user- and CI-editable at any time with no
re-install and no integrity check — unlike every existing consent-bound field (`command`, `args`,
`env`, `cwd`, `url`), all of which come from the manifest itself (`capability-trust.cts:74-125`).

Left unaddressed, this is a real hole: a lane consented against `http://localhost:8080` could be
silently redirected to a remote host by a later config edit — including one arriving through an
ordinary pull request touching `.planning/config.json` — and every subsequent review run would
egress plans, requirements, research, and decisions to the new destination with no re-prompt.

Therefore, normatively:

1. The consent record binds the **resolved host**, not merely the config key.
2. Before invoking an `openai-http` lane the runtime **re-resolves** `hostConfigKey` and compares the
   result against the consented host.
3. On mismatch the lane is **blocked, not silently redirected**; the user is told the destination
   changed and must re-consent. A blocked lane reports like any other unavailable lane — it never
   degrades to running against the new host.
4. This check lives on the **invocation** path (Phase 5b), not only in the install path.

A host change is a change of *who receives the user's plans*. It is the most security-relevant
mutation in this design, and it must not be reachable by editing a JSON file.

**Stated honestly, and consistent with ADR-1244 D5's own acknowledgment that there is no sandbox:**
even with the above, consent-at-install remains a weaker gate for a *standing egress channel* than
for a hook. A user consents once; the lane thereafter receives every plan on every review run.
Disclosure plus destination re-verification makes the channel **visible, pinned, and revocable** — it
does not make it safe. A per-run egress prompt was considered and rejected as consent fatigue that
trains users to approve blindly.

### D6 — `handler` is a closed enum of first-party names; third-party lanes are data-only

Lane divergence is real (context above), so the descriptor must not promise uniformity. Where a lane
needs genuinely imperative behavior — the Antigravity three-layer fallback is the canary —
`reviewer.handler` names an imperative module **by closed first-party name**, rather than growing
conditionals inside data.

The enum ships with exactly these members. `null` is the default and covers eight of the twelve
lanes:

| `handler` | Lanes | What it owns that data cannot express |
|---|---|---|
| `null` | the other eight | Nothing — the declared vocabulary suffices |
| `"antigravity"` | `antigravity` | The three-layer fallback for an upstream stdout bug; the **two-level timeout** (a 600 s external `timeout`/`gtimeout` cap wrapping a 540 s native `--print-timeout`, `review.md:560`); and the stale-response watermark guard that rejects a cached conversation from a prior run |
| `"openai-compatible"` | `ollama`, `lm_studio`, `llama_cpp` | Model discovery against `/v1/models`, the JSON request/response shape, and the **served-model mismatch warning** raised when the responding model differs from the one requested (`review.md:794-797`) |

Enumerating the members here is deliberate. A "closed enum" whose membership is left to the
implementing phase is not closed, and three separate phases would each have invented a different
list.

**On `timeoutFloorMs` and the Antigravity two-level timeout.** The descriptor carries **one** scalar,
`timeoutFloorMs` — the outer wall-clock bound every lane gets. A lane whose tool has its own
*internal* timeout (Antigravity's `--print-timeout` is the only current case) expresses that inner
bound in its **handler**, not in the descriptor. Adding a second declarative timeout field to serve
one first-party lane would be speculative generality; the handler seam exists for exactly this. The
delegation is stated here so a reader does not wonder where the measured 540 s went.

This upholds rather than relaxes ADR-1016. That ADR's core principle is that "a runtime that needs a
shape no existing primitive expresses is supported by adding a first-party primitive … never by
embedding arbitrary code or an open escape hatch in the descriptor," and its §Alternatives #2
explicitly **rejected** an open escape hatch. `handler` is the same construction as ADR-1016
Decision 3's closed `ConverterName`: the descriptor references a first-party function by name and
never embeds it.

**The consequence must be stated plainly, because it caps this epic's headline claim.** Third-party
lanes are **data-only**. A third-party CLI needing a shape the closed vocabulary lacks is blocked on
a first-party PR. The honest claim is *most* lanes, declaratively — not *any* lane.

The escalation path is the ADR-1016 model, and it is documented rather than implied: file an issue
naming the primitive the vocabulary lacks; it is reviewed and added first-party. **D2 is the worked
example of that path already functioning** — the `openai-http` transport exists precisely because a
survey produced evidence that three real lanes did not fit, and the vocabulary widened on evidence
rather than on speculation.

**Two real CLIs that would NOT fit today**, named so the boundary is a known quantity rather than a
surprise for the first third-party author who hits it:

- **Aider** mutates the repository by default — it edits files and commits. The vocabulary has no way
  to declare "this tool must be invoked read-only", and the existing lanes achieve that only by
  *asking politely inside the prompt text* (`review.md:448`: "Do not edit any files"), which a
  coding-agent CLI is under no obligation to honor. A repo-mutating reviewer is a materially
  different safety posture from a read-only one, and the descriptor does not currently express it.
- **Plandex** requires a stateful session (`plandex new`) before a review turn. D2's single
  `binary` + `args` + prompt-channel shape describes one invocation; it cannot express a two-phase
  setup-then-invoke sequence.

Neither is a reason to reject this design — both are exactly the "file an issue naming the primitive"
case, and both would likely be served by two future primitives: a declared invocation-safety posture,
and a `setup` phase on the descriptor. They are recorded because an ADR claiming a closed vocabulary
is sufficient, without naming what it excludes, is claiming more than it verified.

Revisiting this to permit a third-party `handler` module confined to the capability install root
(the ADR-1244 D7 model, which does allow third-party command modules) would genuinely deliver "any
plugin can ship a lane." It is rejected **here** because it reverses an ADR-1016 rejection rather
than amending it, and because D7 itself calls third-party code execution the highest-risk surface
and sequences it last. It should be revisited only with its own ADR and its own evidence.

### D7 — `probe.kind` is a closed enum wider than existence, and every probe is bounded

`probe.kind` is a closed enum:

| Kind | Fields | Semantics |
|---|---|---|
| `command-exists` | `binary` | `command -v <binary>` |
| `command-capability` | `binary`, `needle`, `timeoutMs` | `<binary> --help` bounded, matched against `needle` |
| `http-reachable` | `hostConfigKey`, `path`, `timeoutMs` | Bounded GET; reachable ⇒ available |

`command-exists` alone is **structurally insufficient**, and the evidence is concrete: `kimi` is
claimed by both Kimi Code CLI (Node) and the legacy Python kimi-cli — which is a separate,
first-party, non-reviewer runtime capability in this repo. An existence-only probe registers the
wrong tool. This was found in review of PR #2776 and is the reason the vocabulary ships wider than
one member.

**Every probe that starts a process or a connection MUST be bounded.** This repo carries a named
*Unbounded Subprocesses* defect class, and the original Kimi probe was a live instance of it: an
unbounded `kimi --help | grep` that ran on **every** `/gsd:review` invocation regardless of which
flags were passed, so a user whose Kimi binary waited on a first-run consent or auth prompt would
hang every future review — including reviews that never asked for that lane.

`command-capability` bounds via external `timeout`, falling back to `gtimeout` (the precedent
already set by the Antigravity block at `review.md:560`). **Stock macOS ships neither**; where no
bounding mechanism is available the probe is **skipped and the lane reported unavailable**, which
degrades a lane rather than hanging a command.

### D8 — Uniqueness is a build-time conformance invariant

Across the merged first-party ∪ overlay set, `reviewer.slug`, `reviewer.flags`, and
`reviewer.reviewsSection` are each unique — for `flags`, over the **flattened** set of every lane's
flags, since one lane may declare several. A collision fails the build gate.

**Amended 2026-07-29 (#2794):** D1 originally declared a singular `flag`, and this invariant was
stated over it. `antigravity` is selected by **both** `--antigravity` and `--agy`
(`review.md`, `docs/COMMANDS.md`), which a single-valued field cannot express, so the field is
`flags: string[]` and uniqueness flattens across lanes. `reviewsSection`
uniqueness is not cosmetic: two lanes sharing a heading would silently merge their output in
`REVIEWS.md`, producing a review that appears to have consensus it does not have.

An overlay lane colliding with a first-party lane is rejected, first-party winning — the existing
`id`-uniqueness precedent (`capability-manifest.md:167`).

**Reviewer instances are not lanes.** `review.reviewer_instances.<name> = {cli, model?, agent?}`
(ADR-1517) lets one model-capable adapter run as several reviewer identities. Instances resolve
*through* a lane and continue to; they do not participate in the roster, the flag set, or this
uniqueness check.

### D9 — Reviewer config keys become federated, and the roster derives from declared lanes

`review.models.*`, `review.<host>_host`, and `review.max_prompt_tokens_per_reviewer.*` move from the
central schema to federated `config` slices owned by their lane capabilities. Key **names** and
existing `.planning/config.json` files are unchanged; only validation provenance moves, so no user
migration is required. Per the config-key exclusivity invariant (`capability-manifest.md:173`), the
central-schema removal and the federated addition **must land in the same commit** or the build gate
fails on a key present in both.

Ownership is per-key and per-lane, so that no key is owned twice — Phase 4 implements this table
rather than re-deriving it:

| Key | Owner | Notes |
|---|---|---|
| `review.models.<slug>` | the lane whose `slug` it names | One key per lane; a lane with no model override declares none |
| `review.ollama_host` | `ollama` | The `hostConfigKey` its own descriptor points at (D2) |
| `review.lm_studio_host` | `lm_studio` | ditto |
| `review.llama_cpp_host` | `llama_cpp` | ditto |
| `review.max_prompt_tokens_per_reviewer.<slug>` | the lane whose `slug` it names | The lane's `promptBudgetKey` (D2) resolves to this |
| `review.max_prompt_tokens` | **stays central** | A global default across all lanes; owned by no single lane, so federating it would be wrong |
| `review.default_reviewers` | **stays central** | Selection policy over lanes (ADR-0011), not a property of any lane |
| `review.reviewer_instances` | **stays central** | Instance→lane mapping (ADR-1517); an instance is not a lane (D8) |

The last three rows matter as much as the first five: a key that describes *policy across* lanes must
not be federated *into* one, and the exclusivity invariant would not catch that error — it only
catches a key owned twice, not a key owned by the wrong side.

`KNOWN_REVIEWER_SLUGS` derives from declared reviewer bodies. `hostBehaviors.reviewerCli` survives
as a **derived legacy alias for one release** and is then removed. Where both a body and the alias
are present, the body wins. The field is undocumented, so external users are unlikely — but
"undocumented" is not "unused", which is why it gets a deprecation window and a changeset note
rather than a silent removal. **The removal is owned by a named phase** (#2801), not left implicit.

## Consequences

**Positive.**

- Adding a reviewer becomes one manifest installed through `gsd capability install <url>` — no core
  patch, no workflow edit, no release cycle — for any lane the vocabulary expresses.
- A cross-cutting fix (empty output, effort channel, model lookup) becomes a single-site change
  covering every lane, retiring the #2494 → #2605 cadence.
- The roster gets one generated source, which makes the `DEFECT.GENERATIVE-FIX` parity assertion for
  #2781 mechanical rather than per-lane.
- Third-party lanes arrive behind the existing trust gate — disclosure, consent, SHA pin,
  `engines.gsd`, reserved namespaces — instead of as an unreviewable prose block.
- A lane owns its own configuration, closing a half-migrated config surface.

**Negative, and accepted.**

- The closed vocabulary must grow, under review, when a genuinely new lane shape appears. This is
  intentional friction and it is the trust boundary. D2 shows the cost is real: the first survey
  already forced one widening.
- Third-party lanes are data-only (D6). "Any plugin can ship a reviewer lane" overstates what this
  delivers; the ADR and the epic should both say *most*.
- Consent-at-install is a weaker gate for a standing egress channel than for a hook (D5). There is
  no sandbox.
- `discloseExecutableSurfaces` is already cyclomatic 51 / cognitive 99 with five dependents. Adding
  a fourth class lands in an existing hotspot; the implementing phase should extract per-class
  helpers rather than grow the switch, and should expect the mutation gate to bite.
- Two declaration mechanisms coexist for one release (D9).
- Normalizing empty-output handling is observable on lanes that previously returned nothing
  silently. That is a bug fix that breaks a workaround, and it needs a changeset note rather than a
  silent correction.

**Explicitly unchanged:** reviewer selection precedence (ADR-0011), the `REVIEWS.md` contract
(ADR-1517), and every existing lane's observable command shape.

## Implementation phases (dependency-ordered)

Verified with `/adr-phase-coverage`: every deliverable is claimed by exactly one phase, every
hand-off lands, and every user-facing capability has a phase that wires its entry point.

Every decision is mapped to the phase that delivers it, so no decision is left to be "handled
somewhere".

| Phase | Issue | Delivers | Deliverable |
|---|---|---|---|
| 0 | [#2793](https://github.com/open-gsd/gsd-core/issues/2793) | — | This ADR |
| 1 | [#2794](https://github.com/open-gsd/gsd-core/issues/2794) | D4 (explicit-selection carve-out only) | Core single-sourced invocation descriptor + `DEFECT.GENERATIVE-FIX` parity assertion; corrects the silently-degrading selector — **closes #2690** |
| 2 | [#2795](https://github.com/open-gsd/gsd-core/issues/2795) | **D1, D2, D3, D4, D7, D8** | Manifest `reviewer` body and the third role; `transport` and `probe.kind` closed enums; registry harvest, validation, uniqueness; the absent-safe invariant and its warning channel |
| 3 | [#2796](https://github.com/open-gsd/gsd-core/issues/2796) | **D5** | The fourth trust-disclosure class: binary + `args` / host + `hostConfigKey`, egress payload classes, signature binding |
| 4 | [#2797](https://github.com/open-gsd/gsd-core/issues/2797) | **D9** (config half) | Federated config migration per the ownership table, same-commit |
| 5a | [#2798](https://github.com/open-gsd/gsd-core/issues/2798) | **D9** (roster half) | The **11 existing** lanes declare reviewer bodies; roster derives; hardcoded tail deleted |
| 5b | [#2799](https://github.com/open-gsd/gsd-core/issues/2799) | **D6**, D5 (invocation-time host re-verification) | `invoke_reviewers` / `write_reviews` iterate lanes; the `antigravity` and `openai-compatible` **handler modules** ported from the existing bash legs; the **`kimi-code`** lane — **closes #2718** |
| 6 | [#2800](https://github.com/open-gsd/gsd-core/issues/2800) | — | Docs, `hostBehaviors` documentation gap, capability matrix, locale parity gate — **closes #2781** |
| 7 | [#2801](https://github.com/open-gsd/gsd-core/issues/2801) | D9 (alias removal) | Remove the `hostBehaviors.reviewerCli` alias, the release *after* 5a |

Two mappings are worth calling out because a reader would otherwise assume the wrong phase. **D6's
handler modules are code**, not data — porting Antigravity's ~100-line three-layer fallback and the
three OpenAI-compatible lanes into named first-party modules is Phase 5b's work, delivered alongside
the iteration that calls them. And **D5 splits across two phases**: the disclosure itself is Phase 3,
but the invocation-time destination re-verification necessarily lands in Phase 5b, because that is
where the invocation path is built.

**Why `kimi-code` lands in 5b and not 5a.** 5a makes the roster derive from declared bodies, but 5b
is what makes `invoke_reviewers` iterate them. The eleven existing lanes already have hand-authored
legs, so declaring them in 5a changes nothing observable. `kimi-code` is net-new with no leg —
declaring it in 5a would make it **selectable but not invocable**: present in `--all`, selected, and
producing an empty section for the whole 5a → 5b window. Landing it with the iteration keeps the
Phase 1 parity assertion green across the entire migration.

## Alternatives considered

1. **A single unified `invoke` shape.** The design this ADR started from. Rejected on evidence: a
   read of all twelve legs found three that are HTTP endpoints with no binary (see Context). Had it
   shipped, Phase 2 would have bolted on an implicit second shape or stranded three lanes in the
   hardcoded tail this epic exists to delete.
2. **Transport inferred from field presence** (`binary` ⇒ spawn, `hostConfigKey` ⇒ http). Fewer
   fields; rejected because a manifest with both or neither has undefined meaning.
3. **A spawn-only body, leaving the three HTTP lanes in core.** Smaller and sooner; rejected because
   it preserves a hardcoded tail and permanently bars a third party from shipping a local-model
   lane — the epic's own problem statement in miniature.
4. **Core descriptor table only** (#2690 as filed). Single-sources invocation inside
   `review-reviewer-selection.cts` and collapses the eleven blocks. Cheaper and lands sooner, and it
   does fix the cross-cutting-defect cadence — but it does not make lanes installable: still a core
   patch, still no trust gate, still no federated config. **Not discarded — adopted as Phase 1**, so
   the descriptor shape is designed once under this ADR rather than twice.
5. **Keep `hostBehaviors.reviewerCli`, just document and validate it.** Cheapest, and it does close
   the documentation gap. Rejected because it leaves problems (b) and (c) intact: a lane still
   cannot own its config, and the five non-installable reviewers still have nowhere to live.
6. **A third-party `handler` module confined to the install root.** See D6 — the only option that
   genuinely delivers "any plugin"; rejected here as reversing rather than amending ADR-1016, and as
   the surface ADR-1244 D7 sequences last. Revisit with its own ADR.
7. **Route lanes through MCP.** Rejected: reviewers are batch, single-shot, ten-to-twenty-minute
   invocations. An MCP server lifecycle adds nothing, and `mcpServers` disclosure already covers the
   cases that genuinely are servers.
8. **One `role: "reviewer"` for every lane**, splitting the six dual-purpose runtimes. Cleaner
   discriminator; rejected for churn (D3).

## Amendments

### 2026-07-29 — vocabulary widened by Phase 1 (#2794)

Phase 1 built the core descriptor table against all eleven shipped legs, which is the first time
every lane's contract was written down in one place. That surfaced four cases the original survey
did not cover. All four are **additive widenings of closed enums**, none reverses a decision, and
each is forced by a lane that exists today rather than by a hypothetical:

| # | Decision | Was | Is | Forced by |
|---|---|---|---|---|
| 1 | D2 | `promptChannel: stdin \| argv \| argv-file-ref` | adds `none` | `coderabbit` is fed no prompt — it reviews the working-tree diff |
| 2 | D2 | `outputChannel: stdout` ("exactly one member today") | adds `file-arg` | `codex` already writes via `-o/--output-last-message` and discards stdout (#1698) |
| 3 | D2 | — | adds `outputArg`, required iff `file-arg` | knowing the review lands in a file is useless without the argument naming it |
| 4 | D1, D8 | `flag: string` | `flags: string[]`, uniqueness flattened | `antigravity` is selected by both `--antigravity` and `--agy` |

**Why this is the process working, not a design failure.** D2 already records that the original
draft assumed one lane shape and that reading all twelve legs disproved it — `openai-http` exists
because a survey produced evidence, not because anyone predicted it. These four are the same
mechanism at the next level of detail: the vocabulary widens when a real lane does not fit, under
review, and never on speculation. D6's escalation path ("file an issue naming the primitive the
vocabulary lacks") is for third parties; a first-party phase that finds the gap while implementing
amends the ADR directly, which is what happened here.

**What this does not change.** No decision is reversed. `transport` remains a closed two-member
discriminator selecting the invoke sub-shape; `probe.kind` and `handler` are untouched; the
absent-safe invariant (D4), the disclosure class (D5), and the config-ownership table (D9) are
unaffected. Phase 2 (#2795) implements the manifest validator against the vocabulary **as amended
here**, which is the point of amending rather than leaving it for Phase 2 to rediscover.
