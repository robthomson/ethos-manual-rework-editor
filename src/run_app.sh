#!/bin/bash
# Ethos Manual Translator Launcher
# This script makes it easy to run the app from source on Linux/macOS.

echo "========================================"
echo "Ethos Manual Translator"
echo "========================================"
echo ""

die() {
    echo ""
    echo "ERROR: $1"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
}

check_import() {
    local module="$1"
    python3 -c "import ${module}" &> /dev/null
}

if ! command -v python3 &> /dev/null; then
    die "Python 3 is not installed. Please install Python 3.9 or higher."
fi

echo "Python found: $(python3 --version)"
echo ""

echo "Checking GUI dependencies..."
if ! check_import "tkinter"; then
    echo "tkinter is missing."
    echo "macOS: install a Python build with Tk support (python.org installer recommended),"
    echo "or ensure tcl/tk is installed and discoverable."
    echo "Linux: install your distro package for Tk (e.g. python3-tk)."
    die "tkinter is required to run the app."
fi

if [ -f requirements_translator.txt ]; then
    python3 -m pip install -r requirements_translator.txt > /dev/null || \
        echo "WARNING: failed to install requirements_translator.txt automatically; run pip install manually if needed."
fi

echo ""
echo "Starting Ethos Manual Translator..."
echo ""

python3 app.py

if [ $? -ne 0 ]; then
    echo ""
    echo "ERROR: Failed to start the app"
    read -p "Press Enter to exit..."
    exit 1
fi

exit 0
