// Parses the [POINT:x,y:label] tag Claude appends to every reply.
// Same grammar as the macOS app (CompanionManager.swift), minus the
// multi-monitor :screenN suffix, which is accepted but ignored.
const POINT_TAG_PATTERN = /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:]+?))?(?::screen\d+)?)\]\s*$/;

/**
 * @returns {{ spokenText: string, point: { x: number, y: number, label: string | null } | null }}
 */
export function parsePointTag(fullReplyText) {
  const match = fullReplyText.match(POINT_TAG_PATTERN);
  const spokenText = fullReplyText.replace(POINT_TAG_PATTERN, "").trim();
  if (!match || match[1] === undefined) {
    return { spokenText, point: null };
  }
  return {
    spokenText,
    point: { x: Number(match[1]), y: Number(match[2]), label: match[3]?.trim() || null },
  };
}

/**
 * While the reply is still streaming, hide a partially written tag so the
 * text bubble never flashes "[POINT:12".
 */
export function hidePartialPointTag(partialReplyText) {
  const tagStartIndex = partialReplyText.lastIndexOf("[");
  if (tagStartIndex === -1) {
    return partialReplyText;
  }
  const possibleTagStart = partialReplyText.slice(tagStartIndex);
  const couldBePointTag = "[POINT:".startsWith(possibleTagStart) || possibleTagStart.startsWith("[POINT:");
  return couldBePointTag ? partialReplyText.slice(0, tagStartIndex).trimEnd() : partialReplyText;
}
