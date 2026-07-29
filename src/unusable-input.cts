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
  /**
   * A ROADMAP.md exists but could not be read (EACCES/EIO/…). Distinct from a project that
   * simply has no ROADMAP yet: absence returns the same sentinel, silently. (#1881)
   */
  ROADMAP_UNREADABLE: 'roadmap_unreadable',
} as const);

type UnusableReason = (typeof UNUSABLE_REASON)[keyof typeof UNUSABLE_REASON];

/** One human-readable clause per reason. Prose lives here, never in a test assertion. */
const REASON_PROSE: Readonly<Record<UnusableReason, string>> = Object.freeze({
  [UNUSABLE_REASON.FRONTMATTER_UNTERMINATED]:
    'frontmatter opens with "---" but never closes; metadata was NOT applied',
  [UNUSABLE_REASON.ROADMAP_UNREADABLE]:
    'ROADMAP.md exists but could not be read; phase and milestone lookups fell back to defaults',
});

// ─── Dedup state ──────────────────────────────────────────────────────────────

/**
 * Process-lifetime dedup set. Mirrors `config-loader.cjs`'s `_warnedUnknownConfigKeys`
 * guard, which ADR-1411 names as the precedent to reuse.
 */
const _warnedUnusableInputs = new Set<string>();

/**
 * Count of diagnostics actually WRITTEN, which is not the same as the size of the dedup set:
 * one emission records every key the input could later be identified by, so set size counts
 * identities while this counts events. Tests assert on this because the behavioural claim is
 * "how many diagnostics did the operator see", not "how many keys are interned".
 */
let _unusableInputEmissions = 0;

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
 * Strip control characters. Deliberately does NOT normalize path separators.
 *
 * An earlier revision folded backslashes to `/` unconditionally, reasoning that `C:\a\b.md`
 * and `C:/a/b.md` are one file and should not report twice. That is true on Windows, and
 * false — destructively — everywhere else: `\` is a legal filename character on Linux and
 * macOS, so `/repo/weird\name/PLAN.md` and `/repo/weird/name/PLAN.md` are two genuinely
 * different files that collapsed to one key, and the second one's diagnostic was silently
 * swallowed. ADR-1411 forbids exactly that ("keying too coarsely suppresses a genuine second
 * failure in a different file"), and this repo targets Linux/macOS/Windows alike.
 *
 * The trade is now explicit and one-directional: two spellings of one Windows path may
 * report twice (mild noise), but two distinct files can never silence each other (lost
 * signal). Dropping a real diagnostic is the strictly worse failure.
 */
function sanitizeSource(source: string): string {
  return source.replace(CONTROL_CHARS, '');
}

/**
 * Identify the offending input. A path is preferred because it is what an operator can act
 * on. When the caller has only an in-memory string, fall back to a short content digest so
 * that *different* bad inputs still produce *different* keys.
 *
 * The leading `p`/`d` tag is what keeps the two namespaces disjoint. Without it a caller
 * whose file is literally named `<unnamed:8efa5269728e7271>` would key identically to a
 * path-less caller whose content happens to hash to that digest — no brute force required,
 * since the digest of any predictable content (a shared template, known boilerplate) can
 * simply be computed and used as a filename to pre-seed suppression. Because control
 * characters — including NUL — are stripped from `source`, a caller-supplied path can never
 * contain the separator and so can never forge a key in the other namespace either.
 *
 * The digest is computed only on the emission path, which is rare, so it never costs
 * anything on a healthy read.
 */
function sourceKey(source?: string, content?: string): string {
  if (typeof source === 'string' && source.trim() !== '') {
    return `p\u0000${sanitizeSource(source)}`;
  }
  const digest = crypto.createHash('sha256').update(content ?? '').digest('hex').slice(0, 16);
  return `d\u0000${digest}`;
}

/** Human-facing name for the offending input, derived from the same key. */
function displaySource(key: string): string {
  return key.startsWith('p\u0000') ? key.slice(2) : `<unnamed:${key.slice(2)}>`;
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

  // The guarantee, stated precisely, because it is not symmetric:
  //
  //   * a file reported BY NAME is reported at most once, and
  //   * an anonymous re-parse of content already reported by name stays silent, and
  //   * two DIFFERENT files always both report, even when their truncated bytes are identical.
  //
  // The asymmetry is the anonymous-FIRST ordering (a path-less parse, then a named parse of the
  // same content), which emits twice. That is a deliberate limit, not an oversight. A path-less
  // caller cannot identify its file, so suppressing the later named report would also suppress a
  // genuine second failure in a DIFFERENT file whenever two files share byte-identical truncated
  // content — the over-coarse keying ADR-1411 explicitly forbids. Between a duplicate line and a
  // swallowed diagnostic the ADR ranks the swallow worse, so the duplicate is accepted; and the
  // second line is the more useful of the two, because it carries the filename.
  //
  // Mechanically: check ONLY the key matching what this caller actually knows, but record every
  // key the input could later be identified by.
  const identity = sourceKey(source, content);
  const keys = [`${identity}\u0000${reason}`];
  if (typeof content === 'string' && identity.startsWith('p\u0000')) {
    keys.push(`${sourceKey(undefined, content)}\u0000${reason}`);
  }
  if (_warnedUnusableInputs.has(keys[0])) return false;
  for (const k of keys) _warnedUnusableInputs.add(k);

  try {
    process.stderr.write(`gsd: warning — ${displaySource(identity)}: ${prose}. (#1879)\n`);
    // Counted only after a write that actually completed. Incrementing before the try counted
    // attempts, so on a broken stderr the counter claimed a diagnostic had reached the operator
    // when nothing had — a seam documented as "written" reporting something else.
    _unusableInputEmissions += 1;
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
  _unusableInputEmissions = 0;
}

/** Number of diagnostics written — the typed surface tests assert on instead of stderr prose. */
function _unusableInputEmissionCountForTests(): number {
  return _unusableInputEmissions;
}

/** Size of the dedup set (identities interned, not events). Retained for key-shape assertions. */
function _unusableInputWarningCountForTests(): number {
  return _warnedUnusableInputs.size;
}

/** Test seam: the sanitized form of a source, so control-char handling is asserted on a
 * returned value instead of by scraping what reached stderr. */
function _sanitizeSourceForTests(source: string): string {
  return sanitizeSource(source);
}

export = {
  UNUSABLE_REASON,
  _sanitizeSourceForTests,
  warnUnusableInput,
  _resetUnusableInputWarningsForTests,
  _unusableInputWarningCountForTests,
  _unusableInputEmissionCountForTests,
};
