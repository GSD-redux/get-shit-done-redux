# `code_review_gate` — report the review and record a per-finding disposition

Read and executed by `execute-phase.md`'s `code_review_gate` step, immediately after code review
returns. It consumes `PHASE_DIR` and `PHASE_NUMBER` and derives everything else.

It lives here rather than inline in the parent because `execute-phase.md` sits against two size
ceilings — the XL hard cap in `tests/workflow-size-budget.test.cjs` and the frozen ADR-857
pre-phase-6 ceiling in `tests/claude-orchestration.test.cjs` — and both are red lines to be kept
under, not budgets to spend.

**What it is for.** The counts the gate prints say how many findings there were, not what happened
to any of them. Without a record, the phase directory carries no answer to *what happened to CR-01*
and a phase can reach `phase.complete` with a Critical standing and no trace it was ever seen.

**Why a sibling artifact rather than a section inside REVIEW.md.** `--auto`'s re-review loop
rewrites REVIEW.md on every iteration, so a ledger kept inside it would not survive the next pass;
and REVIEW.md has a single writer, `gsd-code-reviewer`, which this step is not.

**Advisory — it never blocks.** Every failure path reports and steps over.

**Check results using deterministic path (not glob):**
```bash
# PADDED must survive a DOTTED phase number. Both callers explicitly accept `03.1`
# (code-review.md:60, code-review-fix.md:36 validate `^[0-9]+(\.[0-9]+)?$`), and
# `printf "%02d"` cannot format one: bash prints `invalid number` and exits 1, which under
# `set -euo pipefail` aborts this step on its FIRST line -- the loudest possible failure from
# the gate that promises never to block, and it takes the whole phase's review reporting with
# it. Pad the integer part only and carry the sub-number verbatim, so 3.1 -> 03.1 and 3 -> 03.
# On failure NO path is built and the fence refuses by name: advisory means advisory, and it
# also means never probing a path assembled out of a value we just rejected.
# VALIDATE, THEN FORMAT -- never format and fall back on failure. `printf "%02d" abc` writes
# `00` to stdout BEFORE it fails, so a `$(printf ... || printf %s ...)` fallback CONCATENATES
# the two and yields `00abc`; `08` fails the same way as invalid octal, giving `0008.1` for a
# legitimate `08.1`. Both were driven. `${PHASE_NUMBER:-}` because an UNSET input must not trip
# `set -u` in a step that promises not to abort, and `10#` because bash reads a leading zero as
# octal, which is what breaks 08 and 09.
# VALIDATE THE WHOLE VALUE, then format -- and on failure build NO path at all.
# Carrying an unusable value verbatim was the first draft and it was worse than the bug it
# replaced: PHASE_NUMBER is interpolated into a file path, so `../../etc/passwd` produced
# `${PHASE_DIR}/../../etc/passwd-REVIEW.md`, where the old `printf "%02d"` had at least
# mangled it to `00`. Both callers already validate `^[0-9]+(\.[0-9]+)?$` against their own
# PADDED_PHASE (code-review.md:60, code-review-fix.md:36) -- the padded form, not the raw
# PHASE_NUMBER this step is handed; this step has two call sites and validates for
# itself rather than trusting either. Anything else yields an EMPTY PADDED and the blocks
# below refuse to build a path from it.
# PHASE_DIR is checked for NON-EMPTINESS ONLY. Both inputs come from the caller's init query, so
# neither is raw user input; only PHASE_NUMBER has a SHAPE (`^[0-9]+(\.[0-9]+)?$`, asserted by both
# callers) to check against. A filesystem path admits `..` and symlinked parents alike, so a shape
# check here rejects working setups and proves nothing. Residual: PHASE_DIR may itself be a symlink
# and the ledger is written through it -- left alone, and not a security boundary.
_pd="${PHASE_DIR:-}"
_pn="${PHASE_NUMBER:-}"
_ok=1
[ -n "$_pd" ] || _ok=0
case "$_pn" in
  ''|*[!0-9.]*) _ok=0 ;;   # empty, or any character outside [0-9.] -- this is the traversal fence
  .*|*.)        _ok=0 ;;   # leading or trailing dot
  *.*.*)        _ok=0 ;;   # more than one dot: not the documented shape
esac
# LENGTH-BOUND EACH COMPONENT SEPARATELY. Bash integers wrap at 2^64, so `$((10#$_int))` on a
# 54-digit value yields -7908320945662590977 SILENTLY and that becomes the padded phase. The
# bound belongs on the INTEGER PART: applied to the whole value it rejected `12345678.1`, whose
# integer part is a legal 8 digits, while accepting `1.123456` -- an accidental bound on the
# composite that was both too strict and too loose. The sub-number is bounded too, since it is
# also interpolated into a filename and filesystem components are finite. Both driven.
if [ "$_ok" = "1" ]; then
  case "${_pn%%.*}" in ?????????*) _ok=0 ;; esac
  case "$_pn" in *.*) case "${_pn#*.}" in ?????????*) _ok=0 ;; esac ;; esac
fi
if [ "$_ok" = "1" ]; then
  _int="${_pn%%.*}"
  case "$_pn" in *.*) _sub=".${_pn#*.}" ;; *) _sub="" ;; esac
  # `10#` because bash reads a leading zero as octal, which is what breaks 08 and 09.
  PADDED="$(printf "%02d" "$((10#$_int))")$_sub"
else
  PADDED=""
fi
# REFUSE BEFORE BUILDING ANY PATH. An unusable input yields an empty PADDED above, and the
# earlier placement -- after the assignments -- meant a rejected value still had
# `${_pd}/-REVIEW.md` assembled and stat'ed before the refusal fired. Nothing is constructed
# from a value we have already rejected.
if [ -z "$PADDED" ]; then
  echo "Code review reporting skipped (unusable phase number or directory: '${PHASE_NUMBER:-}')"
  return 0 2>/dev/null || exit 0
fi
REVIEW_FILE="${_pd}/${PADDED}-REVIEW.md"
DISPOSITION_FILE="${_pd}/${PADDED}-REVIEW-DISPOSITION.md"
# Extract ONLY the leading frontmatter block: `sed -n '/^---$/,/^---$/p'` re-opens its range
# on a body `---` and runs to EOF, which leaks body lines into the scan. That leak is benign
# for a key the frontmatter always carries (the first match still wins) but NOT for an
# optional one — a review with no `findings:` block and a body `total:` line would otherwise
# report the body's number as the count. Stop at the closing delimiter instead, and strip CR
# first so a CRLF-authored review neither breaks the delimiter match nor injects a carriage
# return into the message below (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP).
# Buffered, and emitted only if the CLOSING delimiter was actually seen: an unterminated
# frontmatter block would otherwise run to EOF and hand the whole review body to the reads below,
# defeating the scoping entirely.
# Guarded and `|| true`: this step is advisory, so a REVIEW.md that is missing, a directory, or
# otherwise unreadable must leave the counts empty and let execution continue — never abort the
# step under `set -e`/`pipefail`.
REVIEW_FM=""
if [ -f "$REVIEW_FILE" ] && [ -r "$REVIEW_FILE" ]; then
  REVIEW_FM=$(tr -d '\r' < "$REVIEW_FILE" 2>/dev/null | awk 'NR==1{if($0!="---") exit; next} /^---$/{closed=1; exit} {buf = buf $0 "\n"} END{if (closed) printf "%s", buf}' || true)
fi
# `|| true` on every read: under `pipefail` a non-matching `grep` exits 1, and an assignment
# whose command substitution fails aborts the step under `set -e`. An advisory gate must survive
# a REVIEW.md with no frontmatter at all.
REVIEW_STATUS=$(echo "$REVIEW_FM" | grep -m1 "^status:" | cut -d: -f2 | tr -d ' ' || true)
# The counts belong to the `findings:` MAPPING, not merely to the frontmatter, and the scoping now
# goes all the way there. `^[[:space:]]*total:` matches any indented key anywhere in the block, so
# a top-level key later named `total:`, `info:` or `critical:` was picked up ahead of the nested
# one — the extensive comment above is about scoping the frontmatter, and the scoping stopped one
# level short of the mapping the values actually live in. `status:` was never exposed: it is
# anchored to column 0 because it IS top-level.
# The awk selects the `findings:` block and stops at the next column-0 key, so the reads below can
# only see keys nested under it. Block 2 derives REVIEW_TOTAL through the same filter.
# `blocker:` is the documented tier-equivalent of `critical:` (gsd-code-reviewer.md § "Label
# equivalence") — accept either, exactly as code-review.md's present_results already does.
REVIEW_FINDINGS_FM=$(echo "$REVIEW_FM" | awk '/^findings:[[:space:]]*$/{f=1; next} f&&/^[^[:space:]]/{exit} f' || true)
REVIEW_CRITICAL=$(echo "$REVIEW_FINDINGS_FM" | grep -E -m1 "^[[:space:]]*(critical|blocker):" | cut -d: -f2 | tr -d ' ' || true)
REVIEW_WARNING=$(echo "$REVIEW_FINDINGS_FM" | grep -E -m1 "^[[:space:]]*warning:" | cut -d: -f2 | tr -d ' ' || true)
REVIEW_INFO=$(echo "$REVIEW_FINDINGS_FM" | grep -E -m1 "^[[:space:]]*info:" | cut -d: -f2 | tr -d ' ' || true)
REVIEW_TOTAL=$(echo "$REVIEW_FINDINGS_FM" | grep -E -m1 "^[[:space:]]*total:" | cut -d: -f2 | tr -d ' ' || true)
# The breakdown is reportable only when ALL FOUR counts are numbers. Deciding on REVIEW_TOTAL
# alone would still emit `6 findings —  critical` for a review carrying a total and nothing else.
REVIEW_COUNTS_OK=1
for _c in "$REVIEW_TOTAL" "$REVIEW_CRITICAL" "$REVIEW_WARNING" "$REVIEW_INFO"; do
  # Length-bounded as well as digit-only: bash integers wrap at 2^64, so a 20-digit count
  # arrives at the sum below as 0 and an inconsistent breakdown passes. No real review
  # reports nine digits of findings.
  case "$_c" in ''|*[!0-9]*) REVIEW_COUNTS_OK=0 ;; ?????????*) REVIEW_COUNTS_OK=0 ;; esac
done
# Numeric is necessary and not sufficient. `total: 0` beside `critical: 1` is four valid numbers
# that render the self-contradicting line `0 findings — 1 critical, 0 warning, 0 info`. An
# inconsistent breakdown is unavailable for the same reason a partial one is: half-true is worse
# than withheld, and the countless form is already the documented fallback.
# `10#` on every operand: bash infers the base from a leading zero, so a review reporting
# `critical: 08` makes $(( )) fail with "value too great for base" and, under `set -e`, takes
# the whole advisory step down — strictly worse than the half-rendered line this check exists
# to prevent. The values are already digit-only by the loop above.
if [ "$REVIEW_COUNTS_OK" = "1" ] \
   && [ "$((10#$REVIEW_CRITICAL + 10#$REVIEW_WARNING + 10#$REVIEW_INFO))" -ne "$((10#$REVIEW_TOTAL))" ]; then
  REVIEW_COUNTS_OK=0
fi
# EMIT — inside the fence, on every reporting arm. Until this block existed, the fence computed six
# values and printed none of them, and the prose below then asked the agent to display four of them.
# The shell exits at the closing fence and the agent sees only stdout, so those values were
# unobtainable: the message could not be rendered, and the whole block was decorative. That is the
# rule block 2 states about itself — a prose-only gate on a value no later block can see is not a
# gate — applied to the block that is this step's primary deliverable rather than only to its
# sibling. The status arm is re-derived here, not left to the reader, for the same reason.
case "$REVIEW_STATUS" in
  ''|clean|skipped) ;;   # nothing to report; block 2 still reconciles an existing ledger
  *)
    if [ "$REVIEW_COUNTS_OK" = "1" ]; then
      echo "Code review: ${REVIEW_TOTAL} findings — ${REVIEW_CRITICAL} critical, ${REVIEW_WARNING} warning, ${REVIEW_INFO} info."
    else
      # A REVIEW.md written without a `findings:` block has no counts to report, and any count that
      # is empty, non-numeric, over-long or inconsistent makes the whole breakdown unavailable
      # rather than half-filled. Half-true is worse than withheld.
      echo "Code review found issues."
    fi
    echo "Consider running: /gsd:code-review ${PHASE_NUMBER:-} --fix"
    ;;
esac
```

**Display that block's stdout verbatim.** It prints the severity breakdown when all four counts are
numeric and mutually consistent, and the countless form otherwise; on a clean, skipped or absent
review it prints nothing and there is nothing to display. Do not re-derive any of it — a number the
shell computed and did not print is gone once the fence closes, which is precisely the defect this
arm exists to close.

**Record a per-finding disposition.** The counts say how many findings there were, not what
happened to any of them. On the same condition as the message above — REVIEW_STATUS not "clean",
not "skipped" and not empty — write `${DISPOSITION_FILE}`: one row per finding ID, defaulting to
`open`, reconciling `fixed`/`skipped` from REVIEW-FIX.md and preserving any disposition already
recorded, its stated reason included. It is a sibling artifact because `--auto` rewrites
REVIEW.md every iteration and `gsd-code-reviewer` is its single writer. Advisory like the rest of
the step — never blocks:

```bash
# Each fenced block runs in a FRESH shell, so block 1's PADDED/REVIEW_FILE/DISPOSITION_FILE are NOT
# live here — re-derive them from the two inputs this step consumes (`PHASE_DIR`, `PHASE_NUMBER`).
# Inheriting them is not merely stale, it is EMPTY, and the failure is silent rather than loud:
# the embedded script throws on reading the empty review path, the trailing `|| echo` swallows it
# as a non-blocking skip, and no ledger is written at all. The shim preamble below is re-emitted
# for the same reason, and these three belong beside it.
# PADDED must survive a DOTTED phase number. Both callers explicitly accept `03.1`
# (code-review.md:60, code-review-fix.md:36 validate `^[0-9]+(\.[0-9]+)?$`), and
# `printf "%02d"` cannot format one: bash prints `invalid number` and exits 1, which under
# `set -euo pipefail` aborts this step on its FIRST line -- the loudest possible failure from
# the gate that promises never to block, and it takes the whole phase's review reporting with
# it. Pad the integer part only and carry the sub-number verbatim, so 3.1 -> 03.1 and 3 -> 03.
# On failure NO path is built and the fence refuses by name: advisory means advisory, and it
# also means never probing a path assembled out of a value we just rejected.
# VALIDATE, THEN FORMAT -- never format and fall back on failure. `printf "%02d" abc` writes
# `00` to stdout BEFORE it fails, so a `$(printf ... || printf %s ...)` fallback CONCATENATES
# the two and yields `00abc`; `08` fails the same way as invalid octal, giving `0008.1` for a
# legitimate `08.1`. Both were driven. `${PHASE_NUMBER:-}` because an UNSET input must not trip
# `set -u` in a step that promises not to abort, and `10#` because bash reads a leading zero as
# octal, which is what breaks 08 and 09.
# VALIDATE THE WHOLE VALUE, then format -- and on failure build NO path at all.
# Carrying an unusable value verbatim was the first draft and it was worse than the bug it
# replaced: PHASE_NUMBER is interpolated into a file path, so `../../etc/passwd` produced
# `${PHASE_DIR}/../../etc/passwd-REVIEW.md`, where the old `printf "%02d"` had at least
# mangled it to `00`. Both callers already validate `^[0-9]+(\.[0-9]+)?$` against their own
# PADDED_PHASE (code-review.md:60, code-review-fix.md:36) -- the padded form, not the raw
# PHASE_NUMBER this step is handed; this step has two call sites and validates for
# itself rather than trusting either. Anything else yields an EMPTY PADDED and the blocks
# below refuse to build a path from it.
# PHASE_DIR is checked for NON-EMPTINESS ONLY. Both inputs come from the caller's init query, so
# neither is raw user input; only PHASE_NUMBER has a SHAPE (`^[0-9]+(\.[0-9]+)?$`, asserted by both
# callers) to check against. A filesystem path admits `..` and symlinked parents alike, so a shape
# check here rejects working setups and proves nothing. Residual: PHASE_DIR may itself be a symlink
# and the ledger is written through it -- left alone, and not a security boundary.
_pd="${PHASE_DIR:-}"
_pn="${PHASE_NUMBER:-}"
_ok=1
[ -n "$_pd" ] || _ok=0
case "$_pn" in
  ''|*[!0-9.]*) _ok=0 ;;   # empty, or any character outside [0-9.] -- this is the traversal fence
  .*|*.)        _ok=0 ;;   # leading or trailing dot
  *.*.*)        _ok=0 ;;   # more than one dot: not the documented shape
esac
# LENGTH-BOUND EACH COMPONENT SEPARATELY. Bash integers wrap at 2^64, so `$((10#$_int))` on a
# 54-digit value yields -7908320945662590977 SILENTLY and that becomes the padded phase. The
# bound belongs on the INTEGER PART: applied to the whole value it rejected `12345678.1`, whose
# integer part is a legal 8 digits, while accepting `1.123456` -- an accidental bound on the
# composite that was both too strict and too loose. The sub-number is bounded too, since it is
# also interpolated into a filename and filesystem components are finite. Both driven.
if [ "$_ok" = "1" ]; then
  case "${_pn%%.*}" in ?????????*) _ok=0 ;; esac
  case "$_pn" in *.*) case "${_pn#*.}" in ?????????*) _ok=0 ;; esac ;; esac
fi
if [ "$_ok" = "1" ]; then
  _int="${_pn%%.*}"
  case "$_pn" in *.*) _sub=".${_pn#*.}" ;; *) _sub="" ;; esac
  # `10#` because bash reads a leading zero as octal, which is what breaks 08 and 09.
  PADDED="$(printf "%02d" "$((10#$_int))")$_sub"
else
  PADDED=""
fi
# REFUSE BEFORE BUILDING ANY PATH. An unusable input yields an empty PADDED above, and the
# earlier placement -- after the assignments -- meant a rejected value still had
# `${_pd}/-REVIEW.md` assembled and stat'ed before the refusal fired. Nothing is constructed
# from a value we have already rejected.
if [ -z "$PADDED" ]; then
  echo "Code review disposition skipped (unusable phase number or directory: '${PHASE_NUMBER:-}')"
  return 0 2>/dev/null || exit 0
fi
REVIEW_FILE="${_pd}/${PADDED}-REVIEW.md"
DISPOSITION_FILE="${_pd}/${PADDED}-REVIEW-DISPOSITION.md"
# The condition stated above this block is re-derived HERE rather than left to the reader. Block 1
# computes REVIEW_STATUS and emits nothing, and its shell is gone, so nothing downstream can act on
# it: a prose-only gate on a value no later block can see is not a gate. Without this, a clean
# re-review rewrites an existing ledger it was never meant to touch.
REVIEW_STATUS=""
REVIEW_TOTAL=""
if [ -f "$REVIEW_FILE" ] && [ -r "$REVIEW_FILE" ]; then
  _FM=$(tr -d '\r' < "$REVIEW_FILE" 2>/dev/null | awk 'NR==1{if($0!="---") exit; next} /^---$/{closed=1; exit} {buf = buf $0 "\n"} END{if (closed) printf "%s", buf}' || true)
  REVIEW_STATUS=$(echo "$_FM" | grep -m1 "^status:" | cut -d: -f2 | tr -d ' ' || true)
  # The frontmatter total is carried into the script so the two parsers in this step can be
  # RECONCILED. The counts come from the frontmatter; the rows come from `### <ID>:` heading
  # matches against a closed CR|BL|WR|IN alternation. They are two independent numbers produced
  # one paragraph apart, and nothing compared them: a finding the heading parser cannot match
  # contributed no row, no note and no diagnostic, and the ledger then asserted `open: 3 of 3`
  # over a set strictly smaller than the console line had just reported. Anchored inside the
  # `findings:` mapping — see the anchoring note in block 1 — and digit-only, because a
  # non-numeric total is not a number to reconcile against.
  REVIEW_TOTAL=$(echo "$_FM" | awk '/^findings:[[:space:]]*$/{f=1; next} f&&/^[^[:space:]]/{exit} f' | grep -E -m1 "^[[:space:]]*total:" | cut -d: -f2 | tr -d ' ' || true)
  case "$REVIEW_TOTAL" in ''|*[!0-9]*) REVIEW_TOTAL="" ;; ?????????*) REVIEW_TOTAL="" ;; esac
fi
# Skip a clean/skipped/absent review ONLY when there is nothing to reconcile AT ALL. An EXISTING
# ledger is still brought up to date -- freezing it would leave findings showing open that the
# review no longer reports, and an unconditional skip would make the reconciliation path
# unreachable on exactly the run that needs it.
# A FIX REPORT IS THE SECOND REASON TO PROCEED: a direct `/gsd:code-review N --auto` writes no gate
# ledger and a converged loop leaves `status: clean`, so a fully fixed phase recorded nothing.
_fix_any=0
[ -f "${_pd}/${PADDED}-REVIEW-FIX.md" ] && _fix_any=1
# Backups count too -- a converged loop's earlier iterations live only there. An unmatched glob
# expands to the literal pattern, which `-f` rejects.
# $(printf '%s' "$PADDED") per lint-workflow-shellcheck's #4109 remedy: a bare $VAR in a `for x in`
# splits differently under bash and zsh.
for _f in "${_pd}/$(printf '%s' "$PADDED")-REVIEW-FIX.iter"*.md; do [ -f "$_f" ] && _fix_any=1; done
case "$REVIEW_STATUS" in
  ''|clean|skipped)
    if [ ! -f "$DISPOSITION_FILE" ] && [ "$_fix_any" = "0" ]; then
      echo "Code review disposition skipped (status: ${REVIEW_STATUS:-none})"
      return 0 2>/dev/null || exit 0
    fi
    echo "Code review ${REVIEW_STATUS:-unreported}; reconciling the fix report and any existing disposition ledger."
    ;;
esac
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# Built before the command for READABILITY, not as a fix. ShellCheck's SC2097/SC2098 here is a FALSE
# POSITIVE: prefix assignments take effect left to right (driven, bash and dash).
FIX_REPORT_FILE="${_pd}/${PADDED}-REVIEW-FIX.md"
REVIEW_FILE="${REVIEW_FILE}" DISPOSITION_FILE="${DISPOSITION_FILE}" PADDED="${PADDED}" \
REVIEW_TOTAL="${REVIEW_TOTAL}" \
FIX_REPORT_FILE="${FIX_REPORT_FILE}" node -e "
  // EVERYTHING BELOW RUNS INSIDE main() AND LEAVES BY return, NEVER an explicit exit call. The script
  // prints its one-line verdict and then ends; with an explicit exit directly after console.log,
  // the exit can pre-empt the write when stdout is a pipe or socket (Node documents those writes
  // as asynchronous on POSIX), and the caller then sees an exit 0 with NO verdict line. A
  // hardening against that documented hazard, not a reproduced defect: the 'unchanged' branch was
  // the only one that exited explicitly, and the empty stdout that first pointed at it turned out to
  // be a reviewing sandbox's own. A function that returns lets the event loop drain stdout before
  // the process ends. Same exit status either way.
  (function main() {
  const fs = require('fs'), path = require('path');
  const norm = (s) => s.replace(/\r\n/g, '\n');
  // AN EXISTING LEDGER THAT IS NOT A REGULAR FILE IS NOT A LEDGER. Checked FIRST, before any read
  // or write of that path, and the ordering is the fix rather than a tidy-up:
  //   * writeFileSync FOLLOWS a symlink, so a planted link replaced the contents of whatever it
  //     pointed at -- outside the phase directory, link left intact so nothing looked wrong;
  //   * a FIFO at that path made readFileSync BLOCK FOREVER, which is the one behaviour a gate
  //     documented as advisory and non-blocking must never have;
  //   * and the unchanged-run fast path read the file before the check, so a symlink whose
  //     target already matched slipped through reporting 'unchanged'.
  // All three driven. lstatSync does not follow the link, which is why it is the right call.
  // NAMED RESIDUAL, not silently accepted: this is a check-then-write, so a symlink planted
  // between the lstat and the write still wins. Node exposes no portable O_NOFOLLOW write, and
  // an attacker who can write into the phase directory mid-run already has what the check would
  // protect. It narrows a real accident; it is not a security boundary, and the docs do not
  // claim one. A hard link likewise passes isFile() by construction.
  if (fs.existsSync(process.env.DISPOSITION_FILE) && !fs.lstatSync(process.env.DISPOSITION_FILE).isFile()) {
    console.log('Code review disposition skipped: ' + process.env.DISPOSITION_FILE + ' exists and is not a regular file; refusing to read or write through it.');
    return;
  }
  // Captures the id AND the title: the title is what tells a stale fix report apart from a
  // current one, because finding ids are reused across re-reviews.
  const ID_RE = /^###\s+((?:CR|BL|WR|IN)-\d+)\s*:\s*(.*)\$/;
  // BL- is Critical-tier-equivalent to CR- (gsd-code-reviewer.md 'Label equivalence').
  const sectionSev = new Map();
  // PREFIX severity -- the fallback, used when the finding sat under no recognized section (a
  // carried row from an earlier review, or a review that does not use the documented headings).
  const prefixSev = (id) => ({ CR: 'critical', BL: 'critical', WR: 'warning' }[id.split('-')[0]] || 'info');
  const sev = (id) => sectionSev.get(id) || prefixSev(id);
  const headings = (text) => {
    // Fenced blocks are skipped: review and fix bodies quote example findings, and a heading
    // inside a fence is an illustration, not a finding.
    const out = [];
    // The OPEN fence's marker is remembered, not just the fact of being fenced. A bare toggle
    // treats every fence marker as interchangeable, so a ~~~ line inside a \` \` \` block CLOSES it
    // and the block's real close REOPENS one — which silently swaps a fenced example for the
    // real findings around it. Driven: a review quoting ~~~ inside a fenced example recorded
    // the EXAMPLE's id and dropped the real finding entirely. Per CommonMark, a fence closes
    // only on the same character, at least as long as the one that opened it.
    let fence = null;
    for (const l of norm(text).split('\n')) {
      const f = l.match(/^ {0,3}(\`{3,}|~{3,})/);   // >3 spaces is an indented block, not a fence
      if (f) {
        const ch = f[1][0], len = f[1].length;
        if (!fence) { fence = { ch: ch, len: len }; out.push({ fence: true }); continue; }
        // A CLOSER carries nothing but whitespace after the marker; an info string makes it
        // an opener's shape, never a close.
        if (ch === fence.ch && len >= fence.len && /^\s*\$/.test(l.slice(l.indexOf(f[1]) + f[1].length))) {
          fence = null; out.push({ fence: true }); continue;
        }
        out.push({ skip: true, line: l }); continue;   // a foreign marker inside a fence is content
      }
      if (fence) { out.push({ skip: true, line: l }); continue; }
      const m = l.match(ID_RE);
      out.push(m ? { id: m[1], title: m[2].trim(), line: l } : { line: l });
    }
    return out;
  };
  const order = [], title = new Map();
  // An ABSENT review still has a ledger to reconcile: the step's own guard proceeds when
  // one exists, and throwing here would send that run to the trailing non-blocking fallback
  // with the
  // ledger untouched -- the freeze the reconciliation path exists to prevent.
  const reviewText = fs.existsSync(process.env.REVIEW_FILE) ? fs.readFileSync(process.env.REVIEW_FILE, 'utf-8') : '';
  // SEVERITY COMES FROM THE SECTION FIRST, the id prefix second. The section heading is the
  // reviewer's OWN statement of a finding's severity -- gsd-code-reviewer.md emits findings under
  // '## Critical Issues' / '## Warnings' / '## Info' -- and this walker already visits every line,
  // so the signal was in hand and discarded. Deriving from the prefix alone means a reviewer who
  // mis-numbers a Critical as WR-04 while filing it under '## Critical Issues' gets a ledger row
  // reading 'warning', which then disagrees with the review it summarizes AND with the frontmatter
  // count line block 1 prints from findings.critical. The Severity column is the whole basis for
  // triaging the ledger, so it has to agree with the document it describes.
  // Matched WHOLE, exactly as the fix-report sections are: a prefix match would let a heading like
  // '## Critical Issues Verification' re-tier everything under it.
  const SECTION_SEV = [[/^##\s+Critical Issues\s*\$/, 'critical'], [/^##\s+Warnings\s*\$/, 'warning'], [/^##\s+Info\s*\$/, 'info']];
  let curSection = null;
  for (const h of headings(reviewText)) {
    if (h.fence || h.skip) continue;
    if (h.line !== undefined && /^##\s+/.test(h.line)) {
      const hit = SECTION_SEV.find(([re]) => re.test(h.line));
      curSection = hit ? hit[1] : null;   // an unrecognized ## section falls back to the prefix
    }
    if (h.id && order.indexOf(h.id) === -1) {
      order.push(h.id); title.set(h.id, h.title);
      if (curSection) sectionSev.set(h.id, curSection);
    }
  }
  // THE FIX REPORTS THIS RUN MAY RECONCILE AGAINST. --auto overwrites REVIEW-FIX.md each iteration
  // and the re-review drops what was fixed, so an iteration-1 fix is in NEITHER final artifact.
  // Read the backups too, newest first.
  const FIX_FINAL = process.env.FIX_REPORT_FILE;
  const fixStem = path.basename(FIX_FINAL).slice(0, -3);        // '<NN>-REVIEW-FIX'
  const iterMarker = fixStem + '.iter';
  // String ops, not a built RegExp: every backslash is one more thing bash rewrites first.
  // ONE expression, no 'return': ShellCheck lints this fence as shell and would mark the rest
  // unreachable (SC2317) against a ratchet baseline.
  const iterDigits = (n) => (n.indexOf(iterMarker) === 0 && n.slice(-3) === '.md') ? n.slice(iterMarker.length, -3) : '';
  const iterOf = (n) => /^[0-9]+\$/.test(iterDigits(n)) ? Number(iterDigits(n)) : null;
  const fixReports = [];
  if (fs.existsSync(FIX_FINAL)) fixReports.push(FIX_FINAL);
  let iterFiles = [];
  // Guarded: the phase directory is not guaranteed readable, and this step never aborts.
  try { iterFiles = fs.readdirSync(path.dirname(FIX_FINAL)).map((n) => [iterOf(n), n]).filter((e) => e[0] !== null); } catch (e) { iterFiles = []; }
  iterFiles.sort((a, b) => b[0] - a[0]);
  for (const e of iterFiles) fixReports.push(path.join(path.dirname(FIX_FINAL), e[1]));
  // A review that reports nothing still has to reconcile an EXISTING ledger: its decided rows
  // and its untriaged rows are BOTH carried, marked. Exiting here would freeze a stale ledger
  // showing findings as open that the review no longer reports.
  // A fix report with no ledger is also something to record: a converged '--auto' run has neither,
  // and exiting here recorded nothing for a fully fixed phase.
  if (order.length === 0 && !fs.existsSync(process.env.DISPOSITION_FILE) && fixReports.length === 0) return;
  // Prior rows: keep the disposition AND its source cell — the source is where a human writes
  // the reason a finding was deferred, and rewriting it would discard the very thing the
  // 'set deferred by hand, with the reason' instruction asks for. The Source cell is the LAST
  // column, so it is captured through to the end of the line, less an optional trailing pipe:
  // a bare | inside it is prose, not a column break. The previous capture admitted a pipe only
  // when escaped, and the whole-line match then FAILED on a bare one -- a human who wrote
  // 'waiting on team A | team B' as a deferral reason had the row not match at all, the finding
  // reset to open, and the reason destroyed: a triaged Critical rendered indistinguishable from
  // one never seen, off an ordinary typo in the one field this ledger asks a human to hand-edit.
  // The render below escapes a bare pipe on the next write, so the file converges to the escaped
  // form either way. The trailing pipe is optional so a hand-mangled row loses no decision.
  const prior = new Map();
  // TITLES, IN THE FRONTMATTER. Ids are reused across re-reviews (--auto renumbers), so an id alone
  // does not identify a finding: driven, a prior 'CR-01 fixed' rendered a brand-new CR-01 'fixed'.
  // Not a fifth table column -- the Source cell is already the hand-edited, pipe-escaping one.
  const priorTitle = new Map();
  // Ids whose decision could not be carried: the id now names a DIFFERENT finding. REPORTED, not
  // re-homed -- rows key on the id, and two under one id is an ambiguity. The note does NOT claim the
  // old row is in git: committing is gated on commit_docs. See docs/features/code-review-pipeline.md.
  const reused = [];
  var _fmId = null, _fmSec = null;
  // Set when the ledger declares JSON scalars; without it they are bare. Load-bearing: a legacy title
  // that merely LOOKED like JSON was parsed, lost its quotes, and flipped to open.
  var _fmJson = false;
  if (fs.existsSync(process.env.DISPOSITION_FILE)) {
    for (const l of norm(fs.readFileSync(process.env.DISPOSITION_FILE, 'utf-8')).split('\n')) {
      // The disposition column is an ENUM, not 'any lowercase token'. ADR-227 requires a trust
      // boundary to validate semantic SHAPE, not merely type, and to coerce a failure to the
      // contract's safe default -- and this ledger is a trust boundary by construction, because
      // the rendered instruction tells a human to hand-edit it. Under the old ([a-z]+) capture a
      // single transposed character ('opne') was stored as a decision: it is not 'open', so it
      // beat the default, was excluded from the open: headline count, and was carried forward
      // forever. One typo and the ledger reported a phase fully triaged.
      // Note the asymmetry that made this a correctness bug rather than a style point: a typo
      // OUTSIDE [a-z] ('Deferred') already failed to match, lost the decision and reset the row
      // to open -- safe. A typo INSIDE [a-z] was unsafe. The parser failed open in the one
      // direction that matters. A row that does not match now yields no prior entry, so the row
      // falls back to 'open' -- the safe default, by the same path the capital-D case took.
      const m = l.match(/^\|\s*((?:CR|BL|WR|IN)-\d+)\s*\|[^|]*\|\s*(open|fixed|skipped|deferred)\s*\|\s*(.*?)\s*\|?\s*\$/);
      // Strip the carried marker before storing: it is rendered from the carried flag, so
      // leaving it on the stored value would re-append it every run — the cell grows without
      // bound AND the file changes on every run, defeating the unchanged-run check below.
      // Strip AT MOST ONE trailing marker, unconditionally. Storing the cell verbatim looked
      // like the way to stop the strip eating human text, and it introduced a worse defect:
      // once the generated marker is stored it can never leave, so a carried finding that
      // REAPPEARS in a later review still renders 'not in the current review' -- a ledger that
      // is now factually wrong about its own contents. The residual ambiguity is irreducible
      // (a reason ending in exactly that phrase is indistinguishable from the marker) and it
      // costs nothing real: on a carried row the render puts the phrase straight back, and on a
      // current row the phrase was self-contradictory to begin with. The unbounded quantifier is
      // what had to go, not the strip itself.
      if (m) prior.set(m[1], { d: m[2], src: m[3].replace(/\s*\(not in the current review\)\s*\$/, '') });
      // Frontmatter is walked in the same pass, as a SECTIONED list rather than by one line shape.
      if (/^titles: json\s*\$/.test(l)) { _fmJson = true; continue; }
      var msec = l.match(/^(findings):\s*\$/);
      if (msec) { _fmSec = msec[1]; _fmId = null; continue; }
      var mi = l.match(/^  - id: ((?:CR|BL|WR|IN)-\d+)\s*\$/);
      if (mi && _fmSec) { _fmId = mi[1]; continue; }
      var mkv = l.match(/^    title: (.*)\$/);
      if (mkv && _fmId && _fmSec === 'findings') {
        var _v = mkv[1];
        if (_fmJson) { try { _v = JSON.parse(_v); } catch (e) { /* keep the raw scalar */ } }
        priorTitle.set(_fmId, _v);
        continue;
      }
    }
  }
  // TITLE COMPARISON, and its FALSE-POSITIVE mode, which was previously unacknowledged.
  // The strict instinct is right -- ids are reused across re-reviews, so a stale REVIEW-FIX.md
  // must not mark a brand-new CR-01 as already fixed -- but gsd-code-fixer.md writes
  // '### {finding_id}: {title}' under no contract that the title is copied byte-for-byte from
  // REVIEW.md. A fixer that REFLOWS a long title produced a spurious stale note, left a
  // genuinely-fixed row 'open', and told the reader the fix report named a different finding.
  // Runs of whitespace are collapsed because re-spacing carries no information. The BOUND, stated
  // because it is easy to over-read this: a title WRAPPED across lines is NOT reconciled. A '###'
  // heading is one line by definition, so the continuation is a separate paragraph the heading
  // parser correctly never captures, and collapsing whitespace cannot reach across that boundary.
  // Not widened -- absorbing whatever follows a heading into the title would swallow arbitrary
  // prose and make this very check meaningless. Case changes and truncation stay strict too --
  // they are the shapes a genuinely different finding actually takes, and widening to them would
  // trade this false positive for the silent false NEGATIVE the strict match exists to prevent.
  // Residual, stated: a fixer that re-cases or truncates still produces a spurious note. That is
  // the safe direction (a visible note, not a silent wrong 'fixed'), and the note's wording below
  // no longer asserts which of the two it is.
  const sameTitle = (a, b) => String(a === undefined ? '' : a).replace(/\s+/g, ' ').trim()
                           === String(b === undefined ? '' : b).replace(/\s+/g, ' ').trim();
  // Section headings are matched WHOLE: a prefix match would let '## Fixed Issues Verification'
  // classify every finding under it as fixed.
  const applied = new Map(), staleFix = [];
  for (const fixPath of fixReports) {
    let sect = null;
    for (const h of headings(fs.readFileSync(fixPath, 'utf-8'))) {
      if (h.fence || h.skip) continue;
      if (/^##\s+Fixed Issues\s*\$/.test(h.line)) { sect = 'fixed'; continue; }
      if (/^##\s+Skipped Issues\s*\$/.test(h.line)) { sect = 'skipped'; continue; }
      if (/^##\s+/.test(h.line)) { sect = null; continue; }
      // First occurrence wins, so an id listed under BOTH sections is not decided by row order.
      // And the fix report must name the SAME finding: ids are reused across re-reviews, so a
      // stale REVIEW-FIX.md would otherwise mark a brand-new CR-01 as already fixed.
      // A title mismatch is the STALE-report case and must not pass silently: the id is
      // reused, the finding is not, and a reader who sees the row stay 'open' has no way to
      // tell that from 'the fix report never mentioned it'. Record it and say so below.
      if (h.id && sect && !applied.has(h.id)) {
        // THREE ARMS. An id the review does not report has no title to disagree with -- not the
        // stale-report case, but what a finding looks like once acted on; the old form dropped it
        // silently. Reuse stays closed below. The record carries the originating report and title.
        var _acted = { d: sect, src: path.basename(fixPath), t: h.title };
        if (!title.has(h.id)) applied.set(h.id, _acted);
        else if (sameTitle(title.get(h.id), h.title)) applied.set(h.id, _acted);
        else if (staleFix.indexOf(h.id) === -1) staleFix.push(h.id);
      }
    }
  }
  // Precedence: an applied outcome is evidence of an action on code and wins; a recorded
  // non-'open' decision wins over the default. 'open' never overwrites a decision.
  // Inherited only while the id names the SAME finding. An ABSENT prior title inherits: a
  // pre-titles ledger has none, and refusing would reset every decision in it.
  const sameFinding = (id) => !priorTitle.has(id) || !title.has(id) || sameTitle(priorTitle.get(id), title.get(id));
  const row = (id) => {
    if (applied.has(id)) { const a = applied.get(id); return { id, sev: sev(id), d: a.d, src: a.src, t: title.has(id) ? title.get(id) : a.t }; }
    const was = prior.get(id);
    if (was && was.d !== 'open' && sameFinding(id)) return { id, sev: sev(id), d: was.d, src: was.src || 'recorded', t: title.get(id) };
    // Reused id: the NEW finding is untriaged and renders 'open'; the prior decision loses its row,
    // and that is REPORTED.
    if (was && was.d !== 'open' && reused.indexOf(id + '=' + was.d) === -1) reused.push(id + '=' + was.d);
    return { id, sev: sev(id), d: 'open', src: '-', t: title.get(id) };
  };
  const rows = order.map(row);
  // A prior finding the current review no longer reports is CARRIED, never dropped -- and that
  // now holds for UNTRIAGED rows too, which is the correction. Carrying only decided rows meant
  // an untriaged row for a dropped or renumbered finding disappeared without trace, and combined
  // with the reconciliation gap that left EVERY row untriaged, a re-review silently deleted the
  // whole ledger. The --auto loop rewrites REVIEW.md on every iteration, so it does not retain it
  // either: run 1 records CR-01 open, the re-review renumbers it to CR-02, and run 2's ledger
  // contains neither. That is #3829's complaint verbatim -- 'no trace of what happened to them' --
  // reproduced by the artifact built to prevent it, and 'nothing was decided about it' is exactly
  // the state #3829 says must leave a trace.
  // The carried marker is what keeps this honest rather than merely additive: the row does not
  // claim the finding is live, it records that it was seen and never triaged. Stated cost, since
  // it is real: a RENUMBERED finding appears twice until someone triages the old row, and a
  // carried untriaged row persists across runs until decided. Both are bounded by the phase's own
  // findings, both are legible from the marker, and both are strictly better than a silent delete.
  // Prior rows UNION ids a fix report decided that the review no longer reports: a decision the
  // ledger cannot render is a decision lost. Precedence matches row() -- applied beats recorded.
  const carriedIds = [];
  for (const id of prior.keys()) if (order.indexOf(id) === -1 && carriedIds.indexOf(id) === -1) carriedIds.push(id);
  for (const id of applied.keys()) if (order.indexOf(id) === -1 && carriedIds.indexOf(id) === -1) carriedIds.push(id);
  for (const id of carriedIds) {
    const act = applied.get(id), was = prior.get(id);
    const d = act ? act.d : (was ? was.d : 'open');
    const src = act ? act.src : (was && was.src) || (d === 'open' ? '-' : 'recorded');
    // Title precedence: the report that DECIDED it, then the prior ledger. A carried row is absent
    // from the review, so one of those two is the only record of it.
    // typeof, not ||: an empty title is FALSY, and the truthy fallback discarded it -- reading back
    // as a pre-format ledger and reopening the leak.
    const kt = act && typeof act.t === 'string' ? act.t : priorTitle.get(id);
    rows.push({ id, sev: sev(id), d: d, src: src, t: kt, carried: true });
  }
  const open = rows.filter((r) => r.d === 'open').length;
  // Surfaced, not thrown: the gate is advisory. But a fix report naming a finding whose title
  // no longer matches is the one case where 'open' understates what is known, so it is stated.
  // The wording no longer ASSERTS a stale report. Both causes reach here -- a genuinely different
  // finding under a reused id, and a fixer that re-titled the same one -- and the step cannot tell
  // them apart, so it reports the observation rather than a conclusion it has not earned.
  // On the console too, for a reader who never opens the ledger.
  const reusedNote = reused.length ? ' (' + reused.length + ' recorded decision(s) DROPPED -- the id now names a different finding, so the decision no longer has a row: ' + reused.join(', ') + ')' : '';
  const staleNote = staleFix.length ? ' (' + staleFix.length + ' fix-report entr' + (staleFix.length === 1 ? 'y titles its' : 'ies title their') + ' finding differently from the review, so ' + (staleFix.length === 1 ? 'it was' : 'they were') + ' not reconciled -- a stale report, or a re-titled one: ' + staleFix.join(', ') + ')' : '';
  // RECONCILE THE TWO PARSERS. The counts come from REVIEW.md's frontmatter; the rows come from
  // heading matches against a CLOSED CR|BL|WR|IN alternation. A finding the heading parser cannot
  // match -- a fifth prefix, a missing ': ' separator, a '#### ' heading -- contributed no row, no
  // note and no diagnostic, and the ledger then declared 'open: 3 of 3' over a set strictly
  // smaller than the console line reported one paragraph earlier. Two findings recorded nowhere,
  // and neither artifact said so.
  // The earlier argument for the closed alternation -- that an unlisted prefix produces no row
  // rather than a MIS-CLASSIFIED one -- is the wrong trade under this repo's own fail-safe rule:
  // a dropped finding is demoted below every finding that parsed, and an unparseable finding is
  // precisely the one a human most needs to see. Surfaced, not thrown, exactly as the stale
  // fix-report case above is: the gate stays advisory and states the shortfall.
  const declaredTotal = /^[0-9]+\$/.test(process.env.REVIEW_TOTAL || '') ? Number(process.env.REVIEW_TOTAL) : null;
  // Against order.length -- the CURRENT review's findings -- never rows.length, which also counts
  // rows carried from earlier reviews and would understate the shortfall or invent one.
  const unparsed = declaredTotal !== null && declaredTotal > order.length ? declaredTotal - order.length : 0;
  const unparsedNote = unparsed ? ' (' + unparsed + ' finding(s) recorded NOWHERE: the review reports ' + declaredTotal + ', but only ' + order.length + ' matched the expected heading shape \`### <CR|BL|WR|IN>-NN: <title>\`)' : '';
  if (rows.length === 0 && !fs.existsSync(process.env.DISPOSITION_FILE)) return;
  // A bare | in a Source cell is escaped on render so the table stays a table. Scanned as PAIRS,
  // not by the preceding character: an escaped pair (backslash + anything) is kept verbatim and only
  // a pipe outside one is escaped. The previous form, /(^|[^\\\\])\|/g, CONSUMED the character before
  // the pipe, so adjacent bare pipes were escaped one per run (A||B -> A\\||B -> A\\|\\|B, a third run
  // to converge) and an escaped backslash before a pipe (A\\\\|B) hid the pipe behind the wrong
  // parity and left it bare. Found by the round-3 adversarial pass, not by the property -- whose
  // generator then emitted at most one bare pipe, the one case the old form got right; it now
  // reaches adjacent pipes and both backslash parities, against an independent parity oracle.
  const escapePipes = (t) => t.replace(/\\\\.|\|/g, (m) => (m === '|' ? '\\\\|' : m));
  const body = ['# Phase ' + process.env.PADDED + ': Code Review Disposition', '', '| Finding | Severity | Disposition | Source |', '|---------|----------|-------------|--------|']
    .concat(rows.map((r) => { const src = escapePipes(r.src || '-'); const mark = r.carried && !/\(not in the current review\)\s*\$/.test(src) ? ' (not in the current review)' : ''; return '| ' + r.id + ' | ' + r.sev + ' | ' + r.d + ' | ' + src + mark + ' |'; }))
    .concat(['', 'Dispositions: \`open\` (recorded, not yet triaged), \`fixed\`, \`skipped\`, \`deferred\`.', 'Set \`deferred\` by hand and put the reason in the Source cell; both are preserved. A \`|\` in the reason is kept as prose and escaped on the next run.', 'Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but \`open\`) is named on the console when that happens; a row still at \`open\` is replaced silently, because \`open\` records no decision to lose.', '']).join('\n');
  // One line: the value feeds a line-oriented record a regex re-reads.
  const oneLine = (t) => String(t === undefined || t === null ? '' : t).replace(/[\r\n]+/g, ' ').trim();
  // JSON.stringify: YAML 1.2 is a JSON superset, so a colon, quote or leading '#' survives. The
  // bare form emitted 'title: Parser: loses data', which a real YAML reader rejects (driven).
  const yv = (t) => JSON.stringify(oneLine(t));
  const head = ['---', 'phase: ' + process.env.PADDED, 'review: ' + path.basename(process.env.REVIEW_FILE), 'titles: json', 'findings:']
    .concat(rows.map((r) => '  - id: ' + r.id + '\n    severity: ' + r.sev + '\n    disposition: ' + r.d
                          // Emitted whenever KNOWN, empty included ('### CR-01:'). Known-empty vs NOT
                          // KNOWN is the distinction; conflating them was a leak. Unknown stays absent.
                          + (typeof r.t === 'string' ? '\n    title: ' + yv(r.t) : '')))
    .concat(['open: ' + open, 'total: ' + rows.length])
    // Emitted only when there IS a shortfall, so an ordinary ledger gains no noise key and the
    // unchanged-run check below is unaffected on every review that parses cleanly.
    .concat(unparsed ? ['unparsed: ' + unparsed] : []).join('\n');
  // Rewrite only on a real change. The timestamp is the one field that always differs, so
  // stamping unconditionally would dirty the tree and produce a docs commit on every phase
  // re-run with nothing to report.
  const render = (stamp) => head + '\nrecorded: ' + stamp + '\n---\n\n' + body;
  const stripTs = (t) => t.replace(/^recorded:.*\$/m, 'recorded:');
  const prev = fs.existsSync(process.env.DISPOSITION_FILE) ? norm(fs.readFileSync(process.env.DISPOSITION_FILE, 'utf-8')) : '';
  if (prev && stripTs(prev) === stripTs(render(''))) {
    console.log('Code review disposition unchanged: ' + open + ' of ' + rows.length + ' finding(s) open' + staleNote + unparsedNote + reusedNote);
    return;
  }
  fs.writeFileSync(process.env.DISPOSITION_FILE, render(new Date().toISOString()));
  console.log('Code review disposition recorded: ' + open + ' of ' + rows.length + ' finding(s) open' + staleNote + unparsedNote + reusedNote + ' — ' + process.env.DISPOSITION_FILE);
  })();
" || echo "Code review disposition record skipped (non-blocking)."

COMMIT_DOCS=$(gsd_run query config-get commit_docs --raw 2>/dev/null || echo "true")
# `-f` FOLLOWS a symlink, so this could hand the commit helper a link the script above just
# refused to write through -- the guard and its consumer disagreeing about the same path.
if [ "$COMMIT_DOCS" = "true" ] && [ -f "${DISPOSITION_FILE}" ] && [ ! -L "${DISPOSITION_FILE}" ]; then
  gsd_run query commit "docs(${PADDED}): record code review disposition" --files "${DISPOSITION_FILE}" || true
fi
```
