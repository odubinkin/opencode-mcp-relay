export * as McpRelay from "./relay"

import path from "node:path"
import { randomBytes } from "node:crypto"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Integration } from "@opencode/schema/integration"
import { McpRelay } from "@opencode/schema/mcp-relay"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Global } from "@opencode/util/global"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Context, Effect, Exit, Layer, Option, Ref, Schema, Scope, Semaphore } from "effect"
import { McpRuntime } from "../mcp-runtime"

const integrationID = Integration.ID.make("opencode-mcp-relay")
const binding = Schema.Struct({ sessionID: Session.ID, directory: AbsolutePath })

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/McpRelay") {}

const make = Effect.gen(function* () {
  const credentials = yield* Credential.Service
  const kv = yield* KV.Service
  const global = yield* Global.Service
  const locations = yield* LocationServiceMap.Service
  const parent = yield* Effect.scope
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof McpRuntime.open>>>()
  const run = Effect.runPromiseWith(context)
  const lock = yield* Semaphore.make(1)
  const active = yield* Ref.make<{ scope: Scope.Closeable; status: McpRelay.Status } | undefined>(undefined)

  const config = (directory: AbsolutePath) =>
    Effect.gen(function* () {
      const service = yield* Config.Service
      const entries = yield* service.entries()
      return {
        service,
        settings: Config.latest(
          entries.filter(
            (entry) => entry.type === "document" && entry.path && path.dirname(entry.path) === global.config,
          ),
          "mcpRelay",
        ),
      }
    }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory }))))

  const secrets = Effect.gen(function* () {
    const entries = yield* credentials.list(integrationID)
    return Object.fromEntries(
      entries.flatMap((entry) => (entry.value.type === "key" ? [[entry.label, entry.value.key]] : [])),
    )
  })
  const status = Effect.fn("McpRelay.status")(function* (directory: AbsolutePath) {
    const current = yield* Ref.get(active)
    const saved = yield* config(directory)
    return (
      current?.status ??
      McpRelay.Status.make({ running: false, ...(saved.settings ? { settings: saved.settings } : {}) })
    )
  })
  const stop = Effect.fn("McpRelay.stop")(function* (directory: AbsolutePath) {
    const current = yield* Ref.getAndSet(active, undefined)
    if (current) yield* Scope.close(current.scope, Exit.void)
    return yield* status(directory)
  })
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const current = yield* Ref.getAndSet(active, undefined)
      if (current) yield* Scope.close(current.scope, Exit.void)
    }),
  )

  return {
    status,
    stop: (directory: AbsolutePath) => lock.withPermit(stop(directory)),
    secrets: secrets.pipe(
      Effect.flatMap((value) =>
        value["client-secret"] && value.password
          ? Effect.succeed({ clientSecret: value["client-secret"], password: value.password, ...(value["api-key"] ? { apiKey: value["api-key"] } : {}) })
          : Effect.fail(new InvalidRequestError({ message: "Configure MCP Relay first" })),
      ),
    ),
    configure: (directory: AbsolutePath, input: McpRelay.Configure) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (yield* Ref.get(active))
            return yield* new InvalidRequestError({ message: "Stop MCP Relay before changing settings" })
          const saved = yield* config(directory)
          if (!saved.service.update)
            return yield* new InvalidRequestError({ message: "Global configuration is read-only" })
          const values = yield* secrets
          const clientSecret = input.clientSecret || values["client-secret"] || randomBytes(32).toString("base64url")
          const password = input.password || values.password || randomBytes(24).toString("base64url")
          if (input.settings.tunnelID) {
            const { OpenAiTunnel } = yield* Effect.promise(() => import("./tunnel"))
            yield* Effect.try({
              try: () => OpenAiTunnel.validate(input.settings.tunnelID!),
              catch: (cause) => new InvalidRequestError({ message: cause instanceof Error ? cause.message : String(cause) }),
            })
            if (!input.apiKey && !values["api-key"])
              return yield* new InvalidRequestError({ message: "OpenAI API key is required for Secure MCP Tunnel" })
          } else {
            const { McpOAuth } = yield* Effect.promise(() => import("./oauth"))
            yield* Effect.try({
              try: () => McpOAuth.make({ ...input.settings, clientSecret, password }),
              catch: (cause) =>
                new InvalidRequestError({ message: cause instanceof Error ? cause.message : String(cause) }),
            })
          }
          const entries = yield* credentials.list(integrationID)
          yield* Effect.forEach(
            [
              { label: "client-secret", key: clientSecret },
              { label: "password", key: password },
              ...(input.apiKey ? [{ label: "api-key", key: input.apiKey }] : []),
            ],
            (value) => {
              const existing = entries.find((entry) => entry.label === value.label)
              return existing
                ? credentials.update(existing.id, { value: { type: "key", key: value.key } })
                : credentials.create({
                    integrationID,
                    label: value.label,
                    value: { type: "key", key: value.key },
                    activate: false,
                  })
            },
          )
          yield* saved.service.update({ mcpRelay: input.settings }).pipe(Effect.orDie)
          return yield* status(directory)
        }),
      ),
    start: (directory: AbsolutePath) =>
      lock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(active)
          // A UI tab change must never retarget a connected external model.
          if (current) return current.status
          const saved = yield* config(directory)
          const settings = saved.settings
          if (!settings) return yield* new InvalidRequestError({ message: "Configure MCP Relay first" })
          const values = yield* secrets
          if (!settings.tunnelID && (!values["client-secret"] || !values.password))
            return yield* new InvalidRequestError({
              message: "MCP Relay credentials are missing; save its settings again",
            })
          if (settings.tunnelID && !values["api-key"])
            return yield* new InvalidRequestError({ message: "OpenAI tunnel API key is missing" })
          const stored = Option.getOrUndefined(Schema.decodeUnknownOption(binding)(yield* kv.get("mcp-relay/session")))
          const tokens = yield* kv.get("mcp-relay/oauth")
          const scope = yield* Scope.fork(parent)
          return yield* Effect.gen(function* () {
            const runtime = yield* McpRuntime.open({
              directory,
              sessionID: stored?.directory === directory ? stored.sessionID : undefined,
            }).pipe(Effect.provide(Context.add(context, Scope.Scope, scope)))
            const { McpServer } = yield* Effect.promise(() => import("./server"))
            const listener = yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  McpServer.listen(runtime, {
                    hostname: settings.tunnelID ? "127.0.0.1" : settings.hostname,
                    port: settings.port,
                    ...(!settings.tunnelID ? { oauth: {
                      ...settings,
                      clientSecret: values["client-secret"],
                      password: values.password,
                      persistence: {
                        value: typeof tokens === "string" ? tokens : undefined,
                        save: (value) => run(kv.set("mcp-relay/oauth", value)),
                      },
                    } } : {}),
                    onRequest: (event) => {
                      void run(Effect.logDebug("MCP Relay HTTP", event))
                    },
                  }),
                catch: (cause) =>
                  new InvalidRequestError({ message: cause instanceof Error ? cause.message : String(cause) }),
              }),
              (listener) => Effect.promise(() => Promise.resolve(listener.close())),
            )
            if (settings.tunnelID) {
              const { OpenAiTunnel } = yield* Effect.promise(() => import("./tunnel"))
              yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: () => OpenAiTunnel.connect({
                    tunnelID: settings.tunnelID!,
                    apiKey: values["api-key"]!,
                    localURL: listener.url,
                  }),
                  catch: (cause) => new InvalidRequestError({ message: cause instanceof Error ? cause.message : String(cause) }),
                }),
                (tunnel) => Effect.promise(() => tunnel.close()),
              )
            }
            yield* kv.set("mcp-relay/session", { sessionID: runtime.sessionID, directory })
            const result = McpRelay.Status.make({
              running: true,
              settings,
              sessionID: runtime.sessionID,
              directory,
              ...(!settings.tunnelID ? { url: `${new URL(settings.issuer).origin}/mcp` } : {}),
              localURL: listener.url,
            })
            yield* Ref.set(active, { scope, status: result })
            yield* Effect.logInfo("MCP Relay started", {
              sessionID: runtime.sessionID,
              directory,
              url: result.url,
              localURL: result.localURL,
            })
            return result
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
          )
        }).pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))),
      ),
  }
})

export const layer = Layer.effect(Service, make)
