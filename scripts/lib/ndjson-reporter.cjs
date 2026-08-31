'use strict';

// Machine-readable companion reporter for scripts/run-tests.cjs (#3889).
//
// node:test's built-in reporters (spec/tap) are human-formatted and
// scripts/run-tests.cjs spawns the child with `stdio: 'inherit'` — by design,
// per #3597/#1051, to avoid the maxBuffer and live-output risks of piping —
// so the parent process has no way to see WHICH file was executing when a
// per-chunk timeout kills the child. This reporter runs ALONGSIDE the normal
// human reporter (a second `--test-reporter` on the same invocation, per
// Node's documented multi-reporter pairing) and appends one JSON object per
// line to a path supplied via the GSD_RUN_TESTS_EVENTS_FILE env var. On a
// timeout, run-tests.cjs reads that file back to name the file(s) still
// in flight (a `test:dequeue` with no matching `test:pass`/`test:fail`).
//
// Durability, not `--test-reporter-destination` (#3889 root cause): a
// reporter that YIELDS strings has them piped by Node into a
// `fs.WriteStream` targeting the destination path, and that stream buffers.
// The parent's `execFileSync` timeout SIGKILLs the child on a hang, and
// SIGKILL is uncatchable and gives the process zero chance to flush — so a
// yield-based reporter can lose every event still sitting in the stream's
// buffer, which is exactly the case this feature exists to diagnose (proven
// live: a chunk killed at 2006ms produced a `killed after 2006ms` line from
// the TIMER, which lives in the parent, but zero usable events from the
// reporter, which lives in the child and never flushed). Writing each event
// with `fs.appendFileSync` — synchronous and unbuffered — makes it durable
// the instant it happens, before the process can be killed out from under
// it. The reporter therefore yields NOTHING; it is a pure side-effecting
// sink. Node still requires a `--test-reporter-destination` to pair with
// this `--test-reporter` (see run-tests.cjs's reporterArgsFor), but that
// destination is a throwaway sink that stays empty by design — the durable
// path is GSD_RUN_TESTS_EVENTS_FILE, not the destination Node manages.
//
// Contract targeted: Node's "Custom reporters" contract
// (https://nodejs.org/api/test.html#custom-reporters) — a reporter module's
// default export is a function receiving the test runner's event stream (an
// AsyncIterable of `{ type, data }` objects). Node feeds that function to
// `stream.compose` as the stream's "body". When the body is an async
// FUNCTION (not an `async function*` generator), `stream.compose`'s own
// contract (https://nodejs.org/api/stream.html#streamcomposestreams)
// requires it to return nully (undefined/null) — returning anything else,
// including an array, throws `ERR_INVALID_RETURN_VALUE` ("Expected nully to
// be returned from the 'body' function but got an instance of Array")
// exactly once the promise resolves. Verified directly against
// `stream.compose` in this repo's Node: calling it with a body that
// `return`s `[]` reproduces that same TypeError. A generator form
// (`async function*`) is the one that yields an iterable; the plain
// `async function` form used here is the one that must return nully. This
// repo's `engines.node` requires >=24.0.0 (package.json), where both
// contracts have been stable since Node 20.
//
// Kept intentionally tiny: only the five event types run-tests.cjs needs are
// handled — `test:enqueue`/`test:dequeue` (emitted by the RUNNER as it queues
// and begins each spawned test-file child, independent of whether anything
// inside that file ever completes) plus `test:start`/`test:pass`/`test:fail`
// (emitted per-subtest, once the child reports it). `test:dequeue` is the
// event that actually means "in flight": a subtest inside a file that hangs
// forever never reaches `test:start`/`test:pass`/`test:fail` at all, because
// node:test only surfaces those to the parent once the child COMPLETES that
// test — a hang, by definition, never completes. Recording `test:dequeue`
// closes that gap: it fires the moment the runner begins the file, so a
// killed hang still leaves a durable "this file was running" record.
// Everything else (diagnostics, plans, coverage) is ignored so a truncated
// events file (the process is SIGKILLed mid-`appendFileSync` on timeout — an
// individual write is unbuffered but not atomic, so the OS can still
// interleave a partial write with the kill) never leaves more than one
// dangling unparsable trailing line.
module.exports = async function ndjsonEventReporter(source) {
  const eventsPath = process.env.GSD_RUN_TESTS_EVENTS_FILE;
  // #3889: an init marker, written as this reporter's FIRST action — before
  // the `for await` loop even begins consuming the event stream — so the
  // events file's mere existence (and its exact contents) can distinguish
  // "the reporter module never loaded in the child at all" (file absent)
  // from "it loaded fine but no test:start reached it before the kill"
  // (file contains only this one line) from "it's working" (file contains
  // more than this line). Same appendFileSync durability rationale as every
  // other write in this file: synchronous and unbuffered, so it survives an
  // uncatchable SIGKILL landing a moment later.
  if (eventsPath) {
    try {
      require('fs').appendFileSync(eventsPath, `${JSON.stringify({ type: 'reporter:init', ts: Date.now() })}\n`);
    } catch {
      // Best-effort, same as every other write below — must never crash the
      // test run this reporter is only observing.
    }
  }
  for await (const event of source) {
    if (!eventsPath) continue; // no destination configured — nothing to record
    if (
      event.type === 'test:enqueue' ||
      event.type === 'test:dequeue' ||
      event.type === 'test:start' ||
      event.type === 'test:pass' ||
      event.type === 'test:fail'
    ) {
      const { file, name, nesting, testNumber } = event.data || {};
      const line = `${JSON.stringify({
        type: event.type,
        file,
        name,
        nesting,
        testNumber,
        ts: Date.now(),
      })}\n`;
      try {
        require('fs').appendFileSync(eventsPath, line);
      } catch {
        // Best-effort: a write failure here (e.g. the events dir vanished)
        // must never crash the test run this reporter is only observing.
      }
    }
  }
  // Falls through to an implicit `return undefined` (nully): this reporter is
  // a pure side-effecting sink (see the durability note above), never a
  // source of reporter OUTPUT, and `stream.compose` requires its async
  // FUNCTION body to return nully — returning an iterable (e.g. `[]`) here
  // raises `ERR_INVALID_RETURN_VALUE` (observed live: this exact `return []`
  // crashed every chunk on the real remote run this regresses).
};
