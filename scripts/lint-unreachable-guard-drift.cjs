#!/usr/bin/env node
'use strict';

/**
 * Prompt-layer drift guard for #3409 — shell guards that cannot observe
 * their own failure arm.
 *
 * Design:      .gsd/phase/feat-3409-unreachable-shell-guard-lint/40-design.md
 * Test matrix: .gsd/phase/feat-3409-unreachable-shell-guard-lint/50-test-matrix.md
 *
 * RETIRED — Detector A (`--pick` + `|| echo` on one line), #3884.
 * `gsd-tools.cjs`'s `--pick <field>` extractor used to coerce a missing/
 * absent field to the empty string and exit **0**, which made the `|| echo D`
 * arm in `$(gsd_run query V --pick F 2>/dev/null || echo D)` unreachable on
 * field absence — the exact defect Detector A existed to flag (this file's
 * own prior header quoted the premise verbatim: "the `|| echo D` arm can
 * fire only on a typo in the verb name, never on the field absence it was
 * written to handle"). ADR-3473 §8.4 ("Failure is a value") makes `--pick`
 * exit **non-zero** on an absent field (see
 * `.gsd/phase/feat-3884-failure-is-a-value/40-design.md` rows B6-B14), so
 * that premise is now FALSE: the `|| echo D` arm is reachable, and the shape
 * Detector A forbade is the CORRECT idiom going forward. Keeping Detector A
 * would forbid the fix, so it is removed rather than updated — see this
 * file's Guard ledger entry in 40-design.md ("net: −1 detector, 0 added").
 * `docs/how-to/resolve-unreachable-guard-findings.md` Shape A was updated in
 * the same change (#3884) to say the same thing. The three shell guards this
 * file's Detector A shipped alongside (#3365's Walking Skeleton gate,
 * `PHASE_REQ_IDS`, `complete-milestone.md`'s bare `cat <glob>`) were fixed
 * under #3409 with remedies that never took the now-retired shape (a bare
 * `--pick` with no fallback, a two-line `X=…`/`X="${X:-D}"` split, and an
 * array expansion, respectively) — see
 * `tests/unreachable-shell-guard.test.cjs`, which this file does not touch
 * and which #3884 confirmed still passes unchanged.
 *
 * ONE detector remains, unaffected by the above — its mechanism (nullglob
 * success-on-empty) has nothing to do with `--pick`'s exit code:
 *
 *   Detector B — `cat` or `ls` invoked in COMMAND POSITION with an operand
 *   containing an unquoted glob metacharacter (`*` or `?`). At bottom the
 *   same class of bug Detector A used to catch one level up the stack: a
 *   fallback/guard arm that a success-on-empty case silently defeats.
 *   Detector B-ii below is `ls <glob> … || echo` — with `ls`'s own
 *   nullglob-driven success-on-empty standing in for what used to be
 *   `--pick`'s absence-coerced-to-''. SCOPED to exactly three fired shapes,
 *   per a full measurement across the four SCAN_DIRS (measured counts
 *   recorded in the PR description; 0 sites for B-iii today, by design — see
 *   KNOWN LIMITS):
 *
 *     B-i.   `cat <glob>` fires UNCONDITIONALLY. This is the stdin-hang
 *            shape (measured rc=137 at 3s under an unmatched glob +
 *            nullglob): `cat` reads from stdin the moment it gets zero
 *            operands, regardless of what — if anything — consumes its own
 *            exit code. There is no fallback arm to inspect; the hang
 *            happens before one could run.
 *     B-ii.  `ls <glob>` fires when its exit code feeds a REAL fallback:
 *            `… || <arm>` where `<arm>` is not the no-op `true`/`:`. Under
 *            nullglob `ls` SUCCEEDS listing the cwd on an unmatched glob,
 *            so the fallback never runs and the intended message/default is
 *            silently replaced by a directory listing — exactly Detector
 *            A's shape, with `ls`'s exit code standing in for `--pick`'s
 *            stdout.
 *     B-iii. `ls <glob>` fires at the head of an `if`/`elif`/`while` test —
 *            the #3300 "existence guard that is always true under
 *            nullglob" shape the issue names directly: an unmatched glob
 *            makes `ls` list the CWD instead of erroring, so the guard is
 *            always true. Zero sites today (the #3300 fix already removed
 *            them); this arm exists solely so a REINTRODUCED instance of
 *            the shape does not ship silently.
 *
 *   NOT fired on:
 *     - `ls <glob> … || true` / `… || :` — suppressing a failure is not a
 *       guard, and there is no fallback VALUE being defeated (the whole
 *       point of `true`/`:` is "do nothing, either way"). Measured: ~15
 *       sites in this tree, all this exact defensive idiom.
 *     - an `ls <glob>` whose STDOUT is what's consumed (`ls foo/*.md
 *       2>/dev/null`, `X=$(ls -d …)`, `ls … | head`) — neither the stdin
 *       hang nor a defeated fallback nor an always-true guard. Measured: 97
 *       sites, explicitly out of this issue's scope ("Explicit non-goal:
 *       … Only the shapes above move.").
 *     - markdown prose describing either command, INCLUDING the specific
 *       shape `` `Bash(cat << 'EOF')` `` (a heredoc operator immediately
 *       after the command name is never a glob operand — see the heredoc
 *       guard below, and matrix row B8).
 *
 *   `|| echo <default>` vs `|| true`/`|| :` is the discriminator for B-ii,
 *   exactly as `--pick` is Detector A's: both distinguish "a fallback VALUE
 *   this shape can silently defeat" from "no fallback value exists to
 *   defeat, so there is nothing here for nullglob's success-on-empty to
 *   break."
 *
 *   Conservative BY CONSTRUCTION where it still applies (40-design.md's
 *   B10/B11 and "Law of Leaky Abstractions" section): whether a `nullglob`
 *   is in effect is not locally decidable from the line alone, so `cat`
 *   still fires unconditionally (B-i) and `ls`'s two exit-code-consuming
 *   shapes (B-ii, B-iii) still fire regardless of whether a guard already
 *   exists nearby. The remedy (an array expansion, or an existence test
 *   before the read) is correct either way, and array expansions carry no
 *   `*`/`?` character at all so they are never flagged — the detector does
 *   not punish its own fix.
 *
 * Regexes are small, bounded, and non-backtracking BY CONSTRUCTION —
 * `npm run lint:ci` runs CodeQL js/redos over this repo, the same
 * discipline `lint-planning-prompt-drift.cjs` documents in its own header:
 *
 *   - CAT_LS_COMMAND_RE's alternation is a FIXED, non-overlapping set (a
 *     handful of literal command-position anchors, then a fixed
 *     `(cat|ls)`), with one `[ \t]*` quantifier between the anchor and the
 *     command name — again no nesting.
 *   - HEREDOC_AFTER_COMMAND_RE and FALLBACK_TOKEN_RE are each a single
 *     bounded quantifier over a fixed/negated class, same shape as above.
 *   - The B-ii/B-iii "does this clause carry a glob, and what terminates
 *     it" question is answered by `scanClauseAfterCommand`, a plain
 *     LINEAR, single left-to-right character walk — not a regex at all, and
 *     therefore not a ReDoS surface by construction rather than by
 *     argument: it inspects each character of the remainder exactly once
 *     and returns at the first clause-terminating token it finds.
 *   - MARKER_RE (the escape-marker parser) is two more `\s*` quantifiers
 *     over fixed literals, then a single trailing `(.*)$` — again one
 *     quantifier, no nesting.
 *
 * ESCAPE MARKER. A line carrying `# gsd-scan-ignore: <reason>` is exempt
 * ONLY when `<reason>` names an issue (`#NNN`, N a positive integer) or an
 * `http(s)://` URL with an actual host after the scheme — the repo's
 * existing precedent from `tests/commit-files-pathspec.test.cjs`
 * (CONTRIBUTING.md, "Every `commit` invocation in shipped content must
 * declare `--files`"), STARTING from that precedent's predicate
 * (`/#\d+|https?:\/\//`) but DELIBERATELY DIVERGING from it (see
 * `ISSUE_REF_RE`'s own comment for exactly what changed and why) rather than
 * copying it verbatim. The sibling file still carries the looser, unpatched
 * form — this guard's escape hatch is a stricter gate than a commit-message
 * pathspec check needs to be, since an accepted reason here silently
 * exempts a real violation from ever being reported. A marker whose reason is free text, empty, or
 * whitespace-only is reported as a DISTINCT "malformed declaration" error —
 * never silently exempted (that would defeat the guard) and never folded
 * into the ordinary violation list (that would tell an author who already
 * explained themselves that they hadn't, the exact mangle-until-CI-shuts-up
 * loop the marker exists to prevent). Simplification versus the sibling
 * predicate this mirrors: that guard's marker parser tokenizes the whole
 * line to rule out a marker surviving inside quoted argv text (a commit
 * MESSAGE quoting the token). This guard's two detectors never process
 * commit-message-shaped free text, so a plain `#\s*gsd-scan-ignore:` literal
 * match is sufficient here and is not widened to match that guard's
 * quote-awareness it has no corresponding hazard for.
 *
 * RATCHET, not an allowlist. `scripts/baselines/unreachable-guard-drift-baseline.json`
 * mirrors `lint-planning-prompt-drift.cjs`'s shrink-only, count-aware
 * baseline exactly (see that module's header for the full "COUNT, not
 * duplicate rows" rationale) — a recorded `(file, text)` pair acknowledges
 * `count` byte-identical occurrences; fewer this run is a PARTIAL migration
 * (stale), more is an unacknowledged new copy (fresh), zero is a fully
 * migrated pair (stale). Matched on `(file, TRIMMED text)`, never the line
 * number, for the same reason: a workflow `.md` file's line numbers churn on
 * every unrelated edit. Malformed declarations are NEVER ratchet-eligible —
 * they are an authoring mistake in the escape hatch itself, not a
 * migration-in-progress, and always hard-fail (40-design.md's Goodhart's Law
 * section names "run `--update` and record the violation as acknowledged
 * instead of fixing it" as the ratchet's own cheapest gaming path; a
 * malformed marker is exactly the shape of a half-hearted attempt at that,
 * and it is refused rather than laundered into the baseline).
 *
 * SHARED TREE-WALK. `scanTree` / `sanitizeForReport` are consumed from
 * `scripts/lib/drift-scan.cjs`, NOT reimplemented — ADR-3180 Decision 4
 * explicitly rejected "let the new drift guard copy Phase 1's tree-walk",
 * and 40-design.md's Greenspun's Tenth Rule section states the binding
 * consequence plainly: "the 46th guard MUST consume `drift-scan.cjs`, not
 * copy it." See that module for the `toPosixRel`-equivalent rationale
 * (below), the symlink-confinement contract, and the ReDoS-avoidance
 * rationale for its own regex-literal reader (unused by this guard's
 * regexes, which need no literal tokenizer — shared here only for the walk
 * and the report sanitizer).
 *
 * Surfaces scanned (SCAN_DIRS): `gsd-core/workflows`, `commands`, `agents`,
 * `skills` — the prompt-layer markdown that ships to every runtime.
 * SCAN_EXT: `.md` only.
 *
 * KNOWN, ACCEPTED limits (same tradeoffs the sibling guards document):
 *   - Detector B's command-position anchor set (line start; `;`, `&`, `|`,
 *     `(`; the keywords `if`/`then`/`elif`/`while`/`do`) is what lets
 *     `$(cat …)` / `$(ls …)` — the dominant real invocation idiom in this
 *     tree — reach the glob check through the `(` anchor. The heredoc guard
 *     (`HEREDOC_AFTER_COMMAND_RE`) is what keeps that same `(` anchor from
 *     flagging the specific markdown prose shape `` `Bash(cat << 'EOF')` ``
 *     — measured against the real tree, it eliminates every such occurrence
 *     (a heredoc operator immediately after the command name is, by
 *     definition, never a glob operand). A prose sentence that put a real
 *     `*`/`?`-bearing word directly after `cat`/`ls` with NO heredoc
 *     operator between them (unobserved in this tree) would still be a
 *     residual over-flag in the same conservative-by-construction spirit as
 *     B10/B11 — accepted for the same reason: removing the `(` anchor
 *     entirely would blind the guard to most of the real `$(cat …)` sites
 *     it exists to catch, the strictly worse direction (silent false
 *     negative vs. a visible, ratchet-acknowledgeable false positive).
 *   - B-iii's `if`/`elif`/`while` head-position check is per-token, not a
 *     full parse of the conditional's grammar: `if [ -f x ] && ls
 *     glob; then` (a compound condition where `ls` is not literally the
 *     first word after `if`) is not reachable through the keyword anchor
 *     and falls through to B-ii's `||`-fallback check instead, which is the
 *     right outcome only when a `||`-fallback is present that isn't a
 *     no-op. A compound `if` condition ending the `ls` clause with `;`/end
 *     of line and no `||` arm is a genuine, unmeasured (zero observed)
 *     miss — left to code review, matching the design's stated per-line
 *     textual-scan tradeoff throughout.
 *   - The `|| true` / `|| :` no-op carve-out (FALLBACK_TOKEN_RE) inspects
 *     only the FIRST token after `||`; a real fallback dressed up as `||
 *     (true; echo "surprise")` would read as the no-op and miss — no such
 *     shape exists in this tree today (measured), and widening the
 *     no-op-detection is a one-line change if one ever appears.
 */

const fs = require('node:fs');
const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { sanitizeForReport, scanTree } = driftScan;

// ─── Detector B — cat <glob> (B-i), ls <glob> … || <real fallback> (B-ii),
// or ls <glob> at the head of if/elif/while (B-iii) ────────────────────────
//
// Command-position anchor: start of line, a shell separator/opener
// (`;`, `&`, `|`, `(`), or one of the keywords that precede a command
// (`if`, `then`, `elif`, `while`, `do`) — each followed by optional
// horizontal whitespace and then the literal command name. Group 1 captures
// WHICH anchor matched (`''` for start-of-line, since `^` itself consumes no
// characters; the literal separator char; or the literal keyword) so
// detectGlobOperand can tell a true `if`/`elif`/`while` head position (B-iii)
// apart from `then`/`do`/a bare separator, which do not themselves test the
// following command's exit status. Group 2 captures the command name. A
// FIXED alternation with one `[ \t]*` quantifier between the anchor and the
// command name; no nesting, nothing to backtrack.
const CAT_LS_COMMAND_RE = /(^|[;&|(]|\bif\b|\bthen\b|\belif\b|\bwhile\b|\bdo\b)[ \t]*(cat|ls)\b/;

// A heredoc operator immediately after the command name (optional
// horizontal whitespace, then `<<`) is never a glob operand — matrix row B8,
// and the mechanism that keeps the markdown-prose shape `` `Bash(cat <<
// 'EOF')` `` (whose surrounding `**bold**` carries literal `*` characters
// elsewhere on the line) from ever reaching the glob scan at all. Single
// bounded quantifier, no nesting.
const HEREDOC_AFTER_COMMAND_RE = /^[ \t]*<</;

// Only `if`/`elif`/`while` test the command that follows THEM directly —
// `then` and `do` introduce what runs AFTER a test has already passed, not
// the test itself, so they do not, on their own, make `ls`'s exit code the
// thing being consumed (B-iii). `cat` (B-i) never consults this set: it
// fires unconditionally regardless of anchor.
const EXIT_TESTING_KEYWORDS = new Set(['if', 'elif', 'while']);

// The first whitespace/`;`/`)`/`|`/`&`-delimited token of the text
// immediately after a `||` — used to tell a REAL fallback (B-ii) from the
// no-op `true`/`:` idiom (~15 measured sites in this tree, all defensive
// failure-suppression with no fallback value being defeated). Single
// bounded negated-class quantifier, no nesting.
const FALLBACK_TOKEN_RE = /^[ \t]*([^\s;)|&]+)/;

function isNoopFallback(fallbackText) {
  const m = FALLBACK_TOKEN_RE.exec(fallbackText);
  if (!m) return true; // nothing after `||` at all — no fallback value to defeat
  return m[1] === 'true' || m[1] === ':';
}

/**
 * Plain LINEAR left-to-right character walk over `rest` (the line remainder
 * immediately after a cat/ls command match) — not a regex, and therefore
 * not a ReDoS surface by construction. Inspects each character exactly
 * once and returns as soon as it finds a clause-terminating token:
 *   `;`            -> the clause ends with no chain at all.
 *   `&&`           -> a short-circuit "glob matched, so proceed" chain.
 *   `||`           -> a short-circuit fallback chain; `fallback` is
 *                     everything after the `||` (for isNoopFallback to
 *                     classify).
 *   a lone `|`     -> the clause's STDOUT is piped onward (informational,
 *                     never a hazard shape this detector fires on).
 *   a lone `&`     -> backgrounded; not a chain this detector recognizes.
 *   end of string  -> no chain of any kind.
 * `hasGlob` is tracked across the WHOLE walk regardless of where the scan
 * stops, since a `*`/`?` can appear anywhere in the operand region before
 * the terminator.
 */
function scanClauseAfterCommand(rest) {
  let hasGlob = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '*' || ch === '?') { hasGlob = true; continue; }
    if (ch === ';') return { hasGlob, terminator: ';', fallback: null };
    if (ch === '&' && rest[i + 1] === '&') return { hasGlob, terminator: '&&', fallback: null };
    if (ch === '|' && rest[i + 1] === '|') return { hasGlob, terminator: '||', fallback: rest.slice(i + 2) };
    if (ch === '|') return { hasGlob, terminator: '|', fallback: null };
    if (ch === '&') return { hasGlob, terminator: '&', fallback: null };
  }
  return { hasGlob, terminator: null, fallback: null };
}

/**
 * Pure: does `line` carry one of Detector B's three fired shapes? Returns
 * `{ command }` (`cat` or `ls`) or `null`. See the module header for the
 * B-i/B-ii/B-iii scoping and what deliberately does NOT fire.
 */
function detectGlobOperand(line) {
  const anchor = CAT_LS_COMMAND_RE.exec(line);
  if (!anchor) return null;
  const anchorToken = anchor[1];
  const command = anchor[2];
  const rest = line.slice(anchor.index + anchor[0].length);
  if (HEREDOC_AFTER_COMMAND_RE.test(rest)) return null;

  const { hasGlob, terminator, fallback } = scanClauseAfterCommand(rest);
  if (!hasGlob) return null;

  if (command === 'cat') return { command }; // B-i: unconditional.

  // command === 'ls': B-iii (head of a real conditional test) or B-ii (a
  // real, non-no-op `||` fallback). Neither a lone `|` (stdout piped
  // onward) nor `|| true`/`|| :` nor a bare `;`/end-of-line qualifies.
  if (EXIT_TESTING_KEYWORDS.has(anchorToken)) return { command };
  if (terminator === '||' && fallback !== null && !isNoopFallback(fallback)) return { command };
  return null;
}

// ─── Escape marker ─────────────────────────────────────────────────────────
//
// `# gsd-scan-ignore: <reason>`. Two `\s*` quantifiers over fixed literals,
// then a single trailing `(.*)$` — one quantifier, no nesting. Lines are
// split via `/\r?\n/` (see findUnreachableGuardDrift) before this ever runs,
// so `.` never has to reason about a trailing `\r` — the pitfall the CRLF
// coverage in the test matrix (P1-P4) exists to catch.
const MARKER_RE = /#\s*gsd-scan-ignore:\s*(.*)$/;

// DELIBERATE DIVERGENCE from tests/commit-files-pathspec.test.cjs's own
// `ISSUE_REF_RE` (`/#\d+|https?:\/\//`), which this predicate started as a
// copy of. That sibling form validates FORMAT only, and two shapes satisfy
// it while naming nothing real:
//   - `#0` matches `#\d+` (`\d+` allows a leading zero / an all-zero run),
//     silently exempting a violation under a reason that names no positive
//     issue number.
//   - a bare `http://` / `https://` matches `https?:\/\/` with nothing
//     after the scheme — no host, so no URL is actually named.
// Both are closed here: an issue ref requires a POSITIVE integer
// (`#[1-9]\d*` — no leading-zero/all-zero match), and a URL requires at
// least one non-whitespace character after the scheme as its host
// (`https?:\/\/[^\s]+`). This guard's escape hatch is a stricter gate than
// the sibling's commit-message pathspec check needs to be — an accepted
// reason here silently exempts a real violation from ever being reported —
// so the sibling is intentionally left at its own, looser form (not edited
// by this change) rather than tightened to match.
// Still one bounded quantifier per alternative, no nesting: `\d*` over a
// fixed digit class, `[^\s]+` over a fixed negated class. Non-backtracking,
// same as every other regex in this module (see the module header's ReDoS
// section).
const ISSUE_REF_RE = /#[1-9]\d*|https?:\/\/[^\s]+/;

// `scanTree` (scripts/lib/drift-scan.cjs) builds its repo-relative path via
// `path.relative()`, which uses NATIVE separators: on Windows that is
// `gsd-core\workflows\plan-phase.md`, while the committed baseline stores
// POSIX paths. Normalized UNCONDITIONALLY — never gated on
// `process.platform` — for the exact reason `lint-planning-prompt-drift.cjs`
// documents at its own `toPosixRel`: a platform-conditional normalizer is
// itself the bug, since it makes the POSIX path the only tested case
// (PR #3223).
function toPosixRel(relPath) {
  return relPath.replace(/\\/g, '/');
}

// Prompt-layer markdown that ships to every runtime.
const SCAN_DIRS = ['gsd-core/workflows', 'commands', 'agents', 'skills'];
const SCAN_EXT = new Set(['.md']);

const BASELINE_REL_PATH = path.join('scripts', 'baselines', 'unreachable-guard-drift-baseline.json');

// The tracking issue this guard's own baseline entries are owned by, absent
// a more specific site owner named at `--update` time. #3409 is this
// guard's own issue: any Detector B site it finds that this PR does not
// convert is a "one careless line from the same class" per 40-design.md's
// Postel's Law section, tracked here until a per-site conversion lands.
// (Detector A's own entries, if any had ever existed, would have been
// tracked the same way until the upstream `--pick` contract fix landed —
// #3884 — but the baseline shipped with zero Detector A entries; see the
// retirement note at the top of this file.)
const RATCHET_OWNER_ISSUE = '#3409';

/**
 * Pure: scan `text` (one file's content) for Detector B violations and
 * malformed escape-marker declarations. `relPath` is the repo-relative path
 * (native separators or POSIX, either accepted) — normalized via
 * `toPosixRel` and attached as `file` on every result.
 *
 * Returns `{ violations, malformed }`:
 *   - `violations`: `[{ file, line, kind: 'B', found, text }]` — `text` is
 *     the TRIMMED source line (the baseline key), `found` names the
 *     discriminating command (`cat`/`ls`). `kind` is retained as a field
 *     (rather than dropped now that only one detector remains) so the
 *     baseline JSON shape and the `--json` report shape are unchanged by
 *     Detector A's retirement.
 *   - `malformed`: `[{ file, line, text, reason }]` — an ATTEMPTED
 *     `# gsd-scan-ignore:` declaration whose reason names no issue and no
 *     URL. Checked on EVERY line independent of whether that line also
 *     matches a detector (a comment-only malformed declaration is still a
 *     malformed declaration) — never ratchet-eligible.
 *
 * Lines are split on `/\r?\n/` so CRLF input carries no trailing `\r` into
 * either the detector regexes or the baseline key (`text.trim()` would
 * catch most of this anyway, per `String.prototype.trim`'s LineTerminator
 * handling, but MARKER_RE's trailing `(.*)$` specifically needs the split
 * to have already happened — `.` excludes `\r` from its own match).
 */
function findUnreachableGuardDrift(text, relPath) {
  const file = toPosixRel(relPath);
  const violations = [];
  const malformed = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    let exempt = false;
    const markerMatch = MARKER_RE.exec(line);
    if (markerMatch) {
      const reason = markerMatch[1];
      if (ISSUE_REF_RE.test(reason)) {
        exempt = true;
      } else {
        malformed.push({ file, line: lineNo, text: line.trim(), reason: reason.trim() });
        exempt = true; // malformed declarations are reported on their own terms, never as a plain violation too (design A14 / matrix M3-M5)
      }
    }
    if (exempt) continue;

    const globInfo = detectGlobOperand(line);
    if (globInfo) {
      violations.push({ file, line: lineNo, kind: 'B', found: globInfo.command, text: line.trim() });
    }
  }
  return { violations, malformed };
}

/**
 * Scan the prompt-layer markdown tree and return every violation and
 * malformed declaration, each annotated with the repo-relative file path
 * (POSIX-normalized — see `toPosixRel`).
 */
function scanRepo(root) {
  const violations = [];
  const malformed = [];
  scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      const found = findUnreachableGuardDrift(text, rel);
      violations.push(...found.violations);
      malformed.push(...found.malformed);
      return []; // scanTree's own accumulator is unused; we track both lists ourselves so its single flat list is never asked to carry two shapes.
    },
  });
  return { violations, malformed };
}

/**
 * Frozen outcome-reason enum. CONTRIBUTING.md's "Prohibited: Raw Text
 * Matching on Test Outputs" requires a typed structured surface wherever
 * this module produces human-readable text — mirrors
 * `gsd-core/bin/verify-reapply-patches.cjs`'s own `REASON` map exactly:
 * `main()`'s `--json` mode and every `loadBaseline` per-error object carry
 * one of these codes instead of free prose, and tests assert on the code,
 * never on the rendered message. Adding a new reason requires updating this
 * enum, the `--json` emission/`loadBaseline` call site that produces it, AND
 * the test that locks `Object.keys(REASON).sort()` — three coordinated
 * changes that keep the code surface from drifting from the test surface.
 */
const REASON = Object.freeze({
  // main() top-level outcomes (non---update and --update paths).
  OK_NO_VIOLATIONS: 'ok_no_violations',
  OK_BASELINE_UPDATED: 'ok_baseline_updated',
  FAIL_FRESH_VIOLATION: 'fail_fresh_violation',
  FAIL_STALE_ENTRY: 'fail_stale_entry',
  FAIL_MALFORMED_MARKER: 'fail_malformed_marker',
  FAIL_BASELINE_LOAD: 'fail_baseline_load',
  // loadBaseline per-error outcomes — each a distinct baseline-load failure
  // class (mirrors lint-planning-prompt-drift.cjs's loadBaseline validation).
  FAIL_BASELINE_MISSING: 'fail_baseline_missing',
  FAIL_BASELINE_EMPTY: 'fail_baseline_empty',
  FAIL_BASELINE_INVALID_JSON: 'fail_baseline_invalid_json',
  FAIL_BASELINE_NOT_OBJECT: 'fail_baseline_not_object',
  FAIL_BASELINE_ENTRIES_NOT_ARRAY: 'fail_baseline_entries_not_array',
  FAIL_BASELINE_ENTRY_NOT_OBJECT: 'fail_baseline_entry_not_object',
  FAIL_BASELINE_ENTRY_FIELD_INVALID: 'fail_baseline_entry_field_invalid',
  FAIL_BASELINE_ENTRY_COUNT_INVALID: 'fail_baseline_entry_count_invalid',
});

/**
 * Read and parse the ratchet baseline. Returns `{ entries, errors }` —
 * `entries` is `[]` and `errors` is an array of STRUCTURED error objects
 * (`{ reason: REASON.*, message, ... }`) when the file is missing, empty,
 * invalid JSON, or malformed. Mirrors `lint-planning-prompt-drift.cjs`'s
 * `loadBaseline` validation exactly (same failure classes: missing, empty,
 * invalid JSON, non-object JSON — including the `null`/array/scalar cases a
 * bare `typeof === 'object'` check would miss — a non-array `entries`
 * field, and per-entry validation of `file`/`text`/`count`). `message` is a
 * human-readable string for the console formatter only; callers (and
 * tests) must key off `reason`, never parse `message`.
 */
function loadBaseline(root) {
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  if (!fs.existsSync(baselinePath)) {
    return {
      entries: [],
      errors: [{
        reason: REASON.FAIL_BASELINE_MISSING,
        message: `${BASELINE_REL_PATH} is missing — run \`node scripts/lint-unreachable-guard-drift.cjs --update\` to generate it`,
      }],
    };
  }
  const raw = fs.readFileSync(baselinePath, 'utf8');
  if (raw.trim() === '') {
    return {
      entries: [],
      errors: [{ reason: REASON.FAIL_BASELINE_EMPTY, message: `${BASELINE_REL_PATH} is present but empty` }],
    };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return {
      entries: [],
      errors: [{
        reason: REASON.FAIL_BASELINE_INVALID_JSON,
        message: `${BASELINE_REL_PATH} is not valid JSON: ${err.message}`,
        parseError: err.message,
      }],
    };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    const gotType = Array.isArray(doc) ? 'array' : typeof doc;
    return {
      entries: [],
      errors: [{
        reason: REASON.FAIL_BASELINE_NOT_OBJECT,
        message: `${BASELINE_REL_PATH} must be a JSON object, got ${gotType}`,
        gotType,
      }],
    };
  }
  if (!Array.isArray(doc.entries)) {
    return {
      entries: [],
      errors: [{
        reason: REASON.FAIL_BASELINE_ENTRIES_NOT_ARRAY,
        message: `${BASELINE_REL_PATH}: "entries" must be an array, got ${JSON.stringify(doc.entries)}`,
        entriesValue: doc.entries,
      }],
    };
  }
  const errors = [];
  const entries = [];
  doc.entries.forEach((entry, i) => {
    const where = `${BASELINE_REL_PATH}.entries[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({
        reason: REASON.FAIL_BASELINE_ENTRY_NOT_OBJECT,
        message: `${where} must be an object, got ${JSON.stringify(entry)}`,
        index: i,
        where,
      });
      return;
    }
    if (typeof entry.file !== 'string' || entry.file === '') {
      errors.push({
        reason: REASON.FAIL_BASELINE_ENTRY_FIELD_INVALID,
        message: `${where}.file must be a non-empty string, got ${JSON.stringify(entry.file)}`,
        index: i,
        where,
        field: 'file',
        value: entry.file,
      });
      return;
    }
    if (typeof entry.text !== 'string' || entry.text === '') {
      errors.push({
        reason: REASON.FAIL_BASELINE_ENTRY_FIELD_INVALID,
        message: `${where}.text must be a non-empty string, got ${JSON.stringify(entry.text)}`,
        index: i,
        where,
        field: 'text',
        value: entry.text,
      });
      return;
    }
    // `count` is optional on read (diffAgainstBaseline defaults an absent
    // count to 1) but when present must be a positive integer.
    if (entry.count !== undefined && !(Number.isInteger(entry.count) && entry.count >= 1)) {
      errors.push({
        reason: REASON.FAIL_BASELINE_ENTRY_COUNT_INVALID,
        message: `${where}.count must be a positive integer when present, got ${JSON.stringify(entry.count)}`,
        index: i,
        where,
        value: entry.count,
      });
      return;
    }
    entries.push(entry);
  });
  return { entries, errors };
}

/**
 * Diff scanned `violations` against baseline `entries`, matched by the pair
 * (`file`, TRIMMED `text`) — never the line number — and COUNT-aware, same
 * semantics as `lint-planning-prompt-drift.cjs`'s `diffAgainstBaseline`:
 *   - `fresh`: violations whose `(file, text)` pair is not in the baseline
 *     at all, PLUS any occurrences of a KNOWN pair beyond its acknowledged
 *     `count`.
 *   - `stale`: baseline entries whose actual occurrence count this run is
 *     LESS than their acknowledged `count` (zero is the fully-migrated
 *     case; a positive-but-short count is a PARTIAL migration).
 */
function diffAgainstBaseline(violations, baseline) {
  const key = (file, text) => `${file} ${text}`;

  const actualByKey = new Map();
  for (const v of violations) {
    const k = key(v.file, v.text);
    let vs = actualByKey.get(k);
    if (!vs) { vs = []; actualByKey.set(k, vs); }
    vs.push(v);
  }

  const knownKeys = new Set(baseline.map((e) => key(e.file, e.text)));

  const fresh = [];
  const stale = [];

  for (const [k, vs] of actualByKey) {
    if (!knownKeys.has(k)) fresh.push(...vs);
  }

  for (const entry of baseline) {
    const k = key(entry.file, entry.text);
    const expected = entry.count ?? 1;
    const vs = actualByKey.get(k) || [];
    const actual = vs.length;
    if (actual < expected) {
      stale.push({ ...entry, count: expected, actualCount: actual });
    } else if (actual > expected) {
      fresh.push(...vs.slice(expected));
    }
  }

  return { fresh, stale };
}

/** Stable sort: by `file`, then by `text`. */
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.text !== b.text) return a.text < b.text ? -1 : 1;
    return 0;
  });
}

/**
 * Collapse `violations` into one baseline row per distinct (file, text)
 * pair, carrying a `count` of how many occurrences that pair has in THIS
 * run. Pure; no I/O.
 */
function dedupeViolationsForBaseline(violations) {
  const order = [];
  const byKey = new Map();
  for (const v of violations) {
    const k = `${v.file} ${v.text}`;
    let entry = byKey.get(k);
    if (!entry) {
      entry = { file: v.file, text: v.text, kind: v.kind, owner_issue: RATCHET_OWNER_ISSUE, count: 0 };
      byKey.set(k, entry);
      order.push(entry);
    }
    entry.count += 1;
  }
  return order;
}

function writeBaseline(root, violations) {
  const entries = sortEntries(dedupeViolationsForBaseline(violations));
  const doc = {
    $comment:
      '#3409 unreachable-shell-guard ratchet. See scripts/lint-unreachable-guard-drift.cjs. '
      + 'SHRINK-ONLY: entries are removed as sites migrate off the unreachable-arm shape; new or '
      + 'changed entries fail lint:ci. `count` is the number of byte-identical (file, text) '
      + 'occurrences acknowledged at this site — a run producing fewer fails as a partial migration, '
      + 'more fails as an unacknowledged new copy.',
    entries,
  };
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return entries;
}

/**
 * `--json` mode emits ONE structured JSON object to stdout in place of the
 * human formatter below — the typed IR CONTRIBUTING.md's "Prohibited: Raw
 * Text Matching on Test Outputs" requires. The human formatter's wording is
 * untouched (operator console use only); `emitJson` is the only new output
 * surface, gated on `json` so the two never interleave on the same stream.
 */
function main() {
  const root = path.join(__dirname, '..');
  const update = process.argv.includes('--update');
  const json = process.argv.includes('--json');
  const { violations, malformed } = scanRepo(root);

  function emitJson(report) {
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  if (update) {
    if (malformed.length > 0) {
      if (!json) {
        process.stderr.write('unreachable-guard-drift: malformed `# gsd-scan-ignore:` declaration(s) — fix these before regenerating the baseline (they are never ratchet-eligible):\n');
        for (const m of malformed) {
          process.stderr.write(`  ${sanitizeForReport(m.file)}:${m.line}  ${sanitizeForReport(m.text)}\n`);
        }
        process.stderr.write('\n  remedy: the reason after `# gsd-scan-ignore:` must name a tracking issue (#NNN) or an http(s):// URL.\n');
      }
      emitJson({ reason: REASON.FAIL_MALFORMED_MARKER, violations: [], malformed, stale: [], baselineErrors: [] });
      process.exitCode = 1;
      return;
    }
    const entries = writeBaseline(root, violations);
    if (!json) {
      process.stdout.write(`ok unreachable-guard-drift: baseline regenerated with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n`);
    }
    emitJson({ reason: REASON.OK_BASELINE_UPDATED, violations: [], malformed: [], stale: [], baselineErrors: [], updatedEntryCount: entries.length });
    return;
  }

  const { entries: baseline, errors } = loadBaseline(root);
  if (errors.length > 0) {
    if (!json) {
      process.stderr.write('unreachable-guard-drift: baseline load error(s):\n');
      // OUTPUT SEAM: `loadBaseline`'s `message` strings embed
      // `JSON.stringify(entry.file)` / `JSON.stringify(entry.text)` /
      // `JSON.stringify(entry)` verbatim, and `JSON.stringify` escapes only
      // code points below 0x20 — it passes C1 controls (0x7F-0x9F) and the
      // bidi/zero-width controls (U+202E RTL override, U+2066-U+2069,
      // U+2028, U+2029) through UNESCAPED. Without `sanitizeForReport` here, a
      // crafted `entries[].file`/`.text` value in the baseline JSON could
      // land an active bidi override straight into CI console output — the
      // exact report-spoofing class every violation/malformed field below is
      // already routed through `sanitizeForReport` to prevent.
      for (const e of errors) process.stderr.write(`  ${sanitizeForReport(e.message)}\n`);
    }
    emitJson({ reason: REASON.FAIL_BASELINE_LOAD, violations: [], malformed: [], stale: [], baselineErrors: errors });
    process.exitCode = 1;
    return;
  }

  const { fresh, stale } = diffAgainstBaseline(violations, baseline);

  if (fresh.length === 0 && stale.length === 0 && malformed.length === 0) {
    if (!json) {
      process.stdout.write(`ok unreachable-guard-drift: no unacknowledged unreachable shell-guard shapes in the prompt layer (${baseline.length} known)\n`);
    }
    emitJson({ reason: REASON.OK_NO_VIOLATIONS, violations: [], malformed: [], stale: [], baselineErrors: [], knownCount: baseline.length });
    return;
  }

  if (!json) {
    if (fresh.length > 0) {
      process.stderr.write('unreachable-guard-drift: NEW unreachable shell-guard shape(s) found in the prompt layer.\n');
      process.stderr.write('Detector B (cat/ls over a glob operand): under a nullglob set elsewhere in the same shell\n');
      process.stderr.write('session, an unmatched glob reads from stdin (cat) or lists the cwd (ls) — use an array\n');
      process.stderr.write('expansion or an existence test instead.\n');
      process.stderr.write(`Or, if this is a deliberate wrong-example, declare it with # gsd-scan-ignore: #NNN, or add an\n`);
      process.stderr.write(`acknowledged entry to ${BASELINE_REL_PATH} via --update:\n`);
      for (const v of fresh) {
        process.stderr.write(`  ${sanitizeForReport(v.file)}:${v.line}  [${v.kind}]  ${sanitizeForReport(v.found)}  ${sanitizeForReport(v.text)}\n`);
      }
    }

    if (stale.length > 0) {
      process.stderr.write('\nunreachable-guard-drift: STALE baseline entr' + (stale.length === 1 ? 'y' : 'ies') + " (fully migrated, or a PARTIAL migration — fewer occurrences found than acknowledged; delete or re-record the row):\n");
      for (const e of stale) {
        process.stderr.write(`  ${sanitizeForReport(e.file)}  ${sanitizeForReport(e.text)}  (found ${e.actualCount}/${e.count} acknowledged occurrence${e.count === 1 ? '' : 's'})\n`);
      }
      process.stderr.write(`\n  remedy: node scripts/lint-unreachable-guard-drift.cjs --update\n`);
    }

    if (malformed.length > 0) {
      process.stderr.write('\nunreachable-guard-drift: malformed `# gsd-scan-ignore:` declaration(s) — never ratchet-eligible, must be fixed directly:\n');
      for (const m of malformed) {
        process.stderr.write(`  ${sanitizeForReport(m.file)}:${m.line}  ${sanitizeForReport(m.text)}\n`);
      }
      process.stderr.write('\n  remedy: the reason after `# gsd-scan-ignore:` must name a tracking issue (#NNN) or an http(s):// URL.\n');
    }
  }

  const reason = fresh.length > 0
    ? REASON.FAIL_FRESH_VIOLATION
    : stale.length > 0
      ? REASON.FAIL_STALE_ENTRY
      : REASON.FAIL_MALFORMED_MARKER;
  emitJson({ reason, violations: fresh, malformed, stale, baselineErrors: [] });

  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findUnreachableGuardDrift,
  detectGlobOperand,
  scanRepo,
  toPosixRel,
  loadBaseline,
  diffAgainstBaseline,
  dedupeViolationsForBaseline,
  sortEntries,
  writeBaseline,
  CAT_LS_COMMAND_RE,
  HEREDOC_AFTER_COMMAND_RE,
  EXIT_TESTING_KEYWORDS,
  FALLBACK_TOKEN_RE,
  isNoopFallback,
  scanClauseAfterCommand,
  MARKER_RE,
  ISSUE_REF_RE,
  SCAN_DIRS,
  SCAN_EXT,
  BASELINE_REL_PATH,
  RATCHET_OWNER_ISSUE,
  REASON,
};
