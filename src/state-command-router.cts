/**
 * Manifest-backed state subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * Phase 5.1: handlers that have SDK equivalents are dispatched via
 * executeForCjs (the sync bridge). CJS fallback is retained for:
 * - complete-phase: no SDK counterpart.
 * - Any command when GSD_WORKSTREAM is active (GSDTransport forces subprocess
 *   for workstream requests; subprocess is disabled in the sync bridge worker).
 * - Any command when the SDK is not available (build not present).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/state-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { STATE_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

// Helper: extract string-only named arg value (value flags never return boolean).
function strArg(opts: Record<string, string | boolean | null>, key: string): string | null | undefined {
  const v = opts[key];
  if (typeof v === 'boolean') return undefined;
  return v;
}

interface StateModule {
  cmdStateLoad(cwd: string, raw: boolean): void;
  cmdStateJson(cwd: string, raw: boolean): void;
  cmdStateGet(cwd: string, field: string | undefined, raw: boolean): void;
  cmdStateUpdate(cwd: string, field: string | undefined, value: string | undefined): void;
  cmdStatePatch(cwd: string, patches: Record<string, string>, raw: boolean): void;
  cmdStateAdvancePlan(cwd: string, raw: boolean): void;
  cmdStateRecordMetric(cwd: string, opts: Record<string, string | null | undefined>, raw: boolean): void;
  cmdStateUpdateProgress(cwd: string, raw: boolean): void;
  cmdStateAddDecision(cwd: string, opts: Record<string, string | null | undefined>, raw: boolean): void;
  cmdStateAddBlocker(cwd: string, opts: Record<string, string | null | undefined>, raw: boolean): void;
  cmdStateAddRoadmapEvolution(cwd: string, opts: Record<string, string | boolean | null | undefined>, raw: boolean): void;
  cmdStateResolveBlocker(cwd: string, text: string | null | undefined, raw: boolean): void;
  cmdStateRecordSession(cwd: string, opts: Record<string, string | null | undefined>, raw: boolean): void;
  cmdStateBeginPhase(cwd: string, phase: string | null | undefined, name: string | null | undefined, plans: number | null, raw: boolean): void;
  cmdSignalWaiting(cwd: string, type: string | null | undefined, question: string | null | undefined, options: string | null | undefined, phase: string | null | undefined, raw: boolean): void;
  cmdSignalResume(cwd: string, raw: boolean): void;
  cmdStatePlannedPhase(cwd: string, phase: string | null | undefined, name: string | null | undefined, plans: number | null, raw: boolean): void;
  cmdStateValidate(cwd: string, raw: boolean, opts?: { strict?: boolean }): void;
  cmdStateSync(cwd: string, opts: { verify: string | boolean | null | undefined }, raw: boolean): void;
  cmdStatePrune(cwd: string, opts: { keepRecent: string; dryRun: boolean }, raw: boolean): void;
  cmdStateRebuild(cwd: string, opts: { dryRun: boolean; verbose: boolean }, raw: boolean): void;
  cmdStateCompletePhase(cwd: string, raw: boolean, phase: string | null | undefined): void;
  cmdStateMilestoneSwitch(cwd: string, milestone: string | null | undefined, name: string | null | undefined, raw: boolean): void;
}

interface RouteStateCommandOptions {
  state: StateModule;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeStateCommand({ state, args, cwd, raw, error }: RouteStateCommandOptions): void {
  const parsePlans = (plans: string | null | undefined): number | null => {
    const parsedPlans = plans == null ? null : Number.parseInt(plans, 10);
    if (plans != null && Number.isNaN(parsedPlans)) {
      error('Invalid --plans value. Expected an integer.');
      return null;
    }
    return parsedPlans;
  };

  routeHubCommandFamily({
    family: 'state',
    args,
    subcommands: ['load', 'complete-phase', ...STATE_SUBCOMMANDS.filter((s) => s !== 'load')],
    defaultSubcommand: 'load',
    // No SDK-only state subcommands remain: add-roadmap-evolution was the last
    // holdout after the SDK retirement (ADR-0174) and is now implemented in CJS
    // (handler below). See #1140.
    unsupported: {},
    error,
    cwd,
    raw,
    unknownMessage: (subcommand: string, available: string[]) => `Unknown state subcommand: "${subcommand}". Available: ${available.join(', ')}`,
    handlers: {
      load: () => state.cmdStateLoad(cwd, raw),
      json: () => state.cmdStateJson(cwd, raw),
      // ADR-3473 §8.4 / #3358 gap: these two read args[2]/args[3] positionally
      // without ever calling parseNamedArgsOrExit, so an unrecognized flag or
      // stray positional was silently dropped instead of rejected. No flags
      // are declared — none are documented for these subcommands
      // (docs/CLI-TOOLS.md:86,89) and no shipped workflow passes any.
      get: () => {
        parseNamedArgsOrExit(args, { positionals: 3 }, error);
        state.cmdStateGet(cwd, args[2], raw);
      },
      update: () => {
        parseNamedArgsOrExit(args, { positionals: 4 }, error);
        state.cmdStateUpdate(cwd, args[2], args[3]);
      },
      patch: () => {
        const patches: Record<string, string> = {};
        if (args.length === 3 && typeof args[2] === 'string' && args[2].trim().startsWith('{')) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(args[2]);
          } catch (err) {
            error(`state patch: invalid JSON object: ${(err as Error).message}`);
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            error('state patch: JSON input must be an object of field/value pairs.');
            return;
          }
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (key && value !== undefined) {
              // eslint-disable-next-line @typescript-eslint/no-base-to-string
              patches[key] = String(value);
            }
          }
        } else {
          for (let i = 2; i < args.length; i += 2) {
            const key = args[i].replace(/^--/, '');
            const value = args[i + 1];
            if (key && value !== undefined) {
              patches[key] = value;
            }
          }
        }
        state.cmdStatePatch(cwd, patches, raw);
      },
      'advance-plan': () => {
        // #3830 facet 2: reject unrecognized options instead of discarding them.
        //
        // Routed to the canonical owner rather than hand-rolled. `parseNamedArgsOrExit`
        // (#3884, src/command-arg-projection.cts) is what every other arm in this file
        // uses, and `positionals: 2` states what this verb is: the two command words,
        // then nothing. It rejects `--plan 10` as an unknown flag, `5` / `01` / `-x` /
        // `-p 10` as unexpected positional arguments, and a bare `--` as an unknown flag
        // — one usage contract and one `ERROR_REASON.USAGE` code across every arm here.
        //
        // Rejected rather than bound: this verb's defect is mutating on an unvalidated
        // position, and an operator-supplied `--plan`/`--total` would be an unvalidated
        // position arriving at a different port. To be useful as an escape hatch it
        // would have to BYPASS the disk cross-check added above — i.e. ship a documented
        // way to write a fabricated plan position. The repair path for a genuinely
        // diverged STATE.md is the existing one: `state rebuild`, `state sync`, or
        // `state patch`.
        parseNamedArgsOrExit(args, { positionals: 2 }, error);
        state.cmdStateAdvancePlan(cwd, raw);
      },
      'record-metric': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['phase', 'plan', 'duration', 'tasks', 'files'], positionals: 2 }, error);
        state.cmdStateRecordMetric(cwd, {
          phase: strArg(a, 'phase'),
          plan: strArg(a, 'plan'),
          duration: strArg(a, 'duration'),
          tasks: strArg(a, 'tasks'),
          files: strArg(a, 'files'),
        }, raw);
      },
      'update-progress': () => state.cmdStateUpdateProgress(cwd, raw),
      'add-decision': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['phase', 'summary', 'summary-file', 'rationale', 'rationale-file'], positionals: 2 }, error);
        state.cmdStateAddDecision(cwd, {
          phase: strArg(a, 'phase'),
          summary: strArg(a, 'summary'),
          summary_file: strArg(a, 'summary-file'),
          rationale: strArg(a, 'rationale') || '',
          rationale_file: strArg(a, 'rationale-file'),
        }, raw);
      },
      'add-blocker': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['text', 'text-file'], positionals: 2 }, error);
        state.cmdStateAddBlocker(cwd, { text: strArg(a, 'text'), text_file: strArg(a, 'text-file') }, raw);
      },
      'add-roadmap-evolution': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['phase', 'action', 'after', 'note', 'note-file'], booleanFlags: ['urgent'], positionals: 2 }, error);
        state.cmdStateAddRoadmapEvolution(cwd, {
          phase: strArg(a, 'phase'),
          action: strArg(a, 'action'),
          after: strArg(a, 'after'),
          note: strArg(a, 'note'),
          note_file: strArg(a, 'note-file'),
          urgent: a['urgent'] === true,
        }, raw);
      },
      'resolve-blocker': () => state.cmdStateResolveBlocker(cwd, strArg(parseNamedArgsOrExit(args, { valueFlags: ['text'], positionals: 2 }, error), 'text'), raw),
      'record-session': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['stopped-at', 'resume-file'], positionals: 2 }, error);
        // Pass resume_file as-is (undefined when --resume-file was not provided) so
        // cmdStateRecordSession can distinguish "caller explicitly passed a value" from
        // "option was not supplied" and apply the template-default-only replacement guard.
        state.cmdStateRecordSession(cwd, { stopped_at: strArg(a, 'stopped-at'), resume_file: strArg(a, 'resume-file') }, raw);
      },
      'begin-phase': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['phase', 'name', 'plans'], positionals: 2 }, error);
        state.cmdStateBeginPhase(cwd, strArg(a, 'phase'), strArg(a, 'name'), parsePlans(strArg(a, 'plans')), raw);
      },
      'signal-waiting': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['type', 'question', 'options', 'phase'], positionals: 2 }, error);
        state.cmdSignalWaiting(cwd, strArg(a, 'type'), strArg(a, 'question'), strArg(a, 'options'), strArg(a, 'phase'), raw);
      },
      'signal-resume': () => state.cmdSignalResume(cwd, raw),
      'planned-phase': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['phase', 'name', 'plans'], positionals: 2 }, error);
        // #3395: --name was parsed here but never forwarded (the StateModule
        // signature had no channel for it), so the argument was silently
        // dropped. It now persists into the Current Position `Phase:` line and
        // the authoritative current_phase_name, mirroring begin-phase.
        state.cmdStatePlannedPhase(cwd, strArg(a, 'phase'), strArg(a, 'name'), parsePlans(strArg(a, 'plans')), raw);
      },
      validate: () => {
        // #3696: --strict makes the verdict gateable by exit status. The
        // default stays exit 0 — the exit code is Tier-2 observable output
        // reaching unenumerable downstream consumers (ADR-3180 Decision 3).
        const a = parseNamedArgsOrExit(args, { booleanFlags: ['strict'], positionals: 2 }, error);
        state.cmdStateValidate(cwd, raw, { strict: a['strict'] === true });
      },
      sync: () => {
        const a = parseNamedArgsOrExit(args, { booleanFlags: ['verify'], positionals: 2 }, error);
        state.cmdStateSync(cwd, { verify: a['verify'] }, raw);
      },
      prune: () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['keep-recent'], booleanFlags: ['dry-run'], positionals: 2 }, error);
        state.cmdStatePrune(cwd, { keepRecent: strArg(a, 'keep-recent') || '3', dryRun: a['dry-run'] === true }, raw);
      },
      rebuild: () => {
        const a = parseNamedArgsOrExit(args, { booleanFlags: ['dry-run', 'verbose'], positionals: 2 }, error);
        state.cmdStateRebuild(cwd, { dryRun: a['dry-run'] === true, verbose: a['verbose'] === true }, raw);
      },
      // complete-phase: CJS-only — no SDK counterpart. Supports two shapes:
      // the documented `--phase N` flag (docs/COMMANDS.md:2207) and an
      // undocumented-but-preserved bare positional `state complete-phase N`
      // (N3). A single static `positionals` count cannot represent both: if
      // args[2] is the flag `--phase`, the boundary must be 2 so the generic
      // flag/value walk (which starts at the boundary) recognizes `--phase`
      // and consumes its value; only when args[2] is itself a bare, non-flag
      // token does the boundary widen to 3 to accept it as the positional
      // phase. Getting this wrong either breaks the documented flag form
      // (boundary 3 treats `--phase`'s value as an unexpected trailing
      // positional) or silently re-admits unknown flags (a static boundary
      // of 3 with an empty args[2] never validates anything past it).
      'complete-phase': () => {
        const bareTrailingPositional = args[2] !== undefined && !args[2].startsWith('--');
        const a = parseNamedArgsOrExit(
          args,
          { valueFlags: ['phase'], positionals: bareTrailingPositional ? 3 : 2 },
          error,
        );
        state.cmdStateCompletePhase(cwd, raw, strArg(a, 'phase') || args[2]);
      },
      'milestone-switch': () => {
        const a = parseNamedArgsOrExit(args, { valueFlags: ['milestone', 'name'], positionals: 2 }, error);
        state.cmdStateMilestoneSwitch(cwd, strArg(a, 'milestone'), strArg(a, 'name'), raw);
      },
    },
  });
}

export = {
  routeStateCommand,
};
