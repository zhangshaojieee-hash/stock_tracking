param(
    [switch]$ResetTunnel
)

$ErrorActionPreference = 'Stop'

$AppRoot = 'D:\macd'
$CodeRoot = Join-Path $AppRoot 'macd-monitor'
$Python = Join-Path $AppRoot '.venv\Scripts\python.exe'
$Cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$Port = 8688
$WebLog = Join-Path $CodeRoot 'webui.out.log'
$WebErr = Join-Path $CodeRoot 'webui.err.log'
$MonitorLog = Join-Path $CodeRoot 'monitor.out.log'
$MonitorErr = Join-Path $CodeRoot 'monitor.err.log'
$TunnelLog = Join-Path $AppRoot 'cloudflared.out.log'
$TunnelErr = Join-Path $AppRoot 'cloudflared.err.log'
$TunnelArgs = @('tunnel', '--protocol', 'http2', '--url', 'http://127.0.0.1:8688')
$UrlFile = Join-Path $AppRoot 'cloudflare-url.txt'
$ConfigPath = Join-Path $CodeRoot 'config.json'
$Docker = 'D:\Docker\resources\bin\docker.exe'
$DockerDesktop = 'D:\Docker\Docker Desktop.exe'
$RssHubName = 'macd-rsshub'
$RssHubImage = 'diygod/rsshub:latest'
$RssHubProxy = 'http://host.docker.internal:7897'

function Get-ProjectProcess([string]$Pattern) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like "*$Pattern*" }
}

function Restart-ProjectProcesses {
    foreach ($pattern in @('webui.py', 'monitor.py')) {
        $processes = @(Get-ProjectProcess $pattern)
        foreach ($process in $processes) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped old process: $pattern (PID $($process.ProcessId))"
        }
    }
    Start-Sleep -Milliseconds 500
}

function Start-ProjectProcess([string]$Pattern, [string]$Arguments, [string]$OutFile, [string]$ErrFile) {
    if (Get-ProjectProcess $Pattern) {
        Write-Host "Already running: $Pattern"
        return
    }
    Start-Process -FilePath $Python -ArgumentList $Arguments -WorkingDirectory $CodeRoot `
        -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -WindowStyle Hidden
    Write-Host "Started: $Pattern"
}

function Test-WebUiRunning {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Ensure-RssHub {
    if (-not (Test-Path $Docker)) {
        Write-Warning "Docker CLI not found: $Docker. RSSHub will rely on Docker Desktop's existing state."
        return
    }

    $dockerDir = Split-Path $Docker -Parent
    if (-not (($env:Path -split ';') -contains $dockerDir)) {
        $env:Path = "$dockerDir;$env:Path"
    }

    try {
        & $Docker info *> $null
        if ($LASTEXITCODE -ne 0) {
            if (Test-Path $DockerDesktop) {
                Write-Host 'Starting Docker Desktop for RSSHub...'
                Start-Process -FilePath $DockerDesktop -WorkingDirectory (Split-Path $DockerDesktop -Parent)
            } else {
                Write-Warning "Docker Desktop executable not found: $DockerDesktop"
                return
            }
            $ready = $false
            for ($attempt = 1; $attempt -le 60; $attempt++) {
                Start-Sleep -Seconds 2
                & $Docker info *> $null
                if ($LASTEXITCODE -eq 0) {
                    $ready = $true
                    break
                }
            }
            if (-not $ready) {
                Write-Warning 'Docker Desktop did not become ready within 120 seconds. MACD will start, but RSSHub may be unavailable.'
                return
            }
            Write-Host 'Docker Desktop is ready.'
        }

        $container = (& $Docker ps -a --filter "name=^/$RssHubName$" --format '{{.Names}}|{{.State}}')
        if ($container -match "^$RssHubName\|running$") {
            Write-Host "Already running: $RssHubName"
            return
        }
        if ($container) {
            & $Docker start $RssHubName | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Started: $RssHubName"
            } else {
                Write-Warning "Could not start existing RSSHub container: $RssHubName"
            }
            return
        }

        Write-Host "Creating: $RssHubName"
        & $Docker run -d --name $RssHubName --restart unless-stopped `
            -p '127.0.0.1:1200:1200' `
            -e "HTTP_PROXY=$RssHubProxy" -e "HTTPS_PROXY=$RssHubProxy" -e "ALL_PROXY=$RssHubProxy" `
            $RssHubImage | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not create RSSHub container: $RssHubName"
        }
    } catch {
        Write-Warning "RSSHub startup check failed: $($_.Exception.Message)"
    }
}

function Send-FeishuStartupNotification([string]$PhoneUrl, [string]$AuthToken, $Config) {
    $webhook = [string]$Config.webhook_url
    if ([string]::IsNullOrWhiteSpace($webhook)) {
        Write-Host 'Skipped: Feishu webhook is not configured'
        return
    }
    if ([string]::IsNullOrWhiteSpace($PhoneUrl)) {
        Write-Warning 'Skipped Feishu startup notification: phone URL is unavailable'
        return
    }

    $startedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $tokenText = if ([string]::IsNullOrWhiteSpace($AuthToken)) { 'not configured' } else { $AuthToken }
    $payload = @{
        msg_type = 'interactive'
        card = @{
            config = @{ wide_screen_mode = $true }
            header = @{
                template = 'blue'
                title = @{ tag = 'plain_text'; content = 'MACD Monitor Started' }
            }
            elements = @(
                @{ tag = 'div'; text = @{ tag = 'lark_md'; content = "**Phone URL**`n$PhoneUrl" } }
                @{ tag = 'hr' }
                @{ tag = 'div'; text = @{ tag = 'lark_md'; content = "**Access token**`n$tokenText" } }
                @{ tag = 'hr' }
                @{ tag = 'div'; text = @{ tag = 'lark_md'; content = "Started: $startedAt`nThe temporary URL may change after restart." } }
            )
        }
    }

    $hmac = $null
    try {
        $secret = [string]$Config.webhook_secret
        if (-not [string]::IsNullOrWhiteSpace($secret)) {
            $timestamp = [string][int][double]((Get-Date).ToUniversalTime().Subtract([datetime]'1970-01-01').TotalSeconds)
            $toSign = "$timestamp`n$secret"
            $hmac = New-Object System.Security.Cryptography.HMACSHA256
            # Feishu signs an empty message with timestamp + newline + secret as the HMAC key.
            $hmac.Key = [Text.Encoding]::UTF8.GetBytes($toSign)
            $digest = $hmac.ComputeHash([byte[]]@())
            $payload.timestamp = $timestamp
            $payload.sign = [Convert]::ToBase64String($digest)
        }

        $body = $payload | ConvertTo-Json -Depth 5 -Compress
        $response = Invoke-RestMethod -Method Post -Uri $webhook `
            -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 10
        if ($response.code -eq 0 -or $response.StatusCode -eq 0) {
            Write-Host 'Feishu startup notification sent' -ForegroundColor Green
        } else {
            Write-Warning "Feishu startup notification failed: $($response | ConvertTo-Json -Compress)"
        }
    } catch {
        Write-Warning "Feishu startup notification failed: $($_.Exception.Message)"
    } finally {
        if ($hmac) { $hmac.Dispose() }
    }
}

if (-not (Test-Path $Python)) {
    throw "Python environment not found: $Python"
}
if (-not (Test-Path $Cloudflared)) {
    throw "cloudflared not found: $Cloudflared"
}
if (-not (Test-Path $ConfigPath)) {
    throw "Missing config.json: $ConfigPath"
}

if ($ResetTunnel) {
    $oldTunnels = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*tunnel*8688*' })
    foreach ($oldTunnel in $oldTunnels) {
        Stop-Process -Id $oldTunnel.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Cleared old Cloudflare Tunnel and URL.' -ForegroundColor Yellow
}

$config = $null
$configError = $null
for ($attempt = 1; $attempt -le 5 -and -not $config; $attempt++) {
    try {
        $configText = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)
        $config = $configText | ConvertFrom-Json
    } catch {
        $configError = $_
        if ($attempt -lt 5) {
            Start-Sleep -Milliseconds 250
        }
    }
}
if (-not $config) {
    throw "Invalid UTF-8 config.json after 5 attempts: $($configError.Exception.Message)"
}
if (@($config.stocks).Count -eq 0) {
    Write-Warning "config.json has no stocks. monitor.py will exit until stocks are configured."
}
$authToken = [string]$config.webui.auth_token

Ensure-RssHub
Restart-ProjectProcesses

if (Test-WebUiRunning) {
    Write-Host 'Already running: webui.py'
} else {
    Start-ProjectProcess 'webui.py' 'webui.py' $WebLog $WebErr
}
if (@($config.stocks).Count -gt 0) {
    Start-ProjectProcess 'monitor.py' 'monitor.py' $MonitorLog $MonitorErr
} else {
    Write-Host 'Skipped: monitor.py (no stocks in config.json)' -ForegroundColor Yellow
}

$Tunnel = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*tunnel*8688*' }
if ($Tunnel) {
    Write-Host 'Already running: cloudflared tunnel'
} else {
    Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $Cloudflared `
        -ArgumentList $TunnelArgs `
        -WorkingDirectory $AppRoot -RedirectStandardOutput $TunnelLog `
        -RedirectStandardError $TunnelErr -WindowStyle Hidden
    Write-Host 'Started: cloudflared tunnel'
}

Start-Sleep -Seconds 3
$url = $null
for ($i = 0; $i -lt 30 -and -not $url; $i++) {
    foreach ($log in @($TunnelLog, $TunnelErr)) {
        if (-not $url -and (Test-Path $log)) {
            $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
            if ($text) {
                $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
                if ($match.Success) {
                    $url = $match.Value
                }
            }
        }
    }
    if (-not $url) {
        Start-Sleep -Seconds 1
    }
}
if ($url) {
    Set-Content -Path $UrlFile -Value $url -Encoding ascii
    Write-Host ''
    Write-Host 'Phone URL:' -ForegroundColor Green
    Write-Host $url -ForegroundColor Cyan
    Write-Host "URL saved to: $UrlFile"
} elseif (Test-Path $UrlFile) {
    $url = (Get-Content $UrlFile -Raw).Trim()
    Write-Host "Phone URL from previous start: $url" -ForegroundColor Yellow
} else {
    Write-Warning "Tunnel started, but URL is not ready yet. Check $TunnelLog"
}

Send-FeishuStartupNotification $url $authToken $config

try {
    $headers = @{}
    if ($authToken) {
        $headers['Authorization'] = "Bearer $authToken"
    }
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" `
        -Headers $headers -UseBasicParsing -TimeoutSec 10
    Write-Host "Web UI health check: $($health.StatusCode) OK" -ForegroundColor Green
} catch {
    Write-Warning "Web UI is still starting. Check $WebErr if it does not become available."
}

Write-Host ''
Write-Host 'Startup complete. Keep this computer on for phone access.'
