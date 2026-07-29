# GSD Registries: Community Capability Registry & EoS Registry

Specification, entry schema, and submission process for GSD's two third-party discoverability catalogs — the **GSD Community Capability Registry** and the **GSD EoS Registry**.

---

## Non-endorsement stance

> Inclusion in this registry means only that a maintainer merged a PR that linked to the author's repository. It is not an endorsement. GSD has not reviewed, tested, audited, or verified the correctness, quality, safety, or security of any listed solution, nor its claimed GSD interactions. Use at your own risk; evaluate the linked source yourself. Entries are removed only for illegal content, malware, spam, or a link that is dead/completely non-functional — never curated for quality.

This stance applies identically to every entry in both registries. It is reproduced verbatim at the top of each generated catalog (`capability-registry.md`, `eos-registry.md`).

## Narrow removal policy

A merged entry is removed **only** for one of these reasons:

- The linked content is illegal.
- The linked repository distributes malware.
- The entry is spam (not a genuine, working solution).
- The linked repository or its default branch is dead or completely non-functional (404, archived-and-empty, permanently inaccessible).

A registry entry is **never** removed for quality, staleness of a working project, disagreement with its design, or because a maintainer would have built it differently. The registry is a directory, not a curated marketplace — see [Non-endorsement stance](#non-endorsement-stance) above.

---

## What gets listed

Two independent catalogs, sharing one schema shape, one non-endorsement stance, and one submission process:

- **Community Capability Registry** (`docs/registries/capability-registry.md`, generated from `docs/registries/capabilities.json`) — third-party **Feature Capabilities**: plug-ins that attach at GSD's Loop Extension Points (ADR-857, ADR-894, ADR-1244) and are installed with `gsd capability install <spec>`.
- **EoS Registry** (`docs/registries/eos-registry.md`, generated from `docs/registries/eos.json`) — third-party **Embeddable Orchestration System (EoS)** host integrations: projects that embed GSD as an orchestration engine inside a host through the ADR-1239 Host-Integration Interface.

Both registries are non-endorsing discoverability catalogs (issue #2182). Neither is the runtime **Capability Registry** (the generated manifest consumed at load time, ADR-894 §5) or the **Capability Registry Overlay** (the runtime loader that merges an installed third-party manifest into that generated registry, ADR-1244 D2) — see `CONTEXT.md` → "Community Capability Registry" and "EoS Registry" for the full disambiguation.

---

## Entry schema

Every entry is one JSON object in `docs/registries/capabilities.json` or `docs/registries/eos.json`, validated by `scripts/registry-schema.cjs`. Field names below are exact and case-sensitive; unknown top-level keys are rejected.

### Capability entries (`capabilities.json`, `type: "capability"`)

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique slug across the registry (`^[a-z0-9]+(-[a-z0-9]+)*$`). |
| `name` | yes | Human-readable name. |
| `type` | yes | Must equal `"capability"`. |
| `repo` | yes | `owner/repo` on github.com — the author's own repository. |
| `description` | yes | One-paragraph plain-language description of the solution and the problem it solves. |
| `author` | yes | Author name (and, optionally, contact). |
| `license` | yes | SPDX identifier (or `UNLICENSED` / `Proprietary`). |
| `enginesGsd` | yes | Declared `engines.gsd` semver range (ADR-1244 D1), e.g. `>=1.6.0`. |
| `install` | yes | Exact, copy-pasteable install command — the ADR-1244 URL-import flow, e.g. `gsd capability install https://github.com/OWNER/REPO.git#v1.0.0`. |
| `uninstall` | yes | Exact, copy-pasteable removal command, e.g. `gsd capability remove <id>`. |
| `interactions` | yes | Object — see below. |
| `discussion` | yes | URL of this entry's GitHub Discussion (`https://github.com/<owner>/<repo>/discussions/<n>`). |

`interactions` (Capability):

| Field | Required | Meaning |
|---|---|---|
| `loopExtensionPoints` | yes, non-empty | Subset of the 12 Loop Extension Points the capability registers on: `discuss:pre`, `discuss:post`, `plan:pre`, `plan:post`, `execute:pre`, `execute:wave:pre`, `execute:wave:post`, `execute:post`, `verify:pre`, `verify:post`, `ship:pre`, `ship:post`. |
| `hookKinds` | yes | Subset of `step`, `contribution`, `gate` — the hook kind registered at each point above. |
| `configKeys` | yes | Array of federated config keys the capability owns (may be empty). |
| `requires` | yes | Array of other Capability ids this capability depends on (may be empty). |
| `runtimeCompat` | yes | Array of compatible runtimes; `["all"]` is allowed. |
| `produces` | yes | Array describing artifacts/data the capability produces (may be empty). |
| `consumes` | yes | Array describing artifacts/data the capability consumes (may be empty). |

Example:

```json
{
  "id": "linear-issue-sync",
  "name": "Linear Issue Sync",
  "type": "capability",
  "repo": "some-org/gsd-cap-linear-sync",
  "description": "Mirrors ROADMAP.md items to Linear issues as a ship:post contribution.",
  "author": "Some Org <hello@some-org.example>",
  "license": "MIT",
  "enginesGsd": ">=1.6.0",
  "install": "gsd capability install https://github.com/some-org/gsd-cap-linear-sync.git#v1.0.0",
  "uninstall": "gsd capability remove linear-issue-sync",
  "interactions": {
    "loopExtensionPoints": ["ship:post"],
    "hookKinds": ["contribution"],
    "configKeys": ["linear-issue-sync.enabled"],
    "requires": [],
    "runtimeCompat": ["all"],
    "produces": ["linear-issue-links"],
    "consumes": ["ROADMAP.md"]
  },
  "discussion": "https://github.com/open-gsd/gsd-core/discussions/1234"
}
```

### EoS entries (`eos.json`, `type: "eos"`)

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique slug across the registry. |
| `name` | yes | Human-readable name. |
| `type` | yes | Must equal `"eos"`. |
| `repo` | yes | `owner/repo` on github.com — the author's own repository. |
| `description` | yes | One-paragraph plain-language description of the host integration. |
| `author` | yes | Author name (and, optionally, contact). |
| `license` | yes | SPDX identifier (or `UNLICENSED` / `Proprietary`). |
| `enginesGsd` | yes | Declared `engines.gsd` semver range this integration targets. |
| `protocolVersion` | yes | Integer ≥ 1 — the ADR-1239 `PROTOCOL_VERSION` this integration implements. |
| `install` | yes | The host-plugin's own install steps (free string). |
| `uninstall` | yes | The host-plugin's own teardown steps (free string). |
| `interactions` | yes | Object — see below. |
| `discussion` | yes | URL of this entry's GitHub Discussion. |

`interactions` (EoS):

| Field | Required | Meaning |
|---|---|---|
| `interfacePoints` | yes, non-empty | Subset of the six ADR-1239 interface points it binds: `command`, `dispatch`, `model`, `hooks`, `state`, `artifact`. |
| `profile` | yes | One of the three host-capability profiles: `programmatic-cli`, `declarative-cli`, `ide`. |
| `axes` | yes | Object carrying **all eight** required ADR-1239 negotiated axes keys — `embeddingMode`, `commandSurface`, `dispatch`, `modelMode`, `hookBus`, `stateIO`, `transport`, `runtime` — and **optionally** a ninth, `effortSurface` (`argv` \| `none`). No other key is accepted. `effortSurface` is optional because ADR-1239 amendment #2481 added it after entries already existed; requiring it would retroactively invalidate every entry published before the amendment. |

`axes` value vocabulary:

| Axis | Allowed values |
|---|---|
| `embeddingMode` | `imperative`, `declarative` |
| `commandSurface` | `slash-file`, `slash-programmatic`, `slash-toml`, `palette`, `prose-only` |
| `dispatch` | Free descriptive string (ADR-1239 `dispatch` is a structured object; the registry accepts a human summary). |
| `modelMode` | `active`, `passive` |
| `hookBus` | `host`, `engine`, `none` |
| `stateIO` | `filesystem`, `sandboxed-storage`, `session-log-append` |
| `transport` | `mcp`, `native-extension` |
| `runtime` | `node`, `bun`, `sandboxed-web`, `python`, `go`, `rust`, `electron`, `other` |

Example:

```json
{
  "id": "acme-editor-embed",
  "name": "Acme Editor GSD Embed",
  "type": "eos",
  "repo": "some-org/acme-gsd-embed",
  "description": "Embeds GSD as an orchestration engine inside the Acme editor's command palette.",
  "author": "Some Org <hello@some-org.example>",
  "license": "Apache-2.0",
  "enginesGsd": ">=1.6.0",
  "protocolVersion": 1,
  "install": "Install the Acme GSD Embed extension from the Acme marketplace — see https://github.com/some-org/acme-gsd-embed#install",
  "uninstall": "Remove the extension from Acme's extension manager.",
  "interactions": {
    "interfacePoints": ["command", "dispatch", "model", "hooks", "state", "artifact"],
    "profile": "ide",
    "axes": {
      "embeddingMode": "declarative",
      "commandSurface": "palette",
      "dispatch": "Routes palette invocations through Acme's own task-runner to gsd_run",
      "modelMode": "active",
      "hookBus": "host",
      "stateIO": "filesystem",
      "transport": "native-extension",
      "runtime": "electron"
    }
  },
  "discussion": "https://github.com/open-gsd/gsd-core/discussions/1235"
}
```

---

## Submission process

Registration is a **documentation PR**, per [CONTRIBUTING.md → Documentation Updates](../../CONTRIBUTING.md#documentation-updates--update-the-relevant-docs):

1. **Fork** the repository.
2. **Edit** `docs/registries/capabilities.json` (Capability Registry) or `docs/registries/eos.json` (EoS Registry) and append exactly one entry matching the [schema](#entry-schema) above.
3. **Run `npm run gen:registry`** to regenerate the corresponding `docs/registries/capability-registry.md` or `docs/registries/eos-registry.md`. Commit both the JSON source and the regenerated markdown.
4. **Open a PR** from a `docs/<issue#>-<slug>` branch (see CONTRIBUTING.md branch-naming conventions) using the [registry-entry PR template](../../.github/PULL_REQUEST_TEMPLATE/registry-entry.md).
5. A maintainer reviews and merges. The only gate is whether the entry is a real, linkable solution with all required fields present — not a quality judgment (see [Non-endorsement stance](#non-endorsement-stance)).

**One entry = one PR.** Do not bundle multiple registry additions, updates, or removals into a single PR.

**The generated `.md` files are GENERATED — never hand-edit them.** `docs/registries/capability-registry.md` and `docs/registries/eos-registry.md` are produced by `scripts/gen-registry.cjs` from `capabilities.json` / `eos.json`. A PR that edits the generated markdown without a matching JSON source change will fail the `gen:registry --check` drift gate. Always edit the JSON and regenerate.

---

## Latest-release tracking

Each entry embeds a live [shields.io](https://shields.io) badge and a permalink to the linked repository's latest GitHub Release:

```
![release](https://img.shields.io/github/v/release/OWNER/REPO?sort=semver&include_prereleases)
```

```
https://github.com/OWNER/REPO/releases/latest
```

There is no re-registration on new releases: register once, and your GitHub Releases are the update channel forever. The badge and permalink are rendered live by GitHub's markdown viewer directly from the linked repository — the registry itself never needs a follow-up PR when you cut a new version.

---

## Ranking + comments

Ranking and community feedback live in **GitHub Discussions**, not in the registry markdown. Each merged entry — from either registry — gets exactly one Discussion in the dedicated `EoS Registry` Discussions category:

- **Upvotes** on the Discussion post and on individual comments, with GitHub's built-in **Top** sort surfacing the most-upvoted community feedback first.
- **Threaded comments** for experience reports, questions, and follow-up from other users.

**Operational setup (one-time, per repo):** a repo admin creates the `EoS Registry` category under this repository's Discussions settings, using the **open-ended discussion** format. From then on, every merged entry gets its own Discussion thread created in that category, and the thread's URL is recorded in the entry's `discussion` field (see [Entry schema](#entry-schema) above) so the generated catalog links directly to it. Despite its name, the category carries threads for **both** registries — `discussion` is required on Capability entries exactly as it is on EoS entries.

**The open-ended format is required, and the choice is not cosmetic.** Because `discussion` is a required field, the thread must exist *before* the entry's PR is opened — and the person opening it is the entry's author, an outside contributor holding neither `maintain` nor `admin` permission on this repository. GitHub's **Announcement** format restricts starting new discussions to those two permission levels, so choosing it blocks every external submission at the first step, while still looking correctly configured to the admin who set it up. **Question/Answer** adds answer-marking, which pins one reply above the rest of a thread — a directory entry has no answer, and the pinning cuts across the upvote **Top** ordering described above. Open-ended is the format this process requires.
