#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  assessWindowsGitStorm,
  buildScopedGhHostPlan,
  buildWindowsGitStormContinuityPlan,
  detectSandboxedGhKeyringFalseFailure,
} from './codex-windows-gitstorm-github-keyring-guard.mjs';

const approvedRoute = {
  provider: 'openai',
  model: 'gpt-5.6-terra',
  automaticModelSelection: false,
  gateway: null,
  fallbacks: [],
};

const calm = assessWindowsGitStorm({
  windowSeconds: 60,
  gitStarts: 3,
  chatgptDirectGitStarts: 1,
  conhostStarts: 2,
  chatgptDirectPowerShellStarts: 0,
  commitUtilizationPercent: 42,
  pageTableBytes: 512 * 1024 ** 2,
  availablePhysicalBytes: 12 * 1024 ** 3,
});
assert.equal(calm.stormDetected, false);
assert.equal(calm.criticalMemoryPressure, false);

const storm = assessWindowsGitStorm({
  windowSeconds: 12,
  gitStarts: 40,
  chatgptDirectGitStarts: 21,
  conhostStarts: 42,
  chatgptDirectPowerShellStarts: 18,
  commitUtilizationPercent: 35.7,
  pageTableBytes: 1 * 1024 ** 3,
  availablePhysicalBytes: 21 * 1024 ** 3,
});
assert.equal(storm.stormDetected, true);
assert.equal(storm.criticalMemoryPressure, false);
assert.equal(storm.rates.directGitStartsPerMinute, 105);
assert.equal(storm.rates.gitStartsPerMinute, 200);

const criticalStorm = assessWindowsGitStorm({
  windowSeconds: 20,
  gitStarts: 33,
  chatgptDirectGitStarts: 17,
  commitUtilizationPercent: 95.9,
  pageTableBytes: 9.63 * 1024 ** 3,
  availablePhysicalBytes: 1.19 * 1024 ** 3,
});
assert.equal(criticalStorm.stormDetected, true);
assert.equal(criticalStorm.criticalMemoryPressure, true);

const calmPlan = buildWindowsGitStormContinuityPlan({
  operationId: 'gitstorm-calm-001',
  repositoryRoot: 'D:\\work\\opencode',
  expectedHead: '96130457e51cc1c32436042a9dd44a5aefce377c',
  evidence: {
    windowSeconds: 60,
    gitStarts: 1,
    chatgptDirectGitStarts: 0,
  },
  operatorRoute: approvedRoute,
});
assert.equal(calmPlan.status, 'no_material_signal');

const containmentPlan = buildWindowsGitStormContinuityPlan({
  operationId: 'gitstorm-contain-001',
  repositoryRoot: 'D:\\work\\opencode',
  expectedHead: '96130457e51cc1c32436042a9dd44a5aefce377c',
  evidence: {
    windowSeconds: 60,
    gitStarts: 45,
    chatgptDirectGitStarts: 23,
    commitUtilizationPercent: 50,
    pageTableBytes: 1 * 1024 ** 3,
    availablePhysicalBytes: 16 * 1024 ** 3,
  },
  operatorRoute: approvedRoute,
});
assert.equal(containmentPlan.status, 'containment_required');
assert.equal(containmentPlan.approvedFallback.operatorRoute.provider, 'openai');
assert.equal(containmentPlan.approvedFallback.operatorRoute.model, 'gpt-5.6-terra');
assert.equal(containmentPlan.approvedFallback.operatorRoute.automaticModelSelection, false);
assert.deepEqual(containmentPlan.approvedFallback.operatorRoute.fallbacks, []);
assert.equal(containmentPlan.guidedIntervention.required, false);
assert.ok(containmentPlan.scope.continue.includes('unrelated-connectors-and-automations'));
assert.ok(containmentPlan.prohibitedAutomaticActions.includes('reboot the host automatically'));

const interventionPlan = buildWindowsGitStormContinuityPlan({
  operationId: 'gitstorm-critical-001',
  repositoryRoot: 'D:\\work\\opencode',
  expectedHead: '96130457e51cc1c32436042a9dd44a5aefce377c',
  evidence: {
    windowSeconds: 60,
    gitStarts: 44,
    chatgptDirectGitStarts: 22,
    commitUtilizationPercent: 90,
    pageTableBytes: 5 * 1024 ** 3,
    availablePhysicalBytes: 1.5 * 1024 ** 3,
  },
  operatorRoute: approvedRoute,
});
assert.equal(interventionPlan.status, 'guided_intervention_required');
assert.equal(interventionPlan.guidedIntervention.required, true);
assert.ok(interventionPlan.guidedIntervention.approvalRequiredBefore.includes('restarting Windows'));

assert.throws(
  () =>
    buildWindowsGitStormContinuityPlan({
      operationId: 'bad-route-auto',
      repositoryRoot: '.',
      expectedHead: 'abcdef1',
      evidence: { windowSeconds: 60 },
      operatorRoute: { ...approvedRoute, automaticModelSelection: true },
    }),
  /automatic model selection must be disabled/,
);
assert.throws(
  () =>
    buildWindowsGitStormContinuityPlan({
      operationId: 'bad-route-gateway',
      repositoryRoot: '.',
      expectedHead: 'abcdef1',
      evidence: { windowSeconds: 60 },
      operatorRoute: { ...approvedRoute, gateway: 'model-router' },
    }),
  /model gateways are prohibited/,
);
assert.throws(
  () =>
    buildWindowsGitStormContinuityPlan({
      operationId: 'bad-route-provider',
      repositoryRoot: '.',
      expectedHead: 'abcdef1',
      evidence: { windowSeconds: 60 },
      operatorRoute: { ...approvedRoute, provider: 'unapproved-provider' },
    }),
  /unapproved provider/,
);
assert.throws(
  () =>
    buildWindowsGitStormContinuityPlan({
      operationId: 'bad-route-fallback',
      repositoryRoot: '.',
      expectedHead: 'abcdef1',
      evidence: { windowSeconds: 60 },
      operatorRoute: { ...approvedRoute, fallbacks: ['another-route'] },
    }),
  /fallback chains must be empty/,
);

const keyringEvidence = {
  credentialStore: 'keyring',
  sandboxCheck: {
    exitCode: 1,
    stderr: 'Failed to log in to github.com account operator. The token in default is invalid.',
  },
  scopedHostCheck: {
    exitCode: 0,
    stdout: 'Logged in to github.com account operator (keyring)\nActive account: true',
  },
};
assert.equal(detectSandboxedGhKeyringFalseFailure(keyringEvidence), true);
assert.equal(
  detectSandboxedGhKeyringFalseFailure({
    ...keyringEvidence,
    scopedHostCheck: { exitCode: 1, stderr: 'also failed' },
  }),
  false,
);
assert.equal(
  detectSandboxedGhKeyringFalseFailure({
    ...keyringEvidence,
    credentialStore: 'file',
    scopedHostCheck: { exitCode: 0, stdout: 'Logged in to github.com account operator' },
  }),
  false,
);

const readPlan = buildScopedGhHostPlan({
  operationId: 'gh-read-001',
  evidence: keyringEvidence,
  ghArgv: ['gh', 'repo', 'view', 'urbanplanningpros/opencode', '--json', 'nameWithOwner'],
  expectedAccount: 'urbanplanningpros',
  repository: 'urbanplanningpros/opencode',
  operatorRoute: approvedRoute,
});
assert.equal(readPlan.status, 'scoped_host_retry_ready');
assert.equal(readPlan.diagnosis.reauthenticationRequired, false);
assert.equal(readPlan.scopedHostCommand.shell, false);
assert.deepEqual(readPlan.scopedHostCommand.argv.slice(0, 3), ['gh', 'repo', 'view']);
assert.equal(readPlan.guidedIntervention.required, false);
assert.ok(readPlan.protocol.doNot.includes('run gh auth login'));

const writePlan = buildScopedGhHostPlan({
  operationId: 'gh-write-001',
  evidence: keyringEvidence,
  ghArgv: ['gh', 'pr', 'create', '--repo', 'urbanplanningpros/opencode'],
  expectedAccount: 'urbanplanningpros',
  repository: 'urbanplanningpros/opencode',
  operatorRoute: approvedRoute,
});
assert.equal(writePlan.status, 'guided_intervention_required');
assert.equal(writePlan.guidedIntervention.required, true);
assert.ok(writePlan.guidedIntervention.verifyBeforeApproval.includes('idempotency key for any write'));

const noMatchPlan = buildScopedGhHostPlan({
  operationId: 'gh-no-match-001',
  evidence: {
    credentialStore: 'keyring',
    sandboxCheck: { exitCode: 0, stdout: 'Logged in' },
    scopedHostCheck: { exitCode: 0, stdout: 'Logged in to github.com (keyring)' },
  },
  ghArgv: ['gh', 'auth', 'status'],
  expectedAccount: 'urbanplanningpros',
  repository: 'urbanplanningpros/opencode',
  operatorRoute: approvedRoute,
});
assert.equal(noMatchPlan.status, 'no_matching_false_failure');

assert.throws(
  () =>
    buildScopedGhHostPlan({
      operationId: 'gh-unsafe-001',
      evidence: keyringEvidence,
      ghArgv: ['gh', 'repo', 'view\nwhoami'],
      expectedAccount: 'urbanplanningpros',
      repository: 'urbanplanningpros/opencode',
      operatorRoute: approvedRoute,
    }),
  /unsafe control character/,
);
assert.throws(
  () =>
    buildScopedGhHostPlan({
      operationId: 'gh-shell-001',
      evidence: keyringEvidence,
      ghArgv: ['bash', '-lc', 'gh auth status'],
      expectedAccount: 'urbanplanningpros',
      repository: 'urbanplanningpros/opencode',
      operatorRoute: approvedRoute,
    }),
  /must begin with gh/,
);
assert.throws(
  () =>
    buildScopedGhHostPlan({
      operationId: 'gh-auto-001',
      evidence: keyringEvidence,
      ghArgv: ['gh', 'auth', 'status'],
      expectedAccount: 'urbanplanningpros',
      repository: 'urbanplanningpros/opencode',
      operatorRoute: { ...approvedRoute, automaticModelSelection: true },
    }),
  /automatic model selection must be disabled/,
);

process.stdout.write('codex-windows-gitstorm-github-keyring-guard: 36 checks passed\n');
