#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ethos Manual Translator
========================
A GUI tool for translators to edit ethos-manual-rework's per-locale docs
pages and submit the result back as a GitHub pull request, without needing
a local git checkout or a markdown editor of their own.

Status: sign-in (auth.py), browsing (github_repo.py), and the editor itself
(English read-only + target-locale editable panes, "Preview" rendering via
preview.py) are wired up and working end to end against the real, live,
public repo. PR submission is not yet.

Planned flow:
  1. Login       -- DONE (auth.py). GitHub fine-grained PAT, pasted in once
                     and stored via `keyring` (OS credential store). No
                     OAuth app to register; see that file's docstring for
                     why. Deferred to save-time, not an upfront gate --
                     browsing is anonymous (see github_repo.py).
  2. Branch/page  -- DONE (github_repo.py). Branches and the nav-derived
                     TOC, both read anonymously (public repo).
  3. Editor       -- DONE (github_repo.py + preview.py). English
                     (read-only) + target locale (editable) source panes
                     side by side -- a missing translation is pre-filled
                     with the English source as a starting point, not left
                     blank. "Preview" renders the *edited* locale text
                     through the same pymdownx extensions
                     ethos-manual-rework's mkdocs.yml lists and opens it in
                     the system browser, with image src=""s rewritten to
                     raw.githubusercontent.com so screenshots actually
                     load. Known gap: swapping in a *replacement* image
                     (this repo's screenshots are per-locale, not shared)
                     isn't handled -- that's a save-step concern, see below.
  4. Save         -- create/update a translate/<locale>/<slug> branch,
                     commit via the Contents API using the translator's own
                     token, bump `translated_from:` frontmatter to the
                     English page's current commit SHA (same convention as
                     ethos-manual-rework's hooks/i18n_status.py checks),
                     open a PR. ethos-manual-rework's pr-preview.yml then
                     comments a live preview link automatically. Needs to
                     also cover replacing a page's screenshots, not just
                     its markdown text -- not designed yet.

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
import preview

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
        self.geometry("1200x720")
        self.minsize(900, 500)
        self._set_icon()

        self.user: auth.SignedInUser | None = None
        self._toc_paths: dict[str, str | None] = {}  # tree item id -> md_path
        self._bg_queue: queue.Queue = queue.Queue()

        # Set once a branch's mkdocs.yml has loaded; used by the editor to
        # know what it's fetching/rendering for.
        self._branch_config: dict | None = None
        self._current_branch: str | None = None
        self._current_md_path: str | None = None
        self._current_title: str | None = None
        self._english_source: str | None = None

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
        outer = ttk.Frame(self, padding=(24, 24, 24, 12))
        outer.pack(fill="both", expand=True)

        ttk.Label(
            outer,
            text=APP_TITLE,
            font=("TkDefaultFont", 16, "bold"),
        ).pack(anchor="w")

        ttk.Label(
            outer,
            text="PR submission is not wired up yet -- edits here aren't saved anywhere.",
            justify="left",
        ).pack(anchor="w", pady=(4, 12))

        self._build_login_frame(outer)
        self._build_picker_row(outer)

        main_paned = ttk.PanedWindow(outer, orient="horizontal")
        main_paned.pack(fill="both", expand=True, pady=(8, 0))

        left = ttk.Frame(main_paned)
        main_paned.add(left, weight=1)
        self._build_browse_pane(left)

        right = ttk.Frame(main_paned)
        main_paned.add(right, weight=3)
        self._build_editor_pane(right)

    def _build_login_frame(self, parent):
        self.login_frame = ttk.LabelFrame(
            parent, text="Sign in (only needed to submit for review)", padding=12
        )
        self.login_frame.pack(fill="x")

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

    def _build_picker_row(self, parent):
        # Its own full-width row above the TOC/editor split, rather than
        # packed into the (deliberately narrow, sized for a tree view) left
        # pane -- these need more room than that pane has to spare, both
        # for two side-by-side fields and for locale names like "pt-BR -
        # Português (Brasil)" to actually be readable. LabelFrame to match
        # the "Sign in" section above it rather than sitting as a bare,
        # unbordered row.
        picker_frame = ttk.LabelFrame(parent, text="Branch & language", padding=12)
        picker_frame.pack(fill="x", pady=(12, 0))

        ttk.Label(picker_frame, text="Branch:").pack(side="left")
        self.branch_combo = ttk.Combobox(picker_frame, state="disabled", width=18)
        self.branch_combo.pack(side="left", padx=(4, 16))
        self.branch_combo.bind("<<ComboboxSelected>>", self._on_branch_selected)

        ttk.Label(picker_frame, text="Language:").pack(side="left")
        self.locale_combo = ttk.Combobox(picker_frame, state="disabled", width=28)
        self.locale_combo.pack(side="left", padx=(4, 0))
        self.locale_combo.bind("<<ComboboxSelected>>", self._on_locale_selected)

    def _build_browse_pane(self, parent):
        # Matches the "English (read-only)"/"Translation (editable)"
        # labels' height and spacing (pady=(0, 8)) so the TOC's bordered
        # box top-aligns with the two text panes' instead of starting a
        # row higher, flush with their labels.
        ttk.Label(parent, text="Table of contents").pack(anchor="w", pady=(0, 14))

        self.toc_tree = ttk.Treeview(parent, show="tree")
        self.toc_tree.pack(fill="both", expand=True)
        self.toc_tree.bind("<<TreeviewSelect>>", self._on_toc_select)

    def _build_editor_pane(self, parent):
        # No separate page-title header -- the TOC's own highlighted
        # selection already says which page this is. "Loading"/"no
        # translation yet" states go on the status bar (transient/global)
        # or the Translation column's own header (page-specific, sits
        # right above the pane it describes) instead, and the preview
        # button shares that same column-header row, right-aligned above
        # the pane it acts on rather than floating alone across an empty
        # full-width row.
        panes = ttk.Frame(parent)
        panes.pack(fill="both", expand=True)
        panes.columnconfigure(0, weight=1)
        panes.columnconfigure(1, weight=1)
        panes.rowconfigure(1, weight=1)

        ttk.Label(panes, text="English (read-only)").grid(row=0, column=0, sticky="w", pady=(0, 8))

        translation_header = ttk.Frame(panes)
        translation_header.grid(row=0, column=1, sticky="ew", padx=(8, 0), pady=(0, 8))
        self.translation_header_label = ttk.Label(translation_header, text="Translation (editable)")
        self.translation_header_label.pack(side="left")
        self.preview_button = ttk.Button(
            translation_header, text="Preview in browser", command=self._on_preview, state="disabled"
        )
        self.preview_button.pack(side="right")

        self.english_text = self._make_text_pane(panes, row=1, column=0)
        self.english_text.config(state="disabled")

        self.locale_text = self._make_text_pane(panes, row=1, column=1, padx=(8, 0))

    def _make_text_pane(self, parent, row: int, column: int, padx=0) -> tk.Text:
        # The Text + Scrollbar pair share a wrapper frame (packed together
        # inside it); the frame itself, not the Text widget, is what's
        # actually grid-managed within `parent` -- gridding the Text widget
        # directly would try to place it within its real parent (the
        # wrapper), which already manages it via pack(), and Tk doesn't
        # allow mixing geometry managers on the same container's children.
        frame = ttk.Frame(parent)
        frame.grid(row=row, column=column, sticky="nsew", padx=padx)

        text = tk.Text(frame, wrap="word", font=("TkFixedFont",), undo=True)
        scrollbar = ttk.Scrollbar(frame, orient="vertical", command=text.yview)
        text.config(yscrollcommand=scrollbar.set)
        text.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        return text

    def _build_status_bar(self):
        status = ttk.Frame(self, relief="sunken")
        status.pack(side="bottom", fill="x")
        self.status_label = ttk.Label(status, text=self._default_status_text(), padding=(8, 2))
        self.status_label.pack(side="left")

    def _default_status_text(self) -> str:
        # Signed in bumps github_repo's rate limit from 60 to 5000/hour
        # (see github_repo.set_token()) -- worth surfacing here so it's
        # visible that signing in early, even though nothing requires it
        # until the save step, has an upside.
        if self.user:
            return f"Signed in as {self.user.login} (5,000 requests/hour)"
        return "Browsing anonymously (60 requests/hour)"

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
        github_repo.set_token(user.token)
        self.status_label.config(text=self._default_status_text())
        self.file_menu.entryconfig("Sign out", state="normal")

        self.token_entry.pack_forget()
        self.signin_button.pack_forget()
        self.signed_in_label.config(
            text=f"Signed in as {user.name or user.login} ({user.login})"
        )
        self.signed_in_label.pack(side="left")

    def _handle_signin_error(self, error: Exception):
        self._set_signin_busy(False)
        self.status_label.config(text=self._default_status_text())
        messagebox.showerror("Sign in failed", str(error))

    def _handle_auto_signin_error(self, error: auth.AuthError):
        # A silently-attempted auto sign-in failed -- don't interrupt
        # startup with a dialog for it either way, but only actually clear
        # the stored token if it's the token itself that's the problem
        # (revoked/wrong scope). A rate limit or network blip doesn't mean
        # the token is bad -- clearing it over one of those would force a
        # perfectly good token to be re-pasted just because GitHub or the
        # network had a moment.
        self._set_signin_busy(False)
        self.status_label.config(text=self._default_status_text())
        if error.invalid_credential:
            auth.clear_token()

    def _set_signin_busy(self, busy: bool):
        state = "disabled" if busy else "normal"
        self.token_entry.config(state=state)
        self.signin_button.config(state=state)

    def _on_sign_out(self):
        auth.clear_token()
        self.user = None
        github_repo.set_token(None)
        self.file_menu.entryconfig("Sign out", state="disabled")
        self.status_label.config(text=self._default_status_text())

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
        self.status_label.config(text=self._default_status_text())

    def _on_branch_selected(self, _event):
        self._clear_editor()
        self._load_branch_content(self.branch_combo.get())

    def _load_branch_content(self, branch: str):
        self._current_branch = branch
        self.status_label.config(text=f"Loading {branch}...")
        self.locale_combo.config(state="disabled")
        self._run_background(
            lambda: github_repo.fetch_mkdocs_config(branch),
            on_success=self._handle_branch_content_loaded,
            on_error=self._handle_browse_error,
        )

    def _handle_branch_content_loaded(self, config: dict):
        self._branch_config = config
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

        self.status_label.config(text=self._default_status_text())

    def _insert_toc_page(self, parent_iid: str, page: github_repo.TocPage):
        iid = self.toc_tree.insert(parent_iid, "end", text=page.title, open=False)
        self._toc_paths[iid] = page.md_path
        for child in page.children:
            self._insert_toc_page(iid, child)

    def _selected_locale_code(self) -> str | None:
        value = self.locale_combo.get()
        return value.split(" - ", 1)[0] if value else None

    def _on_toc_select(self, _event):
        selected = self.toc_tree.selection()
        if not selected:
            return
        iid = selected[0]
        md_path = self._toc_paths.get(iid)
        title = self.toc_tree.item(iid, "text")
        if not md_path:
            self._clear_editor()
            self.status_label.config(text=f"{title}: section, no page of its own")
            return
        self._current_md_path = md_path
        self._current_title = title
        self.status_label.config(text=f"Loading {title}...")
        self.preview_button.config(state="disabled")
        self._load_page(title, md_path)

    def _load_page(self, title: str, md_path: str):
        branch = self._current_branch
        locale = self._selected_locale_code()

        def work():
            english = github_repo.fetch_page_source(branch, "en", md_path)
            if locale == "en":
                return english, english, True
            translated = github_repo.try_fetch_page_source(branch, locale, md_path)
            return english, translated, translated is not None

        self._run_background(
            work,
            on_success=lambda result: self._handle_page_loaded(title, md_path, *result),
            on_error=self._handle_browse_error,
        )

    def _handle_page_loaded(
        self, title: str, md_path: str, english: str, locale_text: str | None, existed: bool
    ):
        if md_path != self._current_md_path:
            return  # user picked something else while this was loading
        self._english_source = english
        self._set_text(self.english_text, english, editable=False)
        self._set_text(self.locale_text, locale_text if locale_text is not None else english, editable=True)

        self.preview_button.config(state="normal")
        self.status_label.config(text=self._default_status_text())
        if existed:
            self.translation_header_label.config(text="Translation (editable)")
        else:
            self.translation_header_label.config(
                text="Translation (editable) -- no translation yet, starting from English"
            )

    def _on_locale_selected(self, _event):
        if not self._current_md_path:
            return  # nothing loaded yet, just a picker change
        self.status_label.config(text=f"Loading {self._current_title}...")
        self.preview_button.config(state="disabled")
        self._load_page(self._current_title, self._current_md_path)

    def _set_text(self, widget: tk.Text, content: str, editable: bool):
        widget.config(state="normal")
        widget.delete("1.0", "end")
        widget.insert("1.0", content)
        widget.edit_reset()
        widget.config(state="normal" if editable else "disabled")

    def _clear_editor(self):
        self._current_md_path = None
        self._current_title = None
        self._english_source = None
        self._set_text(self.english_text, "", editable=False)
        self._set_text(self.locale_text, "", editable=True)
        self.preview_button.config(state="disabled")
        self.translation_header_label.config(text="Translation (editable)")

    def _on_preview(self):
        if not self._current_md_path or not self._branch_config:
            return
        content = self.locale_text.get("1.0", "end-1c")
        title = self._current_title or self._current_md_path
        html = preview.render_html(
            content,
            self._branch_config["markdown_extensions"],
            self._current_branch,
            self._selected_locale_code(),
            self._current_md_path,
            title,
        )
        preview.open_preview(html)

    def _handle_browse_error(self, error: Exception):
        self.status_label.config(text=self._default_status_text())
        messagebox.showerror("Couldn't load from GitHub", str(error))


def main() -> int:
    App().mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
