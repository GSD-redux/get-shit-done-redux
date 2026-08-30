'use strict';

/**
 * portability-vocab.cjs — single source of truth for path-related portability.
 *
 * PATH_RETURNING_FNS: canonical list of function calls (Node builtins and
 * project resolvers) that return a filesystem path. The drift-guard test
 * (tests/portability-vocab-drift.test.cjs) enforces completeness against
 * src/runtime-homes.cts's exported path-returning functions.
 *
 * EXTEND THIS LIST when adding a new path resolver to the codebase.
 * The drift-guard test will fail if you forget.
 *
 * ── Known boundaries ─────────────────────────────────────────────────────────
 *
 * Matching is by spelling: `path`, `os`, and the project resolver names below
 * are assumed to refer to the standard Node modules / project resolver exports.
 * A local variable that shadows one of these names (e.g. `const path = …`) is
 * out of scope — the helpers treat it as the real module.
 *
 * isPosixNormalizerCall inspects only the DIRECT argument of the call node;
 * deeper nesting (e.g. `String(path.join(...)).toLowerCase().replace(/\\/g,'/')`)
 * is not covered — only the outermost call and one level of String() cast are
 * visible to the rule.
 *
 * countWindowsExecutableExtensions matches by spelling (case-insensitive)
 * against the fixed WINDOWS_EXECUTABLE_EXTENSIONS set below — it does not
 * parse the string as a PATHEXT-style delimited list, so it also matches a
 * bare substring occurrence (e.g. `.exe` inside `.exeFoo`). That is
 * deliberate: the rule this feeds (local/no-private-binary-resolution) only
 * needs "does this string carry two-or-more of these extensions", the same
 * shape both deleted private resolvers had, not a strict grammar.
 */

/**
 * Canonical set of function names (dotted or bare) that return filesystem paths.
 *
 * Format:
 *  - "path.join"     → MemberExpression: object=Identifier{path}, property=Identifier{join}
 *  - "os.homedir"    → MemberExpression: object=Identifier{os},   property=Identifier{homedir}
 *  - "getGlobalDir"  → Identifier callee with that name
 */
const PATH_RETURNING_FNS = [
  // ── Node built-ins ──────────────────────────────────────────────────────────
  'path.join',
  'path.resolve',
  'path.dirname',
  'path.basename',
  'path.normalize',
  'path.relative',
  'os.homedir',
  'os.tmpdir',

  // ── Project resolvers (src/runtime-homes.cts exports + install.js helpers) ──
  // Add bare function names here; dotted forms (e.g. obj.resolveX) are not used
  // in the test corpus because these are module-level exports, not methods.
  'resolveAgentDir',
  'getGlobalConfigDir',
  'getGlobalSkillsBase',
  // #2088 (ADR-1239 upgrade 3): resolves the on-disk skills-install dir honoring
  // a skills-kind `home` override (e.g. Codex → $HOME/.agents/skills).
  '_resolveSkillsRootDir',
  // #3664: shared kind-destination resolver (skills/agents/kimi-agents kinds).
  '_kindDestDir',
  'getGlobalSkillDir',
  'getGlobalSkillDisplayPath',
  'resolveSkillsBaseFromDescriptor',
  'resolveConfigHomeFromDescriptor',
  'resolveKimiGlobalDir',
  // #2095 (EoS/kimi): resolves the directory holding Kimi CLI's OWN native
  // config.toml (~/.kimi by default, KIMI_SHARE_DIR override) — a sibling of,
  // and deliberately separate from, resolveKimiGlobalDir's generic
  // Agent-Skills root above.
  'resolveKimiHooksTomlDir',
  'resolveAntigravityGlobalDir',
  'getGlobalDir',
  'getConfigDirFromHome',
  'resolveKiloConfigPath',
  'resolveOpencodeConfigPath',
  'computePathPrefix',
  'expandHome',
  'getPathX',
  'normalizeInstallRelativePath',
  'toPosixPath',
];

/**
 * Windows executable extensions (lowercase canonical). This is the fixed
 * candidate-extension set both deleted private resolvers (`fallow-runner`'s
 * `['fallow.exe','fallow.cmd','fallow.bat','fallow']` and `gsd-tools`'
 * `'.EXE;.CMD;.BAT;.COM'`) hardcoded; local/no-private-binary-resolution
 * flags a re-occurrence of two-or-more of these outside the seam.
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * The Windows PATHEXT environment variable name. Windows environment variable
 * names are case-insensitive, so a read of ANY casing of this name (`Pathext`,
 * `pathext`, ...) is the signal local/no-private-binary-resolution matches on.
 */
const PATHEXT_VAR_NAME = 'PATHEXT';

/**
 * Windows environment variable names whose CONVENTIONAL casing varies from the
 * all-uppercase POSIX convention (`Path` not `PATH`, `ComSpec` not `COMSPEC`,
 * `TEMP`/`TMP`/`APPDATA`/`USERPROFILE` as shipped by Windows). `process.env` is
 * a case-insensitive Proxy that hides this on every platform, so
 * `process.env.PATH` is always safe — but a plain object (a spread of
 * `process.env`, a function parameter, any object that is not literally
 * `process.env` at the access site) keeps the OS's actual casing and an
 * exact-case lookup against it silently returns `undefined` on Windows.
 * local/no-exact-case-env-access matches a read of ANY casing of ANY of these
 * names off ANY receiver that is not `process.env` itself (#3624, epic #3411
 * Phase 4).
 */
const WINDOWS_CASE_VARYING_ENV_VARS = ['PATH', 'PATHEXT', 'ComSpec', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA'];

const WINDOWS_CASE_VARYING_ENV_VARS_LOWER = new Set(WINDOWS_CASE_VARYING_ENV_VARS.map((v) => v.toLowerCase()));

/**
 * True when `name` case-insensitively matches one of WINDOWS_CASE_VARYING_ENV_VARS.
 * @param {string} name
 * @returns {boolean}
 */
function isCaseVaryingEnvVarName(name) {
  return typeof name === 'string' && WINDOWS_CASE_VARYING_ENV_VARS_LOWER.has(name.toLowerCase());
}

/**
 * Boundary-aware match for each WINDOWS_EXECUTABLE_EXTENSIONS entry, in the
 * same order. A plain substring test misfires on ordinary prose/event-name
 * tokens that merely start with the same three letters — e.g. `.execute`
 * contains the substring `.exe`, and `.compacting` contains `.com`, neither
 * of which is a Windows executable extension (a real false positive this
 * caught in src/host-integration.cts's OPENCODE_EXTENSION_EVENTS list). The
 * negative lookahead requires the match NOT be immediately followed by
 * another letter, so `.exe` at the end of a token or before a delimiter
 * (`;`, `.`, `'`, whitespace, end-of-string) still matches, but `.exe` inside
 * `.execute` does not. Hand-written RegExp literals (not built from a
 * runtime string) so this itself is not an adhoc-regex-escape construction.
 */
const WINDOWS_EXECUTABLE_EXTENSION_PATTERNS = [
  /\.exe(?![a-zA-Z])/i,
  /\.cmd(?![a-zA-Z])/i,
  /\.bat(?![a-zA-Z])/i,
  /\.com(?![a-zA-Z])/i,
];

/**
 * Returns how many DISTINCT entries of WINDOWS_EXECUTABLE_EXTENSIONS appear
 * (case-insensitively, boundary-aware) in `str`. Used by
 * local/no-private-binary-resolution to apply its two-or-more threshold —
 * see the "Known boundaries" note above for the matching semantics.
 *
 * @param {string} str
 * @returns {number}
 */
function countWindowsExecutableExtensions(str) {
  if (typeof str !== 'string' || str.length === 0) return 0;
  let count = 0;
  for (const pattern of WINDOWS_EXECUTABLE_EXTENSION_PATTERNS) {
    if (pattern.test(str)) count += 1;
  }
  return count;
}

/**
 * Returns true when `node` is a CallExpression whose callee matches one of the
 * PATH_RETURNING_FNS entries.
 *
 * Handles two call shapes:
 *   - Dotted:  path.join(…)   → callee is MemberExpression{object: Identifier, property: Identifier}
 *   - Bare:    getGlobalDir() → callee is Identifier
 *
 * @param {import('eslint').Rule.Node} node - AST node to inspect
 * @returns {boolean}
 */
function isPathReturningCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;

  // Dotted call: path.join, os.homedir, etc.
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.property.type === 'Identifier'
  ) {
    const dotted = `${callee.object.name}.${callee.property.name}`;
    if (PATH_RETURNING_FNS.includes(dotted)) return true;
  }

  // Bare call: getGlobalConfigDir(), resolveKimiGlobalDir(), etc.
  if (callee.type === 'Identifier') {
    if (PATH_RETURNING_FNS.includes(callee.name)) return true;
  }

  return false;
}

/**
 * Returns true when `node` is a string literal (or a template literal with no
 * expressions) whose value contains '/' and does NOT look like a URL.
 *
 * URL exclusion: value starts with 'http://' or 'https://'.
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function isPosixSlashStringLiteral(node) {
  if (!node) return false;

  // Plain string literal
  if (node.type === 'Literal' && typeof node.value === 'string') {
    const v = node.value;
    if (!v.includes('/')) return false;
    if (v.startsWith('http://') || v.startsWith('https://')) return false;
    return true;
  }

  // Template literal with no expressions (static): `some/path`
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const v = node.quasis[0]?.value?.cooked ?? '';
    if (!v.includes('/')) return false;
    if (v.startsWith('http://') || v.startsWith('https://')) return false;
    return true;
  }

  return false;
}

/**
 * Returns true when `node` is a CallExpression that normalizes its first
 * argument to POSIX-style slashes.
 *
 * Recognized shapes:
 *   1. <x>.replace(/\\/g, '/')              — regex /\\/g with replacement '/'
 *   2. <x>.replace(/[\\/]/g, '/')           — regex /[\\/]/g with replacement '/'
 *   3. <x>.replaceAll('\\', '/')            — literal backslash to slash
 *   4. <x>.replaceAll(path.sep, '/')        — path.sep to slash
 *   5. <x>.split(path.sep).join('/')        — split-join idiom
 *   6. toPosixPath(<x>)                     — explicit wrapper
 *
 * Note: for replace(), we REQUIRE the 'g' flag on the regex AND the regex
 * source must actually target backslashes (source `\\` or `[\\/]`).
 * A regex like /foo/g or /\//g does NOT qualify.
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function isPosixNormalizerCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;

  // toPosixPath(<x>)
  if (callee.type === 'Identifier' && callee.name === 'toPosixPath') return true;

  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    const method = callee.property.name;
    const args = node.arguments;

    // <x>.replace(regex, '/')
    // REQUIRE: g flag + regex source must target backslashes: `\\` or `[\\/]`
    if (method === 'replace' && args.length >= 2) {
      const regexArg = args[0];
      const replacementArg = args[1];
      if (
        regexArg.type === 'Literal' &&
        regexArg.regex != null &&
        regexArg.regex.flags.includes('g') &&
        _isBackslashTargetingRegex(regexArg.regex.pattern) &&
        _isSlashReplacement(replacementArg)
      ) {
        return true;
      }
    }

    // <x>.replaceAll(sep, '/')
    if (method === 'replaceAll' && args.length >= 2) {
      const sepArg = args[0];
      const replacementArg = args[1];
      if (_isSlashReplacement(replacementArg)) {
        // replaceAll('\\', '/') or replaceAll('\\\\', '/') or replaceAll(path.sep, '/')
        if (_isBackslashLiteral(sepArg)) return true;
        if (_isPathSep(sepArg)) return true;
      }
    }

    // <x>.split(path.sep).join('/')
    // The callee is <split_result>.join — check the object for .split(path.sep)
    if (method === 'join' && args.length >= 1 && _isSlashReplacement(args[0])) {
      const splitCall = callee.object;
      if (
        splitCall.type === 'CallExpression' &&
        splitCall.callee.type === 'MemberExpression' &&
        !splitCall.callee.computed &&
        splitCall.callee.property.type === 'Identifier' &&
        splitCall.callee.property.name === 'split' &&
        splitCall.arguments.length >= 1 &&
        _isPathSep(splitCall.arguments[0])
      ) {
        return true;
      }
    }
  }

  return false;
}

/** True if node is the replacement '/' string literal */
function _isSlashReplacement(node) {
  return node && node.type === 'Literal' && node.value === '/';
}

/**
 * True if regexPattern (the raw regex source string, as stored in the AST's
 * `.regex.pattern` field) actually targets backslashes.
 *
 * Accepted: exactly `\\` (two-char, two backslashes: matches one backslash)
 *           exactly `[\\/]` (five-char: backslash-or-forward-slash charset)
 * Rejected: `foo`, `\/` (forward-slash only), anything else.
 *
 * @param {string} pattern  — the AST `.regex.pattern` string
 * @returns {boolean}
 */
function _isBackslashTargetingRegex(pattern) {
  // Pattern `\\` (two backslash chars in the regex) — matches a single backslash
  if (pattern === '\\\\') return true;
  // Pattern `[\\/]` (backslash-or-forward-slash charset) — five chars
  if (pattern === '[\\\\/]') return true;
  return false;
}

/** True if node is a backslash literal ('\\' or '\\\\') */
function _isBackslashLiteral(node) {
  if (!node || node.type !== 'Literal') return false;
  return node.value === '\\' || node.value === '\\\\';
}

/** True if node is path.sep */
function _isPathSep(node) {
  return (
    node &&
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'path' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'sep'
  );
}

/**
 * If `node` is `String(<x>)`, return `<x>`; otherwise return `node` as-is.
 * Allows the rule to see through String() casts on path expressions.
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {import('eslint').Rule.Node}
 */
function unwrapString(node) {
  if (
    node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'String' &&
    node.arguments.length === 1
  ) {
    return node.arguments[0];
  }
  return node;
}

/**
 * If `node` is a method-call chain of the form `<receiver>.replace(...)`,
 * `<receiver>.replaceAll(...)`, or `<receiver>.split(...).join(...)` that is
 * NOT a valid POSIX normalizer (i.e. `isPosixNormalizerCall(node)` is false),
 * return the receiver (the `.object` of the callee MemberExpression).
 *
 * This lets the rule detect:
 *   `path.join(a,b).replace(/foo/g, '/')` → not a normalizer, but the
 *   receiver `path.join(a,b)` IS a path-returning call → violation.
 *
 * Only peels ONE layer. The caller is responsible for checking the peeled node.
 * Returns `null` when `node` is already a valid normalizer or is not a method chain.
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {import('eslint').Rule.Node | null}
 */
function unwrapNonNormalizerMethodChain(node) {
  if (!node || node.type !== 'CallExpression') return null;
  // If it IS a valid normalizer, do NOT peel — the caller already handled that.
  if (isPosixNormalizerCall(node)) return null;

  const callee = node.callee;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    const method = callee.property.name;
    // String-mutation methods that commonly wrap path calls
    if (method === 'replace' || method === 'replaceAll') {
      return callee.object;
    }
    // <x>.split(...).join(...) — callee.object is the .split() result;
    // peel to the .split()'s receiver
    if (method === 'join') {
      const splitCall = callee.object;
      if (
        splitCall &&
        splitCall.type === 'CallExpression' &&
        splitCall.callee.type === 'MemberExpression' &&
        !splitCall.callee.computed &&
        splitCall.callee.property.type === 'Identifier' &&
        splitCall.callee.property.name === 'split'
      ) {
        return splitCall.callee.object;
      }
    }
  }
  return null;
}

module.exports = {
  PATH_RETURNING_FNS,
  WINDOWS_EXECUTABLE_EXTENSIONS,
  PATHEXT_VAR_NAME,
  WINDOWS_CASE_VARYING_ENV_VARS,
  isCaseVaryingEnvVarName,
  countWindowsExecutableExtensions,
  isPathReturningCall,
  isPosixSlashStringLiteral,
  isPosixNormalizerCall,
  unwrapString,
  unwrapNonNormalizerMethodChain,
};
