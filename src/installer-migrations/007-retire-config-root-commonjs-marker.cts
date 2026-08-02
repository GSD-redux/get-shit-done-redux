/**
 * Installer migration: retire the config-root `{"type":"commonjs"}` marker that
 * pre-#2544 installs wrote over `<configRoot>/package.json`.
 *
 * What old artifact is being retired?
 *   `package.json` at the runtime config root. Before #2544,
 *   `installSharedHooksBundle(destRootDir)` wrote `{"type":"commonjs"}` there
 *   unconditionally on every install and every re-install, to pin GSD's staged
 *   `.js` hook scripts to CommonJS via Node's ancestor walk. #2544 moved that
 *   marker into the directories GSD actually fills (`hooks/`, and the
 *   `nativePlugin.dir` for runtimes declaring one) and stopped writing the
 *   config root at all. Without this migration an upgrader keeps BOTH markers:
 *   the new one under `hooks/` and the stale one at the root, so the config
 *   root stays pinned to CommonJS and the PR's own claim — that GSD no longer
 *   writes the shared config root — is false for every install made since the
 *   marker was introduced, until the user uninstalls.
 *
 * How do we prove it is GSD-owned?
 *   By exact content match, NOT by the manifest. The config-root marker was
 *   never recorded in `gsd-file-manifest.json` — `writeManifest()` records
 *   `hooks/`, `agents/`, `commands/`, `scripts/`, and the native plugin, and
 *   has never had a `manifest.files['package.json']` entry — so
 *   `classifyArtifact('package.json')` answers `unknown` and the planner's
 *   own guard would downgrade a `remove-managed` to `preserve-user`.
 *   This migration therefore supplies the "purpose-built detector for an old
 *   GSD-owned shape" that `docs/installer-migrations.md#remove-managed`
 *   sanctions, and declares the resulting classification on the action: the
 *   file is removed only when its bytes are exactly the marker GSD writes
 *   (`{"type":"commonjs"}`, trailing whitespace tolerated). That is the same
 *   predicate `removeCommonJsMarker` has always used on the uninstall side, so
 *   install, uninstall, and migration cannot drift apart.
 *
 * What happens if the user modified it?
 *   Then it is not the marker, and this migration does not touch it. Any
 *   `package.json` carrying a `name`, `dependencies`, `scripts`, or any key
 *   beyond the single `type` — i.e. every file the #2544 defect destroyed —
 *   fails the exact-content test and is left exactly as found. There is
 *   deliberately no `backup-and-remove` branch: a modified file here is not a
 *   patched GSD artifact, it is somebody else's file.
 *
 * What happens if it is missing?
 *   No actions. Fresh post-#2544 installs never wrote it, already-migrated
 *   installs no longer have it, and the executor additionally journals a
 *   `missing` outcome if it disappears between plan and apply. Idempotent.
 *
 * What runtime and scope does it affect?
 *   Every runtime whose config root received the marker — i.e. every runtime
 *   not excluded from `installSharedHooksBundle(targetDir)` by
 *   `hostBehaviors.skipSharedHooksInstall` and not Codex: antigravity,
 *   augment, claude, claude-local, codebuddy, hermes, qwen, kilo, opencode,
 *   and pi. The `runtimes` field is OMITTED — the framework's "all runtimes" —
 *   rather than carrying that hand-list: a runtime that never received the
 *   marker simply has no file to match, so enumerating them would add a second
 *   place for the set to drift out of date without changing behavior. Note it
 *   must be omitted and not `[]`; see the field's own comment below.
 *
 *   ONE DELIBERATE CARVE-OUT — kimi. Kimi's marker was written to its native
 *   hook root (`~/.kimi`, `resolveKimiHooksTomlDir`), which is NOT under
 *   kimi's `configDir` (its generic Agent-Skills root). Migration relPaths are
 *   structurally confined to `configDir` (`validateSafeRelPath` /
 *   `ensureInsideConfig`), so this framework cannot address that path at all.
 *   Kimi's stale root marker is retired by the installer instead, at the same
 *   call site that writes its replacement — see the `kimi-hooks-toml` branch
 *   in `bin/install.js`. Named here so the gap is not mistaken for an
 *   oversight.
 *
 * Is the action safe in non-interactive install?
 *   Yes. `remove-managed` is non-interactive and journaled, the executor takes
 *   a rollback snapshot before unlinking, and no branch of this migration can
 *   emit `prompt-user`. A file that is not byte-identical to GSD's marker
 *   produces no action at all.
 *
 * See docs/installer-migrations.md#shipped-migrations and #action-types.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type ArtifactClassification = string;

interface ClassifiedArtifact {
  classification: ArtifactClassification;
  [key: string]: unknown;
}

type ActionType = 'remove-managed';

interface MigrationAction {
  type: ActionType;
  relPath: string;
  reason: string;
  ownershipEvidence: string;
  classification: string;
  originalHash: string;
  currentHash: string;
}

interface MigrationPlanContext {
  configDir: string;
  classifyArtifact(relPath: string): ClassifiedArtifact;
}

interface InstallerMigration {
  id: string;
  title: string;
  description: string;
  introducedIn: string;
  /**
   * OMITTED, not `[]`, to mean "every runtime". The authoring validator treats
   * the field as optional but requires it to be NON-EMPTY when present
   * (`validateStringArray`), while the runtime filter treats an empty array the
   * same as an absent one. Only the validator actually runs on the record, so
   * `runtimes: []` throws at plan time and the migration never executes.
   */
  runtimes?: string[];
  scopes: string[];
  destructive: boolean;
  plan: (ctx: MigrationPlanContext) => MigrationAction[];
}

/** The config-root path the pre-#2544 installer wrote, relative to configDir. */
const STALE_ROOT_MARKER = 'package.json';

/**
 * The exact marker content GSD wrote. Duplicated as a literal rather than
 * imported from `src/commonjs-marker.cts` on purpose: a migration record is a
 * frozen historical statement about what a PAST version installed, and it must
 * keep matching those bytes even if the live module's constant is ever changed.
 * Importing would silently re-point this detector at a future value.
 */
const LEGACY_MARKER_CONTENT = '{"type":"commonjs"}';

const OWNERSHIP_EVIDENCE =
  'file content is byte-identical to the {"type":"commonjs"} marker pre-#2544 installs '
  + 'wrote at the config root (installSharedHooksBundle); same exact-content predicate '
  + 'removeCommonJsMarker uses on uninstall. Never manifest-recorded, so this is the '
  + 'purpose-built detector permitted by docs/installer-migrations.md#remove-managed';

const REASON =
  'superseded by the hooks/ and plugin-dir markers (#2544); leaving it pins the shared '
  + 'config root to CommonJS and keeps GSD occupying a file it no longer writes';

const migration: InstallerMigration = {
  id: '2026-07-28-retire-config-root-commonjs-marker',
  title: 'Retire the pre-#2544 config-root CommonJS marker',
  description:
    'Remove <configRoot>/package.json when it is exactly the {"type":"commonjs"} marker '
    + 'pre-#2544 installs wrote there, now superseded by markers scoped to the directories '
    + 'GSD owns. A package.json with any other content is left untouched.',
  introducedIn: '1.8.0',
  scopes: ['global', 'local'],
  destructive: true,
  plan: (ctx: MigrationPlanContext): MigrationAction[] => {
    const markerPath = path.join(ctx.configDir, STALE_ROOT_MARKER);

    let stat: import('node:fs').Stats;
    try {
      // lstat, not existsSync: existsSync follows symlinks and reports false for
      // a dangling one. A symlink here is not something GSD wrote, and removing
      // it is never ours to do — mirrors classifyMarker's fail-closed posture.
      stat = fs.lstatSync(markerPath);
    } catch {
      return [];
    }
    if (!stat.isFile()) return [];

    let content: string;
    try {
      content = fs.readFileSync(markerPath, 'utf8');
    } catch {
      // Present but unreadable never downgrades to the permissive answer.
      return [];
    }
    if (content.trim() !== LEGACY_MARKER_CONTENT) return [];

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return [
      {
        type: 'remove-managed',
        relPath: STALE_ROOT_MARKER,
        reason: REASON,
        ownershipEvidence: OWNERSHIP_EVIDENCE,
        // Declared, not derived: classifyArtifact answers 'unknown' for this
        // never-manifested path, and the planner downgrades a remove-managed on
        // an 'unknown' classification to preserve-user. The exact-content match
        // above IS the ownership proof, so the classification is stated here.
        classification: 'managed-pristine',
        originalHash: hash,
        currentHash: hash,
      },
    ];
  },
};

export = migration;
