/**
 * Task command router — is-behavior-adding subcommand handler.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/task-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON } = ioMod;
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import redEvidencePredicateMod = require('./red-evidence-predicate.cjs');
const { evaluateRedEvidence } = redEvidencePredicateMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planDocumentMod = require('./plan-document.cjs');
const { parsePlanDocument } = planDocumentMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityLoaderMod = require('./capability-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import taskContentResolutionMod = require('./task-content-resolution.cjs');
const {
  resolveTaskContent,
  ResolverAmbiguousError,
  ResolverFailedError,
  ResolverTimeoutError,
  ResolverMalformedOutputError,
} = taskContentResolutionMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BehaviorAddingChecks {
  tdd_true: boolean;
  has_behavior_block: boolean;
  has_source_files: boolean;
}

interface BehaviorAddingResult {
  is_behavior_adding: boolean;
  checks: BehaviorAddingChecks;
  reason: string | null;
}

interface RouteTaskCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
}

interface PlanTaskLike {
  trackerId: string | null;
}

interface CapabilityLike {
  id: string;
  taskContentResolver?: unknown;
}

/**
 * Testability seam for `routeResolveContent` (mirrors this codebase's other
 * routers' `_`-prefixed injection convention, e.g.
 * `refactor-trigger-command-router.cts`'s `_git`/`_windows`/`_core`).
 * Production callers omit both fields.
 */
interface ResolveContentDeps {
  loadCapabilities?: (cwd: string) => CapabilityLike[];
  resolveTaskContentFn?: typeof resolveTaskContent;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function isBehaviorAddingTaskContent(content: string): BehaviorAddingResult {
  const tddTrue = /\btdd\s*=\s*["']true["']/i.test(content);

  const behaviorMatch = content.match(/<behavior>([\s\S]*?)<\/behavior>/i);
  const hasBehaviorBlock = Boolean(behaviorMatch && behaviorMatch[1].trim().length > 0);

  const filesMatch = content.match(/<files>([\s\S]*?)<\/files>/i);
  let hasSourceFiles = false;
  if (filesMatch) {
    const fileLines = filesMatch[1]
      .split(/[\n,]/)
      .map((line) => line.trim().replace(/^[-*]\s*/, ''))
      .filter(Boolean);
    hasSourceFiles = fileLines.some((file) =>
      !/\.md$/i.test(file) &&
      !/\.json$/i.test(file) &&
      !/\.test\.[^.]+$/i.test(file) &&
      !/\.spec\.[^.]+$/i.test(file) &&
      !/(^|[\\/])tests?[\\/]/i.test(file) &&
      !/\.(yml|yaml|toml|ini|cfg|conf|properties)$/i.test(file) &&
      !/(^|[\\/])\.env(\..+)?$/i.test(file)
    );
  }

  const isBehaviorAdding = tddTrue && hasBehaviorBlock && hasSourceFiles;
  const missing: string[] = [];
  if (!tddTrue) missing.push('tdd="true" frontmatter absent');
  if (!hasBehaviorBlock) missing.push('<behavior> block missing or empty');
  if (!hasSourceFiles) missing.push('<files> has no non-test source file');

  return {
    is_behavior_adding: isBehaviorAdding,
    checks: {
      tdd_true: tddTrue,
      has_behavior_block: hasBehaviorBlock,
      has_source_files: hasSourceFiles,
    },
    reason: isBehaviorAdding ? null : `Not behavior-adding: ${missing.join('; ')}`,
  };
}

/**
 * Default (production) capability loader for `resolve-content`: the merged
 * first-party + validated-installed-overlay registry (ADR-1244 D2), the
 * established runtime read path for "installed capabilities including
 * third-party" — as opposed to `capability-loader.cts`'s heavier build-time
 * validation entry points or the static `capability-registry.cjs` alone
 * (first-party only, would miss a third-party capability's
 * `taskContentResolver` declaration entirely).
 */
function defaultLoadCapabilities(cwd: string): CapabilityLike[] {
  const registry = capabilityLoaderMod.loadRegistry({ includeInstalled: true, cwd }) as {
    capabilities?: Record<string, CapabilityLike>;
  };
  return Object.values(registry.capabilities ?? {});
}

function parseResolveContentArgs(args: string[]): { plan: string | null; taskId: string | null } {
  let plan: string | null = null;
  let taskId: string | null = null;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--plan') {
      plan = args[i + 1] ?? null;
      i++;
    } else if (args[i] === '--task-id') {
      taskId = args[i + 1] ?? null;
      i++;
    }
  }
  return { plan, taskId };
}

/**
 * `task resolve-content --plan <PLAN.md path> --task-id <tracker-id value> --raw`
 * (ADR-3646 Decision 2). Resolves one task's content from the external
 * tracker its `tracker-id` attribute names, via `task-content-resolution.cts`.
 *
 * HARD-HALT CONTRACT: a thrown `ResolverAmbiguousError` / `ResolverFailedError`
 * / `ResolverTimeoutError` / `ResolverMalformedOutputError` from
 * `resolveTaskContent` is turned into this CLI's own non-zero exit via
 * `error()` — never swallowed into a `{resolved: false}` JSON answer. Any
 * other thrown error is not one of the four documented resolver-error
 * classes and is allowed to propagate uncaught.
 */
function routeResolveContent(
  { args, cwd, raw }: RouteTaskCommandOptions,
  deps: ResolveContentDeps = {},
): void {
  const usage = 'Usage: task resolve-content --plan <path> --task-id <tracker-id> --raw';
  const { plan, taskId } = parseResolveContentArgs(args);
  if (!plan || !taskId) {
    error(usage, ERROR_REASON.USAGE);
    return;
  }

  const projectRoot = path.resolve(cwd || process.cwd());
  const resolvedPlanPath = path.resolve(projectRoot, plan);
  const rel = path.relative(projectRoot, resolvedPlanPath);
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) {
    error(`Plan file is outside project scope: ${plan}`, ERROR_REASON.USAGE);
    return;
  }
  if (!fs.existsSync(resolvedPlanPath)) {
    error(`Plan file not found: ${plan}`, ERROR_REASON.USAGE);
    return;
  }

  const planContent = fs.readFileSync(resolvedPlanPath, 'utf-8');
  const parsedPlan = parsePlanDocument(planContent, resolvedPlanPath) as { tasks?: PlanTaskLike[] };
  const task = (parsedPlan.tasks ?? []).find((t) => t.trackerId === taskId);
  if (!task) {
    error(`No task with tracker-id '${taskId}' found in plan: ${plan}`, ERROR_REASON.USAGE);
    return;
  }

  const loadCapabilities = deps.loadCapabilities ?? defaultLoadCapabilities;
  const capabilities = loadCapabilities(projectRoot);
  const resolveFn = deps.resolveTaskContentFn ?? resolveTaskContent;

  let result;
  try {
    result = resolveFn({ trackerId: task.trackerId, capabilities });
  } catch (err) {
    if (
      err instanceof ResolverAmbiguousError ||
      err instanceof ResolverFailedError ||
      err instanceof ResolverTimeoutError ||
      err instanceof ResolverMalformedOutputError
    ) {
      error((err as Error).message, ERROR_REASON.UNKNOWN);
      return;
    }
    throw err;
  }

  switch (result.kind) {
    case 'not-applicable':
      output({ resolved: false }, raw, undefined);
      return;
    case 'no-resolver':
      output({ resolved: false, reason: 'no-resolver' }, raw, undefined);
      return;
    case 'empty':
      output({ resolved: false, reason: 'empty' }, raw, undefined);
      return;
    case 'resolved':
      output({ resolved: true, content: result.content }, raw, undefined);
      return;
  }
}

/**
 * `task red-evidence-verdict --task-file <path> --trailer <json> --pick verdict`
 * (#3770 Phase 3). Reads the task file and forwards its raw text, plus the
 * raw `--trailer` text, to `evaluateRedEvidence` — this arm does argument
 * parsing, the call and printing, nothing else (D-17); every JSON parse and
 * key-set check lives in the pure evaluator module.
 */
function routeRedEvidenceVerdict({ args, cwd, raw }: RouteTaskCommandOptions): void {
  const opts = parseNamedArgsOrExit(
    args,
    { valueFlags: ['task-file', 'trailer', 'changed-files'], positionals: 2 },
    error,
  );
  const taskFile = opts['task-file'];
  const trailer = opts['trailer'];
  if (typeof taskFile !== 'string' || taskFile.length === 0) {
    error('--task-file <path> is required for `task red-evidence-verdict`', ERROR_REASON.USAGE);
    return;
  }
  if (typeof trailer !== 'string') {
    error('--trailer <json> is required for `task red-evidence-verdict`', ERROR_REASON.USAGE);
    return;
  }

  // Resolve symlinks on BOTH sides before comparing: `path.resolve` does not,
  // so a symlink planted inside the repo would pass a containment check done on
  // the unresolved path and then be read anyway. `statSync().isFile()` subsumes
  // the existence check and additionally rejects a directory, which would
  // otherwise reach `readFileSync` and throw EISDIR out of a module documented
  // as never throwing.
  let projectRoot: string;
  let realTaskPath: string;
  try {
    projectRoot = fs.realpathSync(path.resolve(cwd || process.cwd()));
    realTaskPath = fs.realpathSync(path.resolve(projectRoot, taskFile));
    if (!fs.statSync(realTaskPath).isFile()) throw new Error('not a regular file');
  } catch {
    error(`Task file not found: ${taskFile}`, ERROR_REASON.USAGE);
    return;
  }
  const rel = path.relative(projectRoot, realTaskPath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    error(`Task file is outside project scope: ${taskFile}`, ERROR_REASON.USAGE);
    return;
  }
  const taskContent = fs.readFileSync(realTaskPath, 'utf-8');

  // Placed AFTER the path guards above, deliberately: the two existing
  // cases in tests/red-evidence-verdict-cli.test.cjs invoke this arm with a
  // deliberately bad --task-file and NO --changed-files, and assert on the
  // path guards' own messages. A usage check placed earlier would report
  // "--changed-files is required" first and turn both into casualties of
  // an argument-order choice (#3770 D-1 revised, T-04.1-04).
  const changedFiles = opts['changed-files'];
  if (typeof changedFiles !== 'string') {
    error(
      '--changed-files <newline-delimited paths> is required for `task red-evidence-verdict`',
      ERROR_REASON.USAGE,
    );
    return;
  }

  const result = evaluateRedEvidence(taskContent, trailer);
  if (result.verdict === 'authorize' && typeof result.declared_file === 'string'
    && !changedFilesInclude(changedFiles, result.declared_file)) {
    output({
      verdict: 'red_commit_not_failing',
      reason: `the commit's changed files do not include "${result.declared_file}", the file `
        + 'the red-evidence trailer itself declares — matched by path segment',
    }, raw, undefined);
    return;
  }

  output(result, raw, undefined);
}

/**
 * Does `changedFilesText` (newline-delimited, as `git show --name-only`
 * emits) contain the file `declaredFile` names? Path-segment matching:
 * equality, or either side being a `/`-anchored suffix of the other, with
 * separators normalized first (#3770 D-1 revised; tightened for
 * gsd-core-vlh / WR-01).
 *
 * Matching is bidirectional because the declared path is authored by hand
 * and may be shorter OR longer than git's repo-relative output — both are
 * frozen as authorizing rows in `MEMBERSHIP_ROWS`
 * (`tests/executor-mvp-tdd-section.test.cjs:2733`): a bare basename
 * (`test_pricing.py`) is shorter, an absolute build path
 * (`/srv/build/tests/test_pricing.py`) is longer. Anchoring on `/` is what
 * makes it a path-segment rule rather than a string one, so
 * `tests/test_shipping.py` cannot match `tests/test_pricing.py`.
 *
 * Residual, deliberately accepted, and narrower than it first shipped: a
 * DECLARATION that is a bare basename still matches that basename at any
 * depth, because a bare basename does not identify a directory, and
 * `MEMBERSHIP_ROWS` freezes that form as authorizing. Nothing else is
 * accepted — a declaration carrying directory segments is matched on those
 * segments, whether the decoy sits in another directory (WR-01) or at the
 * repo root as a bare name (gsd-core-ifc).
 *
 * This deliberately does NOT reuse `locationsAgree`'s `path.win32.basename`
 * reduction, which it previously borrowed. The two comparisons have
 * different inputs and therefore need different rules: `locationsAgree`
 * compares a DECLARED path against an OBSERVED one reported by a test
 * runner, which legitimately differ by prefix (`tests/test_pricing.py` vs
 * `/srv/build/tests/test_pricing.py`), so it must reduce to a basename.
 * Here both sides are repo-relative paths emitted by git, so there is no
 * prefix skew to normalize away — and reducing to a basename lets any
 * same-named file elsewhere in the tree stand in for the declared one,
 * defeating the anti-decoy property this check exists to provide.
 *
 * Do not carry this rule back into `locationsAgree`. The `why` at
 * `tests/executor-mvp-tdd-section.test.cjs:1291-1304` records that exactly
 * this `endsWith` pair was proposed for that function in review and
 * rejected: there it is a strict narrowing of basename equality that blocks
 * `outside-in` and `fixture-is-the-behavior`, manufacturing the REGR-04
 * regression. It is safe HERE only because this check compares a
 * declaration against git's changed-file list, never a declared location
 * against a runner-observed one.
 */
function changedFilesInclude(changedFilesText: string, declaredFile: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const declaredPath = norm(declaredFile);
  return changedFilesText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(norm)
    .some((changed) => changed === declaredPath
      || changed.endsWith(`/${declaredPath}`)
      // The reverse direction is gated on `changed` carrying a directory
      // segment. Without that guard a bare-basename changed file — any
      // unrelated file living at the repo root — forges membership for a
      // directory-qualified declaration, which is the WR-01 decoy mirrored
      // onto the other side (gsd-core-ifc).
      || (changed.includes('/') && declaredPath.endsWith(`/${changed}`)));
}

function routeTaskCommand({ args, cwd, raw }: RouteTaskCommandOptions): void {
  const subcommand = args[1];
  if (subcommand === 'resolve-content') {
    routeResolveContent({ args, cwd, raw });
    return;
  }
  if (subcommand === 'red-evidence-verdict') {
    routeRedEvidenceVerdict({ args, cwd, raw });
    return;
  }
  if (subcommand !== 'is-behavior-adding') {
    error(
      'Unknown task subcommand. Available: is-behavior-adding, resolve-content, '
        + 'red-evidence-verdict',
      ERROR_REASON.SDK_UNKNOWN_COMMAND,
    );
  }

  let content: string | null = null;
  if (args[2] === '--task-content') {
    content = args[3] || null;
  } else if (args[2]) {
    const projectRoot = path.resolve(cwd || process.cwd());
    const requestedPath = args[2];
    const resolvedTaskPath = path.resolve(projectRoot, requestedPath);
    const rel = path.relative(projectRoot, resolvedTaskPath);
    if (rel === '..' || rel.startsWith(`..${path.sep}`)) {
      error(`Task file is outside project scope: ${requestedPath}`, ERROR_REASON.USAGE);
    }
    if (!fs.existsSync(resolvedTaskPath)) {
      error(`Task file not found: ${requestedPath}`, ERROR_REASON.USAGE);
    }
    content = fs.readFileSync(resolvedTaskPath, 'utf-8');
  }

  if (!content) {
    error('Usage: task.is-behavior-adding <plan-file-path> | --task-content "<xml>"', ERROR_REASON.USAGE);
  }

  output(isBehaviorAddingTaskContent(content as string), raw, undefined);
}

export = {
  isBehaviorAddingTaskContent,
  routeTaskCommand,
  routeResolveContent,
  routeRedEvidenceVerdict,
};
