/**
 * Host runtime detection — ADR-2313 Phase 5 (#3245, folded from #2320).
 *
 * `init`'s reported `agent_runtime` was hardcoding `claude` even when run
 * inside a Codex session, because resolveRuntime's ladder only checks the
 * explicit `GSD_RUNTIME` env var and `.planning/config.json`'s `runtime`
 * field — there was no fallback that looked at the actual host process.
 *
 * This module adds a host-detection rung strictly BELOW those two explicit
 * sources: it only runs when neither `GSD_RUNTIME` nor config `runtime` is
 * set. It never writes anything (#2297 — no shared-defaults poisoning: this
 * module never touches .planning/config.json or any other file). It never
 * shells out, so there is no subprocess to time-bound — detection is pure
 * env-var and existence-check inspection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveExplicitRuntime, readInstallRuntimeMarker } from './runtime-slash.cjs';
import { resolveRuntimeNameFromCandidates } from './runtime-name-policy.cjs';
import { CODEX_CONFIG_MARKER } from './update-context.cjs';

export { CODEX_CONFIG_MARKER };

export type DetectionSource = 'session-env' | 'config-home' | 'none';

export interface HostRuntimeDetection {
  runtime: string | null;
  source: DetectionSource;
  signal: string | null;
}

export interface DetectionDeps {
  env?: Record<string, string | undefined>;
  fileExists?: (p: string) => boolean;
}

// Codex sandbox env vars set by the shell tool / Seatbelt child-process spawn.
// Evidence: openai/codex AGENTS.md — "The sandbox environment automatically
// sets CODEX_SANDBOX_NETWORK_DISABLED=1 when using the shell tool, and
// CODEX_SANDBOX=seatbelt for child processes spawned via Seatbelt." (injected
// by spawn_child_async in codex-rs/core/src/spawn.rs). These are absent under
// sandbox_mode = "danger-full-access", so this signal is best-effort and
// degrades to the default when unset.
//
// Note: CODEX_THREAD_ID (which appears in src/active-workstream-store.cts's
// WORKSTREAM_SESSION_ENV_KEYS) is deliberately NOT used here — it is
// undocumented in Codex's published env-var reference and source, so it
// fails this repo's citation bar.
export const CODEX_SESSION_ENV_SIGNALS: readonly string[] = Object.freeze([
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
]);

// Evidence: learn.chatgpt.com/docs/config-file/environment-variables —
// "Sets the root for Codex state, including config…". The marker FILENAME
// (`config.toml`) is single-sourced from `update-context.cts`'s
// `inferPreferredRuntime` (imported above and re-exported for existing
// importers) — that is the only thing shared between the two functions. The
// TRUTHINESS RULE deliberately differs: `inferPreferredRuntime` treats a
// bare, unchecked `CODEX_HOME` as sufficient to resolve an update context,
// while THIS module additionally requires the marker file to exist, because
// it is asserting session identity rather than resolving an update context
// and needs the stronger signal. That difference is intentional and pinned
// by a test in `tests/host-runtime-detection.test.cjs` rather than left
// implicit.
//
// The DEFAULT `~/.codex/config.toml` is deliberately NEVER probed here:
// every machine that has ever run Codex has that file, so probing it
// unconditionally would misreport Claude Code sessions (or any other
// runtime) as codex just because Codex was installed at some point. An
// explicitly-exported CODEX_HOME is the user designating a Codex root for
// the CURRENT session, which is a much stronger signal.
export const CODEX_CONFIG_HOME_ENV = 'CODEX_HOME';

// The degraded no-detection result. Also the fallback returned when ANY step
// of detection throws (see the module's stated no-throw premise below).
const NO_DETECTION: HostRuntimeDetection = { runtime: null, source: 'none', signal: null };

/**
 * Detect the host runtime from process environment signals, without ever
 * consulting the explicit GSD_RUNTIME/config.json sources (those are a
 * higher-priority rung handled by resolveExplicitRuntime).
 *
 * Never throws: the whole body — including the raw `env[key]` reads, which a
 * caller could supply as a throwing Proxy — is wrapped in a single guarded
 * region that degrades to `NO_DETECTION` on any unexpected error, rather than
 * only guarding the `fileExists` probe.
 */
export function detectHostRuntime(deps?: DetectionDeps): HostRuntimeDetection {
  try {
    const env = deps?.env ?? process.env;
    const fileExists = deps?.fileExists ?? ((p: string) => fs.existsSync(p));

    for (const key of CODEX_SESSION_ENV_SIGNALS) {
      const value = env[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return { runtime: 'codex', source: 'session-env', signal: key };
      }
    }

    const codexHome = env[CODEX_CONFIG_HOME_ENV];
    if (typeof codexHome === 'string' && codexHome.trim() !== '') {
      try {
        if (fileExists(path.join(codexHome, CODEX_CONFIG_MARKER))) {
          return { runtime: 'codex', source: 'config-home', signal: CODEX_CONFIG_HOME_ENV };
        }
      } catch {
        // Swallow probe failures (EACCES etc.) and fall through to no-detection.
      }
    }

    return NO_DETECTION;
  } catch {
    // A malformed `deps.env` (e.g. a throwing Proxy) must degrade like any
    // other unreadable signal, not propagate — this function's contract is
    // that it never throws.
    return NO_DETECTION;
  }
}

/**
 * Resolve the runtime to report from init: explicit sources first, then the
 * host-detection rung, then the per-install `.gsd-runtime` marker (#3364),
 * then the 'claude' default. This is intentionally separate from
 * resolveRuntime — only init's agent_runtime reporting call site uses this
 * ladder. The two ladders now BOTH carry the marker but order it differently:
 * here it sits below detection (a live session signal outranks what a tree was
 * merely installed for), while `resolveRuntime` has no detection rung and
 * places the marker directly above the default.
 *
 * Never throws: degrades to the 'claude' default on any unexpected error
 * (e.g. a throwing `deps.env`), matching detectHostRuntime's no-throw
 * contract.
 */
export function resolveReportedRuntime(projectDir: string | null | undefined, deps?: DetectionDeps): string {
  try {
    return resolveReportedRuntimeUnsafe(projectDir, deps);
  } catch {
    return 'claude';
  }
}

function resolveReportedRuntimeUnsafe(projectDir: string | null | undefined, deps?: DetectionDeps): string {
  const explicit = resolveExplicitRuntime(projectDir, deps?.env ?? process.env);
  if (explicit) return explicit;
  const detected = detectHostRuntime(deps);
  if (detected.runtime) return detected.runtime;
  // #3364: below detection, above the default. The install marker is a weaker
  // signal than a live session signal — an exported CODEX_HOME says what the
  // user is running RIGHT NOW, while the marker only says what this tree was
  // installed for — but it is a far stronger signal than assuming Claude.
  // Without this rung the marker fixes every `resolveRuntime` consumer and
  // still leaves this one broken: init passes the reported runtime into
  // checkAgentsInstalled, so a Kimi install with a neutral project config
  // reported `agent_runtime: "claude"` and all 34 agents missing, because
  // Kimi's YAML/prompt layout was read as Claude's. #3364 names agent-install
  // checks among the consumers it is filed to fix, so this ladder is in scope.
  const marker = resolveRuntimeNameFromCandidates(readInstallRuntimeMarker());
  if (marker) return marker;
  return 'claude';
}
