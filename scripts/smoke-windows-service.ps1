param(
    [ValidateRange(0, 65535)]
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
    throw "smoke-windows-service.ps1 仅支持 Windows。"
}

$root = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $root "gallery-dl-backend"
$backendPython = Join-Path $backendDir ".venv\Scripts\python.exe"
$dedupPython = Join-Path $root ".venv\Scripts\python.exe"
$launcher = Join-Path $backendDir "run_backend.ps1"
$exampleConfig = Join-Path $backendDir "config.example.json"
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ldos-windows-service-smoke." + [Guid]::NewGuid().ToString("N"))

foreach ($required in @($backendPython, $dedupPython, $launcher, $exampleConfig)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Windows 服务 smoke 缺少文件：$required"
    }
}

function Get-FreeLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

if ($Port -eq 0) {
    $Port = Get-FreeLoopbackPort
}

$null = [System.IO.Directory]::CreateDirectory($workDir)
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:serverProcess = $null
$script:stdoutTask = $null
$script:stderrTask = $null
$script:serverMode = ""

function New-SmokeConfig {
    param(
        [ValidateSet("disabled", "missing-models")]
        [string]$Mode
    )

    $modeRoot = Join-Path $workDir $Mode
    $null = [System.IO.Directory]::CreateDirectory($modeRoot)
    $config = Get-Content -LiteralPath $exampleConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $runtimeDir = Join-Path $modeRoot "runtime"
    $credentialsDir = Join-Path $modeRoot "credentials"

    $config.runtime_dir = $runtimeDir
    $config.database_path = Join-Path $runtimeDir "backend.sqlite3"
    $config.default_output_root = Join-Path $runtimeDir "downloads"
    $config.allowed_output_roots = @((Join-Path $runtimeDir "downloads"))
    $config.allowed_config_roots = @($credentialsDir)
    $config.allowed_cookie_roots = @($credentialsDir)
    $config.server.host = "127.0.0.1"
    $config.server.port = $Port
    $config.gallery.repo_path = Join-Path $root "gallery-dl-codeberg"
    $config.gallery.cache_file = Join-Path $credentialsDir "managed\gallery-dl-cache.sqlite3"
    $config.gallery.python_executable = $backendPython
    $config.proxy.enabled = $false
    $config.proxy.auto_start = $false
    $config.dedup.enabled = ($Mode -eq "missing-models")
    $config.dedup.device = "cpu"
    $config.dedup.python_executable = $dedupPython
    $config.dedup.worker_script = Join-Path $root "dedup_review_worker.py"
    $config.dedup.core_script = Join-Path $root "dedup_core.py"
    $config.dedup.model_dir = Join-Path $modeRoot "missing-models"

    $destination = Join-Path $workDir "config-$Mode.json"
    $encoded = ($config | ConvertTo-Json -Depth 20) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($destination, $encoded, $utf8NoBom)
    return $destination
}

function Format-ServerLog {
    param($Result)
    return "stdout:`n$($Result.Stdout)`nstderr:`n$($Result.Stderr)"
}

function Stop-SmokeServer {
    if ($null -eq $script:serverProcess) {
        return $null
    }

    $process = $script:serverProcess
    $stdoutTask = $script:stdoutTask
    $stderrTask = $script:stderrTask
    $mode = $script:serverMode

    if (-not $process.HasExited) {
        & taskkill.exe /PID $process.Id /T /F *> $null
        $null = $process.WaitForExit(10000)
    }
    if (-not $process.HasExited) {
        $process.Kill($true)
        $process.WaitForExit()
    }

    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    [System.IO.File]::WriteAllText((Join-Path $workDir "server-$mode.stdout.log"), $stdout, $utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $workDir "server-$mode.stderr.log"), $stderr, $utf8NoBom)

    $result = [PSCustomObject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdout
        Stderr = $stderr
    }
    $process.Dispose()
    $script:serverProcess = $null
    $script:stdoutTask = $null
    $script:stderrTask = $null
    $script:serverMode = ""
    return $result
}

function Start-SmokeServer {
    param(
        [string]$ConfigPath,
        [string]$Mode
    )

    if ($null -ne $script:serverProcess) {
        throw "Windows 服务 smoke 已有后端进程在运行。"
    }

    $pwsh = Join-Path $PSHOME "pwsh.exe"
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwsh
    $startInfo.WorkingDirectory = $backendDir
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $startInfo.Environment["PYTHONUTF8"] = "1"
    $startInfo.Environment["PYTHONUNBUFFERED"] = "1"
    foreach ($argument in @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $launcher,
        "-Config",
        $ConfigPath,
        "-PortOverride",
        [string]$Port
    )) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "无法启动 Windows 后端 smoke 进程。"
    }
    $script:serverProcess = $process
    $script:stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $script:stderrTask = $process.StandardError.ReadToEndAsync()
    $script:serverMode = $Mode
}

function Wait-SmokeHealth {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($script:serverProcess.HasExited) {
            $result = Stop-SmokeServer
            throw "Windows 后端在通过 /healthz 前退出（exit=$($result.ExitCode)）。`n$(Format-ServerLog $result)"
        }
        try {
            $body = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
            if ($body.ok -eq $true) {
                return
            }
        } catch {
            # 服务仍在启动时连接失败属于预期，继续轮询。
        }
        Start-Sleep -Milliseconds 250
    }

    $result = Stop-SmokeServer
    throw "Windows 后端未在 45 秒内通过 /healthz。`n$(Format-ServerLog $result)"
}

$assertDisabled = @'
import json
import sys
import urllib.request
with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/readyz", timeout=5) as response:
    body = json.load(response)
    assert response.status == 200 and body["ready"] is True
    assert body["components"]["dedup"]["status"] == "disabled"
'@

$assertMissingModels = @'
import json
import sys
import urllib.error
import urllib.request
try:
    urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/readyz", timeout=10)
except urllib.error.HTTPError as exc:
    body = json.load(exc)
    assert exc.code == 503 and body["ready"] is False
    assert body["components"]["dedup"]["status"] == "error"
else:
    raise AssertionError("模型缺失时 /readyz 不应返回 200")
'@

try {
    $disabledConfig = New-SmokeConfig -Mode "disabled"
    Start-SmokeServer -ConfigPath $disabledConfig -Mode "disabled"
    Wait-SmokeHealth
    & $backendPython -c $assertDisabled ([string]$Port)
    if ($LASTEXITCODE -ne 0) {
        throw "Windows 禁用去重 readyz 断言失败。"
    }
    $null = Stop-SmokeServer

    $missingConfig = New-SmokeConfig -Mode "missing-models"
    Start-SmokeServer -ConfigPath $missingConfig -Mode "missing-models"
    Wait-SmokeHealth
    & $backendPython -c $assertMissingModels ([string]$Port)
    if ($LASTEXITCODE -ne 0) {
        throw "Windows 缺模型 readyz 断言失败。"
    }
    $null = Stop-SmokeServer

    Write-Host "Windows 服务 smoke 通过：healthz=200，禁用去重 readyz=200，缺模型 readyz=503。"
} finally {
    try {
        $null = Stop-SmokeServer
    } catch {
        Write-Warning "清理 Windows smoke 后端进程失败：$($_.Exception.Message)"
    }
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
