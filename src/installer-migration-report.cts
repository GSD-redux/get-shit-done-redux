/**
 * Installer migration report utilities (ADR-457 build-at-publish: the
 * hand-written bin/lib/installer-migration-report.cjs collapsed to a TypeScript
 * source of truth). Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 *
 * Resolution environment variable surface for #3541 — when the installer
 * runs without a TTY (typical /gsd:update path via Claude Code or any
 * scripted update), prompt-user migration actions cannot be answered
 * interactively. Classification-based defaults apply; anything else falls
 * through to the hard assertion with a grouped, actionable error message.
 *
 * docs/installer-migrations.md#prompt-user-resolution for the spec.
 */

export const RESOLUTION_ENV_VAR = 'GSD_INSTALLER_MIGRATION_RESOLVE';
const VALID_CHOICES: ReadonlyArray<string> = ['keep', 'remove'];

// #3628: explicit whitelist of bundled hook files shipped in the npm
// distribution under `hooks/`. The classifier-based auto-removal of these
// files at first-time-baseline scan (added in #3610) is restricted to this
// set — a shape regex like `^hooks/gsd-[^/]+\.(?:js|sh|cjs|mjs)$` also
// matches user-authored custom hooks and retired bundled hooks from prior
// versions, and auto-removing those is silent data loss.
//
// The bug-3628 regression guard asserts this Set stays aligned with the
// on-disk `hooks/` directory in both directions: whitelist-but-missing
// AND shipped-but-not-whitelisted both fail CI.
export const BUNDLED_GSD_HOOK_FILES: ReadonlySet<string> = Object.freeze(new Set([
  'hooks/gsd-check-update-worker.js',
  'hooks/gsd-check-update.js',
  'hooks/gsd-config-reload.js',
  'hooks/gsd-context-monitor.js',
  'hooks/gsd-cursor-post-tool.js',
  'hooks/gsd-cursor-pre-tool.js',
  'hooks/gsd-cursor-session-start.js',
  'hooks/gsd-cursor-stop.js',
  'hooks/gsd-cursor-subagent-start.js',
  'hooks/gsd-cursor-subagent-stop.js',
  // Windsurf/Cascade blocking hooks — registered by writeWindsurfHooksJson (#2100).
  'hooks/gsd-windsurf-pre-write.js',
  'hooks/gsd-windsurf-pre-command.js',
  'hooks/gsd-ensure-canonical-path.js',
  'hooks/gsd-graphify-update.sh',
  'hooks/gsd-phase-boundary.sh',
  'hooks/gsd-prompt-guard.js',
  'hooks/gsd-read-guard.js',
  'hooks/gsd-read-injection-scanner.js',
  'hooks/gsd-session-state.sh',
  'hooks/gsd-statusline.js',
  'hooks/gsd-update-banner.js',
  'hooks/gsd-validate-commit.sh',
  'hooks/gsd-workflow-guard.js',
  'hooks/gsd-worktree-path-guard.js',
  'hooks/gsd-write-guard.js',
]));

// ── Internal action types ─────────────────────────────────────────────────────

interface MigrationAction {
  type: string;
  relPath?: string;
  reason?: string;
  migrationId?: string;
  migrationChecksum?: string;
  classification?: string;
  originalHash?: string | null;
  currentHash?: string | null;
  requestedType?: string;
  backupRelPath?: string | null;
  choices?: string[];
  deleteIfEmpty?: boolean;
  count?: number;
  actions?: MigrationAction[];
  [key: string]: unknown;
}

interface MigrationPlan {
  actions?: MigrationAction[];
  blocked?: MigrationAction[];
  [key: string]: unknown;
}

interface MigrationResult {
  blocked?: MigrationAction[];
  plan?: MigrationPlan;
  [key: string]: unknown;
}

interface SummaryRow {
  label: string;
  relPath: string;
  reason: string;
  action: MigrationAction;
}

interface SummarizeResult {
  hasReportableActions: boolean;
  blocked: MigrationAction[];
  rows: (SummaryRow | null)[];
}

interface Resolution {
  relPath: string | undefined;
  category: string;
  choice: string;
  reason: string | undefined;
  resolvedActionType: string;
  source: string;
}

interface ResolvePromptsResult {
  result: MigrationResult;
  resolutions: Resolution[];
}

interface ClassifyResult {
  category: string;
  choice: string;
}

interface ResolveOptions {
  isTty?: boolean;
  env?: Record<string, string | undefined>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function installerMigrationActionLabel(action: MigrationAction | null | undefined): string {
  if (!action || !action.type) return 'skipped';
  if (action.type === 'backup-and-remove') return 'backed up and removed';
  if (action.type === 'remove-managed') return 'removed';
  if (action.type === 'rewrite-json') return action.deleteIfEmpty ? 'rewrote or removed' : 'rewrote';
  if (action.type === 'record-baseline') return 'recorded';
  if (action.type === 'baseline-preserve-user') return 'preserved';
  if (action.type === 'preserve-user') return 'preserved';
  if (action.type === 'prompt-user') return 'blocked';
  return 'skipped';
}

function blockedInstallerMigrationActions(result: MigrationResult | null | undefined): MigrationAction[] {
  if (result && Array.isArray(result.blocked)) return result.blocked;
  const plan = result && result.plan;
  if (plan && Array.isArray(plan.blocked)) return plan.blocked;
  return [];
}

function baselineSummaryLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function baselineSummaryRow(type: string, actions: MigrationAction[]): SummaryRow {
  const count = actions.length;
  if (type === 'record-baseline') {
    return {
      label: 'recorded',
      relPath: baselineSummaryLabel(count, 'managed baseline file'),
      reason: 'first-time baseline scan',
      action: { type: 'record-baseline-summary', count, actions },
    };
  }
  return {
    label: 'preserved',
    relPath: baselineSummaryLabel(count, 'user baseline file'),
    reason: 'first-time baseline scan',
    action: { type: 'baseline-preserve-user-summary', count, actions },
  };
}

export function summarizeInstallerMigrationResult(result: MigrationResult | null | undefined): SummarizeResult {
  const plan = result && result.plan;
  const actions: MigrationAction[] = plan && Array.isArray(plan.actions) ? plan.actions : [];
  const blocked = blockedInstallerMigrationActions(result);
  const blockedSet = new Set(blocked);
  const rows: (SummaryRow | null)[] = [];
  const baselineIndexes = new Map<string, number>();
  const baselineActions = new Map<string, MigrationAction[]>();

  for (const action of actions) {
    const type = action && action.type;
    if (type === 'record-baseline' || type === 'baseline-preserve-user') {
      if (!baselineActions.has(type)) {
        baselineActions.set(type, []);
        baselineIndexes.set(type, rows.length);
        rows.push(null);
      }
      baselineActions.get(type)!.push(action);
      continue;
    }

    rows.push({
      label: blockedSet.has(action) ? 'blocked' : installerMigrationActionLabel(action),
      relPath: action.relPath ?? '',
      reason: action.reason || '',
      action,
    });
  }

  // Phase 4 requires action reporting without flooding first-time baseline installs:
  // docs/installer-migrations.md#phase-4-installupdate-integration.
  for (const [type, baselineRows] of baselineActions) {
    rows[baselineIndexes.get(type)!] = baselineSummaryRow(type, baselineRows);
  }

  return {
    hasReportableActions: actions.length > 0 || blocked.length > 0,
    blocked,
    rows,
  };
}

// Classify a blocked prompt-user action into one of the safe-default
// categories. Returns null when no safe default applies — caller must
// fall back to the hard assertion / interactive prompt for those.
//
// Stale SDK build artifacts live under gsd-core/sdk/{dist,src}/
// and are regenerated on every install, so removing them is lossless.
// User-facing skill anchors are the .md files that surface as commands
// to the user — these are user-owned and must be kept.
export function classifyPromptUserAction(action: MigrationAction): ClassifyResult | null {
  const relPath = action && action.relPath;
  if (typeof relPath !== 'string' || !relPath) return null;
  if (/^gsd-core\/sdk\/(dist|src)\//.test(relPath)) {
    return { category: 'stale-sdk-build-artifact', choice: 'remove' };
  }
  if (/^skills\/gsd-[^/]+\/SKILL\.md$/.test(relPath)) {
    return { category: 'user-facing-skill', choice: 'keep' };
  }
  // #3610 / #3628: bundled GSD hooks shipped under `hooks/`. The whitelist
  // is the explicit set of filenames in the npm distribution — files that
  // match the shape but are NOT in the whitelist (user-authored hooks,
  // retired hooks from prior versions) fall through to the block-or-prompt
  // flow so the user retains control. On a first-time-baseline scan the
  // installer can safely remove whitelisted hooks because it is about to
  // write the fresh bundled versions in their place.
  if (BUNDLED_GSD_HOOK_FILES.has(relPath)) {
    return { category: 'bundled-gsd-hook', choice: 'remove' };
  }
  return null;
}

// Convert a blocked prompt-user action into a concrete plan action.
// `keep` → baseline-preserve-user (idempotent — already on disk).
// `remove` → backup-and-remove (safe: keeps a rollback copy in the
// migration journal under gsd-migration-journal/<runId>-backups/).
function materializeResolution(action: MigrationAction, choice: string): MigrationAction {
  const base: MigrationAction = {
    type: '',          // overridden in each return branch below
    migrationId: action.migrationId,
    migrationChecksum: action.migrationChecksum,
    relPath: action.relPath,
    reason: action.reason,
    classification: action.classification,
    originalHash: action.originalHash || null,
    currentHash: action.currentHash || null,
    requestedType: 'prompt-user',
  };
  if (choice === 'keep') {
    return { ...base, type: 'baseline-preserve-user' };
  }
  // 'remove'
  return { ...base, type: 'backup-and-remove', backupRelPath: null };
}

function normalizeResolutionChoice(rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') return null;
  const normalized = rawValue.trim().toLowerCase();
  return VALID_CHOICES.includes(normalized) ? normalized : null;
}

function actionSupportsChoice(action: MigrationAction, choice: string): boolean {
  if (!action || !choice) return false;
  if (!Array.isArray(action.choices) || action.choices.length === 0) {
    return VALID_CHOICES.includes(choice);
  }
  return action.choices.includes(choice);
}

// Resolve prompt-user actions when stdin is not a TTY. Mutates the
// passed result so:
//   - resolved actions are appended to plan.actions in their concrete
//     form (baseline-preserve-user / backup-and-remove);
//   - result.blocked and plan.blocked are filtered to actions that
//     could NOT be safely defaulted (caller must still handle those).
// Returns { result, resolutions } where `resolutions` is the structured
// log of every defaulted resolution.
export function resolveInstallerMigrationPromptsForNonTty(
  result: MigrationResult,
  options: ResolveOptions = {},
): ResolvePromptsResult {
  if (!result || typeof result !== 'object') {
    return { result, resolutions: [] };
  }
  const blocked = blockedInstallerMigrationActions(result);
  if (blocked.length === 0) {
    return { result, resolutions: [] };
  }
  const isTty = options.isTty === true;
  if (isTty) {
    // Honour interactive prompting paths (not implemented yet — the
    // hard throw is still the right behaviour for TTY runs); resolver
    // only fires when the installer cannot interactively ask.
    return { result, resolutions: [] };
  }

  const env: Record<string, string | undefined> =
    options && options.env && typeof options.env === 'object'
      ? options.env
      : process.env;
  const envChoice = normalizeResolutionChoice(env && env[RESOLUTION_ENV_VAR]);
  const resolutions: Resolution[] = [];
  const unresolved: MigrationAction[] = [];

  for (const action of blocked) {
    if (action && action.type === 'prompt-user') {
      let category: string | null = null;
      let choice: string | null = null;
      let source: string | null = null;
      if (envChoice && actionSupportsChoice(action, envChoice)) {
        category = 'operator-override';
        choice = envChoice;
        source = RESOLUTION_ENV_VAR;
      } else {
        const classification = classifyPromptUserAction(action);
        if (classification) {
          category = classification.category;
          choice = classification.choice;
          source = 'non-tty-default';
        }
      }

      if (choice) {
        const resolved = materializeResolution(action, choice);
        // Replace the original prompt-user action in-place when present so
        // applyInstallerMigrationPlan never sees an unsupported action type.
        // Fallback to append only when the blocked action did not originate
        // from plan.actions (defensive).
        if (result.plan && Array.isArray(result.plan.actions)) {
          const idx = result.plan.actions.indexOf(action);
          if (idx >= 0) {
            result.plan.actions[idx] = resolved;
          } else {
            result.plan.actions.push(resolved);
          }
        }
        resolutions.push({
          relPath: action.relPath,
          category: category ?? '',
          choice: choice ?? '',
          reason: action.reason,
          resolvedActionType: resolved.type,
          source: source ?? '',
        });
        continue;
      }
    }
    unresolved.push(action);
  }

  // Mutate both the top-level and plan.blocked surfaces so downstream
  // callers (assertInstallerMigrationsUnblocked, summarizers) see the
  // post-resolution state.
  if (Array.isArray(result.blocked)) {
    result.blocked = unresolved;
  }
  if (result.plan && Array.isArray(result.plan.blocked)) {
    result.plan.blocked = unresolved;
  }

  return { result, resolutions };
}

// Group blocked prompt-user actions by their `reason` so the operator
// sees one summary line per cause instead of N path lines for the
// same underlying issue.
function groupBlockedByReason(blocked: MigrationAction[]): Map<string, MigrationAction[]> {
  const byReason = new Map<string, MigrationAction[]>();
  for (const action of blocked) {
    const reason = (action && action.reason) || 'no reason given';
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason)!.push(action);
  }
  return byReason;
}

function describeChoicesForActions(blocked: MigrationAction[]): string[] {
  const choiceSet = new Set<string>();
  for (const action of blocked) {
    if (action && Array.isArray(action.choices)) {
      for (const choice of action.choices) choiceSet.add(choice);
    }
  }
  if (choiceSet.size === 0) {
    for (const fallback of VALID_CHOICES) choiceSet.add(fallback);
  }
  return [...choiceSet];
}

function buildBlockedErrorMessage(blocked: MigrationAction[]): string {
  const byReason = groupBlockedByReason(blocked);
  const totalFiles = blocked.length;
  const choices = describeChoicesForActions(blocked);

  const lines: string[] = [
    `installer migration blocked pending user choice: ${totalFiles} file${totalFiles === 1 ? '' : 's'} need a decision`,
    `  choices: [${choices.join(', ')}]`,
  ];
  for (const [reason, actions] of byReason) {
    lines.push(`  - ${actions.length} file${actions.length === 1 ? '' : 's'}: ${reason}`);
    // Show up to 3 sample paths so operators can spot which files are
    // affected without dumping a thousand-line wall when SDK build
    // artifacts leak.
    const sample = actions.slice(0, 3).map((a) => a.relPath);
    if (sample.length > 0) {
      lines.push(`      e.g. ${sample.join(', ')}${actions.length > sample.length ? `, ... (+${actions.length - sample.length} more)` : ''}`);
    }
  }
  lines.push(
    `  resolve non-interactively by setting ${RESOLUTION_ENV_VAR}=<choice> ` +
    `(or run the installer in a TTY to be prompted per file).`
  );
  return lines.join('\n');
}

export function assertInstallerMigrationsUnblocked(result: MigrationResult | null | undefined): void {
  const blocked = blockedInstallerMigrationActions(result);
  if (blocked.length === 0) return;
  const message = buildBlockedErrorMessage(blocked);
  const error = Object.assign(new Error(message), {
    blocked,
    blockedByReason: Object.fromEntries(groupBlockedByReason(blocked)),
    resolutionEnvVar: RESOLUTION_ENV_VAR,
  });
  throw error;
}
