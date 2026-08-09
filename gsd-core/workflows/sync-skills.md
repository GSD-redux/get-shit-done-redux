# sync-skills — Cross-Runtime GSD Skill Sync

**Command:** `/gsd-sync-skills`

Sync managed `gsd-*` skill directories from one canonical runtime's skills root to one or more destination runtime skills roots. Keeps multi-runtime installs aligned after a `gsd-update` on one runtime.

---

## Arguments

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--from <runtime>` | Yes | *(none)* | Source runtime — the canonical runtime to copy from |
| `--to <runtime\|all>` | Yes | *(none)* | Destination runtime or `all` supported runtimes |
| `--dry-run` | No | *on by default* | Preview changes without writing anything |
| `--apply` | No | *off* | Execute the diff (overrides dry-run) |

If neither `--dry-run` nor `--apply` is specified, dry-run is the default.

**Supported runtime names:** `antigravity`, `augment`, `claude`, `cline`, `codebuddy`, `codex`, `copilot`, `cursor`, `grok`, `hermes`, `kilo`, `kimi`, `kimi-code`, `opencode`, `pi`, `qwen`, `trae`, `windsurf`, `zcode` — the full capability registry runtime set (`gsd-core/bin/lib/capability-registry.cjs`'s `runtimes`) plus `grok` (a live, dedicated `~/.agents`-layout resolution branch in `getGlobalConfigDir` predating the capability registry — overridable via `GROK_AGENTS_HOME`), excluding `vscode`: it is `installSurface: 'none'` (#2103) and `getGlobalSkillsBase('vscode')` returns `null`, so a skills-root sync to/from it always aborts at Step 2's resolution guard — there is nowhere on disk to sync to.

---

## Step 1: Parse Arguments

```bash
FROM_RUNTIME=""
TO_RUNTIMES=()
IS_APPLY=false

# Parse --from
if [[ "$@" == *"--from"* ]]; then
  FROM_RUNTIME=$(echo "$@" | grep -oP '(?<=--from )\S+')
fi

# Parse --to
if [[ "$@" == *"--to all"* ]]; then
  TO_RUNTIMES=(antigravity augment claude cline codebuddy codex copilot cursor grok hermes kilo kimi kimi-code opencode pi qwen trae windsurf zcode)
elif [[ "$@" == *"--to"* ]]; then
  TO_RUNTIMES=( $(echo "$@" | grep -oP '(?<=--to )\S+') )
fi

# Parse --apply
if [[ "$@" == *"--apply"* ]]; then
  IS_APPLY=true
fi
```

**Validation:**
- If `--from` is missing or unrecognized: print error and exit
- If `--to` is missing or unrecognized: print error and exit
- If `--from` == `--to` (single destination): print `[no-op: source and destination are the same runtime]` and exit

---

## Step 2: Resolve Skills Roots

Resolve paths via `gsd_run query skills-root` — this reuses the single authoritative path table via the shipped `gsd-tools` binary (#3024: the installer entry point is not shipped in installed trees, but `gsd-tools` is):

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
SRC_SKILLS_ROOT=$(gsd_run query skills-root "$FROM_RUNTIME" --raw)
if [ $? -ne 0 ] || [ -z "$SRC_SKILLS_ROOT" ]; then
  echo "error: failed to resolve skills root for runtime '$FROM_RUNTIME' (gsd_run query skills-root $FROM_RUNTIME --raw)" >&2
  exit 1
fi

for DEST_RUNTIME in "${TO_RUNTIMES[@]}"; do
  RESOLVED_DEST_ROOT=$(gsd_run query skills-root "$DEST_RUNTIME" --raw)
  if [ $? -ne 0 ] || [ -z "$RESOLVED_DEST_ROOT" ]; then
    echo "error: failed to resolve skills root for runtime '$DEST_RUNTIME' (gsd_run query skills-root $DEST_RUNTIME --raw)" >&2
    exit 1
  fi
done
```

This loop validates every destination in `TO_RUNTIMES` up front — a bad runtime id anywhere in a multi-destination `--to` aborts here, before Step 3 or Step 5 touch anything. The resolved value itself is not retained: each of Steps 3 and 5 re-resolves `DEST_ROOT` for the specific `$DEST_RUNTIME` it is currently processing (see those steps), so `$DEST_ROOT` is always unambiguously scoped to one destination and never threaded through a shared array.

**Guard:** If the source skills root does not exist, print:
```
error: source skills root not found: <path>
       Is GSD installed globally for the '<runtime>' runtime?
       Run: npx -y @opengsd/gsd-core@latest --global --<runtime>
```
Then exit.

**Guard:** If resolving the skills root for the source OR any destination runtime fails (`gsd_run query skills-root <runtime> --raw` exits non-zero or prints nothing — see Step 2's bash), print:
```
error: failed to resolve skills root for runtime '<runtime>'
       command: gsd_run query skills-root <runtime> --raw
       Is '<runtime>' a registered runtime id? See supported runtime names above.
```
Then exit. Never proceed to Step 3 or Step 5 with an empty or unresolved root — an empty `$DEST_ROOT` turns `rm -rf "$DEST_ROOT/$SKILL"` into `rm -rf "/$SKILL"`.

**Guard:** If `--to` contains the same runtime as `--from`, skip that destination silently.

---

## Step 3: Compute Diff Per Destination

For each destination runtime:

```bash
# Bind the destination root for this iteration's destination runtime. Already
# validated to resolve successfully in Step 2's eager-validation loop;
# re-resolving here (rather than reading back a shared array) keeps this
# value unambiguously scoped to the destination currently being processed.
DEST_ROOT=$(gsd_run query skills-root "$DEST_RUNTIME" --raw)
if [ $? -ne 0 ] || [ -z "$DEST_ROOT" ]; then
  echo "error: failed to resolve skills root for runtime '$DEST_RUNTIME' (gsd_run query skills-root $DEST_RUNTIME --raw)" >&2
  exit 1
fi

# List gsd-* subdirectories in source
SRC_SKILLS=$(ls -1 "$SRC_SKILLS_ROOT" 2>/dev/null | grep '^gsd-')

# List gsd-* subdirectories in destination (may not exist yet)
DST_SKILLS=$(ls -1 "$DEST_ROOT" 2>/dev/null | grep '^gsd-')

# Diff:
# CREATE  — in SRC but not in DST
# UPDATE  — in both; content differs (compare recursively via checksums)
# REMOVE  — in DST but not in SRC (stale GSD skill no longer in source)
# SKIP    — in both; content identical (already up to date)
```

**Non-GSD preservation:** Only `gsd-*` entries are ever created, updated, or removed. Entries in the destination that do not start with `gsd-` are never touched.

---

## Step 4: Print Diff Report

Always print the report, regardless of `--apply` or `--dry-run`:

```
sync source: <runtime> (<src_skills_root>)
sync targets: <dest1>, <dest2>

== <dest1> (<dest1_skills_root>) ==
CREATE: gsd-help
UPDATE: gsd-update
REMOVE: gsd-old-command
SKIP:   gsd-plan-phase (up to date)
(N changes)

== <dest2> (<dest2_skills_root>) ==
CREATE: gsd-help
(N changes)

dry-run only. use --apply to execute.    ← omit this line if --apply
```

If a destination root does not exist and `--apply` is true, print `CREATE DIR: <path>` before its entries.

If all destinations are already up to date:
```
All destinations are up to date. No changes needed.
```

---

## Step 5: Execute (only when --apply)

If `--dry-run` (or no flag): skip this step entirely and exit after printing the report.

For each destination with changes:

```bash
# Bind DEST_ROOT for this iteration's destination (see Step 3's identical
# re-resolution note — Step 2 already validated this resolves successfully).
DEST_ROOT=$(gsd_run query skills-root "$DEST_RUNTIME" --raw)

[[ "$SRC_SKILLS_ROOT" == /* ]] || { echo "error: SRC_SKILLS_ROOT is empty or not absolute: '$SRC_SKILLS_ROOT'" >&2; exit 1; }
[[ "$DEST_ROOT" == /* ]] || { echo "error: DEST_ROOT is empty or not absolute: '$DEST_ROOT'" >&2; exit 1; }

mkdir -p "$DEST_ROOT"

# #3025: verbatim cp -r copies the SOURCE runtime's converted skill form, which
# corrupts skills for destinations that need a different conversion (e.g. Claude
# SKILL.md → Codex TOML agent). Until the installer exposes a per-skill conversion
# CLI, sync is limited to runtime pairs that share the same skill format.
# Run `gsd install --<dest-runtime> --local` to get correctly converted skills
# for a destination that uses a different format.

for SKILL in $CREATE_LIST $UPDATE_LIST; do
  rm -rf "$DEST_ROOT/$SKILL"
  cp -r "$SRC_SKILLS_ROOT/$SKILL" "$DEST_ROOT/$SKILL"
done

for SKILL in $REMOVE_LIST; do
  rm -rf "$DEST_ROOT/$SKILL"
done
```

**Idempotency:** Running `--apply` a second time with no intervening changes must report zero changes (all entries are SKIP).

**Atomicity:** Each skill directory is replaced as a unit (remove then copy). Partial updates of individual files within a skill are not performed — the whole directory is replaced.

After executing all destinations:

```
Sync complete: <N> skills synced to <M> runtime(s).
```

---

## Safety Rules

1. **Only `gsd-*` directories** are created, updated, or removed. Any directory not starting with `gsd-` in a destination root is untouched.
2. **Dry-run is the default.** `--apply` must be passed explicitly to write anything.
3. **Source root must exist.** Never create the source root; it must have been created by a prior `gsd-update` or installer run.
4. **No cross-runtime content transformation.** Sync copies files verbatim. It does not apply runtime-specific content transformations (those happen at install time). If a runtime requires transformed content (e.g. Augment's format differs), the developer should run the installer for that runtime instead of using sync.

---

## Limitations

- Sync copies files verbatim and does not apply runtime-specific content transformations. Use the GSD installer directly for runtimes that require format conversion.
- Cross-project skills (`.agents/skills/`) are out of scope — this command only touches global runtime skills roots.
- Bidirectional sync is not supported. Choose one canonical source with `--from`.
