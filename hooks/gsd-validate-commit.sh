#!/usr/bin/env bash
# gsd-hook-version: {{GSD_VERSION}}
# gsd-validate-commit.sh — PreToolUse hook: enforce Conventional Commits format
# Blocks git commit commands with non-conforming messages (exit 2).
# Allows conforming messages and all non-commit commands (exit 0).
# Uses Node.js for JSON parsing (always available in GSD projects, no jq dependency).
#
# OPT-IN: This hook is a no-op unless config.json has hooks.community: true.
# Enable with: "hooks": { "community": true } in .planning/config.json
set -euo pipefail

# Temp files created below for subprocess stderr capture (config read, command
# extraction, classifier). A single EXIT trap replaces three hand-rolled
# mktemp/rm-f pairs so an early or unexpected exit path can never leak one —
# and a future fourth check does not need its own copy (#3911 review).
# Idempotent and failure-proof by construction: unset vars expand to "" (a
# no-op rm -f target), and `|| true` guarantees the trap itself never changes
# the script's exit status.
ENABLED_ERR=""
CMD_ERR=""
CLASSIFY_ERR=""
cleanup_temp_files() {
  rm -f "${ENABLED_ERR:-}" "${CMD_ERR:-}" "${CLASSIFY_ERR:-}" 2>/dev/null || true
}
trap cleanup_temp_files EXIT

# Check opt-in config — exit silently if not enabled
if [ -f .planning/config.json ]; then
  ENABLED_ERR=$(mktemp)
  ENABLED=$(node -e "
    try{
      const c=require('./.planning/config.json');
      process.stdout.write(c.hooks?.community===true?'1':'0');
    }catch(e){
      process.stderr.write('CONFIG_READ_FAILED: '+(e&&e.message?e.message:String(e)));
      process.exit(3);
    }
  " 2>"$ENABLED_ERR") || CONFIG_STATUS=$?
  CONFIG_STATUS=${CONFIG_STATUS:-0}
  if [ "$CONFIG_STATUS" != "0" ]; then
    # Could not determine the opt-in flag at all (node missing, JSON parse
    # error other than absence, etc.) — distinct from ".planning/config.json
    # exists and legitimately disables the hook". Say so and pass, per #3838.
    echo "gsd-validate-commit.sh: could not read .planning/config.json (opt-in check) — validator disabled for this call. $(cat "$ENABLED_ERR")" >&2
    exit 0
  fi
  if [ "$ENABLED" != "1" ]; then exit 0; fi
else
  exit 0
fi

INPUT=$(cat)

# Extract command from JSON using Node (handles escaping correctly, no jq needed)
CMD_ERR=$(mktemp)
CMD=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try{
      process.stdout.write(JSON.parse(d).tool_input?.command||'');
    }catch(e){
      process.stderr.write('COMMAND_EXTRACTION_FAILED: '+(e&&e.message?e.message:String(e)));
      process.exit(3);
    }
  });
" 2>"$CMD_ERR") || CMD_STATUS=$?
CMD_STATUS=${CMD_STATUS:-0}
if [ "$CMD_STATUS" != "0" ]; then
  # Could not extract tool_input.command at all (node missing, malformed
  # JSON, etc.) — distinct from "there is genuinely no command field". Say
  # so and pass, per #3838.
  echo "gsd-validate-commit.sh: could not extract tool_input.command from the hook payload — validator disabled for this call. $(cat "$CMD_ERR")" >&2
  exit 0
fi

# Only check git commit commands.
# Delegates to hooks/lib/git-cmd.js isGitSubcommand() — the canonical token-walk
# classifier that handles env-prefix, -C path, and full-path git invocations.
# A naive `^git\s+commit` regex misses all three; this guard fixes that (#3129).
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
CLASSIFY_ERR=$(mktemp)
GIT_CMD_LIB="$HOOK_DIR/lib/git-cmd.js" node -e "
  try {
    const {isGitSubcommand}=require(process.env.GIT_CMD_LIB);
    process.exit(isGitSubcommand(process.argv[1],'commit')?0:1);
  } catch(e) {
    process.stderr.write('CLASSIFIER_THREW: '+(e&&e.message?e.message:String(e)));
    process.exit(3);
  }
" "$CMD" 2>"$CLASSIFY_ERR" || CLASSIFY_STATUS=$?
CLASSIFY_STATUS=${CLASSIFY_STATUS:-0}
if [ "$CLASSIFY_STATUS" != "0" ] && [ "$CLASSIFY_STATUS" != "1" ]; then
  # 0 = is a git commit (validate below); 1 = genuinely not a git commit
  # (real negative, pass silently) — the ONLY intentional non-zero exit the
  # script above ever produces on success. Any other status — 127 node
  # missing, or 3 from the try/catch above when the git-cmd.js require chain
  # throws (e.g. its built dependency, gsd-core/bin/lib/token-scanner.cjs, is
  # a gitignored build artifact and absent on a fresh checkout — run
  # `npm run build:lib`) — means the classifier could not run at all. Say so
  # on stderr and pass (#3838): PreToolUse stderr does not disturb the JSON
  # protocol.
  echo "gsd-validate-commit.sh: could not classify the command via hooks/lib/git-cmd.js (exit $CLASSIFY_STATUS) — validator disabled for this call. If this persists, run \`npm run build:lib\`. $(cat "$CLASSIFY_ERR")" >&2
  exit 0
fi
if [ "$CLASSIFY_STATUS" = "0" ]; then
  # Extract message from -m flag
  MSG=""
  if [[ "$CMD" =~ -m[[:space:]]+\"([^\"]+)\" ]]; then
    MSG="${BASH_REMATCH[1]}"
  elif [[ "$CMD" =~ -m[[:space:]]+\'([^\']+)\' ]]; then
    MSG="${BASH_REMATCH[1]}"
  fi

  if [ -n "$MSG" ]; then
    SUBJECT=$(echo "$MSG" | head -1)
    # Validate Conventional Commits format
    if ! [[ "$SUBJECT" =~ ^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+\))?:[[:space:]].+ ]]; then
      # Emit a typed `code` field alongside `reason` (#2974). Tests assert
      # on the stable code string; the reason is the human-readable copy.
      echo '{"decision": "block", "code": "CONVENTIONAL_COMMITS_VIOLATION", "reason": "Commit message must follow Conventional Commits: <type>(<scope>): <subject>. Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore. Subject must be <=72 chars, lowercase, imperative mood, no trailing period."}'
      exit 2
    fi
    if [ ${#SUBJECT} -gt 72 ]; then
      echo '{"decision": "block", "code": "COMMIT_SUBJECT_TOO_LONG", "reason": "Commit subject must be 72 characters or less."}'
      exit 2
    fi
  fi
fi

exit 0
