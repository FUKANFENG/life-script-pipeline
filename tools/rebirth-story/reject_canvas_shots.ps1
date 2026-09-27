[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,
    [Parameter(Mandatory = $true)]
    [string]$ProjectId,
    [Parameter(Mandatory = $true)]
    [int]$StartShot,
    [Parameter(Mandatory = $true)]
    [int]$EndShot,
    [Parameter(Mandatory = $true)]
    [string]$Reason
)

$ErrorActionPreference = "Stop"
$projectPath = [IO.Path]::GetFullPath($ProjectDir)
$progressPath = Join-Path $projectPath "canvas-generation-progress.json"
$agentConfigPath = Join-Path $env:USERPROFILE ".infinite-canvas\canvas-agent.json"
$rejectedRoot = Join-Path $projectPath "qc\rejected"
New-Item -ItemType Directory -Force -Path $rejectedRoot | Out-Null

$agentConfig = Get-Content -LiteralPath $agentConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
$headers = @{ "x-canvas-agent-token" = [string]$agentConfig.token }

function Invoke-CanvasTool([string]$Name, [object]$Payload) {
    $body = @{ name = $Name; input = $Payload } | ConvertTo-Json -Depth 40 -Compress
    $response = Invoke-RestMethod -Method Post -Uri ($agentConfig.url + "/api/tools") -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 120
    if (-not $response.ok) { throw "Canvas 工具调用失败：$Name；$($response.error)" }
    return $response.result
}

function Save-Json([string]$Path, [object]$Value) {
    $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding UTF8
}

$state = Invoke-CanvasTool "canvas_get_state" @{}
if ([string]$state.projectId -ne $ProjectId) {
    throw "当前画布不是目标画布。期望 $ProjectId，实际 $($state.projectId)"
}

$progress = Get-Content -LiteralPath $progressPath -Encoding UTF8 -Raw | ConvertFrom-Json
$ops = New-Object Collections.Generic.List[object]
$audit = New-Object Collections.Generic.List[object]

foreach ($number in $StartShot..$EndShot) {
    $shotId = "S{0:D3}" -f $number
    $configId = "shot-config-$($shotId.ToLowerInvariant())"
    $connections = @($state.connections | Where-Object { $_.fromNodeId -eq $configId })
    $childIds = @($connections | ForEach-Object { $_.toNodeId })
    $imageNodes = @($state.nodes | Where-Object {
        $_.id -in $childIds -and $_.type -eq "image" -and $_.metadata.status -eq "success"
    })
    foreach ($node in $imageNodes) {
        $ops.Add(@{
            type = "update_node"
            id = [string]$node.id
            patch = @{ title = "$shotId REJECTED | $Reason" }
        })
        foreach ($connection in @($connections | Where-Object { $_.toNodeId -eq $node.id })) {
            $ops.Add(@{ type = "delete_connections"; ids = @([string]$connection.id) })
        }
    }

    $record = @($progress.shots | Where-Object { $_.shot_id -eq $shotId }) | Select-Object -First 1
    $archivedPaths = @()
    if ($record) {
        foreach ($candidate in @(
            [string]$record.local_path,
            (Join-Path $projectPath "images\16x9\$shotId.png")
        )) {
            if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
            $kind = if ($candidate -match "16x9") { "prepared" } else { "raw" }
            $extension = [IO.Path]::GetExtension($candidate)
            $target = Join-Path $rejectedRoot "$shotId.$kind$extension"
            Move-Item -LiteralPath $candidate -Destination $target -Force
            $archivedPaths += $target
        }
        $record.image_node_id = $null
        $record.status = "pending"
        $record.attempts = 0
        $record.error = $null
        $record.local_path = $null
        $record.storage_key = $null
        $record.width = $null
        $record.height = $null
        $record.bytes = $null
    }
    $audit.Add([ordered]@{
        shot_id = $shotId
        rejected_node_ids = @($imageNodes | ForEach-Object { $_.id })
        archived_paths = $archivedPaths
        reason = $Reason
    })
}

for ($offset = 0; $offset -lt $ops.Count; $offset += 100) {
    $chunk = @($ops[$offset..([Math]::Min($offset + 99, $ops.Count - 1))])
    Invoke-CanvasTool "canvas_apply_ops" @{ ops = $chunk } | Out-Null
}

$progress.updated_at = (Get-Date).ToString("o")
$progress.succeeded = @($progress.shots | Where-Object { $_.status -eq "success" }).Count
$progress.failed = @($progress.shots | Where-Object { $_.status -eq "failed" }).Count
$progress.pending = @($progress.shots | Where-Object { $_.status -in @("pending", "running") }).Count
Save-Json $progressPath $progress

$auditPath = Join-Path $projectPath ("qc\rejected-shots-{0:D3}-{1:D3}.json" -f $StartShot, $EndShot)
Save-Json $auditPath ([ordered]@{
    schema_version = 1
    project_id = $ProjectId
    created_at = (Get-Date).ToString("o")
    reason = $Reason
    records = $audit.ToArray()
})

Write-Output "已保留并断开 $StartShot-$EndShot 的不合格结果；镜头已重置为待生成。"
