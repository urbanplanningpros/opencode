# Codex plugin installation authority

## Boundary

Codex `0.146.0` can receive account-level remote plugin state that disagrees with its own installation policy metadata. A remote plugin must not gain model-visible skills, MCP servers, apps, hooks, or external-write authority merely because the synchronized service marks it installed or enabled.

Inventory is not authority. Authority requires an exact local approval receipt bound to:

- plugin ID;
- plugin version;
- approving operator;
- approval time;
- canonical consent receipt SHA-256;
- `plugin-enable` scope;
- `skill-injection` scope;
- the effective capability snapshot used by the task.

## Admission sequence

Before an authority-bearing task starts:

1. Capture app-server `plugin/installed` output.
2. Capture the model-visible skill catalog and each skill's plugin origin.
3. Capture the effective MCP, app, and hook catalog when those capabilities are relevant.
4. Compare every active plugin and model-visible skill with the approved plugin ledger.
5. Reject any enabled, installed, or model-visible capability without an exact ID-and-version approval receipt.
6. Treat this combination as an explicit compatibility failure unless a valid local receipt exists:

```json
{
  "source": { "type": "remote" },
  "installed": true,
  "enabled": true,
  "installPolicy": "AVAILABLE",
  "installPolicySource": null,
  "mustShowInstallationInterstitial": true,
  "authPolicy": "ON_INSTALL"
}
```

Run the evidence guard:

```bash
node scripts/operator/codex-plugin-install-authority-guard.mjs \
  --input /approved/task/codex-plugin-authority-evidence.json \
  --json
```

Exit behavior:

```text
0   exact approval authority is verified, or strict recovery is complete
75  preserve state and move the task to the strict no-plugin recovery route
64  prohibited provider, gateway, selector, or deployment route detected
2   malformed evidence
```

## Continuity recovery

Do not stop unrelated work and do not blindly delete shared plugin caches or authentication state.

When unapproved plugin capability is detected:

1. Stop only the affected authority-bearing turn.
2. Preserve task ID, turn ID, repository SHA, diff hash, operation IDs, and idempotency keys.
3. Reconcile every uncertain external write before replay.
4. Start a fresh dedicated `CODEX_HOME` that has no copied plugin, MCP, session, or authentication state from the affected profile.
5. Launch Codex through the strict wrapper:

```bash
CODEX_HOME=/var/lib/upp-operator/codex/strict-no-plugin \
node scripts/operator/codex-plugin-authority-safe-launch.mjs \
  -- \
  exec --ephemeral -
```

The wrapper forces:

```text
--disable plugins
--disable remote_plugin
--disable plugin_sharing
--disable skill_search
```

6. Recapture the effective plugin and model-visible skill catalogs.
7. Resume only after the fresh profile shows no active plugin capability and no model-visible plugin skills.
8. Use explicitly authorized local executors for required connector or deployment actions while the affected plugin route is isolated.

The remote device, account-level plugin registry, cached bundle, or model-visible skill description never grants write authority by itself.

## Approved-plugin operation

An approved plugin may be admitted only when the local approval ledger matches the exact active version and contains both required scopes. Version drift, missing consent hashes, or a changed effective capability catalog requires a new review and receipt.

Recommended receipt shape:

```json
{
  "id": "approved-plugin@approved-marketplace",
  "version": "1.0.0",
  "consentReceiptSha256": "<64 hex characters>",
  "approvedBy": "operator identity",
  "approvedAt": "2026-07-29T14:00:00Z",
  "scopes": ["plugin-enable", "skill-injection"]
}
```

For mutating tools, retain the existing exact payload approval, operation ID, idempotency key, and destination verification requirements. Plugin approval does not authorize a specific external write.

## Promotion condition

Restore normal remote-plugin production authority only after a stable Codex build proves all of the following in a disposable profile:

- a plugin with `AVAILABLE`, `ON_INSTALL`, and an installation interstitial remains inactive until the installation flow completes;
- `codex plugin list`, app-server `plugin/installed`, and the model-visible catalog agree;
- uninstalling or disabling the plugin removes its skills and processes from a fresh session;
- no account-level plugin appears in a dedicated profile without an explicit approved installation;
- connector and write approvals remain exact and independently verifiable.
