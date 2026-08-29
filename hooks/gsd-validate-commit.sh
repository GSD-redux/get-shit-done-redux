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
  # Extract message from -m flag.
  #
  # MSG_QUOTE records WHICH arm matched. bash treats the two arms differently
  # and the subject step below depends on that difference — see the resolver
  # gate (review of #3816, round 4).
  MSG=""
  MSG_QUOTE=""
  MSG_MATCH=""
  if [[ "$CMD" =~ -m[[:space:]]+\"([^\"]+)\" ]]; then
    MSG="${BASH_REMATCH[1]}"
    MSG_QUOTE=dq
    MSG_MATCH="${BASH_REMATCH[0]}"
  elif [[ "$CMD" =~ -m[[:space:]]+\'([^\']+)\' ]]; then
    MSG="${BASH_REMATCH[1]}"
    MSG_QUOTE=sq
    MSG_MATCH="${BASH_REMATCH[0]}"
  fi

  if [ -n "$MSG" ]; then
    # Subject = first line of the message, EXCEPT for the command-substituted
    # heredoc form, where the first line is the opener rather than the message:
    #
    #     git commit -m "$(cat <<'EOF'
    #     feat(auth): add login flow
    #     EOF
    #     )"
    #
    # The capture above spans it whole, because bash `[^"]` matches newlines, so
    # `head -1` yielded the literal `$(cat <<'EOF'` and EVERY heredoc-form commit
    # was blocked regardless of its message (#3802).
    #
    # Selection of WHICH argument is the message is unchanged above — only the
    # subject-from-message step is delegated. Falls back to the previous `head -1`
    # if node or the library is unavailable, so a broken extractor degrades to the
    # old behavior instead of becoming a new silent-allow path.
    #
    # SINGLE-QUOTE GATE (review of #3816, round 4 — BLOCKER). The resolver may
    # only run on the DOUBLE-quoted arm. Inside `-m '...'` bash performs NO
    # command substitution, so `$(cat <<'EOF'` is literal text and git's real
    # subject is that opener line — resolving the body there validates a
    # message git never receives. Measured against the real hook, all four
    # spellings (`<<'E'`, `<<"E"`, `<<\E`, `<<E`) went base=2 -> head=0: a
    # net-new bypass reachable by the ordinary authoring slip of typing `'`
    # for `"`. The sq arm therefore keeps the pre-fix `head -1`, which is exact
    # base parity.
    #
    # ADJACENCY GUARD (review of #3816): text glued to the CLOSING quote —
    # `-m "$(cat <<'EOF' ... )"suffix` — is concatenated by bash into the SAME
    # argument, so the capture above holds only a PREFIX of the real message.
    # Resolving a heredoc from a prefix hands the length gate a fraction of the
    # real subject: a net-new bypass relative to base, which measured the
    # opener line and blocked. When the quote is not followed by whitespace or
    # the end of the command, skip the resolver and keep the pre-fix subject
    # (first captured line): the heredoc form then fails the format gate
    # exactly as it did on base, and the plain single-line form keeps base
    # behavior unchanged. The guard is tested against the arm that MATCHED,
    # not against both: testing both let a double-quoted heredoc whose BODY
    # mentions a glued single-quoted token (`-m "... -m 'foo'bar ..."`) trip
    # the sq arm and lose the fix for a message that never had a prefix
    # problem (review of #3816, round 4, Minor 1).
    # RESOLVER PRECONDITIONS. The resolver may run only where the captured text
    # is provably the subject git receives. Each guard names an input where it
    # is not; every refusal falls back to `head -1`, the pre-fix subject, which
    # fails the format gate exactly as this whole form did before the fix.
    RESOLVE=0
    if [ "$MSG_QUOTE" = dq ]; then
      RESOLVE=1
      # Text before the message we matched. The heredoc BODY always sits after
      # the match, so this window cannot be contaminated by message content —
      # which is what lets the two guards below scan for tokens that would also
      # be legal inside a commit message.
      MSG_PREFIX="${CMD%%"$MSG_MATCH"*}"
      # Text after it. Together, PREFIX and SUFFIX are the whole command MINUS
      # the message — the window a guard must use when the token it scans for
      # is also legal English inside a commit message, but may legally appear
      # on EITHER side of the message on the command line.
      MSG_SUFFIX="${CMD#*"$MSG_MATCH"}"

      # ADJACENCY GUARD (review of #3816): text glued to the CLOSING quote —
      # `-m "$(cat <<'EOF' ... )"suffix` — is concatenated by bash into the SAME
      # argument, so the capture holds only a PREFIX of the real message, and
      # the length gate would measure a fraction of the real subject.
      if [[ "$CMD" =~ -m[[:space:]]+\"[^\"]+\"[^[:space:]] ]]; then RESOLVE=0; fi

      # FIRST-MESSAGE GUARD (Codex review of #3816, round 4 — BLOCKER). The
      # capture is a SEARCH over the whole command and the double-quoted arm is
      # tried first, so it can select a `-m` that is not git's subject at all:
      #
      #   git commit -m 'WIP first' -m "$(cat <<'EOF'  -> git concatenates; the
      #   git commit -m WIP        -m "$(cat <<'EOF'      subject is `WIP first`
      #   git commit -m WIP --     -m "$(cat <<'EOF'  -> after --, not a message
      #   git commit -m WIP && echo -m "$(cat <<'EOF' -> belongs to `echo`
      #
      # All four measured base=2 -> head=0, with git recording the FIRST message
      # as the subject (verified against real commits, not the man page). The
      # mis-selection is pre-existing; resolving it is what turned it into an
      # enforcement bypass. Resolve only when nothing before the match could
      # have been an earlier message, an end-of-options marker, or another
      # command.
      if [[ "$MSG_PREFIX" =~ (^|[[:space:]])(-m|--message)([[:space:]]|=) ]] \
        || [[ "$MSG_PREFIX" =~ (^|[[:space:]])--([[:space:]]|$) ]] \
        || [[ "$MSG_PREFIX" =~ [\;\&\|] ]]; then RESOLVE=0; fi

      # CLEANUP-MODE GUARD (Codex review of #3816, round 4 — BLOCKER). The
      # resolver skips leading blank lines and strips trailing whitespace
      # because git's DEFAULT cleanup=whitespace does. Under
      # `--cleanup=verbatim` git does neither, so a 72-char subject plus three
      # trailing spaces is committed as a 75-byte subject while the hook
      # measured 72 — COMMIT_SUBJECT_TOO_LONG dodged (measured base=2 -> head=0;
      # confirmed by reading the raw commit object, since `git log --pretty=%s`
      # strips trailing whitespace in its own output and hides it).
      # Any named mode other than `whitespace` refuses. A mode set persistently
      # in git config is invisible here and stays a documented residual limit.
      # SCOPE (review of #3816, round 5 — BLOCKER). This scan must exclude the
      # message. `--cleanup=` and `commit.cleanup=` are ordinary English inside
      # a commit message — this repository's own hooks and docs discuss them
      # constantly — and the heredoc BODY sits verbatim inside $CMD, so
      # scanning $CMD refused to resolve any conforming message that merely
      # MENTIONED the token, blocking it with CONVENTIONAL_COMMITS_VIOLATION.
      # Scanning $MSG_PREFIX alone (the fix as first prescribed) would reopen
      # the bypass this guard exists for: git accepts the flag on either side
      # of -m, and `git commit -m "<heredoc>" --cleanup=verbatim` is caught
      # today only because the scan is command-wide. PREFIX + SUFFIX keeps both
      # positions covered while excluding the one span that is message text.
      # The two are joined with a space so a token cannot be forged across the
      # seam out of a prefix tail and a suffix head.
      if [[ "$MSG_PREFIX $MSG_SUFFIX" =~ (--cleanup|commit\.cleanup)[=[:space:]]+([^[:space:]]+) ]]; then
        if [ "${BASH_REMATCH[2]}" != "whitespace" ]; then RESOLVE=0; fi
      fi
    fi

    if [ "$RESOLVE" = 1 ]; then
      SUBJECT=$(GIT_CMD_LIB="$HOOK_DIR/lib/git-cmd.js" MSG="$MSG" node -e "
        const {resolveCommitSubject}=require(process.env.GIT_CMD_LIB);
        process.stdout.write(resolveCommitSubject(process.env.MSG));
      " 2>/dev/null) || SUBJECT=$(echo "$MSG" | head -1)
    else
      SUBJECT=$(echo "$MSG" | head -1)
    fi
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
