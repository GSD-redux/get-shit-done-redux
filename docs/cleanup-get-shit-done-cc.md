# Cleaning Up get-shit-done-cc

Use this procedure when you see a persistent `⬆ /gsd-update` indicator in
your statusline even though `@opengsd/gsd-core` is already up to date.  It
removes leftover files from the old `get-shit-done-cc` package that was
renamed to `@opengsd/gsd-core` in issue [#607](https://github.com/open-gsd/gsd-core/issues/607).

## Why this happens

When the package was renamed, its version counter reset — `get-shit-done-cc`
reached `1.42.x` while `@opengsd/gsd-core` started at `1.2.0`.  If the old
package is still installed in any runtime config directory (e.g. `~/.gemini`),
its update checker writes a higher `latest` version into the shared update
cache (`~/.cache/gsd/gsd-update-check.json`), and older versions of the new
tooling accepted those foreign writes.  The statusline then permanently shows
an upgrade that does not exist.  The current installer detects and removes
these leftovers automatically, and the update cache is now per-package with a
`package_name` lineage field that readers validate — so a foreign package can
no longer poison it.

## Steps

### 1. Preview the cleanup (dry run)

Run the installer with `--dry-run` to see exactly what it would change without
touching anything:

```bash
npx -y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global --dry-run
```

The command prints the removal plan — each file path and the reason it would
be deleted — and lists any stale update-cache files it would clear, then exits
without making any modifications.

Swap `--claude` for the flag matching your runtime if you use a different one
(see the [runtime flags table](manual-update.md#runtime-flags)).

### 2. Apply the cleanup

Run the same installer without `--dry-run`:

```bash
npx -y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global
```

The installer:

- Detects leftover `get-shit-done-cc` artifacts across all runtime config
  directories (`~/.claude`, `~/.gemini`, `~/.codex`, `~/.config/opencode`,
  `~/.kilo`, and others).
- Removes orphaned hooks, commands, and any file that references the old
  package name.
- Clears the stale shared update cache.
- Preserves user-owned artifacts such as `dev-preferences.md`, custom agents,
  and any file not managed by GSD.

### 3. Manual fallback

If the installer cannot resolve `get-shit-done-cc` in your environment, or you
prefer to clean up by hand:

1. **Check each runtime config directory** for a `gsd-core/` subtree left
   by the old package:

   ```bash
   ls ~/.claude/gsd-core/
   ls ~/.gemini/gsd-core/
   ls ~/.codex/gsd-core/
   ls ~/.config/opencode/gsd-core/
   ls ~/.kilo/gsd-core/
   ```

   Remove any directories found there that were written by `get-shit-done-cc`
   (the new package installs under the same path, so only remove the directory
   if you have not yet run the new installer for that runtime).

2. **Uninstall the old package** if it is still resolvable:

   ```bash
   npx get-shit-done-cc --uninstall
   ```

3. **Delete the stale shared cache**:

   ```bash
   rm -f ~/.cache/gsd/gsd-update-check.json
   ```

### 4. Verify

Open a new terminal session (or restart your AI runtime).  The `⬆ /gsd-update`
indicator should no longer appear in the statusline.  You can confirm the
installed version with:

```bash
npx @opengsd/gsd-core@latest -- gsd-core --version
```
