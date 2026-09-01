#!/usr/bin/env node
'use strict';

/**
 * lint-workflow-shellcheck.cjs
 *
 * Systemic prevention for the zsh/bash word-splitting bug class (#4109):
 * every ```bash fenced block embedded in gsd-core/workflows/*.md (and the
 * nested gsd-core/workflows/<workflow>/steps/*.md / modes/*.md / etc. layer)
 * is extracted and run through the real ShellCheck binary. Any finding fails
 * the lint with a non-zero exit — this is what stops the SC2086-class bug
 * (unquoted variable expansion, word-split/glob differently under zsh vs
 * bash) from landing undetected a second time (it already landed 4 times in
 * this repo's workflow templates before #4109's fix).
 *
 * ShellCheck source: scripts/lib/shellcheck-fetch.cjs, a small dependency-
 * free downloader that fetches a PINNED koalaman/shellcheck release directly
 * from GitHub releases and caches the extracted binary under
 * node_modules/.cache/shellcheck/<version>/. This replaces the `shellcheck`
 * npm package (gunar/shellcheck) originally used here (#4109) — removed in
 * #4120 because its extraction dependency, `decompress@4.2.1`, carries an
 * unpatched CRITICAL zip-slip vulnerability (GHSA-mp2f-45pm-3cg9, CVSS 9.1)
 * with no patched version available upstream. See shellcheck-fetch.cjs's own
 * header comment for the extraction implementation and its zip-slip defense.
 *
 * Extraction: reuses scanFencedBlocks from markdown-sectionizer.cts (the
 * canonical fence-scanning engine — see tests/review-plan-coverage-manifest
 * .test.cjs's extractAllBashBlocks for the precedent this follows) rather
 * than a bespoke regex.
 *
 * Placeholder handling: workflow blocks reference template placeholders —
 * both single-token (`{run_dir}`, `{N}`) and multi-word prose (`{discovered
 * test command}`, `{each unique directory from resolved paths}`) — that are
 * not valid shell and would misparse as ShellCheck syntax errors unrelated to
 * the word-splitting class this lint targets. Every such placeholder (NOT
 * `${identifier}`, which is a real parameter expansion, and NOT real brace
 * syntax like `{1..5}`/`{a,b,c}`/`{ cmd; }` — see `substitutePlaceholders`'s
 * own comment for the exact discriminating rule) is substituted with a
 * shell-safe bareword before staging, generalizing the test harness's
 * single-placeholder `body.split('{run_dir}').join(runDir)` substitution to
 * the general case.
 *
 * Rule selection (documented per the brief's requirement to justify the
 * include/exclude choice):
 *   - SC2086 (double-quote to prevent globbing/word splitting) is the exact
 *     bug class #4109 fixes and MUST be enabled — it is ShellCheck's default
 *     behavior and is never excluded here.
 *   - The rest of ShellCheck's DEFAULT rule set is also left enabled: most of
 *     it (SC2046, SC2068, SC2145, SC2206, SC2207, etc.) is the SAME
 *     quoting/word-splitting/array-expansion family SC2086 belongs to, and is
 *     exactly the kind of finding this lint exists to catch.
 *   - Three codes are explicitly EXCLUDED because they produce structural
 *     false positives in this templated, cross-block, agent-populated
 *     context rather than real defects:
 *       SC1091 — "not following sourced file": blocks `source`/`.` files
 *       that exist only at run time in the calling agent's real RUN_DIR, not
 *       in this lint's throwaway single-block temp file.
 *       SC2154 — "var is referenced but not assigned": workflow blocks
 *       routinely reference variables the CALLING AGENT exports as env vars,
 *       or that a DIFFERENT fenced block earlier in the same workflow
 *       assigned — invisible to a scan of one isolated block.
 *       SC2034 — "var appears unused": the mirror image of SC2154 — a var
 *       assigned in this block is frequently consumed by a LATER block in
 *       the same workflow, again invisible to a single-block scan.
 *     SC2148 ("shell directive missing") is not in this exclude list because
 *     passing `--shell=bash` to ShellCheck (all these blocks are already
 *     fenced ```bash, i.e. self-declared) prevents it from firing at all.
 *
 * Exit 0 with no output on a clean tree (or a tree whose only findings are
 * already accepted in the baseline, see below); exit 1 with every NEW
 * finding (file, line, ShellCheck code, message) printed to stderr otherwise.
 *
 * Baseline (pre-existing findings, #4109 follow-up):
 * Landing this lint against the real repo surfaced ~212 pre-existing
 * ShellCheck findings across ~60 files that are unrelated to #4109's actual
 * fix (a zsh word-splitting bug already fixed at its 6 sites). Requiring all
 * 212 to be fixed in the same PR that adds the lint would block CI for
 * reasons orthogonal to the issue. Instead, `scripts/lint-workflow-
 * shellcheck-baseline.json` records the *accepted* pre-existing findings as
 * of the baseline's generation, and this script only fails on findings NOT
 * present in that baseline ("new" findings) — a standard ratchet: today's
 * findings can never silently grow, but paying down the backlog is a
 * separate, incremental effort.
 *
 * Baseline shape: a flat JSON array of `{file, code, message}` triples (see
 * BASELINE_PATH below). `file` is the workflow-relative path (matches a
 * finding's mapped `block.file`), `code` is the bare ShellCheck code number
 * (e.g. `"2086"`, matches `f.code`), `message` is ShellCheck's finding text
 * verbatim (matches `f.message`).
 *
 * Matching strategy — deliberately EXCLUDES line/column: matching on exact
 * line number would make the baseline brittle to totally unrelated edits.
 * E.g. inserting one line near the top of a large workflow file shifts every
 * subsequent line number, which would make every already-accepted finding
 * below that point look "new" on the next lint run — a spurious CI failure
 * with no relationship to any real regression. `{file, code, message}` is
 * stable under such reflow: the finding's identity (what rule fired, what it
 * says, which file) doesn't move just because line numbers shift.
 *
 * This does mean two textually-identical findings in the same file (same
 * code, same message) are indistinguishable by key alone. Findings are
 * matched as a MULTISET, not a set: the baseline is loaded into a
 * `key -> count` map, and each current finding consumes one count of its key
 * if available (marking it "baselined") or is reported "new" once the
 * baseline's count for that key is exhausted. This preserves ratchet
 * semantics per-file-per-rule-per-message (a THIRD occurrence of a message
 * that only had two accepted instances IS reported as new) without being
 * sensitive to which physical line within the file each occurrence sits on.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { resolveShellcheckBin } = require('./lib/shellcheck-fetch.cjs');

// Hard bound on the ShellCheck binary's run time, matching this repo's
// npm-subprocess timeout convention (5-30s git, 60s npm — same "external
// process that could hang" hazard class). Applied directly to runShellcheck's
// own spawnSync call below.
const SHELLCHECK_TIMEOUT_MS = 60_000;

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const SECTIONIZER_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs');
const BASELINE_PATH = path.join(__dirname, 'lint-workflow-shellcheck-baseline.json');

// Codes excluded for structural reasons documented in the module header above.
const EXCLUDED_CODES = ['SC1091', 'SC2154', 'SC2034'];

/** Every bare `{identifier}` (not `${identifier}`) → a shell-safe bareword. */
function substitutePlaceholders(body) {
  // Only matches content that is ALREADY known-safe to be workflow-template
  // prose: starts with a letter, then nothing but letters/digits/underscore/
  // hyphen/space. This deliberately excludes every real shell use of `{...}`
  // that could otherwise collide with a placeholder-shaped token:
  //   - `${var}` parameter expansion — excluded by the `(?<!\$)` lookbehind.
  //   - `{1..5}` / `{01..10}` numeric ranges — digit-first or contain `.`.
  //   - `{a,b,c}` brace-expansion lists — contain `,`.
  //   - `{ cmd; }` / `{ cmd1; cmd2; }` compound-command grouping — POSIX
  //     requires whitespace immediately after the opening `{` (it is only a
  //     reserved word when blank-separated), and the body always carries a
  //     `;`/pipe/redirect/quote — none of which this charset admits, so a
  //     real command group can never match this regex.
  //   - JSON-shaped literals like `{"key": "value"}` — contain `"`/`:`.
  // Everything workflow authors actually use as a template placeholder in
  // this repo (`{run_dir}`, `{N}`, `{discovered test command}`, `{scenario
  // keyword}`, `{expected}`, `{implementation file}`, …) is pure prose text
  // and matches; nothing else does.
  return body.replace(/(?<!\$)\{([A-Za-z][A-Za-z0-9_ -]*)\}/g, (match, inner) => {
    const safe = inner.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'X';
    return `PLACEHOLDER_${safe}`;
  });
}

/** Recursively collect every `.md` file under `dir`. */
function collectMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    // Node's recursive readdir sets entry.parentPath (>=20.12) / entry.path (older).
    const parent = entry.parentPath ?? entry.path;
    out.push(path.join(parent, entry.name));
  }
  return out.sort();
}

/**
 * Every ```bash fenced block across every workflow .md file, with enough
 * metadata to map a ShellCheck finding back to its original source location.
 */
function extractBashBlocks(sectionizer) {
  const files = collectMarkdownFiles(WORKFLOWS_DIR);
  const blocks = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    const relFile = path.relative(ROOT, file);
    const fenced = sectionizer.scanFencedBlocks(lines);
    let blockIdx = 0;
    for (const b of fenced) {
      if (b.closeLineIdx === -1) continue; // unterminated fence — nothing well-defined to check
      if ((b.infoString || '').trim() !== 'bash') continue;
      const body = lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n');
      blocks.push({
        file: relFile,
        blockIdx: blockIdx++,
        // 1-based source line of the FIRST body line — a JSON finding's own
        // `line` (1-based, relative to the staged single-block temp file) is
        // added to this minus 1 to recover the real workflow-file line.
        firstBodyLine: b.openLineIdx + 2,
        body,
      });
    }
  }
  return blocks;
}

/** Stable identity key for a mapped finding — see the "Matching strategy" note above. */
function findingKey(f) {
  return `${f.file} ${f.code} ${f.message}`;
}

/**
 * Structural check (separate from the ShellCheck pass above): catches the
 * exact #4109 bug shape — `for x in $VAR; do` / `for x in ${VAR}; do` with a
 * BARE, unquoted scalar variable reference in the for-list position.
 *
 * ShellCheck does NOT flag this pattern under any ruleset, confirmed
 * empirically by reintroducing the exact bug and running this script's own
 * ShellCheck invocation (including `--enable=all`): a bare `$VAR` directly in
 * a for-list is a deliberately-accepted, common bash idiom to ShellCheck, so
 * SC2086 and friends never fire on it. That idiom is exactly what silently
 * diverges between bash (word-splits it) and zsh (does not) — the root cause
 * of #4109. Hence this dedicated structural pass, run in the SAME invocation
 * as the ShellCheck pass, over the SAME extracted ```bash blocks.
 *
 * Algorithm per for-loop found in a block body:
 *   1. Locate `for <ident> in <list-expr>` and capture <list-expr> up to the
 *      first `;` or newline that is NOT nested inside a `$( ... )` span (a
 *      paren-depth scan, not a naive `[^;]*` regex slice) — a for-list that
 *      itself contains a `;` inside a command substitution must not have its
 *      capture truncated early.
 *   2. Strip every `$( ... )` command-substitution span out of <list-expr>.
 *      Command substitution ALWAYS word-splits its result in both bash AND
 *      zsh — that is the actual #4109 fix pattern applied at every known
 *      site (`$(printf '%s' "$VAR")`), so a bare `$VAR` INSIDE a `$(...)`
 *      span is safe and must never be flagged.
 *   3. Search what remains for a bare `$IDENT` / `${IDENT}` that is NOT
 *      immediately preceded by `"` — a `"$VAR"` reference is a different,
 *      also-safe idiom (single-token literal-list iteration), not the
 *      splitting bug.
 *
 * Findings from this pass are NEVER baselined (unlike the ShellCheck pass) —
 * this check is new-by-construction and every workflow site known to be
 * vulnerable was already swept as part of #4109's fix, so any finding here
 * is a genuinely new/missed site worth surfacing distinctly rather than
 * silently absorbing into scripts/lint-workflow-shellcheck-baseline.json.
 */

/** Strip every balanced `$( ... )` span from `text`, preserving everything else. */
function stripCommandSubstitutions(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      i = j;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

// A bare `$IDENT` / `${IDENT}` not immediately preceded by `"`.
const BARE_VAR_RE = /(^|[^"])\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/;

/**
 * Blank out `# ...` shell comments (to end of line), preserving every other
 * character's position 1:1 (comment text is replaced with spaces, newlines
 * are kept) so downstream character-offset -> line-number mapping stays
 * valid without needing a second pass. A `#` only starts a comment when it
 * is the first character of a "word" (start of line, or preceded by
 * whitespace) — matching real shell comment semantics and, deliberately,
 * NOT stripping `${VAR#pattern}` parameter-expansion `#`s (always preceded
 * by a non-whitespace identifier character, e.g. `${sm_raw#./}`). Prose
 * inside a `#` comment (e.g. a changelog note quoting `for x in $VAR` as an
 * example of a PAST bug) must never be mistaken for live code — this is
 * what stops that false positive.
 */
function stripShellComments(body) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i++;
      continue;
    }
    const prev = i === 0 ? '\n' : body[i - 1];
    if (ch === '#' && /\s/.test(prev)) {
      while (i < body.length && body[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue; // the '\n' itself (if any) is handled by the next loop iteration
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Every `for <ident> in <list-expr>` for-loop header in `body`, with the raw
 * list-expression text and the 0-based character offset of the `for` keyword
 * (used by the caller to recover a line number).
 */
function extractForLoops(body) {
  const results = [];
  const headerRe = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+/g;
  let m;
  while ((m = headerRe.exec(body)) !== null) {
    const start = headerRe.lastIndex;
    let i = start;
    let depth = 0;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && (ch === ';' || ch === '\n')) break;
      i++;
    }
    results.push({ loopVar: m[1], listExpr: body.slice(start, i), matchIndex: m.index });
    headerRe.lastIndex = i;
  }
  return results;
}

/** 1-based line number of `charIndex` within `body` (0-based first line = 1). */
function lineOffsetOf(body, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex && i < body.length; i++) {
    if (body[i] === '\n') line++;
  }
  return line;
}

/**
 * Scan every extracted block for the bare unquoted `for x in $VAR` shape.
 * Returns mapped findings (`{file, line, loopVar, varName, listExpr,
 * blockIdx}`), analogous in shape to the ShellCheck findings above but never
 * baselined — see this section's header note.
 */
function findBareForLoopSplits(blocks) {
  const findings = [];
  for (const block of blocks) {
    const codeOnly = stripShellComments(block.body);
    for (const loop of extractForLoops(codeOnly)) {
      const stripped = stripCommandSubstitutions(loop.listExpr);
      const bare = BARE_VAR_RE.exec(stripped);
      if (!bare) continue;
      findings.push({
        file: block.file,
        line: block.firstBodyLine + lineOffsetOf(block.body, loop.matchIndex) - 1,
        blockIdx: block.blockIdx,
        loopVar: loop.loopVar,
        varName: bare[2],
        listExpr: loop.listExpr.trim(),
      });
    }
  }
  return findings;
}

/** Load the baseline array (empty if the file does not exist yet). */
function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return [];
  const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new ExitError(
      1,
      `lint-workflow-shellcheck: ${path.relative(ROOT, BASELINE_PATH)} must be a JSON array of ` +
        `{file, code, message} objects.`,
    );
  }
  return parsed;
}

/**
 * Partition `mappedFindings` (each `{file, code, message, ...}`) into
 * `{newFindings, baselinedFindings}` against the baseline multiset. See the
 * "Matching strategy" note in the module header for why this is a
 * key -> count multiset match rather than exact-line matching.
 */
function partitionAgainstBaseline(mappedFindings, baseline) {
  const remaining = new Map();
  for (const entry of baseline) {
    const key = findingKey(entry);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  const newFindings = [];
  const baselinedFindings = [];
  for (const f of mappedFindings) {
    const key = findingKey(f);
    const count = remaining.get(key) || 0;
    if (count > 0) {
      remaining.set(key, count - 1);
      baselinedFindings.push(f);
    } else {
      newFindings.push(f);
    }
  }
  return { newFindings, baselinedFindings };
}

function loadSectionizer() {
  try {
    return require(SECTIONIZER_PATH);
  } catch (e) {
    throw new ExitError(
      1,
      `lint-workflow-shellcheck: cannot load the markdown-sectionizer seam at ` +
        `${path.relative(ROOT, SECTIONIZER_PATH)} — run 'npm run build:lib' first (${e.message})`,
    );
  }
}

/**
 * Run ShellCheck (json1 output) over every staged temp file in one invocation,
 * bounded by SHELLCHECK_TIMEOUT_MS.
 *
 * `bin` is resolved by the caller via scripts/lib/shellcheck-fetch.cjs's
 * `resolveShellcheckBin()` (downloading and caching the pinned release on
 * first use, per that module's own header comment). This invokes
 * `child_process.spawnSync` directly with a native `timeout` so a hung
 * ShellCheck binary is killed (Node sets `result.error.code === 'ETIMEDOUT'`
 * and `result.signal` on expiry) rather than hanging this lint — and,
 * transitively, CI — indefinitely.
 */
function runShellcheck(bin, filePaths) {
  const args = [
    '--shell=bash',
    '--format=json1',
    `--exclude=${EXCLUDED_CODES.join(',')}`,
    ...filePaths,
  ];
  const result = childProcess.spawnSync(bin, args, { stdio: 'pipe', timeout: SHELLCHECK_TIMEOUT_MS });
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    throw new ExitError(
      1,
      `lint-workflow-shellcheck: ShellCheck invocation ${
        timedOut ? `timed out after ${SHELLCHECK_TIMEOUT_MS}ms` : 'failed'
      }: ${result.error.message}`,
    );
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : (result.stdout || '');
  if (stdout.trim() === '') {
    // ShellCheck produced no output at all — genuine infra failure (crash,
    // bad binary, etc.), not "zero findings" (which is `{"comments":[]}`).
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : (result.stderr || '');
    throw new ExitError(
      1,
      `lint-workflow-shellcheck: ShellCheck produced no output (exit ${result.status}). stderr: ${stderr}`,
    );
  }
  try {
    return JSON.parse(stdout).comments || [];
  } catch (e) {
    throw new ExitError(
      1,
      `lint-workflow-shellcheck: could not parse ShellCheck json1 output: ${e.message}\n${stdout}`,
    );
  }
}

async function main() {
  const sectionizer = loadSectionizer();
  const blocks = extractBashBlocks(sectionizer);

  if (blocks.length === 0) {
    process.stdout.write('ok lint-workflow-shellcheck: no ```bash blocks found under gsd-core/workflows/\n');
    return 0;
  }

  // Structural pass (see findBareForLoopSplits's header comment) — runs
  // independently of ShellCheck. As of the #4109 sweep, every previously
  // KNOWN site is fixed (0 structural findings on a clean tree), so this now
  // GATES the exit code exactly like the ShellCheck-baseline-diff check
  // below: a non-empty structuralFindings fails main() even if ShellCheck
  // itself reports nothing new. Every finding is printed prominently below
  // regardless of outcome; the two checks are combined into one final exit
  // decision so a run with both kinds of findings reports both.
  const structuralFindings = findBareForLoopSplits(blocks);
  if (structuralFindings.length > 0) {
    process.stdout.write(
      `\nSTRUCTURAL FINDING (not ShellCheck, not baselined) lint-workflow-shellcheck: ` +
        `${structuralFindings.length} bare unquoted \`for x in $VAR\` for-loop(s) — the #4109 bash/zsh ` +
        `word-splitting bug shape ShellCheck itself does not detect:\n\n`,
    );
    for (const f of structuralFindings) {
      process.stdout.write(
        `  ${f.file}:${f.line} (block #${f.blockIdx}) — ` +
          `for ${f.loopVar} in ${f.listExpr} — bare $${f.varName} is unquoted and not inside $(...); ` +
          `wrap in $(printf '%s' "$${f.varName}") to split identically under bash and zsh.\n`,
      );
    }
    process.stdout.write('\n');
  }
  const structuralFailed = structuralFindings.length > 0;

  const shellcheckBin = await resolveShellcheckBin();

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-workflow-shellcheck-'));
  try {
    const stagedPaths = [];
    const byPath = new Map();
    blocks.forEach((block, i) => {
      const scriptPath = path.join(stageDir, `block-${i}.sh`);
      fs.writeFileSync(scriptPath, substitutePlaceholders(block.body));
      stagedPaths.push(scriptPath);
      byPath.set(scriptPath, block);
    });

    const findings = runShellcheck(shellcheckBin, stagedPaths);

    if (findings.length === 0) {
      process.stdout.write(
        `ok lint-workflow-shellcheck: ${blocks.length} \`\`\`bash block(s) across ` +
          `${new Set(blocks.map((b) => b.file)).size} workflow file(s) checked, 0 ShellCheck findings\n`,
      );
      return structuralFailed ? 1 : 0;
    }

    const mappedFindings = findings.map((f) => {
      const block = byPath.get(f.file);
      return {
        file: block ? block.file : f.file,
        line: block ? block.firstBodyLine + f.line - 1 : f.line,
        column: f.column,
        code: String(f.code),
        level: f.level,
        message: f.message,
        blockIdx: block ? block.blockIdx : undefined,
      };
    });

    const baseline = loadBaseline();
    const { newFindings, baselinedFindings } = partitionAgainstBaseline(mappedFindings, baseline);

    if (newFindings.length === 0) {
      process.stdout.write(
        `ok lint-workflow-shellcheck: ${baselinedFindings.length} pre-existing finding(s) from baseline, ` +
          `0 new\n`,
      );
      return structuralFailed ? 1 : 0;
    }

    process.stderr.write(
      `\nERROR lint-workflow-shellcheck: ${newFindings.length} NEW ShellCheck finding(s) in ` +
        `gsd-core/workflows/ \`\`\`bash block(s) (#4109 word-splitting/quoting prevention) not present in ` +
        `${path.relative(ROOT, BASELINE_PATH)}.\n\n`,
    );
    for (const f of newFindings) {
      const loc = f.blockIdx !== undefined
        ? `${f.file} (block #${f.blockIdx}, line ${f.line}, col ${f.column})`
        : `${f.file}:${f.line}:${f.column}`;
      process.stderr.write(`  ${loc} — SC${f.code} (${f.level}): ${f.message}\n`);
    }
    if (baselinedFindings.length > 0) {
      process.stderr.write(`\n(${baselinedFindings.length} other pre-existing finding(s) from baseline, not shown.)\n`);
    }
    process.stderr.write('\n');
    return 1;
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

// Guarded so requiring this module (e.g. from tests/lint-workflow-shellcheck
// .test.cjs, to exercise the exported pure parser/logic functions) does not
// ALSO trigger a full ShellCheck run as an unwanted side effect of require()
// — matches the established convention in this repo's other dual-purpose
// script+module lint scripts, e.g. scripts/lint-docs-required.cjs's own
// `if (require.main === module) runMain(main);`.
if (require.main === module) runMain(main);

module.exports = {
  substitutePlaceholders,
  collectMarkdownFiles,
  extractBashBlocks,
  EXCLUDED_CODES,
  findingKey,
  loadBaseline,
  partitionAgainstBaseline,
  BASELINE_PATH,
  stripCommandSubstitutions,
  stripShellComments,
  extractForLoops,
  findBareForLoopSplits,
};
