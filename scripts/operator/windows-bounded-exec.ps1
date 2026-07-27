[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$ArgumentList = @(),

  [ValidateRange(1, 86400)]
  [int]$TimeoutSeconds = 1800,

  [ValidateRange(50, 5000)]
  [int]$PollMilliseconds = 250,

  [string]$WorkingDirectory = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  [Console]::Error.WriteLine("windows-bounded-exec.ps1 is available only on Windows hosts.")
  exit 64
}

if ($ArgumentList.Count -gt 0 -and $ArgumentList[0] -eq "--") {
  if ($ArgumentList.Count -eq 1) {
    $ArgumentList = @()
  } else {
    $ArgumentList = $ArgumentList[1..($ArgumentList.Count - 1)]
  }
}

$command = Get-Command $FilePath -ErrorAction SilentlyContinue
if (-not $command) {
  [Console]::Error.WriteLine("Command not found: $FilePath")
  exit 127
}

try {
  $resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
} catch {
  [Console]::Error.WriteLine("Working directory does not exist: $WorkingDirectory")
  exit 72
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $command.Source
$startInfo.WorkingDirectory = $resolvedWorkingDirectory
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $false

foreach ($argument in $ArgumentList) {
  [void]$startInfo.ArgumentList.Add($argument)
}

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$script:cancelRequested = $false
$cancelHandler = [ConsoleCancelEventHandler]{
  param($sender, $eventArgs)
  $eventArgs.Cancel = $true
  $script:cancelRequested = $true
}

function Stop-ProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
  if ($taskkill) {
    & $taskkill.Source /PID $ProcessId /T /F 2>$null | Out-Null
  }

  try {
    $target = Get-Process -Id $ProcessId -ErrorAction Stop
    if (-not $target.HasExited) {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # The process already exited.
  }
}

[Console]::add_CancelKeyPress($cancelHandler)

try {
  if (-not $process.Start()) {
    [Console]::Error.WriteLine("Unable to start command: $FilePath")
    exit 69
  }

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $terminationReason = $null

  while (-not $process.HasExited) {
    if ($script:cancelRequested) {
      $terminationReason = "interrupt"
      break
    }

    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      $terminationReason = "timeout"
      break
    }

    Start-Sleep -Milliseconds $PollMilliseconds
    $process.Refresh()
  }

  if ($terminationReason) {
    Stop-ProcessTree -ProcessId $process.Id
    [void]$process.WaitForExit(10000)

    if ($terminationReason -eq "interrupt") {
      [Console]::Error.WriteLine("Interrupted command and terminated its Windows process tree: $FilePath")
      exit 130
    }

    [Console]::Error.WriteLine("Command exceeded the ${TimeoutSeconds}s limit and its Windows process tree was terminated: $FilePath")
    exit 124
  }

  $process.WaitForExit()
  exit $process.ExitCode
} catch {
  if ($process -and -not $process.HasExited) {
    Stop-ProcessTree -ProcessId $process.Id
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 69
} finally {
  [Console]::remove_CancelKeyPress($cancelHandler)
  $process.Dispose()
}
