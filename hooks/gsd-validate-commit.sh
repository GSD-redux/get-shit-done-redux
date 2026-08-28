#!/usr/bin/env bash
# gsd-hook-version: {{GSD_VERSION}}
# gsd-validate-commit.sh — PreToolUse hook: enforce Conventional Commits format
# Blocks git commit commands with non-conforming messages (exit 2).
# Allows conforming messages and all non-commit commands (exit 0).
# Uses Node.js for JSON parsing (always available in GSD projects, no jq dependency).
#
# OPT-IN: This hook is a no-op unless config.json has hooks.community: true.
# Enable with: "hooks": { "community": true } in .planning/config.json

# Check opt-in config — exit silently if not enabled
if [ -f .planning/config.json ]; then
  ENABLED=$(node -e "try{const c=require('./.planning/config.json');process.stdout.write(c.hooks?.community===true?'1':'0')}catch{process.stdout.write('0')}" 2>/dev/null)
  if [ "$ENABLED" != "1" ]; then exit 0; fi
else
  exit 0
fi

INPUT=$(cat)

# Extract command from JSON using Node (handles escaping correctly, no jq needed)
CMD=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).tool_input?.command||'')}catch{}})" 2>/dev/null)

# Only check git commit commands.
# Delegates to hooks/lib/git-cmd.js isGitSubcommand() — the canonical token-walk
# classifier that handles env-prefix, -C path, and full-path git invocations.
# A naive `^git\s+commit` regex misses all three; this guard fixes that (#3129).
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
if GIT_CMD_LIB="$HOOK_DIR/lib/git-cmd.js" node -e "
  const {isGitSubcommand}=require(process.env.GIT_CMD_LIB);
  process.exit(isGitSubcommand(process.argv[1],'commit')?0:1);
" "$CMD" 2>/dev/null; then
  # Extract message from -m flag.
  #
  # MSG_QUOTE records WHICH arm matched. bash treats the two arms differently
  # and the subject step below depends on that difference — see the resolver
  # gate (review of #3816, round 4).
  MSG=""
  MSG_QUOTE=""
  if [[ "$CMD" =~ -m[[:space:]]+\"([^\"]+)\" ]]; then
    MSG="${BASH_REMATCH[1]}"
    MSG_QUOTE=dq
  elif [[ "$CMD" =~ -m[[:space:]]+\'([^\']+)\' ]]; then
    MSG="${BASH_REMATCH[1]}"
    MSG_QUOTE=sq
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
    if [ "$MSG_QUOTE" = dq ] && ! [[ "$CMD" =~ -m[[:space:]]+\"[^\"]+\"[^[:space:]] ]]; then
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
