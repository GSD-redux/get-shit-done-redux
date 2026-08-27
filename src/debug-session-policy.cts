/**
 * Pure parser for the optional Runtime Evidence policy in a debug session.
 * The caller owns path confinement, bounded I/O, identity checks, and UTF-8
 * decoding; this module owns only fail-closed Markdown interpretation.
 */

import { collectSection, stripFencedCode, tokenizeHeadings } from './markdown-sectionizer.cjs';

type RuntimeEvidencePolicy = 'adaptive' | 'off';

/**
 * Mask HTML comments without changing line boundaries. A stray closing token
 * outside a comment is ordinary user data; nested or unclosed comments are
 * ambiguous and fail safe.
 */
function maskDebugSessionComments(content: string): string | null {
  let masked = '';
  let cursor = 0;

  while (cursor < content.length) {
    const opening = content.indexOf('<!--', cursor);
    if (opening === -1) {
      masked += content.slice(cursor);
      break;
    }

    masked += content.slice(cursor, opening);
    const closing = content.indexOf('-->', opening + 4);
    if (closing === -1) return null;
    const nested = content.indexOf('<!--', opening + 4);
    if (nested !== -1 && nested < closing) return null;

    const comment = content.slice(opening, closing + 3);
    masked += comment.replace(/[^\r\n]/g, ' ');
    cursor = closing + 3;
  }

  return masked;
}

/**
 * Read one valid schema-v1 policy from the exact `## Runtime Evidence`
 * section. Duplicate sections, duplicate keys, malformed records, fenced
 * examples, NUL bytes, and unsupported values are ambiguous and resolve to
 * null. Invalid input is never rewritten or repaired here.
 */
function parseSavedRuntimeEvidencePolicy(content: string): RuntimeEvidencePolicy | null {
  if (content.includes('\0')) return null;
  const commentMasked = maskDebugSessionComments(content);
  if (commentMasked === null) return null;

  const isRuntimeEvidenceHeading = (heading: { level: number; text: string }): boolean =>
    heading.level === 2 && heading.text === 'Runtime Evidence';
  const matchingHeadings = tokenizeHeadings(commentMasked).filter(isRuntimeEvidenceHeading);
  if (matchingHeadings.length !== 1) return null;

  const section = collectSection(commentMasked, isRuntimeEvidenceHeading, { levelBounded: true });
  if (!section) return null;
  const unfenced = stripFencedCode(section.body);
  if (unfenced.unterminatedFence) return null;

  const lines = unfenced.text.split(/\r?\n/);
  const schemaRecords = lines.filter((line) => /^schema_version[ \t]*:/.test(line));
  const policyRecords = lines.filter((line) => /^policy[ \t]*:/.test(line));
  if (schemaRecords.length !== 1 || policyRecords.length !== 1) return null;
  if (!/^schema_version:[ \t]*1[ \t]*$/.test(schemaRecords[0])) return null;

  const policyMatch = /^policy:[ \t]*(adaptive|off)[ \t]*$/.exec(policyRecords[0]);
  return policyMatch ? policyMatch[1] as RuntimeEvidencePolicy : null;
}

export = {
  maskDebugSessionComments,
  parseSavedRuntimeEvidencePolicy,
};
