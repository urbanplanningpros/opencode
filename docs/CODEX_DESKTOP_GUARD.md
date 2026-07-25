# Codex Desktop Guard

## Scope

This guard addresses emerging reliability failures in the Codex Desktop 26.721 build family:

- Windows native crashes while detecting or opening Git-backed local projects.
- Windows crashes after using the in-app browser, including cases where the app cannot reopen until Windows repair is run.
- Desktop renderer freezes when very large local JSONL session histories are opened or regain window focus.
- Desktop WSL integration can fail to update its runtime because a Windows path is passed to Linux `tar`, while plugin RPC calls repeatedly hit the 30-second timeout.

These are community-reported regressions. Until OpenAI publishes and validates a fix, the operating response is to change execution surfaces rather than disable business-critical work.

## Preflight

Run before using Codex Desktop on an operating machine:

```powershell
pwsh ./scripts/operator/codex-desktop-guard.ps1
```

Machine-readable result:

```powershell
pwsh ./scripts/operator/codex-desktop-guard.ps1 -Json
```

The guard exits with code `2` when the desktop surface should be restricted. It does not change app state, rename `.git`, reinstall software, or edit session files.

## Required continuity route

When the guard reports `codex-cli-direct-wsl-or-approved-local`:

```text
Persist task manifest and continuation state
→ route repository work to native Codex CLI or isolated direct WSL Codex CLI
→ route safe offline analysis to the approved local runtime
→ keep connector writes in the idempotent queue
→ verify every write before completion
```

Do not use model gateways or excluded providers.

## Windows build 26.721.x

Until fixed and canary-tested:

- Do not use the Codex in-app browser on Windows 26.721.x.
- Do not use the Desktop app as the only control surface for a long-running or destructive task.
- If opening a Git-backed project crashes the app, keep `.git` intact and route the work through Codex CLI or the approved local runtime.
- Do not rename, hide, delete, or reconstruct `.git` merely to keep the Desktop app open.
- Back up `%USERPROFILE%\.codex` before Windows repair, app reset, reinstall, or state-file edits.

## WSL continuity route

Do not use **Codex Desktop → Agent environment: WSL** on affected `26.721.x` builds. The reported failure occurs before normal task execution: the Desktop runtime updater passes a Windows path to Linux `tar`, then plugin calls repeatedly time out.

Use the direct launcher instead:

```powershell
pwsh ./scripts/operator/codex-wsl-direct.ps1 -PreflightOnly
pwsh ./scripts/operator/codex-wsl-direct.ps1
```

For a named distribution:

```powershell
pwsh ./scripts/operator/codex-wsl-direct.ps1 -Distribution Ubuntu
```

Pass Codex arguments as an array:

```powershell
pwsh ./scripts/operator/codex-wsl-direct.ps1 -CodexArgs @("exec", "-")
```

The direct route:

- Invokes the Codex CLI inside WSL without the Desktop runtime installer.
- Uses the Linux-native state directory `$HOME/.codex-direct`.
- Does not reuse `%USERPROFILE%\.codex`, avoiding mixed-version SQLite migrations between Windows and WSL runtimes.
- Passes command arguments positionally rather than interpolating them into the shell script.

Do not point `CODEX_HOME` at `/mnt/c/Users/<user>/.codex` for this route. If authentication must be established inside WSL, perform a fresh approved OpenAI login in the isolated Linux environment.

## Large-session threshold

The default warning threshold is 200 MiB per JSONL session file. Override only for investigation:

```powershell
pwsh ./scripts/operator/codex-desktop-guard.ps1 -WarnSessionBytes 314572800
```

When a session crosses the threshold:

1. Checkpoint the objective, acceptance criteria, decisions, changed files, and continuation prompt outside the vendor session.
2. Start a new thread rather than continuing to grow the existing desktop history.
3. Use CLI, isolated direct WSL CLI, or approved local execution until the old session is archived and recovery-tested.
4. Never resend a write action merely because the desktop UI appears frozen; reconcile the target system first.

## Return-to-normal criteria

Desktop restrictions can be removed only after:

1. OpenAI publishes a fixed build newer than the affected build family.
2. The fixed build opens representative Git repositories without a native crash.
3. Desktop WSL runtime installation completes using Linux-compatible paths.
4. Plugin listing and installed-plugin calls complete without hitting the 30-second ceiling.
5. In-app browser navigation passes ten controlled read-only canaries on Windows.
6. Large-thread focus switching and resume tests remain responsive.
7. Stop/cancel and active-turn state remain accurate during a controlled long-running task.
8. `%USERPROFILE%\.codex` and direct-WSL backup and rollback procedures are confirmed.
