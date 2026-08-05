When `FALLOW_ENABLED=true`:

1) Resolve binary via PATH first, then `node_modules/.bin/fallow`.
```bash
FALLOW_BIN=$(FALLOW_CWD="$(pwd)" node -e "
const { resolveFallowBinary } = require('./gsd-core/bin/lib/fallow-runner.cjs');
const resolved = resolveFallowBinary({ cwd: process.env.FALLOW_CWD });
if (resolved) process.stdout.write(resolved);
")
```

2) If binary is missing, fail with actionable message:
```bash
if [ -z \"$FALLOW_BIN\" ]; then
  echo \"Error: fallow is enabled but no binary was found.\"
  echo \"Install fallow via \`npm install -D fallow\` or \`cargo install fallow\`.\"
  # Exit workflow
fi
```

3) Execute structural pass and persist JSON (bounded at 120s). Note: `fallow audit` exits 0 when clean and 1 when issues are found — BOTH are successful runs. Only a timeout (124), usage error (2), or crash yields no usable JSON; success is decided by whether the output parses as a valid fallow report, not by exit code:
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
FALLOW_JSON_PATH="${PHASE_DIR}/FALLOW.json"
FALLOW_STDERR_TMP=$(mktemp)

# Phase scope uses fallow's native changed-files scoping (--changed-since <base>).
# Derive the phase base commit; if none is found, fall back to repo scope (fallow
# auto-detects the base branch).
FALLOW_SCOPE_ARGS=()
if [ \"$FALLOW_SCOPE\" = \"phase\" ]; then
  FALLOW_PHASE_COMMITS=$(git log --oneline --all --grep=\"${PADDED_PHASE}\" --format=\"%H\" 2>/dev/null)
  if [ -n \"$FALLOW_PHASE_COMMITS\" ]; then
    FALLOW_BASE=$(echo \"$FALLOW_PHASE_COMMITS\" | tail -1)^
    FALLOW_SCOPE_ARGS=(--changed-since \"$FALLOW_BASE\")
  fi
fi

gsd_run run-with-timeout 120 -- \"$FALLOW_BIN\" audit --format json --quiet --max-crap \"$FALLOW_MAX_CRAP\" \"${FALLOW_SCOPE_ARGS[@]+\"${FALLOW_SCOPE_ARGS[@]}\"}\" > \"${FALLOW_JSON_PATH}.tmp\" 2>\"$FALLOW_STDERR_TMP\"
FALLOW_EXIT=$?

# fallow exits 0 (clean) or 1 (issues found) — BOTH are successful runs that produce a
# valid JSON report. Only a timeout (124), usage error (2), or crash yields no usable JSON.
# Decide success by whether the output parses as a fallow report, not by exit code.
FALLOW_OK=$(FALLOW_TMP=\"${FALLOW_JSON_PATH}.tmp\" node -e \"
  try {
    const fs = require('fs');
    const txt = fs.readFileSync(process.env.FALLOW_TMP, 'utf8');
    const o = JSON.parse(txt);
    process.stdout.write(o && typeof o === 'object' && 'verdict' in o ? '1' : '0');
  } catch { process.stdout.write('0'); }
\")
if [ \"$FALLOW_OK\" != \"1\" ]; then
  FALLOW_STDERR_SUMMARY=$(head -5 \"$FALLOW_STDERR_TMP\")
  rm -f \"${FALLOW_JSON_PATH}.tmp\" \"$FALLOW_STDERR_TMP\"
  # #2667: distinguish a hard EXECUTION failure (the binary was found at step 1
  # but would not run) from the binary-missing path (step 2). Exit 124 = timeout,
  # 2 = usage error, 125 = spawn failure (e.g. Windows EINVAL on a .cmd shim —
  # CVE-2024-27980, now mediated by run-with-timeout), 126/127 = not executable /
  # not found. A non-zero exit here with a resolved binary means fallow is
  # installed but did not produce a report — surface that loudly so a Windows
  # user does not mistake it for "fallow absent".
  case \"$FALLOW_EXIT\" in
    124) FALLOW_FAIL_KIND=\"timed out\" ;;
    2)   FALLOW_FAIL_KIND=\"usage error\" ;;
    125) FALLOW_FAIL_KIND=\"spawn failure (the binary was found but did not start — e.g. a Windows .cmd shim; run-with-timeout mediates this)\" ;;
    126) FALLOW_FAIL_KIND=\"not executable\" ;;
    127) FALLOW_FAIL_KIND=\"not found\" ;;
    *)   FALLOW_FAIL_KIND=\"crashed\" ;;
  esac
  echo \"WARNING: fallow structural pre-pass failed (${FALLOW_FAIL_KIND}, exit ${FALLOW_EXIT}): ${FALLOW_STDERR_SUMMARY}\"
  FALLOW_JSON_PATH=\"\"
else
  mv \"${FALLOW_JSON_PATH}.tmp\" \"$FALLOW_JSON_PATH\"
  rm -f \"$FALLOW_STDERR_TMP\"
fi
```

On any failure of the structural pre-pass (binary missing at step 2, or an execution failure here — timeout, spawn failure, crash, empty output, or unparseable JSON), the workflow continues with no `<structural_findings>` injection; the reviewer agent receives a normal review request. The WARNING above names the failure KIND so a hard execution failure (e.g. a Windows `.cmd` spawn failure) is not mistaken for an absent optional dependency.

4) Optional MCP bridge path (runtime-dependent):
- If `FALLOW_MCP=true`, set reviewer input mode to MCP-backed structural findings.
- Otherwise pass static JSON findings from `FALLOW.json`.
