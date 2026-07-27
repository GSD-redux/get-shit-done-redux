/**
 * Installer migration: remove legacy Codex hooks.json GSD hook registrations.
 *
 * ADR-457 build-at-publish: the hand-written
 * bin/lib/installer-migrations/002-codex-legacy-hooks-json.cjs collapsed to a
 * TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */

import {
  isManagedHookCommand,
  isRecognizedCodexContextMonitorCommand,
} from '../shell-command-projection.cjs';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

interface PruneResult {
  value: JsonValue;
  changed: boolean;
}

interface HooksJsonRead {
  exists: boolean;
  error?: boolean;
  value?: JsonValue;
}

interface MigrationAction {
  type: string;
  relPath: string;
  value: JsonValue;
  deleteIfEmpty: boolean;
  reason: string;
  ownershipEvidence: string;
}

interface MigrationPlanContext {
  configDir: string;
  readJson(relPath: string): HooksJsonRead;
}

interface InstallerMigration {
  id: string;
  title: string;
  description: string;
  introducedIn: string;
  runtimes: string[];
  scopes: string[];
  destructive: boolean;
  runtimeContract: string;
  plan: (ctx: MigrationPlanContext) => MigrationAction[];
}

function isStructurallyEmpty(value: JsonValue): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== 'object') return false;
  for (const _key in value) return false;
  return true;
}

function isManagedCodexHookCommand(command: unknown, configDir: string): boolean {
  if (
    typeof command === 'string'
    && (
      command.includes('gsd-context-monitor.js')
      || command.includes('gsd-context-monitor.cmd')
    )
  ) {
    return isRecognizedCodexContextMonitorCommand(command, configDir);
  }
  return isManagedHookCommand(command, {
    surface: 'codex-hooks-json',
    includeLegacyAliases: true,
    configDir,
  });
}

function pruneLegacyCodexHooksJsonValue(value: JsonValue, configDir: string): PruneResult {
  if (Array.isArray(value)) {
    let changed = false;
    const next: JsonValue[] = [];
    for (const item of value) {
      const pruned = pruneLegacyCodexHooksJsonValue(item, configDir);
      if (pruned.changed) changed = true;
      if (pruned.changed && isStructurallyEmpty(pruned.value)) changed = true;
      else next.push(pruned.value);
    }
    return { value: next, changed };
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const valueObj = value as Record<string, JsonValue>;
    const command = valueObj['command'];
    if (isManagedCodexHookCommand(command, configDir)) {
      return { value: null, changed: true };
    }

    let changed = false;
    const nextEntries: Array<[string, JsonValue]> = [];
    for (const [key, child] of Object.entries(valueObj)) {
      const pruned = pruneLegacyCodexHooksJsonValue(child, configDir);
      if (pruned.changed) changed = true;
      if (pruned.changed && isStructurallyEmpty(pruned.value)) changed = true;
      else nextEntries.push([key, pruned.value]);
    }
    return { value: Object.fromEntries(nextEntries), changed };
  }

  return { value, changed: false };
}

const migration: InstallerMigration = {
  id: '2026-05-11-codex-legacy-hooks-json',
  title: 'Remove legacy Codex hooks.json GSD hook registrations',
  description: 'Remove legacy Codex hooks.json GSD hook registrations after config.toml migration.',
  introducedIn: '1.50.0',
  runtimes: ['codex'],
  scopes: ['global', 'local'],
  destructive: true,
  runtimeContract: 'docs/installer-migrations.md#runtime-configuration-contract-registry Codex row',
  plan: (ctx: MigrationPlanContext): MigrationAction[] => {
    const { configDir } = ctx;
    const hooksJson = ctx.readJson('hooks.json');
    if (!hooksJson.exists || hooksJson.error) return [];

    const pruned = pruneLegacyCodexHooksJsonValue(hooksJson.value, configDir);
    if (!pruned.changed) return [];

    return [
      {
        type: 'rewrite-json',
        relPath: 'hooks.json',
        value: pruned.value,
        deleteIfEmpty: true,
        reason: 'legacy Codex hooks.json GSD registration retired by installer migration',
        ownershipEvidence: 'pruned command is an exact retired monitor or target-confined update hook registration',
      },
    ];
  },
};

export = migration;
