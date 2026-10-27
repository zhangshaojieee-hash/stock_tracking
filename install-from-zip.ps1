# MACD 监控 Windows ZIP 一键安装器
# 用法: 将仓库下载为 ZIP、解压后，双击 install-from-zip.bat。
# 安装器不需要 Git；只需要 Windows PowerShell 5.1 和 Python 3。

$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path $PSScriptRoot).Path
$AppDir = Join-Path $env:USERPROFILE 'macd-monitor'
$CodeDir = Join-Path $AppDir 'macd-monitor'
$VenvDir = Join-Path $AppDir '.venv'
$Python = Join-Path $VenvDir 'Scripts\python.exe'
$WebLog = Join-Path $CodeDir 'webui.install.log'
$WebErr = Join-Path $CodeDir 'webui.install.err.log'
$MonitorLog = Join-Path $CodeDir 'monitor.install.log'
$MonitorErr = Join-Path $CodeDir 'monitor.install.err.log'
$Url = 'http://localhost:8688/'

function Stop-WithMessage([string]$Message) {
    Write-Host ''
    Write-Host "[错误] $Message" -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$Label) {
    Write-Host "[执行] $Label"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label 失败，退出码 $LASTEXITCODE"
    }
}

function Test-PythonExecutable([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        & $Path --version *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Find-Python {
    $candidates = New-Object System.Collections.Generic.List[string]

    foreach ($root in @(
        (Join-Path $env:LocalAppData 'Programs\Python'),
        (Join-Path $env:ProgramFiles 'Python'),
        (Join-Path ${env:ProgramFiles(x86)} 'Python'),
        (Join-Path $env:USERPROFILE '.pyenv\pyenv-win\versions')
    )) {
        if (Test-Path -LiteralPath $root) {
            Get-ChildItem -LiteralPath $root -Recurse -Filter 'python.exe' -File -ErrorAction SilentlyContinue |
                Sort-Object FullName -Descending |
                ForEach-Object { $candidates.Add($_.FullName) }
        }
    }

    if ($env:VIRTUAL_ENV) {
        $candidates.Add((Join-Path $env:VIRTUAL_ENV 'Scripts\python.exe'))
    }

    foreach ($name in @('python.exe', 'py.exe')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and $command.Source -notlike '*\WindowsApps\*') {
            $candidates.Add($command.Source)
        }
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (Test-PythonExecutable $candidate) {
            return $candidate
        }
    }
    return $null
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

Write-Host '=============================================================='
Write-Host '  MACD 监控 ZIP 一键安装 (Windows)'
Write-Host "  源码目录: $SourceRoot"
Write-Host "  安装目录: $AppDir"
Write-Host '=============================================================='

try {
    if (-not (Test-Path (Join-Path $SourceRoot 'macd-monitor\webui.py'))) {
        Stop-WithMessage '请从仓库 ZIP 解压后的根目录运行此脚本。'
    }

    $systemPythonPath = Find-Python
    if (-not $systemPythonPath) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Host '[安装] 未检测到 Python，尝试使用 Windows 包管理器安装 Python 3.13...'
            & $winget.Source install --id Python.Python.3.13 --exact --scope user --accept-source-agreements --accept-package-agreements
            if ($LASTEXITCODE -eq 0) {
                Refresh-Path
                $systemPythonPath = Find-Python
            }
        }
    }
    if (-not $systemPythonPath) {
        Stop-WithMessage '未检测到 Python 3。请先安装 https://www.python.org/downloads/windows/，安装时勾选 Add python.exe to PATH，然后重新运行此脚本。'
    }
    Write-Host "[检查] Python: $systemPythonPath"

    if (-not (Test-Path $AppDir)) {
        New-Item -ItemType Directory -Path $AppDir | Out-Null
    }
    if ((Resolve-Path $SourceRoot).Path -ne (Resolve-Path $AppDir).Path) {
        Write-Host '[复制] 正在复制源码到安装目录，保留已有运行数据...'
        $items = Get-ChildItem -LiteralPath $SourceRoot -Force
        foreach ($item in $items) {
            $destination = Join-Path $AppDir $item.Name
            if ($item.Name -in @('.git', '.venv')) { continue }
            if ($item.PSIsContainer) {
                $sourceChild = $item.FullName
                $destinationChild = Join-Path $AppDir $item.Name
                if (-not (Test-Path $destinationChild)) { New-Item -ItemType Directory -Path $destinationChild | Out-Null }
                Get-ChildItem -LiteralPath $sourceChild -Recurse -File -Force | ForEach-Object {
                    $relative = $_.FullName.Substring($SourceRoot.Length).TrimStart('\')
                    if ($relative -match '(^|\\)(config\.json|data\.db($|-)|state\.json|.*\.log$|.*\.bak$|.*\.db-(shm|wal)$)') { return }
                    $target = Join-Path $AppDir $relative
                    $parent = Split-Path $target -Parent
                    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
                    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
                }
            } elseif ($item.Name -notmatch '^(config\.json|data\.db($|-)|state\.json|.*\.log$|.*\.bak$)$') {
                Copy-Item -LiteralPath $item.FullName -Destination $destination -Force
            }
        }
    }

    if (-not (Test-Path $Python)) {
        Invoke-Checked $systemPythonPath @('-m', 'venv', $VenvDir) '创建 Python 虚拟环境'
    }
    Invoke-Checked $Python @('-m', 'pip', 'install', '--upgrade', 'pip') '准备 Python 包管理器'
    Invoke-Checked $Python @('-m', 'pip', 'install', 'requests') '安装 Python 依赖 requests'

    if (-not (Test-Path $CodeDir)) {
        throw "安装目录不完整: $CodeDir"
    }
    Set-Location $CodeDir
    if (-not (Test-Path 'config.json')) {
        Copy-Item 'config.example.json' 'config.json'
        Write-Host '[配置] 已生成 config.json，默认使用示例股票。'
    } else {
        Write-Host '[配置] 已存在 config.json，保留现有配置。'
    }

    Invoke-Checked $Python @('monitor.py', '--report') '验证监控程序'

    $old = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'python.exe' -and $_.CommandLine -like "*$CodeDir*webui.py*"
    })
    foreach ($process in $old) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $previousHost = $env:WEBUI_HOST
    $env:WEBUI_HOST = '127.0.0.1'
    try {
        Start-Process -FilePath $Python -ArgumentList @('webui.py') -WorkingDirectory $CodeDir `
            -RedirectStandardOutput $WebLog -RedirectStandardError $WebErr -WindowStyle Hidden
    } finally {
        $env:WEBUI_HOST = $previousHost
    }

    $ready = $false
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        Start-Sleep -Seconds 1
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                $ready = $true
                break
            }
        } catch { }
    }
    if (-not $ready) {
        throw "Web UI 启动失败，请查看 $WebErr"
    }

    $monitor = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'python.exe' -and $_.CommandLine -like "*$CodeDir*monitor.py*"
    })
    if ($monitor.Count -eq 0) {
        Start-Process -FilePath $Python -ArgumentList @('monitor.py') -WorkingDirectory $CodeDir `
            -RedirectStandardOutput $MonitorLog -RedirectStandardError $MonitorErr -WindowStyle Hidden
        Write-Host '[启动] 监控程序已在后台启动。'
    } else {
        Write-Host '[启动] 监控程序已经在运行。'
    }

    Start-Process $Url
    Write-Host ''
    Write-Host '==============================================================' -ForegroundColor Green
    Write-Host '  安装完成，浏览器已打开。' -ForegroundColor Green
    Write-Host "  本地地址: $Url" -ForegroundColor Cyan
    Write-Host "  安装目录: $AppDir"
    Write-Host "  Web UI 日志: $WebLog"
    Write-Host "  Web UI 错误: $WebErr"
    Write-Host "  监控日志: $MonitorLog"
    Write-Host "  监控错误: $MonitorErr"
    Write-Host '==============================================================' -ForegroundColor Green
    Read-Host '按回车关闭安装窗口'
} catch {
    Stop-WithMessage $_.Exception.Message
}
