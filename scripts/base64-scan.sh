#!/usr/bin/env bash
# base64-scan.sh — Detect base64-obfuscated prompt injection in source files
#
# Extracts base64 blobs >= 40 chars, decodes them, and checks decoded content
# against the same injection patterns used by prompt-injection-scan.sh.
#
# Usage:
#   scripts/base64-scan.sh --diff origin/main   # CI mode: scan changed files
#   scripts/base64-scan.sh --file path/to/file   # Scan a single file
#   scripts/base64-scan.sh --dir agents/          # Scan all files in a directory
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
  echo "base64-scan: FATAL: exit-code registry not found at $EXIT_CODES_SH" >&2
  echo "  Regenerate with: node scripts/gen-exit-code-registry.cjs --write" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$EXIT_CODES_SH"

# ── Locale hardening (#116) ───────────────────────────────────────────────────
# BSD tr (macOS) treats input bytes as multi-byte characters under any UTF-8
# locale.  When the input to `tr -cd '[:print:]'` contains bytes that are not
# valid UTF-8 start sequences (e.g. lone continuation bytes 0x80–0x9F), BSD tr
# emits "Illegal byte sequence" to stderr and exits non-zero.  Setting LC_ALL=C
# forces the C locale throughout the script so every byte 0x00–0xFF is a valid
# character — no multi-byte interpretation, no illegal-byte errors.
#
# This is safe for our use-case: all injection patterns are ASCII; base64 -d
# and grep -E POSIX classes ([:space:], [:print:]) behave correctly in C locale.
#
# Source: `man tr` on macOS 26.5 — ENVIRONMENT section states LC_ALL / LC_CTYPE
# control character interpretation; BSD tr rejects invalid multi-byte sequences.
# Empirically verified: `printf '\x80\x81hello' | LC_ALL=C tr -cd '[:print:]'`
# exits 0 and strips the high bytes cleanly.
export LC_ALL=C

MIN_BLOB_LENGTH=40
# Lines longer than this byte count are skipped with a partial-scan warning.
# This prevents `grep -oE` from spending unbounded time on e.g. minified JS or
# single-line binary blobs.  1 MiB is large enough for any realistic text file
# line but small enough to bound blob-extraction cost.
MAX_LINE_BYTES=1048576

# -- Portable timeout wrapper (#116) ------------------------------------------
# macOS does not ship GNU coreutils timeout.  We probe for it (or gtimeout
# from homebrew coreutils), falling back to perl alarm(N)+exec.
# Exit codes: GNU timeout uses 124 on timeout; perl SIGALRM produces 142.
# Both are treated as timeout exits by is_timeout_exit() below.
# Usage: run_with_timeout <seconds> <command> [args...]
_TIMEOUT_CMD=""
# shellcheck disable=SC2329  # intentionally defined for use by callers; not called in main loop
_init_timeout_cmd() {
  if [[ -n "$_TIMEOUT_CMD" ]]; then return; fi
  if command -v timeout >/dev/null 2>&1; then
    _TIMEOUT_CMD="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    _TIMEOUT_CMD="gtimeout"
  else
    _TIMEOUT_CMD="perl_alarm"
  fi
}

# shellcheck disable=SC2329  # intentionally defined for use by callers; not called in main loop
run_with_timeout() {
  local secs="$1"; shift
  _init_timeout_cmd
  case "$_TIMEOUT_CMD" in
    timeout|gtimeout)
      "$_TIMEOUT_CMD" "$secs" "$@"
      ;;
    perl_alarm)
      # perl sets SIGALRM after N seconds, then exec()s the command.
      # Exit 142 (SIGALRM) when timed out.
      perl -e '
        my $secs = shift @ARGV;
        alarm($secs);
        exec(@ARGV) or die "exec: $!\n";
      ' -- "$secs" "$@"
      ;;
  esac
}

# is_timeout_exit: returns 0 (true) if rc indicates a timeout kill.
# shellcheck disable=SC2329  # intentionally defined for use by callers; not called in main loop
is_timeout_exit() { [[ "$1" -eq 124 || "$1" -eq 142 ]]; }


# ─── Injection Patterns (decoded content) ────────────────────────────────────
# Subset of patterns — if someone base64-encoded something, check for the
# most common injection indicators.
DECODED_PATTERNS=(
  'ignore[[:space:]]+(all[[:space:]]+)?previous[[:space:]]+instructions'
  'you[[:space:]]+are[[:space:]]+now[[:space:]]+'
  'system[[:space:]]+prompt'
  '</?system>'
  '</?assistant>'
  '\[SYSTEM\]'
  '\[INST\]'
  '<<SYS>>'
  'override[[:space:]]+(system|safety|security)'
  'pretend[[:space:]]+(you|to)[[:space:]]'
  'act[[:space:]]+as[[:space:]]+(a|an|if)'
  'jailbreak'
  'bypass[[:space:]]+(safety|content|security)'
  'eval[[:space:]]*\('
  'exec[[:space:]]*\('
  'rm[[:space:]]+-rf'
  'curl[[:space:]].*\|[[:space:]]*sh'
  'wget[[:space:]].*\|[[:space:]]*sh'
)

# ─── Ignorelist ──────────────────────────────────────────────────────────────

IGNOREFILE=".base64scanignore"
IGNORED_PATTERNS=()

load_ignorelist() {
  if [[ -f "$IGNOREFILE" ]]; then
    while IFS= read -r line; do
      # Skip comments and empty lines
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "${line// }" ]] && continue
      IGNORED_PATTERNS+=("$line")
    done < "$IGNOREFILE"
  fi
}

is_ignored() {
  local blob="$1"
  if [[ ${#IGNORED_PATTERNS[@]} -eq 0 ]]; then
    return 1
  fi
  for pattern in "${IGNORED_PATTERNS[@]}"; do
    if [[ "$blob" == "$pattern" ]]; then
      return 0
    fi
  done
  return 1
}

# ─── Skip Rules ──────────────────────────────────────────────────────────────

should_skip_file() {
  local file="$1"
  # Skip binary files
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot|*.otf) return 0 ;;
    *.zip|*.tar|*.gz|*.bz2|*.xz|*.7z) return 0 ;;
    *.pdf|*.doc|*.docx|*.xls|*.xlsx) return 0 ;;
  esac
  # Skip lockfiles and node_modules
  case "$file" in
    */node_modules/*) return 0 ;;
    */package-lock.json) return 0 ;;
    */yarn.lock) return 0 ;;
    */pnpm-lock.yaml) return 0 ;;
  esac
  # Skip the scan scripts themselves and test files
  case "$file" in
    */base64-scan.sh) return 0 ;;
    */security-scan.security.test.cjs) return 0 ;;
  esac
  # Skip scanner fixture directories — they contain deliberate injection samples
  case "$file" in
    tests/fixtures/*) return 0 ;;
  esac
  return 1
}

is_data_uri() {
  local context="$1"
  # data:image/png;base64,... or data:application/font-woff;base64,...
  echo "$context" | grep -qE 'data:[a-zA-Z]+/[a-zA-Z0-9.+-]+;base64,' 2>/dev/null
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
      # `|| true` on the filter below is CORRECT (not gratuitous): `grep -v`
      # exits 1 when every line is filtered out (e.g. an all-images diff),
      # which is a legitimate empty result, not a failure to run.
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
      printf '%s\n' "$raw" \
        | grep -vE '\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|otf|zip|tar|gz|pdf)$' || true
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
      raw=$(find "$dir" -type f ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/dist/*' \
        ! -name '*.png' ! -name '*.jpg' ! -name '*.gif' ! -name '*.woff*' 2>"$err_file")
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

extract_and_check_blobs() {
  local file="$1"
  local found=0
  local line_num=0

  # Skip binary-by-content files (e.g. adversarial parser fixtures with embedded
  # non-UTF8 / NUL bytes). They cannot meaningfully carry base64-obfuscated *text*,
  # and feeding NUL bytes through the per-line scanner spawns thousands of bogus
  # `base64 -d` subprocesses (the "ignored null byte" warnings) — slow enough to
  # blow the job timeout on a large diff. `grep -Iq .` treats a binary file as
  # non-matching, so this skips it with a coverage notice (collect_files already
  # filters binary *extensions*; this catches binary *content* in text extensions).
  if ! LC_ALL=C grep -Iq . "$file" 2>/dev/null; then
    echo "SKIP: $file (binary content — base64 text scan not applicable)" >&2
    return 0
  fi

  while IFS= read -r line; do
    line_num=$((line_num + 1))

    # Guard: skip lines that exceed MAX_LINE_BYTES.  Very long lines (e.g. a
    # minified JS bundle stored as one line, or a binary file with no newlines)
    # would cause `grep -oE` to spend unbounded time.  We emit a partial-scan
    # warning to stderr so the caller can see coverage was reduced.
    if [[ ${#line} -gt $MAX_LINE_BYTES ]]; then
      echo "SKIP: $file line $line_num (${#line} bytes > ${MAX_LINE_BYTES} limit — partial scan)" >&2
      continue
    fi

    # Skip data URIs — legitimate base64 usage
    if is_data_uri "$line"; then
      continue
    fi

    # Extract base64-like blobs (alphanumeric + / + = padding, >= MIN_BLOB_LENGTH)
    local blobs
    blobs=$(echo "$line" | grep -oE '[A-Za-z0-9+/]{'"$MIN_BLOB_LENGTH"',}={0,3}' 2>/dev/null || true)

    if [[ -z "$blobs" ]]; then
      continue
    fi

    while IFS= read -r blob; do
      [[ -z "$blob" ]] && continue

      # Check ignorelist
      if [[ ${#IGNORED_PATTERNS[@]} -gt 0 ]] && is_ignored "$blob"; then
        continue
      fi

      # Try to decode — if it fails, not valid base64
      local decoded
      decoded=$(echo "$blob" | base64 -d 2>/dev/null || echo "")

      if [[ -z "$decoded" ]]; then
        continue
      fi

      # Check if decoded content is mostly printable text (not random binary)
      local total_chars=${#decoded}
      if [[ $total_chars -eq 0 ]]; then
        continue
      fi

      # Count printable ASCII characters
      local printable_count
      printable_count=$(echo -n "$decoded" | tr -cd '[:print:]' | wc -c | tr -d ' ')
      # Skip if less than 70% printable (likely binary data, not obfuscated text)
      if [[ $((printable_count * 100 / total_chars)) -lt 70 ]]; then
        continue
      fi

      # Scan decoded content against injection patterns
      for pattern in "${DECODED_PATTERNS[@]}"; do
        if echo "$decoded" | grep -iqE "$pattern" 2>/dev/null; then
          if [[ $found -eq 0 ]]; then
            echo "FAIL: $file"
            found=1
          fi
          echo "  line $line_num: base64 blob decodes to suspicious content"
          echo "    blob: ${blob:0:60}..."
          echo "    decoded: ${decoded:0:120}"
          echo "    matched: $pattern"
          break
        fi
      done
    done <<< "$blobs"
  done < "$file"

  return $found
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  if [[ $# -eq 0 ]]; then
    echo "Usage: $0 --diff [base] | --file <path> | --dir <path>" >&2
    exit "$EXIT_USAGE"
  fi

  load_ignorelist

  local mode="$1"
  shift

  local files
  files=$(collect_files "$mode" "$@")

  if [[ -z "$files" ]]; then
    # collect_files already exited (UNAVAILABLE/USAGE) for anything that
    # could not establish scope. Reaching here with an empty result means
    # scope WAS established and is genuinely empty (e.g. an all-images
    # diff) — that is NO_INPUT, not a silent clean pass.
    echo "base64-scan: no files to scan"
    exit "$EXIT_NO_INPUT"
  fi

  local total=0
  local failed=0

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if should_skip_file "$file"; then
      continue
    fi
    total=$((total + 1))
    if ! extract_and_check_blobs "$file"; then
      failed=$((failed + 1))
    fi
  done <<< "$files"

  echo ""
  echo "base64-scan: scanned $total files, $failed with findings"

  if [[ $failed -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
