@echo off
chcp 65001 >nul
setlocal

:: 双击此文件即可安装。安装器会创建独立 Python 环境、启动 Web UI 并打开 localhost。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-from-zip.ps1"
if errorlevel 1 (
    echo.
    echo 安装失败，请查看上方错误信息。
    pause
)
endlocal
