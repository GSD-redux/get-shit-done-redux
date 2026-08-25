# How to diagnose which `gsd-tools` is running

Two packages publish a binary called `gsd-tools`: this one, and the predecessor
`get-shit-done-cc`. They answer some of the same verb names with **different** behavior.
This guide tells you which one you have and how to fix a bad resolution.

Use it when:

- a workflow behaves unlike its documentation,
- a workflow stops with `gsd-tools.cjs not found … and gsd_run is not on PATH`,
- or you simply want to confirm which tool a project is running against.

## Why this matters

[#3129](https://github.com/open-gsd/gsd-core/issues/3129) is the worked example.
`phases.clear` **archives** your phase directories under this package and **deletes** them
under the predecessor. Both print success-shaped output, and `.planning/` is gitignored by
default, so the difference is invisible until the directories are gone.

Shipped workflows no longer resolve `gsd-tools` from `PATH` at all — they resolve `gsd_run`,
which only this package publishes. That closes the path that caused #3129. The steps below
are for confirming your setup and for fixing the cases the resolver now refuses.

## Ask the tool what it is

```bash
gsd-tools runtime-identity
```

A healthy GSD runtime prints:

```json
{
  "packageName": "@opengsd/gsd-core",
  "version": "1.12.0"
}
```

Three other outcomes are possible, and they mean different things:

| What you see | What it means |
|---|---|
| The JSON above | This is our tool. Nothing to do. |
| A usage screen mentioning `gsd-sdk`, exit 1 | This is the **predecessor's** binary. See [A different package owns it](#a-different-package-owns-it). |
| `Error: Unknown command: runtime-identity` | This is our tool, but **older than the verb**. See [It is an old gsd-core](#it-is-an-old-gsd-core). |
| Nothing runs at all | Nothing named `gsd-tools` is on your `PATH`. That is fine — workflows do not need it. |

Then find out which package owns the file:

```bash
readlink -f "$(command -v gsd-tools)"
```

## A different package owns it

The resolved path contains `get-shit-done-cc`, or the identity probe printed a `gsd-sdk`
usage screen.

Workflows will not reach it — they resolve `gsd_run`, which that package does not publish —
so this is no longer dangerous. It is still worth resolving, because *you* invoking
`gsd-tools` by hand will reach the wrong tool.

If you no longer use the predecessor:

```bash
npm uninstall -g get-shit-done-cc
```

If you need both installed, put this package's bin directory first on `PATH`:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Re-run `gsd-tools runtime-identity` and confirm it reports `@opengsd/gsd-core`.

## It is an old gsd-core

The resolved path is inside `@opengsd/gsd-core`, but `runtime-identity` is not a known
command. That version predates the verb. Nothing is wrong beyond being out of date:

```bash
npm install -g @opengsd/gsd-core@latest
```

## A workflow says `gsd_run is not on PATH`

The resolver looked for `gsd_run` and found nothing, and none of the path-based locations
matched either. It stops rather than guessing — falling back to an arbitrary `gsd-tools` is
exactly the behavior that caused #3129.

This is expected in one specific case: an installation old enough to predate the `gsd_run`
binary ([#381](https://github.com/open-gsd/gsd-core/issues/381)). Upgrade:

```bash
npm install -g @opengsd/gsd-core@latest
```

Confirm the binary is now present:

```bash
command -v gsd_run
```

If you deliberately pin an old version, invoke workflows from a project or config directory
where the path-based resolution branches apply — a local install under
`gsd-core/bin/gsd-tools.cjs`, or your runtime's config directory — rather than relying on
`PATH`.

## Tell "not installed" apart from "wrong one installed"

These two look similar and have opposite fixes:

```bash
command -v gsd_run   || echo "gsd_run:   NOT FOUND"
command -v gsd-tools || echo "gsd-tools: NOT FOUND"
```

- **`gsd_run` found** — workflows resolve correctly, whatever `gsd-tools` says.
- **`gsd_run` missing, `gsd-tools` present** — the likely collision case. Run
  `readlink -f "$(command -v gsd-tools)"` and follow the matching section above.
- **Both missing** — nothing is installed globally; workflows will use a local or
  config-directory install if one exists.

## Related

- [Runtime identity](../FEATURES.md#168-runtime-identity) — why the launcher resolves `gsd_run`
  rather than asserting identity at every call
- [`runtime-identity`](../COMMANDS.md#runtime-identity) — the verb's exact output
- [#3129](https://github.com/open-gsd/gsd-core/issues/3129) — the incident this prevents
