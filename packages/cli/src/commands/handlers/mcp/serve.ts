import { Effect, Option, Redacted } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { McpServer } from "../../../mcp/server"
import { McpHost } from "../../../mcp/host"
import { Env } from "../../../env"
import { Global } from "@opencode/util/global"
import path from "node:path"

export default Runtime.handler(
  Commands.commands.mcp.commands.serve,
  Effect.fn("cli.mcp.serve")(function* (input) {
    const directory = Option.getOrUndefined(input.directory)
    if (directory) process.chdir(directory)
    const config = yield* Env.mcpOAuth
    const global = yield* Global.Service
    const runtime = yield* McpHost.make(process.cwd(), path.join(global.state, "mcp-runtime"))
    if (input.transport === "stdio") return yield* McpServer.stdio(runtime)
    const configured = Boolean(
      config.issuer || config.clientID || config.clientSecret || config.password || config.redirectURIs,
    )
    if (
      configured &&
      (!config.issuer || !config.clientID || !config.clientSecret || !config.password || !config.redirectURIs)
    )
      return yield* Effect.fail(new Error("Set all OPENCODE_MCP_OAUTH_* variables to enable MCP OAuth"))
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        McpServer.listen(runtime, {
          hostname: input.hostname,
          port: input.port,
          oauth:
            configured && config.clientSecret && config.password
              ? {
                  issuer: config.issuer,
                  clientID: config.clientID,
                  clientSecret: Redacted.value(config.clientSecret),
                  password: Redacted.value(config.password),
                  tokenFile: config.tokenFile ?? path.join(global.state, "mcp-oauth", "oauth-tokens.json"),
                  redirectURIs: config.redirectURIs
                    .split(",")
                    .map((uri) => uri.trim())
                    .filter(Boolean),
                }
              : undefined,
        }),
      ),
      (server) => Effect.sync(() => server.close()),
    )
    yield* Effect.sync(() => process.stderr.write(`OpenCode MCP server listening at ${server.url}\n`))
    return yield* Effect.never
  }),
)
