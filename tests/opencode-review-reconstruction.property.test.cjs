/**
 * OpenCode review reconstruction — property tests (#1936).
 *
 * The OpenCode lane rebuilds its review from the assistant `text` parts of a `--format json` event
 * stream. `--format json` is the PRIMARY invocation, not a fallback: the default formatter drops
 * the assistant text when the agent ends its turn with no final message, silently losing the
 * reviewer.
 *
 * This suite used to extract two embedded `jq` programs from `review.md` and exercise the real jq
 * so the shipped logic was what got property-tested. Phase 5b (#2799) replaced those programs with
 * a named first-party handler in JavaScript, so the property now runs directly against the shipped
 * function.
 *
 * That deletes the entire #2099 problem this file was architected around. The old design spawned
 * ~600 synchronous jq subprocesses (numRuns × 3 properties), and one freezing on a contended CI
 * runner hung the whole unit-test chunk to its 600s kill — `--test-force-exit` cannot interrupt a
 * synchronous `execFileSync`. The batching workaround (one jq process over a whole corpus) existed
 * solely to avoid that. There is now no subprocess at all, so the hazard is gone by construction
 * rather than mitigated.
 */

'use strict';

const { describe, test } = require('node:test');
const fc = require('fast-check');

const { handleOpencodeOutput } = require('../gsd-core/bin/lib/review-lane-runner.cjs');

/** Deterministic: pinned seed, bounded runs, replay data printed on failure. */
const FC = { seed: 42, numRuns: 200 };

const NL = String.fromCharCode(10);

/** An assistant text event, as opencode emits it. */
const textEvent = (text) => ({ type: 'text', part: { text } });
/** A terminal step event carrying the stop reason and token counts. */
const stepFinish = (reason, output) => ({ type: 'step_finish', part: { reason, tokens: { output } } });

/** Serialize events the way opencode does: one compact JSON value per line. */
const streamOf = (events) => events.map((e) => JSON.stringify(e)).join(NL);

/** Text that survives a JSON round-trip, including the shapes that broke the jq version. */
const hostileText = fc.oneof(
  fc.string(),
  fc.constantFrom('', ' ', '   ', NL, 'a' + NL + 'b', '"quoted"', '\\backslash', 'emoji 🎉', 'null', '-n'),
  fc.string({ unit: 'grapheme' }),
);

describe('opencode reconstruction — properties', () => {
  test('every assistant text part appears, in order, joined by newlines', () => {
    fc.assert(
      fc.property(fc.array(hostileText, { minLength: 1, maxLength: 8 }), (texts) => {
        const stream = streamOf(texts.map(textEvent));
        return handleOpencodeOutput(stream).review === texts.join(NL);
      }),
      FC,
    );
  });

  test('non-text events never contribute to the review', () => {
    fc.assert(
      fc.property(
        fc.array(hostileText, { minLength: 1, maxLength: 5 }),
        fc.array(fc.record({ reason: fc.string(), output: fc.nat() }), { maxLength: 4 }),
        (texts, steps) => {
          const events = [...texts.map(textEvent), ...steps.map((s) => stepFinish(s.reason, s.output))];
          return handleOpencodeOutput(streamOf(events)).review === texts.join(NL);
        },
      ),
      FC,
    );
  });

  test('a malformed line is skipped without losing the surrounding review', () => {
    // Losing an entire review to one unparseable line would be strictly worse than the bug this
    // handler exists to fix, so a partial stream must still yield its usable text.
    fc.assert(
      fc.property(
        fc.array(hostileText, { minLength: 1, maxLength: 4 }),
        fc.constantFrom('NOT JSON', '{"truncated":', '}{', '[', 'null', '   '),
        (texts, garbage) => {
          const lines = [...texts.map((t) => JSON.stringify(textEvent(t))), garbage];
          return handleOpencodeOutput(lines.join(NL)).review === texts.join(NL);
        },
      ),
      FC,
    );
  });

  test('is total — never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (anything) => {
        try {
          const r = handleOpencodeOutput(anything);
          return typeof r.review === 'string' && typeof r.diagnostic === 'string';
        } catch {
          return false;
        }
      }),
      FC,
    );
  });

  test('CRLF streams reconstruct identically to LF', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }), (texts) => {
        const lf = streamOf(texts.map(textEvent));
        const crlf = lf.split(NL).join(String.fromCharCode(13) + NL);
        return handleOpencodeOutput(lf).review === handleOpencodeOutput(crlf).review;
      }),
      FC,
    );
  });

  test('a stream with no assistant text yields an empty review and a diagnostic', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(), (reason, output) => {
        const r = handleOpencodeOutput(streamOf([stepFinish(reason, output)]));
        return r.review === '' && r.diagnostic.includes(String(output));
      }),
      FC,
    );
  });
});
