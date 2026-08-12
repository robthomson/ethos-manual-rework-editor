"""GitHub sign-in: a pasted-in fine-grained PAT, validated against the
target repo and stored in the OS credential store.

No OAuth app to register, no server to hold a client secret -- see this
project's README / conversation history for why a plain PAT fits a small
group of trusted, named translators better than building an OAuth flow.
The token needs, at minimum, Contents (read/write) and Pull requests
(write) permissions scoped to REPO_SLUG; that's on the translator to set up
when they create it (a fine-grained PAT scoped to just this one repo), not
something this app can enforce beyond checking the calls it needs actually
succeed.
"""

from __future__ import annotations

from dataclasses import dataclass

import keyring
from github import Auth, Github
from github.GithubException import BadCredentialsException, GithubException

REPO_SLUG = "robthomson/ethos-manual-rework"

_KEYRING_SERVICE = "ethos-manual-translator"
_KEYRING_USERNAME = "github-pat"


class AuthError(Exception):
    """Raised for any sign-in failure, with a message safe to show as-is.

    invalid_credential distinguishes "this token is actually bad" (GitHub
    rejected it outright -- safe, correct to forget it and stop trying)
    from every other failure (rate-limited, network blip, GitHub having a
    moment -- the token itself might be perfectly fine, so callers doing an
    unattended auto-sign-in shouldn't clear a stored token over one of
    these). Defaults to False so a caller that doesn't check it fails safe
    (keeps the token) rather than unsafe (discards a possibly-good one).
    """

    def __init__(self, message: str, *, invalid_credential: bool = False):
        super().__init__(message)
        self.invalid_credential = invalid_credential


@dataclass
class SignedInUser:
    login: str
    name: str | None
    token: str


def validate_token(token: str) -> SignedInUser:
    """Checks the token is valid *and* can actually reach REPO_SLUG.

    Raises AuthError with a translator-facing message on any failure.
    Doesn't check specific permissions (Contents/PRs write) beyond repo
    visibility -- there's no cheap way to probe those without attempting
    the real write, so a bad scope will surface later, at save time,
    instead of here.
    """
    token = token.strip()
    if not token:
        raise AuthError("Enter a GitHub personal access token.")

    # retry=None: see github_repo.py's identical comment -- PyGithub's
    # default retry waits out a rate-limit window (minutes) before raising
    # anything, which for a GUI means silently hanging on "Signing in..."
    # for however long that takes.
    gh = Github(auth=Auth.Token(token), retry=None)
    try:
        user = gh.get_user()
        login = user.login  # forces the API call; PyGithub is lazy
        name = user.name
    except BadCredentialsException as e:
        raise AuthError(
            "That token isn't valid (GitHub rejected it).", invalid_credential=True
        ) from e
    except GithubException as e:
        raise AuthError(f"GitHub error while checking the token: {e.data}") from e
    except Exception as e:  # network errors, etc.
        raise AuthError(f"Couldn't reach GitHub: {e}") from e

    try:
        gh.get_repo(REPO_SLUG)
    except BadCredentialsException as e:
        raise AuthError(
            "That token isn't valid (GitHub rejected it).", invalid_credential=True
        ) from e
    except GithubException as e:
        if e.status in (404, 403):
            raise AuthError(
                f"Signed in as {login}, but this token can't see {REPO_SLUG}. "
                "Check it's a fine-grained PAT scoped to that repo, with "
                "Contents and Pull requests permissions.",
                invalid_credential=True,
            ) from e
        raise AuthError(f"GitHub error while checking repo access: {e.data}") from e

    return SignedInUser(login=login, name=name, token=token)


def save_token(token: str) -> None:
    keyring.set_password(_KEYRING_SERVICE, _KEYRING_USERNAME, token)


def load_token() -> str | None:
    return keyring.get_password(_KEYRING_SERVICE, _KEYRING_USERNAME)


def clear_token() -> None:
    try:
        keyring.delete_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
    except keyring.errors.PasswordDeleteError:
        pass  # nothing stored -- fine
