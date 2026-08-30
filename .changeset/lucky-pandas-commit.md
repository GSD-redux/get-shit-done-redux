---
type: Fixed
pr: 3816
---
**The commit-message hook no longer blocks every heredoc-form commit** — with `hooks.community: true`, `gsd-validate-commit.sh` rejected `git commit -m "$(cat <<'EOF' … EOF)"` with `CONVENTIONAL_COMMITS_VIOLATION` whatever the message said, because its `-m` capture matches across newlines and the message's first line was the literal `$(cat <<'EOF'` rather than the subject. That opener is a standard agent-authored commit idiom, so enabling the toggle — which also carries the session-state and phase-boundary hooks — made that pattern fail every time.

The subject is now resolved from the captured message before validation, for the canonical form: a single `-m "…"` holding one `$(cat …)` substitution, under git's default `cleanup=whitespace`. Resolution handles the delimiter spellings bash does not expand (`<<'EOF'` and `<<\EOF`, with or without `<<-`, spaced or space-free), the leading tabs `<<-` strips, CRLF line endings, and both directions of `cleanup=whitespace` — leading blank lines are skipped, and trailing whitespace on the subject is not counted against the 72-character limit.

Everywhere the validated text could differ from the subject git actually receives, resolution is refused and the commit stays blocked exactly as it was before this change. That covers: a `-m '…'` single-quoted argument, in which bash performs no command substitution at all; a bare `<<EOF` delimiter, whose body bash expands; a `-m` that is not git's first message argument, since git concatenates multiple `-m` values and takes the first as the subject; an explicit `--cleanup=` or `-c commit.cleanup=` mode other than `whitespace`, including git's
abbreviated spellings of it (`--cle=verbatim` and anything else that is an unambiguous prefix);
a message argument claimed by a bundled short option, since git reads `-am 'first'` as `-a -m` and
takes that first message as the subject; a `cat` reached by a relative path; a substitution composed with more text on either side of the terminator; and a `"` inside the subject line itself, which the quote-bounded capture cannot span.

Option names are matched against the command as bash hands it to git, with quote characters
removed, so a spliced spelling like `--clean""up=verbatim` or `-""m` is recognised as the option
it actually is rather than slipping past a literal match.

Whether text is glued to the message argument is judged against the one character that
follows it, so a glued `-m` belonging to a command chained after this one no longer
refuses a message that was never truncated.

Known limits, all fail-closed — the commit is blocked, never wrongly allowed: the `<<"EOF"` delimiter spelling and a closing `)` on its own line remain false positives, a `--cleanup=` carried by a command chained after the commit refuses it as though it were git's own, and a `cleanup` mode set persistently in git config is invisible to the hook. Which argument the hook captures as the message is unchanged. (#3802)
