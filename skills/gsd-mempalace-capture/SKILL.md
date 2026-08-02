---
name: gsd-mempalace-capture
description: "File a phase artifact into MemPalace; mirror decision facts into its temporal KG"
argument-hint: "[CONTEXT.md|PLAN.md|SUMMARY.md]"
allowed-tools:
  - Read
  - Bash
---


**STOP -- DO NOT READ THIS FILE. You are already reading it. This prompt was injected into your context by the command system. Using the Read tool on this file wastes tokens. Begin executing Step 0 immediately.**

## Step 0 -- Banner

**Before ANY tool calls**, display this banner:

```
GSD > MEMPALACE CAPTURE
```

Then proceed to Step 1.

## Step 1 -- Config Gate

Check whether the MemPalace capability is enabled by reading `.planning/config.json` directly with the Read tool.

1. Read `.planning/config.json` with the Read tool.
2. If the file does not exist, or `config.mempalace` is absent, or `config.mempalace.enabled !== true`, or `config.mempalace.capture_artifacts === false`: display the disabled message and **STOP**.
3. Otherwise proceed to Step 2.

**Disabled message:**

```
GSD > MEMPALACE CAPTURE

MemPalace capture is disabled (mempalace.enabled / mempalace.capture_artifacts).
Nothing was filed; the loop proceeds normally.
```

This step is `onError: skip` at `discuss:post` / `plan:post` / `verify:post` -- capture never fails a phase.

## Step 2 -- Resolve target

1. **Artifact.** Take the artifact from `$ARGUMENTS`. If absent, infer from the loop point: `discuss:post` → `CONTEXT.md`, `plan:post` → `PLAN.md`, `verify:post` → `SUMMARY.md`.
2. **Room.** Map artifact → room:
   - `CONTEXT.md` → `decisions`
   - `PLAN.md` → `planning`
   - `SUMMARY.md` → `milestones`
   (Confirmed problem→fix pairs go to `problems` — see the `capture-problems` fragment used at `execute:wave:post`.)
3. **Wing.** `config.mempalace.wing` if non-empty, else `config.project_code`, else the repo directory name.
4. **Mode / transport.** Read `config.mempalace.memory_mode`. Prefer MCP (`mempalace_*`) when your MemPalace MCP server is registered and your runtime permits those tools; otherwise use the `mempalace` CLI (covered by this skill's `Bash` allow-tool), as in `mempalace-recall`.

## Step 3 -- File verbatim (idempotent)

On any error or timeout, stop and let the phase continue -- capture is best-effort.

1. **Dedup first.** Interactive: `mempalace_check_duplicate` on the artifact's deterministic drawer id. Headless: rely on `mempalace mine`'s content-hash idempotency.
2. **Add the drawer (verbatim).** File the exact artifact text into `room: <room>` of `wing: <wing>` with provenance (`source_file`, phase id). Interactive: `mempalace_add_drawer`. Headless: see below.

   **`mempalace mine` has no `--room` flag** — only `search` accepts `--room` ([CLI reference: https://mempalaceofficial.com/reference/cli.html](https://mempalaceofficial.com/reference/cli.html)). Room assignment is driven by `detect_room()` matching folder-path segments against the `rooms:` list in `mempalace.yaml` ([mining guide: https://mempalaceofficial.com/guide/mining.html](https://mempalaceofficial.com/guide/mining.html) — "Rooms are auto-detected from your folder structure"; [config reference: https://mempalaceofficial.com/guide/configuration.html](https://mempalaceofficial.com/guide/configuration.html)). Stage the artifact under a room-named folder so `detect_room()` assigns it correctly:

   ```bash
   STAGE=".planning/.mempalace-stage"
   # One-time: declare the GSD room taxonomy so detect_room() recognizes these folders
   mkdir -p "$STAGE"
   [ -f "$STAGE/mempalace.yaml" ] || cat > "$STAGE/mempalace.yaml" <<'YAML'
   # Each entry MUST be a dict with a `name` key (the miner's detect_room()
   # indexes room["name"] — a bare-string list crashes _mine_impl with
   # TypeError: string indices must be integers, not 'str'). Optional fields:
   # `description`, `keywords` (matched against folder-path segments).
   rooms:
     - name: decisions
     - name: planning
     - name: milestones
     - name: problems
     - name: general
   YAML
   # Suppress MemPalace cache artifacts written into the scanned tree
   [ -f "$STAGE/.gitignore" ] || echo "mempalace_embedder.json" > "$STAGE/.gitignore"
   # Stage under <room>/<phase-id>/<basename> — stable path so mine's content-hash
   # idempotency (file_already_mined keys on absolute source_file + mtime) deduplicates
   # instead of creating duplicate drawers on re-runs.
   ROOM_DIR="$STAGE/<room>/<phase-id>"
   mkdir -p "$ROOM_DIR"
   cp "<artifact-path>" "$ROOM_DIR/<basename>"
   # Mine with --wing only — no --room flag; detect_room() assigns from the folder path
   mempalace mine "$STAGE" --wing <wing>
   ```
3. **Mirror KG facts** when `config.mempalace.mirror_kg` is true: extract decision/delivery facts and `mempalace_kg_add` them with `valid_from` = the phase date (e.g. `(<project>, decided, <decision>)` from CONTEXT; `(<phase>, delivered, <capability>)` from SUMMARY). Under `augment` these are an *additive* mirror of GSD's native `.planning/graphs/`. Under `kg_backend`/`replace` the palace KG is the *authoritative* fact store — GSD still produces `.planning/graphs/` through its normal graphify, so an unreachable palace never loses a fact.
4. Re-running a phase MUST NOT create duplicate drawers (deterministic ids + `check_duplicate`).

## Step 4 -- Report

Print a one-line summary: `Filed <artifact> → <wing>/<room> (<n> KG facts)` or `MemPalace unavailable — capture skipped`.

## Anti-Patterns

1. DO NOT let any MemPalace error fail the step -- capture is `onError: skip`.
2. DO NOT write lossy summaries -- store the verbatim artifact text (AAAK compression is a separate, optional index).
3. DO NOT prune or delete drawers here -- pruning (`sync --apply`) is the curator agent's job at `ship:post`, wing-scoped only.
4. DO NOT skip the config gate or the dedup check.
