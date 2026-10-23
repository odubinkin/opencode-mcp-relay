import { NodeServices } from "@effect/platform-node"
import { Effect, Logger, Redacted, Schema } from "effect"
import { stat } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { parseArgs, parseEnv } from "node:util"
import { Env } from "../env"
import { McpServer } from "./server"
import { McpHost } from "./host"

async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      "env-file": { type: "string", default: ".env" },
      directory: { type: "string" },
      hostname: { type: "string" },
      port: { type: "string" },
      transport: { type: "string", default: "http" },
      attach: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  }).values
  if (args.help) {
    process.stdout.write(
      "OpenCode MCP standalone server\n\nUsage: opencode-mcp [--env-file PATH] [--directory PATH] [--hostname HOST] [--port PORT] [--transport http|stdio] [--attach]\n\n--attach opens the native MCP Session in an installed or sibling opencode TUI.\nDefaults: HTTP, 127.0.0.1:4096. Reads .env from the current directory unless --env-file is provided.\n",
    )
    return
  }
  if (await Bun.file(args["env-file"]).exists()) {
    Object.entries(parseEnv(await Bun.file(args["env-file"]).text())).forEach(([key, value]) => {
      process.env[key] ??= value
    })
  }
  const settings = await Effect.runPromise(Env.mcpRuntime)
  if (args.attach) {
    const connection = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          url: Schema.String,
          password: Schema.String,
          sessionID: Schema.String,
          directory: Schema.String,
        }),
      ),
    )(
      await Bun.file(
        path.join(
          path.resolve(settings.stateDirectory ?? path.join(path.dirname(args["env-file"]), "runtime")),
          "ui-connection.json",
        ),
      ).text(),
    )
    const tui = path.join(path.dirname(process.execPath), "opencode")
    const command = (await Bun.file(tui).exists()) ? tui : Bun.which("opencode")
    if (!command) throw new Error("Install OpenCode or put its CLI binary next to opencode-mcp to use --attach")
    process.exitCode = await Bun.spawn(
      [command, "--server", connection.url, "--session", connection.sessionID, connection.directory],
      {
        env: { ...Env.session(), OPENCODE_PASSWORD: connection.password },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    ).exited
    return
  }
  const directory = path.resolve(args.directory ?? settings.directory ?? process.cwd())
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`)
  if (args.transport !== "http" && args.transport !== "stdio") throw new Error("transport must be http or stdio")
  const port = Number(args.port ?? settings.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be between 0 and 65535")
  const config = await Effect.runPromise(Env.mcpOAuth)
  if (
    args.transport === "http" &&
    (!config.issuer || !config.clientID || !config.clientSecret || !config.password || !config.redirectURIs)
  )
    throw new Error("Configure all OPENCODE_MCP_OAUTH_* variables in .env before starting the standalone HTTP server")
  const oauth =
    config.clientSecret && config.password
      ? {
          issuer: config.issuer,
          clientID: config.clientID,
          clientSecret: Redacted.value(config.clientSecret),
          password: Redacted.value(config.password),
          tokenFile: path.resolve(config.tokenFile ?? path.join(path.dirname(args["env-file"]), "oauth-tokens.json")),
          redirectURIs: config.redirectURIs
            .split(",")
            .map((uri) => uri.trim())
            .filter(Boolean),
        }
      : undefined
  const controller = new AbortController()
  const close = () => controller.abort()
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* McpHost.make(directory, path.resolve(path.dirname(args["env-file"]), "runtime"))
        if (args.transport === "stdio") return yield* McpServer.stdio(runtime)
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            McpServer.listen(runtime, {
              hostname: args.hostname ?? settings.hostname,
              port,
              onRequest: (event) => {
                const line = JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n"
                appendFileSync(path.join(path.dirname(path.resolve(args["env-file"])), "mcp-diagnostic.log"), line, {
                  mode: 0o600,
                })
                process.stderr.write(line)
              },
              oauth,
            }),
          ),
          (server) => Effect.promise(() => server.close()),
        )
        yield* Effect.sync(() =>
          process.stderr.write(`OpenCode MCP server listening at ${server.url}\nProject directory: ${directory}\n`),
        )
        return yield* Effect.never
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatJson)])),
    ),
    { signal: controller.signal },
  ).catch((cause) => {
    if (!controller.signal.aborted) throw cause
  })
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`)
  process.exitCode = 1
})
