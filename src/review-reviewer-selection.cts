/**
 * Review Reviewer Selection Module (ADR-457 build-at-publish: the hand-written
 * bin/lib/review-reviewer-selection.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * Owns reviewer-selection policy projection for /gsd:review:
 * explicit flags > --all > review.default_reviewers > all detected.
 *
 * Reviewer instances (#1517): a bounded config surface
 * `review.reviewer_instances.<name> = {cli, model?, agent?}` lets one
 * model-capable adapter (e.g. opencode) run as several independent reviewer
 * identities. Instances participate ONLY in the config_default branch (no
 * per-instance CLI flags). An instance is available iff its base `cli` is
 * detected. The instance→cli mapping lives HERE (single source; see the parity
 * test in tests/review-reviewer-instances.test.cjs — DEFECT.GENERATIVE-FIX).
 *
 * KNOWN_REVIEWER_SLUGS (post-review #2092): registry-derived, not a flat
 * hand-maintained array. Each capability-runtime descriptor that is a valid
 * reviewer CLI declares `runtime.hostBehaviors.reviewerCli: true`
 * (capabilities/<id>/capability.json); this module reads that flag off the
 * generated capability-registry.cjs at require-time. A handful of reviewer
 * CLIs are NOT install-time runtimes at all (no capabilities/<id>/ descriptor
 * exists) — those stay a small hardcoded tail:
 *   - `gemini` — hook-event dialect name only (see runtime-hooks-surface.cts);
 *     the Gemini CLI reviewer is not an installable runtime (#1928 folded
 *     gemini into antigravity's descriptor).
 *   - `coderabbit` / `ollama` / `lm_studio` / `llama_cpp` — third-party
 *     review/model CLIs with no GSD install surface at all.
 */

const NON_RUNTIME_REVIEWER_SLUGS: ReadonlyArray<string> = [
  'gemini',
  'coderabbit',
  'ollama',
  'lm_studio',
  'llama_cpp',
];

function deriveRuntimeReviewerSlugs(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('./capability-registry.cjs') as {
    runtimes?: Record<string, { runtime?: { hostBehaviors?: { reviewerCli?: boolean } } }>;
  };
  const runtimes = registry.runtimes || {};
  return Object.keys(runtimes).filter(
    (id) => runtimes[id]?.runtime?.hostBehaviors?.reviewerCli === true,
  );
}

export const KNOWN_REVIEWER_SLUGS: ReadonlyArray<string> = [
  ...deriveRuntimeReviewerSlugs(),
  ...NON_RUNTIME_REVIEWER_SLUGS,
];

/** Instance names are lowercase slugs that must not shadow a built-in slug. */
export const INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface NormalizedDefaultReviewers {
  absent: boolean;
  values: string[];
  errors: string[];
}

export interface ReviewerInstance {
  cli: string;
  model?: string;
  agent?: string;
}

export interface NormalizedReviewerInstances {
  instances: Record<string, ReviewerInstance>;
  errors: string[];
}

export interface ResolvedReviewer {
  identity: string;
  kind: 'builtin' | 'instance';
  cli: string;
  model?: string;
  agent?: string;
}

export interface ReviewerSelectionInput {
  detected?: unknown[];
  explicitFlags?: unknown[];
  allFlag?: unknown;
  configuredDefaultReviewers?: unknown;
  /** #1517: the `review.reviewer_instances` config object. */
  reviewerInstances?: unknown;
}

export interface ReviewerSelectionResult {
  source: string;
  selected: string[];
  warnings: string[];
  infos: string[];
  errors: string[];
  /** #1517: per-identity resolution (builtin slug or expanded instance). */
  resolvedInstances: ResolvedReviewer[];
  /** #1517: true when ≥2 selected instances share a base cli (consensus caveat). */
  sharedAdapterCaveat: boolean;
}

export function normalizeConfiguredDefaultReviewers(
  rawValue: unknown,
): NormalizedDefaultReviewers {
  if (rawValue === undefined || rawValue === null) {
    return { absent: true, values: [], errors: [] };
  }
  if (!Array.isArray(rawValue)) {
    return {
      absent: false,
      values: [],
      errors: ['review.default_reviewers must be a JSON array of reviewer slugs'],
    };
  }
  if (rawValue.length === 0) {
    return {
      absent: false,
      values: [],
      errors: ['review.default_reviewers cannot be empty'],
    };
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  const errors: string[] = [];
  for (const item of rawValue) {
    if (typeof item !== 'string') {
      errors.push('review.default_reviewers must contain only string slugs');
      continue;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(item)) {
      errors.push(`invalid reviewer slug in review.default_reviewers: ${item}`);
      continue;
    }
    const slug = item.toLowerCase();
    if (!seen.has(slug)) {
      seen.add(slug);
      normalized.push(slug);
    }
  }

  return { absent: false, values: normalized, errors };
}

/**
 * Validate the `review.reviewer_instances` config object (#1517).
 * `cli` MUST be a known adapter (never an arbitrary shell command — Kerckhoffs /
 * Postel: strict at the invocation boundary). `model`/`agent` are opaque
 * pass-through strings; they are never interpolated into shell strings by this
 * module. Instance names must not collide with a built-in slug.
 */
export function normalizeReviewerInstances(
  rawValue: unknown,
): NormalizedReviewerInstances {
  if (rawValue === undefined || rawValue === null) {
    return { instances: {}, errors: [] };
  }
  if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return {
      instances: {},
      errors: ['review.reviewer_instances must be a JSON object mapping instance names to {cli,model,agent}'],
    };
  }

  const obj = rawValue as Record<string, unknown>;
  const instances: Record<string, ReviewerInstance> = {};
  const errors: string[] = [];

  for (const [name, spec] of Object.entries(obj)) {
    if (!INSTANCE_NAME_PATTERN.test(name)) {
      errors.push(
        `invalid reviewer instance name '${name}': must match ^[a-z0-9][a-z0-9-]*$`,
      );
      continue;
    }
    if (KNOWN_REVIEWER_SLUGS.includes(name)) {
      errors.push(
        `reviewer instance name '${name}' must not equal a built-in reviewer slug`,
      );
      continue;
    }
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push(`reviewer_instances.${name} must be an object with at least {cli}`);
      continue;
    }
    const s = spec as Record<string, unknown>;
    const cli = s.cli;
    if (typeof cli !== 'string' || !KNOWN_REVIEWER_SLUGS.includes(cli)) {
      errors.push(
        `reviewer_instances.${name}.cli must be a known reviewer adapter (got: ${JSON.stringify(cli)})`,
      );
      continue;
    }
    const instance: ReviewerInstance = { cli };
    if (s.model !== undefined && s.model !== null) {
      if (typeof s.model !== 'string') {
        errors.push(`reviewer_instances.${name}.model must be a string`);
        continue;
      }
      instance.model = s.model;
    }
    if (s.agent !== undefined && s.agent !== null) {
      if (typeof s.agent !== 'string') {
        errors.push(`reviewer_instances.${name}.agent must be a string`);
        continue;
      }
      instance.agent = s.agent;
    }
    instances[name] = instance;
  }

  return { instances, errors };
}

export function resolveReviewerSelection(
  input: ReviewerSelectionInput,
): ReviewerSelectionResult {
  const detected = new Set(
    (input.detected ?? []).map((v) => String(v).toLowerCase()),
  );
  const explicitFlags = new Set(
    (input.explicitFlags ?? []).map((v) => String(v).toLowerCase()),
  );
  const allFlag = !!input.allFlag;
  const normalizedDefaults = normalizeConfiguredDefaultReviewers(
    input.configuredDefaultReviewers,
  );
  const normalizedInstances = normalizeReviewerInstances(input.reviewerInstances);
  const instances = normalizedInstances.instances;
  const instancesConfigured = Object.keys(instances).length > 0;

  const warnings: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [...normalizedDefaults.errors, ...normalizedInstances.errors];

  let source = 'no_config_all_detected';
  let selected: string[] = [];

  if (explicitFlags.size > 0) {
    source = 'explicit_flags';
    // ADR-2782 D4: absent-safe governs DISCOVERY, never explicit selection.
    // Not finding a lane nobody asked for is normal; failing to run a lane
    // somebody asked for is an error. Every miss used to be an `info`, so a
    // PARTIAL miss (`--gemini --qwen` with qwen absent) ran the review with a
    // thinner reviewer set while present_results reported success — "a cross-AI
    // review that silently drops a lane is blind in one eye" (review.md).
    // A total miss already errored, but only as a side effect of the selected
    // set being empty; the partial case had no signal at all.
    const priorErrorCount = errors.length;
    selected = [...explicitFlags].filter((slug) => detected.has(slug));
    // Sorted so the error order does not depend on flag order on the command line.
    const missing = [...explicitFlags].filter((slug) => !detected.has(slug)).sort();
    for (const slug of missing) {
      errors.push(`explicit reviewer '${slug}' is not available on this host`);
    }
    // Guarded on the error count as it stood BEFORE this branch, so the
    // aggregate message fires under exactly the conditions it did previously.
    // Guarding on `errors.length` would let the per-slug errors just pushed
    // suppress it, silently dropping a message this change did not intend to
    // remove.
    if (selected.length === 0 && priorErrorCount === 0) {
      errors.push('no selected reviewers are available for explicit flags');
    }
  } else if (allFlag) {
    source = 'all_flag';
    selected = [...detected];
  } else if (!normalizedDefaults.absent) {
    source = 'config_default';
    // #1517: expand instance references BEFORE the built-in-slug check. An
    // instance name and a built-in slug are the two legal kinds of entry.
    for (const entry of normalizedDefaults.values) {
      if (instances[entry]) {
        // Instance reference — available iff its base cli is detected.
        const cli = instances[entry].cli;
        if (!detected.has(cli)) {
          infos.push(`configured instance ${entry} not detected (cli ${cli} missing on this host)`);
        } else {
          selected.push(entry);
        }
      } else if (KNOWN_REVIEWER_SLUGS.includes(entry)) {
        if (!detected.has(entry)) {
          infos.push(`configured reviewers not detected on this host: ${entry}`);
        } else {
          selected.push(entry);
        }
      } else {
        // Neither a defined instance nor a built-in slug.
        if (instancesConfigured) {
          // Most likely a typo'd instance name — must be loud (#1517 design Q2).
          errors.push(
            `reviewer instance '${entry}' referenced in review.default_reviewers is not defined in review.reviewer_instances`,
          );
        } else {
          // Backward-compatible behaviour: unknown slug with no instances
          // configured warns and is dropped.
          warnings.push(`unknown reviewer slug in review.default_reviewers: ${entry}`);
        }
      }
    }
    if (selected.length === 0 && errors.length === 0) {
      errors.push('all configured default reviewers are unavailable on this host');
    }
  } else {
    selected = [...detected];
  }

  const selectedSorted = selected.sort();

  // Single-source instance→cli resolution projected onto the selected set.
  const resolvedInstances: ResolvedReviewer[] = selectedSorted.map((identity) => {
    const inst = instances[identity];
    if (inst) {
      return {
        identity,
        kind: 'instance' as const,
        cli: inst.cli,
        model: inst.model,
        agent: inst.agent,
      };
    }
    return { identity, kind: 'builtin' as const, cli: identity };
  });

  const cliCounts: Record<string, number> = {};
  for (const r of resolvedInstances) {
    if (r.kind === 'instance') {
      cliCounts[r.cli] = (cliCounts[r.cli] ?? 0) + 1;
    }
  }
  const sharedAdapterCaveat = Object.values(cliCounts).some((c) => c >= 2);

  return {
    source,
    selected: selectedSorted,
    warnings,
    infos,
    errors,
    resolvedInstances,
    sharedAdapterCaveat,
  };
}
