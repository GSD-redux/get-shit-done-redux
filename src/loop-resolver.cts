/**
 * Loop Resolver — ADR-857 phase 3c registry-consuming query
 *
 * Given a loop point (one of the 12 canonical points from loop-host-contract.cjs),
 * filters the materialized Capability Registry by config activation and returns
 * the active hooks as a JSON envelope with a rendered-markdown field.
 *
 * Consumed live by the landed phase-6 loop-hook cutovers: plan-phase.md / autonomous.md
 * at plan:pre (ui-phase) and autonomous.md at verify:post (ui-review). Further per-feature
 * cutovers are ongoing.
 *
 * Command surface: gsd-tools loop render-hooks <point>
 *
 * Exports (three things):
 *   resolveLoopHooks({ point, registry, config }) → { point, activeHooks }
 *   renderLoopHooks(resolved) → markdown string
 *   cmdLoopRenderHooks(cwd, point, raw, options) — I/O entry point
 *
 * Both pure functions (resolveLoopHooks, renderLoopHooks) take explicit
 * registry/config arguments so they are trivially testable without I/O.
 *
 * Dependencies (leaf modules only — no circular risk):
 *   - ./config-loader.cjs  (loadConfig)
 *   - ./io.cjs             (output, error)
 *   - ./capability-activation.cjs (resolveConfigKey, _resolveActivationValue, _getNestedConfigValue, _readRawConfigKey)
 *   - loop-host-contract.cjs (CANONICAL_POINTS via LOOP_HOST_CONTRACT)
 *   - capability-registry.cjs (byLoopPoint, consumed at call time)
 *   - capability-state.cjs (resolveCapabilityRuntimeState — for capabilities list)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output: coreOutput, error: coreError } = ioMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderModule = require('./config-loader.cjs');
const { loadConfig } = configLoaderModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateModule = require('./capability-state.cjs');
const { resolveCapabilityRuntimeState } = capabilityStateModule;

// ─── Capability-activation engine (single owner for config-key precedence) ────
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityActivationModule = require('./capability-activation.cjs');
const { _getNestedConfigValue, _readRawConfigKey, _resolveActivationValue, _resolvePointGate, resolveConfigKey } = capabilityActivationModule;

// ─── Canonical points (derived from LOOP_HOST_CONTRACT — authoritative 12) ───

// FIX 2: Derive the authoritative canonical set from LOOP_HOST_CONTRACT so it
// cannot drift from the host contract. CANONICAL_POINTS_FALLBACK is kept as an
// alias for backward compatibility in tests and exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _loopHostContract = require('./loop-host-contract.cjs') as { LOOP_HOST_CONTRACT: Array<{ points: string[] }> };
const CANONICAL_POINTS: ReadonlyArray<string> = (() => {
  try {
    const contract = _loopHostContract.LOOP_HOST_CONTRACT;
    if (Array.isArray(contract)) {
      const pts: string[] = [];
      for (const step of contract) {
        if (step && Array.isArray(step.points)) {
          for (const p of step.points) {
            if (typeof p === 'string') pts.push(p);
          }
        }
      }
      if (pts.length > 0) return pts;
    }
  } catch { /* fall through to hardcoded fallback */ }
  return [
    'discuss:pre',
    'discuss:post',
    'plan:pre',
    'plan:post',
    'execute:pre',
    'execute:wave:pre',
    'execute:wave:post',
    'execute:post',
    'verify:pre',
    'verify:post',
    'ship:pre',
    'ship:post',
  ];
})();

// Alias for backward compatibility (tests import this name)
const CANONICAL_POINTS_FALLBACK: ReadonlyArray<string> = CANONICAL_POINTS;

// FIX 2: _getCanonicalPoints now returns the authoritative CANONICAL_POINTS set
// derived from LOOP_HOST_CONTRACT — not the registry's byLoopPoint keys.
// The registry's byLoopPoint is only used to READ hooks, not to define valid points.
function _getCanonicalPoints(_registry: Record<string, unknown>): ReadonlyArray<string> {
  return CANONICAL_POINTS;
}

// ─── (Precedence engine imported from capability-activation.cjs above) ────────

// ─── Types ────────────────────────────────────────────────────────────────────

interface HookRef {
  skill?: string;
  agent?: string;
  [key: string]: unknown;
}

interface RawHook {
  capId?: unknown;
  point?: unknown;
  ref?: unknown;
  into?: unknown;
  fragment?: unknown;
  produces?: unknown;
  consumes?: unknown;
  when?: unknown;
  onError?: unknown;
  blocking?: unknown;
  check?: unknown;
  /** #4209 DISP-02: step-only reviewer-lane opt-in trait; validated boolean upstream. */
  supportsReviewerLanes?: unknown;
}

type HookKind = 'step' | 'contribution' | 'gate';

interface ActiveHook {
  capId: string;
  kind: HookKind;
  ref?: HookRef;
  into?: string;
  fragment?: { inline?: string; path?: string };
  when?: string;
  produces?: string[];
  consumes?: string[];
  blocking?: boolean;
  check?: unknown;
  onError?: string;
  /** Resolved capability-owned config values declared in the contribution's configValues map. */
  configValues?: Record<string, unknown>;
  /**
   * #4209 DISP-02: step-only reviewer-lane opt-in trait. Only present (and only
   * ever `true`) when the source step declared a literal `true`; omitted or
   * `false` never reach the active hook — the field is inert by absence, not
   * by carrying `false`.
   */
  supportsReviewerLanes?: true;
}

interface ResolveLoopHooksInput {
  point: string;
  registry: Record<string, unknown>;
  config: Record<string, unknown>;
  /** Optional cwd — enables raw config.json fallback reads (FIX 1 precedence level 2). */
  cwd?: string;
  /**
   * Optional capability-state map; when present, inactive capabilities do not render hooks.
   * Each entry carries both `enabled` (installed+surfaced) and `active` (enabled+configActivation).
   * The resolver gates on `active` so that the config activation key (activationKey) is
   * honoured even when no per-hook `when` guard is present (Phase 4 tri-state alignment).
   *
   * `active` is REQUIRED (not optional) so the gate is fail-closed: a missing or undefined
   * `active` field is a compile error, never silently treated as truthy.
   */
  capabilityStatesById?: Map<string, { enabled?: boolean; active: boolean }> | Record<string, { enabled?: boolean; active: boolean }>;
}

interface ResolveLoopHooksResult {
  point: string;
  activeHooks: ActiveHook[];
}

// ─── Pure resolver ─────────────────────────────────────────────────────────────

/**
 * Pure resolver: given a point, registry, and config, returns the active hooks.
 *
 * Throws if `point` is not one of the 12 canonical points (caller converts to
 * io.error). Never throws for malformed registry/hook entries — skips and
 * continues.
 *
 * Ordering: steps first, then contributions, then gates. Within each array,
 * the materialized registry order is preserved.
 *
 * Activation: a hook with no `when` is always active. With `when` (dotted key),
 * resolved against `config`; active iff truthy. Inactive hooks are filtered out.
 */
function resolveLoopHooks(input: ResolveLoopHooksInput): ResolveLoopHooksResult {
  const { point, registry, config, cwd, capabilityStatesById } = input;

  // Validate point
  const canonicalPoints = _getCanonicalPoints(registry);
  if (!canonicalPoints.includes(point)) {
    throw new Error(
      `Invalid loop point: "${point}". Valid points: ${canonicalPoints.join(', ')}`,
    );
  }

  // Guard: registry missing byLoopPoint
  const byLoopPoint = registry['byLoopPoint'];
  if (!byLoopPoint || typeof byLoopPoint !== 'object' || Array.isArray(byLoopPoint)) {
    return { point, activeHooks: [] };
  }
  const byLoopPointMap = byLoopPoint as Record<string, unknown>;

  // Guard: point missing in registry
  const entry = byLoopPointMap[point];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { point, activeHooks: [] };
  }
  const entryMap = entry as Record<string, unknown>;

  const activeHooks: ActiveHook[] = [];

  // Helper: check activation using single-key precedence resolver (FIX 1 + FIX 3)
  function isActive(hook: RawHook): boolean {
    const when = hook['when'];
    if (when !== undefined && when !== null) {
      // FIX 3: `when` present but not a non-empty string → malformed registry data → INACTIVE
      if (typeof when !== 'string' || when.length === 0) return false;
      if (!_resolveActivationValue(when, config, cwd, registry)) return false;
    }
    // #3661: optional point-selection gate — see capability-activation.cts.
    return _resolvePointGate((hook as Record<string, unknown>)['pointFrom'], point, config, cwd, registry);
  }

  function isCapabilityActive(capId: string): boolean {
    if (!capabilityStatesById) return true;
    const state = capabilityStatesById instanceof Map
      ? capabilityStatesById.get(capId)
      : capabilityStatesById[capId];
    if (!state) return false;
    // Fail-closed gate: only render the hook when active is explicitly true.
    // A capability can be installed and surfaced (enabled=true) but config-disabled
    // (active=false); in that case the hook must not render.
    // Phase 4 tri-state alignment: `active` is now required (not optional), so
    // `=== true` is the correct fail-closed check (not `!== false`).
    return state.active === true;
  }

  // Helper: safe string array
  function toStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
  }

  function toFragment(v: unknown): { inline?: string; path?: string } | undefined {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const raw = v as Record<string, unknown>;
    const fragment: { inline?: string; path?: string } = {};
    if (typeof raw.inline === 'string') fragment.inline = raw.inline;
    if (typeof raw.path === 'string') fragment.path = raw.path;
    return Object.keys(fragment).length > 0 ? fragment : undefined;
  }

  /**
   * Resolve declared configValues for a contribution hook.
   * The hook may carry `configValues: { alias: "dotted.key", ... }`.
   * Each key is resolved using the same four-level precedence as activation resolution,
   * but returning the raw value (not coerced to boolean) so numeric/string config values
   * are preserved (e.g. security_asvs_level: 2, security_block_on: "medium").
   */
  function resolveConfigValues(hook: RawHook): Record<string, unknown> | undefined {
    const raw = (hook as Record<string, unknown>)['configValues'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const rawMap = raw as Record<string, unknown>;
    const resolved: Record<string, unknown> = {};
    for (const [alias, dotKey] of Object.entries(rawMap)) {
      // Prototype-pollution guard (inline literal, CodeQL barrier)
      if (alias === '__proto__' || alias === 'constructor' || alias === 'prototype') continue;
      if (typeof dotKey !== 'string') continue;
      const r = resolveConfigKey(dotKey, { config, cwd, registry });
      if (r.found) resolved[alias] = r.value;
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  // Process steps
  const stepsRaw = entryMap['steps'];
  const steps: RawHook[] = Array.isArray(stepsRaw) ? (stepsRaw as RawHook[]) : [];
  for (const hook of steps) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityActive(capId)) continue;
    if (!isActive(hook)) continue;
    const ref = (typeof hook['ref'] === 'object' && hook['ref'] !== null)
      ? (hook['ref'] as HookRef)
      : undefined;
    const when = typeof hook['when'] === 'string' ? hook['when'] : undefined;
    const fragment = toFragment(hook['fragment']);
    const produces = toStringArray(hook['produces']);
    const consumes = toStringArray(hook['consumes']);
    const onError = typeof hook['onError'] === 'string' ? hook['onError'] : undefined;
    const active: ActiveHook = { capId, kind: 'step' };
    if (ref !== undefined) active.ref = ref;
    if (fragment !== undefined) active.fragment = fragment;
    if (when !== undefined) active.when = when;
    if (produces.length > 0) active.produces = produces;
    if (consumes.length > 0) active.consumes = consumes;
    if (onError !== undefined) active.onError = onError;
    // #4209 DISP-02: only a literal `true` projects; absent/false stay inert.
    if (hook['supportsReviewerLanes'] === true) active.supportsReviewerLanes = true;
    activeHooks.push(active);
  }

  // Process contributions
  const contributionsRaw = entryMap['contributions'];
  const contributions: RawHook[] = Array.isArray(contributionsRaw) ? (contributionsRaw as RawHook[]) : [];
  for (const hook of contributions) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityActive(capId)) continue;
    if (!isActive(hook)) continue;
    const into = typeof hook['into'] === 'string' ? hook['into'] : undefined;
    const fragment = toFragment(hook['fragment']);
    const when = typeof hook['when'] === 'string' ? hook['when'] : undefined;
    const produces = toStringArray(hook['produces']);
    const consumes = toStringArray(hook['consumes']);
    const onError = typeof hook['onError'] === 'string' ? hook['onError'] : undefined;
    const configValuesResolved = resolveConfigValues(hook);
    const active: ActiveHook = { capId, kind: 'contribution' };
    if (into !== undefined) active.into = into;
    if (fragment !== undefined) active.fragment = fragment;
    if (when !== undefined) active.when = when;
    if (produces.length > 0) active.produces = produces;
    if (consumes.length > 0) active.consumes = consumes;
    if (onError !== undefined) active.onError = onError;
    if (configValuesResolved !== undefined) active.configValues = configValuesResolved;
    activeHooks.push(active);
  }

  // Process gates
  const gatesRaw = entryMap['gates'];
  const gates: RawHook[] = Array.isArray(gatesRaw) ? (gatesRaw as RawHook[]) : [];
  for (const hook of gates) {
    if (!hook || typeof hook !== 'object') continue;
    const capId = typeof hook['capId'] === 'string' ? hook['capId'] : '';
    if (!isCapabilityActive(capId)) continue;
    if (!isActive(hook)) continue;
    const when = typeof hook['when'] === 'string' ? hook['when'] : undefined;
    const check = hook['check'] !== undefined ? hook['check'] : undefined;
    const blocking = typeof hook['blocking'] === 'boolean' ? hook['blocking'] : undefined;
    const onError = typeof hook['onError'] === 'string' ? hook['onError'] : undefined;
    const active: ActiveHook = { capId, kind: 'gate' };
    if (when !== undefined) active.when = when;
    if (check !== undefined) active.check = check;
    if (blocking !== undefined) active.blocking = blocking;
    if (onError !== undefined) active.onError = onError;
    activeHooks.push(active);
  }

  return { point, activeHooks };
}

// ─── Pure renderer ─────────────────────────────────────────────────────────────

/**
 * Pure renderer: given a resolved result, returns a deterministic markdown string.
 *
 * Empty active set → returns a "no active hooks" placeholder line.
 * Steps: heading with ordinal + skill ref + capId, produces/consumes lines.
 * Contributions: labeled block.
 * Gates: check name, blocking flag, onError.
 */
function renderLoopHooks(resolved: ResolveLoopHooksResult): string {
  const { point, activeHooks } = resolved;

  if (activeHooks.length === 0) {
    return `_No active hooks at ${point}._`;
  }

  const lines: string[] = [];
  let stepOrdinal = 0;

  for (const hook of activeHooks) {
    if (hook.kind === 'step') {
      stepOrdinal += 1;
      const refStr = hook.ref?.skill
        ? `skill:${hook.ref.skill}`
        : hook.ref?.agent
          ? `agent:${hook.ref.agent}`
          : JSON.stringify(hook.ref ?? {});
      lines.push(`### Step ${stepOrdinal}: ${refStr} (${hook.capId})`);
      if (hook.produces && hook.produces.length > 0) {
        lines.push(`- produces: ${hook.produces.join(', ')}`);
      }
      if (hook.consumes && hook.consumes.length > 0) {
        lines.push(`- consumes: ${hook.consumes.join(', ')}`);
      }
      if (hook.when) {
        lines.push(`- when: \`${hook.when}\``);
      }
      if (hook.onError) {
        lines.push(`- onError: ${hook.onError}`);
      }
      if (hook.fragment?.inline) {
        lines.push('');
        lines.push(hook.fragment.inline);
      } else if (hook.fragment?.path) {
        lines.push('');
        lines.push(`_Step fragment path is declared but not rendered by loop-resolver: ${hook.fragment.path}_`);
      }
      lines.push('');
    } else if (hook.kind === 'contribution') {
      lines.push(`<contribution from="${hook.capId}" into="${hook.into ?? '(unset)'}">`);
      if (hook.fragment?.inline) {
        lines.push(hook.fragment.inline);
      } else if (hook.fragment?.path) {
        lines.push(`_Contribution fragment path is declared but not rendered by loop-resolver: ${hook.fragment.path}_`);
      }
      if (hook.produces && hook.produces.length > 0) {
        lines.push(`- produces: ${hook.produces.join(', ')}`);
      }
      if (hook.consumes && hook.consumes.length > 0) {
        lines.push(`- consumes: ${hook.consumes.join(', ')}`);
      }
      if (hook.when) {
        lines.push(`- when: \`${hook.when}\``);
      }
      if (hook.onError) {
        lines.push(`- onError: ${hook.onError}`);
      }
      lines.push('</contribution>');
      lines.push('');
    } else if (hook.kind === 'gate') {
      let checkStr = '(none)';
      if (hook.check !== undefined && hook.check !== null) {
        checkStr = typeof hook.check === 'object'
          ? JSON.stringify(hook.check)
          : typeof hook.check === 'string' || typeof hook.check === 'number' || typeof hook.check === 'boolean'
            ? String(hook.check)
            : '(complex)';
      }
      lines.push(`**Gate** (${hook.capId}): check=${checkStr}, blocking=${String(hook.blocking ?? false)}, onError=${hook.onError ?? 'skip'}`);
      if (hook.when) {
        lines.push(`- when: \`${hook.when}\``);
      }
      lines.push('');
    }
  }

  // Trim trailing blank line
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

// ─── I/O command handler ───────────────────────────────────────────────────────

/**
 * Command entry point: load registry + config, resolve + render, emit envelope.
 *
 * Envelope: { point, activeHooks, rendered }
 * On invalid point, emits io.error instead of throwing.
 *
 * Config note: FIX 1 replaced _loadMergedConfig (whole-config deep-merge) with a
 * per-hook single-key activation resolver (_resolveActivationValue). The resolver
 * checks loadConfig result first, then raw config.json files directly (workstream
 * then root), then the registry's configSchema default. This eliminates the
 * merged-object-from-untrusted-keys security concern and correctly handles
 * pre-cutover keys like `workflow.ui_phase` that live in config.json but are not
 * yet exposed through loadConfig's whitelist.
 *
 * --active-cap <capId>: when present, resolves hooks for <point> exactly as the
 * normal path does, then prints exactly `true` (if any resolved activeHook has
 * capId === <capId>) or `false` followed by a single newline, and exits 0.
 * No JSON envelope is emitted — output is clean for shell $(…) capture.
 * Missing <capId> value → coreError + non-zero exit.
 * Unknown/inactive capId → `false` (not an error).
 */
// #2009: a capability id surfaced inside the runnable `gsd capability remove <id>`
// remediation must match the canonical kebab-case id shape (identical to
// capability-consent.cts / capability-ledger.cts) before it is embedded — a raw
// overlay directory name is attacker-controlled and can carry shell/markdown
// metacharacters (backticks, ';', '|', '$()'). An id that fails this check is
// withheld and no runnable command is rendered for it.
const LOAD_FAIL_CAP_ID_RE = /^[a-z][a-z0-9-]*$/;

// #2009: neutralize control chars, newlines, and backticks from a third-party
// load-failure reason so a malicious manifest cannot break out of the warning
// line or inject markdown / prompt content into the surfaced message.
function sanitizeLoadFailReason(reason: unknown): string {
  const cleaned = String(reason)
    // Strip C0 control chars, DEL, and backticks; collapse remaining whitespace.
    .replace(/[\x00-\x1F\x7F`]/g, ' ')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return cleaned || '(no reason given)';
}

interface ResolvedActiveHooks {
  point: string;
  activeHooks: ActiveHook[];
  warnings: string[];
}

/**
 * The full config/registry/capability-state resolution `cmdLoopRenderHooks` performs, minus its
 * CLI-only output formatting — extracted so an in-process caller (e.g. `review-lane dispatch-step`
 * self-verifying a `supportsReviewerLanes` trait) can reach the SAME resolution `gsd_run loop
 * render-hooks <point> --raw` would give it, without spawning a subprocess and re-parsing its
 * stdout (which was subject to `io.cjs`'s `@file:` overflow protocol on the rendered-string
 * envelope — a bug class this in-process call cannot hit, since it never touches that envelope
 * or its rendering at all).
 *
 * Throws on an invalid `point` (mirrors `resolveLoopHooks`); callers convert to their own error
 * channel. Emits the same loud stderr load-failure warnings `cmdLoopRenderHooks` always has,
 * regardless of caller — a skipped gate must never be silently invisible.
 */
function resolveActiveHooksForPoint(
  cwd: string,
  point: string,
  options: Record<string, unknown> = {},
): ResolvedActiveHooks {
  const runtimeConfigDir = typeof options['configDir'] === 'string'
    ? options['configDir']
    : undefined;
  // #2003: thread an explicit --runtime override into the capability-state
  // resolver so the config-dir resolution bypasses the persisted-runtime
  // fallback (GSD_RUNTIME → config.runtime). Without this, a repo with persisted
  // runtime:"codex" resolves the config dir to ~/.codex and execute:post /
  // verify:post hooks silently no-op when the operator drives from Claude Code.
  const runtimeOverride = typeof options['runtime'] === 'string' ? options['runtime'] : undefined;
  // Load the config snapshot ONCE and share it with both the capability-state
  // resolver (via configOverride) and loop-hook resolution, so federated keys
  // present in loadConfig resolve identically for `active` and for hook when/
  // configValues — eliminating the previous double loadConfig() call. Note: keys
  // absent from loadConfig still fall through to raw .planning/config.json reads
  // (precedence levels 2-3) in each pass; that residual re-read window is
  // pre-existing (unchanged by this consolidation), not introduced here.
  let config: Record<string, unknown>;
  try {
    config = loadConfig(cwd);
  } catch {
    config = {};
  }
  const state = resolveCapabilityRuntimeState(cwd, runtimeConfigDir, config, runtimeOverride) as {
    warnings?: string[];
    capabilities: Array<{ id: string; enabled?: boolean; active: boolean }>;
  };
  // Load overlay-aware registry (ADR-1244 D2 wiring) so installed third-party
  // capabilities are visible to loop rendering exactly like first-party ones.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadRegistry } = require('./capability-loader.cjs') as { loadRegistry: (opts?: Record<string, unknown>) => Record<string, unknown> };
  // #1459 IC-04: thread the consent home (process.env.GSD_HOME) EXPLICITLY so a consented project cap's
  // loop surfaces (steps/gates/contributions) render here at the SAME home that gated its activation.
  const registry = loadRegistry({ includeInstalled: true, cwd, gsdHome: process.env['GSD_HOME'] });
  const capabilityStatesById = new Map<string, { enabled?: boolean; active: boolean }>();
  for (const cap of state.capabilities || []) {
    capabilityStatesById.set(cap.id, cap);
  }

  const resolved: ResolveLoopHooksResult = resolveLoopHooks({ point, registry, config, cwd, capabilityStatesById });

  // ── ADR-1244 D2: load-failed capability gates FAIL OPEN with a loud warning ────
  // Decision (#2009): a capability that failed to LOAD must not block the loop.
  // The prior behavior injected a BLOCKING synthetic gate (blocking:true,
  // onError:'halt') at every point where the skipped cap declared a gate, so a
  // single incompatible capability halted every ship:pre / verify:post
  // project-wide for a load error unrelated to what the gate checked — with no
  // remediation surfaced. We now fail OPEN: no gate is injected (the loop proceeds
  // and `--active-cap <failed-cap>` correctly reports it inactive), and a loud
  // warning is emitted instead — to STDERR (which the operator, or the agent
  // running the command, actually sees regardless of how the host workflow
  // consumes stdout) AND in the envelope's `warnings` channel for structured
  // consumers. The warning names the load reason and the exact
  // `gsd capability remove <id>` remediation so the operator can clear the broken
  // capability. blockedGates is still recorded by the loader; only the consequence
  // changes from block to warn. step/contribution overlays were already skip-open.
  //
  // The gate injection was dropped rather than made non-blocking because no host
  // workflow generically surfaces an arbitrary gate's message at ship:pre /
  // verify:post (consumers dispatch on specific capIds / ref.skills), and the
  // generic gate consumers expect an object-shaped `check`, not a prose string —
  // so an injected advisory gate would be silently dropped or mis-dispatched. A
  // stderr warning is the channel that is actually surfaced. (See #2009 review.)
  const overlayMeta = (registry as { _overlay?: { blockedGates?: Array<{ point: string; capId: string; reason: string }> } })['_overlay'];
  const loadFailWarnings: string[] = [];
  if (overlayMeta && Array.isArray(overlayMeta.blockedGates)) {
    for (const blocked of overlayMeta.blockedGates) {
      if (blocked.point !== point) continue;
      // Security (#2009 review): capId/reason come from a third-party manifest or
      // directory name. Validate capId before embedding it in the runnable
      // remediation command; withhold it (no runnable command) if it is not a
      // canonical id. Strip control chars/backticks from reason.
      const idValid = LOAD_FAIL_CAP_ID_RE.test(String(blocked.capId));
      const capLabel = idValid
        ? `"${blocked.capId}"`
        : 'with an invalid id (withheld) under .gsd/capabilities/';
      const remediation = idValid
        ? `Run \`gsd capability remove ${blocked.capId}\` to remove it, or fix the load error.`
        : 'Remove the offending capability directory under .gsd/capabilities/, or fix the load error.';
      loadFailWarnings.push(
        `capability ${capLabel} failed to load (${sanitizeLoadFailReason(blocked.reason)}); ` +
        `its gate at ${point} is SKIPPED and NOT enforced (failing open). ${remediation}`,
      );
    }
  }
  // Emit loudly to stderr in EVERY output mode (including --active-cap), so a
  // skipped gate is never silently invisible to the operator/agent.
  for (const w of loadFailWarnings) {
    process.stderr.write(`gsd: warning — ${w}\n`);
  }

  // Surface capability-state warnings and the #2009 load-failure fail-open warnings together
  // (in addition to the stderr emission above, which is the channel host workflows actually see).
  const combinedWarnings = [...(state.warnings || []), ...loadFailWarnings];

  return { point: resolved.point, activeHooks: resolved.activeHooks, warnings: combinedWarnings };
}

function cmdLoopRenderHooks(
  cwd: string,
  point: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  if (!point) {
    coreError('loop render-hooks requires a <point> argument. Valid points: ' + CANONICAL_POINTS.join(', '));
    return;
  }

  // --active-cap <capId> mode: emit 'true' or 'false' only (scanner-safe, no JSON envelope)
  const activeCapId = typeof options['activeCap'] === 'string' ? options['activeCap'] : undefined;
  if (activeCapId !== undefined && activeCapId === '') {
    coreError('--active-cap requires a <capId> value (e.g. --active-cap tdd)');
    return;
  }

  let result: ResolvedActiveHooks;
  try {
    result = resolveActiveHooksForPoint(cwd, point, options);
  } catch (err: unknown) {
    const msg = (err instanceof Error) ? err.message : String(err);
    coreError(msg);
    return;
  }

  if (activeCapId !== undefined) {
    const isActive = result.activeHooks.some((h) => h.capId === activeCapId);
    process.stdout.write(isActive ? 'true\n' : 'false\n');
    return;
  }

  const rendered = renderLoopHooks({ point: result.point, activeHooks: result.activeHooks });
  const envelope: {
    point: string;
    activeHooks: ActiveHook[];
    rendered: string;
    warnings?: string[];
  } = {
    point: result.point,
    activeHooks: result.activeHooks,
    rendered,
  };
  if (result.warnings.length > 0) {
    envelope.warnings = result.warnings;
  }

  coreOutput(envelope, raw);
}

export = {
  resolveLoopHooks,
  renderLoopHooks,
  cmdLoopRenderHooks,
  resolveActiveHooksForPoint,
  // Exported for tests
  _getNestedConfigValue,
  _resolveActivationValue,
  _readRawConfigKey,
  // Re-exported for identity parity guard (FIX 2: resolveConfigValues in this module
  // calls resolveConfigKey; exporting it here makes the single-owner contract testable).
  resolveConfigKey,
  // #3661: re-exported for the same identity parity guard — isActive calls
  // _resolvePointGate; exporting it here makes the single-owner contract testable
  // (see tests/capability-precedence-parity.test.cjs's identity guard describe block).
  _resolvePointGate,
  CANONICAL_POINTS_FALLBACK,
  CANONICAL_POINTS,
};
