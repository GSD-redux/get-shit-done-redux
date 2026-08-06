# The Embeddable Orchestration System (EoS)

> **Explanation** — This document describes *why* GSD is built around one
> versioned interface for embedding inside many different host applications,
> and *how* the interface points, negotiated axes, and adapter shapes fit
> together. It is not a how-to; for field-level detail see the
> [Host-Integration Interface reference](../reference/host-integration-interface.md).
> For the compatibility rules that interface itself follows, see
> [Interface versioning and deprecation policy](interface-versioning-policy.md).

---

## The problem it solves

GSD is a filesystem-native orchestration engine, not a standalone
application. Almost all of the useful work it does — running a loop,
dispatching an agent, resolving a model, persisting state — happens *inside*
some other program: a CLI, an IDE, or an agentic desktop app. Each of those
hosts has its own command surface, its own hook system, its own idea of how a
model call gets routed, and its own storage model. There is no shared
substrate a priori.

Before 1.7.0, every host integration was wired bespoke: a runtime-specific
adapter that reached into GSD's internals however it needed to, and exposed
whatever surface that host happened to support. That does not scale. Each new
host is a fresh bespoke integration to write and maintain, drift between
hosts accumulates silently over time, and no third party can build a host
integration without reverse-engineering GSD's internals from source.

The **Embeddable Orchestration System (EoS)** is the answer: one public, versioned
contract — the ADR-1239 Host-Integration Interface — that every host
integration is expressed against, first-party and third-party alike (Phase A,
#1690). A host does not reach into GSD's internals; it declares which
interface points it binds and which values it supports for each negotiated
axis, and the engine tells it, deterministically, what it gets.

## The contract: interface points, negotiated axes, and a version handshake

The interface has three moving parts.

**Six interface points** are the places a host can bind to GSD: `command`
(how a user invokes a GSD command), `dispatch` (how that invocation reaches
the orchestration loop), `model` (how model calls are routed), `hooks` (how
lifecycle events fire), `state` (how `.planning/` state is read and
written), and `artifact` (how generated files are produced). A host does not
have to bind all six — degradation per point is graceful and explicit (see
`degradationFor` in the reference).

**Eight negotiated axes** describe *how* a given host binds those points, not
*whether* it does. `embeddingMode`, `commandSurface`, `dispatch`,
`modelMode`, `hookBus`, `stateIO`, `transport`, and `runtime` form a closed
vocabulary — a host declares a value from a documented set for each axis (or
the `undocumented` sentinel), and the engine negotiates the resulting
capability set. The full value tables live in the
[reference](../reference/host-integration-interface.md#the-eight-negotiated-axes);
what matters conceptually is that these axes describe the *shape* of a host,
not its identity — a terminal CLI and a VS Code extension are simply
different points in the same eight-dimensional space, not different kinds of
thing the engine has to special-case.

**A `PROTOCOL_VERSION` handshake** ties the two together over time. A host
declares the interface version it targets; the engine negotiates down to
`min(host, engine)` rather than refusing to talk. A host newer than the
running engine gets a warning, not a crash — its declared axes beyond the
engine's version are simply not trusted. What counts as an additive change
versus a version-bumping breaking one, and how long a deprecated value stays
usable, is the subject of its own document:
[Interface versioning and deprecation policy](interface-versioning-policy.md).

Underpinning all of it is the `undocumented` sentinel: the permanent,
fail-closed fallback for an axis a host says nothing about. GSD never
*guesses* a host's capability from context — a host that omits an axis gets
the safe default for that axis, never an assumed one.

## Two adapter shapes: imperative and declarative

The single most useful mental model for a given host integration is which of
two adapter shapes it uses, set by the `embeddingMode` axis.

**Imperative** hosts can run GSD's own shell preamble or programmatic
dispatch directly at invocation time (`embeddingMode: imperative`). The host
hands control to GSD's runtime launcher and GSD does the rest, live, on every
invocation. Most CLI-style and IDE-embedded hosts work this way — OpenCode,
Cursor, Cline, Hermes, Qwen, Kilo, Trae, Kimi, Antigravity, and Augment are
all imperative integrations.

**Declarative** hosts cannot run arbitrary code at dispatch time. They
consume static, generated artifacts — frontmatter, config, or another format
baked at install time — and interpret them through their own, fixed dispatch
mechanism (`embeddingMode: declarative`). Codex is the current declarative
host.

The consequence of that split is concrete, not academic: a declarative
host's model configuration is fixed at install time, because there is no
live dispatch step at which GSD could re-resolve it. If the model
configuration changes after install, a declarative host is silently stale
until the next reinstall — which is why GSD warns when a declarative host's
model configuration changes without a matching reinstall (#1688). An
imperative host has no equivalent gap, because it re-runs GSD's dispatch
logic on every invocation.

Three **host-capability profiles** — `programmatic-cli`, `declarative-cli`,
and `ide` — give the axis combinations for the reference cases GSD actually
targets: a baseline imperative CLI, a baseline declarative CLI, and a
baseline IDE (active model mode, engine-owned hook bus, sandboxed storage).
See `PROFILE_BASELINES` in the reference for the exact axis values each
profile fixes.

## What 1.7.0 delivered on top of the contract

1.7.0 both published the interface (Phase A, #1690) and put it to work at
scale in the same cycle. Fourteen runtimes moved onto the public interface via adapters
(#2087–#2100) — existing bespoke integrations were rewritten to express
themselves as EoS descriptors rather than as ad hoc code.

Three new hosts joined over the same window, each exercising a different
part of the interface: ZCode (#1925), pi (#2102), and a VS Code extension
driven entirely through the adapter layer (#2103). Gemini CLI was retired in
favor of its successor, Antigravity, which shares its underlying
infrastructure (#1928).

A companion `gsd-mcp-server` (#1681) gives hosts that prefer an MCP
transport a way to reach interface points 1 and 5 (`command` and `state`)
without implementing the shell-preamble dispatch path themselves — a second
transport onto the same contract, not a second contract.

The clearest evidence that the contract is doing its job: because every host
integration is now expressed as data — a descriptor, not bespoke code —
`/gsd-surface` can reproduce a given runtime's generated agent output
byte-for-byte from the same descriptors the installer itself consumes
(#1575). Runtime output can no longer drift from what the installer
produces, because there is only one source of truth for it.

## Where EoS ends and Capabilities begin

EoS is easy to conflate with GSD's other extensibility axis, Capabilities
(ADR-857, ADR-1244), because both are commonly described as "third parties
extending GSD." They answer different questions, and the distinction matters
for anyone building against either surface.

**EoS is about *where* GSD runs** — which host application embeds the
orchestration engine, and how that host's command surface, model routing,
hook bus, and storage bind to the engine. **Capabilities are about *what*
GSD does** — feature plug-ins that attach at GSD's Loop Extension Points
inside the loop that is already running. A host integration and a capability
are orthogonal axes: the same capability behaves identically regardless of
which host is running the loop, and the same host runs any composed set of
capabilities without knowing anything about them.

Each has its own non-endorsing discoverability registry (#2182): the **EoS
Registry** lists third-party host integrations, and the **Community
Capability Registry** lists third-party capabilities. Both share one entry
schema shape, one non-endorsement stance, and one submission process — see
[GSD Registries](../registries/README.md) for the full specification of
both.

## Why a published interface — and what it costs

Publishing a stable, versioned interface is a deliberate trade. The moment
an external host depends on `PROTOCOL_VERSION` 1's axis vocabulary, that
vocabulary becomes a long-term compatibility commitment — Hyrum's Law
applies in full: whatever a host observably depends on becomes part of the
contract, whether or not it was meant to be. That is the cost, and it is why
the [versioning policy](interface-versioning-policy.md) exists as a
separate, disciplined document rather than an informal understanding.

The benefit is the reason 1.7.0's fourteen-runtime migration and three new
hosts were tractable at all: a new host is additive descriptor work against
a published contract, not a fork of GSD's engine internals. A third-party
host author can build and test an integration against the documented axis
vocabulary without waiting on, or coordinating with, the core team — the
same posture the EoS Registry's non-endorsement stance formalizes for
discoverability. The interface is what makes "many hosts, one engine" a
scalable design rather than a maintenance burden that grows linearly with
every new host.

## See also

- [Reference: the Host-Integration Interface](../reference/host-integration-interface.md)
- [Interface versioning and deprecation policy](interface-versioning-policy.md)
- [GSD Registries](../registries/README.md)
- [How overlay capabilities compose](capability-overlay-model.md)
- [What's new in 1.7.0](../whats-new-1.7.0.md)
