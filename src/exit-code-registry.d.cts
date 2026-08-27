// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: gsd-core/bin/shared/exit-codes.json + the ENTRY_FIELD_TYPES table in
// scripts/gen-exit-code-registry.cjs. Regenerate with:
//   node scripts/gen-exit-code-registry.cjs --write
//
// Ambient type declaration for exit-code-registry.cjs — a GENERATED,
// committed artifact with no `.cts` source of its own (it is hand-serialized
// from gsd-core/bin/shared/exit-codes.json by scripts/gen-exit-code-registry.cjs,
// ADR-3889 §2, #3905/#3906), so tsc has nothing to compile for it. This file
// exists purely so `src/cli-exit.cts`'s `require('./exit-code-registry.cjs')`
// type-checks against the SAME shape the generated artifact actually exports
// at runtime — mirroring the src/vendor/*.d.cts pattern already used for
// other verbatim/generated JS this tree resolves types for without compiling.
//
// This declaration is generated from the same ENTRY_FIELD_TYPES table
// serializeRegistry()'s per-entry object literals iterate, and is
// byte-compared by `node scripts/gen-exit-code-registry.cjs --check`
// (the same check that already covers the two sibling .cjs artifacts) so a
// shape drift here fails the build instead of surfacing at a destructuring
// call site.

export interface ExitCodeEntry {
  readonly code: number;
  readonly name: string;
  readonly meaning: string;
  readonly owner: string;
  readonly authorizedBy: string;
}

declare const exitCodeRegistry: {
  readonly EXIT_CODES: readonly ExitCodeEntry[];
  // Property-typed function signatures (`name: (args) => ret`), NOT method
  // shorthand (`name(args): ret`) — the latter is a TS "method" and trips
  // @typescript-eslint/unbound-method at every destructuring call site
  // (`const { exitCodeFor } = ...`), since a method may implicitly use
  // `this`. These are pure functions that never do, so they are typed as
  // plain function-valued properties instead.
  exitCodeFor: (name: string) => number;
  nameForExitCode: (code: number) => string;
};

export = exitCodeRegistry;
