# Ethos Manual Editor

A desktop app for translators working on
[ethos-manual-rework](https://github.com/robthomson/ethos-manual-rework):
sign in with GitHub, pick a page, edit your language's version next to the
English source (as rendered rich text, or raw markdown, or a live preview),
and submit the result as a pull request — no local git checkout or markdown
editor of your own required.

Electron + React/TypeScript + Express. Replaces the previous Python/tkinter
version of this tool.

**Status: working end to end**, verified against the real, live repo — sign-in,
branch/language/page browsing, local editing (autosaving, no explicit "create
a workspace" step needed), and committing + opening a pull request are all
wired up. See `DEV_NOTES.md` for the full architecture writeup and what's not
built yet (a diff-vs-English view, spellcheck, and rich-mode support for
admonitions/tabs are the main gaps).

## Signing in

Sign-in uses GitHub's OAuth **device flow** — click "Sign in with GitHub" in
the app, then enter the shown code at the `github.com` link it opens. No
token to create or paste in yourself.

Browsing and editing don't need sign-in at all (everything lives in a local
workspace on disk until you submit) — it's only needed once you click
"Submit for review", since that's the one action that actually talks to
GitHub with write access.

The first time you submit, GitHub may ask you to **install the app** on your
account — a separate step from signing in, needed once per account. The app
tells you directly (a link in the top bar) if this hasn't happened yet.

## Download

Binaries are published on GitHub Releases when a `release/*` tag is pushed:

```
https://github.com/robthomson/ethos-manual-rework-editor/releases
```

Asset names:
- Windows: `Ethos Manual Editor Setup <version>-x64.exe`
- macOS (Intel): `Ethos Manual Editor-<version>.dmg`
- macOS (Apple Silicon): `Ethos Manual Editor-<version>-arm64.dmg`
- Linux: `Ethos Manual Editor-<version>-<arch>.AppImage` and
  `Ethos Manual Editor-<version>-<arch>.tar.gz` (`x64` or `arm64`)

None of these are code-signed yet, so Windows SmartScreen / macOS Gatekeeper
will warn on first launch ("keep anyway" / "open anyway").

Every push to `main` and every PR also builds (but doesn't release) the same
binaries for all platforms, uploaded as workflow run artifacts — see the
Actions tab.

## Developer setup

Requires Node.js (LTS) and `make` (Windows: Git Bash/MSYS2 or WSL — see the
Makefile's own header comment if `make` itself has trouble finding `npm`).

```bash
make init   # npm install at root + backend/ + frontend/
make dev    # boots backend (Express) + Vite + a real Electron window together
```

`make help` lists every other target (`build`, `dist`, `clean`, `distclean`,
running just the backend or frontend on their own, etc.).

You'll also need a `backend/.env` with a registered GitHub App's device-flow
client ID for sign-in to work locally:

```
GITHUB_CLIENT_ID=<your app's client id>
GITHUB_APP_INSTALL_URL=https://github.com/apps/<your-app-slug>/installations/new
```

The App needs Device Flow enabled and Contents (read/write) + Pull requests
(read/write) permissions — Metadata (read) gets added automatically. See
`DEV_NOTES.md` for the exact registration steps.

### Building a standalone executable

`npm run dist` (or `make dist`) — packages the current platform's build via
`electron-builder`, output in `release/`. This is the same command every CI
workflow runs; there's no separate manual packaging step to keep in sync.

## Releasing

- `release/<version>` tag → a real GitHub Release, built for Windows (x64),
  macOS (Intel/Apple Silicon), and Linux (x64/arm64), notes pulled from
  `Releases.md`.
- Add a matching `## <version>` section to `Releases.md` before tagging —
  `.github/scripts/extract-release-notes.py` pulls that section verbatim
  into the release notes.
