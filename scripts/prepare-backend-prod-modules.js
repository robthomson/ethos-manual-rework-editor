/* scripts/prepare-backend-prod-modules.js
 *
 * Description of responsibility:
 *   Creates backend/node_modules.prod/ -- a genuinely separate,
 *   production-only install of backend's dependencies (via a real
 *   `npm ci --omit=dev`) -- so electron-builder's extraResources can
 *   bundle *that* into the packaged app instead of the developer's own
 *   backend/node_modules, which needs devDependencies (typescript,
 *   ts-node-dev, and their own substantial transitive trees) for
 *   `npm run dev`/`build:backend` and shouldn't be pruned in place.
 *
 * Info:
 *   Confirmed live, on a real hung GitHub Actions Windows runner (via an
 *   interactive tmate debug session -- see DEV_NOTES.md's "Windows CI
 *   hang" writeup): backend/node_modules contributed 1933 of the
 *   packaged app's 2038 total files, and per-file I/O overhead on that
 *   runner's storage -- not compression level, not Windows Defender,
 *   both ruled out live with direct evidence -- was the actual
 *   bottleneck behind the packaging step timing out.
 *
 *   A first attempt used an extraResources `filter` glob list (exclude
 *   just the top-level typescript/ts-node-dev/@types folders) -- only
 *   cut ~330 files (17%), because ts-node-dev's own transitive-only
 *   dependencies (ts-node, resolve, @jridgewell/*, diff, source-map,
 *   dynamic-dedupe, etc. -- 100+ files on their own) sit as separate
 *   top-level packages in npm's flat node_modules layout, which a
 *   narrow, hand-maintained filter list kept missing. A real
 *   `npm ci --omit=dev` sidesteps that guesswork entirely -- npm's own
 *   dependency resolver already knows exactly which packages (direct or
 *   transitive) only exist to satisfy a devDependency.
 *
 *   Copies backend/package.json + package-lock.json into the staging
 *   dir first (rather than running `npm ci` with --prefix against
 *   backend/'s own package.json in place) specifically so this never
 *   touches or depends on the developer's own backend/node_modules --
 *   npm ci --omit=dev always installs into ./node_modules relative to
 *   where package.json lives, so a physically separate directory is
 *   what keeps the two installs from interfering with each other.
 *
 *   Uses execFileSync with shell:true only on win32 -- npm resolves to
 *   npm.cmd there, which needs a shell to invoke; POSIX runners (all
 *   three CI platforms' own build steps) don't need or want that.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const backendDir = path.join(__dirname, "..", "backend");
const stagingDir = path.join(backendDir, "node_modules.prod");

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

fs.copyFileSync(path.join(backendDir, "package.json"), path.join(stagingDir, "package.json"));
fs.copyFileSync(path.join(backendDir, "package-lock.json"), path.join(stagingDir, "package-lock.json"));

execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: stagingDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

console.log(`prepare-backend-prod-modules: wrote production-only backend deps to ${stagingDir}`);
