'use strict';

/**
 * Host Integration module — ADR-1239 Phase A.
 *
 * Pure, additive, no-I/O module providing a closed vocabulary for host
 * integration axes, degradation ladder, profile classification, and
 * capability negotiation.
 *
 * The SINGLE source of truth for integration axes and degradation levels.
 * All functions are pure (no side effects, no I/O).
 *
 * Per-CLI sourced axis VALUES (with citations) live in docs/reference/host-integration-capability-matrix.md — every value is documented or explicitly 'undocumented'.
 */

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Undocumented sentinel — fail-closed when a host omits CLI docs for an axis
// ---------------------------------------------------------------------------

/**
 * Sentinel value used when a host descriptor's CLI docs do not state a value
 * for an axis. It VALIDATES (accepted by the validator) but NEVER propagates
 * into effective axes — it fails closed exactly like an unknown/missing value.
 *
 * Do NOT add to HOST_INTEGRATION_AXES (which is the documented vocabulary).
 */
const UNDOCUMENTED = 'undocumented';

// ---------------------------------------------------------------------------
// Closed vocabulary — axes and interface points
// ---------------------------------------------------------------------------

const HOST_INTEGRATION_AXES = Object.freeze({
  embeddingMode:   Object.freeze(['imperative', 'declarative'] as const),
  commandSurface:  Object.freeze(['slash-file', 'slash-programmatic', 'slash-toml', 'palette', 'prose-only'] as const),
  modelMode:       Object.freeze(['active', 'passive'] as const),
  hookBus:         Object.freeze(['host', 'engine', 'none'] as const),
  stateIO:         Object.freeze(['filesystem', 'sandboxed-storage', 'session-log-append'] as const),
  transport:       Object.freeze(['mcp', 'native-extension'] as const),
  runtime:         Object.freeze(['node', 'bun', 'sandboxed-web', 'python', 'go', 'rust', 'electron', 'other'] as const),
  subagentToolkit: Object.freeze(['full', 'read-only', 'built-in-only'] as const),
  // ADR-1239 amendment (#2481): how reasoning effort reaches this host.
  // `argv` — deliverable as an argument on the host's own invocation.
  // `none` — the host exposes no reasoning-effort mechanism.
  // `undocumented` is NOT a member here; it is the corpus-wide sentinel above.
  // A config-file-only surface deliberately has NO vocabulary member: the only
  // host that ever had one (Gemini CLI's thinkingConfig) was removed as a sunset
  // runtime in #1928/#1996, and neither its successor Antigravity CLI nor ZCode
  // documents a reasoning setting. Adding a member with no host would be a guess.
  effortSurface:   Object.freeze(['argv', 'none'] as const),
  // ADR-1239 Codex-binding amendment (#2584): a `dispatch` sub-field — not a new
  // axis — declaring how a host isolates concurrent same-wave executors.
  // `harness-worktree` — the host's own harness creates + binds a git worktree
  // per executor; GSD passes the host's own isolation flag and calls no git
  // itself (host-driven fan-out).
  // `orchestrator-worktree` — GSD itself process-spawns each executor with an
  // explicit working directory into a worktree GSD created, validated, and
  // merges (GSD-driven fan-out; concurrency is OS-level, not the host's).
  // `none` — no isolation primitive; same-wave plans run inline/sequentially
  // (the #853 flatten rule).
  // `undocumented` is NOT a member here; it is the corpus-wide sentinel above.
  // Mechanism-specific ("worktree"), not abstract — same "name only what a
  // host actually has" rule that kept effortSurface from guessing a
  // config-file member above. A future non-worktree isolation mechanism adds a
  // `*-container` member then, evidence-backed.
  isolation:       Object.freeze(['harness-worktree', 'orchestrator-worktree', 'none'] as const),
});

const INTERFACE_POINTS = Object.freeze(['command', 'dispatch', 'model', 'hooks', 'state', 'artifact'] as const);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EmbeddingMode    = 'imperative' | 'declarative';
type CommandSurface   = 'slash-file' | 'slash-programmatic' | 'slash-toml' | 'palette' | 'prose-only';
type ModelMode        = 'active' | 'passive';
type HookBus          = 'host' | 'engine' | 'none';
type StateIO          = 'filesystem' | 'sandboxed-storage' | 'session-log-append';
type Transport        = 'mcp' | 'native-extension';
type HostRuntime      = 'node' | 'bun' | 'sandboxed-web' | 'python' | 'go' | 'rust' | 'electron' | 'other';
type SubagentToolkit  = 'full' | 'read-only';
type EffortSurface    = 'argv' | 'none';
type DispatchIsolation = 'harness-worktree' | 'orchestrator-worktree' | 'none';
type DegradationLevel = 'full' | 'degraded' | 'absent';
type InterfacePoint   = 'command' | 'dispatch' | 'model' | 'hooks' | 'state' | 'artifact';

interface DispatchCapability {
  namedDispatch: boolean;
  nested: boolean;
  maxDepth: number;
  background: boolean;
  subagentToolkit: SubagentToolkit;
  backgroundDispatch: boolean;
  isolation: DispatchIsolation;
}

interface HostIntegrationAxes {
  embeddingMode: EmbeddingMode;
  commandSurface: CommandSurface;
  dispatch: DispatchCapability;
  modelMode: ModelMode;
  hookBus: HookBus;
  stateIO: StateIO;
  transport: Transport;
  runtime: HostRuntime;
  effortSurface: EffortSurface;
}

interface DegradationResult {
  level: DegradationLevel;
  fallback: string;
  unknown?: boolean;
}

// ---------------------------------------------------------------------------
// Profile baselines
// ---------------------------------------------------------------------------

// Fail-closed floor: the most restrictive known value per axis, injected when a host omits an axis (degrade-closed, never assume capability).
const SAFE_DEFAULTS: HostIntegrationAxes = {
  embeddingMode:  'declarative',
  commandSurface: 'prose-only',
  dispatch: { namedDispatch: false, nested: false, maxDepth: 0, background: false, subagentToolkit: 'read-only', backgroundDispatch: false, isolation: 'none' },
  modelMode:      'passive',
  hookBus:        'none',
  stateIO:        'session-log-append',
  transport:      'mcp',
  runtime:        'node',
  effortSurface:  'none',
};

const PROFILE_BASELINES: Readonly<Record<'programmatic-cli' | 'declarative-cli' | 'ide', HostIntegrationAxes>> =
  Object.freeze({
    'programmatic-cli': Object.freeze({
      embeddingMode:  'imperative',
      commandSurface: 'slash-file',
      dispatch: Object.freeze({ namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: true, isolation: 'none' }),
      modelMode:      'passive',
      hookBus:        'host',
      stateIO:        'filesystem',
      transport:      'mcp',
      runtime:        'node',
      effortSurface:  'none',
    } as HostIntegrationAxes),
    'declarative-cli': Object.freeze({
      embeddingMode:  'declarative',
      commandSurface: 'slash-file',
      dispatch: Object.freeze({ namedDispatch: true, nested: false, maxDepth: 1, background: false, subagentToolkit: 'full', backgroundDispatch: false, isolation: 'none' }),
      modelMode:      'passive',
      hookBus:        'host',
      stateIO:        'filesystem',
      transport:      'mcp',
      runtime:        'node',
      effortSurface:  'none',
    } as HostIntegrationAxes),
    'ide': Object.freeze({
      embeddingMode:  'imperative',
      commandSurface: 'palette',
      dispatch: Object.freeze({ namedDispatch: true, nested: true, maxDepth: 5, background: true, subagentToolkit: 'full', backgroundDispatch: true, isolation: 'none' }),
      modelMode:      'active',
      hookBus:        'engine',
      stateIO:        'sandboxed-storage',
      transport:      'mcp',
      runtime:        'sandboxed-web',
      effortSurface:  'none',
    } as HostIntegrationAxes),
  });

// ---------------------------------------------------------------------------
// degradationFor — plain data-table lookup (NOT clever code)
// ---------------------------------------------------------------------------

/**
 * Look up the degradation level for a given interface point and partial axes.
 *
 * NEVER throws. Returns { level:'absent', fallback:'...', unknown:true } for
 * any missing or unrecognised axis value.
 */
function degradationFor(point: InterfacePoint, axes: Partial<HostIntegrationAxes>): DegradationResult {
  const UNKNOWN: DegradationResult = {
    level: 'absent',
    fallback: 'unknown capability — degraded closed',
    unknown: true,
  };

  switch (point) {
    case 'command': {
      const cs = (axes as Record<string, unknown>).commandSurface;
      if (cs === 'slash-file' || cs === 'slash-programmatic') return { level: 'full', fallback: '' };
      if (cs === 'slash-toml' || cs === 'palette')            return { level: 'degraded', fallback: 'toml/palette surface — limited command routing' };
      if (cs === 'prose-only')                                 return { level: 'absent',  fallback: 'AGENTS.md prose + skills menu' };
      return UNKNOWN;
    }

    case 'dispatch': {
      const d = (axes as Record<string, unknown>).dispatch;
      if (!d || typeof d !== 'object') return UNKNOWN;
      const disp = d as Record<string, unknown>;
      if (disp.namedDispatch !== true || disp.maxDepth === 0) {
        return { level: 'absent', fallback: 'single-agent inline / SDK sub-session' };
      }
      // maxDepth < 0 means unbounded
      const isUnbounded = typeof disp.maxDepth === 'number' && Number.isFinite(disp.maxDepth) && disp.maxDepth < 0;
      const depth = (typeof disp.maxDepth === 'number' && Number.isFinite(disp.maxDepth)) ? disp.maxDepth : 0;
      const isFullDepth = isUnbounded || (disp.nested === true && depth >= 2);
      if (isFullDepth) {
        // Fail-closed: return 'full' ONLY when subagentToolkit is explicitly 'full';
        // any other value (read-only, undocumented, unknown, missing) → degraded.
        if (disp.subagentToolkit === 'full') {
          return { level: 'full', fallback: '' };
        }
        return { level: 'degraded', fallback: 'restricted/undocumented subagent toolkit — limited dispatch surface' };
      }
      // flat (maxDepth===1)
      return { level: 'degraded', fallback: 'flat dispatch — waves run inline' };
    }

    case 'model': {
      // NOTE (#2481): the effortSurface axis is deliberately NOT folded into this
      // level. `modelMode` has graded interface point 3 since Phase A, and every
      // existing consumer reads it as "can GSD drive model selection". Widening it
      // to also mean "…and deliver effort" silently redefines an established
      // contract — an `active` host with no declared effort surface would flip
      // from `full` to `absent`. Effort is negotiated on its own axis and read
      // from `effective.effortSurface` by the consumers that care.
      const mm = (axes as Record<string, unknown>).modelMode;
      if (mm === 'active')  return { level: 'full',     fallback: '' };
      if (mm === 'passive') return { level: 'degraded', fallback: 'instruction-injection / per-agent model field' };
      return UNKNOWN;
    }

    case 'hooks': {
      const hb = (axes as Record<string, unknown>).hookBus;
      if (hb === 'host')   return { level: 'full',     fallback: '' };
      if (hb === 'engine') return { level: 'degraded', fallback: 'engine-owned bus' };
      if (hb === 'none')   return { level: 'absent',   fallback: 'rule-text instructions' };
      return UNKNOWN;
    }

    case 'state': {
      const si = (axes as Record<string, unknown>).stateIO;
      if (si === 'filesystem')          return { level: 'full',     fallback: '' };
      if (si === 'sandboxed-storage')   return { level: 'degraded', fallback: 'sandboxed storage' };
      if (si === 'session-log-append')  return { level: 'degraded', fallback: 'append-only session log' };
      return UNKNOWN;
    }

    case 'artifact': {
      const cs = (axes as Record<string, unknown>).commandSurface;
      if (cs === 'slash-file' || cs === 'slash-programmatic') return { level: 'full',     fallback: '' };
      if (cs === 'slash-toml' || cs === 'prose-only')         return { level: 'degraded', fallback: 'menu / @-only' };
      if (cs === 'palette')                                    return { level: 'absent',   fallback: 'palette + chat participant; skills become LM tools' };
      return UNKNOWN;
    }

    default:
      return UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// profileOf
// ---------------------------------------------------------------------------

/**
 * Classify a partial set of integration axes into a named profile.
 * Returns null when no profile can be determined.
 */
function profileOf(axes: Partial<HostIntegrationAxes>): 'programmatic-cli' | 'declarative-cli' | 'ide' | null {
  const a = axes as Record<string, unknown>;
  if (a.embeddingMode === 'imperative' && a.runtime === 'sandboxed-web') return 'ide';
  if (a.embeddingMode === 'imperative')   return 'programmatic-cli';
  if (a.embeddingMode === 'declarative')  return 'declarative-cli';
  return null;
}

// ---------------------------------------------------------------------------
// EngineCapabilities + DEFAULT_ENGINE
// ---------------------------------------------------------------------------

interface EngineCapabilities {
  protocolVersion: number;
  axes: HostIntegrationAxes;
  known: typeof HOST_INTEGRATION_AXES;
}

const DEFAULT_ENGINE: EngineCapabilities = {
  protocolVersion: PROTOCOL_VERSION,
  axes: {
    embeddingMode:  'imperative',
    commandSurface: 'slash-file',
    dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: true, isolation: 'none' },
    modelMode:      'active',
    hookBus:        'host',
    stateIO:        'filesystem',
    transport:      'mcp',
    runtime:        'node',
    effortSurface:  'argv',
  },
  known: HOST_INTEGRATION_AXES,
};

// ---------------------------------------------------------------------------
// NegotiationResult
// ---------------------------------------------------------------------------

interface NegotiationResult {
  protocolVersion: number;
  effective: HostIntegrationAxes;
  points: Record<InterfacePoint, { hostLevel: DegradationLevel; effectiveLevel: DegradationLevel; fallback: string }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// negotiateHostCapabilities
// ---------------------------------------------------------------------------

/**
 * Negotiate host integration capabilities against an engine.
 *
 * POST-CONDITION: every effective scalar axis value is in engine.known[axis].
 * effective never contains a value the host didn't declare AND the engine
 * cannot drive.
 *
 * NEVER throws. Returns a fresh object each call (mutation-safe).
 */
function negotiateHostCapabilities(
  host: Partial<HostIntegrationAxes> & { protocolVersion?: number },
  engine: EngineCapabilities = DEFAULT_ENGINE,
): NegotiationResult {
  const warnings: string[] = [];
  const h = host as Record<string, unknown>;
  // Warn if protocolVersion is present but not a finite number
  if (h.protocolVersion !== undefined && (typeof h.protocolVersion !== 'number' || !Number.isFinite(h.protocolVersion))) {
    warnings.push(`host protocolVersion is not a finite number — using engine version ${engine.protocolVersion}`);
  }
  const hostPV = (typeof h.protocolVersion === 'number' && Number.isFinite(h.protocolVersion)) ? h.protocolVersion : engine.protocolVersion;
  const enginePV = engine.protocolVersion;

  // Warn if host declares a newer protocol version
  if (hostPV > enginePV) {
    warnings.push(
      `host protocolVersion ${hostPV} newer than engine ${enginePV} — capabilities beyond version ${enginePV} not trusted`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helper: negotiate a single scalar axis
  // ---------------------------------------------------------------------------
  function negotiateScalar<K extends keyof typeof HOST_INTEGRATION_AXES>(
    axis: K,
  ): (typeof HOST_INTEGRATION_AXES)[K][number] {
    type V = (typeof HOST_INTEGRATION_AXES)[K][number];
    const knownValues: ReadonlyArray<V> = engine.known[axis];
    const hostVal = h[axis] as V | undefined;
    const engineVal = engine.axes[axis as keyof HostIntegrationAxes] as V;
    const safeDefault = SAFE_DEFAULTS[axis as keyof HostIntegrationAxes] as V;

    if (hostVal === undefined || hostVal === null) {
      // Host did not declare this axis
      warnings.push(`host did not declare '${axis}'`);
      return safeDefault;
    }
    if ((hostVal as unknown) === UNDOCUMENTED) {
      // Host declared the undocumented sentinel — treat as fail-closed (degrade to safe default)
      warnings.push(`host axis '${axis}' is undocumented — degraded closed`);
      return safeDefault;
    }
    if (!knownValues.includes(hostVal)) {
      // Host declared an unknown/future value — NEVER copy into effective
      warnings.push(
        `host declared unknown '${axis}' value '${String(hostVal)}' — not trusted (host protocolVersion ${hostPV} vs engine ${enginePV})`,
      );
      return safeDefault;
    }
    // Engine capability cap: if the engine can't drive the host's value,
    // use the engine's lesser capability.
    // For modelMode: 'active' > 'passive' — if host wants active but engine
    // is passive, cap to passive.
    if (axis === 'modelMode') {
      if (hostVal === 'active' && engineVal === 'passive') return 'passive';
    }
    // For effortSurface: 'argv' > 'none'. An engine that cannot deliver the
    // host's richer channel caps the result to what it can drive.
    if (axis === 'effortSurface') {
      const RANK: Record<string, number> = { argv: 1, none: 0 };
      const hr = RANK[hostVal as string] ?? 0;
      const er = RANK[engineVal as string] ?? 0;
      if (hr > er) return engineVal;
    }
    return hostVal;
  }

  // Negotiate all scalar axes
  const effectiveEmbeddingMode  = negotiateScalar('embeddingMode');
  const effectiveCommandSurface = negotiateScalar('commandSurface');
  const effectiveModelMode      = negotiateScalar('modelMode');
  const effectiveHookBus        = negotiateScalar('hookBus');
  const effectiveStateIO        = negotiateScalar('stateIO');
  const effectiveTransport      = negotiateScalar('transport');
  const effectiveRuntime        = negotiateScalar('runtime');
  const effectiveEffortSurface  = negotiateScalar('effortSurface');

  // ---------------------------------------------------------------------------
  // Dispatch struct negotiation
  // ---------------------------------------------------------------------------
  const hostDispatch = (typeof h.dispatch === 'object' && h.dispatch !== null)
    ? h.dispatch as Record<string, unknown>
    : null;
  const engineDispatch = engine.axes.dispatch;

  let effectiveNamedDispatch: boolean;
  let effectiveNested: boolean;
  let effectiveBackground: boolean;
  let effectiveBackgroundDispatch: boolean;
  let effectiveSubagentToolkit: SubagentToolkit;
  let effectiveMaxDepth: number;
  let effectiveIsolation: DispatchIsolation;

  if (hostDispatch === null) {
    // Host didn't declare dispatch at all — fail-closed to most-restrictive values
    warnings.push(`host did not declare 'dispatch'`);
    effectiveNamedDispatch      = false;
    effectiveNested             = false;
    effectiveBackground         = false;
    effectiveBackgroundDispatch = false;
    effectiveSubagentToolkit    = 'read-only';
    effectiveMaxDepth           = 0;
    effectiveIsolation          = 'none';
  } else {
    // N1: observability warnings for 'undocumented' sentinel on dispatch fields
    if (hostDispatch.namedDispatch === 'undocumented') {
      warnings.push(`dispatch.namedDispatch is undocumented — degraded closed`);
    }
    if (hostDispatch.nested === 'undocumented') {
      warnings.push(`dispatch.nested is undocumented — degraded closed`);
    }
    if (hostDispatch.background === 'undocumented') {
      warnings.push(`dispatch.background is undocumented — degraded closed`);
    }
    if (hostDispatch.subagentToolkit === 'undocumented') {
      warnings.push(`dispatch.subagentToolkit is undocumented — degraded closed (read-only)`);
    }
    if (hostDispatch.backgroundDispatch === 'undocumented') {
      warnings.push(`dispatch.backgroundDispatch is undocumented — degraded closed`);
    }
    if (hostDispatch.isolation === 'undocumented') {
      warnings.push(`dispatch.isolation is undocumented — degraded closed (none)`);
    }

    effectiveNamedDispatch      = (hostDispatch.namedDispatch === true) && engineDispatch.namedDispatch;
    effectiveNested             = (hostDispatch.nested === true) && engineDispatch.nested;
    effectiveBackground         = (hostDispatch.background === true) && engineDispatch.background;
    effectiveBackgroundDispatch = (hostDispatch.backgroundDispatch === true) && engineDispatch.backgroundDispatch;

    // subagentToolkit: fail closed to read-only unless explicitly 'full'
    // (an 'undocumented' or 'read-only' value → read-only)
    const hostToolkit   = hostDispatch.subagentToolkit === 'full' ? 'full' : 'read-only';
    const engineToolkit = engineDispatch.subagentToolkit === 'read-only' ? 'read-only' : 'full';
    effectiveSubagentToolkit = (hostToolkit === 'read-only' || engineToolkit === 'read-only') ? 'read-only' : 'full';

    // isolation: effective = the host's declared value only if it is a known
    // valid vocabulary member; otherwise 'none'. NOT host && engine gated —
    // GSD owns the vocabulary, so "engine-known" == "in the valid set" (this
    // still satisfies effective ⊆ host-declared ∩ engine-known).
    const hostIso = hostDispatch.isolation;
    effectiveIsolation = (typeof hostIso === 'string' && (HOST_INTEGRATION_AXES.isolation as readonly string[]).includes(hostIso))
      ? hostIso as DispatchIsolation
      : 'none';

    // maxDepth: missing/non-number/non-finite → 0 + warning
    let hostMaxDepth: number;
    if (typeof hostDispatch.maxDepth !== 'number' || !Number.isFinite(hostDispatch.maxDepth)) {
      warnings.push(`host dispatch.maxDepth is missing or not a number — treating as 0`);
      hostMaxDepth = 0;
    } else {
      hostMaxDepth = hostDispatch.maxDepth;
    }

    // Treat negative as +Infinity for the min, then if result is +Infinity emit -1
    const hDepthNum = hostMaxDepth < 0 ? Infinity : hostMaxDepth;
    const eDepthNum = engineDispatch.maxDepth < 0 ? Infinity : engineDispatch.maxDepth;
    const minDepth  = Math.min(hDepthNum, eDepthNum);
    effectiveMaxDepth = minDepth === Infinity ? -1 : minDepth;

    // If namedDispatch is false, cap maxDepth/nested/background/backgroundDispatch to 0/false/false/false (struct consistency)
    if (!effectiveNamedDispatch) {
      effectiveMaxDepth           = 0;
      effectiveNested             = false;
      effectiveBackground         = false;
      effectiveBackgroundDispatch = false;
    }
  }

  const effectiveDispatch: DispatchCapability = {
    namedDispatch:      effectiveNamedDispatch,
    nested:             effectiveNested,
    maxDepth:           effectiveMaxDepth,
    background:         effectiveBackground,
    subagentToolkit:    effectiveSubagentToolkit,
    backgroundDispatch: effectiveBackgroundDispatch,
    isolation:          effectiveIsolation,
  };

  // ---------------------------------------------------------------------------
  // Assemble effective axes
  // ---------------------------------------------------------------------------
  const effective: HostIntegrationAxes = {
    embeddingMode:  effectiveEmbeddingMode,
    commandSurface: effectiveCommandSurface,
    dispatch:       effectiveDispatch,
    modelMode:      effectiveModelMode,
    hookBus:        effectiveHookBus,
    stateIO:        effectiveStateIO,
    transport:      effectiveTransport,
    runtime:        effectiveRuntime,
    effortSurface:  effectiveEffortSurface,
  };

  // ---------------------------------------------------------------------------
  // Compute points (fresh objects — mutation-safe)
  // ---------------------------------------------------------------------------
  const points = {} as Record<InterfacePoint, { hostLevel: DegradationLevel; effectiveLevel: DegradationLevel; fallback: string }>;
  for (const point of INTERFACE_POINTS) {
    const hostDeg      = degradationFor(point, host);
    const effectiveDeg = degradationFor(point, effective);
    points[point] = {
      hostLevel:      hostDeg.level,
      effectiveLevel: effectiveDeg.level,
      fallback:       effectiveDeg.fallback,
    };
  }

  // protocolVersion: min of host and engine
  const resultProtocolVersion = Math.min(hostPV, enginePV);

  return {
    protocolVersion: resultProtocolVersion,
    effective,
    points,
    warnings: [...warnings], // fresh copy
  };
}

// ---------------------------------------------------------------------------
// shouldFlattenDispatch — ADR-1239 Phase B / #1708
// ---------------------------------------------------------------------------

/**
 * Returns true when the orchestrator MUST run inline (flatten); false when it
 * may be backgrounded.
 *
 * A host may background only if it can reliably background a nesting-capable
 * orchestrator — i.e. both `background` AND `backgroundDispatch` are
 * explicitly `true`. Any other value (false, missing, 'undocumented') fails
 * closed to inline (the always-safe path).
 *
 * This graduates the #853 prose rule (originally `RUNTIME === 'codex'`, then
 * extended to cursor) to a typed, documentation-sourced decision; codex AND
 * cursor are both background-eligible in the registry. See
 * docs/reference/host-integration-capability-matrix.md.
 *
 * Null-safety: if dispatch is null, undefined, or not an object, returns true
 * (inline, fail-closed) instead of throwing.
 */
type UnvalidatedDispatch = (Partial<DispatchCapability> & { background?: unknown; backgroundDispatch?: unknown }) | null | undefined;

function shouldFlattenDispatch(dispatch: UnvalidatedDispatch): boolean {
  if (!dispatch || typeof dispatch !== 'object') return true;
  const canBackground = dispatch.background === true && dispatch.backgroundDispatch === true;
  return !canBackground;
}

// ---------------------------------------------------------------------------
// resolveDispatchType — ADR-1239 / epic #2505 Phase 4 (Option A)
//
// Maps a requested GSD subagent name (e.g. "gsd-planner") to the type an
// Agent() call should actually use on the CURRENT runtime. On runtimes whose
// descriptor declares `hostIntegration.dispatch.namedDispatch: true` (Claude,
// OpenCode, Cursor, …), the requested name is returned unchanged — those hosts
// can dispatch GSD's named subagents directly. On runtimes with
// `namedDispatch: false` (kimi-code — only three built-in subagents
// `coder`/`explore`/`plan`, per moonshotai.github.io/kimi-code/en/customization/
// agents), the name is mapped to the closest built-in by role-suffix
// heuristic. The persona rides the existing `${AGENT_SKILLS_*}` prompt
// injection (Phase 3 / #2510) regardless of the resolved type, so the
// dispatcher does not need to know the persona — only the toolkit tier.
//
// This is Option A of the Phase 4 design (per-workflow runtime detection via
// `gsd_run query resolve-dispatch-type`), not Option B (PreToolUse mutation) —
// Kimi Code's documented hook API supports only allow/deny on PreToolUse, not
// tool_input rewriting, so a hook-based remap is infeasible (see #2508).
//
// Fail-closed: unknown dispatch shape or missing namedDispatch axis ⇒ return
// the requested name unchanged (named-dispatch is the GSD default; degrading
// to it on unknown runtimes preserves behavior for every runtime already in
// the field).
// ---------------------------------------------------------------------------

// Role-suffix → built-in mapping. Order matters: the first match wins.
// `plan`-tier agents plan/design without touching files; `explore`-tier agents
// are read-only; everything else (executors, writers, fixers, debuggers) maps
// to `coder` (the general-purpose built-in with the full tool set).
const DISPATCH_TYPE_SUFFIX_MAP: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/-?(planner|roadmapper|selector|spec)$/i, 'plan'],
  [/-?(researcher|mapper|checker|verifier|auditor|analyzer|synthesizer|profiler|curator|classifier|reviewer)$/i, 'explore'],
]);

// Names that are already generic (not gsd-*) and should map to the
// general-purpose built-in on built-in-only runtimes.
const GENERIC_NAMES_TO_CODER: ReadonlySet<string> = Object.freeze(new Set([
  'general-purpose', 'general', 'default', 'sonnet', 'opus', 'haiku',
]));

function resolveDispatchType(requested: unknown, dispatch: UnvalidatedDispatch): string {
  if (typeof requested !== 'string' || requested.length === 0) return 'coder';
  // Built-in-only runtime (EXPLICIT namedDispatch: false, e.g. kimi-code):
  // map to coder/explore/plan by suffix heuristic.
  if (dispatch && typeof dispatch === 'object' && dispatch.namedDispatch === false) {
    if (GENERIC_NAMES_TO_CODER.has(requested)) return 'coder';
    for (const [pattern, builtin] of DISPATCH_TYPE_SUFFIX_MAP) {
      if (pattern.test(requested)) return builtin;
    }
    return 'coder';
  }
  // Named-dispatch runtime (namedDispatch: true OR unknown/absent): use the
  // requested name unchanged. Absent namedDispatch degrades to named-dispatch
  // (the GSD default) so every runtime already in the field keeps working.
  return requested;
}

// ---------------------------------------------------------------------------
// Managed-hook event surface per hookEvents dialect (ADR-1239 / ADR-1016)
// ---------------------------------------------------------------------------

// Host-fireable MANAGED-hook events per `hookEvents` dialect. `hookEvents` is the
// managed-hook dialect — the event names GSD writes into a DECLARATIVE host's
// settings.json (claude = SessionStart/PreToolUse/…; gemini = BeforeTool/AfterTool).
// This is DISTINCT from the extension-system event surface (below): a host's
// plugin/extension API fires a different, plugin-owned event set. The two must
// not be conflated (ADR-1239 amendment / #1943 — the former 'opencode-subset'
// `hookEvents` value was this conflation; it is now `extensionEvents: opencode`).
const HOOK_EVENT_SURFACES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: Object.freeze(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'PreCompact']),
  gemini: Object.freeze(['SessionStart', 'BeforeTool', 'AfterTool', 'SessionEnd']),
});

/**
 * Resolve the managed-hook event surface for a `hookEvents` dialect.
 * Returns null for unknown/missing dialects (fail-closed). Pure, never throws.
 */
function hookEventSurfaceFor(hookEvents: unknown): readonly string[] | null {
  if (typeof hookEvents !== 'string') return null;
  return HOOK_EVENT_SURFACES[hookEvents] || null;
}

// ---------------------------------------------------------------------------
// Extension-system event surface (ADR-1239 amendment / #1943)
// ---------------------------------------------------------------------------

// The events a host's PLUGIN/EXTENSION API exposes — for imperative-embedding
// hosts that load GSD as a plugin. This is a SEPARATE vocabulary + descriptor
// field (`extensionEvents`) from `hookEvents`: hookEvents = the managed-hook
// dialect (declarative hosts' settings.json); extensionEvents = the plugin-owned
// event subset (imperative hosts' extension API). They are not the same thing.
//
// Values are documentation-sourced (ADR-1239 §research): OpenCode ~25 plugin
// events (session/tool/file/permission); pi ~30 fine-grained extension events;
// 'none' = the host exposes no extension surface and the engine owns the bus
// (VS Code). Declarative hosts (no plugin API) do not set `extensionEvents`.
// OpenCode's plugin event surface (ADR-1239 §research; ~25 documented events,
// GSD binds this subset). Hoisted to a named const — rather than duplicated
// object literals — so the `kilo` dialect below (#2093) can reuse the IDENTICAL
// array instead of a copy-pasted one that could silently drift out of sync.
const OPENCODE_EXTENSION_EVENTS = Object.freeze([
  'session.created', 'session.idle', 'experimental.session.compacting',
  'tool.execute.before', 'tool.execute.after', 'file.edited',
  // #2087 — additional documented plugin events GSD binds (opencode.ai/docs/plugins):
  // permission decisions + session error surface.
  'permission.asked', 'permission.replied', 'session.error',
]);

const EXTENSION_EVENT_SURFACES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  opencode: OPENCODE_EXTENSION_EVENTS,
  // #2093 — Kilo Code is an OpenCode fork sharing the same plugin/extension
  // event bus (host hook bus, UPGRADE 1): reuses OPENCODE_EXTENSION_EVENTS
  // verbatim (not a re-derivation), so the two dialects stay pinned together
  // by construction. See .kilo/plugins/gsd-core.js (copied verbatim from
  // .opencode/plugins/gsd-core.js).
  kilo: OPENCODE_EXTENSION_EVENTS,
  // #2091 — Hermes Agent real plugin hook vocabulary (13 events).
  // Cite: https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md
  // Replaces the borrowed `hookEvents: "claude"` 6-event surface that silently
  // never fired on Hermes.
  hermes: Object.freeze([
    'pre_tool_call', 'post_tool_call',
    'pre_llm_call', 'post_llm_call',
    'on_session_start', 'on_session_end',
    'on_session_finalize', 'on_session_reset',
    'subagent_start', 'subagent_stop',
    'pre_gateway_dispatch', 'pre_approval_request',
    'transform_tool_result',
  ]),
  // #2102 Stage 2 — pi's real ExtensionAPI event vocabulary (~30 fine-grained
  // extension events; documentation-sourced, ADR-1239 §research). Replaces the
  // placeholder single-event ['tool_call'] surface — the Stage 1 value only
  // covered the one event pi/gsd.cjs happened to bind at the time, not the
  // full declared surface.
  pi: Object.freeze([
    'session_start', 'project_trust', 'resources_discover', 'input',
    'before_agent_start', 'agent_start', 'message_start', 'message_update',
    'message_end', 'turn_start', 'context', 'before_provider_request',
    'after_provider_response', 'tool_execution_start', 'tool_execution_update',
    'tool_execution_end', 'tool_call', 'tool_result', 'turn_end', 'agent_end',
    'session_before_switch', 'session_shutdown', 'session_before_fork',
    'session_info_changed', 'session_before_compact', 'session_compact',
    'session_before_tree', 'session_tree', 'thinking_level_select', 'model_select',
  ]),
  none: Object.freeze([]),
});

/**
 * Resolve the extension-system event surface for an `extensionEvents` dialect.
 * Returns null for unknown/missing dialects (fail-closed). Pure, never throws.
 *
 * A non-null result is what makes an `extensionEvents` value a CONSUMED value
 * rather than reserved vocab. For 'opencode' it carries NO workflow-phase events
 * — the engine owns phase sequencing internally on such hosts (ADR-1239 §OpenCode).
 */
function extensionEventSurfaceFor(extensionEvents: unknown): readonly string[] | null {
  if (typeof extensionEvents !== 'string') return null;
  return EXTENSION_EVENT_SURFACES[extensionEvents] || null;
}

// ---------------------------------------------------------------------------
// Module export (CommonJS — matches existing src/*.cts pattern)
// ---------------------------------------------------------------------------

export = {
  PROTOCOL_VERSION,
  UNDOCUMENTED,
  HOST_INTEGRATION_AXES,
  INTERFACE_POINTS,
  PROFILE_BASELINES,
  DEFAULT_ENGINE,
  HOOK_EVENT_SURFACES,
  EXTENSION_EVENT_SURFACES,
  degradationFor,
  profileOf,
  negotiateHostCapabilities,
  shouldFlattenDispatch,
  resolveDispatchType,
  hookEventSurfaceFor,
  extensionEventSurfaceFor,
};
