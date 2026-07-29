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
