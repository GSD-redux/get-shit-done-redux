@~/.claude/gsd-core/references/response-language-directive.md

# sync-skills — Cross-Runtime GSD Skill Sync

**Command:** `/gsd-sync-skills`

Sync managed `gsd-*` skill directories from one canonical runtime's skills root to one or more destination runtime skills roots. Keeps multi-runtime installs aligned after a `gsd-update` on one runtime.

---

## Arguments

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--from <runtime>` | Yes | *(none)* | Source runtime — the canonical runtime to copy from |
| `--to <runtime\|all>` | Yes | *(none)* | Destination runtime or `all` supported runtimes. **Must equal `--from`** — cross-runtime sync is refused (#3025: skill content/layout is runtime-specific and produced by the installer's per-runtime converters; use the installer for a different runtime). |
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
  FROM_RUNTIME=$(echo "$@" | sed -E 's/.*--from[[:space:]]+([^[:space:]]+).*/\1/')
fi

# Parse --to
if [[ "$@" == *"--to all"* ]]; then
  TO_RUNTIMES=(antigravity augment claude cline codebuddy codex copilot cursor grok hermes kilo kimi kimi-code opencode pi qwen trae windsurf zcode)
elif [[ "$@" == *"--to"* ]]; then
  TO_RUNTIMES=( $(echo "$@" | sed -E 's/.*--to[[:space:]]+([^[:space:]]+).*/\1/') )
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
- If any `--to` destination differs from `--from` (cross-runtime): REFUSE with the installer pointer below and exit. sync only supports identity sync — see the guard.
- If `--from` or any `--to` value is not a runtime-id shape (`^[a-z0-9][a-z0-9-]*$`): REFUSE and exit — runtime ids are lowercase alphanumeric (+ hyphen); this rejects shell metacharacters before any interpolation (see security guard).

**#3025 — Runtime-id shape validation (security: run BEFORE any interpolation):**

`--from`/`--to` are interpolated into later `echo`/heredoc/`[[ ]]` contexts. Reject any value that is not a runtime-id shape BEFORE it reaches them, so a hostile value (e.g. `--to '$(cmd)'`, captured wholesale by the parser) cannot execute via command substitution in an error message.

```bash
# #3025 (security): runtime ids are lowercase alphanumeric (+ hyphen). Reject
# anything else BEFORE any echo/heredoc/[[ ]] so a hostile --from/--to value
# cannot execute via command substitution in a later error message.
is_runtime_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]]; }
if ! is_runtime_id "$FROM_RUNTIME"; then
  echo "error: invalid --from runtime id (not lowercase alphanumeric): '$FROM_RUNTIME'" >&2
  exit 1
fi
for DEST in "${TO_RUNTIMES[@]}"; do
  if ! is_runtime_id "$DEST"; then
    echo "error: invalid --to runtime id (not lowercase alphanumeric): '$DEST'" >&2
    exit 1
  fi
done
```

**#3025 — Cross-runtime refuse guard (run BEFORE Step 2 resolution / Step 5 copy):**

Skill content and directory layout are runtime-specific. The installer applies per-runtime
converters, adapter headers, brand swaps, and layout rules at install time, and two runtimes
(`grok`, `gemini`) resolve to ANOTHER runtime's skills root. A verbatim copy from one runtime's
skills root therefore produces content the installer would never have written for the destination,
and can damage a runtime the user never named. Every cross-runtime pair is unsafe (content and/or
layout and/or aliasing); only identity (`--from` == `--to`) is safe. Refuse cross-runtime and point
the user at the installer — the only path that produces correctly converted skills.

```bash
# #3025: refuse cross-runtime skill sync before any resolution or copy.
for DEST in "${TO_RUNTIMES[@]}"; do
  if [[ "$DEST" != "$FROM_RUNTIME" ]]; then
    cat >&2 <<EOF
error: cross-runtime skill sync is not supported (--from $FROM_RUNTIME --to $DEST).
       Skill content and directory layout are runtime-specific: the installer applies
       per-runtime converters, adapter headers, brand swaps, and layout rules that a
       verbatim copy cannot reproduce, and some runtimes share another runtime's skills
       root — so a cross-runtime sync can damage a runtime you did not name.
       To install correctly-converted skills for the '$DEST' runtime, run the GSD
       installer for that runtime (not sync):
         npx -y @opengsd/gsd-core@latest --global --<runtime>
       (grok and gemini have no dedicated installer flag — they alias the codex and
       claude skills roots respectively, which is itself why sync refuses them.)
       sync only supports identity sync, where --from and --to are the same runtime.
EOF
    exit 1
  fi
done
```

---

## Step 2: Resolve Skills Roots

Resolve paths via `gsd_run query skills-root` — this reuses the single authoritative path table via the shipped `gsd-tools` binary (#3024: the installer entry point is not shipped in installed trees, but `gsd-tools` is):

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
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

# #3025: cross-runtime sync is refused in Step 1's guard (skill content/layout is
# runtime-specific; a verbatim copy corrupts destinations and can alias another
# runtime's root). This loop is therefore reached only for IDENTITY sync, where
# every skill is SKIP (source == destination) and the create/update lists are
# empty. If per-runtime conversion is ever wired in, this is where it would go;
# until then the cp -r must never run for a destination != source.

# Rewrapped through unquoted command substitution (gsd-core#4109): a bare
# `$VAR` word-splits under bash but not zsh, collapsing every element onto
# one iteration there.
for SKILL in $(printf '%s' "$CREATE_LIST") $(printf '%s' "$UPDATE_LIST"); do
  rm -rf "$DEST_ROOT/$SKILL"
  cp -r "$SRC_SKILLS_ROOT/$SKILL" "$DEST_ROOT/$SKILL"
done

# Rewrapped through unquoted command substitution (gsd-core#4109): a bare
# `$VAR` word-splits under bash but not zsh, collapsing every element onto
# one iteration there.
for SKILL in $(printf '%s' "$REMOVE_LIST"); do
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

- Sync copies files verbatim and does not apply runtime-specific content transformations. **Cross-runtime sync is refused** (#3025): skill content and layout are runtime-specific, and some runtimes alias another runtime's skills root, so a verbatim cross-runtime copy corrupts the destination (and can damage a runtime you did not name). Only identity sync (`--from` == `--to`) is supported. To install skills for a different runtime, run the GSD installer for that runtime (`npx -y @opengsd/gsd-core@latest --global --<runtime>`).
- Cross-project skills (`.agents/skills/`) are out of scope — this command only touches global runtime skills roots.
- Bidirectional sync is not supported. Choose one canonical source with `--from`.
