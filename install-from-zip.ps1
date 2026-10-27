# MACD monitor Windows ZIP installer
# Download the repository ZIP, extract it, then double-click install-from-zip.bat.
# Git is not required. Python 3 is required.

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path $PSScriptRoot).Path
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
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    Read-Host 'Press Enter to exit'
    exit 1
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$Label) {
    Write-Host "[RUN] $Label"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
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
Write-Host '  MACD monitor ZIP installer (Windows)'
Write-Host "  Install: $AppDir"
Write-Host '=============================================================='

try {
    if (-not (Test-Path (Join-Path $AppDir 'macd-monitor\webui.py'))) {
        Stop-WithMessage 'Run this script from the extracted repository root.'
    }

    $systemPythonPath = Find-Python
    if (-not $systemPythonPath) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Host '[SETUP] Python not found. Trying to install Python 3.13 with winget...'
            & $winget.Source install --id Python.Python.3.13 --exact --scope user --accept-source-agreements --accept-package-agreements
            if ($LASTEXITCODE -eq 0) {
                Refresh-Path
                $systemPythonPath = Find-Python
            }
        }
    }
    if (-not $systemPythonPath) {
        Stop-WithMessage 'Python 3 was not found. Install it from https://www.python.org/downloads/windows/ and enable Add python.exe to PATH, then run this script again.'
    }
    Write-Host "[CHECK] Python: $systemPythonPath"

    Write-Host '[PATH] Using the extracted folder as the install directory.'
    Write-Host '[PATH] Runtime data in this folder will be preserved.'
    if (-not (Test-Path $Python)) {
        Invoke-Checked $systemPythonPath @('-m', 'venv', $VenvDir) 'Create Python virtual environment'
    }
    Invoke-Checked $Python @('-m', 'pip', 'install', '--upgrade', 'pip') 'Prepare pip'
    Invoke-Checked $Python @('-m', 'pip', 'install', 'requests') 'Install requests'

    if (-not (Test-Path $CodeDir)) {
        throw "Install directory is incomplete: $CodeDir"
    }
    Set-Location $CodeDir
    if (-not (Test-Path 'config.json')) {
        Copy-Item 'config.example.json' 'config.json'
        Write-Host '[CONFIG] Created config.json from the example.'
    } else {
        Write-Host '[CONFIG] Existing config.json was preserved.'
    }

    Invoke-Checked $Python @('monitor.py', '--report') 'Validate monitor'

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
        throw "Web UI failed to start. Check $WebErr"
    }

    $monitor = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'python.exe' -and $_.CommandLine -like "*$CodeDir*monitor.py*"
    })
    if ($monitor.Count -eq 0) {
        Start-Process -FilePath $Python -ArgumentList @('monitor.py') -WorkingDirectory $CodeDir `
            -RedirectStandardOutput $MonitorLog -RedirectStandardError $MonitorErr -WindowStyle Hidden
        Write-Host '[START] Monitor started in the background.'
    } else {
        Write-Host '[START] Monitor is already running.'
    }

    Start-Process $Url
    Write-Host ''
    Write-Host '==============================================================' -ForegroundColor Green
    Write-Host '  Installation complete. Browser opened.' -ForegroundColor Green
    Write-Host "  Local URL: $Url" -ForegroundColor Cyan
    Write-Host "  Install: $AppDir"
    Write-Host "  Web log: $WebLog"
    Write-Host "  Web error: $WebErr"
    Write-Host "  Monitor log: $MonitorLog"
    Write-Host "  Monitor error: $MonitorErr"
    Write-Host '==============================================================' -ForegroundColor Green
    Read-Host 'Press Enter to close'
} catch {
    Stop-WithMessage $_.Exception.Message
}
