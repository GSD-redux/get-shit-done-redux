/**
 * runtime-slash.cts — single source of truth for emitting GSD slash-command
 * references in user-facing runtime output (recommended-actions JSON, persisted
 * ROADMAP.md entries, verify/validate fix hints, error messages, etc.).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/runtime-slash.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 *
 * Background: #2808 unified all GSD skill installs to register under the hyphen
 * form (`name: gsd-<cmd>`). The legacy colon form `/gsd:<cmd>` is no longer
 * routable by Claude Code skill installs, but ~50 runtime emissions in
 * bin/lib/*.cjs still hardcoded it (#3584). Codex installs need the shell-var
 * `$gsd-<cmd>` form. This module is the only place the runtime should decide
 * which shape to emit.
 *
 *   - codex:                                   $gsd-<cmd>   (shell-var syntax)
 *   - claude, cursor, opencode, kilo, etc.:    /gsd-<cmd>
 *
 * The colon form is never emitted.
 *
 * Cross-import proof candidate (ADR-457): this is the first TS source that
 * imports a sibling TS-migrated module. The import specifier uses the .cjs
 * extension per nodenext convention; tsc resolves it to src/runtime-name-policy.cts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeRuntimeName, resolveRuntimeNameFromCandidates } from './runtime-name-policy.cjs';

export function formatGsdSlash(commandName: unknown, runtime: unknown): unknown {
  if (typeof commandName !== 'string') return commandName;
  if (commandName === '') return commandName;

  // Strip any existing leading prefix so the helper is idempotent and accepts
  // both legacy `/gsd:<name>` and canonical hyphen-form input (plus the bare
  // `gsd:<name>` shorthand and codex `$gsd-<name>` shell-var input).
  const stripped = commandName.replace(/^[/$]?gsd[-:]/i, '');
  // If the regex matched nothing (no prefix), the input is already a bare name.
  const bare = stripped === commandName ? commandName : stripped;
  // Defensive: a degenerate input like `/gsd:`, `gsd-`, or whitespace-only
  // normalizes to empty. Returning the original colon-form would re-emit the
  // deprecated shape that this module exists to suppress (#3584). Return an
  // empty string so callers see "no command" rather than the broken input.
  if (bare === '' || bare.trim() === '') return '';

  // Split on the first whitespace so only the command token is rewritten —
  // anything after the first space is caller-supplied arguments (phase
  // numbers, --flags, --paths C:\\Users\\Me, etc.) that must round-trip
  // untouched. Codex lowercases only the command token; preserving the
  // argument tail prevents path/flag corruption on case-sensitive systems.
  const wsMatch = bare.match(/^(\S+)(\s[\s\S]*)?$/);
  const token = wsMatch ? wsMatch[1] : bare;
  const tail = wsMatch && wsMatch[2] ? wsMatch[2] : '';

  const runtimeText = (typeof runtime === 'string' && runtime ? runtime : 'claude').toLowerCase();
  const rt = canonicalizeRuntimeName(runtimeText) || runtimeText;

  // Descriptor-driven: look up commandStyle from the capability registry.
  // Mirrors the lazy-require pattern from runtime-homes.cts §getGlobalConfigDir.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runtimes } = require('./capability-registry.cjs') as {
    runtimes: Record<string, { runtime?: { commandStyle?: string } }>;
  };
  const style = runtimes[rt]?.runtime?.commandStyle;

  if (style === 'shell-var') {
    // shell-var runtimes (currently: codex) use $gsd-<cmd> syntax. The command
    // token is lowercased because shell-var identifiers are conventionally
    // lowercase; matches the convertCodexSlash() projection in bin/install.js.
    return `$gsd-${token.toLowerCase()}${tail}`;
  }
  return `/gsd-${token}${tail}`;
}

/**
 * Resolve the explicit runtime for a project directory, from the two
 * explicit sources only — no default is applied.
 *
 *   env.GSD_RUNTIME  >  config.runtime  >  null
 *
 * Returns null when neither explicit source is set, so a caller can
 * distinguish "config said claude" from "nothing was set" (needed by
 * #3245's host-detection rung, which must only run when this returns null).
 *
 * @param projectDir - path to the project directory, or null/undefined
 * @param env - environment variables to read GSD_RUNTIME from; defaults to process.env
 * @returns the resolved runtime name, or null if neither source is set
 */
export function resolveExplicitRuntime(
  projectDir: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const envRuntime = resolveRuntimeNameFromCandidates(env['GSD_RUNTIME']);
  if (envRuntime) return envRuntime;
  if (projectDir) {
    try {
      // Read config.json directly (not via loadConfig). loadConfig has a side
      // effect of normalizing and re-writing legacy keys back to disk, which
      // would mutate the project file just to read the runtime name. We only
      // need the literal `runtime:` value, so a plain JSON read is sufficient
      // and side-effect-free.
      const configPath = path.join(projectDir, '.planning', 'config.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && 'runtime' in parsed) {
          const configRuntime = resolveRuntimeNameFromCandidates((parsed as Record<string, unknown>)['runtime']);
          if (configRuntime) return configRuntime;
        }
      }
    } catch {
      // Fall through to default — a missing/broken config must not crash
      // runtime output formatting.
    }
  }
  return null;
}

/**
 * Resolve the effective runtime for a project directory.
 *
 *   process.env.GSD_RUNTIME  >  config.runtime  >  per-install `.gsd-runtime`
 *   marker  >  'claude'
 *
 * The marker rung (#3364) sits BELOW both explicit sources and ABOVE the
 * default. Without it, a real non-Claude install whose `.planning/config.json`
 * carries no `runtime` key — which is every config `config-new-project` writes
 * — resolved to 'claude', so every consumer believed it was on Claude: the
 * isolation gate reported `harness-worktree`, `/gsd:settings` recommended
 * Worktrees and `/gsd:health` stayed quiet. #2446 fixed the installer side of
 * #2395 but never taught the resolver to read what it persists.
 *
 * The rung lives HERE, in the one canonical resolver, rather than in a call
 * site: a per-consumer fix forks precedence, so `dispatch-should-flatten` and
 * `resolve-dispatch-type` would answer 'claude' while the isolation query
 * answered 'cursor' for the same install.
 *
 * Deliberately NOT inside `resolveExplicitRuntime`: that function's null return
 * is the signal #3245's host-detection rung keys on, and the marker is an
 * install-time identity, not one of the two explicit per-session sources.
 * Placing it here leaves `resolveReportedRuntime`'s EXPLICIT rungs unchanged —
 * but that ladder is not left alone: this PR adds the marker to it separately,
 * in `host-runtime-detection.cts`, at a DIFFERENT position (BELOW detection
 * rather than above the default), because a live session signal outranks what a
 * tree was merely installed for. Both ladders gain the rung; they order it
 * differently on purpose. See that file's own comment for the reasoning. The
 * marker read is a bare file read — no config normalization, no writes.
 *
 * @param projectDir - path to the project directory, or null/undefined
 * @returns the resolved runtime name
 */
export function resolveRuntime(projectDir: string | null | undefined): string {
  const explicit = resolveExplicitRuntime(projectDir);
  if (explicit) return explicit;
  const marker = resolveRuntimeNameFromCandidates(readInstallRuntimeMarker());
  if (marker) return marker;
  return 'claude';
}

// ── Per-install runtime marker (#2297, relocated here for #2486) ─────────────
// `<install>/gsd-core/.gsd-runtime`, written at install time. Resolved relative
// to this module's own directory (`<install>/gsd-core/bin/lib`), so it follows
// the install it ships inside. Cached because it is read on hot resolution
// paths and cannot change within a process.
let _installMarkerCache: string | null | undefined;
export function readInstallRuntimeMarker(): string | null {
  if (_installMarkerCache !== undefined) return _installMarkerCache;
  try {
    const markerPath = path.join(__dirname, '..', '..', '.gsd-runtime');
    const raw = fs.readFileSync(markerPath, 'utf8').trim();
    _installMarkerCache = raw || null;
  } catch {
    // No marker: dev/source tree, or an install predating #2297. Fall through to
    // the 'claude' default (keeps tier aliases — never worse than the bug).
    _installMarkerCache = null;
  }
  return _installMarkerCache;
}

// Test seams for the install-marker rung (the dev/source tree has no marker, so
// the file read always bottoms out at 'claude' — these let tests exercise the
// marker rung and reset the module-level cache between cases).
export function _setInstallRuntimeMarkerForTests(value: string | null): void {
  _installMarkerCache = value;
}
export function _resetInstallRuntimeMarkerCacheForTests(): void {
  _installMarkerCache = undefined;
}

/**
 * Convenience: format using the runtime resolved from a project directory.
 * Equivalent to `formatGsdSlash(name, resolveRuntime(projectDir))`.
 */
export function formatGsdSlashFor(projectDir: string | null | undefined, commandName: unknown): unknown {
  return formatGsdSlash(commandName, resolveRuntime(projectDir));
}
