#!/usr/bin/env node
'use strict';

/**
 * lint-hooks-runtime-build-seam.cjs — every `hooks/**` file that requires a
 * compiled runtime-library module (`gsd-core/bin/lib/*.cjs`) must also go
 * through the self-healing build seam (`gsd-core/bin/ensure-runtime-build.cjs`,
 * #2002) before that require can be reached (#3582).
 *
 * ## Why
 *
 * `gsd-core/bin/lib/*.cjs` are compiled from `src/*.cts` by `npm run
 * build:lib` (ADR-457, "build-at-publish") and are gitignored. The npm
 * package builds before publishing, so the artifacts exist on that path.
 * `gsd-core/bin/gsd-tools.cjs` calls `ensureRuntimeBuild()` before requiring
 * its own `./lib` — but a plugin-marketplace / git-clone install that never
 * runs `npm run build:lib` materializes the raw tree with the compiled
 * `./lib` absent, and NO hook self-healed before this issue. A hook that
 * requires a compiled module directly dies at module load (or first call)
 * with `Cannot find module`, and — in a guard whose own catch treats "cannot
 * resolve" as fail-closed — that `Cannot find module` gets misreported as an
 * unrelated "could not read or resolve …configuration" denial instead of the
 * seam's own actionable message (#3050 lesson: a guard that cannot verify
 * must not silently misreport why).
 *
 * ## What this enforces
 *
 * For every `.js`/`.cjs` file under `hooks/` (excluding the generated
 * `hooks/dist/` build-output copy, which is not source): if the file's code
 * (comments stripped) contains a `require(...)` of a path that names
 * `gsd-core/bin/lib/<name>.cjs` (any relative-path spelling — `../gsd-core/…`,
 * `../../gsd-core/…`, etc. — the segment `gsd-core/bin/lib/` plus a trailing
 * `.cjs` is the discriminator, not the exact prefix), the SAME file must ALSO
 * contain BOTH:
 *   1. a `require(...)` of a path naming `gsd-core/bin/ensure-runtime-build.cjs`
 *      (the seam module itself), AND
 *   2. an actual INVOCATION `ensureRuntimeBuild(` — not merely a destructuring
 *      import with no call, which would import the seam but never run it.
 *
 * File-level co-occurrence, not line-by-line ordering: this repo's hooks
 * define helper functions in whatever order reads best and call them in a
 * different order at runtime (e.g. `hooks/gsd-cursor-subagent-start.js`'s
 * `resolveFallbackIsolation` is defined textually ABOVE the single
 * `ensureRuntimeBuild()` call site in `evaluateRootIsolation`, which is its
 * only caller) — a strict "seam call must appear on an earlier LINE than the
 * require" check would false-positive on exactly that, real, correct
 * pattern. This guard is therefore a drift ratchet at the file level ("did
 * the seam get wired in at all"), not a full control-flow verifier; exact
 * placement (does the call precede every reaching path) is a code-review
 * concern, same tradeoff every other structural drift guard in this repo
 * makes (see e.g. `lint-unreachable-guard-drift.cjs`'s own per-line, not
 * per-flow, scope).
 *
 * ## What PASSES
 *
 * - A hook that never requires `gsd-core/bin/lib/*.cjs` at all (most of
 *   `hooks/`) — nothing to check.
 * - A hook that requires a compiled module AND requires + calls
 *   `ensureRuntimeBuild()` somewhere in the same file.
 * - A prose comment that mentions `gsd-core/bin/lib/…` without a real,
 *   well-formed `require('....cjs')` call (comments are stripped before
 *   scanning).
 *
 * ## What FAILS
 *
 * - A hook that requires a compiled `gsd-core/bin/lib/*.cjs` module but never
 *   requires `ensure-runtime-build.cjs`, or requires it but never calls
 *   `ensureRuntimeBuild(...)`.
 *
 * ## Known limitations (documented, not defects — read before trusting a green run)
 *
 * - **Literal-string matching only.** `REQUIRE_RE` matches `require(...)`
 *   called with a single- OR double-quoted string literal argument. A
 *   concatenated/computed path (`require(base + '/gsd-core/bin/lib/x.cjs')`),
 *   a template literal (`` require(`${dir}/x.cjs`) ``), or `createRequire(...)`
 *   / `require.resolve` used indirectly all evade `isCompiledLibRequire` and
 *   `isSeamRequire` — none of them appear as a literal quoted `require(...)`
 *   call, so a file using one of these forms scans as "requires nothing",
 *   even if it genuinely needs the seam.
 * - **`hooks/` only.** `scanRepo`'s `walk()` only descends `SCAN_ROOT`
 *   (`hooks/`, minus `hooks/dist/`). A compiled `gsd-core/bin/lib/*.cjs`
 *   require sitting inside a NON-hooks helper module that a hook file then
 *   requires (directly or transitively) is invisible to this scan — the scan
 *   only ever reads the hook file's OWN text, never follows its require
 *   graph. Deliberate: this is a same-file drift ratchet ("did the hook wire
 *   the seam in at all"), not a whole-program static analyzer.
 *
 * Because of both limits, a file that passes this lint is not a
 * correctness proof — it is a co-occurrence heuristic that catches the
 * exact regression shape #3582 fixed (a bare literal compiled-lib require
 * with no seam call anywhere in the same hook file). Anything routed around
 * a literal require or around `hooks/` needs a code-review check, not this
 * script, to catch a missing self-heal.
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');
const SCAN_ROOT = 'hooks';
const SCAN_EXT = new Set(['.js', '.cjs']);
// hooks/dist/ is a generated build-output copy (scripts/build-hooks.js),
// gitignored and not source — never scanned.
const EXCLUDE_DIR_NAMES = new Set(['dist']);

// Line-based comment stripper (deliberately NOT the naive two-regex
// `/\*[\s\S]*?\*\//g` then `//` approach other tests in this repo use for
// simpler files): this module's own source comments legitimately spell
// `gsd-core/bin/lib/*.cjs` (a glob) inside a `//` line, which forms a bare
// `/*` token — a whole-text block-comment regex applied naively would read
// that as an OPENING block comment and swallow everything up to the next
// unrelated `*/` anywhere later in the file, silently deleting real code
// (verified while authoring this guard: it ate the very require() line the
// guard exists to check for). Processing line-by-line and stripping a
// trailing `//` comment BEFORE ever checking that line's remainder for `/*`
// means a `/*`-shaped token inside a `//` comment is never seen at all.
function stripComments(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    if (line.trim().startsWith('//')) { out.push(''); continue; }
    // Strip a trailing `//` comment (not a `://` URL) BEFORE any `/*` check
    // on the remainder — see the function header for why this ordering
    // matters.
    const trailing = /(^|[^:])\/\/.*$/.exec(line);
    if (trailing) line = line.slice(0, trailing.index + trailing[1].length);
    // Same-line and newly-opened block comments in what remains.
    for (;;) {
      const start = line.indexOf('/*');
      if (start === -1) break;
      const end = line.indexOf('*/', start + 2);
      if (end !== -1) {
        line = line.slice(0, start) + line.slice(end + 2);
        // keep scanning from the same position in case of a second
        // same-line block comment
      } else {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

// Captures the quoted path of every require(...) call. Single bounded
// negated-class quantifier per alternative, no nesting.
const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

function isCompiledLibRequire(requirePath) {
  return requirePath.includes('gsd-core/bin/lib/') && requirePath.endsWith('.cjs');
}

function isSeamRequire(requirePath) {
  return requirePath.endsWith('gsd-core/bin/ensure-runtime-build.cjs');
}

// An actual invocation, not merely a `{ ensureRuntimeBuild }` destructuring
// import — the identifier immediately followed by `(`.
const SEAM_CALL_RE = /\bensureRuntimeBuild\s*\(/;

/**
 * Pure: scan one file's contents for the violation described above.
 * Returns `{ compiledLibRequires: string[], hasSeamRequire: boolean,
 * hasSeamCall: boolean }`. `compiledLibRequires` is `[]` when the file
 * requires no compiled module — the caller treats that as "nothing to
 * check" regardless of the other two fields.
 */
function scanFile(text) {
  const code = stripComments(text);
  const compiledLibRequires = [];
  let hasSeamRequire = false;
  let m;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(code)) !== null) {
    const requirePath = m[2];
    if (isCompiledLibRequire(requirePath)) compiledLibRequires.push(requirePath);
    if (isSeamRequire(requirePath)) hasSeamRequire = true;
  }
  const hasSeamCall = SEAM_CALL_RE.test(code);
  return { compiledLibRequires, hasSeamRequire, hasSeamCall };
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing root is not an error here — caller decides
  }
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDE_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan `root`'s hooks/ tree and return every violating file.
 * @param {string} root  repo root (or a fixture root for tests)
 * @returns {{ file: string, compiledLibRequires: string[], missing: string[] }[]}
 */
function scanRepo(root) {
  const violations = [];
  for (const full of walk(path.join(root, SCAN_ROOT))) {
    const text = fs.readFileSync(full, 'utf8');
    const { compiledLibRequires, hasSeamRequire, hasSeamCall } = scanFile(text);
    if (compiledLibRequires.length === 0) continue;
    if (hasSeamRequire && hasSeamCall) continue;
    const missing = [];
    if (!hasSeamRequire) missing.push('require(".../gsd-core/bin/ensure-runtime-build.cjs")');
    if (!hasSeamCall) missing.push('a call to ensureRuntimeBuild(...)');
    violations.push({
      file: path.relative(root, full).split(path.sep).join('/'),
      compiledLibRequires,
      missing,
    });
  }
  return violations;
}

function main() {
  const violations = scanRepo(ROOT);
  if (violations.length > 0) {
    const detail = violations
      .map((v) => (
        `  ${v.file}\n` +
        `    requires: ${v.compiledLibRequires.join(', ')}\n` +
        `    missing: ${v.missing.join(' AND ')}`
      ))
      .join('\n');
    throw new ExitError(
      1,
      `lint-hooks-runtime-build-seam: ${violations.length} hooks/ file(s) require a compiled\n` +
        `gsd-core/bin/lib/*.cjs module without also self-healing via\n` +
        `ensureRuntimeBuild() from gsd-core/bin/ensure-runtime-build.cjs first (#3582) — on a\n` +
        `plugin-marketplace/git-clone install that never ran \`npm run build:lib\`, that\n` +
        `require crashes (or is silently misreported) instead of self-building:\n\n${detail}\n`,
    );
  }
  console.log('ok lint-hooks-runtime-build-seam: every hooks/ compiled-lib require goes through ensureRuntimeBuild()');
}

module.exports = { scanFile, scanRepo, walk, stripComments, isCompiledLibRequire, isSeamRequire, SEAM_CALL_RE };

if (require.main === module) runMain(main);
