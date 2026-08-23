/* backend/routes/gitRoutes.ts
 *
 * Description of responsibility:
 *   Turns a workspace's local file changes into a real commit on the
 *   user's fork, and opens or updates the pull request from that fork
 *   branch back to upstream — the one thing this app couldn't do until
 *   now (everything else is local-disk-only, see workspaceStore.ts's
 *   own header comment).
 *
 * Info:
 *   Adapted from rotorflight-docEditor's own backend/routes/gitRoutes.ts
 *   (commitChanges/submitPullRequest/syncBranchWithUpstream/ensureBranch —
 *   the fork-branch-commit-PR mechanics carry over unchanged in shape, per
 *   the original plan for this rewrite) — real differences from that
 *   project accounted for here:
 *     - One combined POST /submit (fork + branch + commit + PR in one
 *       call) instead of docEditor's separate /commit and /pr routes —
 *       this app's UI only ever needs "submit this workspace", not a
 *       multi-step commit-then-PR review flow.
 *     - Branch name is the workspace's own name directly (e.g.
 *       "default-main-fr"), matching docEditor's "workspace name IS the
 *       branch name" convention — simpler than a translate/<locale>/<slug>
 *       scheme, and consistent with this app already being one branch/PR
 *       per locale-workspace session (see DEV_NOTES.md's own "PR
 *       granularity" note).
 *     - What actually gets committed per changed path is entirely
 *       workspaceStore.ts:prepareChangeForCommit()'s job (translated_from:
 *       reattachment, mkdocs.yml vs. page vs. image) — this file only
 *       ever deals with GitHub's Git Data API, never this project's own
 *       workspace layout or frontmatter convention.
 *     - PRs are created as drafts (`draft: true`) — mirrors the old
 *       Python app's own "draft PRs by default" behavior (a translator
 *       submitting mid-session shouldn't look done until they say so).
 *       No "mark ready for review" action built yet — that needs a
 *       GraphQL mutation (markPullRequestReadyForReview; the REST Pulls
 *       API has no way to flip draft->ready), not part of this slice;
 *       GitHub's own "Ready for review" button on the PR page is the
 *       fallback until it exists here.
 *     - No delete/removed-file handling — this app has no "delete an
 *       existing upstream page" feature (a discarded brand-new page,
 *       workspaceStore.ts's own discardChange(), never reaches a commit
 *       at all; it's undone before ever being submitted).
 *     - **Repo-owner case**: caught live, testing against the real repo —
 *       ensureFork() assumes the signed-in user is a *different* account
 *       than GITHUB_OWNER (the normal open-source "contribute via your
 *       own fork" shape), and GitHub's fork API can't fork a repo onto
 *       the account that already owns it. When the signed-in login IS
 *       GITHUB_OWNER (the repo's own owner using this tool on their own
 *       docs), there's no fork step at all — every Git Data API call
 *       below targets `${GITHUB_OWNER}/${GITHUB_REPO}` directly instead
 *       of `${login}/${GITHUB_REPO}`, and the PR's `head` is the bare
 *       branch name (GitHub's Pulls API only wants the "owner:branch"
 *       form for a *cross-repo* head — a same-repo PR just uses the
 *       branch name on its own).
 */
import express from "express";
import { getTokenForUser } from "./authRoutes";
import { githubRequest, GitHubApiError, GitHubRateLimitError, buildGitHubUrl } from "../githubClient";
import { ensureFork, ForkError, UpstreamMergeConflictError } from "../ensureFork";
import { GITHUB_OWNER, GITHUB_REPO, GITHUB_DEFAULT_BRANCH } from "../config/github";
import { readMeta, scanChanges, prepareChangeForCommit, WorkspaceError } from "../workspaceStore";
import { isSafePathSegment } from "../safePath";

const router = express.Router();

// See this file's own header comment ("Repo-owner case") — the one
// account GitHub can't let ensureFork() fork the upstream repo onto,
// since it already owns it.
function isRepoOwner(login: string): boolean {
  return login.toLowerCase() === GITHUB_OWNER.toLowerCase();
}

// Returns {login, token} together — unlike navRoutes.ts/workspaceRoutes.ts's
// own tokenForRequest() (which quietly falls back to anonymous browsing on
// any auth failure), submitting a PR has no anonymous fallback at all, so
// this throws a clear, actionable WorkspaceError instead of leaving
// getTokenForUser()'s own generic "User not authenticated" Error to fall
// through to a vague 500.
async function requireAuth(req: express.Request): Promise<{ login: string; token: string }> {
  const login = req.session?.login;
  if (!login) throw new WorkspaceError("Sign in with GitHub before submitting.");
  try {
    const token = await getTokenForUser(login);
    return { login, token };
  } catch {
    throw new WorkspaceError("Your GitHub sign-in has expired — sign in again before submitting.");
  }
}

/* ============================================================
   Branch helpers — see gitRoutes.ts's own header comment: adapted
   near-verbatim from rotorflight-docEditor's own ensureBranch/
   syncBranchWithUpstream (same Git Data API, same reasoning for a real
   merge over a tree splice), just repointed at this project's
   githubRequest()/config and using the workspace's own name as the
   branch name.
   ============================================================ */

// Real merge (GitHub's Merges API), not a tree splice — see this file's
// header comment for why. Uses the bare-fetch path (not the shared
// githubRequest()) because it has to distinguish three different non-JSON
// outcomes: 201 (real merge commit), 204 (already up to date — not an
// error), and 409 (a genuine content conflict).
async function syncBranchWithUpstream(token: string, remoteOwner: string, branch: string): Promise<void> {
  const upstreamRef = await githubRequest<{ object: { sha: string } }>(
    token,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${GITHUB_DEFAULT_BRANCH}`,
  );

  const res = await fetch(buildGitHubUrl(`/repos/${remoteOwner}/${GITHUB_REPO}/merges`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base: branch,
      head: upstreamRef.object.sha,
      commit_message: `Merge upstream/${GITHUB_DEFAULT_BRANCH} into ${branch}`,
    }),
  });

  if (res.status === 204 || res.status === 201) return; // already up to date, or merged cleanly
  if (res.status === 409) throw new UpstreamMergeConflictError(branch);

  const text = await res.text();
  throw new GitHubApiError(res.status, `GitHub API error syncing with upstream: ${res.status} ${text}`);
}

// Ensures the workspace's own branch exists at `remoteOwner`/GITHUB_REPO
// (the user's fork, or GITHUB_REPO itself when the signed-in user IS
// GITHUB_OWNER — see this file's header comment), then brings it up to
// date with upstream before the caller commits on top.
async function ensureBranch(
  token: string,
  remoteOwner: string,
  branch: string,
): Promise<{ object: { sha: string } }> {
  let branchExists = true;
  try {
    await githubRequest(token, `/repos/${remoteOwner}/${GITHUB_REPO}/git/refs/heads/${branch}`);
  } catch {
    branchExists = false;
  }

  if (!branchExists) {
    // From remoteOwner's own default-branch tip, not necessarily
    // upstream's own current tip — a fork's default branch is usually
    // behind upstream, and a ref pointing at a commit never merged into
    // the fork's own history 404s even though it's individually readable
    // by SHA across the fork network (forks share object storage with
    // their parent). When remoteOwner IS GITHUB_OWNER this is the exact
    // same repo, so its "own tip" already *is* upstream's current tip —
    // this still works, it's just a no-op distinction in that case.
    // syncBranchWithUpstream (called unconditionally below) brings a real
    // fork forward right after; for the same-repo case it just resolves
    // as already-up-to-date.
    const base = await githubRequest<{ object: { sha: string } }>(
      token,
      `/repos/${remoteOwner}/${GITHUB_REPO}/git/refs/heads/${GITHUB_DEFAULT_BRANCH}`,
    );
    await githubRequest(token, `/repos/${remoteOwner}/${GITHUB_REPO}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
    });
  }

  // Every call, not just creation — an already-existing workspace branch
  // (submitting a follow-up update) can just as easily have drifted from
  // upstream since it was created.
  await syncBranchWithUpstream(token, remoteOwner, branch);

  return githubRequest(token, `/repos/${remoteOwner}/${GITHUB_REPO}/git/refs/heads/${branch}`);
}

/* ============================================================
   Commit
   ============================================================ */

interface TreeItem {
  path: string;
  mode: "100644";
  type: "blob";
  content?: string;
  sha?: string;
}

// Builds and commits one tree covering every pending change in the
// workspace — plain function (not just the route below) so /submit can
// call it directly in-process. Returns false if there was nothing to
// commit (submitPullRequest still runs — a workspace with an already-
// open PR and no *new* changes since should just re-affirm/update it,
// not error out).
async function commitChanges(
  token: string,
  remoteOwner: string,
  workspaceName: string,
  branch: string,
): Promise<boolean> {
  const changes = await scanChanges(workspaceName);
  if (changes.length === 0) return false;

  const ref = await ensureBranch(token, remoteOwner, branch);
  const headCommit = await githubRequest<{ tree: { sha: string } }>(
    token,
    `/repos/${remoteOwner}/${GITHUB_REPO}/git/commits/${ref.object.sha}`,
  );

  const treeItems: TreeItem[] = [];
  for (const change of changes) {
    const prepared = await prepareChangeForCommit(token, workspaceName, change.path);

    if (prepared.binary) {
      // Git trees' inline `content` field is UTF-8 text only — a binary
      // file needs its own blob first, base64-encoded, referenced by sha.
      const blob = await githubRequest<{ sha: string }>(token, `/repos/${remoteOwner}/${GITHUB_REPO}/git/blobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: prepared.buffer!.toString("base64"), encoding: "base64" }),
      });
      treeItems.push({ path: prepared.repoPath, mode: "100644", type: "blob", sha: blob.sha });
      continue;
    }

    treeItems.push({ path: prepared.repoPath, mode: "100644", type: "blob", content: prepared.content });
  }

  const tree = await githubRequest<{ sha: string }>(token, `/repos/${remoteOwner}/${GITHUB_REPO}/git/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: treeItems }),
  });

  const pageWord = changes.length === 1 ? "page" : "pages";
  const commit = await githubRequest<{ sha: string }>(token, `/repos/${remoteOwner}/${GITHUB_REPO}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Update ${changes.length} ${pageWord} from workspace "${workspaceName}"`,
      tree: tree.sha,
      parents: [ref.object.sha],
    }),
  });

  await githubRequest(token, `/repos/${remoteOwner}/${GITHUB_REPO}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commit.sha }),
  });

  return true;
}

/* ============================================================
   Pull request
   ============================================================ */

interface SubmitResult {
  status: "pr_created" | "pr_updated" | "no_changes";
  prNumber?: number;
  url?: string;
}

async function submitPullRequest(
  token: string,
  login: string,
  workspaceName: string,
  branch: string,
  changeCount: number,
): Promise<SubmitResult> {
  const meta = await readMeta(workspaceName);
  const title =
    meta.locale === "en"
      ? `Docs updates from "${workspaceName}"`
      : `Translate (${meta.locale}) — ${workspaceName}`;
  const body = `Submitted via Ethos Manual Editor. ${changeCount} file(s) changed in this workspace.`;

  const existing = await githubRequest<Array<{ number: number }>>(
    token,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?head=${login}:${branch}&state=open`,
  );

  if (existing.length > 0) {
    const pr = await githubRequest<{ number: number; html_url: string }>(
      token,
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${existing[0].number}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    return { status: "pr_updated", prNumber: pr.number, url: pr.html_url };
  }

  // GitHub's Pulls API only wants the "owner:branch" head form for a
  // *cross-repo* head (a real fork) — a same-repo PR (the signed-in user
  // IS GITHUB_OWNER, see this file's header comment) just uses the bare
  // branch name; sending "owner:branch" there is rejected as an invalid
  // head reference.
  const head = isRepoOwner(login) ? branch : `${login}:${branch}`;

  const pr = await githubRequest<{ number: number; html_url: string }>(
    token,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        head,
        base: GITHUB_DEFAULT_BRANCH,
        body,
        draft: true,
      }),
    },
  );
  return { status: "pr_created", prNumber: pr.number, url: pr.html_url };
}

/* ============================================================
   Routes
   ============================================================ */

function handleError(res: express.Response, err: unknown) {
  if (err instanceof WorkspaceError) return res.status(400).json({ error: err.message });
  if (err instanceof ForkError) return res.status(409).json({ error: err.message });
  if (err instanceof GitHubRateLimitError) return res.status(429).json({ error: err.message });
  if (err instanceof GitHubApiError) return res.status(502).json({ error: err.message });
  console.error("git route error:", err);
  return res.status(500).json({ error: "Something went wrong submitting to GitHub." });
}

router.post("/:name/submit", async (req, res) => {
  const workspaceName = req.params.name;
  if (!isSafePathSegment(workspaceName)) {
    return res.status(400).json({ error: "Invalid workspace name." });
  }

  try {
    const { login, token } = await requireAuth(req);
    const branch = workspaceName;

    // See this file's header comment ("Repo-owner case") — GitHub can't
    // fork GITHUB_OWNER/GITHUB_REPO onto the same account that owns it
    // (ensureFork() would 409 on exactly that, caught live testing this
    // against the real repo). When the signed-in login IS GITHUB_OWNER,
    // commit directly to a branch on the real repo instead.
    const remoteOwner = isRepoOwner(login) ? GITHUB_OWNER : login;
    if (remoteOwner !== GITHUB_OWNER) {
      await ensureFork(token, login);
    }

    const changes = await scanChanges(workspaceName);
    if (changes.length === 0) {
      return res.json({ status: "no_changes" } satisfies SubmitResult);
    }

    await commitChanges(token, remoteOwner, workspaceName, branch);
    const result = await submitPullRequest(token, login, workspaceName, branch, changes.length);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// Lets the frontend show "PR #N open" / "PR merged" / "no PR yet" without
// having to remember anything itself — a workspace's PR state can change
// out-of-band (merged or closed on github.com) between sessions.
router.get("/:name/pr-status", async (req, res) => {
  const workspaceName = req.params.name;
  if (!isSafePathSegment(workspaceName)) {
    return res.status(400).json({ error: "Invalid workspace name." });
  }

  try {
    const { login, token } = await requireAuth(req);

    const prs = await githubRequest<Array<{ number: number; html_url: string; state: string; merged_at: string | null }>>(
      token,
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?head=${login}:${workspaceName}&state=all`,
    );

    if (prs.length === 0) return res.json({ state: "none" });

    const pr = prs[0];
    const state = pr.state === "open" ? "open" : pr.merged_at ? "merged" : "closed";
    res.json({ state, prNumber: pr.number, url: pr.html_url });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
