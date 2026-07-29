# ADR-2782: Reviewer Lane — the cross-AI reviewer handoff becomes a declared capability surface

- **Status:** Accepted
- **Date:** 2026-07-28
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
keys, and updating five prose surfaces. #2718 was that patch in flight (PR #2776, closed in favour
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
*one place where divergence is declared*, not one behaviour imposed on every lane.

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
    "flag": "--acme",
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
    "requires": [],
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
| `invoke.promptChannel` | `stdin` \| `argv` \| `argv-file-ref` | forbidden |
| `invoke.outputChannel` | `stdout` | forbidden |
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
the run directory.

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

### D5 — A fourth executable-surface disclosure class: the reviewer lane

ADR-1244 D5 rule 2 requires that executable surfaces be disclosed and consented at install, and
names three classes: `hooks`, command modules, and `mcpServers`. A reviewer lane is a fourth, and it
is materially different from the other three: **it receives data**. A lane is piped the plan text,
the requirements, the research findings, and the `CONTEXT.md` decisions, and its output is read back
into `REVIEWS.md`. That is an egress channel for the most sensitive artifacts GSD produces.

Making lanes pluggable **without** a disclosure class would open a data-exfiltration path behind a
manifest field. The trust work is therefore the gating requirement of this design, not polish.

`discloseExecutableSurfaces` gains a reviewer-lane surface that discloses, by transport:

- **`spawn`** — the **binary** that will be executed.
- **`openai-http`** — the **destination host URL** resolved from `hostConfigKey`. Disclosing `curl`
  would be technically true and practically meaningless; the destination is the disclosure that
  matters. A `localhost` destination is still disclosed, distinguished from a remote one.

Both forms additionally disclose the **egress payload classes** — plan text, requirements, research
findings, `CONTEXT.md` decisions — rather than an unhelpful "sends data to the tool".

The lane folds into `disclosureSignature` / `signatureForManifest` as stable sorted JSON, exactly as
`env`/`cwd` do for MCP servers (#1459), so that adding a lane, changing its binary, or changing its
resolved host forces re-consent. `executableSetChanged` treats those as executable-set changes for
the auto-update re-consent trigger (ADR-1244 D5 rule 4).

**Stated honestly, and consistent with ADR-1244 D5's own acknowledgment that there is no sandbox:**
consent-at-install is a weaker gate for a *standing egress channel* than it is for a hook. A user
consents once; the lane thereafter receives every plan on every review run. Disclosure makes the
channel **visible and revocable** — it does not make it safe. A per-run egress prompt was considered
and rejected as consent fatigue that trains users to approve blindly.

### D6 — `handler` is a closed enum of first-party names; third-party lanes are data-only

Lane divergence is real (context above), so the descriptor must not promise uniformity. Where a lane
needs genuinely imperative behaviour — the Antigravity three-layer fallback is the canary —
`reviewer.handler` names an imperative module **by closed first-party name**, rather than growing
conditionals inside data.

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

Across the merged first-party ∪ overlay set, `reviewer.slug`, `reviewer.flag`, and
`reviewer.reviewsSection` are each unique. A collision fails the build gate. `reviewsSection`
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

| Phase | Issue | Deliverable |
|---|---|---|
| 0 | [#2793](https://github.com/open-gsd/gsd-core/issues/2793) | This ADR |
| 1 | [#2794](https://github.com/open-gsd/gsd-core/issues/2794) | Core single-sourced invocation descriptor + `DEFECT.GENERATIVE-FIX` parity assertion — **closes #2690** |
| 2 | [#2795](https://github.com/open-gsd/gsd-core/issues/2795) | Manifest `reviewer` body; registry harvest, validation, uniqueness; the D4 absent-safe invariant |
| 3 | [#2796](https://github.com/open-gsd/gsd-core/issues/2796) | The fourth trust-disclosure class (D5) |
| 4 | [#2797](https://github.com/open-gsd/gsd-core/issues/2797) | Federated config migration (D9), same-commit |
| 5a | [#2798](https://github.com/open-gsd/gsd-core/issues/2798) | The **11 existing** lanes declare reviewer bodies; roster derives; hardcoded tail deleted |
| 5b | [#2799](https://github.com/open-gsd/gsd-core/issues/2799) | `invoke_reviewers` / `write_reviews` iterate lanes; the **`kimi-code`** lane — **closes #2718** |
| 6 | [#2800](https://github.com/open-gsd/gsd-core/issues/2800) | Docs, `hostBehaviors` documentation gap, capability matrix, locale parity gate — **closes #2781** |
| 7 | [#2801](https://github.com/open-gsd/gsd-core/issues/2801) | Remove the `hostBehaviors.reviewerCli` alias (D9), the release *after* 5a |

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
