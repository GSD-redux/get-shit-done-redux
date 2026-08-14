'use strict';

/**
 * no-source-grep
 *
 * Flags variables bound to readFileSync() of a .cjs/.cts/.js/.mjs/.mts/.ts
 * source path that later have a text-search method called on them, whether
 * directly, via a bounded chain of derived bindings (`const b = f(a)`,
 * `b = a`, ...), or via `regex.test(tracked)` / `/lit/.test(tracked)`.
 *
 * Variable identity is resolved through real lexical scope (ESLint
 * `Variable` objects via `sourceCode.scopeManager`/`getScope`), not by name
 * string, so a same-named binding in an unrelated or shadowing scope is
 * never conflated with a tracked one.
 *
 * Honor file-level escape comment: // allow-test-rule: <reason>
 */

// How many derivation hops from the original readFileSync() binding to
// follow before giving up on a transitive chain. hop=1 is the variable
// bound directly to the readFileSync() result; hop=2 is a variable derived
// one step from it; etc. Depth-bounded on purpose (test-matrix.md rows
// 9-11): a chain longer than this is a documented, accepted blind spot, not
// a bug — see 40-design.md "Known limits".
const MAX_TRANSITIVE_HOPS = 3;

const TEXT_METHODS = new Set([
  'includes',
  'match',
  'matchAll',
  'startsWith',
  'endsWith',
  'indexOf',
  'search',
  'split',
  'replace',
]);

// Method names that, called ON an already-tracked value, still return a
// value that may carry the source file's TEXT (string in, string/array
// out) -- so tracking continues to propagate through the derived result.
const PROPAGATING_STRING_METHODS = new Set([
  'replace',
  'replaceAll',
  'slice',
  'substring',
  'substr',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'normalize',
  'padStart',
  'padEnd',
  'concat',
  'repeat',
  'at',
  'toString',
  'valueOf',
  'split',
  'join',
]);

// Method names that, called ON an already-tracked value, definitively
// return a non-text (number/boolean) result. Calling one of these directly
// on a tracked value IS itself the violation TEXT_METHODS exists to catch
// (see `includes`/`startsWith`/etc. above) -- but the RETURN VALUE of the
// call must not stay tracked, or `const ok = raw.includes('x'); ok.foo()`
// would go on being treated as if `ok` were still source text.
const NON_PROPAGATING_METHODS = new Set([
  'indexOf',
  'lastIndexOf',
  'search',
  'charCodeAt',
  'codePointAt',
  'localeCompare',
  'includes',
  'startsWith',
  'endsWith',
  'test',
]);

// Global "shape-narrowing" functions whose return value is definitively
// not text, regardless of what is passed in.
const NON_PROPAGATING_CALLEE_NAMES = new Set([
  'Number',
  'parseInt',
  'parseFloat',
  'Boolean',
]);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reading source .cjs/.cts/.js/.mjs/.mts/.ts files with readFileSync and then doing text search on the result',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      noSourceGrep:
        'Source-grep test: do not read source .cjs/.cts/.js/.mjs/.mts/.ts files with readFileSync and call .includes/.match/.matchAll/.startsWith/.indexOf/.split/.replace/.search (or regex.test()) on the result. Use require() to run the module instead. Add // allow-test-rule: <reason> at the top of the file to suppress.',
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode;

    // Check for file-level escape comment
    const comments = sourceCode.getAllComments();
    const hasAllowAnnotation = comments.some(
      (c) => /allow-test-rule:\s*\S/.test(c.value)
    );
    if (hasAllowAnnotation) return {};

    // Map from Identifier AST node -> resolved ESLint `Variable`, built once
    // per file (see buildIdentifierVariableMap) so that resolveVariable() is
    // an O(1) lookup instead of a per-call linear scan over scope.references
    // / scope.variables. Populated lazily on first use from Program:exit,
    // after the scope manager has finished analyzing the whole file, and
    // rebuilt fresh for every file since `create(context)` runs per file
    // (nothing here is module-level state).
    let identifierVariableMap = null;

    // Walk every scope exactly once and record, for each Identifier node
    // that is either a resolved reference or a declaration site, the
    // `Variable` it resolves to. References are indexed first and
    // declarations only fill in gaps, mirroring the precedence of the
    // original per-call algorithm (which checked scope.references before
    // falling back to scope.variables) -- though in practice an Identifier
    // node can only ever be one or the other, never both.
    function buildIdentifierVariableMap() {
      const map = new Map();
      const scopeManager = sourceCode.scopeManager;
      for (const scope of scopeManager.scopes) {
        for (const ref of scope.references) {
          if (ref.resolved) map.set(ref.identifier, ref.resolved);
        }
      }
      for (const scope of scopeManager.scopes) {
        for (const variable of scope.variables) {
          for (const def of variable.defs) {
            if (def.name && !map.has(def.name)) map.set(def.name, variable);
          }
        }
      }
      return map;
    }

    // Resolve an Identifier node to the ESLint `Variable` it names, via real
    // scope analysis rather than name-string matching. Handles both uses
    // (references, resolved through reference.resolved) and declaration
    // sites (the `id` of a VariableDeclarator, a parameter, etc.).
    function resolveVariable(identifierNode) {
      if (!identifierVariableMap) {
        identifierVariableMap = buildIdentifierVariableMap();
      }
      return identifierVariableMap.get(identifierNode) || null;
    }

    // Detect if a node represents a readFileSync call on a source file
    // (.cjs/.cts/.js/.mjs/.mts/.ts) that lives in a source directory
    // (bin, lib, gsd-core, src).
    function isSourceReadFileSync(node) {
      if (!node || node.type !== 'CallExpression') return false;

      const callee = node.callee;
      const isFsRead =
        (callee.type === 'Identifier' && callee.name === 'readFileSync') ||
        (callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'readFileSync');

      if (!isFsRead) return false;

      const args = node.arguments;
      if (!args || args.length === 0) return false;

      const firstArg = args[0];
      const fullSrc = sourceCode.getText(firstArg);

      return looksLikeSourcePath(fullSrc);
    }

    // Given the source text of a path expression, determine if it references
    // a .cjs/.cts/.js/.mjs/.mts/.ts source file in a source directory.
    function looksLikeSourcePath(src) {
      // Must end with a source extension (in a string). Longer extensions
      // are listed first in the alternation so `.cts`/`.mts`/`.mjs` are
      // never partially matched by the shorter `.js`/`.ts`/`.cjs` arms.
      const hasSourceExt = /['"`.][^'"`.]*\.(?:cts|mts|mjs|cjs|js|ts)['"`)]/i.test(src);
      if (!hasSourceExt) return false;

      // Must reference a source directory indicator somewhere in the expression
      const hasSourceDir = /['"](?:bin|lib|gsd-core|src)['"]/i.test(src);
      return hasSourceDir;
    }

    // Variable -> hop number. hop=1 is a variable bound directly to a
    // source readFileSync() result; each additional derivation hop
    // increments by 1, capped at MAX_TRANSITIVE_HOPS.
    const hopOf = new Map();

    // Generic conservative fallback: walk every Identifier under `node` and
    // return the smallest hop number among identifiers that resolve to an
    // already-tracked variable, or null if none do. This is the DEFAULT for
    // any expression shape not explicitly recognized below (arguments to an
    // unknown function call, logical expressions, etc.) -- for an
    // unrecognized shape we choose to PROPAGATE (risking a rarer false
    // positive) rather than silently drop a true positive, because the
    // callee/operator may still be returning text derived from the tracked
    // value. Clearly-scalar shapes (member access, comparisons, numeric/
    // boolean methods, Number()/parseInt()/etc.) are special-cased below to
    // explicitly NOT propagate instead, since for those we know for certain
    // the result cannot carry text.
    function walkForTrackedHop(node) {
      let min = null;
      (function walk(n) {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'Identifier') {
          const v = resolveVariable(n);
          if (v && hopOf.has(v)) {
            const h = hopOf.get(v);
            if (min === null || h < min) min = h;
          }
        }
        for (const key of Object.keys(n)) {
          if (key === 'parent') continue;
          const val = n[key];
          if (Array.isArray(val)) {
            for (const child of val) {
              if (child && typeof child.type === 'string') walk(child);
            }
          } else if (val && typeof val.type === 'string') {
            walk(val);
          }
        }
      })(node);
      return min;
    }

    // Determine whether tracking should propagate through `node`'s value
    // into whatever it is assigned/bound to, and if so, at what (minimum)
    // hop it draws from. Returns null when the value shape is one we know
    // for certain cannot still carry the tracked file's text.
    function minTrackedHop(node) {
      if (!node || typeof node.type !== 'string') return null;

      switch (node.type) {
        case 'Identifier': {
          // Identity: `const b = a;`
          const v = resolveVariable(node);
          return v && hopOf.has(v) ? hopOf.get(v) : null;
        }

        case 'AwaitExpression':
          return minTrackedHop(node.argument);

        case 'ConditionalExpression': {
          // `cond ? a : other` -- only the branches can carry the tracked
          // value; the test itself is a boolean and does not propagate.
          const c = minTrackedHop(node.consequent);
          const a = minTrackedHop(node.alternate);
          if (c === null) return a;
          if (a === null) return c;
          return Math.min(c, a);
        }

        case 'TemplateLiteral': {
          // `` `${a}` `` -- a template embedding a tracked value still
          // carries its text.
          let min = null;
          for (const expr of node.expressions) {
            const h = minTrackedHop(expr);
            if (h !== null && (min === null || h < min)) min = h;
          }
          return min;
        }

        case 'BinaryExpression': {
          // String concatenation (`a + 'x'` / `'x' + a`) may still carry
          // text; every OTHER binary operator (===, !==, ==, !=, <, >, <=,
          // >=, arithmetic, etc.) produces a boolean/number and must not
          // propagate.
          if (node.operator !== '+') return null;
          const l = minTrackedHop(node.left);
          const r = minTrackedHop(node.right);
          if (l === null) return r;
          if (r === null) return l;
          return Math.min(l, r);
        }

        case 'UnaryExpression':
          // `!x`, `typeof x`, `void x`, `-x`, `+x`, `~x` all produce a
          // non-text primitive.
          return null;

        case 'MemberExpression':
          // Bare property/element access that is NOT itself a call (e.g.
          // `.length`, `.size`, or any other property read). This is the
          // reported false-positive shape (`const len = raw.length;`):
          // none of these definitively still carry the original text, so
          // do not propagate.
          return null;

        case 'ArrayExpression':
        case 'ObjectExpression':
          // Do not widen into array/object literals or the destructuring
          // that would be needed to read a value back out of them. This is
          // a documented, deliberate blind spot (not a new bug) -- see
          // 40-design.md "Known limits".
          return null;

        case 'CallExpression': {
          const callee = node.callee;

          // Number(...), parseInt(...), parseFloat(...), Boolean(...):
          // the result is definitively not text, regardless of the arg.
          if (
            callee.type === 'Identifier' &&
            NON_PROPAGATING_CALLEE_NAMES.has(callee.name)
          ) {
            return null;
          }

          // Array.isArray(...): definitively boolean.
          if (
            callee.type === 'MemberExpression' &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'Array' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'isArray'
          ) {
            return null;
          }

          // Method call on a tracked receiver: `obj.method(...)`. Whether
          // the result stays tracked depends on what the method returns.
          if (
            callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier'
          ) {
            const objHop = minTrackedHop(callee.object);
            if (objHop !== null) {
              const propName = callee.property.name;
              if (NON_PROPAGATING_METHODS.has(propName)) return null;
              if (PROPAGATING_STRING_METHODS.has(propName)) return objHop;
              // Unrecognized method name on a known-tracked receiver:
              // conservative default for an unrecognized call result (see
              // fallback rationale above) -- propagate rather than risk
              // silently dropping a true positive.
              return objHop;
            }
          }

          // Not a recognized narrowing/receiver call shape: fall through
          // to the generic conservative walk (covers "tracked value passed
          // as an argument to any call", e.g. `const b = strip(a);`).
          return walkForTrackedHop(node);
        }

        default:
          // Any other expression shape (LogicalExpression, parenthesized
          // expressions -- which are not a distinct AST node -- etc.):
          // conservative default, see walkForTrackedHop doc comment.
          return walkForTrackedHop(node);
      }
    }

    const pendingDeclarators = [];
    const pendingAssignments = [];
    const pendingCalls = [];

    return {
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.init) {
          pendingDeclarators.push({ id: node.id, init: node.init });
        }
      },
      AssignmentExpression(node) {
        if (node.left.type === 'Identifier' && node.right) {
          pendingAssignments.push({ left: node.left, right: node.right });
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return;
        const propName = node.callee.property.name;
        if (TEXT_METHODS.has(propName)) {
          pendingCalls.push({ node, kind: 'textMethod' });
        } else if (propName === 'test') {
          pendingCalls.push({ node, kind: 'regexTest' });
        }
      },
      'Program:exit'() {
        // Seed hop=1 for variables bound directly to a source readFileSync().
        for (const { id, init } of pendingDeclarators) {
          if (isSourceReadFileSync(init)) {
            const v = resolveVariable(id);
            if (v && !hopOf.has(v)) hopOf.set(v, 1);
          }
        }
        for (const { left, right } of pendingAssignments) {
          if (isSourceReadFileSync(right)) {
            const v = resolveVariable(left);
            if (v && !hopOf.has(v)) hopOf.set(v, 1);
          }
        }

        // Fixpoint over derived bindings, bounded by MAX_TRANSITIVE_HOPS.
        // Each variable is added at most once, so this always terminates.
        let changed = true;
        while (changed) {
          changed = false;
          for (const { id, init } of pendingDeclarators) {
            const v = resolveVariable(id);
            if (!v || hopOf.has(v)) continue;
            const parentHop = minTrackedHop(init);
            if (parentHop !== null && parentHop + 1 <= MAX_TRANSITIVE_HOPS) {
              hopOf.set(v, parentHop + 1);
              changed = true;
            }
          }
          for (const { left, right } of pendingAssignments) {
            const v = resolveVariable(left);
            if (!v || hopOf.has(v)) continue;
            const parentHop = minTrackedHop(right);
            if (parentHop !== null && parentHop + 1 <= MAX_TRANSITIVE_HOPS) {
              hopOf.set(v, parentHop + 1);
              changed = true;
            }
          }
        }

        // Now that hopOf is stable, evaluate every candidate call site.
        for (const { node, kind } of pendingCalls) {
          const obj = node.callee.object;

          if (kind === 'textMethod') {
            // varName.includes(...), varName.match(...), etc.
            if (obj.type === 'Identifier') {
              const v = resolveVariable(obj);
              if (v && hopOf.has(v)) {
                context.report({ node, messageId: 'noSourceGrep' });
                continue;
              }
            }
            // Inline: readFileSync(...).includes(...)
            if (isSourceReadFileSync(obj)) {
              context.report({ node, messageId: 'noSourceGrep' });
            }
            continue;
          }

          // kind === 'regexTest': re.test(tracked) or /lit/.test(tracked).
          // The tracked variable is the ARGUMENT here, not the callee object.
          const looksLikeRegexReceiver =
            obj.type === 'Identifier' || (obj.type === 'Literal' && !!obj.regex);
          if (!looksLikeRegexReceiver) continue;

          const args = node.arguments;
          if (!args || args.length === 0) continue;

          if (minTrackedHop(args[0]) !== null) {
            context.report({ node, messageId: 'noSourceGrep' });
          }
        }
      },
    };
  },
};

module.exports = rule;
