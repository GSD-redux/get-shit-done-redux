/**
 * Installer Migration Authoring — validation helpers for installer migration records and actions.
 *
 * ADR-457 build-at-publish: the hand-written
 * bin/lib/installer-migration-authoring.cjs collapsed to a TypeScript source
 * of truth. Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 */

import path from 'node:path';
import { posixNormalize } from './shell-command-projection.cjs';

/** An unvalidated migration record supplied by the caller. */
export type MigrationRecord = Record<string, unknown>;

/** A migration action (open shape). */
export type MigrationAction = Record<string, unknown>;

function getStr(record: MigrationRecord, field: string): string {
  const v = record[field];
  return typeof v === 'string' ? v : '';
}

function requireNonEmptyString(record: MigrationRecord, field: string, source: string): void {
  const v = record[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`migration record must include a non-empty ${field}: ${source}`);
  }
}

function isNonEmptyStringArray(arr: unknown): arr is string[] {
  return Array.isArray(arr) && arr.length > 0 && arr.every((v) => typeof v === 'string' && v.trim() !== '');
}

function validateStringArray(record: MigrationRecord, field: string, source: string): void {
  if (record[field] === undefined) return;
  if (!isNonEmptyStringArray(record[field])) {
    throw new Error(`migration record ${field} must be a non-empty string array when provided: ${source}`);
  }
}

function requireStringArray(record: MigrationRecord, field: string, source: string): void {
  if (!isNonEmptyStringArray(record[field])) {
    throw new Error(`migration record ${field} must be a non-empty string array: ${source}`);
  }
}

function recordSource(record: MigrationRecord, fallback: string | undefined): string {
  const id = getStr(record, 'id');
  return fallback ?? (id.trim() ? id : '<unknown>');
}

function actionSource(migration: MigrationRecord, action: MigrationAction): string {
  const migrationId = getStr(migration, 'id') || '<unknown>';
  const relPath = getStr(action, 'relPath') || '<unknown>';
  return `${migrationId} ${relPath}`;
}

function requireActionEvidence(action: MigrationAction, field: string, migration: MigrationRecord): void {
  const v = action[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`migration action ${getStr(action, 'type')} must include ${field}: ${actionSource(migration, action)}`);
  }
}

function validateSafeRelPath(relPath: string, migration: MigrationRecord, actionType: string): void {
  const source = actionSource(migration, { relPath });
  const normalized = posixNormalize(relPath);
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error(`migration action ${actionType} relPath must stay inside configDir: ${source}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`migration action ${actionType} relPath must stay inside configDir: ${source}`);
  }
}

export function validateInstallerMigrationRecord(record: unknown, source?: string): MigrationRecord {
  const rec = record as MigrationRecord;
  const displaySource = recordSource(rec, source);
  if (!record || typeof record !== 'object') {
    throw new Error(`migration record must export an object: ${displaySource}`);
  }

  // Authoring contract follows docs/installer-migrations.md#authoring-workflow
  // and docs/adr/0008-installer-migration-module.md#decision.
  requireNonEmptyString(rec, 'id', displaySource);
  requireNonEmptyString(rec, 'title', displaySource);
  requireNonEmptyString(rec, 'description', displaySource);
  requireNonEmptyString(rec, 'introducedIn', displaySource);
  if (typeof rec['destructive'] !== 'boolean') {
    throw new Error(`migration record must declare destructive as a boolean: ${displaySource}`);
  }
  validateStringArray(rec, 'runtimes', displaySource);
  requireStringArray(rec, 'scopes', displaySource);
  if (typeof rec['plan'] !== 'function') {
    throw new Error(`migration record must include a plan function: ${displaySource}`);
  }

  return rec;
}

export function validateInstallerMigrationActions(actions: unknown, migration: MigrationRecord): MigrationAction[] {
  if (!Array.isArray(actions)) {
    throw new Error(`migration ${getStr(migration, 'id')} plan must return an array`);
  }

  for (const action of actions as unknown[]) {
    if (!action || typeof action !== 'object') {
      throw new Error(`migration action must be an object: ${getStr(migration, 'id')}`);
    }
    const act = action as MigrationAction;
    const actType = getStr(act, 'type');
    const actRelPath = getStr(act, 'relPath');
    if (!actType || actType.trim() === '') {
      throw new Error(`migration action must include a non-empty type: ${getStr(migration, 'id')}`);
    }
    if (!actRelPath || actRelPath.trim() === '') {
      throw new Error(`migration action ${actType} must include a non-empty relPath: ${getStr(migration, 'id')}`);
    }
    validateSafeRelPath(actRelPath, migration, actType);
    // Ownership and runtime-contract evidence are required by
    // docs/installer-migrations.md#action-types and
    // docs/adr/0008-installer-migration-module.md#runtime-contract-decision.
    // `remove-empty-dir` carries the same evidence bar as `remove-managed`: it is
    // still a destructive removal, just of a directory node instead of a file.
    if (actType === 'remove-managed' || actType === 'rewrite-json' || actType === 'remove-empty-dir') {
      requireActionEvidence(act, 'ownershipEvidence', migration);
    }
    if (actType === 'rewrite-json') {
      const rc = getStr(migration, 'runtimeContract');
      if (!rc || rc.trim() === '') {
        throw new Error(`migration action rewrite-json requires migration runtimeContract: ${actionSource(migration, act)}`);
      }
    }
  }

  return actions as MigrationAction[];
}
