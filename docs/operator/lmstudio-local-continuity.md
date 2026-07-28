# LM Studio local continuity

Codex CLI 0.145.0 can request LM Studio's OpenAI-compatible `GET /v1/models` endpoint through its generic model manager. LM Studio returns the standard `{ "data": [...] }` shape, while that Codex path expects a Codex-specific `{ "models": [...] }` catalog. Treat `codex --oss --local-provider lmstudio` as unavailable when the probe reports `direct_local_required`.

This continuity route is intentionally narrow:

- loopback HTTP only;
- exact local-model allowlist;
- no remote MCP, tools, model gateways, or automatic model selection;
- no credentials in prompts or URLs;
- bounded text-only Responses requests with `store=false`;
- direct OpenAI remains the primary full operator route.

## Configure

```bash
export OPERATOR_LMSTUDIO_BASE_URL='http://127.0.0.1:1234'
export OPERATOR_LMSTUDIO_MODEL='openai/gpt-oss-20b'
export OPERATOR_LMSTUDIO_ALLOWED_MODELS='["openai/gpt-oss-20b"]'
```

When LM Studio API authentication is enabled, inject the token only into the executor environment:

```bash
export OPERATOR_LMSTUDIO_API_TOKEN='<host-scoped-token>'
```

Do not place that token in a task manifest, prompt, repository, or log.

## Probe Codex compatibility

```bash
bun scripts/operator/codex-lmstudio-local-route.mjs --probe --json
```

Exit codes:

- `0`: the catalog already has the Codex `models` shape;
- `75`: LM Studio is healthy, but the installed Codex catalog path is incompatible; use direct local execution;
- `64`: provider/model policy rejection;
- `69`: local service or response failure.

## Verify direct local inference

```bash
bun scripts/operator/codex-lmstudio-local-route.mjs --canary --json
```

The canary must return `status: verified` before admitting read-only continuity work.

## Use with the durable operator router

Configure the local command as an exact argument array:

```bash
export OPERATOR_LOCAL_COMMAND='[
  "bun",
  "scripts/operator/codex-lmstudio-local-route.mjs",
  "--execute"
]'
```

Then run the existing provider-neutral task router. This executor returns text only. It cannot edit files, run commands, invoke connectors, or authorize an external write. Use it for state reconstruction, bounded analysis, patch drafting, and continuation planning while the full Codex LM Studio path is unavailable.

For builds, deployments, repository mutations, and connector operations, continue through guarded direct OpenAI or an explicitly authorized host-local command path. Preserve operation IDs and idempotency keys, and reconcile uncertain writes before replay.

## Resume condition

Return the Codex LM Studio route to production only after a stable Codex release:

1. accepts LM Studio's standard `/v1/models` payload or bypasses the incompatible catalog refresh;
2. reaches `/v1/responses` with the explicitly selected model;
3. passes three read-only tool canaries;
4. preserves the provider and model allowlists;
5. does not introduce a gateway or automatic provider fallback.
