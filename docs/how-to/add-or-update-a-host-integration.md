# How to add or update a host's integration capabilities

This guide is for GSD maintainers adding a new host CLI, or updating an existing host's
host-integration axes (ADR-1239 Phase A). It covers the **documentation-sourcing rule**, the
nine `runtime.hostIntegration` axes, the `undocumented` sentinel, and how to validate.

The governing rule for this whole process: **every axis value must come from the host's own
authoritative documentation. Never infer, guess, or assume.** Where the docs do not state an axis,
record the explicit `undocumented` sentinel — not a plausible default. The reference matrix
(`docs/reference/host-integration-capability-matrix.md`) is the source of truth, and every value in
it carries a citation and an evidence quote.

---

## 1. Find the host's authoritative documentation

In order of preference:

1. **Context7** — `resolve-library-id` for the host, then `query-docs` for "plugins / subagents / hooks / commands / MCP / model API".
2. **Official dev docs / source repo** — the host's documentation site or GitHub repo (plugin API, agents, hooks, MCP, command authoring).

Capture the exact source (Context7 library id + query, or the doc URL) and a short verbatim quote
for each value you determine. You will paste these into the matrix in step 4.

## 2. Determine each of the nine axes from the docs

Read the docs and map them to the closed vocabulary. Do not pick a value unless a source states it.

| Axis | What to look for in the docs |
|---|---|
| `embeddingMode` | An in-process programmatic plugin/extension API (`imperative`) vs. configuration files only (`declarative`). |
| `commandSurface` | How custom commands are authored/invoked: `slash-file` (.md), `slash-toml`, `slash-programmatic`, `palette`, `prose-only`. |
| `dispatch` | Sub-agent delegation: `namedDispatch`, `nested`, `maxDepth` (int; `-1` = documented-unbounded), `background`, `subagentToolkit` (`full`/`read-only`). |
| `modelMode` | A programmatic model request/provider API (`active`) vs. instruction/per-agent-field only (`passive`). |
| `hookBus` | The host fires lifecycle events a plugin subscribes to (`host`), an extension host owns the bus (`engine`), or no bus (`none`). **Independent of `hooksSurface`** — e.g. opencode has `hooksSurface: none` but `hookBus: host`. |
| `stateIO` | `filesystem`, `sandboxed-storage` (web IDE, no arbitrary FS), or `session-log-append`. |
| `transport` | `mcp` (native MCP support) vs. `native-extension` (MCP needs a community extension). |
| `runtime` | The plugin/extension runtime: `node`, `bun`, `sandboxed-web`, `python`, `go`, `rust`, `electron`, `other`. |
| `effortSurface` | How reasoning effort reaches the host: `argv` (a flag on the host's own invocation) or `none` (no reasoning-effort mechanism). Added by #2481. There is deliberately **no** config-file member — do not invent one; use `undocumented` when the host's docs state no reasoning setting. |

## 3. Write the `runtime.hostIntegration` block

In `capabilities/<id>/capability.json`, inside the `runtime` object, add (or edit) the block. Use a
documented closed-vocabulary value, or the literal string `"undocumented"` for any axis the docs do
not state:

```json
"hostIntegration": {
  "embeddingMode": "declarative",
  "commandSurface": "slash-file",
  "dispatch": { "namedDispatch": true, "nested": false, "maxDepth": 1, "background": false, "subagentToolkit": "undocumented" },
  "modelMode": "passive",
  "hookBus": "host",
  "stateIO": "filesystem",
  "transport": "mcp",
  "runtime": "node"
}
```

**When to use `undocumented`:** only when you searched and the host's docs genuinely do not state the
axis. It validates, but `negotiateHostCapabilities` **fail-closes** on it (degrades to the most
restrictive known value) — so it is always safe and never a silent capability claim. A dispatch
boolean or `maxDepth` may also be `"undocumented"`.

**Do not conflate the orthogonal axes:** `commandStyle` (GSD's emission style) is *not*
`commandSurface` (the host's surface type); the `hookEvents` dialect is *not* `hookBus` (bus
ownership); `runtimeCompat` (which features run on a host) is independent of these runtime→engine
axes.

## 4. Record the citations in the reference matrix

Add (or update) the host's section in `docs/reference/host-integration-capability-matrix.md` with a
row per axis: `Axis | Value | Source | Evidence`. For an `undocumented` value, put the search trail
in the Source column. This file is the deployment source of truth — a value without a citation here
is not allowed.

## 5. Validate

```bash
npm run build:lib
npm run gen:capability-registry   # validateRuntimeBody runs on every descriptor
```

`gen:capability-registry` must succeed with zero errors. The validator
(`gsd-core/bin/lib/capability-validator.cjs`) rejects out-of-vocabulary values, malformed dispatch
structs, and reserved keys (`__proto__`/`constructor`/`prototype`).

Then run the host-integration tests and the full cross-platform suite:

```bash
node --test tests/host-integration-descriptors.test.cjs   # asserts every descriptor validates + profiles
gsd-test-both                                              # Mac + Linux Docker (run before any PR)
```

## 6. If you need a vocabulary value that does not exist yet

The vocabulary is intentionally **closed** (ADR-857 Decision 8): a genuinely new host shape requires
a first-party primitive, reviewed. To add one (e.g. a new `runtime` kind):

1. Add the value to the relevant axis in `HOST_INTEGRATION_AXES` in `src/host-integration.cts`.
2. Add the same value to the matching `VALID_*` set in `capability-validator.cjs`.

The parity guard (`tests/host-integration-validator-parity.test.cjs`) fails if these two drift, so
they must be updated together. Document the new value's meaning in the matrix legend.

## 7. Fold an already-hardcoded host into the interface (worked example: `claude`)

Sections 1–6 cover a *green-field* host (`pi`, `antigravity` — a fresh descriptor + reference
binding). This section covers the other case: a host that already has a **real production install**
driven by scattered `runtime === '<id>'` string-equality branches in `bin/install.js`, which you want
to move onto the Host-Integration Interface **without changing a single installed byte**. `claude`
(the tier-1 reference host, #2086) is the worked example.

The pattern is byte-parity-safe by construction — each string check becomes a **descriptor lookup that
yields the same truth value**, so behavior is unchanged and only the brittle coupling is removed:

1. **Inventory the branches.** Find every `runtime === '<id>'` / `runtime !== '<id>'` in `bin/install.js`
   for the host (`grep -nE "runtime\s*[!=]==\s*'claude'"`). Each is a host behavior encoded as a string
   comparison rather than a declared capability.

2. **Declare the behaviors on the descriptor.** Add a `runtime.hostBehaviors` object to the host's
   `capability.json`. Each key names one behavior the branches gated on — e.g. for `claude`:
   `permissionsSchema: "claude"`, `settingsFileByScope: { local: "settings.local.json", global: "settings.json" }`,
   `sourceMarkerFile: ".gsd-source"`, `agentFrontmatterExtensions: ["effort"]`, `localInstallStyle: "legacy-flat"`,
   `authorsCanonicalWorkflow: true`, `ownsClaudePaths: true`, `nativeModelAliases: true`,
   `skillsGlobalOnboarding: true`, `attributionSource: "settings-json-commit"`. The validator
   (`validateRuntimeBody`) is lenient toward these host-behavior keys; they carry install policy, not the
   closed negotiated axes.

3. **Replace each branch with a descriptor read.** `bin/install.js` exposes a `_hostBehaviors(runtime)`
   helper (reads `_capabilityRegistry.runtimes[runtime].runtime.hostBehaviors`, `{}` if absent). Rewrite
   `if (runtime === 'claude')` → `if (_hostBehaviors(runtime).permissionsSchema === 'claude')`, and
   `if (runtime !== 'claude')` → `if (!_hostBehaviors(runtime).authorsCanonicalWorkflow)`. Only the host
   declares the key, so every other runtime keeps the generic path.

4. **Route install/uninstall through the public adapter.** Replace the direct
   `installRuntimeArtifacts(...)` / `uninstallRuntimeArtifacts(...)` calls with
   `createImperativeAdapter({ runtime }).install({...})` / `.uninstall({...})`. The imperative adapter
   delegates to the *same* engine functions, so the output is byte-identical — that is the point: the
   host is now driven **through** the interface, not around it.

5. **Prove parity, both scopes.** `tests/golden-install-parity.test.cjs` captures a byte-stable manifest
   of every emitted file. Assert the host's install is unchanged for **global and local** scopes
   (regenerate a baseline from `origin/next` first, then confirm the migrated tree matches it). Exclude
   only genuinely volatile / platform-varying files (`settings.json`, `settings.local.json`, `.gsd-source`).

6. **Guard against regression.** Add a `*-imperative-reference.test.cjs` asserting the adapter classifies
   the host correctly, negotiation fails closed on a corrupted descriptor, and — with a source-grep behind
   an `// allow-test-rule:` exemption — that **no `runtime === '<id>'` branch remains** in `bin/install.js`.

**Another completed worked example: `copilot` (#2099).** Copilot was already installing through the
declarative artifactLayout (not the direct `installRuntimeArtifacts` calls step 4 describes), so its
migration folded the *residual* hardcoded branches rather than the whole install path: the `.agent.md`
destination-suffix rename in `src/install-engine.cts` (→ `hostBehaviors.agentFileExtension`), two
uninstall side-effect branches in `bin/install.js` (→
`resolveInstallPlan(runtime).installSurface === 'copilot-instructions'`, already a live descriptor field
elsewhere in the same file), and two `skipSharedHooksInstall` gates (→
`hostBehaviors.skipSharedHooksInstall: true`). A dead legacy agent-converter dispatch arm — unreachable
because copilot is a member of `_DESCRIPTOR_AGENTS_RUNTIMES` — was deleted outright rather than re-gated,
mirroring step 6's guard: `tests/declarative-reference-copilot.test.cjs` source-greps both files for the
retired `isCopilot` reads. See the `copilot` section of the reference matrix for the full EoS migration
note, including the two upgrades (multi-event hook bus; negotiated `dispatch.background`) this PR adds.

---

## Related

- Reference: [`docs/reference/host-integration-capability-matrix.md`](../reference/host-integration-capability-matrix.md) — the per-CLI sourced values.
- ADR: [`docs/adr/1239-gsd-embeddable-orchestration-engine.md`](../adr/1239-gsd-embeddable-orchestration-engine.md) — why the interface exists and the Phase A amendment.
- The closed-vocabulary runtime descriptor it extends: [ADR-1016](../adr/1016-runtime-capability-descriptor.md).
