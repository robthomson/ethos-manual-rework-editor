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
  scanner grabbing or quarantining the file — that was the leading
  theory initially, but turned out to be wrong (see below). First
  attempt: `Set-MpPreference -DisableRealtimeMonitoring $true` as a
  Windows-only step. **Re-verified in CI (retagged `release/0.2.0`) —
  still hung**, cancelled again at the 25-minute wall, at a *different*
  point this time (right after downloading the NSIS packaging tool
  itself, before signtool ever ran). Suspected Defender Tamper
  Protection silently no-op'ing the toggle (GitHub's hosted Windows
  runners can't have Defender disabled, only excluded from, per their
  own runner-images docs) and switched to `Add-MpPreference
  -ExclusionPath`/`-ExclusionProcess` instead — **re-verified again,
  still hung, at the exact same byte-for-byte point as the previous
  attempt** (`downloaded nsis-3.0.4.1.7z`, then dead silence). Two
  different Defender mitigations producing an identical, deterministic
  stall (not the varying timing an AV race would produce) ruled out
  Defender entirely. The actual cause: `windows-latest` had just moved
  to a brand-new Windows Server 2025 image (`win25/...`, confirmed via
  the `actions/runner-images` releases feed) — a fresh-image
  incompatibility with electron-builder's bundled NSIS/7z tooling, not
  antivirus at all. Fixed by pinning the matrix to `windows-2022` (a
  known-stable prior image) in all three workflows instead of chasing
  the new image further; removed both now-disproven Defender steps.
  Kept `signAndEditExecutable: false` (still a real, if unrelated,
  reduction in signtool calls) and the 25-minute timeout (a good safety
  net regardless of root cause). **Re-verified — hung a fourth time, at
  that exact same line**, this time with the log's own
  `os=10.0.20348` confirming the pin genuinely took effect (that build
  number is Server 2022, not the 2025 image) — ruling the runner image
  out too. Four consecutive CI cycles, two OS generations, two Defender
  configurations, one constant: electron-builder's own step of
  extracting/invoking its bundled NSIS packaging tool right after
  downloading it hangs specifically on GitHub-hosted Windows runners —
  a real electron-builder/NSIS issue, not something in this project's
  config, and not practical to root-cause further without a runner
  shell (tmate/SSH). Given the repeated ~25-minute cost per cycle,
  asked the user directly rather than guessing at more AV/OS settings;
  chosen fix: switched the Windows target from `nsis` (installer) to
  `portable` (single exe, no install/uninstall step) — this sidesteps
  the broken code path entirely, since the portable target never
  downloads or invokes NSIS at all. `README.md`'s Windows asset name
  updated to match (`Ethos Manual Editor <version>-x64.exe`, no more
  "Setup"). **Re-verified — the portable target ALSO downloads
  `nsis-3.0.4.1.7z`** (electron-builder's Windows "portable" target turns
  out to be built on NSIS's one-click portable mode internally, not a
  separate NSIS-free mechanism as assumed) — hung a fifth time, at that
  same exact line. Added a throwaway manual-only diagnostic workflow
  (`debug-windows.yml`, `workflow_dispatch`, deleted once resolved) to
  test hypotheses in ~1 minute each instead of a full ~25-minute release
  cycle. Traced the real download+extract mechanism: electron-builder's
  JS wrapper (`builder-util`'s `executeAppBuilder()`) spawns a bundled
  native helper, `app-builder.exe` (a precompiled Go binary from
  `app-builder-bin`, fresh on every CI run since `node_modules` is
  reinstalled each time), passing it an `SZA_PATH` env var pointing at
  another bundled binary, `7za.exe` (from `7zip-bin`) — `app-builder.exe`
  spawns `7za.exe` itself to do the actual extraction. Tested every layer
  in isolation and **every single one succeeded instantly**: `app-builder
  --help`, a direct real `7za.exe` extraction of the actual archive, the
  exact `app-builder.exe download-artifact` invocation with a correct
  absolute `SZA_PATH` (ruling out a red herring from an earlier attempt
  with a relative path, which fails fast for an unrelated reason —
  `app-builder.exe` resolves relative paths against its own internal
  cache dir, not the caller's cwd), and even a literal Node.js script
  making electron-builder's *exact* internal call
  (`require("builder-util").executeAppBuilder(["download-artifact", ...])`)
  — 515ms, no hang. Every component works alone; only the real, full
  `npm run dist` hangs, always at the same point. Re-examined the two
  earlier Defender-exclusion attempts and found a real gap: both excluded
  `%LOCALAPPDATA%\Temp`, but GitHub's Windows runners redirect the actual
  TEMP/RUNNER_TEMP to `D:\a\_temp` (confirmed directly in a diagnostic
  run's own log line — `Downloaded to D:\a\_temp\nsis.7z`) — meaning
  neither earlier attempt actually excluded the directory where scratch/
  extraction work happens, so Defender was never properly ruled out
  despite two "failed" mitigation attempts. Retrying a third Defender
  mitigation with the corrected path (`$env:RUNNER_TEMP`) plus explicit
  process exclusions for `app-builder.exe`/`7za.exe` alongside the
  existing ones. **Re-verified via `push.yml` (no tag dance needed) —
  hung again, at that exact same line**, with the exclusion step itself
  confirmed to have run successfully beforehand. This conclusively rules
  out Windows Defender: the one plausible gap in the exclusion path is
  now closed, and the identical, deterministic hang persisted regardless.
  Eight total CI cycles (six real build attempts + two isolated
  diagnostic rounds) have now ruled out, with direct evidence: the
  runner OS image (Server 2025 vs. 2022), both Windows packaging targets
  (`nsis` and `portable`), Windows Defender (three different
  configurations), and the Node-vs-PowerShell process-spawning
  mechanism (every component — `app-builder.exe`, `7za.exe`, and even
  electron-builder's *exact* internal Node call — completes in under a
  second in isolation). The hang is real, reproducible, and specific to
  the full `npm run dist` pipeline on GitHub-hosted Windows runners, but
  the root cause remains unknown — properly diagnosing it further would
  need an interactive session on the actual hanging runner (e.g. a
  `tmate`/SSH debug step), which needs the user's live participation
  mid-run rather than another unattended guess. Asked directly rather
  than spend a 9th cycle guessing; **decision: stop chasing this in
  CI.** Removed Windows from all three workflows' matrices entirely
  (macOS/Linux stay fully automated) and deleted the throwaway
  `debug-windows.yml`/`debug-node-spawn.js` diagnostic files. The
  Windows portable exe (`package.json`'s `win`/`portable` config is
  untouched and still correct — this only ever failed in CI, never
  locally, across every attempt this session) is now built locally per
  release and uploaded by hand via `gh release upload` — documented in
  `README.md`'s Releasing section.
  **Resolved, a later session** — the proper `tmate` debugging session
  above happened for real: a throwaway `debug-windows-tmate.yml`
  (`workflow_dispatch`, drops into an interactive `tmate` shell right
  before the packaging step) let a human attach directly to a live
  hung runner and actually inspect it, something none of the 8 prior
  unattended cycles could do. Real findings, checked live, not guessed:
  - The "hung" process (`7za.exe`) was never actually stuck — `Get-Process
    -Id <pid> | Select Threads` showed its one thread in `Running` state
    (not any `Wait` state), and its CPU time and working set were both
    climbing steadily on repeated checks. It was doing real, ongoing
    work the whole time.
  - Its real command line (`Get-CimInstance Win32_Process`) was
    `7za.exe a -bd -mx=9 -mtc=off -mtm=off -mta=off ... .nsis.7z .` —
    **compressing** (`a` = add) the entire `win-unpacked` output
    directory at **maximum LZMA compression**, **single-threaded**
    (`-mt*=off`), not downloading/extracting anything (the original
    working theory, from `nsis-3.0.4.1.7z` being the last thing logged
    before earlier cycles' silence, turned out to be a red herring —
    that log line was just the last thing printed before this much
    bigger, slower step, not the step that was actually slow).
  - Reading `app-builder-lib`'s own source (`targets/archive.js`)
    directly: for `.7z`-format output specifically, electron-builder
    hard-codes `-mx=9` — the top-level `compression: "store"/"normal"`
    config option (which the code otherwise supports) is silently
    ignored for this format; it only affects `.zip` output. **Tested
    live** via the escape hatch visible in that same source
    (`process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL` overrides `-mx=`
    directly): re-ran with `ELECTRON_BUILDER_COMPRESSION_LEVEL=1` in the
    same session — CPU time climbed at essentially the same rate as at
    the default level 9. **Compression level was not the bottleneck.**
  - Windows Defender was checked directly too (`Get-MpPreference`) —
    `DisableRealtimeMonitoring: True`, `ExclusionPath: {C:\, D:\}` —
    already fully disabled and excluded by GitHub's own default runner
    image, before any of this project's own workflow steps ever ran.
    Conclusively rules Defender out, not just via a possibly-incomplete
    exclusion path like the three earlier attempts.
  - What's actually large: `win-unpacked` held 2038 files (~300MB) —
    ordinary for an Electron app — but 1933 of those (95%) were under
    `backend/node_modules`, bundled in raw (not asar-packed, since the
    backend runs as a real spawned Node process) via `extraResources`.
    That includes `typescript`, `ts-node-dev`, and `ts-node-dev`'s own
    substantial transitive-only tree (`ts-node`, `resolve`,
    `@jridgewell/*`, `diff`, `source-map`, `dynamic-dedupe`, 100+ files
    on their own) — none of it ever needed at runtime (`tsc` already
    compiled `backend/dist` ahead of time; `ts-node-dev` only exists for
    `npm run dev`). **Root cause: per-file I/O overhead on this shared
    runner's storage, multiplied across ~1900 files that shouldn't have
    shipped at all** — not a deadlock, not compression settings, not
    antivirus.
  - **Fix**: `scripts/prepare-backend-prod-modules.js` builds a
    genuinely separate `backend/node_modules.prod/` via a real
    `npm ci --omit=dev` (wired in as part of `predist`), and
    `extraResources` now bundles *that* instead of the developer's own
    `backend/node_modules` (which still needs its devDependencies for
    `npm run dev`/`build:backend`, so it can't be pruned in place). A
    first attempt used a hand-maintained `extraResources` `filter` glob
    list instead (exclude just `typescript/`/`ts-node-dev/`/`@types/`)
    — only cut file count by 17% (2038→1601), missing `ts-node-dev`'s
    transitive-only tree entirely, which sits as separate top-level
    packages in npm's flat layout. The real `npm ci --omit=dev` fix cut
    it by 54% (2038→930/932) — npm's own resolver correctly excludes
    every devDependency-only package, direct or transitive, with no
    guesswork. Verified locally, not just by file count: ran the
    packaged backend directly (same plain-Node harness used earlier
    this session to verify the GitHub sign-in packaging fix) against
    the pruned `node_modules` — `/api/health`, the real GitHub
    device-flow start, and a live GitHub-API-backed route
    (`/api/nav/branches`, exercises `fs-extra`/`js-yaml`) all worked
    correctly. Validated end-to-end on a real Windows CI runner via
    `debug-windows-timed-dist.yml` (unattended, just times the real
    `npm run dist` — see that workflow's own comment) before re-adding
    Windows to the real build matrices.
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
- **Custom nodes for pymdownx tabs in Rich mode** — admonitions/details
  are now built (see the dedicated section below, updated from
  "researched, not yet built"); tabs (`=== "Label"`) still aren't, and
  pages containing one still gate to Source mode. No confirmed real
  usage of tabs in `ethos-manual-rework` today, so this costs little in
  practice.
- Spellcheck-in-editor.
- Structural insert helpers as UI (a toolbar to insert an admonition/
  table/tab without hand-typing syntax) — Rich mode now has a basic
  formatting toolbar (Bold/Italic/Link/Image), but nothing yet to insert
  a *new* admonition/details/table/tab; editing an *existing* one is
  fully supported now that the custom-node work below landed. Insert
  helpers are a separate, smaller follow-up whenever wanted.
- The diff-vs-English view.
- **Not machine-verified**: the actual browse/drag/paste interaction in
  the image-upload modal (upload/list/serve endpoints themselves were
  tested directly against the API).

## pymdownx admonitions/details in Rich mode (built)

Milkdown's default schema has no concept of `!!! type "Title"` admonitions
or `??? .../???+ ...` collapsible details — and CommonMark's own "lazy
continuation" rule means a page containing one, edited in a generic
rich-text editor with no custom handling, would have its whole
`!!!`/indented-body structure silently flattened into a plain paragraph
the moment it's saved. That's real data loss, not a display quirk, which
is why `containsPymdownxBlocks()` used to gate those pages to Source mode
entirely — it now only gates on tabs (`=== "Label"`, still unsupported;
see below).

Caught live testing the macOS build: a page with an admonition made the
Rich button permanently un-clickable, surfacing this as a real gap rather
than a theoretical one. Implemented as three files under
`frontend/src/wysiwyg/`, matching the previously-researched approach
almost exactly (confirmed via two Explore agents reading the actual
installed Milkdown 7.22.1 source before writing any code, not guessing at
API shapes):

- **`pymdownxSchema.ts`**: `$nodeSchema("admonition"/"details", ...)`,
  `type`/`title` as node **attrs** (not child nodes — title is a literal
  quoted string in the source, never itself markdown-formatted, so this
  loses nothing), `content: "block+"` for the body. Modeled directly on
  `@milkdown/preset-commonmark`'s real `blockquote`/`code-block` schemas.
- **`pymdownxRemark.ts`**: a `$remark`-wrapped plugin reusing
  `preprocessPymdownxBlocks()`'s marker-matching logic (same
  `byLine`-position matching `pymdownxBlocks.ts:remarkPymdownxBlocks()`
  uses for the preview) but retagging `node.type` for real
  (`"admonition"`/`"details"`) instead of setting hast-only
  `hName`/`hProperties` — Milkdown's own parse pipeline never runs
  remark-rehype at all, so it dispatches on real `node.type`. Also holds
  the `toMarkdown` handlers (`admonitionToMarkdownHandler`/
  `detailsToMarkdownHandler`) registered into
  `remarkStringifyOptionsCtx`'s `handlers` field (a real, public
  extension point — no deep import into `mdast-util-to-markdown`'s own
  internals needed, since its `exports` field blocks that anyway; `State`
  already carries `indentLines`/`containerFlow` bound as handler args).
  Modeled on that package's own built-in blockquote handler, 4-space
  `map` instead of `"> "`.
- **`pymdownxViews.ts`**: hand-written plain-DOM `NodeView` classes, not
  React — confirmed via research that `@milkdown/react` (this version)
  has no NodeView bridge at all (only `@milkdown/components`, which is
  Vue-based) and no `@prosemirror-adapter` package exists in this
  dependency tree. The title bar is a real `<input type="text">`
  (**not** a nested `contenteditable` div, see below), outside
  `contentDOM` so ProseMirror's mutation observer never tries to manage
  it, synced to the node's `title` attr via `tr.setNodeAttribute` on
  `input`.

**A second real bug, caught live (not by the headless test) — the title
bar wasn't actually editable at all.** The first version used a nested
`contenteditable="true"` div for the title, matching what looked like a
standard ProseMirror pattern. Verified via a live Electron smoke test
(driven through `playwright-core`'s `chromium.connectOverCDP()` against
the CDP port `electron/main.ts` already opens on `9333` — the same
proven approach this session's earlier `getUsableToken()` display-logic
investigation used) that this design is fundamentally broken: a
`contenteditable` region nested *inside* another `contenteditable`
ancestor never receives real DOM focus in Chromium at all —
`document.activeElement` stayed on the outer ProseMirror root the whole
time, so neither `focus`/`blur`/`focusout` nor `input`/`keydown`/
`beforeinput` ever fired on the nested div, even though typed text still
visually appeared there (native contenteditable text insertion doesn't
require the element to be "focused" in the DOM sense a form control
needs). Net effect: typing a title looked like it worked, but nothing
ever committed it back to the node's `title` attr, so it silently
vanished the moment you switched to Source. Fixed by replacing the
nested div with a real `<input type="text">` — a genuine independent
form control gets real focus/blur/input events regardless of being
nested inside a `contenteditable` ancestor, and comes with a free bonus:
a native `placeholder` attribute for the capitalized-type fallback
instead of a CSS `:empty::before` trick. For `details`, the `<input>`
sits inside a real `<summary>` (moved there via `summary.appendChild`,
inserted first) with `stopPropagation()` on the input's own click/
mousedown so interacting with the title text doesn't also fire the
`<summary>`'s native open/close toggle.

Re-verified live after the fix, on real `ethos-manual-rework` content
(a `!!! warning` block with no title, in System Setup → File Manager):
typed "Startup Delay" into the title, switched to Source, and the
serialized markdown read exactly `!!! warning "Startup Delay"` —
confirming the full write path, not just the parse/serialize logic the
headless test already covered.

**A real round-trip bug caught before shipping**: `preprocessPymdownxBlocks()`
used to bake a capitalized-type fallback title (e.g. `"Warning"`) directly
into the marker when no title was given in the source — meaning an
untouched `!!! warning` (no title) would round-trip through Rich mode as
`!!! warning "Warning"`, a spurious diff on save even with zero real
edits. Fixed by keeping the marker's `title` genuinely empty in that case
and moving the capitalized-fallback to *display* time only, in two
places that both need to agree: `remarkPymdownxBlocks()` (preview) and
`pymdownxViews.ts`'s NodeViews (a CSS `:empty::before` placeholder via
`data-placeholder`, not real DOM text — pre-filling the actual
contenteditable text would make a plain focus+blur with no edit look
identical to the user having typed that text).

**Verified via a standalone jsdom round-trip script** (not committed —
built the real `Editor.make()` chain from `WysiwygEditor.tsx` headlessly,
parsed real admonition/details markdown, serialized it back out, diffed
byte-for-byte against the original): basic admonition with a title/link/
two paragraphs, no-title fallback, collapsed details, open-by-default
details all matched exactly. One case — an admonition nested inside a
list item — did *not* match byte-for-byte, but an isolated control test
(plain nested paragraph, zero admonition code involved) reproduced the
identical reformatting (list continuation indent renormalized to the
bullet marker's own width) — confirming it's a pre-existing
`remark-stringify` characteristic of Rich mode in general, not a
regression from this work.

Tabs are still not supported — no confirmed real usage of `=== "Label"`
anywhere in `ethos-manual-rework` today (admonitions are heavily used —
confirmed — details/tabs are not), so gating them out costs little in
practice. `containsPymdownxBlocks()` narrowed accordingly (only checks
`TAB_RE` now).

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
