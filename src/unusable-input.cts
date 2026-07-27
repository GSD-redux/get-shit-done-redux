/**
 * Unusable Input Diagnostic — the out-of-band half of ADR-1411's
 * "corrupt is not absent" amendment (epic #1879).
 *
 * ADR-1411 splits the amendment's mechanism in two. Where a read already returns a
 * provenance envelope, the cause is named *in-band* — that is `ConfigResolution.reason`
 * (#1880, shipped). Where a read returns a bare sentinel or a plausible default it cannot
 * extend, the return value is preserved exactly and the cause is surfaced *out-of-band*,
 * as a deduplicated diagnostic on stderr. This module owns that second mechanism.
 *
 * It exists as a shared seam rather than a pattern copied per site because four call sites
 * across four modules need identical behaviour (#1882 frontmatter, #1881 roadmap-parser,
 * #1883 planning-workspace/verify, #1884 planning lock). Four hand-rolled copies of one
 * behaviour is `DEFECT.GENERATIVE-FIX` by construction; one seam with a frozen reason set
 * is the documented cure.
 *
 * Two contracts this module must not break:
 *
 *  - **Unconditional.** ADR-1411 diverges deliberately from ADR-227's never-implemented
 *    `GSD_DEBUG` opt-in: "an opt-in nobody sets is indistinguishable from the silence
 *    #1879 is about". There is no config gate here, by design.
 *  - **Never throws.** Callers are leaf readers that promised a total function. A failed
 *    stderr write (closed stream, EPIPE) must not turn a silent degradation into a crash.
 */

import crypto from 'node:crypto';

// ─── Reason vocabulary ────────────────────────────────────────────────────────

/**
 * Frozen so tests assert a typed surface instead of diagnostic prose
 * (CONTRIBUTING.md — Prohibited: Raw Text Matching on Test Outputs).
 *
 * Adding a reason is three coordinated changes, matching the repo's `REASON`-enum
 * convention: the entry here, the emitting call site, and the test that locks
 * `Object.keys(UNUSABLE_REASON).sort()`. Each epic-#1879 phase adds only its own —
 * pre-declaring the later phases' reasons would be speculative generality and would
 * leave values no call site emits.
 */
const UNUSABLE_REASON = Object.freeze({
  /**
   * A file opened a `---` frontmatter fence at byte 0, carried at least one parseable
   * key, and never closed the fence — a truncated or half-written file, NOT a file that
   * legitimately has no frontmatter. (#1882)
   */
  FRONTMATTER_UNTERMINATED: 'frontmatter_unterminated',
} as const);

type UnusableReason = (typeof UNUSABLE_REASON)[keyof typeof UNUSABLE_REASON];

/** One human-readable clause per reason. Prose lives here, never in a test assertion. */
const REASON_PROSE: Readonly<Record<UnusableReason, string>> = Object.freeze({
  [UNUSABLE_REASON.FRONTMATTER_UNTERMINATED]:
    'frontmatter opens with "---" but never closes; metadata was NOT applied',
});

// ─── Dedup state ──────────────────────────────────────────────────────────────

/**
 * Process-lifetime dedup set. Mirrors `config-loader.cjs`'s `_warnedUnknownConfigKeys`
 * guard, which ADR-1411 names as the precedent to reuse.
 */
const _warnedUnusableInputs = new Set<string>();

/**
 * ASCII control characters (including NUL) are stripped from any path before it is used
 * as a key component or written to a terminal. Two reasons, both real:
 *
 *  - the key separator is NUL, so a `sourcePath` containing NUL could otherwise forge a
 *    collision with a different (path, reason) pair and suppress a genuine second failure;
 *  - a path carrying ANSI escapes would be replayed verbatim into the operator's terminal.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Path separators are normalized **unconditionally** rather than via `path.sep`, because a
 * backslash-bearing path can arrive on Linux too — see the repo's recurring
 * path-separator-normalization defect. Without this, `C:\a\b.md` and `C:/a/b.md` are two
 * keys for one file and the diagnostic fires twice on Windows.
 */
function normalizeSource(source: string): string {
  return source.replace(CONTROL_CHARS, '').replace(/\\/g, '/');
}

/**
 * Identify the offending input. A path is preferred because it is what an operator can act
 * on. When the caller has only an in-memory string (no path to give), fall back to a short
 * content digest so that *different* bad inputs still produce *different* keys — keying too
 * coarsely would suppress a genuine second failure, which ADR-1411 explicitly forbids.
 *
 * Computed only on the flag path, which is rare, so the hash never costs anything on a
 * healthy read.
 */
function sourceKey(source?: string, content?: string): string {
  if (typeof source === 'string' && source.trim() !== '') return normalizeSource(source);
  const digest = crypto.createHash('sha256').update(content ?? '').digest('hex').slice(0, 16);
  return `<unnamed:${digest}>`;
}

// ─── Emission ─────────────────────────────────────────────────────────────────

interface WarnUnusableInputArgs {
  /** Which unusable-input condition fired. */
  reason: UnusableReason;
  /** Resolved path of the offending file, when the caller has one. */
  source?: string;
  /** Raw content, used only to derive a dedup key when `source` is absent. */
  content?: string;
}

/**
 * Emit a deduplicated diagnostic naming an input that exists but cannot be used.
 *
 * The key is `<normalized source>\0<reason>`. ADR-1411 requires the resolved path AND the
 * distinguishing cause — keying on the path alone would let a second, different fault on
 * the same file go unreported; keying on the message prose would couple the guard to
 * wording.
 *
 * @returns `true` when this call actually wrote a diagnostic, `false` when it was
 * deduplicated. Returning the decision is what lets tests assert emission *counts* on a
 * typed surface rather than scraping stderr.
 */
function warnUnusableInput({ reason, source, content }: WarnUnusableInputArgs): boolean {
  // Defensive: an unknown reason must not emit a diagnostic with `undefined` in it.
  const prose = Object.prototype.hasOwnProperty.call(REASON_PROSE, reason)
    ? REASON_PROSE[reason]
    : null;
  if (prose === null) return false;

  const key = `${sourceKey(source, content)}\u0000${reason}`;
  if (_warnedUnusableInputs.has(key)) return false;
  _warnedUnusableInputs.add(key);

  try {
    process.stderr.write(`gsd: warning — ${sourceKey(source, content)}: ${prose}. (#1879)\n`);
  } catch {
    /* a closed or broken stderr must never escalate a degraded read into a crash */
  }
  return true;
}

// ─── Test seams ───────────────────────────────────────────────────────────────

/**
 * Clear the dedup state between cases.
 *
 * This exists because the set is process-global: without it, the second test to use a key
 * silently observes the first test's suppression. #2674 is the cautionary precedent — a
 * reset helper that cleared two of three sets was a silent no-op for the very suite that
 * existed to test it, and the cases only passed because each happened to pick a key no
 * other case reused.
 */
function _resetUnusableInputWarningsForTests(): void {
  _warnedUnusableInputs.clear();
}

/** Size of the dedup set — the typed surface tests assert on instead of stderr prose. */
function _unusableInputWarningCountForTests(): number {
  return _warnedUnusableInputs.size;
}

export = {
  UNUSABLE_REASON,
  warnUnusableInput,
  _resetUnusableInputWarningsForTests,
  _unusableInputWarningCountForTests,
};
