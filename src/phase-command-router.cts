/**
 * Manifest-backed phase subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * Unsupported in this router:
 * - scaffold: routed through top-level scaffold command.
 *
 * CJS-only subcommands: mvp-mode (dispatched directly, before hub).
 *
 * #3788: dispatch is mediated by CommandRoutingHub. The public entry point
 * and observable CLI behaviour are unchanged.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/phase-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { PHASE_SUBCOMMANDS } from './command-aliases.cjs';

// ─── CommandRoutingHub (issue #3788, simplified in #175, typed in #176) ───────
// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
const { createHub, ERROR_KINDS, makeInvalidArgs } = commandRoutingHub;
// #2620 (ADR-0174 §6): inject the reference DispatchLogger on the live phase
// dispatch path, but only when observability is opt-in enabled; otherwise the
// Hub stays byte-for-byte silent via its no-op fallback.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import observabilityLogger = require('./observability/logger.cjs');
const { createDefaultLogger, isAuditEnabled } = observabilityLogger;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhaseHandlers {
  cmdPhaseMvpMode: (cwd: string, args: string[], raw: boolean) => void;
  cmdPhaseNextDecimal: (cwd: string, arg: string | undefined, raw: boolean) => void;
  cmdPhaseAdd: (cwd: string, desc: string, raw: boolean, customId: string | null) => void;
  cmdPhaseAddBatch: (cwd: string, descriptions: string[], raw: boolean) => void;
  cmdPhaseInsert: (cwd: string, pos: string | undefined, desc: string, raw: boolean) => void;
  cmdPhaseRemove: (cwd: string, phaseNum: string, opts: { force: boolean }, raw: boolean) => void;
  cmdPhaseComplete: (cwd: string, phaseNum: string | undefined, raw: boolean) => void;
  cmdPhaseUatPassed: (cwd: string, phaseNum: string | undefined, raw: boolean, opts?: { policy?: { requireVerification?: boolean } }) => void;
  cmdPhaseListPlans: (cwd: string, phaseNum: string | undefined, raw: boolean) => void;
}

interface RoutePhaseCommandOptions {
  phase: PhaseHandlers;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routePhaseCommand({ phase, args, cwd, raw, error }: RoutePhaseCommandOptions): void {
  // ── Unsupported subcommands ─────────────────────────────────────────────────
  // Resolved before dispatch so the error message stays deterministic.
  const UNSUPPORTED: Record<string, string> = {
    scaffold: 'phase scaffold is routed through the top-level scaffold command.',
  };

  const subcommand = args[1];

  if (subcommand && UNSUPPORTED[subcommand]) {
    error(UNSUPPORTED[subcommand]);
    return;
  }

  // ── No subcommand → reject early with helpful error ────────────────────────
  // Pre-#3788 code resolved unknown subcommands via routeCjsCommandFamily which
  // fell through to error() when no handler matched (including undefined).
  // Post-#3788 the hub's manifest check is skipped for falsy subcommand, so we
  // must guard here to preserve the deterministic "Available: ..." error message.
  if (!subcommand) {
    const available = PHASE_SUBCOMMANDS.filter(s => !UNSUPPORTED[s]).join(', ');
    error(`Unknown phase subcommand. Available: ${available}`);
    return;
  }

  // ── CJS-only subcommands (dispatched directly, before hub) ─────────────────
  // `mvp-mode` has a CJS-native implementation in phase.cmdPhaseMvpMode that
  // differs from the SDK query layer (different ROADMAP scan + error codes).
  // Dispatch it early to preserve pre-migration observable behaviour (correct
  // exit code, correct JSON error reason code, correct ROADMAP scan).
  if (subcommand === 'mvp-mode') {
    phase.cmdPhaseMvpMode(cwd, args.slice(2), raw);
    return;
  }

  // ── Build the CJS registry ──────────────────────────────────────────────────
  // Each handler receives a ctx object from the hub and must return a HubResult.
  const cjsRegistry = {
    phase: {
      'next-decimal': (_ctx: Record<string, unknown>): { ok: true; data: null } => {
        phase.cmdPhaseNextDecimal(cwd, args[2], raw);
        return { ok: true as const, data: null };
      },
      add: (_ctx: Record<string, unknown>) => {
        let customId: string | null = null;
        const descArgs: string[] = [];
        for (let i = 2; i < args.length; i++) {
          const token = args[i];
          if (token === '--raw') {
            continue;
          }
          if (token === '--id') {
            const id = args[i + 1];
            if (!id || id.startsWith('--')) {
              return makeInvalidArgs('--id', '--id requires a value');
            }
            customId = id;
            i++;
          } else if (token.startsWith('--')) {
            return makeInvalidArgs(token, `phase add does not support ${token}`);
          } else {
            descArgs.push(token);
          }
        }
        phase.cmdPhaseAdd(cwd, descArgs.join(' '), raw, customId);
        return { ok: true as const, data: null };
      },
      'add-batch': (_ctx: Record<string, unknown>) => {
        const descFlagIdx = args.indexOf('--descriptions');
        let descriptions: string[];
        if (descFlagIdx !== -1) {
          const rawDescriptions = args[descFlagIdx + 1];
          if (!rawDescriptions || rawDescriptions.startsWith('--')) {
            return makeInvalidArgs('--descriptions', '--descriptions must be a JSON array');
          }
          try {
            descriptions = JSON.parse(rawDescriptions) as string[];
          } catch {
            return makeInvalidArgs('--descriptions', '--descriptions must be a JSON array');
          }
          if (!Array.isArray(descriptions)) {
            return makeInvalidArgs('--descriptions', '--descriptions must be a JSON array');
          }
        } else {
          descriptions = args.slice(2).filter(a => a !== '--raw');
        }
        phase.cmdPhaseAddBatch(cwd, descriptions, raw);
        return { ok: true as const, data: null };
      },
      insert: (_ctx: Record<string, unknown>) => {
        if (args.includes('--dry-run')) {
          return makeInvalidArgs('--dry-run', 'phase insert does not support --dry-run');
        }
        phase.cmdPhaseInsert(cwd, args[2], args.slice(3).join(' '), raw);
        return { ok: true as const, data: null };
      },
      remove: (_ctx: Record<string, unknown>) => {
        const removeArgs = args.slice(2).filter(token => token !== '--raw');
        let forceFlag = false;
        const positional: string[] = [];
        for (const token of removeArgs) {
          if (token === '--force') {
            forceFlag = true;
            continue;
          }
          if (token.startsWith('--')) {
            return makeInvalidArgs(token, `phase remove does not support ${token}`);
          }
          positional.push(token);
        }
        if (positional.length !== 1) {
          return makeInvalidArgs('<phase-number>', 'phase remove accepts exactly one phase number');
        }
        phase.cmdPhaseRemove(cwd, positional[0], { force: forceFlag }, raw);
        return { ok: true as const, data: null };
      },
      complete: (_ctx: Record<string, unknown>): { ok: true; data: null } => {
        // #2201: accept --phase N as well as the positional form (the state
        // family already accepts --phase). An unrecognized flag is a usage
        // error, not "Phase --phase not found".
        let phaseNum: string | null = null;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--phase') {
            phaseNum = args[++i];
            if (!phaseNum || phaseNum.startsWith('--'))
              return makeInvalidArgs('--phase', '--phase requires a value') as never;
          } else if (args[i].startsWith('--phase=')) {
            phaseNum = args[i].slice(8);
          } else if (args[i] === '--raw') {
            continue;
          } else if (args[i].startsWith('--')) {
            return makeInvalidArgs(args[i], `phase complete does not support ${args[i]}`) as never;
          } else {
            phaseNum = args[i];
          }
        }
        if (!phaseNum)
          return makeInvalidArgs('--phase', 'phase number required (positional or --phase N)') as never;
        phase.cmdPhaseComplete(cwd, phaseNum, raw);
        return { ok: true as const, data: null };
      },
      'uat-passed': (_ctx: Record<string, unknown>): { ok: true; data: null } => {
        let requireVerification = false;
        const positional: string[] = [];
        for (const token of args.slice(2)) {
          if (token === '--require-verification') {
            requireVerification = true;
          } else if (token === '--raw') {
            // --raw is handled by the outer CLI layer; accepted here silently
          } else if (token.startsWith('--')) {
            return makeInvalidArgs(token, `phase uat-passed does not support ${token}`) as never;
          } else {
            positional.push(token);
          }
        }
        phase.cmdPhaseUatPassed(cwd, positional[0], raw, { policy: { requireVerification } });
        return { ok: true as const, data: null };
      },
      // #1437 — list plan files for a phase
      'list-plans': (_ctx: Record<string, unknown>): { ok: true; data: null } => {
        // #2201: accept --phase N as well as positional.
        let phaseNum: string | null = null;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--phase') {
            phaseNum = args[++i];
            if (!phaseNum || phaseNum.startsWith('--'))
              return makeInvalidArgs('--phase', '--phase requires a value') as never;
          } else if (args[i].startsWith('--phase=')) {
            phaseNum = args[i].slice(8);
          } else if (args[i] === '--raw') {
            continue;
          } else if (args[i].startsWith('--')) {
            return makeInvalidArgs(args[i], `phase list-plans does not support ${args[i]}`) as never;
          } else {
            phaseNum = args[i];
          }
        }
        if (!phaseNum)
          return makeInvalidArgs('--phase', 'phase number required (positional or --phase N)') as never;
        phase.cmdPhaseListPlans(cwd, phaseNum, raw);
        return { ok: true as const, data: null };
      },
    },
  };

  // ── Build manifest (available subcommands for UnknownCommand detection) ─────
  // `availableSubcommands` is what the error message shows. It excludes
  // unsupported commands (already handled above) but does NOT include 'mvp-mode'
  // because it was absent from PHASE_SUBCOMMANDS in the original and was not
  // shown in the "Available:" list there either.
  //
  // `manifestSubcommands` is the full routing set for the hub — it includes
  // 'mvp-mode' (which the original code routed via a handler even without a
  // manifest entry) so the hub's UnknownCommand check passes for it.
  const availableSubcommands = PHASE_SUBCOMMANDS.filter(s => !UNSUPPORTED[s]);
  const manifestSubcommands = ['mvp-mode', ...availableSubcommands];
  const manifest = { phase: manifestSubcommands };

  // ── Construct hub ──────────────────────────────────────────────────────────
  // #175: Hub is CJS-only — no mode param, no sdkLoader.
  // #2620: wire the reference logger (ADR-0174 §6) only when observability is
  // opt-in enabled; otherwise leave it unset so the Hub stays byte-for-byte
  // silent via its no-op fallback.
  const hub = createHub({ cjsRegistry, manifest, logger: isAuditEnabled() ? createDefaultLogger({ cwd }) : undefined });

  // ── Dispatch ────────────────────────────────────────────────────────────────
  const result = hub.dispatch({
    family: 'phase',
    subcommand,
    args: args.slice(2),
    cwd,
    raw,
  });

  // ── Translate result → CLI output / error (adapter responsibility) ──────────
  // CJS handlers call output() themselves (inside phase.cmdPhase*()).
  // No further output call is needed here.
  if (!result.ok) {
    if (result.kind === ERROR_KINDS.UnknownCommand) {
      const available = availableSubcommands.join(', ');
      error(`Unknown phase subcommand. Available: ${available}`);
      return;
    }
    if (result.kind === ERROR_KINDS.InvalidArgs || result.kind === ERROR_KINDS.HandlerRefusal) {
      // #176: typed payload — reason holds the human-readable message
      error(result.reason);
      return;
    }
    // HandlerFailure: message field
    error(result.message);
    return;
  }
}

export = {
  routePhaseCommand,
};
