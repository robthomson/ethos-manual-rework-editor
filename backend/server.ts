/* backend/server.ts
 *
 * Description of responsibility:
 *   The Express app's entry point: wires up CORS, JSON parsing, session
 *   middleware, and mounts every route module before starting the
 *   listener. In production, also serves the frontend's built static
 *   files and falls back to index.html for any non-API route, so the
 *   whole app ships as one process on one port.
 *
 * Info:
 *   Ported from rotorflight-docEditor's backend/server.ts, trimmed to
 *   what this project currently has wired up (auth only, for now —
 *   docsRoutes/gitRoutes land in a later slice) and renamed accordingly.
 *   dotenv.config() runs before any other import specifically so every
 *   subsequently-imported module (config/github.ts in particular) sees
 *   fully-populated process.env values at module-load time, not just
 *   inside request handlers. CORS is locked to a single configured
 *   FRONTEND_ORIGIN with credentials:true — a wildcard origin can't be
 *   combined with cookie-bearing requests, so this is what makes session
 *   auth work at all. In production this ends up being same-origin
 *   anyway (the frontend is served by this same process), so CORS is a
 *   defensive no-op for the app's own traffic and only matters for
 *   FRONTEND_ORIGIN being set correctly, not for the app to work.
 *
 *   If SESSION_SECRET isn't set, a fresh random one is generated at boot
 *   rather than falling back to a fixed literal — this app is packaged
 *   and distributed (see electron/main.ts), so a hardcoded fallback
 *   would mean every single install shares the same cookie-signing
 *   secret. A secret that only lives in memory and changes every restart
 *   is fine here: sessions are also only ever kept in memory
 *   (MemoryStore), so they don't outlive a restart anyway.
 */

// Load env FIRST
import dotenv from "dotenv";
dotenv.config();

// THEN import everything else
import express from "express";
import cors from "cors";
import session from "express-session";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import authRoutes from "./routes/authRoutes";
import navRoutes from "./routes/navRoutes";
import workspaceRoutes from "./routes/workspaceRoutes";

const app = express();
const PORT = process.env.PORT || 4100;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.SESSION_SECRET) {
  console.warn(
    "⚠️  SESSION_SECRET is not set — generated a random one for this run. " +
      "Sessions won't survive a restart. Not needed for a per-user packaged install.",
  );
}

// A wildcard origin can't be combined with credentialed (cookie-bearing)
// requests — CORS must name the real frontend origin for sessions to work.
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json());

// Establishes who's making each request. Every route that touches a user's
// GitHub token or workspace derives identity from req.session.login, never
// from a client-supplied login query param/body field — otherwise anyone
// who knew (or guessed) another user's GitHub username could act as them.
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // Not tied to NODE_ENV — "production" here still means plain
      // http://localhost (as a combined server or via Electron). A
      // `secure` cookie can't be stored or sent over a non-HTTPS
      // connection at all, so setting this from NODE_ENV alone would
      // silently break every request after login.
      secure: false,
      maxAge: 8 * 60 * 60 * 1000, // 8h, matches the device-flow token's own fallback expiry
    },
  }),
);

// This server binds on all interfaces (see app.listen below), not just
// localhost, so anything else on the same network can reach it — a single
// desktop user has no reason to make hundreds of requests a minute, so a
// generous cap here costs normal usage nothing while bounding how hard a
// runaway client can hit the filesystem/GitHub-API-backed routes below.
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Mount GitHub OAuth
app.use("/api/auth", authRoutes);

// Browse ethos-manual-rework's nav/locales/pages — anonymous-capable,
// see navRoutes.ts's header comment.
app.use("/api/nav", navRoutes);

// Local workspace editing — also anonymous-capable, see
// workspaceRoutes.ts/workspaceStore.ts's header comments for why.
app.use("/api/workspace", workspaceRoutes);

// TODO (next slice): gitRoutes (commit/PR via the user's fork) once the
// GitHub App is registered — see the approved plan.

// Health check — includes mode so electron/main.ts's startup health-check
// can tell "our own production instance answered" apart from "something
// else entirely answered on this port".
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", mode: process.env.NODE_ENV || "development" });
});

// Serve the built frontend in production — dev mode keeps using Vite's own
// dev server (localhost:5173) with its /api proxy, unaffected by this.
if (process.env.NODE_ENV === "production") {
  const FRONTEND_DIST =
    process.env.FRONTEND_DIST_PATH ||
    path.join(process.cwd(), "..", "frontend", "dist");

  if (fs.existsSync(path.join(FRONTEND_DIST, "index.html"))) {
    app.use(express.static(FRONTEND_DIST));

    // Any non-API route is a client-side path — hand back index.html and
    // let the frontend itself decide what to render, rather than a 404.
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(FRONTEND_DIST, "index.html"));
    });
  } else {
    console.warn(
      `⚠️  NODE_ENV=production but no frontend build found at ${FRONTEND_DIST} — ` +
        `run "npm run build" in frontend/ first. Serving API routes only.`,
    );
  }
}

// Start server LAST
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
