# Worktree Path Safety

Guards for executor agents running inside Claude Code worktrees. The
supplied-root pin (step 0p) runs in EVERY mode; the remaining checks run before
any staging, Edit, or Write operation in worktree mode.

---

## Supplied-root pin — step 0p (#4254, EVERY mode)

Sequential-mode dispatch (no `isolation="worktree"`) gives the executor no
spawn-time cwd guarantee, and the worktree-only guards below do not apply — so
a sequential executor whose process cwd resolved to a different checkout of
the same repo would self-derive that checkout as its root and commit there,
silently. Step 0p closes that hole by comparing the executor's actual root
against a root the ORCHESTRATOR already validated — never against anything the
executor derives itself.

**Runtime contract (executor):** if your prompt contains a `<project_root_pin>`
block, run its guard script verbatim before your first Edit/Write and again
before every commit, in the same cwd as that write or commit. On FATAL, halt
and report — recovery (moving commits between checkouts) is an
orchestrator/human decision, never agent self-repair. If your prompt contains
NO `<project_root_pin>` block (worktree/isolated dispatch, or a legacy
orchestrator), emit one warning line and continue with steps 0a/0b below — do
not fail closed on dispatches that never carried a pin. **Never bind
`{PINNED_ROOT}` yourself**: if this template reaches you unbound it is
reference prose, not your pin — only the orchestrator's build-time
substitution produces a valid guard.

**Composition contract (orchestrator — build time, NOT a sub-agent runtime
step):** copy the guard below into the dispatched prompt inside a
`<project_root_pin>` block, substituting `{PINNED_ROOT}` with the literal value
of `$ORCHESTRATOR_WT` captured at execute_waves entry, shell-single-quoted:
wrap the path in `'…'` and escape any embedded `'` as `'\''`. A path that
cannot be quoted this way must halt the phase (surface a blocker) rather than
ship a pin that could mis-parse. The comparison is git-vs-git on BOTH sides —
`git -C` resolves the pinned path to its repo's canonical toplevel in git's
own path representation, so symlink aliases, trailing slashes, `/var` vs
`/private/var` spellings, and Windows drive-letter forms — forward- or
backslash-separated, `RUNNER~1`-style short names included — compare equal by
construction (shell `pwd -P` normalization does NOT match git's emission on
Windows — do not re-introduce it).

Two portability rules baked into the guard below, learned from the #4254 CI
Windows legs: (1) a backslash comparator must be GENERATED at runtime
(`printf '\134'`), because a backslash written twice in the script text does
not survive the Windows command-line round-trip into bash — the doubled form
arrives halved, which silently rewrites any escape pattern that relies on it;
(2) every FATAL names its `Guard stage` and, where a git capture failed,
git's own stderr in a `Diagnostic` line, so a platform failure self-describes
instead of surfacing as a bare `Actual root: <none>`.

```bash
# gsd:guard=supplied-root-pin (#4254) — run before the first Edit/Write and before every commit.
PINNED_ROOT='{PINNED_ROOT}'  # orchestrator build-time substitution — the only valid source of this value
PIN_STAGE=''
PIN_DIAG=''
gsd_pin_fail() {
  echo "FATAL: executor root does not match the orchestrator-supplied PROJECT_ROOT pin (#4254)." >&2
  echo "  Pinned root: ${PINNED_ROOT:-<empty or unexpanded>}" >&2
  echo "  Actual root: ${ACTUAL_ROOT:-<none>}" >&2
  echo "  Guard stage: ${PIN_STAGE:-<unset>}" >&2
  if [ -n "$PIN_DIAG" ]; then echo "  Diagnostic: $PIN_DIAG" >&2; fi
  echo "  No writes or commits are permitted from this checkout. HALT and report; recovery is an" >&2
  echo "  orchestrator/human decision. Only the IMMEDIATE submodule of the pinned checkout is a" >&2
  echo "  legitimate other cwd — nested submodules must surface as a blocker, not self-route." >&2
  exit 1
}
# Backslash comparator, generated at runtime: a backslash written twice in this
# script does not survive the Windows spawn path into bash (the command-line
# round-trip halves the doubled form), which rejected every C:\ pin at the form
# gate on the #4254 CI Windows legs. printf's octal escape is a lone backslash,
# which does survive; the quoted expansion below is literal in a case pattern.
BS=$(printf '\134')
# Fail closed if the comparator could not be generated: an empty BS would widen
# the drive-form arm below to drive-RELATIVE pins (C:foo) — the one fail-open
# seam in this construction, closed loudly rather than trusted to the shell.
if [ -z "$BS" ]; then
  PIN_STAGE=form-gate
  PIN_DIAG='backslash comparator generation failed (printf octal escape returned empty)'
  gsd_pin_fail
fi
case "$PINNED_ROOT" in
  ''|'{PINNED_ROOT}') PIN_STAGE=pin-unbound; gsd_pin_fail ;;  # empty or unexpanded pin — fail closed, never warn-and-proceed
  /*) ;;                                                     # absolute POSIX form
  [A-Za-z]:/*|[A-Za-z]:"$BS"*) ;;                            # Windows drive form, forward- or backslash-separated
  *) PIN_STAGE=form-gate; gsd_pin_fail ;;                    # relative pin — never trustworthy across cwds
esac
ACTUAL_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$ACTUAL_ROOT" ]; then
  PIN_STAGE=actual-capture
  PIN_DIAG="git rev-parse --show-toplevel from the cwd failed: $(git rev-parse --show-toplevel 2>&1 1>/dev/null)"
  gsd_pin_fail
fi
PINNED_TL=$(git -C "$PINNED_ROOT" rev-parse --show-toplevel 2>/dev/null)
if [ -z "$PINNED_TL" ]; then
  PIN_STAGE=pinned-capture
  PIN_DIAG="git -C <pinned root> rev-parse --show-toplevel failed: $(git -C "$PINNED_ROOT" rev-parse --show-toplevel 2>&1 1>/dev/null)"
  gsd_pin_fail
fi
if [ "$ACTUAL_ROOT" != "$PINNED_TL" ]; then
  # Registered-submodule allowance: sub_repos plans legitimately commit inside an
  # immediate submodule of the pinned checkout. The superproject working tree is
  # git-emitted in the same representation as PINNED_TL, so the equality is
  # representation-safe on every platform.
  SUPER_TL=$(git rev-parse --show-superproject-working-tree 2>/dev/null)
  if [ "$SUPER_TL" != "$PINNED_TL" ]; then
    PIN_STAGE=root-mismatch
    PIN_DIAG="actual=${ACTUAL_ROOT} pinned=${PINNED_TL} superproject=${SUPER_TL:-<none>}"
    gsd_pin_fail
  fi
fi
```

---

## Worktree branch check (run once at spawn-time)

The spawn-time HEAD/base guard now lives in the canonical fragment
`gsd-core/references/worktree-branch-check.md`, which the orchestrator embeds directly
into your prompt at dispatch. Run that block FIRST, before any reset/checkout or staging.
If your prompt contains a `<worktree_branch_check>` embed instruction rather than the block itself, complete that read-and-embed step before any reset/checkout or staging.

---

## cwd-drift sentinel — step 0a (#3097)

A prior Bash call may have `cd`'d out of the worktree into the main repo. When
that happens `[ -f .git ]` is false (main repo's `.git` is a directory), silently
skipping all worktree guards. The sentinel captures the spawn-time toplevel and
detects drift before every commit.

```bash
if [ -f .git ]; then  # we are in a worktree
  WT_GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
  case "$WT_GIT_DIR" in
    *.git/worktrees/*)
      SENTINEL="$WT_GIT_DIR/gsd-spawn-toplevel"
      [ ! -f "$SENTINEL" ] && git rev-parse --show-toplevel > "$SENTINEL" 2>/dev/null
      EXPECTED_TL=$(cat "$SENTINEL" 2>/dev/null)
      ACTUAL_TL=$(git rev-parse --show-toplevel 2>/dev/null)
      if [ -n "$EXPECTED_TL" ] && [ "$ACTUAL_TL" != "$EXPECTED_TL" ]; then
        echo "FATAL: cwd drifted from spawn-time worktree root (#3097)" >&2
        echo "  Spawn-time: $EXPECTED_TL" >&2
        echo "  Current:    $ACTUAL_TL" >&2
        echo "RECOVERY: cd \"$EXPECTED_TL\" before staging, then re-run this commit." >&2
        exit 1
      fi
      ;;
  esac
fi
```

---

## Absolute-path guard — step 0b (#3099)

Edit/Write calls using absolute paths constructed from the **orchestrator's** `pwd`
(main repo root) will resolve to the main repo, not the worktree. Writes land in
the wrong directory; `git commit` from the worktree sees a clean tree and the work
is silently lost.

Before any Edit or Write using an absolute path:

```bash
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
# Fail fast if ABS_PATH resolves outside the worktree
if [[ "$ABS_PATH" != "$WT_ROOT"* ]]; then
  echo "WARNING: $ABS_PATH is outside the worktree ($WT_ROOT)" >&2
  echo "Use a relative path or recompute the absolute path from WT_ROOT." >&2
fi
```

**Prefer relative paths** for all Edit/Write operations. When an absolute path is
unavoidable, always derive it from `git rev-parse --show-toplevel` run inside the
worktree — never from `pwd` captured in the orchestrator context.
