'use strict';

/**
 * no-source-grep
 *
 * Flags variables bound to readFileSync() of a .cjs/.cts/.js/.mjs/.mts/.ts
 * source path that later have a text-search method called on them, whether
 * directly, via a bounded chain of derived bindings (`const b = f(a)`,
 * `b = a`, ...), or via `regex.test(tracked)` / `/lit/.test(tracked)` /
 * `regex.exec(tracked)` / `/lit/.exec(tracked)` (#3464 phase 8).
 *
 * Variable identity is resolved through real lexical scope (ESLint
 * `Variable` objects via `sourceCode.scopeManager`/`getScope`), not by name
 * string, so a same-named binding in an unrelated or shadowing scope is
 * never conflated with a tracked one.
 *
 * Honor a SITE-SCOPED escape comment: // allow-test-rule: <reason> (#NNN)
 * A marker suppresses only the violation(s) it sits next to (same line, or
 * above with nothing but blank/comment lines between), not the whole file
 * (#3508 / epic #3464 phase 4). "Next to" is checked against EITHER half of
 * the read+search pair -- the text-search call site, or the readFileSync()
 * call that originated the tracked value -- so annotating the read directly
 * (the intuitive placement) suppresses the violation just as well as
 * annotating the search call (adversarial-review fix, epic #3464 phase 4).
 *
 * A `readFileSync(...)` path argument that is a bare Identifier is resolved
 * ONE hop back to its `VariableDeclarator` initializer before classification,
 * so a path built once and passed by reference is recognized the same as an
 * inline path expression; `hooks` is also a recognized source directory
 * alongside `bin`/`lib`/`gsd-core`/`src` (#3545 / epic #3464 phase 7).
 */

// How many derivation hops from the original readFileSync() binding to
// follow before giving up on a transitive chain. hop=1 is the variable
// bound directly to the readFileSync() result; hop=2 is a variable derived
// one step from it; etc. Depth-bounded on purpose (test-matrix.md rows
// 9-11): a chain longer than this is a documented, accepted blind spot, not
// a bug — see 40-design.md "Known limits".
const MAX_TRANSITIVE_HOPS = 3;

// How many source lines a `// allow-test-rule: <reason>` marker is allowed
// to sit above the violation it suppresses (0 = same line as the marker's
// own line, i.e. the line directly below it). The repo's real placement
// style is a marker followed by a short run of CONTINUATION PROSE (more
// `//` comment lines expanding on the reason) immediately before the flagged
// call -- observed spans across the 8 real #3508 violation sites run 0-4
// comment lines (e.g. the #3502 marker in tests/adr-index-gate.test.cjs, the
// #770 markers in tests/install-minimal-hooks.test.cjs). 8 gives that a
// comfortable margin without being effectively unbounded -- large enough to
// never force churn on a legitimately-placed marker, small enough that a
// marker meant for one call site cannot drift into covering an unrelated
// site 40+ lines later (test-matrix.md row 4, the defect this closes).
const MAX_MARKER_LOOKAHEAD_LINES = 8;

// Matches a `allow-test-rule: <reason>` directive inside a comment's VALUE
// (the AST comment node's text with delimiters stripped -- i.e. this is
// tested against `c.value`, never against raw source text). Exported so
// external consumers (scripts/lint-allow-test-rule-refs.cjs) that need to
// find marker comments via the SAME AST-comment definition the rule itself
// honors can import this instead of hand-rolling an equivalent pattern that
// could silently drift from what the rule actually recognizes.
const MARKER_COMMENT_RE = /allow-test-rule:\s*\S/;

/**
 * Given every comment in a file (`sourceCode.getAllComments()`), compute the
 * two line-level facts `isSuppressedAt` needs: which lines carry a
 * `allow-test-rule:` marker, and which lines are wholly comment (used for the
 * "nothing but blank/comment lines between the marker and the violation"
 * purity check). Extracted verbatim from the per-file computation `create()`
 * used to do inline, so a second consumer (the effective-exemption counter)
 * can derive the identical inputs without re-deriving the marker-detection
 * logic itself.
 *
 * @param {{value: string, loc: {start: {line:number}, end: {line:number}}}[]} allComments
 * @returns {{markerLines: number[], commentLineSet: Set<number>}}
 */
function collectMarkerAndCommentLines(allComments) {
  const markerLines = [];
  const commentLineSet = new Set();
  for (const c of allComments) {
    for (let l = c.loc.start.line; l <= c.loc.end.line; l++) {
      commentLineSet.add(l);
    }
    if (MARKER_COMMENT_RE.test(c.value)) {
      for (let l = c.loc.start.line; l <= c.loc.end.line; l++) {
        markerLines.push(l);
      }
    }
  }
  return { markerLines, commentLineSet };
}

/**
 * Site-scoped suppression predicate: is `violationLine` suppressed by any of
 * `markerLines`? Extracted verbatim from the logic `create()` used to close
 * over directly (previously named `isSuppressed`), generalized to take its
 * per-file inputs as parameters instead of reading them off closure state, so
 * a second consumer (scripts/lint-allow-test-rule-refs.cjs, the
 * effective-exemption counter) can call the EXACT SAME adjacency arithmetic
 * the rule uses at report time -- rather than reimplementing it, which is the
 * generative-fix-divergence defect class this repo has shipped before.
 *
 * A violation at `violationLine` is suppressed if some marker sits on that
 * exact line (trailing form) or on an earlier line within `maxLookahead`,
 * with every line strictly between the marker and the violation being blank
 * and/or itself a comment line -- i.e. no live code sits between the marker
 * and the call it suppresses. This is what makes suppression SITE-scoped
 * rather than file-wide.
 *
 * @param {object} opts
 * @param {number[]} opts.markerLines - line numbers carrying a marker.
 * @param {number} opts.violationLine - the candidate violation's line.
 * @param {Set<number>} opts.commentLineSet - lines wholly occupied by a comment.
 * @param {string[]} opts.lines - the file's source lines (sourceCode.lines).
 * @param {number} [opts.maxLookahead] - defaults to MAX_MARKER_LOOKAHEAD_LINES.
 * @returns {boolean}
 */
function isSuppressedAt({
  markerLines,
  violationLine,
  commentLineSet,
  lines,
  maxLookahead = MAX_MARKER_LOOKAHEAD_LINES,
}) {
  function isBlankLine(line) {
    const text = lines[line - 1];
    return text !== undefined && text.trim() === '';
  }
  for (const markerLine of markerLines) {
    if (markerLine > violationLine) continue;
    if (violationLine - markerLine > maxLookahead) continue;
    let pure = true;
    for (let l = markerLine + 1; l < violationLine; l++) {
      if (!isBlankLine(l) && !commentLineSet.has(l)) {
        pure = false;
        break;
      }
    }
    if (pure) return true;
  }
  return false;
}

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
    // `neutralizeSuppression` is a diagnostic-only knob for
    // scripts/lint-allow-test-rule-refs.cjs (the effective-exemption
    // counter): when true, every candidate violation is reported regardless
    // of a marker, so the script can enumerate the FULL site inventory via
    // one real ESLint pass, then classify each site with isSuppressedAt
    // (exported below) against the real markers. No config in this repo
    // passes this option, so default (real) linting is unaffected -- this is
    // an extract-and-export refactor of existing logic, not a behavior
    // change to `no-source-grep` itself.
    schema: [
      {
        type: 'object',
        properties: {
          neutralizeSuppression: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noSourceGrep:
        'Source-grep test: do not read source .cjs/.cts/.js/.mjs/.mts/.ts files with readFileSync and call .includes/.match/.matchAll/.startsWith/.indexOf/.split/.replace/.search (or regex.test() / regex.exec()) on the result. Use require() to run the module instead. Add // allow-test-rule: <reason> (#NNN) directly above (or trailing) the flagged line to suppress just that site.',
      // Diagnostic-only companion to `noSourceGrep`, emitted ONLY when the
      // `neutralizeSuppression` schema option is set (see its doc comment
      // and `reportUnlessSuppressed` above) -- never fires with the real
      // (shipped) config, so this never appears in real lint output.
      noSourceGrepDiagnosticReadLine: '{{readLine}}',
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode;

    // All comments in the file (used both to find markers and to know which
    // lines are "just a comment" for the lookahead purity check below).
    const allComments = sourceCode.getAllComments();

    // Line numbers of every `// allow-test-rule: <reason>` marker comment in
    // the file (a marker may span one line or several -- see
    // collectMarkerAndCommentLines' doc comment above), and the set of lines
    // fully occupied by ANY comment (used by isSuppressedAt's purity check).
    const { markerLines, commentLineSet } = collectMarkerAndCommentLines(allComments);

    // Diagnostic-only: see the `neutralizeSuppression` schema option doc
    // comment above. Never true for any config in this repo.
    const neutralizeSuppression = !!(
      context.options &&
      context.options[0] &&
      context.options[0].neutralizeSuppression
    );

    // A violation at `violationLine` is suppressed if some marker sits on
    // that exact line (trailing form) or on an earlier line within
    // MAX_MARKER_LOOKAHEAD_LINES, with every line strictly between the
    // marker and the violation being blank and/or itself a comment line --
    // i.e. no live code (not even the readFileSync() call the marker is
    // ostensibly about) sits between the marker and the call it suppresses.
    // This is what makes suppression SITE-scoped rather than file-wide: a
    // marker parked far above an unrelated later violation (test-matrix.md
    // row 4) no longer reaches it. Delegates to the exported isSuppressedAt
    // predicate (see its doc comment) rather than duplicating the adjacency
    // arithmetic here.
    function isSuppressed(violationLine) {
      if (neutralizeSuppression) return false;
      return isSuppressedAt({
        markerLines,
        violationLine,
        commentLineSet,
        lines: sourceCode.lines,
      });
    }

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

    // WIDENING (fold, #3545/epic #3464 phase 7): resolve a bare Identifier
    // path argument back to its variable initializer, ONE hop, before
    // text-matching it -- so `const p = path.join(__dirname, '..', 'src',
    // 'x.cjs'); readFileSync(p)` is classified the same as an inline
    // `readFileSync(path.join(__dirname, '..', 'src', 'x.cjs'))`. Only
    // resolves a `VariableDeclarator`'s `init` (not an `AssignmentExpression`
    // — an assignment-bound identifier is a documented, deliberate miss, see
    // 40-design.md "Known limits"), and only ONE hop (a chain of two or more
    // indirections stays invisible -- also documented).
    function resolveOneHopText(node) {
      if (node.type !== 'Identifier') return sourceCode.getText(node);
      const v = resolveVariable(node);
      if (!v) return sourceCode.getText(node);
      const def = v.defs.find((d) => d.type === 'Variable' && d.node && d.node.init);
      if (!def) return sourceCode.getText(node);
      return sourceCode.getText(def.node.init);
    }

    // Detect if a node represents a readFileSync call on a source file
    // (.cjs/.cts/.js/.mjs/.mts/.ts) that lives in a source directory
    // (bin, lib, gsd-core, hooks, src).
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
      const fullSrc = resolveOneHopText(firstArg);

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

      // Must reference a source directory indicator somewhere in the
      // expression (bin, lib, gsd-core, hooks, src).
      const hasSourceDir = /['"](?:bin|lib|gsd-core|hooks|src)['"]/i.test(src);
      return hasSourceDir;
    }

    // Variable -> hop number. hop=1 is a variable bound directly to a
    // source readFileSync() result; each additional derivation hop
    // increments by 1, capped at MAX_TRANSITIVE_HOPS.
    const hopOf = new Map();

    // Variable -> line number of the readFileSync() call that originated the
    // value tracked at that variable (same line as the hop=1 seed for a
    // direct binding; propagated unchanged through every derivation hop,
    // since a transitive chain is still fundamentally about the SAME
    // original read+search pair). Populated in lockstep with hopOf below so
    // a report can consult "where was this text actually read from" and
    // honor a marker placed at either half of the pair (adversarial-review
    // fix: marker adjacent to the read alone must suppress too, not just a
    // marker adjacent to the search call).
    const readLineOf = new Map();

    // Generic conservative fallback: walk every Identifier under `node` and
    // return the {hop, line} of the identifier with the smallest hop number
    // among identifiers that resolve to an already-tracked variable, or null
    // if none do. This is the DEFAULT for any expression shape not
    // explicitly recognized below (arguments to an unknown function call,
    // logical expressions, etc.) -- for an unrecognized shape we choose to
    // PROPAGATE (risking a rarer false positive) rather than silently drop a
    // true positive, because the callee/operator may still be returning text
    // derived from the tracked value. Clearly-scalar shapes (member access,
    // comparisons, numeric/boolean methods, Number()/parseInt()/etc.) are
    // special-cased below to explicitly NOT propagate instead, since for
    // those we know for certain the result cannot carry text.
    function walkForTrackedInfo(node) {
      let best = null;
      (function walk(n) {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'Identifier') {
          const v = resolveVariable(n);
          if (v && hopOf.has(v)) {
            const h = hopOf.get(v);
            if (best === null || h < best.hop) {
              best = { hop: h, line: readLineOf.get(v) };
            }
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
      return best;
    }

    // Determine whether tracking should propagate through `node`'s value
    // into whatever it is assigned/bound to, and if so, at what (minimum)
    // hop -- and from which original read line -- it draws from. Returns
    // null when the value shape is one we know for certain cannot still
    // carry the tracked file's text.
    function trackedInfo(node) {
      if (!node || typeof node.type !== 'string') return null;

      switch (node.type) {
        case 'Identifier': {
          // Identity: `const b = a;`
          const v = resolveVariable(node);
          return v && hopOf.has(v)
            ? { hop: hopOf.get(v), line: readLineOf.get(v) }
            : null;
        }

        case 'AwaitExpression':
          return trackedInfo(node.argument);

        case 'ConditionalExpression': {
          // `cond ? a : other` -- only the branches can carry the tracked
          // value; the test itself is a boolean and does not propagate.
          const c = trackedInfo(node.consequent);
          const a = trackedInfo(node.alternate);
          if (c === null) return a;
          if (a === null) return c;
          return c.hop <= a.hop ? c : a;
        }

        case 'TemplateLiteral': {
          // `` `${a}` `` -- a template embedding a tracked value still
          // carries its text.
          let best = null;
          for (const expr of node.expressions) {
            const info = trackedInfo(expr);
            if (info !== null && (best === null || info.hop < best.hop)) {
              best = info;
            }
          }
          return best;
        }

        case 'BinaryExpression': {
          // String concatenation (`a + 'x'` / `'x' + a`) may still carry
          // text; every OTHER binary operator (===, !==, ==, !=, <, >, <=,
          // >=, arithmetic, etc.) produces a boolean/number and must not
          // propagate.
          if (node.operator !== '+') return null;
          const l = trackedInfo(node.left);
          const r = trackedInfo(node.right);
          if (l === null) return r;
          if (r === null) return l;
          return l.hop <= r.hop ? l : r;
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
            const objInfo = trackedInfo(callee.object);
            if (objInfo !== null) {
              const propName = callee.property.name;
              if (NON_PROPAGATING_METHODS.has(propName)) return null;
              if (PROPAGATING_STRING_METHODS.has(propName)) return objInfo;
              // Unrecognized method name on a known-tracked receiver:
              // conservative default for an unrecognized call result (see
              // fallback rationale above) -- propagate rather than risk
              // silently dropping a true positive.
              return objInfo;
            }
          }

          // Not a recognized narrowing/receiver call shape: fall through
          // to the generic conservative walk (covers "tracked value passed
          // as an argument to any call", e.g. `const b = strip(a);`).
          return walkForTrackedInfo(node);
        }

        default:
          // Any other expression shape (LogicalExpression, parenthesized
          // expressions -- which are not a distinct AST node -- etc.):
          // conservative default, see walkForTrackedInfo doc comment.
          return walkForTrackedInfo(node);
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
        } else if (propName === 'exec') {
          pendingCalls.push({ node, kind: 'execCall' });
        }
      },
      'Program:exit'() {
        // Seed hop=1 for variables bound directly to a source readFileSync(),
        // recording the readFileSync() call's own line as the "origin read
        // line" for that variable.
        for (const { id, init } of pendingDeclarators) {
          if (isSourceReadFileSync(init)) {
            const v = resolveVariable(id);
            if (v && !hopOf.has(v)) {
              hopOf.set(v, 1);
              readLineOf.set(v, init.loc.start.line);
            }
          }
        }
        for (const { left, right } of pendingAssignments) {
          if (isSourceReadFileSync(right)) {
            const v = resolveVariable(left);
            if (v && !hopOf.has(v)) {
              hopOf.set(v, 1);
              readLineOf.set(v, right.loc.start.line);
            }
          }
        }

        // Fixpoint over derived bindings, bounded by MAX_TRANSITIVE_HOPS.
        // Each variable is added at most once, so this always terminates.
        // The origin read line is carried through unchanged from whichever
        // parent variable the hop was derived from -- a transitive chain is
        // still fundamentally about the same original read+search pair.
        let changed = true;
        while (changed) {
          changed = false;
          for (const { id, init } of pendingDeclarators) {
            const v = resolveVariable(id);
            if (!v || hopOf.has(v)) continue;
            const parentInfo = trackedInfo(init);
            if (parentInfo !== null && parentInfo.hop + 1 <= MAX_TRANSITIVE_HOPS) {
              hopOf.set(v, parentInfo.hop + 1);
              readLineOf.set(v, parentInfo.line);
              changed = true;
            }
          }
          for (const { left, right } of pendingAssignments) {
            const v = resolveVariable(left);
            if (!v || hopOf.has(v)) continue;
            const parentInfo = trackedInfo(right);
            if (parentInfo !== null && parentInfo.hop + 1 <= MAX_TRANSITIVE_HOPS) {
              hopOf.set(v, parentInfo.hop + 1);
              readLineOf.set(v, parentInfo.line);
              changed = true;
            }
          }
        }

        // Report a violation at `node` unless a marker's site-scoped
        // suppression (see isSuppressed above) covers either the search
        // call's own line OR the line of the readFileSync() call that
        // originated the tracked value (adversarial-review fix: the
        // violation is fundamentally about the read+search PAIR, so a
        // marker adjacent to either half is a legitimate, still strictly
        // site-scoped, way to annotate it). `readLine` is optional -- pass
        // it whenever the call site can determine one.
        function reportUnlessSuppressed(node, readLine) {
          if (neutralizeSuppression) {
            // Diagnostic-only mode (see the `neutralizeSuppression` schema
            // option doc comment): report every candidate site regardless of
            // suppression, PLUS a paired companion message at the exact same
            // node carrying `readLine` -- the other half of the read+search
            // pair that the real (non-neutralized) suppression check above
            // also consults. This lets a consumer (the effective-exemption
            // counter) replicate this rule's own OR-of-two-lines suppression
            // decision from the OUTSIDE via `isSuppressedAt` without this
            // rule re-exposing its internal hop/scope-resolution machinery.
            // Never fires with the real (shipped) config.
            context.report({ node, messageId: 'noSourceGrep' });
            context.report({
              node,
              messageId: 'noSourceGrepDiagnosticReadLine',
              data: { readLine: readLine === undefined || readLine === null ? '' : String(readLine) },
            });
            return;
          }
          if (isSuppressed(node.loc.start.line)) return;
          if (readLine !== undefined && readLine !== null && isSuppressed(readLine)) {
            return;
          }
          context.report({ node, messageId: 'noSourceGrep' });
        }

        // Now that hopOf is stable, evaluate every candidate call site.
        for (const { node, kind } of pendingCalls) {
          const obj = node.callee.object;

          if (kind === 'textMethod') {
            // varName.includes(...), varName.match(...), etc.
            if (obj.type === 'Identifier') {
              const v = resolveVariable(obj);
              if (v && hopOf.has(v)) {
                reportUnlessSuppressed(node, readLineOf.get(v));
                continue;
              }
            }
            // Inline: readFileSync(...).includes(...) -- read and search are
            // the same line, so no separate read line to pass.
            if (isSourceReadFileSync(obj)) {
              reportUnlessSuppressed(node);
            }
            continue;
          }

          // kind === 'regexTest' / 'execCall': re.test(tracked) or
          // /lit/.test(tracked), and identically re.exec(tracked) or
          // /lit/.exec(tracked) (#3464 phase 8) -- both return a
          // regex-shaped result, but what matters here is only that the
          // ARGUMENT (not the callee object) may carry the tracked source
          // text, so the receiver/argument classification is shared
          // byte-for-byte between the two kinds.
          const looksLikeRegexReceiver =
            obj.type === 'Identifier' || (obj.type === 'Literal' && !!obj.regex);
          if (!looksLikeRegexReceiver) continue;

          const args = node.arguments;
          if (!args || args.length === 0) continue;

          const argInfo = trackedInfo(args[0]);
          if (argInfo !== null) {
            reportUnlessSuppressed(node, argInfo.line);
          }
        }
      },
    };
  },
};

module.exports = rule;
// Named exports consumed by scripts/lint-allow-test-rule-refs.cjs (the
// effective-exemption counter) and its tests -- ESLint itself only reads
// `.create`/`.meta` off this module, so these extra properties are inert to
// ESLint and exist purely as the single source of truth for anything that
// needs to reason about marker suppression outside the rule's own
// Program:exit walk. See each function's doc comment above for why this
// extraction exists (generative-fix-divergence prevention).
module.exports.MAX_MARKER_LOOKAHEAD_LINES = MAX_MARKER_LOOKAHEAD_LINES;
module.exports.MARKER_COMMENT_RE = MARKER_COMMENT_RE;
module.exports.collectMarkerAndCommentLines = collectMarkerAndCommentLines;
module.exports.isSuppressedAt = isSuppressedAt;
