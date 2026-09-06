'use strict';

/**
 * git-cmd.js — token-walk git command classifier.
 *
 * Determines whether a shell command string invokes a specific git
 * subcommand. Handles the four forms that a naive `^git\s+commit` regex
 * misses:
 *
 *   bare:         git commit -m "..."                 ✓
 *   -C path:      git -C /some/path commit -m "..."   ✓ (missed by regex)
 *   env-prefix:   GIT_AUTHOR_NAME=x git commit "..."  ✓ (missed by regex)
 *   full-path:    /usr/bin/git commit -m "..."         ✓ (missed by regex)
 *
 * This module is the single source of truth for git-commit detection so all
 * hooks that need to gate on git commits share one implementation.
 *
 * Exported by the hooks/lib/ directory — require via a path relative to the
 * hook's own __dirname:
 *
 *   const { isGitSubcommand } = require(path.join(__dirname, 'lib', 'git-cmd.js'));
 *
 * `tokenize()` delegates to the shared `src/token-scanner.cts` seam (ADR-3212
 * §4, epic #3212 Phase 3, #3414) — the built `gsd-core/bin/lib/token-scanner.cjs`
 * artifact, not a sibling hooks/-tree file, because hook scripts are staged as
 * standalone files at install time and a sibling require is a staging
 * dependency that can fail silently (see gsd-workflow-guard.js's own
 * KIMI_TOOL_NAMES comment for the precedent this follows). Re-exported here
 * unchanged — every existing caller's behavior is identical (parity-asserted
 * in tests/token-scanner.test.cjs row 5).
 */

const path = require('path');
const { tokenizeShellLike } = require(path.join(__dirname, '..', '..', 'gsd-core', 'bin', 'lib', 'token-scanner.cjs'));

/**
 * Git global options that take a following argument.
 * These must be consumed as (option, argument) pairs when walking tokens.
 */
const ARGUMENT_TAKING_FLAGS = new Set([
  '-C',                // working directory
  '-c',                // config override (separate-arg form: `git -c k=v …`; #3504)
  '--git-dir',         // path to git repository
  '--work-tree',       // path to working tree
  '--namespace',       // git namespace
  '--super-prefix',    // superproject-relative prefix
  '--exec-path',       // path to core git programs (when given an arg)
  '--html-path',
  '--man-path',
  '--info-path',
  '--list-cmds',
]);

/**
 * Git global flags that consume no extra argument.
 */
const BOOLEAN_FLAGS = new Set([
  '-p', '--paginate', '--no-pager',
  '--no-replace-objects', '--bare',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks',
  '-P', '--no-lazy-fetch',
  '--version', '--help',
]);

/**
 * Tokenize a shell command string.
 * Handles single-quoted strings, double-quoted strings, and unquoted tokens.
 * Does NOT perform variable expansion or brace expansion.
 *
 * Delegates to the shared `src/token-scanner.cts` seam — see the module
 * header comment for why the built artifact, not a sibling require, is used.
 *
 * @param {string} cmd
 * @returns {string[]}
 */
function tokenize(cmd) {
  return tokenizeShellLike(cmd);
}

/**
 * Walk past leading env-prefix assignments and global git options, same as
 * `isGitSubcommand`'s phases 1-3. Returns the index of the subcommand token,
 * or -1 if the command does not resolve to a git invocation at all.
 *
 * @param {string[]} tokens
 * @returns {number}
 */
function skipToSubcommand(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    i++;
  }
  if (i >= tokens.length) return -1;
  const gitToken = tokens[i++];
  if (path.basename(gitToken) !== 'git') return -1;

  while (i < tokens.length) {
    const t = tokens[i];
    const eqIdx = t.indexOf('=');
    const flagName = eqIdx !== -1 ? t.slice(0, eqIdx) : t;
    if (ARGUMENT_TAKING_FLAGS.has(flagName)) {
      i += eqIdx !== -1 ? 1 : 2;
      continue;
    }
    // #3504: glued `-ckey=value` form — git accepts the config override with
    // its argument attached (`git -cfoo.bar=1 …`). The eq-slice above yields
    // flagName `-cfoo`, which no set contains, so without this arm the walk
    // stops and the whole invocation is misclassified as not-git.
    if (/^-c\S*=/.test(t)) {
      i++;
      continue;
    }
    if (BOOLEAN_FLAGS.has(t)) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Extract the branch-name argument from a git command line that creates or
 * references one — `git checkout -b <name>` or `git branch <name>`. Returns
 * null for any other command, including plain `git checkout <ref>` (switches
 * branches, does not create one) and commands where a checkout/branch-shaped
 * substring appears only inside a quoted argument (e.g. a commit message).
 *
 * New capability (ADR-3212 §4, epic #3212 Phase 3, #3414) exercising the
 * shared scanner on the domain the ADR names ("a branch name... [is] not
 * regular") — not a migration of existing duplicated logic; no prior
 * implementation of this existed in the repo (design doc §1.2).
 *
 * @param {string} cmd
 * @returns {string | null}
 */
function extractBranchArgument(cmd) {
  if (!cmd) return null;
  const tokens = tokenizeShellLike(cmd);
  const subIdx = skipToSubcommand(tokens);
  if (subIdx === -1 || subIdx >= tokens.length) return null;
  const sub = tokens[subIdx];

  if (sub === 'checkout') {
    for (let j = subIdx + 1; j < tokens.length; j++) {
      if (tokens[j] === '-b' && j + 1 < tokens.length) return tokens[j + 1];
    }
    return null;
  }

  if (sub === 'branch') {
    for (let j = subIdx + 1; j < tokens.length; j++) {
      if (!tokens[j].startsWith('-')) return tokens[j];
    }
    return null;
  }

  return null;
}

/**
 * Return true if `cmd` invokes the git subcommand `sub`.
 *
 * @param {string} cmd  - Full shell command string (may include env vars, full paths)
 * @param {string} sub  - Subcommand to test for, e.g. 'commit'
 * @returns {boolean}
 */
function isGitSubcommand(cmd, sub) {
  if (!cmd || !sub) return false;

  // Phases 1-3 (env-prefix skip, git-executable check, global-option consume)
  // extracted verbatim into skipToSubcommand — byte-identical logic, shared
  // with extractBranchArgument rather than a second copy (#3212 Phase 3).
  const tokens = tokenizeShellLike(cmd);
  const subIdx = skipToSubcommand(tokens);

  // Phase 4: check the subcommand
  if (subIdx === -1 || subIdx >= tokens.length) return false;
  return tokens[subIdx] === sub;
}

/**
 * Resolve a `-m` message argument to its SUBJECT — the first line of the commit
 * message — resolving the command-substituted heredoc form to the heredoc
 * BODY's first line.
 *
 * PURE STRING FUNCTION. It deliberately does NOT tokenize or walk the command
 * line: selecting *which* argument is the message stays with the caller, exactly
 * as before, so this cannot change which commands are validated. An earlier
 * revision of this fix did walk tokens and regressed four separate cases —
 * `git commit -- -m WIP` (a pathspec), `git commit --amend && echo -m WIP` (a
 * later command's flag), `-m "" --allow-empty-message` (the scanner drops empty
 * tokens, so the following flag became the subject), and unquoted
 * `git commit -m WIP`. All were allowed upstream and would have started being
 * blocked. Reported in review of #3802.
 *
 * The defect this DOES fix: `gsd-validate-commit.sh` captured the message with
 * `-m[[:space:]]+"([^"]+)"`, and bash `[^"]` matches newlines, so the widely
 * used agent-authored commit idiom
 *
 *     git commit -m "$(cat <<'EOF'
 *     feat(auth): add login flow
 *     EOF
 *     )"
 *
 * captured the whole span up to the final quote at `)"`. Taking its first line
 * yielded the literal `$(cat <<'EOF'`, which can never satisfy Conventional
 * Commits, so every heredoc-form commit was blocked regardless of its message.
 *
 * Recognition is anchored at BOTH ends and requires a command substitution, so
 * an ordinary message merely CONTAINING — or ending in — `<<WORD` is not
 * mistaken for an opener. Without the `^\$\(` anchor,
 * `-m "WIP notes <<EOF\nfix: smuggled subject"` resolved to the second line and
 * ALLOWED a non-conforming commit: an enforcement bypass, not just a
 * misclassification (review of #3802).
 *
 * NOT resolved, by design: an UNQUOTED delimiter (`<<EOF`). bash expands `$var`
 * and `$(...)` in that body, so the literal text here is not what git receives.
 * An earlier revision resolved it anyway and called the gap "the same
 * pre-existing limit as expansions in a plain `-m` argument" — that framing was
 * wrong on both halves: on base the whole heredoc form was blocked, so this fix
 * CREATED the path, and it dodged the length gate as well as the format gate.
 * See the expansion guard in the body (review of #3816, round 4).
 *
 * KNOWN LIMIT: the DOUBLE-QUOTED delimiter spelling (`<<"EOF"`) is resolvable
 * here but unreachable through the caller — `gsd-validate-commit.sh`'s
 * double-quoted `-m` capture stops at the first `"`, which in that spelling is
 * the delimiter's own quote, so the resolver only ever sees a truncated opener
 * and the commit stays blocked. Its single-quoted `-m` capture DOES deliver the
 * spelling intact, which is why an earlier revision's claim of unreachability
 * was false; the caller now gates the resolver on the double-quoted arm alone
 * (review of #3816, round 4), so the claim holds again — for that reason, not
 * by luck. That is the pre-fix behaviour for the whole form (fail closed, a
 * false positive on one rare spelling), and widening the bash capture to span
 * inner quotes would change what is captured for EVERY message containing one —
 * a regression class this fix deliberately does not touch (Codex review of
 * #3816). The same capture truncation blocks a `"` in the SUBJECT LINE itself,
 * where it lands inside the line being measured. It does NOT block a `"` on a
 * later body line: the subject is already complete before the truncation point,
 * so that message resolves and is allowed (measured; an earlier revision of this
 * comment and of the changeset claimed a `"` ANYWHERE blocked, which is false —
 * Codex review of #3816, round 4). The truncation guard below is what keeps the
 * unmeasurable half fail-closed. Two more legal-but-unrecognized spellings
 * stay blocked the same fail-closed way: an env-prefixed cat
 * (`$(A=1 cat <<'EOF'`) and an option-terminated cat (`$(cat -- <<'EOF'`) —
 * recognizing either would mean modelling bash prefix words here, cost with
 * no reported user (review of #3816, round 3).
 *
 * @param {string} messageArg - the raw `-m` argument, already selected by the caller
 * @returns {string} the subject to validate
 */
function resolveCommitSubject(messageArg) {
  // CRLF-tolerant split. With a bare split('\n') every body line kept its \r,
  // so `body.indexOf(delimiter)` never matched on CRLF input: the truncation
  // guard was inert, an empty CRLF message resolved to 'EOF\r' instead of '',
  // and a real 72-char subject measured 73 (review of #3816). Splitting on
  // /\r?\n/ is the repo-wide remedy for this recurring defect class.
  const lines = String(messageArg == null ? '' : messageArg).split(/\r?\n/);
  // The path prefix is a PATH-CHARACTER class, not \S*: `\S*` accepted
  // `id;/bin/cat`, so `$(id;/bin/cat <<'EOF' ...` was resolved to its heredoc
  // body while bash actually runs `id` first and git's real subject is `id`'s
  // OUTPUT — an enforcement bypass (Codex review of #3816). A prefix carrying
  // any shell metacharacter now fails recognition, which falls back to the
  // opener line and the format gate: fail closed, exactly the pre-fix
  // behaviour for the whole form.
  //
  // Whitespace inside the recognition is ASCII space/tab — [ \t], never \s —
  // because JavaScript \s includes Unicode whitespace bash does NOT split on:
  // `$(<NBSP>/bin/cat <<'EOF'` was recognized here while bash reads
  // `<NBSP>/bin/cat` as the executable NAME, so recognition claimed a
  // substitution that does not run cat (Codex review of #3816, round 2). The
  // same ASCII rule as the blank-line skip below, for the same reason.
  // `cat[ \t]*<<`, not `+`: bash accepts `cat<<'EOF'` with no space (review of
  // #3816, round 3), and recognizing it costs nothing — the token before `<<`
  // is still literally `cat`.
  //
  // The path prefix must be ABSOLUTE (Codex review of #3816, round 4). The old
  // `[\w./-]*\/` also accepted `./cat` and `../evil/cat`, so a relative
  // executable that merely ENDS in `cat` was trusted to echo its stdin: with a
  // planted `../evil/cat` printing `WIP injected`, the resolver validated the
  // heredoc body while git's real subject was `WIP injected` (measured
  // base=2 -> head=0 against a real commit). Requiring `/` up front costs
  // nothing real — `/bin/cat` and a bare `cat` both still resolve.
  //
  // AN ABSOLUTE PATH IS NOT AN IDENTITY EITHER (independent review of #3816,
  // round 8). Round 4 stopped at "must be absolute", so any absolute path
  // ENDING in `/cat` was still trusted to echo its stdin — the very thing the
  // round-4 reasoning rejected one spelling earlier. With an executable at
  // `/some/scratch/dir/cat` printing `WIP injected`, the resolver validated
  // the conforming heredoc body while git's real subject was `WIP injected`
  // (measured on bash 3.2.57 and 5.3.15 against a real commit: hook exit 0,
  // `git cat-file -p` subject `WIP injected`, while the same command through
  // `./cat` was already refused). The prefix is now the canonical system
  // locations, which is the only claim a string can support. `/usr/local/bin`
  // is deliberately excluded: it is user-writable on ordinary machines, which
  // is the plantable case this guard exists for.
  //
  // RESIDUAL, not fixable from a string: a bare `cat` shadowed earlier on PATH
  // has the same effect and is indistinguishable here. It is also not a
  // meaningful boundary — anyone who can plant an executable on PATH can run
  // `git commit` directly — so this hook stays an authoring guard, not a
  // security control.
  //
  // The delimiter alternatives are split so the BARE spelling is its own group:
  // `\\(...)` (backslash-quoted) and `(...)` (bare) were one `\\?(...)` branch,
  // which conflated the only two spellings that differ in bash. See the
  // expansion guard below.
  const opener = /^\$\([ \t]*(?:\/(?:usr\/)?bin\/)?cat[ \t]*<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\([^\s'"();|&<>\\]+)|([^\s'"();|&<>\\]+))[ \t]*$/
    .exec(lines[0]);
  if (!opener) return lines[0];

  // EXPANSION GUARD (review of #3816, round 4 — BLOCKER). Only `<<'D'`, `<<"D"`
  // and `<<\D` suppress expansion. A BARE `<<D` is expanded by bash, so the body
  // captured here is NOT the text git receives, and measuring it is an
  // enforcement bypass in both gates at once:
  //
  //     -m "$(cat <<EOF\nfeat: $UNSET_VAR\nEOF\n)"   git gets `feat:`  -> format gate dodged
  //     -m "$(cat <<EOF\nfeat: ${LONG}\nEOF\n)"      git gets any length -> length gate dodged
  //
  // Both measured base=2 -> head=0 against the real hook. This is NOT the
  // pre-existing plain-`-m` expansion limit an earlier revision claimed it was:
  // on base the whole heredoc form was blocked, so no expansion inside a body
  // ever reached an allow — this fix created the path, and closes it here.
  // Same rule every other guard in this function follows: when the real subject
  // cannot be known, fall back to the opener line, which fails the format gate.
  if (opener[5]) return lines[0];

  // `<<-` strips leading TABS from every body line, including the terminator.
  const stripTabs = opener[1] === '-';
  const delimiter = opener[2] || opener[3] || opener[4];
  const body = lines.slice(1).map((l) => (stripTabs ? l.replace(/^\t+/, '') : l));

  // TRUNCATION GUARD. The capture that produced this argument stops at the first
  // `"`, so a message containing one arrives here missing its tail — and its
  // terminator. Resolving anyway would hand the length gate a PREFIX of the real
  // subject and let an over-long message through, an enforcement hole that did
  // not exist before this fix (review of #3802). A body with no terminator is
  // therefore not resolved at all: returning the opener line fails the format
  // gate, which is exactly what this whole form did before the fix. The fix
  // applies where the capture is complete and changes nothing where it is not.
  const end = body.indexOf(delimiter);

  // POST-TERMINATOR GUARD (review of #3816, round 3 — BLOCKER). Everything
  // after the terminator is still part of the real message once bash
  // substitutes: `-m "$(cat <<'EOF'\nfeat: ok\nEOF\n) <200 a's>"` expands to a
  // single 200+ char subject, but discarding the tail measured 8 and DODGED
  // COMMIT_SUBJECT_TOO_LONG — the same prefix-measurement class the truncation
  // guard below exists for, missed on the other side of the terminator. The
  // canonical idiom's tail is exactly one closing-paren line; anything else
  // means the substitution is composed with more text, so fall back to the
  // opener line — blocked, the pre-fix behaviour for the whole form.
  if (end !== -1) {
    const tail = body.slice(end + 1);
    if (tail.length !== 1 || !/^[ \t]*\)[ \t]*$/.test(tail[0])) return lines[0];
  }

  // git's default `cleanup=whitespace` strips leading blank lines, so the subject
  // is the first NON-EMPTY body line, not blindly the first one. Taking lines[1]
  // returned '' for a body that starts blank and falsely blocked a conforming
  // commit — the very defect class #3802 reports (review of #3802).
  const scan = end === -1 ? body : body.slice(0, end);
  // "Blank" is git's ASCII definition — space and tab — never JavaScript's
  // trim(), whose Unicode whitespace class skips lines git KEEPS: a body whose
  // first line is a NBSP resolved to the SECOND line while git's real subject
  // is the NBSP line — an enforcement bypass (Codex review of #3816, verified
  // against `git stripspace`, which preserves the c2a0 bytes). A Unicode-blank
  // first line is now returned as the subject and fails the format gate: the
  // same fail-closed direction git itself takes.
  const idx = scan.findIndex((l) => !/^[ \t]*$/.test(l));
  if (idx === -1) return end === -1 ? lines[0] : '';

  // Truncation is only fatal to the line it lands IN. A captured line is complete
  // exactly when another line follows it, because the capture kept its newline.
  // So an unterminated body whose subject line is followed by more text is still
  // measurable; only a subject line that runs to the end of a truncated capture
  // is not, and that one falls back to the opener — which fails the format gate,
  // exactly as this whole form did before the fix. Without this, the length gate
  // measured a PREFIX of the real subject and let an over-long message through
  // (review of #3802).
  if (end === -1 && idx >= body.length - 1) return lines[0];

  // git's `cleanup=whitespace` strips whitespace at BOTH ends of the line, not
  // just leading blanks. Measuring the raw line rejected `feat: <66 x's>` plus
  // three trailing spaces as 75 chars when git's actual subject is a conforming
  // 72 — a still-blocked conforming commit, the very defect #3802 reports
  // (review of #3816). Trailing only, here: leading blank-LINE handling is the
  // findIndex above, and `<<-` leading-tab stripping already happened.
  return scan[idx].replace(/[ \t]+$/, '');
}

module.exports = { isGitSubcommand, tokenize, extractBranchArgument, skipToSubcommand, resolveCommitSubject };
