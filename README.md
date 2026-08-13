# Ethos Manual Translator

A desktop GUI for translators working on [ethos-manual-rework](https://github.com/robthomson/ethos-manual-rework):
sign in with a GitHub token, pick a page, edit your language's version next
to the English source, and submit the result as a pull request -- no local
git checkout or markdown editor of your own required.

**Status: working end to end.** Sign-in, branch/language/page browsing, the
side-by-side editor with live preview, and submitting as a pull request are
all wired up and verified against the real, live repo. See `src/app.py`'s
module docstring for how each piece fits together and which pieces of
ethos-manual-rework's own tooling (nav parsing, the `translated_from:`
staleness convention, etc.) it reuses.

## Setting up your GitHub token

Submitting a translation needs a **fine-grained personal access token**
([create one here](https://github.com/settings/personal-access-tokens/new)),
pasted into the app's "Sign in" box (only needed at submit time -- browsing
and editing don't require signing in at all). Two separate settings on that
page both need to be right, and it's easy to set one and miss the other:

- **Repository access** -- "Only select repositories" -> `ethos-manual-rework`.
  (Leaving this on "Public Repositories (read-only)" silently caps the
  token to read-only regardless of the permissions below.)
- **Permissions** -- both of these, not just one:
  - **Contents: Read and write** (needed to commit the edited page)
  - **Pull requests: Read and write** (needed to open the PR -- a
    genuinely separate permission from Contents; having Contents alone
    gets you a real commit but a 403 on the PR itself)

If a permission is missing, the app's error message says which one --
worth reading closely if submitting fails, rather than assuming the whole
token is bad.

## Download

Binaries are published on GitHub Releases when a `release/*` tag is pushed:

```
https://github.com/robthomson/ethos-manual-rework-editor/releases
```

Asset names:
- Windows: `ethos-manual-translator-<version>-windows-<arch>.zip`
- macOS: `ethos-manual-translator-<version>-macos-<arch>.zip`
- Linux: `ethos-manual-translator-<version>-linux-<arch>.zip`

Every push to `main` and every PR also builds (but doesn't release) binaries
for all platforms, uploaded as workflow run artifacts -- see the Actions tab.

## Developer Notes

Requires Python 3.9+.

```bash
cd src
pip install -r requirements_translator.txt
python app.py
```

or `run_app.cmd` (Windows) / `./run_app.sh` (Linux/macOS) once dependencies
are installed.

### Building a standalone executable

Windows: `src\make.cmd` (builds and drops `ethos-manual-translator.exe` in
the repo root). macOS/Linux: same PyInstaller invocations as
`.github/workflows/*.yml` -- see those for the exact flags per platform.

## Releasing

Same tag-based flow as rotorflight-lua-ethos-suite-updater:
- `release/<version>` tag -> real release, built for Windows (x64/x86),
  macOS (Intel/ARM), and Linux (x64/arm64), notes pulled from `Releases.md`.
- Add a matching `## <version>` section to `Releases.md` before tagging --
  `.github/scripts/extract-release-notes.py` pulls that section verbatim
  into the release notes.
