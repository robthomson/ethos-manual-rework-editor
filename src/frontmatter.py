"""Splits/rejoins the `translated_from: <sha>` YAML frontmatter block
translated pages carry.

Matches ethos-manual-rework's own hooks/i18n_status.py:_read_frontmatter()
parsing exactly (bounded by a leading "---" and the next "\n---") -- same
convention and same "if it doesn't look right, just treat it as absent"
tolerance, not a reimplementation with different edge cases that could
disagree with what that hook decides is stale.

Translators shouldn't have to look at or accidentally mangle this -- it's
bookkeeping for that staleness check, not page content -- so app.py strips
it before displaying a page and needs to re-attach it, bumped to the
current English commit SHA, when the save step (not built yet) writes the
file back.
"""

from __future__ import annotations

import yaml

_MARKER = "---"


def split(text: str) -> tuple[dict, str]:
    """Returns (frontmatter, body). frontmatter is {} if there is none, or
    it's there but doesn't parse as a YAML mapping -- same "just treat it
    as absent" tolerance hooks/i18n_status.py's own parser has, rather than
    this failing to load a page over it."""
    if not text.startswith(_MARKER):
        return {}, text
    end = text.find(f"\n{_MARKER}", len(_MARKER))
    if end == -1:
        return {}, text

    raw = text[len(_MARKER) : end]
    body = text[end + len(f"\n{_MARKER}") :].lstrip("\n")
    try:
        frontmatter = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        return {}, text
    if not isinstance(frontmatter, dict):
        return {}, text
    return frontmatter, body


def join(frontmatter: dict, body: str) -> str:
    """Inverse of split() -- only emits a frontmatter block at all if
    `frontmatter` is non-empty (a brand-new translation has none yet)."""
    if not frontmatter:
        return body
    raw = yaml.safe_dump(frontmatter, default_flow_style=False, sort_keys=False).strip()
    return f"{_MARKER}\n{raw}\n{_MARKER}\n\n{body}"
