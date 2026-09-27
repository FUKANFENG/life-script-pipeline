[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo
)

$ErrorActionPreference = "Stop"
$target = (Resolve-Path -LiteralPath $TargetRepo).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$uv = (Get-Command uv -ErrorAction Stop).Source

Write-Host "安装 Web 依赖..."
Push-Location (Join-Path $target "web")
try {
    if (Test-Path -LiteralPath "package-lock.json") { & $npm ci }
    else { & $npm install }
    if ($LASTEXITCODE -ne 0) { throw "Web 依赖安装失败" }
}
finally { Pop-Location }

Write-Host "安装 Canvas Agent 依赖..."
Push-Location (Join-Path $target "canvas-agent")
try {
    & $npm install
    if ($LASTEXITCODE -ne 0) { throw "Canvas Agent 依赖安装失败" }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Canvas Agent 构建失败" }
}
finally { Pop-Location }

Write-Host "创建 Local Aligner Python 3.11 环境..."
Push-Location (Join-Path $target "tools\local-aligner")
try {
    $env:UV_PYTHON = "3.11"
    & $uv sync --all-groups
    if ($LASTEXITCODE -ne 0) { throw "Local Aligner 环境安装失败" }
}
finally { Pop-Location }

Write-Host "创建 Story Media Runtime Python 3.11 环境..."
Push-Location (Join-Path $target "tools\story-runtime")
try {
    $env:UV_PYTHON = "3.11"
    & $uv sync --all-groups
    if ($LASTEXITCODE -ne 0) { throw "Story Media Runtime 环境安装失败" }
}
finally { Pop-Location }

$localConfig = Join-Path $target ".story-workflow.local.ps1"
$ffmpeg = Join-Path $target "tools\media-runtime\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
$aligner = Join-Path $target "tools\local-aligner\.venv\Scripts\local-aligner.exe"
$storyPython = Join-Path $target "tools\story-runtime\.venv\Scripts\python.exe"
$config = @"
# 本文件只保存本机路径，不保存 API Key。
`$env:INFINITE_CANVAS_WORKSPACE = '$($target.Replace("'", "''"))'
`$env:STORY_ALIGNER_EXECUTABLE = '$($aligner.Replace("'", "''"))'
`$env:PYTHON = '$($storyPython.Replace("'", "''"))'
`$env:LOCAL_ALIGNER_DEVICE = 'cuda'
`$env:FFMPEG_PATH = '$($ffmpeg.Replace("'", "''"))'
`$env:STORY_ALIGNMENT_MAX_CONCURRENCY = '1'
"@
[System.IO.File]::WriteAllText($localConfig, $config, [System.Text.UTF8Encoding]::new($false))

Write-Host "环境初始化完成。" -ForegroundColor Green
Write-Host "本机路径配置：$localConfig"
Write-Host "请单独设置 MINIMAX_API_KEY，不要写入该文件。"
