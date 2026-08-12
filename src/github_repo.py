"""Read-only access to ethos-manual-rework's structure: branches, locales,
and the docs nav (the page picker's table of contents).

Unauthenticated by default -- see auth.py's docstring and app.py's plan for
why browsing doesn't require signing in, this repo is public. But once a
token *does* exist (the user signed in, for this session or a past one --
see set_token(), called from app.py on sign-in/out), there's no reason not
to use it for browsing too: it costs nothing (same token they'd need for
the save step anyway) and raises the rate limit from 60/hour to 5000/hour,
which matters in practice -- anonymous is easy to exhaust just from normal
use, let alone testing (hit this for real, see _wrap_errors).

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
from github import Auth, Github
from github.GithubException import (
    GithubException,
    RateLimitExceededException,
    UnknownObjectException,
)

REPO_SLUG = "robthomson/ethos-manual-rework"


# retry=None: PyGithub's default retries a rate-limited request by *waiting
# out* the rate-limit window (which can be several minutes) before raising
# anything -- great for a script, bad for a GUI that would otherwise just
# sit on "Loading..." with no feedback for that whole time. Disabling
# retries makes a 403 surface immediately as RateLimitExceededException,
# which _wrap_errors turns into a message actually explaining what
# happened.
def _client(token: str | None) -> Github:
    return Github(auth=Auth.Token(token), retry=None) if token else Github(retry=None)


_gh = _client(None)  # anonymous until set_token() says otherwise
_authenticated = False


def set_token(token: str | None) -> None:
    """Switches the client used for all reads. Call with a token on sign-in
    (including the silent auto-sign-in from a stored one), with None on
    sign-out."""
    global _gh, _authenticated
    _gh = _client(token)
    _authenticated = token is not None


class RepoError(Exception):
    """Any failure reading repo structure, with a message safe to show as-is."""


@dataclass
class TocPage:
    title: str
    md_path: str | None  # None for a pure section header with no page of its own
    children: list["TocPage"] = field(default_factory=list)


def _wrap_errors(action: str, fn):
    try:
        return fn()
    except RepoError:
        raise  # already has a clean, specific message -- don't rewrap it
    except RateLimitExceededException as e:
        if _authenticated:
            hint = "Even signed in, that's a lot of requests -- wait a few minutes and try again."
        else:
            hint = "Wait a few minutes and try again, or sign in (raises the limit from 60 to 5000/hour)."
        raise RepoError(f"GitHub's rate limit was hit while {action}. {hint}") from e
    except GithubException as e:
        raise RepoError(f"GitHub error while {action}: {e.data}") from e
    except Exception as e:
        raise RepoError(f"Couldn't reach GitHub while {action}: {e}") from e


def _repo():
    return _wrap_errors("looking up the repo", lambda: _gh.get_repo(REPO_SLUG))


# mike's build output branch (see ethos-manual-rework's deploy.yml) -- a
# real branch, but not a content/version branch anyone should pick to edit.
_NON_CONTENT_BRANCHES = {"gh-pages"}


def list_branches() -> list[str]:
    """main first (if present), then the rest alphabetically -- matches how
    ethos-manual-rework's own versioning convention treats main as the
    active branch and everything else as a frozen prior version."""
    names = _wrap_errors(
        "listing branches",
        lambda: [
            b.name for b in _repo().get_branches() if b.name not in _NON_CONTENT_BRANCHES
        ],
    )
    names.sort(key=lambda n: (n != "main", n))
    return names


def _fetch_text_file(branch: str, path: str, missing_ok: bool = False) -> str | None:
    def fetch():
        try:
            return _repo().get_contents(path, ref=branch)
        except UnknownObjectException:
            if missing_ok:
                return None
            raise RepoError(f"{path} not found on branch {branch}.") from None

    content_file = _wrap_errors(f"fetching {path}@{branch}", fetch)
    if content_file is None:
        return None
    return base64.b64decode(content_file.content).decode("utf-8")


def docs_path(locale: str, md_path: str) -> str:
    return f"docs/{locale}/{md_path}"


def fetch_page_source(branch: str, locale: str, md_path: str) -> str:
    """English (or any locale expected to exist) -- a 404 here is a real
    error, not a "not translated yet" case."""
    return _fetch_text_file(branch, docs_path(locale, md_path))


def try_fetch_page_source(branch: str, locale: str, md_path: str) -> str | None:
    """A non-English locale's page -- None means "not translated yet",
    which is an expected, common, non-error outcome here."""
    return _fetch_text_file(branch, docs_path(locale, md_path), missing_ok=True)


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
