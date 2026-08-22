/* frontend/src/hooks/useAuth.ts
 *
 * Description of responsibility:
 *   Owns the frontend's view of GitHub auth: restores an existing
 *   session on load, drives the OAuth device-flow login (start + poll),
 *   and fetches the signed-in user's public GitHub profile for display.
 *
 * Info:
 *   Ported unchanged from rotorflight-docEditor's
 *   frontend/src/hooks/useAuth.ts — nothing here is specific to which
 *   docs repo the backend edits.
 *
 *   The restore-on-load effect asks the backend "who does my session
 *   cookie belong to?" (/api/auth/session) rather than trusting a
 *   remembered localStorage login — the backend derives identity purely
 *   from req.session.login, so asking about an arbitrary remembered name
 *   would let anyone impersonate any GitHub username that had ever
 *   signed in, just by writing that name into their own localStorage.
 *   `ethos_login` in localStorage is still written on successful login
 *   and read elsewhere in the app, but only as informational display
 *   state now, never as a trust boundary.
 */
import { useEffect, useState } from "react";

type User = {
  login: string;
  name: string;
  avatar_url: string;
};

type AuthStep = "idle" | "waiting" | "polling";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authStep, setAuthStep] = useState<AuthStep>("idle");
  const [login, setLogin] = useState<string | null>(null);
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  // null = not checked yet, false = confirmed missing (see installUrl),
  // true = confirmed installed. Checked once per login rather than only
  // discovered later when a PR submission's commit/PR step 403s.
  const [appInstalled, setAppInstalled] = useState<boolean | null>(null);
  const [appInstallUrl, setAppInstallUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated && data.login) {
          setLogin(data.login);
          localStorage.setItem("ethos_login", data.login);
          setIsAuthenticated(true);
        } else {
          localStorage.removeItem("ethos_login");
        }
      })
      .catch(() => {});
  }, []);

  async function startGitHubLogin() {
    setAuthError(null);

    const res = await fetch("/api/auth/device/start", {
      method: "POST",
    });
    const data = await res.json();

    if (!data.user_code || !data.device_code) {
      setAuthError("Couldn't start GitHub sign-in. Please try again.");
      setAuthStep("idle");
      return;
    }

    setUserCode(data.user_code);
    setVerificationUri(data.verification_uri);
    setAuthStep("polling");

    pollForAuth(data.device_code, data.interval);
  }

  async function pollForAuth(deviceCode: string, interval: number) {
    const poll = async () => {
      try {
        const res = await fetch("/api/auth/device/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: deviceCode }),
        });

        const data = await res.json();

        if (data.status === "ok" && data.login) {
          setLogin(data.login);
          localStorage.setItem("ethos_login", data.login);
          setIsAuthenticated(true);
          setAuthStep("idle");
          return;
        }

        if (data.error === "authorization_pending") {
          setTimeout(poll, interval * 1000);
          return;
        }

        if (data.error === "slow_down") {
          setTimeout(poll, (interval + 2) * 1000);
          return;
        }

        // Any other error (expired code, access denied, a backend
        // failure) — stop polling and surface it instead of leaving the
        // UI stuck on "Waiting for authorisation…" forever.
        setAuthError(
          "GitHub sign-in failed (" +
            (data.error || "unknown error") +
            "). Please try again.",
        );
        setAuthStep("idle");
      } catch (err) {
        console.error("Device flow poll failed:", err);
        setAuthError("GitHub sign-in failed. Please try again.");
        setAuthStep("idle");
      }
    };

    poll();
  }

  useEffect(() => {
    if (!login) return;

    fetch(`https://api.github.com/users/${login}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && data.login) {
          setUser({
            login: data.login,
            name: data.name,
            avatar_url: data.avatar_url,
          });
        }
      })
      .catch(() => {});
  }, [login]);

  // Also re-checked on window focus: installing the App happens on
  // github.com in another tab/window, so without this the banner would
  // keep showing "not installed" for the rest of the session even after
  // the user actually installs it and switches back.
  useEffect(() => {
    if (!login) {
      setAppInstalled(null);
      setAppInstallUrl(null);
      return;
    }

    function checkInstallStatus() {
      fetch("/api/auth/installation-status", { credentials: "include" })
        .then((res) => res.json())
        .then((data) => {
          setAppInstalled(!!data.installed);
          setAppInstallUrl(data.installUrl ?? null);
        })
        .catch(() => {
          setAppInstalled(true);
        });
    }

    checkInstallStatus();
    window.addEventListener("focus", checkInstallStatus);
    return () => window.removeEventListener("focus", checkInstallStatus);
  }, [login]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});

    localStorage.removeItem("ethos_login");
    setUser(null);
    setLogin(null);
    setIsAuthenticated(false);
    setAuthStep("idle");
  }

  return {
    user,
    login,
    isAuthenticated,
    authStep,
    userCode,
    verificationUri,
    authError,
    appInstalled,
    appInstallUrl,
    startGitHubLogin,
    logout,
  };
}
