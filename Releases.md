## 0.2.2

- Rich mode (the WYSIWYG editor) can now edit pages with admonitions
  ("!!! note" boxes) and collapsible details sections directly, instead
  of forcing those pages into raw-markdown Source mode.
- Download asset names now always spell out the OS and CPU architecture
  (e.g. `Ethos-Manual-Editor-0.2.2-mac-x64.dmg`), so it's clear at a
  glance which file to grab.

## 0.2.1

- Fixed GitHub sign-in not working at all in downloaded builds ("Couldn't
  start GitHub sign-in") -- a packaging bug meant the app's GitHub Client
  ID never made it into shipped builds. If sign-in is ever misconfigured
  again, the app now warns you plainly on launch instead of failing
  silently.

## 0.2.0

Complete rewrite as a desktop app (Electron + React), replacing the
previous Python/tkinter version.

- Sign in with GitHub via device flow -- no more pasting a personal
  access token
- Browse branches/languages and the manual's table of contents, with
  each page's translation status (missing / stale / up to date) shown
  at a glance
- Editing turns on automatically as soon as you pick a language -- no
  separate "create a workspace" step
- Edit a page as real rich text (bold/italic/link/image), as raw
  Markdown, or as a live rendered preview -- switch between them anytime
- Insert images by uploading or picking one already used elsewhere in
  that language
- Create brand-new pages and sections (English only -- every other
  language only ever translates what already exists)
- Discard local changes to any page, one at a time, if you want to
  start over
- Submit for review opens a draft pull request; submitting again
  updates the same one instead of opening a duplicate

## 0.1.0

- Sign in with a GitHub personal access token to submit translations as
  pull requests -- browsing and editing don't require signing in at all
- Pick a branch/version and language, browse the manual's table of contents
- Edit a page's translation side by side with the English source; a
  missing translation starts pre-filled from English instead of blank
- "Preview in browser" renders your edit through the real markdown
  pipeline, including working screenshots
- Submit for review opens a pull request as a draft; "Mark ready for
  review" once you're done editing, or "Discard & reset" to abandon it
  and start over
- Reopening the app on a page you've already started resumes from your
  open pull request instead of the currently published translation
