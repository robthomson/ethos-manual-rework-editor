# Notes for Claude Code

This file is for cross-repo pointers and reminders that don't belong in
`DEV_NOTES.md` (which is specifically this app's own architecture/history
journal — see its own header). Keep entries short; link out rather than
duplicating detail that lives elsewhere.

## Real manual content sync (repeatable ODT → Markdown process)

If asked to sync real manual content from `.odt` masters into
`ethos-manual-rework` (any branch), pull in real content for a new locale,
or otherwise touch anything under `docs/<locale>/` in that repo — **the
repeatable process lives in a different repo, not here**:

- `ethos-tools/manual-sync/RUNBOOK.md` — the step-by-step process:
  building `PAGE_MAP` for English first, verifying a locale's real
  structure before trusting it, deriving other locales' mappings
  positionally instead of hand-writing them, known `odt_to_markdown.py`
  bugs already found and fixed, the PDF-only-locale dead end (confirmed
  encoding-corruption finding), and the full verification checklist.
- `ethos-tools/manual-sync/README.md` — per-script reference
  (`sync.py`, `sync_mapped.py`, `page_map.py`/`page_map_<branch>.py`).
- `ethos-manual/forge/odt_to_markdown.py` — the actual `.odt` → Markdown
  converter (lives on `ethos-manual`, not `ethos-manual-rework`).

This app (`ethos-manual-rework-editor`) is the browser/editor for
`ethos-manual-rework`'s content once it's already in the repo — it has no
code involved in the sync process itself and needs no changes for any of
this (confirmed: it's fully generic to whatever `docs/<locale>/SUMMARY.md`
and pages exist).
