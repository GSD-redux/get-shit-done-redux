# Capability matrix reference

> **Generated file — do not edit by hand.**
> This matrix is generated from the capability registry by
> `scripts/gen-capability-matrix.cjs` and kept honest by a drift guard
> (`tests/capability-matrix-sync.test.cjs` runs `--check`). Any manual edit is
> overwritten on the next generation run. To change a capability's declared
> metadata, edit the corresponding `capabilities/<id>/capability.json` and run
> `node scripts/gen-capability-matrix.cjs --write`.

See also: [ADR-1244](../adr/1244-capability-ecosystem.md) —
[Capability manifest fields](#manifest-field-reference) —
[The capability trust model](../explanation/capability-trust-model.md)

---

## Column definitions

| Column | Description |
|---|---|
| **id** | Canonical capability identifier; unique across first- and third-party capabilities. Reserved prefixes: `gsd-`, `gsd-core-`, `anthropic-`. |
| **role** | `feature` — extends what the loop does; `runtime` — adapts GSD to a specific AI runtime/IDE. |
| **tier** | `core` — always active; `standard` — active when the runtime supports it; `full` — opt-in or runtime-specific. |
| **engines.gsd** | Semver RANGE expressing host-version compatibility. A hard gate at install and at load. `—` means the capability declares no range. |
| **extension points** | The loop points this capability registers hooks into (from the registry's `byLoopPoint` index). `—` means it registers none (typical for runtime capabilities, whose job is surface emission). |
| **hook kinds** | Which of `step`, `contribution`, `gate` the capability's hooks use. `—` means none. |
| **source** | `first-party` — ships with GSD Core; `third-party` — installed from an external source via `gsd capability install`. |

> **On versions.** This matrix intentionally omits a per-capability `version`
> column. First-party capabilities are versioned **in lockstep** with the GSD
> Core package (their `capability.json` `version` always equals the GSD release
> version), so a per-row version would simply repeat the package version and
> churn the committed file on every release. The stable host-compatibility
> signal — `engines.gsd` — is shown instead. A third-party capability's exact
> version is recorded in the per-runtime ledger (`.gsd-capabilities.json`) at
> install time.

---

## Native (first-party) capabilities

First-party capabilities are implicitly trusted: they ship as part of the GSD
Core package and are stamped with the package version at release (per
ADR-1244 D6). They are not subject to the consent or integrity-pin flow applied
to third-party capabilities.

### Feature capabilities (role: feature) — 20

Feature capabilities extend what the loop does — contributing research,
planning, execution, verification, or ship artefacts at the loop extension
points.

| id | role | tier | engines.gsd | extension points | hook kinds | source |
|---|---|---|---|---|---|---|
| `ai-integration` | feature | full | `>=1.6.0` | `plan:pre`, `verify:pre` | step, contribution, gate | first-party |
| `assumption-delta` | feature | full | `>=1.6.0` | `plan:pre` | contribution | first-party |
| `audit` | feature | full | `>=1.6.0` | — | — | first-party |
| `broken-windows` | feature | full | `>=1.7.0` | `ship:pre` | gate | first-party |
| `claude-orchestration` | feature | full | `>=1.7.0` | `plan:post`, `execute:wave:pre` | contribution | first-party |
| `code-review` | feature | full | `>=1.6.0` | `execute:post` | step | first-party |
| `drift` | feature | full | `>=1.6.0` | `plan:pre`, `execute:wave:post` | gate | first-party |
| `external-job` | feature | full | `>=1.7.0` | `plan:post`, `execute:wave:post` | contribution | first-party |
| `gap-analysis` | feature | standard | `>=1.6.0` | `plan:post` | gate | first-party |
| `graphify` | feature | full | `>=1.6.0` | — | — | first-party |
| `intel` | feature | full | `>=1.6.0` | `plan:pre` | step | first-party |
| `mempalace` | feature | full | `>=1.6.0` | `discuss:pre`, `discuss:post`, `plan:pre`, `plan:post`, `execute:wave:post`, `verify:post`, `ship:post` | step, contribution | first-party |
| `nyquist` | feature | full | `>=1.6.0` | `verify:post` | step | first-party |
| `pattern-mapper` | feature | full | `>=1.6.0` | `plan:pre` | step | first-party |
| `profile-pipeline` | feature | full | `>=1.6.0` | — | — | first-party |
| `research` | feature | standard | `>=1.6.0` | `plan:pre` | step | first-party |
| `schema-gate` | feature | full | `>=1.6.0` | `plan:pre` | contribution | first-party |
| `security` | feature | full | `>=1.6.0` | `plan:pre`, `verify:post`, `ship:pre` | step, contribution, gate | first-party |
| `tdd` | feature | full | `>=1.6.0` | `plan:pre`, `execute:post` | contribution, gate | first-party |
| `ui` | feature | full | `>=1.6.0` | `plan:pre`, `execute:wave:post`, `verify:post` | step, gate | first-party |

### Runtime capabilities (role: runtime) — 19

Runtime capabilities adapt GSD to a specific AI runtime or IDE — emitting
skills, agents, hooks configuration, and surface files for that host. They
typically register no loop hooks (their primary responsibility is surface
emission), so their extension-point and hook-kind cells are `—`.

| id | role | tier | engines.gsd | extension points | hook kinds | source |
|---|---|---|---|---|---|---|
| `antigravity` | runtime | core | `>=1.6.0` | — | — | first-party |
| `augment` | runtime | core | `>=1.6.0` | — | — | first-party |
| `claude` | runtime | core | `>=1.6.0` | — | — | first-party |
| `cline` | runtime | core | `>=1.6.0` | — | — | first-party |
| `codebuddy` | runtime | core | `>=1.6.0` | — | — | first-party |
| `codex` | runtime | core | `>=1.6.0` | — | — | first-party |
| `copilot` | runtime | core | `>=1.6.0` | — | — | first-party |
| `cursor` | runtime | core | `>=1.6.0` | — | — | first-party |
| `hermes` | runtime | core | `>=1.6.0` | — | — | first-party |
| `kilo` | runtime | core | `>=1.6.0` | — | — | first-party |
| `kimi` | runtime | core | `>=1.6.0` | — | — | first-party |
| `kimi-code` | runtime | core | `>=1.7.0` | — | — | first-party |
| `opencode` | runtime | core | `>=1.6.0` | — | — | first-party |
| `pi` | runtime | core | `>=1.7.0` | — | — | first-party |
| `qwen` | runtime | core | `>=1.6.0` | — | — | first-party |
| `trae` | runtime | core | `>=1.6.0` | — | — | first-party |
| `vscode` | runtime | core | `>=1.7.0` | — | — | first-party |
| `windsurf` | runtime | core | `>=1.6.0` | — | — | first-party |
| `zcode` | runtime | core | `>=1.6.0` | — | — | first-party |

### Reviewer capabilities (role: reviewer) — 5

Reviewer capabilities declare a cross-AI **reviewer lane** — one external CLI or
model endpoint `/gsd:review` hands a plan to (ADR-2782 D3). They are not install
targets: they emit no skills, agents, hooks or surface files, so their
extension-point and hook-kind cells are `—`. A host that is *also* a reviewer
(Claude, Codex, Cursor, OpenCode, Qwen, Antigravity) keeps one manifest and
appears under **runtime** above, carrying its lane alongside its runtime body;
only lanes that GSD never installs into appear here.

Because a lane receives the plan text, requirements, research findings and
`CONTEXT.md` decisions, it is a disclosed executable surface and is consent-gated
at install like any other — see
[the trust model](../explanation/capability-trust-model.md).

| id | role | tier | engines.gsd | extension points | hook kinds | source |
|---|---|---|---|---|---|---|
| `coderabbit` | reviewer | full | `>=1.8.0` | — | — | first-party |
| `gemini` | reviewer | full | `>=1.8.0` | — | — | first-party |
| `llama-cpp` | reviewer | full | `>=1.8.0` | — | — | first-party |
| `lm-studio` | reviewer | full | `>=1.8.0` | — | — | first-party |
| `ollama` | reviewer | full | `>=1.8.0` | — | — | first-party |

---

## Third-party capabilities

This matrix is the **first-party catalogue**: it is generated from the committed
registry and therefore lists only the capabilities that ship with GSD Core.
Installed third-party capabilities are NOT written into this committed file. Once a
user installs one via `gsd capability install <spec>` it enters the **runtime
registry overlay** (ADR-1244 D2); the overlay-aware view of what is installed on a
given machine is `gsd capability list` (see the
[`gsd capability` command reference](gsd-capability-command.md)), which reports
first-party and installed third-party capabilities together using the same column
fields described below, with `source` = `third-party`.

### Column values for third-party rows

| Column | Value |
|---|---|
| **id** | As declared in `capability.json`. Must not use reserved prefixes (`gsd-`, `gsd-core-`, `anthropic-`). |
| **role** | `feature` or `runtime`, as declared. |
| **tier** | `core`, `standard`, or `full`, as declared. |
| **engines.gsd** | Range from `capability.json`; verified at install and at each load. |
| **extension points** | The loop points the capability registers into, validated against the known 12 identifiers. |
| **hook kinds** | `step`, `contribution`, and/or `gate` as declared. Disclosed in the consent summary at install. |
| **source** | `third-party` |

### Community registry

Whether GSD operates or advertises a central community registry of third-party
capabilities is **TBD/TBA** (PRD). The matrix mechanic and all manifest fields
ship regardless of that decision; URL/git/npm/tarball import does not depend on
a central registry.

---

## Manifest field reference

The fields below are defined in `capability.json` and govern how a capability
appears in this matrix. For the full schema, see
[ADR-1244 D1](../adr/1244-capability-ecosystem.md#d1--versioned-capability-manifest)
and the [capability manifest reference](capability-manifest.md).

| Field | Required | Type | Purpose |
|---|---|---|---|
| `version` | **Yes** | semver string | Capability version. The registry rejects manifests without it. |
| `engines.gsd` | Recommended | semver range | Host-version compatibility gate. Enforced at install and load. |
| `compatVersions` | No | object: cap-version → gsd-range | Graceful-downgrade table for sources that enumerate versions (git tags, registry, npm). |
| `integrity` | No | `sha512-<base64>` | SHA-512 digest of the fetched bundle. Verified before extraction when present; mismatch aborts. |
| `provenance` | No | `{ sourceRepo, commit }` | Source provenance; populated in CI for first-party/curated capabilities. |

---

## Related documents

- [ADR-1244 — Capability Ecosystem](../adr/1244-capability-ecosystem.md)
- [The capability trust model](../explanation/capability-trust-model.md) — why the trust rules are structured as they are
- [The phase loop](../explanation/the-phase-loop.md) — the 12 loop extension points in context
- [Capability manifest reference](capability-manifest.md) — the full `capability.json` schema
- [ADR-857](../adr/857-capability-system.md) — the original capability architecture (D7/D8 extended by ADR-1244)
