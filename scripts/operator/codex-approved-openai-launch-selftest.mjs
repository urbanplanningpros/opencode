import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const launcher = path.join(scriptDir, "codex-approved-openai-launch.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-approved-openai-"))
const home = path.join(root, "home")
fs.mkdirSync(home, { recursive: true })

function run(args = [], extraEnv = {}) {
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    OPERATOR_CODEX_BINARY: "codex",
    OPERATOR_CODEX_RUNTIME_VERSION: "codex-cli 0.145.0",
    ...extraEnv,
  })
  return spawnSync(process.execPath, [launcher, "--approved-openai-preflight-only", "--", ...args], {
    encoding: "utf8",
    env,
  })
}

const chatgpt = run(["exec", "--ephemeral", "-"])
assert.equal(chatgpt.status, 0, chatgpt.stderr)
const chatgptOutput = JSON.parse(chatgpt.stdout)
assert.equal(chatgptOutput.provider, "openai")
assert.equal(chatgptOutput.auth_profile, "openai-chatgpt-primary")
assert.match(chatgptOutput.state_profile, /codex-cli-0\.145\.0--openai-chatgpt-primary$/)
assert.equal(chatgptOutput.provider_fallback_allowed, false)
assert.deepEqual(chatgptOutput.forwarded_args.slice(0, 3), ["--", "-c", 'model_provider="openai"'])

const api = run(["exec", "--ephemeral", "-"], { OPENAI_API_KEY: "test-only" })
assert.equal(api.status, 0, api.stderr)
const apiOutput = JSON.parse(api.stdout)
assert.equal(apiOutput.auth_profile, "openai-api-primary")
assert.notEqual(apiOutput.codex_home, chatgptOutput.codex_home)

const account = run(["exec", "--ephemeral", "-"], {
  OPERATOR_CODEX_AUTH_PROFILE: "openai-business-account-b",
})
assert.equal(account.status, 0, account.stderr)
const accountOutput = JSON.parse(account.stdout)
assert.equal(accountOutput.auth_profile, "openai-business-account-b")
assert.notEqual(accountOutput.codex_home, chatgptOutput.codex_home)

const bedrock = run(["-c", 'model_provider="amazon-bedrock"', "exec", "-"])
assert.equal(bedrock.status, 64)
assert.match(bedrock.stderr, /Refusing model provider 'amazon-bedrock'/)

const gateway = run(["--config=model_provider=openrouter", "exec", "-"])
assert.equal(gateway.status, 64)
assert.match(gateway.stderr, /Refusing model provider 'openrouter'/)

const profile = run(["--profile", "unsafe", "exec", "-"])
assert.equal(profile.status, 64)
assert.match(profile.stderr, /Refusing a Codex config profile/)

const local = run(["--local-provider=ollama", "exec", "-"])
assert.equal(local.status, 64)
assert.match(local.stderr, /Refusing --local-provider/)

const shared = run(["exec", "-"], { CODEX_HOME: path.join(home, ".codex") })
assert.equal(shared.status, 64)
assert.match(shared.stderr, /Refusing shared ~\/\.codex state/)

console.log("approved OpenAI provider and auth isolation self-test passed")
