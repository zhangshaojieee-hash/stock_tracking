@echo off
chcp 65001 >nul
setlocal

:: Double-click this file to install. It creates a Python environment, starts Web UI and opens localhost.
echo Starting installer. Please keep this window open...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-from-zip.ps1"
set "INSTALL_EXIT=%errorlevel%"
echo.
if not "%INSTALL_EXIT%"=="0" echo Installation failed. See the error above.
pause
exit /b %INSTALL_EXIT%
