/* backend/routes/authRoutes.ts
 *
 * Description of responsibility:
 *   Implements GitHub's OAuth device flow (start/poll) and owns the
 *   server-side session: it's the only place req.session.login ever
 *   gets set, and it exposes /session, /status/:login, /me/:login and
 *   /logout for the frontend to read and clear that session. Also
 *   stores each user's GitHub access token on disk, keyed by their
 *   immutable GitHub id (routes/tokens/<id>.json, not <login>.json — see
 *   the comment above StoredToken for why), and exposes
 *   getTokenForUser() for the rest of the backend.
 *
 * Info:
 *   /status/:login and /me/:login only ever answer for the caller's own
 *   session login, never an arbitrary :login param — otherwise anyone
 *   could probe whether any GitHub username has used this app. Identity
 *   is established exactly once, in /device/poll, right after GitHub
 *   confirms the token; nothing downstream trusts a client-supplied
 *   login value. Token file paths use process.cwd() rather than
 *   __dirname so they resolve the same whether running from source
 *   (ts-node-dev) or compiled dist/ output.
 *
 *   Ported from rotorflight-docEditor's backend/routes/authRoutes.ts,
 *   repointed at this project's config/github.ts (GITHUB_CLIENT_ID,
 *   GITHUB_APP_INSTALL_URL) and the consolidated githubRequest() in
 *   ./githubClient (see that file's header comment).
 */
import express from "express";
import fs from "fs";
import path from "path";
import { GITHUB_CLIENT_ID, GITHUB_APP_INSTALL_URL } from "../config/github";
import { githubRequest } from "../githubClient";
import { ensureFork } from "../ensureFork";

const router = express.Router();

// ---------------------------------------------
// Token Storage Directory
// ---------------------------------------------
// process.cwd() rather than __dirname — matches how every other file-storage
// path in this app is computed (workspaces/, mirror/), and unlike __dirname
// it resolves to the same place whether this runs from source (ts-node-dev)
// or from compiled dist/routes/authRoutes.js, so a production build doesn't
// silently start looking for tokens in the wrong directory.
const TOKENS_DIR = path.join(process.cwd(), "routes", "tokens");

if (!fs.existsSync(TOKENS_DIR)) {
  // recursive: true — "routes" itself won't exist yet either the first
  // time this runs against a brand-new cwd (e.g. a packaged Electron
  // app's freshly created per-user data directory, see electron/main.ts).
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  console.log("📁 Created tokens directory:", TOKENS_DIR);
}

// ---------------------------------------------
// Helpers
// ---------------------------------------------
// Keyed by GitHub's immutable numeric id, not the mutable `login` handle —
// per GitHub's own guidance, storing identity by username means a GitHub
// account rename silently orphans the stored token: the app would look for
// a filename that no longer matches anything. `id` never changes for the
// life of the account, so a rename just means the *login* field inside the
// same file gets refreshed next time this same account logs in — the
// record itself stays found.
//
// Every other route in the app still calls getTokenForUser(login) with the
// session's current username — GitHub's own APIs need the current username
// anyway for repo/fork/PR paths (there's no numeric-id form of
// "owner/repo") — so loadToken() here does the login->id resolution
// internally via a directory scan, keeping every caller elsewhere in the
// codebase completely unchanged.
interface StoredToken {
  access_token: string;
  expires_at: number;
  login: string;
  id: number;
}

function tokenPath(id: number) {
  return path.join(TOKENS_DIR, `${id}.json`);
}

function readTokenFile(file: string): StoredToken | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));

    if (
      !data.expires_at ||
      typeof data.expires_at !== "number" ||
      Number.isNaN(data.expires_at)
    ) {
      console.warn(`Token file ${file} missing or invalid expires_at, deleting`);
      fs.unlinkSync(file);
      return null;
    }

    if (Date.now() > data.expires_at) {
      console.log(`⏳ Token for ${data.login} expired, deleting`);
      fs.unlinkSync(file);
      return null;
    }

    return data;
  } catch (err) {
    console.error("Failed to load token file:", file, err);
    return null;
  }
}

function loadToken(login: string): StoredToken | null {
  for (const name of fs.readdirSync(TOKENS_DIR)) {
    if (!name.endsWith(".json")) continue;

    const token = readTokenFile(path.join(TOKENS_DIR, name));
    if (token && token.login === login) return token;
  }

  return null;
}

// Sessions live in MemoryStore (see server.ts's own comment on why —
// nothing here needs to survive a restart in the general case), but
// that means every backend restart orphans any already-issued session
// cookie: the stored *token* file is still sitting on disk, perfectly
// valid, with nothing left mapping a browser's cookie to it. For a
// genuinely multi-tenant server that's the right failure mode (a
// restart shouldn't silently hand out someone else's session) — but
// this app is single-user per desktop install (see
// workspaceStore.ts's own header comment for the same reasoning
// applied to local workspaces), so requiring a full device-flow
// re-login after every restart is pure friction with no real security
// benefit. If exactly one valid token is stored, auto-adopt it as
// "whoever's using this install" — ambiguous (zero, or more than one,
// e.g. two different accounts tested on the same machine) still falls
// back to a real login rather than guessing.
function findSoleStoredUser(): StoredToken | null {
  const files = fs.readdirSync(TOKENS_DIR).filter((name) => name.endsWith(".json"));
  if (files.length !== 1) return null;
  return readTokenFile(path.join(TOKENS_DIR, files[0]));
}

function saveToken(token: StoredToken) {
  const file = tokenPath(token.id);
  fs.writeFileSync(file, JSON.stringify(token, null, 2), "utf8");
  console.log(`💾 Saved token for ${token.login} (id ${token.id})`);
}

// GitHub's own device-flow response shapes — narrows the two .json()
// results below away from `unknown` instead of leaving them implicitly any.
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
}

// ---------------------------------------------
// Start Device Flow
// ---------------------------------------------
router.post("/device/start", async (_req, res) => {
  console.log("📡 /device/start called");

  const params = new URLSearchParams();
  params.append("client_id", GITHUB_CLIENT_ID);
  params.append("scope", "repo");

  const resp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = (await resp.json()) as DeviceCodeResponse;

  res.json({
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    interval: data.interval,
  });
});

// ---------------------------------------------
// Poll for Token
// ---------------------------------------------
router.post("/device/poll", async (req, res) => {
  try {
    // No client_secret — GitHub Apps' device flow needs none (unlike a
    // classic OAuth App's), which is the whole reason this is registered
    // as one: nothing secret has to ship inside a downloadable executable.
    const params = new URLSearchParams();
    params.append("client_id", GITHUB_CLIENT_ID);
    params.append("device_code", req.body.device_code);
    params.append(
      "grant_type",
      "urn:ietf:params:oauth:grant-type:device_code",
    );

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = (await resp.json()) as AccessTokenResponse;

    if (data.error) {
      return res.json({ status: "pending", error: data.error });
    }

    // GitHub's contract is error-or-access_token, never neither — but
    // that's not something the response's own type can prove, so this
    // both narrows access_token to a definite string below and guards the
    // case where it holds for some unexpected reason.
    if (!data.access_token) {
      return res.json({ status: "pending", error: "no_access_token" });
    }

    // Fetch user identity
    const user = await githubRequest<any>(data.access_token, "/user");

    // Compute expiration safely
    const expires_at =
      typeof data.expires_in === "number"
        ? Date.now() + data.expires_in * 1000
        : Date.now() + 8 * 60 * 60 * 1000; // fallback: 8 hours

    const token: StoredToken = {
      access_token: data.access_token,
      expires_at,
      login: user.login,
      id: user.id,
    };

    saveToken(token);

    // This is the actual authentication boundary: everything downstream
    // (docsRoutes/gitRoutes) identifies "who is making this request" from
    // req.session.login, never from a client-supplied login field, so this
    // is the one place that gets to set it.
    req.session.login = token.login;
    req.session.userId = token.id;

    // Fire-and-forget: starts fork creation as early as possible so it has
    // time to become usable before the user gets to submitting a PR,
    // without making login wait on it. ensureFork() is called again before
    // any actual commit (gitRoutes.ts), so a user submitting within
    // seconds of this is still handled correctly — this is purely a head
    // start.
    ensureFork(token.access_token, token.login).catch((err) => {
      console.error(`ensureFork failed for ${token.login} after login:`, err);
    });

    res.json({ status: "ok", login: user.login });
  } catch (err) {
    // Anything thrown above (a GitHub API hiccup, etc.) used to escape
    // uncaught, which Express turns into a 500 HTML error page — the
    // frontend's poll() then fails to parse that as JSON and the polling
    // loop just dies silently, leaving the UI stuck on "Waiting for
    // authorisation…" forever with no visible error. Returning real JSON
    // here lets the frontend at least stop and let the user retry instead.
    console.error("device/poll failed:", err);
    res.status(500).json({ status: "error", error: "poll_failed" });
  }
});

// ---------------------------------------------
// Restore session on page load — the frontend can't ask "is <name>
// authenticated?" anymore (that let anyone probe/impersonate any GitHub
// username); it can only ask "who does my own session cookie belong to?".
// ---------------------------------------------
router.get("/session", (req, res) => {
  let login = req.session.login;

  // No session yet for this cookie (fresh browser session, or the
  // backend restarted and wiped MemoryStore since it was issued) — see
  // findSoleStoredUser()'s own comment for why auto-adopting a single
  // stored token is the right call for a single-user desktop install.
  if (!login) {
    const sole = findSoleStoredUser();
    if (sole) {
      login = sole.login;
      req.session.login = login;
      req.session.userId = sole.id;
    }
  }

  const authenticated = !!login && !!loadToken(login);

  if (!authenticated) {
    // Token expired/was revoked since the cookie was issued — don't keep
    // asserting a session that no longer has a usable token behind it.
    req.session.login = undefined;
  }

  res.json({ authenticated, login: authenticated ? login : null });
});

// ---------------------------------------------
// Auth Status (legacy, param'd form) — only ever confirms the caller's OWN
// session, not an arbitrary username, so this can't be used to check
// whether someone else has authenticated with this app.
// ---------------------------------------------
router.get("/status/:login", (req, res) => {
  const authenticated =
    req.session.login === req.params.login && !!loadToken(req.params.login);
  res.json({ authenticated });
});

// ---------------------------------------------
// Get User Info — same restriction: only your own profile, derived from
// your own session, never an arbitrary :login someone else supplied.
// ---------------------------------------------
router.get("/me/:login", async (req, res) => {
  if (req.session.login !== req.params.login) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const token = loadToken(req.params.login);

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const user = await githubRequest<any>(token.access_token, "/user");
    res.json({
      login: user.login,
      name: user.name,
      avatar_url: user.avatar_url,
    });
  } catch (err) {
    console.error("Failed to fetch user:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ---------------------------------------------
// Installation Status — checked once right after login (see
// frontend/src/hooks/useAuth.ts) rather than only discovered when a PR
// submission's commit/PR steps 403 — the app can't force an install onto
// an account (GitHub requires that account's own owner to approve it, see
// GitHubAppNotInstalledError), but it can at least tell the user
// immediately instead of after they've already done a session's worth of
// edits.
// ---------------------------------------------
router.get("/installation-status", async (req, res) => {
  const login = req.session.login;
  const token = login ? loadToken(login) : null;

  if (!login || !token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const data = await githubRequest<{
      installations: Array<{ account: { login: string } }>;
    }>(token.access_token, "/user/installations");

    const installed = data.installations.some(
      (i) => i.account.login.toLowerCase() === login.toLowerCase(),
    );

    res.json({
      installed,
      installUrl: installed ? undefined : GITHUB_APP_INSTALL_URL,
    });
  } catch (err) {
    console.error("installation-status check failed:", err);
    // Fails open — a transient GitHub API hiccup here shouldn't put up a
    // false "not installed" warning; the PR-submit-time check (which
    // fails closed, since it can't complete the action either way) still
    // catches a genuinely missing install regardless.
    res.json({ installed: true });
  }
});

// ---------------------------------------------
// Logout
// ---------------------------------------------
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// ---------------------------------------------
// Export helper for docsRoutes/gitRoutes
// ---------------------------------------------
export function getTokenForUser(login: string): string {
  const token = loadToken(login);
  if (!token) throw new Error("User not authenticated");
  return token.access_token;
}

export default router;
