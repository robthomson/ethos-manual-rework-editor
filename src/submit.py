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
from github.GithubException import UnknownObjectException

import frontmatter
from github_repo import REPO_SLUG, _repo, _wrap_errors

_OWNER = REPO_SLUG.split("/")[0]


@dataclass
class PullRequestInfo:
    number: int
    url: str
    branch: str


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
            return PullRequestInfo(number=pr.number, url=pr.html_url, branch=branch)
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

        base_ref = repo.get_git_ref(f"heads/{base_branch}")
        base_commit = repo.get_git_commit(base_ref.object.sha)

        blob = repo.create_git_blob(content, "utf-8")
        tree = repo.create_git_tree(
            [InputGitTreeElement(path=docs_path, mode="100644", type="blob", sha=blob.sha)],
            base_tree=base_commit.tree,
        )
        commit = repo.create_git_commit(pr_title, tree, [base_commit])

        try:
            ref = repo.get_git_ref(f"heads/{target_branch}")
            ref.edit(commit.sha, force=True)
        except UnknownObjectException:
            repo.create_git_ref(f"refs/heads/{target_branch}", commit.sha)

        existing = find_open_pr(base_branch, locale, md_path)
        if existing:
            return existing

        pr = repo.create_pull(title=pr_title, body=pr_body, head=target_branch, base=base_branch)
        return PullRequestInfo(number=pr.number, url=pr.html_url, branch=target_branch)

    return _wrap_errors("submitting the translation", work)
