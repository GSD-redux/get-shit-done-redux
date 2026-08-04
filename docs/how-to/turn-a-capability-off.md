# Turn a capability off (and keep it off)

This guide shows you how to switch a GSD capability off so it stops taking part in the loop — and stays off — and how to switch off a single feature of a capability without disabling the whole thing.

GSD resolves one capability state from three places: whether the capability is installed, whether it is surfaced, and whether each of its hooks is gated in config. "Off" means off across all three. For why the model works this way, see [Develop a Capability for GSD 1.6.0+](develop-a-capability.md).

> **First-party vs. installed: pick the right off-switch.** The path depends on where the capability came from.
>
> - A **first-party** capability — one that ships with GSD (for example `ui`, `code-review`, `research`) — is turned off with `gsd capability disable <id>` or gated with `gsd capability set <id> --gate …`. These verbs validate `<id>` against the built-in capability registry.
> - An **installed third-party overlay** — one you added with `gsd capability install …` — is **not** in that build-time registry, so `disable`/`enable`/`set` reject it with `unknown capability: "<id>"`. The off-switch for an installed overlay is `gsd capability remove <id> --scope <scope>`.
>
> The rest of this guide covers first-party capabilities. For installed overlays, jump to [Turn off an installed third-party capability](#turn-off-an-installed-third-party-capability).

The reliable, fully general way to change first-party capability state is the `capability` command. The `/gsd-surface` and `/gsd-settings` slash commands are convenient interactive front-ends, but they operate on **skill clusters**, not arbitrary capabilities — so reach for the CLI when you want a precise, scriptable, per-capability switch.

---

## Turn a whole first-party capability off

Disable the capability by id:

```bash
gsd capability disable <id>
```

For example, to stop the UI capability:

```bash
gsd capability disable ui
```

This unsurfaces the capability's skills and makes all of its hooks inactive. It is reversible and needs no reinstall — the bundle stays on disk and your hook gates are preserved. `gsd capability disable <id>` is exactly `gsd capability set <id> --off`; re-enable with `gsd capability enable <id>` (i.e. `--on`).

`disable`/`enable`/`set` only accept ids the built-in registry knows about. Run them against an installed third-party overlay and you get `unknown capability: "<id>"` — see [Turn off an installed third-party capability](#turn-off-an-installed-third-party-capability) for that case.

Check the result:

```bash
gsd capability state --raw
```

The capability now reports `enabled: false` and every hook `active: false`.

---

## Turn off one feature of a capability

To keep a capability on but switch off a single hook, gate that hook instead of disabling the capability. A **gate** is a dotted config key declared in the capability's `config` slice whose boolean value controls whether one of its hooks fires. Set it to `false`:

```bash
gsd capability set code-review --gate workflow.code_review=false
```

The capability stays enabled; only that hook stops firing. `--gate` is repeatable, so you can set several gates in one call. See the [`set` reference](../reference/gsd-capability-command.md#set) for the full contract.

---

## Capabilities that own no skills

Some capabilities (for example, `research`) contribute only hooks and agents — they have no skills to unsurface, so disabling them via the surface has no effect. Switch these off by gating their hooks instead:

```bash
gsd capability set research --gate workflow.research=false
```

If you gate every hook of a capability off while it is still surfaced, `gsd capability state` flags it as surfaced-but-inactive — a sign you probably meant to disable the capability itself.

---

## Turn off an installed third-party capability

A capability you added with `gsd capability install …` is an **installed overlay**, not a first-party capability. It is not present in the build-time registry that `disable`/`enable`/`set` validate against, so those verbs reject it:

```bash
gsd capability disable my-overlay
# error: unknown capability: "my-overlay"
```

**Remove it.** This is the deactivation path for an installed overlay — it strips the overlay's files and edits for the chosen scope:

```bash
gsd capability remove my-overlay --scope global    # default scope is global
gsd capability remove my-overlay --scope project   # for a project-scoped install
```

`--scope` defaults to `global`, so pass `--scope project` for a project install. Add `--purge-data` to also delete the overlay's persisted data. If the id is not installed in the chosen scope you get `capability "my-overlay" is not installed in <scope> scope`. (Trying to `remove` a first-party id instead reports that it cannot be removed here — use the product uninstaller, `gsd --uninstall`.)

> The `/gsd-surface` clusters described below are derived from the **built-in** capability registry, so they cover first-party skill-owning capabilities. For an installed overlay, `remove` is the off-switch.

See [Remove a capability](remove-a-capability.md) for the full removal flow and [`gsd capability remove`](../reference/gsd-capability-command.md#remove) for every flag and output field.

---

## The interactive paths (`/gsd-surface` and `/gsd-settings`)

The slash commands are the interactive equivalents, useful when you are working inside an agent session rather than scripting:

- **`/gsd-surface disable <cluster>`** toggles a whole skill **cluster** on or off and re-stages the surface. Its argument is validated against the fixed set of cluster names — one of `core_loop`, `audit_review`, `milestone`, `research_ideate`, `workspace_state`, `docs`, `ui`, `ai_eval`, `ns_meta`, `utility` (the command rejects anything else and lists these). A few of these names coincide with first-party skill-owning capability ids (for example `ui`), so `/gsd-surface disable ui` works — but the command does **not** accept an arbitrary capability id, including an installed overlay's id. To switch off a specific capability by id, use the CLI (`gsd capability disable <id>` for first-party, `gsd capability remove <id>` for an installed overlay). Reverse a cluster with `/gsd-surface enable <cluster>`.
- **`/gsd-settings`** is the interactive prompt for GSD's workflow toggles (the `workflow.*` config keys that gate hooks). Use it to turn workflow features on or off conversationally; it writes the same config keys that `gsd capability set … --gate` writes.

For anything you want to be exact about — a specific capability id, a single named gate, or a step in a script or CI job — prefer the CLI.

---

## Scripting it

To mutate capability state directly (in scripts or CI), call the command non-interactively. The first three verbs work on **first-party** ids; the last works on **installed overlays**:

```bash
# Disable a whole first-party capability
gsd capability disable <id>          # equivalently: gsd capability set <id> --off

# Re-enable
gsd capability enable <id>           # equivalently: gsd capability set <id> --on

# Toggle one hook gate
gsd capability set <id> --gate <key>=<true|false>

# Deactivate an installed third-party overlay (disable/set would reject it)
gsd capability remove <id> --scope <global|project>
```

See the [`gsd capability` command reference](../reference/gsd-capability-command.md) for every subcommand, flag, and output shape.

---

## Related

- [`gsd capability` command reference](../reference/gsd-capability-command.md) — `disable`, `enable`, `set`, and the rest of the family
- [Develop a Capability for GSD 1.6.0+](develop-a-capability.md)
- [Install a minimal GSD and add skills later](install-minimal-and-add-skills.md)
- [docs index](../README.md)
