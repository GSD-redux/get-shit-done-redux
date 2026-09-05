/**
 * Verification-status subcommand router.
 * Routes `verification.status <phaseDir>` to verification.cmdVerificationStatus.
 *
 * Note: `verification` (reads verifier-emitted status) is distinct from `verify`
 * (runs verification checks like plan-structure/artifacts). Keep them separate.
 *
 * ADR-457 build-at-publish: source in src/verification-command-router.cts,
 * compiled to gsd-core/bin/lib/verification-command-router.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;

// ─── Types ────────────────────────────────────────────────────────────────────

interface VerificationModule {
  cmdVerificationStatus(cwd: string, phaseDirArg: string | undefined, raw: boolean): void;
  cmdVerificationResolveFile(cwd: string, phaseDirArg: string | undefined, raw: boolean): void;
  cmdVerificationFingerprint(cwd: string, phaseDirArg: string | undefined, files: string[], raw: boolean): void;
}

interface RouteVerificationCommandOptions {
  verification: VerificationModule;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const VERIFICATION_SUBCOMMANDS = ['status', 'resolve-file', 'fingerprint'];

function routeVerificationCommand({
  verification,
  args,
  cwd,
  raw,
  error,
}: RouteVerificationCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: VERIFICATION_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown verification subcommand. Available: ${available.join(', ')}`,
    handlers: {
      status: () => verification.cmdVerificationStatus(cwd, args[2], raw),
      'resolve-file': () => verification.cmdVerificationResolveFile(cwd, args[2], raw),
      fingerprint: () => verification.cmdVerificationFingerprint(cwd, args[2], args.slice(3), raw),
    },
  });
}

export = {
  routeVerificationCommand,
};
