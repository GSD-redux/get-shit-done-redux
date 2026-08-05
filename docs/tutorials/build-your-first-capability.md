# Build Your First Capability

In this tutorial you will build a tiny, fully declarative GSD capability from scratch and watch it act inside your project's loop. By the end you will have a working capability installed, visible in `gsd capability list`, and firing at the `plan:pre` extension point.

No code is required. Declarative capabilities — those that own only prompt fragments and hook declarations, with no executable hook scripts or MCP servers — require no trust prompt at install time.

We will build a capability called `hello-note`. It registers a `contribution` at the `plan:pre` extension point that injects a short greeting fragment into the planner's prompt and declares that it produces a file called `HELLO.md`.

---

## Before you begin

You need:

- GSD 1.6.0 or later (`gsd --version`).
- A throwaway project directory. Create one now:

```bash
mkdir ~/hello-demo && cd ~/hello-demo
gsd init
```

You will work inside `~/hello-demo` for the rest of this tutorial.

---

## Step 1 — Scaffold the capability folder

Capabilities live in a `capabilities/<id>/` folder. Create the folder structure:

```bash
mkdir -p capabilities/hello-note/fragments
```

Your project tree now looks like this:

```text
~/hello-demo/
  .gsd/
  capabilities/
    hello-note/
      fragments/        ← prompt fragments live here
```

---

## Step 2 — Write the prompt fragment

The fragment is a short Markdown file that will be injected into the planner's prompt when the `plan:pre` hook fires. Create it:

```bash
cat > capabilities/hello-note/fragments/plan-pre.md << 'EOF'
## Hello from hello-note

This planning session was started with the hello-note capability active.
Record a brief note in HELLO.md summarising the plan goal in one sentence.
EOF
```

Notice that the fragment is plain prose. The capability system reads this file and inlines its text when the capability is loaded, then renders it into the planner's prompt when the loop reaches `plan:pre`.

---

## Step 3 — Write `capability.json`

Create the manifest at `capabilities/hello-note/capability.json`:

```json
{
  "id": "hello-note",
  "role": "feature",
  "version": "0.1.0",
  "title": "Hello Note",
  "description": "Injects a greeting note at plan:pre and produces HELLO.md.",
  "tier": "standard",
  "requires": [],
  "engines": { "gsd": ">=1.6.0" },
  "runtimeCompat": { "supported": ["*"], "unsupported": [] },
  "skills": [],
  "agents": [],
  "config": {},
  "steps": [],
  "contributions": [
    {
      "point": "plan:pre",
      "into": "planner",
      "fragment": { "path": "fragments/plan-pre.md" },
      "produces": ["HELLO.md"],
      "consumes": [],
      "onError": "skip"
    }
  ],
  "gates": []
}
```

A few things to notice:

- `version` is required in 1.6.0. Use semver.
- `engines.gsd` is a hard gate: GSD will refuse to install or load this capability on any version older than 1.6.0.
- `role: "feature"` means this capability adds optional behaviour to the loop — it is not a runtime descriptor. A `feature` capability must declare `runtimeCompat`; `{ "supported": ["*"] }` means "every runtime".
- This is a **contribution**, not a **step**. A contribution injects a prompt fragment into a named agent role (`into`) and needs no dispatch target. A step, by contrast, *must* carry a `ref` with exactly one of `skill`, `agent`, or `command` — so a fragment-only injection is always a contribution. That is why `steps` is left empty here.
- `into: "planner"` names the agent role that receives the fragment. `planner` is one of the roles published by the `plan:pre` extension point (alongside `researcher` and `checker`); the value must be a role that point publishes or the manifest fails validation.
- `produces` tells the registry that this contribution writes `HELLO.md`, which lets the registry order hooks and detect unsatisfied dependencies in more complex setups.
- `onError: "skip"` means the loop continues even if this contribution fails. For a first capability that is the safe choice.

The fragment is referenced by `path`. At load time GSD reads the file and inlines its text into the registry, so the contribution carries the materialised content wherever the loop renders it. This keeps the capability completely declarative — no executable code is involved.

---

## Step 4 — Install the capability into your project

Install from the local path with `--scope project` so it is scoped only to this demo project:

```bash
gsd capability install ./capabilities/hello-note --scope project
```

The command emits a JSON result:

```json
{
  "status": "installed",
  "id": "hello-note",
  "version": "0.1.0",
  "scope": "project",
  "disclosure": [
    "This capability ships no executable surfaces (declarative only)."
  ]
}
```

GSD copies the bundle into `.gsd/capabilities/hello-note/` and records it in the project ledger at `.gsd-capabilities.json`. Because `hello-note` declares no executable surfaces (no hook scripts, no MCP servers, no command modules) it installs without a consent prompt — the `disclosure` line confirms there was no runnable code to review. That is intentional: declarative capabilities are safe to install without reviewing executable code.

---

## Step 5 — Confirm the installation

```bash
gsd capability list
```

`list` emits a JSON array of every capability GSD can see — the first-party ones that ship with GSD, plus any you have installed. Your `hello-note` entry appears at the end:

```json
{
  "id": "hello-note",
  "role": "feature",
  "version": "0.1.0",
  "tier": "standard",
  "source": "./capabilities/hello-note",
  "scope": "project",
  "status": "active",
  "reason": null,
  "title": "Hello Note"
}
```

`status` is `active` — the capability is installed, compatible with your GSD version, and will fire. (The other status values are `incompatible`, when the host GSD version is outside the capability's `engines.gsd` range, and `inactive`, when a project-scoped capability has not been consented on this machine.)

You can also query the active hook set for the `plan:pre` point:

```bash
gsd loop render-hooks plan:pre --raw
```

The envelope is `{ point, activeHooks, rendered }`. Your contribution appears in `activeHooks` (alongside any first-party hooks active at this point):

```json
{
  "capId": "hello-note",
  "kind": "contribution",
  "into": "planner",
  "fragment": {
    "inline": "## Hello from hello-note\n\nThis planning session was started with the hello-note capability active.\nRecord a brief note in HELLO.md summarising the plan goal in one sentence.\n",
    "path": "fragments/plan-pre.md"
  },
  "produces": ["HELLO.md"],
  "onError": "skip"
}
```

Notice that `fragment.inline` now holds the materialised text from `fragments/plan-pre.md` — GSD inlined it at load time, while keeping the original `path` for reference. The top-level `rendered` field of the envelope contains the same fragment formatted as a `<contribution from="hello-note" into="planner">…</contribution>` block, which is what the planner actually receives.

---

## Step 6 — See the contribution reach the planner

Planning is driven by a slash command, not a `gsd` subcommand. In your AI assistant, start a planning session for a phase with:

```text
/gsd-plan-phase
```

When the planner runs, the `plan:pre` hook set is rendered into its prompt, so it receives the `hello-note` contribution and, following the fragment's instruction, records a one-line note in `HELLO.md`.

You do not need to run a full planning session to confirm the wiring, though. The `loop render-hooks` command shows exactly what the loop would hand the planner — the same output you saw in Step 5:

```bash
gsd loop render-hooks plan:pre --raw
```

Find `hello-note` in `activeHooks` and read the `rendered` field: the `<contribution from="hello-note" into="planner">` block is the literal text the planner receives. That confirms the capability is wired into the loop, without dispatching a single agent.

---

## Step 7 — Remove the capability

When you want to stop the contribution from firing, remove the capability from the project:

```bash
gsd capability remove hello-note --scope project
```

This emits a JSON result describing what was removed:

```json
{
  "status": "removed",
  "id": "hello-note",
  "scope": "project",
  "removedFiles": [
    ".gsd/capabilities/hello-note"
  ],
  "strippedEdits": 0,
  "dataPreserved": true
}
```

Run `gsd capability list` again and `hello-note` is gone from the array. Run `gsd loop render-hooks plan:pre --raw` and you will see it is absent from `activeHooks`: a removed capability contributes nothing to the loop.

Removing the installed bundle does not touch the source folder you authored under `capabilities/hello-note/` — that is your copy. To reinstall, just run the Step 4 command again.

---

## You have built your first capability

You scaffolded a capability folder, wrote a manifest with a single `plan:pre` contribution, installed it into a project-scoped ledger without a trust prompt, confirmed it in the active hook set, saw it reach the planning loop, and removed it cleanly.

The capability you built is fully declarative: it owns a prompt fragment and a hook declaration, and no executable code was involved at any point.

---

## Where next

- [Publish a capability](../how-to/publish-a-capability.md) — package and share your capability via a URL or registry.
- [Import a capability from a URL](../how-to/import-a-capability-from-a-url.md) — install a third-party capability from a git URL, tarball, or npm package.
- [Capability manifest reference](../reference/capability-manifest.md) — all fields, types, and validation rules for `capability.json`.
- [Capability trust model](../explanation/capability-trust-model.md) — why declarative capabilities need no consent prompt and how executable surfaces are disclosed.
