#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  auditGitHubInstallationEvidence,
  buildWindowsSandboxContinuityPlan,
  detectWindowsSandboxRefreshFailure,
} from './codex-windows-sandbox-github-readiness-guard.mjs';

const failureLog = `
helper_sandbox_lock_failed
lock sandbox bin dir D:\\OpenAI\\Codex\\home\\.sandbox-bin failed:
SetNamedSecurityInfoW sandbox dir failed: 5
`;

assert.equal(detectWindowsSandboxRefreshFailure(failureLog), true);
assert.equal(
  detectWindowsSandboxRefreshFailure('SetNamedSecurityInfoW failed: 5 but no sandbox lock signature'),
  false,
);

const plan = buildWindowsSandboxContinuityPlan({
  operationId: 'windows-sandbox-canary-001',
  repositoryRoot: 'D:\\work\\opencode',
  expectedHead: '77493842b4c7960c30233ec75f0a461b99f05711',
  logSha256: 'a'.repeat(64),
  wslDistribution: 'Ubuntu',
  wslRepositoryRoot: '/home/operator/opencode',
});
assert.equal(plan.approvedFallback.provider, 'openai');
assert.equal(plan.approvedFallback.model, 'gpt-5.6-terra');
assert.equal(plan.approvedFallback.automaticModelSelection, false);
assert.equal(plan.approvedFallback.gateway, null);
assert.deepEqual(plan.approvedFallback.fallbacks, []);
assert.equal(plan.guidedIntervention.required, true);
assert.ok(plan.guidedIntervention.prohibitedAutomaticActions.includes('rewrite its DACL'));

const baseEvidence = {
  identityAuthenticated: true,
  operatorRoute: {
    provider: 'openai',
    model: 'gpt-5.6-terra',
    automaticModelSelection: false,
    gateway: null,
    fallbacks: [],
  },
  requiredRepositories: ['urbanplanningpros/opencode'],
  accessibleRepositories: [],
  installations: [],
};

const missingInstallation = auditGitHubInstallationEvidence({
  operationId: 'github-canary-001',
  evidence: baseEvidence,
});
assert.equal(missingInstallation.status, 'guided_intervention_required');
assert.deepEqual(missingInstallation.gaps.missingInstallationTargets, ['urbanplanningpros']);
assert.deepEqual(missingInstallation.gaps.inaccessibleRepositories, ['urbanplanningpros/opencode']);
assert.equal(missingInstallation.protocol.allowMutation, false);

const missingRepoSelection = auditGitHubInstallationEvidence({
  operationId: 'github-canary-002',
  evidence: {
    ...baseEvidence,
    installations: [{ account: 'urbanplanningpros', type: 'organization', appInstalled: true }],
  },
});
assert.equal(missingRepoSelection.status, 'guided_intervention_required');
assert.deepEqual(missingRepoSelection.gaps.missingInstallationTargets, []);
assert.deepEqual(missingRepoSelection.gaps.inaccessibleRepositories, ['urbanplanningpros/opencode']);

const ready = auditGitHubInstallationEvidence({
  operationId: 'github-canary-003',
  evidence: {
    ...baseEvidence,
    installations: [{ account: 'urbanplanningpros', type: 'organization', appInstalled: true }],
    accessibleRepositories: ['urbanplanningpros/opencode'],
  },
});
assert.equal(ready.status, 'ready');
assert.equal(ready.protocol.allowReadOnlyCanary, true);
assert.equal(ready.protocol.allowMutation, false);

assert.throws(
  () =>
    auditGitHubInstallationEvidence({
      operationId: 'github-canary-004',
      evidence: {
        ...baseEvidence,
        operatorRoute: {
          provider: 'openai',
          model: 'gpt-5.6-terra',
          automaticModelSelection: true,
          gateway: null,
          fallbacks: [],
        },
      },
    }),
  /automatic model selection must be disabled/,
);

assert.throws(
  () =>
    auditGitHubInstallationEvidence({
      operationId: 'github-canary-005',
      evidence: {
        ...baseEvidence,
        operatorRoute: {
          provider: 'openai',
          model: 'gpt-5.6-terra',
          automaticModelSelection: false,
          gateway: 'model-gateway',
          fallbacks: [],
        },
      },
    }),
  /model gateways are prohibited/,
);

assert.throws(
  () =>
    auditGitHubInstallationEvidence({
      operationId: 'github-canary-006',
      evidence: {
        ...baseEvidence,
        operatorRoute: {
          provider: 'anthropic',
          model: 'gpt-5.6-terra',
          automaticModelSelection: false,
          gateway: null,
          fallbacks: [],
        },
      },
    }),
  /unapproved provider/,
);

process.stdout.write('codex-windows-sandbox-github-readiness-guard: 17 checks passed\n');
