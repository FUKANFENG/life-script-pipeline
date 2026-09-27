[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo,
    [int]$WebPort = 3000,
    [int]$AgentPort = 17371,
    [switch]$Lan
)

$ErrorActionPreference = "Stop"
$target = (Resolve-Path -LiteralPath $TargetRepo).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$runtime = Join-Path $target ".runtime\story-workflow"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

$localConfig = Join-Path $target ".story-workflow.local.ps1"
if (Test-Path -LiteralPath $localConfig) { . $localConfig }
$env:INFINITE_CANVAS_WORKSPACE = $target
$env:CANVAS_AGENT_HOST = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
$env:PORT = "$AgentPort"

$agent = Start-Process -FilePath $npm -ArgumentList @("run", "dev") -WorkingDirectory (Join-Path $target "canvas-agent") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime "agent.out.log") -RedirectStandardError (Join-Path $runtime "agent.err.log")

$env:PORT = $null
$web = Start-Process -FilePath $npm -ArgumentList @("run", "dev", "--", "--port", "$WebPort", "--host", $(if ($Lan) { "0.0.0.0" } else { "127.0.0.1" })) -WorkingDirectory (Join-Path $target "web") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime "web.out.log") -RedirectStandardError (Join-Path $runtime "web.err.log")

$record = [ordered]@{
    started_at = (Get-Date).ToString("o")
    target = $target
    lan = [bool]$Lan
    web = @{ pid = $web.Id; port = $WebPort }
    agent = @{ pid = $agent.Id; port = $AgentPort }
}
$record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runtime "services.json") -Encoding utf8

Start-Sleep -Seconds 2
Write-Host "Web UI: http://127.0.0.1:$WebPort" -ForegroundColor Green
Write-Host "Canvas Agent: http://127.0.0.1:$AgentPort"
if ($Lan) { Write-Host "已启用局域网监听；请使用本机局域网 IP 和端口 $WebPort 访问。" }

