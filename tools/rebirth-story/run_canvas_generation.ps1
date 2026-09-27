[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,
    [Parameter(Mandatory = $true)]
    [string]$ProjectId,
    [int]$Concurrency = 3,
    [int]$StartShot = 1,
    [int]$EndShot = 277,
    [int]$MaxAttempts = 5,
    [int]$PollSeconds = 10,
    [int]$BatchTimeoutSeconds = 900
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectPath = [IO.Path]::GetFullPath($ProjectDir)
$planPath = Join-Path $projectPath "story-plan.json"
$progressPath = Join-Path $projectPath "canvas-generation-progress.json"
$anchorPath = Join-Path $projectPath "anchor-node-map.json"
$logPath = Join-Path $projectPath "canvas-generation.log"
$imageDir = Join-Path $projectPath "images\raw"
$agentConfigPath = Join-Path $env:USERPROFILE ".infinite-canvas\canvas-agent.json"

New-Item -ItemType Directory -Force -Path $imageDir | Out-Null

function Write-RunLog([string]$Message) {
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value $line
    Write-Output $line
}

if (-not (Test-Path -LiteralPath $planPath)) {
    throw "story-plan.json 不存在：$planPath"
}
if (-not (Test-Path -LiteralPath $agentConfigPath)) {
    throw "Canvas Agent 配置不存在：$agentConfigPath"
}

$agentConfig = Get-Content -LiteralPath $agentConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
$agentUrl = [string]$agentConfig.url
$headers = @{ "x-canvas-agent-token" = [string]$agentConfig.token }

function Invoke-CanvasTool([string]$Name, [object]$InputObject) {
    $body = @{ name = $Name; input = $InputObject } | ConvertTo-Json -Depth 40 -Compress
    $response = Invoke-RestMethod -Method Post -Uri ($agentUrl + "/api/tools") -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 120
    if (-not $response.ok) {
        throw "Canvas 工具调用失败：$Name"
    }
    return $response.result
}

function Get-CanvasState {
    $state = Invoke-CanvasTool "canvas_get_state" @{}
    if ([string]$state.projectId -ne $ProjectId) {
        throw "当前画布不是目标画布。期望 $ProjectId，实际 $($state.projectId)"
    }
    return $state
}

function Get-AnchorImageId([object]$State, [string]$ConfigTitle) {
    $configNode = @($State.nodes | Where-Object { $_.type -eq "config" -and $_.title -eq $ConfigTitle }) | Select-Object -First 1
    if (-not $configNode) {
        throw "未找到锚点配置节点：$ConfigTitle"
    }
    $childIds = @($State.connections | Where-Object { $_.fromNodeId -eq $configNode.id } | ForEach-Object { $_.toNodeId })
    $imageNode = @($State.nodes | Where-Object { $_.id -in $childIds -and $_.type -eq "image" -and $_.metadata.status -eq "success" }) | Select-Object -Last 1
    if (-not $imageNode) {
        throw "锚点图片尚未成功：$ConfigTitle"
    }
    return [string]$imageNode.id
}

function Save-Json([string]$Path, [object]$Value) {
    $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Find-ResultNode([object]$State, [string]$ConfigId) {
    $childIds = @($State.connections | Where-Object { $_.fromNodeId -eq $ConfigId } | ForEach-Object { $_.toNodeId })
    return @($State.nodes | Where-Object { $_.id -in $childIds -and $_.type -eq "image" -and $_.metadata.status -eq "success" }) | Select-Object -Last 1
}

function Save-CanvasMedia([object[]]$Records) {
    $recordsWithImages = @($Records | Where-Object { $_.image_node_id })
    for ($offset = 0; $offset -lt $recordsWithImages.Count; $offset += 3) {
        $group = @($recordsWithImages[$offset..([Math]::Min($offset + 2, $recordsWithImages.Count - 1))])
        $nodeIds = @($group | ForEach-Object { $_.image_node_id })
        $media = Invoke-CanvasTool "canvas_get_node_media" @{ nodeIds = $nodeIds }
        foreach ($item in @($media.items)) {
            $record = $group | Where-Object { $_.image_node_id -eq $item.nodeId } | Select-Object -First 1
            if (-not $record -or -not $item.base64) { continue }
            $extension = if ([string]$item.mimeType -match "jpeg") { "jpg" } else { "png" }
            $fileName = "{0}.{1}" -f $record.shot_id, $extension
            $outputPath = Join-Path $imageDir $fileName
            [IO.File]::WriteAllBytes($outputPath, [Convert]::FromBase64String([string]$item.base64))
            $record.local_path = $outputPath
            $record.storage_key = [string]$item.storageKey
            $record.width = [int]$item.width
            $record.height = [int]$item.height
            $record.bytes = [int64]$item.bytes
        }
    }
}

$plan = Get-Content -LiteralPath $planPath -Encoding UTF8 -Raw | ConvertFrom-Json
$shots = @($plan.shots | Where-Object {
    $number = [int](([string]$_.id).Substring(1))
    $number -ge $StartShot -and $number -le $EndShot
})
if (-not $shots.Count) {
    throw "指定范围内没有镜头：$StartShot-$EndShot"
}

$state = Get-CanvasState
$anchorIds = [ordered]@{
    style = Get-AnchorImageId $state "STYLE-01 | 全片视觉基准"
    clean_style = Get-AnchorImageId $state "STYLE-02 | 无人物环境光影基准"
    newborn = Get-AnchorImageId $state "CHAR-01 | 林川 2006 婴儿期"
    infant = Get-AnchorImageId $state "CHAR-01 | 林川 2006 婴儿期"
    young_child = Get-AnchorImageId $state "CHAR-04B | 林川 幼儿期圆头修订"
    child = Get-AnchorImageId $state "CHAR-02 | 林川 童年期"
    teen = Get-AnchorImageId $state "CHAR-05B | 林川 少年期圆头修订"
    young_adult = Get-AnchorImageId $state "CHAR-03 | 林川 青年期"
}
Save-Json $anchorPath ([ordered]@{ schema_version = 1; project_id = $ProjectId; anchors = $anchorIds })

$anchorTitleOps = @(
    @{ type = "update_node"; id = $anchorIds.style; patch = @{ title = "STYLE-01 RESULT | 全片视觉基准" } },
    @{ type = "update_node"; id = $anchorIds.clean_style; patch = @{ title = "STYLE-02 RESULT | 无人物环境光影基准" } },
    @{ type = "update_node"; id = $anchorIds.newborn; patch = @{ title = "CHAR-01 RESULT | 林川 2006 婴儿期" } },
    @{ type = "update_node"; id = $anchorIds.young_child; patch = @{ title = "CHAR-04 RESULT | 林川 幼儿期" } },
    @{ type = "update_node"; id = $anchorIds.child; patch = @{ title = "CHAR-02 RESULT | 林川 童年期" } },
    @{ type = "update_node"; id = $anchorIds.teen; patch = @{ title = "CHAR-05 RESULT | 林川 少年期" } },
    @{ type = "update_node"; id = $anchorIds.young_adult; patch = @{ title = "CHAR-03 RESULT | 林川 青年期" } }
)
Invoke-CanvasTool "canvas_apply_ops" @{ ops = $anchorTitleOps } | Out-Null

Write-RunLog "为 $($shots.Count) 个镜头写入风格图与年龄角色图双参考，生成并发固定为 $Concurrency。"
$setupOps = New-Object Collections.Generic.List[object]
foreach ($shot in $shots) {
    $shotId = ([string]$shot.id).ToLowerInvariant()
    $configId = "shot-config-$shotId"
    $promptId = "shot-prompt-$shotId"
    $stage = [string]$shot.protagonist_stage
    $referenceId = [string]$anchorIds[$stage]
    if (-not $referenceId) { throw "镜头 $($shot.id) 的角色阶段没有锚点：$stage" }
    $composer = "@[node:$promptId]`n@[node:$($anchorIds.clean_style)]`n@[node:$referenceId]"
    $setupOps.Add(@{ type = "update_node"; id = $configId; metadata = @{ composerContent = $composer; prompt = $composer } })
    $setupOps.Add(@{ type = "connect_nodes"; fromNodeId = $anchorIds.clean_style; toNodeId = $configId })
    $setupOps.Add(@{ type = "connect_nodes"; fromNodeId = $referenceId; toNodeId = $configId })
}
for ($offset = 0; $offset -lt $setupOps.Count; $offset += 100) {
    $chunk = @($setupOps[$offset..([Math]::Min($offset + 99, $setupOps.Count - 1))])
    Invoke-CanvasTool "canvas_apply_ops" @{ ops = $chunk } | Out-Null
}

$records = [ordered]@{}
if (Test-Path -LiteralPath $progressPath) {
    $existing = Get-Content -LiteralPath $progressPath -Encoding UTF8 -Raw | ConvertFrom-Json
    foreach ($record in @($existing.shots)) { $records[[string]$record.shot_id] = $record }
}
foreach ($shot in $shots) {
    if ($records.Contains([string]$shot.id)) { continue }
    $records[[string]$shot.id] = [pscustomobject]@{
        shot_id = [string]$shot.id
        config_node_id = "shot-config-$(([string]$shot.id).ToLowerInvariant())"
        image_node_id = $null
        status = "pending"
        attempts = 0
        error = $null
        local_path = $null
        storage_key = $null
        width = $null
        height = $null
        bytes = $null
    }
}

function Write-Progress {
    $all = @($records.Values)
    $payload = [ordered]@{
        schema_version = 1
        project_id = $ProjectId
        updated_at = (Get-Date).ToString("o")
        total = $all.Count
        succeeded = @($all | Where-Object { $_.status -eq "success" }).Count
        failed = @($all | Where-Object { $_.status -eq "failed" }).Count
        pending = @($all | Where-Object { $_.status -in @("pending", "running") }).Count
        shots = $all
    }
    Save-Json $progressPath $payload
}

$state = Get-CanvasState
foreach ($record in @($records.Values)) {
    $resultNode = Find-ResultNode $state $record.config_node_id
    if (-not $resultNode) { continue }
    $record.image_node_id = [string]$resultNode.id
    $record.status = "success"
    $record.error = $null
}
$initialComplete = @($records.Values | Where-Object { $_.status -eq "success" })
if ($initialComplete.Count) {
    Save-CanvasMedia $initialComplete
    Write-RunLog "恢复并确认已完成镜头：$($initialComplete.Count)。"
}
Write-Progress

$active = @{}
$retryAfter = @{}
$transientPattern = "precheck|quota|429|HTTP 5\d\d|slot|temporar|timed out|selection|connection failed"

Write-RunLog "启用滚动并发：任一任务结束后立即补位，不等待整批完成。"
while ($true) {
    if ($active.Count) {
        $activeEntries = @($active.Values)
        $statusResult = Invoke-CanvasTool "generation_get_status" @{
            scope = "canvas"
            nodeIds = @($activeEntries | ForEach-Object { $_.record.config_node_id })
            limit = $activeEntries.Count
        }
        $now = Get-Date
        $completedEntries = @($activeEntries | Where-Object {
            $entry = $_
            $task = @($statusResult.tasks | Where-Object { $_.id -eq $entry.record.config_node_id }) | Select-Object -First 1
            $timedOut = ($now - $entry.started_at).TotalSeconds -ge $BatchTimeoutSeconds
            $timedOut -or ($task -and $task.status -notin @("queued", "running"))
        })

        if ($completedEntries.Count) {
            $state = Get-CanvasState
            $successRecords = New-Object Collections.Generic.List[object]
            $renameOps = New-Object Collections.Generic.List[object]
            foreach ($entry in $completedEntries) {
                $record = $entry.record
                $task = @($statusResult.tasks | Where-Object { $_.id -eq $record.config_node_id }) | Select-Object -First 1
                $resultNode = Find-ResultNode $state $record.config_node_id
                if ($resultNode) {
                    $record.image_node_id = [string]$resultNode.id
                    $record.status = "success"
                    $record.error = $null
                    $retryAfter.Remove([string]$record.shot_id)
                    $successRecords.Add($record)
                    $renameOps.Add(@{ type = "update_node"; id = $record.image_node_id; patch = @{ title = "$($record.shot_id) RESULT | 正式分镜" } })
                }
                else {
                    $record.status = if ([int]$record.attempts -ge $MaxAttempts) { "failed" } else { "pending" }
                    $record.error = if ($task -and $task.error) { [string]$task.error } else { "生成等待超时或未返回成功图片" }
                    if ([string]$record.error -match $transientPattern) {
                        $retryAfter[[string]$record.shot_id] = (Get-Date).AddSeconds(60)
                    }
                    Write-RunLog "$($record.shot_id) 失败：$($record.error)"
                }
                $active.Remove([string]$record.config_node_id)
            }
            if ($renameOps.Count) { Invoke-CanvasTool "canvas_apply_ops" @{ ops = $renameOps.ToArray() } | Out-Null }
            if ($successRecords.Count) { Save-CanvasMedia $successRecords.ToArray() }
            Write-Progress
            $doneCount = @($records.Values | Where-Object { $_.status -eq "success" }).Count
            Write-RunLog "当前完成 $doneCount/$($records.Count)，运行中 $($active.Count)。"
        }
    }

    $availableSlots = [Math]::Max(0, $Concurrency - $active.Count)
    if ($availableSlots) {
        $now = Get-Date
        $eligible = @($records.Values | Where-Object {
            $shotId = [string]$_.shot_id
            $configId = [string]$_.config_node_id
            $retryReady = -not $retryAfter.ContainsKey($shotId) -or $retryAfter[$shotId] -le $now
            $_.status -ne "success" -and
                [int]$_.attempts -lt $MaxAttempts -and
                -not $active.ContainsKey($configId) -and
                $retryReady
        } | Select-Object -First $availableSlots)

        if ($eligible.Count) {
            $runOps = @()
            foreach ($record in $eligible) {
                $record.attempts = [int]$record.attempts + 1
                $record.status = "running"
                $record.error = $null
                $active[[string]$record.config_node_id] = [pscustomobject]@{
                    record = $record
                    started_at = Get-Date
                }
                $runOps += @{ type = "run_generation"; nodeId = $record.config_node_id; mode = "image" }
            }
            Write-Progress
            Write-RunLog ("补位触发 {0}，尝试次数 {1}，运行中 $($active.Count)。" -f (($eligible.shot_id) -join ","), (($eligible.attempts) -join ","))
            try {
                Invoke-CanvasTool "canvas_apply_ops" @{ ops = $runOps } | Out-Null
            }
            catch {
                foreach ($record in $eligible) {
                    $record.status = if ([int]$record.attempts -ge $MaxAttempts) { "failed" } else { "pending" }
                    $record.error = $_.Exception.Message
                    $active.Remove([string]$record.config_node_id)
                    $retryAfter[[string]$record.shot_id] = (Get-Date).AddSeconds(60)
                }
                Write-RunLog "提交生成任务失败，相关镜头退避 60 秒：$($_.Exception.Message)"
                Write-Progress
            }
        }
    }

    $remaining = @($records.Values | Where-Object { $_.status -ne "success" -and [int]$_.attempts -lt $MaxAttempts })
    if (-not $active.Count -and -not $remaining.Count) { break }
    Start-Sleep -Seconds $PollSeconds
}

$failedRecords = @($records.Values | Where-Object { $_.status -ne "success" })
Write-Progress
if ($failedRecords.Count) {
    Write-RunLog "批量生成结束，成功 $($records.Count - $failedRecords.Count)，失败 $($failedRecords.Count)。"
    exit 2
}

Write-RunLog "批量生成完成：$($records.Count)/$($records.Count)，全部图片已落盘。"
