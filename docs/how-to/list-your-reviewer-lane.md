# How to list your reviewer lane in the registry

**Goal:** Get a reviewer lane you have built into the **Reviewer Lane Registry**, so other people can find it, install it, and give you feedback.

**Prerequisites:** A working lane in a public repository, with a tagged release. If you have not built one yet, start with [Ship a reviewer lane in your capability](ship-a-reviewer-lane.md). GSD 1.9.1 or later.

Listing is a documentation PR against `gsd-core`. There is no separate account, package publish, or approval queue — you append one JSON object, regenerate a catalog, and open a PR.

---

## Check you are aiming at the right catalog

GSD has three discoverability catalogs, and picking the wrong one costs you a review round-trip. Pick by what your capability *is*, not by what it does:

| Your capability | Catalog | Source file |
|---|---|---|
| A lane and nothing else — `role: "reviewer"`, GSD never installs into it | **Reviewer Lane Registry** | `docs/registries/reviewers.json` |
| A runtime GSD installs into, that *also* carries a `reviewer` body | Whichever matches its **primary install shape** — usually the Capability or EoS registry | `capabilities.json` / `eos.json` |
| A feature capability attaching at Loop Extension Points | Community Capability Registry | `docs/registries/capabilities.json` |

The Reviewer Lane Registry exists specifically for lanes that are **not install targets in their own right**. If your capability is a host integration that happens to review as well, it belongs under its primary shape — do not list it twice.

---

## Open the discussion thread first

The `discussion` field is **required**, so the thread has to exist before you open the PR. Doing this second is the most common way to get sent back.

Start an open-ended discussion in the **EoS Registry** category. Despite the name, that category carries threads for all three catalogs. One thread per entry; it is where upvotes, experience reports, and your follow-up live.

Keep the URL — it goes straight into the entry.

---

## Write your entry

Append **exactly one** object to `docs/registries/reviewers.json`:

```json
{
  "id": "acme-review-lane",
  "name": "Acme Review Lane",
  "type": "reviewer",
  "repo": "some-org/gsd-lane-acme",
  "description": "Adds an Acme-hosted model as an external reviewer lane for /gsd-review, evaluating diffs against Acme's static-analysis findings.",
  "author": "Some Org <hello@some-org.example>",
  "license": "MIT",
  "enginesGsd": ">=1.9.1",
  "install": "gsd capability install https://github.com/some-org/gsd-lane-acme.git#v1.0.0",
  "uninstall": "gsd capability remove acme-review-lane",
  "interactions": {
    "slug": "acme",
    "flags": ["--acme"],
    "transport": "openai-http",
    "evidenceClass": "diff-only",
    "reviewsSection": "## Acme Review",
    "requiresBinaries": [],
    "configKeys": ["acme.api_key"],
    "runtimeCompat": ["all"]
  },
  "discussion": "https://github.com/open-gsd/gsd-core/discussions/1236"
}
```

Three fields reject entries more often than the rest, so check them before anything else:

- **`interactions.slug`** must equal your manifest's `reviewer.slug` and follows the *lane* grammar `^[a-z0-9][a-z0-9_-]*$` — underscores and a leading digit are allowed (`lm_studio`, `4o-mini`). This is **not** the same grammar as the top-level `id`, which is kebab-only.
- **`interactions.flags`** are kebab even when the slug is snake: `lm_studio` → `--lm-studio`. Each must match `^--[a-z0-9][a-z0-9-]*$`.
- **`install`** and **`uninstall`** must be exact and copy-pasteable. Someone will paste them verbatim; a placeholder that does not run is the one thing a directory cannot tolerate.

**If a `configKeys` entry holds a live credential, say so in your README.** The example above declares `acme.api_key` to show the shape, and that shape has a consequence worth understanding before you copy it. Config values are written **in plaintext** to `.planning/config.json` — masking applies to display only, and that file is the security boundary. `planning.commit_docs` defaults to `true`, so unless the installing user has gitignored `.planning/`, a credential stored that way lands in their repository. None of the twelve first-party lanes stores a credential this way; they own only `review.models.*`, host, and prompt-budget keys. If your lane genuinely needs a secret, document the exposure for your users rather than leaving them to discover it — and never invent your own storage side-channel to route around it.

Everything else follows the shared entry shape. For the complete field-by-field table, see the [registry specification](../registries/README.md#reviewer-entries-reviewersjson-type-reviewer).

---

## Regenerate the catalog

Never hand-edit `docs/registries/reviewer-registry.md` — it is generated, and a drift gate will fail your PR:

```bash
npm run gen:registry
```

Commit **both** the JSON source and the regenerated markdown.

---

## Open the PR

Branch as `docs/<issue#>-<slug>`, and use the [registry-entry PR template](../../.github/PULL_REQUEST_TEMPLATE/registry-entry.md).

**One entry, one PR.** Do not bundle additions, updates, or removals together.

A maintainer checks one thing: whether the entry is a real, linkable solution with every required field present. It is not a quality review — inclusion is explicitly [not an endorsement](../registries/README.md#non-endorsement-stance), and entries are removed only for illegal content, malware, spam, or a dead link. Nobody will reject your lane for design decisions they would have made differently.

---

## Ship new versions without touching the registry

**Register once.** Your GitHub Releases are the update channel from then on.

Each entry embeds a live shields.io badge and a permalink to your repository's latest release, rendered directly by GitHub's markdown viewer. Cutting `v1.1.0` updates what visitors see with no follow-up PR.

The one thing worth revisiting is `enginesGsd` — if a later version of your lane starts depending on a newer GSD, update that range so the catalog does not advertise compatibility you no longer support.

---

## Related

- [Ship a reviewer lane in your capability](ship-a-reviewer-lane.md) — build the lane you are listing
- [Registry specification](../registries/README.md) — the full entry schema, non-endorsement stance, and removal policy
- [Reviewer Lane Registry](../registries/reviewer-registry.md) — the generated catalog itself
- [Publish a capability](publish-a-capability.md) — versioning, `engines.gsd`, and distribution
