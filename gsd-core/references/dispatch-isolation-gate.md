# Dispatch isolation gate (ADR-1239 / #2584)

The single source of truth for **how a dispatch site decides whether it may run an agent
isolated**. Every workflow that spawns an executor-like subagent reads this file and follows
it, rather than restating the rule inline (#2652).

`ISOLATION` — not `RUNTIME` — is the decision variable. **Never branch a dispatch site on a
runtime id.** Isolation is a negotiated capability declared per host; a runtime-name test
silently diverges the moment a new host declares support, which is exactly how #2652 happened:
`quick.md` and `diagnose-issues.md` kept a `RUNTIME != "claude"` gate after #2584 migrated the
phase scheduler, so Codex — which declares `orchestrator-worktree` — was refused isolation it
had in fact negotiated.

## Resolve ISOLATION

Run this in the dispatch site's config-gate step, right after `RUNTIME` / `USE_WORKTREES` are
read. It requires `gsd_run` to be defined (the standard shim preamble).

```bash
# Isolation is a NEGOTIATED CAPABILITY, not a runtime id (#2584). Fail-closed to none.
ISOLATION=$(gsd_run query dispatch-isolation --raw 2>/dev/null || echo "none")
case "$ISOLATION" in
  harness-worktree|orchestrator-worktree|none) ;;
  *) ISOLATION=none ;;
esac

# Project-level opt-out wins on every host; a host with no primitive fails closed.
[ "$USE_WORKTREES" = "false" ] && ISOLATION=none
if [ "$ISOLATION" = "none" ] && [ "$USE_WORKTREES" != "false" ]; then
  echo "FATAL: runtime '$RUNTIME' declares no executor-isolation primitive (dispatch.isolation=none) — agents would run unisolated against the main checkout. Set workflow.use_worktrees=false." >&2
  exit 1
fi
```

| `ISOLATION` | Meaning | What a dispatch site does |
|---|---|---|
| `harness-worktree` | The host's own harness creates and binds a worktree per agent. | Pass the host's declared `harnessFlag` on the dispatch. GSD runs no git. |
| `orchestrator-worktree` | No harness primitive, but a headless exec accepting a working directory. | GSD creates the worktree and process-spawns the agent into it. GSD performs every git operation. |
| `none` | No isolation primitive. | Run inline, sequentially. |

Fail-closed is the invariant: an undeclared, unknown, or unresolvable declaration degrades to
`none`, never to an unsafe parallel path.

## Resolve the harness flag (harness-worktree only)

The flag is descriptor data — never hardcode `isolation="worktree"`, which is Claude Code's
literal and wrong on any other harness-worktree host (Cursor declares the same capability).

```bash
HARNESS_FLAG=""
if [ "$ISOLATION" = "harness-worktree" ]; then
  HARNESS_FLAG=$(gsd_run query dispatch-isolation --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j&&j.harnessFlag?j.harnessFlag:"")}catch{process.stdout.write("")}})')
  [ -n "$HARNESS_FLAG" ] || { echo "FATAL: runtime declares dispatch.isolation=harness-worktree but no harnessIsolationFlag — refusing to dispatch an agent that would believe it is isolated." >&2; exit 1; }
fi
```

Substitute `$HARNESS_FLAG` for the `{harnessFlag}` placeholder in the dispatch call. On Claude
Code it resolves to literally `isolation="worktree"`.

## Single-agent dispatch sites

`quick.md` and `diagnose-issues.md` spawn through the host's own subagent tool, which can only
express the `harness-worktree` model. On an `orchestrator-worktree` host they must degrade to
sequential rather than pass a harness flag the host will ignore — dispatching unisolated while
reporting isolation is the one outcome worse than running sequentially:

```bash
if [ "$ISOLATION" = "orchestrator-worktree" ]; then
  echo "⚠ Runtime '$RUNTIME' declares dispatch.isolation=orchestrator-worktree, which requires GSD-driven process spawning. This dispatch site uses the host subagent tool, so it is running sequentially on the main working tree instead. Parallel wave execution (/gsd:execute-phase) is unaffected." >&2
  ISOLATION=none
  USE_WORKTREES=false
fi
```

Wave fan-out sites (`execute-phase`) implement both models — see
`gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md`.

## Base divergence

Any site that ends up with `ISOLATION != none` must also run the `worktree.base-check`
auto-degrade before dispatch (#683, #1369, #1941), or the agent's `worktree_branch_check` guard
halts on a stale fork base. `quick.md` and `execute-phase` do this today.
