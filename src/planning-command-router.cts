/**
 * Planning command router — CLI subcommand dispatcher for `gsd-tools planning`.
 *
 * Routes `planning inspect` (#2790) to `planningInspect.cmdPlanningInspect`.
 * Both the spaced form (`query planning inspect`) and the dotted canonical form
 * (`query planning.inspect`) reach here identically: `gsd-tools` splits a dotted
 * command on its FIRST dot before dispatch, so the router never sees the dot.
 *
 * v1 accepts NO arguments beyond the subcommand. `--raw`, `--cwd`, `--pick`,
 * `--default` and `--json-errors` are global and are spliced out of argv by
 * `gsd-tools`' own `main()` before any router runs, so anything still present at
 * `args[2]` or beyond is genuinely unrecognised and is a fail-loud USAGE error.
 * That strictness is deliberate: silently ignoring an argument a caller believed
 * was scoping the query would return a full-project snapshot presented as a
 * scoped one — a confidently wrong answer.
 *
 * Router signature `{ args, cwd, raw, error }` — identical to the other host
 * routers. Test seam: pass `_planningInspect` to inject a recording mock; the
 * `_` prefix follows this repo's established seam convention.
 *
 * ADR-457 build-at-publish: source in src/planning-command-router.cts, compiled
 * to gsd-core/bin/lib/planning-command-router.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningInspect = require('./planning-inspect.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');

const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { ERROR_REASON } = io;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlanningInspectModule {
  cmdPlanningInspect(cwd: string, raw: boolean): void;
}

interface RoutePlanningCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: inject a mock planning-inspect module. Defaults to the real one. */
  _planningInspect?: PlanningInspectModule;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const PLANNING_SUBCOMMANDS = ['inspect'];

function routePlanningCommand({ args, cwd, raw, error, _planningInspect }: RoutePlanningCommandOptions): void {
  const mod: PlanningInspectModule = _planningInspect ?? planningInspect;

  routeCjsCommandFamily({
    args,
    subcommands: PLANNING_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown planning subcommand. Available: ${available.join(', ')}`,
    handlers: {
      inspect: () => {
        const extra = args.slice(2);
        if (extra.length > 0) {
          const offender = extra[0];
          const shape = offender.startsWith('-') ? 'flag' : 'positional argument';
          error(
            `planning inspect takes no arguments; got ${shape}: ${offender}. ` +
              'Usage: gsd-tools query planning inspect',
            ERROR_REASON.USAGE,
          );
          return;
        }
        mod.cmdPlanningInspect(cwd, raw);
      },
    },
  });
}

export = {
  routePlanningCommand,
  PLANNING_SUBCOMMANDS,
};
