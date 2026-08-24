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
 * First line of a `-m` message argument, resolving the command-substituted
 * heredoc form to the heredoc BODY's first line.
 *
 * @param {string} arg
 * @returns {string}
 */
function firstLineOfMessageArg(arg) {
  const lines = String(arg).split('\n');
  // `$(cat <<'EOF'` / `$(cat <<-"EOF"` / `$(cat << EOF` — the opener is the
  // whole first line, so the real subject is the line after it. Matching the
  // heredoc OPERATOR rather than the `cat` is deliberate: the operator is what
  // makes the rest of the token a body, and `$(/bin/cat <<'EOF'` is the same
  // shape. A `-m` argument that merely CONTAINS `<<` further along its first
  // line is not this form and is left alone.
  if (/<<-?[ \t]*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[ \t]*\)?[ \t]*$/.test(lines[0])) {
    return lines.length > 1 ? lines[1] : '';
  }
  return lines[0];
}

/**
 * Extract the commit SUBJECT — the first line of the `-m` message — from a
 * git command line. Returns null when the command carries no `-m <message>`
 * pair, which callers must distinguish from an EMPTY subject: the former means
 * "nothing to validate", the latter is a message that fails validation.
 *
 * Token-walk rather than regex, for the same reason `isGitSubcommand` exists.
 * The bash regex this replaces — `-m[[:space:]]+"([^"]+)"` in
 * gsd-validate-commit.sh — matched ACROSS NEWLINES, because bash `[^"]`
 * includes them. Against Claude Code's documented commit idiom:
 *
 *     git commit -m "$(cat <<'EOF'
 *     feat(auth): add login flow
 *     EOF
 *     )"
 *
 * it captured the entire span from the quote after `-m` to the final quote at
 * `)"`, so `head -1` yielded the literal `$(cat <<'EOF'` as the subject — which
 * can never satisfy Conventional Commits. Every heredoc-form commit was blocked,
 * conforming or not (#3802). The shared scanner already returns that span as ONE
 * token, so all that remains is resolving the heredoc body.
 *
 * Only the separated `-m <msg>` form is recognised, matching the regex it
 * replaces: a glued `-mfeat: x` or `--message=...` yielded no match before and
 * still yields null, so this fix changes no behavior beyond the heredoc form.
 *
 * @param {string} cmd
 * @returns {string | null}
 */
function extractCommitSubject(cmd) {
  if (!cmd) return null;
  const tokens = tokenizeShellLike(cmd);
  // Start at the subcommand, so a `-m` appearing among git's own global options
  // — or inside an env-prefix assignment — cannot be mistaken for the message.
  const start = skipToSubcommand(tokens);
  if (start === -1) return null;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i] === '-m') {
      return i + 1 < tokens.length ? firstLineOfMessageArg(tokens[i + 1]) : null;
    }
  }
  return null;
}

module.exports = { isGitSubcommand, tokenize, extractBranchArgument, skipToSubcommand, extractCommitSubject };
