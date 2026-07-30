/**
 * capability-loader.cts — runtime Capability Registry overlay (ADR-1244 D2).
 *
 * Promotes the registry from a frozen data file to a module with an interface:
 *
 *     loadRegistry({ includeInstalled }) -> composed registry
 *
 * It composes the **first-party frozen registry** (the committed, generated
 * `capability-registry.cjs`) with a **validated installed overlay** — third-party
 * capability manifests read at runtime from per-scope install roots:
 *   - global:  $GSD_HOME/.gsd/capabilities/<id>/capability.json  (GSD_HOME defaults to ~)
 *   - project: <projectRoot>/.gsd/capabilities/<id>/capability.json
 *
 * Invariants enforced over the merged set (first-party ∪ overlay):
 *   - First-party always wins: an overlay whose `id`, owned skill/agent stem, or
 *     federated config key collides with first-party (or uses a reserved `gsd-` /
 *     `gsd-core-` / `anthropic-` id prefix) is rejected.
 *   - Load-time re-gate (default-resilient): an overlay that fails validation or
 *     whose `engines.gsd` does not satisfy the running GSD version is SKIPPED
 *     with a warning — it never crashes the loop. A skipped capability that
 *     declares a `gate` is additionally recorded in
 *     `_overlay.incompatibleGateCapIds` / `_overlay.blockedGates` so the loop
 *     resolver can surface a loud fail-OPEN advisory for that gate (#2009): the
 *     un-evaluable gate is skipped (not enforced) with a remediation message,
 *     rather than silently vanishing.
 *
 * The merged registry is materialized by the canonical `buildRegistry`
 * (re-exported from the generator, which ships) over a cap-map reconstructed
 * from the frozen registry's capability objects plus the accepted overlay
 * capabilities — so every derived view (bySkill, byLoopPoint, configSchema,
 * capabilityClusters, profileMembership, …) is computed by exactly one builder
 * and cannot drift from the first-party path.
 *
 * Install never executes capability code here (staging/exec belongs to ADR-1244
 * D3/D5); this module only READS and VALIDATES declarations.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Registry = Record<string, unknown>;

interface CapManifest {
  id: string;
  role?: string;
  version?: string;
  skills?: string[];
  agents?: string[];
  commands?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  gates?: unknown[];
  engines?: { gsd?: string };
}

interface ValidatorModule {
  validateCapability: (cap: unknown, id: string) => string[];
  /** Returns an error array (e.g. fragment path escapes the capability dir) — NOT a throw. */
  materializeHookFragments: (cap: unknown, capDir: string) => string[];
  validateAgainstContract: (cap: unknown, capId: string) => string[];
  validateConsumesGlobal: (capMap: Map<string, unknown>) => string[];
  validateCrossCapability: (capMap: Map<string, unknown>, centralKeys: Set<string>) => string[];
  /**
   * ADR-2782 D4.3 — NON-FATAL diagnostics for an ACCEPTED capability (e.g. an
   * unknown field inside a `reviewer` body, which is ignored with a warning
   * rather than failing validation so a manifest built for a newer GSD degrades
   * visibly instead of being rejected). Returns warnings; never throws.
   * Optional so an older built validator without it still loads.
   */
  collectReviewerWarnings?: (cap: unknown) => string[];
}
interface SemverModule {
  semverSatisfies: (version: unknown, range: unknown) => boolean;
}
interface ProjectRootModule {
  findProjectRoot: (startDir: string) => string | null;
  /** #1459 IC-01/CB-4: the canonical realpath'd consent project root (RECORD/LOOKUP/revoke parity). */
  consentProjectRoot: (cwd: string) => string;
}
interface GeneratorModule {
  buildRegistry: (capMap: Map<string, unknown>) => Registry;
  loadCentralConfigKeys: () => Set<string>;
}
interface LedgerModule {
  /** THE single per-entry validator (shared with capability-ledger's readers) — loader parity. */
  isValidLedgerEntry: (id: unknown, entry: unknown) => boolean;
  /** Shared fd-based bounded reader: content, null for ENOENT, or THROWS (non-regular/oversized/IO). */
  readSmallRegularFile: (filePath: string, maxBytes: number) => string | null;
}
interface ConsentModule {
  /**
   * #1459 CB-1/CB-2: the consent decision is bound to the RECOMPUTED full-bundle content hash, not
   * the repo-plantable ledger integrity nor the executable-only disclosure signature.
   */
  hasProjectConsent: (args: {
    gsdHome?: string;
    projectRoot: string;
    id: string;
    contentHash: string;
  }) => boolean;
  /** Recompute the full-bundle content hash over capDir (manifest AND artifacts AND identity). */
  bundleContentHash: (capDir: string) => string;
}

export interface LoadRegistryOptions {
  /** When true, compose the validated installed overlay on top of first-party. */
  includeInstalled?: boolean;
  /** Working directory used to locate the project-scoped overlay root. */
  cwd?: string;
  /** Override the global overlay home (defaults to GSD_HOME env or os.homedir()). */
  gsdHome?: string;
  /** Override the running GSD version used for engines.gsd satisfaction. */
  hostVersion?: string;
  /**
   * Optional configHome root for load-time write-confinement of installed
   * third-party descriptors (ADR-1239 Phase C-2 / #1681). When set, each
   * installed overlay's declared destSubpaths must resolve within this root or
   * the descriptor is rejected fail-closed (skip + warn). Omit to rely on the
   * install-time gate only (backward-compatible).
   */
  configHome?: string;
}

export interface OverlaySkip {
  id: string;
  scope: 'global' | 'project';
  reason: string;
  /**
   * #1459 IC-02: a STRUCTURAL discriminant for the skip so consumers (gsd-tools `list`) classify a
   * warning by `kind`, not by matching the human-readable `reason` prose (which is free to change).
   * `'unconsented'` is the project-scope no-consent-record case the list command marks INACTIVE; other
   * skips carry no `kind` (they are first-party-wins / validation / engines / pending diagnostics).
   */
  kind?: 'unconsented';
}

export interface BlockedGate {
  /** Loop extension point the skipped capability declared a gate at. */
  point: string;
  /** The skipped capability's id. */
  capId: string;
  /** Why the capability was skipped. */
  reason: string;
}

export interface OverlayMeta {
  /** Capabilities skipped at load, with the reason (surfaced to the user). */
  warnings: OverlaySkip[];
  /**
   * ADR-2782 D4.3 — non-fatal diagnostics for capabilities that were ACCEPTED.
   * Distinct from `warnings`, which records capabilities that were SKIPPED: a
   * consumer that treats every `warnings` entry as "inactive" would mislabel an
   * active capability if these were folded in. Today this carries unknown-field
   * notices from a `reviewer` body built for a newer GSD — the case D4.3 exists
   * for, which validates cleanly and so would otherwise surface nowhere at all.
   */
  diagnostics: string[];
  /** Skipped capabilities that declared a gate — the loop must fail CLOSED for these. */
  incompatibleGateCapIds: string[];
  /**
   * Per-point fail-closed records: for each gate a skipped capability declared at
   * a known loop point, the loop resolver must inject a blocking gate at that
   * point rather than proceeding as if the gate had passed.
   */
  blockedGates: BlockedGate[];
  /**
   * Absolute install-root directory for each ACCEPTED OVERLAY (third-party) capability that
   * declares `commands` — `capId → <scope>/.gsd/capabilities/<capId>`. First-party capabilities
   * are NOT listed here (their command modules ship in `bin/lib/`). ADR-1244 Phase 5 (D7) uses this
   * to dispatch a third-party command family by `require()`-ing its router module FROM the install
   * root, confined to that root. Only committed (non-`_pending`) capabilities reach this map, so its
   * presence is the consent+commit signal a runtime dispatcher needs.
   */
  commandRoots: Record<string, string>;
}

const RESERVED_ID_PREFIX = /^(gsd-|gsd-core-|anthropic-)/;
const GSD_HOME_DIRNAME = '.gsd';
/**
 * GENEROUS DoS backstop for the bounded per-scope ledger read (mirrors capability-ledger's
 * LEDGER_MAX_BYTES). The project-scope ledger is repo-plantable untrusted content; reading it via
 * the shared fd reader (regular-file + size cap) means a FIFO/device/symlinked ledger can no longer
 * BLOCK (the #1459 raw-readFileSync hang) or read unbounded.
 */
const LEDGER_MAX_BYTES = 8 * 1024 * 1024;
/**
 * #1459 finding 2 (HIGH): GENEROUS DoS backstop on a project-plantable `capability.json`. The loader
 * MUST read the manifest via the shared bounded fd reader (regular-file + size cap, no FIFO hang),
 * NOT a raw `fs.readFileSync` — a repo-planted FIFO/device manifest would otherwise BLOCK the loader
 * forever and an oversized manifest would read unbounded into memory (OOM). A legitimate manifest is a
 * few KiB of declarative JSON; 8 MiB is wildly more than any real capability.json. A null/oversized/
 * non-regular read → SKIP the overlay (warning), fail-closed.
 */
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Test seams (#1461). The validator and generator are normally `require()`d
// fresh inside loadRegistry. These optional overrides let a test inject a
// validator whose cross-capability check THROWS (OVL-1) or a generator whose
// buildRegistry THROWS (OVL-2), to prove the loader still NEVER crashes the
// loop — it skips the offending overlay with a warning / falls back to the
// frozen first-party registry. Pass null to restore the real module.
// ---------------------------------------------------------------------------
let _validatorOverride: ValidatorModule | null = null;
let _generatorOverride: GeneratorModule | null = null;

/** Test seam: override the capability validator module. Pass null to restore. */
function _setValidatorForTest(v: ValidatorModule | null): void {
  _validatorOverride = v;
}
/** Test seam: override the registry generator module. Pass null to restore. */
function _setGeneratorForTest(g: GeneratorModule | null): void {
  _generatorOverride = g;
}

/**
 * Resolve the running GSD version; fail-closed to '0.0.0' if it cannot be read.
 *
 * Prefer the authoritative `gsd-core/VERSION` the installer writes for EVERY runtime
 * (libDir = gsd-core/bin/lib/, so `../../VERSION` = gsd-core/VERSION). This is reliable
 * across all installed layouts — including runtimes that get no marker package.json, and
 * local installs where the walked-up `../../../package.json` would resolve to the USER's
 * own project and report a wrong version (#1920). Fall back to the runtime-root
 * package.json for the dev/source tree, then fail-closed. Mirrors resolveVersionFrom()
 * (#1383). `libDir` is injectable for tests; it defaults to this module's directory.
 */
export function readHostVersion(libDir: string = __dirname): string {
  const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;
  try {
    const v = fs.readFileSync(path.join(libDir, '..', '..', 'VERSION'), 'utf8').trim();
    if (SEMVER_PREFIX.test(v)) return v;
  } catch { /* not an installed tree (no gsd-core/VERSION) */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const pkg: { version?: string } = require(path.join(libDir, '..', '..', '..', 'package.json'));
    if (pkg && typeof pkg.version === 'string' && SEMVER_PREFIX.test(pkg.version)) return pkg.version;
  } catch { /* runtime root has no package.json */ }
  return '0.0.0';
}

/**
 * Canonicalize a directory path for dedup/scope-escalation comparison. #1459 finding 1 (HIGH): the dedup
 * MUST collapse two DIFFERENT LEXICAL paths that name the SAME PHYSICAL directory (a symlink) to one key,
 * else a symlinked GSD_HOME aliasing the project root is scanned once as trusted 'global' BEFORE the
 * 'project' scan and the in-repo `.gsd/capabilities` bundle bypasses the CB-3 consent gate via aliasing.
 * `fs.realpathSync` resolves symlinks to the physical path; on ENOENT/IO error it falls back to
 * `path.resolve` (a not-yet-created overlay dir cannot be realpath'd).
 *
 * #1459 CONVERGENCE finding 3 (LOW/MED): the realpath FAILURE must be reported to the caller (the
 * `realpathFailed` flag), NOT silently swallowed. The old behavior — fall back to `path.resolve` while
 * preserving the candidate's ORIGINAL scope — was not strictly fail-safe: a symlinked GSD_HOME whose
 * realpath THROWS (a race / odd-FS) would key on its SYMLINK-LEXICAL path, which differs from the
 * project candidate's realpath'd key, so the two would NOT merge and the aliased global root would be
 * scanned as trusted-'global' (no consent record required) — parking an aliased project tree in the
 * trusted-global slot. The caller (`overlayRoots`) uses `realpathFailed` to classify a realpath-failed
 * GLOBAL candidate CONSERVATIVELY (consent-required 'project'), so a race/odd-FS can never aliased-upgrade
 * an in-repo bundle to trusted-global. The fallback key is still `path.resolve` (best-effort dedup); a
 * normal ENOENT (the global capabilities dir simply does not exist yet) still resolves to no scan because
 * the later readdir fails — the conservative reclassification is harmless when there is nothing to read.
 */
function canonicalDir(dir: string): { path: string; realpathFailed: boolean; enoent: boolean } {
  try {
    return { path: fs.realpathSync(dir), realpathFailed: false, enoent: false };
  } catch (err) {
    // #1459 finding 1 (round 6): distinguish a NON-EXISTENT overlay dir (ENOENT — there is simply nothing
    // to scan at that scope, so the fail-safe demotion must NOT fire) from a realpath that fails for ANOTHER
    // reason (race / odd-FS / EIO / EACCES — the dir may exist but is uncanonicalizable, so we cannot prove
    // physical distinctness and MUST fail safe toward needs-consent).
    const code = (err as NodeJS.ErrnoException).code;
    const enoent = code === 'ENOENT' || code === 'ENOTDIR';
    return { path: path.resolve(dir), realpathFailed: true, enoent };
  }
}

/**
 * The ordered overlay install roots (global first, then project), deduped by
 * CANONICAL (realpath'd) absolute path so a single physical directory is never scanned twice (which
 * would otherwise self-report a spurious id collision when the project lives
 * under the GSD home, or in tests where both resolve to the same fixture).
 *
 * #1459 CB-3: when the consent-global home resolves EQUAL to (or an ancestor whose .gsd collides with)
 * a GENUINE project root, the global overlay dir and the project overlay dir are the SAME directory.
 * The dedup must NOT then keep it as 'global' (trusted, no consent record required) — that would let an
 * in-repo bundle bypass consent simply because GSD_HOME pointed at the repo. On a collision the
 * surviving scope escalates to the MORE RESTRICTIVE 'project' (consent-required), but ONLY when the
 * colliding root is a GENUINE marker'd project (a `.planning/` dir or a `.git`). `findProjectRoot` is
 * total — it returns `cwd` itself when no marker exists — so a bare GSD_HOME with no project marker
 * (the user's own home; also the test-fixture `cwd === home` no-op) must stay 'global' and NOT spuriously
 * demand consent.
 *
 * #1459 finding 1 (HIGH): BOTH the dedup key AND the CB-3 collision comparison are keyed on the
 * realpath'd path (canonicalDir), so a symlinked GSD_HOME that physically IS the project root collides
 * and escalates to consent-required 'project' — it can no longer be aliased into the trusted-global slot.
 *
 * #1459 finding 1 (HIGH, ROUND 6): the trusted-global slot is now gated on PROVABLE distinctness from the
 * project tree — realpath(global) AND realpath(project) must BOTH succeed AND resolve to DIFFERENT physical
 * paths. The earlier one-sided rule (demote only a realpath-FAILED *global* candidate) still allowed the
 * symlinked-GSD_HOME bypass: when GSD_HOME aliases the project root, the GLOBAL candidate realpaths fine
 * while the PROJECT candidate's realpath fails, so the keys never collide and the in-repo bundle stays in
 * the no-consent global slot. If distinctness cannot be proven (either realpath throws, or both resolve
 * EQUAL) AND there is a genuine project root, the global is demoted to consent-required 'project'.
 */
function hasGenuineProjectMarker(dir: string): boolean {
  try {
    const planning = path.join(dir, '.planning');
    if (fs.existsSync(planning) && fs.statSync(planning).isDirectory()) return true;
  } catch { /* fall through */ }
  try {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
  } catch { /* fall through */ }
  return false;
}

function overlayRoots(cwd: string, gsdHome?: string): Array<{ dir: string; scope: 'global' | 'project' }> {
  const roots: Array<{ dir: string; scope: 'global' | 'project' }> = [];
  const byPath = new Map<string, { dir: string; scope: 'global' | 'project' }>();
  const add = (dir: string, scope: 'global' | 'project', canonical: { path: string; realpathFailed: boolean }, genuineProject = false): void => {
    const resolved = path.resolve(dir);
    // #1459 finding 1: the DEDUP KEY (and thus the CB-3 scope-escalation comparison) is the CANONICAL
    // (realpath'd) path, so a symlinked GSD_HOME that physically IS the project root collides here (and
    // escalates below) instead of being scanned as a distinct trusted 'global' root. The SCANNED path
    // (`entry.dir`) stays the lexical `path.resolve` value — the readdir/commandRoots path is unchanged
    // for the common (non-symlinked) case; only the dedup/escalation decision is realpath-aware.
    const key = canonical.path;
    const existing = byPath.get(key);
    if (existing) {
      // CB-3: a dir already claimed escalates to the more restrictive scope ONLY for a GENUINE project
      // root — so a real GSD_HOME == projectRoot (incl. via a symlink) still requires consent, while a
      // marker-less home stays trusted-global (and the test-fixture cwd===home no-op is preserved).
      if (existing.scope === 'global' && scope === 'project' && genuineProject) existing.scope = 'project';
      return;
    }
    const entry = { dir: resolved, scope };
    byPath.set(key, entry);
    roots.push(entry);
  };
  const home = gsdHome || process.env['GSD_HOME'] || os.homedir();
  const globalDir = path.join(home, GSD_HOME_DIRNAME, 'capabilities');
  const globalCanon = canonicalDir(globalDir);
  let projectRoot: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const projectRootMod: ProjectRootModule = require('./project-root.cjs');
    projectRoot = projectRootMod.findProjectRoot(cwd);
  } catch {
    projectRoot = null;
  }
  const projectDir = projectRoot ? path.join(projectRoot, GSD_HOME_DIRNAME, 'capabilities') : null;
  const projectCanon = projectDir ? canonicalDir(projectDir) : null;

  // #1459 finding 1 (HIGH, round 6): the global overlay root is trusted (consent-FREE) ONLY when we can
  // PROVE it is a distinct physical directory from the project overlay tree — i.e. realpath(global) AND
  // realpath(project) BOTH succeed AND resolve to DIFFERENT physical paths. A one-sided rule (demote only a
  // realpath-FAILED *global* candidate) left the symlinked-GSD_HOME bypass open: when GSD_HOME is a symlink
  // alias of the project root, the GLOBAL candidate realpaths fine (stays trusted-global) while the PROJECT
  // candidate's realpath fails → the two keys never collide → the in-repo bundle stays in the no-consent
  // global slot. So the global is demoted to consent-required 'project' (only when there IS a GENUINE
  // project root, so a marker-less home / cwd===home stays trusted-global) whenever distinctness cannot be
  // proven: EITHER realpath throws, OR both succeed but resolve EQUAL (an alias). When the demoted-global
  // and the project candidate physically coincide they then dedup onto one consent-required entry; when
  // they are merely unprovable-distinct (e.g. global realpath failed) the global is independently demoted
  // so an aliased in-repo tree it would scan still requires a record. A genuinely non-existent global dir
  // (ENOENT) realpath-fails too, but its later readdir fails, so this demotion is a harmless no-op there.
  let globalScope: 'global' | 'project' = 'global';
  if (projectRoot && projectCanon && hasGenuineProjectMarker(projectRoot)) {
    // The fail-safe only matters when there IS an in-repo overlay tree to protect. A NON-EXISTENT project
    // overlay dir (ENOENT) has nothing to bypass into the trusted-global slot, so the global stays trusted
    // (and a genuinely distinct real global cap is not spuriously demoted — the control case). Otherwise,
    // demote the global to consent-required 'project' UNLESS we can PROVE physical distinctness:
    //   - the project overlay actually exists (or can't be proven absent), AND
    //   - either realpath can't canonicalize one side (race/odd-FS → can't prove distinct), OR
    //   - both canonicalize EQUAL (an alias — GSD_HOME physically IS the project root).
    const projectAbsent = projectCanon.realpathFailed && projectCanon.enoent;
    if (!projectAbsent) {
      const provablyDistinct =
        !globalCanon.realpathFailed &&
        !projectCanon.realpathFailed &&
        globalCanon.path !== projectCanon.path;
      if (!provablyDistinct) globalScope = 'project';
    }
  }
  add(globalDir, globalScope, globalCanon);
  if (projectDir && projectCanon) {
    add(projectDir, 'project', projectCanon, hasGenuineProjectMarker(projectRoot as string));
  }
  return roots;
}

/**
 * Resolve the PROJECT ROOT for `cwd` used to LOOK UP a project-scope consent record (#1459). Delegates
 * to the SINGLE canonical `consentProjectRoot` helper (IC-01/CB-4) so the loader's lookup key always
 * matches the install RECORD key and the `trust revoke` key — installing from a subdir then resolves
 * to the same realpath'd project root the loader checks (no install-then-inactive). Falls back to
 * `cwd` if the project-root module cannot be loaded at all (the consent store realpaths it).
 */
function projectRootFor(cwd: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const projectRootMod: ProjectRootModule = require('./project-root.cjs');
    return projectRootMod.consentProjectRoot(cwd);
  } catch { /* fall through */ }
  return cwd;
}

/**
 * Read the per-scope ledger co-located with an overlay root (the root is `<scope>/.gsd/capabilities`,
 * so its ledger is `<scope>/.gsd-capabilities.json`) and classify its ids:
 *   - `pending`:   ids carrying an in-flight `_pending` intent (crashed/uncommitted install/upgrade)
 *                  — must not be activated until reconciliation completes.
 *   - `committed`: ids with a ledger entry and NO `_pending` — i.e. an install the user actually
 *                  completed (and, for executable surfaces, CONSENTED to). This is the authoritative
 *                  consent signal required before dispatching a capability's CLI COMMANDS (ADR-1244
 *                  Phase 5 / D7): a bundle merely dropped on disk with no ledger entry is NOT
 *                  consented and its command family must not be dispatchable.
 * Never throws: a missing/invalid ledger yields empty sets.
 */
/**
 * Is `e` a structurally-valid COMMITTED ledger entry for `id`? Delegates the structural shape to
 * capability-ledger's SHARED `isValidLedgerEntry` (loader/ledger validator PARITY — #1459 ROOT FIX:
 * the loader previously hand-duplicated the shape and could drift), and ADDS the loader-specific
 * "committed = valid AND carries NO `_pending` marker" semantic. A malformed/tampered/pending entry
 * fails this check and is therefore NOT treated as committed — fail closed.
 */
function isCommittedLedgerEntry(ledger: LedgerModule, id: string, e: unknown): boolean {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (Object.prototype.hasOwnProperty.call(e as Record<string, unknown>, '_pending')) return false; // intent ⇒ uncommitted.
  return ledger.isValidLedgerEntry(id, e);
}

function ledgerOverlayIds(ledger: LedgerModule, rootDir: string): {
  pending: Set<string>;
  committed: Set<string>;
} {
  const pending = new Set<string>();
  const committed = new Set<string>();
  try {
    const ledgerPath = path.join(rootDir, '..', '..', '.gsd-capabilities.json');
    // #1459 (HIGH): read the per-scope ledger via the SHARED fd-based bounded reader (open → fstat →
    // require regular file → size cap → read exactly size). The previous raw `fs.readFileSync` BLOCKED
    // forever on a repo-planted FIFO ledger (a project-scope DoS) and read an oversized file whole.
    const content = ledger.readSmallRegularFile(ledgerPath, LEDGER_MAX_BYTES);
    if (content === null) return { pending, committed }; // genuinely missing.
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return { pending, committed };
    const entries = (parsed as Record<string, unknown>)['entries'];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return { pending, committed };
    for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      if ((entry as Record<string, unknown>)['_pending']) {
        pending.add(id); // a truthy in-flight intent — defer/skip until reconciliation
      } else if (isCommittedLedgerEntry(ledger, id, entry)) {
        committed.add(id); // a genuine, structurally-valid commit
      }
      // else: malformed / tampered / falsy-_pending → neither (fail closed: declarative-only)
    }
  } catch { /* missing/invalid/non-regular/oversized ledger — no pending, no committed (fail closed) */ }
  return { pending, committed };
}

/** Shallow-attach overlay diagnostics WITHOUT mutating the frozen registry module. */
function withOverlayMeta(reg: Registry, meta: OverlayMeta): Registry {
  return Object.assign({}, reg, { _overlay: meta });
}

/**
 * Loop extension points a capability declares a gate at (the `point` strings off `cap.gates`).
 * SINGLE source of truth shared by BOTH the per-candidate `skip()` closure AND the OVL-2
 * buildRegistry-failure fallback (#1461) so a dropped gate-declaring overlay fails CLOSED via the
 * SAME extraction the per-candidate path uses — never one path blocking and the other failing open.
 *
 * #1461 finding 1 (HIGH): this MUST be TOTAL over an UNTRUSTED, possibly-malformed manifest — it
 * runs on a candidate BEFORE per-candidate validation has confirmed the shape. A null `cap`, a
 * non-object `cap`, a non-array `cap.gates` (e.g. `gates: {}` / `gates: null`), or a malformed gate
 * ENTRY (`gates: [null]` / `gates: ["x"]` / a gate with a non-string `point`) must NEVER throw: it
 * returns only the extractable `point` strings, filtering null/non-object/malformed entries. A
 * `null` gate has no extractable point, so it contributes nothing (no spurious fail-closed block).
 */
function gatePointsOf(cap: unknown): string[] {
  if (!cap || typeof cap !== 'object') return [];
  const gates = (cap as { gates?: unknown }).gates;
  if (!Array.isArray(gates)) return [];
  return (gates as unknown[])
    .map((g) =>
      g && typeof g === 'object' && typeof (g as Record<string, unknown>).point === 'string'
        ? ((g as Record<string, unknown>).point as string)
        : null,
    )
    .filter((p): p is string => typeof p === 'string');
}

/**
 * Load the capability registry, optionally composing the installed overlay.
 *
 * @returns the registry object (same shape as `capability-registry.cjs`). When
 *   overlays are considered, an `_overlay` field carries skip warnings and the
 *   fail-closed gate list. With `includeInstalled` falsy, the frozen first-party
 *   registry is returned unchanged (identity-stable).
 */
export function loadRegistry(options: LoadRegistryOptions = {}): Registry {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const base: Registry = require('./capability-registry.cjs');
  if (!options.includeInstalled) return base;

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const validator: ValidatorModule = _validatorOverride ?? require('./capability-validator.cjs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const semver: SemverModule = require('./semver-compare.cjs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const ledgerMod: LedgerModule = require('./capability-ledger.cjs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const consentMod: ConsentModule = require('./capability-consent.cjs');
  // ADR-1239 Phase C-2 (#1681): load-time configHome confinement for installed
  // third-party descriptors. Accessed via module ref for stub compatibility.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const externalDescriptorTrust: { assertDescriptorConfined(descriptor: unknown, configHome: string): void; isPathConfined(target: string, root: string): boolean } = require('./external-descriptor-trust.cjs');

  const cwd = options.cwd || process.cwd();
  const hostVersion = options.hostVersion || readHostVersion();
  // The user-owned consent home — SAME `gsdHome || GSD_HOME || homedir()` rule the CLI uses, so the
  // consent the CLI records is the consent the loader checks. The consent store NEVER lives in a repo.
  const gsdHome = options.gsdHome || process.env['GSD_HOME'] || os.homedir();

  const warnings: OverlaySkip[] = [];
  // ADR-2782 D4.3 — non-fatal notices for capabilities that are ACCEPTED (see OverlayMeta).
  const diagnostics: string[] = [];
  const incompatibleGateCapIds: string[] = [];
  const blockedGates: BlockedGate[] = [];
  const commandRoots: Record<string, string> = {};
  const overlayCaps: CapManifest[] = [];

  // First-party reservations — first-party always wins.
  const fpCaps = (base.capabilities ?? {}) as Record<string, unknown>;
  const fpBySkill = (base.bySkill ?? {}) as Record<string, unknown>;
  const fpByAgent = (base.byAgent ?? {}) as Record<string, unknown>;
  const fpConfigKeys = (base.configKeys ?? {}) as Record<string, unknown>;
  const fpConfigSchema = (base.configSchema ?? {}) as Record<string, unknown>;

  const fpFamilies = (base.commandFamilies ?? {}) as Record<string, unknown>;
  const fpIds = new Set(Object.keys(fpCaps));
  const claimedSkills = new Set(Object.keys(fpBySkill));
  const claimedAgents = new Set(Object.keys(fpByAgent));
  const claimedConfig = new Set([...Object.keys(fpConfigKeys), ...Object.keys(fpConfigSchema)]);
  const claimedFamilies = new Set(Object.keys(fpFamilies));
  const acceptedIds = new Set<string>();

  // Running merged cap-map (first-party ∪ accepted overlays). A candidate is
  // accepted only if the FULL cross-capability suite stays clean after adding it
  // (first-party alone is clean, so any new error is the candidate's fault) — the
  // overlay can never violate the same invariants the build-time generator enforces.
  const acceptedMap = new Map<string, unknown>(Object.entries(fpCaps));

  // Generator (buildRegistry + central config keys) loaded lazily — only when at
  // least one overlay candidate exists, so the no-overlay fast path stays cheap.
  let generatorMod: GeneratorModule | null = null;
  const getGenerator = (): GeneratorModule => {
    if (generatorMod) return generatorMod;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const mod: GeneratorModule = _generatorOverride ?? require('../../../scripts/gen-capability-registry.cjs');
    generatorMod = mod;
    return mod;
  };
  let centralKeys: Set<string> | null = null;
  const getCentralKeys = (): Set<string> => {
    if (!centralKeys) {
      try {
        centralKeys = getGenerator().loadCentralConfigKeys();
      } catch {
        centralKeys = new Set<string>();
      }
    }
    return centralKeys;
  };

  for (const root of overlayRoots(cwd, options.gsdHome)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // no overlay dir at this scope — normal
    }
    // Ids whose ledger entry carries an in-flight `_pending` intent (a crashed/uncommitted
    // install or upgrade). They are NOT yet committed, so they must not be activated — reconcile
    // will roll them forward or back. Fail OPEN (skip without a gate block): an uncommitted gate
    // is not a real installed gate. See capability-lifecycle.cts (ADR-1244 Phase 4).
    const { pending: pendingIds, committed: committedIds } = ledgerOverlayIds(ledgerMod, root.dir);
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      const capDir = path.join(root.dir, id);
      const manifestPath = path.join(capDir, 'capability.json');

      if (pendingIds.has(id)) {
        warnings.push({ id, scope: root.scope, reason: 'install/upgrade in progress (uncommitted) — deferred until reconciliation' });
        continue;
      }

      let cap: CapManifest;
      try {
        // #1459 finding 2 (HIGH): read the manifest via the SHARED fd-based bounded reader (open → fstat
        // → require regular file → size cap → read exactly size). A project-planted FIFO/device manifest
        // can no longer BLOCK the loader (the raw readFileSync hang) and an oversized manifest can no
        // longer read unbounded. A null read (genuinely missing OR refused as non-regular/oversized) →
        // skip the overlay, fail-closed.
        const manifestRaw = ledgerMod.readSmallRegularFile(manifestPath, MANIFEST_MAX_BYTES);
        if (manifestRaw === null) {
          warnings.push({ id, scope: root.scope, reason: 'capability.json missing, non-regular (FIFO/device), or exceeds the size cap — skipped' });
          continue;
        }
        cap = JSON.parse(manifestRaw) as CapManifest;
      } catch (e) {
        warnings.push({ id, scope: root.scope, reason: 'unreadable or invalid capability.json: ' + errMessage(e) });
        continue;
      }

      // Points at which this capability declares a gate — used to fail CLOSED if
      // the capability is skipped (a skipped deploy gate must block, not pass).
      const gatePoints: string[] = gatePointsOf(cap);
      const declaresGate = gatePoints.length > 0;
      const skip = (reason: string): void => {
        warnings.push({ id, scope: root.scope, reason });
        if (declaresGate) {
          incompatibleGateCapIds.push(id);
          for (const point of gatePoints) blockedGates.push({ point, capId: id, reason });
        }
      };

      // #1461 finding 1 (HIGH): make the ENTIRE per-candidate processing body TOTAL. The committed
      // validator is NOT total for malformed ARRAY entries — validateGate/validateStep/
      // validateContribution dereference an entry (`.point`, `.into`, …) BEFORE any shape check, so a
      // manifest with `gates: [null]` (or `steps: [null]` / `contributions: [null]`) makes
      // validateCapability THROW `Cannot read properties of null (reading 'point')`. That throw was
      // OUTSIDE any per-candidate guard → it escaped loadRegistry and crashed EVERY consumer
      // (loop-resolver, config-loader, surface, capability-state, gsd-tools). ADR-1244 D2 mandates a
      // malformed overlay is SKIPPED with a warning, never crashes the loop. Wrapping the whole body
      // (manifest already parsed above) means ANY throw from ANY validator/step becomes a structured
      // `skip()` + continue to the next candidate — which ALSO fail-closes a declared gate (the `skip`
      // closure records incompatibleGateCapIds/blockedGates for the extractable gate points). The
      // existing structured skip/continue paths inside are unchanged; this is a fail-safe BACKSTOP for
      // a validator/step that THROWS rather than returning errors. `continue` inside this try simply
      // advances the `for` loop (there is no finally to interfere).
      try {
      // 1. Reserved namespace — third-party may not impersonate first-party.
      if (RESERVED_ID_PREFIX.test(id)) {
        skip('id uses a reserved first-party prefix (gsd-/gsd-core-/anthropic-)');
        continue;
      }
      // 2. Per-capability structural + version-envelope validation.
      const errs = validator.validateCapability(cap, id);
      if (errs.length) {
        skip('failed validation: ' + errs.join('; '));
        continue;
      }
      // 3. First-party wins + overlay/overlay de-dup on id, skill, agent, config key.
      if (fpIds.has(id) || acceptedIds.has(id)) {
        skip('id collides with an already-registered capability');
        continue;
      }
      const skills: string[] = Array.isArray(cap.skills) ? cap.skills : [];
      const agents: string[] = Array.isArray(cap.agents) ? cap.agents : [];
      const cfgKeys: string[] = cap.config && typeof cap.config === 'object' && !Array.isArray(cap.config)
        ? Object.keys(cap.config) : [];
      const skillClash = skills.find((s) => claimedSkills.has(s));
      if (skillClash) { skip('owns skill "' + skillClash + '" already owned by another capability'); continue; }
      const agentClash = agents.find((a) => claimedAgents.has(a));
      if (agentClash) { skip('owns agent "' + agentClash + '" already owned by another capability'); continue; }
      const cfgClash = cfgKeys.find((k) => claimedConfig.has(k));
      if (cfgClash) { skip('owns config key "' + cfgClash + '" already owned by another capability'); continue; }
      const families: string[] = Array.isArray(cap.commands)
        ? cap.commands
            .map((c) => (c && typeof c === 'object' && typeof c.family === 'string' ? c.family : null))
            .filter((f): f is string => typeof f === 'string')
        : [];
      const familyClash = families.find((f) => claimedFamilies.has(f));
      if (familyClash) { skip('owns command family "' + familyClash + '" already owned by another capability'); continue; }
      // 4. Load-time engines.gsd re-gate.
      const range = cap.engines?.gsd;
      if (typeof range === 'string' && range && !semver.semverSatisfies(hostVersion, range)) {
        skip('incompatible with GSD ' + hostVersion + ' (requires engines.gsd "' + range + '")');
        continue;
      }
      // 5. #1459 — USER-OWNED CONSENT GATE (TRUST-1 + TRUST-3). For a PROJECT-scope overlay the
      //    authoritative consent signal is NOT the in-repo ledger (repo-plantable: a clone/fork
      //    activated executable surfaces AND declarative loop surfaces with no user decision) but a
      //    record in the user-owned consent store on THIS machine, bound to (realpath(projectRoot),
      //    id, RECOMPUTED full-bundle content hash). If there is NO matching record we do NOT push
      //    the cap into acceptedMap/overlayCaps and do NOT set a commandRoot → the cap is
      //    DISCOVERED-BUT-INACTIVE (a warning records why). This single gate closes BOTH
      //    command-dispatch (TRUST-1) and declarative-surface (TRUST-3) activation. GLOBAL scope is
      //    under the user's own home and is trusted as before (no consent record required).
      //
      //    CONVERGENCE finding 1 (HIGH): this gate now runs BEFORE the heavy/unbounded pre-activation
      //    work (materializeHookFragments — which reads each `fragment.path` off disk — and the full
      //    cross-capability validation). A forged in-repo PROJECT overlay can point a `fragment.path`
      //    at an in-bundle FIFO/oversized file; materializing it BEFORE the consent check would
      //    hang/OOM the loader before the unconsented → inactive fail-closed path is reached. Running
      //    the (already bounded + fail-closed) consent recompute FIRST means an unconsented project
      //    overlay skips with NO further disk work. The gate's DECISION is identical — only the
      //    work-ordering moved (consented project overlays + GLOBAL overlays still materialize below).
      //
      //    CONTENT BINDING (#1459 round 2, CB-1/CB-2/TRUST2-5): the binding is the bundle CONTENT
      //    HASH recomputed HERE over the on-disk capDir (manifest AND artifacts AND identity) — NOT
      //    the ledger `integrity` (which is `''` for path/git/dir installs and taken verbatim from
      //    the repo-plantable project ledger → degenerate `'' === ''`) and NOT the executable-only
      //    disclosure signature (a declarative-only swap leaves it constant). Any tamper — a swapped
      //    declarative capability.json, an edited hook script, an empty-integrity local install —
      //    changes the recomputed hash and the cap stays inactive. `bundleContentHash` is itself
      //    bounded + fail-closed (it refuses non-regular bundle files and reads via the shared bounded
      //    reader), so it cannot hang on a forged FIFO bundle file. The whole lookup is wrapped so a
      //    consent-store read / hash-recompute failure fails CLOSED (inactive), never crashing the
      //    loop (the loader must stay non-throwing end to end).
      //
      //    IRREDUCIBLE TOCTOU LIMIT (#1459 / mirrors the #1462 lock-release residual): the hash
      //    verified HERE binds the bundle's on-disk content at THIS instant. A local writer racing
      //    between this verification and the capability's LATER execution (a hook firing, a command
      //    dispatch) can still mutate the bundle files after the check passes — this is a filesystem
      //    primitive limit, not a loader bug: short of fd-pinned execution or an atomic content
      //    snapshot (which needs native support we do not have here), no userspace check can close the
      //    window between "verify content" and "execute content". This is documented, not dismissed:
      //    the gate is the strongest defense available at this layer (any persisted tamper is caught on
      //    the NEXT load), and the residual race requires an attacker already able to write the project
      //    tree at execution time.
      if (root.scope === 'project') {
        let consented = false;
        try {
          consented = consentMod.hasProjectConsent({
            gsdHome,
            projectRoot: projectRootFor(cwd),
            id,
            contentHash: consentMod.bundleContentHash(capDir),
          });
        } catch {
          consented = false; // fail closed — a consent-store/hash-recompute failure never activates a cap.
        }
        if (!consented) {
          // DISCOVERED-BUT-INACTIVE: no user consent record on this machine. NOT a gate block (an
          // unconsented project gate is not a real installed gate — same fail-open posture as
          // `_pending`); it simply does not contribute any surface. #1459 IC-02: tag the skip with the
          // structural `kind: 'unconsented'` so gsd-tools `list` marks it INACTIVE by discriminant, not
          // by matching the (changeable) reason prose. NOTE (convergence finding 1): we `continue` here
          // BEFORE materializeHookFragments, so an unconsented project overlay's fragment files are never
          // read — a forged FIFO/oversized fragment cannot hang/OOM the loop.
          warnings.push({ id, scope: root.scope, kind: 'unconsented', reason: 'discovered — no user consent record (inactive)' });
          continue;
        }
      }
      // 5b. Materialize path-based hook fragments (resolved against the overlay dir). Runs AFTER the
      //    project consent gate (convergence finding 1) so only a CONSENTED project overlay (or a
      //    trusted GLOBAL overlay) reaches the fragment reads. materializeHookFragments RETURNS errors
      //    (e.g. a fragment path escaping the capability dir, OR — convergence finding 1(b) — a fragment
      //    that is non-regular/oversized and refused by the shared bounded reader) — capture them; an
      //    un-materializable fragment is a skip, never a hang.
      let fragErrs: string[];
      try {
        fragErrs = validator.materializeHookFragments(cap, capDir) || [];
      } catch (e) {
        skip('hook fragment could not be materialized: ' + errMessage(e));
        continue;
      }
      if (fragErrs.length) {
        skip('invalid hook fragment: ' + fragErrs.join('; '));
        continue;
      }
      // 6. Full cross-capability validation over the merged set (the same invariants
      //    the build-time generator enforces): contract roles, consumes-satisfiability,
      //    owner-uniqueness, config-key exclusivity vs central schema, requires acyclicity
      //    + tier-monotone. Incremental: add the candidate, validate, drop on any error.
      acceptedMap.set(id, cap);
      // #1461 OVL-1 (HIGH): these validators are CONTRACTED to RETURN error arrays, but one can THROW
      // (e.g. validateConsumesGlobal asserting on a duplicate producer). An unguarded throw here
      // escapes loadRegistry and crashes EVERY consumer (loop-resolver, config-loader, surface,
      // capability-state, gsd-tools). ADR-1244 D2: a malformed overlay is SKIPPED with a warning,
      // never crashes the loop. So a throwing validator is treated EXACTLY like a validation failure:
      // drop this one candidate (with a warning) and continue — the rest of the overlay set is
      // unaffected. (The returns-errors path below is unchanged.)
      let crossErrs: string[];
      try {
        crossErrs = [
          ...validator.validateAgainstContract(cap, id),
          ...validator.validateConsumesGlobal(acceptedMap),
          ...validator.validateCrossCapability(acceptedMap, getCentralKeys()),
        ];
      } catch (e) {
        acceptedMap.delete(id);
        skip('cross-capability validation error: ' + errMessage(e));
        continue;
      }
      if (crossErrs.length) {
        acceptedMap.delete(id);
        skip('cross-capability validation failed: ' + crossErrs.slice(0, 3).join('; '));
        continue;
      }

      // ADR-1239 Phase C-2 (#1681): load-time configHome confinement — reject
      // (skip + warn) any installed third-party descriptor whose declared
      // destSubpath escapes the user-approved configHome, BEFORE it is composed.
      // Defense-in-depth on top of the install-time gate (#1679 AC3).
      if (typeof options.configHome === 'string' && options.configHome.length > 0) {
        try {
          externalDescriptorTrust.assertDescriptorConfined(cap, options.configHome);
        } catch (confineErr) {
          acceptedMap.delete(id);
          skip('configHome confinement rejected: ' + errMessage(confineErr));
          continue;
        }
      }

      // Accepted.
      //
      // ADR-2782 D4.3: an unknown field inside a `reviewer` body is IGNORED WITH A
      // WARNING rather than failing validation, so a lane built for a newer GSD
      // degrades to accepted-but-partially-understood instead of being rejected.
      // That case validates cleanly, so without this call it would surface
      // nowhere at runtime — the build-time generator only ever sees first-party
      // in-repo manifests, never an installed third-party overlay. Guarded on
      // presence so an older built validator without the function still loads,
      // and wrapped because the never-crash contract (ADR-1244 D2) outranks a
      // diagnostic: a throwing collector must not cost the user a working lane.
      if (typeof validator.collectReviewerWarnings === 'function') {
        try {
          for (const w of validator.collectReviewerWarnings(cap) || []) {
            diagnostics.push(`${root.scope}:${id}: ${w}`);
          }
        } catch {
          // A diagnostic that cannot be produced is not worth failing an install over.
        }
      }
      overlayCaps.push(cap);
      acceptedIds.add(id);
      for (const s of skills) claimedSkills.add(s);
      for (const a of agents) claimedAgents.add(a);
      for (const k of cfgKeys) claimedConfig.add(k);
      for (const f of families) claimedFamilies.add(f);
      // Record the install root for a third-party cap that ships command modules, so a runtime
      // dispatcher can require() the router FROM the install root (ADR-1244 Phase 5 / D7). Gated on
      // a COMMITTED ledger entry (committedIds): executable CLI commands run only for a capability
      // the user actually installed+consented to via the lifecycle — a bundle merely dropped on
      // disk with no ledger entry provides declarative surfaces (Phase 2) but is NOT command-
      // dispatchable. (Project-scope ledgers live in the repo tree and are thus only as trustworthy
      // as the repo — see docs/explanation/capability-trust-model.md.)
      if (families.length > 0 && committedIds.has(id)) commandRoots[id] = capDir;
      } catch (e) {
        // #1461 finding 1 (HIGH): ANY throw from ANY validator/step in the per-candidate body lands
        // here — drop just THIS candidate with a structured skip-warning and continue with the rest of
        // the overlay set (the loop is never crashed). `skip()` ALSO fail-closes the candidate's
        // declared gates (incompatibleGateCapIds/blockedGates) so a malformed gate-declaring overlay
        // blocks rather than silently passing. Remove any half-committed acceptedMap entry so the
        // partially-processed candidate cannot leak into the final buildRegistry compose.
        acceptedMap.delete(id);
        skip('overlay processing error: ' + errMessage(e));
        continue;
      }
    }
  }

  const meta: OverlayMeta = { warnings, diagnostics, incompatibleGateCapIds, blockedGates, commandRoots };

  if (overlayCaps.length === 0) {
    // Nothing to compose. Return the frozen registry unchanged when there is
    // also nothing to report (identity-stable); otherwise attach diagnostics.
    if (warnings.length === 0) return base;
    return withOverlayMeta(base, meta);
  }

  // Compose via the canonical builder so every derived view matches first-party.
  // acceptedMap already holds first-party ∪ accepted overlays (validated above).
  //
  // #1461 OVL-2 (HIGH): an overlay can pass every per-candidate step yet trip a STRICTER whole-build
  // check inside buildRegistry (config-slice shape, topo cycle across the merged set, configFormat
  // parity). An unguarded buildRegistry throw escapes loadRegistry and crashes the loop. ADR-1244 D2
  // mandates NEVER-CRASH: on a compose failure, fall back to the frozen FIRST-PARTY registry plus a
  // warning recording why — the loop still gets a usable registry, just without the overlay surfaces.
  try {
    const merged = getGenerator().buildRegistry(acceptedMap);
    return withOverlayMeta(merged, meta);
  } catch (e) {
    const reason = 'buildRegistry failed composing overlays: ' + errMessage(e) + '; falling back to first-party';
    meta.warnings.push({ id: '*', scope: 'global', reason });
    // #1461 finding 3 (LOW): the fallback DROPS every accepted overlay, so NO dropped overlay may
    // retain a command root. A stale `commandRoots[capId]` would let a runtime dispatcher require()/
    // run a third-party command family FROM the install root of a capability the fallback decided NOT
    // to load. Clear the map (the first-party base never lists overlay commandRoots — first-party
    // command modules ship in bin/lib/, not via _overlay.commandRoots).
    meta.commandRoots = {};
    // #1461 OVL-2 (HIGH): on compose failure the fallback DROPS every accepted overlay, so any
    // accepted overlay that DECLARED a gate would have its gate silently vanish with no trace.
    // Record each dropped gate-declaring overlay's gate as blocked using the SAME extraction the
    // per-candidate `skip()` closure uses (gatePointsOf), so loop-resolver surfaces the loud
    // fail-OPEN advisory (#2009) at each declared point exactly as it would for a per-candidate
    // skip — the gate does not silently disappear.
    for (const cap of overlayCaps) {
      const gatePoints = gatePointsOf(cap);
      if (gatePoints.length === 0) continue;
      meta.incompatibleGateCapIds.push(cap.id);
      for (const point of gatePoints) meta.blockedGates.push({ point, capId: cap.id, reason });
    }
    return withOverlayMeta(base, meta);
  }
}

// readHostVersion is exported for the #1920 regression (VERSION-first host-version resolution).
module.exports = { loadRegistry, readHostVersion, _setValidatorForTest, _setGeneratorForTest };
