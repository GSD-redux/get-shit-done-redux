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
 *   removed: Array, grown: Array, shrunk: Array, staleAcks: string[], errors: string[], ok: boolean
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
      moved: 0, attributed: [], unattributable: [], acked: [], removed: [],
      grown: [], shrunk: [], staleAcks: [], errors, ok: false,
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

      let via = null;
      for (const source of attribution.sources) {
        const hit = sourceSatisfiedBy(source, changedSet);
        // `!== null`, not truthiness: an exact match returns the source string, and an
        // empty-string source would return '' — falsy, so a real match would be
        // silently discarded. Unreachable with today's rules (every source is a
        // non-empty template) but it is a footgun for the next rule author.
        if (hit !== null) { via = hit; break; }
      }

      if (via !== null) {
        attributed.push({ ...record, via });
      } else if (ackEntries.has(rel)) {
        usedAcks.add(rel);
        acked.push({ ...record, reason: ackEntries.get(rel).reason });
      } else {
        unattributable.push({ ...record, expectedSources: attribution.sources });
      }
    }
  }

  // ── Size ratchet, folded into the same machine (ADR-2719 §4, must-have 6) ──
  // NOTE: stale-ack detection is computed AFTER this block, not before. An ack may be
  // consumed by either a hash move or a size growth, so computing it earlier would
  // report a size-growth ack as stale.
  const grown = [];
  const shrunk = [];
  if (sizeBaseline && sizeCurrent) {
    for (const name of Object.keys(sizeCurrent).sort()) {
      if (!Object.prototype.hasOwnProperty.call(sizeBaseline, name)) continue;
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
    && staleAcks.length === 0;

  return {
    moved,
    attributed,
    unattributable,
    acked,
    removed,
    grown,
    shrunk,
    staleAcks,
    errors,
    ok,
  };
}

/**
 * Render a report as the failure message ADR-2719 §1 specifies — it sells the whole
 * design on this text, so it is a deliverable, not a detail.
 */
function formatReport(result, { sampleLimit = 20 } = {}) {
  const parts = [];

  if (result.errors.length) {
    parts.push(`${result.errors.length} error(s):\n  ${result.errors.slice(0, sampleLimit).join('\n  ')}`);
  }

  if (result.unattributable.length) {
    const list = result.unattributable.slice(0, sampleLimit)
      .map((u) => `  ${u.runtime}: ${u.rel}\n      rule ${u.ruleId}; expected a change under ${u.expectedSources.join(' or ')}`);
    parts.push(
      `${result.unattributable.length} emitted path(s) changed that nothing in this diff explains:\n${list.join('\n')}` +
      (result.unattributable.length > sampleLimit
        ? `\n  …and ${result.unattributable.length - sampleLimit} more`
        : '') +
      '\n\nIf this ripple is intended, record it in tests/emitted-drift-ack.json naming each\n' +
      'path and why. Do NOT regenerate anything to silence this.',
    );
  }

  const unackedGrowth = result.grown.filter((g) => !g.acked);
  if (unackedGrowth.length) {
    const list = unackedGrowth.slice(0, sampleLimit)
      .map((g) => `  ${g.name} grew ${g.delta} bytes (${g.from} -> ${g.to})`);
    parts.push(
      `${unackedGrowth.length} file(s) grew without an acknowledgment:\n${list.join('\n')}`,
    );
  }

  if (result.staleAcks.length) {
    parts.push(
      `${result.staleAcks.length} stale acknowledgment(s) — the ripple they explained is gone, ` +
      'so they must be deleted (an ack that outlives its ripple pre-clears the next one):\n  ' +
      result.staleAcks.slice(0, sampleLimit).join('\n  '),
    );
  }

  return parts.join('\n\n');
}

module.exports = {
  ACK_VERSION,
  sourceSatisfiedBy,
  parseAck,
  diffEmitted,
  formatReport,
};
