# ========================================
# VARIABLES
# ========================================
#
# Same shape as rotorflight-configurator's own Makefile (PHONY targets,
# `## description` comments auto-listed by `make help`) so switching
# between sibling repos feels the same. Requires GNU Make — on Windows
# that means Git Bash/MSYS2 (already on PATH if you can run other git
# commands) or WSL; plain PowerShell/cmd.exe has no `make` of its own.
#
# Every target here is a thin wrapper over the npm scripts already
# defined in package.json/backend/package.json/frontend/package.json —
# `npm run <x>` still works directly, this just gives one consistent
# entry point across repos.

.DELETE_ON_ERROR:
.ONESHELL:
.SHELLFLAGS       := -eu -c
.DEFAULT_GOAL     := help

# Make's recipe shell here is bash (Git Bash/MSYS2's, even when `make`
# itself was launched from a plain cmd.exe/PowerShell window) — and
# invoking the bare `npm` on Windows means bash execs the extension-less
# POSIX-wrapper script Node's installer drops next to npm.cmd, resolved
# via a PATH entry like "C:\Program Files\nodejs". Something in that
# specific resolution path (which bash/make/MSYS build is involved
# varies by machine) chokes on the space in "Program Files" with
# "No such file or directory" even though the file is really there.
# Routing through cmd.exe instead sidesteps it entirely: cmd.exe is a
# real Windows executable with no spaces in its own path (always under
# System32) and does its own native PATH/PATHEXT resolution to npm.cmd,
# which handles "Program Files" the way every other Windows tool does.
#
# The switches are `//d //s //c`, not `/d /s /c` — a single leading
# slash reads to MSYS2/Cygwin's bash as the start of a POSIX absolute
# path (its own root, "/"), and its automatic argument-mangling layer
# (the same thing that turns a unix-style path argument into a Windows
# one for native .exe children) rewrites "/c ..." into something cmd.exe
# doesn't recognize as its /c switch at all — cmd.exe then silently just
# prints its banner and exits without ever running the command, no error
# emitted. Doubling the slash is bash's own escape for "don't touch
# this one" and is what actually gets a real /c through to cmd.exe here.
#
# $(OS) is Windows_NT even inside Git Bash (it's inherited from the
# Windows environment), so this only changes anything on Windows.
ifeq ($(OS),Windows_NT)
NPM := cmd.exe //d //s //c npm
else
NPM := npm
endif

# ========================================
# RULES
# ========================================

.PHONY: init
init: ## Install dependencies (root, backend, frontend)
	$(NPM) install
	$(NPM) --prefix backend install
	$(NPM) --prefix frontend install

.PHONY: dev
dev: ## Run the full dev stack (backend + frontend, hot-reloading)
	$(NPM) run dev

.PHONY: dev-backend
dev-backend: ## Run only the backend (Express, ts-node-dev)
	$(NPM) --prefix backend run dev

.PHONY: dev-frontend
dev-frontend: ## Run only the frontend (Vite dev server)
	$(NPM) --prefix frontend run dev

.PHONY: build
build: ## Build frontend + backend + electron main process
	$(NPM) run build

.PHONY: electron
electron: build ## Run the packaged Electron shell against a fresh build
	$(NPM) run electron:start

.PHONY: dist
dist: ## Build an installable package via electron-builder
	$(NPM) run dist

.PHONY: clean
clean: ## Remove build output (dist/ folders, release/)
	rm -fr backend/dist electron/dist frontend/dist release

.PHONY: distclean
distclean: clean ## clean, plus remove all node_modules
	rm -fr node_modules backend/node_modules frontend/node_modules

# ========================================
# HELP
# ========================================

blue      := $(shell tput setaf 4)
grey500   := $(shell tput setaf 244)
grey300   := $(shell tput setaf 240)
bold      := $(shell tput bold)
underline := $(shell tput smul)
reset     := $(shell tput sgr0)

.PHONY: help
help: ## Display this help
	@printf '\n'
	@printf '  $(underline)$(grey500)Targets$(reset)\n\n'
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*?##/ \
		{ printf "  $(grey300)make$(reset) $(bold)$(blue)%-20s$(reset) $(grey500)%s$(reset)\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)
	@printf '\n'
