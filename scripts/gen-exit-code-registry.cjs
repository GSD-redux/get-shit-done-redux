#!/usr/bin/env node
/**
 * gen-exit-code-registry.cjs — generates FIVE byte-identical/derived
 * artifacts from the declaration at gsd-core/bin/shared/exit-codes.json:
 *   - gsd-core/bin/lib/exit-code-registry.cjs   (tsc-adjacent build tree)
 *   - scripts/lib/exit-code-registry.cjs        (committed, for scripts/
 *     consumers that must work on an unbuilt clone — same reason
 *     scripts/lib/cli-exit.cjs exists alongside gsd-core/bin/lib/cli-exit.cjs;
 *     see scripts/gen-scripts-cli-exit.cjs).
 *   - hooks/lib/exit-code-registry.js            (committed, for hooks/
 *     consumers that must work on a raw, unbuilt clone — same reason as the
 *     scripts/ copy above; see scripts/gen-hooks-cli-exit.cjs, which emits
 *     hooks/lib/cli-exit.js's sibling `require('./exit-code-registry.js')`.
 *     `.js`, not `.cjs`, to match the hooks/lib/*.js convention — ADR-3889
 *     Phase 7, #3911).
 *   - src/exit-code-registry.d.cts               (the ambient type declaration
 *     tsc uses to typecheck src/cli-exit.cts's `require('./exit-code-registry.cjs')`
 *     against the shape the .cjs artifacts above actually export — generated
 *     from the SAME ENTRY_FIELD_TYPES table serializeRegistry() uses, so the
 *     two can never independently drift).
 *   - gsd-core/bin/shared/exit-codes.sh          (POSIX sh, safe under
 *     `set -u`: one `export EXIT_<NAME>=<code>` per entry, sourced by the
 *     bash scanners under scripts/ so a shell caller never re-invents a
 *     literal exit-code integer — ADR-3889 Phase 4, #3908).
 *
 * ADR-3889 ("One exit-code registry — 0 and 1 are free, everything else is
 * allocated") Phase 1 (#3905) built the single-output allocator; Phase 2
 * (#3906) added the second .cjs emission so scripts/ has its own committed
 * copy instead of reaching into gitignored build output; a follow-up closed
 * the review finding that the .d.cts was hand-maintained with no gate by
 * generating it here too; Phase 4 (#3908) added the shell fragment so the
 * three bash scanners can source symbolic names instead of hardcoding
 * integers; Phase 7 (#3911) added the hooks/lib/ copy so a shipped hook can
 * terminate through `terminateNow` without depending on any build artifact.
 *
 * The three .cjs/.js artifacts (primary, scripts, hooks) are byte-identical:
 * serializeRegistry() only encodes the DECLARATION path (for the banner
 * comment), never the output path, so one generated string is written to all
 * three locations unchanged. The .d.cts and .sh artifacts are separate,
 * smaller derivations but are generated and --check-gated exactly the same
 * way.
 *
 * Nothing in this script emits a registered exit code itself; wiring
 * consumers onto the registry is separate work.
 *
 * Usage:
 *   node scripts/gen-exit-code-registry.cjs                # same as --write
 *   node scripts/gen-exit-code-registry.cjs --write         # write all five artifacts
 *   node scripts/gen-exit-code-registry.cjs --check         # exit 1 if ANY committed artifact is stale
 *   node scripts/gen-exit-code-registry.cjs --declaration <path> --out <path> --scripts-out <path> --hooks-out <path> --dts-out <path> --sh-out <path>   # override for tests
 *   node scripts/gen-exit-code-registry.cjs --json          # emit ONE JSON report on stdout instead of human prose
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DECLARATION_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'exit-codes.json');
const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'exit-code-registry.cjs');
const DEFAULT_SCRIPTS_OUTPUT_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'exit-code-registry.cjs');
const DEFAULT_HOOKS_OUTPUT_PATH = path.join(REPO_ROOT, 'hooks', 'lib', 'exit-code-registry.js');
const DEFAULT_DTS_OUTPUT_PATH = path.join(REPO_ROOT, 'src', 'exit-code-registry.d.cts');
const DEFAULT_SH_OUTPUT_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'exit-codes.sh');

/**
 * Single source of the entry field list (name -> TS type), in emission order.
 * serializeRegistry()'s per-entry object literal and serializeDts()'s
 * ExitCodeEntry interface are BOTH derived from this one table, so the two
 * artifacts cannot independently drift out of shape with each other — closing
 * the review finding that the ambient .d.cts was a hand-maintained guess at
 * what serializeRegistry() emits.
 */
const ENTRY_FIELD_TYPES = Object.freeze({
  code: 'number',
  name: 'string',
  meaning: 'string',
  owner: 'string',
  authorizedBy: 'string',
});

/** Frozen reason codes so tests assert on structure, not prose. */
const REASON = Object.freeze({
  OK: 'ok_generated_sync',
  DRIFTED: 'fail_generated_drifted',
  USAGE: 'fail_usage',
  MISSING_DECLARATION: 'fail_missing_declaration',
  MALFORMED_DECLARATION: 'fail_malformed_declaration',
  NOT_AN_ARRAY: 'fail_not_an_array',
  EMPTY_DECLARATION: 'fail_empty_declaration',
  INVALID_ENTRY: 'fail_invalid_entry',
  DUPLICATE_CODE: 'fail_duplicate_code',
  DUPLICATE_NAME: 'fail_duplicate_name',
  RESERVED_CODE: 'fail_reserved_code',
  FORBIDDEN_OWNER: 'fail_forbidden_owner',
  MISSING_ARTIFACT: 'fail_missing_artifact',
  INVALID_CHARACTERS: 'fail_invalid_characters',
});

const USAGE_MESSAGE = [
  'Usage: node scripts/gen-exit-code-registry.cjs [--write|--check] [--declaration <path>] [--out <path>] [--scripts-out <path>] [--hooks-out <path>] [--dts-out <path>] [--sh-out <path>] [--json]',
  '  (no flag)        same as --write',
  '  --write          write all five generated registry artifacts',
  '  --check          exit 1 if ANY committed artifact is stale',
  '  --declaration    override the declaration path (default: gsd-core/bin/shared/exit-codes.json)',
  '  --out            override the primary output artifact path (default: gsd-core/bin/lib/exit-code-registry.cjs)',
  '  --scripts-out    override the secondary output artifact path (default: scripts/lib/exit-code-registry.cjs)',
  '  --hooks-out      override the hooks output artifact path (default: hooks/lib/exit-code-registry.js)',
  '  --dts-out        override the ambient type declaration path (default: src/exit-code-registry.d.cts)',
  '  --sh-out         override the shell-sourceable fragment path (default: gsd-core/bin/shared/exit-codes.sh)',
  '  --json           emit ONE JSON report ({ok, reason, context, detail?}) on stdout instead of human-readable prose',
].join('\n');

/** SCREAMING_SNAKE_CASE: starts with a letter, only uppercase letters/digits/underscores. */
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Fields every entry must carry as a non-empty, non-whitespace-only string. */
const REQUIRED_STRING_FIELDS = ['meaning', 'owner', 'authorizedBy'];

/**
 * Characters forbidden in any declaration string field: a literal pipe `|`
 * (the Markdown table cell delimiter `gen-exit-code-docs.cjs`'s
 * `renderRegisteredTable` interpolates these fields into — an unescaped `|`
 * breaks the row and everything after it lands verbatim in the rendered
 * page, including a forged Markdown heading), and any C0 control character
 * (`\x00`-`\x1F`, `\x7F`) — which subsumes CR (`\r`) and LF (`\n`), both of
 * which would otherwise let a single declaration entry inject an entire
 * extra row (or non-table content) into the generated table.
 *
 * Enforced HERE, at the validator both generators share (`gen-exit-code-registry.cjs`'s
 * `validateEntry`, called by `gen-exit-code-docs.cjs`'s `loadEntries`), not
 * at the docs renderer — failing closed at the declaration source is
 * correct: an escaping fix at render time would let a malformed declaration
 * through validation and only cosmetically repair the symptom (#3913 P9
 * SEC-3).
 *
 * Checked via char codes rather than a literal control-character regex
 * range — same approach as `scripts/registry-schema.cjs`'s
 * `hasDisallowedControlChar` — so this never trips ESLint's `no-control-regex`.
 *
 * @param {string} v
 * @returns {boolean}
 */
function hasForbiddenDeclarationChar(v) {
  for (let i = 0; i < v.length; i += 1) {
    const code = v.charCodeAt(i);
    if (code === 0x7c) return true; // '|'
    if (code < 0x20 || code === 0x7f) return true; // C0 control chars (incl. CR/LF/tab) + DEL
  }
  return false;
}

/**
 * Bands, per ADR-3889 §1:
 *   0, 1                 free (not allocatable here)
 *   2                     hook-adapter only
 *   3-13                  Node-reserved
 *   14-63, 79, 126+        outside every band
 *   64-78                 generic
 *   80-125                domain
 *
 * SINGLE SOURCE for every band boundary in this file: `isAllocatableCode`,
 * `bandFor`, and (via scripts/gen-exit-code-docs.cjs's `classifyBand`) the
 * generated "Reserved bands" table are ALL derived from this one ordered
 * list of `{category, allocatable, test}` predicates — there is no second
 * hand-typed range anywhere else. Widening or narrowing a band means editing
 * a `test` function here; every consumer (validation, the docs page) picks
 * that change up with nothing else to keep in sync.
 */
const BANDS = Object.freeze([
  { category: 'free', allocatable: false, test: (code) => code === 0 || code === 1 },
  { category: 'hook-only', allocatable: true, test: (code) => code === 2 },
  { category: 'node-reserved', allocatable: false, test: (code) => code >= 3 && code <= 13 },
  { category: 'generic', allocatable: true, test: (code) => code >= 64 && code <= 78 },
  { category: 'domain', allocatable: true, test: (code) => code >= 80 && code <= 125 },
  { category: 'shell-signal', allocatable: false, test: (code) => code >= 126 },
]);

/** The band a code falls into, or `null` for the residual "outside every band" gap (14-63, 79) that no BANDS entry above claims. */
function bandEntryFor(code) {
  return BANDS.find((band) => band.test(code)) || null;
}

function isAllocatableCode(code) {
  const band = bandEntryFor(code);
  return band !== null && band.allocatable;
}

/**
 * Label the non-allocatable band a rejected code falls into, per the same
 * BANDS table isAllocatableCode reads. Only called for codes that already
 * failed isAllocatableCode, so an allocatable band's category is never
 * returned here.
 * @returns {string}
 */
function bandFor(code) {
  const band = bandEntryFor(code);
  return band ? band.category : 'outside-every-band'; // 14-63, 79
}

/**
 * Validate a single declaration entry's shape and band membership.
 * @returns {{ok:true}|{ok:false,reason:string,message:string,context:object}}
 */
function validateEntry(entry, index) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return {
      ok: false,
      reason: REASON.INVALID_ENTRY,
      message: `entry[${index}] is not an object: ${JSON.stringify(entry)}`,
      context: { field: 'entry', index },
    };
  }

  const { code, name } = entry;
  if (!Number.isInteger(code) || code < 0) {
    return {
      ok: false,
      reason: REASON.INVALID_ENTRY,
      message: `entry[${index}].code must be a non-negative integer (no coercion), received ${JSON.stringify(code)}`,
      context: { field: 'code', index, code },
    };
  }

  if (typeof name !== 'string' || name.trim() === '' || !NAME_RE.test(name)) {
    return {
      ok: false,
      reason: REASON.INVALID_ENTRY,
      message: `entry[${index}].name must be a non-empty SCREAMING_SNAKE_CASE string, received ${JSON.stringify(name)}`,
      context: { field: 'name', index, code, name },
    };
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = entry[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return {
        ok: false,
        reason: REASON.INVALID_ENTRY,
        message: `entry[${index}] (${name}).${field} must be a non-empty string, received ${JSON.stringify(value)}`,
        context: { field, index, code, name },
      };
    }
    if (hasForbiddenDeclarationChar(value)) {
      return {
        ok: false,
        reason: REASON.INVALID_CHARACTERS,
        message: `entry[${index}] (${name}).${field} must not contain a "|", CR, LF, or other control character ` +
          `(these are interpolated into a Markdown table cell by gen-exit-code-docs.cjs), received ${JSON.stringify(value)}`,
        context: { field, index, code, name },
      };
    }
  }

  if (!isAllocatableCode(code)) {
    return {
      ok: false,
      reason: REASON.RESERVED_CODE,
      message: `entry[${index}] (${name}) declares code ${code}, which is outside every allocatable band ` +
        `(2 hook-adapter only; 64-78 generic; 80-125 domain) — see ADR-3889 §1`,
      context: { code, band: bandFor(code), index, name },
    };
  }

  if (code === 2 && entry.owner !== 'hook-adapter') {
    return {
      ok: false,
      reason: REASON.FORBIDDEN_OWNER,
      message: `entry[${index}] (${name}) declares code 2 with owner "${entry.owner}" — code 2 is reserved to ` +
        `the Claude Code hook protocol and may only be owned by "hook-adapter"`,
      context: { code, owner: entry.owner, requiredOwner: 'hook-adapter', index, name },
    };
  }

  return { ok: true };
}

/**
 * Validate the whole declaration: every entry individually, then the
 * cross-entry invariants (one number one meaning; one owner emits a given
 * code — but the SAME owner may legitimately own several distinct codes).
 * @returns {{ok:true}|{ok:false,reason:string,message:string,context:object}}
 */
function validateEntries(entries) {
  for (let i = 0; i < entries.length; i++) {
    const result = validateEntry(entries[i], i);
    if (!result.ok) return result;
  }

  const byCode = new Map();
  const byName = new Map();
  for (const entry of entries) {
    if (byCode.has(entry.code)) {
      const other = byCode.get(entry.code);
      return {
        ok: false,
        reason: REASON.DUPLICATE_CODE,
        message: `code ${entry.code} is declared twice: "${other.name}" and "${entry.name}"`,
        context: { code: entry.code, names: [other.name, entry.name] },
      };
    }
    byCode.set(entry.code, entry);

    if (byName.has(entry.name)) {
      const other = byName.get(entry.name);
      return {
        ok: false,
        reason: REASON.DUPLICATE_NAME,
        message: `name "${entry.name}" is declared twice: code ${other.code} and code ${entry.code}`,
        context: { name: entry.name, codes: [other.code, entry.code] },
      };
    }
    byName.set(entry.name, entry);
  }

  return { ok: true };
}

/**
 * Load and parse the declaration file.
 * @returns {{ok:true,entries:Array}|{ok:false,reason:string,message:string}}
 */
function loadDeclaration(declarationPath) {
  if (!fs.existsSync(declarationPath)) {
    return {
      ok: false,
      reason: REASON.MISSING_DECLARATION,
      message: `declaration not found at ${declarationPath}`,
      context: { path: declarationPath },
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(declarationPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: REASON.MISSING_DECLARATION,
      message: `could not read ${declarationPath}: ${err.message}`,
      context: { path: declarationPath },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: REASON.MALFORMED_DECLARATION,
      message: `${declarationPath} is not valid JSON: ${err.message}`,
      context: { path: declarationPath },
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      reason: REASON.NOT_AN_ARRAY,
      message: `${declarationPath} must be a JSON array, received ${parsed === null ? 'null' : typeof parsed}`,
      context: { path: declarationPath },
    };
  }

  if (parsed.length === 0) {
    return {
      ok: false,
      reason: REASON.EMPTY_DECLARATION,
      message: `${declarationPath} is an empty array — declare at least one exit code`,
      context: { path: declarationPath },
    };
  }

  return { ok: true, entries: parsed };
}

/**
 * Hand-serialize the generated registry module (string concatenation, like
 * gsd-core/bin/lib/capability-registry.cjs — no build step, no template
 * engine, so the emitted bytes are exactly what `--check` re-derives).
 */
function serializeRegistry(entries, declarationPath) {
  const relDeclaration = path.relative(REPO_ROOT, declarationPath).split(path.sep).join('/');
  const banner = [
    '\'use strict\';',
    '',
    '// GENERATED FILE — DO NOT EDIT BY HAND.',
    `// Source of truth: ${relDeclaration}. Regenerate with:`,
    '//   node scripts/gen-exit-code-registry.cjs --write',
    '// This exact content is emitted to THREE locations — gsd-core/bin/lib/exit-code-registry.cjs,',
    '// scripts/lib/exit-code-registry.cjs, and hooks/lib/exit-code-registry.js (the latter two',
    '// committed so scripts/ and hooks/ consumers work on an unbuilt clone) — all byte-compared by',
    '// `npm run lint:generated-sync` (#3905 ADR-3889 Phase 1; #3906 Phase 2 added the second copy;',
    '// #3911 ADR-3889 Phase 7 added the hooks/lib/ copy).',
    '//',
    '// exitCodeFor(name) / nameForExitCode(code) are pure and total over this',
    '// closed table — each throws for anything not registered here.',
    '',
  ].join('\n');

  const entryFieldNames = Object.keys(ENTRY_FIELD_TYPES);
  const entryLiterals = entries.map((e) => {
    const fieldLines = entryFieldNames.map((field) => `    ${field}: ${JSON.stringify(e[field])},`).join('\n');
    return `  Object.freeze({\n${fieldLines}\n  })`;
  }).join(',\n');

  const body = [
    'const EXIT_CODES = Object.freeze([',
    entryLiterals,
    ']);',
    '',
    'const NAME_TO_CODE = new Map(EXIT_CODES.map((entry) => [entry.name, entry.code]));',
    'const CODE_TO_NAME = new Map(EXIT_CODES.map((entry) => [entry.code, entry.name]));',
    '',
    '/**',
    ' * Resolve the registered exit code for a symbolic name. Pure, total: throws',
    ' * for anything not an exact, registered, exact-case key — including',
    ' * non-strings, the empty string, untrimmed strings, wrong case, and',
    ' * prototype-chain names like `__proto__`/`constructor`/`toString` (a Map',
    ' * lookup never touches the prototype chain, so these are indistinguishable',
    ' * from any other unregistered name).',
    ' *',
    ' * @param {string} name',
    ' * @returns {number}',
    ' */',
    'function exitCodeFor(name) {',
    '  if (typeof name !== \'string\' || name.length === 0) {',
    '    throw new Error(`exitCodeFor: name must be a non-empty string, received ${JSON.stringify(name)}`);',
    '  }',
    '  if (!NAME_TO_CODE.has(name)) {',
    '    throw new Error(`exitCodeFor: unregistered exit code name: ${JSON.stringify(name)}`);',
    '  }',
    '  return NAME_TO_CODE.get(name);',
    '}',
    '',
    '/**',
    ' * Reverse of exitCodeFor: resolve the symbolic name for a registered exit',
    ' * code. Pure, total: throws for anything not an exact, registered code.',
    ' *',
    ' * @param {number} code',
    ' * @returns {string}',
    ' */',
    'function nameForExitCode(code) {',
    '  if (!CODE_TO_NAME.has(code)) {',
    '    throw new Error(`nameForExitCode: unregistered exit code: ${JSON.stringify(code)}`);',
    '  }',
    '  return CODE_TO_NAME.get(code);',
    '}',
    '',
    'module.exports = { EXIT_CODES, exitCodeFor, nameForExitCode };',
    '',
  ].join('\n');

  return banner + '\n' + body;
}

/**
 * Generate the ambient type declaration for the generated .cjs registry
 * artifacts. Derived from the SAME ENTRY_FIELD_TYPES table serializeRegistry()
 * iterates for its per-entry object literals, and from serializeRegistry()'s
 * own fixed `module.exports = { EXIT_CODES, exitCodeFor, nameForExitCode }`
 * shape — so this declaration cannot drift out of step with what the sibling
 * .cjs artifacts actually export without both call sites being edited
 * together. Structural only (no per-entry data): the type is the same
 * regardless of how many rows the declaration has.
 */
function serializeDts(declarationPath) {
  const relDeclaration = path.relative(REPO_ROOT, declarationPath).split(path.sep).join('/');
  const fieldLines = Object.entries(ENTRY_FIELD_TYPES)
    .map(([field, type]) => `  readonly ${field}: ${type};`)
    .join('\n');

  return [
    '// GENERATED FILE — DO NOT EDIT BY HAND.',
    `// Source of truth: ${relDeclaration} + the ENTRY_FIELD_TYPES table in`,
    '// scripts/gen-exit-code-registry.cjs. Regenerate with:',
    '//   node scripts/gen-exit-code-registry.cjs --write',
    '//',
    '// Ambient type declaration for exit-code-registry.cjs — a GENERATED,',
    '// committed artifact with no `.cts` source of its own (it is hand-serialized',
    '// from gsd-core/bin/shared/exit-codes.json by scripts/gen-exit-code-registry.cjs,',
    '// ADR-3889 §2, #3905/#3906), so tsc has nothing to compile for it. This file',
    "// exists purely so `src/cli-exit.cts`'s `require('./exit-code-registry.cjs')`",
    '// type-checks against the SAME shape the generated artifact actually exports',
    '// at runtime — mirroring the src/vendor/*.d.cts pattern already used for',
    '// other verbatim/generated JS this tree resolves types for without compiling.',
    '//',
    '// This declaration is generated from the same ENTRY_FIELD_TYPES table',
    "// serializeRegistry()'s per-entry object literals iterate, and is",
    '// byte-compared by `node scripts/gen-exit-code-registry.cjs --check`',
    '// (the same check that already covers the two sibling .cjs artifacts) so a',
    '// shape drift here fails the build instead of surfacing at a destructuring',
    '// call site.',
    '',
    'export interface ExitCodeEntry {',
    fieldLines,
    '}',
    '',
    'declare const exitCodeRegistry: {',
    '  readonly EXIT_CODES: readonly ExitCodeEntry[];',
    '  // Property-typed function signatures (`name: (args) => ret`), NOT method',
    '  // shorthand (`name(args): ret`) — the latter is a TS "method" and trips',
    '  // @typescript-eslint/unbound-method at every destructuring call site',
    '  // (`const { exitCodeFor } = ...`), since a method may implicitly use',
    '  // `this`. These are pure functions that never do, so they are typed as',
    '  // plain function-valued properties instead.',
    '  exitCodeFor: (name: string) => number;',
    '  nameForExitCode: (code: number) => string;',
    '};',
    '',
    'export = exitCodeRegistry;',
    '',
  ].join('\n');
}

/**
 * Generate the shell-sourceable fragment: one `export EXIT_<NAME>=<code>`
 * line per declared entry, POSIX sh, safe under `set -u` (a sourced file that
 * only ever ASSIGNS variables can never trip an unset-variable check,
 * regardless of what the caller's shell had in scope beforehand).
 *
 * Consumed by the bash scanners under scripts/ via `. gsd-core/bin/shared/
 * exit-codes.sh` (ADR-3889 Phase 4, #3908) so a shell caller resolves a
 * symbolic name instead of hardcoding a literal integer that can silently
 * drift from the registry.
 */
function serializeSh(entries, declarationPath) {
  const relDeclaration = path.relative(REPO_ROOT, declarationPath).split(path.sep).join('/');
  const banner = [
    '#!/bin/sh',
    '# GENERATED FILE — DO NOT EDIT BY HAND.',
    `# Source of truth: ${relDeclaration}. Regenerate with:`,
    '#   node scripts/gen-exit-code-registry.cjs --write',
    '#',
    '# One `export EXIT_<NAME>=<code>` per gsd-core/bin/shared/exit-codes.json',
    '# entry (ADR-3889 §2, #3905/#3906/#3908). POSIX sh, safe under `set -u`:',
    '# sourcing this file only ever ASSIGNS variables, never reads one, so it',
    '# cannot trip an unset-variable check regardless of the caller\'s existing',
    '# environment.',
    '#',
    '# Usage (from a scanner under scripts/):',
    '#   . "$(dirname "$0")/../gsd-core/bin/shared/exit-codes.sh"',
    '#   exit "$EXIT_UNAVAILABLE"',
    '',
  ].join('\n');

  const lines = entries.map((e) => `export EXIT_${e.name}=${e.code}`);

  return banner + lines.join('\n') + '\n';
}

/**
 * Load, validate, and serialize the declaration in one step.
 * @returns {{ok:true,content:string}|{ok:false,reason:string,message:string}}
 */
function buildRegistryContent(declarationPath) {
  const loaded = loadDeclaration(declarationPath);
  if (!loaded.ok) return loaded;

  const validated = validateEntries(loaded.entries);
  if (!validated.ok) return validated;

  return { ok: true, content: serializeRegistry(loaded.entries, declarationPath), entries: loaded.entries };
}

function printFail(result) {
  console.error(`FAIL gen-exit-code-registry: ${result.reason}`);
  console.error(`  ${result.message}`);
}

/**
 * Emit a failure outcome: structured JSON on stdout (and NO stderr prose)
 * when `json` is set, otherwise the legacy human-readable stderr report.
 * `context` carries the specifics (offending code/name/field/path) that the
 * `detail` prose currently embeds, so a `--json` consumer never needs to
 * parse prose to recover them — it defaults to `null` for reasons (USAGE,
 * DRIFTED, MISSING_ARTIFACT) that carry no structured specifics.
 * @param {{reason:string, message?:string, context?:object}} result
 * @param {boolean} json
 */
function emitFail(result, json) {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, reason: result.reason, context: result.context ?? null, detail: result.message }) + '\n');
    return;
  }
  printFail(result);
}

/**
 * Emit a success outcome: structured JSON on stdout when `json` is set,
 * otherwise the legacy human-readable stdout line.
 * @param {string} reason
 * @param {string} humanMessage
 * @param {boolean} json
 */
function emitOk(reason, humanMessage, json) {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, reason }) + '\n');
    return;
  }
  console.log(humanMessage);
}

function doWrite(declarationPath, outPath, scriptsOutPath, hooksOutPath, dtsPath, shPath, json) {
  const result = buildRegistryContent(declarationPath);
  if (!result.ok) {
    emitFail(result, json);
    return 1;
  }
  // The three .cjs/.js artifacts are byte-identical copies of the same
  // generated content (serializeRegistry never encodes the output path), so
  // the same string is written to all three locations unchanged.
  for (const target of [outPath, scriptsOutPath, hooksOutPath]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result.content, 'utf8');
  }
  const dtsContent = serializeDts(declarationPath);
  fs.mkdirSync(path.dirname(dtsPath), { recursive: true });
  fs.writeFileSync(dtsPath, dtsContent, 'utf8');
  const shContent = serializeSh(result.entries, declarationPath);
  fs.mkdirSync(path.dirname(shPath), { recursive: true });
  fs.writeFileSync(shPath, shContent, 'utf8');
  emitOk(
    REASON.OK,
    `ok gen-exit-code-registry: wrote ${outPath}\nok gen-exit-code-registry: wrote ${scriptsOutPath}\n`
    + `ok gen-exit-code-registry: wrote ${hooksOutPath}\n`
    + `ok gen-exit-code-registry: wrote ${dtsPath}\nok gen-exit-code-registry: wrote ${shPath}`,
    json,
  );
  return 0;
}

/**
 * Verify one committed artifact against the freshly generated content.
 * @returns {{ok:true}|{ok:false,reason:string,message:string,context:object}}
 */
function checkOneArtifact(artifactLabel, artifactPath, content) {
  if (!fs.existsSync(artifactPath)) {
    return {
      ok: false,
      reason: REASON.MISSING_ARTIFACT,
      message: `${artifactPath} (${artifactLabel}) does not exist. Run:\n  node scripts/gen-exit-code-registry.cjs --write`,
      context: { artifact: artifactLabel, path: artifactPath },
    };
  }

  const committed = fs.readFileSync(artifactPath, 'utf8');
  if (committed !== content) {
    return {
      ok: false,
      reason: REASON.DRIFTED,
      message:
        `${artifactPath} (${artifactLabel}, ${committed.length} bytes) != freshly generated content (${content.length} bytes)\n\n`
        + 'Regenerate with:\n  node scripts/gen-exit-code-registry.cjs --write',
      context: { artifact: artifactLabel, path: artifactPath },
    };
  }

  return { ok: true };
}

/**
 * --check verifies ALL FIVE committed artifacts against the same freshly
 * generated content and fails naming which one drifted (or is missing) if
 * any does. Checked in a fixed order (primary, secondary, hooks, dts, sh) so
 * a single-artifact failure is always reported deterministically.
 */
function doCheck(declarationPath, outPath, scriptsOutPath, hooksOutPath, dtsPath, shPath, json) {
  const result = buildRegistryContent(declarationPath);
  if (!result.ok) {
    emitFail(result, json);
    return 1;
  }
  const dtsContent = serializeDts(declarationPath);
  const shContent = serializeSh(result.entries, declarationPath);

  const artifacts = [
    ['primary', outPath, result.content],
    ['secondary', scriptsOutPath, result.content],
    ['hooks', hooksOutPath, result.content],
    ['dts', dtsPath, dtsContent],
    ['sh', shPath, shContent],
  ];
  for (const [artifactLabel, artifactPath, content] of artifacts) {
    const checked = checkOneArtifact(artifactLabel, artifactPath, content);
    if (!checked.ok) {
      emitFail(checked, json);
      return 1;
    }
  }

  emitOk(
    REASON.OK,
    `ok gen-exit-code-registry: ${outPath} matches ${declarationPath}\n`
    + `ok gen-exit-code-registry: ${scriptsOutPath} matches ${declarationPath}\n`
    + `ok gen-exit-code-registry: ${hooksOutPath} matches ${declarationPath}\n`
    + `ok gen-exit-code-registry: ${dtsPath} matches ${declarationPath}\n`
    + `ok gen-exit-code-registry: ${shPath} matches ${declarationPath}`,
    json,
  );
  return 0;
}

/**
 * @returns {{mode:'write'|'check', declarationPath:?string, outPath:?string, scriptsOutPath:?string, hooksOutPath:?string, dtsPath:?string, shPath:?string, json:boolean}}
 */
function parseArgs(argv) {
  let mode = null;
  let declarationPath = null;
  let outPath = null;
  let scriptsOutPath = null;
  let hooksOutPath = null;
  let dtsPath = null;
  let shPath = null;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write' || arg === '--check') {
      if (mode !== null) {
        throw new Error(`conflicting mode flags: --${mode} and ${arg}`);
      }
      mode = arg === '--write' ? 'write' : 'check';
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--declaration') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--declaration requires a value');
      declarationPath = value;
    } else if (arg.startsWith('--declaration=')) {
      declarationPath = arg.slice('--declaration='.length);
    } else if (arg === '--out') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--out requires a value');
      outPath = value;
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
    } else if (arg === '--scripts-out') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--scripts-out requires a value');
      scriptsOutPath = value;
    } else if (arg.startsWith('--scripts-out=')) {
      scriptsOutPath = arg.slice('--scripts-out='.length);
    } else if (arg === '--hooks-out') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--hooks-out requires a value');
      hooksOutPath = value;
    } else if (arg.startsWith('--hooks-out=')) {
      hooksOutPath = arg.slice('--hooks-out='.length);
    } else if (arg === '--dts-out') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--dts-out requires a value');
      dtsPath = value;
    } else if (arg.startsWith('--dts-out=')) {
      dtsPath = arg.slice('--dts-out='.length);
    } else if (arg === '--sh-out') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--sh-out requires a value');
      shPath = value;
    } else if (arg.startsWith('--sh-out=')) {
      shPath = arg.slice('--sh-out='.length);
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }

  return { mode: mode || 'write', declarationPath, outPath, scriptsOutPath, hooksOutPath, dtsPath, shPath, json };
}

function main() {
  // --json must be honored even on a parse failure (e.g. an unrecognized
  // flag alongside --json), so it is detected from the raw argv rather
  // than from parseArgs's return value, which may never be produced.
  const rawArgv = process.argv.slice(2);
  const jsonRequested = rawArgv.includes('--json');

  let args;
  try {
    args = parseArgs(rawArgv);
  } catch (err) {
    emitFail({ reason: REASON.USAGE, message: jsonRequested ? err.message : `${err.message}\n${USAGE_MESSAGE}` }, jsonRequested);
    return 1;
  }

  const declarationPath = args.declarationPath || DEFAULT_DECLARATION_PATH;
  const outPath = args.outPath || DEFAULT_OUTPUT_PATH;
  const scriptsOutPath = args.scriptsOutPath || DEFAULT_SCRIPTS_OUTPUT_PATH;
  const hooksOutPath = args.hooksOutPath || DEFAULT_HOOKS_OUTPUT_PATH;
  const dtsPath = args.dtsPath || DEFAULT_DTS_OUTPUT_PATH;
  const shPath = args.shPath || DEFAULT_SH_OUTPUT_PATH;

  return args.mode === 'check'
    ? doCheck(declarationPath, outPath, scriptsOutPath, hooksOutPath, dtsPath, shPath, args.json)
    : doWrite(declarationPath, outPath, scriptsOutPath, hooksOutPath, dtsPath, shPath, args.json);
}

if (require.main === module) process.exitCode = main();

/**
 * Classify a single code into one of the band categories the docs page
 * renders a row for. Reads the SAME `bandEntryFor`/BANDS table that
 * `isAllocatableCode`/`bandFor` are themselves derived from — there is no
 * second, independently-typed band boundary anywhere in this classification,
 * so widening or narrowing a band (editing a `test` in BANDS) changes what
 * this returns too, with nothing else to keep in sync.
 * @param {number} code
 * @returns {'free'|'hook-only'|'node-reserved'|'outside-every-band'|'generic'|'domain'|'shell-signal'}
 */
function classifyBand(code) {
  const band = bandEntryFor(code);
  return band ? band.category : 'outside-every-band'; // 14-63, 79
}

/**
 * Scan the code space [0, maxCode] and group it into maximal contiguous
 * runs of the same classifyBand() category, in the order those categories
 * first appear. The run touching `maxCode` is marked `openEnded: true` for
 * any category whose classification never changes past that point
 * (currently only 'shell-signal', since bandFor(code >= 126) is constant),
 * so the docs renderer can print it as `126+` instead of a false upper
 * bound. This is what makes the docs page's band table a DERIVED artifact:
 * widening a band in isAllocatableCode/bandFor changes what this function
 * returns, which changes the rendered table, with no second literal to
 * keep in sync.
 * @param {number} maxCode
 * @returns {Array<{category:string, ranges:Array<{start:number,end:number,openEnded:boolean}>}>}
 */
function computeBandRanges(maxCode) {
  /** @type {Map<string, Array<{start:number,end:number,openEnded:boolean}>>} */
  const byCategory = new Map();
  const order = [];

  let runCategory = null;
  let runStart = null;
  for (let code = 0; code <= maxCode; code += 1) {
    const category = classifyBand(code);
    if (category !== runCategory) {
      if (runCategory !== null) {
        pushRun(byCategory, order, runCategory, runStart, code - 1, false);
      }
      runCategory = category;
      runStart = code;
    }
  }
  // Close the final run. It is open-ended (unbounded above) exactly when its
  // category classification is constant for every code beyond maxCode too —
  // true today only for 'shell-signal', since bandFor treats every code
  // >= 126 identically with no further upper boundary.
  const openEnded = classifyBand(maxCode) === classifyBand(maxCode + 1);
  pushRun(byCategory, order, runCategory, runStart, maxCode, openEnded);

  return order.map((category) => ({ category, ranges: byCategory.get(category) }));
}

function pushRun(byCategory, order, category, start, end, openEnded) {
  if (!byCategory.has(category)) {
    byCategory.set(category, []);
    order.push(category);
  }
  byCategory.get(category).push({ start, end, openEnded });
}

module.exports = {
  REASON,
  USAGE_MESSAGE,
  DEFAULT_DECLARATION_PATH,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_SCRIPTS_OUTPUT_PATH,
  DEFAULT_HOOKS_OUTPUT_PATH,
  DEFAULT_DTS_OUTPUT_PATH,
  DEFAULT_SH_OUTPUT_PATH,
  ENTRY_FIELD_TYPES,
  BANDS,
  bandEntryFor,
  isAllocatableCode,
  bandFor,
  classifyBand,
  computeBandRanges,
  hasForbiddenDeclarationChar,
  validateEntry,
  validateEntries,
  loadDeclaration,
  serializeRegistry,
  serializeDts,
  serializeSh,
  buildRegistryContent,
  parseArgs,
  main,
};
