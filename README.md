# Ethos Manual Translator

A desktop GUI for translators working on [ethos-manual-rework](https://github.com/robthomson/ethos-manual-rework):
sign in with a GitHub token, pick a page, edit your language's version next
to the English source, and submit the result as a pull request -- no local
git checkout or markdown editor of your own required.

**Status: early scaffold.** The packaging/release pipeline (ported from
[rotorflight-lua-ethos-suite-updater](https://github.com/rotorflight/rotorflight-lua-ethos-suite-updater),
same build-and-release-per-OS approach) is in place and produces a real,
launchable window -- login, page browsing, editing, and PR submission
aren't wired up yet. See `src/app.py`'s module docstring for the planned
flow and which pieces of ethos-manual-rework's own tooling it'll reuse.

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

or on Linux/macOS, `./run_app.sh` (checks for tkinter/deps first).

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
