/**
 * Install Surface Shadowing rule (#2873, epic #2866 Phase 4a — governed by
 * `.gsd/phase/feat-2873-cross-scope-shadowing/40-design.md`).
 *
 * One code, W028, surfacing `install-shadow-report.cts`'s `ShadowReport` as
 * a `/gsd-health` diagnostic — the design doc's row #4 ("one diagnostic,
 * severity WARNING, same projection" as the install-time report). WARNING
 * severity, ADVISE remedy with `risk: NONE`: shadowing is never auto-fixable
 * (there is no single correct scope to remove) so this is advisory only,
 * mirroring `agent-install.cts`'s W010 shape.
 *
 * Reaches OUTSIDE the planning snapshot the same way `agent-install.cts`
 * does for W010: `resolveRuntime(cwd)` (`runtime-slash.cjs`) resolves the
 * runtime id from `process.env.GSD_RUNTIME` / `config.runtime` / the
 * `'claude'` default (never throws), using `snapshot.cwd`
 * (`planning-snapshot.cts`'s `buildPlanningSnapshot` — `path.resolve(cwd)`)
 * as the project directory. `buildShadowReport` is then called with that
 * `cwd` so the local scope resolves against the project actually being
 * health-checked, while `home` is left un-injected so the resolver defaults
 * to `os.homedir()` — the real machine, same production call shape the
 * installer uses.
 *
 * `check(snapshot)` degrades to `[]` (never throws) whenever there is
 * nothing installable to report: `buildShadowReport` itself already
 * degrades an unresolvable runtime (`configHome.kind === 'none'`, e.g.
 * vscode — design row #7) to `reason: RESOLVER_UNAVAILABLE`, which
 * `renderShadowReport` renders as `[]`; the try/catch around both calls
 * below additionally absorbs any other unexpected throw (design row D5),
 * since this rule is advisory and must never make `/gsd-health` itself
 * fail.
 *
 * Design: .gsd/phase/feat-2873-cross-scope-shadowing/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/install-surface-shadowing.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/install-surface-shadowing.cjs
 * (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');
type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
type Rule = healthDiagnosticMod.Rule;
type Diagnostic = healthDiagnosticMod.Diagnostic;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import installShadowReportMod = require('../install-shadow-report.cjs');
const { buildShadowReport, renderShadowReport } = installShadowReportMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeSlashMod = require('../runtime-slash.cjs');
const { resolveRuntime } = runtimeSlashMod;

import { PACKAGE_NAME } from '../package-identity.cjs';

/**
 * `check(snapshot)` for W028 — see module header for the degrade-to-`[]`
 * cases and the runtime-resolution mechanism reused from `agent-install.cts`.
 */
function checkInstallSurfaceShadowing(snapshot: PlanningSnapshot): Diagnostic[] {
  let lines: string[];
  let runtime: string;
  try {
    runtime = resolveRuntime(snapshot.cwd);
    const report = buildShadowReport(runtime, { cwd: snapshot.cwd });
    // `renderShadowReport` returns `[]` for every reason other than
    // SCOPE_SHADOWED (design rows #1, #2, #6, #7, #8, #11), and sanitizes
    // every `declaredRuntime` it interpolates via `sanitizeForRender`
    // internally (`install-shadow-report.cts`) — this rule's `message`
    // reuses that render path rather than re-sanitizing, so the
    // sanitize-at-the-render-seam guarantee (design row #13) holds here too.
    // Trigger names are already SAFE_STEM-gated upstream
    // (`installed-surface-resolver.cts`'s `deriveStemsForKindEntry`) before
    // they ever reach a rendered line — no re-gating needed here either.
    lines = renderShadowReport(report);
  } catch {
    // Advisory rule: an unresolvable runtime, a `configHome.kind === 'none'`
    // runtime, or any other unexpected failure degrades to "no finding",
    // never a thrown exception that would break `/gsd-health` itself
    // (design row D5).
    return [];
  }

  if (lines.length === 0) return [];

  return [
    {
      code: 'W028',
      severity: SEVERITY.WARNING,
      message: lines.join(' '),
      remedy: adviseRemedy(`Review install scopes for ${runtime}: npx ${PACKAGE_NAME}@latest`),
    },
  ];
}

const RULES: Rule[] = [
  {
    code: 'W028',
    severity: SEVERITY.WARNING,
    description: 'A GSD-owned install scope shadows another on this machine',
    repairable: false,
    check: checkInstallSurfaceShadowing,
  },
];

export = { RULES };
