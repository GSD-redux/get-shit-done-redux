'use strict';
// hooks/lib/hook-exit.js — hand-written, NOT generated. A tiny hook-facing
// vocabulary layered over hooks/lib/cli-exit.js's terminateNow (ADR-3889 §3),
// for the 19 enforcement hooks P7/#3911 is migrating off raw process.exit().
//
// WHY onCrash is a REQUIRED argument, with no default (this is the entire
// point of this module): every hook audited for #3911 ended its outer
// try/catch in ONE of two ways — some `process.exit(0)` (fail open: a hook
// error must never block a legitimate tool call), others `process.exit(2)`
// (fail closed: a hook whose whole job is a security/safety denial must not
// let its own bug wave the denial through). Both are legitimate policies for
// DIFFERENT hooks — but neither is the "obviously correct" one, and a shared
// helper that silently defaulted to either would let a future hook inherit
// the wrong policy by omission, which is exactly the "nothing fails with
// success" defect ADR-3889 exists to close. Requiring the caller to name its
// policy at every call site — not just once at module load — makes "I forgot
// to decide" a load-time/call-time crash instead of a silent behavior. A
// caller that truly wants "allow on crash" must still write ALLOW; there is
// no path that reaches terminateNow without a declared choice.
//
// crash() itself is total: it does not throw on a bad `onCrash`, because
// throwing would unwind into the CALLER's own outer catch — the exact
// fail-open-by-accident hazard this module removes. Instead an unrecognized
// policy terminates via terminateNow('INTERNAL', ...) with a diagnostic
// payload naming the offending value, so a typo'd/misspelled policy is
// debuggable on stderr rather than silently reinterpreted as ALLOW or DENY.
const { terminateNow } = require('./cli-exit.js');

/** Frozen enum of the two declarable crash policies. No third option. */
const HOOK_ON_CRASH = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
});

/** Terminate with the hook-protocol PASS outcome (exit 0). */
function allow(payload) {
  terminateNow('PASS', payload);
}

/**
 * Terminate with the hook-protocol deny outcome (exit 2, stdout+stderr).
 *
 * @param {*} payload - JSON-serializable value written to fd 1 (and, when
 *   `stderrPayload` is omitted, fd 2 too).
 * @param {*} [stderrPayload] - optional distinct value for fd 2, forwarded
 *   verbatim to terminateNow's own `stderrPayload` param — a string is
 *   written raw, anything else is JSON-stringified.
 */
function deny(payload, stderrPayload) {
  terminateNow('HOOK_DENY', payload, stderrPayload);
}

/**
 * Dispatch to allow()/deny() per a DECLARED crash policy. `onCrash` is
 * required — see the module header for why there is no default.
 *
 * @param {'allow'|'deny'} onCrash - one of HOOK_ON_CRASH's two values.
 * @param {*} payload - JSON-serializable value forwarded to terminateNow.
 */
function crash(onCrash, payload) {
  if (onCrash === HOOK_ON_CRASH.ALLOW) {
    allow(payload);
    return;
  }
  if (onCrash === HOOK_ON_CRASH.DENY) {
    deny(payload);
    return;
  }
  // Never guess a policy and never throw (a throw would unwind into the
  // caller's own outer catch — the fail-open-by-accident defect this module
  // exists to remove). Terminate deterministically with INTERNAL, naming the
  // offending value so a misspelled/omitted policy is diagnosable.
  terminateNow('INTERNAL', {
    error: 'hook-exit: crash() called with an unrecognized onCrash policy',
    receivedOnCrash: onCrash,
    expectedOneOf: [HOOK_ON_CRASH.ALLOW, HOOK_ON_CRASH.DENY],
    originalPayload: payload,
  });
}

module.exports = { HOOK_ON_CRASH, allow, deny, crash };
