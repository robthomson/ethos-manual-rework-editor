# Dev notes — Electron rewrite

Working notes for the in-progress rewrite of this app (Python/tkinter →
Electron + React/TypeScript + Express), pulling architecture ideas from
`rotorflight-docEditor` (a sibling project). This file is the map back to
"why is it built this way" — update it as things change; don't let it rot.

## Where things stand (as of this branch)

**Working end-to-end, verified against the real, live `ethos-manual-rework`
repo:**
- Sign-in via GitHub OAuth device flow (a registered GitHub App —
  `ethos-manual-editor`, App ID 4686312, owned by `@robthomson`; Client ID
  in `backend/.env`, gitignored, not committed).
- Anonymous-capable nav browsing: branches, locales, the nav tree annotated
  with translated/missing status, per-page English + translation +
  staleness (`translated_from:` vs. the English page's current commit SHA).
- Local workspace editing, no sign-in required for this part (see
  `backend/workspaceStore.ts`'s header comment for why): create a
  workspace (branch + locale), open a page (lazily materialized from
  GitHub on first open, then pure local disk I/O), edit with autosave,
  see a real added/modified change list.
- **New page creation** (English-only — see below): writes the page file
  under `docs/en/` and inserts the nav entry into a local working copy of
  `mkdocs.yml`. Both tracked in the workspace's change list. Verified
  against the real repo's actual nav structure.
- `make dev` boots backend + Vite + a real Electron window together
  (originally didn't — docEditor's own `dev` script doesn't either; you're
  expected to open a plain browser tab. Fixed here since a desktop app
  that never shows its own window during dev is a bad loop).

**Not built yet:**
- The actual commit/PR submission flow (`gitRoutes.ts`/`ensureFork.ts` —
  fork creation, real-merge-from-upstream, commit, open PR). This needs
  the GitHub App to be *installed* on the account submitting, not just
  registered — that's a separate step (Install App button on the app's
  settings page).
- Spellcheck-in-editor.
- Structural insert helpers (admonitions/tables/tabs — pymdownx syntax:
  `!!! note "Title"`, `=== "Tab"`, not Docusaurus's `:::`/JSX).
- The diff-vs-English view.
- Live rendered preview (in progress as of this commit — see below).
- Image upload/insertion (in progress as of this commit — see below).

## Key architecture decisions (and why)

Full reasoning lives in the approved plan
(`C:\Users\RobThomson\.claude\plans\piped-questing-rabbit.md` at time of
writing — copy it into this repo if that path won't be reachable later).
Short version:

1. **Stack**: Electron + React/TS, `electron/` + `backend/` (Express) +
   `frontend/` (Vite/React), mirroring docEditor's shape. `src/` (the
   Python app) is untouched and still works — retire it only once this
   reaches parity.
2. **Auth**: GitHub OAuth device flow via a registered GitHub App, with
   per-user forks (not today's pasted-PAT direct-write model). Chosen
   over keeping the simpler PAT model because [context from that
   conversation: the user wanted the nicer login UX and was willing to
   register a GitHub App].
3. **Local workspace editing, not stateless single-page Data-API calls**:
   a workspace = one branch + one locale. Pages materialize *lazily* (only
   what's actually opened gets fetched from GitHub, once), **not** a full
   `git clone` — see "Why not a real git checkout?" below, that question
   came up directly and here's the answer that was given.
4. **Preview engine**: a custom remark/rehype pipeline for pymdownx's real
   syntax (`ethos-manual-rework` is mkdocs + pymdownx, not
   MDX/Docusaurus like docEditor's own target repo) — chosen over reusing
   Python-Markdown via a bundled subprocess, to keep this a pure Node/
   Electron app with no Python runtime dependency. **This is the piece
   this commit starts building** (see below).
5. **New-page creation is English-only.** Every other locale only ever
   translates pages that already exist in the nav (which is itself always
   English-derived structure) — never invents its own. Enforced both in
   the UI (the "+ New Page" action only appears in an English workspace)
   and server-side in `workspaceStore.ts:createNewPage()` (so it can't be
   reached any other way even if a future caller forgets the check).

### Why not a real `git clone`? (came up directly, worth keeping the answer)

Two real reasons, from the original Python tool's own stated rationale:
1. **No git dependency** — today's approach (GitHub REST API, no clone)
   needs nothing installed beyond the app itself. A real checkout means
   either shelling out to system `git` (translators need git installed)
   or bundling an embeddable git library (isomorphic-git) — real
   complexity either way.
2. **Per-locale image bloat** — `docs/` holds every locale's own
   screenshots; a plain clone pulls all of them. Avoiding that needs a
   *sparse* + *shallow* clone (git 2.25+ cone-mode sparse-checkout,
   partial clone) — doable, meaningfully more engineering than a plain
   clone.

Decided **not** to build this: the two real rate-limit hits during dev
weren't from browsing being inherently too chatty (`fetchMkdocsConfig`/
`fetchRepoTree` are cached — see `backend/githubCache.ts` — and edited
pages are already local after first open). Most of the damage was
**restarting the dev server repeatedly during testing**, which wipes the
in-memory cache each time. Signing in raises the limit from 60→5000/hour,
which comfortably covers a single translator's real usage regardless of
caching. Revisit a real (sparse) checkout only if offline editing is
ever a real requirement — that's the one thing sign-in doesn't buy you.

## Known trade-offs / rough edges to revisit

- **`mkdocs.yml` round-trip fidelity.** `createNewPage()` parses the whole
  file as YAML (`js-yaml`) and re-dumps it to insert one nav entry —
  correct content, but reformats the *entire* file (verified: quoting
  style changes) rather than a clean one-line diff. A real PR built from
  this will show much more churn in `mkdocs.yml` than the actual change.
  Fix would be a line-based/text-surgery insertion instead of parse+dump —
  meaningfully more engineering, deliberately deferred.
- **GitHub rate limit**: signing in fixes this for real usage (5000/hour),
  but a *dev loop* that restarts the backend often will still burn through
  the anonymous 60/hour fast if testing while signed out. Sign in during
  dev testing.
- **No offline support.** Every unmaterialized page/section list still
  needs a live GitHub call the first time. Fine for the target use case
  (a translator with a normal internet connection); would need the
  sparse-checkout approach above if that ever changes.

## Setup (for a fresh clone / new machine)

1. `backend/.env` (gitignored — copy from `.env.example` and fill in):
   - `GITHUB_CLIENT_ID` — from the registered GitHub App
     (`ethos-manual-editor`, https://github.com/settings/apps/ethos-manual-editor).
   - `GITHUB_APP_INSTALL_URL` — `https://github.com/apps/ethos-manual-editor/installations/new`.
   - Device Flow must be explicitly enabled on the App's settings page
     (a separate checkbox from everything else — easy to miss; GitHub
     returns a clear `device_flow_disabled` error if it's off).
2. `make init` (or `npm install` at root + `backend/` + `frontend/`).
3. `make dev` — boots backend (ts-node-dev), Vite, and a real Electron
   window together.
4. Sign in via the button in the app; **also click "Install App"** on the
   GitHub App's settings page for whichever account will be tested with —
   separate step from registering the App, needed before any commit/PR
   flow (not yet built) will work.

## Open questions for next session

- **"WYSIWYG editor"** was asked for again after already being scoped
  *out* in favor of source + live-preview (an actual contentEditable
  rich-text editor is a much bigger, riskier build, and neither this app
  nor docEditor has one). Proceeding on the assumption that "live
  rendered preview" (already in the plan, just not built yet) is what's
  wanted — **confirm this**, since true click-to-format rich text editing
  is a materially different, larger undertaking if that's actually the
  ask.
- Image upload/selection: building the paste/drag/browse upload flow
  (matching docEditor's `AddImageModal.tsx` pattern) plus inserting a
  reference into the edited markdown at the cursor. Scope for this pass:
  upload into the workspace's local `img/` folder next to the page being
  edited; committing new images upstream is still blocked on the
  commit/PR flow not being built yet (same as page text).
- "Create new page" was flagged as a want, but it already exists
  (English-only, see above) — worth confirming this actually is what was
  wanted, or if something more is expected of it (e.g. available for
  every locale, which would contradict the "translations always follow
  English" decision above — flag if that's actually wanted).
