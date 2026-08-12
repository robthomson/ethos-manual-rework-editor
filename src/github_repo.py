"""Anonymous, read-only access to ethos-manual-rework's structure: branches,
locales, and the docs nav (the page picker's table of contents).

Deliberately unauthenticated -- see auth.py's docstring and app.py's plan
for why. This is all public-repo reads, so there's nothing to sign in for;
using an authenticated client here would just spend the user's own PAT's
rate limit for no reason before they've even decided what to edit.

build_toc() walks mkdocs.yml's `nav:` the same way ethos-manual-rework's
own scripts/build_pdfs.py:nav_pages() does, fed a copy of mkdocs.yml
fetched over the API instead of read from a local checkout -- but keeps
the tree shape (that script flattens to a list since it only needs render
order for the PDF; a picker needs the section/child structure back).
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field

import yaml
from github import Github
from github.GithubException import GithubException, UnknownObjectException

REPO_SLUG = "robthomson/ethos-manual-rework"

_gh = Github()  # anonymous: no token, ~60 requests/hour


class RepoError(Exception):
    """Any failure reading repo structure, with a message safe to show as-is."""


@dataclass
class TocPage:
    title: str
    md_path: str | None  # None for a pure section header with no page of its own
    children: list["TocPage"] = field(default_factory=list)


def _repo():
    try:
        return _gh.get_repo(REPO_SLUG)
    except GithubException as e:
        raise RepoError(f"Couldn't reach {REPO_SLUG}: {e.data}") from e
    except Exception as e:
        raise RepoError(f"Couldn't reach GitHub: {e}") from e


# mike's build output branch (see ethos-manual-rework's deploy.yml) -- a
# real branch, but not a content/version branch anyone should pick to edit.
_NON_CONTENT_BRANCHES = {"gh-pages"}


def list_branches() -> list[str]:
    """main first (if present), then the rest alphabetically -- matches how
    ethos-manual-rework's own versioning convention treats main as the
    active branch and everything else as a frozen prior version."""
    try:
        names = [
            b.name for b in _repo().get_branches() if b.name not in _NON_CONTENT_BRANCHES
        ]
    except GithubException as e:
        raise RepoError(f"Couldn't list branches: {e.data}") from e
    names.sort(key=lambda n: (n != "main", n))
    return names


def _fetch_text_file(branch: str, path: str) -> str:
    try:
        content_file = _repo().get_contents(path, ref=branch)
    except UnknownObjectException as e:
        raise RepoError(f"{path} not found on branch {branch}.") from e
    except GithubException as e:
        raise RepoError(f"Couldn't fetch {path}@{branch}: {e.data}") from e
    return base64.b64decode(content_file.content).decode("utf-8")


def fetch_mkdocs_config(branch: str) -> dict:
    text = _fetch_text_file(branch, "mkdocs.yml")
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise RepoError(f"mkdocs.yml on {branch} isn't valid YAML: {e}") from e


def locale_names(config: dict) -> dict[str, str]:
    """locale -> display name (e.g. "fr" -> "Français"). "en" isn't listed
    under plugins.i18n.languages in mkdocs.yml (it's the implicit default),
    so it's added here to match -- same as
    ethos-manual-rework/scripts/build_pdfs.py:locale_names()."""
    names = {"en": "English"}
    for plugin in config.get("plugins", []):
        if isinstance(plugin, dict) and "i18n" in plugin:
            for language in plugin["i18n"].get("languages", []):
                names[language["locale"]] = language["name"]
    return names


def build_toc(config: dict) -> list[TocPage]:
    """Walks nav:. A section (dict value is a list) whose first child is a
    bare, unlabeled string is treated as that section's own landing page --
    matches both mkdocs' own interpretation (clicking a nav tab opens it)
    and how every section in this repo's nav is actually written."""

    def walk(entries: list) -> list[TocPage]:
        pages = []
        for entry in entries:
            if isinstance(entry, str):
                pages.append(TocPage(title=entry, md_path=entry))
            elif isinstance(entry, dict):
                for label, value in entry.items():
                    if isinstance(value, str):
                        pages.append(TocPage(title=label, md_path=value))
                    else:
                        section_path = None
                        rest = value
                        if rest and isinstance(rest[0], str):
                            section_path, rest = rest[0], rest[1:]
                        pages.append(
                            TocPage(
                                title=label,
                                md_path=section_path,
                                children=walk(rest),
                            )
                        )
        return pages

    return walk(config.get("nav", []))
