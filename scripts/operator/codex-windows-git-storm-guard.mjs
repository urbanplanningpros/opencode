#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

const EXIT_POLICY = 75;
const EXIT_USAGE = 64;

function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    fixture: null,
    json: false,
    sampleSeconds: 15,
    pollMilliseconds: 150,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fixture") {
      options.fixture = argv[++index] ?? fail("--fixture requires a path");
    } else if (arg === "--sample-seconds") {
      options.sampleSeconds = Number(argv[++index]);
    } else if (arg === "--poll-milliseconds") {
      options.pollMilliseconds = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: codex-windows-git-storm-guard.mjs [options]\n\n`);
      process.stdout.write(`  --fixture PATH             Evaluate a saved metrics fixture\n`);
      process.stdout.write(`  --sample-seconds N         Live Windows sample duration (default: 15)\n`);
      process.stdout.write(`  --poll-milliseconds N      Process polling interval (default: 150)\n`);
      process.stdout.write(`  --json                     Emit JSON\n`);
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.sampleSeconds) || options.sampleSeconds < 5 || options.sampleSeconds > 120) {
    fail("--sample-seconds must be between 5 and 120");
  }
  if (!Number.isFinite(options.pollMilliseconds) || options.pollMilliseconds < 75 || options.pollMilliseconds > 2000) {
    fail("--poll-milliseconds must be between 75 and 2000");
  }

  return options;
}

function canonicalMetrics(raw) {
  const requiredNumbers = [
    "sample_seconds",
    "git_starts",
    "conhost_starts",
    "codex_attributed_git_starts",
    "pid4_handles_start",
    "pid4_handles_end",
    "commit_percent",
  ];

  for (const key of requiredNumbers) {
    if (!Number.isFinite(Number(raw[key])) || Number(raw[key]) < 0) {
      fail(`Invalid metric: ${key}`);
    }
  }

  return {
    platform: String(raw.platform ?? "unknown"),
    sample_seconds: Number(raw.sample_seconds),
    git_starts: Number(raw.git_starts),
    conhost_starts: Number(raw.conhost_starts),
    codex_attributed_git_starts: Number(raw.codex_attributed_git_starts),
    pid4_handles_start: Number(raw.pid4_handles_start),
    pid4_handles_end: Number(raw.pid4_handles_end),
    commit_percent: Number(raw.commit_percent),
    codex_desktop_present: Boolean(raw.codex_desktop_present),
    codex_vscode_extension_present: Boolean(raw.codex_vscode_extension_present),
    observed_request_kinds: Array.isArray(raw.observed_request_kinds)
      ? raw.observed_request_kinds.map(String).slice(0, 20)
      : [],
    observed_sources: Array.isArray(raw.observed_sources)
      ? raw.observed_sources.map(String).slice(0, 20)
      : [],
  };
}

function ratePerMinute(count, seconds) {
  return Math.round((count * 60 * 100) / seconds) / 100;
}

function evaluate(rawMetrics) {
  const metrics = canonicalMetrics(rawMetrics);
  const gitRate = ratePerMinute(metrics.git_starts, metrics.sample_seconds);
  const attributedGitRate = ratePerMinute(
    metrics.codex_attributed_git_starts,
    metrics.sample_seconds,
  );
  const conhostRate = ratePerMinute(metrics.conhost_starts, metrics.sample_seconds);
  const handleDelta = Math.max(0, metrics.pid4_handles_end - metrics.pid4_handles_start);
  const handleRate = ratePerMinute(handleDelta, metrics.sample_seconds);
  const hasCodexEvidence =
    metrics.codex_desktop_present ||
    metrics.codex_vscode_extension_present ||
    metrics.codex_attributed_git_starts > 0 ||
    metrics.observed_request_kinds.some((value) =>
      ["git-origins", "review-summary", "status-summary", "branch-diff-stats"].includes(value),
    );

  const critical =
    hasCodexEvidence &&
    (attributedGitRate >= 120 ||
      (gitRate >= 180 && handleRate >= 300) ||
      handleRate >= 900 ||
      metrics.commit_percent >= 92);

  const warning =
    hasCodexEvidence &&
    (attributedGitRate >= 45 ||
      gitRate >= 90 ||
      handleRate >= 120 ||
      metrics.commit_percent >= 82);

  const status = critical ? "recovery_required" : warning ? "warning" : "healthy";
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(metrics))
    .digest("hex");

  return {
    schema_version: 1,
    status,
    fingerprint_sha256: fingerprint,
    metrics: {
      ...metrics,
      git_starts_per_minute: gitRate,
      codex_attributed_git_starts_per_minute: attributedGitRate,
      conhost_starts_per_minute: conhostRate,
      pid4_handle_growth_per_minute: handleRate,
    },
    admission: {
      codex_desktop_git_integration: status === "healthy",
      codex_vscode_extension: status === "healthy",
      guarded_direct_openai_cli: true,
      explicitly_authorized_local_route: true,
    },
    required_actions:
      status === "healthy"
        ? []
        : [
            "Checkpoint task manifests, repository state, operation IDs, and idempotency keys.",
            "Stop admitting new Desktop or VS Code Codex Git-inspection work on the affected Windows host.",
            "Fully close the affected Codex Desktop surface or disable the OpenAI Codex VS Code extension; do not kill unrelated Git processes globally.",
            "Continue business-critical work through the guarded direct OpenAI CLI or an explicitly authorized local route.",
            "Reconcile every external write that lacks a verified receipt before replay.",
            "Require a new healthy sample before restoring the affected UI integration.",
          ],
  };
}

function collectWindowsMetrics(sampleSeconds, pollMilliseconds) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$sampleSeconds = ${sampleSeconds}
$pollMilliseconds = ${pollMilliseconds}
$seen = [System.Collections.Generic.HashSet[int]]::new()
$gitStarts = 0
$conhostStarts = 0
$codexAttributedGitStarts = 0
$desktopPresent = $false
$extensionPresent = $false

function Get-ProcessSnapshot {
  @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
}

function Test-CodexAncestor([int]$parentPid, [hashtable]$byPid) {
  $cursor = $parentPid
  for ($depth = 0; $depth -lt 8 -and $cursor -gt 0; $depth++) {
    $item = $byPid[$cursor]
    if ($null -eq $item) { break }
    $name = [string]$item.Name
    if ($name -match '^(ChatGPT|codex)\.exe$') { return $true }
    if ($name -ieq 'Code.exe') {
      $extensionRoot = Join-Path $HOME '.vscode\extensions'
      if (Test-Path $extensionRoot) {
        if (Get-ChildItem $extensionRoot -Directory -Filter 'openai.chatgpt-*' -ErrorAction SilentlyContinue | Select-Object -First 1) {
          return $true
        }
      }
    }
    $cursor = [int]$item.ParentProcessId
  }
  return $false
}

$initial = Get-ProcessSnapshot
foreach ($item in $initial) {
  [void]$seen.Add([int]$item.ProcessId)
  if ([string]$item.Name -match '^(ChatGPT|codex)\.exe$') { $desktopPresent = $true }
}
$extensionRoot = Join-Path $HOME '.vscode\extensions'
if (Test-Path $extensionRoot) {
  $extensionPresent = [bool](Get-ChildItem $extensionRoot -Directory -Filter 'openai.chatgpt-*' -ErrorAction SilentlyContinue | Select-Object -First 1)
}

$pid4Start = (Get-Process -Id 4 -ErrorAction Stop).HandleCount
$deadline = [DateTime]::UtcNow.AddSeconds($sampleSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
  $snapshot = Get-ProcessSnapshot
  $byPid = @{}
  foreach ($item in $snapshot) { $byPid[[int]$item.ProcessId] = $item }
  foreach ($item in $snapshot) {
    $pid = [int]$item.ProcessId
    if ($seen.Add($pid)) {
      $name = [string]$item.Name
      if ($name -ieq 'git.exe') {
        $gitStarts++
        if (Test-CodexAncestor ([int]$item.ParentProcessId) $byPid) { $codexAttributedGitStarts++ }
      } elseif ($name -ieq 'conhost.exe') {
        $conhostStarts++
      }
    }
  }
  Start-Sleep -Milliseconds $pollMilliseconds
}
$pid4End = (Get-Process -Id 4 -ErrorAction Stop).HandleCount
$commitPercent = [double](Get-Counter '\Memory\% Committed Bytes In Use').CounterSamples[0].CookedValue

$requestKinds = [System.Collections.Generic.HashSet[string]]::new()
$sources = [System.Collections.Generic.HashSet[string]]::new()
$codexLogRoot = Join-Path $env:LOCALAPPDATA 'Codex\Logs'
if (Test-Path $codexLogRoot) {
  $recentLogs = Get-ChildItem $codexLogRoot -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -gt [DateTime]::UtcNow.AddMinutes(-10) } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 5
  foreach ($log in $recentLogs) {
    foreach ($line in (Get-Content $log.FullName -Tail 4000 -ErrorAction SilentlyContinue)) {
      foreach ($kind in @('git-origins','review-summary','status-summary','branch-diff-stats')) {
        if ($line -match "requestKind[=: ]+$kind") { [void]$requestKinds.Add($kind) }
      }
      foreach ($source in @('sidebar_workspace_task_groups_task_dirs','local_conversation_git_actions','review_model','git-repo-watcher')) {
        if ($line -match "source[=: ]+$source") { [void]$sources.Add($source) }
      }
    }
  }
}

[ordered]@{
  platform = 'win32'
  sample_seconds = $sampleSeconds
  git_starts = $gitStarts
  conhost_starts = $conhostStarts
  codex_attributed_git_starts = $codexAttributedGitStarts
  pid4_handles_start = $pid4Start
  pid4_handles_end = $pid4End
  commit_percent = [math]::Round($commitPercent, 2)
  codex_desktop_present = $desktopPresent
  codex_vscode_extension_present = $extensionPresent
  observed_request_kinds = @($requestKinds)
  observed_sources = @($sources)
} | ConvertTo-Json -Depth 4 -Compress
`;

  const output = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: (sampleSeconds + 20) * 1000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(output.trim());
}

const options = parseArgs(process.argv.slice(2));
let rawMetrics;
if (options.fixture) {
  rawMetrics = JSON.parse(readFileSync(options.fixture, "utf8"));
} else if (process.platform === "win32") {
  rawMetrics = collectWindowsMetrics(options.sampleSeconds, options.pollMilliseconds);
} else {
  rawMetrics = {
    platform: process.platform,
    sample_seconds: options.sampleSeconds,
    git_starts: 0,
    conhost_starts: 0,
    codex_attributed_git_starts: 0,
    pid4_handles_start: 0,
    pid4_handles_end: 0,
    commit_percent: 0,
    codex_desktop_present: false,
    codex_vscode_extension_present: false,
    observed_request_kinds: [],
    observed_sources: [],
  };
}

const result = evaluate(rawMetrics);
if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`Codex Windows Git storm guard: ${result.status}\n`);
  process.stdout.write(`Git starts/min: ${result.metrics.git_starts_per_minute}\n`);
  process.stdout.write(`Codex-attributed Git starts/min: ${result.metrics.codex_attributed_git_starts_per_minute}\n`);
  process.stdout.write(`PID 4 handle growth/min: ${result.metrics.pid4_handle_growth_per_minute}\n`);
  process.stdout.write(`Committed bytes in use: ${result.metrics.commit_percent}%\n`);
}

if (result.status !== "healthy") {
  process.exit(EXIT_POLICY);
}
