/* backend/ensureFork.ts
 *
 * Description of responsibility:
 *   Ensures <login>/<GITHUB_REPO> exists as a genuine fork of
 *   <GITHUB_OWNER>/<GITHUB_REPO>, creating it if missing, before any
 *   commit or PR flow tries to use it.
 *
 * Info:
 *   GitHub's fork API returns 202 and replicates the fork asynchronously
 *   — the repo existing is not the same as it being usable — so this
 *   polls the fork's default-branch ref until it's actually queryable
 *   instead of returning as soon as the fork API call succeeds. Shared
 *   between authRoutes.ts (called right after login, as a head start)
 *   and gitRoutes.ts (called again before every commit, so it's still
 *   correct for someone who submits within seconds of first login).
 *
 *   Ported from rotorflight-docEditor's backend/ensureFork.ts, repointed
 *   at this project's config and the consolidated githubRequest() (see
 *   githubClient.ts's header comment for why there's only one here).
 */
import { githubRequest, GitHubApiError, GitHubAppNotInstalledError } from "./githubClient";
import {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_DEFAULT_BRANCH,
  GITHUB_APP_INSTALL_URL,
} from "./config/github";

const FORK_POLL_INTERVAL_MS = 1500;
const FORK_POLL_MAX_ATTEMPTS = 8; // ~12s of polling before giving up

export class ForkError extends Error {}

export class ForkNotReadyError extends ForkError {
  constructor() {
    super(
      "Your GitHub fork is still being created — please try again in a few seconds.",
    );
    this.name = "ForkNotReadyError";
  }
}

export class ForkConflictError extends ForkError {
  constructor() {
    super(
      `A repository named "${GITHUB_REPO}" already exists on your GitHub account but isn't a fork of ${GITHUB_OWNER}/${GITHUB_REPO}. Please rename or remove it, then try again.`,
    );
    this.name = "ForkConflictError";
  }
}

// Thrown by gitRoutes.ts's syncBranchWithUpstream() when a real merge of
// upstream's latest commit into the workspace branch hits an actual
// content conflict (GitHub's Merges API returns 409) — upstream and the
// user's already-committed local edits changed the same lines. Unlike
// ForkNotReadyError this isn't transient; it needs a human to resolve it.
export class UpstreamMergeConflictError extends ForkError {
  constructor(branch: string) {
    super(
      `Merging upstream's latest changes into "${branch}" hit a real ` +
        `conflict — upstream and your local edits changed the same ` +
        `content. Resolve it on GitHub directly (compare/merge ` +
        `${GITHUB_OWNER}/${GITHUB_REPO}:${GITHUB_DEFAULT_BRANCH} into ` +
        `your fork's ${branch} branch), then try submitting again.`,
    );
    this.name = "UpstreamMergeConflictError";
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureFork(token: string, login: string): Promise<void> {
  let existing: any = null;
  try {
    existing = await githubRequest(token, `/repos/${login}/${GITHUB_REPO}`);
  } catch {
    existing = null;
  }

  const isRealFork =
    existing?.fork === true &&
    existing?.parent?.full_name?.toLowerCase() ===
      `${GITHUB_OWNER}/${GITHUB_REPO}`.toLowerCase();

  if (existing && !isRealFork) {
    throw new ForkConflictError();
  }

  if (!isRealFork) {
    try {
      await githubRequest(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/forks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_branch_only: true }),
      });
    } catch (err) {
      // GITHUB_OWNER/GITHUB_REPO is the well-known upstream repo — it
      // always exists, so a 403/404 forking it can only mean the App has
      // no usable installation for this account, not a genuinely missing
      // repo. The unfiltered rethrow below preserves any other failure
      // (rate limit, network error, etc.) as-is.
      if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
        throw new GitHubAppNotInstalledError(GITHUB_APP_INSTALL_URL);
      }
      throw err;
    }
  }

  for (let attempt = 0; attempt < FORK_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      await githubRequest(
        token,
        `/repos/${login}/${GITHUB_REPO}/git/refs/heads/${GITHUB_DEFAULT_BRANCH}`,
      );
      return;
    } catch (err) {
      // A 403 here is not "still replicating" — GitHub returns 404 for a
      // ref that genuinely doesn't exist yet, never 403. Retrying a 403
      // just burns ~12s before giving up with a misleading "still being
      // created" message instead of the real cause: no installation
      // access to this account's fork at all.
      if (err instanceof GitHubApiError && err.status === 403) {
        throw new GitHubAppNotInstalledError(GITHUB_APP_INSTALL_URL);
      }
      await sleep(FORK_POLL_INTERVAL_MS);
    }
  }

  throw new ForkNotReadyError();
}
