## Registry Entry PR

> **Using the wrong template?**
> — Bug fix: use [fix.md](?template=fix.md)
> — New feature (not a registry listing): use [feature.md](?template=feature.md)
> — Enhancement to existing behavior: use [enhancement.md](?template=enhancement.md)

Full schema and process: [docs/registries/README.md](../../docs/registries/README.md).

---

## Registry type

<!-- Check exactly one. -->

- [ ] Capability Registry entry — adds/updates one object in `docs/registries/capabilities.json`
- [ ] EoS Registry entry — adds/updates one object in `docs/registries/eos.json`
- [ ] Reviewer Lane Registry entry — adds/updates one object in `docs/registries/reviewers.json`

## The entry

<!-- Paste the exact JSON object you added, unmodified. -->

```json
{
  "id": "",
  "name": "",
  "type": "",
  "repo": "",
  "description": "",
  "author": "",
  "license": "",
  "enginesGsd": "",
  "install": "",
  "uninstall": "",
  "interactions": {},
  "discussion": ""
}
```

---

## Required-field checklist

- [ ] `id`, `name`, `type`, `repo`, `description`, `author`, `license`, `enginesGsd`, `install`, `uninstall`, `interactions`, `discussion` are all present and non-empty
- [ ] **(Capability entries only)** `interactions.loopExtensionPoints` is a non-empty subset of the 12 Loop Extension Points, `interactions.hookKinds` ⊆ `{step, contribution, gate}`, and `interactions.configKeys` / `requires` / `runtimeCompat` / `produces` / `consumes` are present (empty arrays are fine where nothing applies)
- [ ] **(EoS entries only)** `protocolVersion` is an integer ≥ 1, `interactions.interfacePoints` is a non-empty subset of the six interface points, `interactions.profile` is one of `programmatic-cli` / `declarative-cli` / `ide`, and `interactions.axes` has exactly the eight required axis keys plus, optionally, `effortSurface` (`argv` / `none`)
- [ ] **(Reviewer entries only)** `interactions.slug` matches the lane slug grammar `^[a-z0-9][a-z0-9_-]*$`, `interactions.flags` is a non-empty array matching `^--[a-z0-9][a-z0-9-]*$`, `interactions.transport` is `spawn` or `openai-http`, `interactions.evidenceClass` is `source-grounded` or `diff-only`, `interactions.reviewsSection` is a non-empty string (max 200 characters), and `interactions.requiresBinaries` / `configKeys` / `runtimeCompat` are present (empty arrays are fine where nothing applies)

## Ownership & non-endorsement

- [ ] `repo` links to a repository **I own or am the primary maintainer of** — not a fork, mirror, or someone else's project
- [ ] I understand that inclusion in this registry means only that a maintainer merged this PR — it is **not** an endorsement, and GSD has not reviewed, tested, audited, or verified my solution or its claimed GSD interactions
- [ ] I understand this entry is removed only for illegal content, malware, spam, or a dead/non-functional link — never for quality — and a maintainer may remove it on that narrow basis without further notice

## One entry, one PR

- [ ] This PR adds or updates exactly **one** entry, in exactly one of `capabilities.json` / `eos.json` / `reviewers.json`
- [ ] I have not bundled any other registry entry, code change, or unrelated docs change into this PR

## Generated file in sync

- [ ] I ran `npm run gen:registry` after editing the JSON source, and this PR includes the regenerated `docs/registries/capability-registry.md`, `docs/registries/eos-registry.md`, or `docs/registries/reviewer-registry.md`
- [ ] I did **not** hand-edit the generated `.md` file directly — all edits were made to the JSON source

## Documentation

> CI enforces `lint:docs` for any changeset fragment typed `Added` / `Changed` / `Deprecated` / `Removed` — it must also touch a file under `docs/`. The JSON source and its regenerated markdown, both under `docs/registries/`, satisfy this.

- [ ] This PR includes both the JSON source file and the regenerated markdown file under `docs/registries/`

## Checklist

- [ ] `npm run validate:registry` passes locally against my entry
- [ ] `discussion` links to a GitHub Discussion in the `Registry` category (or notes that one will be created on merge, per [docs/registries/README.md](../../docs/registries/README.md))
- [ ] `.changeset/` fragment added with an `Added` type describing the new listing

---

## Example filled entry

<!-- Reference only — delete this section before submitting your PR. -->

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
