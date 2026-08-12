@echo off
setlocal
cd /d %~dp0

if not defined TRANSLATOR_VERSION set TRANSLATOR_VERSION=0.1.0

echo [1/6] Checking for pyinstaller...
pyinstaller --version >nul 2>&1
if errorlevel 1 (
    echo PyInstaller not found. Installing...
    pip install pyinstaller || goto :error
)

echo [2/6] Generating version info (%TRANSLATOR_VERSION%)...
python gen_version_info.py || goto :error

echo [3/6] Compiling app.py to standalone EXE...
python -m PyInstaller --onefile --noupx app.py --name ethos-manual-translator --windowed --version-file version_info.txt --icon icon.ico --add-data "icon.ico;." || goto :error

echo [4/6] Moving ethos-manual-translator.exe into parent folder...
if exist ..\ethos-manual-translator.exe (
    del ..\ethos-manual-translator.exe
)
move /Y dist\ethos-manual-translator.exe ..\ethos-manual-translator.exe >nul

echo [5/6] Cleaning up build tree...
rd /s /q build
rd /s /q dist
del /q ethos-manual-translator.spec

echo [6/6] Build complete. ethos-manual-translator.exe is ready at: ..\ethos-manual-translator.exe
goto :eof

:error
echo Build failed.
exit /b 1
