@echo off
chcp 65001 >nul
set "URL_FILE=D:\macd\cloudflare-url.txt"

echo 正在清理旧的 Cloudflare 地址和 Tunnel...
if exist "%URL_FILE%" del /f /q "%URL_FILE%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\macd\start_macd.ps1" -ResetTunnel

if exist "%URL_FILE%" (
    echo.
    echo 新的手机访问地址：
    type "%URL_FILE%"
) else (
    echo.
    echo [警告] 新地址尚未生成，请查看 D:\macd\cloudflared.err.log
)
echo.
echo 启动命令已执行。请使用上面显示的新地址。
pause
