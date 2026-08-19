/**
 * install-shadow-report.cts — Cross-Scope Shadow Report Module (#2873, epic
 * #2866 Phase 4a — governed by
 * `.gsd/phase/feat-2873-cross-scope-shadowing/40-design.md`).
 *
 * A read-only PROJECTION over `resolveInstalledSurfaces`
 * (`installed-surface-resolver.cts`, #2872 Phase 3). That module answers
 * "what is installed"; it is documented there as read-only, and rendering
 * plus sanitization are a different concern with a different consumer set
 * (installer + `/gsd-health`) — the design doc's "Rejected" #5 is why this is
 * a separate leaf module rather than a second export bolted onto the
 * resolver.
 *
 * ── What "shadowed" means here ──────────────────────────────────────────────
 * A trigger is shadowed when `resolveTriggerSurface` (via the resolver)
 * recorded a non-null `shadowedBy` for it: two scopes both installed a
 * trigger-bearing artifact under the SAME trigger name, and only one wins.
 * For claude (`skills`@global vs `commands`@local) the KINDS differ, so the
 * loser's entire spec tree becomes unreachable through the trigger — the bug
 * #2218 diagnosed. For the 12 both-scopes-`skills` runtimes the kinds are the
 * SAME on both sides, so the loser is merely overridden, not vanished
 * (design row #5 / "Not-corruption"). `kindsDiffer` on `ShadowReport` is what
 * lets `renderShadowReport` word the two cases correctly.
 *
 * ── Report, don't correct (mirrors the resolver's own law) ─────────────────
 * `mismatches` surfaces a declared runtime/scope that disagrees with the
 * probed one (Postel's Law, design doc: liberal in what is accepted, but the
 * mismatch is never silently absorbed). This module never substitutes a
 * declared value for a probed one; it only reports the disagreement the
 * resolver already computed.
 *
 * ── Sanitize at the render seam ─────────────────────────────────────────────
 * `declaredRuntime` is attacker-influenceable (it comes from a manifest that
 * may live inside a merely-cloned repository) and length-bounded but
 * deliberately NOT charset-gated by the reader (`declaredRuntimeMatchesProbe`
 * needs the raw value there). THIS module is what renders it to an operator,
 * so this module owns the guard — `sanitizeForRender` strips ANSI escapes,
 * C0/C1 controls, and Unicode bidi overrides/isolates, then collapses
 * whitespace. It never truncates: `readInstallManifest` already caps at 64
 * chars, and a second truncation here would double-truncate.
 *
 * Trigger names, by contrast, are already `SAFE_STEM`-gated upstream
 * (`installed-surface-resolver.cts`'s `deriveStemsForKindEntry`) before they
 * ever reach a `TriggerSurface` — this module does not re-gate them.
 *
 * ── Per-scope truth filter (why this lives HERE, not in the resolver) ──────
 * `resolveOneRuntime` (`installed-surface-resolver.cts`) builds ONE union of
 * every installed scope's `stems` and hands that single list to
 * `resolveTriggerSurface`, which then synthesizes a candidate trigger for
 * EVERY stem at EVERY installed scope's trigger-bearing kind entry —
 * regardless of whether that specific scope's own manifest actually shipped
 * that stem. Concretely: a global `full`-profile install (stems a, b, c)
 * alongside a local `core`-profile install (stem a only) unions to
 * `{a, b, c}`, and `resolveTriggerSurface` then reports `commands@local`
 * candidates for b and c too — trigger names for artifacts that do not exist
 * on disk at that scope. Left unfiltered, this module would tell the user
 * `/gsd-b` and `/gsd-c` are shadowed local commands when there is no local
 * artifact for either at all — over-reporting that is not cosmetic, since
 * the whole point of this report is to make a real failure legible.
 *
 * `resolveTriggerSurface`'s API takes ONE stem list shared by every scope it
 * is asked about, so per-scope truth cannot be expressed through it without
 * either widening a shipped Phase-2 contract other callers may depend on, or
 * calling it once per scope and re-implementing its winner computation
 * (`isHigherPriority`) here as a second, driftable copy. `resolveOneRuntime`
 * / `resolveInstalledSurfaces` (Phase 3, #2872) is likewise a shipped module
 * this task deliberately leaves untouched. This module already receives the
 * full `InstalledRuntimeSurface`, including each scope's own REAL `stems`
 * list (`installed-surface-resolver.cts`'s `deriveStemsFromManifest`) — so
 * the correction belongs here, as a filter over `resolveTriggerSurface`'s
 * already-computed `shadowedBy` groups: a trigger is reported as shadowed
 * only when its underlying stem is present in BOTH the winner's scope's own
 * `stems` AND the shadowed side's scope's own `stems` — i.e. an artifact
 * genuinely exists at both scopes, not merely "some stem exists somewhere in
 * the union".
 *
 * `TriggerSurface` does not carry the originating stem OR the composing
 * prefix on its output — only the already-composed `trigger` string
 * (`${prefix}${stem}`) — so the stem cannot be read off it directly. Rather
 * than hand-roll a fixed-offset `trigger.slice(4)` (which would silently
 * assume every runtime's prefix is exactly `gsd-` — true today, but not a
 * contract this module owns), the prefix is recovered the honest way: by
 * re-resolving that scope's `ArtifactKind` layout (`resolveRuntimeArtifactLayout`
 * / `resolveRuntimeArtifactLayoutFromRegistry`, the SAME layout descriptor
 * `resolveTriggerSurface` itself reads its `entry.prefix` from) for the
 * winner's and shadowed side's own `(scope, kind)`, and reading `.prefix`
 * off the matching kind entry. This is metadata-only (constructing an
 * `ArtifactKind` never touches the filesystem — see
 * `runtime-artifact-layout.cts`'s kind-builder functions), so it costs
 * nothing beyond a small per-`(scope,kind)` memo. If a prefix cannot be
 * resolved at all (a `TypeError` from an unexpected registry shape), the
 * trigger is conservatively DROPPED rather than kept — the same
 * report-nothing-you-cannot-prove posture as the rest of this filter.
 *
 * ── Pure with respect to caller-visible state ───────────────────────────────
 * `buildShadowReport` builds a fresh `ShadowReport` (fresh arrays, fresh
 * objects) on every call, exactly as the resolver documents for itself
 * (`installed-surface-resolver.cts`'s "Pure with respect to caller-visible
 * state" paragraph) — no shared or cached state between calls.
 */

import { type InstallScope } from './install-scope.cjs';
import {
  resolveInstalledSurfaces,
  type ResolveInstalledSurfacesOptions,
  type InstalledRuntimeSurface,
  type InstalledScopeRecord,
} from './installed-surface-resolver.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeArtifactLayoutMod = require('./runtime-artifact-layout.cjs');
const { resolveRuntimeArtifactLayout, resolveRuntimeArtifactLayoutFromRegistry } = runtimeArtifactLayoutMod;

/** The registry shape `resolveRuntimeArtifactLayoutFromRegistry` accepts as
 *  its first argument — reused (not re-typed) so `opts.registry` can be
 *  forwarded to it, mirroring `installed-surface-resolver.cts`'s own
 *  `LayoutRegistryLike`. */
type LayoutRegistryLike = Parameters<typeof resolveRuntimeArtifactLayoutFromRegistry>[0];

/** `installed-surface-resolver.cts` does not export `TriggerSurface` by
 *  name (only via `InstalledRuntimeSurface.triggers`'s element type) —
 *  derived here rather than re-declared as a second, driftable shape. */
type TriggerSurface = InstalledRuntimeSurface['triggers'][number];

// ── Reason enum ─────────────────────────────────────────────────────────

export const SHADOW_REASON = Object.freeze({
  NOT_SHADOWED: 'not_shadowed',
  SCOPE_SHADOWED: 'scope_shadowed',
  RESOLVER_UNAVAILABLE: 'resolver_unavailable',
});

// ── Public types ────────────────────────────────────────────────────────

export interface ShadowedTrigger {
  trigger: string;
  winnerKind: string;
  winnerScope: InstallScope;
  shadowedKind: string;
  shadowedScope: InstallScope;
}

export interface DeclarationMismatch {
  scope: InstallScope;
  declaredRuntime: string | null;
  declaredRuntimeMatchesProbe: boolean | null;
  declaredScope: InstallScope | null;
  declaredScopeMatchesProbe: boolean | null;
}

export interface ShadowReport {
  runtime: string;
  reason: string;
  shadowed: boolean;
  winner: { kind: string; scope: InstallScope } | null;
  shadowedSide: { kind: string; scope: InstallScope } | null;
  kindsDiffer: boolean;
  triggers: ShadowedTrigger[];
  mismatches: DeclarationMismatch[];
}

// ── Sanitization ────────────────────────────────────────────────────────

/** CSI (`\x1b[...final`) and OSC (`\x1b]...BEL-or-ST`) sequences. An
 *  unterminated/malformed sequence is left for the C0-control strip below to
 *  remove the bare `\x1b` byte — liberal, never a throw. */
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** C0 controls (`\x00`-`\x1f`, including any `\x1b` the ANSI strip above did
 *  not consume) and DEL/C1 (`\x7f`-`\x9f`). */
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** Unicode bidi embedding/override controls (U+202A-U+202E) and bidi
 *  isolates (U+2066-U+2069) — the RTL-spoofing class the design doc's row
 *  #13 names. */
const BIDI_RE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/** Combining marks (U+0300-U+036F) — "zalgo" text. Stacked onto the
 *  preceding base character, an unbounded run visually overflows into
 *  adjacent terminal cells/rows even though the string stays within the
 *  64-char cap `readInstallManifest` enforces. Written as `\u{...}` escapes
 *  (not literal combining characters) so the source itself stays plain
 *  ASCII and does not visually combine in editors/diffs. */
const COMBINING_MARK_RE = /[\u{0300}-\u{036F}]/gu;

/** Zero-width characters: ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D), and
 *  BOM/ZWNBSP (U+FEFF). None of these are JS `\s`, so they survive both the
 *  char-count cap and the whitespace-collapse step below undetected. */
const ZERO_WIDTH_RE = /[\u{200B}-\u{200D}\u{FEFF}]/gu;

/**
 * Sanitize a `declaredRuntime` (or any similarly attacker-influenceable
 * string) for terminal/console rendering. `null` passes through as `null`;
 * `''` passes through as `''`. Strips ANSI escapes, C0/C1 controls, Unicode
 * bidi overrides/isolates, combining marks (zalgo), and zero-width
 * characters (replacing each stripped run with nothing — never a space),
 * then collapses any remaining whitespace run (including adjacent spaces
 * left behind by a removed newline) to a single space and trims.
 *
 * Idempotent by construction: once ANSI/control/bidi/combining/zero-width
 * bytes are gone and whitespace is collapsed to single internal spaces with
 * no leading/trailing space, a second pass finds nothing left to strip or
 * collapse. Pure character-class filter — never truncates; `readInstallManifest`
 * already caps at 64 chars.
 */
export function sanitizeForRender(value: string | null): string | null {
  if (value === null) return null;
  const stripped = value
    .replace(ANSI_RE, '')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(COMBINING_MARK_RE, '')
    .replace(ZERO_WIDTH_RE, '');
  return stripped.replace(/\s+/g, ' ').trim();
}

// ── Per-scope truth filter helpers ─────────────────────────────────────

/**
 * Build a `(scope, kind) -> prefix | null` lookup for one runtime, memoized
 * per call to `buildShadowReport` (never shared across calls — matches this
 * module's "fresh objects on every call" contract). `null` means "could not
 * be resolved" (unknown scope record, or a `TypeError` from the layout
 * resolver) — the caller treats that as "cannot honestly attribute this
 * trigger to a real stem here", not as "assume it is fine".
 */
function buildPrefixLookup(
  runtime: string,
  scopeRecords: Map<InstallScope, InstalledScopeRecord>,
  opts: ResolveInstalledSurfacesOptions,
): (scope: InstallScope, kind: string) => string | null {
  const cache = new Map<string, string | null>();
  return (scope: InstallScope, kind: string): string | null => {
    const key = `${scope}:${kind}`;
    if (cache.has(key)) return cache.get(key) as string | null;
    const record = scopeRecords.get(scope);
    let prefix: string | null = null;
    if (record) {
      try {
        const layout = opts.registry !== undefined
          ? resolveRuntimeArtifactLayoutFromRegistry(opts.registry as LayoutRegistryLike, runtime, record.configHome, record.scope)
          : resolveRuntimeArtifactLayout(runtime, record.configHome, record.scope);
        const kindEntry = (layout.kinds as Array<{ kind: string; prefix: string }>).find((k) => k.kind === kind);
        prefix = kindEntry ? kindEntry.prefix : null;
      } catch {
        // Unknown runtime / malformed registry — degrade to "cannot resolve",
        // never throw out of a report builder (matches this module's own
        // RESOLVER_UNAVAILABLE degrade-not-propagate posture above).
        prefix = null;
      }
    }
    cache.set(key, prefix);
    return prefix;
  };
}

/** `trigger` minus `prefix`, or `null` when `prefix` is unknown, does not
 *  actually prefix `trigger`, or the remainder would be empty (a `prefix`
 *  covering the whole trigger string is not a real stem). */
function stemFromTrigger(trigger: string, prefix: string | null): string | null {
  if (prefix === null || !trigger.startsWith(prefix)) return null;
  const stem = trigger.slice(prefix.length);
  return stem === '' ? null : stem;
}

/**
 * True when `t` (a `resolveTriggerSurface`-reported shadowed trigger) is a
 * REAL cross-scope shadow: its stem is present in the winner's OWN scope
 * `stems` and, independently, in the shadowed side's OWN scope `stems`. See
 * the module-level "Per-scope truth filter" comment for why this check
 * exists and why it lives here rather than in the resolver.
 */
function isGenuinelyShadowed(
  t: TriggerSurface,
  scopeRecords: Map<InstallScope, InstalledScopeRecord>,
  prefixFor: (scope: InstallScope, kind: string) => string | null,
): boolean {
  if (t.shadowedBy === null) return false;
  const winnerRecord = scopeRecords.get(t.shadowedBy.scope);
  const shadowedRecord = scopeRecords.get(t.scope);
  const winnerStem = stemFromTrigger(t.trigger, prefixFor(t.shadowedBy.scope, t.shadowedBy.kind));
  const shadowedStem = stemFromTrigger(t.trigger, prefixFor(t.scope, t.kind));
  if (winnerStem === null || shadowedStem === null) return false;
  return (winnerRecord?.stems ?? []).includes(winnerStem) && (shadowedRecord?.stems ?? []).includes(shadowedStem);
}

// ── Report builder ──────────────────────────────────────────────────────

/**
 * Build a shadow report for one runtime. `opts` is forwarded VERBATIM to
 * `resolveInstalledSurfaces` — this function adds no option of its own.
 * Production call shape: `buildShadowReport('claude', { home, cwd })`.
 *
 * A `resolveInstalledSurfaces` `TypeError` (unknown runtime, or
 * `configHome.kind === 'none'`, e.g. vscode — design row #7) degrades to
 * `reason: RESOLVER_UNAVAILABLE` rather than propagating: an install-time or
 * `/gsd-health` caller must never crash because a runtime has no installable
 * config directory. Any other error type is rethrown — mirrors the
 * resolver's own `TypeError` narrowing (`resolveInstalledSurfaces`'s sweep
 * catch, and `buildScopeRecord`'s stem-derivation catch) so the two cannot
 * drift apart.
 */
export function buildShadowReport(runtime: string, opts: ResolveInstalledSurfacesOptions = {}): ShadowReport {
  let surfaces: InstalledRuntimeSurface[];
  try {
    surfaces = resolveInstalledSurfaces(runtime, opts);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return {
      runtime,
      reason: SHADOW_REASON.RESOLVER_UNAVAILABLE,
      shadowed: false,
      winner: null,
      shadowedSide: null,
      kindsDiffer: false,
      triggers: [],
      mismatches: [],
    };
  }

  // resolveInstalledSurfaces(runtime, opts) with an explicit string `runtime`
  // always returns exactly one element (see its own doc comment).
  const surface = surfaces[0];

  // Per-scope truth filter (see module comment): `surface.triggers` may
  // contain candidates synthesized from the CROSS-SCOPE stem union
  // (`installed-surface-resolver.cts`'s `stemUnion`) that do not correspond
  // to a real artifact at one or both scopes. Only a trigger whose stem is
  // provably present in BOTH the winner's own `stems` and the shadowed
  // side's own `stems` is reported.
  const scopeRecords = new Map<InstallScope, InstalledScopeRecord>(surface.scopes.map((r) => [r.scope, r] as const));
  const prefixFor = buildPrefixLookup(runtime, scopeRecords, opts);
  const shadowedSurfaces = surface.triggers.filter((t) => isGenuinelyShadowed(t, scopeRecords, prefixFor));
  const triggers: ShadowedTrigger[] = shadowedSurfaces
    .map((t) => ({
      trigger: t.trigger,
      // `shadowedBy` is non-null by construction of the filter above.
      winnerKind: t.shadowedBy!.kind,
      winnerScope: t.shadowedBy!.scope,
      shadowedKind: t.kind,
      shadowedScope: t.scope,
    }))
    .sort((a, b) => (a.trigger < b.trigger ? -1 : a.trigger > b.trigger ? 1 : 0));

  const mismatches: DeclarationMismatch[] = [];
  for (const record of surface.scopes) {
    if (record.declaredRuntimeMatchesProbe === false || record.declaredScopeMatchesProbe === false) {
      mismatches.push({
        scope: record.scope,
        // Postel's Law (design doc): sanitized here because this is the
        // render seam — never silently absorbed, always surfaced.
        declaredRuntime: sanitizeForRender(record.declaredRuntime),
        declaredRuntimeMatchesProbe: record.declaredRuntimeMatchesProbe,
        declaredScope: record.declaredScope,
        declaredScopeMatchesProbe: record.declaredScopeMatchesProbe,
      });
    }
  }

  if (triggers.length === 0) {
    return {
      runtime,
      reason: SHADOW_REASON.NOT_SHADOWED,
      shadowed: false,
      winner: null,
      shadowedSide: null,
      kindsDiffer: false,
      triggers: [],
      mismatches,
    };
  }

  // Winner/shadowedSide are the (kind,scope) pair of the FIRST shadowed
  // trigger (post-sort, for the same determinism reason the array itself is
  // sorted). They are asserted-by-construction uniform across the whole set
  // for every runtime this module has seen (every trigger shadowed by the
  // SAME scope, with the SAME two kinds, on one machine) — but if a future
  // registry shape ever produced a non-uniform set, this still returns the
  // first pair rather than throwing; every distinct (kind,scope) pair is
  // already visible per-entry in `triggers` itself, so nothing is lost.
  const first = triggers[0];
  const winner = { kind: first.winnerKind, scope: first.winnerScope };
  const shadowedSide = { kind: first.shadowedKind, scope: first.shadowedScope };

  return {
    runtime,
    reason: SHADOW_REASON.SCOPE_SHADOWED,
    shadowed: true,
    winner,
    shadowedSide,
    kindsDiffer: winner.kind !== shadowedSide.kind,
    triggers,
    mismatches,
  };
}

// ── Renderer ────────────────────────────────────────────────────────────

/**
 * Render a `ShadowReport` to plain lines — no ANSI, no color, no leading
 * indent. The caller (installer console output, `/gsd-health` text mode)
 * owns terminal formatting; this keeps the module free of terminal concerns
 * and testable without a spawned process. Structured (`--json`) health
 * output (design row #17) consumes the typed `ShadowReport` directly and
 * never calls this function.
 *
 * `reason !== SCOPE_SHADOWED` renders nothing — there is nothing to report
 * (design rows #1, #2, #6, #7, #8, #11).
 */
export function renderShadowReport(report: ShadowReport, opts: { sampleLimit?: number } = {}): string[] {
  if (report.reason !== SHADOW_REASON.SCOPE_SHADOWED || report.winner === null || report.shadowedSide === null) {
    return [];
  }

  const sampleLimit = opts.sampleLimit ?? 5;
  const count = report.triggers.length;
  const plural = count === 1 ? '' : 's';
  const { winner, shadowedSide, kindsDiffer } = report;

  const lines: string[] = [];
  lines.push(
    kindsDiffer
      ? `${count} trigger${plural} shadowed: the ${shadowedSide.scope} ${shadowedSide.kind} surface is unreachable through ${count === 1 ? 'that trigger' : 'those triggers'} — ${winner.scope} ${winner.kind} wins instead.`
      : `${count} trigger${plural} shadowed: the ${shadowedSide.scope} ${shadowedSide.kind} ${count === 1 ? 'entry is' : 'entries are'} overridden by ${winner.scope} ${winner.kind}.`,
  );

  // Trigger names in `report.triggers` are already SAFE_STEM-gated upstream
  // (installed-surface-resolver.cts's deriveStemsForKindEntry) — no re-gating
  // needed here.
  const sample = report.triggers.slice(0, sampleLimit);
  for (const t of sample) {
    lines.push(`  - ${t.trigger}: ${t.shadowedScope}/${t.shadowedKind} shadowed by ${t.winnerScope}/${t.winnerKind}`);
  }
  const remaining = count - sample.length;
  if (remaining > 0) {
    lines.push(`  ...and ${remaining} more`);
  }

  for (const m of report.mismatches) {
    // Re-sanitized defensively: `buildShadowReport` already sanitizes
    // `declaredRuntime` before it reaches a `ShadowReport`, and
    // `sanitizeForRender` is idempotent, so this is a no-op in the normal
    // path and a real guard against a hand-built `ShadowReport` (e.g. a
    // renderer-only test) that skipped it.
    const declaredRuntime = sanitizeForRender(m.declaredRuntime);
    const parts: string[] = [];
    if (m.declaredRuntimeMatchesProbe === false) {
      parts.push(`declared runtime "${declaredRuntime}" does not match this runtime`);
    }
    if (m.declaredScopeMatchesProbe === false) {
      parts.push(`declared scope "${m.declaredScope}" does not match the probed ${m.scope} scope`);
    }
    lines.push(`Note: ${m.scope} scope manifest mismatch — ${parts.join('; ')}.`);
  }

  return lines;
}
