/**
 * Milestone Lock — advisory (phase, session) claim over the single Current
 * Position slot in STATE.md (#3311).
 *
 * Problem it solves: two sessions running DIFFERENT phases in the same working
 * tree both read-modify-write `## Current Position`. The byte-level STATE.md
 * lock (#464) already serializes those writes, so no write is lost — but the
 * SEMANTIC clobber is silent: `state.advance-plan` takes no phase argument and
 * advances whatever plan the (possibly just clobbered) Current Position names,
 * and nothing ever surfaces that two sessions claimed two different phases
 * against the one single-slot field.
 *
 * This module is the maintainer-chosen fix (issue #3311 comment): a milestone
 * lock keyed by phase + session id, with a second session WARNED instead of
 * silently overwriting. It is an advisory claim file, not a mutex:
 *
 * - `.planning/milestone.lock` (workstream-scoped via planningDir) holds
 *   `{ phase, session, pid, updated_at }`.
 * - Session identity reuses `getWorkstreamSessionKey()`
 *   (active-workstream-store.cjs): env-first (GSD_SESSION_KEY,
 *   CLAUDE_SESSION_ID, CODEX_THREAD_ID, …), then the controlling TTY. Two
 *   agent sessions in different terminals/runtimes resolve different keys;
 *   headless runs resolve to null.
 * - Liveness is age-based only: a claim is live while
 *   `now - updated_at < MILESTONE_LOCK_TTL_MS`. There is deliberately NO
 *   pid-liveness gate — CLI invocations are short-lived, so the recorded pid
 *   is dead by the next invocation regardless of whether the agent SESSION is
 *   still active; pid-death would make every claim instantly stale. Active
 *   sessions heartbeat their claim (advance-plan on a matching position
 *   refreshes updated_at); an abandoned claim self-expires after the TTL.
 * - Conflict rule: a live claim for a DIFFERENT phase held by a DIFFERENT
 *   session. Same phase never conflicts (the lock is keyed by phase — two
 *   sessions on one phase are doing the same work). A non-null session key
 *   equal to the caller's never conflicts (one orchestrating session may
 *   re-target its own claim). A null session key never counts as "same" as
 *   anything, so headless parallel phases are still detected. The one
 *   exception is advance-plan (checkMilestonePosition), which reports ANY
 *   live claim/position phase mismatch regardless of session — a session's
 *   own legitimate re-targeting goes through begin-phase, which keeps the
 *   claim in sync, so a same-session mismatch is just as anomalous.
 * - On conflict the existing claim is LEFT INTACT (not stolen): as long as two
 *   phases are concurrently active, every Current Position mutation keeps
 *   reporting the conflict. The conflicting command still proceeds (warn, not
 *   block — a stale-but-live claim must not brick later sessions).
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock } from './clock.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- active-workstream-store.cjs is an export= CommonJS module
import activeWorkstreamStore = require('./active-workstream-store.cjs');

export const MILESTONE_LOCK_FILENAME = 'milestone.lock';

/**
 * How long a claim stays live without a heartbeat. Active sessions heartbeat
 * on every advance-plan against their claimed phase; a phase's planning stage
 * (begin-phase → first completed plan) can legitimately run for hours, so the
 * floor must comfortably exceed the longest expected gap between heartbeats
 * while still expiring an abandoned claim within a working day.
 */
export const MILESTONE_LOCK_TTL_MS = 4 * 60 * 60 * 1000;

interface MilestoneClaim {
  phase: string;
  session: string | null;
  pid: number;
  updated_at: number;
}

export interface MilestoneConflict {
  /** Phase the live claim holds. */
  locked_phase: string;
  /** Session key of the live claim's holder (null = headless/unknown). */
  locked_session: string | null;
  /** Phase the calling command targets / the Current Position names. */
  phase: string;
  /** Calling session's key (null = headless/unknown). */
  session: string | null;
}

function milestoneLockPath(cwd: string): string {
  return path.join(planningWorkspace.planningDir(cwd), MILESTONE_LOCK_FILENAME);
}

/**
 * Normalize a phase token for claim comparison: trim, and collapse an integer
 * spelling to its canonical form so "01", "1" and " 1 " compare equal while
 * decimals ("2.5") compare by their trimmed text.
 */
function normalizePhaseToken(value: string): string {
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) return String(parseInt(trimmed, 10));
  return trimmed;
}

function sameSession(a: string | null, b: string | null): boolean {
  // A null key is "unknown", not "equal" — two headless sessions must still
  // conflict across phases (the CI/cron shape of #3311).
  if (a === null || b === null) return false;
  return a === b;
}

function parseClaim(raw: string | null | undefined): MilestoneClaim | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MilestoneClaim>;
    if (typeof parsed.phase !== 'string' || !parsed.phase.trim()) return null;
    return {
      phase: parsed.phase,
      session: typeof parsed.session === 'string' ? parsed.session : null,
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : 0,
    };
  } catch {
    // Corrupt body (concurrent partial write, hand edit) — treat as no claim.
    // The next writer replaces the file; never crash a state command over an
    // advisory sidecar.
    return null;
  }
}

function readClaim(cwd: string): MilestoneClaim | null {
  try {
    return parseClaim(fs.readFileSync(milestoneLockPath(cwd), 'utf-8'));
  } catch {
    return null; // absent or unreadable — same posture as parseClaim
  }
}

function writeClaim(cwd: string, claim: MilestoneClaim): void {
  ensureClaimDir(cwd);
  fs.writeFileSync(milestoneLockPath(cwd), JSON.stringify(claim, null, 2) + '\n');
}

// planningWorkspace.planningDir targets .planning (or the workstream-scoped
// variant); the parent is created by every GSD command that gets this far, but
// the claim write must not throw if it is somehow missing.
function ensureClaimDir(cwd: string): void {
  try {
    fs.mkdirSync(path.dirname(milestoneLockPath(cwd)), { recursive: true });
  } catch {
    /* best-effort — see writeClaim callers' advisory posture */
  }
}

function isClaimLive(claim: MilestoneClaim, nowMs: number): boolean {
  return nowMs - claim.updated_at < MILESTONE_LOCK_TTL_MS;
}

function currentSessionKey(): string | null {
  return activeWorkstreamStore.getWorkstreamSessionKey();
}

function toConflict(claim: MilestoneClaim, phase: string, session: string | null): MilestoneConflict {
  return {
    locked_phase: claim.phase,
    locked_session: claim.session,
    phase,
    session,
  };
}

/**
 * Human-visible warning for a conflict. Emitted on stderr unconditionally —
 * visibility is the entire point of this lock (#3311's "silent last-write-wins").
 */
export function warnMilestoneConflict(conflict: MilestoneConflict, action: string): void {
  const holder = conflict.locked_session ?? 'an unknown (headless) session';
  const actor = conflict.session ?? 'an unknown (headless) session';
  process.stderr.write(
    `[gsd-tools] WARNING: milestone lock conflict (#3311): ${holder} holds the milestone claim for phase ` +
      `${conflict.locked_phase}, but ${actor} is running ${action} for phase ${conflict.phase}. ` +
      `STATE.md's ## Current Position is a single slot — concurrent phases overwrite each other's ` +
      `position. Verify Current Position before trusting it.\n`,
  );
}

/**
 * begin-phase entry point: claim `phase` for this session.
 *
 * Returns a conflict descriptor (and leaves the existing claim intact) when a
 * live claim for a DIFFERENT phase is held by a DIFFERENT session; otherwise
 * takes/refreshes the claim and returns null.
 */
export function claimMilestonePhase(cwd: string, phase: string, nowMs?: number): MilestoneConflict | null {
  const now = nowMs ?? realClock.now();
  const session = currentSessionKey();
  const existing = readClaim(cwd);
  if (
    existing !== null &&
    isClaimLive(existing, now) &&
    normalizePhaseToken(existing.phase) !== normalizePhaseToken(phase) &&
    !sameSession(existing.session, session)
  ) {
    return toConflict(existing, phase, session);
  }
  writeClaim(cwd, { phase: String(phase).trim(), session, pid: process.pid, updated_at: now });
  return null;
}

/**
 * advance-plan entry point: `positionPhase` is the phase STATE.md's Current
 * Position currently names.
 *
 * A live claim naming a DIFFERENT phase means the position was moved away from
 * the claimed phase without a matching begin-phase — the #3311 flip — and is
 * returned as a conflict REGARDLESS of session: this session's own legitimate
 * re-targeting goes through begin-phase, which keeps the claim in sync, so a
 * same-session mismatch is exactly as anomalous as a cross-session one. A live
 * claim matching the position phase is heartbeat-refreshed (this session is
 * actively working that phase, so the claim stays live). No claim is ever
 * created here: advance-plan has no phase argument of its own, so it can only
 * corroborate or contradict an existing claim, not originate one.
 */
export function checkMilestonePosition(cwd: string, positionPhase: string, nowMs?: number): MilestoneConflict | null {
  const now = nowMs ?? realClock.now();
  const existing = readClaim(cwd);
  if (existing === null || !isClaimLive(existing, now)) return null;
  const session = currentSessionKey();
  if (normalizePhaseToken(existing.phase) === normalizePhaseToken(positionPhase)) {
    // Heartbeat — keep the claim's liveness anchored to actual activity.
    writeClaim(cwd, { phase: existing.phase, session: existing.session, pid: process.pid, updated_at: now });
    return null;
  }
  return toConflict(existing, positionPhase, session);
}

/**
 * phase.complete entry point (read-only check): a live claim for a DIFFERENT
 * phase held by a DIFFERENT session is a conflict. phase.complete never claims
 * — it ends work on a phase rather than starting it.
 */
export function checkMilestoneConflictForPhase(cwd: string, phase: string, nowMs?: number): MilestoneConflict | null {
  const now = nowMs ?? realClock.now();
  const existing = readClaim(cwd);
  if (existing === null || !isClaimLive(existing, now)) return null;
  if (normalizePhaseToken(existing.phase) === normalizePhaseToken(phase)) return null;
  const session = currentSessionKey();
  if (!sameSession(existing.session, session)) {
    return toConflict(existing, phase, session);
  }
  return null;
}

/**
 * Release the claim when the phase it names completes — regardless of which
 * session completes it (an orchestrator cleaning up after a dead session must
 * not be blocked by the dead session's own claim). Returns whether a matching
 * claim was removed.
 */
export function releaseMilestonePhase(cwd: string, phase: string): boolean {
  const existing = readClaim(cwd);
  if (existing === null) return false;
  if (normalizePhaseToken(existing.phase) !== normalizePhaseToken(phase)) return false;
  try {
    fs.unlinkSync(milestoneLockPath(cwd));
    return true;
  } catch {
    return false; // already gone — same outcome for the caller
  }
}