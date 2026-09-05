/**
 * Reviewer Lane Runner (ADR-2782 Phase 5b, #2799).
 *
 * Executes an invocation plan from `review-lane-invocation.cts`: probes the lane, spawns the binary
 * or calls the HTTP endpoint, applies the empty-output policy, and dispatches the three first-party
 * handlers D6 names. This is the module that replaces ~640 lines of hand-authored per-CLI bash.
 *
 * THREE RUNTIME DEPENDENCIES DISAPPEAR HERE, and that is a correctness win rather than a tidy-up:
 *   - `jq` — five legs needed it on PATH; it is absent on stock Windows/Git-Bash (#2589). Parsing is
 *     `JSON.parse` now.
 *   - `curl` — the three OpenAI-compatible legs shelled out to it. Node's `fetch` replaces it, and
 *     the raw response body (where an OpenAI-compatible server puts its error JSON on a 4xx/5xx
 *     while curl still exits 0) is no longer discarded by a pipe.
 *   - external `timeout` / `gtimeout` — the Antigravity leg probed for one because
 *     `--print-timeout` cannot fire before a session exists, and STOCK MACOS SHIPS NEITHER, so on a
 *     stock Mac that leg ran unbounded. `spawnSync`'s native `timeout` is always available, so D7's
 *     "skip the probe where no bounding mechanism exists" carve-out is no longer needed.
 *
 * EVERY subprocess call in this file passes `timeout` + `killSignal` + `maxBuffer`. This repo has a
 * named `DEFECT.UNBOUNDED-SUBPROCESS` class (`CONTEXT.md:772`) and an unbounded sync spawn is not a
 * slow test, it is a hung one: `--test-force-exit` cannot interrupt a synchronous call, so a frozen
 * spawn hangs the whole CI chunk to its 10-minute kill with `# fail 0` and no `not ok` (#2099).
 *
 * TOTAL. No function here throws for a lane-level failure; every one returns a typed outcome. A
 * reviewer lane that cannot run must produce a diagnosable artifact, because the ambiguity between
 * "failed" and "ran cleanly with nothing to report" IS the defect this epic closes (#2494/#2605).
 */

import type { LanePlan, SpawnPlan, HttpPlan, LaneUnavailableReason } from './review-lane-invocation.cjs';
import {
  LANE_UNAVAILABLE,
  isEmptyReview,
  normalizeHost,
  fileRefPrompt as fileRefPromptText,
  configString,
} from './review-lane-invocation.cjs';

/* ------------------------------------------------------------------ *
 * Injected seams
 * ------------------------------------------------------------------ */

export interface SpawnOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Node sets this to ETIMEDOUT when `timeout` fired. */
  errorCode?: string;
}

export interface RunnerDeps {
  /**
   * Bounded synchronous spawn. Production wires `child_process.spawnSync`.
   * `env` pairs are merged OVER the inherited environment for this one child (#2483) — an absent
   * `env` inherits unchanged, and the parent process environment is never mutated either way.
   */
  spawn: (binary: string, argv: string[], opts: { input?: string; timeoutMs: number; env?: Readonly<Record<string, string>> }) => SpawnOutcome;
  /** Bounded HTTP POST/GET returning the RAW body — never pre-parsed, so errors stay diagnosable. */
  httpJson: (url: string, opts: { method: 'GET' | 'POST'; body?: string; timeoutMs: number }) =>
    Promise<{ ok: boolean; status: number; body: string; error?: string }>;
  readFile: (p: string) => string;
  writeFile: (p: string, content: string) => void;
  exists: (p: string) => boolean;
  /** `command -v` equivalent. */
  hasBinary: (name: string) => boolean;
  /** Resolved config lookup, for the egress-host re-verification. */
  configGet: (key: string) => unknown;
  /** Home dir, for the Antigravity transcript paths. */
  homeDir: string;
  warn: (msg: string) => void;
}

export interface LaneRunResult {
  slug: string;
  ok: boolean;
  /** Present when `ok` is false. */
  reason?: LaneUnavailableReason;
  detail?: string;
  /** True when a diagnostic stub was written instead of a real review. */
  stubbed: boolean;
  /** The model this lane actually ran under, and how that was determined (#2295). */
  model: ResolvedModel;
}

/* ------------------------------------------------------------------ *
 * #2295 — the resolved model
 * ------------------------------------------------------------------ */

/**
 * How a lane's resolved model was recovered. FROZEN — adding a member is three coordinated
 * changes (enum + emitting site + the test locking `Object.keys(MODEL_SOURCE).sort()`), the same
 * discipline `PARITY_VIOLATION` and `LANE_UNAVAILABLE` already carry.
 *
 * The source travels with the value on purpose. Postel's robustness principle is usually quoted
 * as "be liberal in what you accept", but its modern caveat is the load-bearing half here:
 * liberal must not mean GUESS SILENTLY. Two of these arms parse third-party text this project
 * does not own — a CLI's startup banner and an undocumented on-disk session log — so a bare
 * model string would be an unattributable claim. Recording HOW it was recovered lets a reader
 * weigh `pinned` (certain) against `banner` (heuristic) without leaving the file.
 */
export const MODEL_SOURCE = Object.freeze({
  /** `review.models.<slug>`, or an ADR-1517 instance `--model`, that really reached the invocation. */
  PINNED: 'pinned',
  /** An OpenAI-compatible server echoed the model it actually ran. The most authoritative arm. */
  SERVED: 'served',
  /** openai-http: discovered from `/v1/models`, or the declared `fallbackModel`; the server did not echo one. */
  REQUESTED: 'requested',
  /** The CLI's own startup banner named it. File-output lanes only — see `resolveSpawnModel`. */
  BANNER: 'banner',
  /** The lane handler's own on-disk session log named it (`agy`'s `transcript_full.jsonl`). */
  TRANSCRIPT: 'transcript',
  /** Nothing recoverable. An explicit non-answer, never an omitted field. */
  UNKNOWN: 'unknown',
} as const);

export type ModelSource = (typeof MODEL_SOURCE)[keyof typeof MODEL_SOURCE];

export interface ResolvedModel {
  /** The model name, or `null` — and `null` IF AND ONLY IF `source` is `unknown`. */
  value: string | null;
  source: ModelSource;
}

/** The one shape every unresolvable case returns, so callers never hand-build it inconsistently. */
export const UNRESOLVED_MODEL: ResolvedModel = Object.freeze({ value: null, source: MODEL_SOURCE.UNKNOWN });

/**
 * How far into captured output a startup banner may appear, in lines. A banner is by definition
 * the FIRST thing a CLI prints; scanning further only raises the odds of matching something that
 * is not one.
 */
export const BANNER_SCAN_LINES = 40;

/** Longest plausible model identifier. Anything past this is not a model name, it is a payload. */
export const MODEL_VALUE_MAX = 200;

/**
 * C0 controls (0x00-0x1F), DEL (0x7F) and C1 controls (0x80-0x9F). A model identifier never
 * legitimately contains one, and a newline in particular is the frontmatter-injection vector
 * this guards against — a recorded model value is written verbatim into REVIEWS.md YAML
 * frontmatter, so a value carrying `\n` could forge arbitrary sibling keys. Deliberately does
 * NOT include `:` — `llama3:70b` and `qwen2.5:7b` are legitimate model ids.
 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * A recovered model value, or `null`. Shares `configString`'s unset-shape rule, length-caps it,
 * then REJECTS (never strips or escapes) a value carrying a control character — see
 * `CONTROL_CHAR_RE`. Rejecting rather than sanitizing means an anomalous value is recorded as
 * `unknown` rather than silently rewritten into something that merely looks safe.
 */
function normalizeModelValue(raw: unknown): string | null {
  const value = configString(raw);
  if (value === null) return null;
  if (value.length > MODEL_VALUE_MAX) return null;
  return CONTROL_CHAR_RE.test(value) ? null : value;
}

/**
 * The one place a `ResolvedModel` is built. Normalizing here rather than per-arm is what makes
 * the `value !== null` ⟺ `source !== 'unknown'` invariant structural instead of a convention
 * five call sites have to remember — and it is the single choke point where a hostile value is
 * refused before it can reach the REVIEWS.md frontmatter a lane's result is rendered into.
 */
function recordedModel(raw: unknown, source: ModelSource): ResolvedModel {
  const value = normalizeModelValue(raw);
  return value === null ? UNRESOLVED_MODEL : { value, source };
}

/**
 * The reasoning effort GSD applied to this invocation, folded into the recorded value (#2295).
 *
 * The issue asks for `gpt-5.6-sol (reasoning=high)`, and the Antigravity lane already reports its
 * own tier the same way (`Gemini 3.5 Flash (Medium)`) — so effort belongs in the model designation
 * a human compares, not in a separate field they would have to join by hand.
 *
 * The source is GSD's OWN resolved execution policy, not the CLI's config or banner, so this arm
 * is certain in a way the banner and transcript arms are not. `MODEL_VALUE_MAX` bounds the model
 * id the suffix is appended to; the suffix itself is GSD-owned and bounded, so it is deliberately
 * outside that cap rather than able to push a legitimate id over it.
 */
function withEffort(resolved: ResolvedModel, effort: string | null): ResolvedModel {
  if (resolved.value === null) return resolved;
  const normalized = normalizeModelValue(effort);
  if (normalized === null) return resolved;
  return { value: `${resolved.value} (reasoning=${normalized})`, source: resolved.source };
}

/** A line that IS a `model:` declaration — leading banner chrome allowed, trailing prose not. */
const BANNER_LINE_RE = /^[\s>*|-]*model\s*:\s*(.+)$/i;

/**
 * The model a CLI named in its own startup banner, or `null` (#2295).
 *
 * TOTAL: never throws, for any string. Deliberately dull — a bounded line window and one anchored
 * regex — because this is the cleverest code in the change and Kernighan's Law says debugging is
 * twice as hard as writing.
 *
 * AMBIGUITY IS NOT RESOLVED, IT IS REFUSED. Two DIFFERENT candidate values in the window means we
 * cannot tell which one ran, and picking the first would attribute a review to a model on a coin
 * flip. Repetition of one identical value is not ambiguity and is accepted.
 */
export function parseModelBanner(text: string): string | null {
  const lines = String(text ?? '').split(/\r?\n/).slice(0, BANNER_SCAN_LINES);
  const found = new Set<string>();
  for (const line of lines) {
    const m = BANNER_LINE_RE.exec(line);
    if (!m) continue;
    const value = normalizeModelValue(m[1]);
    if (value !== null) found.add(value);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** An own, string-valued `model` key on a plain object — never a prototype member, never coerced. */
function ownModel(node: unknown): string | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const record = node as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'model')) return null;
  return normalizeModelValue(record.model);
}

/**
 * Key names the depth-2 wrapper scan below refuses to descend through, even though `JSON.parse`
 * gives each an ordinary OWN data property here (never the real `Object.prototype` accessor — see
 * `resolveConvId`'s `#3118` note on the same class of trap). The transcript is third-party JSON on
 * a trust boundary; an entry SHAPED like `{"constructor":{"model":"x"}}` must never resolve as
 * though "constructor" were a legitimate settings-wrapper key.
 */
const UNSAFE_WRAPPER_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The session model named by the LAST settings-shaped entry of a `transcript_full.jsonl`, or `null`.
 *
 * TOTAL: never throws, for any string. Every line is independently parsed, so one truncated or
 * garbage line cannot poison the file.
 *
 * SCOPE IS BOUNDED AT DEPTH TWO, AND THAT BOUND IS THE DESIGN. The transcript is an undocumented
 * third-party format; its settings entry may carry `model` at the top level or one level down
 * under a wrapper whose key name we cannot know without guessing. A depth is knowable; a key name
 * is not. A recursive search over attacker-adjacent JSON would be both unbounded and a licence to
 * match any `model`-ish key anywhere, so anything deeper degrades to `null` — which the maintainer
 * ruled an acceptable recorded value, unlike a wrong one.
 *
 * `typeof null === 'object'`, so the null guard in `ownModel` is explicit rather than implied —
 * the same trap `resolveConvId` documents at #3118.
 */
export function parseTranscriptModel(text: string): string | null {
  let latest: string | null = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // one bad line is not a bad file
    }
    const direct = ownModel(entry);
    if (direct !== null) {
      latest = direct;
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (UNSAFE_WRAPPER_KEYS.has(key)) continue;
      const nested = ownModel(record[key]);
      if (nested !== null) latest = nested;
    }
  }
  return latest;
}

/* ------------------------------------------------------------------ *
 * D5 rules 2–4 — the egress destination is re-verified at INVOCATION
 * ------------------------------------------------------------------ */

export interface EgressCheck {
  allowed: boolean;
  consentedHost?: string;
  currentHost?: string;
}

/**
 * Compare a lane's re-resolved egress destination against the one the user consented to.
 *
 * ADR-2782 D5 puts this on the invocation path deliberately. `hostConfigKey` names a key in
 * `.planning/config.json`, which is the ONE consent-bound value living outside the SHA-pinned
 * bundle: user- and CI-editable at any time, with no re-install and no integrity check. Without
 * this check a lane consented against `http://localhost:8080` could be silently redirected to a
 * remote host by an ordinary pull request touching a JSON file, and every subsequent review would
 * egress plans, requirements, research and decisions to the new destination with no re-prompt.
 *
 * ABSENCE IS NOT A MISMATCH, and this is the part that must not be "hardened" later by someone who
 * reads only the rule name:
 *   - No consent record at all ⇒ ALLOW. First-party lanes (`ollama`, `lm_studio`, `llama_cpp`) ship
 *     inside the SHA-pinned distribution and are never consent-gated, so blocking on a missing
 *     record would break every existing local-model user on upgrade.
 *   - A consent record predating this feature ⇒ ALLOW. Those records were written before a host was
 *     recorded; treating the absence as a change would force spurious re-consent across every
 *     installed capability, which ADR-2782 D4 rule 5 explicitly forbids.
 *
 * Hosts are compared NORMALIZED, so a trailing slash or an explicit `:80` is not a "destination
 * change". A warning that fires on cosmetic edits is a warning users learn to dismiss.
 */
export function checkEgressHost(consentedHost: unknown, currentHost: string): EgressCheck {
  const consented = typeof consentedHost === 'string' ? normalizeHost(consentedHost) : '';
  if (!consented) return { allowed: true };
  const current = normalizeHost(currentHost);
  if (consented === current) return { allowed: true, consentedHost: consented, currentHost: current };
  return { allowed: false, consentedHost: consented, currentHost: current };
}

/* ------------------------------------------------------------------ *
 * Probe (D7) — every probe bounded, and only for a SELECTED lane
 * ------------------------------------------------------------------ */

export async function probeLane(
  plan: LanePlan,
  deps: RunnerDeps,
): Promise<{ available: true } | { available: false; reason: LaneUnavailableReason; detail: string }> {
  // Prerequisites first: a missing `jq`-style helper is a clearer failure than whatever the tool
  // does without it, and reporting it costs nothing.
  for (const bin of plan.requiresBinaries) {
    if (!deps.hasBinary(bin)) {
      return {
        available: false,
        reason: LANE_UNAVAILABLE.MISSING_REQUIRED_BINARY,
        detail: `lane '${plan.slug}' requires '${bin}' on PATH`,
      };
    }
  }

  const probe = plan.probe;
  if (!probe || typeof probe !== 'object') {
    return { available: false, reason: LANE_UNAVAILABLE.PROBE_FAILED, detail: 'lane declares no probe' };
  }

  switch (probe.kind) {
    case 'command-exists':
      return deps.hasBinary(probe.binary)
        ? { available: true }
        : {
            available: false,
            reason: LANE_UNAVAILABLE.MISSING_BINARY,
            detail: `'${probe.binary}' not found on PATH`,
          };

    case 'command-capability': {
      // Existence alone is structurally insufficient here: `kimi` is claimed by BOTH the Kimi Code
      // CLI and the legacy Python kimi-cli, and an existence-only probe registers the wrong tool.
      if (!deps.hasBinary(probe.binary)) {
        return {
          available: false,
          reason: LANE_UNAVAILABLE.MISSING_BINARY,
          detail: `'${probe.binary}' not found on PATH`,
        };
      }
      const out = deps.spawn(probe.binary, ['--help'], { timeoutMs: probe.timeoutMs });
      if (out.errorCode === 'ETIMEDOUT') {
        return {
          available: false,
          reason: LANE_UNAVAILABLE.PROBE_TIMEOUT,
          detail: `'${probe.binary} --help' exceeded ${probe.timeoutMs}ms`,
        };
      }
      const help = `${out.stdout}\n${out.stderr}`;
      return help.includes(probe.needle)
        ? { available: true }
        : {
            available: false,
            reason: LANE_UNAVAILABLE.PROBE_FAILED,
            detail: `'${probe.binary}' is on PATH but its --help lacks '${probe.needle}' — this is a different tool sharing the name`,
          };
    }

    case 'http-reachable': {
      // Only a STRING config value names a host. `String(unknown)` would turn an object into the
      // literal '[object Object]' and probe that as a URL — a nonsense destination reported as
      // "unreachable" rather than as the misconfiguration it is.
      const configured = deps.configGet(probe.hostConfigKey);
      const base = normalizeHost(
        (typeof configured === 'string' ? configured : '') ||
          (plan.transport === 'openai-http' ? plan.host : ''),
      );
      if (!base) {
        return { available: false, reason: LANE_UNAVAILABLE.HOST_UNREACHABLE, detail: 'no host resolved' };
      }
      const r = await deps.httpJson(`${base}${probe.path}`, { method: 'GET', timeoutMs: probe.timeoutMs });
      return r.ok
        ? { available: true }
        : {
            available: false,
            reason: LANE_UNAVAILABLE.HOST_UNREACHABLE,
            detail: `${base}${probe.path} unreachable: ${r.error ?? `HTTP ${r.status}`}`,
          };
    }

    default:
      return {
        available: false,
        reason: LANE_UNAVAILABLE.PROBE_FAILED,
        detail: `unknown probe kind '${String((probe as { kind?: unknown }).kind)}'`,
      };
  }
}

/* ------------------------------------------------------------------ *
 * Empty-output policy (#2494 / #2605 / #2794)
 * ------------------------------------------------------------------ */

/**
 * Write the review, or a diagnostic stub when the lane produced nothing usable.
 *
 * The stub is not cosmetic. Before #2494/#2605 a failed lane left a zero-byte file, `write_reviews`
 * rendered it as "a reviewer that ran cleanly with nothing to report", and the lane vanished from
 * the cross-AI consensus while `present_results` reported success — a review blind in one eye. The
 * stub keeps its "failed or returned empty output" header precisely so it can never be mistaken for
 * a real review.
 *
 * `extraDiagnostics` carries the raw HTTP response body for the OpenAI-compatible lanes: an error
 * from such a server arrives with HTTP 4xx/5xx and the JSON in the BODY, so stderr alone is empty
 * and the body is the only evidence.
 *
 * `outcome` (#4255) carries the spawn's exit status so the stub can say WHICH empty it is. The
 * header alone cannot: a crash, a timeout kill and a model that ended its turn without writing a
 * final message all reach here as the same zero bytes, and the third is what a too-low reasoning
 * effort produces on a large source-grounded prompt. A clean exit inside the timeout with no
 * output is a stopped-short model, and the stub now says so — with the effort it ran at, which is
 * the value the operator would change.
 */
export function writeReviewOrStub(
  plan: LanePlan,
  content: string,
  deps: RunnerDeps,
  extraDiagnostics?: string,
  outcome?: { status: number | null; errorCode?: string },
): { stubbed: boolean } {
  if (!isEmptyReview(content)) {
    deps.writeFile(plan.reviewPath, content.endsWith('\n') ? content : `${content}\n`);
    return { stubbed: false };
  }
  const stderr = deps.exists(plan.errPath) ? deps.readFile(plan.errPath) : '';
  const parts = [`${plan.slug} review failed or returned empty output. stderr:`, stderr];
  if (extraDiagnostics) parts.push('Raw response body:', extraDiagnostics);
  parts.push(emptyOutputDiagnosis(plan, outcome));
  deps.writeFile(plan.reviewPath, `${parts.join('\n')}\n`);
  return { stubbed: true };
}

/**
 * One line naming the effort the lane ran at and how the process ended (#4255).
 *
 * Kept out of the header so the `failed or returned empty output` string every downstream reader
 * greps for is untouched — this is an added line, not a reworded one.
 */
export function emptyOutputDiagnosis(
  plan: LanePlan,
  outcome?: { status: number | null; errorCode?: string },
): string {
  // `effort` lives on the spawn plan only. An HTTP lane reaches a server directly and has no
  // reviewer CLI at all, so naming one there would be a lie about what ran (Codex review of
  // #4255) — the two transports get different, accurate wording.
  const spawned = plan.transport === 'spawn';
  const level = spawned ? plan.effort : null;
  const effort = level
    ? `ran at effort=${level}`
    : spawned
      ? "ran with no effort argument, so the reviewer CLI's own configuration applied"
      : 'is an HTTP lane and carries no reasoning-effort setting';
  if (!outcome) return `Diagnosis: ${plan.slug} ${effort}.`;
  // Four endings, not two. `status` is null for BOTH a timeout kill and a process that never
  // ran or died on a signal (ENOENT, SIGKILL) — reporting the latter as "status null" said
  // nothing, and folding them together would attach the stopped-short hint to a crash.
  const timedOut = outcome.errorCode === 'ETIMEDOUT';
  const neverRan = !timedOut && outcome.status === null;
  const cleanExit = outcome.status === 0;
  const ending = timedOut
    ? 'was killed by the outer timeout'
    : neverRan
      ? `did not exit normally (${outcome.errorCode ?? 'killed by a signal'})`
      : cleanExit
        ? 'exited cleanly inside the timeout'
        : `exited with status ${String(outcome.status)}`;
  // Hedged deliberately. A clean exit with no output is CONSISTENT with a model ending its turn
  // without a final message — which is what too low an effort produces on a large prompt — but it
  // is equally consistent with the CLI writing its output somewhere this lane did not read. The
  // line points at the likeliest cause without asserting it.
  const tail = cleanExit
    ? ' — a clean exit that produced no output is most often a model ending its turn without'
      + ' writing a final message rather than a crash; if this lane carries a reasoning effort,'
      + ' raising it is the usual fix.'
    : '.';
  return `Diagnosis: ${plan.slug} ${effort} and ${ending}${tail}`;
}

/* ------------------------------------------------------------------ *
 * Handlers (D6) — named first-party code, never conditionals in data
 * ------------------------------------------------------------------ */

/**
 * `opencode` — reconstruct the review from the assistant `text` parts of a `--format json` stream.
 *
 * `--format json` is the PRIMARY invocation, not a fallback: OpenCode's default `build` agent is an
 * agentic coder, and on a large review prompt it may run a few `read` tool calls then end its turn
 * with ZERO output tokens, so `--format default` yields empty stdout and the reviewer is silently
 * lost (#1936). When no assistant text was emitted, surface the stop reason and output-token count
 * so the failure is diagnosable rather than a generic empty stub.
 *
 * The stream is JSONL-ish: one JSON value per line. A line that does not parse is SKIPPED rather
 * than failing the lane — a partial stream still carries usable review text, and losing the whole
 * review to one malformed line would be strictly worse than the bug this handler exists to fix.
 */
export function handleOpencodeOutput(rawStdout: string): { review: string; diagnostic: string } {
  const texts: string[] = [];
  let stopReason = '?';
  let outputTokens = '?';
  for (const line of String(rawStdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt === null || typeof evt !== 'object') continue;
    const e = evt as { type?: unknown; part?: unknown };
    const part = (e.part ?? {}) as { text?: unknown; reason?: unknown; tokens?: unknown };
    if (e.type === 'text' && typeof part.text === 'string') {
      // An EMPTY string is kept, not skipped. The shipped jq was `.part.text // empty`, and `//`
      // only substitutes for `false`/`null` — an empty string is truthy in jq, so it survived and
      // contributed a blank line. Dropping it here would quietly close up blank lines between
      // parts, which is a real (if cosmetic) divergence from the behaviour being ported.
      texts.push(part.text);
    } else if (e.type === 'step_finish') {
      if (typeof part.reason === 'string') stopReason = part.reason;
      const tokens = (part.tokens ?? {}) as { output?: unknown };
      if (typeof tokens.output === 'number') outputTokens = String(tokens.output);
    }
  }
  return {
    review: texts.join('\n'),
    diagnostic: `stop reason=${stopReason}, output tokens=${outputTokens}`,
  };
}

/** One `PLANNER_RESPONSE` line of an Antigravity transcript. */
interface TranscriptEntry {
  source?: unknown;
  status?: unknown;
  type?: unknown;
  content?: unknown;
}

/**
 * `antigravity` — three layers, a two-level timeout, and a stale-response watermark.
 *
 * Layer 1 is stdout, which works on macOS/Linux/WSL. On native Windows `agy -p` silently produces
 * no stdout despite the API call succeeding (an upstream `text_drip.go` non-TTY flush bug), so
 * layer 2 reads the transcript `agy` always persists to disk. Layer 3 is a diagnostic stub.
 *
 * THE WATERMARK IS THE SUBTLE PART. Without it, layer 2 reads the last `PLANNER_RESPONSE` in the
 * transcript regardless of when it was written — including one from a PREVIOUS invocation in the
 * same workspace, silently presenting a stale review as this run's. So the transcript line count is
 * snapshotted BEFORE the spawn and only lines appended after it are considered. If the conversation
 * id changed, `agy` started a fresh session and every line is new (skip 0).
 *
 * `takeWatermark` must therefore be called before `runAntigravity`; the plan's outer timeout is the
 * external wall-clock cap that `--print-timeout` cannot provide (it cannot fire before a session
 * exists — a process can stall pre-session and outlive its own native timeout, #2073 mode 3).
 *
 * KNOWN LIMIT — the watermark is sequential, not concurrent. `last_conversations.json` is keyed by
 * WORKSPACE, so two `/gsd:review` runs against the same repo at the same time resolve the same
 * conversation id and share one transcript. The fallback then takes "the latest DONE
 * PLANNER_RESPONSE after the watermark" with nothing to tell the two runs apart, so one run could
 * read the other's response. This cannot be closed here: `agy` exposes no per-invocation id to
 * filter on, and the transcript carries none. It is stated rather than silently tolerated because
 * the guarantee this function advertises ("never stale") holds only for sequential use, and a
 * future reader deserves to know which half is actually guaranteed.
 *
 * ONE MARK COVERS TWO FILES (#2295). The review body lives in `transcript.jsonl`; the model lives
 * in `transcript_full.jsonl` — and these are DIFFERENT FILES WITH DIFFERENT LINE COUNTS. Using
 * `lines` as an offset into the full transcript would either skip real entries or replay old ones,
 * with no signal either way that it had done so. So this snapshots both, in the one pre-spawn call
 * site every caller already has to make — a second watermark function would just be a second thing
 * to remember to call before the spawn.
 */
export interface TranscriptWatermark {
  /** The `agy` conversation id this watermark was taken against, or `''` when none resolved. */
  convId: string;
  /** Line count of `transcript.jsonl` (the review body log) at watermark time. */
  lines: number;
  /** `true` when `transcript.jsonl` existed but could not be read (#3118 fail-closed shape). */
  unreadable?: boolean;
  /**
   * Line count of `transcript_full.jsonl` (the settings/model log) at watermark time.
   * DIFFERENT FILE, DIFFERENT LINE COUNT than `lines` — the review body and the model live in
   * two files that grow independently, so one count is never a valid offset into the other.
   */
  fullLines: number;
  /** `true` when `transcript_full.jsonl` existed but could not be read (#3118 fail-closed shape). */
  fullUnreadable?: boolean;
}

export function antigravityWatermark(workspace: string, deps: RunnerDeps): TranscriptWatermark {
  const convId = resolveWorkspaceConvId(workspace, deps);
  if (!convId) return { convId: '', lines: 0, fullLines: 0 };

  const tx = transcriptPath(deps.homeDir, convId);
  let lines = 0;
  let unreadable: boolean | undefined;
  if (deps.exists(tx)) {
    try {
      lines = deps.readFile(tx).split(/\r?\n/).filter((l) => l.trim()).length;
    } catch {
      // #3118: this conv-id pre-dates this run, so its transcript exists but this run cannot
      // verify its line count. Reporting `lines: 0` would assert a fact we could not check — flag
      // it instead so the fallback can decline rather than silently skip zero and replay a stale
      // response.
      unreadable = true;
    }
  }

  const fullTx = fullTranscriptPath(deps.homeDir, convId);
  let fullLines = 0;
  let fullUnreadable: boolean | undefined;
  if (deps.exists(fullTx)) {
    try {
      fullLines = deps.readFile(fullTx).split(/\r?\n/).filter((l) => l.trim()).length;
    } catch {
      fullUnreadable = true;
    }
  }

  return { convId, lines, ...(unreadable ? { unreadable } : {}), fullLines, ...(fullUnreadable ? { fullUnreadable } : {}) };
}

/**
 * Workspace lookup is case-insensitive — the leg's jq did `ascii_downcase` on both sides.
 *
 * #3118: a successful `JSON.parse` does not by itself make the payload a usable object —
 * `JSON.parse('null')` succeeds and returns `null`, so a truncated/zeroed cache file slips past
 * the callers' parse-only try/catch. `typeof null === 'object'`, so the guard below must exclude
 * `null` explicitly. Arrays are excluded too (not a workspace map), which also falls out of the
 * `Object.entries`/`hasOwnProperty` lookups below returning nothing for array input.
 */
function resolveConvId(cache: unknown, workspace: string): string {
  if (cache === null || typeof cache !== 'object') return '';
  const record = cache as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, workspace)) {
    const direct = record[workspace];
    if (typeof direct === 'string' && direct) return direct;
  }
  const target = workspace.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === target && typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * The `agy` conversation id for this workspace, or `''` when the cache is absent, unreadable or
 * names none.
 *
 * Reads and parses `last_conversations.json` once, so `antigravityWatermark`,
 * `antigravityTranscriptFallback` and `antigravityModel` — three callers as of #2295 — share one
 * lookup instead of each hand-rolling the same exists/readFile/JSON.parse/resolveConvId sequence.
 *
 * #3118: a successful `JSON.parse` does not by itself make the payload a usable object —
 * `JSON.parse('null')` succeeds and returns `null`, so a truncated/zeroed cache file slips past a
 * parse-only try/catch; `resolveConvId`'s own guard handles the object-shape half of that trap.
 * Workspace lookup is case-insensitive — the leg's jq did `ascii_downcase` on both sides — which
 * `resolveConvId` implements.
 */
function resolveWorkspaceConvId(workspace: string, deps: RunnerDeps): string {
  const cachePath = `${deps.homeDir}/.gemini/antigravity-cli/cache/last_conversations.json`;
  if (!deps.exists(cachePath)) return '';
  let cache: Record<string, unknown>;
  try {
    cache = JSON.parse(deps.readFile(cachePath)) as Record<string, unknown>;
  } catch {
    return '';
  }
  return resolveConvId(cache, workspace);
}

function transcriptPath(homeDir: string, convId: string): string {
  return `${homeDir}/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`;
}

/** The sibling log that carries `agy`'s SETTINGS entries (and so the session's model), not the review body. */
function fullTranscriptPath(homeDir: string, convId: string): string {
  return `${homeDir}/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript_full.jsonl`;
}

/**
 * Layer 2: the newest `PLANNER_RESPONSE` written AFTER the watermark, or `''`.
 *
 * Returning `''` rather than the newest entry overall is the whole point — an empty result lets
 * layer 3 fire with an honest diagnostic, where a stale one would be indistinguishable from a
 * successful review.
 */
export function antigravityTranscriptFallback(
  workspace: string,
  mark: { convId: string; lines: number; unreadable?: boolean },
  deps: RunnerDeps,
): string {
  const convId = resolveWorkspaceConvId(workspace, deps);
  if (!convId) return '';
  // #3118: the watermark could not read this conversation's transcript, so there is no trustworthy
  // skip for it. Declining is the fail-closed answer; skipping 0 would replay a prior run's review.
  if (mark.unreadable === true && convId === mark.convId) return '';
  const tx = transcriptPath(deps.homeDir, convId);
  if (!deps.exists(tx)) return '';
  let lines: string[];
  try {
    lines = deps.readFile(tx).split(/\r?\n/).filter((l) => l.trim());
  } catch {
    return '';
  }
  // Same conv-id ⇒ only lines beyond the watermark are this run's. Different id ⇒ fresh session,
  // so every line is new.
  const skip = convId === mark.convId ? mark.lines : 0;
  let latest = '';
  for (const line of lines.slice(skip)) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (
      entry.source === 'MODEL' &&
      entry.status === 'DONE' &&
      entry.type === 'PLANNER_RESPONSE' &&
      typeof entry.content === 'string'
    ) {
      latest = entry.content;
    }
  }
  return latest;
}

/**
 * The model `agy` ran under, recovered from its own `transcript_full.jsonl`, or `null` (#2295).
 *
 * THE STALENESS RULE HERE IS DELIBERATELY LOOSER THAN `antigravityTranscriptFallback`'s, and the
 * difference is the whole reason this is a separate function rather than a flag on that one.
 *
 * For a REVIEW BODY, a pre-watermark entry is fatal: it would present a previous run's review as
 * this one's. For the MODEL it is not. `last_conversations.json` is keyed by WORKSPACE, so a
 * matching conv-id means `agy` reused the SAME SESSION — and that session's model IS the model
 * this run ran under. `agy` reuses sessions per workspace, so a strict post-watermark-only scan
 * would report `unknown` for most real runs while being no more correct.
 *
 * A DIFFERENT conv-id means a fresh session, where every line is already this run's.
 * `fullUnreadable` still declines outright (#3118's fail-closed shape): a file that indisputably
 * exists but could not be read is not the same fact as an absent one.
 */
export function antigravityModel(
  workspace: string,
  mark: TranscriptWatermark,
  deps: RunnerDeps,
): string | null {
  const convId = resolveWorkspaceConvId(workspace, deps);
  if (!convId) return null;
  // #3118, applied to the model arm: a file that indisputably exists but could not be read is not
  // the same fact as an absent one — decline rather than guess.
  if (mark.fullUnreadable === true && convId === mark.convId) return null;

  const fullTx = fullTranscriptPath(deps.homeDir, convId);
  if (!deps.exists(fullTx)) return null;
  let fullText: string;
  try {
    fullText = deps.readFile(fullTx);
  } catch {
    return null;
  }

  // Same conv-id ⇒ agy reused this session; only lines beyond the watermark are guaranteed new,
  // but see the doc-comment above for why a pre-watermark fallback still applies for the MODEL.
  // Different id ⇒ fresh session, so every line is already this run's.
  const sameSession = convId === mark.convId;
  const lines = fullText.split(/\r?\n/).filter((l) => l.trim());
  const skip = sameSession ? mark.fullLines : 0;
  const afterWatermark = parseTranscriptModel(lines.slice(skip).join('\n'));
  if (afterWatermark !== null) return afterWatermark;

  // Nothing new since the watermark. For a same-session reuse, the session's own (pre-watermark)
  // model is still this run's model — the whole point of the looser rule above.
  return sameSession ? parseTranscriptModel(fullText) : null;
}

/**
 * The model a spawned lane ran under. Precedence is TOTAL and ORDERED (#2295).
 *
 * `pinned` first because it is the only arm that is certain. Then the handler's own transcript,
 * then the startup banner.
 *
 * THE BANNER ARM IS GATED ON `outputTarget.kind === 'file'`, and that gate is the single most
 * important line in this function. A lane whose review comes back on STDOUT has its review text
 * in exactly the buffer the banner scan would read — so a review that merely DISCUSSES a model
 * ("model: gpt-5 is the wrong choice here") would be recorded as that lane's resolved model. Only
 * a lane that writes its review to a FILE has a stdout stream that is banner and nothing else.
 * The condition is derived from DECLARED DATA rather than from a slug check, so it covers today's
 * one file-output lane and any future one without naming either. (`stampBlindReview` anchors its
 * own tells to the first five lines for the same class of reason.)
 *
 * `repoRoot` is the workspace `agy` keys its conversation cache by, so it is required rather than
 * defaulted — an empty workspace would silently resolve no conversation and look identical to "no
 * model recorded".
 */
export function resolveSpawnModel(
  plan: SpawnPlan,
  out: { stdout?: string; stderr?: string },
  mark: TranscriptWatermark,
  deps: RunnerDeps,
  repoRoot: string,
): ResolvedModel {
  try {
    if (plan.model) return withEffort(recordedModel(plan.model, MODEL_SOURCE.PINNED), plan.effort);

    if (plan.handler === 'antigravity') {
      let transcript: string | null;
      try {
        transcript = antigravityModel(repoRoot, mark, deps);
      } catch {
        return UNRESOLVED_MODEL;
      }
      return withEffort(recordedModel(transcript, MODEL_SOURCE.TRANSCRIPT), plan.effort);
    }

    if (plan.outputTarget.kind === 'file') {
      const banner = parseModelBanner(out.stdout ?? '') ?? parseModelBanner(out.stderr ?? '');
      return withEffort(recordedModel(banner, MODEL_SOURCE.BANNER), plan.effort);
    }

    return UNRESOLVED_MODEL;
  } catch {
    // A model arm must NEVER fail the lane — see the module banner's TOTAL contract.
    return UNRESOLVED_MODEL;
  }
}

/**
 * Antigravity's prompt variant (#2176).
 *
 * Differs from the standard `argv-file-ref` text by one clause, and that clause is load-bearing:
 * it REQUIRES the reviewer to self-report when it cannot read the repo. Without it a blind review
 * is indistinguishable from a grounded one — the reviewer happily reviews the plan text in
 * isolation and its verdict is counted at full weight in the consensus. `stampBlindReview` reads
 * this self-report back out.
 */
export function antigravityPrompt(promptPath: string, repoRoot: string): string {
  return (
    `Read the file at ${promptPath} in full and carry out the review request it contains. ` +
    `The repository under review is at ${repoRoot} — resolve every relative file path in the ` +
    `review request against that absolute root and verify claims against those files. ` +
    `If you cannot read files under ${repoRoot}, begin your output with the exact line ` +
    `REVIEWED-WITHOUT-REPO-ACCESS before the review. Output only the resulting markdown review. ` +
    `Do not edit any files.`
  );
}

/**
 * Antigravity's argv adjustments — the two things data cannot express for this lane.
 *
 * 1. `--add-dir <repo>`, CAPABILITY-PROBED. Without it agy's permission context never receives the
 *    cwd repo: the agent anchors on its own `~/.gemini/antigravity-cli/scratch` dir and reviews the
 *    plan text in isolation, which is exactly what the Review Instructions forbid (#2176). It is
 *    probed rather than assumed because older agy builds reject the unknown flag outright, and a
 *    lane that fails to start is worse than one that runs on the prompt anchor alone.
 * 2. The self-report prompt variant above, swapped in for the standard file-ref text.
 *
 * Both are argv shape, so they belong here rather than in the descriptor: expressing "add this
 * flag only if the binary's --help mentions it" as data would need a conditional, which is
 * precisely what the named-handler seam exists to absorb (ADR-2782 D6). The native
 * `--print-timeout` VALUE (#3274) is NOT this handler's job — `resolveLanePlan`
 * (review-lane-invocation.cts) resolves the `{{nativeTimeout}}` ARGV_PLACEHOLDER itself, exactly
 * like `{{model}}`/`{{effort}}`/`{{output}}`/`{{prompt}}`, so `plan.argv` arrives here already fully
 * resolved.
 */
export function antigravityArgv(
  argv: readonly string[],
  promptPath: string,
  repoRoot: string,
  deps: RunnerDeps,
): string[] {
  const standard = fileRefPromptText(promptPath, repoRoot);
  const out = argv.map((a) => (a === standard ? antigravityPrompt(promptPath, repoRoot) : a));

  let supportsAddDir = false;
  try {
    const help = deps.spawn('agy', ['--help'], { timeoutMs: 5_000 });
    supportsAddDir = `${help.stdout}\n${help.stderr}`.includes('--add-dir');
  } catch {
    supportsAddDir = false;
  }
  if (!supportsAddDir) return out;

  // Insert before the trailing `-p <prompt>` pair so the prompt stays last, as the leg had it.
  const pIdx = out.lastIndexOf('-p');
  if (pIdx === -1) return [...out, '--add-dir', repoRoot];
  return [...out.slice(0, pIdx), '--add-dir', repoRoot, ...out.slice(pIdx)];
}

/**
 * Layer 3's diagnostic: what `agy` itself logged, when both stdout and the transcript were empty.
 *
 * #2073 mode 2 is invisible without this. A pinned model that 404s server-side exits **0** with
 * empty stdout AND an empty transcript — every signal the other two layers read says "clean run,
 * nothing to report". The only evidence is in `agy`'s own log, so a bare generic stub would leave
 * the user with a silently missing reviewer and nothing to diagnose.
 *
 * Mode 3 (a pre-session stall, which `--print-timeout` cannot bound because it cannot fire before a
 * session exists) leaves no log line at all, so its tell is stated rather than searched for.
 *
 * #3996 mode 4 (a headless tool-permission denial) exits 0 with empty stdout and a POPULATED
 * transcript, and reports the cause only on stderr — so the stub carries the run's stderr
 * (`evidence.stderr`, the same `plan.errPath` content the generic stub reads), and the mode-3
 * tell is stated only when `antigravityFailureMode` rules a session out (a fresh conv-id or
 * transcript growth past the watermark means one verifiably started). Asserting mode 3 over a
 * transcript this code just read inverts who is better placed to know.
 */
/**
 * What actually failed, as a typed fact rather than a guess baked into prose. #3996.
 *
 * The session-started question is decidable at diagnostic time with the same staleness rule the
 * layer-2 fallback uses: re-resolve the workspace's CURRENT conv-id and compare against the
 * pre-spawn watermark. A conv-id that changed, or a transcript that grew past the watermark
 * line count, means THIS invocation demonstrably reached a session — a pre-launch stall is
 * ruled out. An unchanged conv-id with no growth means nothing new happened, which is the
 * #2073 mode-3 shape even when a PRIOR session's transcript still exists on disk (existence
 * alone would mis-diagnose mode 3 as mode 4 in any workspace with history).
 */
export const ANTIGRAVITY_FAILURE_MODE = Object.freeze({
  /** A session ran this invocation (fresh conv-id, or transcript growth) but no review was recovered. */
  SESSION_STARTED: 'session_started',
  /** No session this invocation — the #2073 mode-3 stall tell is the right signpost. */
  PRE_SESSION_STALL: 'pre_session_stall',
} as const);

export type AntigravityFailureMode =
  (typeof ANTIGRAVITY_FAILURE_MODE)[keyof typeof ANTIGRAVITY_FAILURE_MODE];

export function antigravityFailureMode(
  workspace: string,
  mark: TranscriptWatermark,
  deps: RunnerDeps,
): AntigravityFailureMode {
  const convId = resolveWorkspaceConvId(workspace, deps);
  if (!convId) return ANTIGRAVITY_FAILURE_MODE.PRE_SESSION_STALL;
  // A different conv-id than the watermark saw = a fresh session this run, transcript or not.
  if (convId !== mark.convId) return ANTIGRAVITY_FAILURE_MODE.SESSION_STARTED;
  const tx = transcriptPath(deps.homeDir, convId);
  if (!deps.exists(tx)) return ANTIGRAVITY_FAILURE_MODE.PRE_SESSION_STALL;
  try {
    const lines = deps.readFile(tx).split(/\r?\n/).filter((l) => l.trim()).length;
    return lines > mark.lines
      ? ANTIGRAVITY_FAILURE_MODE.SESSION_STARTED
      : ANTIGRAVITY_FAILURE_MODE.PRE_SESSION_STALL;
  } catch {
    // #3118 fail-closed shape: the transcript indisputably exists but cannot be read — do not
    // assert the stall case over a file this code cannot check.
    return ANTIGRAVITY_FAILURE_MODE.SESSION_STARTED;
  }
}

export function antigravityDiagnostic(
  deps: RunnerDeps,
  evidence: { stderr?: string; mode?: AntigravityFailureMode } = {},
): string {
  const lines = [
    'Antigravity review failed or returned empty output.',
  ];
  const logPath = `${deps.homeDir}/.gemini/antigravity-cli/cli.log`;
  if (deps.exists(logPath)) {
    try {
      const hits = deps
        .readFile(logPath)
        .split(/\r?\n/)
        .filter((l) => /agent executor error|NOT_FOUND|Publisher model/i.test(l))
        .slice(-3);
      if (hits.length) {
        lines.push(
          "agy log hint (pinned model may be unavailable — run 'agy models' and set review.models.agy):",
          ...hits,
        );
      }
    } catch {
      /* an unreadable log is not worth failing the lane over */
    }
  }
  // #3996: the stub carries agy's stderr, as the generic lane stub already does — mode 4 (a
  // headless tool-permission denial) exits 0 with empty stdout and a populated transcript, and
  // the stderr line is the only signal that names its cause.
  const stderr = (evidence.stderr ?? '').trim();
  if (stderr) lines.push('stderr:', stderr);
  // #3996: mode 3's tell is stated only when its precondition holds — the mode is computed from
  // the watermark (#3996 mode 3 in a workspace with history is a no-growth transcript, not an
  // absent one), never guessed from prose.
  if (evidence.mode === ANTIGRAVITY_FAILURE_MODE.SESSION_STARTED) {
    lines.push(
      'An agy session started this run but no review was recovered, so a pre-launch stall is ' +
        'ruled out.' +
        (stderr
          ? ' See stderr above; a headless run that was auto-denied a tool permission reports ' +
            'the cause and its fix there.'
          : ' agy reported nothing on its error stream; inspect the transcript under ' +
            '~/.gemini/antigravity-cli/brain/<conv-id>/ for where the session stopped.'),
    );
  } else {
    lines.push(
      'If no agy run started, that is the pre-session-stall case: check whether a new ' +
        '~/.gemini/antigravity-cli/brain/<conv-id>/ dir appeared within ~30s of launch.',
    );
  }
  return lines.join('\n');
}

/**
 * Stamp a machine-readable marker when the reviewer plainly ran without repo access (#2176).
 *
 * BOTH tells are ANCHORED, and that anchoring is load-bearing: a grounded review that merely QUOTES
 * `REVIEWED-WITHOUT-REPO-ACCESS` — reviewing this very file, say — must never be mis-stamped. So
 * the self-report is only honoured in the first five lines, and the scratch-dir tell only in a
 * workspace-DECLARATION phrasing.
 */
export function stampBlindReview(review: string): string {
  if (isEmptyReview(review)) return review;
  const head = review.split(/\r?\n/).slice(0, 5).join('\n');
  const selfReported = head.includes('REVIEWED-WITHOUT-REPO-ACCESS');
  const scratchTell = /(workspace|working) (directory|dir)[\s\S]{0,40}antigravity-cli\/scratch/i.test(review);
  if (!selfReported && !scratchTell) return review;
  return (
    '> [reviewed-without-repo-access] This reviewer ran without visibility into the repo under ' +
    'review — down-weight its verdict in the Consensus Summary.\n\n' +
    review
  );
}

/**
 * A `path/to/file:line`-shaped source citation (#3194).
 *
 * The Review Instructions (review.md) require every reviewer to "cite concrete
 * `path/to/file:line` evidence"; this recognizes that shape in review output. Two anchors
 * make the match a source citation rather than any `colon-digits`:
 *   - the token before the colon must contain a path separator (`/` or `\`) or end in a
 *     `.extension`, so a bare PLAN-line reference — "see line 42", "L12-L18", the invented
 *     references measured in #3194 — does not match;
 *   - the token may not itself contain `:` and may not start immediately after `/` or `:`,
 *     so a URL (`http://localhost:8080`) and its host:port do not match either.
 *
 * KNOWN LIMIT (deliberate, #3194 scope): presence is checked, not resolution. A citation to
 * a line that does not exist still counts — catching invented references that look impeccable
 * requires repo access at stamp time and is follow-up material, not part of this fix.
 */
const SOURCE_CITATION_RE = /(?<![/:])(?:[^\s:]*[/\\][^\s:]*|[^\s:]*\.[A-Za-z0-9]{1,16}):[0-9]+/;

/** The marker the Consensus Summary step recognizes and down-weights (#3194). */
const UNGROUNDED_MARKER = '[reviewed-without-source-citations]';

/**
 * Stamp a machine-readable marker when a source-grounded lane's review cites no `file:line`
 * evidence (#3194).
 *
 * The sibling of `stampBlindReview`, for a different failure mode: that one fires when a
 * reviewer REPORTS it had no repo access; this one fires when a lane that DECLARES
 * `source-grounded` evidence delivered none — the review restates the plan's own claims with
 * at most invented plan-line references. Either way the Consensus Summary must not count the
 * verdict at full weight, which is why both prepend a marker the consensus step recognizes.
 *
 * Idempotent and empty-safe: an already-stamped review passes through unchanged, and an empty
 * review is left to the empty-output policy's diagnostic stub.
 */
export function stampUngroundedReview(review: string): string {
  if (isEmptyReview(review)) return review;
  if (review.startsWith(`> ${UNGROUNDED_MARKER}`)) return review;
  if (SOURCE_CITATION_RE.test(review)) return review;
  return (
    `> ${UNGROUNDED_MARKER} This reviewer declared source-grounded evidence but cited no ` +
    'file:line source evidence, so it reviewed the pasted plan text only — down-weight its ' +
    'verdict in the Consensus Summary.\n\n' +
    review
  );
}

/**
 * `openai-compatible` — model discovery, the chat-completions round trip, and the served-model
 * mismatch warning.
 *
 * The raw body is returned alongside the content because an OpenAI-compatible server reports errors
 * with an HTTP 4xx/5xx and the JSON in the BODY. The bash piped the response straight into `jq`,
 * which discarded exactly that evidence; the stub appends it now.
 *
 * MODEL (#2295): what actually ran beats what was asked for. If the response echoes a `model`
 * field, that is `SERVED` — the most authoritative arm, since it is the server's own report of
 * what it ran. Otherwise the request falls back to `REQUESTED`: the discovered or `fallbackModel`
 * value that was actually sent, recorded even when the request itself failed — the ADR-2782
 * served-model mismatch warning above is preserved unchanged.
 */
export async function runOpenAiCompatible(
  plan: HttpPlan,
  promptText: string,
  deps: RunnerDeps,
): Promise<{ review: string; rawBody: string; model: ResolvedModel }> {
  let model = plan.model;
  if (!model && plan.modelsUrl) {
    const listed = await deps.httpJson(plan.modelsUrl, { method: 'GET', timeoutMs: 2_000 });
    if (listed.ok) {
      try {
        const parsed = JSON.parse(listed.body) as { data?: Array<{ id?: unknown }> };
        const first = Array.isArray(parsed.data) ? parsed.data[0] : undefined;
        if (first && typeof first.id === 'string' && first.id) model = first.id;
      } catch {
        /* fall through to the declared fallback */
      }
    }
  }
  if (!model) model = plan.fallbackModel;
  const requested: ResolvedModel = recordedModel(model, MODEL_SOURCE.REQUESTED);

  const body = JSON.stringify({ model, messages: [{ role: 'user', content: promptText }] });
  const res = await deps.httpJson(plan.url, { method: 'POST', body, timeoutMs: plan.timeoutMs });
  if (!res.ok && !res.body) {
    return { review: '', rawBody: res.error ?? `HTTP ${res.status}`, model: requested };
  }
  let review = '';
  let served: ResolvedModel | null = null;
  try {
    const parsed = JSON.parse(res.body) as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    // A server that quietly serves a different model than requested produces a review the user
    // will attribute to the wrong system. Warn rather than fail — the review is still real.
    if (typeof parsed.model === 'string' && parsed.model && parsed.model !== model) {
      deps.warn(
        `${plan.slug} served model '${parsed.model}' but '${model}' was requested. ` +
          `Review may be from a different model.`,
      );
    }
    const servedModel = recordedModel(parsed.model, MODEL_SOURCE.SERVED);
    if (servedModel.source !== MODEL_SOURCE.UNKNOWN) served = servedModel;
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === 'string') review = content;
  } catch {
    /* leave review empty — the raw body carries the diagnosis */
  }
  return { review, rawBody: res.body, model: served ?? requested };
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/**
 * Run one resolved lane end to end.
 *
 * Order is deliberate: egress re-verification happens BEFORE the probe and before any spawn, so a
 * lane whose destination changed never receives the plan text even once.
 */
export async function runLane(
  plan: LanePlan,
  deps: RunnerDeps,
  opts: { consentedHost?: unknown; explicitlyRequested?: boolean; repoRoot: string },
): Promise<LaneRunResult> {
  // Nothing ran for either early exit below, so there is nothing to attribute a model to (#2295).
  const base = { slug: plan.slug, stubbed: false, model: UNRESOLVED_MODEL };

  if (plan.transport === 'openai-http') {
    const egress = checkEgressHost(opts.consentedHost, plan.host);
    if (!egress.allowed) {
      const detail =
        `lane '${plan.slug}' was consented to send plans to ${egress.consentedHost} but ` +
        `${plan.hostConfigKey} now resolves to ${egress.currentHost}. Re-consent to allow the new ` +
        `destination — this lane will not run against a host you did not approve.`;
      deps.warn(detail);
      return { ...base, ok: false, reason: LANE_UNAVAILABLE.EGRESS_HOST_CHANGED, detail };
    }
  }

  const probed = await probeLane(plan, deps);
  if (!probed.available) {
    // D4's carve-out: not finding a lane nobody asked for is normal; failing to run a lane somebody
    // asked for is an ERROR. Both are visible; only the second is fatal to the run.
    if (opts.explicitlyRequested) deps.warn(`explicitly requested reviewer '${plan.slug}': ${probed.detail}`);
    return { ...base, ok: false, reason: probed.reason, detail: probed.detail };
  }

  return plan.transport === 'spawn'
    ? runSpawnLane(plan, deps, opts.repoRoot)
    : runHttpLane(plan, deps);
}

function runSpawnLane(plan: SpawnPlan, deps: RunnerDeps, repoRoot: string): LaneRunResult {
  const input = plan.stdin && deps.exists(plan.stdin) ? deps.readFile(plan.stdin) : undefined;

  const mark =
    plan.handler === 'antigravity'
      ? antigravityWatermark(repoRoot, deps)
      : { convId: '', lines: 0, fullLines: 0 };

  const argv =
    plan.handler === 'antigravity'
      ? antigravityArgv(plan.argv, plan.promptPath, repoRoot, deps)
      : plan.argv;

  const out = deps.spawn(plan.binary, argv, {
    input,
    timeoutMs: plan.timeoutMs,
    ...(plan.env ? { env: plan.env } : {}),
  });
  // The model arm reads the RAW spawn outcome here, deliberately, so it sees `out.stdout`/`out.stderr`
  // exactly as the process emitted them — before the handlers below reassign `review` (#2295).
  const model = resolveSpawnModel(plan, out, mark, deps, repoRoot);
  // #3086: surface spawn errors (ENOENT, ETIMEDOUT, etc.) that would otherwise
  // be silently dropped — the review path read only stdout/stderr and treated
  // an empty-stderr spawn failure as "the model had nothing to say".
  const errContent = out.errorCode
    ? `${out.stderr ?? ''}\n[spawn error: ${out.errorCode}]\n`
    : (out.stderr ?? '');
  deps.writeFile(plan.errPath, errContent);

  // `file-arg` lanes write the review themselves and their stdout is deliberately discarded (#1698).
  let review =
    plan.outputTarget.kind === 'file'
      ? deps.exists(plan.outputTarget.path)
        ? deps.readFile(plan.outputTarget.path)
        : ''
      : (out.stdout ?? '');

  let extra: string | undefined;

  if (plan.handler === 'opencode') {
    const rebuilt = handleOpencodeOutput(review);
    if (!isEmptyReview(rebuilt.review)) {
      review = rebuilt.review;
    } else {
      review = '';
      extra = `OpenCode review returned no assistant text (#1936: agent ended its turn with no final message).\nDiagnostic: ${rebuilt.diagnostic}`;
    }
  }

  if (plan.handler === 'antigravity') {
    // A non-zero exit (timeout kill, crash) discards partial output so the transcript fallback and
    // the diagnostic stub can take over.
    if (out.status !== 0) review = '';
    if (isEmptyReview(review)) review = antigravityTranscriptFallback(repoRoot, mark, deps);
    review = stampBlindReview(review);
    // Layer 3. `emptyOutput: 'handler-owned'` means the generic stub does not fire for this lane,
    // so if nothing is written here the lane goes out empty — the #2073 failure itself.
    if (isEmptyReview(review)) {
      // The model is kept on this stub path deliberately (#2295): #2073 mode 2 is exactly a
      // pinned model that 404s server-side and exits 0 with empty output, so the model IS the
      // diagnosis — dropping it here would throw away the one piece of evidence the stub exists
      // to preserve.
      deps.writeFile(
        plan.reviewPath,
        `${antigravityDiagnostic(deps, {
          stderr: errContent,
          mode: antigravityFailureMode(repoRoot, mark, deps),
        })}\n`,
      );
      return { slug: plan.slug, ok: true, stubbed: true, model };
    }
  }

  // #3194: verify the declared evidence class against the review's actual output. A
  // source-grounded lane whose review cites no file:line evidence reviewed the plan text
  // only; stamp it so the Consensus Summary down-weights the verdict instead of silently
  // trusting the lane's declaration. diff-only lanes are exempt — their verdict is already
  // folded in as a diff observation, and the citation check must not change that surface.
  if (plan.evidenceClass !== 'diff-only') review = stampUngroundedReview(review);

  const { stubbed } = writeReviewOrStub(plan, review, deps, extra, out);
  return { slug: plan.slug, ok: true, stubbed, model };
}

async function runHttpLane(plan: HttpPlan, deps: RunnerDeps): Promise<LaneRunResult> {
  const promptText = deps.exists(plan.promptPath) ? deps.readFile(plan.promptPath) : '';
  const { review, rawBody, model } = await runOpenAiCompatible(plan, promptText, deps);
  // #3194: same verification on the http path — see runSpawnLane.
  const stamped = plan.evidenceClass !== 'diff-only' ? stampUngroundedReview(review) : review;
  deps.writeFile(plan.errPath, '');
  const { stubbed } = writeReviewOrStub(plan, stamped, deps, rawBody);
  return { slug: plan.slug, ok: true, stubbed, model };
}
