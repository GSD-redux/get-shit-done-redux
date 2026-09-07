/**
 * Phase-ID display adapters (#3638 / ADR-612 PR-5).
 *
 * STATE.md and milestone metadata still expose the legacy `vN.0` marker on
 * this stacked base. Display surfaces need to translate that metadata into a
 * bracket identity without growing another renderer. These pure adapters do
 * only the boundary normalization, then delegate identity parsing/rendering to
 * phase-id.cts's canonical pair.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseId = require('./phase-id.cjs');
const { parsePhaseId, renderMilestoneId, renderPhaseId } = phaseId;

function canonicalNumeric(value: string): string {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === '0') offset++;
  const stripped = value.slice(offset);
  return stripped.length < 2 ? stripped.padStart(2, '0') : stripped;
}

function isDigits(value: string): boolean {
  return value.length > 0
    && [...value].every(char => char >= '0' && char <= '9');
}

function milestoneToken(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).replace(/^v/i, '');
  const parts = raw.split('.');
  if (parts.length > 2 || parts.some(part => !isDigits(part))) return null;
  return canonicalNumeric(parts[0]);
}

function phaseToken(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  const parts = raw.split('.');
  if (parts.length > 2 || parts.some(part => !isDigits(part))) return null;
  return parts.map(canonicalNumeric).join('.');
}

/**
 * Render a bracket phase display from legacy milestone metadata.
 * Returns null for incomplete or invalid metadata so cosmetic callers can
 * degrade without breaking a command/statusline render.
 */
function renderBracketPhaseDisplay(
  milestone: unknown,
  phase: unknown,
  projectCode: unknown,
): string | null {
  const project = typeof projectCode === 'string' ? projectCode : '';
  const mm = milestoneToken(milestone);
  const pp = phaseToken(phase);
  if (!project || mm === null || pp === null) return null;

  try {
    return renderPhaseId(parsePhaseId(`${project}.${mm}-${pp}`));
  } catch {
    return null;
  }
}

/** Render only the bracket milestone label, still through canonical parsing. */
function renderBracketMilestoneDisplay(
  milestone: unknown,
  projectCode: unknown,
): string | null {
  const project = typeof projectCode === 'string' ? projectCode : '';
  const mm = milestoneToken(milestone);
  if (!project || mm === null) return null;

  try {
    // The sentinel phase is a validation vehicle, not a rendering artifact.
    return renderMilestoneId(parsePhaseId(`${project}.${mm}-00`));
  } catch {
    return null;
  }
}

export = {
  renderBracketPhaseDisplay,
  renderBracketMilestoneDisplay,
};
