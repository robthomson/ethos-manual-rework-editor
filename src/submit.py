"""Submits a translator's edited page as a pull request.

One atomic commit via GitHub's Git Data API (blob -> tree -> commit ->
branch ref -> PR), not a local git clone -- this app was built specifically
to avoid needing git installed or a local checkout, and a full clone would
also drag down every locale's screenshot set just to edit one markdown
file (see this project's own history for the fuller reasoning). Every
write here needs an authenticated client (github_repo.set_token() must
have been called with a real token) -- unlike the rest of github_repo.py,
which is deliberately anonymous-by-default.

The branch name is fully deterministic (branch_name() -- derived from
locale + page path, nothing else), so "is there already work in flight for
this page" is answered by asking GitHub live (find_open_pr()) rather than
tracking anything locally. That's what lets this resume correctly across
app restarts, different machines, reinstalls, with zero local state:
GitHub's branches/PRs already *are* the source of truth. app.py's load
path calls find_open_pr() before fetching from the base branch, so
reopening an in-progress translation continues from the PR's branch
instead of quietly reloading it from base and risking overwriting it.
"""

from __future__ import annotations

from dataclasses import dataclass

from github import InputGitTreeElement
from github.GithubException import GithubException, UnknownObjectException

import frontmatter
from github_repo import REPO_SLUG, RepoError, _repo, _wrap_errors

_OWNER = REPO_SLUG.split("/")[0]


def _wrap_permission_error(action: str, needed: str, fn):
    """Like _wrap_errors, but recognizes the specific 403 "Resource not
    accessible by personal access token" GitHub returns when a
    fine-grained PAT is missing one particular permission, and says which
    one -- rather than the raw API response this project's own live
    testing hit, twice, for two genuinely different permissions gating two
    different steps of one submit (Contents for the commit, separately
    Pull requests for opening the PR -- Contents: write alone isn't
    enough). Anything else propagates for _wrap_errors, wrapping this
    call, to handle with its own generic messages."""
    try:
        return fn()
    except GithubException as e:
        message = str(e.data.get("message", "")) if isinstance(e.data, dict) else ""
        if e.status == 403 and "not accessible" in message.lower():
            raise RepoError(
                f"GitHub rejected {action}: this token doesn't have '{needed}' "
                f"permission on {REPO_SLUG}. Check the fine-grained PAT's permissions "
                f"include '{needed}: Read and write' for this repo, then try again."
            ) from e
        raise


@dataclass
class PullRequestInfo:
    number: int
    url: str
    branch: str
    draft: bool


def branch_name(locale: str, md_path: str) -> str:
    slug = md_path[: -len(".md")] if md_path.endswith(".md") else md_path
    return f"translate/{locale}/{slug.replace('/', '-')}"


def find_open_pr(base_branch: str, locale: str, md_path: str) -> PullRequestInfo | None:
    """Read-only -- safe to call on every page load, not just at submit
    time. See module docstring for why this replaces needing local state."""
    branch = branch_name(locale, md_path)

    def fetch():
        prs = _repo().get_pulls(state="open", head=f"{_OWNER}:{branch}", base=base_branch)
        for pr in prs:
            return PullRequestInfo(number=pr.number, url=pr.html_url, branch=branch, draft=pr.draft)
        return None

    return _wrap_errors(f"checking for an existing PR for {branch}", fetch)


def latest_commit_sha(branch: str, path: str) -> str:
    """Mirrors ethos-manual-rework's own hooks/i18n_status.py: `git log -1
    -- <path>` -- the most recent commit that touched this exact file on
    this branch."""

    def fetch():
        commits = _repo().get_commits(sha=branch, path=path)
        return commits[0].sha

    return _wrap_errors(f"looking up the last commit for {path}@{branch}", fetch)


def submit_translation(
    *,
    base_branch: str,
    locale: str,
    md_path: str,
    body_text: str,
    existing_frontmatter: dict,
    pr_title: str,
    pr_body: str,
) -> PullRequestInfo:
    """Creates or updates the translate/<locale>/<slug> branch with one new
    commit (the edited page, translated_from: bumped to the English page's
    current commit) and opens a PR for it -- or, if one's already open for
    this exact branch, just points the branch at the new commit. GitHub
    updates the existing PR automatically; this never creates a duplicate.
    """
    target_branch = branch_name(locale, md_path)
    docs_path = f"docs/{locale}/{md_path}"
    en_path = f"docs/en/{md_path}"

    def work():
        repo = _repo()

        english_sha = latest_commit_sha(base_branch, en_path)
        new_frontmatter = {**existing_frontmatter, "translated_from": english_sha}
        content = frontmatter.join(new_frontmatter, body_text)

        # Two distinct fine-grained PAT permissions gate two distinct steps
        # here -- Contents for the commit itself, separately Pull requests
        # for opening the PR. Wrapped individually (not just the one outer
        # _wrap_errors below) so a 403 says which one is missing instead of
        # both surfacing as the same generic error -- this project's own
        # live testing hit both, one after the other, confirming they
        # really are independent gates and not the same underlying cause.
        def create_commit():
            base_ref = repo.get_git_ref(f"heads/{base_branch}")
            base_commit = repo.get_git_commit(base_ref.object.sha)

            blob = repo.create_git_blob(content, "utf-8")
            tree = repo.create_git_tree(
                [InputGitTreeElement(path=docs_path, mode="100644", type="blob", sha=blob.sha)],
                base_tree=base_commit.tree,
            )
            new_commit = repo.create_git_commit(pr_title, tree, [base_commit])

            try:
                ref = repo.get_git_ref(f"heads/{target_branch}")
                ref.edit(new_commit.sha, force=True)
            except UnknownObjectException:
                repo.create_git_ref(f"refs/heads/{target_branch}", new_commit.sha)

        _wrap_permission_error("committing the translation", "Contents", create_commit)

        existing = find_open_pr(base_branch, locale, md_path)
        if existing:
            return existing

        def open_pr():
            # Draft: a translator can submit repeatedly while still
            # editing (that's the whole point of resuming from an open
            # PR's branch -- see module docstring), so a plain PR would
            # leave reviewers with no way to tell "still being worked on"
            # from "actually done" other than asking. Only true at
            # *creation* -- updating an existing PR's branch (the
            # `if existing: return existing` above) never touches its
            # draft state either way, so a translator's own explicit
            # mark_ready_for_review() sticks across further edits instead
            # of silently reverting.
            pr = repo.create_pull(
                title=pr_title, body=pr_body, head=target_branch, base=base_branch, draft=True
            )
            return PullRequestInfo(number=pr.number, url=pr.html_url, branch=target_branch, draft=True)

        return _wrap_permission_error("opening the pull request", "Pull requests", open_pr)

    return _wrap_errors("submitting the translation", work)


def mark_ready_for_review(pr_number: int) -> PullRequestInfo:
    """The translator's explicit "I'm done editing" signal -- see
    submit_translation()'s docstring for why PRs start as drafts. GitHub's
    REST API has no field for this (draft -> ready is one-way and
    deliberately not just PATCHable); PyGithub's mark_ready_for_review()
    goes through the GraphQL mutation that's the only way to do it."""

    def work():
        pr = _repo().get_pull(pr_number)
        pr.mark_ready_for_review()
        return PullRequestInfo(number=pr.number, url=pr.html_url, branch=pr.head.ref, draft=pr.draft)

    return _wrap_permission_error("marking the pull request ready for review", "Pull requests", work)


def discard_pr(pr_number: int, branch: str) -> None:
    """Abandons an in-progress translation: closes the PR (without
    merging) and deletes its branch. Deliberately not just "stop editing"
    -- the branch is what find_open_pr() keys off of, so leaving it around
    would mean the next page load either keeps resuming this same
    abandoned attempt (branch open, no PR) or, worse, a *closed* PR here
    would need its own special-casing in find_open_pr() (which only looks
    at state="open") to avoid being resumed from either. Deleting it
    outright keeps "does this page have a resumable PR" answerable by that
    one already-existing check, no extra state to track anywhere."""

    def work():
        repo = _repo()
        pr = repo.get_pull(pr_number)
        if pr.state == "open":
            pr.edit(state="closed")
        try:
            repo.get_git_ref(f"heads/{branch}").delete()
        except UnknownObjectException:
            pass  # already gone -- fine

    _wrap_permission_error("discarding the pull request", "Pull requests", work)
