import { Effect, Redacted } from "effect"
import { stat } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { parseArgs, parseEnv } from "node:util"
import { Env } from "../env"
import { McpServer } from "./server"

async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      "env-file": { type: "string", default: ".env" },
      directory: { type: "string" },
      hostname: { type: "string" },
      port: { type: "string" },
      transport: { type: "string", default: "http" },
      help: { type: "boolean", short: "h" },
    },
  }).values
  if (args.help) {
    process.stdout.write(
      "OpenCode MCP standalone server\n\nUsage: opencode-mcp [--env-file PATH] [--directory PATH] [--hostname HOST] [--port PORT] [--transport http|stdio]\n\nDefaults: HTTP, 127.0.0.1:4096. Reads .env from the current directory unless --env-file is provided.\n",
    )
    return
  }
  if (await Bun.file(args["env-file"]).exists()) {
    Object.entries(parseEnv(await Bun.file(args["env-file"]).text())).forEach(([key, value]) => {
      process.env[key] ??= value
    })
  }
  const directory = path.resolve(args.directory ?? process.env.OPENCODE_MCP_DIRECTORY ?? process.cwd())
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`)
  if (args.transport === "stdio") return McpServer.serve(directory)
  if (args.transport !== "http") throw new Error("transport must be http or stdio")
  const port = Number(args.port ?? process.env.OPENCODE_MCP_PORT ?? "4096")
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be between 0 and 65535")
  const config = await Effect.runPromise(Env.mcpOAuth)
  if (!config.issuer || !config.clientID || !config.clientSecret || !config.password || !config.redirectURIs)
    throw new Error("Configure all OPENCODE_MCP_OAUTH_* variables in .env before starting the standalone HTTP server")
  const server = McpServer.listen(directory, {
    hostname: args.hostname ?? process.env.OPENCODE_MCP_HOSTNAME ?? "127.0.0.1",
    port,
    onRequest: (event) => {
      const line = JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n"
      appendFileSync(path.join(path.dirname(path.resolve(args["env-file"])), "mcp-diagnostic.log"), line, {
        mode: 0o600,
      })
      process.stderr.write(line)
    },
    oauth: {
      issuer: config.issuer,
      clientID: config.clientID,
      clientSecret: Redacted.value(config.clientSecret),
      password: Redacted.value(config.password),
      tokenFile: path.resolve(config.tokenFile ?? path.join(path.dirname(args["env-file"]), "oauth-tokens.json")),
      redirectURIs: config.redirectURIs
        .split(",")
        .map((uri) => uri.trim())
        .filter(Boolean),
    },
  })
  process.stderr.write(`OpenCode MCP server listening at ${server.url}\nProject directory: ${directory}\n`)
  const close = () => {
    server.close()
    process.exit(0)
  }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : "Unable to start OpenCode MCP"}\n`)
  process.exitCode = 1
})
