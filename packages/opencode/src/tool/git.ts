import z from "zod"
import path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { InstanceState } from "@/effect"
import * as Tool from "./tool"
import DESCRIPTION from "./git.txt"

const execFileAsync = promisify(execFile)

const MAX_DIFF_BYTES = 200_000
const MAX_BLAME_LINES = 500

const Parameters = z.object({
  operation: z
    .enum(["status", "diff", "log", "branch", "blame", "show"])
    .describe("The git operation to perform"),
  path: z
    .string()
    .optional()
    .describe(
      "File or directory path to scope the operation. For blame, this is required and must be a file path.",
    ),
  ref: z
    .string()
    .optional()
    .describe(
      "A git ref (commit SHA, branch, tag). For diff: compare against this ref. For log: start from this ref. For blame: annotate at this ref. For show: the commit to inspect (required).",
    ),
  staged: z
    .boolean()
    .optional()
    .describe("For diff only: show staged changes (index vs HEAD) instead of unstaged (working tree vs index)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("For log only: number of commits to show (default 20, max 500)."),
  all: z
    .boolean()
    .optional()
    .describe("For branch only: include remote-tracking branches."),
})

type Params = z.infer<typeof Parameters>

function git(args: string[], cwd: string, signal: AbortSignal): Effect.Effect<string> {
  return Effect.tryPromise({
    try: () =>
      execFileAsync("git", args, { cwd, signal, maxBuffer: 10 * 1024 * 1024 }).then(({ stdout }) => stdout),
    catch: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      // strip the "Command failed:" prefix for cleaner output
      const cleaned = msg.replace(/^Command failed: git[^\n]*\n?/, "").trim()
      return new Error(cleaned || msg)
    },
  })
}

function truncate(content: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(content) <= maxBytes) return content
  const truncated = Buffer.from(content).slice(0, maxBytes).toString("utf8")
  return `${truncated}\n\n(${label} truncated — output exceeded ${maxBytes} bytes)`
}

function resolveTarget(ins: { directory: string }, p?: string): string {
  if (!p) return ins.directory
  return path.isAbsolute(p) ? p : path.resolve(ins.directory, p)
}

async function runOperation(params: Params, ins: { directory: string }, signal: AbortSignal): Promise<string> {
  const cwd = ins.directory

  switch (params.operation) {
    case "status": {
      const args = ["status", "--short", "--branch"]
      if (params.path) args.push("--", resolveTarget(ins, params.path))
      const out = await execFileAsync("git", args, { cwd, signal }).then(({ stdout }) => stdout)
      return out.trim() || "Nothing to commit, working tree clean."
    }

    case "diff": {
      const args = ["diff", "--unified=3"]
      if (params.staged) args.push("--staged")
      if (params.ref) args.push(params.ref)
      if (params.path) args.push("--", resolveTarget(ins, params.path))
      const out = await execFileAsync("git", args, { cwd, signal, maxBuffer: 10 * 1024 * 1024 }).then(
        ({ stdout }) => stdout,
      )
      if (!out.trim()) {
        return params.staged
          ? "No staged changes."
          : params.ref
            ? `No differences from ${params.ref}.`
            : "No unstaged changes."
      }
      return truncate(out, MAX_DIFF_BYTES, "diff")
    }

    case "log": {
      const n = params.limit ?? 20
      const fmt = [
        "commit %H",
        "Author: %an <%ae>",
        "Date:   %ad",
        "",
        "    %s",
        "",
        "%b",
        "---",
      ].join("%n")
      const args = ["log", `--max-count=${n}`, `--format=${fmt}`, "--date=short"]
      if (params.ref) args.push(params.ref)
      if (params.path) args.push("--", resolveTarget(ins, params.path))
      const out = await execFileAsync("git", args, { cwd, signal, maxBuffer: 10 * 1024 * 1024 }).then(
        ({ stdout }) => stdout,
      )
      return out.trim() || "No commits found."
    }

    case "branch": {
      const args = ["branch", "--sort=-committerdate", "--format=%(refname:short)%09%(objectname:short)%09%(subject)"]
      if (params.all) args.push("--all")
      const out = await execFileAsync("git", args, { cwd, signal }).then(({ stdout }) => stdout)
      if (!out.trim()) return "No branches found."

      const lines = out.trim().split("\n").map((line) => {
        const [ref, sha, ...rest] = line.split("\t")
        return `${(ref ?? "").padEnd(40)} ${(sha ?? "").slice(0, 7)}  ${rest.join(" ")}`
      })
      return lines.join("\n")
    }

    case "blame": {
      if (!params.path) throw new Error("blame requires a file path")
      const target = resolveTarget(ins, params.path)
      const args = ["blame", "--line-porcelain"]
      if (params.ref) args.push(params.ref)
      args.push("--", target)

      const raw = await execFileAsync("git", args, { cwd, signal, maxBuffer: 20 * 1024 * 1024 }).then(
        ({ stdout }) => stdout,
      )

      // Parse porcelain blame into readable annotated output
      const lines: string[] = []
      const authorCache = new Map<string, string>()
      const chunks = raw.split(/(?=^[0-9a-f]{40} )/m)

      for (const chunk of chunks) {
        if (!chunk.trim()) continue
        const headerLine = chunk.split("\n")[0] ?? ""
        const [sha, , , lineNum] = headerLine.split(" ")
        if (!sha || sha.length < 7) continue

        const authorMatch = chunk.match(/^author (.+)$/m)
        const dateMatch = chunk.match(/^author-time (\d+)$/m)
        const contentMatch = chunk.match(/^\t(.*)$/m)

        const author = authorMatch?.[1] ?? "?"
        const date = dateMatch?.[1]
          ? new Date(parseInt(dateMatch[1]) * 1000).toISOString().slice(0, 10)
          : "?"
        const content = contentMatch?.[1] ?? ""
        const shortSha = sha.slice(0, 7)

        if (!authorCache.has(sha)) authorCache.set(sha, `${shortSha} ${date} ${author}`)
        const annotation = authorCache.get(sha)!

        lines.push(`${String(lineNum).padStart(5)}  ${annotation.padEnd(42)}  ${content}`)

        if (lines.length >= MAX_BLAME_LINES) {
          lines.push(`\n(Truncated: showing first ${MAX_BLAME_LINES} lines)`)
          break
        }
      }

      return lines.join("\n") || "No blame output."
    }

    case "show": {
      if (!params.ref) throw new Error("show requires a ref (commit SHA, tag, or branch)")
      const args = ["show", "--stat", "--unified=3", params.ref]
      const out = await execFileAsync("git", args, { cwd, signal, maxBuffer: 10 * 1024 * 1024 }).then(
        ({ stdout }) => stdout,
      )
      return truncate(out.trim(), MAX_DIFF_BYTES, "show output")
    }
  }
}

export const GitTool = Tool.define(
  "git",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context

          yield* ctx.ask({
            permission: "bash",
            patterns: [`git ${params.operation}`],
            always: ["status", "diff", "log", "branch", "blame", "show"],
            metadata: { operation: params.operation, path: params.path, ref: params.ref },
          })

          const output = yield* Effect.tryPromise({
            try: () => runOperation(params, ins, ctx.abort),
            catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
          })

          const title =
            params.operation === "blame" || params.operation === "show"
              ? `git ${params.operation} ${params.ref ?? params.path ?? ""}`
              : `git ${params.operation}${params.path ? ` ${path.relative(ins.worktree, path.isAbsolute(params.path) ? params.path : path.resolve(ins.directory, params.path))}` : ""}`

          return {
            title: title.trim(),
            metadata: { operation: params.operation },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
