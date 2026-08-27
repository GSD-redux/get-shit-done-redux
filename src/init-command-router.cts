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
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InitModule {
  cmdInitExecutePhase(cwd: string, phase: string | undefined, raw: boolean, opts: Record<string, string | boolean | null | undefined>): void;
  cmdInitPlanPhase(cwd: string, phase: string | undefined, raw: boolean, opts: Record<string, string | boolean | null | undefined>): void;
  cmdInitNewProject(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitNewMilestone(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
  cmdInitOnboard(cwd: string, raw: boolean, opts?: Record<string, string | boolean | null>): void;
  cmdInitQuick(cwd: string, name: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
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
  cmdInitDebug(
    cwd: string,
    raw: boolean,
    options?: Record<string, string | boolean | null | undefined>,
    continueSlug?: string | null,
  ): void;
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

type DebugSubcommand = 'debug' | 'list' | 'status' | 'continue';
type RuntimeEvidenceOverride = 'adaptive' | 'off' | null;

interface DebugInvocationProjection {
  subcommand: DebugSubcommand;
  slug: string | null;
  description: string;
  diagnose: boolean;
  runtimeEvidenceOverride: RuntimeEvidenceOverride;
}

type DebugInvocationResult =
  | { ok: true; data: DebugInvocationProjection }
  | { ok: false; reason: string };

const DEBUG_GLOBAL_FLAG_TOKENS = new Set([
  '--diagnose',
  '--runtime-probes',
  '--no-runtime-probes',
]);
const DEBUG_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DEBUG_SLUG_MAX_LENGTH = 30;

/**
 * Project the complete `/gsd:debug` argv exactly once at the CLI seam.
 * Recognized flags are whole-token, global, and removed before positional
 * routing. Flag-shaped lookalikes remain description data.
 */
function projectDebugInvocation(tokens: string[]): DebugInvocationResult {
  const diagnose = tokens.includes('--diagnose');
  const runtimeProbes = tokens.includes('--runtime-probes');
  const noRuntimeProbes = tokens.includes('--no-runtime-probes');

  if (runtimeProbes && noRuntimeProbes) {
    return { ok: false, reason: 'Cannot combine --runtime-probes with --no-runtime-probes.' };
  }

  const positionals = tokens.filter((token) => !DEBUG_GLOBAL_FLAG_TOKENS.has(token));
  const first = positionals[0];
  const hasRecognizedFlag = positionals.length !== tokens.length;
  const runtimeEvidenceOverride: RuntimeEvidenceOverride = runtimeProbes
    ? 'adaptive'
    : noRuntimeProbes
      ? 'off'
      : null;

  if (first === 'list') {
    if (hasRecognizedFlag || positionals.length !== 1) {
      return { ok: false, reason: 'The list subcommand accepts no flags or arguments.' };
    }
    return {
      ok: true,
      data: { subcommand: 'list', slug: null, description: '', diagnose: false, runtimeEvidenceOverride: null },
    };
  }

  if (first === 'status') {
    if (hasRecognizedFlag || positionals.length !== 2) {
      return { ok: false, reason: 'The status subcommand requires exactly one slug and accepts no flags.' };
    }
    const slug = positionals[1];
    if (slug.length > DEBUG_SLUG_MAX_LENGTH || !DEBUG_SLUG_RE.test(slug)) {
      return { ok: false, reason: 'Invalid status slug; expected lowercase letters, digits, or hyphens (max 30).' };
    }
    return {
      ok: true,
      data: { subcommand: 'status', slug, description: '', diagnose: false, runtimeEvidenceOverride: null },
    };
  }

  if (first === 'continue') {
    if (diagnose) {
      return { ok: false, reason: 'Cannot combine continue with --diagnose.' };
    }
    if (positionals.length !== 2) {
      return { ok: false, reason: 'The continue subcommand requires exactly one slug.' };
    }
    const slug = positionals[1];
    if (slug.length > DEBUG_SLUG_MAX_LENGTH || !DEBUG_SLUG_RE.test(slug)) {
      return { ok: false, reason: 'Invalid continue slug; expected lowercase letters, digits, or hyphens (max 30).' };
    }
    return {
      ok: true,
      data: { subcommand: 'continue', slug, description: '', diagnose: false, runtimeEvidenceOverride },
    };
  }

  if (diagnose && runtimeProbes) {
    return { ok: false, reason: 'Cannot combine --diagnose with --runtime-probes.' };
  }

  return {
    ok: true,
    data: {
      subcommand: 'debug',
      slug: null,
      description: positionals.join(' '),
      diagnose,
      runtimeEvidenceOverride,
    },
  };
}

// ─── Implementation ───────────────────────────────────────────────────────────

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
      'execute-phase': () => {
        // `wave` is an optionalValueFlags entry, not a booleanFlags entry:
        // `--wave N` is a documented, shipped form (commands/gsd/execute-phase.md:4,48)
        // whose value is consumed by the workflow layer
        // (gsd-core/workflows/execute-phase.md:84), not by this CLI seam — see
        // NamedArgSpec.optionalValueFlags in command-arg-projection.cts.
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['validate', 'tdd'], optionalValueFlags: ['wave'], positionals: 3 }, error);
        init.cmdInitExecutePhase(cwd, args[2], raw, {
          validate: namedArgs['validate'],
          tdd: namedArgs['tdd'],
          wave: namedArgs['wave'],
        });
      },
      'plan-phase': () => {
        const namedArgs = parseNamedArgsOrExit(
          args,
          {
            valueFlags: ['granularity', 'prd', 'ingest', 'research-phase'],
            booleanFlags: ['validate', 'tdd', 'reviews', 'chunked'],
            positionals: 3,
          },
          error,
        );
        init.cmdInitPlanPhase(cwd, args[2], raw, {
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
        parseNamedArgsOrExit(args, { positionals: 3 }, error);
        init.cmdInitVerifyWork(cwd, args[2], raw);
      },
      'phase-op': () => {
        parseNamedArgsOrExit(args, { positionals: 3 }, error);
        init.cmdInitPhaseOp(cwd, args[2], raw);
      },
      'code-review': () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['fix'], positionals: 3 }, error);
        init.cmdInitCodeReview(cwd, args[2], raw, { fix: namedArgs['fix'] });
      },
      review: () => {
        parseNamedArgsOrExit(args, { positionals: 3 }, error);
        init.cmdInitReview(cwd, args[2], raw, {});
      },
      'discuss-phase-assumptions': () => {
        const namedArgs = parseNamedArgsOrExit(args, { booleanFlags: ['auto'], positionals: 3 }, error);
        init.cmdInitDiscussPhaseAssumptions(cwd, args[2], raw, { auto: namedArgs['auto'] });
      },
      todos: () => {
        parseNamedArgsOrExit(args, { positionals: 3 }, error);
        init.cmdInitTodos(cwd, args[2], raw);
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
        const namedArgs = parseNamedArgsOrExit(
          args,
          {
            booleanFlags: ['diagnose', 'runtime-probes', 'no-runtime-probes'],
            positionals: 'rest',
          },
          error,
        );
        const projection = projectDebugInvocation(args.slice(2));
        if (!projection.ok) {
          error(projection.reason);
          return;
        }
        const route = projection.data;
        const continueSlug = route.subcommand === 'continue' ? route.slug : null;

        init.cmdInitDebug(cwd, raw, {
          diagnose: namedArgs['diagnose'],
          'runtime-probes': namedArgs['runtime-probes'],
          'no-runtime-probes': namedArgs['no-runtime-probes'],
          subcommand: route.subcommand,
          slug: route.slug,
          description: route.description,
          'runtime-evidence-override': route.runtimeEvidenceOverride,
        }, continueSlug);
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
  projectDebugInvocation,
  routeInitCommand,
};
