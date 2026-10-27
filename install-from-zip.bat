@echo off
chcp 65001 >nul
setlocal

:: 双击此文件即可安装。安装器会创建独立 Python 环境、启动 Web UI 并打开 localhost。
echo 正在启动安装器，请不要关闭此窗口...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-from-zip.ps1"
set "INSTALL_EXIT=%errorlevel%"
echo.
if not "%INSTALL_EXIT%"=="0" echo 安装失败，请根据上方错误信息处理。
pause
exit /b %INSTALL_EXIT%
