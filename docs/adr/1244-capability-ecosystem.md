# ADR-1244 — Capability Ecosystem: third-party authoring, versioned manifests, and URL import/upgrade/remove

- **Status:** Accepted — ratified 2026-07-17 (originally Proposed 2026-06-14); see "Ratification" below
- **Date:** 2026-06-14
- **Amended by:** [ADR-2782](2782-reviewer-lane-capability-surface.md) (Reviewer Lane capability surface) — **D5 gains a fourth executable-surface disclosure class**, the reviewer lane, which is the first disclosed surface that *receives* data rather than only executing: a lane is piped plan text, requirements, research findings, and `CONTEXT.md` decisions. D9's capability matrix gains a reviewer-lane column.

> **Relationship to other ADRs.** This ADR **amends and extends ADR-857 Decisions 7 and 8** — it does not reverse them. ADR-857 D7 deferred third-party code-loading "to its own ADR"; D8 deferred third-party CLI support "to an external loader + trust/validation gate, no rework because runtimes are already descriptors." This *is* that ADR, and it *delivers* that gate. It builds on **ADR-894** (capability declaration format), **ADR-1016** (runtime capability descriptor), and **ADR-58** (InstallPlan seam). Tracked by [#1244](https://github.com/open-gsd/gsd-core/issues/1244). Target release: **1.6.0**.

---

## Ratification (2026-07-17): Proposed → Accepted

Ratified by explicit maintainer directive; the Status field sat at Proposed for 33 days after the owning issue and all six phase sub-issues had already closed as shipped.

**Evidence the decision shipped:**

- Issue #1244 and all six phase sub-issues (#1430–#1435, Phase 1 through Phase 6) are CLOSED / `stateReason: COMPLETED`.
- **D1** (versioned manifest): `capabilities/*/capability.json` carry `version` + `engines` (confirmed in `ai-integration`, `antigravity`, `claude-orchestration`).
- **D2** (runtime overlay): `src/capability-loader.cts:486` exports `loadRegistry({ includeInstalled })`.
- **D3** (source resolver): `src/capability-source.cts:1080` exports `resolveCapabilitySource`, backed by the four adapters `resolveLocal` (861), `resolveGit` (892), `resolveNpm` (944), `resolveTarball` (1017).
- **D4** (ledger): `src/capability-ledger.cts` (42.4K) exists with `tests/capability-ledger.test.cjs` (111.0K) covering it.
- **D5** (trust model): `src/capability-trust.cts` and `src/capability-consent.cts` exist; `strictKnownRegistries` is threaded through `src/capability-lifecycle.cts` at lines 171, 881, 956, and 1079, each backed by `tests/capability-trust.test.cjs` and `tests/capability-consent.test.cjs`.
- **D6** (upgrade/compat): `src/capability-lifecycle.cts:1078` implements `upgradeCapability` under the documented atomic stage-then-swap (comment header at line 1056); `compatVersions` downgrade handling is present at lines 126, 920, and 1111.
- **D9** (capability matrix): `docs/reference/capability-matrix.md` (9.4K) exists and is generated from the registry.

Governance: owning issue #1244, `stateReason: COMPLETED`, closed 2026-07-07.

**Known gaps at ratification:** the D8 cross-reference promised back into ADR-857 ("D7 and D8... extended by ADR-1244") was never written — `docs/adr/857-capability-system.md` has no mention of ADR-1244. And epic #1900 (ADR-1244 edge hardening: MCP arg/cwd confinement, tarball/registry SSRF denylist, duplicated injection patterns) remains OPEN with all three of its filed children (#1901, #1902, #1903) closed `NOT_PLANNED` — the epic's own text scopes this as post-ship hardening on an already fail-closed pipeline, not a reversal of any D1–D9 decision, but the hardening itself is not yet scheduled.

---

## Context

ADR-857 turned the five-step loop into a **host** with **12 Loop Extension Points** and made every feature a **Capability** — a folder `capabilities/<id>/capability.json` declaring owned skills/agents, lifecycle hooks, a federated config slice, and loop-extension registrations (`step` / `contribution` / `gate`). 32 capabilities ship today (20 `role:feature`, 12 `role:runtime`). The architecture is in place; the **ecosystem is not**.

Three structural facts make third-party capabilities impossible today:

1. **The registry is a build-time artifact.** `scripts/gen-capability-registry.cjs` reads `capabilities/*/capability.json` at build time and emits `gsd-core/bin/lib/capability-registry.cjs`, which is committed and shipped read-only. Every runtime consumer (`config-loader.cjs`, `surface.cjs`, `capability-state.cjs`, command dispatch in `gsd-tools.cjs`) `require()`s that generated file. **Nothing reads `capability.json` at runtime.** A capability that is not in the shipped package literally cannot be *seen* by config federation, surface, state resolution, or dispatch. There is no build step on a user's machine.

2. **Capabilities are unversioned.** `capability.json` carries no `version`. Version lives only at the registry *schema* level (`SCHEMA_VERSION = '1'`) and on the package manifests (`package.json`, `.claude-plugin/plugin.json`, `gemini-extension.json`, stamped by `scripts/sync-manifest-versions.cjs`). "Is there a newer version of this capability?" and "does this capability work with my GSD version?" are both undefined.

3. **There is no per-capability install/upgrade/remove.** The only uninstall surface is whole-product (`bin/install.js --uninstall`), which deletes everything matching the `gsd-*` prefix with **no record of what an install wrote**. Upgrade of one capability, and clean removal of one capability, are impossible.

The maintainer has decided the 1.6.0 scope: **full ecosystem** (the live loader ships in 1.6.0, not just docs) and **full first-party parity** for third-party capabilities (they may ship the same executable surfaces GSD ships — hooks, MCP servers, command modules), mediated by a trust/integrity/consent gate. This raises the security stakes and makes the trust model load-bearing.

The crux for every decision below: **close the build-time/runtime gap with a runtime overlay, and make every executable surface pass through one consent + integrity seam.**

---

## Decisions

### D1 — Versioned capability manifest

`capability.json` gains:

- **`version`** — semver, **required**. The registry rejects a capability without one; a parity test fails the build if any *native* manifest lacks a version.
- **`engines.gsd`** — a semver **range** expressing host compatibility (e.g. `">=1.6.0 <3.0.0"`). Modelled on VS Code's `engines.vscode`. A hard gate at install **and** at load.
- **`compatVersions`** *(optional)* — a capability-version → min-gsd-version table for graceful downgrade. Modelled on Obsidian's `versions.json`. Only meaningful for sources that enumerate versions (git tags, registry, npm).
- **`integrity`** *(optional)* — `sha512-<base64>` of the capability bundle, populated by a registry or recorded at install.
- **`provenance`** *(optional)* — `{ sourceRepo, commit }`; SHOULD be emitted in CI for first-party and curated capabilities.

The build-time validator in `gen-capability-registry.cjs` is extended to enforce these fields. Native capabilities are stamped at release (D6). **Rationale:** versioning is the data substrate every other decision depends on — upgrade, compatibility, integrity, and the matrix all key off it.

### D2 — Runtime Capability Registry overlay

Promote the registry from a frozen data file to a **module with an interface**:

```
loadRegistry({ includeInstalled }) → composed registry
```

It composes **first-party (shipped, frozen) ∪ installed overlay** — third-party manifests read at runtime from a per-scope install root (global: `~/.gsd/capabilities/<id>/`; project: `.gsd/capabilities/<id>/`). The conformance validator (today build-time-only) is **extracted to a runtime-callable `validateCapability()` / `validateCrossCapability()`** and run **at install time over the merged set**, not just the new manifest.

Invariants enforced at install (over first-party ∪ ledger ∪ new):

- **First-party always wins.** An overlay whose `id` collides with a first-party id, or that claims a skill/agent stem already owned, is **rejected**.
- Cross-capability invariants from ADR-894 (owner-uniqueness, config-key exclusivity, artifact-production-uniqueness per point, `requires` acyclic + tier-monotone) re-checked over the merged set.

**Load-time re-gate (default-resilient):** the host can change under an installed overlay (a GSD upgrade renames a loop point, or `engines.gsd` no longer matches). At load, an invalid or incompatible overlay is **skipped with a warning** and flagged in the ledger as needing update — it never crashes the loop. This mirrors the existing defensive skip in `capability-state.cjs`.

**Rationale:** this is the load-bearing unlock. Without a runtime overlay seam, the loader, ledger, and dispatch have nowhere to land. Deletion test: remove the overlay and the third-party-install complexity reappears in every consumer.

### D3 — Capability source resolver (the URL importer)

One seam, `resolveCapabilitySource(spec)`, with one **adapter per source kind**:

| Spec form | Adapter |
|---|---|
| `<name>@<registry>` | registry |
| `https://…/repo.git#<tag>` / `#sha:<40-hex>` | git |
| `npm:@org/pkg@<range>` | npm |
| `https://…/cap-x.y.z.tgz` | tarball |
| `./local/path` | local |

Every adapter follows the same pipeline: **fetch → verify integrity/SHA → check `engines.gsd` → return a staged, validated bundle**. Git/npm sources shell out through the existing `shell-command-projection` seam with bounded timeouts; tarball/registry fetch uses Node's `https` + `crypto`. The trust gate (D5) lives at this single seam. **Rationale:** multiple real adapters = a real seam (not hypothetical); adding a source kind = adding an adapter, not editing the loader.

### D4 — Capability ledger

A per-runtime install manifest, e.g. `~/.claude/.gsd-capabilities.json`, recording per installed capability:

```jsonc
{
  "<id>": {
    "version": "1.2.0",
    "source": "https://github.com/org/cap.git#sha:…",
    "integrity": "sha512-…",
    "files": ["skills/…", "agents/…"],          // owned files written
    "sharedEdits": [{ "file": "settings.json", "marker": "<id>" }]
  }
}
```

The ledger is the **commit point** for installs/upgrades (atomic write, like `surface.cjs writeSurface`) and the basis for precise removal. It records not only owned files but **fragments written into shared files** (`settings.json` hooks, `mcpServers`) so removal can strip exactly those entries without deleting shared files. A **reconciliation sweep** on next run resolves crash orphans (files not in the ledger; ledger entries with missing files). **Rationale:** "remove by `gsd-*` prefix" has whole-product blast radius and no record of ownership; the ledger gives selective, reversible, crash-safe install.

### D5 — Trust model: artifact parity is full, trust posture is tiered

Third-party capabilities may ship the **same artifacts** first-party ships (full parity, per the maintainer's scope), but **trust is not symmetric**:

- **First-party** is implicitly trusted — it *is* the shipped package.
- **Third-party** requires **explicit, informed, revocable consent + SHA-pinned integrity.**

Hard rules (MUST):

1. **Install never executes capability code.** Staging is copy-only; no `postinstall`-equivalent. (npm `--ignore-scripts` lesson.)
2. **Executable surfaces are disclosed and consented at install.** `hooks`, `mcpServers`, and command modules activate on the *next tool call* — there is no "first use" gate for a hook — so consent must be at install, naming every executable surface. The disclosure includes each MCP server's **`env` and `cwd`** (#1459), because an environment variable (e.g. `NODE_OPTIONS=--require evil.js`) can change *what* a command does without touching the command or argv; the disclosure signature folds env/cwd in as stable sorted JSON so any add/change forces re-consent. Declining aborts cleanly.
3. **Integrity is verified before extraction** when an `integrity`/SHA is available; mismatch aborts. (npm registry-signature lesson.)
4. **Auto-update is OFF by default** for third-party; enabling it still **re-prompts when the executable set changes** between versions. (VS Code stolen-PAT + silent-auto-update lesson.)
5. **Modules are `require()`'d only from the capability's own install root** — parent-directory traversal in declared paths is rejected.
6. **`gsd-*` (and `gsd-core-*`, `anthropic-*`) ids/prefixes are reserved** — third-party cannot impersonate first-party.
7. **`strictKnownRegistries`** (managed/project config) can lock installs to an allowlist; `[]` means no external installs.
8. **The consent signal for a project-scope capability is a user-owned consent store, NOT the in-repo ledger** (#1459). The store lives at `${GSD_HOME||homedir()}/.gsd/consent.json` — outside any repository — keyed by `(realpath(projectRoot), id)` and bound to the bundle integrity + disclosure signature. Before activating a project-scope overlay (its declarative loop surfaces **and** its command dispatch) the loader requires a matching record on **this machine**; without it the capability is discovered-but-inactive. This **retracts the prior limitation** that a project-scope ledger living inside the repository was itself the consent — a forged/cloned project ledger could otherwise activate executable + declarative surfaces with no user decision. Global-scope installs (under the user's own home) need no per-project record. `gsd capability trust list`/`revoke` audit and revoke project consents.

Stated honestly: **there is no sandbox.** Node-level sandboxing is impractical and would defeat full parity. Consent + integrity + reversibility are the barrier. (Obsidian's honest acknowledgment.) **Rationale:** a one-time trust prompt does not make running arbitrary code safe; separating *artifact parity* from *trust posture* is what makes full parity defensible.

### D6 — Upgrade and compatibility

- **Atomic stage-then-swap.** Upgrade fully stages (fetch + verify + validate) before swapping; the **ledger write is the commit point**; a reconciliation sweep handles crash orphans. A mid-upgrade crash leaves either the old or the new version fully intact — never a half-state.
- **Two-layer compatibility.** `engines.gsd` is a **hard gate** (block with a clear message at install and load); `compatVersions` provides **graceful downgrade** to the newest compatible version — but only for sources that enumerate versions (git tags, registry, npm). A bare tarball URL has one version and simply blocks.
- **Native version stamping.** `scripts/sync-manifest-versions.cjs` (or a parallel capability sweep) stamps `version` into native `capabilities/*/capability.json` at release; the existing version-sync regression guard is extended to cover them.
- **"Update available?" is a per-source matrix** (git: fetch tags/manifest; registry: catalog; npm: dist-tags; tarball: not auto-detectable → manual only) — documented, not silently partial.

### D7 — Registry-driven dispatch (sequenced last, behind the gate)

Fulfil ADR-857 D7's deferred "registry over hardcoded switch": `gsd-tools.cjs` / `command-routing-hub.cjs` consult the (overlay-aware) registry's `commands: [{ family, module, router }]` and dispatch via dynamic `require(module)[router]()`. **This is where third-party code executes**, so it is gated by the same consent (D5) and **confined to the capability's install root**. First-party in-tree modules (`graphify`, `intel`, `audit`) collapse onto the same seam (dogfooding). **Sequenced last** because it carries the highest risk.

### D8 — Relationship to ADR-857 (amend, not reverse)

ADR-857 D7/D8 did not *forbid* third-party code — they *deferred* it pending (a) its own ADR and (b) a trust/validation gate. This ADR satisfies both. ADR-857 is updated to mark D7 and D8 **"extended by ADR-1244."** The only substantive change is moving third-party from "deferred" to "delivered, gated." The runtime overlay (D2) is consistent with 857's own direction ("each loop step authored as if it could become a Capability"; "registry over hardcoded switch").

### D9 — The capability matrix

A **generated-from-registry** catalog at `docs/reference/capability-matrix.md`, mapping every capability to `id`, `version`, `tier`, extension points, hook kinds, and `engines.gsd` — kept honest by a drift guard (like `docs/INVENTORY.md`). It includes a documented section where third-party authors register their capability. **Whether GSD operates/advertises a central community registry is left TBD/TBA** (see the PRD); the documentation mechanic ships regardless of that decision.

---

## Consequences

**Positive**

- GSD becomes an actual platform: authors ship capabilities independently; users install/upgrade/remove them without forking or maintainer PRs.
- Versioned manifests give native capabilities a real version surface and make compatibility explicit.
- The overlay + ledger make install reversible and crash-safe; whole-product `--uninstall` is no longer the only removal path.
- The trust gate is concentrated at one seam (D3/D5) — auditable, testable, and the single place the security posture is enforced.
- D7 retires a long-standing hardcoded-switch debt and dogfoods first-party modules onto the same dispatch seam.

**Negative / costs**

- **New permanent attack surface.** URL import + third-party code execution at full parity is the highest-maintenance, highest-risk part of GSD. The trust/integrity/consent model is a forever responsibility.
- Runtime overlay couples the runtime validator to the ADR-894/1016 schema — a generative-parity assertion is required so build-time and runtime validators cannot drift.
- Per-runtime ledger × 16 runtimes multiplies the install/remove test surface (cross-platform fault injection required).
- Documentation breadth (COMMANDS / FEATURES / USER-GUIDE / CONFIGURATION / ARCHITECTURE / AGENTS + the generated matrix).

**Risks & mitigations**

- *Malicious capability via auto-update* → auto-update OFF by default; re-consent on executable-set change; SHA pin.
- *Overlay drift / contract change under an installed capability* → load-time re-gate, skip-with-warning, ledger flag.
- *Half-state install/upgrade* → ledger-as-commit-point + reconciliation sweep.
- *Impersonation* → reserved namespace; `strictKnownRegistries` allowlist.
- *Validator drift* → shared validator module + generative-parity test.

---

## Implementation phases (dependency-ordered)

1. **Versioned manifest** (D1) + native stamping (D6) — the data substrate; the "documentation-release" piece.
2. **Runtime registry overlay** (D2) — the structural unlock.
3. **Source resolver** (D3) + **ledger** (D4) — additive, testable in isolation.
4. **Trust gate** (D5) + **upgrade/compat** (D6).
5. **Registry-driven dispatch** (D7) — last, behind the gate.
6. **Capability matrix** (D9) + full diataxis documentation set.

Each phase ships as its own PR with a changeset and full gate compliance (per CONTRIBUTING: one concern per PR; docs-required for `Added`/`Changed` fragments).

---

## Alternatives considered

1. **Stay build-time only** (third parties fork or upstream-PR). Rejected — no ecosystem; every community capability becomes maintainer burden. This is the status quo 857 D7/D8 flagged.
2. **Declarative-only third-party** (no hooks/MCP/code). Safer (matches 857 D7), but the maintainer chose full parity so authors ship the same power GSD ships — accepting the heavier trust model rather than a capped one.
3. **Centralized-registry-only** (no URL import). Rejected for launch — gates every capability behind maintainer review (the Obsidian one-PR-per-version pitfall). URL/git import keeps distribution decentralized; a registry can layer on top later.
4. **Regenerate the committed registry on the user's machine at install.** Rejected — requires the full build toolchain on every machine and mutates a shipped file; the overlay achieves the same without a build step.
