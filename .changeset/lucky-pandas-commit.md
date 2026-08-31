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
and syntactic backslashes removed, so a spliced spelling like `--clean""up=verbatim`, `-""m`,
`--clean\up=verbatim` or `-\m` is recognised as the option it actually is rather than slipping
past a literal match. A message option is also recognised when its value is attached (`-mWIP`,
which git reads as `-m WIP`) and when its name is abbreviated (`--mes=WIP`), and a newline is
treated as a command separator alongside `;`, `&` and `|`, so a later command's `-m` is never
mistaken for this commit's message. Where more than one `cleanup` directive appears, resolution
is refused rather than guessed: git applies the last one, and argument order is not recoverable
from a substring scan. Modes in which git composes the subject itself (`--squash`, `--fixup`)
refuse resolution outright, because the supplied message is not the subject in them at all.

Whether text is glued to the message argument is judged against the one character that
follows it, so a glued `-m` belonging to a command chained after this one no longer
refuses a message that was never truncated.

Known limits that fail closed — the commit is blocked, never wrongly allowed: the `<<"EOF"` delimiter spelling and a closing `)` on its own line remain false positives; a `--cleanup=` carried by a command chained after the commit refuses it as though it were git's own; and a leading assignment followed by a separator, as in `FOO=bar; git commit …`, is read as an assignment prefix, so the commit is recognised and then refused for the separator in its prefix. Which argument the hook captures as the message is unchanged.

Two limits fail OPEN, and are called out separately because they are the direction that matters:
a `cleanup` mode set persistently in git config is invisible to the hook, so under
`commit.cleanup=verbatim` a subject whose trailing whitespace pushes it past 72 characters is
measured without that whitespace and allowed; and the other options that supply a message from
somewhere other than `-m` (`-C`/`--reuse-message`, `-c`/`--reedit-message`, `-F`/`--file`,
`-t`/`--template`) are not detected. The latter is deliberate rather than overlooked: `-c` is
also a git GLOBAL option that legally precedes the subcommand, so scanning for it would refuse
ordinary `git -c key=value commit` invocations, and guessing that trade seemed worse than
naming the gap.

One limit is pre-existing rather than introduced here, and runs in the fail-open direction: the
hook validates a command only when the git invocation itself begins it. Leading environment
assignments, an absolute path to git, and the git global options this classifier knows are all
walked through — that set is finite and does not cover every global option git accepts, so an
unlisted one such as `--config-env` is not walked. Measured: `git add -A && git commit …`,
`cd dir && git commit …`, `git status; git commit …` and `(git commit …)` are not recognised as
commits at all, so they are unchecked in every message form, heredoc or not, while a command
chained *after* the commit (`git commit … && echo done`) is recognised normally. It is not true
of every chained-before shape, though: `FOO=bar; git commit …` tokenizes with `FOO=bar;` read as
an assignment prefix, so it IS recognised and then refused, which is the fail-closed limit noted
above. So the resolution and the limits here describe the commands this hook gates, not every
commit a shell can run. Widening the classifier is a separate change with its own bypass surface
and with blast radius beyond this hook — `isGitSubcommand` is the shared git-commit detector for
every hook that gates on one — so it is deliberately not made here. The two shapes above are
pinned by tests, including non-conforming subjects that prove they are unvalidated rather than
merely permitted. (#3802)
