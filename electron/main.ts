/* electron/main.ts
 *
 * Description of responsibility:
 *   The Electron main-process entry point. In production/packaged mode,
 *   redirects the backend's data directory into the OS's proper per-user
 *   app-data folder, starts the existing Express server in-process (the
 *   combined frontend+API server built for `node dist/server.js`), waits
 *   for it to actually be ready, then opens a BrowserWindow pointed at
 *   it. In dev mode (`npm run dev`/`make dev`), does none of that —
 *   backend and frontend are already running as their own separate
 *   `ts-node-dev`/Vite processes (see root package.json's `dev` script)
 *   — and instead just waits for both of those to answer, then opens a
 *   window pointed at the Vite dev server (which proxies /api to the
 *   dev backend itself; see frontend/vite.config.ts).
 *
 * Info:
 *   Ported near-verbatim from rotorflight-docEditor's electron/main.ts —
 *   only the product name/port default differ, and that project has no
 *   dev-mode branch at all (its own `dev` script never opens a window;
 *   you're expected to open the Vite URL in a plain browser tab). Added
 *   here because a desktop app that never shows its own window during
 *   day-to-day development is a worse loop than it needs to be.
 *
 *   isDev is keyed off `!app.isPackaged && NODE_ENV !== "production"` —
 *   NODE_ENV is never set to "production" for this process in dev (only
 *   startBackend(), below, sets it, and only on the production path), so
 *   plain `electron .` during development lands here by default.
 *
 *   Production-path specifics (unchanged): deliberately does NOT spawn
 *   the backend as a separate child process — Electron's main process
 *   is already a full Node.js process, so requiring the backend's
 *   compiled server.js directly (which starts listening as a side
 *   effect of being imported) is simpler than managing a second
 *   process's lifecycle for an app this size. process.chdir() to the
 *   userData directory happens BEFORE requiring the backend, and
 *   nothing in the backend itself had to change for this to work: every
 *   backend file that stores real data (workspaces, saved tokens, the
 *   upstream mirror) already computes its path via process.cwd() rather
 *   than __dirname specifically so it behaves the same whether run from
 *   source or from compiled dist/ output. FRONTEND_DIST_PATH is a
 *   separate concern from the cwd redirect: server.ts needs to find the
 *   *packaged app's own* frontend build (inside the installed app's
 *   resources, not the user's data folder), which isn't reachable via a
 *   process.cwd()-relative "../frontend/dist" the way it is in plain
 *   `node dist/server.js` — so this is passed explicitly instead.
 */
import { app, BrowserWindow, dialog, shell, ipcMain } from "electron";
import path from "path";
import fs from "fs";
import http from "http";

// TEMPORARY DEBUG — remove before committing.
app.commandLine.appendSwitch("remote-debugging-port", "9333");

const PORT = process.env.PORT || "4100";

// Not the same NODE_ENV check as startBackend()'s own — this reads it
// BEFORE startBackend() has a chance to set it, so it reflects whatever
// this process was actually launched with. Plain `electron .` (root
// package.json's `electron:dev` script) never sets NODE_ENV, so this is
// true by default in dev; `npm run electron:start` (the packaged-build
// smoke test, and every real packaged install) always ends up on the
// production path via startBackend() below.
const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

// Matches backend/server.ts's own default PORT and frontend/vite.config.ts's
// proxy target — dev mode never sets $PORT (that's a production-path-only
// env var, see startBackend()), so these have to be spelled out separately
// rather than reusing the PORT constant above.
const DEV_BACKEND_HEALTH_URL = "http://localhost:4100/api/health";
const DEV_FRONTEND_URL = "http://localhost:5173/";

// Electron packages application code (this file, the backend, the built
// frontend) inside process.resourcesPath once packaged; app.getAppPath()
// covers the equivalent location when running unpackaged (electron .) —
// app.getAppPath() there already resolves to the repo root itself (where
// package.json lives, with backend/ and frontend/ directly inside it), so
// unlike the packaged case it needs no adjustment.
const RESOURCES_ROOT = app.isPackaged
  ? process.resourcesPath
  : app.getAppPath();

function startBackend(): void {
  console.log("RESOURCES_ROOT:", RESOURCES_ROOT, "| packaged:", app.isPackaged);

  const userDataDir = app.getPath("userData");
  fs.mkdirSync(userDataDir, { recursive: true });

  // Every workspace/token/mirror path in the backend is process.cwd()-
  // relative — redirecting cwd here, before requiring the backend at
  // all, is what puts all of that in the OS's real per-user app-data
  // folder instead of wherever this process happened to launch from.
  process.chdir(userDataDir);

  process.env.NODE_ENV = "production";
  process.env.PORT = PORT;
  process.env.FRONTEND_DIST_PATH = path.join(
    RESOURCES_ROOT,
    "frontend",
    "dist",
  );

  // Packaged as resources/backend/dist/server.js with resources/backend/
  // node_modules/ as its sibling (not flattened together) specifically so
  // Node's normal require() resolution — walking up from server.js
  // through parent node_modules folders — finds it exactly the way it
  // already does for a plain `node backend/dist/server.js` run.
  require(path.join(RESOURCES_ROOT, "backend", "dist", "server.js"));
}

// Confirms /api/health answers AND that whatever answered is actually the
// instance we expect on this port — not just anything. A leftover dev-mode
// instance and a real packaged/production instance answer this exact same
// route identically except for `mode`, so a bare "did something respond"
// check can't tell them apart; expectedMode says which one we're actually
// waiting for.
function waitForServer(
  url: string,
  timeoutMs: number,
  expectedMode: "production" | "development",
): Promise<void> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      http
        .get(url, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (body.mode === expectedMode) {
                resolve();
                return;
              }
              reject(
                new Error(
                  `Something else is already answering at ${url} (responded ` +
                    `with mode="${body.mode}", expected "${expectedMode}"). ` +
                    `Close whatever that is and try again.`,
                ),
              );
            } catch (err) {
              reject(
                new Error(
                  `${url} is already in use by something that isn't this ` +
                    `app (its /api/health response wasn't valid JSON).`,
                ),
              );
            }
          });
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Server did not respond at ${url} in time`));
            return;
          }
          setTimeout(attempt, 200);
        });
    }
    attempt();
  });
}

// Same retry-until-ready shape as waitForServer above, but for the Vite
// dev server — it doesn't serve JSON (or /api/health at all), just plain
// HTML, so this only checks that *something* answers, not what.
function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      http
        .get(url, (res) => {
          res.resume(); // drain the response so the socket can close
          resolve();
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Server did not respond at ${url} in time`));
            return;
          }
          setTimeout(attempt, 200);
        });
    }
    attempt();
  });
}

const ICON_PATH = path.join(RESOURCES_ROOT, "electron", "icon.ico");

const PRELOAD_PATH = path.join(__dirname, "preload.js");

async function createWindow(targetUrl: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Ethos Manual Editor",
    icon: ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_PATH,
    },
  });

  win.setMenuBarVisibility(false);

  // Every target="_blank" link in the app (PR links, the GitHub App
  // install link) hits this — without it, Electron's default behavior
  // opens a second bare BrowserWindow inside the app itself rather than
  // the user's actual system browser, which is especially broken for a
  // GitHub login/install page that expects a real, cookie-persistent
  // browser session.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Backs preload.ts's window.electronAPI.focusWindow() — see that file's
  // header comment for why the renderer's own window.focus() call isn't
  // reliable enough on its own.
  ipcMain.handle("focus-window", () => {
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
    win.webContents.focus();
  });

  if (isDev) {
    // Vite's own hot-reload client needs real DevTools open to be useful,
    // and a dev window with no visible way to inspect a failed fetch/render
    // is a worse loop than just always showing it.
    win.webContents.openDevTools({ mode: "right" });
  }

  await win.loadURL(targetUrl);
}

app.whenReady().then(async () => {
  try {
    if (isDev) {
      // Backend and frontend are already running as their own separate
      // processes (see root package.json's `dev` script) — nothing to
      // start here, just wait for both before opening a window pointed
      // at the Vite dev server itself (not this app's own PORT, which
      // dev mode never listens on).
      await waitForServer(DEV_BACKEND_HEALTH_URL, 15000, "development");
      await waitForHttp(DEV_FRONTEND_URL, 15000);
      await createWindow(DEV_FRONTEND_URL);
    } else {
      startBackend();
      await waitForServer(`http://localhost:${PORT}/api/health`, 15000, "production");
      await createWindow(`http://localhost:${PORT}/`);
    }
  } catch (err) {
    console.error("Startup failed:", err);
    dialog.showErrorBox(
      "Ethos Manual Editor failed to start",
      String(err),
    );
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(isDev ? DEV_FRONTEND_URL : `http://localhost:${PORT}/`);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
