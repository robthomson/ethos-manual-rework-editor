"""Renders a page's markdown to HTML for the "Preview" button, using the
same markdown_extensions ethos-manual-rework's own mkdocs.yml lists (fed in
from github_repo.fetch_mkdocs_config(), not hardcoded here, so this stays
correct if that list ever changes) -- not a generic JS-equivalent renderer
guessing at pymdownx's specific admonition/tabbed syntax.

Doesn't attempt to match mkdocs-material's actual visual theme -- the goal
is correct extension *behavior* (admonitions, tabs, code fences render as
the real site would structure them), not a pixel-identical preview. A
minimal embedded stylesheet just keeps it legible.

Image handling: pages reference screenshots by path relative to the page
itself (e.g. `../assets/foo.png`), which resolve to nothing without a local
checkout. Rewritten to raw.githubusercontent.com URLs for the branch/locale
being previewed, via urljoin against the page's own raw-content URL -- same
resolution logic a browser applies, so it handles `./`, `../`, and
bare-relative forms uniformly. General inter-page links (`[...](../foo.md)`)
are deliberately NOT rewritten to the live site's pretty-URL scheme -- known
limitation, out of scope for a first pass (the ask was specifically about
images, not full link fidelity).
"""

from __future__ import annotations

import os
import re
import tempfile
import webbrowser
from urllib.parse import urljoin

import markdown

from github_repo import REPO_SLUG

PREVIEW_FILENAME = "ethos-manual-translator-preview.html"

_STYLE = """
body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
       max-width: 860px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.6; color: #1a1a1a; }
img { max-width: 100%; }
code, pre { font-family: "SF Mono", Consolas, monospace; }
pre { background: #f4f4f4; padding: 0.75rem 1rem; border-radius: 4px; overflow-x: auto; }
code { background: #f4f4f4; padding: 0.15rem 0.35rem; border-radius: 3px; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ddd; padding: 0.4rem 0.75rem; }
.admonition { border-left: 4px solid #448aff; background: #f4f8ff; padding: 0.75rem 1rem; margin: 1rem 0; border-radius: 2px; }
.admonition-title { font-weight: 700; margin: 0 0 0.35rem 0; }
.admonition.warning, .admonition.caution { border-left-color: #ff9100; background: #fff8f0; }
.admonition.danger { border-left-color: #ff5252; background: #fff2f2; }
/* pymdownx.tabbed (alternate_style): all tabs shown stacked with a visible
   label, rather than replicating the real site's click-to-switch CSS --
   simpler, and shows every tab's content at once, which is arguably more
   useful for a translator checking all of them for missed strings. */
.tabbed-set { border: 1px solid #ddd; border-radius: 4px; margin: 1rem 0; }
.tabbed-labels { display: flex; background: #f4f4f4; margin: 0; padding: 0; list-style: none; }
.tabbed-labels label { padding: 0.5rem 1rem; font-weight: 600; font-size: 0.9rem; }
.tabbed-block { padding: 0.75rem 1rem; border-top: 1px solid #ddd; }
"""

_HTML_TEMPLATE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Preview: {title}</title>
<style>{style}</style>
</head>
<body>
<p style="color:#888;font-size:0.85rem;">
  Preview of <strong>{locale}</strong> &middot; {branch}/{docs_path}<br>
  Rendered locally -- may not exactly match the live site's theme.
</p>
<hr>
{body}
</body>
</html>
"""

_SRC_ATTR_RE = re.compile(r'(<img\b[^>]*\bsrc=")([^"]+)(")')


def split_extensions(raw: list) -> tuple[list[str], dict]:
    """mkdocs.yml's markdown_extensions: list mixes bare names ("admonition")
    and single-key dicts with options ({"toc": {"permalink": True}}) --
    python-markdown's API wants those as two separate arguments."""
    names = []
    configs = {}
    for entry in raw:
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict):
            for name, options in entry.items():
                names.append(name)
                configs[name] = options or {}
    return names, configs


def render_html(
    markdown_text: str,
    extensions: list,
    branch: str,
    locale: str,
    md_path: str,
    title: str,
) -> str:
    names, configs = split_extensions(extensions)
    body = markdown.markdown(markdown_text, extensions=names, extension_configs=configs)

    docs_path = f"docs/{locale}/{md_path}"
    page_raw_url = f"https://raw.githubusercontent.com/{REPO_SLUG}/{branch}/{docs_path}"

    def rewrite_src(match: re.Match) -> str:
        prefix, src, suffix = match.groups()
        if src.startswith(("http://", "https://", "data:")):
            return match.group(0)
        return prefix + urljoin(page_raw_url, src) + suffix

    body = _SRC_ATTR_RE.sub(rewrite_src, body)

    return _HTML_TEMPLATE.format(
        title=title,
        style=_STYLE,
        locale=locale,
        branch=branch,
        docs_path=docs_path,
        body=body,
    )


def open_preview(html: str) -> None:
    path = os.path.join(tempfile.gettempdir(), PREVIEW_FILENAME)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    webbrowser.open(f"file://{path}")
