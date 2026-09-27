[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo
)

$ErrorActionPreference = "Stop"
$target = (Resolve-Path -LiteralPath $TargetRepo).Path
$recordPath = Join-Path $target ".runtime\story-workflow\services.json"
if (-not (Test-Path -LiteralPath $recordPath)) {
    Write-Host "没有找到工作流服务记录。"
    exit 0
}

$record = Get-Content -LiteralPath $recordPath -Encoding UTF8 -Raw | ConvertFrom-Json
foreach ($id in @($record.web.pid, $record.agent.pid)) {
    $process = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
    if ($process) { Stop-Process -Id $process.Id -Force }
}
Remove-Item -LiteralPath $recordPath -Force
Write-Host "工作流服务已停止。" -ForegroundColor Green

