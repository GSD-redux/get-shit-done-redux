/**
 * Manifest-backed validate subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * Phase 6: validate.consistency, validate.health, validate.agents are
 * dispatched via executeForCjs when the SDK is available. CJS fallback
 * retained when:
 * - GSD_WORKSTREAM is active (workstream-scoped requests fall through to CJS).
 * - SDK is unavailable (build not present).
 *
 * CJS-only subcommands:
 * - context: complex inline logic using classifyContextUtilization and
 *   output formatting that has no direct SDK counterpart. Remains CJS-native.
 *
 * SDK-only (unsupported in CJS router): none.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/validate-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { VALIDATE_SUBCOMMANDS } from './command-aliases.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';
import { classifyContextUtilization, STATES } from './context-utilization.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface VerifyModule {
  cmdValidateConsistency(cwd: string, raw: boolean): void;
  cmdValidateHealth(cwd: string, opts: { repair: boolean; backfill: boolean }, raw: boolean): void;
  cmdValidateAgents(cwd: string, raw: boolean): void;
}

interface RouteValidateCommandOptions {
  verify: VerifyModule;
  args: string[];
  cwd: string;
  raw: boolean;
  output: (result: unknown, raw: boolean, rawValue?: unknown) => void;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeValidateCommand({ verify, args, cwd, raw, output: outputFn, error }: RouteValidateCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: VALIDATE_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown validate subcommand. Available: ${available.join(', ')}`,
    handlers: {
      consistency: () => verify.cmdValidateConsistency(cwd, raw),
      // Keep health on CJS for now so fix hints are rendered via runtime-slash
      // helpers (codex expects $gsd-* command shape).
      health: () => {
        const repairFlag = args.includes('--repair');
        const backfillFlag = args.includes('--backfill');
        verify.cmdValidateHealth(cwd, { repair: repairFlag, backfill: backfillFlag }, raw);
      },
      agents: () => verify.cmdValidateAgents(cwd, raw),
      // context: CJS-only — complex inline logic using classifyContextUtilization
      // with custom output formatting that has no direct SDK counterpart.
      context: () => {
        const opts = parseNamedArgsOrExit(args, { valueFlags: ['tokens-used', 'context-window'], booleanFlags: ['json'], positionals: 2 }, error);
        if (opts['tokens-used'] === null) {
          error('--tokens-used <integer> is required for `validate context`');
          return;
        }
        if (opts['context-window'] === null) {
          error('--context-window <integer> is required for `validate context`');
          return;
        }
        const threadCmd = String(formatGsdSlash('thread', resolveRuntime(cwd)));
        const RECOMMENDATIONS: Record<string, string | null> = {
          [STATES.HEALTHY]: null,
          [STATES.WARNING]: `Context is approaching the fracture zone — consider ${threadCmd} to continue in a fresh window.`,
          [STATES.CRITICAL]: `Reasoning quality may degrade past 70% utilization (fracture point). Run ${threadCmd} now to preserve output quality.`,
        };
        let classified: ReturnType<typeof classifyContextUtilization>;
        try {
          classified = classifyContextUtilization(Number(opts['tokens-used']), Number(opts['context-window']));
        } catch (e) {
          const msg = (e as Error).message;
          const flag = /tokensUsed/.test(msg) ? '--tokens-used' : '--context-window';
          error(`${flag} must be a non-negative integer (window > 0), got the values supplied`);
          return;
        }
        const result = { ...classified, recommendation: RECOMMENDATIONS[classified.state] };
        if (opts['json'] === true) {
          outputFn(result, raw);
        } else {
          const lines = [`Context utilization: ${result.percent}% (${result.state})`];
          if (result.recommendation) lines.push(result.recommendation);
          outputFn(result, true, lines.join('\n'));
        }
      },
    },
  });
}

export = {
  routeValidateCommand,
};
