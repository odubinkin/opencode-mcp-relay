export * as McpRuntime from "./mcp-runtime"

import { Agent } from "@opencode/core/agent"
import { App } from "@opencode/core/app"
import { Session } from "@opencode/core/session"
import { SessionExternal } from "@opencode/core/session/external"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import type { ServerOptions } from "./options"

/** The native API and MCP use this one application graph, so UI replies settle the same forms. */
export const make = Effect.fn("McpRuntime.make")(function* (input: {
  readonly directory: string
  readonly sessionID?: string
  readonly agent?: string
  readonly server?: ServerOptions
}) {
  const { createRoutes } = yield* Effect.promise(() => import("./routes"))
  const services = yield* Layer.build(createRoutes(input.server).pipe(Layer.provide(HttpServer.layerServices)))
  const context = yield* Effect.context()
  const tools = yield* open(input).pipe(Effect.provide(services))
  return {
    ...tools,
    run: Effect.runPromiseWith(Context.merge(context, services)),
    fetch: Context.get(services, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(services)),
  }
})

/** Bind MCP to the host backend; never create another application graph for integrated Relay. */
export const open = Effect.fn("McpRuntime.open")(function* (input: {
  readonly directory: string
  readonly sessionID?: string
  readonly agent?: string
}) {
  const context = yield* Effect.context()
  const scope = yield* Effect.scope
  const run = Effect.runPromiseWith(context)
  const external = yield* SessionExternal.open({
    id: input.sessionID ? Session.ID.make(input.sessionID) : undefined,
    agent: input.agent ? Agent.ID.make(input.agent) : undefined,
    location: Location.Ref.make({ directory: AbsolutePath.make(input.directory) }),
  })
  const sessions = yield* Session.Service
  const app = yield* App.Metadata
  return {
    version: app.version,
    sessionID: external.sessionID,
    context: () => run(external.context),
    catalog: () => run(external.catalog),
    updates: () => run(external.updates),
    execute: (
      name: string,
      args: Record<string, unknown>,
      options?: {
        readonly signal?: AbortSignal
        readonly progress?: (metadata: Readonly<Record<string, unknown>>) => void
      },
    ) =>
      run(
        Effect.gen(function* () {
          const fiber = yield* external
            .execute(name, args, {
              progress: (metadata) => Effect.sync(() => options?.progress?.(metadata)),
            })
            .pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
        }),
        { signal: options?.signal },
      ),
    switchAgent: (agent: string) => run(external.switchAgent(Agent.ID.make(agent))),
    environment: (variables: Readonly<Record<string, string>>) =>
      sessions.environment({ sessionID: external.sessionID, variables }),
    watch: async (changed: () => Promise<void>) => {
      const fiber = await run(
        Stream.runForEach(external.changes, () => Effect.promise(changed)).pipe(
          Effect.catch((cause) => Effect.logError("MCP catalog watcher failed", cause)),
          Effect.forkIn(scope, { startImmediately: true }),
        ),
      )
      return () => run(Fiber.interrupt(fiber))
    },
    run,
  }
})

export type Interface = Effect.Success<ReturnType<typeof make>>
export type Tools = Effect.Success<ReturnType<typeof open>>
