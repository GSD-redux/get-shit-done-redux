/**
 * Canonical workstream name validation and slug normalization
 * (ADR-457 build-at-publish: the hand-written bin/lib/workstream-name-policy.cjs
 * collapsed to a TypeScript source of truth). Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 *
 * Used by active-workstream-store.cjs, planning-workspace.cjs, workstream.cjs.
 *
 * #3883 (ADR-3473 §8.3): toWorkstreamSlug delegates to core-utils.cjs's
 * generateSlugInternal (the canonical slug formula), passing `maxLen: null`
 * to preserve this site's pre-migration untruncated contract — the 60-char
 * default collided distinct >60-char workstream names onto the same slug
 * (verified: `"a".repeat(60)+"alpha"` and `"a".repeat(60)+"beta"` truncated
 * identically). core-utils.cjs already
 * requires (transitively, at module-init time) THIS module:
 * core-utils.cjs -> planning-workspace.cjs -> active-workstream-store.cjs ->
 * workstream-name-policy.cjs. A top-level require of core-utils.cjs here
 * would therefore close that cycle and — per this codebase's compiled-.cjs
 * convention of a single `module.exports = {...}` reassignment at the bottom
 * of core-utils.cjs — capture a stale, still-empty exports object forever
 * (verified live: "generateSlugInternal is not a function" whichever module
 * loads first). The require is deferred (lazy, inside toWorkstreamSlug's
 * body) instead, mirroring the same cycle-break already used by
 * core-utils.cts's own getPhaseFileStats/plan-scan.cjs seam and by
 * phase-id.cts's toDir/getPhaseDirFromPhaseId.
 */

export const INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE =
  'Invalid workstream name: must be alphanumeric, hyphens, underscores, or dots';

const ACTIVE_WORKSTREAM_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Result of validateActiveWorkstreamName. */
export interface WorkstreamValidationResult {
  ok: boolean;
  reason: 'empty' | 'invalid' | null;
  value: string | null;
}

export function normalizeWorkstreamNameInput(name: string | null | undefined): string | null {
  const value = String(name ?? '').trim();
  return value || null;
}

/**
 * Returns true when `name` contains a path separator, a bare dot, or a
 * dot-dot sequence — any of which would make the name unsafe for use as a
 * filesystem path segment.
 */
export function hasInvalidPathSegment(name: string | null | undefined): boolean {
  const value = String(name ?? '');
  return /[/\\]/.test(value) || value === '.' || value === '..' || value.includes('..');
}

export function validateActiveWorkstreamName(name: string | null | undefined): WorkstreamValidationResult {
  const value = normalizeWorkstreamNameInput(name);
  if (!value) {
    return {
      ok: false,
      reason: 'empty',
      value: null,
    };
  }
  if (hasInvalidPathSegment(value) || !ACTIVE_WORKSTREAM_RE.test(value)) {
    return {
      ok: false,
      reason: 'invalid',
      value,
    };
  }
  return {
    ok: true,
    reason: null,
    value,
  };
}

/**
 * Validate a workstream name.
 * Allowed: alphanumeric, hyphens, underscores, dots.
 * Disallowed: empty, spaces, slashes, special chars, path traversal.
 *
 * Alias for isValidActiveWorkstreamName; provided for SDK-layer callers.
 */
export function validateWorkstreamName(name: string | null | undefined): boolean {
  return isValidActiveWorkstreamName(name);
}

/**
 * Convert a display name to a URL/filesystem-safe workstream slug.
 * Lowercases, collapses non-alphanumeric runs to hyphens, strips leading/trailing hyphens.
 */
export function toWorkstreamSlug(name: string | null | undefined): string {
  // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
  // (generateSlugInternal, core-utils.cts) rather than re-implementing it —
  // this call site previously diverged from it (no transliteration, no
  // 60-char truncation). Lazy require to break the core-utils.cjs cycle
  // (see the module dependency doc comment above).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  return (require('./core-utils.cjs').generateSlugInternal(String(name ?? ''), null) as string | null) ?? '';
}

/**
 * Returns true when `name` is a valid active workstream name:
 * - Must start with alphanumeric
 * - May contain alphanumeric, dots, underscores, hyphens
 * - Must not contain path traversal sequences (..)
 */
export function isValidActiveWorkstreamName(name: string | null | undefined): boolean {
  return validateActiveWorkstreamName(name).ok;
}

export function assertValidActiveWorkstreamName(
  name: string | null | undefined,
  errorMessage: string = INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE,
): string {
  const validation = validateActiveWorkstreamName(name);
  if (!validation.ok) {
    throw new Error(errorMessage);
  }
  return validation.value!;
}
