#!/usr/bin/env bash
# secret-scan.sh — Check files for accidentally committed secrets/credentials
#
# Usage:
#   scripts/secret-scan.sh --diff origin/main       # CI mode: scan changed files
#   scripts/secret-scan.sh --file path/to/file      # Scan a single file
#   scripts/secret-scan.sh --dir agents/            # Scan all files in a directory
#   scripts/secret-scan.sh --diff origin/main --strict  # Strict/release mode
#
# Flags:
#   --strict   Reduced-exclusion mode for release and security-audit CI lanes.
#              Under --strict:
#                - Grandfathered (un-annotated) .secretscanignore entries are
#                  treated as FAILURES rather than silently honoured.
#                - Exclusions whose 'expires' date is in the past are ignored
#                  (the file IS scanned, not skipped).
#              This flag does not change secret-detection logic — only which
#              exclusions are applied.
#
# Exit codes (ADR-3889, #3908 — registered in gsd-core/bin/shared/exit-codes.json):
#   0                = clean
#   1                = findings detected
#   $EXIT_USAGE       (64) = usage error (bad argv, missing --file/--dir target)
#   $EXIT_NO_INPUT    (66) = ran; scope established; zero files in scope (genuinely empty)
#   $EXIT_UNAVAILABLE (69) = could not establish scope (bad ref, not a repo, unreadable dir)
#
# Annotation format for .secretscanignore (required for --strict compliance):
#   # allow: <pattern>  reason="..."  owner="..."  expires="YYYY-MM-DD"  [rule-id="..."]
#   <pattern>
#
# Design references:
#   - GitGuardian exclusion annotation convention:
#     https://docs.gitguardian.com/internal-repositories-monitoring/integrations/cli/secrets
#   - CNCF Security TAG threat-model exception lifecycle:
#     https://github.com/cncf/tag-security/blob/main/community/working-groups/threat-modeling/templates/threats.md
#
# Periodic reduced-exclusion scan procedure:
#   Run this script with --strict on every release branch and during scheduled
#   security reviews. This mode intentionally skips grandfathered entries and
#   expired exclusions so that accumulated technical debt in the ignore-list
#   cannot permanently hide secrets. See SECURITY.md for the audit runbook.
set -euo pipefail

# ─── Exit-code registry (ADR-3889, #3908) ────────────────────────────────────
# Resolved relative to THIS script's location, not the caller's cwd, so this
# works regardless of where the scanner is invoked from. Loud, non-zero
# failure if the fragment is missing — never fall back to a guessed literal
# integer, and never let a missing registry silently degrade to exit 0.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXIT_CODES_SH="$SCRIPT_DIR/../gsd-core/bin/shared/exit-codes.sh"
if [[ ! -f "$EXIT_CODES_SH" ]]; then
  echo "secret-scan: FATAL: exit-code registry not found at $EXIT_CODES_SH" >&2
  echo "  Regenerate with: node scripts/gen-exit-code-registry.cjs --write" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$EXIT_CODES_SH"

# ─── Global mode flag ─────────────────────────────────────────────────────────
STRICT_MODE=false

# ─── Secret Patterns ─────────────────────────────────────────────────────────
# Format: "LABEL:::REGEX"
# Each entry is a human label paired with a POSIX extended regex.

SECRET_PATTERNS=(
  # AWS
  "AWS Access Key:::AKIA[0-9A-Z]{16}"
  "AWS Secret Key:::aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{40}"

  # OpenAI / Anthropic / AI providers
  "OpenAI API Key:::sk-[A-Za-z0-9]{20,}"
  "Anthropic API Key:::sk-ant-[A-Za-z0-9_-]{20,}"

  # GitHub
  "GitHub PAT:::ghp_[A-Za-z0-9]{36}"
  "GitHub OAuth:::gho_[A-Za-z0-9]{36}"
  "GitHub App Token:::ghs_[A-Za-z0-9]{36}"
  "GitHub Fine-grained PAT:::github_pat_[A-Za-z0-9_]{20,}"

  # Stripe
  "Stripe Secret Key:::sk_live_[A-Za-z0-9]{24,}"
  "Stripe Publishable Key:::pk_live_[A-Za-z0-9]{24,}"

  # Generic patterns
  "Private Key Header:::-----BEGIN[[:space:]]+(RSA|EC|DSA|OPENSSH)?[[:space:]]*PRIVATE[[:space:]]+KEY-----"
  "Generic API Key Assignment:::api[_-]?key[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{20,}['\"]"
  "Generic Secret Assignment:::secret[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{20,}['\"]"
  "Generic Token Assignment:::token[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{20,}['\"]"
  "Generic Password Assignment:::password[[:space:]]*[:=][[:space:]]*['\"][^'\"]{8,}['\"]"

  # Slack
  "Slack Bot Token:::xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}"
  "Slack Webhook:::hooks\.slack\.com/services/T[A-Z0-9]{8,}/B[A-Z0-9]{8,}/[A-Za-z0-9]{24}"

  # Google
  "Google API Key:::AIza[A-Za-z0-9_-]{35}"

  # NPM
  "NPM Token:::npm_[A-Za-z0-9]{36}"

  # .env file content (key=value with sensitive-looking keys)
  "Env Variable Leak:::(DATABASE_URL|DB_PASSWORD|REDIS_URL|MONGO_URI|JWT_SECRET|SESSION_SECRET|ENCRYPTION_KEY)[[:space:]]*=[[:space:]]*[^[:space:]]{8,}"
)

# ─── Ignorelist ──────────────────────────────────────────────────────────────
#
# Entries in IGNORED_FILES are loaded from .secretscanignore.
# In --strict mode, only fully-annotated entries with a future 'expires' date
# are loaded. Grandfathered entries and expired entries are skipped (the
# corresponding files ARE scanned, not excluded).
#
# Annotation format (structured comment must immediately precede the path):
#   # allow: <pattern>  reason="..."  owner="..."  expires="YYYY-MM-DD"  [rule-id="..."]
#   <pattern>
#
# Entries without a structured annotation are grandfathered:
#   - Default mode: accepted (file excluded), deprecation warning emitted
#   - Strict mode: rejected (file scanned, no exclusion applied)

IGNOREFILE=".secretscanignore"
IGNORED_FILES=()

# Returns value of key="value" annotation pair from a string
_extract_annotation_key() {
  local str="$1"
  local key="$2"
  echo "$str" | grep -oE "${key}=['\"][^'\"]+['\"]" | head -1 | sed "s/${key}=['\"]//;s/['\"]$//" || true
}

# Returns today as YYYY-MM-DD
_today() {
  date +%Y-%m-%d
}

# Returns 0 (true) if a date string YYYY-MM-DD is strictly in the past
_date_is_past() {
  local d="$1"
  [[ "$d" < "$(_today)" ]]
}

load_ignorelist() {
  if [[ ! -f "$IGNOREFILE" ]]; then
    return
  fi

  local prev_comment=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    # Empty line resets context
    if [[ -z "${line// }" ]]; then
      prev_comment=""
      continue
    fi

    # Accumulate comment
    if [[ "$line" =~ ^[[:space:]]*# ]]; then
      prev_comment="$line"
      continue
    fi

    # This is a path entry
    local pattern="$line"

    # Determine if preceding comment is a structured annotation
    local is_structured=false
    if [[ "$prev_comment" =~ ^#[[:space:]]+allow:[[:space:]] ]]; then
      is_structured=true
    fi

    if [[ "$is_structured" == true ]]; then
      # Parse structured annotation
      local expires
      expires=$(_extract_annotation_key "$prev_comment" "expires")

      if [[ -n "$expires" ]] && _date_is_past "$expires"; then
        # Expired exclusion — never apply, regardless of mode
        echo "secret-scan: WARNING: exclusion '$pattern' has expired (expires=$expires) — entry ignored" >&2
        prev_comment=""
        continue
      fi

      # Valid structured annotation — always apply
      IGNORED_FILES+=("$pattern")

    else
      # Grandfathered (plain comment or no comment)
      if [[ "$STRICT_MODE" == true ]]; then
        # Strict mode: do NOT apply grandfathered exclusion
        echo "secret-scan: WARNING (--strict): grandfathered exclusion '$pattern' not applied" >&2
      else
        # Default mode: apply but warn
        echo "secret-scan: DEPRECATION WARNING: '$pattern' has no structured annotation — grandfather applied" >&2
        echo "  Migrate to: # allow: $pattern  reason=\"...\"  owner=\"...\"  expires=\"YYYY-MM-DD\"" >&2
        IGNORED_FILES+=("$pattern")
      fi
    fi

    prev_comment=""
  done < "$IGNOREFILE"
}

is_ignored() {
  local file="$1"
  if [[ ${#IGNORED_FILES[@]} -eq 0 ]]; then
    return 1
  fi
  for pattern in "${IGNORED_FILES[@]}"; do
    # Support glob-style matching
    # shellcheck disable=SC2254
    case "$file" in
      $pattern) return 0 ;;
    esac
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
    */secret-scan.sh) return 0 ;;
    */secret-scan-lint.security.test.cjs) return 0 ;;
    */security-scan.security.test.cjs) return 0 ;;
    */security-prompt-injection.security.test.cjs) return 0 ;;
    tests/fixtures/adversarial/security/*|*/tests/fixtures/adversarial/security/*) return 0 ;;
  esac
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

scan_file() {
  local file="$1"
  local found=0

  if is_ignored "$file"; then
    return 0
  fi

  for entry in "${SECRET_PATTERNS[@]}"; do
    local label="${entry%%:::*}"
    local pattern="${entry#*:::}"

    local matches
    matches=$(grep -nE -e "$pattern" "$file" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      if [[ $found -eq 0 ]]; then
        echo "FAIL: $file"
        found=1
      fi
      echo "$matches" | while IFS= read -r line; do
        echo "  [$label] $line"
      done
    fi
  done

  return $found
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  if [[ $# -eq 0 ]]; then
    echo "Usage: $0 --diff [base] | --file <path> | --dir <path> [--strict]" >&2
    exit "$EXIT_USAGE"
  fi

  # Parse --strict flag first (may appear anywhere in argv)
  local remaining_args=()
  for arg in "$@"; do
    if [[ "$arg" == "--strict" ]]; then
      STRICT_MODE=true
    else
      remaining_args+=("$arg")
    fi
  done
  set -- "${remaining_args[@]}"

  if [[ $# -eq 0 ]]; then
    echo "Usage: $0 --diff [base] | --file <path> | --dir <path> [--strict]" >&2
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
    echo "secret-scan: no files to scan"
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
    if ! scan_file "$file"; then
      failed=$((failed + 1))
    fi
  done <<< "$files"

  echo ""
  echo "secret-scan: scanned $total files, $failed with findings"

  if [[ $failed -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
