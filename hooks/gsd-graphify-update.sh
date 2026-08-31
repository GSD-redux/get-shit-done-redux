#!/usr/bin/env bash
# gsd-hook-version: {{GSD_VERSION}}
# gsd-graphify-update.sh — PostToolUse hook (Bash matcher) that auto-rebuilds
# the project knowledge graph after main HEAD advances on the default branch.
#
# OPT-IN (issue #3347 AC): no-op unless .planning/config.json has BOTH
#   graphify.enabled: true
#   graphify.auto_update: true
# graphify.auto_update defaults to false so existing users see no behavior change.
#
# Gates (in fast-fail order — each shaves work off the common non-dispatch path):
#   0. .planning/config.json exists AND $CI unset/empty (#3729 — both are
#      parse-free shell tests; running them before the Gate 1 node spawn keeps
#      non-GSD repositories and CI off the spawn path entirely, which on
#      Windows otherwise flashes a console window per Bash call)
#   1. Stdin payload present and tool_name == "Bash"
#   2. tool_input.command matches a HEAD-advancing git op (shell-direct or
#      the exact `gsd-tools query commit` command shape; the SDK command invokes
#      git internally, so the literal "git commit" substring never appears —
#      see #3653)
#   3. Inside a git repo
#   4. Current branch == default branch (git.base_branch override, else main/master/trunk)
#   5. .planning/config.json sets graphify.enabled=true AND graphify.auto_update=true
#   6. graphify binary on PATH
#   7. No rebuild already in flight (PID lock — kill -0 check, stale-tolerant)
#
# When all gates pass:
#   - Writes .planning/graphs/.last-build-status.json with status="running"
#   - Detaches hooks/lib/gsd-graphify-rebuild.sh which copies graphify-out/* to
#     .planning/graphs/ and rewrites the status file with status="ok"|"failed"
#
# Returns 0 in all cases. Never blocks the user-facing tool call.

set -uo pipefail

# Gate 0 — GSD project at all, and not CI (#3729). Both are pure shell tests;
# they must precede the Gate 1 node spawn so the common non-GSD/CI path pays
# for zero child processes. Hoisting is behavior-preserving: old Gates 3 and 6
# made the same decisions, just later.
[ -f .planning/config.json ] || exit 0
[ -z "${CI:-}" ] || exit 0

# Gate 1 — tool_name == Bash; extract command
INPUT=$(cat 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

TOOL_INFO=$(printf '%s' "$INPUT" | node -e '
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  try {
    const p = JSON.parse(d);
    process.stdout.write((p.tool_name || "") + "\n" + (p.tool_input?.command || ""));
  } catch { process.stdout.write("\n"); }
});
' 2>/dev/null || printf '\n')
TOOL_NAME=$(printf '%s\n' "$TOOL_INFO" | sed -n '1p')
# Capture the FULL command (line 2 through EOF). Agent runtimes routinely emit
# HEAD-advancing commits as multi-line scripts (`cd /path` then `git add` then
# `git commit …`); reading only line 2 (`sed -n '2p'`) missed a `git commit`
# that was not on the first command line and silently no-op'd the rebuild
# (#1772). Line 2..EOF preserves embedded newlines; the `case` glob below
# matches the substring anywhere in the multi-line string.
COMMAND=$(printf '%s\n' "$TOOL_INFO" | sed -n '2,$p')

# #2304: Kimi CLI registers this hook with matcher 'Shell' and forwards its
# own tool vocabulary (tool_name 'Shell', possibly module-qualified as
# kimi_cli.tools.shell:Shell). kimi-cli's Shell.Params names its field
# `command` (src/kimi_cli/tools/shell/__init__.py), same as Claude's Bash,
# so only the tool name needs normalization — the shell counterpart of the
# KIMI_TOOL_NAMES map inlined in the JS guards.
TOOL_NAME="${TOOL_NAME##*:}"
if [ "$TOOL_NAME" = "Shell" ]; then TOOL_NAME="Bash"; fi

[ "$TOOL_NAME" = "Bash" ] || exit 0

# Gate 2 — HEAD-advancing git op (shell-direct or exact `gsd-tools query commit`)
case "$COMMAND" in
  *"git commit"*|*"git merge"*|*"git pull"*|*"git rebase --continue"*|*"git cherry-pick"*) ;;
  *"gsd-tools query commit"|*"gsd-tools query commit "*) ;;
  *) exit 0 ;;
esac

# Gate 3 — inside git repo
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Gate 4 — current branch == default branch (config guaranteed by Gate 0)
DEFAULT_BRANCH=""
DEFAULT_BRANCH=$(node -e '
try {
  const c = require("./.planning/config.json");
  process.stdout.write(c.git?.base_branch || "");
} catch { process.stdout.write(""); }
' 2>/dev/null || echo "")
if [ -z "$DEFAULT_BRANCH" ]; then
  for cand in main master trunk; do
    if git rev-parse --verify "$cand" >/dev/null 2>&1; then
      DEFAULT_BRANCH="$cand"
      break
    fi
  done
fi
[ -n "$DEFAULT_BRANCH" ] || exit 0

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
[ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] || exit 0

# Gate 5 — both graphify gates true in config (file existence checked at Gate 0)
GATES=$(node -e '
try {
  const c = require("./.planning/config.json");
  const ok = c.graphify?.enabled === true && c.graphify?.auto_update === true;
  process.stdout.write(ok ? "1" : "0");
} catch { process.stdout.write("0"); }
' 2>/dev/null || echo "0")
[ "$GATES" = "1" ] || exit 0

# Gate 6 — graphify on PATH
GRAPHIFY_BIN=$(command -v graphify 2>/dev/null || true)
[ -n "$GRAPHIFY_BIN" ] || exit 0

# Gate 7 — no live rebuild in flight
mkdir -p .planning/graphs
LOCK_FILE=".planning/graphs/.rebuild.lock"
if [ -f "$LOCK_FILE" ]; then
  PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
fi

# All gates passed. Write initial running status synchronously so observers
# (the next planner load_graph_context step) see the in-flight signal.
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
STATUS_FILE=".planning/graphs/.last-build-status.json"
TS_START=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
MS_START=$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo "0")

GSD_TS="$TS_START" \
GSD_HEAD="$HEAD_SHA" \
GSD_STATUS_FILE="$STATUS_FILE" \
node -e '
  const fs = require("node:fs");
  const status = {
    ts: process.env.GSD_TS,
    status: "running",
    exit_code: null,
    duration_ms: null,
    head_at_build: process.env.GSD_HEAD,
    graphify_version: null,
  };
  fs.writeFileSync(process.env.GSD_STATUS_FILE, JSON.stringify(status, null, 2) + "\n");
' 2>/dev/null || true

# Resolve rebuild helper script (sibling-relative for portability across install layouts)
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
REBUILD_SCRIPT="$HOOK_DIR/lib/gsd-graphify-rebuild.sh"
[ -f "$REBUILD_SCRIPT" ] || exit 0

# Detach the rebuild. Spawn as a regular background job so we can capture
# its PID via $! and write it to the lock file synchronously here in the
# parent. This eliminates a startup race where a caller (e.g. test cleanup)
# observing an absent lock could not distinguish "subprocess finished" from
# "subprocess hasn't started yet." With the lock written before this hook
# returns, lock-presence is a reliable in-flight signal.
bash "$REBUILD_SCRIPT" \
  "$STATUS_FILE" \
  "$LOCK_FILE" \
  "$HEAD_SHA" \
  "$MS_START" \
  "$GRAPHIFY_BIN" \
  </dev/null >/dev/null 2>&1 &
REBUILD_PID=$!
echo "$REBUILD_PID" > "$LOCK_FILE"
disown "$REBUILD_PID" 2>/dev/null || true

exit 0
