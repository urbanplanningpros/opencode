[CmdletBinding()]
param(
  [int]$AppServerPid = 0,
  [int]$ProcessThreshold = 8,
  [long]$HandleThreshold = 900,
  [long]$WorkingSetThresholdBytes = 134217728,
  [string]$SnapshotDir,
  [switch]$ExecuteRecovery,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows) {
  Write-Error "The node_repl guard requires Windows."
  exit 64
}

function Get-ProcessInventory {
  @(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
      ProcessId = [int]$_.ProcessId
      ParentProcessId = [int]$_.ParentProcessId
      Name = [string]$_.Name
      CommandLine = [string]$_.CommandLine
      CreationDate = $_.CreationDate
    }
  })
}

function Get-Descendants {
  param(
    [int]$RootPid,
    [object[]]$Inventory
  )

  $children = @{}
  foreach ($process in $Inventory) {
    $parent = [int]$process.ParentProcessId
    if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }
    $children[$parent] += $process
  }

  $result = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Generic.Queue[object]
  foreach ($child in @($children[$RootPid])) { if ($null -ne $child) { $queue.Enqueue($child) } }
  $seen = New-Object System.Collections.Generic.HashSet[int]
  while ($queue.Count -gt 0) {
    $process = $queue.Dequeue()
    if (-not $seen.Add([int]$process.ProcessId)) { continue }
    $result.Add($process)
    foreach ($child in @($children[[int]$process.ProcessId])) { if ($null -ne $child) { $queue.Enqueue($child) } }
  }
  @($result)
}

function Write-AtomicJson {
  param(
    [string]$Path,
    [object]$Value
  )
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = "$Path.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
  $Value | ConvertTo-Json -Depth 20 | Set-Content -Path $temporary -Encoding utf8
  Move-Item -Path $temporary -Destination $Path -Force
}

$inventory = Get-ProcessInventory
if ($AppServerPid -le 1) {
  $candidates = @($inventory | Where-Object {
    $_.Name -ieq "codex.exe" -and $_.CommandLine -match "(^|\s)app-server(\s|$)"
  })
  if ($candidates.Count -ne 1) {
    Write-Error "Unable to identify one Codex app-server process. Pass -AppServerPid explicitly."
    exit 2
  }
  $AppServerPid = [int]$candidates[0].ProcessId
}

$target = $inventory | Where-Object { $_.ProcessId -eq $AppServerPid } | Select-Object -First 1
if ($null -eq $target) {
  Write-Error "Codex app-server process $AppServerPid was not found."
  exit 69
}

$descendants = @(Get-Descendants -RootPid $AppServerPid -Inventory $inventory)
$nodeRepl = @($descendants | Where-Object {
  $_.Name -ieq "node_repl.exe" -or $_.CommandLine -match "(^|[\\/])node_repl(\.exe)?(\s|$)"
})

$details = @($nodeRepl | ForEach-Object {
  $runtime = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  [pscustomobject]@{
    process_id = $_.ProcessId
    parent_process_id = $_.ParentProcessId
    creation_date = $_.CreationDate
    working_set_bytes = if ($null -ne $runtime) { [long]$runtime.WorkingSet64 } else { 0 }
    handle_count = if ($null -ne $runtime) { [long]$runtime.HandleCount } else { 0 }
  }
})

$totalWorkingSet = [long](($details | Measure-Object -Property working_set_bytes -Sum).Sum)
$totalHandles = [long](($details | Measure-Object -Property handle_count -Sum).Sum)
$reasons = New-Object System.Collections.Generic.List[string]
if ($details.Count -ge $ProcessThreshold) { $reasons.Add("node_repl_processes=$($details.Count)>=$ProcessThreshold") }
if ($totalHandles -ge $HandleThreshold) { $reasons.Add("node_repl_handles=$totalHandles>=$HandleThreshold") }
if ($totalWorkingSet -ge $WorkingSetThresholdBytes) {
  $reasons.Add("node_repl_working_set_bytes=$totalWorkingSet>=$WorkingSetThresholdBytes")
}

if ([string]::IsNullOrWhiteSpace($SnapshotDir)) {
  $root = if ($env:OPERATOR_STATE_DIR) { $env:OPERATOR_STATE_DIR } else { Join-Path $HOME ".upp-operator-state" }
  $SnapshotDir = Join-Path $root "node-repl-guard"
}
$observedAt = [DateTimeOffset]::UtcNow.ToString("o")
$fileStamp = $observedAt.Replace(":", "-").Replace(".", "-")
$snapshotFile = Join-Path $SnapshotDir "$fileStamp-pid-$AppServerPid.json"
$snapshot = [ordered]@{
  observed_at = $observedAt
  app_server_pid = $AppServerPid
  descendant_processes = $descendants.Count
  node_repl_processes = $details.Count
  node_repl_working_set_bytes = $totalWorkingSet
  node_repl_handle_count = $totalHandles
  node_repl = $details
  thresholds = [ordered]@{
    processes = $ProcessThreshold
    handles = $HandleThreshold
    working_set_bytes = $WorkingSetThresholdBytes
  }
  status = if ($reasons.Count -eq 0) { "healthy" } else { "recovery_required" }
  reasons = @($reasons)
}
Write-AtomicJson -Path $snapshotFile -Value $snapshot

if ($ExecuteRecovery -and $reasons.Count -gt 0) {
  try {
    if ([string]::IsNullOrWhiteSpace($env:OPERATOR_NODE_REPL_RECOVERY_COMMAND)) {
      throw "OPERATOR_NODE_REPL_RECOVERY_COMMAND is required as a JSON string array."
    }
    $command = @($env:OPERATOR_NODE_REPL_RECOVERY_COMMAND | ConvertFrom-Json)
    $invalidCommandParts = @($command | Where-Object { $_ -isnot [string] })
    if ($command.Count -eq 0 -or $invalidCommandParts.Count -gt 0) {
      throw "OPERATOR_NODE_REPL_RECOVERY_COMMAND must be a non-empty JSON string array."
    }
    $oldSnapshot = $env:OPERATOR_NODE_REPL_SNAPSHOT
    $oldPid = $env:CODEX_APP_SERVER_PID
    $env:OPERATOR_NODE_REPL_SNAPSHOT = $snapshotFile
    $env:CODEX_APP_SERVER_PID = [string]$AppServerPid
    try {
      $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
      $processInfo.FileName = $command[0]
      $processInfo.UseShellExecute = $false
      foreach ($argument in @($command | Select-Object -Skip 1)) { $processInfo.ArgumentList.Add($argument) }
      $process = [System.Diagnostics.Process]::Start($processInfo)
      $process.WaitForExit()
      $snapshot.recovery = [ordered]@{
        exit_code = $process.ExitCode
        reaudit_required = $true
      }
    } finally {
      $env:OPERATOR_NODE_REPL_SNAPSHOT = $oldSnapshot
      $env:CODEX_APP_SERVER_PID = $oldPid
    }
  } catch {
    $snapshot.recovery = [ordered]@{
      exit_code = $null
      error = $_.Exception.Message
      reaudit_required = $true
    }
  }
  Write-AtomicJson -Path $snapshotFile -Value $snapshot
}

$result = [ordered]@{}
foreach ($entry in $snapshot.GetEnumerator()) { $result[$entry.Key] = $entry.Value }
$result.snapshot_file = $snapshotFile
if ($Json) { $result | ConvertTo-Json -Depth 20 }
else {
  Write-Host "Codex node_repl guard: $($snapshot.status)"
  Write-Host "Processes: $($details.Count); handles: $totalHandles; working set bytes: $totalWorkingSet"
  Write-Host "Snapshot: $snapshotFile"
  foreach ($reason in $reasons) { Write-Host "- $reason" }
}

if ($reasons.Count -eq 0) { exit 0 }
exit 2
