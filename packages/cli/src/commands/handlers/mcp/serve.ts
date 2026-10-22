import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { McpServer } from "../../../mcp/server"

export default Runtime.handler(
  Commands.commands.mcp.commands.serve,
  Effect.fn("cli.mcp.serve")(function* (input) {
    const directory = Option.getOrUndefined(input.directory)
    if (directory) process.chdir(directory)
    if (input.transport === "stdio") return yield* Effect.promise(() => McpServer.serve(process.cwd()))
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => McpServer.listen(process.cwd(), { hostname: input.hostname, port: input.port })),
      (server) => Effect.sync(() => server.close()),
    )
    yield* Effect.sync(() => process.stderr.write(`OpenCode MCP server listening at ${server.url}\n`))
    return yield* Effect.never
  }),
)
