# Reference: the Host-Integration Interface

This is the normative reference for the GSD Host-Integration Interface (ADR-1239)
— the versioned, negotiated contract over which any host embeds GSD's
orchestration loop. The published surface is the SDK entry
(`src/host-integration-sdk.cts`); this document specifies every symbol on it.

The governing principle: **every axis value a host declares must come from that
host's authoritative documentation.** Where docs are silent, the host declares
the `undocumented` sentinel and the engine degrades fail-closed — it never
assumes a capability.

---

## Protocol version

`PROTOCOL_VERSION` (a positive integer) is the interface version. It governs the
negotiated capability set; see the [versioning policy](../explanation/interface-versioning-policy.md)
for what a bump means.

## The nine negotiated axes

`HOST_INTEGRATION_AXES` is the closed vocabulary. Each axis takes a documented
value (or the `undocumented` sentinel):

| Axis | Values |
|---|---|
| `embeddingMode` | `imperative` \| `declarative` |
| `commandSurface` | `slash-file` \| `slash-programmatic` \| `slash-toml` \| `palette` \| `prose-only` |
| `dispatch` | struct: `{ namedDispatch, nested, maxDepth, background, subagentToolkit, backgroundDispatch }` |
| `modelMode` | `active` \| `passive` |
| `hookBus` | `host` \| `engine` \| `none` |
| `stateIO` | `filesystem` \| `sandboxed-storage` \| `session-log-append` |
| `transport` | `mcp` \| `native-extension` |
| `runtime` | `node` \| `bun` \| `sandboxed-web` \| `python` \| `go` \| `rust` \| `electron` \| `other` |
| `effortSurface` | `argv` \| `none` |

## Classification + negotiation

- `profileOf(axes)` → `'programmatic-cli'` \| `'declarative-cli'` \| `'ide'` \| `null`.
- `negotiateHostCapabilities(host, engine)` → `{ protocolVersion, effective, points, warnings }` — the in-process negotiation. Pure; never throws.
- `handleHandshakeRequest(request)` / `buildHandshakeRequest(descriptor)` — the **serialized** (out-of-process) form of the same negotiation, JSON-safe across a wire boundary. The two are consistent: a serialized request yields the same `effective` axes as the in-process call.
- `degradationFor(point, axes)` → `{ level, fallback, unknown? }` for one of the six interface points (`command` \| `dispatch` \| `model` \| `hooks` \| `state` \| `artifact`).
- `hookEventSurfaceFor(hookEvents)` → the host-fireable hook events for a dialect (`'claude'` \| `'gemini'` \| `'opencode-subset'`), or `null` if unknown.
- `shouldFlattenDispatch(dispatch)` → `true` when the orchestrator must run inline (fail-closed).

## The engine adapters

All five satisfy a common `{ kind, runtime, install, uninstall }` shape and are
constructed fail-closed (they throw if a required host primitive is absent):

| Adapter | Factory | Selected by |
|---|---|---|
| Embedding (declarative) | `createDeclarativeAdapter({runtime})` | `embeddingMode: 'declarative'` |
| Embedding (imperative) | `createImperativeAdapter({runtime})` | `embeddingMode: 'imperative'` (also exposes the composed `registry`) |
| Model | `createModelAdapter({modelMode}, {sendRequest?})` | `modelMode` (`'active'` needs a host `sendRequest`) |
| Hook bus | `createHookBus({bus}, {hostEmit?})` | `hookBus` (`'host'` needs a host `hostEmit`) |
| State IO | `createStateIO({io}, {backend?})` | `stateIO` (`'sandboxed-storage'`/`'session-log-append'` need a host `backend`) |

The declarative + imperative adapters delegate install/uninstall in-process to
the **same** `installRuntimeArtifacts` engine function `bin/install.js` uses, so
adapter output is byte-identical to a first-party install (gated by the
differential attribution check, `tests/emitted-attribution.test.cjs`, ADR-2719).

## Profiles

`PROFILE_BASELINES` fixes the three reference profiles:

| Profile | Baseline |
|---|---|
| `programmatic-cli` | imperative, slash-file, host bus, filesystem, mcp, node |
| `declarative-cli` | declarative, slash-file, host bus, filesystem, mcp, node |
| `ide` | imperative, palette, **active** model, **engine** bus, **sandboxed-storage**, sandboxed-web |

## See also

- [How-to: author a host-plugin](../how-to/author-a-host-plugin.md)
- [Tutorial: embed GSD in a new host](../tutorials/embed-gsd-in-a-new-host.md)
- [Interface versioning policy](../explanation/interface-versioning-policy.md)
- ADR-1239 (the design) · `docs/reference/host-integration-capability-matrix.md` (per-host values + citations)
