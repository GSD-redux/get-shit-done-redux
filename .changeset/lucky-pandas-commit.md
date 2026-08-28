---
type: Fixed
pr: 3816
---
**The commit-message hook no longer blocks every heredoc-form commit** — with `hooks.community: true`, `gsd-validate-commit.sh` rejected `git commit -m "$(cat <<'EOF' … EOF)"` with `CONVENTIONAL_COMMITS_VIOLATION` whatever the message said, because its `-m` capture matches across newlines and the message's first line was the literal `$(cat <<'EOF'` rather than the subject. That opener is a standard agent-authored commit idiom, so enabling the toggle — which also carries the session-state and phase-boundary hooks — made that pattern fail every time.

The subject is now resolved from the captured message before validation. Resolution covers the delimiter spellings bash does not expand (`<<'EOF'`, `<<"EOF"`, `<<\EOF`, with or without `<<-`, spaced or space-free), the leading tabs `<<-` strips, CRLF line endings, and both directions of git's own `cleanup=whitespace` — leading blank lines are skipped, and trailing whitespace on the subject is not counted against the 72-character limit.

Resolution is deliberately refused, leaving the commit blocked as before, wherever the validated text would not be the text git receives: a bare `<<EOF` delimiter, whose body bash expands; a `-m '…'` single-quoted argument, in which bash performs no command substitution at all; a message carrying a `"` anywhere, including in its own subject, which the quote-bounded capture cannot span; and a substitution composed with more text on either side of the terminator. Which argument counts as the message is unchanged, so no command starts or stops being validated. (#3802)
