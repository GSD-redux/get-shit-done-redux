# ADR-0174: Retire @opengsd/gsd-sdk package boundary — single-runtime collapse

- **Status:** Accepted (2026-05-23); amended #1642 (2026-06-23) — §5 reconciled to as-built Result type + `exitReason?` field added on `InvalidArgs`
- **Date:** 2026-05-23
- **Tracking issue:** [#174](https://github.com/open-gsd/get-shit-done-redux/issues/174) — sub-issues #175–#197

## Supersedes

| ADR | What it said | Why it is superseded |
|-----|-------------|----------------------|
| [ADR-0005](0005-sdk-architecture-seam-map.md) | Established the SDK as a composition of explicit seam Modules with thin Adapters, with the SDK package itself as the composition root. | The SDK package boundary is being retired; the seam-Module vocabulary survives intact under a single `src/` tree inside `get-shit-done-cc`. |
| [ADR-0007](0007-sdk-package-seam-module.md) | Defined one explicit SDK Package Seam Module for the `@opengsd/gsd-sdk` → `@opengsd/get-shit-done-redux` compatibility transition. | The transition scaffolding this Module owned (install-layout probing, legacy-asset discovery, compatibility diagnostics) is deleted when the SDK package boundary is retired. |
| [ADR-0012](0012-command-routing-hub.md) | Introduced `CommandRoutingHub` with a `mode: 'sdk' \| 'cjs'` parameter, `sdkLoader`, `cjsRegistry`, and the `SdkDispatchFailed` / `SdkLoadFailed` errorKinds as the dispatch seam for CJS command families. | The Hub survives but is simplified: `mode`, `sdkLoader`, `cjsRegistry`, and SDK-failure errorKinds are deleted because there is no second runtime to select. The four surviving cross-cutting concerns (errors, manifest, args, observability) remain in the Hub and are now unambiguously load-bearing. |
| [ADR-3524](3524-cjs-sdk-hard-seam.md) | Hardened the CJS↔SDK seam with a generator-based Shared-Module Source Policy (one source of truth per Module, generated artifacts, freshness checks, hand-sync pair lint) as the canonical Phase 5 engine. | The generator pattern solved drift within the dual-runtime world. Collapsing onto a single TypeScript source tree in `src/` eliminates the seam these generators bridged; tsc replaces every `.generated.cjs` artifact. |

## Context

The following forced-decisions explain why this consolidation is happening now rather than continuing the ADR-3524 trajectory:

1. **Lived cost of dual-runtime exceeded the value of a separately-installable typed package.** ADR-3524 was correct about the drift problem and correct that a generator pattern was better than hand-sync. But the generator pattern is infrastructure to maintain parity between two runtimes, not value delivered to users. The total scaffolding footprint reached ~120 files: worker pool, per-Module generators, freshness checks, parity tests, transition shims, two release pipelines, and the bridge that ran the async SDK handler synchronously via `synckit` for CJS callers. None of that scaffolding was visible to users as a feature.

2. **CJS already provides the feature set in-process; the SDK package boundary added cost without user-visible capability.** Every capability the SDK was being built to expose — typed dispatch, structured results, observability, command metadata — can be compiled out of a single TypeScript source tree and required directly. The separately-installable `@opengsd/gsd-sdk` package had no external programmatic API user requirement driving it. It was scaffolding for scaffolding.

3. **The deletion test concentrated complexity rather than spreading it.** Removing the SDK package as a whole eliminates an entire surface: the bridge, the generators, the release pipeline, the parity tests. Keeping the SDK package and merging only the bridge would have preserved parity tests, generators, and the second release pipeline indefinitely.

4. **ADR-0012's `mode` parameter was the contested part of the Hub design.** Review comments during the ADR-0012 PR identified mode-selection, sdkLoader injection, and the SdkDispatchFailed errorKind as the fragile parts of the Hub contract. These concerns disappear when there is one runtime. The four surviving concerns — uniform error contract, manifest-backed resolution, arg shape coercion, observability — are clearly load-bearing and uncontested. Stripping mode makes the Hub stronger, not weaker.

5. **External programmatic API surface is not a user requirement.** The user does not need `@opengsd/gsd-sdk` to be installable by external consumers. The typed contract is internal. Retaining the package boundary would mean paying for SDK scaffolding in perpetuity to support a use case that does not exist.

## Decision

### 1. Single npm package

`get-shit-done-cc` is the sole npm package. `@opengsd/gsd-sdk` is retired. No external programmatic API is exposed. The typed contract is internal to `get-shit-done-cc`.

### 2. Source shape — TypeScript canonical in `src/`, compiled to CJS in `dist/`

`src/` is the hand-authored source of truth for all Modules. `tsc` on `prepublishOnly` compiles `src/` to CJS in `dist/`. `bin/gsd-tools.cjs` becomes a thin shim that `require`s from `dist/`. No `synckit`, no worker pool, no generator scripts replacing tsc. The `.generated.cjs` artifacts in `bin/lib/` are deleted; their callers are updated to require from `dist/`.

### 3. Source tree — seam-aligned subdirectories under `src/`

Each subdirectory maps 1:1 to an architectural concern, preserving the seam-Module vocabulary from ADR-0005 under a single tree:

| Directory | Concern |
|-----------|---------|
| `src/dispatch/` | The simplified Hub |
| `src/handlers/` | Command implementations grouped by family (`phase/`, `roadmap/`, `state/`, `init/`, …) |
| `src/errors/` | `GSDError`, `errorKind` enum, error classification |
| `src/manifest/` | Command metadata, alias resolution |
| `src/config/` | Configuration Module (was Shared CJS/SDK) |
| `src/state/` | STATE.md Document Module |
| `src/workstream/` | Workstream Inventory Module |
| `src/runtime/` | Runtime Name Policy, project-root resolution |
| `src/cli/` | `gsd-tools` entrypoint code |
| `src/observability/` | DispatchLogger, redaction |

### 4. Hub simplified — four cross-cutting concerns, no mode parameter

`CommandRoutingHub` is retained with its no-throw contract and closed `errorKind` enum, but the following are deleted: `mode: 'sdk' | 'cjs'` parameter, `sdkLoader`, `cjsRegistry`, `SdkDispatchFailed` errorKind, `SdkLoadFailed` errorKind.

The Hub owns exactly four cross-cutting concerns:

1. **Uniform error contract** — all internal throws are caught and converted to structured `Result` values; the Hub never calls `process.exit` or prints to stdout/stderr.
2. **Manifest-backed resolution** — command lookup and alias resolution are routed through `src/manifest/`.
3. **Arg shape coercion** — incoming arg shapes are normalized before handler invocation.
4. **Observability** — DispatchLogger is injected; the Hub emits `DispatchEvent` records on every dispatch path.

### 5. Sync dispatch with tight-typed `Result<T>` per `errorKind` variant

Dispatch is synchronous: `dispatch<T>(req: DispatchRequest): Result<T>`.

Rationale: continuous stack traces, no async-boundary races in the logger, no orphaned side effects, SIGINT shows what is actually running. `synckit` dependency is removed.

The `Result<T>` type is a discriminated union per `errorKind` variant, not a flat string field. The as-built type (in `src/command-routing-hub.cts`) is:

```ts
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'UnknownCommand'; command: string }
  | { ok: false; kind: 'InvalidArgs'; arg: string; reason: string; exitReason?: string }
  | { ok: false; kind: 'HandlerRefusal'; reason: string }
  | { ok: false; kind: 'HandlerFailure'; message: string; cause?: Error };
```

> **Drift note (amendment #1642, 2026-06-23):** the original §5 text specified a different planned shape — `'Unknown'` / `'BadArgs'` / `'ValidationFailed'` / `'NotImplemented'` / `'HandlerFailed'`. The SDK retirement migration kept the ADR-0012 names (`UnknownCommand` / `InvalidArgs` / `HandlerFailure`) and never added the planned `ValidationFailed` or `NotImplemented` variants; `HandlerRefusal` was added during implementation but never back-filled into this ADR. This amendment reconciles the ADR to the as-built code so the contract documented here matches what consumers actually depend on. The drift was caught during architecture review (parent #1641).

**Factories** (`src/command-routing-hub.cts`):

```ts
makeUnknownCommand(command: string) → Readonly<UnknownCommandResult>
makeInvalidArgs(arg: string, reason: string, exitReason?: string) → Readonly<InvalidArgsResult>
makeHandlerRefusal(reason: string) → Readonly<HandlerRefusalResult>
makeHandlerFailure(message: string, cause?: unknown) → HandlerFailureResult
```

**The `exitReason?` field on `InvalidArgs`** (added by this amendment) carries an `ERROR_REASON` enum value (e.g. `ERROR_REASON.USAGE`) separately from the existing `reason` explanation text. This lets routers that today call `error(msg, ERROR_REASON.USAGE)` directly — bypassing the Hub — preserve `ERROR_REASON` granularity when they migrate to returning `makeInvalidArgs(...)` Results through the Hub. The field is optional and additive; existing callers are unaffected.

**Dispatcher translation contract:** when an adapter translates an `InvalidArgs` Result whose `exitReason` is present, it passes `exitReason` as the second argument to `error(message, exitReason)` so the JSON-error envelope (`GSD_JSON_ERRORS=1`) preserves the typed reason for downstream consumers (CLI tests, integration harnesses).

Adding a new variant **or adding a field to an existing variant** requires amending this ADR (preserving the drift-prevention property from ADR-0012).

### 6. Observability seam — silent on success, structured JSON on error, opt-in audit

- **Silent on success** — no stdout/stderr output from the Hub on a successful dispatch.
- **Structured JSON to stderr on error** — every `Result` with `ok: false` emits a structured JSON line to stderr with `traceId`, `kind`, and the variant's typed payload.
- **Opt-in file audit** — `GSD_AUDIT=1` env var or `config.audit.enabled: true` writes `DispatchEvent` records to `.planning/.gsd-trace.jsonl`. Args are excluded by default (privacy); `GSD_AUDIT_ARGS=1` opts in.
- **Trace identity** — every `DispatchEvent` carries a `traceId`. Composed dispatches set `parentTraceId` to link children to the parent invocation.
- **Injected logger** — the Hub accepts a `DispatchLogger` interface. The default implementation writes per the rules above. The test implementation is in-memory and carries no I/O side effects.

### 7. `Init.*` family stays as a composer module

`src/handlers/init/composer.ts` composes N atomic dispatches. Each child dispatch receives the parent's `traceId` as its `parentTraceId`, linking the full init tree in the audit trail. The composer is the only caller that sets `parentTraceId`; all other dispatches are leaf dispatches.

## Consequences

### Positive

- **Locality up.** Composition concerns are concentrated in one place per seam. The seam-Module vocabulary from ADR-0005 is preserved; only the package boundary is retired.
- **Leverage up.** One build pipeline, one `npm publish`, one CI release workflow. The `release-sdk.yml` workflow and all SDK steps in `release.yml`, `hotfix.yml`, and `install-smoke.yml` are deleted.
- **Test surface down ~35 files; character shifts from ~40% infrastructure / 60% behavior to ~5% / 95%.** The parity tests, generator freshness checks, hand-sync pair lint, bridge unit tests, and worker-pool integration tests are deleted outright. Tests that were testing infrastructure (does the generator emit the right bytes?) become irrelevant. Tests that verify observable dispatch outcomes survive and are the dominant surface.
- **Debuggability up.** Continuous stack traces from the caller through the Hub to the handler. `traceId` trees link composed dispatches in the audit log. No async-boundary gaps in log entries. SIGINT shows the actual call in progress.
- **`synckit` dependency removed.** The in-process event-loop bridge that ran async SDK handlers synchronously for CJS callers is deleted with it.

### Negative

- **External programmatic API surface retires.** Accepted by the user — it is not a requirement. Any future external API surface would be a new design decision, not a reversion.
- **CONTEXT.md and ~20 doc files require updating across Phase 6 PRs.** The "Shared CJS/SDK Module" qualifier, SDK seam descriptions, and references to the `sdk/` directory structure are updated in Phase 6 (deferred; this ADR does not touch CONTEXT.md).
- **~15–18 PRs of implementation work across 7 phases.** See Migration Plan below.
- **`tsc` build step added to `prepublishOnly`.** `get-shit-done-cc` currently has no TypeScript compilation at the root. The build step is net-simpler than the existing generator infrastructure, but it is a new step in the publish path.

## Alternatives considered

### Shape A — pure CJS + JSDoc, zero build step

Rejected. Loses TypeScript authoring ergonomics: no structural type checking, no discriminated-union narrowing, no intra-repo cross-Module type errors caught at compile time. The SDK was correct that TypeScript authoring is worth the compilation step; this alternative gives up the wrong thing.

### Shape C — CJS + `.d.ts` overlays

Rejected. Recreates the parity problem at a smaller scale: hand-authored `.d.ts` files drift from the `.cjs` implementations unless a freshness check is added, which is the generator pattern again at half the scale. The root cause (two artifacts for one behavior surface) is not addressed.

### Keep SDK package, merge only the bridge

Rejected. Deleting `synckit` without deleting the SDK package preserves parity tests, generator scripts, and the second release pipeline indefinitely. The bridge was not the sole source of complexity — it was the most visible symptom. Merging only the bridge trades a runtime dependency for an ongoing infrastructure maintenance burden without eliminating the dual-runtime cost.

### Keep dual runtime indefinitely (status quo)

Rejected. Lived experience showed the cost ratio is wrong: ~120 files of scaffolding for a feature set CJS provides in-process, with no external programmatic API user requirement to justify the separately-installable package. The incremental fix cycle (each drift class fixed once in CJS, once in SDK, once in the generator) compounds with every new Module added to the Shared-Module table.

## Migration plan

Seven phases, ~15–18 PRs total. Each phase is a coherent slice that leaves the codebase in a working state.

| Phase | Description | PRs |
|-------|-------------|-----|
| 1 — Simplify the Hub in place | Drop `mode`, introduce tight-typed `Result<T>`, add observability seam, add `traceId`. | ~4 |
| 2 — Move TS source from `sdk/` to `src/` | Per-Module migration: config, state, workstream, runtime, manifest, errors, observability, dispatch, cli, handlers. | ~8 |
| 3 — Retire parity layer | Delete parity tests; replace `.generated.cjs` generator scripts with tsc output in `dist/`; update callers. | ~3 |
| 4 — Collapse bridge | Inline bridge logic into Hub; delete `synckit`; delete `bin/lib/cjs-sdk-bridge.cjs` and `sdk/src/runtime-bridge-sync/`. | ~1 |
| 5 — Retire SDK package | Delete `sdk/` directory; delete `bin/gsd-sdk.js` shim and `bin/gsd-sdk` wrapper; delete `release-sdk.yml` and SDK steps in `release.yml`, `hotfix.yml`, `install-smoke.yml`. | ~2 |
| 6 — Docs cleanup | Update CONTEXT.md, `docs/`, workflow markdown, and localized docs to remove SDK references. | ~4 |
| 7 — Land this ADR's PR | The PR for this ADR closes the umbrella tracking issue. | 1 (this PR) |

Implementation is tracked in [#174 — sub-issues #175–#197](https://github.com/open-gsd/get-shit-done-redux/issues/174).
