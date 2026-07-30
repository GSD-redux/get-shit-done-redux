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

/**
 * ADR-2782 D6 — closed enum of first-party imperative modules. Ported in Phase 5b.
 *
 * `'opencode'` was added by Phase 5b (#2799) as an additive widening, forced by a lane that ships
 * today. Phase 1 declared `opencode.handler = null`, but the lane's review is RECONSTRUCTED from
 * assistant `text` parts of a `--format json` stream — `--format json` is the primary invocation,
 * not a fallback, because the default formatter drops the text when the agent ends its turn with no
 * final message (#1936). A data-driven `outputChannel: 'stdout'` copy would write the raw JSON
 * envelope into REVIEWS.md as the review, straight back into #1936.
 *
 * The alternative — an `outputChannel: 'json-parts'` member — was rejected: it pushes a parsing
 * language into the descriptor and would want a selector expression next. D6's whole point is that
 * divergence escapes to NAMED FIRST-PARTY CODE rather than accreting inside data.
 */
export type LaneHandler = null | 'antigravity' | 'openai-compatible' | 'opencode';

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

/**
 * Argv placeholders (Phase 5b, #2799).
 *
 * `args` is an argv TEMPLATE, not a prefix. The injected pieces — model, effort, output file,
 * argv-borne prompt — do not all go in the same place, and no positional rule expresses that:
 * `codex` injects the model in the MIDDLE (after the `exec --ephemeral` subcommand) and the output
 * file later still, while `gemini` injects the model first and five lanes end with a bare `-` that
 * must stay last. Splicing by position silently produced
 * `codex --model M -o F exec --ephemeral …`, which is not a valid codex invocation.
 *
 * So each lane declares WHERE each piece goes. A placeholder expands to zero or more argv elements
 * and vanishes when it has nothing to contribute (no model configured, no effort channel, prompt on
 * stdin), which is what lets one template serve the configured and unconfigured cases.
 *
 * This is a closed four-member vocabulary with no expressions, no nesting and no conditionals — a
 * placeholder set, deliberately not a template language. The moment it needs a conditional, the
 * lane wants a `handler` instead (D6).
 */
export const ARGV_PLACEHOLDER = Object.freeze({
  /** `modelArg` + the resolved model, or nothing. */
  MODEL: '{{model}}',
  /** The host's effort argv, or nothing unless `effortChannel` is `argv`. */
  EFFORT: '{{effort}}',
  /** `outputArg` + the review path, or nothing unless `outputChannel` is `file-arg`. */
  OUTPUT: '{{output}}',
  /** The argv-borne prompt, or nothing unless `promptChannel` is `argv`/`argv-file-ref`. */
  PROMPT: '{{prompt}}',
} as const);

export interface SpawnInvoke {
  binary: string;
  /** Argv template — see `ARGV_PLACEHOLDER`. Order here is the order the tool receives. */
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
  /**
   * Base URL used when `hostConfigKey` resolves to empty.
   *
   * Added by Phase 5b (#2799). Phase 4 federated every `*_host` key with a default of `""`, so the
   * REAL fallback (`http://localhost:11434` and friends) only ever existed inside the bash leg. A
   * data-driven lane with an empty host and no declared default would POST to a garbage URL, so
   * the fallback has to be declared somewhere — and the lane is the only thing that knows it.
   */
  defaultHost: string;
  path: string;
  modelDiscovery: 'none' | 'first-from-models-endpoint';
  /** Model used when neither config nor discovery yields one. */
  fallbackModel: string;
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
  /**
   * Dotted config key holding this lane's model override, or null when the lane accepts none.
   *
   * Added by Phase 5b (#2799). Phase 1 left the model key IMPLICIT (`review.models.<slug>`), and
   * that convention is wrong for a lane that ships today: `antigravity`'s slug is `antigravity` but
   * its key is `review.models.agy` (`review.md:291`, and Phase 4 federated it under that exact
   * name). Resolving by slug would look up `review.models.antigravity`, miss, and silently ignore a
   * configured model — the pinned-model escape hatch #2073 added precisely so a 404ing default can
   * be overridden.
   *
   * Declared rather than derived, for the same reason `promptBudgetKey` is: the key is data about
   * the lane, and a naming convention that one shipped lane already breaks is not a contract.
   */
  modelConfigKey: string | null;
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
 * The twelve declared lanes, in `write_reviews` order.
 *
 * `kimi-code` joined in Phase 5b (#2799, closes #2718) — ADR-2782's phase table lands it here
 * rather than in 5a precisely so it arrives together with the iteration that can invoke it.
 */
export const REVIEWER_LANES: ReadonlyArray<ReviewerLane> = Object.freeze([
  {
    slug: 'gemini',
    flags: ['--gemini'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'gemini' },
    invoke: {
      binary: 'gemini',
      args: ['{{model}}', '-p', '-'],
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
    modelConfigKey: 'review.models.gemini',
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
      args: ['{{model}}', '{{effort}}', '-p', '-'],
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
    modelConfigKey: 'review.models.claude',
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
      // Leg order exactly: codex exec --ephemeral --model M $EFFORT --skip-git-repo-check -o F -
      args: ['exec', '--ephemeral', '{{model}}', '{{effort}}', '--skip-git-repo-check', '{{output}}', '-'],
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
    modelConfigKey: 'review.models.codex',
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
    // Accepts no model flag at all (review.md:367) — not merely "none configured".
    modelConfigKey: null,
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
      args: ['run', '{{model}}', '{{effort}}', '--format', 'json', '-'],
      ...SPAWN_STDIN_STDOUT,
      modelArg: '--model',
      effortChannel: 'argv',
    },
    timeoutFloorMs: 660_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'OpenCode',
    evidenceClass: 'source-grounded',
    // Phase 5b: the handler reconstructs from the JSON stream with JSON.parse, so `jq` — absent on
    // stock Windows/Git-Bash (#2589) — is no longer a prerequisite for this lane.
    requiresBinaries: [],
    promptBudgetKey: null,
    modelConfigKey: 'review.models.opencode',
    // Phase 5b (#2799): was `null`. The review is REBUILT from assistant `text` parts; a plain
    // stdout copy would write the raw JSON envelope as the review (#1936). See LaneHandler.
    handler: 'opencode',
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
    modelConfigKey: null,
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
      args: ['-p', '--mode', 'ask', '--trust', '--output-format', 'text', '{{prompt}}'],
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
    modelConfigKey: null,
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
      args: ['--print-timeout', '540s', '{{model}}', '-p', '{{prompt}}'],
      promptChannel: 'argv-file-ref',
      outputChannel: 'stdout',
      modelArg: '--model',
      effortChannel: 'none',
    },
    timeoutFloorMs: 600_000,
    emptyOutput: 'handler-owned',
    reviewsSection: 'Antigravity',
    evidenceClass: 'source-grounded',
    // Phase 5b: the handler reads the transcript with JSON.parse per line, not `jq`.
    requiresBinaries: [],
    promptBudgetKey: null,
    // NOT `review.models.antigravity` — the shipped key is `review.models.agy` (review.md:291) and
    // Phase 4 federated it under that name. This lane is why the key is declared, not derived.
    modelConfigKey: 'review.models.agy',
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
      defaultHost: 'http://localhost:11434',
      path: '/v1/chat/completions',
      modelDiscovery: 'first-from-models-endpoint',
      fallbackModel: 'llama3',
      effortChannel: 'none',
    },
    timeoutFloorMs: 120_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'Ollama',
    evidenceClass: 'source-grounded',
    // Phase 5b: the openai-compatible handler speaks HTTP directly and parses with JSON.parse, so
    // neither `jq` nor `curl` is a prerequisite any more (#2589's stated Windows hazard).
    requiresBinaries: [],
    promptBudgetKey: 'review.max_prompt_tokens_per_reviewer.ollama',
    modelConfigKey: 'review.models.ollama',
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
      defaultHost: 'http://localhost:1234',
      path: '/v1/chat/completions',
      modelDiscovery: 'first-from-models-endpoint',
      fallbackModel: 'local-model',
      effortChannel: 'none',
    },
    timeoutFloorMs: 120_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'LM Studio',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: 'review.max_prompt_tokens_per_reviewer.lm_studio',
    modelConfigKey: 'review.models.lm_studio',
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
      defaultHost: 'http://localhost:8080',
      path: '/v1/chat/completions',
      modelDiscovery: 'first-from-models-endpoint',
      fallbackModel: 'local-model',
      effortChannel: 'none',
    },
    timeoutFloorMs: 120_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'llama.cpp',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: 'review.max_prompt_tokens_per_reviewer.llama_cpp',
    modelConfigKey: 'review.models.llama_cpp',
    handler: 'openai-compatible',
  },
  {
    // Phase 5b (#2799) — closes #2718. Net-new in this phase BY DESIGN (ADR-2782's phase table):
    // declaring it in 5a would have made it selectable but not invocable, producing an empty
    // section for the whole 5a → 5b window.
    //
    // The probe is `command-capability`, not `command-exists`, and that is the entire reason D7's
    // vocabulary ships wider than existence: `kimi` is claimed by BOTH the Kimi Code CLI (Node) and
    // the legacy Python kimi-cli, which is a separate first-party runtime capability in this repo.
    // An existence-only probe registers the wrong tool. The needle `--output-format` appears in
    // Kimi Code's `--help` and is absent from the legacy CLI (whose headless flags are `--print` /
    // `--work-dir`). Verified in both directions against Kimi Code CLI 0.29.2 and a stub legacy
    // binary in closed PR #2776 — analysis carried forward with credit to @drungrin.
    //
    // The original probe there was an UNBOUNDED `kimi --help | grep` that ran on EVERY /gsd:review
    // regardless of flags: a live instance of this repo's named Unbounded Subprocesses defect, and
    // the review blocker. Here the bound is declared (`timeoutMs`) and the runner enforces it, and
    // the probe runs only for a SELECTED lane.
    slug: 'kimi-code',
    flags: ['--kimi-code'],
    transport: 'spawn',
    probe: {
      kind: 'command-capability',
      binary: 'kimi',
      needle: '--output-format',
      timeoutMs: 5_000,
    },
    invoke: {
      // Print mode takes the prompt as an ARGUMENT, so the full plan set goes by file reference to
      // stay clear of the 32,767-char Windows execFileSync ceiling — same shape as cursor.
      binary: 'kimi',
      args: ['{{model}}', '-p', '{{prompt}}'],
      promptChannel: 'argv-file-ref',
      outputChannel: 'stdout',
      modelArg: '-m',
      effortChannel: 'none',
    },
    timeoutFloorMs: 900_000,
    emptyOutput: 'stub-with-stderr',
    reviewsSection: 'Kimi Code',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    modelConfigKey: 'review.models.kimi-code',
    handler: null,
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
  REGISTRY_LANE_UNDECLARED: 'registry_lane_undeclared',
  DESCRIPTOR_LANE_NOT_IN_REGISTRY: 'descriptor_lane_not_in_registry',
  BESPOKE_LEG_PRESENT: 'bespoke_leg_present',
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
  /**
   * Reviewer slugs declared by `reviewer` bodies in the GENERATED capability registry.
   *
   * Phase 5b (#2799). Once `invoke_reviewers` iterates lanes, the registry — not the workflow text —
   * is what actually decides which lanes exist at runtime, so this is the surface parity has to
   * bind. A missing or malformed value degrades to violations rather than silence, exactly as
   * `workflowText` does: a checker that cannot tell "no registry" from "registry agrees" is worse
   * than no checker.
   */
  registry: ReadonlyArray<string>;
  /** Full text of gsd-core/workflows/review.md. */
  workflowText: string;
}

/**
 * The marker that used to make a hand-authored `invoke_reviewers` leg identifiable.
 *
 * Phase 5b (#2799) deleted every bespoke leg, so this regex flipped polarity: matching one is now
 * the VIOLATION (`BESPOKE_LEG_PRESENT`) rather than the requirement. It is retained precisely
 * because deleting it would leave nothing stopping a future contributor from quietly re-adding a
 * per-CLI block — which is the drift (#2718 → #2781) this whole epic exists to end.
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

/** Bounds of the step a bespoke leg marker could appear inside. */
const INVOKE_STEP_RE = /<step name="invoke_reviewers">([\s\S]*?)<\/step>/;

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
 * Bidirectional parity across three surfaces: the descriptor, the roster
 * (`KNOWN_REVIEWER_SLUGS`), and the generated capability **registry** — plus one anti-parity
 * assertion against the workflow.
 *
 * **Re-pointed by Phase 5b (#2799).** Through Phase 5a this function also required a literal
 * `<!-- reviewer-lane: <slug> -->` per lane inside `invoke_reviewers` and a literal
 * `## <Section> Review` per lane inside `write_reviews`. Phase 5b deletes exactly that text: the
 * workflow now iterates declared lanes and renders sections from `reviewsSection`, so there is no
 * per-lane text left to scan. Those two families could not be kept without keeping the
 * hand-maintained per-lane blocks this epic exists to delete.
 *
 * What replaced them is the parity that is actually load-bearing once lanes are data: the registry
 * is what decides which lanes exist at runtime, so `descriptor ↔ registry` is checked in both
 * directions. That is also the mechanical single source #2781/Phase 6 needs for its docs and locale
 * gate, which per-leg text could never provide.
 *
 * Bidirectional is still the point. A forward-only check ("does each declared lane resolve?")
 * misses the failure this exists to catch: #2718 added a lane and #2781 was the documentation drift
 * that followed. A registry lane nobody declared must fail, and so must a re-added bespoke leg.
 *
 * Pure and total: never reads the filesystem, never throws. Empty or malformed `workflowText` /
 * `registry` degrades to violations, so a caller cannot mistake a read failure for a clean bill of
 * health.
 *
 * CRLF-insensitive: `\r` is stripped before matching, because a Windows autocrlf checkout would
 * otherwise leave every marker unmatched.
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

  // --- descriptor <-> registry ---
  //
  // The registry is what decides which lanes exist at runtime once the workflow iterates, so this
  // replaces the per-leg text checks Phase 5b deleted. A non-array degrades to an empty set, which
  // then reports every descriptor lane as missing — loud, not silent.
  const registrySet = new Set(
    (Array.isArray(input.registry) ? input.registry : []).filter(
      (x): x is string => typeof x === 'string',
    ),
  );
  for (const slug of registrySet) {
    if (!seenSlug.has(slug)) add(PARITY_VIOLATION.REGISTRY_LANE_UNDECLARED, slug);
  }
  for (const slug of seenSlug) {
    if (!registrySet.has(slug)) add(PARITY_VIOLATION.DESCRIPTOR_LANE_NOT_IN_REGISTRY, slug);
  }

  // --- anti-parity: no bespoke leg may return ---
  //
  // Phase 5b deleted every hand-authored per-CLI block. Nothing in the type system stops a future
  // contributor from adding one back, and a re-added block is invisible to every other check here
  // (it would still be declared, still be in the roster, still be in the registry). Matching a leg
  // marker is therefore now the violation.
  const markerSlugs = countOccurrences(sliceStep(workflowText, INVOKE_STEP_RE), LEG_MARKER_RE);
  for (const slug of markerSlugs.keys()) {
    add(PARITY_VIOLATION.BESPOKE_LEG_PRESENT, slug);
  }

  return { ok: violations.length === 0, violations };
}
