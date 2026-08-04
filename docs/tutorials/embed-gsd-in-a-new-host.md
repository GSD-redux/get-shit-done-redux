# Tutorial: embed GSD in a new host

This tutorial walks through embedding GSD's orchestration loop into a brand-new
host end-to-end — from classifying the host, to composing the engine adapters,
to running a GSD command through the embedded engine. It is the learning path
that pairs with the [how-to](../how-to/author-a-host-plugin.md) (steps) and the
[reference](../reference/host-integration-interface.md) (spec).

You will build a minimal **programmatic-cli** host-plugin that invokes a GSD
command via the embedded engine. No gsd-core source changes.

---

## Prerequisites

- The GSD Host-Integration SDK entry importable in your host's runtime.
- Your host's authoritative docs open (you'll declare axes from them, never infer).

## Step 1 — Classify the host

Your host is a programmatic CLI with an event bus and a passive model (it can
only receive prompts, not call a model for you). That is the `programmatic-cli`
profile.

```js
const SDK = require('@opengsd/gsd-core/sdk');
// Confirm the profile from your declared axes:
const profile = SDK.profileOf({ embeddingMode: 'imperative', runtime: 'node' });
// → 'programmatic-cli'
```

## Step 2 — Compose the engine adapters

```js
const hookBus = SDK.createHookBus({ bus: 'host' });     // your host fires events
const model   = SDK.createModelAdapter({ modelMode: 'passive' });
const stateIO = SDK.createStateIO({ io: 'filesystem' });
const adapter = SDK.createImperativeAdapter({ runtime: 'my-cli' });
```

## Step 3 — Negotiate capabilities

```js
const req = SDK.buildHandshakeRequest({
  embeddingMode: 'imperative', commandSurface: 'slash-file', modelMode: 'passive',
  hookBus: 'host', stateIO: 'filesystem', transport: 'mcp', runtime: 'node',
});
const { effective, points, warnings } = SDK.handleHandshakeRequest(req);
// `effective` is the negotiated capability set; `points` is per-interface-point
// degradation; `warnings` flags any axis the host omitted.
```

## Step 4 — Run a GSD command through the embedded engine

The imperative adapter exposes the engine surface; your host binds its command
surface (slash commands, palette, chat) to it. A user invoking `/gsd-phase` in
your host dispatches through the embedded engine exactly as it would in a
first-party host — that is the parity the interface guarantees.

## Step 5 — Verify parity

Assert that your host-plugin, built from the SDK entry alone, produces the same
negotiated result as the in-process path. The SDK smoke test
(`tests/sdk-smoke.test.cjs`) is the template — copy its structure for your
host's own parity test.

## Recap

You classified a host, declared its axes from authoritative docs, composed the
adapters, negotiated capabilities over the (serialized) handshake, and ran a GSD
command through the embedded engine — all without touching gsd-core source. A
new host is now a plugin you wrote.

## Next

- [How-to: author a host-plugin](../how-to/author-a-host-plugin.md) — the step-by-step reference.
- [Interface versioning policy](../explanation/interface-versioning-policy.md) — how the surface evolves.
