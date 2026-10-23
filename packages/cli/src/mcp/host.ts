export * as McpHost from "./host"

import { Effect, Redacted } from "effect"
import { mkdir, chmod } from "node:fs/promises"
import path from "node:path"
import { OPENCODE_VERSION } from "../version"
import { Env } from "../env"

/** Start a private native API alongside MCP; never elect or replace the user's managed service. */
export const make = Effect.fn("McpHost.make")(function* (directory: string, defaultState: string) {
  const { McpRuntime } = yield* Effect.promise(() => import("@opencode/server/mcp-runtime"))
  const config = yield* Env.mcpRuntime
  const state = path.resolve(config.stateDirectory ?? defaultState)
  yield* Effect.promise(() => mkdir(state, { recursive: true, mode: 0o700 }))
  const sessionFile = Bun.file(path.join(state, "session-id"))
  const port = config.uiPort
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    return yield* Effect.fail(new Error("Invalid OPENCODE_MCP_UI_PORT"))
  const password = config.uiPassword ? Redacted.value(config.uiPassword) : crypto.randomUUID()
  const runtime = yield* McpRuntime.make({
    directory,
    sessionID: (yield* Effect.promise(() => sessionFile.exists()))
      ? (yield* Effect.promise(() => sessionFile.text())).trim()
      : undefined,
    agent: config.agent,
    server: {
      password,
      app: { name: "opencode-mcp", version: OPENCODE_VERSION },
      database: { path: path.join(state, "opencode.sqlite") },
      config: {
        directory: process.env.OPENCODE_CONFIG_DIR,
        file: process.env.OPENCODE_CONFIG,
        content: process.env.OPENCODE_CONFIG_CONTENT,
      },
      models: { fetch: false },
      fs: { filewatcher: process.env.OPENCODE_DISABLE_FILEWATCHER !== "true" },
    },
  })
  yield* runtime.environment(Env.session())
  yield* Effect.promise(() => Bun.write(sessionFile, runtime.sessionID, { mode: 0o600 }))
  const api = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (request) => runtime.fetch(request) }),
    ),
    (api) => Effect.promise(() => api.stop(true)),
  )
  const url = `http://127.0.0.1:${api.port}`
  const connectionFile = path.join(state, "ui-connection.json")
  yield* Effect.promise(async () => {
    await Bun.write(
      connectionFile,
      JSON.stringify({ url, username: "opencode", password, sessionID: runtime.sessionID, directory }, null, 2),
      { mode: 0o600 },
    )
    await chmod(connectionFile, 0o600)
  })
  yield* Effect.sync(() =>
    process.stderr.write(
      `OpenCode native API: ${url}\nMCP session: ${runtime.sessionID}\nUI credentials: ${connectionFile}\n`,
    ),
  )
  return runtime
})
