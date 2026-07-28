# Direct OpenAI image-edit continuity

Use this route when Codex Desktop's built-in image editor returns a transport-shaped error for a valid multi-reference edit. It calls the direct OpenAI Responses API and does not use a model gateway, automatic model selector, or third-party provider.

## Queue an edit

```bash
bun operator:queue \
  --action openai_image_edit \
  --operation-id image-edit-001 \
  --idempotency-key image-edit-001-v1 \
  --payload '{
    "prompt":"Arrange the four reference products in one coherent composition.",
    "images":["assets/a.png","assets/b.png","assets/c.png","assets/d.png"],
    "output_path":"artifacts/image-edit-001.png"
  }'
```

Execute the queued action through the dedicated local shim:

```bash
export OPERATOR_ACTION_EXECUTOR_COMMAND='["node","scripts/operator/openai-image-edit-local.mjs"]'
export OPENAI_API_KEY='<host-scoped OpenAI key>'
export OPERATOR_IMAGE_INPUT_ROOTS='/approved/input/root'
export OPERATOR_IMAGE_OUTPUT_ROOTS='/approved/output/root'

bun operator:process
```

The API key belongs only in the executor environment. Do not place it in prompts, task manifests, repository files, CI logs, or local-model environments.

## Safety and continuity behavior

The executor:

- permits only the direct `api.openai.com/v1` endpoint;
- defaults to the explicitly approved `gpt-5.6` model and rejects excluded-provider or gateway identifiers;
- allows PNG, JPEG, and WebP references from approved roots;
- supports up to eight references by default and requires a PNG output path under an approved root;
- records only hashes and operation metadata in its receipt, not prompt text or image bytes;
- writes a `dispatching` receipt before the API request;
- marks transport timeouts, selected retryable HTTP outcomes, and server errors as `uncertain`;
- refuses to replay an uncertain operation automatically;
- atomically writes and hashes the generated PNG before returning `verified=true`.

A generic Desktop `network error` is not evidence that an edit was rejected. Reconcile the existing operation receipt before issuing a new idempotency key.

## Dry-run validation

```bash
export OPERATOR_OPENAI_IMAGE_EDIT_DRY_RUN=true
export OPERATOR_IMAGE_INPUT_ROOTS="$PWD"
export OPERATOR_IMAGE_OUTPUT_ROOTS="$PWD"

node scripts/operator/openai-image-edit-local.mjs < queue-record.json
```

Dry-run mode validates references, roots, model restrictions, request shape, and output location without sending image data or requiring an API key.

## Return to the Desktop path

Resume the built-in Codex image editor only after a fixed build completes a disposable four-reference edit, preserves benign requested text, returns structured error codes and request IDs for rejected requests, and completes three later text turns without corrupting session history.
