/**
 * Manifest-backed init subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * Phase 6: all init.* subcommands have SDK equivalents and are dispatched
 * via executeForCjs (the sync bridge). CJS fallback retained when:
 * - GSD_WORKSTREAM is active (workstream-scoped requests fall through to CJS).
 * - SDK is unavailable (build not present).
 *
 * CJS-only subcommands: none.
 * SDK-only (unsupported in CJS router): none.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/init-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { INIT_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
import { parseNamedArgsOrExit, isFlagToken } from './command-arg-projection.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InitModule {
  cmdInitExecutePhase(cwd: string, phase: string | undefined, raw: boolean, opts: Record<string, string | boolean | null | undefined>): void;
  cmdInitPlanPhase(cwd: string, phase: string | undefined, raw: boolean, opts: Record<string, string | boolean | null | undefined>): void;
  cmdInitNewProject(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitNewMilestone(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitOnboard(cwd: string, raw: boolean, opts?: Record<string, string | boolean | null>): void;
  cmdInitQuick(cwd: string, name: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitQuickBatch(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitIngestDocs(cwd: string, raw: boolean): void;
  cmdInitResume(cwd: string, raw: boolean): void;
  cmdInitVerifyWork(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdInitPhaseOp(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdInitCodeReview(cwd: string, phase: string | undefined, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitReview(cwd: string, phase: string | undefined, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitDiscussPhaseAssumptions(cwd: string, phase: string | undefined, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitTodos(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdInitMilestoneOp(cwd: string, raw: boolean): void;
  cmdInitMapCodebase(cwd: string, raw: boolean): void;
  cmdInitProgress(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitManager(cwd: string, raw: boolean): void;
  cmdInitCompleteMilestone(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitAutonomous(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitDocsUpdate(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitUpdate(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitTransition(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitDebug(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitNewWorkspace(cwd: string, raw: boolean): void;
  cmdInitListWorkspaces(cwd: string, raw: boolean): void;
  cmdInitRemoveWorkspace(cwd: string, name: string | undefined, raw: boolean): void;
}

interface RouteInitCommandOptions {
  init: InitModule;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * #3865: `--phase <N>` / `--phase=<N>` alias for the positional phase token
 * the phase-taking init.* queries read at args[2]. Normalizes the pair into
 * that caller-owned slot so (a) the handler's own args[2] read sees the
 * value, and (b) the strict flag validation it runs sees exactly the argv
 * the positional form produces (a bare `--phase 60` at index 2-3 would
 * otherwise leave `60` as a rejected stray positional — or, pre-ADR-3473
 * §8.4, silently answer `phase_found:false, plan_count:0` for a phase with
 * plans on disk). A valueless `--phase` is a usage error naming the flag.
 * Any other flag-shaped args[2] resolves to `undefined` — the commands'
 * no-position-given input (execute-phase/plan-phase/verify-work usage-error
 * "phase required"; the find-based queries answer phase_found:false; todos
 * drops its area filter) — instead of passing the flag text down as a phase
 * name.
 */
function normalizePhaseAlias(
  args: string[],
  error: (message: string) => void,
): { args: string[]; phase: string | undefined } {
  const tok = args[2];
  if (tok === undefined) return { args, phase: undefined };
  if (tok === '--phase=') {
    error('--phase requires a value: use --phase <N> (or the positional form <N>)');
    // Fail-closed backstop, mirroring parseNamedArgsOrExit: the wired error()
    // exits, but a returning fail() must not fall through to the splices below.
    throw new Error('normalizePhaseAlias: error() returned instead of exiting');
  }
  if (tok.startsWith('--phase=')) {
    const value = tok.slice('--phase='.length);
    const out = args.slice();
    out.splice(2, 1, value);
    return { args: out, phase: value };
  }
  if (tok === '--phase') {
    const next = args[3];
    if (next === undefined || isFlagToken(next)) {
      error('--phase requires a value: use --phase <N> (or the positional form <N>)');
      throw new Error('normalizePhaseAlias: error() returned instead of exiting');
    }
    const out = args.slice();
    out.splice(2, 2, next);
    return { args: out, phase: next };
  }
  if (isFlagToken(tok)) return { args, phase: undefined };
  return { args, phase: tok };
}

function routeInitCommand({ init, args, cwd, raw, error }: RouteInitCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: INIT_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown init workflow: ${_subcommand}\nAvailable: ${available.join(', ')}`,
    handlers: {
      // #2932/#2992: `parseNamedArgs` never yields `undefined` for an absent
      // flag (value-flags default to `null`, booleanFlags default to `false`);
      // `buildSectionManifestField`'s flags-Set builder (src/init.cts) is the
      // single source of truth for flag ABSENCE and gates on value truthiness,
      // so `namedArgs` is passed through here uncoerced.
      //
      // #3865: the phase-taking init.* queries accept `--phase <N>` /
      // `--phase=<N>` as an alias for the positional form (matching
      // `phase list-plans`, which accepts both). Pre-normalizing here moves
      // the value into the caller-owned args[2] slot every handler below
      // already reads, so the strict flag validation those handlers run sees
      // exactly the argv the positional form produces. A valueless --phase is
      // a usage error naming the flag — never a silent `phase_found:false`
      // for a phase that has plans (the reported incident: 7 plans read as 0).
      'execute-phase': () => {
        const norm = normalizePhaseAlias(args, error);
        // `wave` is an optionalValueFlags entry, not a booleanFlags entry:
        // `--wave N` is a documented, shipped form (commands/gsd/execute-phase.md:4,48)
        // whose value is consumed by the workflow layer
        // (gsd-core/workflows/execute-phase.md:84), not by this CLI seam — see
        // NamedArgSpec.optionalValueFlags in command-arg-projection.cts.
        const namedArgs = parseNamedArgsOrExit(norm.args, { booleanFlags: ['validate', 'tdd'], optionalValueFlags: ['wave'], positionals: 3 }, error);
        init.cmdInitExecutePhase(cwd, norm.phase, raw, {
          validate: namedArgs['validate'],
          tdd: namedArgs['tdd'],
          wave: namedArgs['wave'],
        });
      },
      'plan-phase': () => {
        const norm = normalizePhaseAlias(args, error);
        const namedArgs = parseNamedArgsOrExit(
          norm.args,
          {
            valueFlags: ['granularity', 'prd', 'ingest', 'research-phase'],
            booleanFlags: ['validate', 'tdd', 'reviews', 'chunked'],
            positionals: 3,
          },
          error,
        );
        init.cmdInitPlanPhase(cwd, norm.phase, raw, {
          validate: namedArgs['validate'],
          tdd: namedArgs['tdd'],
          granularity: namedArgs['granularity'],
          prd: namedArgs['prd'],
          ingest: namedArgs['ingest'],
          'research-phase': namedArgs['research-phase'],
          reviews: namedArgs['reviews'],
          chunked: namedArgs['chunked'],
        });
      },
      'new-project': () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['auto'], positionals: 2 }, error);
        init.cmdInitNewProject(cwd, raw, { auto: namedArgs['auto'] });
      },
      'new-milestone': () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['reset-phase-numbers'], positionals: 2 }, error);
        init.cmdInitNewMilestone(cwd, raw, {
          'reset-phase-numbers': namedArgs['reset-phase-numbers'],
        });
      },
      onboard: () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['fast', 'text'], positionals: 2 }, error);
        init.cmdInitOnboard(cwd, raw, { fast: namedArgs['fast'], text: namedArgs['text'] });
      },
      quick: () => {
        // #3180 Decision 4a / L2 (ADR-3473 §8.4): `positionals: 'rest'` because
        // everything after `init quick` is a free-text description — strict
        // undeclared-flag rejection would break
        // `/gsd-quick add a --dry-run option`, which works today.
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['discuss', 'research', 'validate', 'full'], positionals: 'rest' }, error);
        // #2994: `args.slice(2)` is the free-text description, but section-manifest
        // gating (buildSectionManifestField, src/init.cts) now requires forwarding
        // --discuss/--research/--validate/--full alongside it — a plain `.join(' ')`
        // would otherwise fold those recognized flag tokens straight into the
        // description text. Strip them before joining so the description stays
        // exactly what it was before this workflow started forwarding flags.
        const quickFlagTokens = new Set(['--discuss', '--research', '--validate', '--full']);
        const description = args
          .slice(2)
          .filter((token) => !quickFlagTokens.has(token))
          .join(' ');
        init.cmdInitQuick(cwd, description, raw, {
          discuss: namedArgs['discuss'],
          research: namedArgs['research'],
          validate: namedArgs['validate'],
          full: namedArgs['full'],
        });
      },
      // #3676 (Phase 4, epic #3344): `init.quick-batch` supplies model
      // profiles/commit_docs/roadmap-existence/section_manifest — batch
      // creation itself is the `quick-batch create` verb's job (wraps
      // `createBatch`, src/quick-batch.cts). No free-text description to
      // strip: `--research`/`--validate` are the only recognized flags
      // (`--discuss`/`--full` are rejected upstream by `parseQuickBatchArgs`
      // before this init bundle is ever reached).
      'quick-batch': () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['research', 'validate'], positionals: 2 }, error);
        init.cmdInitQuickBatch(cwd, raw, {
          research: namedArgs['research'],
          validate: namedArgs['validate'],
        });
      },
      'ingest-docs': () => init.cmdInitIngestDocs(cwd, raw),
      resume: () => init.cmdInitResume(cwd, raw),
      // ADR-3473 §8.4 / #3358 gap: these handlers read args[2] positionally
      // without ever calling parseNamedArgsOrExit, so an unrecognized flag or
      // stray positional was silently dropped instead of rejected. No flags
      // are declared because none are documented for these subcommands
      // (docs/CLI-TOOLS.md); `--ws` seen in shipped workflows targets the
      // separate `query init.verify-work` seam and is stripped before
      // reaching `init verify-work` (gsd-core/workflows/verify-work.md:42-45).
      'verify-work': () => {
        const norm = normalizePhaseAlias(args, error);
        parseNamedArgsOrExit(norm.args, { positionals: 3 }, error);
        init.cmdInitVerifyWork(cwd, norm.phase, raw);
      },
      'phase-op': () => {
        const norm = normalizePhaseAlias(args, error);
        parseNamedArgsOrExit(norm.args, { positionals: 3 }, error);
        init.cmdInitPhaseOp(cwd, norm.phase, raw);
      },
      'code-review': () => {
        const norm = normalizePhaseAlias(args, error);
        const namedArgs = parseNamedArgsOrExit(norm.args, { booleanFlags: ['fix'], positionals: 3 }, error);
        init.cmdInitCodeReview(cwd, norm.phase, raw, { fix: namedArgs['fix'] });
      },
      review: () => {
        const norm = normalizePhaseAlias(args, error);
        parseNamedArgsOrExit(norm.args, { positionals: 3 }, error);
        init.cmdInitReview(cwd, norm.phase, raw, {});
      },
      'discuss-phase-assumptions': () => {
        const norm = normalizePhaseAlias(args, error);
        const namedArgs = parseNamedArgsOrExit(norm.args, { booleanFlags: ['auto'], positionals: 3 }, error);
        init.cmdInitDiscussPhaseAssumptions(cwd, norm.phase, raw, { auto: namedArgs['auto'] });
      },
      todos: () => {
        const norm = normalizePhaseAlias(args, error);
        parseNamedArgsOrExit(norm.args, { positionals: 3 }, error);
        init.cmdInitTodos(cwd, norm.phase, raw);
      },
      'milestone-op': () => init.cmdInitMilestoneOp(cwd, raw),
      'map-codebase': () => init.cmdInitMapCodebase(cwd, raw),
      progress: () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['forensic'], positionals: 2 }, error);
        init.cmdInitProgress(cwd, raw, { forensic: namedArgs['forensic'] });
      },
      // Keep manager on CJS for now so runtime-specific command rendering
      // (e.g. $gsd-* for codex) stays consistent with runtime-slash helpers.
      manager: () => init.cmdInitManager(cwd, raw),
      'complete-milestone': () => init.cmdInitCompleteMilestone(cwd, raw),
      autonomous: () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['converge', 'cross-ai'], positionals: 2 }, error);
        init.cmdInitAutonomous(cwd, raw, {
          converge: namedArgs['converge'],
          'cross-ai': namedArgs['cross-ai'],
        });
      },
      'docs-update': () => init.cmdInitDocsUpdate(cwd, raw, {}),
      update: () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['next', 'rc'], positionals: 2 }, error);
        init.cmdInitUpdate(cwd, raw, { next: namedArgs['next'], rc: namedArgs['rc'] });
      },
      transition: () => init.cmdInitTransition(cwd, raw, {}),
      debug: () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['diagnose'], positionals: 2 }, error);
        init.cmdInitDebug(cwd, raw, { diagnose: namedArgs['diagnose'] });
      },
      'new-workspace': () => init.cmdInitNewWorkspace(cwd, raw),
      'list-workspaces': () => init.cmdInitListWorkspaces(cwd, raw),
      'remove-workspace': () => {
        parseNamedArgsOrExit(args, { positionals: 3 }, error);
        init.cmdInitRemoveWorkspace(cwd, args[2], raw);
      },
    },
  });
}

export = {
  routeInitCommand,
};
