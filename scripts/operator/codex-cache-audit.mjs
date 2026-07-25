import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

function filesIn(directory) {
  if (!fs.existsSync(directory)) return []
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
}

function candidateFiles(codexHome) {
  return [
    ...filesIn(path.join(codexHome, "cache", "remote_plugin_catalog")),
    ...filesIn(path.join(codexHome, "cache", "codex_apps_tools")),
    path.join(codexHome, "models_cache.json"),
  ].filter((file) => fs.existsSync(file))
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function snapshot(files) {
  return new Map(
    files.map((file) => {
      const stat = fs.statSync(file)
      return [
        file,
        {
          size: stat.size,
          mtime_ms: stat.mtimeMs,
          sha256: digest(file),
        },
      ]
    }),
  )
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const args = parseArgs(process.argv.slice(2))
const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const durationMs = Math.max(0, Number(args["duration-ms"] || 10_000))
const intervalMs = Math.max(50, Number(args["interval-ms"] || 500))
const thresholdBytesPerDay = Math.max(0, Number(args["threshold-bytes-per-day"] || 1_073_741_824))
const files = candidateFiles(codexHome)
const initial = snapshot(files)
const activity = new Map(
  files.map((file) => [
    file,
    {
      file,
      size: initial.get(file).size,
      rewrites: 0,
      identical_rewrites: 0,
      bytes_written: 0,
      last_mtime_ms: initial.get(file).mtime_ms,
      last_sha256: initial.get(file).sha256,
    },
  ]),
)

const startedAt = Date.now()
while (Date.now() - startedAt < durationMs) {
  await sleep(Math.min(intervalMs, Math.max(0, durationMs - (Date.now() - startedAt))))
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const stat = fs.statSync(file)
    const record = activity.get(file)
    if (stat.mtimeMs === record.last_mtime_ms) continue
    const sha256 = digest(file)
    record.rewrites += 1
    record.identical_rewrites += sha256 === record.last_sha256 ? 1 : 0
    record.bytes_written += stat.size
    record.size = stat.size
    record.last_mtime_ms = stat.mtimeMs
    record.last_sha256 = sha256
  }
}

const elapsedMs = Math.max(1, Date.now() - startedAt)
const records = [...activity.values()].map((record) => ({
  ...record,
  estimated_bytes_per_day: Math.round((record.bytes_written / elapsedMs) * 86_400_000),
}))
const totalBytesWritten = records.reduce((sum, record) => sum + record.bytes_written, 0)
const estimatedBytesPerDay = Math.round((totalBytesWritten / elapsedMs) * 86_400_000)
const result = {
  codex_home: codexHome,
  sampled_files: records.length,
  duration_ms: elapsedMs,
  total_rewrites: records.reduce((sum, record) => sum + record.rewrites, 0),
  identical_rewrites: records.reduce((sum, record) => sum + record.identical_rewrites, 0),
  bytes_written: totalBytesWritten,
  estimated_bytes_per_day: estimatedBytesPerDay,
  threshold_bytes_per_day: thresholdBytesPerDay,
  excessive_churn: estimatedBytesPerDay > thresholdBytesPerDay && totalBytesWritten > 0,
  files: records,
}

if (args.json) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`CODEX_HOME: ${result.codex_home}`)
  console.log(`Sampled files: ${result.sampled_files}`)
  console.log(`Observed rewrites: ${result.total_rewrites} (${result.identical_rewrites} byte-identical)`)
  console.log(`Estimated write rate: ${(result.estimated_bytes_per_day / 1_073_741_824).toFixed(2)} GiB/day`)
  if (result.excessive_churn) {
    console.error("Excessive Codex cache churn detected. Launch Codex through the guarded route with remote_plugin disabled.")
  }
}

process.exit(result.excessive_churn ? 2 : 0)
