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
  never itself a "change").
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
  instance: renders correctly *and* round-trips back to valid markdown
  (one confirmed cosmetic-only difference: bullets round-trip as `*`
  regardless of source style — see "Known trade-offs" below). **Safety-
  gated**: pages containing pymdownx blocks (admonitions/details/tabs)
  stay in Source mode — see "pymdownx blocks in Rich mode" below for why
  this isn't just a missing feature but an active data-loss risk if
  skipped. Each editing pane is now a three-way Rich/Source/Preview
  toggle, defaulting to Rich when it's safe to.
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

**Not built yet:**
- The actual commit/PR submission flow (`gitRoutes.ts`/`ensureFork.ts` —
  fork creation, real-merge-from-upstream, commit, open PR). This needs
  the GitHub App to be *installed* on the account submitting, not just
  registered — that's a separate step (Install App button on the app's
  settings page).
- **Custom nodes for pymdownx blocks in Rich mode** (admonitions/details/
  tabs) — see the dedicated section below; the approach is researched and
  written up, not yet implemented.
- Spellcheck-in-editor.
- Structural insert helpers as UI (a toolbar to insert an admonition/
  table/tab without hand-typing syntax) — Rich mode's own native
  formatting controls (once a toolbar/slash-menu is added — Milkdown
  supports both, neither wired up yet) may end up subsuming most of the
  original need for this in the Source-mode workflow.
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
   `frontend/` (Vite/React), mirroring docEditor's shape. `src/` (the
   Python app) is untouched and still works — retire it only once this
   reaches parity.
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
- **WYSIWYG bullet-marker style.** Round-tripping a bullet list through
  Rich mode always emits `*` markers, regardless of whether the source
  used `-` — confirmed via direct testing. Cosmetic only (both are valid
  CommonMark), but will show as a no-op diff line in a real PR if a
  translator's edit touches an existing bulleted list. Likely fixable via
  a remark-stringify option Milkdown exposes; not yet investigated.
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
   separate step from registering the App, needed before any commit/PR
   flow (not yet built) will work.

## Open questions for next session

- **Try the image-upload modal for real** (browse/drag/paste) — the one
  piece of this session's work that couldn't be machine-verified.
- **Build custom-node support for pymdownx blocks in Rich mode** — the
  approach is fully researched (see the dedicated section above); this
  is the natural next step to make Rich mode available on the
  (admonition-heavy) pages currently gated to Source.
- Structural insert helpers / a Rich-mode toolbar or slash-menu — neither
  built yet; worth deciding whether Milkdown's own native ones (once
  wired up) cover what was originally wanted here, or whether the
  Source-mode pymdownx-specific insert helpers from the original plan
  are still separately wanted.
- The diff-vs-English view, spellcheck, and the actual commit/PR flow
  remain unbuilt — see "Not built yet" above.
