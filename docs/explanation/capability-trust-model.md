# The capability trust model

> **Explanation** — This document describes *why* GSD draws its trust
> boundaries where it does, and *what the trade-offs are*. It is not a
> step-by-step guide to installing capabilities; for that, see the how-to
> guides for [importing a capability](../how-to/import-a-capability-from-a-url.md) and
> [version management](../how-to/version-a-capability.md). For the decision record, see
> [ADR-1244 D5](../adr/1244-capability-ecosystem.md#d5--trust-model-artifact-parity-is-full-trust-posture-is-tiered).
> For the capability field reference, see the
> [capability matrix](../reference/capability-matrix.md).

---

## The central thesis: artifact parity is not trust parity

GSD 1.6.0 opens the capability platform to third-party authors with **full
artifact parity**: a third-party capability may ship the same executable
surfaces that GSD Core ships — hooks, MCP servers, command modules, and
reviewer lanes. This is a deliberate product choice, and it carries real
security weight.

Full parity means a third-party capability, once installed, can execute code
the next time a relevant loop event fires. There is no "first use" gate.
There is no sandbox. The capability author has, in effect, a code-execution
path into your runtime.

The maintainer's response to this is not to deny parity but to draw a sharp
line between two things that are often conflated:

- **Artifact parity** — what a third-party capability is *allowed to ship*.
- **Trust posture** — the evidence and consent required before that capability
  *executes* on your machine.

GSD grants full artifact parity. It does not grant symmetric trust. First-party
capabilities are implicitly trusted because they *are* the shipped package —
their provenance is the GSD Core release process itself. Third-party
capabilities require explicit, informed, revocable consent plus SHA-pinned
integrity before any executable surface is activated. These two things are
structurally separate, and keeping them separate is what makes full parity
defensible.

---

## What the ecosystem learnt the hard way

GSD's trust model is not designed in isolation. It is informed by failures in
four ecosystems that tackled the same problem — and each one paid tuition.

### VS Code: auto-update + stolen publisher credentials

VS Code's extension marketplace grants extensions the same permissions as the
editor itself. In 2023 a publisher's personal access token was stolen; the
attacker published a backdoored update to an existing, trusted extension. Every
user with auto-update enabled received the malicious version silently, on the
next launch, with no prompt. The lesson: auto-update for executable surfaces is
a liability when credentials can be compromised, because the user's last
explicit act of trust was for *version N* — not for whatever version N+1
contains.

GSD's response: auto-update is **off by default** for third-party capabilities.
When it is enabled, a change to the *executable set* (the set of hooks, MCP
servers, command modules, or reviewer lanes the capability declares) triggers a
re-consent prompt before the update applies. Updating a non-executable
capability (documentation, agents, skills) does not require re-consent.

VS Code also has no signature check on VSIX packages. GSD requires an
`integrity` SHA-512 pin in the ledger, verified before extraction.

### npm: the supply-chain attack surface

npm's `postinstall` scripts mean that downloading a package can execute
arbitrary code on the developer's machine — a property that supply-chain
attackers have exploited in the s1ngularity attack class (a malicious package
is published under a name a legitimate package depends on). npm's own
recommendation for sensitive environments is `--ignore-scripts`.

GSD takes a stronger position: **install never executes capability code**,
full stop. Installation is a copy-only staging operation. There is no
`postinstall`-equivalent. A capability's hooks, MCP server, command
modules, and reviewer lanes are not invoked during install; they are first
invoked when the loop fires after install. This means a malicious payload in an
executable surface cannot be triggered by the act of downloading it — the user
has a window between install and first use to verify what they consented to.

### The reviewer lane: the one surface that *receives* data

Three of the four disclosure classes are about code the capability gets to
**run**. A reviewer lane — one external CLI or model endpoint that `/gsd:review`
hands a plan to — is different in kind, and the difference is the reason it is
disclosed at all.

A lane is piped the plan text, the requirements, the research findings, and the
`CONTEXT.md` decisions, and its output is read back into `REVIEWS.md`. That is an
**egress channel for the most sensitive artifacts GSD produces**. Making lanes
pluggable without a disclosure class would have opened a data-exfiltration path
behind a manifest field, which is why the trust work gates the feature rather
than following it.

What is disclosed depends on how the lane is reached:

- A **spawned** lane discloses its binary **and its full declared arguments**, in
  both rendered and raw form. Disclosing the binary alone would be insufficient,
  and not hypothetically: a lane declaring `python3` with innocuous arguments
  could later change them to `["-c", "<arbitrary program>"]` without the binary
  changing at all. Arguments are therefore signature-bound, exactly as they are
  for MCP servers.
- An **OpenAI-compatible HTTP** lane has no binary, so it discloses the
  **destination host** and the config key that names it. Disclosing `curl` would
  be technically true and practically meaningless; the destination is the
  disclosure that matters. A `localhost` destination is still disclosed, and is
  distinguished from a remote one — a lane pointed at a local port is an egress
  channel too, and the port may not be what the user assumes.

Both forms additionally name the **egress payload classes**, rather than an
unhelpful "sends data to the tool".

**Stated honestly:** consent-at-install is a weaker gate for a *standing* egress
channel than it is for a hook. A user consents once; the lane thereafter receives
every plan on every review run. Disclosure makes the channel visible, pinned and
revocable — it does not make it safe. A per-run egress prompt was considered and
rejected as consent fatigue that trains users to approve blindly.

One consequence is worth naming because it does not follow the pattern of the
other three classes. A lane's destination host lives in `.planning/config.json`,
which is user- and CI-editable at any time with no re-install and no integrity
check — unlike every other consent-bound value, all of which come from the
SHA-pinned manifest. Consent therefore binds the **resolved host**, not merely
the config key, so that a later edit redirecting a consented lane to a different
destination is detectable rather than silent.

SLSA provenance (the `provenance` field in `capability.json`) provides a
machine-checkable link from a capability bundle back to a specific commit in a
specific source repository. GSD emits provenance for first-party capabilities
in CI and recommends it for curated capabilities; whether to require it for
community-listed third-party capabilities is an open question tied to whether
GSD operates a central registry (see the PRD).

### Obsidian: no sandbox, stated honestly

Obsidian's plugin system does not sandbox plugins. Plugins run in the renderer
process with full Electron API access. Obsidian acknowledges this directly in
its documentation and community materials, and its response is restricted mode
on by default — no community plugins run until the user deliberately disables
restricted mode — plus a human-curated plugin directory that requires a
maintainer review PR for each new plugin.

GSD borrows two things from Obsidian. First, the honesty: **there is no
sandbox**, and this document says so directly rather than implying one. Second,
the principle that explicit opt-in per capability is better than a blanket "all
community plugins are safe" message. GSD does not use restricted mode, but its
consent gate at install serves the same function: executable surfaces are
disclosed and consented to before they activate, not discovered after the fact.

GSD does not borrow Obsidian's centralised review model. Requiring a
maintainer-review PR for every third-party capability is the bottleneck that
makes the Obsidian system painful for authors and creates a PR-queue burden
for maintainers. GSD ships decentralised URL import precisely to avoid that.

### Claude Code: trust prompt + marketplace

Claude Code prompts the user at install for each extension that requires
elevated trust, lists the permissions the extension requests, and maintains a
`strictKnownMarketplaces` allowlist for managed environments where only
reviewed sources are permitted. Claude Code's SHA-pinning mechanic (pinning to
a specific version hash rather than floating on `latest`) is the direct model
for GSD's integrity field.

GSD mirrors the allowlist mechanic as `strictKnownRegistries`, and mirrors the
SHA-pin as the `integrity` field in `capability.json` and the capability
ledger.

---

## Each pillar and its reasoning

### Install never runs code

The most powerful thing GSD can say to a user about a third-party capability
is: "downloading and staging this capability will not execute any of its code."
That guarantee makes the consent step meaningful. If install could run code, a
malicious capability could bypass consent entirely — the install step would be
the attack.

Staging is copy-only: files are extracted to the install root, the manifest is
validated, cross-capability invariants are checked, and the ledger is written.
No hook fires, no module is `require()`'d, no MCP server is started. The
executable surfaces remain inert until the first loop event fires after
consent.

### Consent at install for executable surfaces

Hooks fire on the *next tool call*. There is no first-use gate for a hook —
the point at which a hook would fire for the first time is not a prompt
opportunity; it is already inside a running tool invocation. This means the
consent window is install, not first use.

GSD presents a pre-install summary that names every executable surface the
capability declares (hooks, MCP servers, command modules), their kinds (`step`,
`contribution`, `gate`), and the loop extension points they register into. For
each MCP server the summary also shows the `env` it would be spawned with (each
key and its — truncated — value) and the `cwd` it would run in, because an
environment variable can change *what* a command does (for example
`NODE_OPTIONS=--require /tmp/evil.js`) without touching the command or its
arguments. Declining aborts the install cleanly. Accepting records the consent
in the user-owned consent store (see "The project-scope trust boundary"), bound
to the bundle's integrity and a *disclosure signature* over the executable set
(hooks, command modules, and each MCP server's command, argv, env, and cwd). The
signature is a stable, key-order-independent encoding, so any later add or change
to a surface — including an env or cwd change — deactivates the capability until
the user re-consents, while a harmless key reorder does not.

For non-executable surfaces (skills, agents, workflow files), the disclosure
note explains what they do but consent is lighter — they do not execute code.

### Integrity pinning

An `integrity` field in `capability.json` carries a `sha512-<base64>` digest
of the capability bundle. When present, GSD verifies this digest before
extracting any files. A mismatch aborts the install.

What integrity pinning defends against: a capability hosted at a URL or in a
registry that is later replaced with a different bundle (whether by an attacker
who has compromised the hosting, or by an author publishing a silent breaking
change). The SHA is the commitment — "I consented to *this* bundle, not
whatever is at this URL today."

What it does not defend against: a malicious capability where the author
themselves publishes a bad bundle. The SHA is honest about what you are
installing; it says nothing about whether what you are installing is safe.

It also pins **only the top-level bundle**, not an `npm`-sourced capability's
resolved dependency graph. `--ignore-scripts` and copy-only staging stop
install-time execution, but when a command module is later `require()`'d, Node
resolves and runs its transitive dependencies — which the bundle SHA does not
cover (the Wiz / VS Code lesson). For the `npm` source kind, a green integrity
check means "the package tarball is the one you pinned," not "every line of code
that will run is the code you reviewed." Authors who want a stronger guarantee
should vendor their dependencies or ship a lockfile.

### Auto-update off by default, re-consent on executable-set change

When auto-update is enabled for a third-party capability, each update is
checked against the ledger's record of the capability's executable surfaces. If
the set of hooks, MCP servers, or command modules has changed — even if the
update is otherwise benign — auto-update halts and re-prompts. The user is
shown which surfaces were added or removed and must consent before the update
applies.

This directly addresses the VS Code stolen-PAT scenario: even if an attacker
publishes a new version of a capability you have auto-update enabled on, the
new version cannot silently gain a hook that the previous version did not have.

### Install-root confinement

A capability's command modules are `require()`'d only from the capability's own
install root. Declared paths containing parent-directory traversal (`../`) are
rejected at install-time validation. This prevents a capability from loading
code it does not own — whether by accident or by design.

### Reserved namespace

The `gsd-`, `gsd-core-`, and `anthropic-` id prefixes are reserved for
first-party use. A third-party capability that claims one of these prefixes is
rejected at the conformance gate. This prevents impersonation: a malicious
actor cannot publish a capability called `gsd-security` and exploit a user's
implicit trust in the GSD namespace.

### `capabilities.strict_known_registries` for managed environments

Teams or enterprises that want to constrain which capability sources are
permissible set `capabilities.strict_known_registries` in config. Its semantics:

- **unset / `null`** *(default)* — permissive: external installs (git / npm /
  tarball) are allowed, each still passing the consent + integrity gate. Local
  filesystem installs are always allowed.
- **`[]`** *(explicit empty array)* — lockdown: **all external installs are
  blocked**; local-only.
- **non-empty list** — a **host-based** allowlist: only sources whose host
  matches an entry (exact host or a subdomain of it — `github.com` matches
  `api.github.com` but never `evilgithub.com`; the literal token `npm` permits
  the npm source kind). A malformed (non-array) value **fails closed**.

This gives an administrator a policy lever that operates before the user even
sees a consent prompt. The default is permissive-with-consent (not Obsidian-style
restricted-by-default), because the epic deliberately chose decentralised import
with the consent prompt as the default barrier and lockdown one config key away.

### Command dispatch: where third-party code runs (1.6.0)

A capability may declare a **command family** (`commands: [{ family, module,
router }]`); `gsd-tools <family>` dispatches it by `require()`-ing the router.
This is the one place a third-party capability's own code executes, so it is
gated twice. **Consent:** a third-party family is dispatchable only if the
capability is *active* under the activation gate below — for a project-scoped
capability that means a **user consent record on this machine**, not merely a
ledger entry. A bundle merely present on disk (or a project ledger that marks it
committed) but with no on-this-machine consent record is **not** activated at
all: no declarative surfaces, no command dispatch. **Confinement:** the router
module loads only from the capability's own install root (bare-`.cjs` basename,
`realpath`-confined, rejecting `..` traversal and symlink escape); a first-party
command can never be shadowed by a third-party one.

#### The project-scope trust boundary

Capabilities install **globally** (`$GSD_HOME/.gsd/capabilities/`) or
**project-scoped** (`<projectRoot>/.gsd/capabilities/`). The authoritative
consent signal is **not** the in-repo ledger but a **user-owned consent store**
that lives **outside any repository**, at
`${GSD_HOME||homedir()}/.gsd/consent.json`. Each project-scope consent record is
keyed by `(realpath(projectRoot), capability id)` and binds the bundle's
`integrity` and its disclosure signature; GSD writes one only when *you* install
or upgrade that project-scoped capability through the lifecycle on this machine,
and removes it when you uninstall.

Before activating a project-scoped overlay — for **both** its declarative loop
surfaces (steps, gates, contributions, federated config) **and** its command
dispatch — the loader requires a matching record in this store. With no match the
capability is *discovered but inactive*: it shows up in `gsd capability list`
with `status: inactive` and a reason, but contributes nothing and runs nothing.

This closes the previous bypass: a repo you check out could ship a capability
bundle *and* a project ledger that marked it committed, and that alone used to
activate it. Now a forged or cloned project ledger activates **nothing** until
you consent on this machine — and because the consent binds the integrity and
the disclosure signature, tampering with the bundle (including changing an MCP
server's `env` or `cwd`) deactivates it until you re-consent. A **global**
install (under your own home) is trusted without a per-project record, as before.
You can audit and revoke project consents with `gsd capability trust list` and
`gsd capability trust revoke <id>`.

---

## The honest limitation: there is no sandbox

GSD does not sandbox third-party capability code. The honest reason: Node-level
sandboxing that meaningfully restricts a `require()`'d module — limiting
filesystem access, network access, subprocess spawning — would require either
a separate process with IPC overhead or a VM context that strips the Node
globals capabilities legitimately need (filesystem for writing surface files,
network for MCP, subprocess for hook shell commands). Full artifact parity and
meaningful sandboxing are in tension. The maintainer chose full parity.

What this means in practice: a third-party capability, once consented to and
installed, runs with the same permissions GSD Core itself runs with. It is not
isolated. A capability that wants to exfiltrate data, or modify files outside
its declared scope, can — exactly as a malicious npm package can.

The barrier is not a technical wall. It is:

1. **Consent** — you explicitly approved the executable surfaces this
   capability declares before they ran.
2. **Integrity** — the bundle you consented to is the bundle that ran (SHA
   verified).
3. **Reversibility** — `gsd capability remove <id>` removes exactly what the
   ledger recorded, including entries in shared config files, leaving no
   orphaned state.

These three things together mean: you know what you installed, you got what you
were shown, and you can undo it completely. They do not guarantee the content
is safe. The trust model is transparent about this.

---

## Trade-offs: the roads not taken

### Declarative-only third-party capabilities

The safer alternative considered in ADR-1244 was declarative-only third-party
capabilities: skills, agents, and workflow files, but no hooks, MCP servers, or
command modules. A third-party author could extend *what GSD describes* but not
*what it executes*.

The maintainer rejected this. A deploy gate capability, a house-style
verification step, a domain-specific planning contribution — all of these
require hook registration to have any effect on the loop. Declarative-only
third-party capabilities would be second-class citizens, unable to participate
in the parts of GSD where participation matters most. Full parity was the
explicit scope.

The cost of that choice is a permanently elevated security responsibility: URL
import with executable surfaces is the highest-maintenance, highest-risk part
of GSD. The trust model is a forever commitment, not a one-time effort.

### Centralised-registry-only distribution

The alternative to decentralised URL/git import is requiring all third-party
capabilities to go through a GSD-operated curated registry — one PR per
capability, reviewed by the maintainer before listing.

This would meaningfully reduce supply-chain risk (a human reviews every listed
capability) but at a cost the maintainer explicitly rejected: it makes
capability authors dependent on maintainer bandwidth, turns the maintainer into
a gatekeeper for an unbounded tail of stack-specific and house-style
capabilities, and replicates exactly the bottleneck that makes Obsidian's
plugin system painful.

The compromise: URL/git/npm/tarball import ships in 1.6.0 without a curated
registry. Whether GSD later operates or advertises a community registry is an
open question (PRD-1244 §8). If it does, the intent is to separate "official"
(curated) from "community" (consented-but-not-reviewed) tiers, mirroring the
split Claude Code uses for its marketplace.

---

## Summary

The capability trust model rests on a single conceptual move: separating
artifact parity from trust posture. Because those two things are kept separate,
GSD can offer authors the full power of the platform while making users'
security obligations clear and auditable. You consent to executable surfaces
before they run, you can verify the bundle's integrity, and you can remove a
capability completely. GSD does not pretend this is the same as not running
the code at all.

---

## Related documents

- [ADR-1244 D5 — Trust model](../adr/1244-capability-ecosystem.md#d5--trust-model-artifact-parity-is-full-trust-posture-is-tiered)
- [Capability matrix](../reference/capability-matrix.md) — the generated catalogue of all capabilities
- [PRD-1244 §6 — Out of scope](../prd/1244-capability-ecosystem.md#6-scope-160) — why sandboxing is explicitly out of scope
- [ADR-857](../adr/857-capability-system.md) — the 12 loop extension points; D7 and D8 extended by ADR-1244
