import { expect } from "bun:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { OpenCode } from "@opencode/client/promise"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Schema } from "effect"
import { HttpServer } from "effect/http"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

it.live(
  "runs Relay in the host backend, persists OAuth in its database and leaves normal sessions untouched",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      const other = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      const configDirectory = path.join(directory.path, "config")
      const settings = {
        issuer: "https://relay.example",
        hostname: "127.0.0.1",
        port: 0,
        clientID: "relay-test",
        redirectURIs: ["https://chatgpt.com/connector/oauth/test"],
      }
      yield* Effect.promise(() =>
        Bun.write(path.join(configDirectory, "opencode.jsonc"), '{\n // Keep my settings\n "shell": "/bin/sh"\n}\n'),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory.path, ".opencode/opencode.json"),
          JSON.stringify({ mcpRelay: settings, permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(directory.path, "hello.txt"), "native-relay-file"))
      const backend = Effect.gen(function* () {
        const server = yield* ServerProcess.start<never, never>({
          hostname: "127.0.0.1",
          port: 0,
          password: "private-api",
          database: { path: path.join(directory.path, "opencode.sqlite") },
          config: { directory: configDirectory },
          models: { fetch: false },
          fs: { filewatcher: false },
        })
        return OpenCode.make({
          baseUrl: HttpServer.formatAddress(server.address),
          headers: { Authorization: `Basic ${btoa("opencode:private-api")}` },
        })
      })
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* backend
          return yield* Effect.promise(async () => {
            const location = { directory: directory.path }
            // A repository cannot publish a listener or supply host-wide relay configuration.
            expect(await api.mcp.relay.status({ location })).toEqual({ running: false })
            const regular = await api.session.create({ location, title: "Normal chat" })
            const configured = await api.mcp.relay.configure({
              location,
              settings,
              clientSecret: "client-secret",
              password: "owner-password",
            })
            expect(configured).toMatchObject({ running: false, settings })
            const text = await Bun.file(path.join(configDirectory, "opencode.jsonc")).text()
            expect(text).toContain("Keep my settings")
            expect(text).toContain('"shell": "/bin/sh"')
            expect(text).not.toContain("owner-password")
            expect(text).not.toContain("client-secret")
            const status = await api.mcp.relay.start({ location })
            if (!status.sessionID || !status.localURL) throw new Error("Relay did not return a connection")
            const sessionID = status.sessionID
            const localURL = status.localURL
            expect(status.running).toBe(true)
            expect(status.sessionID).not.toBe(regular.id)
            expect((await api.session.get({ sessionID: regular.id })).driver).toBeUndefined()
            expect((await api.session.get({ sessionID })).driver).toBe("external")
            expect(await api.mcp.relay.start({ location: { directory: other.path } })).toEqual(status)
            await expect(api.mcp.relay.configure({ location, settings })).rejects.toThrow("Stop MCP Relay")
            expect((await fetch(localURL)).status).toBe(401)
            const origin = new URL(localURL).origin
            const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()
            expect(metadata.code_challenge_methods_supported).toEqual(["S256"])
            const verifier = "v".repeat(43)
            const form = (values: Record<string, string>) => ({
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams(values),
              redirect: "manual" as const,
            })
            const authorization = await fetch(
              `${origin}/oauth/authorize?${new URLSearchParams({ client_id: settings.clientID, redirect_uri: settings.redirectURIs[0], response_type: "code", resource: `${settings.issuer}/mcp`, scope: "opencode:tools", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })}`,
            )
            const transaction = /name="transaction" value="([^"]+)"/.exec(await authorization.text())?.[1]
            expect(transaction).toBeDefined()
            if (!transaction) throw new Error("Expected OAuth consent form")
            const consent = await fetch(
              `${origin}/oauth/authorize`,
              form({ transaction, decision: "allow", password: "owner-password" }),
            )
            const redirect = consent.headers.get("location")
            if (!redirect) throw new Error("Expected OAuth callback redirect")
            const code = new URL(redirect).searchParams.get("code")
            if (!code) throw new Error("Expected OAuth authorization code")
            const token = await fetch(
              `${origin}/oauth/token`,
              form({
                client_id: settings.clientID,
                client_secret: "client-secret",
                grant_type: "authorization_code",
                code,
                redirect_uri: settings.redirectURIs[0],
                code_verifier: verifier,
                resource: `${settings.issuer}/mcp`,
              }),
            )
            expect(token.status).toBe(200)
            const tokens = Schema.decodeUnknownSync(
              Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String }),
            )(await token.json())
            const client = new Client({ name: "relay-test", version: "1" })
            await client.connect(
              new StreamableHTTPClientTransport(new URL(localURL), {
                requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
              }),
            )
            try {
              expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("read")
              expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("subagent")
              expect(await client.callTool({ name: "read", arguments: { path: "hello.txt" } })).toMatchObject({
                content: [{ type: "text", text: expect.stringContaining("native-relay-file") }],
              })
              const messages = (await api.message.list({ sessionID })).data
              expect(messages).toMatchObject([
                { type: "tool", tool: { name: "read", state: { status: "completed", input: { path: "hello.txt" } } } },
              ])
              expect(messages.some((message) => message.type === "assistant")).toBe(false)
            } finally {
              await client.close()
            }
            const stopped = await api.mcp.relay.stop({ location })
            expect(stopped.running).toBe(false)
            expect((await api.mcp.relay.start({ location })).sessionID).toBe(status.sessionID)
            // Leaving this listener running also exercises backend-scope shutdown, not just explicit stop.
            return { sessionID, access: tokens.access_token, refresh: tokens.refresh_token }
          })
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* backend
          yield* Effect.promise(async () => {
            const location = { directory: directory.path }
            expect((await api.mcp.relay.status({ location })).running).toBe(false)
            const status = await api.mcp.relay.start({ location })
            if (!status.localURL) throw new Error("Relay did not return a connection")
            expect(status.sessionID).toBe(saved.sessionID)
            const client = new Client({ name: "relay-restart", version: "1" })
            await client.connect(
              new StreamableHTTPClientTransport(new URL(status.localURL), {
                requestInit: { headers: { Authorization: `Bearer ${saved.access}` } },
              }),
            )
            try {
              expect((await client.listTools()).tools.length).toBeGreaterThan(3)
            } finally {
              await client.close()
            }
            const response = await fetch(`${new URL(status.localURL).origin}/oauth/token`, {
              method: "POST",
              body: new URLSearchParams({
                client_id: settings.clientID,
                client_secret: "client-secret",
                grant_type: "refresh_token",
                refresh_token: saved.refresh,
                resource: `${settings.issuer}/mcp`,
              }),
              headers: { "content-type": "application/x-www-form-urlencoded" },
            })
            expect(response.status).toBe(200)
            await api.mcp.relay.stop({ location })
          })
        }),
      )
    }),
  // Two real native backend startups reopen one SQLite file, including credentials and token hashes.
  { timeout: 30_000 },
)
