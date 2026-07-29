import path from "node:path"
import { spawn } from "node:child_process"
import { verifyEmailApproval } from "./email-send-approval.mjs"

function fail(message, code = 64) {
  console.error(message)
  process.exit(code)
}

let input = ""
for await (const chunk of process.stdin) input += chunk
let record
try {
  record = JSON.parse(input)
} catch (error) {
  fail(`invalid queue record: ${error.message}`, 2)
}

const dryRun = process.env.OPERATOR_GMAIL_DRY_RUN === "true"
let approval = null
if (!dryRun) {
  try {
    approval = verifyEmailApproval(record)
  } catch (error) {
    fail(error.message, error.exitCode || 64)
  }
}

if (process.env.OPERATOR_EMAIL_APPROVAL_TEST_NO_SEND === "true") {
  process.stdout.write(
    JSON.stringify({
      verified: true,
      test_no_send: true,
      operation_id: record.operation_id,
      approval,
    }),
  )
  process.exit(0)
}

const executor = path.join(import.meta.dirname, "gmail-send-local.mjs")
const child = spawn(process.execPath, [executor], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OPERATOR_EMAIL_APPROVAL_VERIFIED: dryRun ? "dry_run" : "1",
    OPERATOR_EMAIL_APPROVAL_PAYLOAD_SHA256: approval?.payload_sha256 || "",
    OPERATOR_EMAIL_APPROVAL_RECEIPT: approval?.receipt_path || "",
  },
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
})

child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.on("error", (error) => fail(`unable to start Gmail executor: ${error.message}`, 69))
child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Gmail executor terminated by ${signal}`)
    process.exit(70)
  }
  process.exit(code ?? 70)
})
child.stdin.end(input)
