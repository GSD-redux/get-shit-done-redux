# How to take over a capability, reviewer lane, or EoS integration

A **takeover** changes who maintains something that already exists and is already listed — a third-party Feature Capability, a reviewer lane, or an Embeddable Orchestration System (EoS) host integration.

There is no `gsd capability transfer` command and no rename tooling. A takeover is a governance process executed entirely through registry pull requests and the entry's GitHub Discussion thread. Everything below is manual and auditable by design.

## Decide what you are taking over

| Surface | Manifest | Registry source | Ships in |
|---|---|---|---|
| First-party capability | `capabilities/<id>/capability.json` | none — generated registry only | the `gsd-core` release |
| Third-party Feature Capability | `capability.json`, `role: "feature"` | `docs/registries/capabilities.json` | the author's own repo |
| Third-party reviewer lane | `capability.json`, `role: "reviewer"` | `docs/registries/reviewers.json` | the author's own repo |
| Third-party EoS host integration | ADR-1239 host plugin (no `capability.json` in `gsd-core`) | `docs/registries/eos.json` | the author's own repo |

A first-party capability has no registry entry and no external owner — changing who works on it is ordinary contribution, not a takeover. Use this guide only when an external `repo` and `author` are recorded somewhere under `docs/registries/`.

## Pick the takeover mode

| Mode | Entry condition | End state |
|---|---|---|
| **T1 — Consensual handoff** | The current author agrees, in public, to hand the project off | Same `id`, same entry, new `repo` and `author` |
| **T2 — Adoption fork** | The author is unreachable but the linked repo still works | **New** `id`, new entry, new Discussion; the original entry stays |
| **T3 — First-party absorption** | GSD absorbs the surface into `capabilities/<id>/` | In-repo capability; the registry entry is annotated, not deleted |
| **T4 — Retirement** | Illegal content, malware, spam, or a dead link | Entry removed |

> **The narrow removal policy constrains every mode.** A merged entry is removed only for illegal content, malware, spam, or a repo that is dead or completely non-functional. It is **never** removed for staleness, quality, abandonment, or a maintainer's disagreement with its design. An abandoned-but-working entry therefore cannot be reclaimed — T2 is always additive, and the original `id` stays taken forever.

## Step 1 — Build the evidence pack

Collect all of this before opening anything. Every later step reads from it.

- The current registry object, copied verbatim from `capabilities.json`, `reviewers.json`, or `eos.json`.
- The upstream `capability.json` (or, for EoS, the host plugin's own manifest), copied verbatim.
- `id`, `author`, `repo`, `license`, `enginesGsd`, and — for EoS — `protocolVersion`.
- The entry's `discussion` URL and its full comment history.
- A liveness probe of `repo`: is the default branch reachable and non-empty? If the link is dead, the correct mode is **T4**, not T2.
- The upstream release history — the shields badge and the update channel both read from `repo`, so a repo with no releases has no update channel at all.

## Step 2 — Verify you are allowed to take it over

**License gate.** T2 and T3 both require a fork or a derivative. If `license` is `UNLICENSED` or `Proprietary`, stop — neither mode is available without written permission from the rights holder.

**Reserved-prefix gate.** The `gsd-`, `gsd-core-`, and `anthropic-` prefixes are reserved for first-party, and a third-party id claiming one is rejected at the conformance gate. You may only move into a reserved prefix as part of **T3**.

**Consent gate (T1 only).** The handoff must be a public comment in the entry's Discussion thread, posted from the GitHub account that owns `repo`. A DM, an email, or a comment from any other account is not sufficient. The reason is structural: the registry-entry PR template's ownership statement is self-attested and no automated gate checks who is changing `repo` or `author`, so the Discussion permalink is the only auditable record that the handoff happened.

**Unreachability record (T2 only).** Document at least three contact attempts across at least 30 days — an issue on the upstream repo, a comment on the entry's Discussion, and one more public channel — each dated and linkable. Paste these into the T2 PR body.

## Step 3 — Snapshot the inherited contract

These fields are the user-visible contract. A takeover **preserves** them. If you intend to change them, do that afterward as a normal version bump under your own maintainership — never inside the ownership-change PR.

**Feature Capability** — `interactions.loopExtensionPoints` (which of the 12 Loop Extension Points it registers on), `hookKinds`, `configKeys`, `requires`, `runtimeCompat`, `produces`, `consumes`; plus the manifest's `skills` and `agents` stems, which must stay unique across the merged first-party and overlay set.

**Reviewer lane** — `interactions.slug`, `flags`, `transport`, `evidenceClass`, `reviewsSection`, `requiresBinaries`, `configKeys`. The `slug`, `flags`, and `reviewsSection` must remain unique across the merged first-party and overlay set; a collision breaks `/gsd-review` for anyone running both lanes.

**EoS host integration** — `protocolVersion`, `interactions.interfacePoints` (the subset of `command`, `dispatch`, `model`, `hooks`, `state`, `artifact` it binds), `interactions.profile`, and all eight required axes: `embeddingMode`, `commandSurface`, `dispatch`, `modelMode`, `hookBus`, `stateIO`, `transport`, `runtime` — plus `effortSurface` if the entry already carries it.

## Step 4 — Work the continuity checklist

Each item below breaks an existing install if you get it wrong.

- **Keep the `id`.** Consent is stored per `(realpath(projectRoot), capability id)`. Changing the `id` re-prompts consent in every project that has the capability installed, and orphans the old `gsd capability update <id>` path.
- **Re-state `integrity`.** The `sha512-<base64>` hash is computed over the published artifact. A rebuild under new ownership produces a new hash, and anyone who pinned with `--integrity` will fail verification until you publish and communicate the new value.
- **Re-state `provenance`.** `sourceRepo` and `commit` must point at the new repository and the exact commit you published.
- **Re-consent on executable-surface change.** If the set of hooks, MCP servers, or command modules changes, installers are re-prompted. Keep it identical through the takeover so the handoff itself is not a consent event.
- **Do not narrow `engines.gsd`.** If you raise the floor, add the corresponding `compatVersions` row so older GSD versions can still resolve a working version.
- **Make `install` and `uninstall` copy-pasteable against the new repo.** They are exact commands, not descriptions, for capability and reviewer entries.
- **Do not drop `protocolVersion`** on an EoS entry. It must stay an integer of 1 or greater and must still name the ADR-1239 protocol the integration actually implements.

## Step 5 — Execute the mode

All registry work follows the standard submission process: fork, edit exactly one JSON object, run `npm run gen:registry`, commit **both** the JSON source and the regenerated markdown, and open one PR from a `docs/<issue#>-<slug>` branch using the registry-entry PR template. Never hand-edit the generated `.md` — the `gen:registry --check` drift gate rejects it. **One entry, one PR**, always.

### T1 — Consensual handoff

1. Change only `repo`, `author`, `install`, and `uninstall` — plus `homepage` and `license` if they genuinely changed.
2. Leave `id`, `discussion`, and the entire `interactions` object byte-identical.
3. Put the permalink to the outgoing author's public handoff comment in the PR body. Without it the PR is indistinguishable from an entry hijack and a maintainer should decline it.
4. Run `npm run validate:registry` locally.
5. Add a `.changeset/` fragment typed `Changed`.

### T2 — Adoption fork

1. Fork upstream under your own account, honoring the license.
2. Choose a **new** `id`. The original is permanently taken.
3. Open a new Discussion in the `EoS Registry` category — which, despite its name, carries threads for all three registries. The `discussion` field is required, so the thread must exist before the PR.
4. State in `description` that this is a maintained fork of the original id, and link it.
5. Leave the original entry completely untouched. Its install command keeps resolving to the original repo forever; that is the intended behavior, not a bug to route around.
6. Add a `.changeset/` fragment typed `Added`.

### T3 — First-party absorption

Absorption is a feature-scale change, so the contribution rules apply before any code: an issue carrying `approved-feature`, and an ADR recording the decision.

1. Land the capability as `capabilities/<id>/capability.json` per ADR-894, with `role`, `tier`, and a `requires` list that is acyclic and tier-monotone. Declare `runtimeCompat`.
2. Reserved prefixes are now available to you, and first-party wins every collision — id, skill and agent stems, config keys, command families.
3. Regenerate the capability registry with `scripts/gen-capability-registry.cjs --write`.
4. Update `CONTEXT.md` domain terms, `docs/README.md`, and the surface docs the capability touches.
5. **Do not delete the registry entry.** Absorption is not one of the four removal grounds. Note the supersession in `description` through a separate `Changed` PR.
6. **Publish a migration note telling existing users to run `gsd capability remove <old-id>` first.** Config keys are exclusive to one capability and skill/agent stems must be unique; a first-party capability that collides with an installed overlay wins silently, leaving the user running code they did not think they were running.

### T4 — Retirement

1. Cite exactly one of the four grounds — illegal, malware, spam, or dead/non-functional link — and put the evidence in the PR body.
2. Remove the single object, regenerate, and commit both files.
3. Add a `.changeset/` fragment typed `Removed`.

Staleness, low quality, an unmaintained-but-working project, or a design you would have built differently are **not** grounds. If that is your situation, the mode is T2.

## Step 6 — Post-takeover obligations

- **Cut a GitHub Release under the new repo.** There is no re-registration on new versions: the shields badge and the `releases/latest` permalink render live from `repo`, so releases are the update channel forever. A takeover with no release leaves consumers with a badge that never moves.
- **Bump `version`** in the manifest, and add a `compatVersions` row if you raised the `engines.gsd` floor.
- **Publish the new `integrity` hash and `provenance` object.**
- **Keep the Discussion thread.** It is the continuity record across maintainers, and it carries the community's upvotes and experience reports.

## What a takeover must not do

- Change `interactions` in the same PR as the ownership change. Split them.
- Repoint `repo` at a fork while the original is alive and maintained. That is an entry hijack, not a takeover.
- Reclaim an `id` that is still listed.
- Remove a working entry in order to make room for a replacement.
- Rename into `gsd-`, `gsd-core-`, or `anthropic-` outside of T3.
- Bundle the change with any other registry entry, code change, or unrelated docs edit.

## Known gaps in the enforcement path

Two parts of this process rest on human judgment rather than an automated gate. Both are worth knowing before you rely on the process.

1. **Entry-update authorship is unverified.** `scripts/registry-schema.cjs` and `npm run validate:registry` check the shape of an entry, not who is changing it. A PR that repoints `repo` and `author` at an unrelated account passes every automated gate. The reviewing maintainer is the only control, which is why the public handoff permalink in Step 5 is mandatory rather than advisory.
2. **There is no `id` migration path.** With no transfer or rename tooling, `id` continuity is manual, and an `id` change is a hard break for every installed consumer — a consent re-prompt, a broken update path, and an orphaned ledger entry.

## Related

- [Develop a Capability for GSD 1.5+](develop-a-capability.md)
- [How to publish a capability so others can install it](publish-a-capability.md)
- [Version a capability](version-a-capability.md)
- [Remove a capability](remove-a-capability.md)
- [GSD Registries: schema and submission process](../registries/README.md)
