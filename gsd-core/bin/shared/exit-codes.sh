#!/bin/sh
# GENERATED FILE — DO NOT EDIT BY HAND.
# Source of truth: gsd-core/bin/shared/exit-codes.json. Regenerate with:
#   node scripts/gen-exit-code-registry.cjs --write
#
# One `export EXIT_<NAME>=<code>` per gsd-core/bin/shared/exit-codes.json
# entry (ADR-3889 §2, #3905/#3906/#3908). POSIX sh, safe under `set -u`:
# sourcing this file only ever ASSIGNS variables, never reads one, so it
# cannot trip an unset-variable check regardless of the caller's existing
# environment.
#
# Usage (from a scanner under scripts/):
#   . "$(dirname "$0")/../gsd-core/bin/shared/exit-codes.sh"
#   exit "$EXIT_UNAVAILABLE"
export EXIT_HOOK_DENY=2
export EXIT_USAGE=64
export EXIT_NO_INPUT=66
export EXIT_UNAVAILABLE=69
export EXIT_INTERNAL=70
export EXIT_DEGRADED=80
