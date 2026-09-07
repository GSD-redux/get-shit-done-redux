'use strict';

// docs-guard-exempt: mentions docs/PARTITION-RULES.md only as a "see" pointer in the
// module docstring below, never reads its content — the checks this file implements are
// verified against docs/PARTITION-RULES.md's own prose by a human reviewer at authoring
// time, not by this test re-parsing that document at runtime.

/**
 * tests/compact-content-partition-guard.test.cjs — ADR-4139 Decision 5, epic #4139,
 * Phase 3 #4403. This is the general-purpose CI guard PARTITION-RULES.md describes: it
 * implements the five checks against every `<name>/detail/*.md` split registered under
 * `gsd-core/workflows/`, and supersedes the one-off `tests/plan-phase-compact-split.test.cjs`
 * pilot (deleted by this same change).
 *
 * See `docs/PARTITION-RULES.md` for the operational spec — it is the source of truth for
 * what each check does; this file is the mechanics plus the failing-first fixtures that
 * prove each check can actually fail (per this repo's rule that a guard nobody has seen go
 * red is not yet a guard).
 *
 * Layout:
 *   - checks 2/3 (disjointness, registration) run unconditionally against the real repo —
 *     they need no PR diff, just the files on disk.
 *   - checks 1/4/5 (completeness, protected content, boundary moves) are PR-diff-scoped:
 *     they compare the resolved base ref (origin/next, mirroring the base-ref-resolution
 *     idiom `tests/helpers/emitted-runtime.cjs`'s `resolveBase` already implements) against
 *     HEAD. When no base ref resolves (a fresh clone, a shallow/detached CI context), they
 *     skip cleanly — this is the ambient-run guard the dispatch brief calls out, and it is
 *     deliberately asymmetric with `readBoundaryMoveTrailers`'s own contract: THAT function
 *     throws on an uncomputable range because it is answering "did THIS PR declare its
 *     moves", and silently passing would disarm it; the ambient guard here is answering "is
 *     there even a PR diff to look at", which is a different, structurally prior question.
 *   - each of the 5 checks gets a fixture `describe` block with a RED (deliberately broken)
 *     and a GREEN (fixed) sibling test, built against synthetic temp files/repos — never
 *     against this repo's own real splits, so the fixture is independent of whatever the
 *     real tree happens to contain.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const { runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { REPO_ROOT, GIT_TIMEOUT_MS, safeDirArgs, resolveBase } = require('./helpers/emitted-runtime.cjs');
const { ACK_TRAILER_DELIM } = require('./helpers/emitted-diff.cjs');
const {
  DEFAULT_WORKFLOWS_DIR,
  discoverRegisteredSplits,
  normalizeNonTrivialLines,
  extractProtectedBlocks,
  readBoundaryMoveTrailers,
  parseBoundaryMoveTrailerValues,
  checkDisjointness,
  checkRegistration,
  checkDetailFileSizeCap,
  NEW_FILE_CAP,
} = require('./helpers/compact-content-split.cjs');

// ─── git plumbing local to this guard (checks 1/4/5's PR-diff orchestration) ──────────

/** `<repoRoot>`-relative, forward-slash path, matching the trailer-key / reference shape
 *  PARTITION-RULES.md and `checkRegistration` both use. */
function toRepoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

/** `git merge-base <baseRef> HEAD`, or `null` on any failure (ambient guard: this is a
 *  "nothing to compare" signal, never a hard error, for the reasons in the file header). */
function computeMergeBaseSha(baseRef) {
  const result = runGit([...safeDirArgs(REPO_ROOT), 'merge-base', baseRef, 'HEAD'], {
    cwd: REPO_ROOT,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.outcome !== OUTCOME.EXITED || result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** `git diff --name-status <mergeBaseSha>...HEAD -- gsd-core/workflows`, parsed into
 *  `{status, path}` rows (`path` is always the CURRENT path — the second field of an
 *  `R###\told\tnew` rename row, or the single field of every other status). `null` on
 *  any git failure (ambient guard). */
function diffNameStatusForWorkflows(mergeBaseSha) {
  const result = runGit(
    [...safeDirArgs(REPO_ROOT), 'diff', '--name-status', `${mergeBaseSha}...HEAD`, '--', 'gsd-core/workflows'],
    { cwd: REPO_ROOT, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (result.outcome !== OUTCOME.EXITED || result.exitCode !== 0) return null;
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t');
      return { status: fields[0][0], path: fields[fields.length - 1] };
    });
}

/** `git show <ref>:<relPath>`, or `null` if the path is absent at `ref` (or on any other
 *  git failure — see the file header on why this check family never throws for that). */
function showAtRefOrNull(ref, relPath) {
  const result = runGit([...safeDirArgs(REPO_ROOT), 'show', `${ref}:${relPath}`], {
    cwd: REPO_ROOT,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result.outcome === OUTCOME.EXITED && result.exitCode === 0 ? result.stdout : null;
}

// ─── pure check logic (the "lower-level functions" the fixtures call directly) ────────

/**
 * Check 1 (completeness): the union of the new spine + new detail parts must be a
 * superset of the OLD spine's non-trivial lines, and the new spine must be smaller.
 * `oldSpineContent === null` (no comparison base — a wholly new split with nothing to be
 * complete relative to) short-circuits to no violations at all, per PARTITION-RULES.md.
 */
function checkCompletenessForPair({ splitName, oldSpineContent, newSpineContent, newDetailContents }) {
  if (oldSpineContent === null) return [];
  const violations = [];
  const oldLines = normalizeNonTrivialLines(oldSpineContent);
  const unionSet = new Set([
    ...normalizeNonTrivialLines(newSpineContent),
    ...newDetailContents.flatMap((c) => normalizeNonTrivialLines(c)),
  ]);
  for (const line of oldLines) {
    if (!unionSet.has(line)) violations.push({ kind: 'incomplete_split', splitName, line });
  }
  const oldSize = Buffer.byteLength(oldSpineContent, 'utf8');
  const newSize = Buffer.byteLength(newSpineContent, 'utf8');
  if (!(newSize < oldSize)) {
    violations.push({ kind: 'spine_not_smaller', splitName, oldSize, newSize });
  }
  return violations;
}

/**
 * All non-blank, trimmed lines of `content`, WITHOUT `normalizeNonTrivialLines`'s
 * boilerplate filter. Check 4 needs this distinct membership set: a protected block can
 * legitimately enclose an `isTrivial`-shaped line (most commonly a code-fence delimiter,
 * e.g. a `<failing_direction_contract>` example's own ```` ``` ````), and that line is
 * just as much "content the block covers" as any prose line — dropping it from the
 * membership test would report a byte-identical spine as having "deleted" its own fence,
 * a false positive caught by this guard's own real-repo sanity run against plan-phase.md
 * before this fix (the fence lines were being tested for presence in a
 * `normalizeNonTrivialLines`-filtered set, which strips exactly that shape).
 */
function allNonBlankLines(content) {
  return content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Check 4 (protected content): every line inside a `<!-- gsd:protected -->` sentinel at
 * the OLD spine must still be physically present in the NEW spine. A missing line that
 * now appears in one of the spine's detail parts is reported as `protected_relocated`
 * (named destination); any other missing line is `protected_deleted`. No trailer can ever
 * excuse either — this function does not even look for one.
 */
function checkProtectedContentForPair({ splitName, oldSpineContent, newSpineContent, detailPathToContent }) {
  if (oldSpineContent === null) return [];
  const violations = [];
  const oldBlocks = extractProtectedBlocks(oldSpineContent).blocks;
  const newSpineLines = new Set(allNonBlankLines(newSpineContent));
  for (const block of oldBlocks) {
    for (const line of block.lines) {
      if (newSpineLines.has(line)) continue;
      let relocatedTo = null;
      for (const [relPath, content] of detailPathToContent) {
        if (allNonBlankLines(content).includes(line)) {
          relocatedTo = relPath;
          break;
        }
      }
      violations.push({
        kind: relocatedTo ? 'protected_relocated' : 'protected_deleted',
        splitName,
        blockFirstLine: block.firstLine,
        line,
        relocatedTo,
      });
    }
  }
  return violations;
}

/**
 * Check 5's moved-line detector: non-trivial lines removed from the spine (present at the
 * old ref, absent now) that are simultaneously newly present in one of the spine's OWN
 * detail parts (absent from that detail part's old content — or the part is brand new —
 * present now). `excludeLines` drops anything already counted as a check-4 protected
 * violation: a protected line moving is ALWAYS a hard failure regardless of a trailer
 * (check 4's job), so check 5 only concerns itself with ordinary lines.
 */
function findMovedLines({ oldSpineContent, newSpineContent, oldDetailContentByPath, newDetailContentByPath, excludeLines }) {
  const oldSpineLines = new Set(normalizeNonTrivialLines(oldSpineContent));
  const newSpineLines = new Set(normalizeNonTrivialLines(newSpineContent));
  const removedFromSpine = new Set([...oldSpineLines].filter((l) => !newSpineLines.has(l)));
  const moved = new Set();
  for (const [relPath, newContent] of newDetailContentByPath) {
    const oldContent = oldDetailContentByPath.has(relPath) ? oldDetailContentByPath.get(relPath) : null;
    const oldDetailLines = new Set(oldContent === null ? [] : normalizeNonTrivialLines(oldContent));
    for (const line of normalizeNonTrivialLines(newContent)) {
      if (removedFromSpine.has(line) && !oldDetailLines.has(line) && !excludeLines.has(line)) {
        moved.add(line);
      }
    }
  }
  return [...moved];
}

/**
 * Check 5 (boundary moves declared): wraps `findMovedLines` with the trailer lookup. When
 * there is nothing moved, `readBoundaryMoveTrailers` is never even called — no PR-shaped
 * question to ask. When there IS a moved line, the trailer read is NOT guarded: a failure
 * there must throw and propagate, per PARTITION-RULES.md check 5 / the file header's
 * asymmetry note.
 */
function checkBoundaryMovesForSplit({
  splitName,
  spineRelPath,
  oldSpineContent,
  newSpineContent,
  oldDetailContentByPath,
  newDetailContentByPath,
  excludeLines,
  baseRef,
  cwd,
}) {
  const moved = findMovedLines({
    oldSpineContent,
    newSpineContent,
    oldDetailContentByPath,
    newDetailContentByPath,
    excludeLines,
  });
  if (moved.length === 0) return [];
  const { declarations } = readBoundaryMoveTrailers({ baseRef, cwd });
  if (declarations.has(spineRelPath)) return [];
  return moved.map((line) => ({ kind: 'undeclared_boundary_move', splitName, spinePath: spineRelPath, line }));
}

/**
 * Full PR-diff-scoped orchestration for checks 1, 4, 5 against the REAL repo. Returns
 * `{skipped: true, reason}` when there is genuinely nothing to compare (ambient guard);
 * otherwise `{skipped: false, completeness, protectedContent, boundaryMoves}`.
 */
function runPrDiffScopedChecks() {
  const base = resolveBase();
  if (!base) return { skipped: true, reason: 'no resolvable base ref (origin/next unavailable)' };

  const mergeBaseSha = computeMergeBaseSha(base.ref);
  if (!mergeBaseSha) return { skipped: true, reason: `merge-base unresolvable for "${base.ref}..HEAD"` };

  const diff = diffNameStatusForWorkflows(mergeBaseSha);
  if (diff === null) return { skipped: true, reason: 'git diff --name-status failed' };

  const splits = discoverRegisteredSplits().filter((s) => s.spineExists);
  const completeness = [];
  const protectedContent = [];
  const boundaryMoves = [];

  // Check 1: only for detail paths newly ADDED by this diff, grouped by split name.
  const newlySplitNames = new Set();
  for (const { status, path: p } of diff) {
    if (status !== 'A') continue;
    const m = /^gsd-core\/workflows\/([^/]+)\/detail\/[^/]+\.md$/.exec(p);
    if (m) newlySplitNames.add(m[1]);
  }
  for (const name of newlySplitNames) {
    const split = splits.find((s) => s.name === name);
    if (!split) continue;
    const spineRel = toRepoRelative(split.spinePath);
    const oldSpineContent = showAtRefOrNull(mergeBaseSha, spineRel);
    const newSpineContent = fs.readFileSync(split.spinePath, 'utf8');
    const newDetailContents = split.detailPaths.map((p) => fs.readFileSync(p, 'utf8'));
    completeness.push(
      ...checkCompletenessForPair({ splitName: name, oldSpineContent, newSpineContent, newDetailContents }),
    );
  }

  // Checks 4 + 5: every registered split NOT already counted as newly-split above (an
  // untouched spine trivially produces zero violations either way, since old === new
  // content — see the file header).
  //
  // A split in `newlySplitNames` is excluded here, not merely redundant with check 1.
  // Checks 4/5 both premise an OLD spine that already carried the content in question —
  // "did an EXISTING split shed protected content or move something undeclared". A
  // split whose detail path did not exist at the resolved base has no such premise: it
  // is brand new relative to that base, which is check 1's domain alone. This also
  // makes checks 4/5 robust to a base ref that resolves further back than expected (a
  // known class of gotcha `resolveBase()`'s own doc comment describes — no `origin/*`
  // remote-tracking refs inside the gsd-test sandbox): a stale/older base makes an
  // already-merged, already-reviewed split look "newly introduced" from that base's
  // vantage point, and retroactively demanding a Boundary-Move-Declared trailer for a
  // split that predates the trailer mechanism's own existence is exactly the false
  // positive this exclusion prevents. Verified against the real repo: plan-phase's
  // split (Phase 2, #4402) landed before this PR (#4403) introduces Boundary-Move-Declared
  // at all, so it must never be checked against that requirement retroactively.
  for (const split of splits) {
    if (newlySplitNames.has(split.name)) continue;
    const spineRel = toRepoRelative(split.spinePath);
    const oldSpineContent = showAtRefOrNull(mergeBaseSha, spineRel);
    if (oldSpineContent === null) continue; // no old spine to compare against at this ref
    const newSpineContent = fs.readFileSync(split.spinePath, 'utf8');
    const detailPathToContent = new Map(split.detailPaths.map((p) => [toRepoRelative(p), fs.readFileSync(p, 'utf8')]));

    const protectedViolations = checkProtectedContentForPair({
      splitName: split.name,
      oldSpineContent,
      newSpineContent,
      detailPathToContent,
    });
    protectedContent.push(...protectedViolations);

    const excludeLines = new Set(protectedViolations.map((v) => v.line));
    const oldDetailContentByPath = new Map();
    for (const relPath of detailPathToContent.keys()) {
      oldDetailContentByPath.set(relPath, showAtRefOrNull(mergeBaseSha, relPath));
    }
    boundaryMoves.push(
      ...checkBoundaryMovesForSplit({
        splitName: split.name,
        spineRelPath: spineRel,
        oldSpineContent,
        newSpineContent,
        oldDetailContentByPath,
        newDetailContentByPath: detailPathToContent,
        excludeLines,
        baseRef: base.ref,
        cwd: REPO_ROOT,
      }),
    );
  }

  return { skipped: false, completeness, protectedContent, boundaryMoves };
}

// ─── real-repo assertions (checks 2/3 unconditional; 1/4/5 PR-diff-scoped) ────────────

describe('compact-content partition guard — real repo state (ADR-4139 Decision 5, #4403)', () => {
  test('check 2 (disjointness): no non-trivial line duplicated between any spine and its detail parts', () => {
    const splits = discoverRegisteredSplits().filter((s) => s.spineExists);
    const violations = checkDisjointness(splits);
    assert.deepStrictEqual(violations, [], `disjointness violations: ${JSON.stringify(violations, null, 2)}`);
  });

  test('check 3 (registration): every split is paired, referenced, and has no dangling reference', () => {
    const splits = discoverRegisteredSplits();
    const violations = checkRegistration(splits, DEFAULT_WORKFLOWS_DIR);
    assert.deepStrictEqual(violations, [], `registration violations: ${JSON.stringify(violations, null, 2)}`);
  });

  test('check 3 (size cap): every detail file is under NEW_FILE_CAP', () => {
    const splits = discoverRegisteredSplits().filter((s) => s.spineExists);
    const violations = checkDetailFileSizeCap(splits);
    assert.deepStrictEqual(violations, [], `size-cap violations: ${JSON.stringify(violations, null, 2)}`);
  });

  test('checks 1, 4, 5: PR-diff-scoped checks against the resolved base ref (skips cleanly when unresolvable)', () => {
    const result = runPrDiffScopedChecks();
    if (result.skipped) {
      // Ambient guard: nothing to compare (no origin/next, no computable merge-base, no
      // readable diff). Not a failure — see the file header for why this is different
      // from check 5's own uncomputable-range throw.
      return;
    }
    assert.deepStrictEqual(
      result.completeness, [],
      `completeness (check 1) violations: ${JSON.stringify(result.completeness, null, 2)}`,
    );
    assert.deepStrictEqual(
      result.protectedContent, [],
      `protected-content (check 4) violations: ${JSON.stringify(result.protectedContent, null, 2)}`,
    );
    assert.deepStrictEqual(
      result.boundaryMoves, [],
      `undeclared boundary-move (check 5) violations: ${JSON.stringify(result.boundaryMoves, null, 2)}`,
    );
  });

  test('plan-phase spine references the shared compact-content gate exactly once (real-repo sanity, folded in from the retired pilot test)', () => {
    const spine = fs.readFileSync(path.join(DEFAULT_WORKFLOWS_DIR, 'plan-phase.md'), 'utf8');
    const matches = spine.match(/compact-content-gate\.md/g) || [];
    assert.strictEqual(matches.length, 1, `expected exactly one reference to compact-content-gate.md, found ${matches.length}`);
  });

  test('every registered spine has no malformed gsd:protected sentinel', () => {
    const splits = discoverRegisteredSplits().filter((s) => s.spineExists);
    for (const split of splits) {
      const { malformed } = extractProtectedBlocks(fs.readFileSync(split.spinePath, 'utf8'));
      assert.deepStrictEqual(
        malformed, [],
        `${split.spinePath} has malformed gsd:protected sentinel(s): ${JSON.stringify(malformed, null, 2)}`,
      );
    }
  });

  test('plan-phase spine: protected-block count and the four named categories are represented (real-repo sanity, folded in from the retired pilot test)', () => {
    const spinePath = path.join(DEFAULT_WORKFLOWS_DIR, 'plan-phase.md');
    const spine = fs.readFileSync(spinePath, 'utf8');
    const { blocks, malformed } = extractProtectedBlocks(spine);
    assert.deepStrictEqual(malformed, []);
    const paired = blocks.filter((b) => b.kind === 'paired');
    const single = blocks.filter((b) => b.kind === 'single');
    assert.ok(paired.length >= 4, `expected at least 4 paired protected blocks, found ${paired.length}`);
    assert.ok(single.length >= 2, `expected at least 2 single-line protected markers, found ${single.length}`);

    // Output-format contracts:
    assert.match(spine, /<!-- gsd:protected:start -->\s*<quality_gate>/, 'quality_gate output-format contract must be protected');
    assert.match(spine, /<!-- gsd:protected:start -->\s*<success_criteria>/, 'success_criteria output-format contract must be protected');
    assert.match(spine, /<!-- gsd:protected:start -->\s*<downstream_consumer>/, 'downstream_consumer output-format contract must be protected');
    // Few-shot example the workflow's own steps depend on:
    assert.match(spine, /<!-- gsd:protected:start -->\s*<failing_direction_contract>/, 'failing_direction_contract few-shot example must be protected');
    // Negative instruction / guardrail:
    const guardrailCount = (spine.match(/<!-- gsd:protected -->\s*> \*\*ORCHESTRATOR RULE[^]*?Never call `ScheduleWakeup`/g) || []).length;
    assert.strictEqual(guardrailCount, 2, `expected 2 protected ScheduleWakeup guardrail paragraphs, found ${guardrailCount}`);
  });
});

// ─── failing-first fixtures: one describe block per check, RED then GREEN ─────────────

describe('failing-first fixture: check 1 (completeness)', () => {
  test('RED — a line from the old spine is missing from the new spine+detail union, and the spine did not shrink', () => {
    const oldSpineContent = 'Intro line.\n\nCritical instruction not carried over.\n\nClosing line.\n';
    const newSpineContent = 'Intro line.\n\nClosing line.\n';
    const newDetailContents = ['Some unrelated detail content.\n'];
    const violations = checkCompletenessForPair({
      splitName: 'broken-split', oldSpineContent, newSpineContent, newDetailContents,
    });
    assert.ok(violations.length > 0, 'expected at least one completeness violation');
    assert.ok(
      violations.some((v) => v.kind === 'incomplete_split' && v.line === 'Critical instruction not carried over.'),
      `expected the missing line to be named: ${JSON.stringify(violations)}`,
    );
  });

  test('GREEN — the union carries every old line and the spine shrank', () => {
    const oldSpineContent = 'Intro line.\n\nCritical instruction not carried over.\n\nClosing line.\n';
    const newSpineContent = 'Intro line.\n\nClosing line.\n';
    const newDetailContents = ['Critical instruction not carried over.\n'];
    const violations = checkCompletenessForPair({
      splitName: 'fixed-split', oldSpineContent, newSpineContent, newDetailContents,
    });
    assert.deepStrictEqual(violations, []);
  });
});

describe('failing-first fixture: check 2 (disjointness)', () => {
  test('RED — a non-trivial line appears in both the spine and a detail part', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-partition-disjoint-'));
    try {
      const workflowsDir = path.join(tmpRoot, 'gsd-core', 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'dup', 'detail'), { recursive: true });
      const duplicatedLine = 'This exact sentence must never appear twice across the split.';
      fs.writeFileSync(path.join(workflowsDir, 'dup.md'), `Spine intro.\n\n${duplicatedLine}\n\ngsd-core/workflows/dup/detail/part.md\n`);
      fs.writeFileSync(path.join(workflowsDir, 'dup', 'detail', 'part.md'), `Detail intro.\n\n${duplicatedLine}\n`);

      const splits = discoverRegisteredSplits(workflowsDir).filter((s) => s.spineExists);
      const violations = checkDisjointness(splits);
      assert.ok(violations.length > 0, 'expected at least one disjointness violation');
      assert.ok(
        violations.some((v) => v.line === duplicatedLine),
        `expected the duplicated line to be named: ${JSON.stringify(violations)}`,
      );
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('GREEN — the same line, rewritten distinctly on each side, is disjoint', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-partition-disjoint-ok-'));
    try {
      const workflowsDir = path.join(tmpRoot, 'gsd-core', 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'dup', 'detail'), { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'dup.md'), 'Spine intro.\n\nSpine-only sentence.\n\ngsd-core/workflows/dup/detail/part.md\n');
      fs.writeFileSync(path.join(workflowsDir, 'dup', 'detail', 'part.md'), 'Detail intro.\n\nDetail-only sentence.\n');

      const splits = discoverRegisteredSplits(workflowsDir).filter((s) => s.spineExists);
      const violations = checkDisjointness(splits);
      assert.deepStrictEqual(violations, []);
    } finally {
      cleanup(tmpRoot);
    }
  });
});

describe('failing-first fixture: check 3 (registration)', () => {
  test('RED — a detail/*.md exists with no matching spine (orphan)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-partition-orphan-'));
    try {
      const workflowsDir = path.join(tmpRoot, 'gsd-core', 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'orphan', 'detail'), { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'orphan', 'detail', 'part.md'), 'Orphaned detail content.\n');

      const splits = discoverRegisteredSplits(workflowsDir);
      const violations = checkRegistration(splits, workflowsDir);
      assert.ok(violations.length > 0, 'expected at least one registration violation');
      assert.ok(
        violations.some((v) => v.kind === 'orphan_detail' && v.name === 'orphan'),
        `expected the orphan split to be named: ${JSON.stringify(violations)}`,
      );
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('GREEN — a spine is added that references the detail part by its full repo-relative path', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-partition-orphan-ok-'));
    try {
      const workflowsDir = path.join(tmpRoot, 'gsd-core', 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'orphan', 'detail'), { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'orphan', 'detail', 'part.md'), 'Orphaned detail content.\n');
      fs.writeFileSync(
        path.join(workflowsDir, 'orphan.md'),
        'Spine intro.\n\nSee gsd-core/workflows/orphan/detail/part.md for elaboration.\n',
      );

      const splits = discoverRegisteredSplits(workflowsDir);
      const violations = checkRegistration(splits, workflowsDir);
      assert.deepStrictEqual(violations, []);
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('RED (size cap) — a new detail file at or over NEW_FILE_CAP', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-partition-sizecap-'));
    try {
      const workflowsDir = path.join(tmpRoot, 'gsd-core', 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'big', 'detail'), { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'big.md'), 'Spine.\n\ngsd-core/workflows/big/detail/part.md\n');
      fs.writeFileSync(path.join(workflowsDir, 'big', 'detail', 'part.md'), 'x'.repeat(NEW_FILE_CAP));

      const splits = discoverRegisteredSplits(workflowsDir).filter((s) => s.spineExists);
      const violations = checkDetailFileSizeCap(splits);
      assert.ok(violations.length > 0, 'expected at least one size-cap violation');
      assert.ok(
        violations.some((v) => v.detailPath.endsWith(path.join('big', 'detail', 'part.md'))),
        `expected the oversized file to be named: ${JSON.stringify(violations)}`,
      );
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('GREEN (size cap) — the same detail file kept just under NEW_FILE_CAP', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-partition-sizecap-ok-'));
    try {
      const workflowsDir = path.join(tmpRoot, 'gsd-core', 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'big', 'detail'), { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'big.md'), 'Spine.\n\ngsd-core/workflows/big/detail/part.md\n');
      fs.writeFileSync(path.join(workflowsDir, 'big', 'detail', 'part.md'), 'x'.repeat(NEW_FILE_CAP - 1));

      const splits = discoverRegisteredSplits(workflowsDir).filter((s) => s.spineExists);
      const violations = checkDetailFileSizeCap(splits);
      assert.deepStrictEqual(violations, []);
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('RED (size cap) — a new detail file one byte OVER NEW_FILE_CAP (the third boundary point)', () => {
    // Boundary coverage requires limit-1 / limit / limit+1 (CLAUDE.md TEST RULES).
    // The two tests above already cover limit-1 (GREEN) and limit exactly (RED,
    // ">= NEW_FILE_CAP" boundary); this is the third point, proving the cap does
    // not silently stop firing past its own threshold.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-partition-sizecap-over-'));
    try {
      const workflowsDir = path.join(tmpRoot, 'gsd-core', 'workflows');
      fs.mkdirSync(path.join(workflowsDir, 'big', 'detail'), { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'big.md'), 'Spine.\n\ngsd-core/workflows/big/detail/part.md\n');
      fs.writeFileSync(path.join(workflowsDir, 'big', 'detail', 'part.md'), 'x'.repeat(NEW_FILE_CAP + 1));

      const splits = discoverRegisteredSplits(workflowsDir).filter((s) => s.spineExists);
      const violations = checkDetailFileSizeCap(splits);
      assert.ok(violations.length > 0, 'expected at least one size-cap violation');
      assert.ok(
        violations.some((v) => v.detailPath.endsWith(path.join('big', 'detail', 'part.md')) && v.size === NEW_FILE_CAP + 1),
        `expected the oversized file to be named with its actual size: ${JSON.stringify(violations)}`,
      );
    } finally {
      cleanup(tmpRoot);
    }
  });
});

describe('failing-first fixture: check 4 (protected content)', () => {
  const oldSpineWithProtection =
    'Intro.\n\n<!-- gsd:protected -->\n> Never do the dangerous thing.\n\nMiddle prose.\n';

  test('RED — a protected line is deleted from the spine entirely', () => {
    const newSpineContent = 'Intro.\n\nMiddle prose.\n';
    const violations = checkProtectedContentForPair({
      splitName: 'broken-split',
      oldSpineContent: oldSpineWithProtection,
      newSpineContent,
      detailPathToContent: new Map(),
    });
    assert.ok(violations.length > 0, 'expected at least one protected-content violation');
    const v = violations.find((x) => x.line === '> Never do the dangerous thing.');
    assert.ok(v, `expected the deleted protected line to be named: ${JSON.stringify(violations)}`);
    assert.strictEqual(v.kind, 'protected_deleted');
  });

  test('RED (relocated) — a protected line moved into a detail part is reported distinctly, not merely "deleted"', () => {
    const newSpineContent = 'Intro.\n\nMiddle prose.\n';
    const detailPathToContent = new Map([
      ['gsd-core/workflows/broken/detail/part.md', 'Detail intro.\n\n> Never do the dangerous thing.\n'],
    ]);
    const violations = checkProtectedContentForPair({
      splitName: 'broken-split',
      oldSpineContent: oldSpineWithProtection,
      newSpineContent,
      detailPathToContent,
    });
    const v = violations.find((x) => x.line === '> Never do the dangerous thing.');
    assert.ok(v, `expected the relocated protected line to be named: ${JSON.stringify(violations)}`);
    assert.strictEqual(v.kind, 'protected_relocated');
    assert.strictEqual(v.relocatedTo, 'gsd-core/workflows/broken/detail/part.md');
  });

  test('GREEN — the protected line is still physically present in the spine', () => {
    const newSpineContent = 'Intro.\n\n<!-- gsd:protected -->\n> Never do the dangerous thing.\n\nMiddle prose.\n';
    const violations = checkProtectedContentForPair({
      splitName: 'fixed-split',
      oldSpineContent: oldSpineWithProtection,
      newSpineContent,
      detailPathToContent: new Map(),
    });
    assert.deepStrictEqual(violations, []);
  });
});

describe('failing-first fixture: check 5 (boundary moves declared)', () => {
  /** A throwaway git repo, mirroring the makeTempRepo idiom in
   *  tests/emitted-ack-trailer.test.cjs (this module's `readBoundaryMoveTrailers` sibling
   *  under tests/helpers/compact-content-split.cjs is a direct port of that same
   *  mechanism, so the fixture idiom mirrors it byte-for-byte). */
  function makeTempRepo(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    gitOrThrow(['init', '-q', '-b', 'main'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    gitOrThrow(['config', 'user.email', 'partition-guard-fixture@example.com'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    gitOrThrow(['config', 'user.name', 'Partition Guard Fixture'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    return dir;
  }

  /** Commit from a message written to a file (never `-m`), so a trailer block lands where
   *  git's own trailer parser expects it — same reasoning as emitted-ack-trailer.test.cjs. */
  function commitMessage(dir, message) {
    const msgFile = path.join(os.tmpdir(), `gsd-partition-guard-msg-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(msgFile, message);
    try {
      gitOrThrow(['add', '-A'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
      gitOrThrow(['commit', '-q', '-F', msgFile], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    } finally {
      cleanup(msgFile);
    }
  }

  function headSha(dir) {
    return gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS }).trim();
  }

  const SPINE_KEY = 'gsd-core/workflows/spine.md'; // the trailer key our fixture declares against

  test('RED — a line moved from spine to detail with no Boundary-Move-Declared trailer', (t) => {
    const dir = makeTempRepo('gsd-partition-boundary-red-');
    t.after(() => cleanup(dir));

    fs.writeFileSync(path.join(dir, 'spine.md'), 'Line A.\n\nOrdinary line that will move.\n\nLine C.\n');
    fs.writeFileSync(path.join(dir, 'detail.md'), 'Line D.\n');
    commitMessage(dir, 'init\n\nbaseline, no move yet\n');
    const baseSha = headSha(dir);

    const oldSpineContent = fs.readFileSync(path.join(dir, 'spine.md'), 'utf8');
    const oldDetailContent = fs.readFileSync(path.join(dir, 'detail.md'), 'utf8');

    fs.writeFileSync(path.join(dir, 'spine.md'), 'Line A.\n\nLine C.\n');
    fs.writeFileSync(path.join(dir, 'detail.md'), 'Line D.\n\nOrdinary line that will move.\n');
    commitMessage(dir, 'move a line without declaring it\n\nno trailer here\n');

    const newSpineContent = fs.readFileSync(path.join(dir, 'spine.md'), 'utf8');
    const newDetailContent = fs.readFileSync(path.join(dir, 'detail.md'), 'utf8');

    const violations = checkBoundaryMovesForSplit({
      splitName: 'spine',
      spineRelPath: SPINE_KEY,
      oldSpineContent,
      newSpineContent,
      oldDetailContentByPath: new Map([['detail.md', oldDetailContent]]),
      newDetailContentByPath: new Map([['detail.md', newDetailContent]]),
      excludeLines: new Set(),
      baseRef: baseSha,
      cwd: dir,
    });

    assert.ok(violations.length > 0, 'expected an undeclared boundary-move violation');
    const v = violations.find((x) => x.line === 'Ordinary line that will move.');
    assert.ok(v, `expected the moved line to be named: ${JSON.stringify(violations)}`);
    assert.strictEqual(v.kind, 'undeclared_boundary_move');
    assert.strictEqual(v.spinePath, SPINE_KEY);
  });

  test('GREEN — the same move, with a Boundary-Move-Declared trailer naming the spine', (t) => {
    const dir = makeTempRepo('gsd-partition-boundary-green-');
    t.after(() => cleanup(dir));

    fs.writeFileSync(path.join(dir, 'spine.md'), 'Line A.\n\nOrdinary line that will move.\n\nLine C.\n');
    fs.writeFileSync(path.join(dir, 'detail.md'), 'Line D.\n');
    commitMessage(dir, 'init\n\nbaseline, no move yet\n');
    const baseSha = headSha(dir);

    const oldSpineContent = fs.readFileSync(path.join(dir, 'spine.md'), 'utf8');
    const oldDetailContent = fs.readFileSync(path.join(dir, 'detail.md'), 'utf8');

    fs.writeFileSync(path.join(dir, 'spine.md'), 'Line A.\n\nLine C.\n');
    fs.writeFileSync(path.join(dir, 'detail.md'), 'Line D.\n\nOrdinary line that will move.\n');
    commitMessage(
      dir,
      `move a line and declare it\n\nBoundary-Move-Declared: ${SPINE_KEY} — moved to detail deliberately, #4403\n`,
    );

    const newSpineContent = fs.readFileSync(path.join(dir, 'spine.md'), 'utf8');
    const newDetailContent = fs.readFileSync(path.join(dir, 'detail.md'), 'utf8');

    const violations = checkBoundaryMovesForSplit({
      splitName: 'spine',
      spineRelPath: SPINE_KEY,
      oldSpineContent,
      newSpineContent,
      oldDetailContentByPath: new Map([['detail.md', oldDetailContent]]),
      newDetailContentByPath: new Map([['detail.md', newDetailContent]]),
      excludeLines: new Set(),
      baseRef: baseSha,
      cwd: dir,
    });

    assert.deepStrictEqual(violations, []);
  });

  test('uncomputable range still throws through checkBoundaryMovesForSplit (never silently passes)', (t) => {
    const origin = makeTempRepo('gsd-partition-boundary-origin-');
    t.after(() => cleanup(origin));
    fs.writeFileSync(path.join(origin, 'spine.md'), 'Line A.\n\nOrdinary line that will move.\n');
    commitMessage(origin, 'origin A\n\nfirst commit\n');
    const shaA = headSha(origin);
    fs.writeFileSync(path.join(origin, 'spine.md'), 'Line A.\n\nOrdinary line that will move.\n\nLine B.\n');
    commitMessage(origin, 'origin B\n\nsecond commit\n');

    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-partition-boundary-clone-'));
    t.after(() => cleanup(clone));
    gitOrThrow(['clone', '-q', '--depth', '1', `file://${origin}`, clone], { cwd: origin, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });

    assert.throws(
      () => checkBoundaryMovesForSplit({
        splitName: 'spine',
        spineRelPath: SPINE_KEY,
        oldSpineContent: 'Line A.\n\nOrdinary line that will move.\n',
        newSpineContent: 'Line A.\n',
        oldDetailContentByPath: new Map(),
        newDetailContentByPath: new Map([['detail.md', 'Ordinary line that will move.\n']]),
        excludeLines: new Set(),
        baseRef: shaA,
        cwd: clone,
      }),
      /./,
      'a genuinely uncomputable merge-base must throw, never return an empty result',
    );
  });
});

// ─── property tests (CLAUDE.md TEST RULES: parsers/bijective contracts need fast-check) ─

describe('property: compact-content-split.cjs parsers', () => {
  // Same alphabets as the ADR-3942 sibling this trailer mechanism ports from
  // (tests/emitted-ack-trailer.test.cjs's KEY_ALPHABET/REASON_ALPHABET) — neither
  // alphabet can produce ACK_TRAILER_DELIM itself, so a generated key/reason pair
  // never accidentally embeds a second delimiter and corrupts its own round trip.
  const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789_./-'.split('');
  const REASON_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.#-'.split('');

  const keyArb = fc.array(fc.constantFrom(...KEY_ALPHABET), { minLength: 1, maxLength: 40 })
    .map((chars) => chars.join(''));
  const reasonArb = fc.array(fc.constantFrom(...REASON_ALPHABET), { minLength: 1, maxLength: 60 })
    .map((chars) => chars.join('').trim())
    .filter((s) => s.length > 0);

  test('prop: Boundary-Move-Declared trailer render/parse is bijective', () => {
    fc.assert(
      fc.property(keyArb, reasonArb, (key, reason) => {
        const rendered = `${key}${ACK_TRAILER_DELIM}${reason}`;
        const { declarations, errors } = parseBoundaryMoveTrailerValues([rendered]);
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(declarations.get(key)?.reason, reason);
      }),
      { seed: 4403, numRuns: 300 },
    );
  });

  test('prop: two identical (key, reason) declarations always dedupe to exactly one entry, never an error', () => {
    fc.assert(
      fc.property(keyArb, reasonArb, (key, reason) => {
        const rendered = `${key}${ACK_TRAILER_DELIM}${reason}`;
        const { declarations, errors } = parseBoundaryMoveTrailerValues([rendered, rendered]);
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(declarations.size, 1);
        assert.strictEqual(declarations.get(key)?.reason, reason);
      }),
      { seed: 4403, numRuns: 200 },
    );
  });

  // Body lines deliberately exclude anything sentinel-shaped or blank, so the
  // generated fixture can never accidentally produce a SECOND sentinel or an
  // early terminator inside what is meant to be one continuous protected span.
  const bodyLineArb = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,'.split('')), { minLength: 1, maxLength: 30 })
    .map((chars) => chars.join('').trim())
    .filter((s) => s.length > 0 && !s.includes('gsd:protected'));

  test('prop: any well-formed <!-- gsd:protected:start/end --> span round-trips through extractProtectedBlocks with zero malformed entries', () => {
    fc.assert(
      fc.property(fc.array(bodyLineArb, { minLength: 1, maxLength: 8 }), (lines) => {
        const content = ['Intro prose.', '', '<!-- gsd:protected:start -->', ...lines, '<!-- gsd:protected:end -->', '', 'Closing prose.'].join('\n');
        const { blocks, malformed } = extractProtectedBlocks(content);
        assert.deepStrictEqual(malformed, []);
        const paired = blocks.filter((b) => b.kind === 'paired');
        assert.strictEqual(paired.length, 1);
        assert.deepStrictEqual(paired[0].lines, lines);
      }),
      { seed: 4403, numRuns: 200 },
    );
  });
});
