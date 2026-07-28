# Codex skill catalog budget continuity

OpenAI Codex can render host-provided skills and executor-provided skills under one shared context budget. Under pressure, descriptions may be removed and host skills may be omitted before executor skills. A skill that exists on disk or in a connector is not necessarily visible to the active model turn.

## Authority boundary

Before granting repository-write, deployment, connector, email, CRM, database, billing, or customer-facing authority, capture the model-visible catalog and any Codex skill-budget warnings into a task-owned JSON file:

```json
{
  "schema_version": 1,
  "runtime": "codex",
  "catalog_source": "app-server world-state capture",
  "write_authority_requested": true,
  "required_skills": [
    "operator-continuity",
    "github-review"
  ],
  "visible_host_skills": [
    "operator-continuity"
  ],
  "visible_executor_skills": [
    "github-review"
  ],
  "warnings": []
}
```

Run:

```bash
bun operator:skill-budget-guard \
  --input /approved/task/skill-catalog-evidence.json \
  --json
```

Exit codes:

- `0`: the declared required skills are visible within the requested authority boundary.
- `75`: compatibility containment is required because a required skill is missing or a write-authorized turn reports catalog budget pressure.
- `64`: the catalog contains a prohibited provider, gateway, or automatic-routing identifier.
- `2`: malformed evidence.

## Containment route

When the guard exits `75`:

1. Preserve the task manifest, repository state, operation IDs, idempotency keys, and the failed catalog evidence.
2. Do not repeatedly retry the same overloaded skill catalog.
3. Start a fresh approved Codex task with only the exact required host and executor skills.
4. Shorten nonessential skill descriptions and remove unused optional skills from that task profile.
5. Capture a new model-visible catalog and rerun the guard.
6. Restore external-write authority only after the guard returns `verified`.
7. Reconcile any uncertain external write before replay.

Read-only work may continue under catalog pressure only when every declared required skill remains visible. Catalog discovery never authorizes a skill, connector, provider, or write by itself.

## Promotion test

Before adopting a Codex release containing the shared-budget behavior, test at least:

1. Host-only catalog under normal capacity.
2. Executor-only catalog under normal capacity.
3. Mixed catalog with shortened descriptions.
4. Mixed catalog where host skills are omitted first.
5. Required-skill admission failure when any required skill is omitted.
6. No prohibited provider or gateway identifiers in either catalog.
7. Fresh-task recovery with a bounded required-skill profile.
