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
  cmdInitTodos(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdInitMilestoneOp(cwd: string, raw: boolean): void;
  cmdInitMapCodebase(cwd: string, raw: boolean): void;
  cmdInitProgress(cwd: string, raw: boolean, options?: Record<string, string | boolean | null | undefined>): void;
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
        //
        // #2992 fix: `parseNamedArgs`'s booleanFlags ALWAYS populate the key
        // (true when the token was seen, `false` otherwise — never
        // `undefined`). `buildSectionManifestField`'s flags-Set builder
        // (src/init.cts) treats any non-`undefined` option value as PRESENT
        // (matrix rows D2/D3: an option's own value `false`/a string is
        // still present — that rule exists for VALUE flags whose absence is
        // `null`, not for a booleanFlag's own presence signal). Passed
        // through raw, a booleanFlag's `false` ("token not seen") would be
        // added to `flags` anyway, making `flag:--wave`/`flag:--validate`/
        // `flag:--tdd` permanently true regardless of the actual CLI
        // invocation — silently defeating the whole gating feature (verified
        // live: `partial-wave` was included with NO `--wave` on the command
        // line). `|| undefined` folds a booleanFlag's own "absent" value
        // into the SAME `undefined` sentinel the flags builder already
        // treats as absent, without touching that builder's documented
        // contract for value flags.
        const namedArgs = parseNamedArgs(args, [], ['validate', 'tdd', 'wave']);
        init.cmdInitExecutePhase(cwd, args[2], raw, {
          validate: namedArgs['validate'] || undefined,
          tdd: namedArgs['tdd'] || undefined,
          wave: namedArgs['wave'] || undefined,
        });
      },
      'plan-phase': () => {
        // #2992 fix: same booleanFlag-presence correction as execute-phase above.
        const namedArgs = parseNamedArgs(args, ['granularity'], ['validate', 'tdd']);
        init.cmdInitPlanPhase(cwd, args[2], raw, {
          validate: namedArgs['validate'] || undefined,
          tdd: namedArgs['tdd'] || undefined,
          granularity: namedArgs['granularity'],
        });
      },
      'new-project': () => {
        // #2992 fix: same booleanFlag-presence correction as execute-phase above.
        const namedArgs = parseNamedArgs(args, [], ['auto']);
        init.cmdInitNewProject(cwd, raw, { auto: namedArgs['auto'] || undefined });
      },
      'new-milestone': () => {
        // #2992 fix: same booleanFlag-presence correction as execute-phase above.
        const namedArgs = parseNamedArgs(args, [], ['reset-phase-numbers']);
        init.cmdInitNewMilestone(cwd, raw, {
          'reset-phase-numbers': namedArgs['reset-phase-numbers'] || undefined,
        });
      },
      onboard: () => {
        const namedArgs = parseNamedArgs(args, [], ['fast', 'text']);
        init.cmdInitOnboard(cwd, raw, { fast: namedArgs['fast'], text: namedArgs['text'] });
      },
      quick: () => {
        // #2992 fix: same booleanFlag-presence correction as execute-phase above.
        const namedArgs = parseNamedArgs(args, [], ['discuss', 'research', 'validate', 'full']);
        init.cmdInitQuick(cwd, args.slice(2).join(' '), raw, {
          discuss: namedArgs['discuss'] || undefined,
          research: namedArgs['research'] || undefined,
          validate: namedArgs['validate'] || undefined,
          full: namedArgs['full'] || undefined,
        });
      },
      'ingest-docs': () => init.cmdInitIngestDocs(cwd, raw),
      resume: () => init.cmdInitResume(cwd, raw),
      'verify-work': () => init.cmdInitVerifyWork(cwd, args[2], raw),
      'phase-op': () => init.cmdInitPhaseOp(cwd, args[2], raw),
      todos: () => init.cmdInitTodos(cwd, args[2], raw),
      'milestone-op': () => init.cmdInitMilestoneOp(cwd, raw),
      'map-codebase': () => init.cmdInitMapCodebase(cwd, raw),
      progress: () => {
        // #2992 fix: same booleanFlag-presence correction as execute-phase above.
        const namedArgs = parseNamedArgs(args, [], ['forensic']);
        init.cmdInitProgress(cwd, raw, { forensic: namedArgs['forensic'] || undefined });
      },
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
