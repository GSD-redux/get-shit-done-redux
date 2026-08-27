#!/usr/bin/env node
/**
 * gen-exit-code-registry.cjs — generates gsd-core/bin/lib/exit-code-registry.cjs
 * from the declaration at gsd-core/bin/shared/exit-codes.json.
 *
 * ADR-3889 ("One exit-code registry — 0 and 1 are free, everything else is
 * allocated") Phase 1 (#3905): this script builds the ALLOCATOR. It owns
 * validating the declaration (band rules, one-number-one-meaning, one-owner)
 * and hand-serializing the generated lookup module — the same
 * declaration -> generator -> `--check` gate pattern this repo already uses
 * for capability-registry.cjs, the model catalog, and the ADR index.
 *
 * Nothing in this script emits a registered exit code itself; wiring
 * consumers onto the registry is a later phase (#3906).
 *
 * Usage:
 *   node scripts/gen-exit-code-registry.cjs                # same as --write
 *   node scripts/gen-exit-code-registry.cjs --write         # write the artifact
 *   node scripts/gen-exit-code-registry.cjs --check         # exit 1 if the committed artifact is stale
 *   node scripts/gen-exit-code-registry.cjs --declaration <path> --out <path>   # override for tests
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DECLARATION_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'exit-codes.json');
const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'exit-code-registry.cjs');

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
});

const USAGE_MESSAGE = [
  'Usage: node scripts/gen-exit-code-registry.cjs [--write|--check] [--declaration <path>] [--out <path>]',
  '  (no flag)        same as --write',
  '  --write          write the generated registry artifact',
  '  --check          exit 1 if the committed artifact is stale',
  '  --declaration    override the declaration path (default: gsd-core/bin/shared/exit-codes.json)',
  '  --out            override the output artifact path (default: gsd-core/bin/lib/exit-code-registry.cjs)',
].join('\n');

/** SCREAMING_SNAKE_CASE: starts with a letter, only uppercase letters/digits/underscores. */
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Fields every entry must carry as a non-empty, non-whitespace-only string. */
const REQUIRED_STRING_FIELDS = ['meaning', 'owner', 'authorizedBy'];

/**
 * Bands, per ADR-3889 §1:
 *   0, 1                 free (not allocatable here)
 *   2                     hook-adapter only
 *   3-13                  Node-reserved
 *   14-63, 79, 126+        outside every band
 *   64-78                 generic
 *   80-125                domain
 */
function isAllocatableCode(code) {
  if (code === 2) return true;
  if (code >= 64 && code <= 78) return true;
  if (code >= 80 && code <= 125) return true;
  return false;
}

/**
 * Validate a single declaration entry's shape and band membership.
 * @returns {{ok:true}|{ok:false,reason:string,message:string}}
 */
function validateEntry(entry, index) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { ok: false, reason: REASON.INVALID_ENTRY, message: `entry[${index}] is not an object: ${JSON.stringify(entry)}` };
  }

  const { code, name } = entry;
  if (!Number.isInteger(code) || code < 0) {
    return {
      ok: false,
      reason: REASON.INVALID_ENTRY,
      message: `entry[${index}].code must be a non-negative integer (no coercion), received ${JSON.stringify(code)}`,
    };
  }

  if (typeof name !== 'string' || name.trim() === '' || !NAME_RE.test(name)) {
    return {
      ok: false,
      reason: REASON.INVALID_ENTRY,
      message: `entry[${index}].name must be a non-empty SCREAMING_SNAKE_CASE string, received ${JSON.stringify(name)}`,
    };
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = entry[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return {
        ok: false,
        reason: REASON.INVALID_ENTRY,
        message: `entry[${index}] (${name}).${field} must be a non-empty string, received ${JSON.stringify(value)}`,
      };
    }
  }

  if (!isAllocatableCode(code)) {
    return {
      ok: false,
      reason: REASON.RESERVED_CODE,
      message: `entry[${index}] (${name}) declares code ${code}, which is outside every allocatable band ` +
        `(2 hook-adapter only; 64-78 generic; 80-125 domain) — see ADR-3889 §1`,
    };
  }

  if (code === 2 && entry.owner !== 'hook-adapter') {
    return {
      ok: false,
      reason: REASON.FORBIDDEN_OWNER,
      message: `entry[${index}] (${name}) declares code 2 with owner "${entry.owner}" — code 2 is reserved to ` +
        `the Claude Code hook protocol and may only be owned by "hook-adapter"`,
    };
  }

  return { ok: true };
}

/**
 * Validate the whole declaration: every entry individually, then the
 * cross-entry invariants (one number one meaning; one owner emits a given
 * code — but the SAME owner may legitimately own several distinct codes).
 * @returns {{ok:true}|{ok:false,reason:string,message:string}}
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
      };
    }
    byCode.set(entry.code, entry);

    if (byName.has(entry.name)) {
      const other = byName.get(entry.name);
      return {
        ok: false,
        reason: REASON.DUPLICATE_NAME,
        message: `name "${entry.name}" is declared twice: code ${other.code} and code ${entry.code}`,
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
    return { ok: false, reason: REASON.MISSING_DECLARATION, message: `declaration not found at ${declarationPath}` };
  }

  let raw;
  try {
    raw = fs.readFileSync(declarationPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: REASON.MISSING_DECLARATION, message: `could not read ${declarationPath}: ${err.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: REASON.MALFORMED_DECLARATION, message: `${declarationPath} is not valid JSON: ${err.message}` };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      reason: REASON.NOT_AN_ARRAY,
      message: `${declarationPath} must be a JSON array, received ${parsed === null ? 'null' : typeof parsed}`,
    };
  }

  if (parsed.length === 0) {
    return { ok: false, reason: REASON.EMPTY_DECLARATION, message: `${declarationPath} is an empty array — declare at least one exit code` };
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
    '// Byte-compared by `npm run lint:generated-sync` (#3905, ADR-3889 Phase 1).',
    '//',
    '// exitCodeFor(name) / nameForExitCode(code) are pure and total over this',
    '// closed table — each throws for anything not registered here.',
    '',
  ].join('\n');

  const entryLiterals = entries.map((e) => {
    return '  Object.freeze({\n'
      + `    code: ${JSON.stringify(e.code)},\n`
      + `    name: ${JSON.stringify(e.name)},\n`
      + `    meaning: ${JSON.stringify(e.meaning)},\n`
      + `    owner: ${JSON.stringify(e.owner)},\n`
      + `    authorizedBy: ${JSON.stringify(e.authorizedBy)},\n`
      + '  })';
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
 * Load, validate, and serialize the declaration in one step.
 * @returns {{ok:true,content:string}|{ok:false,reason:string,message:string}}
 */
function buildRegistryContent(declarationPath) {
  const loaded = loadDeclaration(declarationPath);
  if (!loaded.ok) return loaded;

  const validated = validateEntries(loaded.entries);
  if (!validated.ok) return validated;

  return { ok: true, content: serializeRegistry(loaded.entries, declarationPath) };
}

function printFail(result) {
  console.error(`FAIL gen-exit-code-registry: ${result.reason}`);
  console.error(`  ${result.message}`);
}

function doWrite(declarationPath, outPath) {
  const result = buildRegistryContent(declarationPath);
  if (!result.ok) {
    printFail(result);
    return 1;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result.content, 'utf8');
  console.log(`ok gen-exit-code-registry: wrote ${outPath}`);
  return 0;
}

function doCheck(declarationPath, outPath) {
  const result = buildRegistryContent(declarationPath);
  if (!result.ok) {
    printFail(result);
    return 1;
  }

  if (!fs.existsSync(outPath)) {
    console.error(`FAIL gen-exit-code-registry: ${REASON.MISSING_ARTIFACT}`);
    console.error(`  ${outPath} does not exist. Run:`);
    console.error('  node scripts/gen-exit-code-registry.cjs --write');
    return 1;
  }

  const committed = fs.readFileSync(outPath, 'utf8');
  if (committed !== result.content) {
    console.error(`FAIL gen-exit-code-registry: ${REASON.DRIFTED}`);
    console.error(
      `  ${outPath} (${committed.length} bytes) != freshly generated content (${result.content.length} bytes)`,
    );
    console.error('');
    console.error('Regenerate with:');
    console.error('  node scripts/gen-exit-code-registry.cjs --write');
    return 1;
  }

  console.log(`ok gen-exit-code-registry: ${outPath} matches ${declarationPath}`);
  return 0;
}

/**
 * @returns {{mode:'write'|'check', declarationPath:?string, outPath:?string}}
 */
function parseArgs(argv) {
  let mode = null;
  let declarationPath = null;
  let outPath = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write' || arg === '--check') {
      if (mode !== null) {
        throw new Error(`conflicting mode flags: --${mode} and ${arg}`);
      }
      mode = arg === '--write' ? 'write' : 'check';
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
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }

  return { mode: mode || 'write', declarationPath, outPath };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`FAIL gen-exit-code-registry: ${REASON.USAGE}`);
    console.error(`  ${err.message}`);
    console.error(USAGE_MESSAGE);
    return 1;
  }

  const declarationPath = args.declarationPath || DEFAULT_DECLARATION_PATH;
  const outPath = args.outPath || DEFAULT_OUTPUT_PATH;

  return args.mode === 'check' ? doCheck(declarationPath, outPath) : doWrite(declarationPath, outPath);
}

if (require.main === module) process.exitCode = main();

module.exports = {
  REASON,
  USAGE_MESSAGE,
  DEFAULT_DECLARATION_PATH,
  DEFAULT_OUTPUT_PATH,
  isAllocatableCode,
  validateEntry,
  validateEntries,
  loadDeclaration,
  serializeRegistry,
  buildRegistryContent,
  parseArgs,
  main,
};
