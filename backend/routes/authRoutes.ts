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
  // Only present for a GitHub App with "expire user authorization tokens"
  // enabled (the default for new Apps) — access_token above then expires
  // in ~8h, and this is what lets getUsableToken() below silently mint a
  // new one instead of forcing a full device-flow re-login every time.
  // GitHub rotates the refresh_token on every use, so refreshStoredToken()
  // always overwrites both together, never just the access_token.
  refresh_token?: string;
  refresh_token_expires_at?: number;
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

    // Deliberately does NOT delete an expired access_token here anymore —
    // that used to also throw away a still-live refresh_token sitting in
    // the same record, forcing a full device-flow re-login even when a
    // silent refresh (getUsableToken() below) could have recovered it.
    // Expiry is judged there, where a refresh can actually be attempted.
    return data;
  } catch (err) {
    console.error("Failed to load token file:", file, err);
    return null;
  }
}

function isRefreshable(token: StoredToken): boolean {
  return (
    !!token.refresh_token &&
    typeof token.refresh_token_expires_at === "number" &&
    Date.now() < token.refresh_token_expires_at
  );
}

// GitHub rotates the refresh_token on every use — the response's own
// refresh_token (if present) is what gets stored, never the one just
// spent. No client_secret needed, same reasoning as the initial device-
// flow exchange in /device/poll below: this app is a public client.
async function refreshStoredToken(token: StoredToken): Promise<StoredToken | null> {
  if (!token.refresh_token) return null;

  try {
    const params = new URLSearchParams();
    params.append("client_id", GITHUB_CLIENT_ID);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", token.refresh_token);

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = (await resp.json()) as AccessTokenResponse;

    if (data.error || !data.access_token) {
      // The refresh_token itself was rejected (revoked, already used,
      // past its own ~6-month expiry) — no path forward but a real
      // re-login, so there's nothing left worth keeping on disk.
      console.log(
        `🔁 Refresh failed for ${token.login} (${data.error || "no access_token"}) — dropping stored token.`,
      );
      fs.unlinkSync(tokenPath(token.id));
      return null;
    }

    const expires_at =
      typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : Date.now() + 8 * 60 * 60 * 1000;

    const updated: StoredToken = {
      access_token: data.access_token,
      expires_at,
      login: token.login,
      id: token.id,
      refresh_token: data.refresh_token,
      refresh_token_expires_at:
        data.refresh_token && typeof data.refresh_token_expires_in === "number"
          ? Date.now() + data.refresh_token_expires_in * 1000
          : undefined,
    };

    saveToken(updated);
    console.log(`🔁 Refreshed access token for ${token.login}`);
    return updated;
  } catch (err) {
    // A transient network hiccup, not a rejection — leave the stored
    // record (and its still-possibly-good refresh_token) alone so the
    // next request can just try again, rather than punishing a blip with
    // a forced re-login.
    console.error(`Refresh request failed for ${token.login}:`, err);
    return null;
  }
}

// The one function every route below should call instead of loadToken()
// directly when it actually needs to *use* the token (call the GitHub
// API with it) — loadToken()'s raw record may hold an access_token
// that's already expired. This is what makes "sign in once" actually
// stick past the ~8h access-token lifetime instead of silently reverting
// to logged-out.
async function getUsableToken(login: string): Promise<StoredToken | null> {
  const token = loadToken(login);
  if (!token) return null;

  if (Date.now() < token.expires_at) return token;

  if (isRefreshable(token)) {
    return refreshStoredToken(token);
  }

  // Genuinely dead: access_token expired, no live refresh_token to
  // recover with (or none was ever issued — e.g. a token saved before
  // this app stored refresh_token at all). A real re-login is the only
  // way forward.
  console.log(`⏳ Token for ${login} expired with no usable refresh_token, deleting`);
  fs.unlinkSync(tokenPath(token.id));
  return null;
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
  // Only present when the GitHub App has "expire user authorization
  // tokens" enabled — see StoredToken's own comment.
  refresh_token?: string;
  refresh_token_expires_in?: number;
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
      refresh_token: data.refresh_token,
      refresh_token_expires_at:
        data.refresh_token && typeof data.refresh_token_expires_in === "number"
          ? Date.now() + data.refresh_token_expires_in * 1000
          : undefined,
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
// Shared by /session below and server.ts's own early auto-adopt
// middleware — factored out so both go through the exact same
// resolve-then-verify logic instead of two copies drifting apart. See
// that middleware's own comment for why a second caller of this needed
// to exist at all: /session was previously the *only* place this ran,
// which meant whichever request(s) reached the backend before it — most
// commonly navRoutes.ts's own branches/toc fetches, firing on mount
// same as this app's own auth check — raced it and read
// req.session.login while it was still empty, silently falling back to
// an anonymous GitHub call (a real, live bug: confirmed reproducing a
// stuck "rate limit hit" nav error despite actually being signed in,
// fixed by moving the auto-adopt earlier so it no longer depends on
// which request happens to run first).
export async function resolveSessionLogin(req: express.Request): Promise<string | null> {
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

  // getUsableToken() (not loadToken()) — silently refreshes an expired
  // access_token via its refresh_token if one's still good, rather than
  // reporting "not authenticated" just because the ~8h access-token
  // lifetime passed since this cookie was issued.
  const token = login ? await getUsableToken(login) : null;

  if (!token) {
    // Truly expired/revoked, no refresh path left — don't keep asserting
    // a session that no longer has a usable token behind it.
    req.session.login = undefined;
    return null;
  }

  return login as string;
}

router.get("/session", async (req, res) => {
  const login = await resolveSessionLogin(req);
  res.json({ authenticated: !!login, login });
});

// ---------------------------------------------
// Auth Status (legacy, param'd form) — only ever confirms the caller's OWN
// session, not an arbitrary username, so this can't be used to check
// whether someone else has authenticated with this app. Not called by the
// frontend (which uses /session) — kept as a presence-only check (doesn't
// attempt a refresh, since it doesn't hand back or use the token itself).
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

  const token = await getUsableToken(req.params.login);

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
  const token = login ? await getUsableToken(login) : null;

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
// Export helper for navRoutes/workspaceRoutes/gitRoutes — async now
// (getUsableToken() may need to make a real refresh-token network call
// before it can answer), so every caller's own tokenForRequest() needs an
// await too (see navRoutes.ts/workspaceRoutes.ts).
// ---------------------------------------------
export async function getTokenForUser(login: string): Promise<string> {
  const token = await getUsableToken(login);
  if (!token) throw new Error("User not authenticated");
  return token.access_token;
}

export default router;
