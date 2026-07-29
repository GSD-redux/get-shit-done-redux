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
 * KNOWN_REVIEWER_SLUGS (ADR-2782 D9, Phase 5a #2798): derived from declared
 * `reviewer` bodies in the capability registry, not a hand-maintained tail.
 * A capability of EITHER `role: "runtime"` (the six dual-purpose hosts —
 * antigravity/claude/codex/cursor/opencode/qwen) or the lane-only
 * `role: "reviewer"` (gemini/coderabbit/ollama/lm_studio/llama_cpp) may carry
 * a `reviewer` body, and it is the body's `reviewer.slug` — NOT the capability
 * id — that becomes the roster entry: the two differ for `lm-studio` (id) /
 * `lm_studio` (slug) and `llama-cpp` (id) / `llama_cpp` (slug), ADR-2782's
 * three-namespace trap (`id` must be kebab; `slug` keeps the shipped roster's
 * snake form).
 *
 * `runtime.hostBehaviors.reviewerCli: true` survives as a DERIVED LEGACY ALIAS
 * for one release (D9): a capability that only sets the flag (no `reviewer`
 * body yet) still contributes its capability id as a slug, exactly as before
 * this phase. Where a capability carries BOTH a declared body and the alias,
 * the BODY WINS — that capability contributes only the body's slug, never
 * both. Alias removal is a named later phase (#2801), not done here.
 *
 * Before this phase the five non-runtime reviewers (`gemini`, `coderabbit`,
 * `ollama`, `lm_studio`, `llama_cpp`) had no `capabilities/<id>/` descriptor at
 * all and were a hardcoded `NON_RUNTIME_REVIEWER_SLUGS` tail. Phase 5a gives
 * each one a lane-only `role: "reviewer"` capability (ADR-2782 D3), so the
 * tail is deleted outright. See
 * `docs/adr/2782-reviewer-lane-capability-surface.md`.
 */

interface RegistryReviewerCapability {
  reviewer?: { slug?: unknown };
  runtime?: { hostBehaviors?: { reviewerCli?: unknown } };
}

interface ReviewerCapabilityRegistry {
  capabilities?: Record<string, RegistryReviewerCapability>;
}

/**
 * Derive the reviewer-slug roster from a capability registry.
 *
 * Exported (rather than a require()-time-only side effect) so tests can
 * exercise the derivation directly against a synthetic registry — the real
 * roster below is a single call against the generated
 * `capability-registry.cjs`, and `tests/review-lane-descriptor.test.cjs`'s
 * `checkReviewerLaneParity` separately guards that the real roster still
 * agrees with `src/review-lane-descriptor.cts` and the workflow.
 *
 * Reads `registry.capabilities` — every declared capability regardless of
 * role — because a `role: "reviewer"` lane-only capability is never stored in
 * `registry.runtimes` (that map is role:"runtime" only). Per capability: a
 * declared `reviewer.slug` wins outright (D9) and the capability contributes
 * ONLY that slug; only when there is no body does the legacy
 * `hostBehaviors.reviewerCli` alias contribute the capability id instead. The
 * result is collected into a Set (so a slug can never appear twice, even if
 * two distinct capabilities somehow named the same one) and returned as a
 * SORTED array, so the roster's order never depends on `Object.entries()`
 * iteration / registry build order.
 */
export function deriveReviewerSlugs(registry: ReviewerCapabilityRegistry): string[] {
  const capabilities = registry.capabilities || {};
  const slugs = new Set<string>();
  for (const [capId, cap] of Object.entries(capabilities)) {
    // Trim before the emptiness test: `length > 0` alone admits a whitespace-only
    // slug ("   ") verbatim into the roster, where it can never match a real lane
    // but still occupies a roster entry. Unreachable through the checked-in
    // registry today, but this function is EXPORTED for reuse and carries no
    // other validation, so it should not depend on its caller's hygiene.
    const rawSlug = cap?.reviewer?.slug;
    const declaredSlug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
    if (declaredSlug.length > 0) {
      slugs.add(declaredSlug);
      continue; // the body wins — never ALSO add this capability's alias below.
    }
    if (cap?.runtime?.hostBehaviors?.reviewerCli === true) {
      slugs.add(capId);
    }
  }
  return [...slugs].sort();
}

/**
 * The roster, derived once at module load.
 *
 * GUARDED, because this runs at `require()` time: an uncaught throw here does not
 * degrade reviewer selection, it breaks `require()` of this module for EVERY
 * consumer. The sibling `capability-trust.cjs` already holds this line — its
 * `discloseExecutableSurfaces` is documented "TOTAL: never throws, for any
 * manifest shape" and wrapped accordingly — and this module handles the same
 * class of registry-derived input, so it should not be the asymmetric one.
 *
 * A malformed registry yields an EMPTY roster rather than a crash. That is a
 * visible degradation, not a silent one: under ADR-2782 D4 an explicitly
 * requested reviewer that is unavailable is an ERROR, so `/gsd:review --claude`
 * against an empty roster fails loudly instead of quietly reviewing with nobody.
 *
 * Unreachable through the checked-in registry today (it is generated, JSON-sourced
 * and code-reviewed, so it cannot carry a getter or a Proxy). Guarded anyway —
 * reachability analysis is not a contract, and the next caller should not have to
 * redo it.
 */
export const KNOWN_REVIEWER_SLUGS: ReadonlyArray<string> = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return deriveReviewerSlugs(require('./capability-registry.cjs') as ReviewerCapabilityRegistry);
  } catch {
    return [];
  }
})();

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
