# How to author a host-plugin for GSD

This guide is for **external tool authors** who want to embed GSD's orchestration
loop (dispatch + hooks + model + state) into a new host — a CLI, IDE, or agent
runtime GSD does not special-case — by writing a **host-plugin** against the
published Host-Integration SDK, **without modifying gsd-core source**.

The contract is the SDK entry (`src/host-integration-sdk.cts` →
`gsd-core/bin/lib/host-integration-sdk.cjs`): import only from it. Everything it
re-exports is public and versioned (`PROTOCOL_VERSION`); everything else in
gsd-core is internal and may change. A smoke test
(`tests/sdk-smoke.test.cjs`) proves a third-party host can be built from this
surface alone.

---

## 1. Decide your host's profile

Classify your host into one of three profiles (the SDK's `profileOf` does this
from your axes):

| Profile | Example hosts | Binding |
|---|---|---|
| `programmatic-cli` | OpenCode, pi | imperative adapter (`createImperativeAdapter`) |
| `declarative-cli` | Antigravity, Codex | declarative adapter (`createDeclarativeAdapter`) |
| `ide` | VS Code | imperative adapter + engine-owned hook bus + active model + sandboxed state |

## 2. Declare your host's integration axes

Declare the nine negotiated axes (`embeddingMode`, `commandSurface`, `dispatch`,
`modelMode`, `hookBus`, `stateIO`, `transport`, `runtime`, `effortSurface`) from your host's
**authoritative documentation** — never infer. Where the docs are silent, use the
`undocumented` sentinel (the SDK degrades it fail-closed). See
`docs/reference/host-integration-interface.md` for the closed vocabulary.

## 3. Compose the engine adapters

```js
const SDK = require('@opengsd/gsd-core/sdk'); // the published entry

// Engine-owned hook bus (for hosts with no event bus, e.g. VS Code):
const hookBus = SDK.createHookBus({ bus: 'engine' });

// Active model via a host provider (e.g. vscode.lm); or 'passive' for CLIs:
const model = SDK.createModelAdapter({ modelMode: 'active' }, { sendRequest: hostSendRequest });

// State IO — filesystem for CLIs, sandboxed-storage for IDEs/web:
const stateIO = SDK.createStateIO({ io: 'filesystem' });

// The engine-as-library adapter bound to your runtime id:
const adapter = SDK.createImperativeAdapter({ runtime: 'my-host' });
```

## 4. Negotiate capabilities (serialized, for out-of-process hosts)

If your host runs out-of-process (can't share object refs with the engine), use
the serialized handshake instead of the in-process `negotiateHostCapabilities`:

```js
const req = SDK.buildHandshakeRequest({ ...myAxes });
const { effective, points, warnings } = SDK.handleHandshakeRequest(req);
```

The result is identical to the in-process negotiation for the same axes — that
consistency is the contract.

## 5. Bind your host primitives + ship

Map the six interface points (command, dispatch, model, hooks, state, artifact)
to your host's primitives (palette/chat, plugin API, provider calls, etc.). The
reference host-plugins (OpenCode, Antigravity, pi, VS Code — see Phase 5) are
canonical examples to mirror. Your host-plugin is now a self-contained artifact;
no gsd-core source change is required.

## See also

- **Tutorial:** `docs/tutorials/embed-gsd-in-a-new-host.md` — a complete end-to-end embedding.
- **Reference:** `docs/reference/host-integration-interface.md` — every axis, adapter, and the handshake.
- **Versioning:** `docs/explanation/interface-versioning-policy.md` — what evolves additively vs. breaking.
