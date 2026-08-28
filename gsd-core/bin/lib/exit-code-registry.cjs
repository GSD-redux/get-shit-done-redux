'use strict';

// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: gsd-core/bin/shared/exit-codes.json. Regenerate with:
//   node scripts/gen-exit-code-registry.cjs --write
// This exact content is emitted to THREE locations — gsd-core/bin/lib/exit-code-registry.cjs,
// scripts/lib/exit-code-registry.cjs, and hooks/lib/exit-code-registry.js (the latter two
// committed so scripts/ and hooks/ consumers work on an unbuilt clone) — all byte-compared by
// `npm run lint:generated-sync` (#3905 ADR-3889 Phase 1; #3906 Phase 2 added the second copy;
// #3911 ADR-3889 Phase 7 added the hooks/lib/ copy).
//
// exitCodeFor(name) / nameForExitCode(code) are pure and total over this
// closed table — each throws for anything not registered here.

const EXIT_CODES = Object.freeze([
  Object.freeze({
    code: 2,
    name: "HOOK_DENY",
    meaning: "Hook protocol deny — the harness blocks the tool call",
    owner: "hook-adapter",
    authorizedBy: "ADR-3889",
  }),
  Object.freeze({
    code: 64,
    name: "USAGE",
    meaning: "Caller error — bad argv, unknown subcommand, missing argument",
    owner: "generic",
    authorizedBy: "ADR-3889",
  }),
  Object.freeze({
    code: 66,
    name: "NO_INPUT",
    meaning: "Ran; zero units were in scope, and that emptiness is known to be genuine",
    owner: "generic",
    authorizedBy: "ADR-3889",
  }),
  Object.freeze({
    code: 69,
    name: "UNAVAILABLE",
    meaning: "Could not run — prerequisite absent, input unreadable, scope unestablished",
    owner: "generic",
    authorizedBy: "ADR-3889",
  }),
  Object.freeze({
    code: 70,
    name: "INTERNAL",
    meaning: "Self-failure — crash, timeout, killed subprocess",
    owner: "generic",
    authorizedBy: "ADR-3889",
  }),
  Object.freeze({
    code: 80,
    name: "DEGRADED",
    meaning: "Ran to completion and is reporting a condition through its result payload rather than as a process failure",
    owner: "gsd-tools",
    authorizedBy: "ADR-3889 + ADR-2980",
  })
]);

const NAME_TO_CODE = new Map(EXIT_CODES.map((entry) => [entry.name, entry.code]));
const CODE_TO_NAME = new Map(EXIT_CODES.map((entry) => [entry.code, entry.name]));

/**
 * Resolve the registered exit code for a symbolic name. Pure, total: throws
 * for anything not an exact, registered, exact-case key — including
 * non-strings, the empty string, untrimmed strings, wrong case, and
 * prototype-chain names like `__proto__`/`constructor`/`toString` (a Map
 * lookup never touches the prototype chain, so these are indistinguishable
 * from any other unregistered name).
 *
 * @param {string} name
 * @returns {number}
 */
function exitCodeFor(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`exitCodeFor: name must be a non-empty string, received ${JSON.stringify(name)}`);
  }
  if (!NAME_TO_CODE.has(name)) {
    throw new Error(`exitCodeFor: unregistered exit code name: ${JSON.stringify(name)}`);
  }
  return NAME_TO_CODE.get(name);
}

/**
 * Reverse of exitCodeFor: resolve the symbolic name for a registered exit
 * code. Pure, total: throws for anything not an exact, registered code.
 *
 * @param {number} code
 * @returns {string}
 */
function nameForExitCode(code) {
  if (!CODE_TO_NAME.has(code)) {
    throw new Error(`nameForExitCode: unregistered exit code: ${JSON.stringify(code)}`);
  }
  return CODE_TO_NAME.get(code);
}

module.exports = { EXIT_CODES, exitCodeFor, nameForExitCode };
