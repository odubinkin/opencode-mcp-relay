export * as McpRuntime from "./mcp-runtime"

import { Agent } from "@opencode/core/agent"
import { Session } from "@opencode/core/session"
import { SessionExternal } from "@opencode/core/session/external"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { createRoutes } from "./routes"
import type { ServerOptions } from "./options"

/** The native API and MCP use this one application graph, so UI replies settle the same forms. */
export const make = Effect.fn("McpRuntime.make")(function* (input: {
  readonly directory: string
  readonly sessionID?: string
  readonly agent?: string
  readonly server?: ServerOptions
}) {
  const services = yield* Layer.build(createRoutes(input.server).pipe(Layer.provide(HttpServer.layerServices)))
  const context = yield* Effect.context()
  const scope = yield* Effect.scope
  const run = Effect.runPromiseWith(Context.merge(context, services))
  const external = yield* SessionExternal.open({
    id: input.sessionID ? Session.ID.make(input.sessionID) : undefined,
    agent: input.agent ? Agent.ID.make(input.agent) : undefined,
    location: Location.Ref.make({ directory: AbsolutePath.make(input.directory) }),
  }).pipe(Effect.provide(services))
  const sessions = Context.get(services, Session.Service)
  return {
    sessionID: external.sessionID,
    fetch: Context.get(services, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(services)),
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
        external.execute(name, args, {
          progress: (metadata) => Effect.sync(() => options?.progress?.(metadata)),
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
