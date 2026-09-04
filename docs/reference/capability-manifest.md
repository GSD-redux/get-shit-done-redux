# Capability Manifest Reference (`capability.json`)

> **Canonical ADRs:** [ADR-1244](../adr/1244-capability-ecosystem.md) · [ADR-894](../adr/894-capability-declaration-format.md) · [ADR-1016](../adr/1016-runtime-capability-descriptor.md)
> **See also:** [How to develop a capability](../how-to/develop-a-capability.md) · [Capability Command Reference](gsd-capability-command.md)

Each capability is a folder `capabilities/<id>/` (or an overlay root `~/.gsd/capabilities/<id>/` / `.gsd/capabilities/<id>/`) containing one `capability.json` declaration.
The file is schema-validated JSON with a common **envelope** plus a **role-typed body** (`role: "feature"`, `role: "runtime"`, or `role: "reviewer"`).

---

## Envelope fields

These fields are present for `role: "feature"`, `role: "runtime"`, and `role: "reviewer"` capabilities.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string (kebab-case) | Yes | Unique identifier; **must equal the folder name**. The prefix `gsd-`, `gsd-core-`, and `anthropic-` are reserved for first-party use. |
| `role` | `"feature"` \| `"runtime"` \| `"reviewer"` | Yes | Discriminator that selects the body schema. `"reviewer"` is for lane-only capabilities that ship a `reviewer` body and nothing else — see [Reviewer body](#reviewer-body-role-reviewer-or-on-any-role) below. |
| `version` | semver string | Yes (1.6.0+) | Semantic version of this capability. The registry rejects a manifest without one. |
| `title` | string | Yes | Short human-readable label. Must be a non-empty string. |
| `description` | string | Yes | Longer summary sentence. Must be a non-empty string. |
| `tier` | `"core"` \| `"standard"` \| `"full"` | Yes | **Source of truth** for install-profile membership and surface cluster assignment. `tier` propagates via the `requires`-closure; install profiles are generated from it. |
| `requires` | string[] | Yes | Capability `id` values this capability depends on. Must be present as an array (use `[]` when there are no dependencies). Each entry must exist in the registry, be acyclic, and be tier-monotone (a `core` capability may not require a `standard` or `full` capability; a `standard` capability may not require a `full` capability). |
| `engines` | object | No | Host-compatibility constraint. Sub-field: `gsd` — semver range string (e.g. `">=1.6.0 <3.0.0"`). Acts as a hard gate at install **and** at load; a mismatch blocks installation and causes the overlay to be skipped with a warning at load time. |
| `runtimeCompat` | object | Yes (`role: "feature"`) | Declares which host runtimes this capability can surface through. Validated for every `role: "feature"` capability (a feature manifest without it fails validation). Sub-fields: `supported` — a **non-empty** array of kebab-case runtime ids, or the single wildcard `["*"]` for a runtime-agnostic capability; `unsupported` — an array of kebab-case runtime ids (the wildcard is **not** permitted here); `notes` — optional object mapping a runtime id (or `"*"`) to a non-empty explanatory string. The wildcard `"*"` may not be mixed with concrete ids in the same array, and the reserved names `__proto__`/`constructor`/`prototype` are rejected. |
| `compatVersions` | object | No | Graceful-downgrade table mapping `"<capVersion>"` to `"<min gsd version>"`. Only meaningful for sources that enumerate versions (git tags, registry, npm); a bare tarball URL carries one version and simply blocks on incompatibility. |
| `integrity` | string | No | `sha512-<base64>` hash of the capability bundle. Verified before extraction when present; mismatch aborts install. |
| `provenance` | object | No | `{ sourceRepo: string, commit: string }`. Emitted in CI for first-party and curated capabilities. |
| `author` | object | No | `{ name: string, email?: string, url?: string }`. |
| `homepage` | string | No | URL. |
| `repository` | string | No | URL. |
| `license` | string | No | SPDX licence identifier (e.g. `"MIT"`). |
| `keywords` | string[] | No | Arbitrary search tags. |

---

## Feature body (`role: "feature"`)

Feature capabilities declare owned artefacts, lifecycle hooks, a federated configuration slice, and loop extension registrations.

### `skills` and `agents`

| Sub-field | Type | Description |
|---|---|---|
| `skills` | string[] | Owned skill stems. Exactly one capability may own each stem across the entire merged registry (first-party ∪ overlay). |
| `agents` | string[] | Owned agent stems. Same uniqueness constraint as skills. |

The `skills` stems declared here are disclosed by name as **instruction surfaces** in the pre-install consent summary ([ADR-2363](../adr/2363-capability-instruction-surface-trust.md)). Bodies are installed verbatim and are not content-scanned — see [the capability trust model](../explanation/capability-trust-model.md).

`agents` are classified as an instruction surface too (ADR-2363 D3), but the stems declared here are **not** disclosed at the prompt: a third-party capability's `agents[]` are never staged into the agent's instruction context — the staging path that unions third-party skills into a runtime's skills directory has no equivalent for agents — so naming them would claim a surface that does not exist. This does not make agents safe or inert; it means the mechanism does not yet reach them.

### `hooks`

Non-loop lifecycle hooks.

| Sub-field | Type | Description |
|---|---|---|
| `event` | string | Hook event name (host-runtime specific). |
| `script` | string | Path to the hook script, **relative** to the capability root. The hook `command` written into the host settings is the realpath-confined **absolute** path to this script (so it always runs the bundle's own file regardless of the working directory) and is POSIX single-quoted (so an install prefix containing spaces cannot break it). For shell safety the path must contain only `[A-Za-z0-9._/-]` — no whitespace, no shell metacharacters (`; \| & $ ` `` ` `` `( ) < > * ? [ ] { } ! ~ # ' " \` newline), no leading `-`, no absolute path, and no `..` segment. A script outside this allowlist fails validation and the capability is rejected. |

### `config` — federated config-key schema slice

The `config` field is an object whose keys are federated configuration keys contributed by this capability. Each key must be absent from the central `config-schema` and absent from every other capability's `config` object (collision fails the build gate). Each entry has the following shape:

| Property | Type | Description |
|---|---|---|
| `type` | `"boolean"` \| `"string"` \| `"number"` \| `"enum"` | Value type. |
| `default` | (type-consistent) | Default value; must be consistent with `type`. |
| `description` | string | Human-readable explanation of the key's effect. |
| `values` | string[] | **`enum` only.** Exhaustive list of permitted string values. |

### `steps`

Steps run at a loop extension point as independent units. Ordering within a point is derived from `produces`/`consumes` (topological sort; capability-id is the tiebreak).

| Sub-field | Type | Required | Description |
|---|---|---|---|
| `point` | string | Yes | One of the 12 valid loop extension point identifiers (see table below). |
| `ref` | object | Yes | The dispatch target. Exactly one of `{ "skill": "<stem>" }`, `{ "agent": "<stem>" }`, or `{ "command": "<name>" }` (the three are mutually exclusive). A `skill`/`agent` stem must be declared in this capability's `skills`/`agents` array. |
| `produces` | string[] | Yes | Artefact names this step produces. Must be present as an array (use `[]` when it produces none); an omitted `produces` fails validation. No two capability steps may produce the same artefact at the same point. |
| `consumes` | string[] | Yes | Artefact names this step consumes. Must be present as an array (use `[]` when it consumes none); an omitted `consumes` fails validation. |
| `onError` | `"skip"` \| `"halt"` | Yes | Behaviour on failure; must be present and one of `"skip"` or `"halt"` (an omitted `onError` fails validation). Steps are purely additive — they never halt or redirect the host workflow on their own; a blocking precondition is expressed as a `gate`. |
| `when` | string | No | Dotted config key; the step is active only when the key is truthy. Evaluated deterministically at render time; phase-context applicability is the skill's own responsibility. |
| `fragment` | object | No | Optional inline-or-file prompt fragment attached to the step, with the **same** `{ "path": "<relative path>" }` or `{ "inline": "<string>" }` semantics as a contribution's `fragment`. A `path` is materialised (read and inlined) at load time, resolved against the capability directory and confined to it (`..` traversal is rejected). |
| `supportsReviewerLanes` | boolean | No | Strict opt-in trait (#4209): declares that this step's dispatch target accepts external reviewer-lane evidence. Only a literal `true` opts in — every other type fails validation, and `false`/omitted are inert (no reviewer-lane behaviour, no key on the projected active hook). Step-scoped, not capability-wide. |

### `contributions`

Contributions inject a fragment into a named agent role's prompt at a loop extension point. Multiple contributions into the same agent role render as ordered labelled blocks (`<contribution from="<id>">…</contribution>`).

| Sub-field | Type | Required | Description |
|---|---|---|---|
| `point` | string | Yes | One of the 12 valid loop extension point identifiers. |
| `into` | string | Yes | Agent role name. Must be a role published by that loop extension point in the host contract. |
| `produces` | string[] | Yes | Artefact names this contribution produces. Use `[]` when it produces none. |
| `consumes` | string[] | Yes | Artefact names this contribution reads. Use `[]` when it reads none. |
| `fragment` | object | Yes | Either `{ "path": "<relative path>" }` (file content) or `{ "inline": "<string>" }` (literal text). |
| `when` | string | No | Dotted config key; activates the contribution conditionally. |
| `onError` | `"skip"` \| `"halt"` | No | Behaviour on failure. |

### `gates`

Gates check a condition at a loop extension point and optionally block progression.

| Sub-field | Type | Required | Description |
|---|---|---|---|
| `point` | string | Yes | One of the 12 valid loop extension point identifiers. |
| `check` | object | Yes | One of three forms (see table below). Must be present as an object; an omitted `check` fails validation. |
| `blocking` | boolean | Yes | Must be present and a boolean; an omitted `blocking` fails validation. When `true`, a failed check halts the loop at this point. |
| `onError` | `"skip"` \| `"halt"` | Yes | Behaviour when the check itself errors; must be present and one of `"skip"` or `"halt"` (an omitted `onError` fails validation). |
| `when` | string | No | Dotted config key; activates the gate conditionally. |

**`check` forms:**

| Form | Shape | Blocking permitted | Notes |
|---|---|---|---|
| Query | `{ "query": "<gsd_run query>" }` | Yes | Deterministic first-party code. |
| Predicate | `{ "predicate": { "kind": "artifact-exists" \| "config-equals" \| …, … } }` | Yes | Declarative; no code path. |
| Agent verdict | `{ "agentVerdict": { "ref": …, "prompt": … } }` | No (forced advisory) | LLM evaluation; non-deterministic checks may not halt the loop. |

### `taskContentResolver`

Declares that this capability resolves per-task content (`<action>`/`<verify>`/
`<acceptance_criteria>`/`<read_first>`/`<done>`) from an external issue tracker instead of
`execute-plan.md`'s per-task loop reading it inline from a task's `PLAN.md` body. This is **not**
one of `steps` / `contributions` / `gates`, and it does not use a `point` value from the closed
12-point vocabulary above — it is dispatched directly, once per task, by `execute-plan.md` before
that task's `read_first` gate, documented separately in
[`loop-hook-dispatch.md`](../../gsd-core/references/loop-hook-dispatch.md#the-executetask-point-a-different-shape).
See [ADR-3646](../adr/3646-per-task-content-resolution-seam.md) for the full design and
[Develop a task-content resolver capability](../how-to/develop-a-task-content-resolver-capability.md)
for the authoring walkthrough.

| Sub-field | Type | Required | Description |
|---|---|---|---|
| `trackerPrefix` | string (kebab-case) | Yes | Matches the prefix of a task's `<task tracker-id="beads:GSD-42">` attribute — everything before the **first** `:`. Text after the first colon, including further colons, is passed through verbatim as the id. Must be unique across the merged first-party ∪ overlay capability set. |
| `invoke.binary` | string | Yes | Executable name or path for the resolver subprocess. |
| `invoke.args` | string[] | Yes | Argv passed to `invoke.binary`. Must contain the `{{id}}` placeholder at least once — GSD substitutes it with the task's tracker id (everything after the first `:`); an `args` array that never carries the placeholder fails validation, since the id could never reach the resolver. |
| `invoke.timeoutMs` | number | Yes | Bound on the subprocess invocation. Required — an unbounded resolver subprocess is this repo's named Unbounded Subprocesses defect class. A resolver exceeding this bound is killed and `task resolve-content` exits non-zero. |

`taskContentResolver` is feature-role only (`role: "feature"`); it is not admissible on `role: "runtime"` or `role: "reviewer"` bodies.

---

## Valid `point` values

The 12 loop extension points are a **closed, additive-only vocabulary**. Every `steps`, `contributions`, and `gates` entry must use one of these identifiers exactly.

A valid point is necessary but not sufficient: each host workflow decides, per point, which hook **kinds** its dispatch text handles, and a point may dispatch a subset. The registry build derives the real answer from the host workflows (`getWiredKinds()` in `scripts/gen-loop-host-contract.cjs`) and rejects a manifest declaring a kind the point does not dispatch — so an unsupported combination is a build-time error naming the point, the kind, and the kinds that point does cover. It is never a hook that renders and is then silently dropped.

`verify:pre` dispatches all three kinds. A step there is **advisory**: it runs before UAT begins and never blocks it — a precondition that must halt verification is a `gate`. Its `produces` artefact names are consumed **additively** by the verify workflow's `extract_tests` step, which can deepen what UAT covers but cannot suppress a checkpoint. See [Develop a capability](../how-to/develop-a-capability.md#check-the-point-dispatches-your-kind) for the authoring workflow.

| Point | Phase | Position |
|---|---|---|
| `discuss:pre` | Discuss | Before the discuss step executes |
| `discuss:post` | Discuss | After the discuss step completes |
| `plan:pre` | Plan | Before the plan step executes |
| `plan:post` | Plan | After the plan step completes |
| `execute:pre` | Execute | Before the execute phase begins |
| `execute:wave:pre` | Execute | Before each execution wave |
| `execute:wave:post` | Execute | After each execution wave |
| `execute:post` | Execute | After the execute phase completes |
| `verify:pre` | Verify | Before the verify step executes |
| `verify:post` | Verify | After the verify step completes |
| `ship:pre` | Ship | Before the ship step executes |
| `ship:post` | Ship | After the ship step completes |

---

## Runtime body (`role: "runtime"`)

Runtime capabilities describe how GSD projects its artefacts onto one host CLI. The body is a closed 8-axis (plus 4 install-surface) vocabulary; no feature-only fields (`skills`, `agents`, `steps`, `contributions`, `gates`, `hooks`) are permitted. Full semantic specifications, the closed enum values for each axis, and the 16-runtime worked examples are in [ADR-1016](../adr/1016-runtime-capability-descriptor.md).

| Axis | Field | Type summary |
|---|---|---|
| Config home | `runtime.configHome` | Structured object with `kind` (`dot-home` \| `dot-home-nested` \| `xdg` \| `generic-agents-root`), `name`, optional `parent`, `env[]`, `probe[]`, `probeExists`, `skillsHome`. `probeExists` is an optional sub-path applied to probe candidates: for `generic-agents-root` it is a hard filter (a candidate qualifies only if `<candidate>/<probeExists>` exists); for `dot-home-nested` it is a preference that makes probing pick the candidate GSD owns (e.g. `gsd-core/VERSION`) over a bare-existing sibling before falling back — see ADR-1016 and #213/#217. |
| Local config dir | `runtime.localConfigDir` | Required dot-prefixed string. The runtime's **local** content-rewrite directory — the `./` target GSD stamps into rewritten artefact bodies (e.g. `./.claude/` → `./<localConfigDir>/`) and the local install dir basename. Backs `getDirName()` (registry-derived, #1679). Usually `.<runtime>` (the runtime's home dot-dir), but **three runtimes diverge** because they read GSD's content from a non-home directory: `copilot` → `.github` (GitHub Copilot reads custom instructions from `.github/copilot-instructions.md` / `.github/instructions/`; see `convertClaudeToCopilotContent` rewrites in `src/runtime-artifact-conversion.cts`), `antigravity` → `.agents` (local agent/workflow dir; see the antigravity rewrites in `src/runtime-artifact-conversion.cts`), `kimi` → `.kimi-code`. Distinct from `configHome.name` (the **global** install home, which for these three is `.copilot` / `antigravity` / `agents`). Byte-parity-proven against the prior hand-maintained mapping by the golden-install-parity harness. |
| Config format | `runtime.configFormat` | Closed enum: `settings-json` \| `toml` \| `markdown` \| `markdown-dir` \| `none`. |
| Artefact layout | `runtime.artifactLayout` | Object with `global` and `local` arrays of `ArtifactKind` (`kind`, `destSubpath`, `prefix`, `nesting`, `recursive`, `stage`). |
| Command style | `runtime.commandStyle` | Closed enum: `slash-hyphen` \| `shell-var`. |
| Hooks surface | `runtime.hooksSurface` | Closed enum: `settings-json` \| `codex-hooks-json` \| `cursor-hooks-json` \| `copilot-inline` \| `cline-rules` \| `kimi-hooks-toml` \| `none`. |
| Sandbox tier | `runtime.sandboxTier` | Closed enum: `none` \| `codex-agent-sandbox`. |
| Support tier | `runtime.supportTier` | Integer: `1` (fully tested first-party) \| `2` (shipped, lower coverage). |
| Install surface | `runtime.installSurface` | Closed enum: `settings-json` \| `codex-toml` \| `copilot-instructions` \| `cline-rules` \| `cursor-hooks-json` \| `profile-marker-only`. |
| Shared settings | `runtime.writesSharedSettings` | boolean. Whether the runtime writes a shared `settings.json`. |
| Permission writer | `runtime.permissionWriter` | `null` \| `"opencode"` \| `"kilo"` \| `"antigravity"`. The finish-time permissions-sidecar writer. |
| Extended hook events | `runtime.extendedHookEvents` | string[] over a closed vocabulary: `SubagentStop`, `Stop`, `PreCompact`, `FileChanged`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `SubagentStart`. |

### `hostBehaviors`

`runtime.hostBehaviors` is a **closed vocabulary** of per-host behavior switches consumed directly by installer and runtime-adaptation code. A key outside the vocabulary is **ignored, with a non-fatal warning** naming the capability and the key; it is never a validation error, so a manifest authored against a newer GSD degrades visibly instead of failing the build of a repo that merely reads it.

Adding a key is a reviewed first-party change, which is [ADR-1016](../adr/1016-runtime-capability-descriptor.md)'s intended friction rather than an obstacle: the runtime descriptor expresses every per-host difference as a value over a closed vocabulary, and a host needing a new shape gets a named primitive rather than an open escape hatch.

> **History.** `hostBehaviors` went unvalidated until [#2801](https://github.com/open-gsd/gsd-core/issues/2801), and this page previously described it as a deliberate open seam sanctioned by ADR-1016. That attribution was wrong — ADR-1016 does not mention `hostBehaviors` at all. See the [ADR-1016 amendment](../adr/1016-runtime-capability-descriptor.md#amendment-2026-08-09-hostbehaviors-is-closed-2801).

The vocabulary holds 59 keys; 39 of them are set by exactly one capability. This table is not exhaustive — it lists the keys with the widest reuse so a reader can pattern-match new ones against the same shape:

| Key | Capabilities declaring it |
|---|---|
| `reapplyCommand` | 9 |
| `skipSharedHooksInstall` | 8 |
| `frontmatterDialect` | 5 |
| `hyphenNameAgentBody` | 3 |
| `legacyCommandsGsdInstallMigration` | 3 |
| `legacyCommandsGsdUninstall` | 3 |
| `nativePlugin` | 3 |
| `skipUpdateBannerCommand` | 3 |
| `verificationStyle` | 3 |

**`reviewerCli` has been removed.** It was a boolean that marked a runtime capability as also being a reviewer lane. [ADR-2782](../adr/2782-reviewer-lane-capability-surface.md) replaced it with the [`reviewer` body](#reviewer-body-role-reviewer-or-on-any-role); it survived one release (1.9.0 → 1.10.0) as a derived legacy alias and was deleted in Phase 7 ([#2801](https://github.com/open-gsd/gsd-core/issues/2801)). No shipped capability declares it.

**If your out-of-tree manifest still sets it:** nothing crashes and nothing else about your capability changes — it simply contributes no reviewer lane, and the registry reports a non-fatal warning naming the capability. The warning reaches you at build time on stderr, and at install time through the overlay loader's diagnostics. To restore the lane, declare a `reviewer` body; [Ship a reviewer lane in your capability](../how-to/ship-a-reviewer-lane.md) is the migration path, and the field reference is below.

See [ADR-1016](../adr/1016-runtime-capability-descriptor.md) (the runtime descriptor is a closed vocabulary; its 2026-08-09 amendment closes `hostBehaviors` too) and [ADR-2782](../adr/2782-reviewer-lane-capability-surface.md) (introduces the `reviewer` body, and D9 retires the `reviewerCli` alias).

For a minimal `role: "runtime"` example, see [ADR-1016 §Decision 8](../adr/1016-runtime-capability-descriptor.md).

---

## Reviewer body (`role: "reviewer"`, or on any role)

[ADR-2782](../adr/2782-reviewer-lane-capability-surface.md) introduces the *reviewer lane*: one external CLI or model endpoint that `/gsd-review` hands a plan to for independent review.

To declare one, follow [Ship a reviewer lane in your capability](../how-to/ship-a-reviewer-lane.md). This section is the field reference behind that guide.

The `reviewer` body is **optional and absent-safe at every layer**. A capability with no `reviewer` body is simply not a lane — that is never a validation error. This is a normative forward/backward-compatibility invariant, not a nicety: a plugin, a runtime, or a future GSD version may omit `reviewer` entirely with no consequence.

The shape is **hybrid**:

- A `reviewer` body is admissible on `role: "runtime"`, so an existing runtime capability — `codex`, `antigravity` — keeps **one** manifest that is both an installable runtime and a reviewer lane.
- A third role, `role: "reviewer"`, exists for lane-only CLIs that GSD never installs into. There are currently 5: `coderabbit`, `gemini`, `llama-cpp`, `lm-studio`, `ollama`.

Current role counts across `capabilities/`: `feature` 20, `runtime` 19, `reviewer` 5.

All 12 shipped lane declarations carry all 14 fields below.

| Field | Type | Notes |
|---|---|---|
| `slug` | string | Lane identity; grammar `^[a-z0-9][a-z0-9_-]*$`. May use `_` (`lm_studio`, `llama_cpp`) even where the capability *folder id* is kebab-case (`lm-studio`). |
| `flags` | string[] | User-facing CLI flags that select this lane. A lane may declare more than one — `antigravity` declares `--antigravity` and `--agy`. 12 lanes declare 13 flags in total. |
| `transport` | closed enum | `spawn` \| `openai-http`. |
| `probe` | object | Availability check. `probe.kind` is a closed enum: `command-exists` \| `command-capability` \| `http-reachable`. `command-capability` additionally takes `binary`, `needle`, and a **required** `timeoutMs` — it exists because a bare binary name can be ambiguous (`kimi` is claimed by both the Kimi Code CLI and the legacy Python `kimi-cli`), and the timeout bound is mandatory because an unbounded `--help \| grep` probe is this repo's named Unbounded Subprocesses defect. |
| `invoke` | object | Shape is selected by `transport`. For `spawn`: `binary`, `args[]`, `promptChannel` (`stdin` \| `argv` \| `argv-file-ref` \| `none`), `outputChannel` (`stdout` \| `file-arg`), `outputArg` (required when `outputChannel` is `file-arg`), `modelArg` (string or `null`), `effortChannel` (`none` \| `argv` \| `env`), `env` (optional; an object of environment name/value pairs, string values only, merged over the inherited environment for that one spawn — keys must match the portable environment-name grammar `[A-Za-z_][A-Za-z0-9_]*`, which is a portability policy rather than an OS limit, and `__proto__` is refused because it would be dropped before reaching the child). For `openai-http`: `hostConfigKey`, `defaultHost`, `path`, `modelDiscovery` (`none` \| `first-from-models-endpoint`), `fallbackModel`, `effortChannel`. `args` supports the `{{model}}`, `{{prompt}}`, `{{effort}}`, and `{{output}}` placeholders. **Every field in this object is disclosed at install and bound to the consent signature** — `env` and `defaultHost` by name in the consent prompt, the rest through a residual, so any change to a declared `invoke` field forces re-consent. `env` additionally **refuses execution-primitive names** — `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `BASH_ENV`, `PYTHONPATH`, `PERL5OPT`, `RUBYOPT`, `GIT_SSH_COMMAND`, `JAVA_TOOL_OPTIONS` and siblings, matched case-insensitively (Windows environment lookup is). A lane needing a specific executable declares an absolute `binary` rather than reshaping the child's `PATH`. That denylist is defence in depth and not the boundary: it cannot be complete against an arbitrary child, and disclosure runs before validation, so install-time consent — which shows every declared pair and warns on execution-primitive names — is what actually gates them. |
| `timeoutFloorMs` | number | Measured per-lane floor. Lane divergence here is real and correct — the descriptor's job is to declare divergence in one place, not to promise uniformity. |
| `timeoutConfigKey` | string or `null` | Federated config key holding this lane's outer timeout override, in SECONDS, e.g. `review.timeouts.antigravity`. Falls back to `timeoutFloorMs` when unset or invalid (#3274). |
| `emptyOutput` | closed enum | `stub-with-stderr` \| `handler-owned`. |
| `reviewsSection` | string | The `REVIEWS.md` heading this lane renders under. Must be unique across the merged roster. |
| `evidenceClass` | closed enum | `source-grounded` \| `diff-only` (diff-only findings are down-weighted in consensus). |
| `requiresBinaries` | string[] | Extra binaries the lane needs beyond `invoke.binary`. |
| `promptBudgetKey` | string or `null` | Federated config key bounding prompt size. |
| `modelConfigKey` | string or `null` | Federated config key naming the model, e.g. `review.models.kimi-code`. |
| `handler` | closed enum or `null` | `antigravity` \| `openai-compatible` \| `opencode` \| `null`. |

**`handler` is a closed enum of first-party handler names, not an open escape hatch.** [ADR-1016](../adr/1016-runtime-capability-descriptor.md) explicitly rejected "arbitrary code in the descriptor"; hard shapes are absorbed by adding a named primitive that is reviewed first-party. The consequence, stated plainly: **a third-party reviewer lane is strictly data-only.** A plugin can ship a lane, but not a quirky lane that needs imperative code — a lane requiring behavior beyond the closed `handler` set is not expressible and must be proposed and merged first-party.

Uniqueness is enforced across the merged first-party ∪ overlay set: duplicate `slug`, duplicate `flags` entry, and duplicate `reviewsSection` are each build-time violations. Two lanes sharing a `reviewsSection` heading would silently merge their output in `REVIEWS.md`, producing apparent consensus that does not exist.

An unknown field inside a `reviewer` body is a **non-fatal warning on stderr, never a build failure** ([ADR-2782](../adr/2782-reviewer-lane-capability-surface.md) D4), so a manifest built against a newer GSD degrades visibly rather than crashing.

### Example — lane-only `role: "reviewer"` capability

```json
{
  "id": "coderabbit",
  "role": "reviewer",
  "version": "1.8.0",
  "title": "CodeRabbit",
  "description": "CodeRabbit CLI — cross-AI /gsd-review reviewer lane only; not a GSD install target (no runtime body, no artifacts).",
  "tier": "full",
  "requires": [],
  "engines": { "gsd": ">=1.8.0" },
  "reviewer": {
    "slug": "coderabbit",
    "flags": ["--coderabbit"],
    "transport": "spawn",
    "probe": { "kind": "command-exists", "binary": "coderabbit" },
    "invoke": {
      "binary": "coderabbit",
      "args": ["review", "--prompt-only"],
      "promptChannel": "none",
      "outputChannel": "stdout",
      "modelArg": null,
      "effortChannel": "none"
    },
    "timeoutFloorMs": 360000,
    "timeoutConfigKey": null,
    "emptyOutput": "stub-with-stderr",
    "reviewsSection": "CodeRabbit",
    "evidenceClass": "diff-only",
    "requiresBinaries": [],
    "promptBudgetKey": null,
    "modelConfigKey": null,
    "handler": null
  }
}
```

---

## Conformance invariants

The following invariants are enforced at **build time** by `scripts/gen-capability-registry.cjs` and at **install time** by the runtime-callable `validateCapability()` / `validateCrossCapability()` over the merged first-party ∪ overlay set.

- **`version` is required.** The registry rejects any manifest without a semver `version` field.
- **`id` uniqueness.** No two capabilities may share an `id`. An overlay whose `id` collides with a first-party `id` is rejected; first-party always wins.
- **Skill and agent stem uniqueness.** Exactly one capability may own each skill or agent stem across the entire merged registry.
- **`requires` exist and are acyclic.** Every `id` listed in `requires` must exist in the registry; the dependency graph must be acyclic.
- **`requires` is tier-monotone.** A `core` capability may not require a `standard` or `full` capability. A `standard` capability may not require a `full` capability.
- **`point` values are from the closed set.** Every `point` in `steps`, `contributions`, and `gates` must be one of the 12 identifiers above.
- **`contribution.into` is a published agent role.** The `into` value must be an agent role declared by the host contract for that loop extension point.
- **Config key exclusivity.** A federated config key must be owned by exactly one capability and absent from the central `config-schema`. Presence in both is a collision; a half-migrated key fails the build gate.
- **Artefact production uniqueness per point.** No two capability steps may `produces` the same artefact name at the same loop extension point.
- **`engines.gsd` is a hard gate.** A capability whose `engines.gsd` range does not satisfy the installed GSD version is blocked at install and skipped (with a warning) at load time.
- **Path confinement.** Declared module paths may not use parent-directory traversal (`../`); modules are `require()`'d only from the capability's own install root.
- **Reserved namespace.** Capability `id` values beginning with `gsd-`, `gsd-core-`, or `anthropic-` are reserved; third-party capabilities using these prefixes are rejected.
- **`taskContentResolver.trackerPrefix` uniqueness, feature-only.** `trackerPrefix` must be unique across the merged first-party ∪ overlay capability set (mirrors `reviewsSection` uniqueness on the reviewer body above); a collision is a build-time violation. `taskContentResolver` is admissible only on `role: "feature"` bodies.

---

## Example — complete `role: "feature"` capability

The following is the canonical UI design-contract capability from ADR-894. It illustrates all major body sections.

```json
{
  "id": "ui",
  "role": "feature",
  "version": "1.0.0",
  "title": "UI design contracts",
  "description": "UI-SPEC design contract and retrospective UI audit for frontend phases.",
  "tier": "standard",
  "requires": [],
  "engines": { "gsd": ">=1.6.0" },
  "runtimeCompat": { "supported": ["*"], "unsupported": [] },
  "skills": ["ui-phase", "ui-review"],
  "agents": ["gsd-ui-checker", "gsd-ui-auditor"],
  "hooks": [],
  "config": {
    "workflow.ui_phase": {
      "type": "boolean",
      "default": true,
      "description": "Enable the UI design-contract gate during planning."
    },
    "workflow.ui_review": {
      "type": "boolean",
      "default": true,
      "description": "Enable the retrospective UI audit."
    },
    "workflow.ui_safety_gate": {
      "type": "boolean",
      "default": true,
      "description": "Block execution on unmet UI-SPEC contracts."
    }
  },
  "steps": [
    {
      "point": "plan:pre",
      "ref": { "skill": "ui-phase" },
      "produces": ["UI-SPEC.md"],
      "consumes": ["CONTEXT.md"],
      "when": "workflow.ui_phase",
      "onError": "skip"
    },
    {
      "point": "verify:post",
      "ref": { "skill": "ui-review" },
      "produces": ["UI-REVIEW.md"],
      "consumes": ["UI-SPEC.md"],
      "when": "workflow.ui_review",
      "onError": "skip"
    }
  ],
  "contributions": [],
  "gates": [
    {
      "point": "execute:wave:post",
      "check": { "query": "ui.safety-gate" },
      "when": "workflow.ui_safety_gate",
      "blocking": true,
      "onError": "halt"
    }
  ]
}
```

Notes on this example:
- `when` on each hook references its own config key; whether the phase is actually a frontend phase is decided inside `ui-phase` (self-gate).
- The `plan:pre` step self-skips on non-frontend phases, producing no `UI-SPEC.md`; the `execute:wave:post` gate's `ui.safety-gate` query passes gracefully when no `UI-SPEC.md` exists.
- A `contribution` follows this shape: `{ "point": "plan:pre", "into": "planner", "produces": [], "consumes": [], "fragment": { "path": "loop/threat-model.md" }, "when": "workflow.security_enforcement" }` (`produces` and `consumes` are required arrays — use `[]` when empty).
