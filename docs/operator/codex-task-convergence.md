# Codex autonomous task convergence protocol

## Purpose

Long-running operator tasks must reduce a fixed set of acceptance criteria. They may not multiply tasks, review loops, agents, or verification gates without tying each addition to a newly failed criterion in the authorized manifest.

## Required controls

Each authoritative task records:

- immutable completion-criteria SHA-256;
- task and operation identifiers;
- maximum elapsed time;
- maximum correction cycles;
- maximum consecutive cycles that do not reduce remaining work;
- remaining and completed criterion identifiers;
- whether any external write outcome is uncertain;
- terminal snapshot evidence.

Subagents remain disabled on the authoritative guarded route. Parallel local analysis requires separately authorized provider-neutral manifests.

Run:

```bash
node scripts/operator/codex-task-convergence-guard.mjs \
  --input /approved/task/convergence-evidence.json \
  --json
```

Exit codes:

```text
0   task is inside its convergence envelope, or a terminal snapshot is verified
75  convergence limit reached and a terminal snapshot is required
64  policy, routing, state, provenance or write-reconciliation failure
2   malformed invocation or evidence
```

## Terminal behavior

When time, cycle, non-reduction, work-expansion, or operator-stop limits are reached:

1. Stop creating tasks, agents, reviews, and verification gates.
2. Preserve the exact task-owned diff and a SHA-256 manifest of affected paths.
3. Reconcile every uncertain external write before replay or publication.
4. When repository writes are authorized, commit and push the current work to the existing branch or a safe snapshot branch.
5. Open or update a draft pull request and record its immutable commit SHA.
6. Persist objective, criteria, current state, changed files, unresolved blockers, operation IDs, and continuation instructions outside model memory.
7. End the current task without another correction cycle.

If repository writes are not authorized, create a provider-neutral diff manifest and continuation package instead of silently discarding local work.

## Restoration condition

A new correction cycle requires a new human-authorized task manifest that names the exact failed criterion and resets a bounded cycle budget. Rewording the same goal or adding review steps does not reset the budget.
