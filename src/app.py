#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ethos Manual Translator
========================
A GUI tool for translators to edit ethos-manual-rework's per-locale docs
pages and submit the result back as a GitHub pull request, without needing
a local git checkout or a markdown editor of their own.

Status: sign-in (this file + auth.py) is wired up and working end to end
against real GitHub credentials. Branch/page browsing, editing, and PR
submission are not yet -- see the plan below for what's next and which
pieces of ethos-manual-rework's own tooling each step reuses.

Planned flow:
  1. Login       -- DONE. GitHub fine-grained PAT, pasted in once and
                     stored via `keyring` (OS credential store). No OAuth
                     app to register; see auth.py's docstring for why.
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
        self._signin_queue: queue.Queue = queue.Queue()

        self._build_menu()
        self._build_body()
        self._build_status_bar()

        self._poll_signin_queue()
        self._try_auto_sign_in()

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
            text=(
                "Branch/page browsing and editing are not wired up yet -- "
                "those will work without signing in. A token is only ever "
                "needed to submit a page for review."
            ),
            justify="left",
        ).pack(anchor="w", pady=(4, 16))

        self.login_frame = ttk.LabelFrame(
            container, text="Sign in (only needed to submit for review)", padding=12
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

    # -- Sign-in -----------------------------------------------------

    def _try_auto_sign_in(self):
        token = auth.load_token()
        if token:
            self.status_label.config(text="Checking saved sign-in...")
            self._validate_in_background(token, on_bad_saved_token=auth.clear_token)

    def _on_sign_in(self):
        token = self.token_entry.get()
        self._set_signin_busy(True)
        self.status_label.config(text="Signing in...")
        self._validate_in_background(token)

    def _validate_in_background(self, token, on_bad_saved_token=None):
        # Worker thread only ever touches the queue, never a Tk widget or
        # `after` directly -- calling `after` from a non-main thread isn't
        # reliably safe across Tk builds/platforms (raises "main thread is
        # not in main loop" on some). _poll_signin_queue, scheduled from
        # the main thread, is what actually dispatches the result.
        def worker():
            try:
                user = auth.validate_token(token)
            except auth.AuthError as e:
                self._signin_queue.put(("error", e, on_bad_saved_token))
                return
            self._signin_queue.put(("success", user))

        threading.Thread(target=worker, daemon=True).start()

    def _poll_signin_queue(self):
        try:
            while True:
                kind, *args = self._signin_queue.get_nowait()
                if kind == "success":
                    self._handle_signin_success(*args)
                else:
                    self._handle_signin_error(*args)
        except queue.Empty:
            pass
        self.after(150, self._poll_signin_queue)

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

    def _handle_signin_error(self, error: auth.AuthError, on_bad_saved_token):
        self._set_signin_busy(False)
        self.status_label.config(text="Browsing anonymously")
        if on_bad_saved_token:
            # A silently-attempted auto sign-in failed (e.g. token revoked
            # since last run) -- clear it rather than retrying every
            # launch, but don't interrupt startup with a dialog for it.
            on_bad_saved_token()
            return
        messagebox.showerror("Sign in failed", str(error))

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


def main() -> int:
    App().mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
