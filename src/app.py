#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ethos Manual Translator
========================
A GUI tool for translators to edit ethos-manual-rework's per-locale docs
pages and submit the result back as a GitHub pull request, without needing
a local git checkout or a markdown editor of their own.

Status: scaffold only. This proves out the packaging/release pipeline
(ported from rotorflight-lua-ethos-suite-updater -- see .github/workflows/
and src/gen_version_info.py et al) with a real, launchable window; none of
the actual GitHub-backed functionality is wired up yet.

Planned flow (see ethos-manual-rework's own repo for the pieces to reuse):
  1. Login       -- GitHub fine-grained PAT, pasted in once and stored via
                     `keyring` (OS credential store). No OAuth app to
                     register; see that repo's conversation history for why.
  2. Branch/page  -- list branches (main + frozen version branches per
                     ethos-manual-rework's docs/en/contributing/versioning.md),
                     then walk mkdocs.yml's `nav:` for the page picker --
                     same recursive walk as ethos-manual-rework's own
                     scripts/build_pdfs.py:nav_pages().
  3. Editor       -- English (read-only) + target locale (editable) source
                     panes side by side, "Preview" opens the real rendered
                     HTML in the system browser (render server-side-style
                     via `markdown` + the same pymdownx extensions
                     ethos-manual-rework's mkdocs.yml lists, for accurate
                     preview -- not a generic JS-equivalent renderer).
  4. Save         -- create/update a translate/<locale>/<slug> branch,
                     commit via the Contents API using the translator's own
                     token, bump `translated_from:` frontmatter to the
                     English page's current commit SHA (same convention as
                     ethos-manual-rework's hooks/i18n_status.py checks),
                     open a PR. ethos-manual-rework's pr-preview.yml then
                     comments a live preview link automatically.

Locale assignment (translators.yml -> github username -> locale) is a soft,
advisory check here -- there's no server to be a hard gate once this is a
downloaded app hitting the GitHub API directly with the user's own token.
The actual enforcement boundary is the same one that already protects
ethos-manual-rework's main branch: PR review.
"""

import os
import sys

try:
    import tkinter as tk
    from tkinter import ttk
except ImportError:
    print("Error: tkinter is required but not found.")
    sys.exit(1)

APP_TITLE = "Ethos Manual Translator"

# Resolves next to this file when run from source, and next to the
# onefile executable's extracted bundle when run via PyInstaller.
ICON_PATH = os.path.join(
    getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))),
    "icon.ico",
)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("900x600")
        self.minsize(700, 450)
        self._set_icon()

        self._build_menu()
        self._build_body()
        self._build_status_bar()

    def _set_icon(self):
        # Best-effort: a missing/unreadable icon shouldn't stop the app
        # from starting (e.g. running app.py straight from a source
        # checkout that doesn't have icon.ico locally).
        try:
            self.iconbitmap(ICON_PATH)
        except (tk.TclError, OSError):
            pass

    def _build_menu(self):
        menubar = tk.Menu(self)

        file_menu = tk.Menu(menubar, tearoff=False)
        file_menu.add_command(label="Exit", command=self.destroy)
        menubar.add_cascade(label="File", menu=file_menu)

        help_menu = tk.Menu(menubar, tearoff=False)
        help_menu.add_command(label="About", command=self._show_about)
        menubar.add_cascade(label="Help", menu=help_menu)

        self.config(menu=menubar)

    def _build_body(self):
        container = ttk.Frame(self, padding=24)
        container.pack(fill="both", expand=True)

        ttk.Label(
            container,
            text=APP_TITLE,
            font=("TkDefaultFont", 16, "bold"),
        ).pack(anchor="w")

        ttk.Label(
            container,
            text=(
                "Scaffold build -- packaging pipeline only.\n"
                "Login, page browsing, editing, and PR submission are not "
                "wired up yet."
            ),
            justify="left",
        ).pack(anchor="w", pady=(4, 16))

        # Placeholder for the eventual step-1 login panel. Kept as a real
        # (disabled) widget rather than just a label so the eventual swap to
        # a working login flow is a small diff, not a rewrite.
        login_frame = ttk.LabelFrame(container, text="1. Sign in", padding=12)
        login_frame.pack(fill="x", pady=(0, 12))
        ttk.Label(login_frame, text="GitHub personal access token:").pack(
            side="left"
        )
        token_entry = ttk.Entry(login_frame, show="*", state="disabled")
        token_entry.pack(side="left", fill="x", expand=True, padx=8)
        ttk.Button(login_frame, text="Sign in", state="disabled").pack(side="left")

    def _build_status_bar(self):
        status = ttk.Frame(self, relief="sunken")
        status.pack(side="bottom", fill="x")
        ttk.Label(status, text="Not connected to GitHub", padding=(8, 2)).pack(
            side="left"
        )

    def _show_about(self):
        from tkinter import messagebox

        messagebox.showinfo(
            APP_TITLE,
            f"{APP_TITLE}\n\nTranslator tool for ethos-manual-rework.\n"
            "https://github.com/robthomson/ethos-manual-rework-editor",
        )


def main() -> int:
    App().mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
