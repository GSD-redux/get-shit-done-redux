/**
 * Learnings — Global knowledge store with CRUD operations
 *
 * Provides a cross-project learnings store at ~/.gsd/knowledge/.
 * Each learning is stored as an individual JSON file with content-hash
 * deduplication. Supports write, read, list, query, delete, copy-from-project,
 * and prune operations.
 *
 * Storage format: { id, source_project, date, context, learning, tags, content_hash }
 * File naming: {id}.json
 * Deduplication: SHA-256 of learning text + source_project
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/learnings.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error: coreError } = ioMod;
import { platformWriteSync } from './shell-command-projection.cjs';

// ─── Types ───────────────────────────────────────────────────────────────────

interface LearningRecord {
  id: string;
  source_project: string;
  date: string;
  context: string;
  learning: string;
  tags: string[];
  content_hash: string;
}

interface WriteEntry {
  source_project: string;
  learning: string;
  context?: string;
  tags?: string[];
}

interface WriteOpts {
  storeDir?: string;
  dedupeIndex?: Map<string, string>;
}

interface WriteResult {
  id: string;
  created: boolean;
  content_hash: string;
}

interface CopyResult {
  total: number;
  created: number;
  skipped: number;
}

interface PruneResult {
  removed: number;
  kept: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_STORE_DIR = path.join(os.homedir(), '.gsd', 'knowledge');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getStoreDir(opts?: WriteOpts | { storeDir?: string }): string {
  return (opts && opts.storeDir) || DEFAULT_STORE_DIR;
}

function ensureStoreDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function contentHash(learning: string, sourceProject: string): string {
  return crypto.createHash('sha256')
    .update(learning + '\n' + sourceProject)
    .digest('hex');
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}-${rand}`;
}

function readLearningFile(filePath: string): LearningRecord | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as LearningRecord;
  } catch (err) {
    process.stderr.write(`Warning: skipping malformed file ${filePath}: ${(err as Error).message}\n`);
    return null;
  }
}

// ─── CRUD Operations ─────────────────────────────────────────────────────────

function learningsWrite(entry: WriteEntry, opts?: WriteOpts): WriteResult {
  const dir = getStoreDir(opts);
  ensureStoreDir(dir);

  const hash = contentHash(entry.learning, entry.source_project);

  // #306: In bulk-import paths, callers may supply a pre-built dedupeIndex
  // (Map<content_hash, id>) to avoid the per-write O(N) store scan.
  if (opts && opts.dedupeIndex) {
    const dedupeIndex = opts.dedupeIndex;
    if (dedupeIndex.has(hash)) {
      return { id: dedupeIndex.get(hash) as string, created: false, content_hash: hash };
    }
    const id = generateId();
    const record: LearningRecord = {
      id,
      source_project: entry.source_project,
      date: new Date().toISOString(),
      context: entry.context || '',
      learning: entry.learning,
      tags: entry.tags || [],
      content_hash: hash,
    };
    platformWriteSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
    dedupeIndex.set(hash, id);
    return { id, created: true, content_hash: hash };
  }

  // Check for duplicate by scanning existing files (single-write path, unchanged)
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const existing = readLearningFile(path.join(dir, file));
    if (existing && existing.content_hash === hash) {
      return { id: existing.id, created: false, content_hash: hash };
    }
  }

  const id = generateId();
  const record: LearningRecord = {
    id,
    source_project: entry.source_project,
    date: new Date().toISOString(),
    context: entry.context || '',
    learning: entry.learning,
    tags: entry.tags || [],
    content_hash: hash,
  };

  platformWriteSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
  return { id, created: true, content_hash: hash };
}

function learningsRead(id: string, opts?: { storeDir?: string }): LearningRecord | null {
  if (!/^[a-z0-9]+-[a-f0-9]+$/.test(id)) return null;
  const dir = getStoreDir(opts);
  const filePath = path.join(dir, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return readLearningFile(filePath);
}

function learningsList(opts?: { storeDir?: string }): LearningRecord[] {
  const dir = getStoreDir(opts);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const results: LearningRecord[] = [];
  for (const file of files) {
    const record = readLearningFile(path.join(dir, file));
    if (record) results.push(record);
  }

  // Sort by date descending (newest first)
  results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return results;
}

function learningsQuery(query: { tag?: string }, opts?: { storeDir?: string }): LearningRecord[] {
  const all = learningsList(opts);
  if (query && query.tag) {
    return all.filter(r => r.tags && r.tags.includes(query.tag as string));
  }
  return all;
}

function learningsDelete(id: string, opts?: { storeDir?: string }): boolean {
  if (!/^[a-z0-9]+-[a-f0-9]+$/.test(id)) return false;
  const dir = getStoreDir(opts);
  const filePath = path.join(dir, `${id}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * #3683 — resolve which learnings artifact a copy reads. The extractor writes
 * phase-scoped `{PHASE_DIR}/{PADDED}-LEARNINGS.md`; the legacy shape is a
 * project-root `LEARNINGS.md`. The MOST RECENT phase-scoped artifact wins (a
 * gated completion copies the phase it just wrote); the project-root file is
 * the fallback when no phase artifact exists. Returns null when neither shape
 * is present.
 */
function resolveLearningsSource(planningDir: string): string | null {
  let best: { p: string; m: number } | null = null;
  const phasesDir = path.join(planningDir, 'phases');
  let phaseEntries: string[];
  try {
    phaseEntries = fs.readdirSync(phasesDir);
  } catch {
    phaseEntries = [];
  }
  for (const entry of phaseEntries) {
    const phaseDir = path.join(phasesDir, entry);
    let stat;
    try {
      stat = fs.statSync(phaseDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let files: string[];
    try {
      files = fs.readdirSync(phaseDir);
    } catch {
      // An unreadable phase dir (ACL, removal race) must not crash the copy —
      // skip it and keep scanning.
      continue;
    }
    for (const f of files) {
      if (!/-LEARNINGS\.md$/i.test(f)) continue;
      const p = path.join(phaseDir, f);
      try {
        const m = fs.statSync(p).mtimeMs;
        if (best === null || m > best.m) best = { p, m };
      } catch {
        continue;
      }
    }
  }
  if (best !== null) return best.p;
  const rootPath = path.join(planningDir, 'LEARNINGS.md');
  return fs.existsSync(rootPath) ? rootPath : null;
}

function learningsCopyFromProject(planningDir: string, opts?: WriteOpts & { sourceProject?: string }): CopyResult {
  const learningsPath = resolveLearningsSource(planningDir);
  if (learningsPath === null) {
    return { total: 0, created: 0, skipped: 0 };
  }

  const content = fs.readFileSync(learningsPath, 'utf-8');
  const sourceProject = (opts && opts.sourceProject) || path.basename(path.resolve(planningDir, '..'));

  // #306: Build the content_hash -> id dedupe index once before the loop so
  // that learningsWrite does not re-scan the entire store on every call —
  // O(K*N) -> O(N+K).
  const dir = getStoreDir(opts);
  ensureStoreDir(dir);
  const dedupeIndex = new Map<string, string>();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const existing = readLearningFile(path.join(dir, file));
    // First-seen-wins, matching the legacy scan path's first-match return so the
    // dedupe-hit `id` is identical on both paths even if the store already holds
    // duplicate content_hashes. (#306)
    if (existing && existing.content_hash && !dedupeIndex.has(existing.content_hash)) {
      dedupeIndex.set(existing.content_hash, existing.id);
    }
  }

  // Parse markdown: split on ## category headings.
  // #3683: the real producer (extract-learnings.md write_learnings) writes ##
  // categories containing ### item headings — each item is ONE learning (the
  // store's relevance contract caps injection by count, so category-sized
  // blobs defeat it). A bare ## section with no ### items keeps the legacy
  // single-learning shape.
  const sections = content.split(/^## /m).slice(1); // skip preamble before first ##
  let created = 0;
  let skipped = 0;

  const writeOne = (title: string, body: string, extraTags: string[]): void => {
    const tags = Array.from(new Set([
      ...extraTags,
      ...title.toLowerCase().split(/\s+/).filter(w => w.length > 2),
    ]));
    const result = learningsWrite({
      source_project: sourceProject,
      learning: body,
      context: title,
      tags,
    }, { ...opts, dedupeIndex });
    if (result.created) created++;
    else skipped++;
  };

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const category = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();
    if (!body) continue;
    const categoryTag = category.toLowerCase().split(/\s+/)[0] || '';

    // Split into ### items when present; otherwise one learning per section.
    const items = body.split(/^### /m).map(s => s.trim()).filter(s => s.length > 0);
    const hasItemHeadings = /^### /m.test(body);
    if (!hasItemHeadings) {
      writeOne(category, body, categoryTag ? [categoryTag] : []);
      continue;
    }
    for (const item of items) {
      const itemLines = item.split('\n');
      const title = itemLines[0].trim();
      const itemBody = itemLines.slice(1).join('\n').trim();
      if (!itemBody && !title) continue;
      writeOne(title, itemBody || title, categoryTag ? [categoryTag] : []);
    }
  }

  return { total: created + skipped, created, skipped };
}

function learningsPrune(olderThan: string, opts?: { storeDir?: string }): PruneResult {
  const match = /^(\d+)d$/.exec(olderThan);
  if (!match) {
    throw new Error(`Invalid duration format: "${olderThan}" — expected format like "90d"`);
  }

  const days = parseInt(match[1], 10);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const dir = getStoreDir(opts);

  if (!fs.existsSync(dir)) return { removed: 0, kept: 0 };

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let removed = 0;
  let kept = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const record = readLearningFile(filePath);
    if (!record) continue;

    const recordDate = new Date(record.date);
    if (recordDate < cutoff) {
      fs.unlinkSync(filePath);
      removed++;
    } else {
      kept++;
    }
  }

  return { removed, kept };
}

// ─── CLI Command Handlers ────────────────────────────────────────────────────

function cmdLearningsList(raw: boolean): void {
  const results = learningsList();
  output({ learnings: results, count: results.length }, raw, undefined);
}

function cmdLearningsQuery(tag: string, raw: boolean): void {
  const results = learningsQuery({ tag });
  output({ learnings: results, count: results.length, tag }, raw, undefined);
}

function cmdLearningsCopy(cwd: string, raw: boolean): void {
  const planDir = path.join(cwd, '.planning');
  const result = learningsCopyFromProject(planDir);
  output(result, raw, undefined);
}

function cmdLearningsPrune(olderThan: string, raw: boolean): void {
  try {
    const result = learningsPrune(olderThan);
    output(result, raw, undefined);
  } catch (err) {
    coreError((err as Error).message);
  }
}

function cmdLearningsDelete(id: string, raw: boolean): void {
  if (!/^[a-z0-9]+-[a-f0-9]+$/.test(id)) {
    coreError(`Invalid learning ID: "${id}"`);
  }
  const deleted = learningsDelete(id);
  output({ id, deleted }, raw, undefined);
}

export = {
  learningsWrite,
  learningsRead,
  learningsList,
  learningsQuery,
  learningsDelete,
  learningsCopyFromProject,
  learningsPrune,
  cmdLearningsList,
  cmdLearningsQuery,
  cmdLearningsCopy,
  cmdLearningsPrune,
  cmdLearningsDelete,
  DEFAULT_STORE_DIR,
};
