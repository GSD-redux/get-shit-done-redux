/**
 * Canonical bracket convention card (#3638 / ADR-612 PR-5).
 *
 * This module is the sole editable source of the compact grammar diagram.
 * Render sites import phaseIdCard(); generated documentation is held to the
 * same bytes by tests/phase-id-card.test.cjs. PR-6 can therefore inject the
 * card broadly without inventing another copy.
 */

const PHASE_ID_CARD = [
  '[GSD.02] 05.03-01',
  ' │   │   │  │   │',
  ' │   │   │  │   └── plan        01',
  ' │   │   │  └────── subphase    03',
  ' │   │   └───────── phase       05',
  ' │   └───────────── milestone   02',
  ' └───────────────── project     GSD',
].join('\n');

const PHASE_ID_LEGEND =
  "milestone = bracket integer; dots = phase-levels; one hyphen = plan; "
  + "no 'Phase' word, no vX.Y";

function phaseIdCard(options: { title?: string } = {}): string {
  const parts: string[] = [];
  if (options.title) parts.push(options.title, '');
  parts.push(PHASE_ID_CARD, '', PHASE_ID_LEGEND);
  return parts.join('\n');
}

export = {
  phaseIdCard,
  PHASE_ID_CARD,
  PHASE_ID_LEGEND,
};
