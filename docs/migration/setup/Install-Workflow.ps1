[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo,
    [switch]$AllowDifferentBase
)

$ErrorActionPreference = "Stop"
$packageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$target = (Resolve-Path -LiteralPath $TargetRepo).Path
$baseCommit = "d36c00786c20946475a06bc200945de66ad1d50a"
$patchFile = Join-Path $packageRoot "payload\patches\story-workflow.patch"
$overlayRoot = Join-Path $packageRoot "payload\overlay"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $target ".story-workflow-backups\$timestamp"

function Invoke-GitCapture([string[]]$Arguments) {
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command git.exe -ErrorAction Stop).Source
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Arguments = ((@("-C", $target) + $Arguments) | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join " "
    $process = [System.Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

if (-not (Test-Path -LiteralPath (Join-Path $target ".git"))) {
    throw "目标不是 Git 仓库：$target"
}
if (-not (Test-Path -LiteralPath (Join-Path $target "web\package.json")) -or -not (Test-Path -LiteralPath (Join-Path $target "canvas-agent\package.json"))) {
    throw "目标不是预期的 Infinite Canvas 工程：$target"
}

$gitResult = Invoke-GitCapture @("cat-file", "-e", "$baseCommit^{commit}")
$containsBase = $gitResult.ExitCode -eq 0
if ($containsBase) {
    $gitResult = Invoke-GitCapture @("merge-base", "--is-ancestor", $baseCommit, "HEAD")
    $containsBase = $gitResult.ExitCode -eq 0
}
if (-not $containsBase -and -not $AllowDifferentBase) {
    throw "目标仓库不包含迁移基线 $baseCommit。请让 Codex 先评估版本差异，确认后使用 -AllowDifferentBase。"
}

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$workingDiff = & git -C $target diff --binary
if ($workingDiff) {
    [System.IO.File]::WriteAllLines((Join-Path $backupRoot "pre-install-working-tree.patch"), [string[]]$workingDiff, [System.Text.UTF8Encoding]::new($false))
}
(& git -C $target status --short) | Set-Content -LiteralPath (Join-Path $backupRoot "pre-install-status.txt") -Encoding utf8

$patchStatus = "not-present"
if (Test-Path -LiteralPath $patchFile) {
    $gitResult = Invoke-GitCapture @("apply", "--check", "--whitespace=nowarn", $patchFile)
    if ($gitResult.ExitCode -eq 0) {
        $gitResult = Invoke-GitCapture @("apply", "--whitespace=nowarn", $patchFile)
        if ($gitResult.ExitCode -ne 0) { throw "源码补丁应用失败：$($gitResult.Stderr.Trim())。备份位于 $backupRoot" }
        $patchStatus = "applied"
    }
    else {
        $gitResult = Invoke-GitCapture @("apply", "--reverse", "--check", "--whitespace=nowarn", $patchFile)
        if ($gitResult.ExitCode -eq 0) {
            $patchStatus = "already-applied"
        }
        else {
            throw "源码补丁与目标代码冲突。没有强行覆盖；备份位于 $backupRoot"
        }
    }
}

$copied = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $overlayRoot) {
    Get-ChildItem -LiteralPath $overlayRoot -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($overlayRoot.Length).TrimStart('\')
        $destination = Join-Path $target $relative
        if (Test-Path -LiteralPath $destination) {
            $backup = Join-Path $backupRoot "overlay-before\$relative"
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
            Copy-Item -LiteralPath $destination -Destination $backup -Force
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
        $copied.Add($relative)
    }
}

$workflowTarget = Join-Path $target "workflow\story-production"
New-Item -ItemType Directory -Force -Path $workflowTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $packageRoot "workflow") -Force | Copy-Item -Destination $workflowTarget -Recurse -Force

$templateTarget = Join-Path $target "workflow\story-production\project-template"
New-Item -ItemType Directory -Force -Path $templateTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $packageRoot "project-template") -Force | Copy-Item -Destination $templateTarget -Recurse -Force

$examplesTarget = Join-Path $target "workflow\story-production\examples"
New-Item -ItemType Directory -Force -Path $examplesTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $packageRoot "examples") -Force | Copy-Item -Destination $examplesTarget -Recurse -Force

$configTarget = Join-Path $target "workflow.config.json"
if (-not (Test-Path -LiteralPath $configTarget)) {
    Copy-Item -LiteralPath (Join-Path $packageRoot "workflow.config.example.json") -Destination $configTarget
}

$agentsPath = Join-Path $target "AGENTS.md"
$begin = "<!-- BEGIN STORY PRODUCTION WORKFLOW -->"
$end = "<!-- END STORY PRODUCTION WORKFLOW -->"
$agentsBlock = @"
$begin
## 人生剧本生产工作流

当用户提供新剧本并要求制作人生副本、图文故事或系列图片视频时，必须先阅读 `workflow/story-production/STORY_PRODUCTION_PLAYBOOK.md`。先计算 TTS 时长并给出章节、场景复用、人物阶段和分镜密度计划；用户确认后再执行。固定交付无字幕无音轨视频、独立 48kHz 配音、自然断句 SRT、审核工作台、9:16 封面和发布文案。
$end
"@
$agentsContent = if (Test-Path -LiteralPath $agentsPath) { Get-Content -LiteralPath $agentsPath -Encoding UTF8 -Raw } else { "# AGENTS.md`r`n" }
$pattern = [regex]::Escape($begin) + ".*?" + [regex]::Escape($end)
if ([regex]::IsMatch($agentsContent, $pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)) {
    $agentsContent = [regex]::Replace($agentsContent, $pattern, $agentsBlock.Trim(), [System.Text.RegularExpressions.RegexOptions]::Singleline)
}
else {
    $agentsContent = $agentsContent.TrimEnd() + "`r`n`r`n" + $agentsBlock.Trim() + "`r`n"
}
[System.IO.File]::WriteAllText($agentsPath, $agentsContent, [System.Text.UTF8Encoding]::new($false))

$gitIgnorePath = Join-Path $target ".gitignore"
$gitIgnoreContent = if (Test-Path -LiteralPath $gitIgnorePath) { Get-Content -LiteralPath $gitIgnorePath -Encoding UTF8 -Raw } else { "" }
foreach ($entry in @(".story-workflow.local.ps1", ".story-workflow-backups/", "**/.venv/", ".runtime/")) {
    if ($gitIgnoreContent -notmatch "(?m)^$([regex]::Escape($entry))\s*$") {
        $gitIgnoreContent = $gitIgnoreContent.TrimEnd() + "`r`n" + $entry + "`r`n"
    }
}
[System.IO.File]::WriteAllText($gitIgnorePath, $gitIgnoreContent, [System.Text.UTF8Encoding]::new($false))

$receipt = [ordered]@{
    schema_version = "1.0"
    installed_at = (Get-Date).ToString("o")
    package = Split-Path $packageRoot -Leaf
    target = $target
    target_head = (& git -C $target rev-parse HEAD).Trim()
    required_base = $baseCommit
    patch_status = $patchStatus
    overlay_files = @($copied)
    backup_directory = $backupRoot
}
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $workflowTarget "install-receipt.json") -Encoding utf8

Write-Host "工作流安装完成。" -ForegroundColor Green
Write-Host "备份目录：$backupRoot"
Write-Host "下一步：运行 setup/Initialize-Environment.ps1、Register-CodexMcp.ps1 和 Test-Installation.ps1。"
