/* backend/config/github.ts
 *
 * Description of responsibility:
 *   The one place the upstream repo's identity and the GitHub App's
 *   client id are read out of the environment, so every other backend
 *   file imports a constant instead of touching process.env itself.
 *
 * Info:
 *   GITHUB_CLIENT_ID has no default — the device flow (authRoutes.ts)
 *   can't work at all without a real App registered for this project, so
 *   failing loudly at startup beats a confusing runtime error the first
 *   time someone tries to sign in. See the project README for what the
 *   App registration needs (Device Flow enabled; Contents: read/write,
 *   Pull requests: read/write; installable on any account).
 */
import dotenv from "dotenv";
dotenv.config();

export const GITHUB_OWNER = process.env.GITHUB_OWNER || "robthomson";
export const GITHUB_REPO = process.env.GITHUB_REPO || "ethos-manual-rework";
export const GITHUB_DEFAULT_BRANCH = process.env.GITHUB_DEFAULT_BRANCH || "main";

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";

if (!GITHUB_CLIENT_ID) {
  console.warn(
    "⚠️  GITHUB_CLIENT_ID is not set — GitHub sign-in will fail until a " +
      "GitHub App is registered (Device Flow enabled) and its client id is " +
      "put in backend/.env. See the README for the exact permissions needed.",
  );
}

// Where a translator is sent to install the GitHub App on their own
// account when installation-status reports they haven't yet — the only
// place that can actually be resolved (an account/org owner has to
// approve it there), same as docEditor's own GITHUB_APP_INSTALL_URL.
export const GITHUB_APP_INSTALL_URL =
  process.env.GITHUB_APP_INSTALL_URL ||
  // The real registered App's slug is "ethos-manual-editor" (confirmed
  // against https://github.com/settings/apps/ethos-manual-editor) — this
  // fallback previously said "ethos-manual-translator", a slug that was
  // never actually registered, so it would have 404ed for anyone running
  // without GITHUB_APP_INSTALL_URL set in their own .env. Never hit in
  // practice so far since the real .env already overrides it correctly,
  // but a wrong default is still worth fixing outright.
  "https://github.com/apps/ethos-manual-editor/installations/new";
