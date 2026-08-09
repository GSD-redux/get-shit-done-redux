/**
 * Installer migration: retire pi's legacy `<piConfigDir>/hooks/` directory
 * after GSD's shared hook bundle moved to `<piConfigDir>/gsd-hooks/` (#3023).
 *
 * What old artifact is being retired?
 *   `hooks/` (and its `hooks/lib/` subdirectory) at the pi config root. pi
 *   reserves that exact name as its own deprecated extension directory and
 *   warns on every startup whenever it exists — pi's
 *   `checkDeprecatedExtensionDirs()` fires on mere PATH EXISTENCE, not on the
 *   directory having contents (unlike the sibling `tools/` check, which does
 *   `readdir` first). GSD used to install its shared hook bundle at exactly
 *   that reserved path, so every pi install carried the warning permanently.
 *   The fix moved the install target to `gsd-hooks/`
 *   (`hostBehaviors.sharedHooksDirName`), but an EXISTING install that
 *   upgrades still has the old `hooks/` tree sitting on disk — nothing
 *   removes it on its own, so the warning would persist forever without this
 *   migration.
 *
 * How do we prove it is GSD-owned?
 *   Per file, by manifest membership — the same `classifyArtifact()` check
 *   every other migration in this directory uses. Pre-#3023 pi installs
 *   record the shared hook bundle under `hooks/…` keys in
 *   `gsd-file-manifest.json`; the new install target writes `gsd-hooks/…`
 *   keys instead, which this migration structurally never sees because it
 *   only ever walks the `hooks/` subtree.
 *
 * What happens if the user modified it?
 *   `backup-and-remove` instead of `remove-managed`, so a locally patched
 *   hook script is recoverable from the backup rather than silently
 *   destroyed — mirrors migration 006.
 *
 * What happens to files the manifest never recorded?
 *   Nothing. An unmanifested file under `hooks/` (classification `unknown`)
 *   is left exactly where it is, and — because its presence keeps the
 *   directory non-empty — it also keeps the directory itself from being
 *   retired. That is a deliberate consequence of directory removal being
 *   gated on emptiness, not a special case.
 *
 * What happens to the directory itself?
 *   `hooks/lib/` and then `hooks/` each get a `remove-empty-dir` action (see
 *   `evaluateRemoveEmptyDir` in `../installer-migrations.cts`). That action
 *   only ever calls `fs.rmdirSync` — never a recursive removal — and
 *   re-checks emptiness immediately before doing so, so a directory that
 *   still holds anything (an unmanifested file, or a file-level action that
 *   failed to apply) is left in place rather than assumed empty. Actions are
 *   emitted deepest-first (`hooks/lib` before `hooks`) so the parent has a
 *   chance to become empty in the same pass.
 *
 * What happens if it is missing?
 *   No actions. A fresh post-#3023 pi install never creates `hooks/` at all,
 *   and an already-migrated install has nothing left to retire — both plan
 *   empty, so the migration is idempotent.
 *
 * What runtime and scope does it affect?
 *   pi only, global and local. No other runtime's install is affected:
 *   `hostBehaviors.sharedHooksDirName` defaults to `'hooks'` for every other
 *   runtime, and none of them reserve that name the way pi does, so a
 *   claude/kimi/opencode/etc. `hooks/` directory is a live, in-use install
 *   surface that must never be touched here. The runtime check is the FIRST
 *   thing `plan()` does, ahead of even checking whether the directory exists,
 *   as defense in depth beyond the `runtimes: ['pi']` record-level filter the
 *   framework itself already enforces.
 *
 * Is the action safe in non-interactive install?
 *   Yes. Every emitted action type (`remove-managed`, `backup-and-remove`,
 *   `remove-empty-dir`) is non-interactive and journaled; none requires a
 *   user choice, and unknown files never produce an action.
 *
 * See docs/installer-migrations.md#shipped-migrations, the pi row of
 * docs/installer-migrations.md#runtime-configuration-contract-registry, and
 * the 2026-08-07 amendment to docs/adr/0008-installer-migration-module.md.
 */

import fs from 'node:fs';
import path from 'node:path';

interface ClassifiedArtifact {
  classification: string;
  [key: string]: unknown;
}

type ActionType = 'remove-managed' | 'backup-and-remove' | 'remove-empty-dir';

interface MigrationAction {
  type: ActionType;
  relPath: string;
  reason: string;
  ownershipEvidence: string;
  classification?: string;
  originalHash?: string | null;
  currentHash?: string | null;
}

interface MigrationPlanContext {
  configDir: string;
  runtime: string | null;
  classifyArtifact(relPath: string): ClassifiedArtifact;
}

interface InstallerMigration {
  id: string;
  title: string;
  description: string;
  introducedIn: string;
  runtimes: string[];
  scopes: string[];
  destructive: boolean;
  plan: (ctx: MigrationPlanContext) => MigrationAction[];
}

/** pi's reserved (and, pre-#3023, GSD-populated) legacy hook directory name. */
const HOOKS_DIR = 'hooks';

const FILE_REASON =
  "pi's startup check warns whenever hooks/ exists (checkDeprecatedExtensionDirs), and GSD's shared " +
  'hook bundle now installs at gsd-hooks/ instead (#3023), so the legacy files are superseded';

const FILE_OWNERSHIP_EVIDENCE =
  'pre-#3023 pi installs record the shared hook bundle under hooks/… keys in gsd-file-manifest.json; ' +
  'the new install target is gsd-hooks/…, which this migration never touches because it only walks the ' +
  'hooks/ subtree';

const DIR_REASON =
  "pi's checkDeprecatedExtensionDirs() warns on hooks/'s mere existence, not its contents (#3023); the " +
  'reserved container is retired once every GSD-owned entry inside it is gone';

const DIR_OWNERSHIP_EVIDENCE =
  'hooks/ and hooks/lib/ are GSD-installed container directories under the pi config root (the pre-#3023 ' +
  'default of hostBehaviors.sharedHooksDirName); removal is gated on emptiness by the shared ' +
  'remove-empty-dir action, so a directory that still holds an unmanifested user file — or any file-level ' +
  'action that failed to apply — is left in place rather than assumed empty';

/**
 * Recursively collect files and directories under `relDir`, never following a
 * symlink (whether it names a file or a directory) and never emitting a path
 * that resolves outside `baseResolved`. Mirrors the traversal guard in
 * migration 003 (`walkLegacyFiles`).
 */
function walkPiHooksTree(root: string, relDir: string, baseResolved: string, files: string[], dirs: string[]): void {
  const dir = path.join(root, relDir);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Never follow a symlink into or through: it must not be traversed,
    // hashed, or removed, regardless of what it points at.
    if (entry.isSymbolicLink()) continue;
    const relPath = path.posix.join(relDir, entry.name);
    const resolved = path.resolve(root, relPath);
    if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) continue;
    if (entry.isDirectory()) {
      dirs.push(relPath);
      walkPiHooksTree(root, relPath, baseResolved, files, dirs);
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
}

const migration: InstallerMigration = {
  id: '2026-08-07-pi-retire-reserved-hooks-dir',
  title: "Retire pi's reserved hooks/ directory",
  description:
    'Remove manifest-managed files under <piConfigDir>/hooks/ and, once empty, the directory itself ' +
    '(and its hooks/lib/ subdirectory), now that the shared hook bundle installs at gsd-hooks/ instead. pi ' +
    'reserves hooks/ as its own deprecated extension directory and warns on every startup while it exists (#3023).',
  introducedIn: '1.9.2',
  runtimes: ['pi'],
  scopes: ['global', 'local'],
  destructive: true,
  plan: (ctx: MigrationPlanContext): MigrationAction[] => {
    // Defense in depth ahead of the framework's own runtimes filter: a
    // claude/kimi/opencode/etc. hooks/ directory is a live install surface,
    // never a retirement target.
    if (ctx.runtime !== 'pi') return [];

    const hooksRoot = path.join(ctx.configDir, HOOKS_DIR);

    let rootLstat: fs.Stats;
    try {
      rootLstat = fs.lstatSync(hooksRoot);
    } catch {
      return []; // absent -> nothing to retire, idempotent
    }
    // Never follow a symlinked hooks/ root: walking through it could plan
    // actions against paths outside the pi config directory entirely.
    if (rootLstat.isSymbolicLink()) return [];
    if (!rootLstat.isDirectory()) return [];

    const baseResolved = path.resolve(ctx.configDir);
    const files: string[] = [];
    const dirs: string[] = [];
    try {
      walkPiHooksTree(ctx.configDir, HOOKS_DIR, baseResolved, files, dirs);
    } catch {
      // Unreadable directory: nothing safe to plan.
      return [];
    }

    const actions: MigrationAction[] = [];
    for (const relPath of files) {
      const { classification } = ctx.classifyArtifact(relPath);
      if (classification === 'managed-pristine') {
        actions.push({ type: 'remove-managed', relPath, reason: FILE_REASON, ownershipEvidence: FILE_OWNERSHIP_EVIDENCE });
      } else if (classification === 'managed-modified') {
        actions.push({ type: 'backup-and-remove', relPath, reason: FILE_REASON, ownershipEvidence: FILE_OWNERSHIP_EVIDENCE });
      }
      // 'unknown' (user-added, not manifest-recorded): no action, preserved.
      // 'missing' / 'managed-missing': impossible here — relPath was just
      // discovered by walking the live filesystem, so it currently exists.
    }

    // Deepest directories first, so a child has already been evaluated (and
    // possibly removed) before its parent's own emptiness is re-checked by
    // the executor. `hooks/` itself is appended last, unconditionally: the
    // executor's own emptiness re-check is what actually decides whether it
    // goes, not this ordering — this ordering only gives it the chance to.
    const orderedDirs = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
    orderedDirs.push(HOOKS_DIR);

    for (const relPath of orderedDirs) {
      actions.push({
        type: 'remove-empty-dir',
        relPath,
        reason: DIR_REASON,
        ownershipEvidence: DIR_OWNERSHIP_EVIDENCE,
        // Declared, not derived: classifyArtifact() hashes file contents via
        // sha256File(), which throws EISDIR against a directory path. These
        // relPaths name directories, so classification is stated directly
        // (never 'unknown', so the planner's unknown-classification block
        // never fires for them) rather than routed through the file
        // classifier.
        classification: 'managed-pristine',
        originalHash: null,
        currentHash: null,
      });
    }

    return actions;
  },
};

export = migration;
