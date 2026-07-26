# Codex macOS permissions-profile guard

## Current compatibility issue

Codex CLI `0.144.6` and `0.145.0` on Apple Silicon have a reported sandbox failure where activating any permissions profile with `-P` or `default_permissions` can abort the sandboxed child before command execution. The failure is silent except for `SIGABRT`, and the permissions profile cannot be relied on to grant deliberate write access to `.git` under `workspace-write`.

## Approved route

Run macOS Codex sessions through the guarded launcher:

```bash
bun operator:codex-safe -- exec --ephemeral -
```

While the guard is active it rejects:

```text
-P <profile>
-P<profile>
--permissions-profile <profile>
--permissions-profile=<profile>
-c default_permissions=...
--config default_permissions=...
default_permissions = "..." in $CODEX_HOME/config.toml
```

The guard continues to disable `remote_plugin`, `code_mode`, and `code_mode_only` and does not add any excluded provider or gateway route.

## Operating protocol

1. Remove `default_permissions` from the active macOS Codex configuration.
2. Do not use `-P` or a permissions-profile alias until a validated stable release fixes the sandbox abort.
3. Allow Codex to edit the working tree only within the normal sandbox boundary.
4. Do not broaden sandbox access merely to make `.git` writable.
5. Perform `git add`, commit, push, pull-request creation, and deployment through an approved GitHub or CI workflow outside the affected Codex sandbox.
6. Preserve the task manifest, changed-file list, and continuation state before handing the Git operation to that workflow.
7. Verify the exact commit SHA and CI result before marking the task complete.

## Removal criteria

Remove this guard only after:

1. OpenAI publishes a stable Codex release containing the permissions-profile fix.
2. A model-free `codex sandbox -P <test-profile> -- sh -c 'echo ALIVE'` canary succeeds on Apple Silicon.
3. The same canary verifies an explicitly approved `.git` write without broadening unrelated filesystem access.
4. Ten read-only tasks and two controlled idempotent write workflows pass.
5. Rollback to the current guarded launcher remains available.
