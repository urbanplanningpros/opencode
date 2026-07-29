# Codex exec-server environment contract

## Scope

This protocol covers external or embedded Codex exec-server environments that may receive native shell tools. It supplements the parent-lifecycle guard and does not authorize a new provider, gateway, model selector, connector, or external write.

## Compatibility boundary

An explicit-shell command requires a successful `environment/info` response before `process/start`.

The reviewed bridge must return:

```json
{
  "shell": {
    "name": "bash",
    "path": "/bin/bash"
  },
  "cwd": "file:///workspace"
}
```

`cwd` is a `PathUri`. Decode and validate it as a URI before converting it to a native path. Never concatenate the literal `file:` value with a workspace path.

## Required evidence

Create a task-scoped JSON record containing:

- task and operation identifiers;
- the reviewed bridge identity SHA-256;
- the exact environment identifier;
- whether the native tool requires an explicit shell;
- the `environment/info` method, status, shell and `cwd_uri`;
- proof the probe completed before `process/start`;
- proof that the host trajectory and Codex rollout retained either the dispatched process or the pre-dispatch failure.

Run:

```bash
node scripts/operator/codex-exec-server-environment-contract-guard.mjs \
  --input /approved/task/exec-server-environment.json \
  --json
```

Exit codes:

```text
0   reviewed environment contract and process dispatch are observable
75  bridge compatibility or process-dispatch readiness failure
64  unsafe authority, path, routing, provenance or observability mismatch
2   malformed invocation or evidence
```

## Failure handling

When `environment/info` is missing, rejected or malformed:

1. Do not rely on model retries to change the command encoding.
2. Do not grant explicit-shell authority to that environment.
3. Preserve the failure in both the host trajectory and Codex rollout.
4. Keep unrelated tasks running through direct OpenAI or the explicitly authorized local route.
5. Patch the same reviewed bridge identity to implement `environment/info`.
6. Start a fresh bounded task after the contract passes.
7. Reconcile any external write whose outcome was uncertain before replay.

A command that reaches `process/start` only after a model retry removed the record-level shell field is not a valid compatibility fix.

## Promotion canary

Before admitting a bridge to production:

1. Verify `environment/info` returns the reviewed shell executable and PathUri.
2. Run one read-only `pwd` command with an explicit shell.
3. Confirm the host trajectory and Codex rollout both retain `process/start` and its result.
4. Intentionally return method-not-found in a disposable environment.
5. Confirm no `process/start` occurs and both evidence stores retain a structured pre-dispatch failure.
6. Restore the valid implementation and repeat the read-only canary twice.
