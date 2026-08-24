#!/bin/sh
# gsd-node-runner.sh — GSD portable node resolver (#3662).
#
# Managed JS hook commands under --portable-hooks route through this script:
#
#   bash "<hooks>/gsd-node-runner.sh" "<baked-node-path>" "<script.js>" [args...]
#
# so a config root shared across environments (mounted ~/.claude, shared
# containers) resolves node at hook-fire time instead of depending on the
# absolute path of whichever environment ran the installer. Candidates, in
# order — the first executable one wins:
#
#   1. the first argument — the install-time node path, tried FIRST and by
#      absolute path so the #2979/#3002/#3017/#3022 minimal-PATH guarantee
#      holds (GUI launches with a stripped PATH still resolve where the
#      baked path exists);
#   2. `command -v node`, accepted only when it yields an absolute path;
#   3. the well-known stable layouts: $HOME-derived mise/volta shims, the
#      Homebrew prefixes, /usr/local/bin/node, /usr/bin/node.
#
# No bare `node` lookup is ever depended on: a candidate is used only after
# an explicit executable check, and when nothing resolves this script fails
# visibly (stderr diagnostic + exit 127) rather than emitting a half-resolved
# invocation.
#
# The candidate list below is a SUPERSET of the inline chain token emitted by
# buildNodeRunnerChainToken (src/runtime-hooks-surface.cts, #3662) — keep the
# two lists consistent.
#
# Diagnostic escape: GSD_NODE_RUNNER_NO_FALLBACKS=1 disables candidates 2-3
# (first-argument-only resolution) — used by the test suite and useful to
# pin down which node a given environment picks.
set -u

preferred=${1:-}
script=${2:-}
if [ -n "$script" ]; then
  shift 2
elif [ -n "$preferred" ]; then
  shift 1
  preferred=
fi

found=''

# check <path> — record <path> if it is an absolute, executable file.
# Absolute = POSIX root (/*) or a win32 drive-letter path (C:/…), which is
# what the installer bakes on Windows; anything else (a relative `command -v`
# hit under a relative PATH entry, a bare name) is rejected so repo-cwd
# content can never reach the runner slot.
check() {
  case "$1" in
    /*|[A-Za-z]:/*) if [ -x "$1" ]; then found=$1; fi ;;
  esac
  [ -n "$found" ]
}

check "$preferred" || {
  if [ "${GSD_NODE_RUNNER_NO_FALLBACKS:-0}" != "1" ]; then
    path_node=$(command -v node 2>/dev/null || true)
    check "$path_node" ||
      check "${HOME:-}/.local/share/mise/shims/node" ||
      check "${HOME:-}/.volta/bin/node" ||
      check /opt/homebrew/bin/node ||
      check /usr/local/bin/node ||
      check /usr/bin/node ||
      true
  fi
}

if [ -z "$found" ]; then
  echo "gsd-node-runner: no usable node found (preferred: ${preferred:-<none>})" >&2
  exit 127
fi

exec "$found" "$script" "$@"
