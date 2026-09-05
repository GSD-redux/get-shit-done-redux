/**
 * Reviewer Lane Invocation Module (ADR-2782 Phase 5b, #2799 — closes #2718).
 *
 * Turns a DECLARED lane (`review-lane-descriptor.cts`) plus resolved configuration into a concrete,
 * inspectable INVOCATION PLAN. Phase 1's module declares; this one resolves; `review-lane-runner`
 * executes. The split exists so the interesting half is pure: a plan is a value, so the twelve
 * shipped lanes can be asserted against a golden table without spawning anything.
 *
 * WHY A GOLDEN TABLE AND NOT A FRESH DESIGN (Gall's Law). The 640 lines of hand-authored bash this
 * replaces is the simple system that worked, and every leg encodes a hard-won fix — #2494 and #2605
 * (empty output), #1698 (Codex stdout teardown noise), #1936 (OpenCode zero-output turns), #2073
 * (Antigravity's three modes), #2176 (repo-root anchoring), #2589 (no jq on stock Windows), #2794
 * (Qwen's missing sidecar). A resolver designed from the descriptor TYPES would throw that away and
 * rebuild the bugs. So each lane's plan was derived from its leg, and `tests/review-lane-invocation`
 * asserts all twelve against a frozen table. Old and new cannot literally run in parallel, so that
 * table is the strangler-fig substitute — it is what makes this cutover safe rather than hopeful.
 *
 * PURE. No filesystem, no network, no subprocess, no clock. Configuration arrives through the
 * `configGet` seam so a test drives it with a plain object and production wires it to the real
 * resolved config. Every function here is total: a malformed lane yields an `unavailable` result,
 * never a throw — a resolver that throws on bad input cannot report on it, and this runs against
 * third-party overlay manifests (ADR-2782 D4).
 */

import type {
  EmptyOutputPolicy,
  EvidenceClass,
  LaneHandler,
  LaneProbe,
  ReviewerLane,
} from './review-lane-descriptor.cjs';
import { LANE_SLUG_RE } from './review-lane-descriptor.cjs';

/* ------------------------------------------------------------------ *
 * Unavailability — a frozen enum, because the reason is the product
 * ------------------------------------------------------------------ */

/**
 * Why a lane will not run.
 *
 * Frozen and exhaustive because the bash it replaces had exactly one outcome for every failure —
 * an empty file — and that ambiguity IS the defect class this epic exists to close (#2494/#2605: a
 * failed lane was indistinguishable from a reviewer that ran cleanly with nothing to report). The
 * caller renders these; tests assert on them. Never assert on the rendered prose.
 *
 * Adding a member is three coordinated changes: this enum, the emitting site, and the test locking
 * `Object.keys(...).sort()`.
 */
export const LANE_UNAVAILABLE = Object.freeze({
  MALFORMED_LANE: 'malformed_lane',
  UNKNOWN_HANDLER: 'unknown_handler',
  UNKNOWN_TRANSPORT: 'unknown_transport',
  MISSING_BINARY: 'missing_binary',
  MISSING_REQUIRED_BINARY: 'missing_required_binary',
  PROBE_FAILED: 'probe_failed',
  PROBE_TIMEOUT: 'probe_timeout',
  HOST_UNREACHABLE: 'host_unreachable',
  EGRESS_HOST_CHANGED: 'egress_host_changed',
  BUDGET_TOO_SMALL: 'budget_too_small',
  BUDGET_TOOL_FAILED: 'budget_tool_failed',
} as const);

export type LaneUnavailableReason =
  (typeof LANE_UNAVAILABLE)[keyof typeof LANE_UNAVAILABLE];

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

/** Where a spawned lane's review actually lands. */
export type OutputTarget =
  | { kind: 'stdout' }
  /** Codex: the tool writes the review itself and stdout is discarded (#1698). */
  | { kind: 'file'; path: string };

export interface SpawnPlan {
  transport: 'spawn';
  slug: string;
  binary: string;
  /** Fully resolved argv — model, effort and prompt already folded in, in leg order. */
  argv: string[];
  /**
   * The configured model that was ACTUALLY APPLIED to this invocation, or `null` (#2295).
   *
   * Not merely "what `review.models.<slug>` says". A lane can declare a `modelConfigKey` and no
   * `modelArg` — a shape a third-party overlay body can reach — and then the configured value
   * never enters argv and the CLI reviews under its own default. Recording the config value in
   * that case would attribute the review to a model that never ran, which is the inverse of the
   * failure #2295 exists to end. So this mirrors the argv expansion: set only when `{{model}}`
   * really expanded to something.
   */
  model: string | null;
  /**
   * The reasoning effort GSD ACTUALLY APPLIED to this invocation, or `null` (#2295).
   *
   * Shares the same applied-not-merely-configured rule `model` above documents. A lane whose
   * `effortChannel` is not `argv` receives no effort argument at all — the placeholder's
   * expansion is structurally empty for that lane — and recording an effort level in that case
   * would attribute the review to a setting that never reached the tool. So this is set only
   * when the effort argv really expanded into this invocation's argv.
   */
  effort: string | null;
  /** Prompt delivered on stdin, or `null` for `argv`/`argv-file-ref`/`none` lanes. */
  stdin: string | null;
  /**
   * The assembled prompt file, regardless of how (or whether) this lane consumes it. Carried even
   * for `promptChannel: 'none'` so a handler never has to re-derive the path from another field.
   */
  promptPath: string;
  outputTarget: OutputTarget;
  /** Canonical review path: `<runDir>/gsd-review-<slug>.md`. */
  reviewPath: string;
  /** stderr sidecar — never `/dev/null` (#2494). */
  errPath: string;
  timeoutMs: number;
  emptyOutput: EmptyOutputPolicy;
  /**
   * The lane's declared evidence class, carried onto the plan so the runner can VERIFY the
   * declaration against the review's actual output (#3194): a `source-grounded` lane whose
   * review cites no `file:line` evidence is stamped and down-weighted in the Consensus
   * Summary, while `diff-only` lanes are exempt (their verdict is already folded in as a
   * diff observation).
   *
   * NORMALIZED, not trusted: this module is the overlay-manifest trust boundary and a
   * third-party body can declare any value. Anything that is not exactly `'diff-only'`
   * resolves as `'source-grounded'` — the fail-toward-verification direction, since the
   * only behavioral consequence is whether the lane's OWN review gets down-weighted.
   */
  evidenceClass: EvidenceClass;
  handler: LaneHandler;
  requiresBinaries: readonly string[];
  probe: LaneProbe;
  /**
   * Per-invocation environment pairs merged over the inherited environment at spawn, or `null`
   * when the lane declares none (#2483). Only string-valued own entries survive resolution — a
   * non-string value is dropped, not coerced, for the same reason model values are not (below).
   */
  env: Readonly<Record<string, string>> | null;
}

export interface HttpPlan {
  transport: 'openai-http';
  slug: string;
  /** Resolved base URL, normalized (no trailing slash). */
  host: string;
  hostConfigKey: string;
  /** `host` + the declared path. */
  url: string;
  /** Models endpoint for discovery, when `modelDiscovery` asks for it. */
  modelsUrl: string | null;
  /** Configured model, or `null` when discovery should run. */
  model: string | null;
  fallbackModel: string;
  promptPath: string;
  reviewPath: string;
  errPath: string;
  timeoutMs: number;
  emptyOutput: EmptyOutputPolicy;
  /** Declared evidence class, carried for run-time verification — see `SpawnPlan`. */
  evidenceClass: EvidenceClass;
  handler: LaneHandler;
  requiresBinaries: readonly string[];
  probe: LaneProbe;
}

export type LanePlan = SpawnPlan | HttpPlan;

export type ResolveResult =
  | { ok: true; plan: LanePlan; warnings: string[] }
  | { ok: false; reason: LaneUnavailableReason; detail: string; warnings: string[] };

/** Every handler name the runner can dispatch. Mirrors `LaneHandler` (D6's closed enum). */
const KNOWN_HANDLERS: ReadonlySet<string> = new Set(['antigravity', 'openai-compatible', 'opencode']);

export interface ResolveInput {
  lane: ReviewerLane;
  /** Resolved config lookup. Returns `undefined` for an absent key. */
  configGet: (key: string) => unknown;
  /** The run-scoped temp dir (`{run_dir}` in the workflow). */
  runDir: string;
  /** Absolute repo root, for `argv-file-ref` anchoring (#2176). */
  repoRoot: string;
  /** Effort argv for lanes whose `effortChannel` is `argv`; empty when the host declares none. */
  effortArgs?: readonly string[];
  /**
   * The bare reasoning-effort level (`'low'`) GSD resolved for this lane's host, or `undefined`
   * (#2295). The per-host ARGV RENDERING of this same level arrives separately in `effortArgs` —
   * `'low'` renders as `--effort low` for one host and `-c model_reasoning_effort=low` for
   * another, and the runner needs the bare level (for the recorded model suffix) independently
   * of whichever rendering actually reached argv.
   */
  effortValue?: string;
}

/* ------------------------------------------------------------------ *
 * Value normalization — the stringly-typed edges the bash lived with
 * ------------------------------------------------------------------ */

/**
 * A configured string value, or `null` when effectively unset.
 *
 * Four shapes all mean "not configured", and the bash had to handle three of them by hand:
 *   - absent / `null` / `undefined`;
 *   - `""` — the declared default of every federated `review.models.*` key;
 *   - `"null"` — the LITERAL four characters `config-get --raw` prints for a missing key, which
 *     every leg tested for (`[ "$X" != "null" ]`). Reading config in-process removes the source of
 *     this, but a `.planning/config.json` written by an older workflow can still contain it;
 *   - whitespace-only — never a meaningful model name or host.
 *
 * A non-string (number, bool, object, array) is NOT coerced. `String(0)` would put `"0"` into argv
 * as a model name; a wrong model silently reviewed is worse than no model override.
 *
 * Exported and shared with the runner's model-recovery arms (#2295) — "what counts as unset" has
 * ONE source, so the plan resolver and the runner's recovered-model normalization cannot disagree.
 */
export function configString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
  return trimmed;
}

/**
 * Normalize a base URL for storage and for the D5 consent comparison.
 *
 * Trailing slash, case in the scheme/host, and an explicit default port are all the same
 * destination. Without normalizing, a cosmetic `.planning/config.json` edit — adding a trailing
 * slash — would read as "the egress destination changed" and block the lane, training the user to
 * dismiss the one warning that matters.
 *
 * Returns the input trimmed when it is not parseable as a URL: an unparseable host is compared
 * verbatim rather than silently rewritten.
 */
export function normalizeHost(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
  // `new URL('localhost:11434')` PARSES — protocol `localhost:`, empty hostname — so a plausible
  // but scheme-less config value would otherwise be rewritten to `localhost://11434` and compared
  // (and requested) as though it were a real destination. No hostname means this is not a URL;
  // return it verbatim so it fails visibly rather than silently becoming something else.
  if (!u.hostname) return trimmed.replace(/\/+$/, '');
  const scheme = u.protocol.toLowerCase();
  const isDefaultPort =
    (scheme === 'http:' && u.port === '80') || (scheme === 'https:' && u.port === '443');
  const port = isDefaultPort ? '' : u.port;
  const host = u.hostname.toLowerCase();
  const pathPart = u.pathname.replace(/\/+$/, '');
  return `${scheme}//${host}${port ? `:${port}` : ''}${pathPart}`;
}

/**
 * Resolve a lane's outer wall-clock timeout in milliseconds (#3274).
 *
 * `timeoutConfigKey` resolves in SECONDS — the user-facing convention this repo already uses for
 * timeout-shaped config keys (`workflow.cross_ai_timeout`, `graphify.build_timeout`), distinct from
 * the internal millisecond unit `timeoutFloorMs` carries. Anything that is not a positive finite
 * number is treated as unset and falls back to `floorMs`, never coerced: a wrong-typed config value
 * silently becoming a wrong-but-plausible timeout is worse than falling back cleanly. `0` and
 * negative values are deliberately treated as unset too — a timeout has no legitimate zero or
 * negative value, so no second sentinel (unlike the prompt-budget keys, which use -1) is needed.
 */
/**
 * The reasoning effort a reviewer lane runs at, and its host-rendered argv (#4255).
 *
 * `argv` is spliced into `{{effort}}`; `value` is the bare level the runner folds into the
 * recorded model designation (`gpt-5.6-sol (reasoning=high)`, #2295). Both are empty/null when
 * this lane emits no effort argument, which is a real and correct outcome — see `resolveLaneEffort`.
 */
export interface LaneEffort {
  argv: readonly string[];
  value: string | null;
  /** Where `value` came from, for diagnostics: the config key, the lane default, or nothing. */
  source: 'config' | 'lane-default' | 'none';
}

/** Levels GSD's effort axis accepts (#3533). `inherit` selects the no-argument path. */
const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'inherit',
]);

/**
 * Resolve one lane's reasoning effort from REVIEW configuration (#4255).
 *
 * Resolution order, highest first:
 *   1. `lane.effortConfigKey` — the per-lane review effort the operator set
 *   2. `lane.defaultEffort` — the lane's declared review default (`high` for prompt-fed,
 *      source-grounded lanes)
 *   3. nothing — no effort argument is emitted and the reviewer CLI's own configuration decides
 *
 * A configured `'inherit'` selects (3) explicitly. An unrecognized level is REFUSED rather than
 * passed to the host: it falls back to the lane default, because forwarding a typo would render an
 * argument the CLI rejects and kill the lane outright.
 *
 * What this function deliberately does NOT do is consult any agent's execution settings. Before
 * #4255 the level came from `gsd-plan-checker`'s installed frontmatter through a hardcoded agent
 * id, so every lane ran at a fast structural verifier's `low` — and, because the rendered argument
 * is a CLI config override, it silently beat the effort the operator had configured for that CLI
 * itself. A value inherited from an unrelated agent is worse than no value at all, which is why
 * (3) emits nothing rather than falling back to some other agent's number.
 *
 * `renderArgv` is injected (the host table and the ADR-2481 surface negotiation live in
 * `model-catalog` / `commands`, above this module's layer) so this stays a pure function of its
 * inputs and the golden lane table can assert it without a spawn.
 */
export function resolveLaneEffort(
  lane: ReviewerLane,
  configGet: (key: string) => unknown,
  renderArgv: (host: string, level: string) => { argv: readonly string[]; value: string | null },
): LaneEffort {
  const none: LaneEffort = { argv: [], value: null, source: 'none' };
  if (!lane || typeof lane !== 'object') return none;
  const configured = lane.effortConfigKey ? configString(configGet(lane.effortConfigKey)) : null;
  const valid = configured !== null && EFFORT_LEVELS.has(configured) ? configured : null;
  const level = valid ?? configString(lane.defaultEffort);
  if (level === null || level === 'inherit') return none;
  const rendered = renderArgv(lane.slug, level);
  const argv = (rendered.argv ?? []).filter((a): a is string => typeof a === 'string' && a !== '');
  if (argv.length === 0) return none;
  return {
    argv,
    value: configString(rendered.value) ?? level,
    source: valid !== null ? 'config' : 'lane-default',
  };
}

export function resolveTimeoutMs(
  timeoutConfigKey: string | null | undefined,
  floorMs: number,
  configGet: (key: string) => unknown,
): number {
  const configuredSeconds = typeof timeoutConfigKey === 'string' ? configGet(timeoutConfigKey) : undefined;
  return typeof configuredSeconds === 'number' && Number.isFinite(configuredSeconds) && configuredSeconds > 0
    ? configuredSeconds * 1000
    : floorMs;
}

/** Buffer (seconds) a lane's native inner timeout sits under its resolved outer wall-clock cap
 * (#3274). Matches the shipped 600s outer / 540s native relationship exactly when unconfigured:
 * floor(600000/1000) - 60 = 540. */
const NATIVE_TIMEOUT_BUFFER_SECONDS = 60;

/**
 * Render the `{{nativeTimeout}}` argv placeholder from a lane's resolved outer timeout (#3274).
 *
 * Clamped to a 1-second floor so a very small configured (or, today, only-ever-default) outer
 * timeout never produces a zero or negative duration string a CLI would reject or misinterpret.
 */
export function nativeTimeoutToken(timeoutMs: number): string {
  const seconds = Math.max(1, Math.floor(timeoutMs / 1000) - NATIVE_TIMEOUT_BUFFER_SECONDS);
  return `${seconds}s`;
}

/**
 * Classify a lane's output as a review or as empty.
 *
 * WHITESPACE-ONLY COUNTS AS EMPTY, for every lane. The bash tested `[ ! -s file ]`, which counts
 * BYTES — so a reply of three spaces passed as a successful review. Two legs (LM Studio,
 * llama.cpp) closed this locally with a case-glob; gemini, claude, codex, qwen and cursor did not.
 * Making it uniform is a deliberate, disclosed behavior change (a bug fix that breaks a workaround)
 * and is why this phase ships a changeset note.
 *
 * The `-n` / `-e` / `-E` hazard the two printf-using legs guarded against cannot occur here at all:
 * nothing in this path goes through `echo`.
 */
export function isEmptyReview(text: unknown): boolean {
  if (typeof text !== 'string') return true;
  return text.trim().length === 0;
}

/**
 * The standard `argv-file-ref` prompt (#2176).
 *
 * Two lanes take the prompt as an ARGUMENT rather than on stdin, and a full plan set inline would
 * approach the 32,767-character Windows `execFileSync` ceiling — so the argument is a short
 * instruction naming the prompt file. It must also carry the ABSOLUTE repo root: an argv-fed CLI
 * does not reliably inherit the review's working directory, and without the anchor the reviewer
 * reviews the plan text in isolation, which is exactly what the Review Instructions forbid.
 *
 * `antigravity` deliberately does NOT use this text — its handler owns a variant that additionally
 * demands a `REVIEWED-WITHOUT-REPO-ACCESS` self-report.
 */
export function fileRefPrompt(promptPath: string, repoRoot: string): string {
  return (
    `Read the file at ${promptPath} in full and carry out the review request it contains. ` +
    `The repository under review is at ${repoRoot} — resolve every relative file path in the ` +
    `review request against that absolute root. Output only the resulting markdown review. ` +
    `Do not edit any files.`
  );
}

/** Run-dir artifact paths. POSIX-joined: these are workflow-visible strings, not OS paths. */
export function artifactPaths(runDir: string, slug: string): {
  promptPath: string;
  reviewPath: string;
  errPath: string;
} {
  const base = String(runDir ?? '').replace(/\/+$/, '');
  return {
    promptPath: `${base}/gsd-review-prompt.md`,
    reviewPath: `${base}/gsd-review-${slug}.md`,
    errPath: `${base}/gsd-review-${slug}.err`,
  };
}

/**
 * Per-lane prompt budget (#2797 semantics, preserved exactly).
 *
 * `-1` is the UNSET sentinel and falls back to the central `review.max_prompt_tokens`, because
 * `0` is a legitimate value meaning "do not trim this lane". Treating 0 as unset would silently
 * switch a user who deliberately disabled trimming onto the global budget.
 *
 * Single source of truth: `gsd-core/bin/gsd-tools.cjs`'s `review-lane plan`/`invoke` and
 * `src/reviewer-step-dispatch.cts`'s `dispatchReviewerLanes` both resolve a lane's budget through
 * this function rather than each carrying their own copy (#4209 R3 — two verbatim copies drift).
 */
export function resolveLaneBudget(lane: ReviewerLane, configGet: (key: string) => unknown): number | null {
  if (!lane.promptBudgetKey) return null;
  const per = configGet(lane.promptBudgetKey);
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (isNum(per) && per !== -1) return per;
  const global = configGet('review.max_prompt_tokens');
  return isNum(global) ? global : null;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/**
 * Resolve one declared lane into an executable plan.
 *
 * TOTAL: never throws. Every rejection is a typed `LaneUnavailableReason`, because the caller has to
 * tell three different unavailabilities apart — a lane that is absent, a lane whose probe failed,
 * and a lane blocked on a changed egress destination are not the same event to a user.
 *
 * NOT resolved here: probe execution, prompt-budget trimming, and the D5 egress-host comparison.
 * Those need I/O and live in the runner. This function decides SHAPE.
 */
export function resolveLanePlan(input: ResolveInput): ResolveResult {
  const warnings: string[] = [];
  const fail = (reason: LaneUnavailableReason, detail: string): ResolveResult => ({
    ok: false,
    reason,
    detail,
    warnings,
  });

  // Trust boundary: the declared type says ReviewerLane, but overlay manifests arrive here.
  const raw = input?.lane as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(LANE_UNAVAILABLE.MALFORMED_LANE, `lane is not an object: ${String(raw)}`);
  }
  const lane = raw as ReviewerLane;
  const slug = typeof lane.slug === 'string' ? lane.slug.trim() : '';
  if (!slug) {
    return fail(LANE_UNAVAILABLE.MALFORMED_LANE, 'lane declares no slug');
  }
  // The slug is CONCATENATED into artifact paths below, so the grammar is enforced here rather
  // than trusted from upstream. `checkReviewerLaneParity` and the capability validator both check
  // it too, but neither runs on this path — and this module's whole premise is that it is the
  // trust boundary for third-party overlay manifests. A slug of `../../../tmp/evil` would
  // otherwise produce a reviewPath outside the run dir that `writeReviewOrStub` happily writes to.
  if (!LANE_SLUG_RE.test(slug)) {
    return fail(
      LANE_UNAVAILABLE.MALFORMED_LANE,
      `lane slug '${slug}' is outside the declared grammar ${String(LANE_SLUG_RE)}`,
    );
  }

  // D4 rule 4: an unknown handler FAILS CLOSED. A lane naming imperative code this GSD version does
  // not have cannot be run "mostly" — the handler is precisely the part data could not express.
  const handler: LaneHandler = lane.handler ?? null;
  if (handler !== null && !KNOWN_HANDLERS.has(handler)) {
    return fail(
      LANE_UNAVAILABLE.UNKNOWN_HANDLER,
      `lane '${slug}' names handler '${String(handler)}', which this GSD version does not provide`,
    );
  }

  const { promptPath, reviewPath, errPath } = artifactPaths(input.runDir, slug);
  const floorMs =
    typeof lane.timeoutFloorMs === 'number' && Number.isFinite(lane.timeoutFloorMs) && lane.timeoutFloorMs > 0
      ? lane.timeoutFloorMs
      : 900_000;
  const timeoutMs = resolveTimeoutMs(lane.timeoutConfigKey, floorMs, input.configGet);
  const emptyOutput: EmptyOutputPolicy = lane.emptyOutput === 'handler-owned' ? 'handler-owned' : 'stub-with-stderr';
  // #3194: only an EXACT 'diff-only' declaration exempts a lane from evidence verification.
  // Anything else — including a missing or garbage value on a third-party overlay body —
  // resolves as 'source-grounded', so the runner verifies rather than trusts it.
  const evidenceClass: EvidenceClass = lane.evidenceClass === 'diff-only' ? 'diff-only' : 'source-grounded';
  const requiresBinaries = Array.isArray(lane.requiresBinaries)
    ? lane.requiresBinaries.filter((b): b is string => typeof b === 'string')
    : [];

  const model = configString(
    typeof lane.modelConfigKey === 'string' ? input.configGet(lane.modelConfigKey) : undefined,
  );

  if (lane.transport === 'openai-http') {
    const rawInvoke: unknown = lane.invoke;
    // The spawn branch below guards with `inv?.binary`; this one must too. Without it a lane
    // declaring `transport: 'openai-http'` and no `invoke` THROWS, which breaks this module's
    // documented totality — and a throw here is worse than it looks: the CLI seam resolves every
    // selected lane in one `.map`, so one malformed overlay manifest would abort the whole review
    // rather than dropping its own lane.
    if (rawInvoke === null || typeof rawInvoke !== 'object' || Array.isArray(rawInvoke)) {
      return fail(
        LANE_UNAVAILABLE.MALFORMED_LANE,
        `openai-http lane '${slug}' declares no invoke object`,
      );
    }
    const inv = rawInvoke as {
      hostConfigKey?: unknown;
      defaultHost?: unknown;
      path?: unknown;
      fallbackModel?: unknown;
      modelDiscovery?: unknown;
    };
    const hostConfigKey = typeof inv.hostConfigKey === 'string' ? inv.hostConfigKey : '';
    const configured = hostConfigKey ? configString(input.configGet(hostConfigKey)) : null;
    // Only a STRING declares a host. Coercing an object would produce the literal
    // '[object Object]' and normalize THAT as the lane's egress destination.
    const declaredDefault = typeof inv.defaultHost === 'string' ? inv.defaultHost : '';
    const host = normalizeHost(configured ?? declaredDefault);
    if (!host) {
      return fail(
        LANE_UNAVAILABLE.MALFORMED_LANE,
        `lane '${slug}' resolves no host: '${hostConfigKey}' is unset and it declares no defaultHost`,
      );
    }
    const apiPath = typeof inv.path === 'string' && inv.path ? inv.path : '/v1/chat/completions';
    const discovers = inv.modelDiscovery === 'first-from-models-endpoint';
    return {
      ok: true,
      warnings,
      plan: {
        transport: 'openai-http',
        slug,
        host,
        hostConfigKey,
        url: `${host}${apiPath}`,
        modelsUrl: discovers ? `${host}/v1/models` : null,
        model,
        fallbackModel: typeof inv.fallbackModel === 'string' ? inv.fallbackModel : 'local-model',
        promptPath,
        reviewPath,
        errPath,
        timeoutMs,
        emptyOutput,
        evidenceClass,
        handler,
        requiresBinaries,
        probe: lane.probe,
      },
    };
  }

  if (lane.transport !== 'spawn') {
    return fail(
      LANE_UNAVAILABLE.UNKNOWN_TRANSPORT,
      `lane '${slug}' declares transport '${String((lane as { transport?: unknown }).transport)}'`,
    );
  }

  const inv = lane.invoke;
  const binary = typeof inv?.binary === 'string' ? inv.binary.trim() : '';
  if (!binary) {
    return fail(LANE_UNAVAILABLE.MALFORMED_LANE, `spawn lane '${slug}' declares no binary`);
  }

  // Output target first: `{{output}}` needs to know the path, and the target is also what tells the
  // runner whether to capture stdout or read a file the tool wrote itself (#1698).
  let outputTarget: OutputTarget = { kind: 'stdout' };
  let outputExpansion: string[] = [];
  if (inv.outputChannel === 'file-arg') {
    const outputArg = typeof inv.outputArg === 'string' ? inv.outputArg : '';
    if (!outputArg) {
      return fail(
        LANE_UNAVAILABLE.MALFORMED_LANE,
        `lane '${slug}' declares outputChannel 'file-arg' with no outputArg naming the argument`,
      );
    }
    outputExpansion = [outputArg, reviewPath];
    outputTarget = { kind: 'file', path: reviewPath };
  }

  let stdin: string | null = null;
  let promptExpansion: string[] = [];
  switch (inv.promptChannel) {
    case 'stdin':
      stdin = promptPath; // the runner streams this file; the plan names it.
      break;
    case 'argv-file-ref':
      promptExpansion = [fileRefPrompt(promptPath, input.repoRoot)];
      break;
    case 'argv':
      promptExpansion = [promptPath];
      break;
    case 'none':
      break; // CodeRabbit reviews the working tree and is fed nothing (review.md:367).
    default:
      return fail(
        LANE_UNAVAILABLE.MALFORMED_LANE,
        `lane '${slug}' declares promptChannel '${String(inv.promptChannel)}'`,
      );
  }

  const modelExpansion =
    model && typeof inv.modelArg === 'string' && inv.modelArg ? [inv.modelArg, model] : [];
  const effortExpansion =
    inv.effortChannel === 'argv'
      ? (input.effortArgs ?? []).filter((a): a is string => typeof a === 'string' && a !== '')
      : [];

  // Expand the argv template in declared order. A placeholder with nothing to contribute expands to
  // ZERO elements and disappears — that is what lets one template serve both the configured and the
  // unconfigured case without a conditional in the data.
  const expansions: Record<string, string[]> = {
    '{{model}}': modelExpansion,
    '{{effort}}': effortExpansion,
    '{{output}}': outputExpansion,
    '{{prompt}}': promptExpansion,
    '{{nativeTimeout}}': [nativeTimeoutToken(timeoutMs)],
  };
  const template = Array.isArray(inv.args)
    ? inv.args.filter((a): a is string => typeof a === 'string')
    : [];
  const argv: string[] = [];
  for (const token of template) {
    // Own-property lookup: a lane could declare a literal `constructor` argument, and prototype
    // members must never resolve as expansions.
    if (Object.prototype.hasOwnProperty.call(expansions, token)) {
      argv.push(...expansions[token]);
    } else {
      argv.push(token);
    }
  }

  // Per-invocation env pairs (#2483). Own string-valued entries only — a non-string is dropped,
  // never coerced, and prototype members never resolve (same lookup discipline as the argv
  // expansions above). An empty or absent declaration resolves to `null`, so the runner has one
  // shape to test.
  let env: Record<string, string> | null = null;
  const declaredEnv: unknown = inv.env;
  if (declaredEnv !== null && typeof declaredEnv === 'object' && !Array.isArray(declaredEnv)) {
    const source = declaredEnv as Record<string, unknown>;
    const pairs: Record<string, string> = {};
    for (const k of Object.keys(source)) {
      const v = source[k];
      if (typeof v === 'string') pairs[k] = v;
    }
    if (Object.keys(pairs).length > 0) env = pairs;
  }

  return {
    ok: true,
    warnings,
    plan: {
      transport: 'spawn',
      slug,
      binary,
      argv,
      model: modelExpansion.length > 0 ? model : null,
      effort: effortExpansion.length > 0 ? (configString(input.effortValue) ?? null) : null,
      stdin,
      promptPath,
      outputTarget,
      reviewPath,
      errPath,
      timeoutMs,
      emptyOutput,
      evidenceClass,
      handler,
      requiresBinaries,
      probe: lane.probe,
      env,
    },
  };
}
