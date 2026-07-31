# How to ship a reviewer lane in your capability

**Goal:** Declare a *reviewer lane* in a capability manifest so `/gsd-review` discovers your external review CLI or model endpoint, offers a flag for it, invokes it, and renders its output into `REVIEWS.md` — without patching GSD core.

**Prerequisites:** You already have a capability (`capability.json`), or you are creating one. The reviewer tool is installed and works from your shell. GSD 1.9.0 or later.

Before 1.9.0 a reviewer was a core patch: a hardcoded roster entry, a hand-authored bash leg in `review.md`, a hardcoded output heading, and central config keys. From 1.9.0 a lane is manifest data, so shipping a reviewer is shipping a capability. See [ADR-2782](../adr/2782-reviewer-lane-capability-surface.md) for the decision record.

---

## Decide which shape your lane takes

A `reviewer` body is admissible on two roles. Pick by whether GSD installs *into* your tool.

| Your situation | Use | Why |
|---|---|---|
| Your capability is already a runtime GSD installs into (it has a `runtime` body) and that same CLI can also review | Keep `role: "runtime"`, add a `reviewer` body | One manifest stays one manifest — this is how `codex`, `cursor`, and `antigravity` ship |
| Your tool only reviews — GSD never installs commands, agents, or skills into it | `role: "reviewer"` | The honest description: a lane with no install surface, like `gemini`, `coderabbit`, and `ollama` |
| Your capability adds planning steps, gates, or contributions | `role: "feature"` — and a separate lane capability | A feature manifest may not carry a `reviewer` body; the validator rejects it |

A `role: "reviewer"` capability **must** carry a `reviewer` body, **must not** carry a `runtime` body, and **must not** carry any feature-only field — `skills`, `agents`, `steps`, `contributions`, `gates`, `hooks`, or `activationKey`. A lane owns no artifacts and wires no loop extension point.

---

## Declare a spawned-CLI lane

Most lanes are `transport: "spawn"` — GSD runs a binary and reads its output. Add a `reviewer` block to your manifest:

```json
{
  "id": "acme-review",
  "role": "reviewer",
  "version": "1.0.0",
  "title": "Acme Review CLI",
  "description": "Acme CLI — cross-AI /gsd-review reviewer lane only; not a GSD install target.",
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
      "args": ["review", "{{model}}", "-p", "-"],
      "promptChannel": "stdin",
      "outputChannel": "stdout",
      "modelArg": "--model",
      "effortChannel": "none"
    },
    "timeoutFloorMs": 900000,
    "emptyOutput": "stub-with-stderr",
    "reviewsSection": "Acme",
    "evidenceClass": "source-grounded",
    "requiresBinaries": [],
    "promptBudgetKey": null,
    "modelConfigKey": "review.models.acme",
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

Four fields decide whether the lane works at all, so get these right first:

- **`invoke.args`** carries the `{{model}}`, `{{prompt}}`, `{{effort}}`, and `{{output}}` placeholders. GSD substitutes them; anything else is passed through literally.
- **`promptChannel`** says how the plan text reaches the tool — `stdin` when it reads a pipe, `argv` or `argv-file-ref` when it takes the prompt path as an argument, `none` when the tool reads the working tree itself (as CodeRabbit does).
- **`outputChannel`** is `stdout`, or `file-arg` when the tool writes to a path you name (then also declare `invoke.outputArg`, as `codex` does with `-o`).
- **`timeoutFloorMs`** is the measured wall-clock floor for *your* tool. Lane divergence here is expected and correct — the descriptor exists to declare divergence in one place, not to impose one number on every lane.

`reviewsSection` is the heading your findings render under in `REVIEWS.md`. It must be unique across every installed lane; two lanes sharing a heading would silently merge their output into apparent consensus that never happened.

For the full field table — every type, enum member, and default — see [Capability manifest § Reviewer body](../reference/capability-manifest.md#reviewer-body-role-reviewer-or-on-any-role).

---

## Declare an OpenAI-compatible HTTP lane instead

If your reviewer is a served model endpoint rather than a CLI, use `transport: "openai-http"`. The `invoke` block takes a different shape — a destination, not a binary:

```json
"reviewer": {
  "slug": "acme_local",
  "flags": ["--acme-local"],
  "transport": "openai-http",
  "probe": {
    "kind": "http-reachable",
    "hostConfigKey": "review.acme_host",
    "path": "/v1/models",
    "timeoutMs": 2000
  },
  "invoke": {
    "hostConfigKey": "review.acme_host",
    "defaultHost": "http://localhost:8080",
    "path": "/v1/chat/completions",
    "modelDiscovery": "first-from-models-endpoint",
    "fallbackModel": "acme-7b",
    "effortChannel": "none"
  },
  "timeoutFloorMs": 120000,
  "emptyOutput": "stub-with-stderr",
  "reviewsSection": "Acme Local",
  "evidenceClass": "source-grounded",
  "requiresBinaries": [],
  "promptBudgetKey": "review.max_prompt_tokens_per_reviewer.acme_local",
  "modelConfigKey": "review.models.acme_local",
  "handler": "openai-compatible"
}
```

`handler: "openai-compatible"` is what gives you model discovery against `/v1/models`, the request and response shape, and the served-model mismatch warning. Declare the matching `review.acme_host` key in your `config` block alongside the model key.

**Every probe is bounded.** An unbounded `--help | grep` probe is a named defect in this repo. `http-reachable` requires `timeoutMs`; so does `command-capability`, the probe kind you use when a bare binary name is ambiguous.

---

## Own your lane's config keys

Declare the lane's keys in your own manifest `config` block, never in the central schema. A key present in both is a build failure, not a warning — federated ownership is exclusive.

Name `modelConfigKey` and `promptBudgetKey` to match keys you actually declare. A lane pointing at a key nobody owns resolves to nothing, which reads to the user as "my model override is being ignored."

Users then set them the ordinary way, in `.planning/config.json`:

```json
{ "review": { "models": { "acme": "acme-large" } } }
```

---

## Build and install

If your capability lives in the GSD repo, regenerate the committed registry and check for drift:

```bash
npm run gen:capability-registry
npm run lint:generated-sync
```

If you are shipping out-of-tree, package and install it like any other capability:

```bash
gsd capability install <url>
```

Uniqueness is checked across the merged first-party ∪ overlay set — a duplicate `slug`, a duplicate entry in `flags`, or a duplicate `reviewsSection` collides. **Expect that collision to be quiet.** `gsd capability install` does not run the cross-capability check; it runs at *load* time, and a colliding overlay is dropped from the active set with a warning rather than failing the install. First-party always wins.

That failure mode is worth internalizing before you debug it: the install command reports success, and your lane simply never appears. If a lane you just installed is missing from `gsd-tools review-lane sections`, suspect a name collision before you suspect the probe. Malformed values inside the body — a `slug` outside `^[a-z0-9][a-z0-9_-]*$`, an enum member that does not exist, an `outputArg` without `outputChannel: "file-arg"` — are ordinary validation errors and are reported directly.

Two naming rules are easy to conflate, so keep them apart. Your `slug` may not be `__proto__`, `constructor`, or `prototype` — a prototype-pollution guard, not a namespace policy; any other grammatical slug is yours, including one starting `gsd-`. Your capability **`id`**, separately, may not begin with `gsd-`, `gsd-core-`, or `anthropic-`; those prefixes are reserved so nothing can impersonate a first-party capability.

An *unknown* field inside your `reviewer` body behaves differently: it is a non-fatal warning on stderr, never a build failure. A manifest built against a newer GSD degrades visibly instead of crashing.

### Listing your lane is not wired yet

You can build, install, and run a third-party lane today. You cannot yet **list** it in a discoverability catalog, and it is better to know that before you write the entry than after.

Neither existing registry accepts a lane. A [Community Capability Registry](../registries/capability-registry.md) entry requires a non-empty `loopExtensionPoints` and a `hookKinds` value, and a lane registers on zero loop extension points by design — the two fields are unsatisfiable rather than merely unset. The [EoS Registry](../registries/eos-registry.md) is for host integrations that embed the orchestration engine through the ADR-1239 interface, which a reviewer lane does not do.

Do not work around this by filing a loop extension point your lane does not use. A third `reviewer` entry type is tracked by [#2904](https://github.com/open-gsd/gsd-core/issues/2904) for a 1.9.x point release; until it lands, distribute your lane by URL and it will install and run normally.

---

## Verify the lane resolves

Check that GSD sees your lane before you run a real review:

```bash
gsd-tools review-lane sections
gsd-tools review-lane flags
```

`sections` lists every `slug` with the heading it renders under; `flags` lists every selector flag. Your lane appears in both, or it is not installed.

Then dry-check the invocation plan for your lane alone:

```bash
gsd-tools review-lane plan --selected acme
```

A resolvable lane returns `"ok": true` with its `section`, `transport`, and prompt path. Once that is green, run it for real against a planned phase:

```bash
/gsd-review --phase 3 --acme
```

If the lane is absent from `--all`, the probe is the usual culprit: `command-exists` fails silently when the binary is not on `PATH` in the environment GSD runs in.

---

## Know what your users are consenting to

A reviewer lane is a **fourth executable-surface disclosure class**, alongside hooks, command modules, and MCP servers — and it is the only one that *receives* data. Your lane is piped plan text, requirements, research findings, and `CONTEXT.md` decisions. Install-time disclosure says so plainly:

```text
  reviewer lane (1): an external reviewer receives plan/review data on every run
    - acme -> acme review --model acme-large -p -
        sends: plan text, requirements, research findings, CONTEXT.md decisions
```

Be clear-eyed about what that buys, because your users are trusting your judgment as much as the mechanism. ADR-2782 D5 says it plainly: disclosure and host pinning make the channel *"visible, pinned, and revocable — it does not make it safe"*, and consent-at-install is a **weaker gate for a standing egress channel than for a hook**. A user consents once; your lane thereafter receives every plan on every review run. A per-run prompt was considered and rejected as consent fatigue. Design your lane as if that single consent is the only one you will ever get, because it is.

Three consequences you should design for:

- **Your `args` are signature-bound, not just your binary.** Changing `binary`, `args`, `hostConfigKey`, `promptChannel`, or `handler` in a new version re-triggers consent on update. Changing `reviewsSection` or `timeoutFloorMs` does not — a cosmetic prompt is how users learn to click through.
- **An `openai-http` lane binds the *resolved host*, not just the config key.** GSD re-resolves `hostConfigKey` before every invocation and blocks the lane if the destination changed, rather than silently sending plans somewhere new. Users see the lane refuse and must re-consent. Point `defaultHost` at the address you actually mean.
- **What the user saw is only tamper-evident because the bundle is pinned.** The disclosure is trustworthy because the downloaded capability is integrity-checked and its hash recorded at install; a later change to your `args` or `hostConfigKey` shows up as a changed signature rather than sliding in quietly. Keep `engines.gsd` honest for the same reason — it is a hard gate, so a lane declaring a range it does not actually work on is blocked at install and skipped at load rather than failing confusingly at review time.

For the reasoning behind consent-plus-integrity rather than a sandbox, see [The capability trust model](../explanation/capability-trust-model.md).

---

## Conditionals: when the vocabulary does not fit your tool

Third-party lanes are **data-only**. `handler` is a closed enum of first-party names (`antigravity`, `openai-compatible`, `opencode`, or `null`) — you may reference an existing member, but you cannot ship your own handler module.

| Your tool | What to do |
|---|---|
| Runs one command, reads a prompt, writes a review | Declare it — the vocabulary covers this, which is eight of the twelve shipped lanes |
| Is an OpenAI-compatible endpoint | `transport: "openai-http"` with `handler: "openai-compatible"` |
| Needs a stateful setup turn before it can review (Plandex-style `new` then `review`) | Not expressible today — the descriptor describes one invocation. File an issue naming the primitive |
| Edits files or commits by default (Aider-style) | Not expressible today — there is no way to declare a read-only invocation posture, and the prompt asking politely is not a guarantee. File an issue naming the primitive |
| Needs genuinely imperative behavior for an upstream bug | File an issue. Named handlers are added first-party after review, the same path that widened the vocabulary to add `openai-http` |

Filing the issue is the supported route, not a workaround. The `openai-http` transport exists because three real lanes did not fit and the vocabulary widened on that evidence.

---

## Related

- [Capability manifest](../reference/capability-manifest.md) — the full `reviewer` body field table and validation rules
- [Set up cross-AI review](set-up-cross-ai-review.md) — the user-facing side: choosing, configuring, and running reviewers
- [Develop a Capability for GSD 1.5+](develop-a-capability.md) — manifests, registry generation, and federated config
- [Publish a capability](publish-a-capability.md) — versioning, `engines.gsd`, and distribution
- [The capability trust model](../explanation/capability-trust-model.md) — disclosure, consent, and integrity
- [ADR-2782](../adr/2782-reviewer-lane-capability-surface.md) — why the lane became a capability surface, and what it deliberately excludes
