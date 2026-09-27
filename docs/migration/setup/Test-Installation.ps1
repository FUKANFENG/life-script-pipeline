[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo,
    [switch]$LoadAlignerModel
)

$ErrorActionPreference = "Stop"
$target = (Resolve-Path -LiteralPath $TargetRepo).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$uv = (Get-Command uv -ErrorAction Stop).Source
$results = [System.Collections.Generic.List[object]]::new()

function Run-Step([string]$Name, [scriptblock]$Action) {
    Write-Host "`n[$Name]"
    try {
        & $Action
        if ($LASTEXITCODE -ne 0) { throw "退出码 $LASTEXITCODE" }
        $results.Add([pscustomobject]@{ Step = $Name; Status = "PASS" })
    }
    catch {
        $results.Add([pscustomobject]@{ Step = $Name; Status = "FAIL" })
        throw "$Name 失败：$($_.Exception.Message)"
    }
}

Run-Step "Canvas Agent 测试" {
    Push-Location (Join-Path $target "canvas-agent")
    try { & $npm test } finally { Pop-Location }
}
Run-Step "Canvas Agent 构建" {
    Push-Location (Join-Path $target "canvas-agent")
    try { & $npm run build } finally { Pop-Location }
}
Run-Step "Web 类型检查" {
    Push-Location (Join-Path $target "web")
    try { & $npm run typecheck } finally { Pop-Location }
}
Run-Step "Web 构建" {
    Push-Location (Join-Path $target "web")
    try { & $npm run build } finally { Pop-Location }
}
Run-Step "Local Aligner 测试" {
    Push-Location (Join-Path $target "tools\local-aligner")
    try { & $uv run pytest } finally { Pop-Location }
}

Run-Step "Story Media Runtime" {
    $storyPython = Join-Path $target "tools\story-runtime\.venv\Scripts\python.exe"
    & $storyPython -c "import av, jieba, numpy, PIL, requests, docx; print('story runtime ok')"
}

if ($LoadAlignerModel) {
    Run-Step "Local Aligner CUDA 模型检查" {
        Push-Location (Join-Path $target "tools\local-aligner")
        try { & $uv run local-aligner doctor --load-model --device cuda } finally { Pop-Location }
    }
}

$results | Format-Table -AutoSize
Write-Host "离线工程验收通过。下一步按 workflow/story-production/ACCEPTANCE_RUNBOOK.md 进行真实小型验收。" -ForegroundColor Green
