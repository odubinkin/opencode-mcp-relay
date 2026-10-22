import { expect, setSystemTime, test } from "bun:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createHash, randomBytes } from "node:crypto"
import { stat } from "node:fs/promises"
import path from "node:path"
import { McpOAuth } from "../src/mcp/oauth"
import { McpServer } from "../src/mcp/server"
import { tmpdir } from "./fixture/tmpdir"

const options = {
  issuer: "https://opencode.example.com",
  clientID: "chatgpt",
  clientSecret: "test-client-secret",
  password: "test-mcp-password",
  redirectURIs: ["https://chatgpt.com/connector_platform_oauth_redirect"],
}
const resource = `${options.issuer}/mcp`

test("discovers OAuth and uses a PKCE grant to access HTTP MCP tools", async () => {
  await using directory = await tmpdir()
  const log: string[] = []
  using server = {
    ...McpServer.listen(directory.path, {
      hostname: "127.0.0.1",
      port: 0,
      oauth: options,
      onRequest: (event) => log.push(JSON.stringify(event)),
    }),
    [Symbol.dispose]() {
      this.close()
    },
  }
  const origin = new URL(server.url).origin
  const unauthorized = await fetch(server.url)
  expect(unauthorized.status).toBe(401)
  expect(unauthorized.headers.get("www-authenticate")).toContain(
    `${options.issuer}/.well-known/oauth-protected-resource/mcp`,
  )
  expect(await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()).toMatchObject({
    resource,
    authorization_servers: [options.issuer],
    scopes_supported: ["opencode:tools"],
  })
  expect(await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
    issuer: options.issuer,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  })
  const request = (url: string, init?: RequestInit) => fetch(url.replace(options.issuer, origin), init)
  const grant = await authorization(request)
  const response = await request(`${options.issuer}/oauth/token`, form(grant))
  expect(response.status).toBe(200)
  const tokens = await response.json()
  const client = new Client({ name: "oauth-test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }),
  )
  try {
    const tools = await client.listTools()
    expect(tools.tools[0]).toMatchObject({
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["opencode:tools"] }] },
    })
    expect(await client.callTool({ name: "list_directory", arguments: {} })).not.toHaveProperty("isError", true)
    expect(log.some((line) => line.includes('"rpc":"tools/list"'))).toBe(true)
    expect(log.join("\n")).not.toContain(tokens.access_token)
    expect(log.join("\n")).not.toContain(options.password)
    expect(log.join("\n")).not.toContain(options.clientSecret)
    // Knowing the MCP session ID must not bypass the HTTP authorization check.
    expect((await fetch(server.url, { headers: { "mcp-session-id": "known-session" } })).status).toBe(401)
    expect((await request(`${options.issuer}/oauth/token`, form(grant))).status).toBe(400)
    const renewed = await request(`${options.issuer}/oauth/token`, {
      ...form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${options.clientID}:${options.clientSecret}`).toString("base64")}`,
      },
    })
    expect(renewed.status).toBe(200)
    expect((await renewed.json()).access_token).not.toBe(tokens.access_token)
    expect(
      (
        await request(
          `${options.issuer}/oauth/token`,
          form({ ...grant, grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
        )
      ).status,
    ).toBe(400)
  } finally {
    await client.close()
  }
})

test("rejects forged authorization requests and does not issue codes without the MCP password", async () => {
  const oauth = McpOAuth.make(options)
  const request = async (url: string, init?: RequestInit) => (await oauth.handle(new Request(url, init)))!
  const verifier = randomBytes(32).toString("base64url")
  const params = parameters(verifier)
  expect(
    (
      await request(
        `${options.issuer}/oauth/authorize?${new URLSearchParams({ ...params, redirect_uri: "https://attacker.example/callback" })}`,
      )
    ).status,
  ).toBe(400)
  const invalidResource = await request(
    `${options.issuer}/oauth/authorize?${new URLSearchParams({ ...params, resource: "https://attacker.example/mcp" })}`,
  )
  expect(new URL(invalidResource.headers.get("location")!).searchParams.get("error")).toBe("invalid_target")
  const page = await request(`${options.issuer}/oauth/authorize?${new URLSearchParams(params)}`)
  const transaction = /name="transaction" value="([^"]+)"/.exec(await page.text())![1]
  expect(
    (
      await request(
        `${options.issuer}/oauth/authorize`,
        form({ transaction, password: "incorrect", decision: "allow" }),
      )
    ).status,
  ).toBe(403)
  const denied = await request(`${options.issuer}/oauth/authorize`, form({ transaction, decision: "deny" }))
  expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied")
  expect(new URL(denied.headers.get("location")!).searchParams.get("iss")).toBe(options.issuer)
  expect(
    (await request(`${options.issuer}/oauth/authorize`, form({ transaction, password: options.password }))).status,
  ).toBe(400)
})

test("binds authorization codes to the client, resource, redirect URI, and PKCE verifier", async () => {
  const oauth = McpOAuth.make(options)
  const request = async (url: string, init?: RequestInit) => (await oauth.handle(new Request(url, init)))!
  const grant = await authorization(request)
  expect((await request(`${options.issuer}/oauth/token`, form({ ...grant, client_secret: "wrong" }))).status).toBe(401)
  expect(
    (await request(`${options.issuer}/oauth/token`, form({ ...grant, resource: "https://other.example/mcp" }))).status,
  ).toBe(400)
  expect((await request(`${options.issuer}/oauth/token`, form({ ...grant, code_verifier: "wrong" }))).status).toBe(400)
  expect((await request(`${options.issuer}/oauth/token`, form(grant))).status).toBe(400)
  const another = await authorization(request)
  expect(
    (await request(`${options.issuer}/oauth/token`, form({ ...another, redirect_uri: "https://other.example" })))
      .status,
  ).toBe(400)
  expect(oauth.authorize(new Request(resource, { headers: { Authorization: "Bearer forged-token" } }))?.status).toBe(
    401,
  )
})

test("rejects incomplete and insecure OAuth configuration", () => {
  expect(() => McpOAuth.make({ ...options, clientSecret: "" })).toThrow("requires")
  expect(() => McpOAuth.make({ ...options, issuer: "http://public.example.com" })).toThrow("HTTPS")
  expect(() => McpOAuth.make({ ...options, issuer: "https://public.example.com/path" })).toThrow("origin")
  expect(() => McpOAuth.make({ ...options, redirectURIs: ["https://chatgpt.com/callback#fragment"] })).toThrow(
    "redirect",
  )
})

test("restores tokens and persists refresh rotation across restarts without storing secrets", async () => {
  await using directory = await tmpdir()
  const tokenFile = path.join(directory.path, "private", "oauth-tokens.json")
  const first = McpOAuth.make({ ...options, tokenFile })
  const request = async (url: string, init?: RequestInit) => (await first.handle(new Request(url, init)))!
  const grant = await authorization(request)
  const tokens = await (await request(`${options.issuer}/oauth/token`, form(grant))).json()
  const content = await Bun.file(tokenFile).text()
  expect(content).not.toContain(tokens.access_token)
  expect(content).not.toContain(tokens.refresh_token)
  expect(content).not.toContain(options.password)
  expect(content).not.toContain(options.clientSecret)
  if (process.platform !== "win32") expect((await stat(tokenFile)).mode & 0o777).toBe(0o600)

  const restored = McpOAuth.make({ ...options, tokenFile })
  const authenticated = new Request(resource, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
  expect(restored.authorize(authenticated)).toBeUndefined()
  const renewed = await restored.handle(
    new Request(
      `${options.issuer}/oauth/token`,
      form({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource,
        client_id: options.clientID,
        client_secret: options.clientSecret,
      }),
    ),
  )
  expect(renewed?.status).toBe(200)
  const rotated = await renewed!.json()
  const restarted = McpOAuth.make({ ...options, tokenFile })
  expect(
    (
      await restarted.handle(
        new Request(
          `${options.issuer}/oauth/token`,
          form({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            resource,
            client_id: options.clientID,
            client_secret: options.clientSecret,
          }),
        ),
      )
    )?.status,
  ).toBe(400)
  expect(
    (
      await restarted.handle(
        new Request(
          `${options.issuer}/oauth/token`,
          form({
            grant_type: "refresh_token",
            refresh_token: rotated.refresh_token,
            resource,
            client_id: options.clientID,
            client_secret: options.clientSecret,
          }),
        ),
      )
    )?.status,
  ).toBe(200)
  expect(McpOAuth.make({ ...options, password: "changed-password", tokenFile }).authorize(authenticated)?.status).toBe(
    401,
  )
  expect(
    McpOAuth.make({ ...options, issuer: "https://other.example.com", tokenFile }).authorize(authenticated)?.status,
  ).toBe(401)
})

test("does not restore expired tokens from disk", async () => {
  await using directory = await tmpdir()
  const tokenFile = path.join(directory.path, "oauth-tokens.json")
  const first = McpOAuth.make({ ...options, tokenFile })
  const request = async (url: string, init?: RequestInit) => (await first.handle(new Request(url, init)))!
  const grant = await authorization(request)
  const tokens = await (await request(`${options.issuer}/oauth/token`, form(grant))).json()
  try {
    setSystemTime(Date.now() + 31 * 24 * 60 * 60_000)
    const restored = McpOAuth.make({ ...options, tokenFile })
    expect(
      restored.authorize(new Request(resource, { headers: { Authorization: `Bearer ${tokens.access_token}` } }))
        ?.status,
    ).toBe(401)
    expect(
      (
        await restored.handle(
          new Request(
            `${options.issuer}/oauth/token`,
            form({
              grant_type: "refresh_token",
              refresh_token: tokens.refresh_token,
              resource,
              client_id: options.clientID,
              client_secret: options.clientSecret,
            }),
          ),
        )
      )?.status,
    ).toBe(400)
  } finally {
    setSystemTime()
  }
})

test("expires authorization codes, access tokens, and refresh tokens", async () => {
  const oauth = McpOAuth.make(options)
  const request = async (url: string, init?: RequestInit) => (await oauth.handle(new Request(url, init)))!
  const now = Date.now()
  try {
    const expired = await authorization(request)
    setSystemTime(now + 61_000)
    expect((await request(`${options.issuer}/oauth/token`, form(expired))).status).toBe(400)
    const grant = await authorization(request)
    const tokens = await (await request(`${options.issuer}/oauth/token`, form(grant))).json()
    const authenticated = new Request(resource, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
    expect(oauth.authorize(authenticated)).toBeUndefined()
    setSystemTime(now + 2 * 60 * 60_000)
    expect(oauth.authorize(authenticated)?.status).toBe(401)
    setSystemTime(now + 31 * 24 * 60 * 60_000)
    expect(
      (
        await request(
          `${options.issuer}/oauth/token`,
          form({ ...grant, grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
        )
      ).status,
    ).toBe(400)
  } finally {
    setSystemTime()
  }
})

async function authorization(request: (url: string, init?: RequestInit) => Promise<Response>) {
  const verifier = randomBytes(32).toString("base64url")
  const page = await request(`${options.issuer}/oauth/authorize?${new URLSearchParams(parameters(verifier))}`)
  expect(page.status).toBe(200)
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://chatgpt.com;")
  const transaction = /name="transaction" value="([^"]+)"/.exec(await page.text())![1]
  const response = await request(`${options.issuer}/oauth/authorize`, {
    ...form({ transaction, password: options.password, decision: "allow" }),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" },
  })
  expect(response.status).toBe(303)
  const callback = new URL(response.headers.get("location")!)
  expect(callback.searchParams.get("state")).toBe("test-state")
  expect(callback.searchParams.get("iss")).toBe(options.issuer)
  return {
    grant_type: "authorization_code",
    client_id: options.clientID,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectURIs[0],
    resource,
    code: callback.searchParams.get("code")!,
    code_verifier: verifier,
  }
}

function parameters(verifier: string) {
  return {
    response_type: "code",
    client_id: options.clientID,
    redirect_uri: options.redirectURIs[0],
    resource,
    scope: "opencode:tools",
    state: "test-state",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }
}

function form(params: Record<string, string>): RequestInit {
  return {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }
}
