#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "codex-git-storm-guard-"));
const guard = fileURLToPath(new URL("./codex-windows-git-storm-guard.mjs", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runFixture(name, fixture) {
  const path = join(root, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [guard, "--fixture", path, "--json"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(result.stdout);
  return { ...result, parsed };
}

try {
  const healthy = runFixture("healthy", {
    platform: "win32",
    sample_seconds: 60,
    git_starts: 4,
    conhost_starts: 2,
    codex_attributed_git_starts: 2,
    pid4_handles_start: 100000,
    pid4_handles_end: 100030,
    commit_percent: 45,
    codex_desktop_present: true,
    codex_vscode_extension_present: true,
    observed_request_kinds: [],
    observed_sources: [],
  });
  assert(healthy.status === 0, "healthy fixture should exit 0");
  assert(healthy.parsed.status === "healthy", "healthy fixture status mismatch");
  assert(healthy.parsed.admission.codex_desktop_git_integration === true, "healthy admission should remain open");

  const sidebarStorm = runFixture("sidebar-storm", {
    platform: "win32",
    sample_seconds: 60,
    git_starts: 172,
    conhost_starts: 140,
    codex_attributed_git_starts: 172,
    pid4_handles_start: 622528,
    pid4_handles_end: 624000,
    commit_percent: 73,
    codex_desktop_present: false,
    codex_vscode_extension_present: true,
    observed_request_kinds: ["git-origins"],
    observed_sources: ["sidebar_workspace_task_groups_task_dirs"],
  });
  assert(sidebarStorm.status === 75, "sidebar storm should fail closed with 75");
  assert(sidebarStorm.parsed.status === "recovery_required", "sidebar storm should require recovery");
  assert(sidebarStorm.parsed.admission.codex_vscode_extension === false, "extension admission should close");
  assert(sidebarStorm.parsed.admission.guarded_direct_openai_cli === true, "direct OpenAI continuity must remain available");

  const desktopStorm = runFixture("desktop-storm", {
    platform: "win32",
    sample_seconds: 15,
    git_starts: 31,
    conhost_starts: 28,
    codex_attributed_git_starts: 31,
    pid4_handles_start: 200000,
    pid4_handles_end: 200120,
    commit_percent: 94,
    codex_desktop_present: true,
    codex_vscode_extension_present: false,
    observed_request_kinds: ["review-summary", "status-summary", "branch-diff-stats"],
    observed_sources: ["local_conversation_git_actions", "review_model"],
  });
  assert(desktopStorm.status === 75, "desktop storm should fail closed with 75");
  assert(desktopStorm.parsed.status === "recovery_required", "desktop storm should require recovery");
  assert(desktopStorm.parsed.admission.codex_desktop_git_integration === false, "Desktop admission should close");

  const warning = runFixture("warning", {
    platform: "win32",
    sample_seconds: 60,
    git_starts: 50,
    conhost_starts: 20,
    codex_attributed_git_starts: 50,
    pid4_handles_start: 300000,
    pid4_handles_end: 300100,
    commit_percent: 65,
    codex_desktop_present: true,
    codex_vscode_extension_present: false,
    observed_request_kinds: ["review-summary"],
    observed_sources: ["review_model"],
  });
  assert(warning.status === 75, "warning fixture should close UI admission with 75");
  assert(warning.parsed.status === "warning", "warning fixture status mismatch");

  process.stdout.write("codex windows git storm guard self-test passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
