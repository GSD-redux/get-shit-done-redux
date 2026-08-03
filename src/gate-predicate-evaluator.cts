/**
 * Gate Predicate Evaluator — issue #2008 / ADR-2008
 *
 * Pure, deps-injected evaluator for capability gate `check.predicate` blocks.
 *
 * Background: the loop-resolver renders active gate hooks (carrying their
 * `check.predicate` declarations) but, prior to #2008, nothing EVALUATED a
 * declared predicate for non-built-in capabilities — `check.query` was the only
 * enforced shape (dispatched via `gsd_run check <query>`), and `check.predicate`
 * was declaration-only. This module is the generic evaluation path.
 *
 * The workflow gate-dispatch calls this evaluator (via the `gsd_run check predicate`
 * subcommand in check-command-router) for any gate whose `check` carries a
 * `predicate` instead of a `query`. The evaluator dispatches by `predicate.kind`
 * and returns the existing `{ block, message }` gate contract. A THROWN error
 * (malformed predicate / unknown kind) is mapped by the CLI wrapper to a
 * non-zero check-command exit, which the workflow's two-step gate contract treats
 * as a step-1 command failure (routed per the gate's `onError`).
 *
 * Built-in kinds: `command-exit-zero` runs a declared command in a bounded
 * `sh -c` subprocess; `artifact-frontmatter-equals` compares a declared value
 * with frontmatter read through injected artifact dependencies. See ADR-2008
 * for the full contracts.
 *
 * This is a leaf pure module: no fs, no child_process, no config — the subprocess
 * seam is injected so the evaluator is trivially testable without spawning.
 */

// ─── Public constants ─────────────────────────────────────────────────────────

/** Default command timeout for `command-exit-zero` (30s). Matches execTool default. */
const COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS = 30_000;

/** Hard cap on the stderr/stdout tail embedded in the gate `message`. */
const COMMAND_MAX_OUTPUT_CHARS = 2000;

/** Hard cap on the declared command length (defense-in-depth against ARGV overflow / abuse). */
const COMMAND_MAX_LENGTH = 4096;

/** Predicate kinds this evaluator recognises (extensible — add to KIND_TABLE). */
const EVALUATOR_KINDS = Object.freeze(['command-exit-zero', 'artifact-frontmatter-equals']);

/** Placeholders interpolated into a declared command, in addition to sh's own vars. */
const INTERPOLATION_VAR_NAMES = Object.freeze(['PHASE_NUMBER', 'PHASE_DIR', 'PHASE_REQ_IDS']);

// ─── Types (internal; runtime API is the `export =` block) ────────────────────

interface PredicateContext {
  /** Project root — also the cwd of the bounded subprocess. */
  cwd: string;
  phaseNumber?: string;
  phaseDir?: string;
  phaseReqIds?: string;
}

interface BoundedShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface PredicateDeps {
  runBoundedShell(opts: { command: string; cwd: string; timeoutMs: number }): BoundedShellResult;
  findPhaseArtifact(phaseDir: string, artifactSuffix: string): string | null;
  readFrontmatter(filePath: string): Record<string, unknown>;
}

interface PredicateResult {
  block: boolean;
  message: string;
  details?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INTERPOLATION_RE = /\$\{(PHASE_NUMBER|PHASE_DIR|PHASE_REQ_IDS)\}/g;

/** Replace the three known ${PHASE_*} placeholders with context values (undefined => ''). */
function interpolate(command: string, ctx: PredicateContext): string {
  return command.replace(INTERPOLATION_RE, (_whole, name: string): string => {
    if (name === 'PHASE_NUMBER') return ctx.phaseNumber ?? '';
    if (name === 'PHASE_DIR') return ctx.phaseDir ?? '';
    if (name === 'PHASE_REQ_IDS') return ctx.phaseReqIds ?? '';
    return '';
  });
}

/** Cap a string at COMMAND_MAX_OUTPUT_CHARS so gate messages stay context-bounded. */
function trimToMax(s: string): string {
  return s.length > COMMAND_MAX_OUTPUT_CHARS ? s.slice(0, COMMAND_MAX_OUTPUT_CHARS) : s;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// ─── Kind: command-exit-zero ──────────────────────────────────────────────────

function evaluateCommandExitZero(
  predicate: Record<string, unknown>,
  ctx: PredicateContext,
  deps: PredicateDeps,
): PredicateResult {
  const command = predicate['command'];
  if (!isNonEmptyString(command)) {
    throw new Error('command-exit-zero predicate requires a non-empty string "command"');
  }
  if (command.length > COMMAND_MAX_LENGTH) {
    throw new Error(`command-exit-zero predicate "command" exceeds max length ${COMMAND_MAX_LENGTH}`);
  }

  let timeoutMs = COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS;
  const rawTimeout = predicate['timeout'];
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error('command-exit-zero predicate "timeout" must be a positive finite number (seconds)');
    }
    timeoutMs = Math.floor(rawTimeout * 1000);
  }

  const interpolated = interpolate(command, ctx);
  const res = deps.runBoundedShell({ command: interpolated, cwd: ctx.cwd, timeoutMs });

  if (res.timedOut) {
    return {
      block: true,
      message: trimToMax(`command timed out after ${Math.round(timeoutMs / 1000)}s: ${res.stderr || interpolated}`),
      details: { kind: 'command-exit-zero', timedOut: true, signal: res.signal },
    };
  }

  if (res.exitCode === 0) {
    return {
      block: false,
      message: 'command exited 0',
      details: { kind: 'command-exit-zero', exitCode: 0 },
    };
  }

  // Non-zero (incl. null exit from a signal kill) => block. Surface code + stderr/stdout tail.
  const code = res.exitCode === null ? '<none>' : String(res.exitCode);
  const tail = trimToMax(res.stderr || res.stdout || '');
  const message = tail ? `command exited ${code}: ${tail}` : `command exited ${code}`;
  return {
    block: true,
    message: trimToMax(message),
    details: { kind: 'command-exit-zero', exitCode: res.exitCode, signal: res.signal },
  };
}

// ─── Kind: artifact-frontmatter-equals ──────────────────────────────────────────

function evaluateArtifactFrontmatterEquals(
  predicate: Record<string, unknown>,
  ctx: PredicateContext,
  deps: PredicateDeps,
): PredicateResult {
  const artifactSuffix = predicate['artifact'];
  if (!isNonEmptyString(artifactSuffix)) {
    throw new Error('artifact-frontmatter-equals predicate requires a non-empty string "artifact"');
  }
  const field = predicate['field'];
  if (!isNonEmptyString(field)) {
    throw new Error('artifact-frontmatter-equals predicate requires a non-empty string "field"');
  }
  const expectedValue = predicate['equals'];
  if (expectedValue === undefined) {
    throw new Error('artifact-frontmatter-equals predicate requires an "equals" key');
  }
  const targetDir = isNonEmptyString(ctx.phaseDir) ? ctx.phaseDir : ctx.cwd;
  const filePath = deps.findPhaseArtifact(targetDir, artifactSuffix);
  if (!filePath) {
    return {
      block: true,
      message: `Artifact matching ${artifactSuffix} not found in ${targetDir}`,
      details: { kind: 'artifact-frontmatter-equals', artifactNotFound: true },
    };
  }

  const fm = deps.readFrontmatter(filePath);

  const actualValue = fm[field];
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const expectedStr = typeof expectedValue === 'object' ? JSON.stringify(expectedValue) : String(expectedValue);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const actualStr = typeof actualValue === 'object' ? JSON.stringify(actualValue) : String(actualValue);

  const matches = actualValue === expectedValue || (actualValue !== undefined && actualValue !== null && actualStr === expectedStr);
  if (matches) {
    return {
      block: false,
      message: `Frontmatter field "${field}" matches expected value (${expectedStr})`,
      details: { kind: 'artifact-frontmatter-equals', match: true },
    };
  }

  return {
    block: true,
    message: `Frontmatter field "${field}" in ${artifactSuffix} is ${actualStr}, expected ${expectedStr}`,
    details: { kind: 'artifact-frontmatter-equals', match: false, actual: actualValue, expected: expectedValue },
  };
}

// ─── Kind dispatch table ──────────────────────────────────────────────────────

const KIND_TABLE: Record<string, (p: Record<string, unknown>, ctx: PredicateContext, deps: PredicateDeps) => PredicateResult> = {
  'command-exit-zero': evaluateCommandExitZero,
  'artifact-frontmatter-equals': evaluateArtifactFrontmatterEquals,
};

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Evaluate a capability gate `check.predicate`.
 *
 * Returns `{ block, message }` for any successfully-recognised predicate.
 * THROWS for a malformed predicate, missing context/deps, or unknown `kind` —
 * the CLI wrapper converts a throw into a non-zero check-command exit so the
 * workflow's `onError` (step-1) contract applies. This keeps the gate fail-closed
 * without conflating an evaluator bug with a legitimate gate-block decision.
 */
function evaluatePredicate(predicate: unknown, context: unknown, deps: unknown): PredicateResult {
  if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) {
    throw new Error('predicate must be an object');
  }
  const ctx = context as PredicateContext;
  if (!ctx || typeof ctx.cwd !== 'string' || ctx.cwd.length === 0) {
    throw new Error('predicate context requires a non-empty "cwd"');
  }
  const d = deps as PredicateDeps;
  if (!d || typeof d.runBoundedShell !== 'function') {
    throw new Error('predicate deps require a "runBoundedShell" function');
  }

  const pred = predicate as Record<string, unknown>;
  const kind = pred['kind'];
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new Error('predicate.kind must be a non-empty string');
  }
  if (kind === 'artifact-frontmatter-equals') {
    if (typeof d.findPhaseArtifact !== 'function') {
      throw new Error('predicate deps require a "findPhaseArtifact" function');
    }
    if (typeof d.readFrontmatter !== 'function') {
      throw new Error('predicate deps require a "readFrontmatter" function');
    }
  }

  const handler = KIND_TABLE[kind];
  if (!handler) {
    throw new Error(`Unknown predicate kind: "${kind}". Known kinds: ${EVALUATOR_KINDS.join(', ')}`);
  }
  return handler(pred, ctx, d);
}

export = {
  evaluatePredicate,
  evaluateCommandExitZero,
  interpolate,
  COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_OUTPUT_CHARS,
  COMMAND_MAX_LENGTH,
  EVALUATOR_KINDS,
  INTERPOLATION_VAR_NAMES,
};
