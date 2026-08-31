'use strict';

/**
 * Differential emitted-artifact attribution — the conservation law (ADR-2719 §1,
 * issue #2723, epic #2719 Phase 3).
 *
 * Given the emitted manifests at `next` HEAD and at PR HEAD, plus the repo paths the
 * PR actually changed, decide which moved emitted paths are EXPLAINED by the diff and
 * which are not. Unattributable deltas are a hard failure that names them; the only
 * way through is a commit trailer on the PR's own commits (ADR-3942) —
 * `Emitted-Drift-Ack-Hash:` / `Emitted-Drift-Ack-Growth:`, read over
 * `<merge-base>..HEAD` by `readAckTrailers` (`tests/helpers/emitted-runtime.cjs`) and
 * parsed by `parseAckTrailers` below.
 *
 * ── Why this module is pure ──────────────────────────────────────────────────
 * No fs, no git, no installer, no clock. The naive shape — one integration test that
 * builds 19 manifests at each end and asserts — cannot practically exercise the four
 * failing-first criteria #2723 requires, so in practice they would not get written,
 * which is precisely how a phase ships promised-but-not-built. Keeping the law pure
 * makes every criterion a millisecond-scale table test, and makes the Stryker gate
 * able to bite (a 20-branch pure function is mutation-testable; a 40-minute
 * integration test is not).
 *
 * The expensive part — obtaining the manifests — lives in emitted-baseline.cjs.
 *
 * ── What this does NOT do ────────────────────────────────────────────────────
 * It never re-derives a byte (ADR-2719 §1 is explicit that asserting
 * `emitted == transform(source)` is the tautology ADR-2264's Amendment rejected).
 * It constrains which keys may move. It also never mutates repo state: no
 * regeneration, no auto-ack. `UPDATE_GOLDEN=1` is exactly the escape hatch this
 * design removes.
 */

const { attributeEmittedPath } = require('./emitted-provenance.cjs');

/**
 * Key names that can never be a legitimate emitted path or bare workflow/agent filename,
 * and that also happen to be the JS-object footguns (`__proto__`, `constructor`,
 * `prototype`). Rejected LOUDLY by `parseAckTrailers` rather than silently dropped: a
 * trailer naming one of these is always an authoring mistake (never a real path or
 * filename), and dropping it quietly would let the SAME reserved key satisfy a downstream
 * lookup instead of failing the gate that names it.
 */
const RESERVED_ACK_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Characters that render as nothing: soft hyphen, the zero-width family, word joiner,
 * BOM. Stripped before reasons are compared, so an invisible edit cannot re-arm a spent
 * acknowledgment. Spelled as codepoints on purpose — a literal character class here
 * would be invisible in review, which is the exact failure being defended against.
 */
const INVISIBLE = new RegExp(
  `[${[0x00AD, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF]
    .map((c) => `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`)
    .join('')}]`,
  'g',
);

/**
 * The single definition of "the prose a reviewer actually reads" for an ack reason.
 *
 * Used internally by `parseAckTrailers`'s own same-key dedup (a key declared twice
 * within one trailer space collapses to one entry only when the reasons are identical
 * after normalization) and exported so a real test can assert on that behavior directly
 * rather than only through `parseAckTrailers`'s combined output.
 *
 * The invisible-stripping (`INVISIBLE`) and whitespace-collapse below are anti-gaming
 * defences, not incidental normalization — see `parseAckTrailers`'s dedup check, its
 * one call site.
 */
function normalizeAckReason(reason) {
  return reason.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/**
 * A brand-new workflow/agent file — absent from the baseline, present now — must
 * still stay under the Codex `project_doc_max_bytes` anchor (ADR-1610 Decision
 * point 3, `NEW_FILE_CAP` in the pre-#2724 tests/workflow-size-budget.test.cjs).
 *
 * #2724 (ADR-2719 Phase 4) deleted the committed per-file baseline that cap used to
 * key "not yet baselined" off of. The size ratchet below (ADR-2719 §4) already
 * computes the exact same signal for a different reason — a name present in
 * `sizeCurrent` but absent from `sizeBaseline` IS "new" by construction, the same
 * definition ADR-1610 used — so no new baseline, git diff, or CI wiring is needed to
 * revive the cap; it only needed a home once the old one was deleted.
 *
 * This is a HARD cap, not ack-able, matching the tier hard caps it sits beside
 * (XL/LARGE/DEFAULT in tests/workflow-size-budget.test.cjs): the fix for exceeding it
 * is extraction, never an acknowledgment entry. Not exempted by explicit XL/LARGE
 * tiering the way the original test-file version was — this module is intentionally
 * pure and has no access to that classification (tests/workflow-size-budget.test.cjs's
 * XL_WORKFLOWS/LARGE_WORKFLOWS sets) — so a legitimately large NEW file must be split
 * via the same lazy-extraction pattern the tier caps already require, one release
 * earlier than an existing file would need to. Documented narrowing, not a silent one.
 */
const NEW_FILE_CAP = 32768;

/**
 * Trailer key naming an emitted PATH whose HASH moved (grammar: 40-design.md).
 * Relocated ahead of `REMEDIATION` (which follows immediately below and calls
 * `renderAckTrailer` at module-eval time, so these three consts must already be
 * initialized — a `const` declared later in the file is in the temporal dead zone
 * during that call, unlike `renderAckTrailer` itself, which is a hoisted function
 * declaration and may stay where it is, further down.
 */
const ACK_TRAILER_HASH = 'Emitted-Drift-Ack-Hash';
/** Trailer key naming a bare workflow/agent FILENAME that grew. */
const ACK_TRAILER_GROWTH = 'Emitted-Drift-Ack-Growth';
/** Key/reason delimiter: space, EM DASH (U+2014), space — split on the FIRST occurrence only. */
const ACK_TRAILER_DELIM = ' — ';

/**
 * Self-serve remediation, as data rather than prose scattered across branches (#2778).
 *
 * ADR-2719 §3 makes the acknowledgment a *conspicuous declaration a contributor makes
 * deliberately*. That only works if the contributor can discover how to make it. Before this,
 * the growth branch stated a requirement and withheld the means: it said "without an
 * acknowledgment" without naming the file, saying the file does not exist yet, giving the
 * schema, or saying which of the two key spaces applies — and it omitted the "do not
 * regenerate" instruction too, so the likeliest guess was to go hunting for a baseline file
 * #2724 deleted. Observed live on #2543.
 *
 * Exported as one frozen object rather than loose strings so the observable surface is
 * deliberate (Hyrum), and so tests can assert on identity instead of prose — rewording the
 * help text must not be a breaking change.
 */
const REMEDIATION = Object.freeze({
  /**
   * #3942: the remedy is a COMMIT TRAILER on this PR, never a new file — the legacy
   * fragment directory and the legacy single file are both retired as write targets.
   *
   * Split into two SPACE-SPECIFIC fields rather than one combined sentence: the two
   * trailer names key on structurally distinct spaces (RULESET.EMITTED_ATTRIBUTION), and
   * a report that trips only one of the two branches must teach only that one name.
   * `formatReport` picks whichever of these apply to the report being rendered — never
   * both unconditionally.
   *
   * Deliberately NAME the trailer WITHOUT a trailing colon (backtick-quoted bare name,
   * not `` `Name:` ``) — the colon-suffixed form is the taught example line's own
   * grammar (`renderAckTrailer`, printed once per space right below this text). Using
   * the colon form here too would make a report that trips BOTH branches print each
   * trailer name (with colon) TWICE — once in this prose, once in its taught line —
   * which is the exact defect this split fixes; see "a ripple and a growth in one report
   * each get their OWN trailer line" in tests/emitted-attribution.test.cjs.
   */
  addTrailerHash:
    'Add a trailer to a commit in this PR (never a new file). Use the '
    + `\`${ACK_TRAILER_HASH}\` trailer for an unattributable ripple (key = the emitted `
    + 'path, always contains "/").',
  addTrailerGrowth:
    'Add a trailer to a commit in this PR (never a new file). Use the '
    + `\`${ACK_TRAILER_GROWTH}\` trailer for growth (key = the bare filename as it `
    + 'appears under gsd-core/workflows/ or agents/).',
  doNotRegenerate:
    'Do NOT regenerate anything to silence this — there is nothing left to regenerate.',
  /** The size ratchet keys on `entry.name` from readdirSync (emitted-runtime.cjs `currentSizes`). */
  growthKeyRule: 'Key on the BARE FILENAME as it appears under gsd-core/workflows/ or agents/',
  /** The hash pass keys on the emitted manifest path, which always carries a `/`. */
  rippleKeyRule: 'Key on the EMITTED PATH exactly as printed above',
  rippleReason: '<why this ripple is deliberate>',
  growthReason: '<why this growth is deliberate>',
  staleAckFix: 'Remove the trailer, or correct it to name the ripple you actually made.',
  /**
   * The taught trailer syntax, rendered through `renderAckTrailer` — the exact function
   * `parseAckTrailers` is the inverse of — so the printed example can never drift from
   * what the reader actually accepts (round-trip discipline, mirrors the old
   * `ackDocument`/`parseAck` pairing this replaces). A realistic path rather than an
   * angle-bracket placeholder: `parseAckTrailers` rejects keys containing `<`/`>`
   * specifically because this PR's own docs teaching the placeholder-shaped example
   * would otherwise arm itself as a live (and then stale) ack — see 40-design.md's
   * negative-space note.
   */
  ackTrailerExample: renderAckTrailer(
    ACK_TRAILER_HASH, 'skills/gsd-add-tests/SKILL.md', 'converter rewrite, ADR-2719',
  ),
});

/**
 * Does a changed repo path satisfy a provenance `sources` entry?
 *
 * A trailing `/` marks a PREFIX (Phase 2's SOURCE_PREFIX_SUFFIX contract) — e.g. Kimi's
 * root agent aggregates all of `agents/`. Prefix matching is SEGMENT-AWARE on purpose:
 * a bare `startsWith('agents/')` would also accept `agentsfoo/x.md` under a source of
 * `agents`, and silently over-attribute. Exact entries compare exactly.
 */
function sourceSatisfiedBy(source, changedSet) {
  if (source.endsWith('/')) {
    for (const changed of changedSet) {
      if (changed.startsWith(source)) return changed;
    }
    return null;
  }
  return changedSet.has(source) ? source : null;
}

/**
 * The conservation law.
 *
 * ── Ack lifecycle: scoped to the diff that introduced it, structurally (ADR-3942 §2) ──
 *
 * Every input here is BASE-RELATIVE — `baseline` vs `current`, `changedPaths` from
 * `git diff base...HEAD`, and now `ackHash`/`ackGrowth` too: they come from commit
 * trailers read over `<merge-base>..HEAD` (`readAckTrailers`,
 * `tests/helpers/emitted-runtime.cjs`), which is the PR's own commits and no others. A
 * trailer on the base side of the fork is out of range by construction, so there is no
 * base-side copy left to compare against and nothing can ever be "spent" — ADR-3942 §2
 * retired the `baseAck`/`spentAcks` mechanism that used to compute that distinction
 * (`readAckFileAtRef`, `readAckSourcesAtRef`, and their callers are deleted alongside
 * it, per ADR-3942 §6).
 *
 * ── Two independent key spaces, not one merged map ────────────────────────────
 *
 * `ackHash` and `ackGrowth` are the two commit-trailer namespaces (40-design.md),
 * already parsed into `Map<string, {reason}>` by `parseAckTrailers`. The hash pass
 * consults `ackHash` ONLY and the growth pass consults `ackGrowth` ONLY: naming a
 * growth-only bare filename in `Emitted-Drift-Ack-Hash` (or vice versa) must NOT excuse
 * anything — that cross-space excusal, possible when both spaces shared one map, is the
 * latent defect this split closes (rows 3/6). `staleAcks` is reported per space so the
 * error can say which trailer declared the unconsumed key.
 *
 * @param {object}   opts
 * @param {object}   opts.baseline      { [runtime]: { [rel]: hash } } at `next` HEAD
 * @param {object}   opts.current       { [runtime]: { [rel]: hash } } at PR HEAD
 * @param {string[]} opts.changedPaths  repo paths the PR changed (git diff --name-only)
 * @param {Map<string,{reason:string}>} [opts.ackHash]   live `Emitted-Drift-Ack-Hash`
 *   entries, keyed on the emitted path (always contains `/`). Defaults to an empty Map.
 * @param {Map<string,{reason:string}>} [opts.ackGrowth] live `Emitted-Drift-Ack-Growth`
 *   entries, keyed on the bare workflow/agent filename. Defaults to an empty Map.
 * @param {object}   [opts.sizeBaseline] { [name]: bytes } workflow/agent sizes at next
 * @param {object}   [opts.sizeCurrent]  { [name]: bytes } workflow/agent sizes at PR HEAD
 * @param {string[]} [opts.mergeAckErrors] errors already discovered while reading the
 *   ack source (`parseAckTrailers`'s per-value errors). This module never touches the
 *   filesystem or git, so it cannot discover such a problem on its own; the caller folds
 *   it in verbatim so it fails the gate exactly like any other ack schema error, rather
 *   than silently resolving via last-wins.
 *
 * @returns {{
 *   moved: number, attributed: Array, unattributable: Array, acked: Array,
 *   removed: Array, grown: Array, shrunk: Array, newFileCapExceeded: Array,
 *   staleAcks: Array<{key: string, space: 'hash'|'growth'}>,
 *   errors: string[], ok: boolean
 * }}
 */
function diffEmitted({
  baseline,
  current,
  changedPaths,
  ackHash = new Map(),
  ackGrowth = new Map(),
  sizeBaseline = null,
  sizeCurrent = null,
  mergeAckErrors = [],
} = {}) {
  const errors = [];

  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    errors.push('baseline manifest set must be an object keyed by runtime');
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    errors.push('current manifest set must be an object keyed by runtime');
  }
  if (!Array.isArray(changedPaths)) {
    // NOT the same as an empty array. A failed `git diff` must never be read as
    // "nothing changed" — that would make every moved hash unattributable and produce
    // a failure storm that reads like a real finding.
    errors.push('changedPaths must be an array (a failed git diff is an error, not an empty set)');
  }
  // #2778-shape guard, extended to the two #3942 ack Maps: without this, `{}`, `null`,
  // or a plain string handed to `ackHash`/`ackGrowth` reaches `liveAckHash.has(rel)` /
  // `liveAckGrowth.has(name)` below and throws an unhandled TypeError instead of an
  // error verdict naming the offending parameter — the same crash class `baseline`/
  // `current`/`changedPaths` are already guarded against, immediately above.
  if (!(ackHash instanceof Map)) {
    errors.push('ackHash must be a Map of parseAckTrailers output (readAckTrailers().hash)');
  }
  if (!(ackGrowth instanceof Map)) {
    errors.push('ackGrowth must be a Map of parseAckTrailers output (readAckTrailers().growth)');
  }
  if (errors.length) {
    return {
      // `newFileCapExceeded` MUST be present here. formatReport reads
      // `result.newFileCapExceeded.length` unconditionally, so omitting it made this
      // early return throw a TypeError instead of rendering the errors it was built to
      // report — and this is precisely the path taken when `git diff` failed or a
      // manifest came back malformed, so the crash replaced the one message that would
      // have explained the infrastructure problem (#2778).
      moved: 0, attributed: [], unattributable: [], acked: [], removed: [],
      grown: [], shrunk: [], newFileCapExceeded: [], staleAcks: [],
      errors, ok: false,
    };
  }

  const changedSet = new Set(changedPaths);
  // Folded in verbatim, not re-derived: see `mergeAckErrors`'s doc comment above.
  errors.push(...mergeAckErrors);

  // Every entry a trailer-scoped range can produce is by construction this PR's own
  // (ADR-3942 §2) — there is no base-side copy to partition against, so both Maps are
  // "live" in full; nothing here is ever "spent".
  const liveAckHash = ackHash;
  const liveAckGrowth = ackGrowth;

  const attributed = [];
  const unattributable = [];
  const acked = [];
  const removed = [];
  const usedAcksHash = new Set();
  const usedAcksGrowth = new Set();
  let moved = 0;

  const runtimes = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const runtime of [...runtimes].sort()) {
    const before = baseline[runtime] || {};
    const after = current[runtime] || {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const rel of [...keys].sort()) {
      const had = Object.prototype.hasOwnProperty.call(before, rel);
      const has = Object.prototype.hasOwnProperty.call(after, rel);

      if (had && has && before[rel] === after[rel]) continue; // unchanged — ignored

      const change = !had ? 'added' : (!has ? 'removed' : 'modified');
      moved++;

      let attribution;
      try {
        attribution = attributeEmittedPath(rel, runtime);
      } catch (err) {
        // A path the Phase 2 table cannot resolve is surfaced, never silently skipped —
        // otherwise a table hole becomes a blind spot in the differential too.
        errors.push(`${runtime}: ${rel}: ${err.message}`);
        continue;
      }

      const record = { runtime, rel, change, ruleId: attribution.ruleId, kind: attribution.kind };

      if (change === 'removed') removed.push(record);

      // Synthesized paths carry no repo source by definition, so a delta in them can
      // never be "unexplained by the diff" — exempt, but still counted and reported.
      if (attribution.kind === 'synthesized') {
        attributed.push({ ...record, via: '<synthesized: exempt>' });
        continue;
      }

      // Sources are checked before transforms so `via` is deterministic when a moved
      // path is explained by both at once — the SOURCE is the more specific, more
      // legible story ("the agent file changed") and is what a reviewer expects to
      // see first, not an accident of iteration order.
      let via = null;
      for (const source of attribution.sources) {
        const hit = sourceSatisfiedBy(source, changedSet);
        // `!== null`, not truthiness: an exact match returns the source string, and an
        // empty-string source would return '' — falsy, so a real match would be
        // silently discarded. Unreachable with today's rules (every source is a
        // non-empty template) but it is a footgun for the next rule author.
        if (hit !== null) { via = hit; break; }
      }
      // #2757: a `derived`/`code-derived` artifact's bytes can also move because the
      // TRANSFORM code that generates them changed, not the source it derives from —
      // `sources` alone cannot express that. Reuses `sourceSatisfiedBy` unchanged so
      // exact/prefix semantics stay identical for both lists.
      if (via === null) {
        for (const transform of attribution.transforms) {
          const hit = sourceSatisfiedBy(transform, changedSet);
          if (hit !== null) { via = hit; break; }
        }
      }

      if (via !== null) {
        attributed.push({ ...record, via });
      } else if (liveAckHash.has(rel)) {
        // `liveAckHash` ONLY — a `liveAckGrowth` entry naming the same string by
        // coincidence must NOT excuse a hash-space ripple (row 3).
        usedAcksHash.add(rel);
        acked.push({ ...record, reason: liveAckHash.get(rel).reason });
      } else {
        unattributable.push({
          ...record,
          expectedSources: attribution.sources,
          expectedTransforms: attribution.transforms,
        });
      }
    }
  }

  // ── Size ratchet, folded into the same machine (ADR-2719 §4, must-have 6) ──
  // NOTE: stale-ack detection is computed AFTER this block, not before. An ack may be
  // consumed by either a hash move or a size growth, so computing it earlier would
  // report a size-growth ack as stale.
  const grown = [];
  const shrunk = [];
  const newFileCapExceeded = [];
  if (sizeBaseline && sizeCurrent) {
    for (const name of Object.keys(sizeCurrent).sort()) {
      if (!Object.prototype.hasOwnProperty.call(sizeBaseline, name)) {
        // No baseline entry: this file is NEW. No `from` to diff against, so the
        // growth ratchet does not apply — but the absolute new-file cap does
        // (ADR-1610 Decision point 3). Never ack-able; see NEW_FILE_CAP's doc comment.
        const bytes = sizeCurrent[name];
        if (bytes > NEW_FILE_CAP) newFileCapExceeded.push({ name, bytes, cap: NEW_FILE_CAP });
        continue;
      }
      const from = sizeBaseline[name];
      const to = sizeCurrent[name];
      if (to > from) {
        // Growth needs the SAME acknowledgment. Anti-creep survives without pinning a
        // number: "verify-work.md grew 1,247 bytes" beats a number moving in a 93-line map.
        // `liveAckGrowth` ONLY (row 6) — the mirror of the hash pass above.
        const isAcked = liveAckGrowth.has(name);
        if (isAcked) usedAcksGrowth.add(name);
        grown.push({ name, from, to, delta: to - from, acked: isAcked });
      } else if (to < from) {
        // Shrinkage is not creep — reported, never gated.
        shrunk.push({ name, from, to, delta: from - to });
      }
    }
  }

  const unackedGrowth = grown.filter((g) => !g.acked);

  // An ack that outlives the ripple it explained is future blindness: it would silently
  // pre-clear a NEW ripple on the same path. It must be deleted when the ripple is.
  // Computed here, once, after BOTH the hash pass and the size pass have consumed acks.
  //
  // Reported PER SPACE — `{key, space}`, never a bare string — so the message can say
  // WHICH trailer declared the unconsumed key (row 7). A string-prefix convention
  // (`hash:<key>`) was considered and rejected: it would encode the namespace in a
  // string the consumer must remember to strip, the same convention-not-code weakness
  // #3942's design explicitly declines elsewhere (40-design.md "Rejected").
  const staleAcks = [
    ...[...liveAckHash.keys()].filter((k) => !usedAcksHash.has(k)).sort().map((key) => ({ key, space: 'hash' })),
    ...[...liveAckGrowth.keys()].filter((k) => !usedAcksGrowth.has(k)).sort().map((key) => ({ key, space: 'growth' })),
  ];

  const ok = errors.length === 0
    && unattributable.length === 0
    && unackedGrowth.length === 0
    && staleAcks.length === 0
    && newFileCapExceeded.length === 0;

  return {
    moved,
    attributed,
    unattributable,
    acked,
    removed,
    grown,
    shrunk,
    newFileCapExceeded,
    staleAcks,
    errors,
    ok,
  };
}

/**
 * The report as a typed intermediate representation, before any rendering (#2778).
 *
 * `formatReport`'s output is the human-facing deliverable ADR-2719 §1 sells the design
 * on — but CONTRIBUTING.md ("Prohibited: Raw Text Matching on Test Outputs") is explicit
 * that a human formatter must expose a structured surface for tests to assert on, so a
 * reworded sentence is never a failing test and a passing test never depends on prose.
 * `formatReport` is a pure rendering of this; assert on this.
 *
 * @returns {{ blocks: Array<{kind: string} & object>, ackable: Array<{key: string, reason: string}> }}
 */
function buildReport(result, { sampleLimit = 20 } = {}) {
  const blocks = [];

  if (result.errors.length) {
    blocks.push({
      kind: 'errors',
      count: result.errors.length,
      items: result.errors.slice(0, sampleLimit),
    });
  }

  const unackedGrowth = result.grown.filter((g) => !g.acked);

  if (result.unattributable.length) {
    blocks.push({
      kind: 'unattributable',
      count: result.unattributable.length,
      items: result.unattributable.slice(0, sampleLimit),
      truncated: Math.max(0, result.unattributable.length - sampleLimit),
      keyRule: REMEDIATION.rippleKeyRule,
    });
  }

  if (unackedGrowth.length) {
    blocks.push({
      kind: 'unacked-growth',
      count: unackedGrowth.length,
      items: unackedGrowth.slice(0, sampleLimit),
      keyRule: REMEDIATION.growthKeyRule,
    });
  }

  if (result.newFileCapExceeded.length) {
    // Deliberately carries NO ack affordance: the new-file cap is not ack-able, and the
    // fix is extraction. Offering a document here would teach an entry that cannot clear
    // the gate — worse than the silence it replaced.
    blocks.push({
      kind: 'new-file-cap',
      count: result.newFileCapExceeded.length,
      items: result.newFileCapExceeded.slice(0, sampleLimit),
    });
  }

  if (result.staleAcks.length) {
    blocks.push({
      kind: 'stale-acks',
      count: result.staleAcks.length,
      items: result.staleAcks.slice(0, sampleLimit),
      fix: REMEDIATION.staleAckFix,
    });
  }

  // ONE ack set for the whole report, not one per branch. A report can trip the hash
  // branch and the size branch at once (a feature PR that both ripples an emitted path
  // and grows a workflow). Capped at `sampleLimit` per branch so the taught trailers stay
  // consistent with the lists above them rather than naming rows the report chose not to
  // print. `space` tags each entry with the trailer namespace it belongs to (#3942), so
  // the renderer can pick `Emitted-Drift-Ack-Hash` vs `Emitted-Drift-Ack-Growth` per line.
  const ackable = [
    ...result.unattributable.slice(0, sampleLimit)
      .map((u) => ({ key: u.rel, reason: REMEDIATION.rippleReason, space: 'hash' })),
    ...unackedGrowth.slice(0, sampleLimit)
      .map((g) => ({ key: g.name, reason: REMEDIATION.growthReason, space: 'growth' })),
  ];

  return { blocks, ackable };
}

/**
 * Render a report as the failure message ADR-2719 §1 specifies — it sells the whole
 * design on this text, so it is a deliverable, not a detail. Pure rendering of
 * `buildReport`; tests assert on that IR, not on these sentences.
 */
function formatReport(result, { sampleLimit = 20 } = {}) {
  const parts = [];

  if (result.errors.length) {
    parts.push(`${result.errors.length} error(s):\n  ${result.errors.slice(0, sampleLimit).join('\n  ')}`);
  }

  if (result.unattributable.length) {
    const list = result.unattributable.slice(0, sampleLimit)
      .map((u) => {
        // #2757: a rule may explain a moved path via its source OR its transform
        // code; name whichever possibilities exist so the message tells the whole
        // story, not just half of it.
        const expected = [
          u.expectedSources.length ? `a change under ${u.expectedSources.join(' or ')}` : null,
          (u.expectedTransforms && u.expectedTransforms.length)
            ? `a transform change under ${u.expectedTransforms.join(' or ')}`
            : null,
        ].filter(Boolean).join(', or ');
        return `  ${u.runtime}: ${u.rel}\n      rule ${u.ruleId}; expected ${expected}`;
      });
    parts.push(
      `${result.unattributable.length} emitted path(s) changed that nothing in this diff explains:\n${list.join('\n')}` +
      (result.unattributable.length > sampleLimit
        ? `\n  …and ${result.unattributable.length - sampleLimit} more`
        : '') +
      `\n\n${REMEDIATION.rippleKeyRule}.`,
    );
  }

  const unackedGrowth = result.grown.filter((g) => !g.acked);
  if (unackedGrowth.length) {
    const list = unackedGrowth.slice(0, sampleLimit)
      .map((g) => `  ${g.name} grew ${g.delta} bytes (${g.from} -> ${g.to})`);
    parts.push(
      `${unackedGrowth.length} file(s) grew without an acknowledgment:\n${list.join('\n')}\n\n` +
      `${REMEDIATION.growthKeyRule}.`,
    );
  }

  if (result.newFileCapExceeded.length) {
    const list = result.newFileCapExceeded.slice(0, sampleLimit)
      .map((f) => `  ${f.name} is ${f.bytes} bytes — exceeds the ${f.cap}-byte new-file cap (ADR-1610)`);
    parts.push(
      `${result.newFileCapExceeded.length} new file(s) exceed the new-file cap (extract, not ack):\n${list.join('\n')}`,
    );
  }

  if (result.staleAcks.length) {
    // Each item names WHICH trailer declared it (#3942 row 7) — a hash-space entry
    // renders as `Emitted-Drift-Ack-Hash: <key>`, a growth-space one as
    // `Emitted-Drift-Ack-Growth: <key>`, via the SAME `renderAckTrailer` the taught
    // example below uses, with a placeholder reason (the real reason is what made it
    // stale in the first place — irrelevant to naming the fix).
    const list = result.staleAcks.slice(0, sampleLimit)
      .map(({ key, space }) => `  ${renderAckTrailer(
        space === 'growth' ? ACK_TRAILER_GROWTH : ACK_TRAILER_HASH, key, '<its declared reason>',
      )}`);
    parts.push(
      `${result.staleAcks.length} stale acknowledgment(s) — written or reworded in THIS diff, ` +
      'but nothing here needed them, so they explain nothing:\n' +
      list.join('\n') +
      `\n\n${REMEDIATION.staleAckFix}`,
    );
  }

  // The remedy, once, at the end — one trailer per entry, never a file. The
  // instructional prose is picked PER SPACE PRESENT, not unconditionally: a report that
  // only trips the growth branch must not teach the hash trailer (and vice versa) — see
  // "the renderer emits the trailer instructions..." below. `addTrailerHash`/
  // `addTrailerGrowth` name their trailer WITHOUT a trailing colon specifically so this
  // prose and the colon-suffixed taught line right below it never double-count the SAME
  // trailer name in one message — see "a ripple and a growth in one report each get
  // their OWN trailer line".
  const { ackable } = buildReport(result, { sampleLimit });
  if (ackable.length) {
    const lines = ackable.map(({ key, reason, space }) => `  ${renderAckTrailer(
      space === 'growth' ? ACK_TRAILER_GROWTH : ACK_TRAILER_HASH, key, reason,
    )}`);
    const spacesPresent = new Set(ackable.map((a) => a.space));
    const instructions = [
      spacesPresent.has('hash') ? REMEDIATION.addTrailerHash : null,
      spacesPresent.has('growth') ? REMEDIATION.addTrailerGrowth : null,
    ].filter(Boolean).join('\n');
    parts.push(
      `${instructions}\n\n` +
      lines.join('\n') +
      `\n\n${REMEDIATION.doNotRegenerate}`,
    );
  }

  return parts.join('\n\n');
}

/**
 * ── #3942 commit-trailer acknowledgment grammar ──────────────────────────────
 *
 * `readAckTrailers` (`tests/helpers/emitted-runtime.cjs`) reads the raw trailer values
 * from git and hands them to `parseAckTrailers` below, whose two Maps are what
 * `diffEmitted`'s `ackHash`/`ackGrowth` parameters now consume directly (40-design.md).
 * `ACK_TRAILER_HASH`/`ACK_TRAILER_GROWTH`/`ACK_TRAILER_DELIM` are declared earlier in
 * this file (immediately before `REMEDIATION`), which calls `renderAckTrailer` at
 * module-eval time and therefore needs them initialized by then.
 */

/** Upper bound on trailers read from one range. Real implementation throws above this. */
const MAX_ACK_TRAILERS = 128;

/**
 * Parse trailer VALUES already extracted per trailer name (no git I/O — the two
 * independent namespaces, `hash` and `growth`, are each an array of the raw text after
 * `<Trailer-Name>: `, one entry per trailer instance found in range).
 *
 * Grammar (40-design.md): `<key> — <reason>`, split on the FIRST ` — ` (space, EM DASH,
 * space — `ACK_TRAILER_DELIM`) so a reason may itself contain further em dashes (row 29).
 * Key and reason are trimmed. A missing delimiter, an empty key, or an empty reason is a
 * per-value error naming the offending trailer — "name them and say why" (ADR-2719 §3).
 * A key that is `RESERVED_ACK_KEYS` (`__proto__`/`constructor`/`prototype`), or that
 * contains `<`, `>`, or whitespace (row 14 — a doc example like
 * `<emitted/path> — <reason>` must never arm itself), is rejected loudly.
 *
 * Same key declared twice WITHIN one space: identical after `normalizeAckReason`
 * (invisible-character-stripped, whitespace-collapsed) dedupes silently, keeping the
 * FIRST declaration; a genuinely different reason is a hard "declared twice" error and
 * the key is dropped from that space entirely — an ambiguous declaration must never
 * silently pick a winner. The two spaces (`hash`/`growth`) are independent namespaces:
 * the same key may legally appear in both (row 18).
 *
 * The cap (`MAX_ACK_TRAILERS`) is checked on the DISTINCT (key, reason) count, AFTER
 * the same-key dedup above — never on the raw input count. A commit trailer, unlike the
 * pre-#3942 fragment file it replaces, legitimately survives a rebase: the identical
 * trailer text is carried forward on each rebased commit, and `git log` over the range
 * then reports it once per commit it lives on. Counting the raw values would throw on a
 * perfectly legitimate branch purely because it was rebased across many commits, even
 * though every value collapses to the SAME map entry above. Counting only what actually
 * survives dedup is what makes the cap mean "too many distinct declarations" rather
 * than "too many git objects happen to carry this text" — still throwing, never
 * truncating, on a genuine overflow, because a truncated read would silently drop
 * acknowledgments (the same law the pre-#3942 fragment-directory cap enforced for its
 * own listing).
 *
 * @param {{hash?: string[], growth?: string[]}} [trailers]
 * @returns {{hash: Map<string, {reason: string}>, growth: Map<string, {reason: string}>, errors: string[]}}
 */
function parseAckTrailers({ hash = [], growth = [] } = {}) {
  const errors = [];
  const spaces = [
    { name: ACK_TRAILER_HASH, values: hash, map: new Map() },
    { name: ACK_TRAILER_GROWTH, values: growth, map: new Map() },
  ];

  for (const space of spaces) {
    const conflicted = new Set(); // keys already reported ambiguous — never resurrected
    for (const raw of space.values) {
      const delimIndex = raw.indexOf(ACK_TRAILER_DELIM);
      if (delimIndex === -1) {
        errors.push(
          `${space.name}: trailer value ${JSON.stringify(raw)} has no "${ACK_TRAILER_DELIM}" `
          + 'delimiter — expected "<key> — <reason>"',
        );
        continue;
      }
      const key = raw.slice(0, delimIndex).trim();
      const reason = raw.slice(delimIndex + ACK_TRAILER_DELIM.length).trim();

      if (key === '') {
        errors.push(`${space.name}: trailer value ${JSON.stringify(raw)} has an empty key`);
        continue;
      }
      if (reason === '') {
        errors.push(
          `${space.name}: trailer value ${JSON.stringify(raw)} has an empty reason — `
          + 'name it and say why (ADR-2719 §3)',
        );
        continue;
      }
      if (RESERVED_ACK_KEYS.has(key)) {
        errors.push(
          `${space.name}: trailer key "${key}" is reserved and can never be a valid `
          + 'emitted path or workflow/agent filename — remove it',
        );
        continue;
      }
      if (/[<>\s]/.test(key)) {
        errors.push(
          `${space.name}: trailer key ${JSON.stringify(key)} is an invalid key — keys may `
          + 'not contain "<", ">", or whitespace',
        );
        continue;
      }

      if (conflicted.has(key)) continue;

      const existing = space.map.get(key);
      if (existing === undefined) {
        space.map.set(key, { reason });
      } else if (normalizeAckReason(existing.reason) === normalizeAckReason(reason)) {
        // Identical after normalization (invisible chars stripped, whitespace collapsed)
        // — dedupe silently, keep the first declaration.
      } else {
        errors.push(
          `${space.name}: trailer key "${key}" is declared twice with ambiguous, `
          + 'conflicting reasons — an ambiguous declaration cannot silently pick a winner',
        );
        space.map.delete(key);
        conflicted.add(key);
      }
    }
  }

  // Post-dedup: distinct (key, reason) declarations that actually survive into the
  // returned Maps — see this function's doc comment for why raw input count is the
  // wrong thing to cap on. A key dropped above (an ambiguous conflicting duplicate) is
  // already absent from `space.map` here and correctly does not count either.
  const distinctCount = spaces[0].map.size + spaces[1].map.size;
  if (distinctCount > MAX_ACK_TRAILERS) {
    throw new Error(
      `emitted-drift ack: ${distinctCount} distinct commit trailer declarations were found `
      + `in range, exceeding the cap of ${MAX_ACK_TRAILERS} trailers. Refusing to read only `
      + 'some of them — a truncated read would silently drop acknowledgments. Prune spent '
      + 'trailers (amend or drop them) rather than letting the count grow unbounded.',
    );
  }

  return { hash: spaces[0].map, growth: spaces[1].map, errors };
}

/**
 * Render one trailer LINE (`<name>: <key> — <reason>`) for docs and self-serve
 * remediation text. Deliberately the exact grammar `parseAckTrailers` parses, so this
 * round-trips through it (row 33/36) — a doc example built from this function can never
 * drift from what the reader actually accepts.
 *
 * @param {string} trailerName
 * @param {string} key
 * @param {string} reason
 * @returns {string}
 */
function renderAckTrailer(trailerName, key, reason) {
  return `${trailerName}: ${key}${ACK_TRAILER_DELIM}${reason}`;
}

module.exports = {
  NEW_FILE_CAP,
  REMEDIATION,
  INVISIBLE,
  normalizeAckReason,
  sourceSatisfiedBy,
  diffEmitted,
  buildReport,
  formatReport,
  ACK_TRAILER_HASH,
  ACK_TRAILER_GROWTH,
  ACK_TRAILER_DELIM,
  MAX_ACK_TRAILERS,
  parseAckTrailers,
  renderAckTrailer,
};
