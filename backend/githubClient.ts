/* backend/githubClient.ts
 *
 * Description of responsibility:
 *   Thin wrapper around the GitHub REST API: attaches the bearer token
 *   and required headers, and turns a non-2xx response into a thrown,
 *   typed error instead of leaving every caller to check res.ok itself.
 *
 * Info:
 *   Every authenticated GitHub call in the backend (ensureFork,
 *   authRoutes, docsRoutes, gitRoutes) goes through this one
 *   githubRequest() — ported from rotorflight-docEditor's
 *   backend/githubClient.ts, but consolidated: that project has a
 *   *second*, independently-written githubRequest() duplicated inside
 *   gitRoutes.ts (different signature, its own copy of the same
 *   rate-limit/error logic). Keeping one implementation here instead
 *   means a future change to auth headers or error handling can't
 *   silently apply to only one of the two call paths.
 *
 *   Uses the global fetch/RequestInit (built into Node 18+, ambient via
 *   @types/node — no import needed) rather than the node-fetch package:
 *   node-fetch v3 is ESM-only, and require()-ing an ESM package from
 *   this file's compiled CommonJS output throws ERR_REQUIRE_ESM on any
 *   Node runtime without require(esm) support — including some Electron
 *   Node builds, even where it happens to work under a newer dev-time
 *   Node version.
 */

export type GitHubToken = string;

const GITHUB_API_BASE = "https://api.github.com";

// Every GitHub API call in the backend builds its URL through this,
// rather than raw template-literal concatenation
// (`https://api.github.com${path}`) — a `path` starting with "//" is
// protocol-relative and would resolve against a different host entirely,
// bypassing api.github.com. No current call site passes anything but a
// literal "/repos/..."-style string, but rejecting a non-conforming path
// here closes that off structurally rather than relying on that staying
// true as the code evolves.
export function buildGitHubUrl(path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`Invalid GitHub API path: ${path}`);
  }
  return new URL(path, GITHUB_API_BASE);
}

export class GitHubApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

// Deliberately does NOT extend GitHubApiError: docsRoutes.ts's
// asAppNotInstalledError() treats any GitHubApiError with status 403/404
// as "the App isn't installed", and a rate limit is a completely
// different, unrelated condition that happens to also show up as a 403 —
// keeping this a sibling type rather than a subclass means that check
// can't accidentally swallow a rate-limit error and misreport it as a
// missing install.
export class GitHubRateLimitError extends Error {
  status: number;
  retryAfterSeconds: number;
  constructor(status: number, retryAfterSeconds: number) {
    super(
      `GitHub API rate limit hit — try again in about ${retryAfterSeconds}s.`,
    );
    this.name = "GitHubRateLimitError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// GitHub signals rate limiting two ways: a "retry-after" header for
// secondary/abuse limits (the one most likely to actually happen here —
// e.g. committing a workspace with several images makes that many
// individual blob-creation calls in quick succession), and
// x-ratelimit-remaining hitting 0 (with x-ratelimit-reset giving the unix
// timestamp it recovers at) for the primary per-hour limit. Returns null
// for a non-rate-limit failure.
export function rateLimitRetryAfterSeconds(res: Response): number | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return Math.max(1, seconds);
  }

  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset) {
    const resetMs = Number(reset) * 1000;
    if (!Number.isNaN(resetMs)) {
      return Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
    }
  }

  return null;
}

// Only worth auto-waiting for a short, bounded delay — a request that's
// already taking seconds shouldn't silently turn into one taking minutes.
// Past this, the caller gets a clear, typed error immediately instead.
export const MAX_AUTO_RETRY_WAIT_SECONDS = 30;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Thrown wherever a GitHubApiError's status (403 with no installation, or
// 404 on a repo we know exists) points at the GitHub App itself not being
// installed/permitted for this account, rather than any other kind of
// failure — see the callers in ensureFork.ts and gitRoutes.ts for exactly
// which calls this is inferred from. Carries installUrl so the frontend
// can offer a direct link instead of just a dead-end error string.
export class GitHubAppNotInstalledError extends Error {
  installUrl: string;
  constructor(installUrl: string) {
    super(
      "GitHub blocked this action — the Ethos Manual Editor GitHub " +
        "App either isn't installed for this account yet, or is installed " +
        "without the permissions this needs. Install it (or approve a " +
        "pending install request) before this will work.",
    );
    this.name = "GitHubAppNotInstalledError";
    this.installUrl = installUrl;
  }
}

// token is nullable — nav/browsing calls (mkdocsConfig.ts) are anonymous
// by default, same as ethos-manual-rework-editor's own Python
// github_repo.py: browsing a public repo needs no sign-in at all, and
// gets upgraded to an authenticated client only once a token actually
// exists (which happens to raise the rate limit from 60/hour to
// 5000/hour too, but that's incidental — see mkdocsConfig.ts). Every
// commit/PR-writing call (gitRoutes.ts, once ported) always has a real
// token, since those actions require sign-in.
export async function githubRequest<T>(
  token: GitHubToken | null,
  path: string,
  init: RequestInit = {},
  _isRetry = false,
): Promise<T> {
  const res = await fetch(buildGitHubUrl(path), {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const retryAfterSeconds = rateLimitRetryAfterSeconds(res);

    if (retryAfterSeconds !== null) {
      if (!_isRetry && retryAfterSeconds <= MAX_AUTO_RETRY_WAIT_SECONDS) {
        console.warn(
          `GitHub API rate limited on ${path} — waiting ${retryAfterSeconds}s and retrying once`,
        );
        await sleep(retryAfterSeconds * 1000);
        return githubRequest<T>(token, path, init, true);
      }
      throw new GitHubRateLimitError(res.status, retryAfterSeconds);
    }

    const text = await res.text();
    console.error("GitHub API error:", res.status, text);
    throw new GitHubApiError(res.status, `GitHub API ${res.status}: ${text}`);
  }

  // 204 No Content (e.g. a merge that was a no-op) has no body to parse.
  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}
