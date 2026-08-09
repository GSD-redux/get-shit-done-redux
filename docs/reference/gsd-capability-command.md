# `gsd capability` Command Reference

> **CLI form:** `gsd capability`
> **Canonical ADR:** [ADR-1244](../adr/1244-capability-ecosystem.md)
> **See also:** [Capability Manifest Reference](capability-manifest.md) · [How to develop a capability](../how-to/develop-a-capability.md) · [The capability trust model](../explanation/capability-trust-model.md)

The `capability` family manages the installation, upgrade, removal, and inspection of GSD capabilities — both first-party (shipped) and third-party overlays. A row for this command also appears in [docs/COMMANDS.md](../COMMANDS.md) (that file is not edited here).

**Implemented:** `install`, `update`, `remove`, `list`, `outdated`, `trust`, `disable`, `enable` (plus the pre-existing `state` and `set` introspection/activation subcommands).

---

## Subcommands

### `install`

**Synopsis**

```
gsd capability install <spec> [--integrity sha512-<hash>] [--scope global|project] [--yes] [--shared-file <rel>]…
```

**Arguments**

| Argument | Description |
|---|---|
| `<spec>` | Source specification (see [Source specifications](#source-specifications) below). |

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--integrity` | `sha512-<base64>` | — | SHA-512 hash of the downloaded artifact, verified before extraction. When supplied, a mismatch aborts the install. **Per-source semantics (a supplied value is never silently ignored):** for **tarball** and **npm** sources it is verified over the downloaded artifact bytes (the fetched `.tgz` for tarball; the `npm pack` `.tgz` for npm — both the same SRI sha512 domain); for **git** and **local** sources there is no single downloadable artifact to hash, so a supplied `--integrity` is **rejected** with an actionable error (git: pin the commit with `#sha:<commit>` instead; local: not supported). When the source registry or `capability.json` already carries an `integrity` field, both must agree. |
| `--scope` | `global` \| `project` | `global` | Installation root (see [Install layout](#install-layout)). |
| `--yes` | flag | off | Grant consent for the capability's executable surfaces non-interactively. The disclosure is still printed. Without it, an install that declares executable surfaces is **aborted** after printing the disclosure (the CLI is non-interactive — there is no prompt to answer). |
| `--shared-file` | path (repeatable) | — | A file, **relative to the scope root**, into which the capability's disclosed hooks / MCP servers should be spliced (e.g. a runtime's `settings.json`). Each fragment is marker-isolated so `remove` can strip exactly it. When omitted, the bundle still installs (declaratively); no shared-file edits are made. |

**Behaviour**

Resolves `<spec>` to a versioned, staged capability bundle. The pipeline is: fetch → verify integrity or SHA pin → check `engines.gsd` against the installed GSD version → disclose executable surfaces (hooks, command modules, MCP servers) and instruction surfaces (skills) → obtain consent (a declarative capability needs none; an executable one requires `--yes` — disclosed instruction surfaces do not by themselves trigger this requirement) → validate the incoming manifest against the trust invariants → extract to the scope root → write the ledger entry atomically.

An overlay whose `id` uses a reserved first-party prefix (`gsd-`, `gsd-core-`, `anthropic-`) is rejected before extraction. Install never executes capability code; staging is copy-only. A declined install (executable surface, no `--yes`) writes **nothing** — no bundle, no ledger entry, no shared-file edits.

A best-effort reconciliation sweep runs before the mutation to recover any crash orphans from a prior interrupted operation.

The ledger file (`<scope-root>/.gsd-capabilities.json`, see [Install layout](#install-layout)) records the installed version, source, integrity hash, owned files, and any fragments written into shared files.

---

### `update`

**Synopsis**

```
gsd capability update [<id> | --all] [--scope global|project] [--yes] [--shared-file <rel>]…
```

**Arguments**

| Argument | Description |
|---|---|
| `<id>` | Capability identifier to update. Omitting both `<id>` and `--all` is an error; passing both is an error. |

**Flags**

| Flag | Description |
|---|---|
| `--all` | Re-resolve and update **every** installed overlay capability in the chosen scope. |
| `--scope` | Scope root to operate in (`global` default; see [Install layout](#install-layout)). |
| `--yes` | Grant consent when the new version's executable set differs from the previously consented one. |
| `--shared-file` | As for `install` — where to splice the (re-derived) hook / MCP fragments. |

**Behaviour**

Re-resolves the capability's **recorded source** (the `source` stored in its ledger entry at install time) and, if the resolved version differs, performs an atomic stage-then-swap: the new bundle is fully staged, verified, and validated before the ledger write commits the swap. A crash during staging leaves the previous version intact; a crash after the ledger write leaves the new version intact, and a reconciliation sweep on the next run resolves any orphaned files.

For third-party capabilities, a version whose executable set (hooks, command modules, MCP servers) differs from the previously consented version requires `--yes` to re-consent before the swap completes; without it the update is aborted and the old version is left fully intact.

`--all` iterates every ledger entry in the scope and reports a per-capability outcome (`upgraded` / `not_installed` / `aborted` / `blocked`). Update availability is source-dependent:

| Source kind | Re-resolution behaviour |
|---|---|
| git (`https://…/repo.git#<tag>`) | Remote tag fetch |
| npm (`npm:@org/pkg@<range>`) | `npm dist-tags` / range resolution |
| tarball (`https://…/cap-x.y.z.tgz`) | Re-fetch of the recorded URL |
| local (`./local/path`) | Re-read of the recorded filesystem path |
| registry (`<name>@<registry>`) | **Not yet implemented** — the registry source kind is reserved; re-resolution throws, so an overlay recorded from a registry spec cannot currently be updated. |

---

### `remove`

**Synopsis**

```
gsd capability remove <id> [--purge-data] [--scope global|project]
```

**Arguments**

| Argument | Description |
|---|---|
| `<id>` | Identifier of the installed overlay capability to remove. |

**Flags**

| Flag | Description |
|---|---|
| `--purge-data` | Also remove data files created by the capability at runtime (artefacts under the capability's declared paths that are not part of the install bundle). |
| `--scope` | Scope root to remove from (`global` default). |

**Behaviour**

Reads the ledger entry for `<id>` and removes exactly: the owned files listed in `files`, and the fragments written into shared files listed in `sharedEdits` (e.g. hook registrations spliced into a `settings.json`). Shared files themselves are not deleted; only the capability's marker-isolated fragments are stripped. The ledger entry is removed atomically after all file operations complete.

First-party capabilities (shipped with GSD) **cannot** be removed via this subcommand — `remove` rejects a first-party `id` and points at the product uninstaller (`gsd --uninstall`).

---

### `disable`

**Synopsis**

```
gsd capability disable <id> [--config-dir <path>] [--runtime <r>] [--scope <s>]
```

**Behaviour**

Marks the capability **inactive** in the runtime activation state — identical to `gsd capability set <id> --off`. A disabled capability stays on disk; it is excluded from the active surface and contributes no hooks, config keys, or loop extension registrations until re-enabled. This toggles the capability-state layer (the runtime config), not the install ledger.

> **Scope: first-party capabilities only.** `<id>` is validated against the **build-time first-party registry** (the generated `capability-registry.cjs`). An installed **third-party overlay** — one added with `gsd capability install …` — is **not** in that registry, so `disable` rejects it with `unknown capability: "<id>"`. Deactivate an installed overlay with [`gsd capability remove <id> --scope <scope>`](#remove) instead.

`enable` reverses a disable without re-fetching.

---

### `enable`

**Synopsis**

```
gsd capability enable <id> [--config-dir <path>] [--runtime <r>] [--scope <s>]
```

**Behaviour**

Clears the inactive flag for `<id>` in the runtime activation state — identical to `gsd capability set <id> --on`. On the next GSD invocation the capability is included in the active surface again, subject to its `engines.gsd` range (an incompatible capability is still skipped with a warning at load time).

> **Scope: first-party capabilities only.** Like `disable`, `enable` validates `<id>` against the build-time first-party registry and rejects an installed overlay with `unknown capability: "<id>"`. There is no `enable` for an installed overlay — re-install it with [`gsd capability install …`](#install) if it was removed.

---

### `set`

**Synopsis**

```
gsd capability set <id> [--on | --enable | --off | --disable] [--gate <key>=<bool>]… [--config-dir <path>] [--runtime <r>] [--scope <s>]
```

**Flags**

| Flag | Description |
|---|---|
| `--on` / `--enable` | Surface the capability (activate its skills). Mutually exclusive with `--off`/`--disable`. |
| `--off` / `--disable` | Unsurface the capability (deactivate its skills). Mutually exclusive with `--on`/`--enable`. |
| `--gate <key>=<bool>` | Set one capability **gate** to `true` or `false`. Repeatable to set several gates in one call. `<bool>` must be the literal `true` or `false`; any other value is rejected. |
| `--config-dir <path>` | Override the runtime config directory the surface state is read from and written to. |
| `--runtime <r>` | When given, re-materialise the surface (rewrite skill files) for runtime `<r>` after the state change. |
| `--scope <s>` | The materialise scope (`global` or `project`); only meaningful together with `--runtime`. Defaults to `global`. |

**Behaviour**

`set` is the single write verb behind the capability **activation** axes. It mutates two independent layers and then re-resolves and reports the capability's state:

- The **enabled** axis (`--on`/`--off`) toggles whether the capability's skills are on the runtime surface (the same mechanism `disable`/`enable` use; `disable`/`enable` are thin aliases for `set … --off`/`--on`).
- The **gate** axis (`--gate`) writes capability-owned config keys into `.planning/config.json`.

> **Scope: first-party capabilities only.** `set` validates `<id>` against the **build-time first-party registry** (the generated `capability-registry.cjs`); an unrecognized id — including any installed **third-party overlay** — is rejected with `unknown capability: "<id>"` and no writes are performed. `set` is for the activation/gate axes of first-party capabilities; to turn off an installed overlay use [`gsd capability remove`](#remove).

A **gate** is a dotted config key declared in the capability's `config` slice whose boolean value controls whether one of the capability's loop hooks fires. Setting a gate to `false` stops that hook running while leaving the capability surfaced; setting it to `true` re-arms it. A `--gate <key>=…` whose `<key>` is not a declared config key of `<id>`, or whose value is not boolean, is rejected and **no** writes are performed (the whole operation is validated before any state is written).

The command is **fail-closed on intent**: if you ask to enable a capability whose skills are not in the install profile, or whose surface/profile does not actually carry it, the operation reports an error rather than silently no-op'ing. Enabling a capability that owns no skills is an advisory warning (use gates to toggle its hooks instead). Surfacing a capability whose every hook is gated off is reported as a warning ("surfaced but every hook is gated off — did you mean `--off`?").

In `--raw` mode the full `{ capabilities, warnings, errors }` envelope is emitted as JSON and the process exits non-zero when `errors` is non-empty; in human mode warnings and errors are written to stderr and a one-line summary of the target capability (`enabled`, `surfaced`, `installed`, active-hook count) is printed.

---

### `list`

**Synopsis**

```
gsd capability list [--json] [--scope global|project]
```

**Flags**

| Flag | Description |
|---|---|
| `--json` | Currently a **no-op**: `list` always emits the JSON array regardless of this flag. The flag is accepted for forward compatibility — a formatted human-readable table is planned, at which point `--json` will select the JSON form. Do not rely on omitting `--json` to get non-JSON output today. |
| `--scope` | Read only the given scope's overlay ledger (`global` or `project`). When omitted, both overlay scopes are swept. First-party capabilities are always listed regardless of `--scope`. |

**Behaviour**

Lists capabilities visible to the current session: first-party capabilities (from the registry) plus installed overlay capabilities. With no `--scope`, both the `global` and `project` overlay scopes are swept; with `--scope`, only that scope's overlay ledger is read. Emits a JSON array of descriptors.

**Output shape**

```json
[
  {
    "id": "string",
    "role": "feature | runtime | null",
    "version": "semver | null",
    "tier": "core | standard | full | null",
    "source": "first-party | <recorded source string>",
    "scope": "first-party | global | project",
    "status": "active | incompatible | inactive",
    "reason": "string | null",
    "title": "string | null"
  }
]
```

`status` values:

| Value | Meaning |
|---|---|
| `active` | Present and (for overlays) compatible with the running GSD version and — for project-scope overlays — backed by a user consent record on this machine. |
| `incompatible` | An overlay whose `engines.gsd` range does not satisfy the current GSD version; skipped with a warning at load time. |
| `inactive` | A **project-scope** overlay that is present on disk (and may have a committed-looking project ledger) but has **no user consent record on this machine** (#1459). It is *discovered but not activated*: it contributes no surfaces and runs nothing. The accompanying `reason` field explains why. Consent it by re-installing through the lifecycle (`gsd capability install … --scope project`). |

The `reason` field is present on **overlay** rows: `null` for active/incompatible overlays and a short explanation for `inactive` ones. First-party rows omit `reason` (and `scope`/`source`/`status` are always `first-party`/`first-party`/`active`).

> Whether a capability has been turned off via `disable` is reported by `gsd capability state` (the activation-state view), not by `list`.

---

### `outdated`

**Synopsis**

```
gsd capability outdated [--json] [--scope global|project]
```

**Flags**

| Flag | Description |
|---|---|
| `--json` | Emit the records array as JSON (machine output). When omitted, a human-readable table is printed instead (columns: `ID`, `Source`, `Current`, `Latest`, `Status`). |
| `--scope` | Read only the given scope's ledger (`global` or `project`). When omitted, both scopes are swept (mirroring `list`). |

**Behaviour**

For every installed overlay capability in the chosen scope(s), `outdated` performs a **light remote peek** of the capability's **recorded source** (the `source` stored in its ledger entry at install time) to learn the latest version that re-resolving that source would install, then compares it (numeric `major.minor.patch`) with the installed version. It is a metadata-only read — it never re-clones, re-packs, or re-extracts a bundle. A failing, timed-out, or unsupported peek **degrades** that row to `status: unknown`; it never crashes the command, and a single bad entry never suppresses the others.

A capability is reported `outdated` **only if** re-resolving its recorded source (exactly what `update` does) would fetch a **newer** version than the one installed. A source pinned to an **immutable** ref — a git `#sha:<commit>` or `#tag:<tag>` fragment, or an **exact** npm version (`npm:@org/pkg@1.2.3`) — is never `outdated`: `update` re-resolves to the same commit/tag/version, so the row is reported `status: pinned` instead.

A **bare** git ref fragment (`…repo.git#<ref>`) is **ambiguous** — it may name an immutable tag or a **mutable branch**. `outdated` resolves it at the remote with a bounded `git ls-remote <url> <ref>` (the same safe argv-only seam, no shell): a ref that resolves under `refs/tags/` is an immutable tag → `status: pinned`; a ref that resolves under `refs/heads/` is a **mutable branch** (`update` re-clones and checks out the branch HEAD, which can move) and is therefore **never** reported `pinned`. Because the ledger does not record the commit a git source was installed at, a moved branch HEAD cannot be compared against the installed commit, so a branch-tracked source degrades to `status: unknown`. An unresolvable / ambiguous / errored / timed-out classification also degrades to `unknown`.

The per-source "update available?" matrix (ADR-1244 D6):

| Source kind | Latest-version peek | Bound |
|---|---|---|
| git, **unpinned** (`https://…/repo.git`, tracks default branch) | `git ls-remote --tags` → highest **stable** semver tag (`v`-prefix and `^{}` peeled entries handled; prerelease/junk tags ignored) | ≤ 30s |
| git, **pinned** (`…repo.git#sha:…` / `#tag:…`) | immutable ref → `status: pinned` (no peek; `update` will not move it) | — |
| git, **bare ref** (`…repo.git#<ref>`) | `git ls-remote <url> <ref>` classifies the ref: `refs/tags/…` → `status: pinned` (immutable tag); `refs/heads/…` → **mutable branch**, never `pinned` (no installed commit recorded to compare against → `status: unknown`); unresolvable/ambiguous → `status: unknown` | ≤ 30s |
| npm **range** (`npm:@org/pkg@^1`) | `npm view <pkg>@<range> version` → **highest version matching the recorded range** (npm prints one line per match; the numeric max satisfying the range is what `update` installs) | ≤ 60s |
| npm **latest** (`npm:@org/pkg`, no version) | `npm view <pkg> version` → the single `latest` dist-tag version | ≤ 60s |
| npm **exact** (`npm:@org/pkg@1.2.3`) | pinned exact version → `status: pinned` (no peek; `update` re-installs the same version) | — |
| local (`./path` or absolute) | re-read of `capability.json` at the recorded path | — |
| tarball (`https://…/cap-x.y.z.tgz`) | **not auto-detectable** — one immutable URL → `status: manual` | — |
| registry (`<name>@<registry>`) | registry adapter not yet implemented → `status: unknown` | — |

**Output shape** (`--json`)

```json
[
  {
    "id": "string",
    "sourceKind": "git | npm | local | tarball | registry | unknown",
    "current": "semver | null",
    "latest": "semver | null",
    "status": "outdated | current | pinned | manual | unknown",
    "scope": "global | project"
  }
]
```

`status` values:

| Value | Meaning |
|---|---|
| `outdated` | Re-resolving the recorded source would fetch a newer version than the installed one (for an npm range, the latest version **matching the recorded range**). Run `gsd capability update <id>` to upgrade. |
| `current` | The installed version is the latest the recorded source would resolve to (or newer). |
| `pinned` | The recorded source is pinned to an **immutable** ref (git `#sha:`/`#tag:`, or a bare git `#<ref>` that resolves to a tag) or an exact npm version; `update` re-resolves to the same commit/tag/version, so it can never be `outdated`. A bare git ref that resolves to a **mutable branch** is never `pinned`. |
| `manual` | The source (a bare tarball URL) cannot be auto-checked; re-install from a new URL to upgrade. |
| `unknown` | The peek failed (network error / timeout / non-zero exit / unparseable output), the source kind is not auto-checkable (registry), or the source tracks a mutable git branch whose installed commit was not recorded (so a moved branch HEAD cannot be compared). |

An empty (or missing) ledger reports nothing: `--json` emits `[]`; the table notes that there are no installed overlay capabilities.

---

### Instruction surfaces (skills)

A capability's declared `skills` stems are **instruction surfaces**: each stem's body — its `SKILL.md` — is copied verbatim into the runtime's instruction context, where it reaches the agent directly. `install` and `update` list every such stem by name in the disclosure printed before the pipeline proceeds, alongside the executable-surface disclosure.

ADR-2363 D3 classifies `agents` as an instruction surface too, but a third-party capability's declared `agents[]` are not disclosed here: they are never staged into the agent's instruction context — the staging path that unions third-party skills into a runtime's skills directory has no equivalent for agents — so naming them would name a surface that does not exist. This is not a claim that agents are safe or inert, only that they are not currently staged for third-party capabilities.

An instruction surface is disclosed but is **not** an executable surface: naming it does not set `hasExecutable` and it does not enter the `disclosureSignature`, so adding, removing, or changing skills between versions does not by itself require `--yes` or force re-consent on `update`. See [ADR-2363](../adr/2363-capability-instruction-surface-trust.md) D3 (the instruction-surface classification) and D4 (why it is excluded from the disclosure signature).

Bodies are not content-scanned, at install, update, or any later point — disclosure names the surface; it never inspects what it contains.

---

### `trust`

Manage the **user-owned consent store** (#1459) that gates project-scope third-party capability activation. The store lives at `${GSD_HOME||homedir()}/.gsd/consent.json` — **outside any repository** — and records, per `(realpath(projectRoot), capability id)`, the bundle integrity and disclosure signature you consented to **on this machine**. A project-scope overlay is inactive until such a record exists (so a forged or cloned in-repo project ledger activates nothing on its own); installing a project-scope capability through the lifecycle writes the record, and removing it revokes the record.

**Synopsis**

```
gsd capability trust list [--scope project] [--json]
gsd capability trust revoke <id> [--project <path>]
```

**`trust list`** emits a JSON array of the consent records for the current consent home:

```json
[
  {
    "id": "string",
    "scope": "project",
    "projectRoot": "/abs/realpath/of/project",
    "integrity": "sha512-… | (empty)",
    "disclosureSignature": "string",
    "contentHash": "sha512-…",
    "consentedAt": "ISO-8601 timestamp"
  }
]
```

`--scope` is accepted for symmetry; only `project` records exist today.

**`trust revoke <id>`** deletes the consent record for `<id>` at the project root. `--project <path>` pins the project root whose consent is revoked (defaults to `realpath(cwd)`). After revoking, the capability — even if its bundle and project ledger remain on disk — lists as `status: inactive` and contributes nothing until you re-consent. `remove` already revokes consent as part of an uninstall; `trust revoke` is the way to withdraw consent **without** uninstalling the bundle.

---

## Source specifications

The `install` subcommand accepts the following source specification forms.

| Form | Example | Adapter | `--integrity` |
|---|---|---|---|
| Git URL with tag | `https://github.com/org/repo.git#v1.2.0` | Git — clones/fetches at the specified tag; `#sha:<40-hex>` pins a specific commit. | **Rejected** — a clone is a directory tree, not a single hashable artifact. Pin the commit with `#sha:<commit>` instead. |
| npm package | `npm:@org/gsd-capability-foo@^1.0.0` | npm — resolves via `npm dist-tags` / semver range; installs with `--ignore-scripts`. | Verified over the `npm pack` `.tgz` bytes (same SRI sha512 domain as a tarball). |
| Tarball URL | `https://host/path/cap-x.y.z.tgz` | Tarball — fetches over HTTPS. | Verified over the downloaded `.tgz` bytes. |
| Local path | `./local/path` (or an absolute path) | Local — copies from the filesystem path. Auto-update detection is not available for this form. | **Rejected** — a local directory has no single hashable artifact; integrity pinning is not supported for local sources. |
| Registry name | `my-cap@gsd-registry` | **Reserved — not yet implemented.** The spec form parses, but there is no first-party registry endpoint, so resolution throws and the install fails. Use a git, npm, tarball, or local source today. | n/a |

Which source forms are *permitted* is governed by the `capabilities.strict_known_registries` policy (see [Configuration](../CONFIGURATION.md) and [the capability trust model](../explanation/capability-trust-model.md)): `null`/absent is permissive, `[]` is lockdown (no third-party sources), and a host allowlist permits only matching registries. This policy is **project-scoped** — it is read from the current project's `.planning/config.json` and applied to installs run in that project regardless of `--scope`; there is no machine-wide source allowlist. (A present-but-unparseable config fails **closed** — external installs are blocked until it is fixed.)

All permitted forms pass through the same pipeline: fetch → verify integrity or SHA pin → check `engines.gsd` → obtain consent → validate → extract → record ledger.

---

## Install layout

Installed overlay capabilities are written under a **scope root** selected by `--scope`:

| Scope | Scope root | Bundle path | Ledger file |
|---|---|---|---|
| `global` | `$GSD_HOME`, defaulting to your home directory | `<root>/.gsd/capabilities/<id>/` | `<root>/.gsd-capabilities.json` |
| `project` | the current project root | `<root>/.gsd/capabilities/<id>/` | `<root>/.gsd-capabilities.json` |

The ledger is the commit point for installs and upgrades. Its entries record the installed version, original source, integrity hash, owned files, and shared-file edits. A reconciliation sweep on the next GSD run resolves crash orphans (files on disk without a ledger entry, or ledger entries with missing files). These paths are exactly the ones the runtime registry overlay reads when composing installed capabilities, so an `install` is visible to the loop without any further step.
