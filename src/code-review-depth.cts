/**
 * Path-scoped code-review depth resolution for #2554 (ADR-457 build-at-publish:
 * a pure TypeScript source of truth compiled to
 * gsd-core/bin/lib/code-review-depth.cjs).
 *
 * Zero I/O, zero clock, zero deps. Resolves the effective review depth
 * (`quick` | `standard` | `deep`) from, in priority order: the `--depth=`
 * invocation flag, the strongest matching path-scoped rule in
 * `workflow.code_review_depth_overrides`, the global `workflow.code_review_depth`
 * config value, and finally the `standard` default — then applies the
 * pre-existing large-scope `deep` → `standard` downgrade.
 *
 * See .gsd/phase/feat-2554-support-path-scoped-code-review-depth-ov/40-design.md
 * for the full behavior table and negative-space notes this module encodes.
 */

/** Depth tiers, weakest to strongest. */
export type DepthTier = 'quick' | 'standard' | 'deep';

/** One `workflow.code_review_depth_overrides` rule entry, pre-validation. */
export interface CodeReviewDepthRule {
  paths: string[];
  depth: DepthTier;
}

/** Frozen enum of validation-failure reasons (CONTRIBUTING's typed-reason rule). */
export type CodeReviewDepthReasonKey =
  | 'NOT_AN_ARRAY'
  | 'RULE_NOT_OBJECT'
  | 'PATHS_MALFORMED'
  | 'INVALID_DEPTH'
  | 'GLOB_UNSUPPORTED'
  | 'PATH_TRAVERSAL'
  | 'PATH_ABSOLUTE'
  | 'PATH_EMPTY';

export const REASON: Readonly<Record<CodeReviewDepthReasonKey, string>> = Object.freeze({
  NOT_AN_ARRAY: 'not_an_array',
  RULE_NOT_OBJECT: 'rule_not_object',
  PATHS_MALFORMED: 'paths_malformed',
  INVALID_DEPTH: 'invalid_depth',
  GLOB_UNSUPPORTED: 'glob_unsupported',
  PATH_TRAVERSAL: 'path_traversal',
  PATH_ABSOLUTE: 'path_absolute',
  PATH_EMPTY: 'path_empty',
});

/** Depth tiers, weakest → strongest. Frozen. */
export const DEPTH_TIERS: readonly DepthTier[] = Object.freeze(['quick', 'standard', 'deep']);

/**
 * A `deep` resolution over more than this many changed files downgrades to
 * `standard` (pre-existing scope guard; see gsd-core/workflows/code-review.md).
 */
export const LARGE_SCOPE_THRESHOLD = 50;

/** One validation-failure entry. `ruleIndex`/`path`/`value` are present when applicable. */
export interface CodeReviewDepthError {
  reason: string;
  ruleIndex?: number;
  path?: string;
  value?: unknown;
}

/** The rule that decided the resolved depth, when `source === 'rule'`. */
export interface MatchedRule {
  index: number;
  path: string;
  depth: DepthTier;
}

export interface ResolveCodeReviewDepthInput {
  /** `--depth=` flag value, or '' if not supplied. */
  flagDepth?: string;
  /** `workflow.code_review_depth` config value, or '' if unset. */
  configDepth?: string;
  /** `workflow.code_review_depth_overrides` config value — validated here, so `unknown`. */
  overrides?: unknown;
  /** The review's changed-file set (plain strings, any of the normalizable shapes). */
  files: string[];
  /** Repo root, for relativizing absolute file paths. */
  repoRoot: string;
}

export interface ResolveCodeReviewDepthOk {
  ok: true;
  depth: DepthTier;
  /** The tier before the large-scope downgrade, if any, was applied. */
  resolvedDepth: DepthTier;
  source: 'flag' | 'rule' | 'config' | 'default';
  matchedRule: MatchedRule | null;
  downgraded: boolean;
  fileCount: number;
  invalidFlagDepth?: true;
  invalidConfigDepth?: true;
}

export interface ResolveCodeReviewDepthErr {
  ok: false;
  errors: CodeReviewDepthError[];
}

export type ResolveCodeReviewDepthResult = ResolveCodeReviewDepthOk | ResolveCodeReviewDepthErr;

/** True for a non-null, non-array object — the shape a JSON rule entry must have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a repo-relative-ish path for matching: coerce non-strings to '',
 * trim whitespace/CR, convert `\` to `/` unconditionally
 * (RULESET.CONTENT-PATH-NORMALIZATION — never conditional on platform), collapse
 * repeated `/`, strip a leading `repoRoot/` prefix, strip leading `./` segments
 * (repeatably), and strip leading/trailing `/` — but ONLY when the path was
 * relativized against `repoRoot` (or was never absolute to begin with). An
 * absolute input (POSIX `/…` or a Windows drive-absolute `C:/…`) that is not
 * under `repoRoot` stays absolute, so it can never spuriously match a
 * repo-relative rule path in `ruleMatchesFile`. Idempotent.
 */
export function normalizeRelPath(p: unknown, repoRoot?: string): string {
  let value = typeof p === 'string' ? p : '';
  value = value.trim();
  value = value.replace(/\\/g, '/');
  value = value.replace(/\/+/g, '/');

  const isAbsolute = value.startsWith('/') || /^[A-Za-z]:\//.test(value);
  let relativized = false;

  if (typeof repoRoot === 'string' && repoRoot !== '') {
    const rootNormalized = repoRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (rootNormalized !== '' && value.startsWith(`${rootNormalized}/`)) {
      value = value.slice(rootNormalized.length + 1);
      relativized = true;
    }
  }

  let prev: string;
  do {
    prev = value;
    if (value.startsWith('./')) {
      value = value.slice(2);
    }
  } while (value !== prev);

  if ((relativized || !isAbsolute) && value.startsWith('/')) {
    value = value.slice(1);
  }
  if (value.endsWith('/') && value !== '/') {
    value = value.slice(0, -1);
  }

  return value;
}

/**
 * Segment-aware match: true iff `filePath === rulePath` or `filePath` starts
 * with `rulePath + '/'`. Both arguments must already be normalized. Case-sensitive.
 */
export function ruleMatchesFile(rulePath: string, filePath: string): boolean {
  return filePath === rulePath || filePath.startsWith(`${rulePath}/`);
}

interface RulePathValidation {
  error: CodeReviewDepthReasonKey | null;
  normalized?: string;
}

/**
 * Validate + normalize a single rule path (not yet matched against files).
 * Check order: glob syntax, `..` traversal segment, absolute (leading `/` with
 * real content, or a Windows drive letter), then empty-after-normalization
 * (covers a bare `/`, `.`, `./`, or whitespace-only path).
 */
function validateRulePath(rawPath: string): RulePathValidation {
  const trimmed = rawPath.trim();
  const slashified = trimmed.replace(/\\/g, '/');

  if (/[*?]/.test(slashified)) {
    return { error: 'GLOB_UNSUPPORTED' };
  }

  const collapsed = slashified.replace(/\/+/g, '/');
  const segments = collapsed.split('/');
  if (segments.includes('..')) {
    return { error: 'PATH_TRAVERSAL' };
  }

  const looksAbsolute = slashified.startsWith('/') || /^[A-Za-z]:/.test(slashified);

  let normalized = collapsed;
  let prev: string;
  do {
    prev = normalized;
    if (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }
  } while (normalized !== prev);
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  if (looksAbsolute && normalized !== '' && normalized !== '.') {
    return { error: 'PATH_ABSOLUTE' };
  }
  if (normalized === '' || normalized === '.') {
    return { error: 'PATH_EMPTY' };
  }

  return { error: null, normalized };
}

interface ValidatedRule {
  index: number;
  paths: string[];
  depth: DepthTier;
}

/** Validate the full `overrides` value. Collects every malformed-rule error, in rule order. */
function validateOverrides(
  overridesInput: unknown,
): { ok: true; rules: ValidatedRule[] } | { ok: false; errors: CodeReviewDepthError[] } {
  const overridesValue = overridesInput === undefined ? [] : overridesInput;

  if (!Array.isArray(overridesValue)) {
    return { ok: false, errors: [{ reason: REASON.NOT_AN_ARRAY }] };
  }

  const errors: CodeReviewDepthError[] = [];
  const rules: ValidatedRule[] = [];

  for (let index = 0; index < overridesValue.length; index += 1) {
    const rule: unknown = overridesValue[index];

    if (!isPlainObject(rule)) {
      errors.push({ reason: REASON.RULE_NOT_OBJECT, ruleIndex: index });
      continue;
    }

    const hasPaths = Object.prototype.hasOwnProperty.call(rule, 'paths');
    const rawPaths = hasPaths ? rule.paths : undefined;
    if (
      !Array.isArray(rawPaths)
      || rawPaths.length === 0
      || rawPaths.some((entry: unknown) => typeof entry !== 'string')
    ) {
      errors.push({ reason: REASON.PATHS_MALFORMED, ruleIndex: index });
      continue;
    }

    let pathError: CodeReviewDepthError | null = null;
    const normalizedPaths: string[] = [];
    for (const rawPath of rawPaths as string[]) {
      const validation = validateRulePath(rawPath);
      if (validation.error) {
        pathError = { reason: REASON[validation.error], ruleIndex: index, path: rawPath };
        break;
      }
      normalizedPaths.push(validation.normalized as string);
    }
    if (pathError) {
      errors.push(pathError);
      continue;
    }

    const hasDepth = Object.prototype.hasOwnProperty.call(rule, 'depth');
    const depthValue = hasDepth ? rule.depth : undefined;
    if (typeof depthValue !== 'string' || !DEPTH_TIERS.includes(depthValue as DepthTier)) {
      errors.push({ reason: REASON.INVALID_DEPTH, ruleIndex: index, value: depthValue });
      continue;
    }

    rules.push({ index, paths: normalizedPaths, depth: depthValue as DepthTier });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, rules };
}

interface FinalizeInput {
  resolvedDepth: DepthTier;
  source: 'flag' | 'rule' | 'config' | 'default';
  matchedRule: MatchedRule | null;
  fileCount: number;
  invalidFlagDepth?: true;
  invalidConfigDepth?: true;
}

/** Applies the large-scope `deep` → `standard` downgrade and assembles the ok result. */
function finalize(input: FinalizeInput): ResolveCodeReviewDepthOk {
  const downgraded = input.resolvedDepth === 'deep' && input.fileCount > LARGE_SCOPE_THRESHOLD;
  const result: ResolveCodeReviewDepthOk = {
    ok: true,
    depth: downgraded ? 'standard' : input.resolvedDepth,
    resolvedDepth: input.resolvedDepth,
    source: input.source,
    matchedRule: input.matchedRule,
    downgraded,
    fileCount: input.fileCount,
  };
  if (input.invalidFlagDepth) result.invalidFlagDepth = true;
  if (input.invalidConfigDepth) result.invalidConfigDepth = true;
  return result;
}

/**
 * Resolve the effective code-review depth. Overrides are always validated
 * first, even when the `--depth=` flag would win outright — a malformed
 * config must never silently pass through unreported. See the design doc's
 * behavior table for the full row-by-row contract.
 */
export function resolveCodeReviewDepth(input: ResolveCodeReviewDepthInput): ResolveCodeReviewDepthResult {
  const { flagDepth, configDepth, overrides, files, repoRoot } = input;

  const validated = validateOverrides(overrides);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }
  const rules = validated.rules;

  if (typeof flagDepth === 'string' && flagDepth !== '') {
    if (DEPTH_TIERS.includes(flagDepth as DepthTier)) {
      return finalize({
        resolvedDepth: flagDepth as DepthTier,
        source: 'flag',
        matchedRule: null,
        fileCount: files.length,
      });
    }
    return finalize({
      resolvedDepth: 'standard',
      source: 'flag',
      matchedRule: null,
      fileCount: files.length,
      invalidFlagDepth: true,
    });
  }

  const normalizedFiles = files.map((f) => normalizeRelPath(f, repoRoot));
  let best: MatchedRule | null = null;
  let bestTierIndex = -1;
  for (const rule of rules) {
    const tierIndex = DEPTH_TIERS.indexOf(rule.depth);
    let matchedPath: string | null = null;
    for (const rulePath of rule.paths) {
      if (normalizedFiles.some((file) => ruleMatchesFile(rulePath, file))) {
        matchedPath = rulePath;
        break;
      }
    }
    if (matchedPath === null) continue;
    if (best === null || tierIndex > bestTierIndex) {
      best = { index: rule.index, path: matchedPath, depth: rule.depth };
      bestTierIndex = tierIndex;
    }
  }
  if (best !== null) {
    return finalize({
      resolvedDepth: best.depth,
      source: 'rule',
      matchedRule: best,
      fileCount: files.length,
    });
  }

  // No rule matched this file set. Provenance depends solely on whether a
  // global config depth was configured — the presence, absence, or emptiness
  // of `overrides` has no bearing here (a validly-configured rule set that
  // simply didn't match this review is indistinguishable, for provenance
  // purposes, from no rule set at all).
  if (typeof configDepth === 'string' && configDepth !== '') {
    if (DEPTH_TIERS.includes(configDepth as DepthTier)) {
      return finalize({
        resolvedDepth: configDepth as DepthTier,
        source: 'config',
        matchedRule: null,
        fileCount: files.length,
      });
    }
    return finalize({
      resolvedDepth: 'standard',
      source: 'config',
      matchedRule: null,
      fileCount: files.length,
      invalidConfigDepth: true,
    });
  }

  return finalize({
    resolvedDepth: 'standard',
    source: 'default',
    matchedRule: null,
    fileCount: files.length,
  });
}
