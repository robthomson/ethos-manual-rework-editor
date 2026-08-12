#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ethos Manual Translator
========================
A GUI tool for translators to edit ethos-manual-rework's per-locale docs
pages and submit the result back as a GitHub pull request, without needing
a local git checkout or a markdown editor of their own.

Status: sign-in (auth.py) and browsing -- branch picker, locale picker, and
a table-of-contents tree walked from mkdocs.yml's `nav:` (github_repo.py) --
are wired up and working end to end against the real, live, public repo.
Editing and PR submission are not yet.

Planned flow:
  1. Login       -- DONE (auth.py). GitHub fine-grained PAT, pasted in once
                     and stored via `keyring` (OS credential store). No
                     OAuth app to register; see that file's docstring for
                     why. Deferred to save-time, not an upfront gate --
                     browsing is anonymous (see github_repo.py).
  2. Branch/page  -- DONE (github_repo.py). Branches and the nav-derived
                     TOC, both read anonymously (public repo).
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
import queue
import sys
import threading

try:
    import tkinter as tk
    from tkinter import messagebox, ttk
except ImportError:
    print("Error: tkinter is required but not found.")
    sys.exit(1)

import auth
import github_repo

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

        self.user: auth.SignedInUser | None = None
        self._toc_paths: dict[str, str | None] = {}  # tree item id -> md_path
        self._bg_queue: queue.Queue = queue.Queue()

        self._build_menu()
        self._build_body()
        self._build_status_bar()

        self._poll_bg_queue()
        self._try_auto_sign_in()
        self._load_branches()

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
        file_menu.add_command(
            label="Sign out", command=self._on_sign_out, state="disabled"
        )
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.destroy)
        menubar.add_cascade(label="File", menu=file_menu)
        self.file_menu = file_menu

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
            text="Editing and PR submission are not wired up yet.",
            justify="left",
        ).pack(anchor="w", pady=(4, 16))

        self._build_login_frame(container)
        self._build_browse_frame(container)

    def _build_login_frame(self, parent):
        self.login_frame = ttk.LabelFrame(
            parent, text="Sign in (only needed to submit for review)", padding=12
        )
        self.login_frame.pack(fill="x", pady=(0, 12))

        ttk.Label(self.login_frame, text="GitHub personal access token:").pack(
            side="left"
        )
        self.token_entry = ttk.Entry(self.login_frame, show="*")
        self.token_entry.pack(side="left", fill="x", expand=True, padx=8)
        self.token_entry.bind("<Return>", lambda _event: self._on_sign_in())

        self.signin_button = ttk.Button(
            self.login_frame, text="Sign in", command=self._on_sign_in
        )
        self.signin_button.pack(side="left")

        self.signed_in_label = ttk.Label(self.login_frame, text="")

    def _build_browse_frame(self, parent):
        browse_frame = ttk.LabelFrame(parent, text="Browse", padding=12)
        browse_frame.pack(fill="both", expand=True)

        picker_row = ttk.Frame(browse_frame)
        picker_row.pack(fill="x", pady=(0, 8))

        ttk.Label(picker_row, text="Branch:").pack(side="left")
        self.branch_combo = ttk.Combobox(picker_row, state="disabled", width=20)
        self.branch_combo.pack(side="left", padx=(4, 16))
        self.branch_combo.bind("<<ComboboxSelected>>", self._on_branch_selected)

        ttk.Label(picker_row, text="Language:").pack(side="left")
        self.locale_combo = ttk.Combobox(picker_row, state="disabled", width=20)
        self.locale_combo.pack(side="left", padx=(4, 0))

        self.toc_tree = ttk.Treeview(browse_frame, show="tree")
        self.toc_tree.pack(fill="both", expand=True)
        self.toc_tree.bind("<<TreeviewSelect>>", self._on_toc_select)

        self.selection_label = ttk.Label(browse_frame, text="No page selected.")
        self.selection_label.pack(anchor="w", pady=(8, 0))

    def _build_status_bar(self):
        status = ttk.Frame(self, relief="sunken")
        status.pack(side="bottom", fill="x")
        self.status_label = ttk.Label(status, text="Browsing anonymously", padding=(8, 2))
        self.status_label.pack(side="left")

    def _show_about(self):
        messagebox.showinfo(
            APP_TITLE,
            f"{APP_TITLE}\n\nTranslator tool for ethos-manual-rework.\n"
            "https://github.com/robthomson/ethos-manual-rework-editor",
        )

    # -- Background work -----------------------------------------------
    #
    # Worker threads only ever touch _bg_queue, never a Tk widget or
    # `after` directly -- calling `after` from a non-main thread isn't
    # reliably safe across Tk builds/platforms (it raised "main thread is
    # not in main loop" here on the build this was first written against).
    # _poll_bg_queue, scheduled from the main thread via `after`, is what
    # actually dispatches queued results back onto widgets.

    def _run_background(self, work, on_success, on_error):
        def worker():
            try:
                result = work()
            except Exception as e:  # noqa: BLE001 -- reported via on_error, not swallowed
                self._bg_queue.put((on_error, (e,)))
                return
            self._bg_queue.put((on_success, (result,)))

        threading.Thread(target=worker, daemon=True).start()

    def _poll_bg_queue(self):
        try:
            while True:
                callback, args = self._bg_queue.get_nowait()
                callback(*args)
        except queue.Empty:
            pass
        self.after(150, self._poll_bg_queue)

    # -- Sign-in ---------------------------------------------------------

    def _try_auto_sign_in(self):
        token = auth.load_token()
        if token:
            self.status_label.config(text="Checking saved sign-in...")
            self._run_background(
                lambda: auth.validate_token(token),
                on_success=self._handle_signin_success,
                on_error=self._handle_auto_signin_error,
            )

    def _on_sign_in(self):
        token = self.token_entry.get()
        self._set_signin_busy(True)
        self.status_label.config(text="Signing in...")
        self._run_background(
            lambda: auth.validate_token(token),
            on_success=self._handle_signin_success,
            on_error=self._handle_signin_error,
        )

    def _handle_signin_success(self, user: auth.SignedInUser):
        auth.save_token(user.token)
        self.user = user
        self.status_label.config(text=f"Signed in as {user.login}")
        self.file_menu.entryconfig("Sign out", state="normal")

        self.token_entry.pack_forget()
        self.signin_button.pack_forget()
        self.signed_in_label.config(
            text=f"Signed in as {user.name or user.login} ({user.login})"
        )
        self.signed_in_label.pack(side="left")

    def _handle_signin_error(self, error: Exception):
        self._set_signin_busy(False)
        self.status_label.config(text="Browsing anonymously")
        messagebox.showerror("Sign in failed", str(error))

    def _handle_auto_signin_error(self, error: Exception):
        # A silently-attempted auto sign-in failed (e.g. token revoked
        # since last run) -- clear it rather than retrying every launch,
        # but don't interrupt startup with a dialog for it.
        self._set_signin_busy(False)
        self.status_label.config(text="Browsing anonymously")
        auth.clear_token()

    def _set_signin_busy(self, busy: bool):
        state = "disabled" if busy else "normal"
        self.token_entry.config(state=state)
        self.signin_button.config(state=state)

    def _on_sign_out(self):
        auth.clear_token()
        self.user = None
        self.file_menu.entryconfig("Sign out", state="disabled")
        self.status_label.config(text="Browsing anonymously")

        self.signed_in_label.pack_forget()
        self.token_entry.delete(0, tk.END)
        self.token_entry.pack(side="left", fill="x", expand=True, padx=8)
        self.signin_button.pack(side="left")
        self._set_signin_busy(False)

    # -- Browse: branches, locales, TOC ----------------------------------

    def _load_branches(self):
        self.status_label.config(text="Loading branches...")
        self._run_background(
            github_repo.list_branches,
            on_success=self._handle_branches_loaded,
            on_error=self._handle_browse_error,
        )

    def _handle_branches_loaded(self, branches: list[str]):
        self.branch_combo.config(values=branches, state="readonly")
        if branches:
            self.branch_combo.current(0)
            self._load_branch_content(branches[0])
        self.status_label.config(text="Browsing anonymously")

    def _on_branch_selected(self, _event):
        self._load_branch_content(self.branch_combo.get())

    def _load_branch_content(self, branch: str):
        self.status_label.config(text=f"Loading {branch}...")
        self.locale_combo.config(state="disabled")
        self._run_background(
            lambda: github_repo.fetch_mkdocs_config(branch),
            on_success=self._handle_branch_content_loaded,
            on_error=self._handle_browse_error,
        )

    def _handle_branch_content_loaded(self, config: dict):
        locales = github_repo.locale_names(config)
        # English first (it's the source of truth every translation is
        # compared against), then the rest alphabetically by locale code.
        ordered = ["en"] + sorted(loc for loc in locales if loc != "en")
        self.locale_combo.config(
            values=[f"{loc} - {locales[loc]}" for loc in ordered], state="readonly"
        )
        self.locale_combo.current(0)

        self.toc_tree.delete(*self.toc_tree.get_children())
        self._toc_paths.clear()
        for page in github_repo.build_toc(config):
            self._insert_toc_page("", page)

        self.status_label.config(text="Browsing anonymously")

    def _insert_toc_page(self, parent_iid: str, page: github_repo.TocPage):
        iid = self.toc_tree.insert(parent_iid, "end", text=page.title, open=False)
        self._toc_paths[iid] = page.md_path
        for child in page.children:
            self._insert_toc_page(iid, child)

    def _on_toc_select(self, _event):
        selected = self.toc_tree.selection()
        if not selected:
            return
        iid = selected[0]
        md_path = self._toc_paths.get(iid)
        title = self.toc_tree.item(iid, "text")
        if md_path:
            self.selection_label.config(text=f"Selected: {title} ({md_path})")
        else:
            self.selection_label.config(text=f"Selected: {title} (section, no page of its own)")

    def _handle_browse_error(self, error: Exception):
        self.status_label.config(text="Browsing anonymously")
        messagebox.showerror("Couldn't load from GitHub", str(error))


def main() -> int:
    App().mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
