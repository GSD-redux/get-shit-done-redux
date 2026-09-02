'use strict';

/**
 * portability-vocab-drift.test.cjs
 *
 * Drift-guard: ensure that every exported function from src/runtime-homes.cts
 * that returns a filesystem path is listed in PATH_RETURNING_FNS
 * (eslint-rules/lib/portability-vocab.cjs).
 *
 * Method:
 *   1. Parse src/runtime-homes.cts with @typescript-eslint/parser.
 *   2. Collect `export function <name>` declarations where the body contains
 *      a path-building expression (path.join, path.dirname, os.homedir,
 *      expandTilde, or returns something with "Dir" / "Path" / "Base" in its name).
 *   3. Assert each collected name is in PATH_RETURNING_FNS or is listed in
 *      IGNORED_NON_PATH_EXPORTS (with a reason comment per entry).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tsParser = require('@typescript-eslint/parser');
const espree = require('espree');

const { PATH_RETURNING_FNS, WINDOWS_CASE_VARYING_ENV_VARS } = require('../eslint-rules/lib/portability-vocab.cjs');

// Functions exported from runtime-homes.cts that do NOT return a filesystem
// path and therefore are intentionally excluded from PATH_RETURNING_FNS.
const IGNORED_NON_PATH_EXPORTS = new Set([
  // resolveConfigHomeFromDescriptor: internal/exported but delegates to path-returning helpers;
  // it IS included in PATH_RETURNING_FNS under its bare name (no object prefix needed).
  // detectAntigravityDirAmbiguity: returns an object (AntigravityAmbiguity), not a path string.
  'detectAntigravityDirAmbiguity',
]);

// bin/install.js path-returning helpers that are registered in PATH_RETURNING_FNS.
// This is the curated set named by ADR-1703 L114-119 ("the relevant bin/install.js
// exports"). The companion test below locks it two ways: each must still be DEFINED
// in the generated installer (catches a rename/removal making the vocab entry stale),
// AND this list must equal the PATH_RETURNING_FNS bare-names that are defined in
// bin/install.js (so the curation cannot drift silently out of sync with the vocab).
const INSTALL_JS_PATH_HELPERS = [
  'getConfigDirFromHome',
  'getGlobalDir',
  'resolveKiloConfigPath',
  'resolveOpencodeConfigPath',
  'computePathPrefix',
  'normalizeInstallRelativePath',
  // #2088 (ADR-1239 upgrade 3): resolves the skills-install dir honoring a
  // skills-kind `home` override (e.g. Codex → $HOME/.agents/skills).
  '_resolveSkillsRootDir',
  // #3664: shared kind-destination resolver (skills/agents/kimi-agents kinds).
  '_kindDestDir',
];

describe('portability-vocab drift guard', () => {
  test('PATH_RETURNING_FNS is a non-empty array', () => {
    assert.ok(Array.isArray(PATH_RETURNING_FNS));
    assert.ok(PATH_RETURNING_FNS.length > 0);
  });

  test('PATH_RETURNING_FNS includes the Node builtins', () => {
    const builtins = ['path.join', 'path.resolve', 'path.dirname', 'path.basename', 'path.normalize', 'path.relative', 'os.homedir', 'os.tmpdir'];
    for (const fn of builtins) {
      assert.ok(PATH_RETURNING_FNS.includes(fn), `Expected PATH_RETURNING_FNS to include builtin "${fn}"`);
    }
  });

  test('every path-returning export from runtime-homes.cts is in PATH_RETURNING_FNS or IGNORED', () => {
    const srcPath = path.join(__dirname, '..', 'src', 'runtime-homes.cts');
    const src = fs.readFileSync(srcPath, 'utf-8');

    // Parse with @typescript-eslint/parser (handles TypeScript syntax)
    const ast = tsParser.parse(src, {
      jsx: false,
      loc: true,
      range: true,
      comment: true,
      tokens: false,
    });

    // Collect exported function names whose body looks path-returning:
    //   - body contains a call to path.join / path.dirname / os.homedir / expandTilde
    //   - OR function name ends with Dir, Path, Base, Home, or starts with resolve/get
    const pathReturningExports = [];

    function bodyText(node) {
      // Slice the source for the function body
      if (node.range) return src.slice(node.range[0], node.range[1]);
      return '';
    }

    function looksPathReturning(funcNode, name) {
      const body = bodyText(funcNode.body ?? funcNode);
      const pathBuilders = [
        'path.join', 'path.resolve', 'path.dirname', 'path.basename',
        'path.normalize', 'path.relative', 'os.homedir', 'os.tmpdir',
        'expandTilde', 'expandTildeWithHome', 'resolveConfigHome',
      ];
      if (pathBuilders.some(p => body.includes(p))) return true;
      // Name heuristic: resolveXxx / getXxxDir / getXxxPath / getXxxBase
      if (/^(resolve|get)[A-Z]/.test(name) && /Dir|Path|Base|Home|Skills/.test(name)) return true;
      return false;
    }

    // Build a lookup from top-level declaration names to their function nodes,
    // to resolve `export { name }` specifier exports (C4).
    const topLevelFunctionNodes = new Map(); // name → funcNode
    for (const node of ast.body) {
      // function <name>(...) { ... }  (non-exported declaration)
      if (
        node.type === 'FunctionDeclaration' &&
        node.id
      ) {
        topLevelFunctionNodes.set(node.id.name, node);
      }
      // const <name> = () => ...  (non-exported const arrow/function)
      if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations) {
          if (
            decl.type === 'VariableDeclarator' &&
            decl.id &&
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
              decl.init.type === 'FunctionExpression')
          ) {
            topLevelFunctionNodes.set(decl.id.name, decl.init);
          }
        }
      }
      // export function / export const — also register in the map
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'FunctionDeclaration' &&
        node.declaration.id
      ) {
        topLevelFunctionNodes.set(node.declaration.id.name, node.declaration);
      }
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'VariableDeclaration'
      ) {
        for (const decl of node.declaration.declarations) {
          if (
            decl.type === 'VariableDeclarator' &&
            decl.id &&
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
              decl.init.type === 'FunctionExpression')
          ) {
            topLevelFunctionNodes.set(decl.id.name, decl.init);
          }
        }
      }
    }

    for (const node of ast.body) {
      // export function <name>(...) { ... }
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'TSDeclareFunction' === false &&
        (node.declaration.type === 'FunctionDeclaration') &&
        node.declaration.id
      ) {
        const name = node.declaration.id.name;
        if (looksPathReturning(node.declaration, name)) {
          pathReturningExports.push(name);
        }
      }

      // export const <name> = (<ArrowFunctionExpression> | <FunctionExpression>)
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'VariableDeclaration'
      ) {
        for (const decl of node.declaration.declarations) {
          if (
            decl.type === 'VariableDeclarator' &&
            decl.id &&
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
              decl.init.type === 'FunctionExpression')
          ) {
            const name = decl.id.name;
            if (looksPathReturning(decl.init, name)) {
              pathReturningExports.push(name);
            }
          }
        }
      }

      // export { name1, name2 } — specifier exports (C4)
      // Resolve each specifier to its in-file function/const declaration.
      if (
        node.type === 'ExportNamedDeclaration' &&
        !node.declaration &&
        node.source == null && // not a re-export from another module
        Array.isArray(node.specifiers)
      ) {
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ExportSpecifier' &&
            specifier.local &&
            specifier.local.type === 'Identifier'
          ) {
            const name = specifier.local.name;
            const exportedName =
              specifier.exported && specifier.exported.type === 'Identifier'
                ? specifier.exported.name
                : name;
            const funcNode = topLevelFunctionNodes.get(name);
            if (funcNode && looksPathReturning(funcNode, exportedName)) {
              pathReturningExports.push(exportedName);
            }
          }
        }
      }
    }

    // Verify we found at least a few (guards against parser silently failing)
    assert.ok(
      pathReturningExports.length >= 3,
      `Expected at least 3 path-returning exports, got ${pathReturningExports.length}: [${pathReturningExports.join(', ')}]`
    );

    const vocabSet = new Set(PATH_RETURNING_FNS);
    const missing = [];
    for (const name of pathReturningExports) {
      if (!vocabSet.has(name) && !IGNORED_NON_PATH_EXPORTS.has(name)) {
        missing.push(name);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `These path-returning exports from runtime-homes.cts are missing from PATH_RETURNING_FNS:\n  ${missing.join('\n  ')}\n\nEither add them to PATH_RETURNING_FNS in eslint-rules/lib/portability-vocab.cjs or add them to IGNORED_NON_PATH_EXPORTS with a reason.`
    );
  });

  test('export const arrow-function returning path.join would be required in PATH_RETURNING_FNS', () => {
    // Simulate parsing a snippet with `export const myArrowResolver = (x) => path.join(home, x)`
    // and verify the drift-guard collector would pick it up (i.e. it's NOT silently bypassed).
    const snippetSrc = `
      export const myArrowResolver = (x) => path.join('/home', x);
    `;
    const ast = tsParser.parse(snippetSrc, {
      jsx: false,
      loc: true,
      range: true,
      comment: true,
      tokens: false,
    });

    const collected = [];
    for (const node of ast.body) {
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'VariableDeclaration'
      ) {
        for (const decl of node.declaration.declarations) {
          if (
            decl.type === 'VariableDeclarator' &&
            decl.id &&
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
              decl.init.type === 'FunctionExpression')
          ) {
            const name = decl.id.name;
            const bodyTxt = snippetSrc.slice(decl.init.range[0], decl.init.range[1]);
            if (['path.join', 'path.resolve', 'path.dirname'].some(p => bodyTxt.includes(p))) {
              collected.push(name);
            }
          }
        }
      }
    }

    assert.deepStrictEqual(collected, ['myArrowResolver'],
      'Arrow-function path export should be collected by the drift guard, requiring it in PATH_RETURNING_FNS');

    // Confirm PATH_RETURNING_FNS does NOT already contain this fictional name
    // (so the test demonstrates a missing entry would be caught, not silently pass).
    assert.ok(
      !PATH_RETURNING_FNS.includes('myArrowResolver'),
      'myArrowResolver should not be in PATH_RETURNING_FNS (it is a test fixture name)',
    );
  });

  test('C4: export { name } specifier form — path resolver would be required in PATH_RETURNING_FNS', () => {
    // Demonstrate that the drift guard now handles `export { mySpecifierResolver }` where
    // the function is declared separately (not inline in the export statement).
    const snippetSrc = `
      function mySpecifierResolver(x) {
        return path.join('/home', x);
      }
      export { mySpecifierResolver };
    `;
    const ast = tsParser.parse(snippetSrc, {
      jsx: false,
      loc: true,
      range: true,
      comment: true,
      tokens: false,
    });

    // Replicate the drift-guard's specifier-resolution logic (C4 addition).
    const topLevelFns = new Map();
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' && node.id) {
        topLevelFns.set(node.id.name, node);
      }
    }

    const collected = [];
    for (const node of ast.body) {
      if (
        node.type === 'ExportNamedDeclaration' &&
        !node.declaration &&
        node.source == null &&
        Array.isArray(node.specifiers)
      ) {
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ExportSpecifier' &&
            specifier.local &&
            specifier.local.type === 'Identifier'
          ) {
            const localName = specifier.local.name;
            const funcNode = topLevelFns.get(localName);
            if (funcNode) {
              const bodyTxt = snippetSrc.slice(funcNode.range[0], funcNode.range[1]);
              if (['path.join', 'path.resolve', 'path.dirname'].some(p => bodyTxt.includes(p))) {
                collected.push(localName);
              }
            }
          }
        }
      }
    }

    assert.deepStrictEqual(collected, ['mySpecifierResolver'],
      'export { name } specifier form should be detected by drift guard, requiring entry in PATH_RETURNING_FNS');

    assert.ok(
      !PATH_RETURNING_FNS.includes('mySpecifierResolver'),
      'mySpecifierResolver should not be in PATH_RETURNING_FNS (it is a test fixture name)',
    );
  });

  // ─── ADR-1703 L114-119: the drift guard also covers "the relevant bin/install.js
  // exports". The generated installer is a path-heavy 12k-line CommonJS file where
  // the loose body-contains heuristic (used for runtime-homes.cts) is UNSOUND — it
  // produces ~33 false positives because nearly every function uses path.join. The
  // two checks below use SOUND shapes only, and document the residual boundary.
  test('bin/install.js: every function that DIRECTLY returns a path.* call is in PATH_RETURNING_FNS', () => {
    const srcPath = path.join(__dirname, '..', 'bin', 'install.js');
    const raw = fs.readFileSync(srcPath, 'utf8');
    // bin/install.js starts with a shebang espree cannot parse — rewrite #! -> //.
    // allow-test-rule: source-text-is-the-product (#3545) — this is shebang-stripping
    // to make the source parseable by espree; the test then walks the real AST
    // structurally (below), it is not a text-grep proxy for behavior
    const src = raw.startsWith('#!') ? '//' + raw.slice(2) : raw;
    const ast = espree.parse(src, { ecmaVersion: 2022, loc: true, range: true, tolerant: true });

    // SOUND shape: a top-level function whose body contains a ReturnStatement
    // whose argument is a CallExpression to path.join/resolve/dirname/normalize/
    // relative. This is tight (0 false positives on the current installer) and
    // catches the canonical resolver shape (resolveOpencodeConfigPath,
    // resolveKiloConfigPath). It does NOT catch a resolver that builds a path
    // into a temp variable then returns the temp — see the boundary note below.
    function returnsPathCall(funcBody) {
      let found = false;
      function walk(n) {
        if (found || !n || typeof n !== 'object') return;
        if (n.type === 'ReturnStatement' && n.argument && n.argument.type === 'CallExpression') {
          const callee = n.argument.callee;
          if (
            callee.type === 'MemberExpression' &&
            !callee.computed &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'path' &&
            callee.property.type === 'Identifier' &&
            ['join', 'resolve', 'dirname', 'normalize', 'relative', 'basename'].includes(callee.property.name)
          ) {
            found = true;
            return;
          }
        }
        // Do NOT descend into nested function expressions/declarations — a path
        // return inside a nested callback does not make the outer fn path-returning.
        if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration') return;
        for (const key of Object.keys(n)) {
          if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
          const child = n[key];
          if (Array.isArray(child)) {
            for (const item of child) {
              if (item && typeof item === 'object' && item.type) walk(item);
            }
          } else if (child && typeof child === 'object' && child.type) {
            walk(child);
          }
        }
      }
      walk(funcBody);
      return found;
    }

    const pathReturning = [];
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' && node.id && node.body) {
        if (returnsPathCall(node.body)) pathReturning.push(node.id.name);
      }
    }

    const vocabSet = new Set(PATH_RETURNING_FNS);
    const missing = pathReturning.filter((n) => !vocabSet.has(n));
    assert.deepStrictEqual(
      missing,
      [],
      `These bin/install.js functions return a path.* call but are missing from PATH_RETURNING_FNS:\n  ${missing.join('\n  ')}\n\nRegister them in eslint-rules/lib/portability-vocab.cjs (or, if they do not return a string path that flows into content/assertions, document why).`,
    );
  });

  test('bin/install.js: the curated INSTALL_JS_PATH_HELPERS still exist (no stale vocab entries after a rename)', () => {
    const srcPath = path.join(__dirname, '..', 'bin', 'install.js');
    const raw = fs.readFileSync(srcPath, 'utf8');
    // allow-test-rule: source-text-is-the-product (#3545) — shebang-stripping to
    // make the source parseable by espree; the test walks the real AST
    // structurally (below), not a text-grep proxy for behavior
    const src = raw.startsWith('#!') ? '//' + raw.slice(2) : raw;
    const ast = espree.parse(src, { ecmaVersion: 2022, loc: true, range: true, tolerant: true });

    // Collect every top-level function-declaration AND const/let/var name defined
    // in the installer (path helpers may be `function foo(){}` OR a const import
    // like `const computePathPrefix = runtimeArtifactConversion._computePathPrefix`).
    const defined = new Set();
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' && node.id) defined.add(node.id.name);
      if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations) {
          if (decl.type === 'VariableDeclarator' && decl.id && decl.id.type === 'Identifier') {
            defined.add(decl.id.name);
          }
        }
      }
    }

    // (a) Each curated helper must still be defined — catches a rename/removal
    //     that would leave a stale entry in PATH_RETURNING_FNS (the rule would
    //     silently stop matching the renamed resolver).
    const missing = INSTALL_JS_PATH_HELPERS.filter((n) => !defined.has(n));
    assert.deepStrictEqual(
      missing,
      [],
      `These curated bin/install.js path helpers are no longer defined in bin/install.js — their PATH_RETURNING_FNS entries are now stale:\n  ${missing.join('\n  ')}\n\nRename them in eslint-rules/lib/portability-vocab.cjs PATH_RETURNING_FNS and in INSTALL_JS_PATH_HELPERS here.`,
    );

    // (b) The curated list must equal the PATH_RETURNING_FNS bare-names that are
    //     defined in bin/install.js — so the curation cannot drift out of sync
    //     with the vocab. If a new install.js helper is added to PATH_RETURNING_FNS,
    //     it must also be added to INSTALL_JS_PATH_HELPERS (and vice versa).
    const vocabSet = new Set(PATH_RETURNING_FNS);
    const vocabHelpersDefinedInInstallJs = [...vocabSet].filter((n) => defined.has(n) && !n.includes('.')).sort();
    assert.deepStrictEqual(
      [...INSTALL_JS_PATH_HELPERS].sort(),
      vocabHelpersDefinedInInstallJs,
      `INSTALL_JS_PATH_HELPERS is out of sync with PATH_RETURNING_FNS entries defined in bin/install.js.\n` +
        `  curated list:  [${[...INSTALL_JS_PATH_HELPERS].sort().join(', ')}]\n` +
        `  vocab ∩ install.js: [${vocabHelpersDefinedInInstallJs.join(', ')}]\n` +
        `Reconcile the two lists.`,
    );
  });
});

describe('exact-case-env-access vocab drift guard', () => {
  test('WINDOWS_CASE_VARYING_ENV_VARS is a non-empty array', () => {
    assert.ok(Array.isArray(WINDOWS_CASE_VARYING_ENV_VARS));
    assert.ok(WINDOWS_CASE_VARYING_ENV_VARS.length > 0);
  });

  test('every literal env-var name passed to envGet(...) in the seam is registered in WINDOWS_CASE_VARYING_ENV_VARS', () => {
    const srcPath = path.join(__dirname, '..', 'src', 'shell-command-projection.cts');
    const src = fs.readFileSync(srcPath, 'utf-8');

    const ast = tsParser.parse(src, {
      jsx: false,
      loc: true,
      range: true,
      comment: true,
      tokens: false,
    });

    // Collect the second-argument string literal of every `envGet(...)` call
    // site anywhere in the file (no special-casing of nesting — walk everything).
    const collected = [];
    function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (
        n.type === 'CallExpression' &&
        n.callee &&
        n.callee.type === 'Identifier' &&
        n.callee.name === 'envGet' &&
        Array.isArray(n.arguments) &&
        n.arguments[1] &&
        n.arguments[1].type === 'Literal' &&
        typeof n.arguments[1].value === 'string'
      ) {
        collected.push(n.arguments[1].value);
      }
      for (const key of Object.keys(n)) {
        if (key === 'parent' || key === 'tokens' || key === 'comments' || key === 'loc' || key === 'range') continue;
        const child = n[key];
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === 'object' && item.type) walk(item);
          }
        } else if (child && typeof child === 'object' && child.type) {
          walk(child);
        }
      }
    }
    walk(ast);

    // Guard against the walker itself being broken (a silent 0-hit pass would
    // make this test vacuously true).
    assert.ok(
      collected.length > 0,
      `Expected to find at least one envGet(...) call site with a literal name in ${srcPath}, found none — the AST walker may be broken.`,
    );

    const vocabLower = new Set(WINDOWS_CASE_VARYING_ENV_VARS.map((v) => v.toLowerCase()));
    const missing = collected.filter((name) => !vocabLower.has(name.toLowerCase()));

    assert.deepStrictEqual(
      missing,
      [],
      `These envGet(...) literal env-var names in src/shell-command-projection.cts are missing from WINDOWS_CASE_VARYING_ENV_VARS:\n  ${missing.join('\n  ')}\n\nAdd them to WINDOWS_CASE_VARYING_ENV_VARS in eslint-rules/lib/portability-vocab.cjs.`,
    );
  });
});

// ─── Known boundary (documented, not enforced) ─────────────────────────────────
//
// A NEW path-returning resolver added to bin/install.js that builds its path via
// a temp variable (`const p = path.join(...); return p;`) or by delegating to
// another helper (`return getGlobalDir(...)`) is NOT caught by the tight
// return-path.* check above (which requires `return path.join(...)` directly).
// The looser body-contains heuristic is unsound here (33 FPs on the current
// installer). The installer's path API is a small, stable, curated set; a new
// resolver there is caught at code review (the active resolver module,
// src/runtime-homes.cts, IS fully drift-guarded by the looser heuristic above,
// which is sound for that focused module).
