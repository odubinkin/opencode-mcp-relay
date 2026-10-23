import { Mcp } from "@opencode/core/mcp/index"
import { Location } from "@opencode/core/location"
import { McpRelay } from "../mcp/relay"
import { McpServerNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"
import { locationErrors, response } from "../location"

const notFound = <A, R>(effect: Effect.Effect<A, Mcp.NotFoundError, R>) =>
  effect.pipe(Effect.mapError((error) => new McpServerNotFoundError({ server: error.server, message: error.message })))

export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "mcp.relay.status",
        Effect.fn(function* () {
          const relay = yield* McpRelay.Service
          const location = yield* Location.Service
          return yield* locationErrors(relay.status(location.directory))
        }),
      )
      .handle(
        "mcp.relay.configure",
        Effect.fn(function* (ctx) {
          const relay = yield* McpRelay.Service
          const location = yield* Location.Service
          return yield* locationErrors(relay.configure(location.directory, ctx.payload))
        }),
      )
      .handle(
        "mcp.relay.start",
        Effect.fn(function* () {
          const relay = yield* McpRelay.Service
          const location = yield* Location.Service
          return yield* relay.start(location.directory)
        }),
      )
      .handle(
        "mcp.relay.stop",
        Effect.fn(function* () {
          const relay = yield* McpRelay.Service
          const location = yield* Location.Service
          return yield* locationErrors(relay.stop(location.directory))
        }),
      )
      .handle(
        "mcp.relay.secrets",
        Effect.fn(function* () {
          const relay = yield* McpRelay.Service
          return yield* relay.secrets
        }),
      )
      .handle(
        "mcp.list",
        Effect.fn(function* () {
          const service = yield* Mcp.Service
          return yield* response(
            service
              .servers()
              .pipe(
                Effect.map((servers) =>
                  servers.map((info) => ({ name: info.name, status: info.status, integrationID: info.integrationID })),
                ),
              ),
          )
        }),
      )
      .handle(
        "mcp.add",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* service.add(ctx.params.server, ctx.payload.config)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.remove",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* notFound(service.remove(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.connect",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* notFound(service.connect(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.disconnect",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* notFound(service.disconnect(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.resource.catalog",
        Effect.fn(function* () {
          const service = yield* Mcp.Service
          return yield* response(service.resourceCatalog())
        }),
      )
  }),
)
