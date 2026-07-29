'use strict';

/**
 * Differential emitted-artifact attribution — the conservation law (ADR-2719 §1,
 * issue #2723, epic #2719 Phase 3).
 *
 * Given the emitted manifests at `next` HEAD and at PR HEAD, plus the repo paths the
 * PR actually changed, decide which moved emitted paths are EXPLAINED by the diff and
 * which are not. Unattributable deltas are a hard failure that names them; the only
 * way through is a committed acknowledgment (`tests/emitted-drift-ack.json`).
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

/** Ack schema version. Pinned from day one: contributors hand-write this file, so its
 *  shape is public the moment it ships (Hyrum). Loosening later is easy; tightening is not. */
const ACK_VERSION = 1;

/**
 * The acknowledgment file, named ONCE (#2778).
 *
 * This string was previously typed by hand in `formatReport`'s unattributable branch, in
 * `parseAck`'s default `source`, and again as `ACK_PATH` in emitted-runtime.cjs. Adding a
 * fourth copy for the growth branch is the *generative fix divergence* class this repo
 * records: parallel surfaces reading one shared value must not be able to drift. One
 * definition consumed by every branch is cheaper than a parity test over four literals.
 */
const ACK_FILE = 'tests/emitted-drift-ack.json';

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
 * Render the minimal valid acknowledgment document for a set of entries (#2778).
 *
 * Built with `JSON.stringify` from `ACK_VERSION` rather than typed out, for two reasons: the
 * printed document is guaranteed to be syntactically valid JSON, and it cannot fall out of
 * step with the version `parseAck` enforces. A hand-typed `"version": 1` sitting beside a live
 * `ACK_VERSION` is the drift this module warns about everywhere else.
 *
 * It teaches exactly ONE shape. `parseAck` is deliberately more liberal — it accepts a bare
 * string as the reason and tolerates a missing `version` or `paths`. Be liberal in what you
 * accept, conservative in what you send: advertising those tolerances would spread a quirk
 * into hand-written contributor files and make the canonical form look optional.
 *
 * It takes ALL the entries at once and renders ONE document, which is not a convenience:
 * a report can trip the hash branch and the size branch together (a feature PR that both
 * ripples an emitted path and grows a workflow). Printing a complete document per branch
 * made each look like "the file to create", so a contributor pasting the second over the
 * first would silently lose the first acknowledgment — an ack-lost failure with no signal.
 * One document, one file, one paste.
 */
function ackDocument(entries) {
  const paths = {};
  for (const { key, reason } of entries) paths[key] = { reason };
  return JSON.stringify({ version: ACK_VERSION, paths });
}

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
  ackFile: ACK_FILE,
  createIfAbsent: 'create the file if absent — it exists only when something needs acknowledging',
  doNotRegenerate:
    'Do NOT regenerate anything to silence this — there is nothing left to regenerate.',
  /** The size ratchet keys on `entry.name` from readdirSync (emitted-runtime.cjs `currentSizes`). */
  growthKeyRule: 'Key on the BARE FILENAME as it appears under gsd-core/workflows/ or agents/',
  /** The hash pass keys on the emitted manifest path, which always carries a `/`. */
  rippleKeyRule: 'Key on the EMITTED PATH exactly as printed above',
  rippleReason: '<why this ripple is deliberate>',
  growthReason: '<why this growth is deliberate>',
  staleAckFix:
    `Delete those entries from ${ACK_FILE}. If that leaves no entries, delete the file `
    + 'itself — its PRESENCE is the alarm, so an empty one signals nothing.',
  ackDocument,
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
 * Normalize + validate the acknowledgment document.
 *
 * Rejects a document that parses but is not a plain object. Treating `0` / `"s"` / `[]` /
 * `null` / `true` as "no acks" would SILENTLY DISARM the gate — the single worst failure
 * available here, because it looks identical to a healthy run.
 *
 * @returns {{ entries: Map<string, {reason: string, runtime?: string}>, errors: string[] }}
 */
function parseAck(doc, { source = 'emitted-drift-ack.json' } = {}) {
  const errors = [];
  const entries = new Map();

  if (doc === null || doc === undefined) return { entries, errors }; // absent == no acks (legal)

  if (typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push(
      `${source}: must be a JSON object, got ${Array.isArray(doc) ? 'array' : typeof doc}`,
    );
    return { entries, errors };
  }

  if (doc.version !== undefined && doc.version !== ACK_VERSION) {
    errors.push(`${source}: unsupported version ${JSON.stringify(doc.version)} (expected ${ACK_VERSION})`);
  }

  const paths = doc.paths;
  if (paths === undefined) return { entries, errors }; // `{}` or `{version:1}` == no acks
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
    errors.push(`${source}: "paths" must be an object of <emitted path> -> { reason }`);
    return { entries, errors };
  }

  for (const [rel, value] of Object.entries(paths)) {
    const reason = value && typeof value === 'object' ? value.reason : value;
    if (typeof reason !== 'string' || reason.trim() === '') {
      // "name them AND say why" is the contract (ADR-2719 §3). An ack with no reason
      // is a silent regeneration wearing a declaration's clothes.
      errors.push(`${source}: ack for "${rel}" has no non-empty "reason"`);
      continue;
    }
    entries.set(rel, {
      reason: reason.trim(),
      runtime: value && typeof value === 'object' ? value.runtime : undefined,
    });
  }

  return { entries, errors };
}

/**
 * The conservation law.
 *
 * @param {object}   opts
 * @param {object}   opts.baseline      { [runtime]: { [rel]: hash } } at `next` HEAD
 * @param {object}   opts.current       { [runtime]: { [rel]: hash } } at PR HEAD
 * @param {string[]} opts.changedPaths  repo paths the PR changed (git diff --name-only)
 * @param {object}   [opts.ack]         parsed emitted-drift-ack.json document (or null)
 * @param {object}   [opts.sizeBaseline] { [name]: bytes } workflow/agent sizes at next
 * @param {object}   [opts.sizeCurrent]  { [name]: bytes } workflow/agent sizes at PR HEAD
 *
 * @returns {{
 *   moved: number, attributed: Array, unattributable: Array, acked: Array,
 *   removed: Array, grown: Array, shrunk: Array, newFileCapExceeded: Array,
 *   staleAcks: string[], errors: string[], ok: boolean
 * }}
 */
function diffEmitted({
  baseline,
  current,
  changedPaths,
  ack = null,
  sizeBaseline = null,
  sizeCurrent = null,
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
  if (errors.length) {
    return {
      // `newFileCapExceeded` MUST be present here. formatReport reads
      // `result.newFileCapExceeded.length` unconditionally, so omitting it made this
      // early return throw a TypeError instead of rendering the errors it was built to
      // report — and this is precisely the path taken when `git diff` failed or a
      // manifest came back malformed, so the crash replaced the one message that would
      // have explained the infrastructure problem (#2778).
      moved: 0, attributed: [], unattributable: [], acked: [], removed: [],
      grown: [], shrunk: [], newFileCapExceeded: [], staleAcks: [], errors, ok: false,
    };
  }

  const changedSet = new Set(changedPaths);
  const { entries: ackEntries, errors: ackErrors } = parseAck(ack);
  errors.push(...ackErrors);

  const attributed = [];
  const unattributable = [];
  const acked = [];
  const removed = [];
  const usedAcks = new Set();
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
      } else if (ackEntries.has(rel)) {
        usedAcks.add(rel);
        acked.push({ ...record, reason: ackEntries.get(rel).reason });
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
        const isAcked = ackEntries.has(name);
        if (isAcked) usedAcks.add(name);
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
  const staleAcks = [...ackEntries.keys()].filter((rel) => !usedAcks.has(rel)).sort();

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
  // branch and the size branch at once, and two complete documents each reading as "the
  // file to create" invites pasting the second over the first — losing an acknowledgment
  // with no signal. Capped at `sampleLimit` per branch so the document stays consistent
  // with the lists above it rather than naming rows the report chose not to print.
  const ackable = [
    ...result.unattributable.slice(0, sampleLimit)
      .map((u) => ({ key: u.rel, reason: REMEDIATION.rippleReason })),
    ...unackedGrowth.slice(0, sampleLimit)
      .map((g) => ({ key: g.name, reason: REMEDIATION.growthReason })),
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
    parts.push(
      `${result.staleAcks.length} stale acknowledgment(s) — the ripple they explained is gone, ` +
      'so they must be deleted (an ack that outlives its ripple pre-clears the next one):\n  ' +
      result.staleAcks.slice(0, sampleLimit).join('\n  ') +
      `\n\n${REMEDIATION.staleAckFix}`,
    );
  }

  // The remedy, once, at the end — one file, one document, one paste.
  const { ackable } = buildReport(result, { sampleLimit });
  if (ackable.length) {
    parts.push(
      `To acknowledge, create ${REMEDIATION.ackFile}\n` +
      `(${REMEDIATION.createIfAbsent})\n` +
      'containing ONE document that names every path listed above and why:\n\n' +
      `  ${REMEDIATION.ackDocument(ackable)}\n\n` +
      REMEDIATION.doNotRegenerate,
    );
  }

  return parts.join('\n\n');
}

module.exports = {
  ACK_VERSION,
  ACK_FILE,
  NEW_FILE_CAP,
  REMEDIATION,
  sourceSatisfiedBy,
  parseAck,
  diffEmitted,
  buildReport,
  formatReport,
};
