# How to update GSD Core

Update an existing GSD Core install to the latest release, preview the changelog before committing, and recover any local customisations that the update would overwrite.

**What you need:** The same runtime GSD is installed for. The update command re-runs the installer under the hood, so it needs Node.js and npx available (same requirement as the original install).

---

## The standard update path

From inside your AI runtime, run:

```bash
/gsd-update
```

GSD will:

1. Detect the installed version and install scope (global or local).
2. Check npm for the latest release of `@opengsd/gsd-core`.
3. Fetch the changelog and show you what changed between your installed version and the latest.
4. Ask for confirmation before touching anything.
5. Back up any user-added files found inside GSD-managed directories to `gsd-user-files-backup/`.
6. Run the installer (`npx @opengsd/gsd-core@latest --<runtime> --<scope>`).
7. Clear the update-check cache so the statusline indicator resets.
8. Offer to restore the user-added files it backed up in step 5.
9. Report whether locally modified GSD files were backed up to `gsd-local-patches/`.

Restart your runtime after the update to pick up new commands and agents.

---

## Flags

| Flag | What it does |
|------|--------------|
| `--sync` | After updating, sync skills from the GSD registry |
| `--reapply` | After updating, merge locally modified GSD files back in from `gsd-local-patches/` |
| `--next` / `--rc` | Target the `@next` RC dist-tag instead of `@latest` (installs or refreshes a release candidate; see ADR #660) |

```bash
/gsd-update --sync        # Update and sync skills
/gsd-update --reapply     # Update and reapply local patches
/gsd-update --next        # Install from the @next RC dist-tag
```

---

## Install or refresh a release candidate

GSD publishes release candidates on the `@next` npm dist-tag (established by ADR #660). To install or refresh from that channel:

```bash
/gsd-update --next
# or equivalently:
/gsd-update --rc
```

The full update flow applies — scope/runtime detection, changelog preview, custom-file backup, and cache clearing all run normally. The only difference is that `check-latest-version.cjs` resolves the `@next` tag and npx installs from `@opengsd/gsd-core@next`.

Only `latest` and `next` are supported channels; no arbitrary dist-tag can be passed (the script enforces an allowlist and exits with code 2 on an invalid tag).

Omitting `--next`/`--rc` keeps targeting `@latest` (stable channel, no change in behavior).

---

## Reviewing the changelog before updating

`/gsd-update` always shows the changelog diff between your installed version and the latest *before* it asks for confirmation. You do not need to visit GitHub separately. The output looks like:

```text
## GSD Update Available

Installed: 1.39.0
Latest:    1.41.0

### What's New
────────────────────────────────────────────────────────────
[changelog entries for 1.40.0 and 1.41.0]
────────────────────────────────────────────────────────────

Proceed with update? [Yes, update now / No, cancel]
```

If the changelog cannot be fetched (no network access, npm outage), the update still proceeds after confirmation — it does not block on changelog availability.

---

## Recovering local customisations

### Files you added inside GSD-managed directories

If you placed custom files inside directories that GSD owns (for example, custom agents prefixed with `gsd-` or extra files in `commands/gsd/`), the installer detects them and copies them to `gsd-user-files-backup/` before wiping those directories.

After the new version is installed, the update offers to put them back. You get a list of what was backed up, then a choice:

- **Restore them now** — each file is copied back to its original location and the update reports what it restored.
- **Leave them in the backup** — nothing is copied; the backup stays exactly where it is.

Either way the backup is **never deleted**, so declining is not destructive and you can restore later.

Before copying anything back, the restore runs a compatibility pass against the version that was just installed and attaches a warning to any file that looks like it may no longer work — one that references a workflow or `/gsd:` command the new release retired, or a skill missing its `name` / `description` frontmatter. Warnings are advisory: the file is still restored, with the warning shown next to it, so you can decide whether to fix it.

Two cases are skipped rather than restored, because restoring would destroy something:

- The new release now ships a file at that exact path (your custom file would overwrite GSD's).
- A different file is already sitting at that path (restoring would overwrite your current version).

Both stay in the backup and are reported with the reason.

To restore later — or after an update where you declined — run the same operation directly:

```bash
node <config-dir>/gsd-core/bin/gsd-tools.cjs restore-custom-files --config-dir <config-dir> --apply
```

Drop `--apply` to preview what would be restored without writing anything.

Files you placed outside GSD-managed directories — custom agents not prefixed with `gsd-`, custom commands outside `commands/gsd/`, your `CLAUDE.md` files, and custom hooks — are never touched by the installer.

### GSD files you modified directly

If you edited a file that GSD installed (for example, tweaking an agent's system prompt), the installer detects the modification via a hash comparison against its manifest, backs the file up to `gsd-local-patches/`, and then replaces it with the new version. After the update:

```bash
/gsd-update --reapply
```

This merges your modifications from `gsd-local-patches/` back into the newly installed files.

If you skipped `--reapply` after a previous update and want to apply patches now:

```bash
/gsd-update --reapply
```

It is safe to run `--reapply` on its own without triggering a new download — if you are already on the latest version, GSD skips the install step and goes straight to reapplying patches.

---

## When npm is unavailable

If `npx @opengsd/gsd-core@latest` fails due to an npm outage, network restrictions, or because you are working from the source repository, use the manual update procedure in [docs/manual-update.md](../manual-update.md). That document covers pulling the latest commit, building the hooks dist, and running `node bin/install.js` directly.

---

## If you are already on the latest version

`/gsd-update` exits early with a confirmation message — no download, no install, no restart needed.

---

## Installer migrations

Each GSD release may include installer migrations that rename, move, or retire managed files. The migration layer runs automatically before the new package payload is written. Migrations that would affect files you have modified prompt for confirmation rather than acting silently. For the full design and runtime-configuration contract registry, see [docs/installer-migrations.md](../installer-migrations.md).

---

## Related

- [Install on your runtime](install-on-your-runtime.md)
- [Commands reference](../COMMANDS.md)
- [Manual update](../manual-update.md)
- [Installer migrations](../installer-migrations.md)
- [Docs index](../README.md)

## CLI version-skew warning

GSD warns (to stderr, non-blocking) when the resolved `gsd-tools.cjs` is **outside your project root** while a project-local install exists — a sign that a global install (often a retired `@gsd-build/sdk` canary) is shadowing your project-local GSD. The warning names the resolved path and, for the `@gsd-build/sdk` case, gives the removal command:

```bash
npm uninstall -g @gsd-build/sdk
```

If you see this warning, remove the stale global package so `gsd_run` resolves the project-local install.
