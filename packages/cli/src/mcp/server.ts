import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server"
import type { Tool, Transport } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { mkdir, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { OPENCODE_VERSION } from "../version"

const OUTPUT_LIMIT = 32 * 1024
const DEFAULT_TIMEOUT = 2 * 60 * 1_000

export namespace McpServer {
  export async function serve(directory: string, suppliedTransport?: Transport) {
    const root = path.resolve(directory)
    const server = new Server({ name: "opencode", version: OPENCODE_VERSION }, { capabilities: { tools: {} } })

    const tools: Tool[] = [
      {
        name: "list_directory",
        description: "List entries in a directory on the local machine.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path, relative to the OpenCode project root." },
          },
        },
      },
      {
        name: "read_file",
        description: "Read a text file. Lines are returned with 1-based line numbers.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path, relative to the OpenCode project root." },
            offset: { type: "integer", minimum: 1, description: "First line to return (defaults to 1)." },
            limit: { type: "integer", minimum: 1, description: "Maximum lines to return (defaults to 2000)." },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Create or overwrite a text file. Missing parent directories are created.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path, relative to the OpenCode project root." },
            content: { type: "string", description: "Complete file content." },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Replace exact text in a file. The old text must occur exactly once unless replace_all is true.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path, relative to the OpenCode project root." },
            old_string: { type: "string", description: "Exact text to replace." },
            new_string: { type: "string", description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one." },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
      {
        name: "run_command",
        description:
          "Run a shell command on the local machine and return combined stdout and stderr. Commands have full local permissions.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute." },
            cwd: { type: "string", description: "Working directory, relative to the OpenCode project root." },
            timeout: { type: "integer", minimum: 1, description: "Timeout in milliseconds (defaults to 120000)." },
          },
          required: ["command"],
        },
      },
    ]
    server.setRequestHandler("tools/list", async () => ({ tools }))

    server.setRequestHandler("tools/call", async ({ params }) => {
      try {
        const args = params.arguments ?? {}
        switch (params.name) {
          case "list_directory":
            return text(await listDirectory(root, requiredString(args, "path", ".")))
          case "read_file":
            return text(
              await readFile(
                root,
                requiredString(args, "path"),
                optionalNumber(args, "offset") ?? 1,
                optionalNumber(args, "limit") ?? 2_000,
              ),
            )
          case "write_file":
            return text(await writeFile(root, requiredString(args, "path"), requiredString(args, "content")))
          case "edit_file":
            return text(
              await editFile(
                root,
                requiredString(args, "path"),
                requiredString(args, "old_string"),
                requiredString(args, "new_string"),
                args.replace_all === true,
              ),
            )
          case "run_command":
            return text(
              await runCommand(
                root,
                requiredString(args, "command"),
                requiredString(args, "cwd", "."),
                optionalNumber(args, "timeout") ?? DEFAULT_TIMEOUT,
              ),
            )
          default:
            return error(`Unknown tool: ${params.name}`)
        }
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : "Tool execution failed")
      }
    })

    if (suppliedTransport) return await server.connect(suppliedTransport)
    const transport = new StdioServerTransport()
    await server.connect(transport)
    await new Promise<void>((resolve, reject) => {
      transport.onclose = resolve
      transport.onerror = reject
    })
  }

  export function listen(directory: string, options: { hostname: string; port: number }) {
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
    const http = Bun.serve({
      hostname: options.hostname,
      port: options.port,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 })
        const session = request.headers.get("mcp-session-id")
        const current = session ? sessions.get(session) : undefined
        if (current) return current.handleRequest(request)
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        })
        await serve(directory, transport)
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId)
        }
        const response = await transport.handleRequest(request)
        if (transport.sessionId) sessions.set(transport.sessionId, transport)
        return response
      },
    })
    return {
      url: `http://${options.hostname}:${http.port}/mcp`,
      close: () => http.stop(true),
    }
  }
}

async function listDirectory(root: string, input: string) {
  const target = resolve(root, input)
  const entries = await readdir(target, { withFileTypes: true })
  return entries
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file"}\t${entry.name}`)
    .join("\n")
}

async function readFile(root: string, input: string, offset: number, limit: number) {
  if (!Number.isInteger(offset) || offset < 1) throw new Error("offset must be a positive integer")
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer")
  const target = resolve(root, input)
  const content = await Bun.file(target).text()
  const lines = content.split("\n")
  const selected = lines.slice(offset - 1, offset - 1 + limit)
  const result = selected.map((line, index) => `${offset + index}: ${line}`).join("\n")
  return lines.length > offset - 1 + limit
    ? `${result}\n[Output truncated. Continue with offset: ${offset + limit}]`
    : result
}

async function writeFile(root: string, input: string, content: string) {
  const target = resolve(root, input)
  const existed = await Bun.file(target).exists()
  await mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, content)
  return `${existed ? "Wrote" : "Created"} ${display(root, target)}`
}

async function editFile(root: string, input: string, oldString: string, newString: string, replaceAll: boolean) {
  if (oldString === "") throw new Error("old_string must not be empty; use write_file to create or overwrite a file")
  if (oldString === newString) throw new Error("old_string and new_string must differ")
  const target = resolve(root, input)
  const content = await Bun.file(target).text()
  const matches = content.split(oldString).length - 1
  if (matches === 0) throw new Error(`Could not find old_string in ${display(root, target)}`)
  if (matches > 1 && !replaceAll)
    throw new Error(`Found ${matches} matches; provide more context or set replace_all to true`)
  await Bun.write(target, replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString))
  return `Edited ${display(root, target)} (${replaceAll ? matches : 1} replacement${replaceAll && matches !== 1 ? "s" : ""})`
}

async function runCommand(root: string, command: string, cwd: string, timeout: number) {
  if (!Number.isInteger(timeout) || timeout < 1) throw new Error("timeout must be a positive integer")
  const directory = resolve(root, cwd)
  if (!(await stat(directory)).isDirectory())
    throw new Error(`Working directory is not a directory: ${display(root, directory)}`)
  const proc = Bun.spawn(
    process.platform === "win32"
      ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
      : ["sh", "-lc", command],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeout)
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)
  const output = truncate(`${stdout}${stderr}`)
  return [
    output || "(no output)",
    timedOut ? `Timed out after ${timeout}ms` : `Process exited with code ${exitCode}`,
  ].join("\n")
}

function resolve(root: string, input: string) {
  return path.resolve(root, input)
}

function display(root: string, target: string) {
  return path.relative(root, target) || "."
}

function requiredString(input: Record<string, unknown>, key: string, fallback?: string) {
  const value = input[key] ?? fallback
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function optionalNumber(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (value === undefined) return
  if (typeof value !== "number") throw new Error(`${key} must be a number`)
  return value
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] }
}

function error(value: string) {
  return { content: [{ type: "text" as const, text: value }], isError: true }
}

function truncate(value: string) {
  if (value.length <= OUTPUT_LIMIT) return value
  return `${value.slice(-OUTPUT_LIMIT)}\n[Output truncated to the last ${OUTPUT_LIMIT} characters]`
}
