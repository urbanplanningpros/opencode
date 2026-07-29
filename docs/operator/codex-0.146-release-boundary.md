# Codex 0.146 Release Boundary

Codex CLI 0.146.0 promotes several capabilities that materially change operator behavior, including Agent Plugins manifests, workspace plugin publishing, additional plugin marketplaces, remote Code Mode hosts, executor-provided skills, broader proxy-aware routing, MCP runtime refreshes, and more durable replay and fork state.

The approved operator route remains limited to explicitly pinned direct OpenAI execution and an explicitly authorized local route. External-provider imports, provider marketplaces, model gateways, automatic model selection, and model-owned dependency installation are not admitted.

## Guarded launch

```bash
node scripts/operator/codex-0146-safe-launch.mjs \
  --dry-run \
  -- \
  exec --ephemeral -

node scripts/operator/codex-0146-safe-launch.mjs \
  -- \
  exec --ephemeral -
```

The wrapper delegates to `codex-cache-safe-launch.mjs` and adds release-specific controls. It forces these additional features off:

```text
hooks
code_mode_host
standalone_web_search
multi_agent
mcp_2026_07_28
tool_suggest
executor_capability_discovery
plugin_sharing
skill_mcp_dependency_install
```

The delegated launcher continues to disable:

```text
remote_plugin
code_mode
code_mode_only
multi_agent_v2
token_budget
external_agent_memory_import
```

The wrapper also inspects the active `CODEX_HOME` configuration, settings, and known marketplace metadata. It rejects symlinked configuration paths and any runtime metadata or operator environment route containing an excluded provider, automatic model selector, model gateway, Bedrock, Vertex, or Copilot routing identifier.

## MCP file uploads and deferred environment readiness

The stable `0.146.0` tag predates upstream commit `250de82bfb51a210325e88bfe1f7c30b0fa514f0`. Without that change, an MCP tool call can execute after a selected remote environment becomes ready while file-argument rewriting still reads the earlier turn-start snapshot. The result can be a missing primary environment, an incorrect capability root, or a file upload resolved against stale environment state.

Before any Codex Apps or MCP call with local file arguments, run:

```bash
node scripts/operator/codex-mcp-file-upload-environment-guard.mjs \
  --input /approved/task/mcp-file-upload-receipt.json \
  --json
```

The receipt must bind the operation and idempotency identifiers, exact tool and argument hash, current step primary environment, capability-root hash, and file provenance. A production `0.146.0` call is allowed only when the approved environment was already ready and primary at turn start and remains the ready primary environment in the current step.

When an environment becomes ready during the turn on an unfixed runtime:

```text
Preserve the operation ID, idempotency key, file hashes and environment identity
→ do not dispatch through the stale turn
→ wait for the approved environment to become ready
→ start a fresh guarded turn and recapture the step environment
→ or route through an explicitly authorized local connector executor
→ independently verify every external write
```

A source build containing the upstream step-context fix remains canary-only until a stable release containing the fix passes the production promotion suite. Do not infer that a later version contains the fix without an artifact or source receipt.

## Remote thread visibility and indexing

A remote sidebar is not the state authority. Before a `0.146.0` remote canary, capture a host-side thread inventory and preserve provider-neutral task manifests outside Codex session state.

If remote project threads disappear from the Desktop sidebar while the remote host and project remain connected:

```text
Preserve CODEX_HOME, session files, state databases and task manifests
→ do not delete, reset, reindex or copy the state profile
→ compare host-side thread IDs with the last inventory
→ continue authorized work through the guarded host CLI or app-server
→ reconcile uncertain writes by operation and idempotency key
→ restore remote-sidebar authority only after the same inventory remains visible across two reconnect canaries
```

Thread visibility loss is not evidence that the underlying task or state was deleted. It also must not authorize replaying an operation whose outcome is unknown.

## Windows background Git credential checks

A Windows Desktop report shows ordinary chat activity triggering `git remote show` against a stale ChatGPT Sites HTTPS remote and opening Git Credential Manager without an operator-requested Git action. Before admitting Desktop against a repository:

1. Record `git remote -v` and the repository-local Git configuration.
2. Do not expose repositories with stale or unnecessary Sites remotes to the production Desktop profile.
3. Use a separate clean clone with only reviewed remotes when the original repository must retain its Sites remote.
4. Treat any unexpected credential UI, `git remote show`, or `git credential-manager` process as a canary failure.
5. Continue work through guarded CLI, WSL, or the VPS route rather than broadening credential access.

Do not delete a required remote merely to suppress the prompt. Preserve its URL and purpose first, then remove it only through a reviewed repository change when it is genuinely obsolete.

## Production promotion

Do not replace the currently validated Codex binary in place. Install 0.146.0 into a separate release path and use a separate `CODEX_HOME` for the canary.

Promote only after all of the following pass:

1. Verify the release artifact and record its SHA-256.
2. Run the guarded launcher dry run and preserve the resulting argument receipt.
3. Run ten read-only direct-OpenAI tasks with no plugin, hook, agent, marketplace, or external-session import activity.
4. Verify an approved MCP connector remains available after authentication and configuration refresh without introducing an unexpected tool or app.
5. Verify an interrupted task preserves the submitted message, final response, failure state, and approval settings.
6. Verify one paginated fork and one ephemeral fork preserve parent lineage and do not duplicate external writes.
7. Verify process-tree shutdown leaves no owned child process or MCP transport behind.
8. Run two idempotent writes through the durable queue and independently verify both target states.
9. Confirm rollback to the previously validated Codex binary and state profile.
10. Verify one static-ready MCP file upload and reject one deferred-readiness upload on stable `0.146.0`; validate the deferred path only on an isolated fixed-runtime canary.
11. Verify the host-side remote thread inventory remains complete through two Desktop reconnects.
12. Verify ordinary chat activity does not invoke an unrequested remote Git check or credential helper.

## Failure handling

When a canary fails:

```text
Checkpoint the task manifest and operation IDs
→ isolate only the 0.146 canary profile
→ route new work to the previously validated direct OpenAI binary or authorized local route
→ reconcile uncertain writes
→ preserve the canary CODEX_HOME and logs
→ correct the guard or wait for a vendor fix
```

Do not pause unrelated business-critical operations. Do not reuse a canary state profile as the production profile after a failed admission test.
