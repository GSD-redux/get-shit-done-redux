/**
 * Reviewer Lane Descriptor Module (ADR-2782 Phase 1, #2794 — closes #2690).
 *
 * ONE place where the cross-AI reviewer lane contract is declared as data.
 *
 * Before this module the contract lived in three unrelated surfaces: the roster
 * in `review-reviewer-selection.cts`, ~640 lines of hand-authored per-CLI bash in
 * `gsd-core/workflows/review.md` `invoke_reviewers`, and the hardcoded section
 * headings in `write_reviews`. A cross-cutting fix therefore landed per-leg —
 * #2494 and #2605 were the same empty-output defect filed twice, and #2475 /
 * #2295 / #2272 are the same shape.
 *
 * SCOPE (ADR-2782's phase table). This module DECLARES; it does not execute.
 * `invoke_reviewers` still runs hand-authored legs until Phase 5b (#2799) makes
 * it iterate. What Phase 1 buys is that a leg can no longer be added, removed,
 * or renamed without the table and the REVIEWS.md section moving with it —
 * `checkReviewerLaneParity` below is the `DEFECT.GENERATIVE-FIX` assertion
 * (`CONTEXT.md:797`) that the roster has never had.
 *
 * The descriptor deliberately does NOT promise uniformity. Lane divergence is
 * real and frequently correct (measured timeout floors differ; three lanes are
 * HTTP endpoints with no binary; Antigravity needs a three-layer fallback for an
 * upstream stdout bug). The value is one place where divergence is DECLARED.
 * Behaviour that data cannot express is delegated to a named `handler`
 * (ADR-2782 D6 closed enum) — never to conditionals inside the table.
 *
 * Field names, nesting, and enum members track ADR-2782 D1/D2/D6/D7 so Phase 2
 * (#2795) harvests this shape into the capability manifest without a translation
 * layer — INCLUDING `transport`'s placement at the lane level (see SpawnLane).
 *
 * Building this table against all eleven shipped legs surfaced four cases the
 * ADR's original survey did not cover. Rather than diverge silently — which is
 * exactly the translation layer this module exists to avoid — ADR-2782 was
 * AMENDED in the same PR (see its Amendments section, 2026-07-29). All four are
 * additive widenings of closed enums, each forced by a lane that exists today:
 *
 *   1. `promptChannel: 'none'` — CodeRabbit reviews the working-tree diff and is
 *      fed no prompt at all.
 *   2. `outputChannel: 'file-arg'` — Codex writes the review via its own
 *      `-o/--output-last-message <FILE>` and discards stdout (#1698), because on
 *      Windows it emits teardown noise to stdout after the final message.
 *   3. `outputArg` — the companion to (2): knowing the review lands in a file is
 *      useless without the argument that names the file.
 *   4. `flags: string[]` — Antigravity is selected by BOTH `--antigravity` and
 *      `--agy`, which a single-valued field cannot express. This also flattens
 *      D8's uniqueness invariant across every lane's flags.
 *
 * Phase 2 (#2795) implements the manifest validator against the amended
 * vocabulary, which is the point of amending rather than leaving it to be
 * rediscovered.
 */

/** ADR-2782 D2 — closed transport discriminator; selects the invoke sub-shape. */
export type LaneTransport = 'spawn' | 'openai-http';

/** ADR-2782 D2, widened by the CodeRabbit lane (see module header). */
export type PromptChannel = 'stdin' | 'argv' | 'argv-file-ref' | 'none';

/** ADR-2782 D2, widened by the Codex lane (see module header). */
export type OutputChannel = 'stdout' | 'file-arg';

/** ADR-2782 D2 — how reasoning effort reaches the tool. */
export type EffortChannel = 'none' | 'argv' | 'env';

/** ADR-2782 D2 — CodeRabbit reviews a diff, not the source tree (`review.md:367`). */
export type EvidenceClass = 'source-grounded' | 'diff-only';

/** ADR-2782 D6 — closed enum of first-party imperative modules. Ported in Phase 5b. */
export type LaneHandler = null | 'antigravity' | 'openai-compatible';

/**
 * What a lane does when it produces no usable output.
 * `stub-with-stderr` is the normalized policy (#2494/#2605): write a diagnostic
 * stub carrying the captured stderr, so `write_reviews` can tell a failed lane
 * apart from a reviewer that ran cleanly with nothing to report.
 * `handler-owned` means the lane's handler writes its own diagnostics.
 */
export type EmptyOutputPolicy = 'stub-with-stderr' | 'handler-owned';

/** ADR-2782 D7 — every probe that starts a process or connection MUST be bounded. */
export type LaneProbe =
  | { kind: 'command-exists'; binary: string }
  | { kind: 'command-capability'; binary: string; needle: string; timeoutMs: number }
  | { kind: 'http-reachable'; hostConfigKey: string; path: string; timeoutMs: number };

export interface SpawnInvoke {
  binary: string;
  args: ReadonlyArray<string>;
  promptChannel: PromptChannel;
  outputChannel: OutputChannel;
  /** Present only when `outputChannel === 'file-arg'`. */
  outputArg?: string;
  /** `null` when the lane accepts no model override. */
  modelArg: string | null;
  effortChannel: EffortChannel;
}

export interface HttpInvoke {
  /** Dotted config key holding the base URL. */
  hostConfigKey: string;
  path: string;
  modelDiscovery: 'none' | 'first-from-models-endpoint';
  effortChannel: 'none';
}

export type LaneInvoke = SpawnInvoke | HttpInvoke;

interface ReviewerLaneCommon {
  slug: string;
  /**
   * Every CLI flag that selects this lane. First entry is canonical.
   * ADR-2782 D1 shows a singular `flag`; see the module header's widening (3).
   */
  flags: ReadonlyArray<string>;
  probe: LaneProbe;
  /** Outer wall-clock bound. An inner tool-native timeout lives in the handler (D6). */
  timeoutFloorMs: number;
  emptyOutput: EmptyOutputPolicy;
  /** The `## <reviewsSection> Review` heading in write_reviews. Unique (D8). */
  reviewsSection: string;
  evidenceClass: EvidenceClass;
  /** External tools required on PATH — `jq` for five lanes. */
  requiresBinaries: ReadonlyArray<string>;
  /** Dotted config key for per-lane prompt trimming, or null. */
  promptBudgetKey: string | null;
  handler: LaneHandler;
}

/**
 * `transport` sits at the LANE level, a sibling of `probe` and `invoke`, exactly
 * as ADR-2782 D1's manifest example places it — not nested inside `invoke`.
 * Nesting it would read more naturally as a TypeScript discriminated union, and
 * that is precisely the convenience Phase 2 (#2795) would have to translate away
 * when harvesting this shape into the capability manifest. The union is
 * discriminated at the lane level instead, which costs nothing and keeps the two
 * vocabularies identical.
 */
export interface SpawnLane extends ReviewerLaneCommon {
  transport: 'spawn';
  invoke: SpawnInvoke;
}

export interface HttpLane extends ReviewerLaneCommon {
  transport: 'openai-http';
  invoke: HttpInvoke;
}

export type ReviewerLane = SpawnLane | HttpLane;

const SPAWN_STDIN_STDOUT = {
  promptChannel: 'stdin',
  outputChannel: 'stdout',
} as const;

/**
 * The eleven lanes shipped today, in `write_reviews` order.
 *
 * `kimi-code` is deliberately absent: it is net-new with no leg, and ADR-2782
 * lands it in Phase 5b alongside the iteration that can invoke it. Declaring it
 * here would make it selectable but not invocable.
 */
export const REVIEWER_LANES: ReadonlyArray<ReviewerLane> = Object.freeze([
  {
    slug: 'gemini',
    flags: ['--gemini'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'gemini' },
    invoke: {
      binary: 'gemini',
      args: ['-p', '-'],
      ...SPAWN_STDIN_STDOUT,
      modelArg: '-m',
      effortChannel: 'none',
    },
    timeoutFloorMs: 900_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'Gemini',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    handler: null,
  },
  {
    // 1_200_000 rather than the 900_000 floor: headless Claude measured ~525 s
    // on a large plan set (review.md:304).
    slug: 'claude',
    flags: ['--claude'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'claude' },
    invoke: {
      binary: 'claude',
      args: ['-p', '-'],
      ...SPAWN_STDIN_STDOUT,
      modelArg: '--model',
      effortChannel: 'argv',
    },
    timeoutFloorMs: 1_200_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'Claude',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    handler: null,
  },
  {
    // Codex captures the review through its own `-o/--output-last-message` and
    // discards stdout, because on Windows it writes process-teardown noise to
    // stdout AFTER the final message, which a stdout redirect would append to a
    // non-empty file and slip past the empty-output guard (#1698).
    slug: 'codex',
    flags: ['--codex'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'codex' },
    invoke: {
      binary: 'codex',
      args: ['exec', '--ephemeral', '--skip-git-repo-check', '-'],
      promptChannel: 'stdin',
      outputChannel: 'file-arg',
      outputArg: '-o',
      modelArg: '--model',
      effortChannel: 'argv',
    },
    timeoutFloorMs: 1_200_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'Codex',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    handler: null,
  },
  {
    // Fed no prompt: CodeRabbit reviews the working-tree diff and accepts
    // neither a prompt nor a model flag (review.md:367). Its findings are
    // deliberately down-weighted in the consensus step.
    slug: 'coderabbit',
    flags: ['--coderabbit'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'coderabbit' },
    invoke: {
      binary: 'coderabbit',
      args: ['review', '--prompt-only'],
      promptChannel: 'none',
      outputChannel: 'stdout',
      modelArg: null,
      effortChannel: 'none',
    },
    timeoutFloorMs: 360_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'CodeRabbit',
    evidenceClass: 'diff-only',
    requiresBinaries: [],
    promptBudgetKey: null,
    handler: null,
  },
  {
    // `--format json` is the primary invocation, not a fallback: the review text
    // lives in assistant `text` parts, which the default formatter drops when the
    // agent stops with no final message (#1936). Reconstruction needs jq.
    slug: 'opencode',
    flags: ['--opencode'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'opencode' },
    invoke: {
      binary: 'opencode',
      args: ['run', '--format', 'json', '-'],
      ...SPAWN_STDIN_STDOUT,
      modelArg: '--model',
      effortChannel: 'argv',
    },
    timeoutFloorMs: 660_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'OpenCode',
    evidenceClass: 'source-grounded',
    requiresBinaries: ['jq'],
    promptBudgetKey: null,
    handler: null,
  },
  {
    slug: 'qwen',
    flags: ['--qwen'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'qwen' },
    invoke: {
      binary: 'qwen',
      args: ['-'],
      ...SPAWN_STDIN_STDOUT,
      modelArg: null,
      effortChannel: 'none',
    },
    timeoutFloorMs: 900_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'Qwen',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    handler: null,
  },
  {
    // `cursor-agent` is a SEPARATE binary from the `cursor` IDE launcher. Print
    // mode takes the prompt as an ARGUMENT, so a full plan set is passed by file
    // reference to stay clear of the 32,767-char Windows execFileSync ceiling.
    slug: 'cursor',
    flags: ['--cursor'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'cursor-agent' },
    invoke: {
      binary: 'cursor-agent',
      args: ['-p', '--mode', 'ask', '--trust', '--output-format', 'text'],
      promptChannel: 'argv-file-ref',
      outputChannel: 'stdout',
      modelArg: null,
      effortChannel: 'none',
    },
    timeoutFloorMs: 900_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'Cursor',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    handler: null,
  },
  {
    // Handler-owned: a three-layer fallback for an upstream stdout bug, a
    // two-level timeout (600 s external cap over a 540 s native --print-timeout),
    // and a stale-response watermark guard. `timeoutFloorMs` carries the OUTER
    // bound only; the inner one lives in the handler (ADR-2782 D6).
    slug: 'antigravity',
    flags: ['--antigravity', '--agy'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'agy' },
    invoke: {
      binary: 'agy',
      args: ['--print-timeout', '540s', '-p'],
      promptChannel: 'argv-file-ref',
      outputChannel: 'stdout',
      modelArg: '--model',
      effortChannel: 'none',
    },
    timeoutFloorMs: 600_000,
    emptyOutput: 'handler-owned',
    reviewsSection: 'Antigravity',
    evidenceClass: 'source-grounded',
    requiresBinaries: ['jq'],
    promptBudgetKey: null,
    handler: 'antigravity',
  },
  {
    slug: 'ollama',
    flags: ['--ollama'],
    transport: 'openai-http',
    probe: {
      kind: 'http-reachable',
      hostConfigKey: 'review.ollama_host',
      path: '/v1/models',
      timeoutMs: 2_000,
    },
    invoke: {
      hostConfigKey: 'review.ollama_host',
      path: '/v1/chat/completions',
      modelDiscovery: 'first-from-models-endpoint',
      effortChannel: 'none',
    },
    timeoutFloorMs: 120_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'Ollama',
    evidenceClass: 'source-grounded',
    requiresBinaries: ['jq'],
    promptBudgetKey: 'review.max_prompt_tokens_per_reviewer.ollama',
    handler: 'openai-compatible',
  },
  {
    slug: 'lm_studio',
    flags: ['--lm-studio'],
    transport: 'openai-http',
    probe: {
      kind: 'http-reachable',
      hostConfigKey: 'review.lm_studio_host',
      path: '/v1/models',
      timeoutMs: 2_000,
    },
    invoke: {
      hostConfigKey: 'review.lm_studio_host',
      path: '/v1/chat/completions',
      modelDiscovery: 'first-from-models-endpoint',
      effortChannel: 'none',
    },
    timeoutFloorMs: 120_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'LM Studio',
    evidenceClass: 'source-grounded',
    requiresBinaries: ['jq'],
    promptBudgetKey: 'review.max_prompt_tokens_per_reviewer.lm_studio',
    handler: 'openai-compatible',
  },
  {
    slug: 'llama_cpp',
    flags: ['--llama-cpp'],
    transport: 'openai-http',
    probe: {
      kind: 'http-reachable',
      hostConfigKey: 'review.llama_cpp_host',
      path: '/v1/models',
      timeoutMs: 2_000,
    },
    invoke: {
      hostConfigKey: 'review.llama_cpp_host',
      path: '/v1/chat/completions',
      modelDiscovery: 'first-from-models-endpoint',
      effortChannel: 'none',
    },
    timeoutFloorMs: 120_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'llama.cpp',
    evidenceClass: 'source-grounded',
    requiresBinaries: ['jq'],
    promptBudgetKey: 'review.max_prompt_tokens_per_reviewer.llama_cpp',
    handler: 'openai-compatible',
  },
].map((lane) => Object.freeze(lane)) as ReviewerLane[]);

/* ------------------------------------------------------------------ *
 * DEFECT.GENERATIVE-FIX parity (CONTEXT.md:797)
 * ------------------------------------------------------------------ */

/**
 * Frozen reason enum. Tests assert on these values, never on rendered prose —
 * CONTRIBUTING.md "Tests assert on typed structured values". Adding a reason is
 * three coordinated changes: this enum, the emitting site, and the test locking
 * `Object.keys(...).sort()`.
 */
export const PARITY_VIOLATION = Object.freeze({
  MALFORMED_LANE: 'malformed_lane',
  INVALID_SLUG: 'invalid_slug',
  ROSTER_SLUG_UNDECLARED: 'roster_slug_undeclared',
  DESCRIPTOR_LANE_NOT_IN_ROSTER: 'descriptor_lane_not_in_roster',
  LEG_MARKER_MISSING: 'leg_marker_missing',
  LEG_MARKER_DUPLICATED: 'leg_marker_duplicated',
  LEG_MARKER_UNDECLARED: 'leg_marker_undeclared',
  SECTION_MISSING: 'section_missing',
  SECTION_DUPLICATED: 'section_duplicated',
  SECTION_UNDECLARED: 'section_undeclared',
  DUPLICATE_SLUG: 'duplicate_slug',
  DUPLICATE_FLAG: 'duplicate_flag',
  DUPLICATE_SECTION: 'duplicate_section',
} as const);

export type ParityViolationReason =
  (typeof PARITY_VIOLATION)[keyof typeof PARITY_VIOLATION];

export interface ParityViolation {
  reason: ParityViolationReason;
  subject: string;
}

export interface ParityResult {
  ok: boolean;
  violations: ParityViolation[];
}

export interface ParityInput {
  descriptor: ReadonlyArray<ReviewerLane>;
  roster: ReadonlyArray<string>;
  /** Full text of gsd-core/workflows/review.md. */
  workflowText: string;
}

/**
 * The machine-readable marker that makes an `invoke_reviewers` leg identifiable.
 *
 * The legs are prose-labelled (`**Qwen Code:**`, `**LM Studio (local,
 * OpenAI-compatible):**`), and five NON-lane bold labels in the same step have
 * the identical bold-then-fence shape (`**Timeout guidance (#2194):**`,
 * `**No hook-trust bypass (#2479):**`, `**Maintainer note — …:**`). Inferring
 * legs from prose shape would be a heuristic asserting what it cannot prove, so
 * each leg carries an explicit marker instead. Phase 5b iterates on these.
 */
const LEG_MARKER_RE = /<!--\s*reviewer-lane:\s*([a-z0-9_-]+)\s*-->/g;

/**
 * The slug grammar, and the reason it is enforced rather than assumed.
 *
 * `LEG_MARKER_RE` can only capture `[a-z0-9_-]`. A lane whose slug falls outside
 * that class is therefore UNMATCHABLE in the workflow: its marker can be present
 * and correct and the scan will still never see it, so the lane reports
 * `LEG_MARKER_MISSING` forever with no indication why. All eleven shipped slugs
 * sit inside the class (`lm_studio`, `llama_cpp` use the underscore), so this
 * never bites today — but Phase 2 (#2795) admits third-party overlay lanes, and
 * a slug like `acme.reviewer` would silently vanish from a review.
 *
 * ADR-2782 does not specify a slug grammar. Rather than widen the marker regex —
 * which would make an HTML comment scanned out of prose more ambiguous, not less
 * — the grammar is pinned here and a violating slug is reported as
 * `INVALID_SLUG`. A loud, named violation beats a silent miss; that is the whole
 * design principle of this module.
 */
export const LANE_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * A lane section heading in write_reviews.
 *
 * Anchored at h2 with an exact ` Review` suffix and NO parenthetical, because:
 *   - `## OpenCode Review (opencode-deepseek)` is an ADR-1517 reviewer INSTANCE,
 *     and ADR-2782 D8 states instances are not lanes — two such headings are
 *     already in the file, so a naive matcher fails on day one;
 *   - `## Consensus Summary` has no ` Review` suffix;
 *   - `# Cross-AI Plan Review — Phase {N}` is h1, not h2.
 * `[^()\n]+` excludes the parenthetical form rather than stripping it, so an
 * instance heading never resolves to a lane.
 */
const SECTION_HEADING_RE = /^##[ \t]+([^()\n\r]+?) Review[ \t]*$/gm;

/** Bounds of the step a marker must appear inside. */
const INVOKE_STEP_RE = /<step name="invoke_reviewers">([\s\S]*?)<\/step>/;
const WRITE_STEP_RE = /<step name="write_reviews">([\s\S]*?)<\/step>/;

function sliceStep(workflowText: string, re: RegExp): string {
  const m = workflowText.match(re);
  return m ? m[1] : '';
}

function countOccurrences(haystack: string, re: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  // Fresh lastIndex per call — a module-level /g regex carries state between
  // calls and would silently skip matches on the second invocation.
  const scanner = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = scanner.exec(haystack)) !== null) {
    const key = m[1].trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Bidirectional parity across four surfaces: the descriptor, the roster
 * (`KNOWN_REVIEWER_SLUGS`), the `invoke_reviewers` legs, and the `write_reviews`
 * sections.
 *
 * Bidirectional is the point. A forward-only check ("does each declared lane
 * resolve?") misses the failure this exists to catch: #2718 added a lane leg and
 * #2781 was the documentation drift that followed. An undeclared leg must fail.
 *
 * Pure and total: never reads the filesystem, never throws. Empty or malformed
 * `workflowText` degrades to violations, so a caller cannot mistake a read
 * failure for a clean bill of health.
 *
 * CRLF-insensitive: `\r` is stripped before matching, because a Windows
 * autocrlf checkout would otherwise leave every marker and heading unmatched
 * and report the whole roster missing.
 */
export function checkReviewerLaneParity(input: ParityInput): ParityResult {
  const { descriptor, roster } = input;
  const workflowText = String(input.workflowText ?? '').replace(/\r\n/g, '\n');
  const violations: ParityViolation[] = [];

  const add = (reason: ParityViolationReason, subject: string): void => {
    violations.push({ reason, subject });
  };

  // --- D8 uniqueness within the descriptor itself ---
  //
  // Every field is validated before use rather than trusted. In Phase 1 the
  // descriptor is a frozen in-source table and none of these guards can fire,
  // but Phase 2 (#2795) feeds this same function manifest-derived data from
  // third-party overlays — which is precisely where a malformed entry arrives.
  // A checker that throws on bad input cannot report on it, and a parity gate
  // that crashes is indistinguishable from one that was never run.
  const seenSlug = new Set<string>();
  const seenFlag = new Set<string>();
  const seenSection = new Set<string>();

  /** A lane that survived validation: slug is a string in the declared grammar. */
  interface ValidatedLane {
    slug: string;
    reviewsSection: string | null;
  }
  const lanes: ValidatedLane[] = [];

  // The declared parameter type says `ReviewerLane[]`, but this function is a
  // trust boundary — narrow from `unknown` rather than believing the annotation.
  const rawLanes: unknown[] = Array.isArray(descriptor) ? (descriptor as unknown[]) : [];
  for (const raw of rawLanes) {
    if (raw === null || typeof raw !== 'object') {
      add(PARITY_VIOLATION.MALFORMED_LANE, String(raw));
      continue;
    }
    const lane = raw as Record<string, unknown>;
    const slug = lane.slug;
    if (typeof slug !== 'string' || !LANE_SLUG_RE.test(slug)) {
      add(PARITY_VIOLATION.INVALID_SLUG, String(slug));
      continue;
    }
    const section = typeof lane.reviewsSection === 'string' ? lane.reviewsSection : null;
    lanes.push({ slug, reviewsSection: section });

    if (seenSlug.has(slug)) add(PARITY_VIOLATION.DUPLICATE_SLUG, slug);
    seenSlug.add(slug);

    const flags: unknown[] = Array.isArray(lane.flags) ? (lane.flags as unknown[]) : [];
    for (const flag of flags) {
      if (typeof flag !== 'string') continue;
      if (seenFlag.has(flag)) add(PARITY_VIOLATION.DUPLICATE_FLAG, flag);
      seenFlag.add(flag);
    }

    // Two lanes sharing a heading would silently MERGE their output in
    // REVIEWS.md, producing a review that appears to have consensus it does
    // not have (ADR-2782 D8).
    if (section !== null) {
      if (seenSection.has(section)) add(PARITY_VIOLATION.DUPLICATE_SECTION, section);
      seenSection.add(section);
    }
  }

  // --- descriptor <-> roster ---
  const rosterSet = new Set(
    (Array.isArray(roster) ? roster : []).filter((x): x is string => typeof x === 'string'),
  );
  for (const slug of rosterSet) {
    if (!seenSlug.has(slug)) add(PARITY_VIOLATION.ROSTER_SLUG_UNDECLARED, slug);
  }
  for (const slug of seenSlug) {
    if (!rosterSet.has(slug)) add(PARITY_VIOLATION.DESCRIPTOR_LANE_NOT_IN_ROSTER, slug);
  }

  // --- descriptor <-> invoke_reviewers legs ---
  const markerCounts = countOccurrences(
    sliceStep(workflowText, INVOKE_STEP_RE),
    LEG_MARKER_RE,
  );
  for (const lane of lanes) {
    const n = markerCounts.get(lane.slug) ?? 0;
    if (n === 0) add(PARITY_VIOLATION.LEG_MARKER_MISSING, lane.slug);
    else if (n > 1) add(PARITY_VIOLATION.LEG_MARKER_DUPLICATED, lane.slug);
  }
  for (const slug of markerCounts.keys()) {
    if (!seenSlug.has(slug)) add(PARITY_VIOLATION.LEG_MARKER_UNDECLARED, slug);
  }

  // --- descriptor <-> write_reviews sections ---
  const sectionCounts = countOccurrences(
    sliceStep(workflowText, WRITE_STEP_RE),
    SECTION_HEADING_RE,
  );
  for (const lane of lanes) {
    if (lane.reviewsSection === null) continue;
    const n = sectionCounts.get(lane.reviewsSection) ?? 0;
    if (n === 0) add(PARITY_VIOLATION.SECTION_MISSING, lane.reviewsSection);
    else if (n > 1) add(PARITY_VIOLATION.SECTION_DUPLICATED, lane.reviewsSection);
  }
  for (const section of sectionCounts.keys()) {
    if (!seenSection.has(section)) add(PARITY_VIOLATION.SECTION_UNDECLARED, section);
  }

  return { ok: violations.length === 0, violations };
}
