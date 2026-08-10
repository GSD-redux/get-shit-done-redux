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
import { resolveExplicitRuntime } from './runtime-slash.cjs';

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
// "Sets the root for Codex state, including config…". This reuses the
// existing `config.toml` probe from `inferPreferredRuntime`
// (src/update-context.cts:84).
//
// The DEFAULT `~/.codex/config.toml` is deliberately NEVER probed here:
// every machine that has ever run Codex has that file, so probing it
// unconditionally would misreport Claude Code sessions (or any other
// runtime) as codex just because Codex was installed at some point. An
// explicitly-exported CODEX_HOME is the user designating a Codex root for
// the CURRENT session, which is a much stronger signal.
export const CODEX_CONFIG_HOME_ENV = 'CODEX_HOME';
export const CODEX_CONFIG_MARKER = 'config.toml';

/**
 * Detect the host runtime from process environment signals, without ever
 * consulting the explicit GSD_RUNTIME/config.json sources (those are a
 * higher-priority rung handled by resolveExplicitRuntime).
 */
export function detectHostRuntime(deps?: DetectionDeps): HostRuntimeDetection {
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

  return { runtime: null, source: 'none', signal: null };
}

/**
 * Resolve the runtime to report from init: explicit sources first, then the
 * host-detection rung, then the 'claude' default. This is intentionally
 * separate from resolveRuntime — only init's agent_runtime reporting call
 * site uses this ladder; every other resolveRuntime caller is unaffected.
 */
export function resolveReportedRuntime(projectDir: string | null | undefined, deps?: DetectionDeps): string {
  const explicit = resolveExplicitRuntime(projectDir, deps?.env ?? process.env);
  if (explicit) return explicit;
  const detected = detectHostRuntime(deps);
  if (detected.runtime) return detected.runtime;
  return 'claude';
}
