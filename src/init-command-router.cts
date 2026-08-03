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
import { parseNamedArgs } from './command-arg-projection.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InitModule {
  cmdInitExecutePhase(cwd: string, phase: string | undefined, raw: boolean, opts: Record<string, string | boolean | null>): void;
  cmdInitPlanPhase(cwd: string, phase: string | undefined, raw: boolean, opts: Record<string, string | boolean | null>): void;
  cmdInitNewProject(cwd: string, raw: boolean): void;
  cmdInitNewMilestone(cwd: string, raw: boolean): void;
  cmdInitOnboard(cwd: string, raw: boolean, opts?: Record<string, string | boolean | null>): void;
  cmdInitQuick(cwd: string, name: string, raw: boolean): void;
  cmdInitIngestDocs(cwd: string, raw: boolean): void;
  cmdInitResume(cwd: string, raw: boolean): void;
  cmdInitVerifyWork(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdInitPhaseOp(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdInitTodos(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdInitMilestoneOp(cwd: string, raw: boolean): void;
  cmdInitMapCodebase(cwd: string, raw: boolean): void;
  cmdInitProgress(cwd: string, raw: boolean): void;
  cmdInitManager(cwd: string, raw: boolean): void;
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

function routeInitCommand({ init, args, cwd, raw, error }: RouteInitCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: INIT_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown init workflow: ${_subcommand}\nAvailable: ${available.join(', ')}`,
    handlers: {
      'execute-phase': () => {
        // #2932: 'wave' is boolean/token-presence (parseNamedArgs's booleanFlags
        // semantics already match the design's token-presence rule: `--wave` alone,
        // `--wave 0`, and duplicate `--wave 1 --wave 2` all resolve to `true`;
        // near-miss tokens `--waves`/`--wave-filter` never match the exact `--wave` token).
        const namedArgs = parseNamedArgs(args, [], ['validate', 'tdd', 'wave']);
        init.cmdInitExecutePhase(cwd, args[2], raw, { validate: namedArgs['validate'], tdd: namedArgs['tdd'], wave: namedArgs['wave'] });
      },
      'plan-phase': () => {
        const namedArgs = parseNamedArgs(args, ['granularity'], ['validate', 'tdd']);
        init.cmdInitPlanPhase(cwd, args[2], raw, { validate: namedArgs['validate'], tdd: namedArgs['tdd'], granularity: namedArgs['granularity'] });
      },
      'new-project': () => init.cmdInitNewProject(cwd, raw),
      'new-milestone': () => init.cmdInitNewMilestone(cwd, raw),
      onboard: () => {
        const namedArgs = parseNamedArgs(args, [], ['fast', 'text']);
        init.cmdInitOnboard(cwd, raw, { fast: namedArgs['fast'], text: namedArgs['text'] });
      },
      quick: () => init.cmdInitQuick(cwd, args.slice(2).join(' '), raw),
      'ingest-docs': () => init.cmdInitIngestDocs(cwd, raw),
      resume: () => init.cmdInitResume(cwd, raw),
      'verify-work': () => init.cmdInitVerifyWork(cwd, args[2], raw),
      'phase-op': () => init.cmdInitPhaseOp(cwd, args[2], raw),
      todos: () => init.cmdInitTodos(cwd, args[2], raw),
      'milestone-op': () => init.cmdInitMilestoneOp(cwd, raw),
      'map-codebase': () => init.cmdInitMapCodebase(cwd, raw),
      progress: () => init.cmdInitProgress(cwd, raw),
      // Keep manager on CJS for now so runtime-specific command rendering
      // (e.g. $gsd-* for codex) stays consistent with runtime-slash helpers.
      manager: () => init.cmdInitManager(cwd, raw),
      'new-workspace': () => init.cmdInitNewWorkspace(cwd, raw),
      'list-workspaces': () => init.cmdInitListWorkspaces(cwd, raw),
      'remove-workspace': () => init.cmdInitRemoveWorkspace(cwd, args[2], raw),
    },
  });
}

export = {
  routeInitCommand,
};
