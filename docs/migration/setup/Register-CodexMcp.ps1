[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo,
    [switch]$Replace
)

$ErrorActionPreference = "Stop"
$target = (Resolve-Path -LiteralPath $TargetRepo).Path
$codex = (Get-Command codex -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$agentDir = Join-Path $target "canvas-agent"
$entry = Join-Path $agentDir "dist\index.js"

Push-Location $agentDir
try {
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Canvas Agent 构建失败" }
}
finally { Pop-Location }

$list = (& $codex mcp list 2>&1) -join "`n"
if ($list -match "(?m)^infinite-canvas\b") {
    if (-not $Replace) {
        throw "Codex 中已存在 infinite-canvas MCP。确认需要替换后使用 -Replace。"
    }
    & $codex mcp remove infinite-canvas
    if ($LASTEXITCODE -ne 0) { throw "移除旧 MCP 配置失败" }
}

& $codex mcp add infinite-canvas -- node $entry mcp
if ($LASTEXITCODE -ne 0) { throw "注册 Infinite Canvas MCP 失败" }

Write-Host "Codex MCP 已指向新电脑的本地定制版 Canvas Agent：$entry" -ForegroundColor Green
