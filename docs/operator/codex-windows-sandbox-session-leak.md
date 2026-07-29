# Codex Windows sandbox logon-session boundary

## Scope

Upstream `openai/codex#35940` reports that Windows `codex sandbox` invocations on measured Codex CLI `0.144.3` and `0.146.0` builds create `CodexSandboxOffline` interactive logon sessions that remain retained by `lsass.exe` after the command exits. A related earlier report, `openai/codex#33356`, measured persistent LSASS-handle growth during sandboxed Windows command execution.

This boundary blocks only affected Windows sandbox command authority. Guarded direct OpenAI planning, ordinary repository work, the approved Linux VPS executor, and explicitly authorized local Linux routes remain available.

## Admission guard

```bash
node scripts/operator/codex-windows-sandbox-session-guard.mjs --json
```

For deterministic or remote evidence:

```bash
node scripts/operator/codex-windows-sandbox-session-guard.mjs \
  --evidence /approved/task/windows-sandbox-session-evidence.json \
  --json
```

The evidence object may include:

```json
{
  "platform": "win32",
  "operation": "codex_sandbox",
  "codex_version": "0.146.0",
  "codex_sandbox_logon_sessions": 120,
  "baseline_codex_sandbox_logon_sessions": 110,
  "interactive_logon_sessions": 140,
  "lsass_handles": 4900,
  "session_probe_complete": true
}
```

Exit behavior:

```text
0   bounded route or fully attested fixed-build canary
75  Windows sandbox route withheld; checkpoint and reroute required
64  prohibited provider, gateway, or automatic-selection metadata
2   malformed evidence or threshold configuration
```

## Continuity route

When the guard exits `75`:

1. Persist the task manifest, exact repository SHA, current diff, operation IDs, idempotency keys, and uncertain-write ledger.
2. Stop scheduling new Windows sandbox commands. Do not kill unrelated work or pause the entire operator stack.
3. Reconcile any command or external write whose outcome is uncertain.
4. Keep Windows as a control surface only and execute commands through the approved Linux VPS or an explicitly authorized local Linux runner.
5. Do not switch to the unelevated Windows sandbox as a workaround. The upstream reproduction found that network denial and piped child-process behavior were not reliable in that mode.
6. After state is safely persisted, reboot an affected host when orphaned sessions or LSASS-handle pressure must be reclaimed. Current reports indicate that stopping Codex processes does not release the retained LSASS state.

Do not use unrestricted execution on a credentialed production Windows host to avoid the leak.

## Promotion gate

Restore Windows `codex sandbox` authority only after a stable Codex build passes all of the following on a disposable Windows host:

- at least 500 sandbox invocations;
- zero net `CodexSandboxOffline` logon-session growth;
- no persistent LSASS-handle growth after the commands exit;
- verified network denial under the intended sandbox policy;
- successful piped child-process execution, including a `node --test`-style runner;
- clean task-state preservation and no uncertain external writes.

A fixed-build attestation must record:

```json
{
  "release_fix_attested": true,
  "canary_invocations": 500,
  "canary_session_delta": 0,
  "network_denial_passed": true,
  "piped_spawn_passed": true
}
```

This attestation permits only the tested pinned build and profile. It does not authorize automatic model selection, gateways, alternate providers, imported sessions, or unrelated connector authority.
