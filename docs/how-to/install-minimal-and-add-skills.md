# How to install a minimal GSD and add skills later

Install GSD Core with a small skill footprint to keep cold-start context low, then grow the surface — live or on reinstall — only when you need more. Use this when context budget matters: large existing projects, constrained models, or runtimes where every description token counts.

**What you need:** A supported runtime and the standard installer prerequisites (Node.js 18+ and npx). If you have not installed GSD at all yet, read [Install on your runtime](install-on-your-runtime.md) first — this guide covers the *profile* choice that layers on top of any runtime install.

---

## Install the minimal profile

To install only the core main-loop skills, add `--minimal` to the installer:

```bash
npx @opengsd/gsd-core@latest --claude --global --minimal
```

`--minimal` has two aliases — use whichever reads best to you; they are identical:

```bash
npx @opengsd/gsd-core@latest --claude --global --core-only
npx @opengsd/gsd-core@latest --claude --global --profile=core
```

A minimal install gives you the eight skills needed to run the core phase loop:

- `new-project`
- `discuss-phase`
- `plan-phase`
- `execute-phase`
- `phase`
- `help`
- `update`
- `surface`

No sub-agents are installed, and the skill-description tokens the model carries at cold start drop to roughly 130, against roughly 1,200 for a full install. The chosen profile is recorded in the `.gsd-profile` marker in your runtime config directory and is reapplied automatically every time you run `/gsd-update`, so you stay minimal across upgrades until you decide otherwise.

> Do not combine `--minimal` with `--profile=` — the installer treats that as a conflict and exits.

---

## Choose a profile

If `core` is too small, pick a wider profile instead. Pass it with `--profile=<name>`:

| Profile | What you get | Approx. description tokens |
|---------|--------------|--------------------------|
| `core` | The eight core-loop skills above. No agents. | ~130 desc tokens |
| `standard` | Everything in `core` plus brownfield onboarding (`onboard`), common management skills — `review`, `config`, `progress`, `resume-work`, `pause-work`, `workspace` — and the sub-agents those skills need. | ~700 desc tokens |
| `full` | Every skill and every sub-agent. This is the default when you pass no profile flag. | ~1,200 desc tokens |

```bash
# Standard: the core loop plus everyday management commands
npx @opengsd/gsd-core@latest --claude --global --profile=standard
```

If you want a named profile plus one extra cluster, compose them with a comma. The installer writes the union of both:

```bash
# Core loop plus the audit/review skills, nothing else
npx @opengsd/gsd-core@latest --claude --global --profile=core,audit
```

---

## See what is installed and what is available

From inside your runtime, list the current surface, the disabled clusters, and the token cost of each:

```bash
/gsd-surface list
```

The skills are grouped into clusters you can toggle as a unit:

`core_loop`, `audit_review`, `milestone`, `research_ideate`, `workspace_state`, `docs`, `ui`, `ai_eval`, `ns_meta`, `utility`

---

## Add skills later without reinstalling

If you installed minimal and now need more, you do not have to re-run the installer. `/gsd-surface` changes the live surface and persists the change in a separate `.gsd-surface.json` file, leaving your install-time profile marker untouched.

To switch to a wider profile in place:

```bash
/gsd-surface profile standard
```

To turn on just one cluster while keeping your base profile:

```bash
/gsd-surface enable audit_review
```

To turn a cluster back off, or to discard all your live changes and return to the profile you installed:

```bash
/gsd-surface disable utility
/gsd-surface reset
```

Surface changes take effect in your next session — restart the runtime to pick them up.

---

## Add skills by reinstalling

`/gsd-surface` is the right tool for occasional, reversible adjustments. If you have decided you want the wider surface permanently, change the install-time profile instead so every future `/gsd-update` keeps it:

```bash
# Re-run the installer without --minimal to record `full` as your profile
npx @opengsd/gsd-core@latest --claude --global

# ...or pin a specific profile
npx @opengsd/gsd-core@latest --claude --global --profile=standard
```

Running `/gsd-update` re-reads the `.gsd-profile` marker and reinstalls at that profile, so a one-off reinstall at a new profile is all you need — subsequent updates follow it automatically.

---

## Related

- [Install on your runtime](install-on-your-runtime.md)
- [Update GSD](update-gsd.md)
- [Configuration](../CONFIGURATION.md)
- [Docs index](../README.md)
