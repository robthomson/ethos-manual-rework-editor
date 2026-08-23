# Dev notes — Electron rewrite

Working notes for the in-progress rewrite of this app (Python/tkinter →
Electron + React/TypeScript + Express), pulling architecture ideas from
`rotorflight-docEditor` (a sibling project). This file is the map back to
"why is it built this way" — update it as things change; don't let it rot.

## Where things stand (as of this branch)

**The old Python/tkinter app (`src/`) is gone.** Told directly it's "no
longer relevant" (after the CI switch-over above already stopped
building it) — deleted the whole directory, its own `.gitignore`
(PyInstaller/Python-cache patterns), and the root `.gitignore`'s
`ethos-manual-translator.exe` entry (added `backend/dist/`, missing from
that file the whole time — a real, harmless gap, now closed). `README.md`
is fully rewritten to describe *this* app (OAuth device-flow sign-in, no
pasted token; real download/build/release instructions matching the
CI workflows above) instead of the old PAT-paste-in Python one.
`Releases.md` and the Makefile never referenced the old app by name, so
neither needed changes.

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
- **Access-token refresh** (`authRoutes.ts:getUsableToken()`/
  `refreshStoredToken()`): this GitHub App expires user access tokens
  after ~8h (the default for new Apps). Caught live — the topbar
  correctly showed "Sign in with GitHub" hours after a real login, which
  turned out to be genuinely-expired-with-no-recovery-path, not a display
  bug (verified the display logic itself is correct via a live DOM check
  over the Chrome DevTools Protocol — screenshotting the Electron window
  via `PrintWindow` intermittently blanks GPU-composited regions and sent
  an earlier pass down the wrong path; CDP's `Runtime.evaluate` is the
  reliable way to inspect this app's actual rendered state). Every stored
  token now also keeps the `refresh_token` GitHub issues alongside it;
  when an access token has expired, `getUsableToken()` silently exchanges
  it for a new one (GitHub rotates the refresh_token on every use, so the
  stored record is always overwritten as a pair) before any route acts as
  though the user is signed out. Only a genuinely dead refresh_token (past
  its own ~6-month expiry, or rejected by GitHub) actually forces a fresh
  device-flow login. `getTokenForUser()` (and both routes'
  `tokenForRequest()` wrappers) became async as part of this, since a
  refresh is a real network call.
- Anonymous-capable nav browsing: branches, locales, the nav tree annotated
  with translated/missing status, per-page English + translation +
  staleness (`translated_from:` vs. the English page's current commit SHA).
  Structural GitHub lookups (mkdocs.yml, the repo tree, branch list,
  commit SHAs) are cached (`backend/githubCache.ts`, 5 min TTL) — without
  this, clicking around re-hit GitHub's live API on every click.
- **Editing turns on automatically** (`useWorkspace.ts:ensureDefaultWorkspace()`):
  picking a branch+locale transparently creates-or-reuses a
  deterministically-named default workspace for that pair — no separate
  "create a workspace first" step to discover. (Originally required
  explicit creation; that wasn't discoverable enough — the read-only
  browsing view gave no visible clue why typing didn't work.) The named-
  workspace picker still exists for anyone who wants extra parallel
  sessions (e.g. "fr-batch-2"). Pages materialize lazily (fetched from
  GitHub once, then pure local disk I/O), autosave, and a real
  added/modified change list (diffed against a per-page `.baseline/`
  snapshot, not mere file existence, so opening a page you never edit is
  never itself a "change"). Each entry in that list is clickable
  (`WorkspaceBar.tsx`), same as a nav-tree row — resolves the change's
  bare mdPath back to its real nav title in `App.tsx`
  (`findTitleByPath()`) rather than showing/opening it by raw file path,
  and cross-highlights with the nav tree so a change opened from here
  reads as selected in both places.
- **New page creation** (English-only): writes the page file under
  `docs/en/` and inserts the nav entry into a local working copy of
  `mkdocs.yml`. Both tracked in the workspace's change list.
- **New section creation** (English-only, `createNewSection()` in
  `workspaceStore.ts`): adds a brand-new top-level nav category — its
  own landing page at `docs/en/<slug>/index.md`, no children yet.
  Confirmed against the real `mkdocs.yml` that every existing top-level
  entry is exactly this shape (label → landing `index.md` → child
  pages), so a section is scoped to that same pattern rather than
  inventing a new nav shape. Shares the working-copy-of-`mkdocs.yml`
  load/save helpers with `createNewPage()` (`loadWorkingMkdocsConfig()`/
  `saveWorkingMkdocsConfig()`, factored out of what was previously
  `createNewPage()`-only code) rather than duplicating that read/dump
  logic a second time. Guards against both a duplicate section title and
  a duplicate folder slug (two different titles slugifying to the same
  folder would otherwise silently collide). `NewSectionModal.tsx`
  (sibling to `NewPageModal.tsx`, no section-picker needed since a new
  section has nowhere existing to be placed under) + a "+ New Section"
  button next to "+ New Page" in the sidebar.
- **Live rendered preview** (`frontend/src/preview/`): a real remark/
  rehype pipeline for `ethos-manual-rework`'s actual pymdownx syntax
  (`!!!`/`???`/`???+` admonitions & details, `=== "Tab"` tabbed content),
  GFM tables, attr_list-noise stripping, heading anchors.
- **Real contentEditable WYSIWYG** (`frontend/src/wysiwyg/WysiwygEditor.tsx`
  — Milkdown, chosen over TipTap for being markdown-native/round-trip-
  first rather than HTML-first): type directly into formatted text for
  headings, bold/italic, lists, links, images, code, GFM tables — no
  visible markdown syntax. Verified end-to-end against a real running
  instance: renders correctly *and* round-trips back to valid markdown.
  **Safety-gated**: pages containing pymdownx blocks (admonitions/details/tabs)
  stay in Source mode — see "pymdownx blocks in Rich mode" below for why
  this isn't just a missing feature but an active data-loss risk if
  skipped. Each editing pane is now a three-way Rich/Source/Preview
  toggle, defaulting to Rich when it's safe to.
- **Formatting toolbar in Rich mode** (Bold/Italic/Link/Image): each
  button calls the relevant `@milkdown/preset-commonmark` command from
  outside the ProseMirror view via `editor.action(callCommand(command.key,
  payload))` — the documented pattern for driving Milkdown from ordinary
  React UI rather than a keymap. Every button `preventDefault()`s on
  mousedown (not click), or the browser would shift focus to the button
  before the click handler runs and collapse whatever selection the
  command needs to act on. Link opens a small inline URL field in the
  toolbar itself rather than a floating popover — simpler, no selection-
  relative positioning to get right. Image reuses `AddImageModal.tsx`
  (the same upload/list-existing flow Source mode's own "Insert image"
  button already uses) but inserts via `insertImageCommand` at the live
  ProseMirror selection instead of splicing the plain-text textarea
  value. No "justify"/text-align button — CommonMark (and this repo's
  own pymdownx extension list) has no text-alignment concept at all, so
  there'd be nothing meaningful for it to write into the saved markdown.
  Verified end-to-end against a real running instance (Chrome DevTools
  Protocol driving real selections + clicks, not just a type-check):
  Bold/Italic/Link all round-tripped to exactly correct markdown
  (`**Emergency**`, `*watchdog*`, `[SD card failure](https://…)`).
  **Moved out of the box** shortly after: rendering the toolbar *inside*
  `WysiwygEditor.tsx` (above `<Milkdown/>`, inside the bordered/scrollable
  box) added an extra row there that the English reference pane didn't
  have, pushing that side's content start lower — caught live from a
  screenshot showing the two panes' text starting at visibly different
  heights. `WysiwygEditorHandle` (an imperative ref: `toggleBold`/
  `toggleItalic`/`applyLink`/`insertImage`) is what `WysiwygEditor.tsx`
  exposes now instead of rendering its own buttons — `EditablePageView.tsx`
  owns the actual toolbar, placed in the *shared* `page-view-pane-label`
  row (the same one the Rich/Source/Preview toggle and English's own
  Source/Preview toggle already live in), so every mode keeps exactly one
  header row regardless of which controls it needs. That row also picked
  up `min-height: 3rem` (shared by both panes) after a second live check
  at a narrower pane width showed the *same* misalignment creeping back
  in — Rich mode's 7-button controls group wraps onto a second line
  there while English's plain 2-button toggle never does, so without a
  shared reserved height the two rows end up different heights again
  regardless of the restructuring. Image insertion is unified across
  Source/Rich too: Source mode still captures the textarea's cursor
  position before the modal opens (loses it otherwise, since opening the
  modal moves focus away), but Rich mode doesn't need that at all —
  ProseMirror keeps its own selection independent of DOM focus, so
  `insertImage()` just inserts at wherever the live selection still is.
- **Hard-wrapped paragraphs rendered with huge gaps in Rich mode**
  (fixed): this repo's markdown source hard-wraps prose at ~80 columns
  (real physical line breaks *within* a paragraph, not blank-line
  separated) — a CommonMark "soft break", supposed to render as an
  ordinary single space. Preview mode already did that correctly; Rich
  mode showed a visibly padded gap at every wrap point instead. Root
  cause, confirmed live via Chrome DevTools Protocol (`Runtime.evaluate`
  on the actual running app — far more reliable here than a screenshot;
  `PrintWindow` intermittently blanks GPU-composited regions of an
  Electron window, which cost some time on an unrelated investigation
  earlier): ProseMirror's document model can't put a literal newline
  inside a text node, so Milkdown represents each of these soft breaks as
  its own inline node, rendered as `<span data-type="hardbreak"
  contenteditable="false"> </span>`. `App.css`'s own
  `.wysiwyg-scroll [contenteditable] { padding: 0.75rem 1rem; ... }` used
  a *bare* attribute selector, which matches `contenteditable`'s mere
  presence — true **or** false — so that padding was landing on every
  one of these inner false-marker spans too, turning an ordinary single
  space into a visibly padded 32px gap. Fixed by scoping every such
  selector to `[contenteditable="true"]`, which only ever matches the
  one real editable root.
- **English reference pane has its own Source/Preview toggle**
  (`EnglishModeToggle` in `EditablePageView.tsx`) — this editing view
  never had one at all before, unlike `PageView.tsx`'s read-only
  browsing view, which already toggles both its panes independently.
  Always `locale="en"` for its own `MarkdownPreview` call regardless of
  which locale is actually being translated, matching `PageView.tsx`'s
  own English-preview call.
- **Discard changes** (`discardChange()` in `workspaceStore.ts`, `POST
  /api/workspace/:name/discard`) — asked directly: "what if we want to
  cancel changes to the page?". Undoes one pending change (whatever
  `scanChanges()` would report for that exact path), not the whole
  workspace. Three cases, keyed off what's actually on disk rather than
  the change's own "added"/"modified" label (which calls an untranslated
  page's *first* translation "added" too, same as a genuinely new page —
  see `scanChanges()`'s own comment — but those need different discard
  behavior):
  1. An uploaded image (no baseline concept at all): delete the file.
  2. A real per-page baseline exists (a prior real translation, or the
     English-fallback text a first translation started from): overwrite
     the working copy with it.
  3. No baseline: a page or section created *this session*
     (`createNewPage()`/`createNewSection()` deliberately skip writing
     one) — delete the file and remove its nav entry from the local
     `mkdocs.yml` (`removeNavEntry()`, the reverse of those two
     functions' own insertion). Known scope cut: discarding a *section*
     that already has child pages added under it removes the whole
     section from the nav at once, without cascading to also discard
     each child — their own working files are left on disk with no nav
     entry pointing at them any more.

  The backend reports which case happened (`{ deleted: boolean }`) so
  the frontend knows what to do next: case 2 just remounts
  `EditablePageView` (via a `reloadNonce` bumped in `App.tsx`) to show
  the reverted content, staying on the same page; cases 1/3 clear the
  selection and refetch the nav toc for real (unlike
  `addLocalPage()`/`addLocalSection()`'s own client-side splice, a
  removal needs the backend's actual current view). Two entry points:
  `EditablePageView.tsx`'s own "Discard changes" button (the currently
  open page) and a per-entry "↺" button in `WorkspaceBar.tsx`'s Changes
  list (any changed page, confirmed first — unlike the workspace-delete
  button next to it, which doesn't, since this can throw away real
  translation work). Verified against the real running app for both
  cases: reverting an edited existing page (content restored, change
  entry gone) and discarding a brand-new section just created (file
  deleted, nav entry gone, kicked back to the "pick a page" placeholder).
- **Renamed to "Ethos Manual Editor"** (from "Ethos Manual Translator")
  across the Electron rewrite's own files — window title, in-app header,
  `package.json`/`backend/package.json` name/description, `appId`/
  `productName`, `frontend/index.html`'s `<title>`. At the time, deliberately
  left `README.md`/`src/` untouched (the old Python app was still shipping
  under that name) — since resolved, see this file's own "old Python app is
  gone" note up top. Caught a real, separate bug while in
  `backend/config/github.ts` for this: `GITHUB_APP_INSTALL_URL`'s
  fallback pointed at `ethos-manual-translator`, a slug that was never
  actually registered — the real App's slug is `ethos-manual-editor` (per
  https://github.com/settings/apps/ethos-manual-editor). Never hit in
  practice so far since the real `.env` already overrides it correctly,
  but fixed the wrong default outright regardless.
- **CI now builds this app, not the old Python one** — told directly the
  old app "is no longer relevant". All three workflows
  (`.github/workflows/{pr,push,release}.yml`) previously only ever built
  the old `src/app.py` via PyInstaller; every PyInstaller step in all
  three is now `npm install` (root + `backend/` + `frontend/`) +
  `npm run dist` (electron-builder), keeping each workflow's own
  existing trigger/purpose (`pr`/`push` build-check artifacts per OS,
  `release/*` tags build **and** create the actual GitHub Release).
  Windows dropped the old job's x86 (32-bit) leg — just x64 now,
  matching normal practice for Electron apps today. No code-signing
  certificates configured, so Windows/macOS output is unsigned
  (SmartScreen/Gatekeeper will warn on first launch) — revisit if/when
  signing certs are available. Version comes from the tag
  (`release/X.Y.Z` → `X.Y.Z`) or a commit-SHA/PR-number placeholder for
  the other two triggers, written into `package.json` via `npm pkg set
  version=...` (not `npm version`, which refuses to run unless the git
  working directory is clean — something `npm install` could easily
  violate via lockfile drift) so electron-builder's own artifact-naming
  templates pick it up. **Verified for real, not just written**: ran
  `npm run dist` locally end-to-end (the exact command every workflow
  now runs) and got a genuine, correctly-named
  `Ethos Manual Editor Setup 0.2.0-x64.exe` (~88MB) out the other end —
  only the Windows leg could be tested this way (no mac/linux hosts
  here), but it's the same `electron-builder` invocation for every OS,
  so this is a real, not just a paper, confirmation the pipeline works.
  `src/` itself (and `README.md`/`Releases.md`, which still describe the
  old app) are untouched for now — ask if those should also go.
  **Follow-up, caught in the first real tag-triggered run**: every
  platform failed at the very last step with `GitHub Personal Access
  Token is not set, neither programmatically, nor using env "GH_TOKEN"`.
  electron-builder auto-detects a `release/*`-shaped tag in CI and
  defaults to trying to *publish the release itself* via its own
  built-in GitHub-publish feature — never configured (no `publish` field
  in `package.json`'s `build` block) and never intended; the actual
  GitHub Release is `release.yml`'s own separate `create-release` job,
  using `gh release create` after downloading every platform's uploaded
  artifact. Local `npm run dist` never hit this because electron-builder
  only auto-publishes when it detects a real CI+tag environment, not a
  plain local run. Fixed by making `dist` always pass
  `--publish never` explicitly, so this can't happen regardless of what
  environment it runs in.
- **CRLF/`.gitattributes`**: cutting the first real release (`git add -A`
  for the version bump) unexpectedly staged ~60 unrelated files, each as
  a 100%-line-diff. Root cause: no `core.autocrlf` was configured anywhere
  (system/global/local all empty), so the working tree had silently
  drifted to CRLF over time with nothing normalizing it back on
  `git add`. Fixed by adding `.gitattributes` (`* text=auto eol=lf`, plus
  explicit `binary` markers for image/font/icon extensions so those never
  get text-normalized) and running `git add --renormalize .` once to
  settle the whole tree onto LF for real.
- **Windows CI hang, 1h24m, zero error output**, while all 4 other
  platforms finished in minutes — confirmed via
  `gh api .../actions/jobs/<id>` that "Build + package (electron-builder)"
  was the stuck step. Added `timeout-minutes: 25` to the `build-app` job
  in all three workflows as a safety net regardless of root cause — but
  a repeat run just hit that same 25-minute wall (`Error: The operation
  was canceled.`) instead of finishing, confirming the hang itself was
  still unfixed, just caught faster. Pulled the full log for that run
  (`gh run view <id> --job <id> --log`, only fetchable once the job
  reaches `completed`) and found it goes dead silent for exactly 24
  minutes, with the last real line being electron-builder's own
  `no signing info identified, signing is skipped` for `elevate.exe`
  (a signtool pass on a freshly-built, unsigned exe) immediately before
  the log stops. First attempt, `signAndEditExecutable: false` in
  `package.json`'s `win` block (a real, documented electron-builder
  option, default `true`) — verified **locally** to be incomplete: it
  does stop signing for the main app exe (confirmed zero signtool calls
  for it), but electron-builder's NSIS target has its own separate,
  ungated signtool call for the *uninstaller* exe
  (`__uninstaller-nsis-*.exe`), and that same local verification build
  then failed outright with `ENOENT: ... unlink '...nsis.7z'` inside
  electron-builder's own `nsisUtil.ts` cleanup step, producing a
  194KB stub instead of a real ~88MB installer. That failure signature —
  dead stop / vanished file right after a signtool pass on a fresh
  unsigned exe — is the known pattern for Windows Defender's real-time
  scanner grabbing or quarantining the file, not a bug in this project's
  config (a documented issue for Electron+NSIS builds on Windows CI
  runners generally). First attempt: `Set-MpPreference
  -DisableRealtimeMonitoring $true` as a Windows-only step before the
  build step. **Re-verified in CI (retagged `release/0.2.0`) — still
  hung**, cancelled again at the 25-minute wall, but at a *different*
  point this time (right after downloading the NSIS packaging tool
  itself, before signtool ever ran) — same class of AV interference,
  just unlucky timing. The step itself ran with no error, which was the
  giveaway: GitHub's hosted Windows runners have Defender **Tamper
  Protection** on, which silently no-ops `-DisableRealtimeMonitoring`
  entirely (their own runner-images docs say Defender can't be disabled
  on hosted runners, only excluded from). Switched to
  `Add-MpPreference -ExclusionPath`/`-ExclusionProcess` instead —
  exclusions *are* honored under Tamper Protection — covering the repo
  workspace, electron-builder's cache dir, and the temp dir, plus
  process exclusions for `electron-builder.exe`/`makensis.exe`/
  `signtool.exe`. Kept `signAndEditExecutable: false` too (still a real,
  if partial, reduction in signtool calls). **Not yet re-verified in
  CI** — needs another retagged run to confirm the Windows leg actually
  completes now.
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
  a local serving route instead of a GitHub URL. This resolution logic
  (`frontend/src/preview/imageResolver.ts`) is shared between Preview and
  Rich mode — Rich mode originally had no equivalent of it at all (caught
  live: every image showed broken in Rich mode while Preview worked fine,
  since Milkdown's default image node just uses the literal relative
  `src` from the markdown source). Fixed via `imageSchema.extendSchema()`
  (the documented Milkdown pattern for overriding one property of a
  preset's built-in node) to override *only* the node's `toDOM` — the
  real `attrs.src` that `parseMarkdown`/`toMarkdown` read and write stays
  the original relative reference, so saving is unaffected; only what the
  browser actually renders is swapped for a resolved URL. Verified: image
  displays correctly in Rich mode, and the round-tripped markdown still
  contains the original relative path.
- `make dev` boots backend + Vite + a real Electron window together
  (originally didn't — docEditor's own `dev` script doesn't either; you're
  expected to open a plain browser tab. Fixed here since a desktop app
  that never shows its own window during dev is a bad loop).
- **Commit + PR submission** (`backend/routes/gitRoutes.ts`, `POST
  /api/workspace/:name/submit`) — the one thing that was still local-
  disk-only until now. Adapted from rotorflight-docEditor's own
  gitRoutes.ts (same Git Data API mechanics: fork → ensure/sync branch →
  build a tree diff → commit → open/update PR — "unchanged in shape" per
  the original plan), with the mechanics this project actually needs
  layered on: branch name is the workspace's own name directly (one
  branch/PR per locale-workspace session, matching this app's editing
  model); `workspaceStore.ts:prepareChangeForCommit()` is the one place
  that turns a `scanChanges()` entry into real commit bytes — an English
  page or image committed as-is, a translation gets `translated_from:`
  reattached and bumped to the English page's *current* commit SHA
  (`latestCommitSha()`), matching `submit.py`'s own behavior and the
  actual reason `hooks/i18n_status.py`'s staleness check exists at all.
  PRs are created as drafts, mirroring the old Python app's own "draft
  PRs by default" behavior — no "mark ready for review" action built yet
  (needs a GraphQL mutation, the REST Pulls API can't flip draft→ready;
  GitHub's own "Ready for review" button is the fallback for now).
  **Repo-owner case** (caught live, testing against the real repo):
  `ensureFork()` assumes the signed-in user is a *different* account
  than `GITHUB_OWNER` — GitHub can't fork a repo onto the account that
  already owns it, which 409'd immediately when testing as the repo's
  actual owner. Fixed: when the signed-in login *is* `GITHUB_OWNER`, the
  whole flow skips forking and commits directly to a branch on the real
  repo, using the bare branch name (not `owner:branch`) as the PR's
  `head` — GitHub's Pulls API only wants the owner-qualified form for a
  genuinely cross-repo head. Verified end-to-end against the real repo
  (not just a type-check): submitted a real pending Dutch-translation
  edit, producing
  [PR #3](https://github.com/robthomson/ethos-manual-rework/pull/3) — a
  single-file, correctly-scoped diff with `translated_from:` intact.
- **Rich-mode bullet marker fixed to `-`** (`WysiwygEditor.tsx`) —
  remark-stringify's own default (`*`) rewrote every existing `-` bullet
  in a list the moment any one line in it changed, since Milkdown
  serializes the *whole* list node, not just the touched line. Caught
  live in [PR #3](https://github.com/robthomson/ethos-manual-rework/pull/3)
  itself: a one-word edit produced an 8-line diff of pure bullet-marker
  noise. Fixed via `remarkStringifyOptionsCtx` — a real Milkdown ctx
  slice (confirmed by reading `@milkdown/core`'s own source:
  `init.ts` builds the actual serializer as
  `unified().use(remarkParse).use(remarkStringify, ctx.get(remarkStringifyOptionsCtx))`,
  and preset-commonmark's own emphasis/strong nodes already read
  `.emphasis`/`.strong` off that same slice for their own marker
  choice — not a guess past an undocumented gap). Verified against a
  real running instance: every bullet in a real translated list now
  round-trips as `-`.

**Not built yet:**
- **Custom nodes for pymdownx blocks in Rich mode** (admonitions/details/
  tabs) — see the dedicated section below; the approach is researched and
  written up, not yet implemented.
- Spellcheck-in-editor.
- Structural insert helpers as UI (a toolbar to insert an admonition/
  table/tab without hand-typing syntax) — Rich mode now has a basic
  formatting toolbar (Bold/Italic/Link/Image), but nothing yet for
  admonitions/tables/tabs specifically (those need the custom-node work
  below first, since Rich mode can't represent them at all yet).
- The diff-vs-English view.
- **Not machine-verified**: the actual browse/drag/paste interaction in
  the image-upload modal (upload/list/serve endpoints themselves were
  tested directly against the API).

## pymdownx blocks in Rich mode (researched, not yet built)

Milkdown's default schema has no concept of `!!! type "Title"` admonitions,
`??? .../???+ ...` collapsible details, or `=== "Label"` tabs — and
CommonMark's own "lazy continuation" rule means a page containing one,
edited in a generic rich-text editor with no custom handling, would have
its whole `!!!`/indented-body structure silently flattened into a plain
paragraph the moment it's saved. That's real data loss, not a display
quirk, which is why `containsPymdownxBlocks()` currently gates those pages
to Source mode instead. The research below is the path to lifting that
gate for real, not a rewrite of the approach:

1. **Parsing**: reuse `preprocessPymdownxBlocks()` unchanged (it already
   rewrites `!!!`/`===` blocks into blockquote-form text +
   line-numbered markers, specifically so CommonMark parses nested
   markdown inside them correctly — the same trick the live preview
   already relies on). Register a Milkdown-specific remark plugin (via
   `@milkdown/utils`'s `$remark`) that retags the resulting `blockquote`
   mdast nodes matching those markers — same line-position matching
   `pymdownxBlocks.ts:remarkPymdownxBlocks()` already does for the
   preview, just setting mdast `data` instead of hast `hName`/
   `hProperties`.
2. **Schema**: `$nodeSchema("admonition", ...)` etc. (via
   `@milkdown/utils`) with `type`/`title` as node **attrs** (not child
   nodes), `content: "block+"` for the body, and a `parseMarkdown.match`
   checking for that retagged mdast type.
3. **Serializing back to real pymdownx syntax** — confirmed feasible by
   reading Milkdown's own built-in `blockquote` node
   (`@milkdown/preset-commonmark`'s bundled source): its `toMarkdown`
   runner is just `state.openNode("blockquote").next(node.content).closeNode()`
   — it builds a *real* mdast `blockquote` node and lets
   `remark-stringify`'s own built-in compiler (which already knows how
   to prefix every line with `> `) do the formatting. There's no
   built-in mdast type that does 4-space-indent-the-children the way
   pymdownx needs, so admonitions need one more piece: a custom
   `mdast-util-to-markdown` extension (the same standard mechanism
   `remark-gfm`/`remark-frontmatter` themselves use — register via a
   remark plugin pushing onto the processor's `toMarkdownExtensions`
   data) providing a handler for the custom mdast type, using that
   package's own `indentLines`/`containerFlow` helpers (the same ones
   `blockquote`'s internal handler uses, just with a 4-space `map`
   instead of `> `) to emit `!!! type "Title"\n` + the indented,
   normally-serialized body.
4. **NodeView**: a React component rendering the styled box (title bar +
   editable body), reusing the same CSS classes the live preview already
   has (`.admonition`, `.admonition-title`, etc. — see `App.css`).

Tabs are lower priority than admonitions/details specifically: no
confirmed real usage of `=== "Label"` anywhere in `ethos-manual-rework`
today (admonitions are heavily used — confirmed — details/tabs are not),
so gating them out costs little in practice right now.

## Key architecture decisions (and why)

Full reasoning lives in the approved plan
(`C:\Users\RobThomson\.claude\plans\piped-questing-rabbit.md` at time of
writing — copy it into this repo if that path won't be reachable later).
Short version:

1. **Stack**: Electron + React/TS, `electron/` + `backend/` (Express) +
   `frontend/` (Vite/React), mirroring docEditor's shape. `src/` (the old
   Python app) has since been retired entirely — see this file's own
   "old Python app is gone" note up top.
2. **Auth**: GitHub OAuth device flow via a registered GitHub App, with
   per-user forks (not today's pasted-PAT direct-write model) — chosen
   for the nicer login UX, at the cost of needing the App registered
   (done) and installed per account (separate step, needed once the
   commit/PR flow exists).
3. **Local workspace editing, not stateless single-page Data-API calls**:
   a workspace = one branch + one locale, auto-provisioned (see above).
   Pages materialize *lazily* (only what's actually opened gets fetched
   from GitHub, once), **not** a full `git clone` — see "Why not a real
   git checkout?" below.
4. **Preview engine**: a custom remark/rehype pipeline for pymdownx's real
   syntax (`ethos-manual-rework` is mkdocs + pymdownx, not
   MDX/Docusaurus like docEditor's own target repo) — chosen over reusing
   Python-Markdown via a bundled subprocess, to keep this a pure Node/
   Electron app with no Python runtime dependency. Only the extensions
   actually listed in the real `mkdocs.yml` are implemented (admonition,
   attr_list, pymdownx.details, pymdownx.superfences, pymdownx.tabbed,
   tables, toc:permalink) — verified against the live file, not guessed.
5. **WYSIWYG engine: Milkdown, not TipTap.** Milkdown is markdown-native
   (built on ProseMirror + remark specifically to round-trip to clean
   markdown); TipTap is HTML-first and would need bolt-on serialization
   with more format-fidelity risk for GFM tables/custom syntax. Confirmed
   the right call once custom pymdownx-block parsing turned out to be
   genuinely feasible via Milkdown's own remark-based pipeline (same
   major `unified`/`remark` version this app already uses elsewhere).
6. **New-page creation is English-only.** Every other locale only ever
   translates pages that already exist in the nav (which is itself always
   English-derived structure) — never invents its own. Enforced both in
   the UI (the "+ New Page" action only appears in an English workspace)
   and server-side in `workspaceStore.ts:createNewPage()`.
7. **Images live in one shared `assets/` folder per locale**
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
  style changes) rather than a clean one-line diff. Fix would be a
  line-based/text-surgery insertion instead of parse+dump — meaningfully
  more engineering, deliberately deferred.
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
- **Auto-provisioned workspaces accumulate.** Every (branch, locale) pair
  anyone so much as *looks at* now gets its own persistent local
  workspace (harmless clutter in the WorkspaceBar list — not wasted
  GitHub calls, since page materialization is still lazy), where
  browsing used to leave nothing behind. Not a correctness issue; worth
  a "clean up unused default workspaces" affordance if the list gets
  noisy in practice.
- **Frontend bundle size.** Milkdown/ProseMirror pushed the built JS
  bundle to ~730KB (from ~380KB) — Vite's build warns about it. Not a
  problem for an Electron app (no network fetch of the bundle at
  runtime), but worth a dynamic `import()` code-split for the Rich-mode
  editor specifically if startup time ever becomes a concern.
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
   separate step from registering the App, needed before the commit/PR
   flow will work (not needed at all when testing as the repo's own
   owner — see "Repo-owner case" above, that path skips forking
   entirely).

## Open questions for next session

- **Try the image-upload modal for real** (browse/drag/paste) — the one
  piece of this session's work that couldn't be machine-verified.
- **Build custom-node support for pymdownx blocks in Rich mode** — the
  approach is fully researched (see the dedicated section above); this
  is the natural next step to make Rich mode available on the
  (admonition-heavy) pages currently gated to Source.
- A basic Rich-mode toolbar (Bold/Italic/Link/Image) is now built; still
  worth deciding whether the Source-mode pymdownx-specific insert
  helpers (admonition/table/tab) from the original plan are still wanted
  as their own UI, or should wait for/fold into Rich mode's custom-node
  support above once that exists.
- The diff-vs-English view and spellcheck remain unbuilt — see "Not
  built yet" above. Commit/PR submission is now built and verified
  against the real repo; still worth building "mark ready for review"
  (a GraphQL mutation — see the commit/PR entry above) and a real test
  of the *non-owner* fork path (only the repo-owner-direct path has been
  exercised against the live repo so far, since that's the account
  available to test with).
