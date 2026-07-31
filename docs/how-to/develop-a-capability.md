# Develop a Capability for GSD 1.5+

This guide shows you how to add or change a first-party GSD Capability after the ADR-857 cutover. In GSD terms, the extension unit is a **Capability**. A plugin is a packaging or host-runtime term, for example a Claude Code plugin, not the unit that owns a GSD feature.

A Capability is right when the feature can be toggled as one unit and owns its own skills, agents, hooks, config keys, or command family. Keep verifier predicate contracts, the five-step loop spine, and shared infrastructure in core unless the ADRs explicitly move that boundary.

## Start from the boundary

Before writing a manifest, decide whether the work is core or a Capability.

Use a Capability when the feature:

- Can be enabled or disabled without changing the meaning of the base loop.
- Owns a stable feature name such as `research`, `ui`, `graphify`, `ai-integration`, or `pattern-mapper`.
- Adds a step, gate, or contribution at a Loop Extension Point.
- Owns one or more feature config keys.
- Owns a command family that can route through the capability registry.

Keep the work in core when the feature:

- Defines the reliability substrate of the loop, such as the verifier predicate contract described by ADR-550 and ADR-857.
- Is required for every installation profile.
- Mutates shared host workflow state rather than adding a declared hook contribution.

## Create the folder

Create one folder per Capability:

```text
capabilities/<id>/
  capability.json
  fragments/
    plan-pre.md
```

The manifest path is `capabilities/<id>/capability.json`.

The `<id>` must match the `id` field in `capability.json`. Co-locate prompt fragments, owned skills, owned agents, and other owned artefacts under the Capability folder when the schema allows it. Shared host artefacts can be referenced by name, but ownership should remain clear in the manifest.

## Write `capability.json`

Use the existing manifests as the source of truth while the schema is still first-party:

- `capabilities/research/capability.json`
- `capabilities/ai-integration/capability.json`
- `capabilities/pattern-mapper/capability.json`
- `capabilities/ui/capability.json`
- `capabilities/graphify/capability.json`

At minimum, a feature Capability declares:

```json
{
  "id": "example",
  "role": "feature",
  "version": "0.1.0",
  "title": "Example",
  "description": "Adds an example planning step.",
  "tier": "standard",
  "requires": [],
  "runtimeCompat": { "supported": ["*"], "unsupported": [] },
  "skills": [],
  "agents": ["gsd-example-agent"],
  "hooks": [],
  "config": {},
  "steps": [
    {
      "point": "plan:pre",
      "ref": { "agent": "gsd-example-agent" },
      "fragment": { "path": "fragments/plan-pre.md" },
      "produces": ["EXAMPLE.md"],
      "consumes": ["CONTEXT.md"],
      "onError": "skip"
    }
  ],
  "contributions": [],
  "gates": []
}
```

The registry generator validates the shape, ownership, and cross-capability contracts. `ref.skill` must name a skill declared by the same Capability. `ref.agent` must name an agent declared by the same Capability.

## Declare runtime compatibility

Every feature Capability must declare `runtimeCompat`. This is part of the GSD 1.5+ developer contract: a Capability says which runtime descriptors it can surface through, and the generator validates that declaration before the central registry is written.

Use the wildcard when the Capability is runtime-agnostic:

```json
"runtimeCompat": {
  "supported": ["*"],
  "unsupported": []
}
```

Use explicit runtime ids when the Capability is intentionally narrower:

```json
"runtimeCompat": {
  "supported": ["claude", "codex"],
  "unsupported": ["kilo"],
  "notes": {
    "kilo": "Requires a hook surface Kilo does not expose yet."
  }
}
```

`supported` is required and must be non-empty. `"*"` means every descriptor-backed runtime, including future first-party runtime descriptors, is compatible unless it is listed in `unsupported`. Explicit runtime ids and `notes` keys must match runtime Capability ids such as `claude`, `codex`, `opencode`, or `kilo`; typos fail `node scripts/gen-capability-registry.cjs --check`.

## Add hooks

Loop Extension Points are the stable sites where Capabilities attach to the host loop. Phase 6 planning-time features use `plan:pre` so the core planner can ask the registry for active planning hooks instead of reading feature config directly.

Choose the hook kind that matches the behaviour:

- `steps` add a sequenced unit of work, such as running `gsd-phase-researcher` or `gsd-pattern-mapper`.
- `contributions` add labelled context to a host prompt.
- `gates` check a condition and may block when `blocking` is true.

Declare file artefact flow with `produces` and `consumes`. The registry uses those arrays to order hooks and to reject unsatisfied dependencies.

## Use prompt fragments

Use `fragment.path` for prompt text longer than a short sentence:

```json
"fragment": { "path": "fragments/plan-pre.md" }
```

The generator materialises that file into `fragment.inline` in the generated registry. Paths must be relative to the Capability folder, must not be absolute, and must not contain `..`.

Use `fragment.inline` only for short, stable text:

```json
"fragment": { "inline": "Add the generated example context to the planner input." }
```

## Generate and verify the registry

After editing any Capability manifest or fragment, regenerate the committed registry:

```bash
node scripts/gen-capability-registry.cjs --write
```

Then run the drift check:

```bash
node scripts/gen-capability-registry.cjs --check
```

For a planning hook, verify the rendered output:

```bash
node gsd-core/bin/gsd-tools.cjs loop render-hooks plan:pre --raw
```

In installed workflow prose, the same resolver surface appears as `gsd-tools loop render-hooks plan:pre`.

The rendered JSON should include the active hook, the declared `ref`, and the materialised `fragment.inline`.

To verify a runtime-specific surface, pass the same config directory that the runtime installation uses:

```bash
node gsd-core/bin/gsd-tools.cjs loop render-hooks plan:pre --config-dir ~/.claude --raw
node gsd-core/bin/gsd-tools.cjs capability state --config-dir ~/.claude --raw
```

`capability state` is the diagnostic view for the same state that workflow dispatch consumes. For each Capability, `enabled` is true only when the Capability is both installed by the active profile and surfaced by the runtime surface. A hook's `configured` field reflects the `when` config key; `active` is true only when the Capability is enabled and the hook is configured on.

## Add or change a runtime descriptor

Runtime-specific facts belong in the runtime Capability declaration, not in a parallel allowlist or runtime-name branch. When adding a first-party runtime under `capabilities/<runtime>/capability.json`, declare these fields in the `runtime` object:

- `configHome`: the global config root resolver, including env overrides and probes.
- `configHome.skillsHome`: optional separate base home for runtimes whose global skills root differs from the config root.
- `artifactLayout.global` and `artifactLayout.local`: command, agent, skill, and Kimi-agent destinations.
- `hooksSurface`, `hookEvents`, and `extendedHookEvents`: hook registration surface and event dialect.
- `installSurface`, `writesSharedSettings`, and `permissionWriter`: install-time config mutation behavior.

The runtime homes, artifact layout, and install-plan resolvers read those descriptor fields directly. Adding a descriptor-backed runtime should not require editing a second list in `runtime-artifact-layout` or a fallback branch in `runtime-config-adapter-registry`.

## Own config in the Capability

Declare feature config keys in the Capability manifest:

```json
"config": {
  "workflow.example_enabled": {
    "type": "boolean",
    "default": true,
    "description": "Enable the example planning step."
  }
}
```

Do not add migrated Capability keys to `gsd-core/bin/shared/config-schema.manifest.json`. The central schema remains for host/core keys; Capability-owned keys validate through the generated registry and are merged into `loadConfig` by the federated config overlay. Existing nested `.planning/config.json` values such as `{ "workflow": { "example_enabled": false } }` continue to override the Capability default.

## Wire the workflow through the registry

Host workflows should ask the resolver for active hooks and then dispatch from the resolved data. Do not add new direct `config-get workflow.<feature>` checks to a host workflow for a migrated feature.

The Phase 6 migrations follow this pattern:

- `research` registers a `plan:pre` step that invokes `gsd-phase-researcher`.
- `ai-integration` owns the AI-SPEC planning activation and config key.
- `pattern-mapper` registers a `plan:pre` step that invokes `gsd-pattern-mapper`.
- `plan-phase.md` reads the resolved `PLAN_PRE_HOOKS_JSON` and dispatches `ref.agent` or `ref.skill` from that data.
- `code-review` registers an `execute:post` step and review workflows dispatch from the active hook's `ref.skill`.
- `security` registers a `plan:pre` contribution, a `verify:post` step, and a blocking `ship:pre` gate.
- `nyquist` registers a `verify:post` step for validation coverage auditing.

This keeps "off means off" enforceable by construction: disabled Capabilities are absent from the active hook set, so the host workflow has nothing feature-specific to run.

## Test the Capability

Add focused tests before changing behaviour:

- Registry tests for manifest validation, ordering, config ownership, command family dispatch, or fragment materialisation.
- Workflow text tests for host workflow cutovers when a workflow stops reading direct feature config.
- Behavioural command tests when a command family moves behind `dispatchCapabilityCommand`.
- Documentation tests when the feature changes developer-facing behaviour.

Run the smallest affected tests first, then the full suite before opening a ready PR:

```bash
node --test tests/capability-registry.test.cjs
node --test tests/phase6-planning-capabilities.test.cjs
node --test tests/phase6-capstone-conformance.test.cjs
npm test
```

Run the Phase 6 capstone test whenever a Capability adds a `when` key or moves activation logic in a host workflow. It checks that migrated activation keys are resolved through Capability hooks or state, and that Capability-owned config keys stay out of the central schema. If a host workflow must keep core behaviour behind a `workflow.*` key, document why it is core rather than Capability-owned before adding it.

## Keep the docs with the slice

Every Phase 6 slice that changes capability behaviour must update the relevant docs in the same PR. Use this manual for developer-facing Capability authoring facts, use how-to guides for task flows, and use ADRs only for decisions and trade-offs.

## The capability ecosystem (1.6.0)

From GSD 1.6.0, capabilities are versioned (the `version` field is required in `capability.json`) and can be installed directly from a URL, a git ref, an npm package, or a local path — without modifying the core repo.

- **Tutorial** — [Build your first capability](../tutorials/build-your-first-capability.md): scaffold and install a declarative capability end-to-end in under ten minutes.
- **How-to** — [Publish a capability](../how-to/publish-a-capability.md): package and distribute a capability via a URL or registry.
- **How-to** — [Import a capability from a URL](../how-to/import-a-capability-from-a-url.md): install a third-party capability from a git URL, tarball, or npm package.
- **How-to** — [Version and update a capability](../how-to/version-a-capability.md): manage `version`, `engines.gsd`, and `compatVersions`; use `gsd capability update`.
- **How-to** — [Remove a capability](../how-to/remove-a-capability.md): uninstall cleanly with `gsd capability remove`, including the `--purge-data` option.
- **How-to** — [Ship a reviewer lane in your capability](../how-to/ship-a-reviewer-lane.md): declare a `reviewer` body (GSD 1.9.0+) so `/gsd-review` discovers and invokes your external review CLI or model endpoint.
- **Reference** — [Capability manifest](../reference/capability-manifest.md): all fields and validation rules for `capability.json`.
- **Reference** — [Capability matrix](../reference/capability-matrix.md): which first-party capabilities exist, their extension points, and their compatibility matrix.
- **Explanation** — [Capability trust model](../explanation/capability-trust-model.md): how declarative and executable capabilities are treated differently at install time.
- **ADR-1244** — `docs/adr/1244-capability-ecosystem.md`: the architectural decision that introduced the installable capability ecosystem.
