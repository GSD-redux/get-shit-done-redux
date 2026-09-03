#!/usr/bin/env bash
# prompt-injection-scan.sh — Scan files for prompt injection patterns
#
# Usage:
#   scripts/prompt-injection-scan.sh --diff origin/main   # CI mode: scan changed .md files
#   scripts/prompt-injection-scan.sh --file path/to/file   # Scan a single file
#   scripts/prompt-injection-scan.sh --dir agents/          # Scan all files in a directory
#
# Exit codes (ADR-3889, #3908 — registered in gsd-core/bin/shared/exit-codes.json):
#   0                = clean
#   1                = findings detected
#   $EXIT_USAGE       (64) = usage error (bad argv, missing --file/--dir target)
#   $EXIT_NO_INPUT    (66) = ran; scope established; zero files in scope (genuinely empty)
#   $EXIT_UNAVAILABLE (69) = could not establish scope (bad ref, not a repo, unreadable dir)
set -euo pipefail

# ─── Exit-code registry (ADR-3889, #3908) ────────────────────────────────────
# Resolved relative to THIS script's location, not the caller's cwd. Loud,
# non-zero failure if the fragment is missing — never fall back to a guessed
# literal integer, and never let a missing registry silently degrade to
# exit 0.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXIT_CODES_SH="$SCRIPT_DIR/../gsd-core/bin/shared/exit-codes.sh"
if [[ ! -f "$EXIT_CODES_SH" ]]; then
  echo "prompt-injection-scan: FATAL: exit-code registry not found at $EXIT_CODES_SH" >&2
  echo "  Regenerate with: node scripts/gen-exit-code-registry.cjs --write" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$EXIT_CODES_SH"

# ─── Patterns ────────────────────────────────────────────────────────────────
# Each pattern is a POSIX extended regex. Keep alphabetized by category.
#
# Left-boundary prefix `(^|[^[:alnum:]])`: several trigger words are also
# suffixes of ordinary English words or camelCase identifiers (fact/impact/
# contract/artifact/interact all end in "act"; retrieval/medieval end in
# "eval"; blueprint/reprint/fingerprint end in "print"; describeFunction/
# wrapFunction end in "Function"; Jordan/Sudan end in "dan"), so an
# unanchored keyword matches as a false-positive substring. `\b` is a GNU
# grep extension and this script must also run under BSD/macOS grep, so the
# boundary is spelled out as `(^|[^[:alnum:]])` instead. This never narrows
# real detections: a genuine attack phrase is always preceded by start-of-
# line, whitespace, or punctuation, never by another alnum character glued
# directly onto the keyword. Only patterns whose leading keyword is provably
# not a real-word suffix are left unanchored (#3175 audit).

PATTERNS=(
  # Instruction override
  'ignore[[:space:]]+(all[[:space:]]+)?(previous|prior|above|earlier|preceding)[[:space:]]+(instructions|prompts|rules|directives|context)'
  'disregard[[:space:]]+(all[[:space:]]+)?(previous|prior|above)[[:space:]]+(instructions|prompts|rules)'
  'forget[[:space:]]+(all[[:space:]]+)?(previous|prior|above)[[:space:]]+(instructions|prompts|rules|context)'
  'override[[:space:]]+(all[[:space:]]+)?(system|previous|safety)[[:space:]]+(instructions|prompts|rules|checks|filters|guards)'
  'override[[:space:]]+(system|safety|security)[[:space:]]'

  # Role manipulation
  'you[[:space:]]+are[[:space:]]+now[[:space:]]+(a|an|my)[[:space:]]'
  'from[[:space:]]+now[[:space:]]+on[[:space:]]+(you|pretend|act|behave)'
  'pretend[[:space:]]+(you[[:space:]]+are|to[[:space:]]+be)[[:space:]]'
  '(^|[^[:alnum:]])act[[:space:]]+as[[:space:]]+(a|an|if|my)[[:space:]]'
  'roleplay[[:space:]]+as[[:space:]]'
  'assume[[:space:]]+the[[:space:]]+role[[:space:]]+of[[:space:]]'

  # System prompt extraction
  'output[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'reveal[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'show[[:space:]]+me[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  '(^|[^[:alnum:]])print[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'what[[:space:]]+(is|are)[[:space:]]+(your|the)[[:space:]]+(system[[:space:]]+)?(prompt|instructions)'
  'repeat[[:space:]]+(your|the|all)[[:space:]]+(system[[:space:]]+)?(prompt|instructions|rules)'

  # Fake message boundaries
  '</?system>'
  '</?assistant>'
  '</?human>'
  '\[SYSTEM\]'
  '\[/SYSTEM\]'
  '\[INST\]'
  '\[/INST\]'
  '<<SYS>>'
  '<</SYS>>'

  # Tool call injection / code execution in markdown
  #
  # The quote-or-apostrophe class below is spelled ["'"'"'"] (a literal `'`
  # via bash's close-quote/escape/reopen idiom), not `["\x27]` — `\x27` is a
  # GNU-grep-only hex escape; BSD/macOS grep treats it as four literal
  # characters (", \, x, 2, 7) and never matches an actual apostrophe, so
  # `eval('...')` (single-quoted) silently went undetected on macOS while
  # passing on GNU-grep CI runners. Found auditing #3175; fixed here since it
  # is the same unanchored/portability defect class as the boundary fix.
  #
  # `exec` stays receiver-blind on purpose. A left boundary that excludes a
  # preceding `.` would drop every member-position `.exec('…')` — including
  # `require('child_process').exec('…')`, the single most common Node spelling
  # of the vector this pattern exists to catch — and a receiver allowlist
  # cannot restore it, because the literal `child_process` is not adjacent to
  # `.exec`. The cost is that `RegExp.prototype.exec`, which takes a subject
  # string rather than code, also matches; files that legitimately call it are
  # handled by ALLOWLIST below, never by narrowing the pattern.
  '(^|[^[:alnum:]])eval[[:space:]]*\([[:space:]]*["'"'"']'
  'exec[[:space:]]*\([[:space:]]*["'"'"']'
  '(^|[^[:alnum:]])Function[[:space:]]*\([[:space:]]*["'"'"'].*return'

  # Jailbreak / DAN patterns
  'do[[:space:]]+anything[[:space:]]+now'
  '(^|[^[:alnum:]])DAN[[:space:]]+mode'
  'developer[[:space:]]+mode[[:space:]]+(enabled|output|activated)'
  'jailbreak'
  'bypass[[:space:]]+(safety|content|security)[[:space:]]+(filter|check|rule|guard)'
)

# ─── Allowlist ───────────────────────────────────────────────────────────────
# Files that legitimately discuss injection patterns (security docs, tests, this script)
ALLOWLIST=(
  'scripts/prompt-injection-scan.sh'
  'scripts/base64-scan.sh'
  'scripts/secret-scan.sh'
  'tests/security-scan.security.test.cjs'
  'tests/security.test.cjs'
  'tests/prompt-injection-scan.security.test.cjs'
  'tests/verify.test.cjs'
  'gsd-core/bin/lib/security.cjs'
  'hooks/gsd-prompt-guard.js'
  'hooks/gsd-read-injection-scanner.js'
  'tests/read-injection-scanner.security.test.cjs'
  'tests/read-injection-scanner.property.test.cjs'
  'tests/security-prompt-injection.security.test.cjs'
  'tests/list-seeds.test.cjs'
  'tests/fixtures/adversarial/security/'
  'SECURITY.md'
  # These files contain intentional injection examples / security-model prose
  # and are not attack vectors — they explain/demonstrate injection patterns.
  'TEST-EXAMPLES.md'
  'explanation/security-model.md'
  # The untrusted-input boundary reference quotes injection phrases
  # ("ignore previous instructions", "you are now…") as examples agents must
  # NOT comply with — it is the defense, not an attack vector.
  'references/untrusted-input-boundary.md'
  # Security regression tests for input validators — fixtures must contain
  # real injection payloads to prove the validator rejects them. See
  # DEFECT.PROMPT-INJECTION-SCAN-COLLISION in CONTEXT.md.
  'tests/windsurf-conversion.test.cjs'
  # RuleTester fixtures for the local/no-unguarded-nonportable-exec ESLint rule
  # contain shell-exec command strings (exec("sh -c …"), execFileSync('bash',['-c',…]))
  # as test DATA the rule must lint — not attack vectors. ADR-1703 Phase 3 (#1720).
  'tests/no-unguarded-nonportable-exec.rule.test.cjs'
  # RuleTester fixtures for the local/no-bare-npm-exec ESLint rule contain npm
  # exec command strings (execFileSync('npm', ['install'])) as test DATA the rule
  # must lint — not attack vectors. ADR-1703 Phase 4 (#1726).
  'tests/no-bare-npm-exec.rule.test.cjs'
  # #2547 — the Kimi field-shadowing regression proves gsd-prompt-guard still
  # SCANS the reconstructed edit[].new content when a model-supplied new_string
  # tries to shadow it. The fixture must be a real injection phrase or the test
  # asserts nothing: it is the payload the guard is required to catch, carried
  # as test DATA. Same class as the read-injection-scanner suites above.
  'tests/kimi-payload-field-shadowing.security.test.cjs'
  # Phase-ID grammar regression tests exercise `RegExp.prototype.exec` via
  # `re.exec('<phase-id>')` against fixtures like 'MANIFOLD-64-auth' / 'CK-64-auth'.
  # The scanner's `exec('` code-execution pattern matches that benign method call,
  # not an attack vector — same DEFECT.PROMPT-INJECTION-SCAN-COLLISION class as the
  # test fixtures above. Pre-existing content (16 such calls on `next`); it surfaces
  # here only because #2573's W024 `state_head` assertions make the file appear in
  # the changed-file set the diff-mode scan walks.
  'tests/health-validation.test.cjs'
  # #2528 — same collision, same disposition: the continuation-grammar suite
  # drives the tokenizer regexes directly via `re.exec('05-80-20')`, so the
  # argument is the subject string, not a command. Exempted per file rather
  # than by narrowing the `exec(` pattern: a left boundary excluding a preceding
  # `.` would drop `require('child_process').exec('…')`, and a receiver
  # allowlist cannot reach it either, because the literal `child_process` is
  # not adjacent to `.exec`. See the note at the pattern itself.
  'tests/continuation-grammar-parity.test.cjs'
  # #3676 row 11b — quick-batch's task-list parser must treat a
  # prompt-injection-shaped task description as inert data, never
  # interpreted. The fixture has to be a real "ignore all previous
  # instructions…" phrase or the test asserts nothing: it is the payload the
  # parser is required to carry byte-for-byte through createBatch and STATE
  # rendering, never a command. Same DEFECT.PROMPT-INJECTION-SCAN-COLLISION
  # class as the input-validator fixtures above.
  'tests/quick-batch.test.cjs'
)

is_allowlisted() {
  local file="$1"
  for allowed in "${ALLOWLIST[@]}"; do
    if [[ "$file" == *"$allowed"* ]]; then
      return 0
    fi
  done
  return 1
}

# ─── File Collection ─────────────────────────────────────────────────────────

collect_files() {
  local mode="$1"
  shift

  case "$mode" in
    --diff)
      local base="${1:-origin/main}"
      # Run git separately from the filter pipe so its OWN exit status (not
      # grep's) decides whether the diff could be established. stdout and
      # stderr are captured SEPARATELY (never merged with `2>&1`) so that a
      # warning git writes to stderr on an otherwise successful diff can
      # never be mistaken for a filename in the file list. On failure the
      # captured stderr is emitted as the diagnostic; on success it is
      # forwarded as a warning, never folded into the file list.
      # `|| true` on the filter below is CORRECT (not gratuitous): `grep -E`
      # exits 1 when nothing matches the scannable extensions (e.g. a diff
      # touching only non-scannable file types), which is a legitimate empty
      # result, not a failure to run.
      local raw status err_file
      err_file=$(mktemp)
      raw=$(git diff --name-only --diff-filter=ACMR "$base"...HEAD 2>"$err_file")
      status=$?
      if (( status != 0 )); then
        cat "$err_file" >&2
        rm -f "$err_file"
        exit "$EXIT_UNAVAILABLE"
      fi
      if [[ -s "$err_file" ]]; then
        echo "Warning: git diff emitted stderr output:" >&2
        cat "$err_file" >&2
      fi
      rm -f "$err_file"
      printf '%s\n' "$raw" | grep -E '\.(md|cjs|js|json|yml|yaml|sh)$' || true
      ;;
    --file)
      if [[ -f "$1" ]]; then
        echo "$1"
      else
        echo "Error: file not found: $1" >&2
        exit "$EXIT_USAGE"
      fi
      ;;
    --dir)
      local dir="$1"
      if [[ ! -d "$dir" ]]; then
        echo "Error: directory not found: $dir" >&2
        exit "$EXIT_USAGE"
      fi
      # Same treatment as --diff: a `find` that fails (e.g. permission
      # denied) must not be reported as an empty directory, and stdout/stderr
      # are captured separately so a stderr warning never enters the file list.
      local raw status err_file
      err_file=$(mktemp)
      raw=$(find "$dir" -type f \( -name '*.md' -o -name '*.cjs' -o -name '*.js' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' -o -name '*.sh' \) \
        ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/dist/*' 2>"$err_file")
      status=$?
      if (( status != 0 )); then
        cat "$err_file" >&2
        rm -f "$err_file"
        exit "$EXIT_UNAVAILABLE"
      fi
      if [[ -s "$err_file" ]]; then
        echo "Warning: find emitted stderr output:" >&2
        cat "$err_file" >&2
      fi
      rm -f "$err_file"
      printf '%s\n' "$raw"
      ;;
    --stdin)
      cat
      ;;
    *)
      echo "Usage: $0 --diff [base] | --file <path> | --dir <path> | --stdin" >&2
      exit "$EXIT_USAGE"
      ;;
  esac
}

# ─── Scanner ─────────────────────────────────────────────────────────────────

scan_file() {
  local file="$1"
  local found=0

  if is_allowlisted "$file"; then
    return 0
  fi

  for pattern in "${PATTERNS[@]}"; do
    # Use grep -iE for case-insensitive extended regex
    # -n for line numbers, -c for count mode first to check
    local matches
    matches=$(grep -inE -e "$pattern" "$file" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      if [[ $found -eq 0 ]]; then
        echo "FAIL: $file"
        found=1
      fi
      echo "$matches" | while IFS= read -r line; do
        echo "  $line"
      done
    fi
  done

  return $found
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  if [[ $# -eq 0 ]]; then
    echo "Usage: $0 --diff [base] | --file <path> | --dir <path>" >&2
    exit "$EXIT_USAGE"
  fi

  local mode="$1"
  shift

  local files
  files=$(collect_files "$mode" "$@")

  if [[ -z "$files" ]]; then
    # collect_files already exited (UNAVAILABLE/USAGE) for anything that
    # could not establish scope. Reaching here with an empty result means
    # scope WAS established and is genuinely empty — that is NO_INPUT, not a
    # silent clean pass.
    echo "prompt-injection-scan: no files to scan"
    exit "$EXIT_NO_INPUT"
  fi

  local total=0
  local failed=0

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    total=$((total + 1))
    if ! scan_file "$file"; then
      failed=$((failed + 1))
    fi
  done <<< "$files"

  echo ""
  echo "prompt-injection-scan: scanned $total files, $failed with findings"

  if [[ $failed -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
