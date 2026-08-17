'use strict';

/**
 * Repo-wide `git add` -> `.planning/` reach guard (#1783, superseding the
 * per-file `execute-phase.md`/`quick.md` scan; extended for #3585).
 *
 * The prior guard (tests/commit-docs-bypass.test.cjs before this module
 * existed) matched a hardcoded regex requiring the literal substring
 * `.planning/` on the SAME line as `git add`, over exactly two allowlisted
 * files. That is structurally blind to `git add -A` / `git add .` / `git add
 * -u` (no `.planning/` text on the line at all, yet every one of them stages
 * the whole index including `.planning/`), and it never looked at any file
 * outside its two-item allowlist.
 *
 * This module classifies `git add` (and `git commit -a`/`--all`) invocations
 * INSIDE fenced code blocks across the repo's live
 * workflow/agent/command/skill/reference surface and decides, per
 * invocation, whether it can reach `.planning/` at all — covering the
 * wildcard/blanket forms, `.planning`-qualified paths (either path-separator
 * convention), any argument carrying an unresolved shell variable, a
 * command/backtick substitution, or a `--pathspec-from-file` argument
 * (fail-closed in all four cases: none of them is statically resolvable, and
 * any one might expand to something planning-rooted). A `git commit -a`
 * (including a combined short cluster like `-am`) is classified the same way
 * `git add -A` is, because `-a` stages every tracked modification —
 * including tracked `.planning/` files — before the commit runs (#3585 F3).
 * An invocation that reaches is a violation UNLESS it sits inside an open
 * `commit_docs` conditional in the SAME fenced block, carries an exclude
 * pathspec naming `.planning`, or the line carries a tracked
 * `# gsd-scan-ignore: #NNN` declaration (shared machinery — see
 * tests/helpers/shipped-command-scan.cjs).
 *
 * ## Known limits
 *
 * This guard is a lightweight, line/token-oriented scan, not a shell
 * interpreter — it targets ACCIDENTAL reintroduction of an unguarded
 * `.planning/`-reaching stage by a contributor editing shipped content, not
 * a determined attempt to defeat it. An isolated security review (#3585)
 * empirically confirmed the following shapes stage `.planning/` at runtime
 * while scoring ZERO offenders here, and none of them is a shape GSD
 * workflow content actually uses — chasing them means writing a shell
 * interpreter:
 *   - `eval "git add -A"` — the invocation lives inside a string literal
 *     `eval` re-parses at runtime, not inside argv this scan can see.
 *   - `find .planning -type f | xargs git add` — the reaching argument
 *     arrives via a pipeline at runtime, never appearing as a literal
 *     `git add` argument in the source text.
 *   - `f() { git add -A; }` — a one-line shell function body; this scan has
 *     no notion of function definitions or of a later, unseen call site.
 *   - a backslash line-continuation splitting one logical command across two
 *     physical lines — this scan is line-based and never rejoins them.
 * Separately, and independently of the above, this module models only
 * `git add` and `git commit -a`/`--all` as staging commands. It does NOT
 * model `git stash`, `git rm --cached`, `git restore --staged`, or
 * `git update-index --add` — each of these can also move `.planning/` files
 * into a state a subsequent commit picks up, and none of them is recognized
 * by this scan.
 */

const fs = require('fs');
const path = require('path');
const {
  tokenize, bareCommandName, shellDashCPayloads, isDeclared, isUntrackedDeclaration,
} = require('./shipped-command-scan.cjs');

// A fenced code block opens/closes on a line whose TRIMMED form starts with
// a run of 3+ backticks or 3+ tildes. Only content INSIDE such a block is
// executable shell — everything else (prose, inline `git add` mentions, bare
// bullet lists) is documentation and is never a candidate.
const FENCE_RE = /^(`{3,}|~{3,})/;

// Shell prefixes that may legitimately precede the git binary itself without
// being the command: keywords that introduce a new command position, the
// modifiers that pass straight through to what follows, and the prompt/list
// markers a doc author might glue onto an example line. Kept in sync (by
// hand, deliberately — this file's domain is narrower than
// shellDashCPayloads's invoker search, so the sets are not shared) with the
// spec's literal list.
const NON_COMMAND_PREFIX = new Set(['then', 'else', 'do', 'time', 'exec', 'nohup', 'env', 'command', '$', '-', '*']);

// AN ASSIGNMENT IS A SKIPPABLE PREFIX ONLY WHEN IT IS NOT A SUBSTITUTION —
// deliberately the same rule as shellDashCPayloads's `skippable` in
// shipped-command-scan.cjs (see its comment for the `V=$(git add -A)` vs
// `FOO=1 git add -A` distinction). This divergence is precisely what the
// shared-helper extraction (#3585) was meant to prevent; kept duplicated
// here only because this file's domain (git-add reach) is narrower than
// that file's invoker search, per the NON_COMMAND_PREFIX comment above.
const isSkippable = (t) => t.redir
  || (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?=/.test(t.value) && !t.value.includes('$('))
  || NON_COMMAND_PREFIX.has(t.value);

// One line, split into shell segments (top-level `;`/`&`/`&&`/`||`
// boundaries), unioned with every `shellDashCPayloads` extraction so
// `bash -c "git add -A"` is reached exactly as a bare `git add -A` is. Each
// segment carries its own SOURCE TEXT (the line, or the extracted payload
// string) so a classifier can slice raw, unescaped substrings out of it —
// see reachesPlanning's comment for why that matters.
const collectSegments = (line) => {
  const sources = [line, ...shellDashCPayloads(line)];
  const segments = [];
  for (const src of sources) {
    let group = [];
    for (const tok of tokenize(src)) {
      if (tok.op) {
        if (group.length) segments.push({ tokens: group, src });
        group = [];
      } else {
        group.push(tok);
      }
    }
    if (group.length) segments.push({ tokens: group, src });
  }
  return segments;
};

// The RAW, as-authored substring behind a token — start/end are source
// offsets tokenize() carries regardless of what it did to escape sequences
// while building `t.value`. This matters for exactly one reason: tokenize()
// applies real (POSIX) unquoted-backslash-escape semantics, which consumes a
// literal `\` before whatever follows it (`.planning\STATE.md` dequotes to
// `.planningSTATE.md`). That is correct for what a POSIX shell would actually
// execute, but this scan is reading DOCUMENTATION that may show a Windows
// path verbatim — the separator itself is the thing being tested for, and
// the escape-eaten `t.value` would hide it. Slicing the original text instead
// preserves it.
const rawSlice = (src, t) => src.slice(t.start, t.end);

// Reach rules, in the order the spec states them. `-A`/`--all`/`.`/`-u` are
// exact-flag matches against the dequoted value (no escape/quote ambiguity
// possible for a bare flag); the `.planning` substring and the unresolved-
// variable check both read the RAW slice for the reason above.
//
// THE EXCLUDE PATHSPEC IS A FULL OVERRIDE, not just a veto on rule (b). Git's
// own semantics are why: `git add -A -- ':!.planning'` stages everything
// EXCEPT `.planning/`, so an exclude pathspec naming `.planning` neutralizes
// the wildcard/blanket forms too, not only a literal `.planning` path
// argument. Checked first, over every arg, before any reach rule fires.
// Shared with the `git commit -a` check below (#3585 F3) — the same
// pathspec override applies to a commit invocation carrying an exclude arg.
const hasPlanningExcludePathspec = (argTokens, src) => argTokens.some(
  (t) => /:!.*\.planning/.test(rawSlice(src, t)),
);

const reachesPlanning = (argTokens, src) => {
  if (hasPlanningExcludePathspec(argTokens, src)) return false;
  for (const t of argTokens) {
    if (t.value === '-A' || t.value === '--all' || t.value === '.' || t.value === '-u') return true;
  }
  for (const t of argTokens) {
    const raw = rawSlice(src, t);
    // Either path-separator convention: `.planning/x`, `.planning\x`, or a
    // bare `.planning` token with nothing after it.
    if (/\.planning(?:[/\\]|$)/.test(raw)) return true;
    // An unresolved shell variable ($VAR / ${VAR}). `{placeholder}` with NO
    // `$` is doc notation, not a shell variable, and must NOT trigger this —
    // the regex requires the `$` explicitly so it never does.
    if (/\$\{?[A-Za-z_]/.test(raw)) return true;
    // Command substitution ($( or backtick) — equally opaque to static
    // analysis as $VAR/${VAR} above, and for the same reason: whatever it
    // expands to might be planning-rooted, and this scan cannot run the
    // shell to find out. Fail closed (#3585 F2).
    if (raw.includes('$(') || raw.includes('`')) return true;
    // --pathspec-from-file names an external file listing the paths to
    // stage; the file's contents are exactly as unknowable statically as an
    // unresolved shell variable, so this also fails closed (#3585 F2).
    if (/^--pathspec-from-file(?:=|$)/.test(raw)) return true;
  }
  return false;
};

// One segment -> null (not a git-add invocation) or { reaches, argTokens }.
// "git" is recognized by bareCommandName so a substitution/subshell-glued
// spelling still resolves (`$(git add -A)`), and by a trailing `/git` so an
// absolute/relative invocation (`/usr/bin/git add -A`) is still caught.
const classifySegment = ({ tokens, src }) => {
  let ci = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (isSkippable(tokens[i])) continue;
    ci = i;
    break;
  }
  if (ci === -1) return null;
  const bare = bareCommandName(tokens[ci]);
  if (bare !== 'git' && !/\/git$/.test(bare)) return null;

  // A flag's VALUE is not itself a flag. `git -C <dir> add -A` must still
  // reach `add` — `-C`, `--git-dir`, `--work-tree`, `--namespace`, and `-c`
  // (in their SEPARATE-value spellings) all consume the next token as their
  // argument. The glued forms (`--git-dir=<p>`, `-C<dir>`) already carry
  // their value in the same token and need no extra consumption; an explicit
  // set (rather than "consume the token after every flag") is what keeps
  // `git --no-pager add -A` from swallowing `add` as `--no-pager`'s value.
  const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
  let addIdx = -1;
  for (let i = ci + 1; i < tokens.length; i += 1) {
    if (tokens[i].redir) continue;
    if (tokens[i].value.startsWith('-')) {
      if (GIT_VALUE_FLAGS.has(tokens[i].value)) i += 1; // consume the flag's separate value
      continue; // a flag on git itself; keep looking
    }
    addIdx = i;
    break;
  }
  if (addIdx === -1) return null;
  const subcommand = tokens[addIdx].value;
  if (subcommand !== 'add' && subcommand !== 'commit') return null;

  const argTokens = tokens.slice(addIdx + 1).filter((t) => !t.redir);

  // tokenize() has no notion of subshell structure: `V=$(git add -A)`'s
  // closing `)` is not consumed as syntax, it is just another character
  // glued onto whatever token happens to be last (`-A)`). That is invisible
  // to the substring-based reach rules (`.planning`, `$VAR`) but breaks the
  // EXACT-flag comparisons (`t.value === '-A'`) reachesPlanning also relies
  // on. Only strip it when the command itself was resolved via a `$(` glue
  // (tokens[ci] carrying `$(` is how bareCommandName found "git" at all —
  // see the comment above), and only the one trailing, unquoted `)` that
  // substitution's own opener is owed.
  if (tokens[ci].value.includes('$(') && argTokens.length) {
    const last = argTokens[argTokens.length - 1];
    const mask = last.qmask || '0'.repeat(last.value.length);
    if (last.value.endsWith(')') && mask[mask.length - 1] === '0') {
      argTokens[argTokens.length - 1] = { ...last, value: last.value.slice(0, -1) };
    }
  }

  if (subcommand === 'commit') {
    // `git commit -a`/`--all` (including a combined short cluster like
    // `-am`) stages every tracked modification, which includes tracked
    // `.planning/` files, so it bypasses the gate exactly as `git add -A`
    // does (#3585 F3). A short cluster is any single-dash, letters-only
    // flag that carries `a` among its letters (`-am`, `-ma`); `--amend` is
    // a distinct double-dash flag and is never matched by this pattern.
    const hasCommitAllFlag = argTokens.some((t) => {
      if (t.value === '--all') return true;
      return /^-[a-zA-Z]+$/.test(t.value) && t.value.includes('a');
    });
    if (!hasCommitAllFlag) return { reaches: false };
    if (hasPlanningExcludePathspec(argTokens, src)) return { reaches: false };
    return { reaches: true };
  }

  return { reaches: reachesPlanning(argTokens, src) };
};

// Whether LINE, considered in isolation (no fence/guard context), contains
// at least one git-add invocation whose arguments reach `.planning/`. Used
// directly by the pure per-line classifier tests; the file scanner below
// layers fence and commit_docs-guard state on top of this.
const hasReachingGitAdd = (line) => collectSegments(line).some((seg) => {
  const result = classifySegment(seg);
  return result !== null && result.reaches;
});

// A `VAR=$(... config-get commit_docs ...)` assignment — the shell-variable
// half of the guard trigger. Matched on the TRIMMED line; `config-get
// commit_docs` may carry trailing flags (`--default true`) after the name.
const CONFIG_GET_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=.*config-get\s+commit_docs\b/;

/**
 * Scan one document's TEXT for unguarded, undeclared `git add` invocations
 * that can reach `.planning/`.
 *
 * State machine, one pass over `text.split(/\r?\n/)`:
 *  - fence tracking: only lines inside a ``` or ~~~ block are candidates.
 *  - inside a fence, an `if`/`fi` depth counter (first-token match) tracks
 *    nesting; a commit_docs guard OPENS at the depth an `if` is entered when
 *    its condition text mentions `commit_docs` or a tracked config-get
 *    variable, and CLOSES the first time depth drops below the depth it
 *    opened at (so a nested `if`/`fi` inside the guard leaves it open, and
 *    an `else` branch of the SAME `if` stays covered — the guard tracks the
 *    conditional's extent, not which branch is truthy).
 *  - guard state (depth, open-guard, tracked vars) resets at every fence
 *    boundary: each fenced block is its own shell, so a guard opened in one
 *    block can never protect a `git add` in a different one.
 */
const scanText = (file, text) => {
  const lines = text.split(/\r?\n/);
  const offenders = [];
  const untracked = [];

  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;
  let ifDepth = 0;
  let guardOpenDepth = null;
  let guardVars = new Set();

  const resetGuardState = () => {
    ifDepth = 0;
    guardOpenDepth = null;
    guardVars = new Set();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(FENCE_RE);

    if (!inFence) {
      if (fenceMatch) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        resetGuardState();
      }
      continue;
    }

    // Inside a fence: a same-character run at least as long as the opener,
    // with nothing else on the line, closes it.
    if (fenceMatch && fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen
      && /^(`+|~+)\s*$/.test(trimmed)) {
      inFence = false;
      fenceChar = null;
      fenceLen = 0;
      resetGuardState();
      continue;
    }

    // A `# gsd-scan-ignore:` attempt with no tracking reference is a
    // malformed declaration — reported on its own terms, never silently
    // folded into "unguarded" (see shipped-command-scan.cjs's declaration
    // comment for why the diagnosis must be specific).
    if (isUntrackedDeclaration(raw)) {
      untracked.push({ file, line: i + 1, text: raw.trim() });
    }

    const assignMatch = trimmed.match(CONFIG_GET_ASSIGN_RE);
    if (assignMatch) guardVars.add(assignMatch[1]);

    const firstToken = trimmed.split(/\s+/)[0] || '';
    if (firstToken === 'if') {
      ifDepth += 1;
      const cond = trimmed.slice(firstToken.length);
      const mentionsCommitDocs = /commit_docs/.test(cond);
      const mentionsTrackedVar = [...guardVars].some(
        (v) => new RegExp(`\\$\\{?${v}\\b`).test(cond),
      );
      if ((mentionsCommitDocs || mentionsTrackedVar) && guardOpenDepth === null) {
        guardOpenDepth = ifDepth;
      }
    } else if (firstToken === 'fi') {
      // Clamped, not raw decrement. A stray/unbalanced `fi` must fail CLOSED
      // (report), never open: an unclamped negative ifDepth lets a LATER
      // `if` set guardOpenDepth = 0, and the guard test `guardOpenDepth !==
      // null` reads zero as an OPEN guard — silently guarding an unrelated
      // `git add -A` that follows.
      ifDepth = Math.max(0, ifDepth - 1);
      if (guardOpenDepth !== null && ifDepth < guardOpenDepth) guardOpenDepth = null;
    }

    const guarded = guardOpenDepth !== null;
    if (!guarded && hasReachingGitAdd(raw) && !isDeclared(raw)) {
      offenders.push({ file, line: i + 1, text: raw.trim() });
    }
  }

  return { offenders, untracked };
};

// The repo-wide walk: every `.md` file (recursive) under each scan root.
const SCAN_ROOTS = [
  'gsd-core/workflows',
  'gsd-core/references',
  'agents',
  'commands',
  'skills',
];

const scanRepo = (repoRoot, roots = SCAN_ROOTS) => {
  const offenders = [];
  const untracked = [];
  for (const root of roots) {
    const rootDir = path.join(repoRoot, root);
    if (!fs.existsSync(rootDir)) continue;
    const mdFiles = fs.readdirSync(rootDir, { recursive: true }).filter((f) => String(f).endsWith('.md'));
    for (const file of mdFiles) {
      const normalized = String(file).split(path.sep).join('/');
      const label = `${root}/${normalized}`;
      const text = fs.readFileSync(path.join(rootDir, String(file)), 'utf-8');
      const result = scanText(label, text);
      offenders.push(...result.offenders);
      untracked.push(...result.untracked);
    }
  }
  return { offenders, untracked };
};

module.exports = {
  hasReachingGitAdd,
  scanText,
  scanRepo,
  SCAN_ROOTS,
};
