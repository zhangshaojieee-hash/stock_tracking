@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion

:: MACD monitor Windows installer
:: When run from a GitHub ZIP, it uses the local ZIP installer.
:: When downloaded alone, it uses the Git clone installer.

if exist "%~dp0macd-monitor\webui.py" if exist "%~dp0install-from-zip.bat" goto zip_install

set "REPO_URL=https://github.com/zhangshaojieee-hash/stock_tracking.git"
set "APP_DIR=%USERPROFILE%\macd-monitor"

echo ==============================================================
echo   MACD monitor installer (Windows)
echo   Install directory: %APP_DIR%
echo ==============================================================

:: ---------- 1. Check git ----------
where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] git was not found. Install it from: https://git-scm.com/download/win
    pause
    exit /b 1
)

:: ---------- 2. Check python ----------
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found. Install it from: https://www.python.org/downloads/
    echo        Enable "Add python.exe to PATH" during setup
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('python --version') do echo [OK] %%i

:: ---------- 3. Get source ----------
if exist "%APP_DIR%\macd-monitor\monitor.py" (
    echo [UPDATE] Existing source found. Pulling latest version...
    git -C "%APP_DIR%" pull --ff-only
) else (
    echo [CLONE] %REPO_URL% ...
    git clone "%REPO_URL%" "%APP_DIR%"
    if errorlevel 1 (
        echo [ERROR] Clone failed. Check network or proxy settings.
        pause
        exit /b 1
    )
)

:: ---------- 4. Install dependencies ----------
echo [SETUP] Installing Python dependency requests ...
python -m pip install --user -q requests
if errorlevel 1 (
    echo [ERROR] Dependency installation failed
    pause
    exit /b 1
)

:: ---------- 5. Initialize config ----------
cd /d "%APP_DIR%\macd-monitor"
if not exist config.json (
    copy config.example.json config.json >nul
    echo [CONFIG] Created config.json. Edit it to add your optional Feishu webhook.
) else (
    echo [CONFIG] Existing config.json preserved
)

:: ---------- 6. Validate ----------
echo [CHECK] Running status report...
python monitor.py --report
if errorlevel 1 (
    echo.
    echo [ERROR] Validation failed. Check the error above.
    pause
    exit /b 1
)

echo.
echo ==============================================================
echo   Installation complete!
echo.
echo   Start monitor: cd %APP_DIR%\macd-monitor ^&^& python monitor.py
echo   Start Web UI:  cd %APP_DIR%\macd-monitor ^&^& python webui.py
echo                 Open http://localhost:8688
echo.
echo   Feishu:       Edit %APP_DIR%\macd-monitor\config.json if needed
echo ==============================================================
pause
exit /b 0

:zip_install
call "%~dp0install-from-zip.bat"
set "ZIP_EXIT=%errorlevel%"
exit /b %ZIP_EXIT%
