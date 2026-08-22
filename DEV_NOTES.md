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
  in `backend/.env`, gitignored, not committed). Sessions live in
  in-memory `MemoryStore` and don't survive a backend restart on their
  own, but `authRoutes.ts`'s `/session` auto-adopts the sole stored token
  on disk when no session exists — right for a single-user desktop
  install (see that file's own comment), so a restart never actually
  forces a fresh device-flow login.
- Anonymous-capable nav browsing: branches, locales, the nav tree annotated
  with translated/missing status, per-page English + translation +
  staleness (`translated_from:` vs. the English page's current commit SHA).
  Structural GitHub lookups (mkdocs.yml, the repo tree, branch list,
  commit SHAs) are cached (`backend/githubCache.ts`, 5 min TTL) — without
  this, clicking around re-hit GitHub's live API on every click.
- Local workspace editing, no sign-in required for this part (see
  `backend/workspaceStore.ts`'s header comment for why): create a
  workspace (branch + locale), open a page (lazily materialized from
  GitHub on first open, then pure local disk I/O), edit with autosave,
  see a real added/modified change list (diffed against a per-page
  `.baseline/` snapshot, not mere file existence, so opening a page you
  never edit is never itself a "change").
- **New page creation** (English-only): writes the page file under
  `docs/en/` and inserts the nav entry into a local working copy of
  `mkdocs.yml`. Both tracked in the workspace's change list.
- **Live rendered preview** (`frontend/src/preview/`): a real remark/
  rehype pipeline for `ethos-manual-rework`'s actual pymdownx syntax
  (`!!!`/`???`/`???+` admonitions & details, `=== "Tab"` tabbed content),
  GFM tables, attr_list-noise stripping, heading anchors. Each pane
  (English/translation/editing) gets an independent Source/Preview
  toggle. This is what "WYSIWYG" pragmatically means here — source +
  real preview, not contentEditable rich text (see "Open questions"
  below, this was asked again and re-confirmed mid-session).
- **Image handling**: relative image `src`s resolve to real
  raw.githubusercontent.com URLs, replicating `mkdocs.yml`'s actual
  `i18n: fallback_to_default: true` config — a locale-specific screenshot
  that doesn't exist falls back to the English one at the same path,
  exactly like the real site's build does (caught live: a translated
  page's screenshots showed as broken images before this was fixed).
  Upload (browse/drag/paste, matching docEditor's `AddImageModal.tsx`
  pattern) goes into the workspace's shared `docs/<locale>/assets/`
  folder (confirmed real convention — NOT a per-page `img/` folder the
  way docEditor assumes) and inserts a reference at the textarea cursor;
  a freshly-uploaded image (nothing committed upstream yet) resolves to
  a local serving route instead of a GitHub URL.
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
- Structural insert helpers as UI (the preview *renders* admonitions/
  tables/tabs correctly now, but there's no toolbar button to insert one
  without hand-typing the pymdownx syntax yet).
- The diff-vs-English view.
- **Not machine-verified**: the actual browse/drag/paste interaction in
  the image-upload modal. Everything behind it (upload/list/serve
  endpoints, byte-identical round trip, change tracking) was tested
  directly against the API; the mouse/file-drop interaction itself needs
  a human — try it and see.

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
   per-user forks (not today's pasted-PAT direct-write model) — chosen
   for the nicer login UX, at the cost of needing the App registered
   (done) and installed per account (separate step, needed once the
   commit/PR flow exists).
3. **Local workspace editing, not stateless single-page Data-API calls**:
   a workspace = one branch + one locale. Pages materialize *lazily* (only
   what's actually opened gets fetched from GitHub, once), **not** a full
   `git clone` — see "Why not a real git checkout?" below.
4. **Preview engine**: a custom remark/rehype pipeline for pymdownx's real
   syntax (`ethos-manual-rework` is mkdocs + pymdownx, not
   MDX/Docusaurus like docEditor's own target repo) — chosen over reusing
   Python-Markdown via a bundled subprocess, to keep this a pure Node/
   Electron app with no Python runtime dependency. Only the extensions
   actually listed in the real `mkdocs.yml` are implemented (admonition,
   attr_list, pymdownx.details, pymdownx.superfences, pymdownx.tabbed,
   tables, toc:permalink) — verified against the live file, not guessed.
5. **New-page creation is English-only.** Every other locale only ever
   translates pages that already exist in the nav (which is itself always
   English-derived structure) — never invents its own. Enforced both in
   the UI (the "+ New Page" action only appears in an English workspace)
   and server-side in `workspaceStore.ts:createNewPage()`.
6. **Images live in one shared `assets/` folder per locale**
   (`docs/<locale>/assets/`), confirmed against real pages (e.g.
   `![Glasses](../assets/model-glasses.png)`) — not docEditor's own
   per-page `img/` folder convention. Upload/insert code follows this
   repo's real layout, not the sibling project's.

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

Decided **not** to build this: the real rate-limit hits during dev
weren't from browsing being inherently too chatty (structural lookups are
cached — see `githubCache.ts` — and edited pages are already local after
first open). Most of the damage was **restarting the dev server
repeatedly during testing**, which used to wipe the in-memory session too
(now fixed — see auto-adopt-sole-token above). Signing in raises the
limit from 60→5000/hour, comfortably covering a single translator's real
usage regardless of caching. Revisit a real (sparse) checkout only if
offline editing is ever a real requirement — that's the one thing
sign-in doesn't buy you.

## Known trade-offs / rough edges to revisit

- **`mkdocs.yml` round-trip fidelity.** `createNewPage()` parses the whole
  file as YAML (`js-yaml`) and re-dumps it to insert one nav entry —
  correct content, but reformats the *entire* file (verified: quoting
  style changes) rather than a clean one-line diff. A real PR built from
  this will show much more churn in `mkdocs.yml` than the actual change.
  Fix would be a line-based/text-surgery insertion instead of parse+dump —
  meaningfully more engineering, deliberately deferred.
- **Preview fidelity, deliberate cuts** (same "behavior over pixel
  parity" spirit as the old `preview.py`):
  - `remark-gfm` also enables strikethrough/autolink/tasklist, which
    aren't actually in `mkdocs.yml`'s extension list — minor overreach,
    those render here but wouldn't on the real site.
  - `pymdownx.superfences`' advanced features (nested/tabbed code
    blocks) aren't attempted; plain fenced code (`` ```lang ``) covers
    the common case.
  - `attr_list` syntax (`{: .class}`) is stripped, not actually applied —
    real semantics need real per-block-type placement rules.
  - A pymdownx block (admonition/details/tabs) nested inside a list item
    works (verified against real content —
    `docs/nl/system-setup/general.md`); a block nested inside *another*
    block does not (no confirmed real usage of that case, unlike the
    list-item one, which an earlier assumption got wrong by checking too
    few files first).
- **Image change-tracking is approximate.** Uploaded images are never
  diffed against a baseline the way page text is (see
  `workspaceStore.ts:uploadImage()`'s own comment) — every image in a
  workspace is unconditionally "added" in the changes list, even a
  re-upload that's actually *replacing* an existing upstream screenshot
  under the same filename (which is really a "modified"). The practical
  effect on what eventually gets committed is the same either way; only
  the changes-list label is imprecise.
- **GitHub rate limit**: signing in fixes this for real usage (5000/hour);
  a *dev loop* that restarts the backend often while signed out can still
  burn through the anonymous 60/hour fast (session auto-restore now
  covers the "signed out because of a restart" case, but doesn't help if
  you were never signed in to begin with).
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

- **Try the image-upload modal for real** (browse/drag/paste) — the one
  piece of this session's work that couldn't be machine-verified; see
  "Not built yet" above.
- **"WYSIWYG editor"** — confirmed mid-session that "live rendered
  preview" (now built) is the right read of this, not actual
  contentEditable rich-text editing. Revisit only if that's genuinely
  still wanted — it's a materially bigger, different undertaking.
- Structural insert helpers (a toolbar to insert an admonition/table/tab
  without hand-typing pymdownx syntax) are still just "the preview
  renders them correctly," not an actual insert UI — worth confirming
  this is still wanted as a next step, per the original plan.
