[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo,
    [string]$XgBaseUrl = "http://127.0.0.1:18080"
)

$ErrorActionPreference = "Stop"
$requiredBase = "d36c00786c20946475a06bc200945de66ad1d50a"
$target = (Resolve-Path -LiteralPath $TargetRepo).Path
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check([string]$Name, [string]$Status, [string]$Detail, [bool]$Required = $true) {
    $checks.Add([pscustomobject]@{
        Name = $Name
        Status = $Status
        Required = $Required
        Detail = $Detail
    })
}

function Command-Version([string]$Command, [string[]]$Arguments) {
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $resolved) { return $null }
    try { return ((& $resolved.Source @Arguments 2>&1 | Select-Object -First 1) -join " ").Trim() }
    catch { return $resolved.Source }
}

function Git-ExitCode([string[]]$Arguments) {
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command git.exe -ErrorAction Stop).Source
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Arguments = ((@("-C", $target) + $Arguments) | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join " "
    $process = [System.Diagnostics.Process]::Start($info)
    $process.StandardOutput.ReadToEnd() | Out-Null
    $process.StandardError.ReadToEnd() | Out-Null
    $process.WaitForExit()
    return $process.ExitCode
}

$repoValid = (Test-Path -LiteralPath (Join-Path $target ".git")) -and
    (Test-Path -LiteralPath (Join-Path $target "web\package.json")) -and
    (Test-Path -LiteralPath (Join-Path $target "canvas-agent\package.json"))
Add-Check "Infinite Canvas 仓库" $(if ($repoValid) { "PASS" } else { "FAIL" }) $target

if ($repoValid) {
    $hasBase = (Git-ExitCode @("cat-file", "-e", "$requiredBase^{commit}")) -eq 0
    if ($hasBase) {
        $hasBase = (Git-ExitCode @("merge-base", "--is-ancestor", $requiredBase, "HEAD")) -eq 0
    }
    Add-Check "XG 工作流基线" $(if ($hasBase) { "PASS" } else { "FAIL" }) "要求包含 $requiredBase"

    $status = (& git -C $target status --short 2>$null) -join "; "
    Add-Check "Git 工作区" $(if ($status) { "WARN" } else { "PASS" }) $(if ($status) { "存在本地修改，安装前将备份；补丁冲突时会停止" } else { "干净" }) $false
}

$node = Command-Version "node" @("--version")
$npm = Command-Version "npm.cmd" @("--version")
$python = Command-Version "py.exe" @("-3.11", "--version")
$uv = Command-Version "uv.exe" @("--version")
$codex = Command-Version "codex" @("--version")

Add-Check "Node.js" $(if ($node) { "PASS" } else { "FAIL" }) $(if ($node) { $node } else { "需要 Node.js 18+" })
Add-Check "npm" $(if ($npm) { "PASS" } else { "FAIL" }) $(if ($npm) { $npm } else { "未找到 npm.cmd" })
Add-Check "Python 3.11" $(if ($python) { "PASS" } else { "FAIL" }) $(if ($python) { $python } else { "未找到 py -3.11" })
Add-Check "uv" $(if ($uv) { "PASS" } else { "FAIL" }) $(if ($uv) { $uv } else { "未找到 uv.exe" })
Add-Check "Codex CLI" $(if ($codex) { "PASS" } else { "WARN" }) $(if ($codex) { $codex } else { "注册 MCP 前需要 Codex CLI" }) $false

$ffmpeg = Join-Path $target "tools\media-runtime\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
Add-Check "FFmpeg" $(if (Test-Path -LiteralPath $ffmpeg) { "PASS" } else { "WARN" }) $(if (Test-Path -LiteralPath $ffmpeg) { $ffmpeg } else { "安装工作流后由迁移包提供" }) $false

$aligner = Join-Path $target "tools\local-aligner\.venv\Scripts\local-aligner.exe"
Add-Check "Local Aligner" $(if (Test-Path -LiteralPath $aligner) { "PASS" } else { "WARN" }) $(if (Test-Path -LiteralPath $aligner) { $aligner } else { "安装后运行 Initialize-Environment.ps1" }) $false

Add-Check "MiniMax 凭据" $(if ($env:MINIMAX_API_KEY) { "PASS" } else { "WARN" }) $(if ($env:MINIMAX_API_KEY) { "环境变量已设置，未显示内容" } else { "真实 TTS 前设置 MINIMAX_API_KEY" }) $false

try {
    $response = Invoke-WebRequest -Uri $XgBaseUrl -Method Get -TimeoutSec 3 -UseBasicParsing
    Add-Check "XG 服务" "PASS" "$XgBaseUrl HTTP $($response.StatusCode)" $false
}
catch {
    $httpStatus = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $httpStatus = [int]$_.Exception.Response.StatusCode
    }
    if ($httpStatus) {
        Add-Check "XG 服务" "PASS" "$XgBaseUrl 可访问，HTTP $httpStatus" $false
    }
    else {
        Add-Check "XG 服务" "WARN" "$XgBaseUrl 当前不可访问；生图前启动服务" $false
    }
}

$checks | Format-Table Name, Status, Required, Detail -AutoSize -Wrap
$failed = @($checks | Where-Object { $_.Required -and $_.Status -eq "FAIL" })
if ($failed.Count) {
    Write-Error "环境检查未通过：$($failed.Name -join '、')"
    exit 1
}

Write-Host "环境基础检查通过。WARN 项可在安装或真实验收前处理。" -ForegroundColor Green
