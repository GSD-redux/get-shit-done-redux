---
type: Fixed
pr: 3816
---
**The commit-message hook no longer blocks every heredoc-form commit** — with `hooks.community: true`, `gsd-validate-commit.sh` rejected `git commit -m "$(cat <<'EOF' … EOF)"` with `CONVENTIONAL_COMMITS_VIOLATION` whatever the message said, because its `-m` capture matches across newlines and the message's first line was the literal `$(cat <<'EOF'` rather than the subject. That opener is a standard agent-authored commit idiom, so enabling the toggle — which also carries the session-state and phase-boundary hooks — made that pattern fail every time. The subject is now resolved from the captured message before validation, handling the opener spellings bash accepts and the leading tabs `<<-` strips, and skipping leading blank lines the way git's own `cleanup=whitespace` does. Which argument counts as the message is unchanged, so no command starts or stops being validated. (#3802)
