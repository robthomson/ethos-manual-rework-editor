/* backend/frontmatter.ts
 *
 * Description of responsibility:
 *   Splits/rejoins the `translated_from: <sha>` YAML frontmatter block
 *   translated pages carry.
 *
 * Info:
 *   Ported from ethos-manual-rework-editor's own src/frontmatter.py (the
 *   Python app this project is replacing) — matches
 *   ethos-manual-rework's own hooks/i18n_status.py:_read_frontmatter()
 *   parsing exactly (bounded by a leading "---" and the next "\n---"),
 *   same convention and same "if it doesn't look right, just treat it as
 *   absent" tolerance, not a reimplementation with different edge cases
 *   that could disagree with what that hook decides is stale.
 *
 *   Translators shouldn't have to look at or accidentally mangle this —
 *   it's bookkeeping for that staleness check, not page content — so the
 *   editor strips it before displaying a page and re-attaches it, bumped
 *   to the current English commit SHA, when the save/submit step writes
 *   the file back (see gitRoutes.ts's submit flow, once ported).
 */
import yaml from "js-yaml";

const MARKER = "---";

export interface SplitResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

// Returns {} for frontmatter if there is none, or it's there but doesn't
// parse as a YAML mapping — same "just treat it as absent" tolerance
// hooks/i18n_status.py's own parser has, rather than this failing to
// load a page over it.
export function splitFrontmatter(text: string): SplitResult {
  if (!text.startsWith(MARKER)) {
    return { frontmatter: {}, body: text };
  }

  const end = text.indexOf(`\n${MARKER}`, MARKER.length);
  if (end === -1) {
    return { frontmatter: {}, body: text };
  }

  const raw = text.slice(MARKER.length, end);
  const body = text.slice(end + `\n${MARKER}`.length).replace(/^\n+/, "");

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return { frontmatter: {}, body: text };
  }

  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body: text };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatter: {}, body: text };
  }

  return { frontmatter: parsed as Record<string, unknown>, body };
}

// Inverse of splitFrontmatter() — only emits a frontmatter block at all
// if `frontmatter` is non-empty (a brand-new translation has none yet).
export function joinFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return body;
  }

  const raw = yaml
    .dump(frontmatter, { flowLevel: -1, sortKeys: false })
    .trimEnd();

  return `${MARKER}\n${raw}\n${MARKER}\n\n${body}`;
}
