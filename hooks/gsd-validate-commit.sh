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
      # LINE CONTINUATIONS ARE NOT SEPARATORS (review of #3816, rounds 8 and 9).
      # `git commit \` newline `  -m "$(cat <<'EOF' …` is an ordinary way to
      # spread an invocation over lines, and every guard below reads a newline in
      # a window as a command separator, so the whole form was refused. That was
      # disclosed as a fail-closed limit in round 8 because "is this newline a
      # continuation" looked like the segmentation question this file has
      # reverted twice. It is not: bash's rule is local and character-level. A
      # newline preceded by an ODD run of backslashes is a continuation and bash
      # removes both; an EVEN run (`\\` then newline) is a literal backslash
      # followed by a real newline, which IS a separator. So the windows are
      # joined the way bash joins them, in three bash-3.2-safe steps: every `\\`
      # pair is parked on \x01, a byte no real command line carries, any
      # backslash-newline that remains is a lone (odd) one and is removed, then
      # the pairs are restored. Applied to BOTH windows, BEFORE the dequote
      # copies are derived, so every scan sees the joined text.
      #
      # KNOWN OVER-BLOCK, fail-closed: a literal \x01 that IS present in the
      # command is restored as `\\`, so an option-shaped token carrying one
      # (`-\x01m`) reads as `-\\m`, dequotes to `-m`, and refuses where it did
      # not before (independent review, round 9). Refusing is the recoverable
      # direction; a control byte in an option name is not a spelling anyone
      # types, and it is not a hole in the accept direction.
      #
      # Direction check: a continuation glued to the closing quote
      # (`"$(…)"\` newline `suffix`) joins to `"$(…)"suffix`, which the glue
      # guard refuses exactly as bash would have glued it; `\\` + newline keeps
      # its newline and is still refused by the separator guard. Measured on
      # bash 3.2.57 and 5.3.15 in tests/hooks-opt-in.test.cjs.
      CONT_PARK=$'\x01'
      MSG_PREFIX="${MSG_PREFIX//\\\\/$CONT_PARK}"
      MSG_PREFIX="${MSG_PREFIX//\\$'\n'/}"
      MSG_PREFIX="${MSG_PREFIX//$CONT_PARK/\\\\}"
      MSG_SUFFIX="${MSG_SUFFIX//\\\\/$CONT_PARK}"
      MSG_SUFFIX="${MSG_SUFFIX//\\$'\n'/}"
      MSG_SUFFIX="${MSG_SUFFIX//$CONT_PARK/\\\\}"

      # QUOTE-SPLICED SPELLINGS (independent review of #3816, round 6). Bash
      # removes quotes before git ever sees an argument, so the same option has
      # unboundedly many spellings on the command line: `--clean""up=verbatim`
      # IS `--cleanup=verbatim` to git, and `-""m` IS `-m`. Both matched no
      # literal and were measured ACCEPTING a 75-byte subject the length gate
      # had recorded as 72. The guards below therefore scan a copy of their
      # window with quote characters removed, which is what bash does to it.
      # Only the two OPTION-NAME scans use it; the adjacency test deliberately
      # does not, because it asks about a literal character position, and the
      # message span itself is excluded from both windows either way.
      MSG_PREFIX_DEQ="${MSG_PREFIX//[\"\']/}"
      MSG_SUFFIX_DEQ="${MSG_SUFFIX//[\"\']/}"
      # BACKSLASH-SPLICED SPELLINGS (independent review of #3816, round 7).
      # Quote removal alone was not "the command as bash hands it to git": bash
      # also removes syntactic backslashes, so `-\m WIP` IS `-m WIP` and
      # `--clean\up=verbatim` IS `--cleanup=verbatim` to git, and both matched
      # no literal. Measured: `-\m WIP -m <conforming heredoc>` accepted the
      # heredoc while git recorded `WIP`, and a trailing `--clean\up=verbatim`
      # accepted a 75-byte subject the length gate measured as 72. Stripped in a
      # second pass so the class is unambiguous.
      MSG_PREFIX_DEQ="${MSG_PREFIX_DEQ//\\/}"
      MSG_SUFFIX_DEQ="${MSG_SUFFIX_DEQ//\\/}"
      # DOLLAR-QUOTED SPELLINGS (independent review of #3816, round 8). The two
      # passes above still were not "the command as bash hands it to git": bash
      # has TWO more quoting forms whose introducer is a `$`, and removing the
      # quote characters alone leaves that `$` stranded in the middle of the
      # option name. `-$"m"` became `-$m` here while bash passes a real `-m` to
      # git, and `--mes$'sage'=WIP` became `--mes$sage=WIP`; neither matched any
      # literal, so the first-message guard below never fired. Measured on bash
      # 3.2.57 and 5.3.15 against a real repository: the hook allowed
      # `-$"m" WIP -m <conforming heredoc>` (exit 0) while `git cat-file -p`
      # recorded the subject `WIP` — the same command spelled `-m WIP` is
      # refused (exit 2). Stripping `$` closes both dollar-quote forms.
      #
      # RESIDUAL, and not fixable from a string: an option name assembled by an
      # EXPANSION — `-${x}m`, `-$(printf m)` — is not knowable without running
      # the command, the same limit this file already documents for expanded
      # heredoc bodies. Stripping `$` makes those spellings collapse toward the
      # literal too, which over-matches, and over-matching only refuses more.
      MSG_PREFIX_DEQ="${MSG_PREFIX_DEQ//\$/}"
      MSG_SUFFIX_DEQ="${MSG_SUFFIX_DEQ//\$/}"

      # ADJACENCY GUARD (review of #3816): text glued to the CLOSING quote —
      # `-m "$(cat <<'EOF' ... )"suffix` — is concatenated by bash into the SAME
      # argument, so the capture holds only a PREFIX of the real message, and
      # the length gate would measure a fraction of the real subject.
      # SCOPE (review of #3816, round 6 — MAJOR). Glue is a property of the ONE
      # character following the MATCHED span, so that character is the whole
      # window. Scanning $CMD for the shape anywhere refused any conforming
      # commit whose command merely CONTAINED a glued `-m` elsewhere —
      # `git commit -m "<heredoc>" && echo -m "test"z` stayed blocked with
      # CONVENTIONAL_COMMITS_VIOLATION. Base blocks it too, because base blocks
      # EVERY heredoc form (that is #3802): this was the fix not reaching the
      # shape, measured base=2 -> pre=2 -> post=0, not a regression.
      # The separators and redirections are excluded because bash does NOT
      # concatenate across them: in `-m "msg"&& echo hi` the argument ends at
      # the quote, so there is no truncated capture to defend against.
      # The class is held in a VARIABLE, not written inline. Inline, every
      # member needs a backslash to get past the `[[ ]]` parser (`;`, `&` and
      # `|` are metacharacters there) — and on bash 3.2, the system /bin/bash on
      # macOS, those backslashes are passed THROUGH to the regex engine instead
      # of being consumed by the shell, silently adding a literal `\` to the
      # class. Unquoted expansion of a variable on the right of `=~` is the one
      # spelling that is a plain regex on 3.2 and 5.x alike (review of #3816,
      # round 8). Writing `[^[:space:];&|()<>]` inline is NOT the fix: it is a
      # bash syntax error on both versions.
      GLUE_CLASS='^[^[:space:];&|()<>]'
      if [[ "$MSG_SUFFIX" =~ $GLUE_CLASS ]]; then RESOLVE=0; fi

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
      # BUNDLED SHORT OPTIONS (independent review of #3816, round 6). git splits
      # `-am 'WIP first'` into `-a -m`, so the real subject is `WIP first` and
      # the heredoc is git's SECOND message — measured accepting the heredoc's
      # subject while git recorded `WIP first`. A standalone `-m` is therefore
      # not the only spelling that claims the message; any short-option cluster
      # ending in `m` does.
      # ATTACHED VALUES AND --message ABBREVIATIONS (independent review of
      # #3816, round 7). The scan required a space or `=` after the option name,
      # so two spellings git accepts matched nothing: an ATTACHED short-option
      # value (`-mWIP`, which git reads as `-m WIP`) and a long-option
      # abbreviation (`--mes=WIP`), the same abbreviation behaviour this file
      # already models for `--cleanup`. Both were measured accepting a later
      # conforming heredoc while git recorded `WIP` as the subject — confirmed
      # against the raw commit object, not `git log --pretty=%s`. The short arm
      # therefore drops its trailing requirement entirely: a `-` followed by
      # letters ending in `m` claims the message however it is spelled. Wider
      # than git's own abbreviation set on purpose — over-matching only refuses
      # more, which is the recoverable direction.
      # Variable-held for the same bash-3.2 reason as GLUE_CLASS above.
      # AN OPTION NAME BUILT BY A COMMAND SUBSTITUTION IS UNRESOLVABLE
      # (independent review of #3816, round 8). Stripping `$` above collapses the
      # two dollar-QUOTE forms onto their literals, but `--clean$(printf up)=`
      # is a different thing: bash RUNS a program to finish the option name, so
      # the argv git receives is not derivable from this string at all. Measured
      # accepting a 75-byte subject the length gate had recorded as 72.
      #
      # SCOPED TO THE NAME, NOT THE VALUE. The class is a `-`-leading token whose
      # characters up to the substitution contain no `=` — an option NAME being
      # assembled. `--author="$(git config user.name)"` and `--author "$(…)"`
      # both put the substitution in the VALUE, which this file never models and
      # which stays allowed; only `-…$(` before any `=` refuses. Scanned on the
      # RAW windows on purpose: the dequoted copies have had their `$` removed,
      # so the shape is no longer visible there.
      #
      # This is a SHAPE, not a segmentation: it never tries to decide where
      # git's own command ends. Two attempts at that were reverted for opening
      # accept-direction holes, and the reasoning above still stands.
      # WIDENED, and the strategy changed with it (independent review, round 9).
      # The `$(`-only spelling above was the fourth patch in a row that tried to
      # EMULATE what bash does to an argument before git sees it -- round 6
      # removed quotes, round 7 backslashes, round 8 the `$` of a dollar-quote,
      # and each time review found another transform that had been missed. Round
      # 9 found four more, all measured accepting `WIP` as the real subject on
      # bash 3.2.57 and 5.3.15 while the plain spelling of the same command is
      # refused:
      #
      #     -$'\155' WIP        ANSI-C octal escape decodes to `m`
      #     -$'\x6d' WIP        ANSI-C hex escape decodes to `m`
      #     -`printf m` WIP     command substitution, backtick spelling
      #     x= … -${x}m WIP     parameter expansion
      #     -? WIP              pathname expansion, with a file named `-m`
      #
      # The last two settle the strategy: an option name finished by a PARAMETER
      # expansion depends on a variable's runtime value, and one finished by a
      # PATHNAME expansion depends on the contents of the working directory.
      # Neither is derivable from the command string at any level of effort, so
      # emulation cannot be completed -- not "has not been completed yet".
      #
      # So the rule is no longer "normalise it and match the literal". It is: an
      # option NAME containing a shell expansion or quoting construct is
      # UNRESOLVABLE, and unresolvable refuses. One rule covers every spelling
      # above, and every spelling nobody has thought of yet, in the fail-closed
      # direction. The dequoting passes above are kept: they still normalise the
      # deterministic removals so the guards RECOGNISE `--clean""up=` and `-\m`
      # rather than merely refusing them, which keeps the existing rows honest.
      #
      # SCOPED TO THE NAME, NOT THE VALUE, exactly as before: the class is a
      # `-`-leading token whose characters up to the substitution contain no `=`.
      # `--author="$(git config user.name)"` and `--author "$(…)"` put the
      # construct in the VALUE and still resolve, pinned in both directions.
      # Scanned on the RAW windows, because the dequoted copies have had `$` and
      # the quote characters removed and the shape is no longer visible there.
      #
      # The class is bracket-only and holds no backslash, per round 8: a POSIX
      # bracket expression has no escape mechanism, and a backslash written
      # inside one becomes a literal member on bash 3.2.
      SUBST_NAME_CLASS='(^|[[:space:]])-[^[:space:]=]*[$`?*[]'
      if [[ "$MSG_PREFIX" =~ $SUBST_NAME_CLASS ]] \
        || [[ "$MSG_SUFFIX" =~ $SUBST_NAME_CLASS ]]; then RESOLVE=0; fi
      SEP_CLASS='[;&|]'
      if [[ "$MSG_PREFIX_DEQ" =~ (^|[[:space:]])(-[a-zA-Z]*m|--m[a-z]*([=[:space:]]|$)) ]] \
        || [[ "$MSG_PREFIX" =~ (^|[[:space:]])--([[:space:]]|$) ]] \
        || [[ "$MSG_PREFIX" =~ $SEP_CLASS ]] \
        || [[ "$MSG_PREFIX" == *$'\n'* ]]; then RESOLVE=0; fi
      # NEWLINE IS A COMMAND SEPARATOR TOO (independent review of #3816, round
      # 7) — the test above. The separator scan covered `;`, `&` and `|` but not
      # a literal newline, so a LATER command's heredoc-shaped `-m` was taken
      # for this commit's message:
      #
      #     git commit --amend --no-edit
      #     echo -m "$(cat <<'EOF'
      #     fix: conforming text unrelated to the commit
      #     EOF
      #     )"
      #
      # The classifier recognises the leading commit, the capture reaches across
      # the newline into `echo`'s argument, and a conforming string with no
      # relationship to the commit was validated and allowed. Tested as a glob
      # rather than folded into the bracket class, because a literal newline
      # inside a bash regex bracket expression is not portably expressible.

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
      # KNOWN LIMIT, deliberately fail-closed (#3816, round 6). This window is
      # the whole command minus the message, so a `--cleanup=` that belongs to a
      # DIFFERENT command — `git commit -m "<heredoc>" && echo --cleanup=verbatim`
      # — also refuses, and a conforming commit git would accept stays blocked.
      # Narrowing it to git's own segment was tried and reverted: deciding where
      # git's command ends needs a shell parse, and a substring scan is not one.
      # Trimming at the first `;&|` cut the window short whenever a separator sat
      # inside an ordinary argument — `--author "a&b"`, and equally `--author
      # a\&b` — which hid a REAL trailing `--cleanup=verbatim` and ACCEPTED a
      # 75-byte subject the length gate had measured as 72. Two successive
      # narrowings each reopened that hole on a shape the previous one missed, so
      # the scan stays wide: refusing a commit git would take is recoverable,
      # accepting an over-long subject is not.
      # ABBREVIATIONS (independent review of #3816, round 6). git accepts any
      # unambiguous prefix of a long option, so `--cle=verbatim` sets the mode
      # while matching no literal `--cleanup` — measured accepting a 75-byte
      # subject recorded as 72. The class is deliberately wider than git's own
      # abbreviation set: over-matching only refuses more, which is the safe
      # direction, and no other `--cl` option exists for git commit.
      # LAST DIRECTIVE WINS, AND ONE MATCH CANNOT SEE IT (independent review of
      # #3816, round 7). A bash regex yields ONE BASH_REMATCH, so only the
      # FIRST cleanup directive was inspected — and git applies the LAST one.
      # `--cleanup=whitespace -m <heredoc> --cleanup=verbatim` therefore read as
      # mode=whitespace, resolution stayed enabled, and a 72-character subject
      # plus trailing spaces was accepted while git recorded 75 bytes with the
      # whitespace preserved (confirmed against the raw commit object). Deciding
      # WHICH directive is last needs an argv order this substring scan does not
      # have, so multiplicity itself refuses: more than one directive is
      # unresolvable, not "probably fine". Single-directive behaviour is
      # unchanged.
      CLEANUP_WINDOW="$MSG_PREFIX_DEQ $MSG_SUFFIX_DEQ"
      # `|| true` is load-bearing: this script runs under `set -euo pipefail`,
      # and grep exits 1 when it matches NOTHING — which is the common case, a
      # command with no cleanup directive at all. Without it the pipeline's
      # non-zero status killed the hook outright (exit 1, no verdict) for every
      # ordinary commit. Caught by running the real hook rather than the scan.
      CLEANUP_HITS=$( { printf '%s' "$CLEANUP_WINDOW" | grep -oE '(--cl[a-z]*|commit\.cleanup)[=[:space:]]+[^[:space:]]+' || true; } | wc -l | tr -d ' ')
      if [ "${CLEANUP_HITS:-0}" -gt 1 ]; then
        RESOLVE=0
      elif [[ "$CLEANUP_WINDOW" =~ (--cl[a-z]*|commit\.cleanup)[=[:space:]]+([^[:space:]]+) ]]; then
        if [ "${BASH_REMATCH[2]}" != "whitespace" ]; then RESOLVE=0; fi
      fi

      # GIT-GENERATED SUBJECTS (independent review of #3816, round 7). With
      # `--squash=<commit>` or `--fixup=<commit>` git composes the subject
      # itself — measured recording `squash! base: something` while a conforming
      # heredoc supplied via -m sailed through. The supplied message is not the
      # subject in these modes at all, so there is nothing here worth measuring
      # and resolution is refused outright. Abbreviations included for the same
      # reason as --cleanup's. Deliberately NOT extended to the other
      # message-SOURCE options (-C/--reuse-message, -c/--reedit-message,
      # -F/--file, -t/--template): `-c` is also a git GLOBAL option that legally
      # precedes the subcommand, so a scan for it would refuse ordinary
      # `git -c k=v commit` invocations. Those remain a disclosed gap rather
      # than a guessed guard.
      if [[ "$MSG_PREFIX_DEQ $MSG_SUFFIX_DEQ" =~ (^|[[:space:]])--(squash|fixup|sq[a-z]*|fix[a-z]*)[=[:space:]] ]]; then RESOLVE=0; fi
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
