#!/usr/bin/env node
'use strict';

/**
 * Registry-completeness guard for the `.planning/`-root artifact registry
 * (epic #3180, ADR-3180 §8.4 deliverable C, Phase 12 #3310).
 *
 * `src/artifacts.cts`'s `isCanonicalPlanningFile` enumerates every file name
 * gsd workflows officially write at the `.planning/` ROOT (used today by
 * `validate.health`'s W019 to flag unrecognized files). Nothing previously
 * checked the OTHER direction: that every actual writer of a `.planning/`
 * root file is itself represented in that registry. This guard closes that
 * gap statically — it does not run any code, it scans `src/*.cts` for a
 * write whose target file name can be determined AT READ TIME and checks
 * that name against the real (compiled) `isCanonicalPlanningFile`.
 *
 * ## What counts as a checkable write
 *
 * A call to `platformWriteSync(` or `fs.writeFileSync(` whose first argument
 * resolves — through same-file, single-hop static tracing only — to a
 * LITERAL `.md`/`.json` file name joined onto an UNAMBIGUOUS `.planning/`
 * root expression. Three source shapes are recognized, all real patterns
 * found in this codebase (`src/roadmap.cts`, `src/state.cts`,
 * `src/config.cts`, `src/milestone.cts`, `src/health-diagnostic.cts`):
 *
 *   1. `path.join(<ROOT>, 'Literal.md')` — inline, or assigned first to a
 *      `const`/`let` binding or an object-literal property
 *      (`key: path.join(<ROOT>, 'Literal.md')`) that is later passed to the
 *      write call by name. Object-literal properties are traced by NAME
 *      only (no cross-function data-flow) — this matches the actual
 *      `RepairPaths`-style convention this repo already uses
 *      (`src/health-diagnostic.cts:209-218`), where a destructured
 *      parameter reuses the same identifier the property was defined with.
 *   2. `planningPaths(cwd).<prop>` for `<prop>` in `state`, `roadmap`,
 *      `project`, `config`, `requirements` — the `PlanningPaths` interface's
 *      own file-valued properties (`src/planning-workspace.cts`), which are
 *      already a full path, not a directory to join further.
 *   3. A `<ROOT>` in both forms above means EXACTLY `planningRoot(cwd)`,
 *      `planningDir(cwd)` (no second argument), or `planningPaths(cwd)`
 *      (no second argument) `.planning` — deliberately excluding any call
 *      that passes a workstream/project argument (`planningDir(cwd, ws)`),
 *      because that form can resolve UNDER `.planning/workstreams/<ws>/`
 *      instead of the `.planning/` root, and this guard cannot tell
 *      statically whether `ws` is truthy at runtime. Per this guard's own
 *      design brief: "false negatives are safer than false positives" — an
 *      ambiguous root expression is silently skipped, never reported either
 *      way.
 *
 * Anything else — a template-literal or otherwise runtime-computed target,
 * a multi-segment join landing under `phases/`, `milestones/`, or
 * `workstreams/`, a path built through an intermediate helper this guard
 * does not recognize (e.g. `path.dirname(x)`, a ternary, a `.gsd/`
 * fallback) — is silently skipped. This guard reports VIOLATIONS only; a
 * skipped write is never counted as a pass either. See the module docblock
 * above `src/artifacts.cts` for the registry's own stated scope
 * (".planning/ root level" only) — this guard shares that scope.
 *
 * ## Caveat: same-file, name-based tracing (not a real data-flow analysis)
 *
 * Both the `const`/`let` and object-literal-property forms are tracked in a
 * single flat, WHOLE-FILE, name -> file-name map (no per-function scoping).
 * If the same identifier were reused in one file for two unrelated purposes
 * — one a real `.planning/`-root join, the other something else entirely —
 * this guard could mis-resolve the second one. No such collision exists in
 * `src/*.cts` today (verified during implementation); this is a known,
 * accepted heuristic limit, matching this guard's explicitly simpler
 * (non-function-scoped) design versus its sibling
 * `lint-planning-snapshot-bypass-drift.cjs`.
 *
 * ## No ratchet / no baseline
 *
 * Unlike its `lint-*-drift.cjs` siblings, this is a bare pass/fail check,
 * not a shrinking-debt baseline: a ground-truth sweep of this codebase
 * found every real `.planning/`-root writer already registered, so there is
 * no inherited debt to grandfather. Any violation this guard reports is a
 * genuine, actionable regression.
 *
 * Tree-walk / root-confinement / symlink / sanitizer machinery is shared
 * via `scripts/lib/drift-scan.cjs`, exactly like every sibling guard.
 */

const fs = require('node:fs');
const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { sanitizeForReport, scanTree } = driftScan;

const REPO_ROOT = path.join(__dirname, '..');
const COMPILED_MODULE_REL = path.join('gsd-core', 'bin', 'lib', 'artifacts.cjs');
const COMPILED_MODULE_PATH = path.join(REPO_ROOT, COMPILED_MODULE_REL);

// Authored TypeScript source only — mirrors every sibling drift guard.
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts']);

// `PlanningPaths` (src/planning-workspace.cts) properties that are
// themselves a FULL FILE path (not a directory) at the `.planning/` root,
// mapped to the literal file name they resolve to. `planning`/`phases`/
// `debug` are deliberately absent — those are directories, not files.
const PLANNING_PATHS_FILE_PROPS = new Map([
  ['state', 'STATE.md'],
  ['roadmap', 'ROADMAP.md'],
  ['project', 'PROJECT.md'],
  ['config', 'config.json'],
  ['requirements', 'REQUIREMENTS.md'],
]);

// The three unambiguous `.planning/`-root expressions this guard recognizes
// as the first argument of `path.join(...)`. Each takes ONLY `cwd` — a call
// carrying a workstream/project argument is excluded (see module docblock).
const ROOT_CALL_SRC = String.raw`planningRoot\(cwd\)|planningDir\(cwd\)|planningPaths\(cwd\)\.planning`;

// A quoted literal file name ending in `.md` or `.json` — single-quoted or
// double-quoted, as two separate alternatives (groups: single-quoted
// filename, double-quoted filename) rather than a `(['"])...\1`
// backreference: this fragment is spliced into several different larger
// regexes below at different capture-group OFFSETS, so a fixed
// backreference number (`\1`) would silently point at whichever group
// happens to be first in THAT particular composed regex, not necessarily
// this fragment's own quote group. Every call site reads
// `matched[i] ?? matched[i + 1]` for the two alternative filename groups
// this fragment always contributes, in order. Deliberately excludes
// backticks: a template literal is a runtime-computed target by definition
// and must never match here.
const LITERAL_FILENAME_SRC = String.raw`(?:'([^'\\]+\.(?:md|json))'|"([^"\\]+\.(?:md|json))")`;

// `const X = <ROOT>;` / `let X = <ROOT>;` — binds X to an unambiguous root
// expression, so a later `path.join(X, 'Literal.md')` can resolve through
// it (mirrors `src/config.cts`'s `planningBase` / `src/health-diagnostic
// .cts`'s `rootBase`/`wsBase`).
const ROOT_VAR_ASSIGN_RE = new RegExp(String.raw`\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:${ROOT_CALL_SRC})\s*;`);

// A "binding" — either `const X = ...` / `let X = ...`, or an object-literal
// property `X: ...` — shared by both join-tracing regexes below so a
// destructured-later property (the `RepairPaths` convention) traces the
// same way a local variable does. Group 1 is the const/let name, group 2 is
// the property name; callers use whichever is non-undefined.
const BINDING_PREFIX_SRC = String.raw`(?:(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=|([A-Za-z_$][\w$]*)\s*:)`;

// `<binding> = path.join(<ROOT>, 'Literal.md')` — the root expression is
// spelled out inline (not through an intermediate variable).
const JOIN_FROM_ROOT_CALL_RE = new RegExp(
  String.raw`${BINDING_PREFIX_SRC}\s*path\.join\(\s*(?:${ROOT_CALL_SRC})\s*,\s*${LITERAL_FILENAME_SRC}\s*\)`,
);

// `<binding> = path.join(IDENT, 'Literal.md')` — the root expression was
// already bound to IDENT by ROOT_VAR_ASSIGN_RE elsewhere in the file.
const JOIN_FROM_IDENT_RE = new RegExp(
  String.raw`${BINDING_PREFIX_SRC}\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,\s*${LITERAL_FILENAME_SRC}\s*\)`,
);

// `<binding> = planningPaths(cwd).<prop>` — PLANNING_PATHS_FILE_PROPS below
// maps <prop> to its file name.
const PLANNING_PATHS_PROP_RE = new RegExp(
  String.raw`${BINDING_PREFIX_SRC}\s*planningPaths\(cwd\)\.([A-Za-z_$][\w$]*)\b`,
);

// The write calls this guard checks the first argument of.
const WRITE_CALL_RE = /\b(?:platformWriteSync|fs\.writeFileSync)\(/g;

// A bare identifier, or an inline `path.join(<ROOT>, 'Literal.md')` /
// `planningPaths(cwd).<prop>` expression, as the resolved first-argument
// text of a write call.
const INLINE_JOIN_ROOT_RE = new RegExp(String.raw`^path\.join\(\s*(?:${ROOT_CALL_SRC})\s*,\s*${LITERAL_FILENAME_SRC}\s*\)$`);
const INLINE_PLANNING_PATHS_PROP_RE = /^planningPaths\(cwd\)\.([A-Za-z_$][\w$]*)$/;
const BARE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Strip `//` line comments and `/* ... *\/` block comments from `line`,
 * preserving the CONTENTS of single/double/backtick-quoted strings verbatim
 * (so a filename literal or an identifier that happens to sit inside a
 * string is never mistaken for code, but a `//`/`/*` inside a string never
 * truncates the line either). No cross-line state: a template literal or
 * block comment that spans multiple lines is left as-is on each line it
 * touches — every real call/assignment this guard matches is single-line in
 * `src/*.cts` today, so cross-line tracking would add complexity with no
 * observed benefit (see this guard's "simpler than its sibling" design
 * note).
 */
function stripLineComment(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close === -1) { i = line.length; break; }
      i = close + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === quote) { j++; break; }
        j++;
      }
      out += line.slice(start, j);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Scan forward from `openParenIdx` (the index of a call's opening `(`) and
 * return the TEXT of its first argument — up to the first top-level comma,
 * or the call's own closing paren if it has only one argument — respecting
 * nested parens and quoted strings so an inner `path.join(a, 'b.md')`
 * comma never terminates early. Returns null if the call does not close on
 * this line (a genuinely multi-line call is out of this guard's scope — see
 * module docblock).
 */
function extractFirstArg(line, openParenIdx) {
  let depth = 1;
  let i = openParenIdx + 1;
  const start = i;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') {
      if (depth === 1) return line.slice(start, i).trim();
      depth--; i++; continue;
    }
    if (ch === ',' && depth === 1) return line.slice(start, i).trim();
    i++;
  }
  return null; // unterminated on this line — skip (see docblock)
}

/**
 * Pure: scan `text` (one `src/*.cts` file's contents) for every write call
 * this guard can statically resolve to a literal `.planning/`-root file
 * name. Returns EVERY resolved candidate (canonical or not) — filtering to
 * violations only happens in `findArtifactWriterDrift` — so tests and
 * callers can tell "not checked" (candidate absent) apart from "checked and
 * passed" (candidate present, canonical).
 */
function scanFileForCandidates(text, relPath) {
  const file = relPath.replace(/\\/g, '/');
  const originalLines = text.split('\n');
  const lines = originalLines.map(stripLineComment);

  // Pass 1: build the whole-file name -> file-name maps (see module
  // docblock for the "flat, same-file, name-based" tracing this performs).
  const rootVars = new Set();
  const filenameVars = new Map();
  for (const line of lines) {
    const rootMatch = ROOT_VAR_ASSIGN_RE.exec(line);
    if (rootMatch) rootVars.add(rootMatch[1]);
  }
  for (const line of lines) {
    const m1 = JOIN_FROM_ROOT_CALL_RE.exec(line);
    if (m1) {
      const name = m1[1] || m1[2];
      filenameVars.set(name, m1[3] || m1[4]);
      continue;
    }
    const propMatch = PLANNING_PATHS_PROP_RE.exec(line);
    if (propMatch) {
      const name = propMatch[1] || propMatch[2];
      const prop = propMatch[3];
      if (PLANNING_PATHS_FILE_PROPS.has(prop)) filenameVars.set(name, PLANNING_PATHS_FILE_PROPS.get(prop));
      continue;
    }
    const m2 = JOIN_FROM_IDENT_RE.exec(line);
    if (m2) {
      const name = m2[1] || m2[2];
      const sourceIdent = m2[3];
      if (rootVars.has(sourceIdent)) filenameVars.set(name, m2[4] || m2[5]);
    }
  }

  // Pass 2: resolve every write call's first argument.
  const out = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    WRITE_CALL_RE.lastIndex = 0;
    let callMatch;
    while ((callMatch = WRITE_CALL_RE.exec(line)) !== null) {
      const openParenIdx = callMatch.index + callMatch[0].length - 1;
      const argText = extractFirstArg(line, openParenIdx);
      if (argText === null) continue;

      let filename = null;
      if (BARE_IDENT_RE.test(argText)) {
        if (filenameVars.has(argText)) filename = filenameVars.get(argText);
      } else {
        const inlineJoin = INLINE_JOIN_ROOT_RE.exec(argText);
        if (inlineJoin) {
          filename = inlineJoin[1] || inlineJoin[2];
        } else {
          const inlineProp = INLINE_PLANNING_PATHS_PROP_RE.exec(argText);
          if (inlineProp && PLANNING_PATHS_FILE_PROPS.has(inlineProp[1])) filename = PLANNING_PATHS_FILE_PROPS.get(inlineProp[1]);
        }
      }

      if (filename !== null) {
        out.push({ file, line: li + 1, filename, text: originalLines[li].trim() });
      }
    }
  }
  return out;
}

/**
 * Pure: `scanFileForCandidates` filtered to violations — a resolved
 * candidate whose file name `isCanonicalPlanningFile` rejects.
 * `isCanonical` defaults to the REAL, compiled function (loaded lazily so a
 * missing `npm run build:lib` only errors when this guard actually runs,
 * not merely on `require`) but is overridable for tests that want to
 * exercise the filter without a build.
 */
function findArtifactWriterDrift(text, relPath, isCanonical) {
  const check = isCanonical || loadIsCanonicalPlanningFile();
  return scanFileForCandidates(text, relPath).filter((c) => !check(c.filename));
}

let _isCanonicalPlanningFile = null;
function loadIsCanonicalPlanningFile() {
  if (_isCanonicalPlanningFile) return _isCanonicalPlanningFile;
  if (!fs.existsSync(COMPILED_MODULE_PATH)) {
    throw new Error(
      `lint-planning-artifact-writer-drift: compiled artifact not found at ${COMPILED_MODULE_REL}.\n` +
      'Run `npm run build:lib` first.',
    );
  }
  const mod = require(COMPILED_MODULE_PATH);
  if (typeof mod.isCanonicalPlanningFile !== 'function') {
    throw new Error(`lint-planning-artifact-writer-drift: ${COMPILED_MODULE_REL} does not export isCanonicalPlanningFile()`);
  }
  _isCanonicalPlanningFile = mod.isCanonicalPlanningFile;
  return _isCanonicalPlanningFile;
}

/** Scan the authored source tree and return every writer-registry violation. */
function scanRepo(root) {
  const isCanonical = loadIsCanonicalPlanningFile();
  return scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      return findArtifactWriterDrift(text, rel, isCanonical);
    },
  });
}

function main() {
  const violations = scanRepo(REPO_ROOT);

  if (violations.length === 0) {
    process.stdout.write('ok planning-artifact-writer: every statically-resolvable .planning/-root write is a registered canonical artifact\n');
    return;
  }

  process.stderr.write('planning-artifact-writer: unregistered .planning/-root artifact write(s) found.\n');
  process.stderr.write('Every write of a literal .planning/-root file name must be reflected in the registry\n');
  process.stderr.write("(src/artifacts.cts's isCanonicalPlanningFile, consumed by validate.health's W019):\n");
  for (const v of violations) {
    process.stderr.write(
      `  ${sanitizeForReport(v.file)}:${v.line}  '${sanitizeForReport(v.filename)}'  ${sanitizeForReport(v.text)}\n` +
      `    remedy: add '${sanitizeForReport(v.filename)}' to CANONICAL_EXACT in src/artifacts.cts, ` +
      'or a CANONICAL_PATTERNS regex if it is version-stamped\n',
    );
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  scanFileForCandidates,
  findArtifactWriterDrift,
  scanRepo,
  stripLineComment,
  extractFirstArg,
  PLANNING_PATHS_FILE_PROPS,
  SCAN_DIRS,
  SCAN_EXT,
  COMPILED_MODULE_PATH,
  COMPILED_MODULE_REL,
};
