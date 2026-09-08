'use strict';

/**
 * Extracted from tests/commit-files-pathspec.test.cjs (#2269) so the #3585
 * commit_docs guard consumes ONE shell tokenizer rather than hand-rolling a
 * second. Only the primitives BOTH guards need live here — the shell
 * tokenizer, the bare-command-name extraction, the -c payload search, and
 * the `gsd-scan-ignore:` declaration machinery.
 *
 * Commit-specific logic stays in the test file and is deliberately NOT
 * moved here: `isCommitInvocation`, `hasScopedFiles`, `SYNOPSIS_TOKEN_RE`,
 * `METAVAR_REDIR_RE`, `segmentInvocations`, `codeSpans`, and
 * `invocationCandidates` all encode assumptions specific to the commit
 * scan and do not generalize to other guards.
 */

// 443 live substitution sites are `VAR=$(gsd_run …)`. That is the majority
// and it is the wrong generalisation — the remaining six are neither, and
// they are live today:
//   for REVIEW_FLAG in $(gsd_run review-lane flags)          (×3)
//   ${PLAN_PRE_HOOKS_JSON:-$(gsd_run loop render-hooks …)}   (×3)
// A parameter-expansion default glues just as hard as an assignment, and so
// does ordinary text (`pre$(…)`) and an indexed assignment (`A[0]=$(…)`).
// Enumerating prefixes means a new one every time the shell is used
// idiomatically, and each miss is silent. So the rule is positional instead:
// strip everything up to and including the LAST substitution opener in the
// token. Whatever preceded it was, by construction, not the command.
//
// ARITHMETIC IS EXCLUDED BY THE SAME MECHANISM, not by a special case.
// `$((x))` leaves a `(` in front of the name after the strip, and a leading
// `(` is not part of any binary name — so it is refused. That mirrors the
// shell, which also requires `$( (` with a space before it will read a nested
// subshell rather than an arithmetic expansion.
//
// The ARRAY LITERAL stays invisible for free: `arr=(a b c)` contains no `$(`
// at all, so neither alternative fires and the token is left whole. It is
// pinned as a zero-candidate case regardless, because that is a property of
// this regex rather than of the grammar and the next edit could lose it.
// THE STRIP IS REFUSED ON A TOKEN THAT CARRIED A QUOTE, because quoting is
// exactly what decides whether an opener is syntax or data. `printf %s
// '$(gsd_run' query commit fixup` runs no gsd command — the opener is
// single-quoted literal text — but quote removal leaves the token `$(gsd_run`
// and a strip would then read it as a binary, fabricating an invocation out
// of a string. The tokenizer already knows; it just was not saying.
//
// RESIDUAL, named rather than implied: this closes the strip's exposure, not
// the tokenizer's quote-blindness in general. `printf %s 'gsd_run' query
// commit fixup` still reads as an invocation, because no markup is stripped
// there — the token's value simply IS the binary name. That predates this
// rule and is unchanged by it; closing it needs quote provenance carried
// through the command-shape test, not just through the strip. The direction
// is a visible false positive with a declared remedy, not a silent miss.
const bareCommandName = (t) => {
  const mask = t.qmask || '0'.repeat(t.value.length);
  // The LAST opener whose own two characters were unquoted. Per-character,
  // not per-token: a quote elsewhere in the word protects only itself, and
  // `echo "pre"$(gsd_run …)` really does run.
  for (let i = t.value.length - 2; i >= 0; i -= 1) {
    if (t.value[i] === '$' && t.value[i + 1] === '(' && mask[i] === '0' && mask[i + 1] === '0') {
      return t.value.slice(i + 2);
    }
  }
  let j = 0;
  while (j < t.value.length && t.value[j] === '(' && mask[j] === '0') j += 1;
  return t.value.slice(j);
};

// Shell-like word splitting. Honours BOTH quote characters (the previous
// parity walk counted only `"`, so a single-quoted message was transparent
// to it in both directions), backslash escapes, and unquoted control
// operators — which become their own tokens, so an operator glued to its
// neighbour (`"a"&&gsd_run`) still separates. Quoted operators and quoted
// whitespace stay literal, which is what keeps a command substitution inside
// a message ("$(gsd-tools query phase-list)") from reading as a second
// invocation, with no separator lookahead needed.
//
// Beyond the operators, the shell consumes THREE more things before argv
// exists, and each one previously leaked into the token list as a value —
// so `--files >/dev/null 2>&1 || true` (a live tail shape in
// gsd-core/references/execute-phase-requirement-revert.md) scored as scoped
// while the runtime saw files=[] and took the blanket-.planning/ default:
//   - a single `&` is a control operator like `;` (`&&` is checked first);
//   - an unquoted `#` at the START of a word begins a comment and ends the
//     command (mid-word `#` stays literal, as in the shell);
//   - redirections (`> x`, `>> x`, `2>&1`, `< x`, with or without a space
//     before the target) are consumed as `redir: true` tokens, along with a
//     glued all-digit IO number, and consumers exclude them from argv.
// Variable tokens ($VAR / ${VAR}) stay ordinary values DELIBERATELY: whether
// one expands to something is unknowable statically, and the three original
// #2269 fix sites all pass `--files "${PHASE_DIR}/…"` — flagging `$`-tokens
// would false-flag every one of them.
//
// Never throws, and an unterminated quote simply runs to end of input: these
// inputs are substrings sliced out of prose, so a torn quote is expected
// rather than exceptional. Tokens carry offsets so callers can slice the
// ORIGINAL text and report a real excerpt instead of a re-joined echo.
//
// Operators are marked STRUCTURALLY (`op: true`), never re-identified by
// comparing a token's text against the operator set. That distinction is the
// whole point of tokenizing: `commit '|' --files a.md` produces a token
// whose VALUE is `|` and which is ordinary message text, and a consumer that
// matched on value would split there and score a scoped invocation as
// unscoped — the identify-structure-by-text mistake this rewrite exists to
// remove, reintroduced one layer up. (Caught by the delimiter-generating
// property below, on its first run.)
const tokenize = (str) => {
  const tokens = [];
  let cur = '';
  let started = false;
  let start = 0;
  let quote = null;
  // A PER-CHARACTER quote mask, parallel to `cur`: '1' where the character was
  // quoted or backslash-escaped (i.e. protected, therefore data), '0' where it
  // was bare syntax. A per-TOKEN boolean is the obvious shape and it is wrong
  // in the unaffordable direction — `echo "pre"$(gsd_run …)` executes, and a
  // token-wide flag suppresses the strip on it, turning a false positive into
  // a silent false negative.
  let curMask = '';
  const add = (text, protectedChar) => {
    cur += text;
    curMask += (protectedChar ? '1' : '0').repeat(text.length);
  };
  const begin = (i) => {
    if (!started) { started = true; start = i; }
  };
  const flush = (end) => {
    if (started) tokens.push({ value: cur, start, end, qmask: curMask });
    cur = '';
    curMask = '';
    started = false;
  };
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < str.length) { add(str[i + 1], true); i += 1; continue; }
      if (ch === quote) { quote = null; continue; }
      add(ch, true);
      continue;
    }
    if (ch === '\\' && i + 1 < str.length) { begin(i); add(str[i + 1], true); i += 1; continue; }
    if (ch === '"' || ch === "'") { begin(i); quote = ch; continue; }
    if (/\s/.test(ch)) { flush(i); continue; }
    // An unquoted # at the start of a word ends the command line — the rest
    // is comment and never reaches argv. Mid-word (`PR#42`) it is literal.
    if (ch === '#' && !started) { flush(i); break; }
    // Redirections: the operator and its target are consumed by the shell,
    // not passed as arguments. A glued all-digit word is an IO number
    // (`2>&1`) and belongs to the redirection, not to argv.
    //
    // #4276: POSIX recognizes an IO number only when the digit run is
    // UNQUOTED, so the test has to read the quoting and not just the
    // characters. `cur` has already lost that distinction — `"2"` and `2`
    // reach here identically — and `curMask` is where it survives ('0' marks
    // a bare character). Without the mask conjunct a correct
    // `--files "2">out` had its value eaten as an IO number and scored as an
    // unscoped invocation: a false positive on documentation that was right.
    if (ch === '>' || ch === '<') {
      const bareDigitRun = /^[0-9]+$/.test(cur) && /^0+$/.test(curMask);
      if (started && bareDigitRun) { cur = ''; curMask = ''; started = false; } else { flush(i); }
      let j = i + 1;
      if (str[j] === ch) j += 1;                                   // >> / <<
      if (str[j] === '&') j += 1;                                  // >& (2>&1)
      while (j < str.length && /[ \t]/.test(str[j])) j += 1;       // gap before target
      while (j < str.length && !/[\s;|&<>]/.test(str[j])) j += 1;  // the target word
      tokens.push({ value: str.slice(i, j), start: i, end: j, redir: true });
      i = j - 1;
      continue;
    }
    const pair = str.slice(i, i + 2);
    if (pair === '&&' || pair === '||') { flush(i); tokens.push({ value: pair, start: i, end: i + 2, op: true }); i += 1; continue; }
    if (ch === ';' || ch === '|' || ch === '&') { flush(i); tokens.push({ value: ch, start: i, end: i + 1, op: true }); continue; }
    begin(i);
    add(ch, false);
  }
  flush(str.length);
  return tokens;
};

// The comment portion of a line — the same rule tokenize() applies, so the
// two cannot disagree about where the command ends: an unquoted `#` at word
// start begins a comment, and a `#` inside quotes or mid-word is literal
// (ship.md commits with `PR #${PR_NUMBER}` in the message).
// It tracks WORD START the way tokenize does, not "preceded by whitespace".
// Those differ, and the difference is exploitable: in `commit docs:\ # x` the
// backslash escapes the space, so the shell keeps `docs: #` as ONE word and
// `#` is literal — while a preceded-by-whitespace test reads it as a comment.
// The scan would then exempt a line the runtime still executes unscoped.
const commentPortion = (line) => {
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) { started = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { started = true; quote = ch; continue; }
    if (/\s/.test(ch)) { started = false; continue; }
    if (ch === '#' && !started) return line.slice(i);
    if (ch === '>' || ch === '<' || ch === ';' || ch === '|' || ch === '&') { started = false; continue; }
    started = true;
  }
  return '';
};

// The explicit opt-out for content that shows the defect ON PURPOSE. A
// wrong-example is otherwise indistinguishable from a regression — which is
// exactly why no property of the surrounding markup can stand in for the
// author's intent — so the author declares it, with a reason.
//
// IT IS ONLY A MARKER IN COMMENT POSITION. Matching the token anywhere on
// the line let a commit MESSAGE carry it — `commit "docs: explain
// gsd-scan-ignore: semantics"` — and silently exempt a real offender. A
// false-negative escape hatch is the one thing this file must not ship, and
// an exemption keyed to attacker-controlled-looking text is precisely that.
// AND IT MUST CARRY A TRACKING ISSUE. An exemption whose reason is free text
// has no expiry and no ledger — the `permanent-allow-test-rule` shape
// RULESET.TESTS.delete-bad-tests names. The repo already answered this for
// its sibling convention under ADR-456 (see #2269), enforced by
// scripts/lint-allow-test-rule-refs. That lint walks tests/ only, so it
// cannot see a marker living in a .md file; rather than teach a second token
// to a script whose whole contract is the ESLint comment form, this scan
// enforces the same rule over its own roots — it already runs in CI on every
// shard.
//
// THE PREDICATE IS THAT LINT'S, MIRRORED RATHER THAN RESTATED. Its
// ISSUE_REF_RE is `/#\d+|https?:\/\//` — `http://` counts, and `#\d+` has no
// trailing boundary. A hand-written near-copy drifts from it in exactly those
// details, and a contributor who satisfies one marker and not the other has
// been given two conventions wearing one name. (Both details were found by
// review against prose here that claimed HTTPS-only. The regex was right and
// the sentence describing it was not, which is its own lesson.)
const ISSUE_REF_RE = /#\d+|https?:\/\//;
//
// The reason is EXTRACTED, not pattern-matched in one shot, so that a marker
// with no reason at all is still recognized as an ATTEMPT. A rejected
// declaration must not fail as a MYSTERY: left un-exempt and nothing more,
// its author is told their commit is unscoped — a true statement about a line
// they had already explained, which is the mangle-until-it-shuts-up loop the
// marker exists to prevent. `# gsd-scan-ignore:` with an empty reason is the
// likeliest way to get this wrong and so is the case that most needs the
// specific diagnosis; a `\S`-requiring pattern silently drops it.
const SCAN_IGNORE_REASON_RE = /gsd-scan-ignore:(.*)$/;
const declarationReason = (portion) => {
  const m = SCAN_IGNORE_REASON_RE.exec(portion);
  return m === null ? null : m[1];
};
// Two independent conditions, and the second is the structural one: the
// marker must be in comment position AND must not survive tokenization as an
// ARGUMENT. tokenize() drops everything from a real comment onward, so a
// genuine declaration leaves no token carrying the token; anything that does
// reached argv, which means the runtime would have executed it. That makes
// "authored argument text can declare the line exempt" impossible by
// construction rather than by getting commentPortion's edges exactly right —
// and commentPortion has edges (redirection targets, escaped separators)
// where mirroring the tokenizer perfectly is fiddly and a miss is silent.
// The marker's reason, but only when the marker is in COMMENT position and
// survives neither as an argv token. Returns null when there is no attempt.
const declaredReasonFor = (line) => {
  if (tokenize(line).some((t) => /gsd-scan-ignore:/.test(t.value))) return null;
  return declarationReason(commentPortion(line));
};
const isDeclared = (line) => {
  const reason = declaredReasonFor(line);
  return reason !== null && ISSUE_REF_RE.test(reason);
};
// An ATTEMPTED declaration that carries no tracking reference — including one
// with no reason at all. Reported on its own terms rather than silently
// failing to exempt: see the extraction note above.
const isUntrackedDeclaration = (line) => {
  const reason = declaredReasonFor(line);
  return reason !== null && !ISSUE_REF_RE.test(reason);
};

// A shell invoked with -c runs its next argument AS A COMMAND, so the
// invocation lives inside a quoted token and no amount of markup-stripping
// reaches it: `bash -c "gsd_run query commit fixup"` scored zero candidates
// while being perfectly executable. The recursion is keyed on the INVOKER,
// not on "a quoted token that parses as an invocation" — that wider rule
// would flag a commit MESSAGE quoting a command, a false positive against
// ordinary documentation. Here the outer command is bash, so a gsd commit
// message can never reach it.
// The invoker set, widened past the four spellings the first cut guessed at.
// `ash`, `csh`, `tcsh`, `fish` and `yash` all take -c and all run what
// follows; leaving them out is a silent false negative in a function whose
// entire job is reaching a command the tokenizer cannot see.
const SHELL_INVOKER_RE = /^(?:.*\/)?(?:ba|da|k|z|a|c|tc|fi|ya)?sh$/;
const shellDashCPayloads = (str) => {
  const payloads = [];
  let group = [];
  const drain = () => {
    if (!group.length) { return; }
    // THE INVOKER MUST BE THE COMMAND, not merely present in the segment.
    // Searching anywhere made `echo bash -c "gsd_run query commit fixup"` a
    // candidate — `echo` prints the string, it does not run it — which is a
    // false positive against prose that merely quotes a command line. Only an
    // env assignment, a shell keyword, or a list/prompt marker may precede the
    // command name. Those are not commands; `echo` is, which is exactly the
    // line the search-anywhere version got wrong.
    // Shell keywords, prompt/list markers, and the command MODIFIERS that
    // pass straight through to the command after them. The modifiers are the
    // mirror of the invoker-set gap: omitting them is a false negative in the
    // same direction, since `time bash -c "…"` really does run the payload.
    //
    // RESIDUAL, named rather than half-solved: a modifier that takes its OWN
    // flags (`sudo -u alice bash -c …`) still stops the search, because
    // skipping arbitrary flag/value pairs here would mean modelling each
    // modifier's option grammar. No live instance exists in the six roots;
    // the failure is a missed candidate, and the declaration marker is not
    // involved either way.
    const NON_COMMAND_PREFIX = new Set([
      'then', 'else', 'do', '$', '-', '*', '&&', '||',
      'time', 'exec', 'nohup', 'env', 'command',
    ]);
    // AN ASSIGNMENT IS A SKIPPABLE PREFIX ONLY WHEN IT IS NOT A SUBSTITUTION.
    // `FOO=1 bash -c "…"` prefixes the command; `V=$(bash -c "…")` IS the
    // command, and skipping it walks the search past the invoker onto `-c`,
    // which is not one — so the payload is never reached. Found by sweeping
    // the substitution-glues-to-the-binary class across every command-name
    // test rather than only the one the finding named.
    const skippable = (t) => t.redir
      || (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?=/.test(t.value) && !t.value.includes('$('))
      || NON_COMMAND_PREFIX.has(t.value);
    const gi = group.findIndex((t) => !skippable(t));
    if (gi !== -1 && SHELL_INVOKER_RE.test(bareCommandName(group[gi]))) {
      const ci = group.findIndex((t, k) => k > gi && !t.redir && t.value === '-c');
      const payload = ci !== -1 ? group.slice(ci + 1).find((t) => !t.redir) : undefined;
      if (payload) payloads.push(payload.value);
    }
    group = [];
  };
  for (const t of tokenize(str)) {
    if (t.op) { drain(); } else { group.push(t); }
  }
  drain();
  return payloads;
};

module.exports = {
  bareCommandName,
  tokenize,
  shellDashCPayloads,
  SHELL_INVOKER_RE,
  commentPortion,
  ISSUE_REF_RE,
  declarationReason,
  declaredReasonFor,
  isDeclared,
  isUntrackedDeclaration,
};
